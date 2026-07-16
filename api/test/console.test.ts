// Slice-2 integration: the console-facing surface (list, timeline, reminders,
// stats, draft edit, bulk, expansion inbox) against pglite + the real SQL.
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
import { SuggestionsService } from '../src/leads/suggestions.service';
import { FullEnrichAdapter } from '../src/enrichment/fullenrich.adapter';
import { OpenRouterClient } from '../src/analysis/openrouter.client';
import { ApolloAdapter } from '../src/enrichment/apollo.adapter';
import { buildStats } from '../src/http/stats';
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

function feFetch(email: string): typeof fetch {
  return (async (_url: any, init?: any) =>
    ({
      ok: true,
      status: 200,
      json: async () =>
        String(init?.method ?? 'GET') === 'POST'
          ? { enrichment_id: 'fe-1' }
          : {
              status: 'FINISHED',
              credits_used: 1,
              datas: [
                {
                  firstname: 'A',
                  lastname: 'Rossi',
                  title: 'CTO',
                  company: { name: 'Nimbus' },
                  contact: { emails: [{ email, status: 'VALID' }] },
                },
              ],
            },
    }) as Response) as typeof fetch;
}

function orFetch(body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(body) } }],
        usage: { prompt_tokens: 500, completion_tokens: 400, cost: 0.008 },
      }),
    }) as Response) as typeof fetch;
}

async function seedAnalyzedLead(db: Db, url: string, fit: number, email = 'a.rossi@nimbus.io') {
  const boss = { send: async () => 'job' };
  const leads = new LeadsService(db, boss);
  const r = await leads.ingest(url, 'test');
  const leadId = (r as any).leadId as string;
  const enrichment = new EnrichmentService(
    db,
    new FullEnrichAdapter({ apiKey: 'fe-key-000000', baseUrl: 'https://fe.example', usdPerCredit: 0.058, fetchFn: feFetch(email) }),
  );
  await enrichment.step(leadId, null);
  await enrichment.step(leadId, 'fe-1');
  const analysis = new AnalysisService(
    db,
    new OpenRouterClient({ apiKey: 'or-key-000000', baseUrl: 'https://or.example', model: 'test/model-1', fetchFn: orFetch(validAnalysis(fit)) }),
    70,
  );
  await analysis.run(leadId);
  return { leadId, leads };
}

test('list merges latest analysis + enrichment and filters honestly', async () => {
  const db = await makeDb();
  const { leads } = await seedAnalyzedLead(db, 'linkedin.com/in/a-rossi-123', 84);
  await seedAnalyzedLead(db, 'linkedin.com/in/low-fit', 40);

  const all = await leads.list({});
  assert.equal(all.total, 2);
  const analyzed = await leads.list({ status: 'analyzed' });
  assert.equal(analyzed.total, 1);
  assert.equal(analyzed.rows[0].fit, 84);
  assert.equal(analyzed.rows[0].company, 'Nimbus');
  assert.equal(analyzed.rows[0].emailStatus, 'verified');
  const parked = await leads.list({ status: 'parked' });
  assert.equal(parked.total, 1);
  const highFit = await leads.list({ fitMin: 70 });
  assert.equal(highFit.total, 1);
  const byAngle = await leads.list({ angle: 'verification' });
  assert.equal(byAngle.total, 2);
  const q = await leads.list({ q: 'a-rossi' });
  assert.equal(q.total, 1);
  const paged = await leads.list({ limit: 1, offset: 1 });
  assert.equal(paged.total, 2);
  assert.equal(paged.rows.length, 1);
});

test('timeline merges every artifact for the drawer, newest first', async () => {
  const db = await makeDb();
  const { leadId, leads } = await seedAnalyzedLead(db, 'linkedin.com/in/a-rossi-123', 84);
  await leads.saveNote(leadId, 'warm intro possible');
  await leads.addReminder(leadId, 'ping again', new Date(Date.now() + 3600_000));

  const items = await leads.timeline(leadId);
  const kinds = new Set(items.map((i) => i.kind));
  assert.ok(kinds.has('lead_ingested'));
  assert.ok(kinds.has('enrichment'));
  assert.ok(kinds.has('analysis'));
  assert.ok(kinds.has('draft·email'));
  assert.ok(kinds.has('draft·linkedin'));
  assert.ok(kinds.has('operator_note'));
  assert.ok(kinds.has('reminder'));
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i - 1].at.getTime() >= items[i].at.getTime(), 'timeline must be newest-first');
  }
});

test('reminders: due ones surface in stats, done ones leave', async () => {
  const db = await makeDb();
  const { leadId, leads } = await seedAnalyzedLead(db, 'linkedin.com/in/a-rossi-123', 84);
  const r = await leads.addReminder(leadId, 'overdue ping', new Date(Date.now() - 60_000));
  await leads.addReminder(leadId, 'future ping', new Date(Date.now() + 86_400_000));

  let stats = await buildStats(db);
  assert.equal(stats.needsYou.remindersDue.length, 1);
  assert.equal(stats.needsYou.remindersDue[0].note, 'overdue ping');
  assert.equal(stats.needsYou.awaitingReview, 1);
  assert.equal(stats.pipeline.byStatus['analyzed'], 1);
  assert.ok(stats.spend30d.find((s) => s.provider === 'fullenrich'));
  assert.ok(stats.activity.length >= 3);
  assert.match(stats.slice3.note, /slice 3/);

  await leads.completeReminder(r.id);
  stats = await buildStats(db);
  assert.equal(stats.needsYou.remindersDue.length, 0);
});

test('draft edit works only on drafts; bulk status flips many', async () => {
  const db = await makeDb();
  const { leadId, leads } = await seedAnalyzedLead(db, 'linkedin.com/in/a-rossi-123', 84);
  const drafts = await db.select().from(t.messages).where(eq(t.messages.leadId, leadId));
  const edit = await leads.updateDraft(drafts[0].id, { subject: 'sharper subject', bodyMd: 'sharper body — reply no and I will close the file.' });
  assert.deepEqual(edit, { ok: true });
  const [after] = await db.select().from(t.messages).where(eq(t.messages.id, drafts[0].id));
  assert.equal(after.subject, 'sharper subject');

  await db.update(t.messages).set({ status: 'sent' }).where(eq(t.messages.id, drafts[1].id));
  const blocked = await leads.updateDraft(drafts[1].id, { bodyMd: 'too late' });
  assert.deepEqual(blocked, { ok: false, error: 'not_a_draft' });

  const two = await seedAnalyzedLead(db, 'linkedin.com/in/second-lead', 84, 'x@forge.io');
  const bulk = await leads.bulkStatus([leadId, two.leadId], 'queued');
  assert.equal(bulk.changed, 2);
  const queued = await leads.list({ status: 'queued' });
  assert.equal(queued.total, 2);
});

test('expansion: apollo people land as suggestions; accept ingests through the same gates', async () => {
  const db = await makeDb();
  const { leadId, leads } = await seedAnalyzedLead(db, 'linkedin.com/in/a-rossi-123', 84);

  const apolloFetch = (async (_url: any, init?: any) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.q_organization_domains_list, ['nimbus.io']); // derived from the verified email
    return {
      ok: true,
      status: 200,
      json: async () => ({
        people: [
          { name: 'B Chen', title: 'VP Eng', organization: { name: 'Nimbus' }, linkedin_url: 'https://linkedin.com/in/b-chen-9' },
          { name: 'A Rossi', title: 'CTO', organization: { name: 'Nimbus' }, linkedin_url: 'https://linkedin.com/in/a-rossi-123' }, // already a lead → filtered
          { name: 'No Url', title: 'CEO', organization: { name: 'Nimbus' } }, // kept, but not acceptable
        ],
      }),
    } as Response;
  }) as typeof fetch;

  const svc = new SuggestionsService(
    db,
    new ApolloAdapter({ apiKey: 'apollo-key-000', baseUrl: 'https://apollo.example', fetchFn: apolloFetch }),
    leads,
  );

  const r = await svc.expand(leadId, 'colleagues');
  assert.equal(r.found, 3);
  assert.equal(r.inserted, 2); // the existing lead was filtered out

  const pending = await svc.list('pending');
  assert.equal(pending.length, 2);
  const withUrl = pending.find((s) => s.linkedinUrl)!;
  const withoutUrl = pending.find((s) => !s.linkedinUrl)!;

  const accepted = await svc.accept(withUrl.id);
  assert.equal(accepted.ok, true);
  const [sugAfter] = await db.select().from(t.leadSuggestions).where(eq(t.leadSuggestions.id, withUrl.id));
  assert.equal(sugAfter.state, 'accepted');
  assert.ok(sugAfter.leadId);
  const [newLead] = await db.select().from(t.leads).where(eq(t.leads.id, sugAfter.leadId!));
  assert.equal(newLead.source, `expand:${leadId}`);

  const noUrl = await svc.accept(withoutUrl.id);
  assert.deepEqual(noUrl, { ok: false, result: 'no_linkedin_url' });

  await svc.dismiss(withoutUrl.id);
  assert.equal((await svc.list('pending')).length, 0);

  // ledger + audit rows landed
  const calls = await db.select().from(t.vendorCalls).where(eq(t.vendorCalls.provider, 'apollo'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'expand_colleagues');
});

test('expansion without an apollo key refuses with a settings pointer', async () => {
  const db = await makeDb();
  const { leadId, leads } = await seedAnalyzedLead(db, 'linkedin.com/in/a-rossi-123', 84);
  const svc = new SuggestionsService(db, null, leads);
  assert.equal(svc.available, false);
  await assert.rejects(() => svc.expand(leadId, 'colleagues'), /APOLLO_API_KEY missing/);
});
