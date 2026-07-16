// Ingest (fig-1 "validate · dedupe · suppression check") + the lead view the
// dossier, the console (slice 2) and GET /v1/leads/:id all share.
import { and, desc, eq, ilike, inArray, type SQL } from 'drizzle-orm';
import type { Db } from '../db/db';
import * as t from '../db/schema';
import { tombstoneOf } from '../governance/tombstone';
import { QUEUES } from '../jobs/boss';

export function normalizeLinkedinUrl(raw: string): string | null {
  let s = (raw ?? '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
  const m = /^\/in\/([^/?#]+)/.exec(u.pathname);
  if (!m) return null;
  // LinkedIn vanity slugs are case-insensitive; lowercase makes dedupe exact.
  const slug = decodeURIComponent(m[1]).replace(/\/+$/, '').toLowerCase();
  if (!slug) return null;
  return `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;
}

export function extractLinkedinUrl(text: string): string | null {
  const m = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\/in\/[^\s<>"')\]]+/i.exec(text ?? '');
  return m ? m[0] : null;
}

export function slugOf(normalizedUrl: string): string {
  return decodeURIComponent(normalizedUrl.slice(normalizedUrl.lastIndexOf('/') + 1));
}

export type IngestResult =
  | { kind: 'created'; leadId: string }
  | { kind: 'existing'; leadId: string; status: string }
  | { kind: 'suppressed' }
  | { kind: 'invalid' };

type BossLike = { send(name: string, data: object): Promise<string | null> };

export class LeadsService {
  constructor(
    private readonly db: Db,
    private readonly boss: BossLike | null,
  ) {}

  async ingest(rawUrl: string, source: string): Promise<IngestResult> {
    const url = normalizeLinkedinUrl(rawUrl);
    if (!url) return { kind: 'invalid' };

    // plain suppression OR an erasure tombstone (G1): both refuse re-acquisition
    const sup = await this.db
      .select({ id: t.suppressions.id })
      .from(t.suppressions)
      .where(inArray(t.suppressions.linkedinUrl, [url, tombstoneOf(url)]))
      .limit(1);
    if (sup.length > 0) return { kind: 'suppressed' };

    const existing = await this.db.select().from(t.leads).where(eq(t.leads.linkedinUrl, url)).limit(1);
    if (existing.length > 0) return { kind: 'existing', leadId: existing[0].id, status: existing[0].status };

    const [lead] = await this.db.insert(t.leads).values({ linkedinUrl: url, source }).returning();
    await this.db.insert(t.events).values({ leadId: lead.id, kind: 'lead_ingested', payload: { source } });
    if (this.boss) await this.boss.send(QUEUES.enrich, { leadId: lead.id });
    return { kind: 'created', leadId: lead.id };
  }

  async view(leadId: string) {
    const [lead] = await this.db.select().from(t.leads).where(eq(t.leads.id, leadId)).limit(1);
    if (!lead) return null;
    const enrichments = await this.db
      .select()
      .from(t.leadEnrichments)
      .where(eq(t.leadEnrichments.leadId, leadId))
      .orderBy(desc(t.leadEnrichments.createdAt))
      .limit(1);
    const analyses = await this.db
      .select()
      .from(t.leadAnalyses)
      .where(eq(t.leadAnalyses.leadId, leadId))
      .orderBy(desc(t.leadAnalyses.createdAt))
      .limit(1);
    const drafts = await this.db
      .select()
      .from(t.messages)
      .where(eq(t.messages.leadId, leadId))
      .orderBy(t.messages.step);
    return { lead, enrichment: enrichments[0] ?? null, analysis: analyses[0] ?? null, drafts };
  }

  async setStatus(leadId: string, status: string, note?: string): Promise<void> {
    await this.db.update(t.leads).set({ status, updatedAt: new Date() }).where(eq(t.leads.id, leadId));
    await this.db
      .insert(t.events)
      .values({ leadId, kind: 'lead_status_change', payload: { status, note: note ?? null } });
  }

  async saveNote(leadId: string, note: string): Promise<void> {
    await this.db
      .insert(t.events)
      .values({ leadId, kind: 'operator_note', payload: { note: note.slice(0, 2000) } });
  }

  // ── the console surface (slice 2) ─────────────────────────────────────────

  // Fetch-then-merge keeps the query trivial at design-partner scale (≤ a few
  // hundred leads); the 1000-row cap is the honesty limit, not a hidden filter.
  async list(filter: {
    status?: string;
    angle?: string;
    fitMin?: number;
    q?: string;
    limit?: number;
    offset?: number;
  }) {
    const conds: SQL[] = [];
    if (filter.status) conds.push(eq(t.leads.status, filter.status));
    if (filter.q) conds.push(ilike(t.leads.linkedinUrl, `%${filter.q}%`));
    const rows = await this.db
      .select()
      .from(t.leads)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(t.leads.updatedAt))
      .limit(1000);

    const ids = rows.map((r) => r.id);
    const analyses = ids.length
      ? await this.db.select().from(t.leadAnalyses).where(inArray(t.leadAnalyses.leadId, ids)).orderBy(desc(t.leadAnalyses.createdAt))
      : [];
    const enrichments = ids.length
      ? await this.db.select().from(t.leadEnrichments).where(inArray(t.leadEnrichments.leadId, ids)).orderBy(desc(t.leadEnrichments.createdAt))
      : [];
    const aBy = new Map<string, (typeof analyses)[number]>();
    for (const a of analyses) if (!aBy.has(a.leadId)) aBy.set(a.leadId, a);
    const eBy = new Map<string, (typeof enrichments)[number]>();
    for (const e of enrichments) if (!eBy.has(e.leadId)) eBy.set(e.leadId, e);

    let merged = rows.map((l) => {
      const a = aBy.get(l.id) ?? null;
      const e = eBy.get(l.id) ?? null;
      const company = (e?.company ?? {}) as Record<string, unknown>;
      return {
        id: l.id,
        linkedinUrl: l.linkedinUrl,
        status: l.status,
        source: l.source,
        lastError: l.lastError,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
        fit: a?.fitScore ?? null,
        angle: a?.angle ?? null,
        icp: a?.icp ?? null,
        email: e?.email ?? null,
        emailStatus: e?.emailStatus ?? null,
        company: typeof company['name'] === 'string' ? (company['name'] as string) : null,
      };
    });
    if (filter.angle) merged = merged.filter((m) => m.angle === filter.angle);
    if (filter.fitMin != null) merged = merged.filter((m) => (m.fit ?? -1) >= filter.fitMin!);

    const total = merged.length;
    const offset = filter.offset ?? 0;
    const limit = Math.min(filter.limit ?? 50, 200);
    return { total, rows: merged.slice(offset, offset + limit) };
  }

  // The lead drawer's merged timeline — the per-person outreach audit chain.
  async timeline(leadId: string) {
    const [evts, msgs, enrs, anas, rems] = await Promise.all([
      this.db.select().from(t.events).where(eq(t.events.leadId, leadId)),
      this.db.select().from(t.messages).where(eq(t.messages.leadId, leadId)),
      this.db.select().from(t.leadEnrichments).where(eq(t.leadEnrichments.leadId, leadId)),
      this.db.select().from(t.leadAnalyses).where(eq(t.leadAnalyses.leadId, leadId)),
      this.db.select().from(t.reminders).where(eq(t.reminders.leadId, leadId)),
    ]);
    return [
      ...evts.map((e) => ({ at: e.at, kind: e.kind, detail: e.payload as unknown })),
      ...msgs.map((m) => ({
        at: m.createdAt,
        kind: `draft·${m.channel}`,
        detail: { id: m.id, step: m.step, subject: m.subject, status: m.status } as unknown,
      })),
      ...enrs.map((e) => ({
        at: e.createdAt,
        kind: 'enrichment',
        detail: { provider: e.provider, emailStatus: e.emailStatus, costUsd: e.costUsd } as unknown,
      })),
      ...anas.map((a) => ({
        at: a.createdAt,
        kind: 'analysis',
        detail: { fit: a.fitScore, icp: a.icp, angle: a.angle, model: a.model } as unknown,
      })),
      ...rems.map((r) => ({
        at: r.createdAt,
        kind: r.doneAt ? 'reminder·done' : 'reminder',
        detail: { id: r.id, note: r.note, dueAt: r.dueAt } as unknown,
      })),
    ].sort((x, y) => y.at.getTime() - x.at.getTime());
  }

  async addReminder(leadId: string, note: string, dueAt: Date) {
    const [r] = await this.db
      .insert(t.reminders)
      .values({ leadId, note: note.slice(0, 500), dueAt })
      .returning();
    return r;
  }

  async completeReminder(id: string): Promise<void> {
    await this.db.update(t.reminders).set({ doneAt: new Date() }).where(eq(t.reminders.id, id));
  }

  async updateDraft(
    messageId: string,
    patch: { subject?: string | null; bodyMd?: string },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const [msg] = await this.db.select().from(t.messages).where(eq(t.messages.id, messageId)).limit(1);
    if (!msg) return { ok: false, error: 'not_found' };
    if (msg.status !== 'draft') return { ok: false, error: 'not_a_draft' };
    const set: Partial<{ subject: string | null; bodyMd: string }> = {};
    if (patch.subject !== undefined) set.subject = patch.subject;
    if (patch.bodyMd !== undefined) set.bodyMd = patch.bodyMd;
    if (Object.keys(set).length === 0) return { ok: false, error: 'nothing_to_update' };
    await this.db.update(t.messages).set(set).where(eq(t.messages.id, messageId));
    await this.db.insert(t.events).values({ leadId: msg.leadId, messageId, kind: 'draft_edited', payload: { step: msg.step } });
    return { ok: true };
  }

  async bulkStatus(ids: string[], status: 'queued' | 'parked'): Promise<{ changed: number }> {
    let changed = 0;
    for (const id of ids.slice(0, 100)) {
      await this.setStatus(id, status, 'bulk via console');
      changed++;
    }
    return { changed };
  }
}
