// Slice-3 integration on pglite + real SQL: approve → policy → push → state;
// webhook drain → transitions + suppression + classify; kill switch within a
// tick; domain-health auto-pause; the reject → steering loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import * as t from '../src/db/schema';
import type { Db } from '../src/db/db';
import { LeadsService } from '../src/leads/leads.service';
import { EnrichmentService } from '../src/enrichment/enrichment.service';
import { AnalysisService } from '../src/analysis/analysis.service';
import { FullEnrichAdapter } from '../src/enrichment/fullenrich.adapter';
import { OpenRouterClient } from '../src/analysis/openrouter.client';
import { SmartleadAdapter } from '../src/channels/smartlead.adapter';
import { SequenceService } from '../src/channels/sequence.service';
import { FLAG_HEALTH_PAUSED, FLAG_PAUSE_ALL, PolicyService } from '../src/policy/policy.service';
import { runTick, type TickDeps } from '../src/jobs/tick';
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

function feFetch(email: string, country = 'United States'): typeof fetch {
  return (async (_u: any, init?: any) =>
    ({
      ok: true,
      status: 200,
      json: async () =>
        String(init?.method ?? 'GET') === 'POST'
          ? { enrichment_id: 'fe-1' }
          : {
              status: 'FINISHED',
              credits_used: 1,
              datas: [{ firstname: 'A', lastname: 'Rossi', title: 'CTO', country_code: country === 'Germany' ? 'DE' : 'US', company: { name: 'Nimbus', country }, contact: { emails: [{ email, status: 'VALID' }] } }],
            },
    }) as Response) as typeof fetch;
}

function orFetch(bodies: unknown[]): typeof fetch {
  let i = 0;
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(bodies[Math.min(i++, bodies.length - 1)]) } }],
        usage: { prompt_tokens: 100, completion_tokens: 80, cost: 0.002 },
      }),
    }) as Response) as typeof fetch;
}

function slFetch() {
  const calls: { url: string; method: string; body: any }[] = [];
  const fn = (async (url: any, init?: any) => {
    const entry = { url: String(url), method: String(init?.method ?? 'GET'), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(entry);
    let json: unknown = {};
    if (entry.url.includes('/campaigns?')) json = [];
    if (entry.url.includes('/campaigns/create')) json = { id: 900 };
    return { ok: true, status: 200, json: async () => json } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

// quietHours '0-0' is a degenerate (disabled) window — these integration tests
// must not depend on the wall clock; quiet-hours firing is covered by the pure
// refusal matrix (sendpolicy.test.ts case 10).
const POLICY_CFG = { dailyCap: 30, quietHours: '0-0', utcOffset: 0, geoBlocked: 'DE,CA', senderReady: true };

async function seedAnalyzed(db: Db, url: string, opts: { email?: string; country?: string; fit?: number } = {}) {
  const boss = { send: async () => 'j' };
  const leads = new LeadsService(db, boss);
  const r = await leads.ingest(url, 'test');
  const leadId = (r as any).leadId as string;
  const enrichment = new EnrichmentService(
    db,
    new FullEnrichAdapter({ apiKey: 'fe-key-000000', baseUrl: 'https://fe.example', usdPerCredit: 0.058, fetchFn: feFetch(opts.email ?? 'a.rossi@nimbus.io', opts.country) }),
  );
  await enrichment.step(leadId, null);
  await enrichment.step(leadId, 'fe-1');
  const analysis = new AnalysisService(
    db,
    new OpenRouterClient({ apiKey: 'or-key-000000', baseUrl: 'https://or.example', model: 'test/model-1', fetchFn: orFetch([validAnalysis(opts.fit ?? 84)]) }),
    70,
  );
  await analysis.run(leadId);
  return { leadId, leads };
}

function makeMachine(db: Db, overrides: Partial<typeof POLICY_CFG> = {}) {
  const policy = new PolicyService(db, { ...POLICY_CFG, ...overrides });
  const sl = slFetch();
  const smartlead = new SmartleadAdapter({ apiKey: 'sl-key-000000', baseUrl: 'https://sl.example/api/v1', fetchFn: sl.fn });
  const notes: string[] = [];
  const notify = async (html: string) => {
    notes.push(html);
  };
  const sequences = new SequenceService(db, policy, smartlead, notify);
  const tickDeps: TickDeps = {
    db,
    policy,
    sequences,
    smartlead,
    classifier: new OpenRouterClient({
      apiKey: 'or-key-000000',
      baseUrl: 'https://or.example',
      model: 'test/model-1',
      fetchFn: orFetch([{ label: 'positive', confidence: 'high' }]),
    }),
    notify,
  };
  return { policy, sequences, tickDeps, sl, notes };
}

// Seeds the events table exactly as the deployed sink leaves it after a
// Smartlead webhook. The payload→kind mapping itself is covered by the root
// webhook-core suite; here we start from the post-sink state (internal kinds),
// which is also the honest seam: the api only ever sees drained event rows.
async function sinkEvent(
  db: Db,
  kind: 'reply' | 'bounce' | 'unsub' | 'complaint' | 'sent',
  opts: { email?: string; replyText?: string } = {},
) {
  await db.insert(t.events).values({
    kind,
    payload: { via: 'webhook-sink', email: opts.email ?? null, reply_text: opts.replyText ?? null },
  });
  const suppress = kind === 'unsub' || kind === 'bounce' || kind === 'complaint' ? kind : null;
  if (suppress && opts.email) {
    await db.insert(t.suppressions).values({ email: opts.email, emailDomain: opts.email.split('@')[1], reason: suppress });
  }
}

test('approve: policy allows → campaign ensured → lead pushed with its own words → in_sequence', async () => {
  const db = await makeDb();
  const { leadId } = await seedAnalyzed(db, 'linkedin.com/in/a-rossi-123');
  const m = makeMachine(db);

  const r = await m.sequences.approve(leadId);
  assert.equal(r.ok, true, JSON.stringify(r));

  const push = m.sl.calls.find((c) => c.url.includes('/900/leads'));
  assert.ok(push, 'lead was pushed to the created campaign');
  assert.equal(push!.body.lead_list[0].email, 'a.rossi@nimbus.io');
  assert.match(push!.body.lead_list[0].custom_fields.muninn_subject_1, /done/);

  const [lead] = await db.select().from(t.leads).where(eq(t.leads.id, leadId));
  assert.equal(lead.status, 'in_sequence');
  assert.equal(lead.geo, 'US');
  const [seq] = await db.select().from(t.sequences).where(eq(t.sequences.leadId, leadId));
  assert.equal(seq.status, 'running');
  assert.ok(seq.nextRunAt, 'day-3 linkedin nudge scheduled');
  const scheduled = await db.select().from(t.messages).where(and(eq(t.messages.leadId, leadId), eq(t.messages.status, 'scheduled')));
  assert.equal(scheduled.length, 3); // the 3 email steps; linkedin stays draft/manual
  // second approve refuses honestly
  const again = await m.sequences.approve(leadId);
  assert.ok(!again.ok && /already in sequence/.test((again as any).reason));
});

test('approve refusals: geo-blocked DE lead and suppressed lead land in policy_refusals', async () => {
  const db = await makeDb();
  const de = await seedAnalyzed(db, 'linkedin.com/in/hans-de', { email: 'hans@bau.de', country: 'Germany' });
  const m = makeMachine(db);
  const r = await m.sequences.approve(de.leadId);
  assert.ok(!r.ok && r.code === 'geo_blocked');

  const sup = await seedAnalyzed(db, 'linkedin.com/in/opted-out', { email: 'gone@x.io' });
  await db.insert(t.suppressions).values({ email: 'gone@x.io', reason: 'unsub' });
  const r2 = await m.sequences.approve(sup.leadId);
  assert.ok(!r2.ok && r2.code === 'suppressed');

  const refusals = await db.select().from(t.policyRefusals);
  assert.deepEqual(refusals.map((x) => x.code).sort(), ['geo_blocked', 'suppressed']);
  const [deLead] = await db.select().from(t.leads).where(eq(t.leads.id, de.leadId));
  assert.equal(deLead.status, 'analyzed'); // refusal leaves the lead reviewable, not mangled
});

test('drain: a reply stops the sequence, flips the lead, classifies label-only, notifies', async () => {
  const db = await makeDb();
  const { leadId } = await seedAnalyzed(db, 'linkedin.com/in/a-rossi-123');
  const m = makeMachine(db);
  await m.sequences.approve(leadId);

  await sinkEvent(db, 'reply', { email: 'a.rossi@nimbus.io', replyText: 'how does the chain survive a rebase?' });
  const r = await runTick(m.tickDeps);
  assert.ok(r.drained >= 1);

  const [lead] = await db.select().from(t.leads).where(eq(t.leads.id, leadId));
  assert.equal(lead.status, 'replied');
  const [seq] = await db.select().from(t.sequences).where(eq(t.sequences.leadId, leadId));
  assert.equal(seq.status, 'stopped');
  const labeled = await db.select().from(t.events).where(eq(t.events.kind, 'reply_labeled'));
  assert.equal(labeled.length, 1);
  assert.match(m.notes.join('\n'), /reply.*positive/s);
  assert.match(m.notes.join('\n'), /labels never auto-act/);
  // the stop reached smartlead too
  assert.ok(m.sl.calls.some((c) => c.url.includes('/leads/') && c.url.includes('pause')));
  // drained events are stamped, never re-processed
  const un = await db.select().from(t.events).where(and(eq(t.events.kind, 'reply'), isNull(t.events.processedAt)));
  assert.equal(un.length, 0);
});

test('drain: bounce parks + unsub suppresses, both stop the sequence', async () => {
  const db = await makeDb();
  const a = await seedAnalyzed(db, 'linkedin.com/in/bouncer', { email: 'b@x.io' });
  const m = makeMachine(db);
  await m.sequences.approve(a.leadId);
  await sinkEvent(db, 'bounce', { email: 'b@x.io' });
  await runTick(m.tickDeps);
  const [lead] = await db.select().from(t.leads).where(eq(t.leads.id, a.leadId));
  assert.equal(lead.status, 'parked');
  assert.equal(lead.lastError, 'email bounced');
  const sup = await db.select().from(t.suppressions).where(eq(t.suppressions.email, 'b@x.io'));
  assert.equal(sup.length, 1); // the sink suppressed it before the api ever woke

  const b = await seedAnalyzed(db, 'linkedin.com/in/unsubber', { email: 'u@y.io' });
  await m.sequences.approve(b.leadId);
  await sinkEvent(db, 'unsub', { email: 'u@y.io' });
  await runTick(m.tickDeps);
  const [lead2] = await db.select().from(t.leads).where(eq(t.leads.id, b.leadId));
  assert.equal(lead2.status, 'suppressed');
});

test('kill switch: flag on → campaigns paused within one tick; off → resumed', async () => {
  const db = await makeDb();
  const { leadId } = await seedAnalyzed(db, 'linkedin.com/in/a-rossi-123');
  const m = makeMachine(db);
  await m.sequences.approve(leadId);

  await m.policy.setFlag(FLAG_PAUSE_ALL, true);
  await runTick(m.tickDeps);
  const paused = m.sl.calls.filter((c) => c.url.includes('/status') && c.body?.status === 'PAUSED');
  assert.equal(paused.length, 1);
  assert.match(m.notes.join('\n'), /PAUSE ALL.*within one tick/s);
  // idempotent: second tick does nothing new
  await runTick(m.tickDeps);
  assert.equal(m.sl.calls.filter((c) => c.url.includes('/status')).length, 1);
  // and the policy now refuses new approvals
  const other = await seedAnalyzed(db, 'linkedin.com/in/second', { email: 's@z.io' });
  const r = await m.sequences.approve(other.leadId);
  assert.ok(!r.ok && r.code === 'pause_all');

  await m.policy.setFlag(FLAG_PAUSE_ALL, false);
  await runTick(m.tickDeps);
  assert.ok(m.sl.calls.some((c) => c.body?.status === 'START'));
});

test('domain health: bounce rate over 2% auto-pauses once and holds until cleared', async () => {
  const db = await makeDb();
  const { leadId } = await seedAnalyzed(db, 'linkedin.com/in/a-rossi-123');
  const m = makeMachine(db);
  await m.sequences.approve(leadId);

  // 40 sends, 2 bounces = 5% — over the 2% ceiling (and past the 20-send floor)
  for (let i = 0; i < 40; i++) await db.insert(t.events).values({ kind: 'sent', payload: {}, processedAt: new Date() });
  for (let i = 0; i < 2; i++) await db.insert(t.events).values({ kind: 'bounce', payload: {}, processedAt: new Date() });

  await runTick(m.tickDeps);
  const flag = await m.policy.getFlag<{ on?: boolean }>(FLAG_HEALTH_PAUSED, {});
  assert.equal(flag.on, true);
  assert.match(m.notes.join('\n'), /domain-health auto-pause/);
  const healthEvents = await db.select().from(t.events).where(eq(t.events.kind, 'domain_health_pause'));
  assert.equal(healthEvents.length, 1);
  await runTick(m.tickDeps); // held, not re-fired
  assert.equal((await db.select().from(t.events).where(eq(t.events.kind, 'domain_health_pause'))).length, 1);
});

test('day-3 linkedin nudge surfaces once, manual mark keeps P1 discipline', async () => {
  const db = await makeDb();
  const { leadId } = await seedAnalyzed(db, 'linkedin.com/in/a-rossi-123');
  const m = makeMachine(db);
  await m.sequences.approve(leadId);
  await db.update(t.sequences).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(t.sequences.leadId, leadId));

  await runTick(m.tickDeps);
  const due = await db.select().from(t.events).where(eq(t.events.kind, 'linkedin_touch_due'));
  assert.equal(due.length, 1);
  assert.match(m.notes.join('\n'), /you send it in the real UI/);
  await runTick(m.tickDeps);
  assert.equal((await db.select().from(t.events).where(eq(t.events.kind, 'linkedin_touch_due'))).length, 1);
});

test('reject feeds the steering loop: the next analysis prompt carries the reason', async () => {
  const db = await makeDb();
  const first = await seedAnalyzed(db, 'linkedin.com/in/rejected-one');
  const m = makeMachine(db);
  await m.sequences.reject(first.leadId, 'too salesy — drop the flattery, lead with the tamper demo');
  const [lead] = await db.select().from(t.leads).where(eq(t.leads.id, first.leadId));
  assert.equal(lead.status, 'parked');

  // capture the prompt the next analysis run sends
  let capturedUser = '';
  const spyFetch = (async (_u: any, init?: any) => {
    const body = JSON.parse(String(init?.body));
    capturedUser = body.messages[1].content;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(validAnalysis(80)) } }], usage: {} }),
    } as Response;
  }) as typeof fetch;

  const boss = { send: async () => 'j' };
  const leads = new LeadsService(db, boss);
  const r = await leads.ingest('linkedin.com/in/next-lead', 'test');
  const nextId = (r as any).leadId as string;
  const enrichment = new EnrichmentService(
    db,
    new FullEnrichAdapter({ apiKey: 'fe-key-000000', baseUrl: 'https://fe.example', usdPerCredit: 0.058, fetchFn: feFetch('n@x.io') }),
  );
  await enrichment.step(nextId, null);
  await enrichment.step(nextId, 'fe-1');
  const analysis = new AnalysisService(
    db,
    new OpenRouterClient({ apiKey: 'or-key-000000', baseUrl: 'https://or.example', model: 'test/model-1', fetchFn: spyFetch }),
    70,
  );
  await analysis.run(nextId);
  assert.match(capturedUser, /OPERATOR STEERING/);
  assert.match(capturedUser, /too salesy/);
});
