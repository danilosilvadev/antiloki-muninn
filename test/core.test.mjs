// Unit tests for the edge functions' shared pure logic. Runs on Node 24's
// built-in type stripping — the same file Deno imports in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  b64urlDecode, b64urlEncode, clampText, corsHeadersFor, escapeHtml,
  honeypotTripped, normalizeConsentChannel, normalizeEmail, normalizeHandle,
  normalizeReferralCode, operatorLine, parseAllowedOrigins, pickUtm,
  referralUrl, sha256Hex, unsubToken, unsubUrl, verifyUnsubToken,
} from '../supabase/functions/_shared/core.ts';

test('normalizeEmail accepts, trims and lowercases valid addresses', () => {
  assert.equal(normalizeEmail('You@YourCompany.DEV'), 'you@yourcompany.dev');
  assert.equal(normalizeEmail('  a@b.co  '), 'a@b.co');
});

test('normalizeEmail rejects junk', () => {
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail('two@@at.com'), null);
  assert.equal(normalizeEmail('sp ace@x.com'), null);
  assert.equal(normalizeEmail('missing@tld'), null);
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeEmail(null), null);
  assert.equal(normalizeEmail(42), null);
  assert.equal(normalizeEmail('a@' + 'b'.repeat(260) + '.com'), null);
});

test('clampText trims, truncates and nulls empties', () => {
  assert.equal(clampText('  hi  ', 10), 'hi');
  assert.equal(clampText('x'.repeat(20), 5), 'xxxxx');
  assert.equal(clampText('   ', 5), null);
  assert.equal(clampText(7, 5), null);
});

test('honeypot trips only on a filled company field', () => {
  assert.equal(honeypotTripped({ company: 'Evil Corp' }), true);
  assert.equal(honeypotTripped({ company: '   ' }), false);
  assert.equal(honeypotTripped({ company: '' }), false);
  assert.equal(honeypotTripped({}), false);
  assert.equal(honeypotTripped({ company: 123 }), false);
});

test('pickUtm keeps only known keys and truncates values', () => {
  const utm = pickUtm({
    utm_source: 'x', utm_medium: 'social', utm_campaign: 'launch',
    utm_term: 't', utm_content: 'c', referrer: 'https://news.ycombinator.com/',
    evil: 'dropme', __proto__conf: 'no',
  });
  assert.deepEqual(Object.keys(utm).sort(), [
    'referrer', 'utm_campaign', 'utm_content', 'utm_medium', 'utm_source', 'utm_term',
  ]);
  assert.equal(pickUtm({ utm_source: 'y'.repeat(1000) }).utm_source.length, 300);
  assert.deepEqual(pickUtm(null), {});
  assert.deepEqual(pickUtm('str'), {});
  assert.deepEqual(pickUtm({ utm_source: 9 }), {});
});

test('referral codes: DB-minted shape passes, junk fails', () => {
  assert.equal(normalizeReferralCode('a1b2c3d4'), 'a1b2c3d4');   // substr(md5,1,8) shape
  assert.equal(normalizeReferralCode('  A1B2C3D4 '), 'a1b2c3d4');
  assert.equal(normalizeReferralCode('abc'), null);              // too short
  assert.equal(normalizeReferralCode('x'.repeat(21)), null);     // too long
  assert.equal(normalizeReferralCode('has space'), null);
  assert.equal(normalizeReferralCode('<script>'), null);
  assert.equal(normalizeReferralCode(undefined), null);
});

test('referralUrl joins cleanly regardless of trailing slash', () => {
  assert.equal(referralUrl('https://x.dev', 'abcd1234'), 'https://x.dev/r/abcd1234');
  assert.equal(referralUrl('https://x.dev/', 'abcd1234'), 'https://x.dev/r/abcd1234');
});

test('operatorLine renders the approved success copy', () => {
  assert.equal(operatorLine(214, false), '✓ operator #214 — share your link to skip the line');
  assert.equal(operatorLine(214, true), '✓ already in line — operator #214 — share your link to skip the line');
});

test('escapeHtml neutralizes markup', () => {
  assert.equal(escapeHtml(`<img src=x onerror="a('b')">&`),
    '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
});

test('CORS: allowed origins echo, others get nothing', () => {
  const allowed = parseAllowedOrigins(' https://antiloki.example , http://localhost:8788/ ');
  assert.deepEqual(allowed, ['https://antiloki.example', 'http://localhost:8788']);
  const hit = corsHeadersFor('https://antiloki.example', allowed);
  assert.equal(hit['Access-Control-Allow-Origin'], 'https://antiloki.example');
  assert.equal(hit['Vary'], 'Origin');
  assert.deepEqual(corsHeadersFor('https://evil.example', allowed), {});
  assert.deepEqual(corsHeadersFor(null, allowed), {});
  assert.deepEqual(corsHeadersFor('https://antiloki.example', []), {});
});

test('sha256Hex matches the known test vector', async () => {
  assert.equal(await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('b64url roundtrips emails including unicode', () => {
  for (const s of ['a@b.co', 'ünïcode@exämple.dev', 'plus+tag@x.io']) {
    const enc = b64urlEncode(s);
    assert.match(enc, /^[A-Za-z0-9_-]+$/);
    assert.equal(b64urlDecode(enc), s);
  }
  assert.equal(b64urlDecode('!!!not-base64!!!'), null);
});

test('unsub tokens verify only for the right email + secret', async () => {
  const token = await unsubToken('a@b.co', 's3cret');
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(await verifyUnsubToken('a@b.co', token, 's3cret'), true);
  assert.equal(await verifyUnsubToken('other@b.co', token, 's3cret'), false);
  assert.equal(await verifyUnsubToken('a@b.co', token, 'wrong'), false);
  assert.equal(await verifyUnsubToken('a@b.co', 'zz'.repeat(32), 's3cret'), false);
  assert.equal(await verifyUnsubToken('a@b.co', 'short', 's3cret'), false);
});

test('unsubUrl builds the canonical link shape', async () => {
  const token = await unsubToken('a@b.co', 's3cret');
  const url = unsubUrl('https://ref.supabase.co/functions/v1/', 'a@b.co', token);
  assert.equal(url, `https://ref.supabase.co/functions/v1/unsub?e=${b64urlEncode('a@b.co')}&t=${token}`);
});

test('consent channels: only whatsapp/telegram, verbatim', () => {
  assert.equal(normalizeConsentChannel('whatsapp'), 'whatsapp');
  assert.equal(normalizeConsentChannel('telegram'), 'telegram');
  assert.equal(normalizeConsentChannel('email'), null);
  assert.equal(normalizeConsentChannel('WHATSAPP'), null);
  assert.equal(normalizeConsentChannel(null), null);
});

test('whatsapp handles: E.164 shape, separators tolerated, + canonical', () => {
  assert.equal(normalizeHandle('whatsapp', '+55 (11) 91234-5678'), '+5511912345678');
  assert.equal(normalizeHandle('whatsapp', '5511912345678'), '+5511912345678');
  assert.equal(normalizeHandle('whatsapp', '123456'), null);        // too short
  assert.equal(normalizeHandle('whatsapp', '1'.repeat(16)), null);  // too long
  assert.equal(normalizeHandle('whatsapp', 'call-me-maybe'), null);
  assert.equal(normalizeHandle('whatsapp', ''), null);
  assert.equal(normalizeHandle('whatsapp', 42), null);
});

test('telegram handles: 5..32 word chars, letter first, @ canonical + lowercased', () => {
  assert.equal(normalizeHandle('telegram', '@Dani_Dev'), '@dani_dev');
  assert.equal(normalizeHandle('telegram', 'dani_dev'), '@dani_dev');
  assert.equal(normalizeHandle('telegram', '@dani'), null);          // 4 chars — too short
  assert.equal(normalizeHandle('telegram', '@1dani'), null);         // digit first
  assert.equal(normalizeHandle('telegram', '@' + 'a'.repeat(33)), null);
  assert.equal(normalizeHandle('telegram', 'has space'), null);
});
