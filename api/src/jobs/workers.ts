// The job handlers wiring enrich → analyze → dossier. Every failure path ends
// in the same place: lead parked with last_error + an operator notification —
// the machine never fails silently.
import { eq } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import type { Db } from '../db/db';
import * as t from '../db/schema';
import { AnalysisService } from '../analysis/analysis.service';
import { EnrichmentService } from '../enrichment/enrichment.service';
import { escapeHtml } from '../telegram/dossier';
import { QUEUES } from './boss';

export interface WorkerDeps {
  db: Db;
  boss: PgBoss;
  enrichment: EnrichmentService;
  analysis: AnalysisService;
  notify: (html: string) => Promise<void>;
  sendDossier: (leadId: string, violations: string[]) => Promise<void>;
  digest: () => Promise<void>;
  weeklyDigest: (() => Promise<void>) | null; // slice 4: C11 — the targets digest
  tick: (() => Promise<{ drained: number }>) | null; // slice 3: the gate & send scheduler
}

const MAX_POLLS = 25; // × 5s ≈ 2 min of vendor patience per enrichment

interface EnrichJobData {
  leadId: string;
  vendorJobId?: string;
  polls?: number;
}

export async function registerWorkers(d: WorkerDeps): Promise<void> {
  await d.boss.work(QUEUES.enrich, async ([job]: PgBoss.Job<EnrichJobData>[]) => {
    const data = job.data;
    try {
      const r = await d.enrichment.step(data.leadId, data.vendorJobId ?? null);
      if (r.kind === 'started') {
        await d.boss.send(QUEUES.enrich, { leadId: data.leadId, vendorJobId: r.enrichmentId, polls: 0 }, { startAfter: 4 });
      } else if (r.kind === 'pending') {
        const polls = (data.polls ?? 0) + 1;
        if (polls > MAX_POLLS) throw new Error(`enrichment timed out after ${MAX_POLLS} polls`);
        await d.boss.send(QUEUES.enrich, { ...data, polls }, { startAfter: 5 });
      } else if (r.kind === 'done' || r.kind === 'skipped') {
        await d.boss.send(QUEUES.analyze, { leadId: data.leadId });
      } else {
        throw new Error(r.reason);
      }
    } catch (e) {
      await parkWithError(d, data.leadId, 'enrichment', e);
    }
  });

  await d.boss.work(QUEUES.analyze, async ([job]: PgBoss.Job<{ leadId: string }>[]) => {
    const { leadId } = job.data;
    try {
      const existing = await d.db
        .select({ id: t.leadAnalyses.id })
        .from(t.leadAnalyses)
        .where(eq(t.leadAnalyses.leadId, leadId))
        .limit(1);
      let violations: string[] = [];
      if (existing.length === 0) {
        const outcome = await d.analysis.run(leadId);
        violations = outcome.violations;
        if (outcome.status === 'parked') {
          await d.notify(
            `🅿 <code>${leadId.slice(0, 8)}</code> parked — fit ${outcome.analysis.fit_score} below threshold. Kept in the record.`,
          );
          return;
        }
      }
      await d.sendDossier(leadId, violations);
    } catch (e) {
      await parkWithError(d, leadId, 'analysis', e);
    }
  });

  await d.boss.work(QUEUES.digest, async () => {
    await d.digest();
  });

  if (d.weeklyDigest) {
    const weekly = d.weeklyDigest;
    await d.boss.work(QUEUES.weeklyDigest, async () => {
      await weekly();
    });
  }

  if (d.tick) {
    const tick = d.tick;
    await d.boss.work(QUEUES.sequenceTick, async () => {
      await tick();
    });
  }
}

async function parkWithError(d: WorkerDeps, leadId: string, stage: string, e: unknown): Promise<void> {
  const msg = `${stage}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
  console.error(`[workers] lead ${leadId} → parked —`, msg);
  try {
    await d.db.update(t.leads).set({ status: 'parked', lastError: msg, updatedAt: new Date() }).where(eq(t.leads.id, leadId));
    await d.db.insert(t.events).values({ leadId, kind: 'pipeline_error', payload: { error: msg } });
    await d.notify(`⚠️ <code>${leadId.slice(0, 8)}</code> parked — ${escapeHtml(msg).slice(0, 300)}`);
  } catch (e2) {
    console.error('[workers] parkWithError itself failed:', e2);
  }
}
