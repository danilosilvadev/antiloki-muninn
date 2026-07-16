// C4 — the dossier factory. One acceptance path (acceptAnalysis), one retry
// with the validator's own complaints, then fail loudly. Every call lands a
// vendor_calls ledger row whether or not the output was accepted.
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/db';
import * as t from '../db/schema';
import { OpenRouterClient } from './openrouter.client';
import { acceptAnalysis, analysisJsonSchema, draftBudgetViolations, type Analysis } from './schema';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt';

export interface AnalysisOutcome {
  leadId: string;
  analysis: Analysis;
  status: 'analyzed' | 'parked';
  violations: string[];
  retried: boolean;
}

export class AnalysisService {
  constructor(
    private readonly db: Db,
    private readonly client: OpenRouterClient,
    private readonly fitThreshold: number,
  ) {}

  async run(leadId: string): Promise<AnalysisOutcome> {
    const [lead] = await this.db.select().from(t.leads).where(eq(t.leads.id, leadId)).limit(1);
    if (!lead) throw new Error(`analysis: lead ${leadId} not found`);
    const [enr] = await this.db
      .select()
      .from(t.leadEnrichments)
      .where(eq(t.leadEnrichments.leadId, leadId))
      .orderBy(desc(t.leadEnrichments.createdAt))
      .limit(1);
    if (!enr) throw new Error(`analysis: lead ${leadId} has no enrichment`);

    // the D4 → C4 loop: recent reject reasons steer every future dossier
    const rejections = await this.db
      .select()
      .from(t.events)
      .where(eq(t.events.kind, 'draft_rejected'))
      .orderBy(desc(t.events.at))
      .limit(5);
    const steering = rejections
      .map((r) => {
        const p = (r.payload ?? {}) as Record<string, unknown>;
        return typeof p['reason'] === 'string' ? (p['reason'] as string) : null;
      })
      .filter((x): x is string => Boolean(x));

    const user = buildUserPrompt({
      linkedinUrl: lead.linkedinUrl,
      email: enr.email,
      emailStatus: enr.emailStatus,
      company: enr.company,
      raw: enr.raw,
      steering,
    });
    const jsonSchema = analysisJsonSchema();

    let result = await this.client.structured({
      system: SYSTEM_PROMPT,
      user,
      schemaName: 'muninn_lead_analysis',
      jsonSchema,
    });
    let accepted = acceptAnalysis(result.parsed);
    let retried = false;
    let totalCost = result.costUsd ?? 0;
    let tokensIn = result.tokensIn ?? 0;
    let tokensOut = result.tokensOut ?? 0;

    if (!accepted.ok) {
      retried = true;
      result = await this.client.structured({
        system: SYSTEM_PROMPT,
        user:
          user +
          '\n\nYour previous output failed validation — fix EXACTLY these issues and return the corrected JSON only:\n' +
          accepted.issues,
        schemaName: 'muninn_lead_analysis',
        jsonSchema,
      });
      accepted = acceptAnalysis(result.parsed);
      totalCost += result.costUsd ?? 0;
      tokensIn += result.tokensIn ?? 0;
      tokensOut += result.tokensOut ?? 0;
    }

    await this.db.insert(t.vendorCalls).values({
      provider: 'openrouter',
      kind: 'analyze',
      leadId,
      costUsd: totalCost > 0 ? String(totalCost) : null,
      tokensIn,
      tokensOut,
      meta: { model: this.client.model, retried, accepted: accepted.ok },
    });

    if (!accepted.ok) {
      throw new Error(`analysis rejected after retry: ${accepted.issues}`);
    }

    const a = accepted.analysis;
    const status: AnalysisOutcome['status'] = a.fit_score >= this.fitThreshold ? 'analyzed' : 'parked';

    await this.db.insert(t.leadAnalyses).values({
      leadId,
      fitScore: a.fit_score,
      icp: a.icp,
      angle: a.angle,
      pains: a.pains,
      hooks: a.hooks,
      briefMd: a.brief_md,
      model: this.client.model,
    });

    for (let i = 0; i < a.drafts.length; i++) {
      const d = a.drafts[i];
      await this.db.insert(t.messages).values({
        leadId,
        channel: d.channel,
        step: i,
        subject: d.subject,
        bodyMd: d.body,
        status: 'draft',
      });
    }

    await this.db.update(t.leads).set({ status, updatedAt: new Date() }).where(eq(t.leads.id, leadId));
    await this.db.insert(t.events).values({
      leadId,
      kind: 'lead_analyzed',
      payload: { fit: a.fit_score, icp: a.icp, angle: a.angle, status, retried },
    });

    return { leadId, analysis: a, status, violations: draftBudgetViolations(a), retried };
  }
}
