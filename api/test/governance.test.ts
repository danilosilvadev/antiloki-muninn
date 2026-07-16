// Slice-5 integration on pglite + real SQL: the erasure cascade with hashed
// tombstones (and the refusals they power at ingest + SendPolicy), the
// retention clock's purge/expire split, the budget breaker's trip-once
// semantics, and the export shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import * as t from '../src/db/schema';
import type { Db } from '../src/db/db';
import { BudgetService } from '../src/governance/budget.service';
import { ErasureService } from '../src/governance/erasure.service';
import { exportWaitlist, toCsv } from '../src/governance/export';
import { runRetention } from '../src/governance/retention';
import { tombstoneOf } from '../src/governance/tombstone';
import { LeadsService } from '../src/leads/leads.service';
import { PolicyService } from '../src/policy/policy.service';

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

const URL_A = 'https://www.linkedin.com/in/a-rossi-123';
const EMAIL_A = 'a.rossi@nimbus.io';

// A fully-populated person: lead + enrichment + analysis + drafts + sequence
// + reminder + refusal + events + a vendor-ledger row with PII in meta —
// plus the waitlist half (member, invite, consents) on the same email.
async function seedPerson(db: Db) {
  const [lead] = await db.insert(t.leads).values({ linkedinUrl: URL_A, status: 'analyzed', source: 'test' }).returning();
  await db.insert(t.leadEnrichments).values({
    leadId: lead.id, provider: 'fullenrich', raw: { contact: { emails: [{ email: EMAIL_A }] } }, email: EMAIL_A, emailStatus: 'verified',
  });
  await db.insert(t.leadAnalyses).values({
    leadId: lead.id, fitScore: 84, icp: 'cto_ai_startup', angle: 'verification', pains: [], hooks: [], briefMd: 'brief', model: 'test/m',
  });
  const [seq] = await db.insert(t.sequences).values({ leadId: lead.id, template: 'verification', status: 'running' }).returning();
  await db.insert(t.messages).values({ leadId: lead.id, sequenceId: seq.id, channel: 'email', bodyMd: 'hello', step: 0 });
  await db.insert(t.reminders).values({ leadId: lead.id, note: 'ping', dueAt: new Date() });
  await db.insert(t.policyRefusals).values({ leadId: lead.id, channel: 'email', code: 'quiet_hours', reason: 'test' });
  await db.insert(t.leadSuggestions).values({ sourceLeadId: lead.id, mode: 'colleagues', linkedinUrl: URL_A, raw: { name: 'A Rossi' }, leadId: lead.id });
  await db.insert(t.events).values({ leadId: lead.id, kind: 'lead_ingested', payload: { source: 'test' } });
  await db.insert(t.events).values({ kind: 'erasure_requested', payload: { email: EMAIL_A, ip_hash: 'x' } });
  await db.insert(t.vendorCalls).values({ provider: 'fullenrich', kind: 'enrich', leadId: lead.id, costUsd: '0.06', meta: { raw: { email: EMAIL_A } } });
  await db.insert(t.suppressions).values({ email: EMAIL_A, reason: 'erasure_request' });

  await db.insert(t.waitlistMembers).values({ email: EMAIL_A, referralCode: 'codea001', name: 'A Rossi' });
  const [member] = await db.select().from(t.waitlistMembers).where(eq(t.waitlistMembers.email, EMAIL_A));
  await db.insert(t.invites).values({ code: 'abcd1234', wave: 1, issuedTo: member.id });
  await db.insert(t.consents).values({ email: EMAIL_A, channel: 'whatsapp', handle: '+5511912345678', grantedAt: new Date(), source: 'thank-you' });
  await db.insert(t.consents).values({ leadId: lead.id, channel: 'telegram', grantedAt: new Date(), source: 'manual' });
  return { lead, member };
}

test('erasure by email: every row goes, the ledger is scrubbed not deleted, only hashed tombstones remain', async () => {
  const db = await makeDb();
  await seedPerson(db);
  const notes: string[] = [];
  const erasure = new ErasureService(db, async (h) => {
    notes.push(h);
  });

  const report = await erasure.erase({ email: EMAIL_A });
  assert.equal(report.leads, 1);
  assert.equal(report.waitlistMembers, 1);

  for (const [table, name] of [
    [t.leads, 'leads'], [t.leadEnrichments, 'lead_enrichments'], [t.leadAnalyses, 'lead_analyses'],
    [t.sequences, 'sequences'], [t.messages, 'messages'], [t.reminders, 'reminders'],
    [t.policyRefusals, 'policy_refusals'], [t.leadSuggestions, 'lead_suggestions'],
    [t.waitlistMembers, 'waitlist_members'], [t.invites, 'invites'], [t.consents, 'consents'],
  ] as const) {
    assert.equal((await db.select().from(table as never)).length, 0, `${name} should be empty`);
  }

  // the cost ledger survives, scrubbed
  const [vc] = await db.select().from(t.vendorCalls);
  assert.equal(vc.leadId, null);
  assert.equal(vc.meta, null);
  assert.equal(Number(vc.costUsd), 0.06);

  // events: the person's trail + the plain-email request row are gone;
  // what remains carries no plain PII
  const events = await db.select().from(t.events);
  assert.ok(events.every((e) => e.leadId === null));
  assert.ok(events.every((e) => !JSON.stringify(e.payload ?? {}).includes(EMAIL_A)));
  assert.ok(events.some((e) => e.kind === 'erasure_completed'));

  // tombstones: hashed rows present, plain rows gone
  const sups = await db.select().from(t.suppressions);
  assert.ok(sups.every((s) => s.email !== EMAIL_A));
  assert.ok(sups.some((s) => s.email === tombstoneOf(EMAIL_A) && s.reason === 'erasure'));
  assert.ok(sups.some((s) => s.linkedinUrl === tombstoneOf(URL_A) && s.reason === 'erasure'));

  assert.ok(notes.some((n) => n.includes('erasure completed')));
});

test('after erasure: re-ingest refuses on the url tombstone, SendPolicy refuses on the email tombstone', async () => {
  const db = await makeDb();
  await seedPerson(db);
  const erasure = new ErasureService(db, async () => {});
  await erasure.erase({ email: EMAIL_A });

  const leads = new LeadsService(db, null);
  assert.deepEqual(await leads.ingest(URL_A, 'test'), { kind: 'suppressed' });

  // a different person whose enrichment happens to surface the erased email
  const other = await leads.ingest('https://www.linkedin.com/in/other-999', 'test');
  assert.equal(other.kind, 'created');
  const [lead] = await db.select().from(t.leads);
  const policy = new PolicyService(db, { dailyCap: 30, quietHours: '0-0', utcOffset: 0, geoBlocked: 'DE,CA', senderReady: true });
  const verdict = await policy.check(lead, 'email', { email: EMAIL_A });
  assert.equal(verdict.allowed, false);
  if (!verdict.allowed) assert.equal(verdict.code, 'suppressed');
});

test('retention: old un-engaged leads purge WITHOUT tombstones; engaged leads keep rows but old raws expire', async () => {
  const db = await makeDb();
  const old = new Date(Date.now() - 100 * 24 * 3_600_000);

  const [stale] = await db.insert(t.leads).values({ linkedinUrl: 'https://www.linkedin.com/in/stale-1', status: 'analyzed', source: 'test', createdAt: old, updatedAt: old }).returning();
  await db.insert(t.leadEnrichments).values({ leadId: stale.id, provider: 'fullenrich', raw: { pii: 'lots' }, createdAt: old });
  const [engaged] = await db.insert(t.leads).values({ linkedinUrl: 'https://www.linkedin.com/in/engaged-1', status: 'in_sequence', source: 'test', createdAt: old, updatedAt: old }).returning();
  await db.insert(t.leadEnrichments).values({ leadId: engaged.id, provider: 'fullenrich', raw: { pii: 'lots' }, email: 'e@x.co', createdAt: old });

  const notes: string[] = [];
  const erasure = new ErasureService(db, async () => {});
  const r = await runRetention(db, erasure, { leadDays: 90, rawDays: 30 }, async (h) => {
    notes.push(h);
  });
  assert.equal(r.purgedLeads, 1);
  assert.equal(r.expiredRaws, 1); // only the engaged lead's raw remains to expire

  const remaining = await db.select().from(t.leads);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, engaged.id);
  const [enr] = await db.select().from(t.leadEnrichments).where(eq(t.leadEnrichments.leadId, engaged.id));
  assert.deepEqual((enr.raw as Record<string, unknown>)['expired'], true);
  assert.equal(enr.email, 'e@x.co'); // distilled columns survive the expiry

  // no tombstone: an aged-out lead may come back
  assert.equal((await db.select().from(t.suppressions)).length, 0);
  const leads = new LeadsService(db, null);
  assert.equal((await leads.ingest('https://www.linkedin.com/in/stale-1', 'test')).kind, 'created');

  // idempotent: a second run finds nothing new (the re-ingested lead is fresh)
  const r2 = await runRetention(db, erasure, { leadDays: 90, rawDays: 30 }, async () => {});
  assert.deepEqual(r2, { purgedLeads: 0, expiredRaws: 0 });
});

test('budget breaker: refuses at the ceiling, alerts exactly once, resets when raised, 0 disables', async () => {
  const db = await makeDb();
  await db.insert(t.vendorCalls).values({ provider: 'openrouter', kind: 'analyze', costUsd: '300' });
  const policy = new PolicyService(db, { dailyCap: 30, quietHours: '0-0', utcOffset: 0, geoBlocked: '', senderReady: true });
  const notes: string[] = [];
  const notify = async (h: string): Promise<void> => {
    notes.push(h);
  };

  const tight = new BudgetService(db, policy, 280, notify);
  const g1 = await tight.gate('fullenrich');
  assert.equal(g1.allowed, false);
  if (!g1.allowed) assert.match(g1.reason, /budget ceiling/);
  assert.equal(await tight.tripped(), true);
  await tight.gate('openrouter');
  assert.equal(notes.filter((n) => n.includes('breaker tripped')).length, 1); // alert once, not per call
  assert.ok((await db.select().from(t.events)).some((e) => e.kind === 'budget_breaker_tripped'));

  const raised = new BudgetService(db, policy, 1000, notify);
  assert.deepEqual(await raised.gate('fullenrich'), { allowed: true });
  assert.equal(notes.filter((n) => n.includes('breaker reset')).length, 1);
  assert.equal(await raised.tripped(), false);

  const unlimited = new BudgetService(db, policy, 0, notify);
  assert.deepEqual(await unlimited.gate('fullenrich'), { allowed: true });
});

test('export: RFC-4180 quoting and the waitlist row shape', async () => {
  const csv = toCsv(['a', 'b'], [
    { a: 'plain', b: 'with,comma' },
    { a: 'has "quotes"', b: 'line\nbreak' },
    { a: null, b: new Date('2026-07-16T00:00:00Z') },
  ]);
  assert.equal(csv, 'a,b\nplain,"with,comma"\n"has ""quotes""","line\nbreak"\n,2026-07-16T00:00:00.000Z\n');

  const db = await makeDb();
  await db.insert(t.waitlistMembers).values({ email: 'w@x.co', referralCode: 'codew001', name: 'W' });
  const rows = await exportWaitlist(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['email'], 'w@x.co');
  assert.equal(rows[0]['referral_code'], 'codew001');
  assert.ok(rows[0]['position'] != null);
});
