import test from 'node:test';
import assert from 'node:assert/strict';
import { ApolloAdapter, mapPeople } from '../src/enrichment/apollo.adapter';

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; json: unknown }) {
  const calls: { url: string; body: any; headers: any }[] = [];
  const fn = (async (url: any, init?: any) => {
    const entry = { url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers };
    calls.push(entry);
    const r = handler(entry.url, init);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.json } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

const OPTS = { apiKey: 'apollo-key-000', baseUrl: 'https://apollo.example/api/v1' };

test('money-guard: ApolloAdapter without fetchFn under tests throws', () => {
  assert.throws(() => new ApolloAdapter(OPTS as any), /money-guard/);
});

test('colleagues mode searches by company domain with senior roles', async () => {
  const { fn, calls } = fakeFetch(() => ({ json: { people: [] } }));
  const a = new ApolloAdapter({ ...OPTS, fetchFn: fn });
  await a.findSimilar({ mode: 'colleagues', companyDomain: 'nimbus.io' });
  assert.ok(calls[0].url.endsWith('/mixed_people/search'));
  assert.deepEqual(calls[0].body.q_organization_domains_list, ['nimbus.io']);
  assert.ok(Array.isArray(calls[0].body.person_seniorities));
  assert.equal((calls[0].headers as any)['x-api-key'], 'apollo-key-000');
});

test('lookalike mode searches by title; missing inputs fail loudly', async () => {
  const { fn, calls } = fakeFetch(() => ({ json: { people: [] } }));
  const a = new ApolloAdapter({ ...OPTS, fetchFn: fn });
  await a.findSimilar({ mode: 'lookalike', title: 'CTO' });
  assert.deepEqual(calls[0].body.person_titles, ['CTO']);

  await assert.rejects(() => a.findSimilar({ mode: 'lookalike' }), /needs a title/);
  await assert.rejects(() => a.findSimilar({ mode: 'colleagues' }), /company domain or name/);
});

test('http errors surface with status + body', async () => {
  const { fn } = fakeFetch(() => ({ status: 401, json: { error: 'bad key' } }));
  const a = new ApolloAdapter({ ...OPTS, fetchFn: fn });
  await assert.rejects(() => a.findSimilar({ mode: 'lookalike', title: 'CTO' }), /401.*bad key/s);
});

test('mapPeople tolerates both name shapes and missing fields', () => {
  const people = mapPeople({
    people: [
      { name: 'A Rossi', title: 'CTO', organization: { name: 'Nimbus' }, linkedin_url: 'https://linkedin.com/in/a-rossi-123' },
      { first_name: 'M', last_name: 'Okonkwo', organization_name: 'Forge' },
      {},
    ],
  });
  assert.equal(people.length, 3);
  assert.deepEqual(
    { name: people[0].name, title: people[0].title, company: people[0].company, linkedinUrl: people[0].linkedinUrl },
    { name: 'A Rossi', title: 'CTO', company: 'Nimbus', linkedinUrl: 'https://linkedin.com/in/a-rossi-123' },
  );
  assert.equal(people[1].name, 'M Okonkwo');
  assert.equal(people[1].company, 'Forge');
  assert.equal(people[1].linkedinUrl, null);
  assert.equal(people[2].name, null);
  assert.deepEqual(mapPeople({}), []);
  assert.deepEqual(mapPeople(null), []);
});
