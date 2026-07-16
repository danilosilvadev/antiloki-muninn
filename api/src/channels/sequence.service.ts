// C6 — the sequence machine. approve() is the ONE path from "human said yes"
// to "Smartlead executes": policy gate → campaign ensure → push with the
// lead's own approved words → state flips, all of it on the record.
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/db';
import * as t from '../db/schema';
import { PolicyService } from '../policy/policy.service';
import { SmartleadAdapter } from './smartlead.adapter';
import { nameGuessFromSlug } from '../enrichment/fullenrich.adapter';
import { slugOf } from '../leads/leads.service';

export type ApproveResult =
  | { ok: true; campaignId: string; notes: string[] }
  | { ok: false; code: string; reason: string };

export class SequenceService {
  constructor(
    private readonly db: Db,
    private readonly policy: PolicyService,
    private readonly smartlead: SmartleadAdapter | null,
    private readonly notify: (html: string) => Promise<void>,
  ) {}

  async approve(leadId: string): Promise<ApproveResult> {
    const [lead] = await this.db.select().from(t.leads).where(eq(t.leads.id, leadId)).limit(1);
    if (!lead) return { ok: false, code: 'not_ready', reason: 'lead not found' };
    if (lead.status === 'in_sequence') return { ok: false, code: 'not_ready', reason: 'already in sequence' };

    const [analysis] = await this.db
      .select()
      .from(t.leadAnalyses)
      .where(eq(t.leadAnalyses.leadId, leadId))
      .orderBy(desc(t.leadAnalyses.createdAt))
      .limit(1);
    const [enrichment] = await this.db
      .select()
      .from(t.leadEnrichments)
      .where(eq(t.leadEnrichments.leadId, leadId))
      .orderBy(desc(t.leadEnrichments.createdAt))
      .limit(1);
    const drafts = await this.db
      .select()
      .from(t.messages)
      .where(and(eq(t.messages.leadId, leadId), eq(t.messages.status, 'draft')))
      .orderBy(asc(t.messages.step));

    if (!analysis || drafts.length < 4) {
      return { ok: false, code: 'not_ready', reason: 'no analysis/drafts yet — the raven must fly first' };
    }
    if (!enrichment?.email) {
      return { ok: false, code: 'not_ready', reason: 'no verified email — LinkedIn-only lead; work it manually from the drawer' };
    }

    const verdict = await this.policy.check(lead, 'email', { email: enrichment.email });
    if (!verdict.allowed) return { ok: false, code: verdict.code, reason: verdict.reason };
    if (!this.smartlead) return { ok: false, code: 'not_ready', reason: 'smartlead adapter not constructed' };

    const campaignId = await this.ensureCampaign(analysis.angle ?? 'verification');

    const emails = drafts.filter((d) => d.channel === 'email').slice(0, 3);
    const guess = nameGuessFromSlug(slugOf(lead.linkedinUrl));
    const customFields: Record<string, string> = {};
    emails.forEach((d, i) => {
      customFields[`muninn_subject_${i + 1}`] = d.subject ?? '';
      customFields[`muninn_body_${i + 1}`] = d.bodyMd;
    });

    const pushRaw = await this.smartlead.addLead(campaignId, {
      email: enrichment.email,
      firstName: guess.firstname,
      lastName: guess.lastname,
      customFields,
    });
    await this.db.insert(t.vendorCalls).values({
      provider: 'smartlead',
      kind: 'push_lead',
      leadId,
      meta: { campaignId, raw: pushRaw },
    });

    // day-3 manual LinkedIn nudge rides sequences.next_run_at
    await this.db.insert(t.sequences).values({
      leadId,
      template: analysis.angle ?? 'verification',
      step: 0,
      status: 'running',
      nextRunAt: new Date(Date.now() + 3 * 24 * 3_600_000),
    });
    for (const d of emails) {
      await this.db.update(t.messages).set({ status: 'scheduled' }).where(eq(t.messages.id, d.id));
    }
    await this.db.update(t.leads).set({ status: 'in_sequence', updatedAt: new Date() }).where(eq(t.leads.id, leadId));
    await this.db.insert(t.events).values({
      leadId,
      kind: 'sequence_pushed',
      payload: { angle: analysis.angle, campaignId, notes: verdict.notes },
    });
    await this.notify(
      `📤 <code>${leadId.slice(0, 8)}</code> approved → <b>${analysis.angle}</b> campaign. Day-0 goes out on Smartlead's schedule.` +
        (verdict.notes.length ? `\n⚖ ${verdict.notes.join(' · ')}` : ''),
    );
    return { ok: true, campaignId, notes: verdict.notes };
  }

  async reject(leadId: string, reason: string): Promise<void> {
    await this.db.update(t.leads).set({ status: 'parked', updatedAt: new Date() }).where(eq(t.leads.id, leadId));
    // the reason STEERS future dossiers — analysis reads recent rejections
    await this.db.insert(t.events).values({
      leadId,
      kind: 'draft_rejected',
      payload: { reason: reason.slice(0, 500) },
    });
  }

  async stopForLead(leadId: string, why: string): Promise<void> {
    const seqs = await this.db
      .select()
      .from(t.sequences)
      .where(and(eq(t.sequences.leadId, leadId), eq(t.sequences.status, 'running')));
    for (const s of seqs) {
      await this.db.update(t.sequences).set({ status: 'stopped', nextRunAt: null }).where(eq(t.sequences.id, s.id));
    }
    if (this.smartlead && seqs.length > 0) {
      const [enr] = await this.db
        .select({ email: t.leadEnrichments.email })
        .from(t.leadEnrichments)
        .where(eq(t.leadEnrichments.leadId, leadId))
        .orderBy(desc(t.leadEnrichments.createdAt))
        .limit(1);
      const [camp] = await this.db
        .select()
        .from(t.smartleadCampaigns)
        .where(eq(t.smartleadCampaigns.angle, seqs[0].template))
        .limit(1);
      if (enr?.email && camp) await this.smartlead.stopLead(camp.campaignId, enr.email);
    }
    await this.db.insert(t.events).values({ leadId, kind: 'sequence_stopped', payload: { why } });
  }

  async ensureCampaign(angle: string): Promise<string> {
    const [existing] = await this.db
      .select()
      .from(t.smartleadCampaigns)
      .where(eq(t.smartleadCampaigns.angle, angle))
      .limit(1);
    if (existing) return existing.campaignId;
    if (!this.smartlead) throw new Error('smartlead not configured');

    const remote = await this.smartlead.listCampaigns();
    const hit = remote.find((c) => c.name === `muninn-${angle}`);
    const campaignId = hit ? hit.id : await this.smartlead.createCampaign(angle);
    await this.db.insert(t.smartleadCampaigns).values({ angle, campaignId });
    await this.db.insert(t.vendorCalls).values({
      provider: 'smartlead',
      kind: hit ? 'campaign_found' : 'campaign_created',
      meta: { angle, campaignId },
    });
    return campaignId;
  }

  async allCampaigns(): Promise<{ angle: string; campaignId: string }[]> {
    const rows = await this.db.select().from(t.smartleadCampaigns);
    return rows.map((r) => ({ angle: r.angle, campaignId: r.campaignId }));
  }
}
