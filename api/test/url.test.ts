import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLinkedinUrl, normalizeLinkedinUrl, slugOf } from '../src/leads/leads.service';

test('normalizeLinkedinUrl canonicalizes every accepted variant', () => {
  const want = 'https://www.linkedin.com/in/a-rossi-123';
  assert.equal(normalizeLinkedinUrl('https://www.linkedin.com/in/a-rossi-123'), want);
  assert.equal(normalizeLinkedinUrl('http://linkedin.com/in/a-rossi-123'), want);
  assert.equal(normalizeLinkedinUrl('linkedin.com/in/a-rossi-123'), want);
  assert.equal(normalizeLinkedinUrl('br.linkedin.com/in/a-rossi-123'), want);
  assert.equal(normalizeLinkedinUrl('https://www.linkedin.com/in/A-Rossi-123'), want); // slug case-folds
  assert.equal(normalizeLinkedinUrl('https://www.linkedin.com/in/a-rossi-123/'), want);
  assert.equal(normalizeLinkedinUrl('https://www.linkedin.com/in/a-rossi-123?utm_source=x#top'), want);
  assert.equal(normalizeLinkedinUrl('  linkedin.com/in/a-rossi-123  '), want);
});

test('normalizeLinkedinUrl rejects non-profile URLs', () => {
  assert.equal(normalizeLinkedinUrl('https://linkedin.com/company/nimbus'), null);
  assert.equal(normalizeLinkedinUrl('https://linkedin.com/pub/old-style'), null);
  assert.equal(normalizeLinkedinUrl('https://evil.com/in/a-rossi'), null);
  assert.equal(normalizeLinkedinUrl('https://linkedin.com.evil.com/in/a'), null);
  assert.equal(normalizeLinkedinUrl('https://linkedin.com/in/'), null);
  assert.equal(normalizeLinkedinUrl('not a url'), null);
  assert.equal(normalizeLinkedinUrl(''), null);
});

test('extractLinkedinUrl finds a profile URL inside chat text', () => {
  assert.equal(
    extractLinkedinUrl('check this one: https://www.linkedin.com/in/a-rossi-123 looks great'),
    'https://www.linkedin.com/in/a-rossi-123',
  );
  assert.equal(extractLinkedinUrl('linkedin.com/in/solo'), 'linkedin.com/in/solo');
  assert.equal(extractLinkedinUrl('no url here'), null);
});

test('slugOf pulls the slug back out of a normalized url', () => {
  assert.equal(slugOf('https://www.linkedin.com/in/a-rossi-123'), 'a-rossi-123');
});
