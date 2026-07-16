// Ingest (fig-1 "validate · dedupe · suppression check") + the lead view the
// dossier, the console (slice 2) and GET /v1/leads/:id all share.
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/db';
import * as t from '../db/schema';
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

    const sup = await this.db
      .select({ id: t.suppressions.id })
      .from(t.suppressions)
      .where(eq(t.suppressions.linkedinUrl, url))
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
}
