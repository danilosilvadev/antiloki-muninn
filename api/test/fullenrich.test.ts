import test from 'node:test';
import assert from 'node:assert/strict';
import { FullEnrichAdapter, mapPollResponse, nameGuessFromSlug } from '../src/enrichment/fullenrich.adapter';

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; json: unknown }): typeof fetch {
  return (async (url: any, init?: any) => {
    const r = handler(String(url), init);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.json,
    } as Response;
  }) as typeof fetch;
}

const OPTS = { apiKey: 'fe-test-key-000000', baseUrl: 'https://fe.example/api/v1', usdPerCredit: 0.058 };

test('money-guard: constructing without fetchFn under the test runner throws', () => {
  assert.throws(() => new FullEnrichAdapter(OPTS as any), /money-guard/);
});

test('start posts the bulk shape and returns the enrichment id', async () => {
  let seen: { url: string; body: any } | null = null;
  const adapter = new FullEnrichAdapter({
    ...OPTS,
    fetchFn: fakeFetch((url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return { json: { enrichment_id: 'fe-123' } };
    }),
  });
  const r = await adapter.start({ linkedinUrl: 'https://www.linkedin.com/in/a-rossi-123', firstname: 'A', lastname: 'Rossi' });
  assert.equal(r.enrichmentId, 'fe-123');
  assert.ok(seen!.url.endsWith('/contact/enrich/bulk'));
  assert.equal(seen!.body.datas.length, 1);
  assert.equal(seen!.body.datas[0].linkedin_url, 'https://www.linkedin.com/in/a-rossi-123');
  assert.deepEqual(seen!.body.datas[0].enrich_fields, ['contact.emails']);
});

test('start surfaces vendor errors with status + body', async () => {
  const adapter = new FullEnrichAdapter({
    ...OPTS,
    fetchFn: fakeFetch(() => ({ status: 402, json: { error: 'no credits' } })),
  });
  await assert.rejects(() => adapter.start({ linkedinUrl: 'https://www.linkedin.com/in/x-y' }), /402.*no credits/s);
});

test('mapPollResponse: finished with a valid email → done/verified', () => {
  const r = mapPollResponse({
    status: 'FINISHED',
    credits_used: 1,
    datas: [{ contact: { emails: [{ email: 'a.rossi@nimbus.io', status: 'VALID' }] }, firstname: 'A', lastname: 'Rossi' }],
  });
  assert.equal(r.status, 'done');
  assert.equal(r.email, 'a.rossi@nimbus.io');
  assert.equal(r.emailStatus, 'verified');
  assert.equal(r.creditsUsed, 1);
});

test('mapPollResponse: catch-all and not-found map honestly', () => {
  const catchAll = mapPollResponse({
    status: 'FINISHED',
    datas: [{ contact: { emails: [{ email: 'info@x.io', status: 'CATCH_ALL' }] } }],
  });
  assert.equal(catchAll.emailStatus, 'catch_all');

  const none = mapPollResponse({ status: 'FINISHED', datas: [{ contact: { emails: [] } }] });
  assert.equal(none.status, 'done');
  assert.equal(none.email, null);
  assert.equal(none.emailStatus, 'not_found');
  assert.equal(none.creditsUsed, 0);
});

test('mapPollResponse: in-progress → pending; failure words → failed', () => {
  assert.equal(mapPollResponse({ status: 'IN_PROGRESS', datas: [] }).status, 'pending');
  assert.equal(mapPollResponse({}).status, 'pending');
  assert.equal(mapPollResponse({ status: 'FAILED' }).status, 'failed');
  assert.equal(mapPollResponse({ status: 'CANCELED' }).status, 'failed');
});

test('costUsd converts credits at the configured rate', () => {
  const adapter = new FullEnrichAdapter({ ...OPTS, fetchFn: fakeFetch(() => ({ json: {} })) });
  assert.equal(adapter.costUsd(1), 0.058);
  assert.equal(adapter.costUsd(null), null);
});

test('nameGuessFromSlug drops id fragments and capitalizes', () => {
  assert.deepEqual(nameGuessFromSlug('danilo-silva-1a2b3c4d'), { firstname: 'Danilo', lastname: 'Silva' });
  assert.deepEqual(nameGuessFromSlug('a-rossi-123'), { firstname: 'A', lastname: 'Rossi' });
  assert.deepEqual(nameGuessFromSlug('mononym'), { firstname: 'Mononym', lastname: '' });
});
