import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterClient, stripFences } from '../src/analysis/openrouter.client';
import {
  acceptAnalysis,
  analysisJsonSchema,
  countWords,
  draftBudgetViolations,
  type Analysis,
} from '../src/analysis/schema';

export function validAnalysis(fit = 84): Analysis {
  return {
    fit_score: fit,
    confidence: 'medium',
    icp: 'cto_ai_startup',
    angle: 'verification',
    pains: [{ pain: 'stopped reading the diffs', evidence: 'headline mentions AI-generated code review load', source: 'enrichment headline' }],
    hooks: [{ hook: 'audit-as-deliverable', evidence: 'company page lists enterprise clients' }],
    brief_md: 'CTO at an AI-forward startup; review load is the visible pain. Verification angle fits; evidence is thin but consistent.',
    drafts: [
      { step: 'day0_email', channel: 'email', subject: '"done," it said — was it?', body: 'When your team ships AI-written code, what do you show the client who asks what the AI actually did? antiloki seals every AI action into a tamper-evident record. Worth 15 minutes? Reply no and I will close the file.' },
      { step: 'day3_linkedin', channel: 'linkedin', subject: null, body: 'Building governed AI delivery records — your review-load posts resonated. Connecting in case the problem space overlaps.' },
      { step: 'day6_email', channel: 'email', subject: 'try to rewrite history — watch it refuse', body: 'One artifact instead of claims: our audit chain refuses edits at the storage layer. 30-second demo inside. If timing is wrong, say so and I will close the file.' },
      { step: 'day12_email', channel: 'email', subject: 'closing the file', body: 'No reply needed — closing the file on my side. The waitlist stays open if the review-load problem ever bites hard enough. Good building.' },
    ],
  };
}

function fakeFetch(responses: Array<{ status?: number; json: unknown }>): { fn: typeof fetch; calls: any[] } {
  const calls: any[] = [];
  const fn = (async (url: any, init?: any) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.json } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

const OPTS = { apiKey: 'or-test-key-000', baseUrl: 'https://or.example/api/v1', model: 'test/model-1' };

test('money-guard: OpenRouterClient without fetchFn under tests throws', () => {
  assert.throws(() => new OpenRouterClient(OPTS as any), /money-guard/);
});

test('structured: parses fenced JSON content + usage cost', async () => {
  const payload = validAnalysis();
  const { fn, calls } = fakeFetch([
    {
      json: {
        choices: [{ message: { content: '```json\n' + JSON.stringify(payload) + '\n```' } }],
        usage: { prompt_tokens: 900, completion_tokens: 650, cost: 0.0123 },
      },
    },
  ]);
  const client = new OpenRouterClient({ ...OPTS, fetchFn: fn });
  const r = await client.structured({ system: 's', user: 'u', schemaName: 'x', jsonSchema: {} });
  assert.deepEqual(r.parsed, payload);
  assert.equal(r.tokensIn, 900);
  assert.equal(r.tokensOut, 650);
  assert.equal(r.costUsd, 0.0123);
  assert.equal(calls[0].body.response_format.type, 'json_schema');
  assert.equal(calls[0].body.model, 'test/model-1');
});

test('structured: http error and non-JSON content throw', async () => {
  const err = new OpenRouterClient({ ...OPTS, fetchFn: fakeFetch([{ status: 500, json: { error: 'boom' } }]).fn });
  await assert.rejects(() => err.structured({ system: 's', user: 'u', schemaName: 'x', jsonSchema: {} }), /500/);

  const notJson = new OpenRouterClient({
    ...OPTS,
    fetchFn: fakeFetch([{ json: { choices: [{ message: { content: 'sorry, as an ai…' } }] } }]).fn,
  });
  await assert.rejects(() => notJson.structured({ system: 's', user: 'u', schemaName: 'x', jsonSchema: {} }), /not JSON/);
});

test('stripFences tolerates plain and fenced payloads', () => {
  assert.equal(stripFences('{"a":1}'), '{"a":1}');
  assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripFences('```\n{"a":1}\n```'), '{"a":1}');
});

test('acceptAnalysis: valid passes, mutations fail with named paths', () => {
  assert.equal(acceptAnalysis(validAnalysis()).ok, true);

  const wrongFit = { ...validAnalysis(), fit_score: 180 };
  const r1 = acceptAnalysis(wrongFit);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.match(r1.issues, /fit_score/);

  const threeDrafts = { ...validAnalysis(), drafts: validAnalysis().drafts.slice(0, 3) };
  const r2 = acceptAnalysis(threeDrafts);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.match(r2.issues, /drafts/);

  const extraKey = { ...validAnalysis(), sneaky: true };
  assert.equal(acceptAnalysis(extraKey).ok, false);

  assert.equal(acceptAnalysis(null).ok, false);
  assert.equal(acceptAnalysis('string').ok, false);
});

test('analysisJsonSchema is a strict object schema', () => {
  const s = analysisJsonSchema() as any;
  assert.equal(s.type, 'object');
  assert.ok(s.properties.fit_score);
  assert.ok(s.properties.drafts);
  assert.equal(s.additionalProperties, false);
});

test('word budget: countWords + violations', () => {
  assert.equal(countWords('one two  three\nfour'), 4);
  const a = validAnalysis();
  assert.deepEqual(draftBudgetViolations(a), []);
  const over = { ...a, drafts: a.drafts.map((d, i) => (i === 0 ? { ...d, body: Array(95).fill('word').join(' ') } : d)) };
  const v = draftBudgetViolations(over as Analysis);
  assert.equal(v.length, 1);
  assert.match(v[0], /day0_email: 95 words/);
});
