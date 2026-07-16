// C7 — the scheduler tick (every minute): drain webhook events into state
// transitions, enforce the kill switch, run the domain-health math, and
// surface due manual-LinkedIn touches. Everything the tick does lands in
// events; nothing here composes or sends a message on its own.
import { and, asc, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { Db } from '../db/db';
import * as t from '../db/schema';
import { OpenRouterClient } from '../analysis/openrouter.client';
import { classifyReply } from '../channels/classify';
import { SequenceService } from '../channels/sequence.service';
import { SmartleadAdapter } from '../channels/smartlead.adapter';
import { FLAG_ANGLE_PAUSED, FLAG_HEALTH_PAUSED, FLAG_PAUSE_ALL, FLAG_PAUSE_APPLIED, PolicyService } from '../policy/policy.service';
import { escapeHtml } from '../telegram/dossier';

export interface TickDeps {
  db: Db;
  policy: PolicyService;
  sequences: SequenceService;
  smartlead: SmartleadAdapter | null;
  classifier: OpenRouterClient | null;
  notify: (html: string) => Promise<void>;
}

const DRAIN_KINDS = ['sent', 'open', 'click', 'reply', 'bounce', 'unsub', 'complaint'];
type EventRow = typeof t.events.$inferSelect;

export async function runTick(d: TickDeps): Promise<{ drained: number }> {
  const drained = await drainEvents(d);
  await enforcePauseAll(d);
  await checkDomainHealth(d);
  await surfaceLinkedinDue(d);
  return { drained };
}

async function drainEvents(d: TickDeps): Promise<number> {
  const rows = await d.db
    .select()
    .from(t.events)
    .where(and(isNull(t.events.processedAt), inArray(t.events.kind, DRAIN_KINDS)))
    .orderBy(asc(t.events.at))
    .limit(200);
  for (const ev of rows) {
    try {
      await processEvent(d, ev);
    } catch (e) {
      console.error('[tick] event processing failed', ev.id, e);
    }
    // events stay append-only in spirit: processed_at is the ONE column ever stamped
    await d.db.update(t.events).set({ processedAt: new Date() }).where(eq(t.events.id, ev.id));
  }
  return rows.length;
}

async function resolveLeadId(d: TickDeps, ev: EventRow, email: string | null): Promise<string | null> {
  if (ev.leadId) return ev.leadId;
  if (!email) return null;
  const [enr] = await d.db
    .select({ leadId: t.leadEnrichments.leadId })
    .from(t.leadEnrichments)
    .where(eq(t.leadEnrichments.email, email))
    .orderBy(desc(t.leadEnrichments.createdAt))
    .limit(1);
  return enr?.leadId ?? null;
}

async function processEvent(d: TickDeps, ev: EventRow): Promise<void> {
  const payload = (ev.payload ?? {}) as Record<string, unknown>;
  const email = typeof payload['email'] === 'string' ? (payload['email'] as string) : null;
  const leadId = await resolveLeadId(d, ev, email);

  switch (ev.kind) {
    case 'sent': {
      if (leadId) {
        const [msg] = await d.db
          .select()
          .from(t.messages)
          .where(and(eq(t.messages.leadId, leadId), eq(t.messages.status, 'scheduled'), eq(t.messages.channel, 'email')))
          .orderBy(asc(t.messages.step))
          .limit(1);
        if (msg) {
          await d.db.update(t.messages).set({ status: 'sent', sentAt: ev.at }).where(eq(t.messages.id, msg.id));
        }
      }
      break;
    }
    case 'reply': {
      if (leadId) {
        await d.sequences.stopForLead(leadId, 'reply');
        await d.db.update(t.leads).set({ status: 'replied', updatedAt: new Date() }).where(eq(t.leads.id, leadId));
      }
      const replyText = typeof payload['reply_text'] === 'string' ? (payload['reply_text'] as string) : null;
      let labelTxt = '';
      if (replyText && d.classifier) {
        const label = await classifyReply(d.classifier, replyText);
        if (label) {
          labelTxt = ` — <b>${label.label}</b> (${label.confidence})`;
          await d.db.insert(t.vendorCalls).values({
            provider: 'openrouter',
            kind: 'classify',
            leadId,
            costUsd: label.costUsd != null ? String(label.costUsd) : null,
            tokensIn: label.tokensIn,
            tokensOut: label.tokensOut,
            meta: { label: label.label, confidence: label.confidence },
          });
          await d.db.insert(t.events).values({
            leadId,
            kind: 'reply_labeled',
            payload: { label: label.label, confidence: label.confidence },
          });
        }
      }
      await d.notify(
        `↩ <b>reply</b>${labelTxt} from ${escapeHtml(email ?? 'unknown')}` +
          (replyText ? `\n<i>${escapeHtml(replyText.slice(0, 220))}</i>` : '') +
          `\nsequence paused — your move (labels never auto-act).`,
      );
      break;
    }
    case 'bounce': {
      if (leadId) {
        await d.sequences.stopForLead(leadId, 'bounce');
        await d.db
          .update(t.leads)
          .set({ status: 'parked', lastError: 'email bounced', updatedAt: new Date() })
          .where(eq(t.leads.id, leadId));
      }
      await d.notify(`⚠️ bounce: ${escapeHtml(email ?? 'unknown')} — suppressed at the sink, sequence stopped.`);
      break;
    }
    case 'unsub':
    case 'complaint': {
      if (leadId) {
        await d.sequences.stopForLead(leadId, ev.kind);
        await d.db.update(t.leads).set({ status: 'suppressed', updatedAt: new Date() }).where(eq(t.leads.id, leadId));
      }
      await d.notify(
        ev.kind === 'unsub'
          ? `🛑 unsubscribe: ${escapeHtml(email ?? 'unknown')} — honored at the edge (<1s), sequence stopped.`
          : `🚨 SPAM COMPLAINT: ${escapeHtml(email ?? 'unknown')} — suppressed; domain-health math runs this tick.`,
      );
      break;
    }
    default:
      break; // open/click: audit-chain only
  }
}

async function enforcePauseAll(d: TickDeps): Promise<void> {
  const on = await d.policy.getFlag<boolean>(FLAG_PAUSE_ALL, false);
  const applied = await d.policy.getFlag<boolean>(FLAG_PAUSE_APPLIED, false);
  if (on === applied) return;
  const campaigns = await d.sequences.allCampaigns();
  // lifting pause-all must NOT resume an angle the operator paused individually
  const anglePaused = await d.policy.getFlag<Record<string, boolean>>(FLAG_ANGLE_PAUSED, {});
  if (d.smartlead) {
    for (const c of campaigns) {
      if (!on && anglePaused[c.angle]) continue;
      try {
        await d.smartlead.setCampaignStatus(c.campaignId, on ? 'PAUSED' : 'START');
      } catch (e) {
        console.error('[tick] campaign status flip failed', c.angle, e);
      }
    }
  }
  await d.policy.setFlag(FLAG_PAUSE_APPLIED, on);
  await d.db.insert(t.events).values({
    kind: on ? 'pause_all_applied' : 'pause_all_lifted',
    payload: { campaigns: campaigns.length },
  });
  await d.notify(
    on
      ? `⏸ <b>PAUSE ALL</b> applied — ${campaigns.length} campaign(s) paused within one tick.`
      : `▶ pause-all lifted — campaigns resumed.`,
  );
}

async function checkDomainHealth(d: TickDeps): Promise<void> {
  const flag = await d.policy.getFlag<{ on?: boolean }>(FLAG_HEALTH_PAUSED, {});
  if (flag?.on) return; // held until the operator clears it, deliberately
  const rates = await d.policy.healthRates();
  const over =
    (rates.bounceRate != null && rates.bounceRate > 0.02) ||
    (rates.complaintRate != null && rates.complaintRate >= 0.001);
  if (!over) return;
  await d.policy.setFlag(FLAG_HEALTH_PAUSED, { on: true, rates, at: new Date().toISOString() });
  const campaigns = await d.sequences.allCampaigns();
  if (d.smartlead) {
    for (const c of campaigns) {
      try {
        await d.smartlead.setCampaignStatus(c.campaignId, 'PAUSED');
      } catch { /* logged below regardless */ }
    }
  }
  await d.db.insert(t.events).values({ kind: 'domain_health_pause', payload: rates });
  await d.notify(
    `⛔ <b>domain-health auto-pause</b>: bounce ${((rates.bounceRate ?? 0) * 100).toFixed(1)}% · complaints ${((rates.complaintRate ?? 0) * 100).toFixed(2)}% — campaigns paused. Root-cause, then clear it from the console.`,
  );
}

async function surfaceLinkedinDue(d: TickDeps): Promise<void> {
  const due = await d.db
    .select()
    .from(t.sequences)
    .where(and(eq(t.sequences.status, 'running'), lte(t.sequences.nextRunAt, new Date())))
    .limit(20);
  for (const s of due) {
    await d.db.update(t.sequences).set({ nextRunAt: null, step: 1 }).where(eq(t.sequences.id, s.id));
    await d.db.insert(t.events).values({ leadId: s.leadId, kind: 'linkedin_touch_due', payload: { sequenceId: s.id } });
    await d.notify(
      `💼 day-3 LinkedIn touch due for <code>${s.leadId.slice(0, 8)}</code> — the note is in the drawer; you send it in the real UI, then mark it sent. (P1 stays manual.)`,
    );
  }
}
