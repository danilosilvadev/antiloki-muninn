// G1 — data-subject erasure: "delete everything on person X" across every
// table that knows them, leaving ONLY hashed suppression tombstones so the
// machine can never re-acquire them. The one deliberate exception: the
// vendor cost ledger keeps provider/kind/cost (a financial record), scrubbed
// of lead_id and meta — money spent stays true, the person is gone.
//
// The same row-cascade, WITHOUT tombstones, is retention's purge (G2):
// an aged-out lead may legitimately come back; an erased person must not.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/db';
import * as t from '../db/schema';
import { normalizeLinkedinUrl } from '../leads/leads.service';
import { tombstoneOf } from './tombstone';

export interface ErasureTarget {
  leadId?: string;
  email?: string;
  linkedinUrl?: string;
}

export interface ErasureReport {
  leads: number;
  waitlistMembers: number;
  rows: Record<string, number>;
  emailHashes: string[];
  urlHashes: string[];
}

export class ErasureService {
  constructor(
    private readonly db: Db,
    private readonly notify: (html: string) => Promise<void>,
  ) {}

  // ── identity resolution ─────────────────────────────────────────────────
  // A person can be known by lead id, linkedin url, and any enriched email.
  // Expand to a fixpoint so "erase by email" also erases the lead the email
  // was found on, and every alias that lead carries.
  private async resolve(target: ErasureTarget): Promise<{ leadIds: string[]; emails: string[]; urls: string[] }> {
    const emails = new Set<string>();
    const urls = new Set<string>();
    const leadIds = new Set<string>();

    if (target.email) emails.add(target.email.trim().toLowerCase());
    if (target.linkedinUrl) {
      const u = normalizeLinkedinUrl(target.linkedinUrl);
      if (u) urls.add(u);
    }
    if (target.leadId) leadIds.add(target.leadId);

    for (let pass = 0; pass < 4; pass++) {
      const before = leadIds.size + emails.size + urls.size;

      if (urls.size > 0) {
        const rows = await this.db
          .select({ id: t.leads.id })
          .from(t.leads)
          .where(inArray(t.leads.linkedinUrl, [...urls]));
        for (const r of rows) leadIds.add(r.id);
      }
      if (emails.size > 0) {
        const rows = await this.db
          .select({ leadId: t.leadEnrichments.leadId })
          .from(t.leadEnrichments)
          .where(inArray(t.leadEnrichments.email, [...emails]));
        for (const r of rows) leadIds.add(r.leadId);
      }
      if (leadIds.size > 0) {
        const rows = await this.db
          .select({ id: t.leads.id, url: t.leads.linkedinUrl })
          .from(t.leads)
          .where(inArray(t.leads.id, [...leadIds]));
        for (const r of rows) urls.add(r.url);
        const enr = await this.db
          .select({ email: t.leadEnrichments.email })
          .from(t.leadEnrichments)
          .where(inArray(t.leadEnrichments.leadId, [...leadIds]));
        for (const r of enr) if (r.email) emails.add(r.email.toLowerCase());
      }

      if (leadIds.size + emails.size + urls.size === before) break;
    }
    return { leadIds: [...leadIds], emails: [...emails], urls: [...urls] };
  }

  // ── the row cascade for one lead ────────────────────────────────────────
  // Shared by erasure (with tombstones) and retention purge (without).
  async purgeLeadRows(leadId: string, rows: Record<string, number>): Promise<void> {
    const bump = (k: string, n: number): void => {
      rows[k] = (rows[k] ?? 0) + n;
    };
    bump('messages', (await this.db.delete(t.messages).where(eq(t.messages.leadId, leadId)).returning({ id: t.messages.id })).length);
    bump('sequences', (await this.db.delete(t.sequences).where(eq(t.sequences.leadId, leadId)).returning({ id: t.sequences.id })).length);
    bump('lead_analyses', (await this.db.delete(t.leadAnalyses).where(eq(t.leadAnalyses.leadId, leadId)).returning({ id: t.leadAnalyses.id })).length);
    bump('lead_enrichments', (await this.db.delete(t.leadEnrichments).where(eq(t.leadEnrichments.leadId, leadId)).returning({ id: t.leadEnrichments.id })).length);
    bump('reminders', (await this.db.delete(t.reminders).where(eq(t.reminders.leadId, leadId)).returning({ id: t.reminders.id })).length);
    bump('policy_refusals', (await this.db.delete(t.policyRefusals).where(eq(t.policyRefusals.leadId, leadId)).returning({ id: t.policyRefusals.id })).length);
    bump('lead_suggestions', (await this.db.delete(t.leadSuggestions).where(eq(t.leadSuggestions.leadId, leadId)).returning({ id: t.leadSuggestions.id })).length);
    bump('consents', (await this.db.delete(t.consents).where(eq(t.consents.leadId, leadId)).returning({ id: t.consents.id })).length);
    bump('events', (await this.db.delete(t.events).where(eq(t.events.leadId, leadId)).returning({ id: t.events.id })).length);
    // the cost ledger survives, scrubbed: money spent stays true, the person is gone
    bump('vendor_calls_scrubbed', (
      await this.db
        .update(t.vendorCalls)
        .set({ leadId: null, meta: null })
        .where(eq(t.vendorCalls.leadId, leadId))
        .returning({ id: t.vendorCalls.id })
    ).length);
    bump('leads', (await this.db.delete(t.leads).where(eq(t.leads.id, leadId)).returning({ id: t.leads.id })).length);
  }

  // ── the full erasure ────────────────────────────────────────────────────
  async erase(target: ErasureTarget): Promise<ErasureReport> {
    const { leadIds, emails, urls } = await this.resolve(target);
    const rows: Record<string, number> = {};

    for (const id of leadIds) await this.purgeLeadRows(id, rows);

    // suggestion rows that ARE this person (found via expansion, never accepted)
    if (urls.length > 0) {
      rows['lead_suggestions'] = (rows['lead_suggestions'] ?? 0) + (
        await this.db.delete(t.leadSuggestions).where(inArray(t.leadSuggestions.linkedinUrl, urls)).returning({ id: t.leadSuggestions.id })
      ).length;
    }

    // the waitlist half: member, their invites, their consents
    let waitlistMembers = 0;
    if (emails.length > 0) {
      const members = await this.db
        .select({ id: t.waitlistMembers.id })
        .from(t.waitlistMembers)
        .where(inArray(t.waitlistMembers.email, emails));
      if (members.length > 0) {
        const memberIds = members.map((m) => m.id);
        rows['invites'] = (await this.db.delete(t.invites).where(inArray(t.invites.issuedTo, memberIds)).returning({ id: t.invites.id })).length;
        waitlistMembers = (await this.db.delete(t.waitlistMembers).where(inArray(t.waitlistMembers.id, memberIds)).returning({ id: t.waitlistMembers.id })).length;
      }
      rows['consents'] = (rows['consents'] ?? 0) + (
        await this.db.delete(t.consents).where(inArray(t.consents.email, emails)).returning({ id: t.consents.id })
      ).length;
      // the public request event carries the plain email — it goes too
      rows['events'] = (rows['events'] ?? 0) + (
        await this.db
          .delete(t.events)
          .where(and(eq(t.events.kind, 'erasure_requested'), inArray(sql`${t.events.payload}->>'email'`, emails)))
          .returning({ id: t.events.id })
      ).length;
    }

    // plain suppression rows about them are themselves PII — replace with tombstones
    if (emails.length > 0) {
      await this.db.delete(t.suppressions).where(inArray(t.suppressions.email, emails));
    }
    if (urls.length > 0) {
      await this.db.delete(t.suppressions).where(inArray(t.suppressions.linkedinUrl, urls));
    }
    const emailHashes = emails.map(tombstoneOf);
    const urlHashes = urls.map(tombstoneOf);
    for (const h of emailHashes) await this.db.insert(t.suppressions).values({ email: h, reason: 'erasure' });
    for (const h of urlHashes) await this.db.insert(t.suppressions).values({ linkedinUrl: h, reason: 'erasure' });

    await this.db.insert(t.events).values({
      kind: 'erasure_completed',
      payload: { email_hashes: emailHashes, url_hashes: urlHashes, leads: leadIds.length, rows },
    });
    await this.notify(
      `⌫ <b>erasure completed</b> — ${leadIds.length} lead(s), ${waitlistMembers} waitlist row(s), ` +
        `${Object.values(rows).reduce((a, b) => a + b, 0)} rows total. Only hashed tombstones remain.`,
    );
    return { leads: leadIds.length, waitlistMembers, rows, emailHashes, urlHashes };
  }
}
