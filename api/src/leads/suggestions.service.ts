// The expansion-suggestions inbox (C3): apollo results land as pending rows;
// the operator accepts (→ normal ingest, same gates) or dismisses. Nothing
// here can queue outreach — accept only starts the enrich→analyze pipeline.
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/db';
import * as t from '../db/schema';
import { ApolloAdapter } from '../enrichment/apollo.adapter';
import { LeadsService, normalizeLinkedinUrl } from './leads.service';

export class SuggestionsService {
  constructor(
    private readonly db: Db,
    private readonly apollo: ApolloAdapter | null,
    private readonly leads: LeadsService,
  ) {}

  get available(): boolean {
    return this.apollo != null;
  }

  async expand(sourceLeadId: string, mode: 'colleagues' | 'lookalike'): Promise<{ found: number; inserted: number }> {
    if (!this.apollo) throw new Error('APOLLO_API_KEY missing — set it in Settings');
    const [lead] = await this.db.select().from(t.leads).where(eq(t.leads.id, sourceLeadId)).limit(1);
    if (!lead) throw new Error('source lead not found');
    const [enr] = await this.db
      .select()
      .from(t.leadEnrichments)
      .where(eq(t.leadEnrichments.leadId, sourceLeadId))
      .orderBy(desc(t.leadEnrichments.createdAt))
      .limit(1);

    const companyDomain = enr?.email?.includes('@') ? enr.email.split('@')[1] : null;
    const company = (enr?.company ?? {}) as Record<string, unknown>;
    const companyName = typeof company['name'] === 'string' ? (company['name'] as string) : null;
    const title = titleFromRaw(enr?.raw);

    const people = await this.apollo.findSimilar({
      mode,
      companyDomain,
      companyName,
      title,
      perPage: 10,
    });

    await this.db.insert(t.vendorCalls).values({
      provider: 'apollo',
      kind: `expand_${mode}`,
      leadId: sourceLeadId,
      meta: { found: people.length },
    });

    let inserted = 0;
    for (const p of people) {
      const url = p.linkedinUrl ? normalizeLinkedinUrl(p.linkedinUrl) : null;
      if (url) {
        // already tracked or suppressed → not a suggestion
        const existing = await this.db.select({ id: t.leads.id }).from(t.leads).where(eq(t.leads.linkedinUrl, url)).limit(1);
        if (existing.length > 0) continue;
        const sup = await this.db
          .select({ id: t.suppressions.id })
          .from(t.suppressions)
          .where(eq(t.suppressions.linkedinUrl, url))
          .limit(1);
        if (sup.length > 0) continue;
        const dupe = await this.db
          .select({ id: t.leadSuggestions.id })
          .from(t.leadSuggestions)
          .where(eq(t.leadSuggestions.linkedinUrl, url))
          .limit(1);
        if (dupe.length > 0) continue;
      }
      await this.db.insert(t.leadSuggestions).values({
        sourceLeadId,
        mode,
        name: p.name,
        title: p.title,
        company: p.company,
        linkedinUrl: url,
        raw: p.raw,
      });
      inserted++;
    }

    await this.db.insert(t.events).values({
      leadId: sourceLeadId,
      kind: 'expansion_ran',
      payload: { mode, found: people.length, inserted },
    });
    return { found: people.length, inserted };
  }

  async list(state: string): Promise<(typeof t.leadSuggestions.$inferSelect)[]> {
    return this.db
      .select()
      .from(t.leadSuggestions)
      .where(eq(t.leadSuggestions.state, state))
      .orderBy(desc(t.leadSuggestions.createdAt));
  }

  async accept(id: string): Promise<{ ok: boolean; result: string; leadId?: string }> {
    const [s] = await this.db.select().from(t.leadSuggestions).where(eq(t.leadSuggestions.id, id)).limit(1);
    if (!s) return { ok: false, result: 'not_found' };
    if (s.state !== 'pending') return { ok: false, result: `already_${s.state}` };
    if (!s.linkedinUrl) return { ok: false, result: 'no_linkedin_url' };
    const r = await this.leads.ingest(s.linkedinUrl, `expand:${s.sourceLeadId}`);
    if (r.kind === 'suppressed') {
      await this.db.update(t.leadSuggestions).set({ state: 'dismissed' }).where(eq(t.leadSuggestions.id, id));
      return { ok: false, result: 'suppressed' };
    }
    if (r.kind === 'invalid') return { ok: false, result: 'invalid_url' };
    await this.db
      .update(t.leadSuggestions)
      .set({ state: 'accepted', leadId: r.leadId })
      .where(eq(t.leadSuggestions.id, id));
    return { ok: true, result: r.kind, leadId: r.leadId };
  }

  async dismiss(id: string): Promise<{ ok: boolean }> {
    await this.db.update(t.leadSuggestions).set({ state: 'dismissed' }).where(eq(t.leadSuggestions.id, id));
    return { ok: true };
  }
}

function titleFromRaw(raw: unknown): string | null {
  const j = (raw ?? {}) as Record<string, unknown>;
  const datas = (Array.isArray(j['datas']) ? j['datas'] : []) as Record<string, unknown>[];
  const d = datas[0] ?? j;
  for (const k of ['title', 'headline', 'job_title']) {
    const v = d[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80);
  }
  return null;
}
