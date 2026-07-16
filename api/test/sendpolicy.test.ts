// C5's promised refusal-matrix test: 12 refusal cases + the allow paths,
// table-driven against the pure gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateSendPolicy, geoFromRaw, hourInOffset, inQuietHours,
  parseGeoBlocked, parseQuietHours, type PolicyInput,
} from '../src/policy/send-policy';

function base(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    channel: 'email',
    pauseAll: false,
    suppressedEmail: false,
    suppressedLinkedin: false,
    hasConsent: false,
    geo: 'US',
    geoBlocked: ['DE', 'CA'],
    senderReady: true,
    sentToday: 3,
    dailyCap: 30,
    hourLocal: 10,
    quietStart: 20,
    quietEnd: 8,
    bounceRate: 0.005,
    complaintRate: 0.0,
    ...overrides,
  };
}

const MATRIX: { name: string; input: PolicyInput; code: string; match: RegExp }[] = [
  { name: '1 · kill switch', input: base({ pauseAll: true }), code: 'pause_all', match: /kill switch/ },
  { name: '2 · suppressed email', input: base({ suppressedEmail: true }), code: 'suppressed', match: /suppression list/ },
  { name: '3 · suppressed linkedin (kills every channel)', input: base({ channel: 'linkedin', suppressedLinkedin: true }), code: 'suppressed', match: /no channel/ },
  { name: '4 · whatsapp without consent', input: base({ channel: 'whatsapp' }), code: 'no_consent', match: /opt-in-only/ },
  { name: '5 · telegram without consent', input: base({ channel: 'telegram' }), code: 'no_consent', match: /opt-in-only/ },
  { name: '6 · Germany blocked (UWG §7)', input: base({ geo: 'DE' }), code: 'geo_blocked', match: /UWG/ },
  { name: '7 · Canada blocked (CASL)', input: base({ geo: 'ca' }), code: 'geo_blocked', match: /CASL/ },
  { name: '8 · no sender configured', input: base({ senderReady: false }), code: 'not_ready', match: /SMARTLEAD_API_KEY/ },
  { name: '9 · daily cap reached', input: base({ sentToday: 30 }), code: 'daily_cap', match: /30\/30.*conversation ceiling/s },
  { name: '10 · quiet hours (23:00 in 20-8)', input: base({ hourLocal: 23 }), code: 'quiet_hours', match: /quiet hours/ },
  { name: '11 · bounce rate over 2%', input: base({ bounceRate: 0.025 }), code: 'domain_health', match: /bounce rate 2\.5%/ },
  { name: '12 · complaint rate at 0.1%', input: base({ complaintRate: 0.001 }), code: 'domain_health', match: /complaint rate/ },
];

for (const c of MATRIX) {
  test(`refusal matrix ${c.name}`, () => {
    const v = evaluateSendPolicy(c.input);
    assert.equal(v.allowed, false, 'expected a refusal');
    if (!v.allowed) {
      assert.equal(v.code, c.code);
      assert.match(v.reason, c.match);
    }
  });
}

test('allow: clean US email at 10:00 under cap', () => {
  const v = evaluateSendPolicy(base());
  assert.equal(v.allowed, true);
  if (v.allowed) assert.deepEqual(v.notes, []);
});

test('allow with notes: UK corporate-subscriber note; EU legitimate-interest note', () => {
  const uk = evaluateSendPolicy(base({ geo: 'GB' }));
  assert.ok(uk.allowed && /PECR/.test(uk.notes[0]));
  const fr = evaluateSendPolicy(base({ geo: 'FR' }));
  assert.ok(fr.allowed && /legitimate-interest/.test(fr.notes[0]));
});

test('allow: unknown geo passes (targeting is the filter, not the gate)', () => {
  assert.equal(evaluateSendPolicy(base({ geo: null })).allowed, true);
});

test('allow: telegram/whatsapp WITH consent pass every email-only gate', () => {
  const v = evaluateSendPolicy(base({ channel: 'telegram', hasConsent: true, senderReady: false, sentToday: 999, hourLocal: 23 }));
  assert.equal(v.allowed, true);
});

test('allow: linkedin manual touches ignore caps/quiet/health (human-executed)', () => {
  const v = evaluateSendPolicy(base({ channel: 'linkedin', sentToday: 999, hourLocal: 23, bounceRate: 0.5 }));
  assert.equal(v.allowed, true);
});

test('ordering: kill switch outranks suppression outranks everything', () => {
  const v = evaluateSendPolicy(base({ pauseAll: true, suppressedEmail: true, geo: 'DE' }));
  assert.ok(!v.allowed && v.code === 'pause_all');
  const v2 = evaluateSendPolicy(base({ suppressedEmail: true, geo: 'DE' }));
  assert.ok(!v2.allowed && v2.code === 'suppressed');
});

test('quiet hours math: wraps midnight, half-open, degenerate window off', () => {
  assert.equal(inQuietHours(23, 20, 8), true);
  assert.equal(inQuietHours(3, 20, 8), true);
  assert.equal(inQuietHours(8, 20, 8), false);   // end is exclusive
  assert.equal(inQuietHours(19, 20, 8), false);
  assert.equal(inQuietHours(12, 9, 17), true);   // non-wrapping window
  assert.equal(inQuietHours(12, 12, 12), false); // start==end → disabled
  assert.deepEqual(parseQuietHours('20-8'), { start: 20, end: 8 });
  assert.deepEqual(parseQuietHours('junk'), { start: 20, end: 8 });
});

test('hourInOffset: UTC-3 and UTC+5.5 both resolve', () => {
  const utcNoon = Date.UTC(2026, 6, 16, 12, 0, 0);
  assert.equal(hourInOffset(utcNoon, -3), 9);
  assert.equal(hourInOffset(utcNoon, 5.5), 17);
});

test('parseGeoBlocked + geoFromRaw resolve vendor shapes', () => {
  assert.deepEqual(parseGeoBlocked(' de , ca '), ['DE', 'CA']);
  assert.equal(geoFromRaw({ datas: [{ country_code: 'br' }] }), 'BR');
  assert.equal(geoFromRaw({ datas: [{ company: { country: 'Germany' } }] }), 'DE');
  assert.equal(geoFromRaw({ datas: [{ profile: { country: 'United States' } }] }), 'US');
  assert.equal(geoFromRaw({}), null);
});
