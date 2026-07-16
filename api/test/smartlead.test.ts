import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartleadAdapter } from '../src/channels/smartlead.adapter';

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; json: unknown }) {
  const calls: { url: string; method: string; body: any }[] = [];
  const fn = (async (url: any, init?: any) => {
    const entry = {
      url: String(url),
      method: String(init?.method ?? 'GET'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(entry);
    const r = handler(entry.url, init);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.json } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

const OPTS = { apiKey: 'sl-key-000000', baseUrl: 'https://sl.example/api/v1' };

test('money-guard: SmartleadAdapter without fetchFn under tests throws', () => {
  assert.throws(() => new SmartleadAdapter(OPTS as any), /money-guard/);
});

test('api key rides the query string on every call', async () => {
  const { fn, calls } = fakeFetch(() => ({ json: [] }));
  const a = new SmartleadAdapter({ ...OPTS, fetchFn: fn });
  await a.listCampaigns();
  assert.match(calls[0].url, /\/campaigns\?api_key=sl-key-000000$/);
});

test('createCampaign creates + installs the 3-step variable sequence (day 0/6/12)', async () => {
  const { fn, calls } = fakeFetch((url) =>
    url.includes('/campaigns/create') ? { json: { id: 777 } } : { json: { ok: true } },
  );
  const a = new SmartleadAdapter({ ...OPTS, fetchFn: fn });
  const id = await a.createCampaign('verification');
  assert.equal(id, '777');
  assert.equal(calls[0].body.name, 'muninn-verification');
  const seq = calls[1];
  assert.match(seq.url, /\/campaigns\/777\/sequences/);
  assert.equal(seq.body.sequences.length, 3);
  assert.deepEqual(
    seq.body.sequences.map((s: any) => s.seq_delay_details.delay_in_days),
    [0, 6, 6],
  );
  assert.equal(seq.body.sequences[0].subject, '{{muninn_subject_1}}');
  assert.equal(seq.body.sequences[2].email_body, '{{muninn_body_3}}');
});

test('addLead pushes the lead with its own approved words as custom fields', async () => {
  const { fn, calls } = fakeFetch(() => ({ json: { upload_count: 1 } }));
  const a = new SmartleadAdapter({ ...OPTS, fetchFn: fn });
  await a.addLead('777', {
    email: 'a.rossi@nimbus.io',
    firstName: 'A',
    lastName: 'Rossi',
    customFields: { muninn_subject_1: 's1', muninn_body_1: 'b1' },
  });
  const body = calls[0].body;
  assert.equal(body.lead_list[0].email, 'a.rossi@nimbus.io');
  assert.equal(body.lead_list[0].custom_fields.muninn_body_1, 'b1');
  assert.equal(body.settings.ignore_global_block_list, false);
  assert.equal(body.settings.ignore_unsubscribe_list, false);
});

test('setCampaignStatus posts PAUSED/START; stopLead soft-fails on 404', async () => {
  const { fn, calls } = fakeFetch((url) => (url.includes('/leads/') ? { status: 404, json: {} } : { json: {} }));
  const a = new SmartleadAdapter({ ...OPTS, fetchFn: fn });
  await a.setCampaignStatus('777', 'PAUSED');
  assert.deepEqual(calls[0].body, { status: 'PAUSED' });
  const stopped = await a.stopLead('777', 'a@b.co');
  assert.equal(stopped, false); // soft fail, no throw
});

test('http errors surface with status + body for non-soft paths', async () => {
  const { fn } = fakeFetch(() => ({ status: 401, json: { message: 'invalid api key' } }));
  const a = new SmartleadAdapter({ ...OPTS, fetchFn: fn });
  await assert.rejects(() => a.listCampaigns(), /401.*invalid api key/s);
});
