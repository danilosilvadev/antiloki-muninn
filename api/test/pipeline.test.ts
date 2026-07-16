// The slice-1 integration test: the REAL migration SQL runs on pglite
// (in-memory Postgres), then the actual services drive ingest → enrich →
// analyze with faked vendors. Any drift between the SQL and the drizzle
// mirror — or any broken pipeline seam — explodes here, offline, for free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import * as t from '../src/db/schema';
import type { Db } from '../src/db/db';
import { LeadsService } from '../src/leads/leads.service';
import { EnrichmentService } from '../src/enrichment/enrichment.service';
import { AnalysisService } from '../src/analysis/analysis.service';
import { FullEnrichAdapter } from '../src/enrichment/fullenrich.adapter';
import { OpenRouterClient } from '../src/analysis/openrouter.client';
import { buildDigest } from '../src/telegram/digest';
import { renderDossier } from '../src/telegram/dossier';
import { validAnalysis } from './analysis.test';

const MIGRATIONS = join(__dirname, '..', '..', '..', 'supabase', 'migrations');

async function makeDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return drizzle(pg, { schema: t }) as unknown as Db;
}

function fakeBoss() {
  const sent: { queue: string; data: any }[] = [];
  return { sent, send: async (queue: string, data: object) => (sent.push({ queue, data }), 'job-1') };
}

function feFetch(): typeof fetch {
  return (async (url: any, init?: any) => {
    const u = String(url);
    const isStart = String(init?.method ?? 'GET') === 'POST';
    const json = isStart
      ? { enrichment_id: 'fe-run-1' }
      : {
          status: 'FINISHED',
          credits_used: 1,
          datas: [
            {
              firstname: 'A',
              lastname: 'Rossi',
              company: { name: 'Nimbus', size: 24 },
              contact: { emails: [{ email: 'a.rossi@nimbus.io', status: 'VALID' }] },
            },
          ],
        };
    return { ok: true, status: 200, json: async () => json } as Response;
  }) as typeof fetch;
}

function orFetch(bodies: unknown[]): { fn: typeof fetch; calls: number[] } {
  const calls: number[] = [];
  const fn = (async () => {
    calls.push(1);
    const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(body) } }],
        usage: { prompt_tokens: 800, completion_tokens: 600, cost: 0.011 },
      }),
    } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

function makeServices(db: Db, orBodies: unknown[]) {
  const boss = fakeBoss();
  const leads = new LeadsService(db, boss);
  const enrichment = new EnrichmentService(
    db,
    new FullEnrichAdapter({ apiKey: 'fe-key-000000', baseUrl: 'https://fe.example', usdPerCredit: 0.058, fetchFn: feFetch() }),
  );
  const or = orFetch(orBodies);
  const analysis = new AnalysisService(
    db,
    new OpenRouterClient({ apiKey: 'or-key-000000', baseUrl: 'https://or.example', model: 'test/model-1', fetchFn: or.fn }),
    70,
  );
  return { boss, leads, enrichment, analysis, orCalls: or.calls };
}

test('migrations apply cleanly and the full pipeline lands every row', async () => {
  const db = await makeDb();
  const s = makeServices(db, [validAnalysis(84)]);

  // ingest
  const r = await s.leads.ingest('LinkedIn.com/in/A-Rossi-123?utm=x', 'telegram');
  assert.equal(r.kind, 'created');
  const leadId = (r as any).leadId as string;
  assert.deepEqual(s.boss.sent[0], { queue: 'muninn-enrich', data: { leadId } });

  // dedupe on a messy variant of the same profile
  const dup = await s.leads.ingest('  http://br.linkedin.com/in/a-rossi-123/ ', 'api');
  assert.equal(dup.kind, 'existing');

  // enrich: start, then poll to done
  const started = await s.enrichment.step(leadId, null);
  assert.equal(started.kind, 'started');
  const done = await s.enrichment.step(leadId, (started as any).enrichmentId);
  assert.equal(done.kind, 'done');
  assert.equal((done as any).email, 'a.rossi@nimbus.io');

  const [enr] = await db.select().from(t.leadEnrichments).where(eq(t.leadEnrichments.leadId, leadId));
  assert.equal(enr.emailStatus, 'verified');
  assert.equal(Number(enr.costUsd), 0.058);

  // idempotency: a redelivered job cannot double-spend
  assert.equal((await s.enrichment.step(leadId, null)).kind, 'skipped');

  // analyze
  const outcome = await s.analysis.run(leadId);
  assert.equal(outcome.status, 'analyzed');
  assert.equal(outcome.retried, false);

  const [lead] = await db.select().from(t.leads).where(eq(t.leads.id, leadId));
  assert.equal(lead.status, 'analyzed');
  const drafts = await db.select().from(t.messages).where(eq(t.messages.leadId, leadId));
  assert.equal(drafts.length, 4);
  assert.ok(drafts.every((d) => d.status === 'draft'));
  const ledger = await db.select().from(t.vendorCalls);
  assert.deepEqual(ledger.map((v) => v.kind).sort(), ['analyze', 'enrich_done', 'enrich_start']);

  // the dossier renders from the real view
  const view = await s.leads.view(leadId);
  const { html } = renderDossier(view!, outcome.violations);
  assert.match(html, /A Rossi/);
  assert.match(html, /fit <b>84<\/b>/);

  // digest sees counts and spend
  const digest = await buildDigest(db);
  assert.match(digest, /analyzed 1/);
  assert.match(digest, /fullenrich \$0\.06|fullenrich \$0\.058/);
  assert.match(digest, /openrouter \$0\.01/);

  // audit chain: every stage logged
  const events = await db.select().from(t.events).where(eq(t.events.leadId, leadId));
  const kinds = events.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['lead_analyzed', 'lead_enriched', 'lead_ingested']);
});

test('fit below threshold parks the lead (kept, no outreach)', async () => {
  const db = await makeDb();
  const s = makeServices(db, [validAnalysis(42)]);
  const r = await s.leads.ingest('linkedin.com/in/low-fit-lead', 'api');
  const leadId = (r as any).leadId as string;
  await s.enrichment.step(leadId, null);
  await s.enrichment.step(leadId, 'fe-run-1');
  const outcome = await s.analysis.run(leadId);
  assert.equal(outcome.status, 'parked');
  const [lead] = await db.select().from(t.leads).where(eq(t.leads.id, leadId));
  assert.equal(lead.status, 'parked');
});

test('invalid model output retries once with the validator issues, then succeeds', async () => {
  const db = await makeDb();
  const bad = { ...validAnalysis(80), fit_score: 'very high' }; // wrong type on purpose
  const s = makeServices(db, [bad, validAnalysis(80)]);
  const r = await s.leads.ingest('linkedin.com/in/retry-lead', 'api');
  const leadId = (r as any).leadId as string;
  await s.enrichment.step(leadId, null);
  await s.enrichment.step(leadId, 'fe-run-1');
  const outcome = await s.analysis.run(leadId);
  assert.equal(outcome.retried, true);
  assert.equal(outcome.status, 'analyzed');
  assert.equal(s.orCalls.length, 2);
});

test('suppressed people are refused at ingest', async () => {
  const db = await makeDb();
  const s = makeServices(db, [validAnalysis()]);
  await db.insert(t.suppressions).values({ linkedinUrl: 'https://www.linkedin.com/in/asked-to-forget', reason: 'manual' });
  const r = await s.leads.ingest('linkedin.com/in/asked-to-forget', 'telegram');
  assert.equal(r.kind, 'suppressed');
  const rows = await db.select().from(t.leads);
  assert.equal(rows.length, 0);
});
