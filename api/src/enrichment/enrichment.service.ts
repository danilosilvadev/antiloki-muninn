// One enrichment step per job attempt: start at the vendor, or poll a running
// vendor job. Idempotent by construction — an existing lead_enrichments row
// short-circuits to 'skipped', so re-delivered jobs never double-spend (C2).
import { eq } from 'drizzle-orm';
import type { Db } from '../db/db';
import * as t from '../db/schema';
import { FullEnrichAdapter, nameGuessFromSlug } from './fullenrich.adapter';
import { slugOf } from '../leads/leads.service';

export type EnrichStepResult =
  | { kind: 'started'; enrichmentId: string }
  | { kind: 'pending' }
  | { kind: 'done'; email: string | null; emailStatus: string | null }
  | { kind: 'skipped' }
  | { kind: 'failed'; reason: string };

export class EnrichmentService {
  constructor(
    private readonly db: Db,
    private readonly adapter: FullEnrichAdapter,
  ) {}

  async step(leadId: string, vendorJobId: string | null): Promise<EnrichStepResult> {
    const [lead] = await this.db.select().from(t.leads).where(eq(t.leads.id, leadId)).limit(1);
    if (!lead) return { kind: 'failed', reason: 'lead not found' };

    const existing = await this.db
      .select({ id: t.leadEnrichments.id })
      .from(t.leadEnrichments)
      .where(eq(t.leadEnrichments.leadId, leadId))
      .limit(1);
    if (existing.length > 0) return { kind: 'skipped' };

    if (!vendorJobId) {
      const guess = nameGuessFromSlug(slugOf(lead.linkedinUrl));
      const started = await this.adapter.start({
        linkedinUrl: lead.linkedinUrl,
        firstname: guess.firstname,
        lastname: guess.lastname,
      });
      await this.db.insert(t.vendorCalls).values({
        provider: 'fullenrich',
        kind: 'enrich_start',
        leadId,
        meta: { enrichmentId: started.enrichmentId },
      });
      return { kind: 'started', enrichmentId: started.enrichmentId };
    }

    const polled = await this.adapter.poll(vendorJobId);
    if (polled.status === 'pending') return { kind: 'pending' };
    if (polled.status === 'failed') return { kind: 'failed', reason: 'vendor reported failure' };

    const cost = this.adapter.costUsd(polled.creditsUsed);
    await this.db.insert(t.leadEnrichments).values({
      leadId,
      provider: 'fullenrich',
      raw: polled.raw,
      email: polled.email,
      emailStatus: polled.emailStatus,
      company: polled.company,
      costUsd: cost != null ? String(cost) : null,
    });
    await this.db.insert(t.vendorCalls).values({
      provider: 'fullenrich',
      kind: 'enrich_done',
      leadId,
      costUsd: cost != null ? String(cost) : null,
      meta: { emailStatus: polled.emailStatus },
    });
    await this.db.update(t.leads).set({ status: 'enriched', updatedAt: new Date() }).where(eq(t.leads.id, leadId));
    await this.db.insert(t.events).values({
      leadId,
      kind: 'lead_enriched',
      payload: { provider: 'fullenrich', emailStatus: polled.emailStatus },
    });
    return { kind: 'done', email: polled.email, emailStatus: polled.emailStatus };
  }
}
