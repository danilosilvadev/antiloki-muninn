import test from 'node:test';
import assert from 'node:assert/strict';
import { displayName, escapeHtml, renderDossier, type LeadView } from '../src/telegram/dossier';

function view(overrides: Partial<LeadView> = {}): LeadView {
  return {
    lead: { id: '0f0e0d0c-1111-4222-8333-444455556666', linkedinUrl: 'https://www.linkedin.com/in/a-rossi-123', status: 'analyzed' },
    enrichment: {
      raw: { datas: [{ firstname: 'A', lastname: 'Rossi', contact: { emails: [{ email: 'a@nimbus.io', status: 'VALID' }] } }] },
      email: 'a@nimbus.io',
      emailStatus: 'verified',
    },
    analysis: {
      fitScore: 84,
      icp: 'cto_ai_startup',
      angle: 'verification',
      pains: [{ pain: 'stopped reading the diffs', evidence: 'headline says so', source: 'enrichment' }],
      hooks: [{ hook: 'audit-as-deliverable', evidence: 'enterprise clients listed' }],
      briefMd: 'CTO at an AI startup. Verification angle. Evidence medium.',
    },
    drafts: [
      { step: 0, channel: 'email', subject: '"done," it said — was it?', bodyMd: 'Short direct question about their review load. Reply no and I close the file.' },
      { step: 1, channel: 'linkedin', subject: null, bodyMd: 'Connect note, no pitch.' },
      { step: 2, channel: 'email', subject: 'watch it refuse', bodyMd: 'One proof artifact.' },
      { step: 3, channel: 'email', subject: 'closing the file', bodyMd: 'Breakup, waitlist stays open.' },
    ],
    ...overrides,
  };
}

test('escapeHtml covers telegram-html specials', () => {
  assert.equal(escapeHtml('<b>&amp;</b>'), '&lt;b&gt;&amp;amp;&lt;/b&gt;');
});

test('displayName prefers vendor names, falls back to a humanized slug', () => {
  assert.equal(displayName(view()), 'A Rossi');
  const noEnrich = view({ enrichment: null });
  assert.equal(displayName(noEnrich), 'A Rossi'); // from slug a-rossi-123, id fragment dropped
});

test('renderDossier contains the operator-relevant lines + buttons', () => {
  const { html, keyboard } = renderDossier(view(), []);
  assert.match(html, /🐦 <b>A Rossi<\/b>/);
  assert.match(html, /fit <b>84<\/b>/);
  assert.match(html, /verification/);
  assert.match(html, /✓ verified email/);
  assert.match(html, /day 0 · email/);
  assert.match(html, /done,.*was it\?/);
  assert.deepEqual(keyboard[0].map((b) => b.callback_data), [
    'q:0f0e0d0c-1111-4222-8333-444455556666',
    'n:0f0e0d0c-1111-4222-8333-444455556666',
    'p:0f0e0d0c-1111-4222-8333-444455556666',
  ]);
});

test('renderDossier stays under the telegram 4096 limit on maximal input', () => {
  const big = 'x'.repeat(5000);
  const v = view({
    analysis: {
      fitScore: 99,
      icp: 'agency_owner',
      angle: 'cant_lie',
      pains: Array(5).fill({ pain: big, evidence: big, source: big }),
      hooks: Array(4).fill({ hook: big, evidence: big }),
      briefMd: big,
    },
    drafts: Array(4).fill({ step: 0, channel: 'email', subject: big, bodyMd: big }),
  });
  const { html } = renderDossier(v, ['day0_email: 999 words (budget 80)']);
  assert.ok(html.length <= 4096, `html length ${html.length} exceeds telegram limit`);
});

test('renderDossier without analysis says so instead of inventing one', () => {
  const { html } = renderDossier(view({ analysis: null, drafts: [] }), []);
  assert.match(html, /no analysis yet/);
});

test('no-email lead is labeled linkedin-only', () => {
  const v = view({ enrichment: { raw: {}, email: null, emailStatus: 'not_found' } });
  const { html } = renderDossier(v, []);
  assert.match(html, /✖ no email — LinkedIn-only/);
});
