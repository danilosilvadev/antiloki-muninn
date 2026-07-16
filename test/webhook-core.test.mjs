// Tests the exact mapping file the webhook-sink edge function ships.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emailDomain, mapSmartleadWebhook } from '../supabase/functions/_shared/webhook-core.ts';

test('reply events carry the reply text for the classifier', () => {
  const m = mapSmartleadWebhook({
    event_type: 'EMAIL_REPLY',
    lead_email: 'A.Rossi@Nimbus.io',
    from_email: 'danilo@send1.example',
    campaign_id: 12345,
    reply_body: 'interesting — how does the chain handle rebases?',
  });
  assert.equal(m.kind, 'reply');
  assert.equal(m.email, 'a.rossi@nimbus.io');
  assert.equal(m.sendingAccount, 'danilo@send1.example');
  assert.equal(m.campaignId, '12345');
  assert.match(m.replyText ?? '', /rebases/);
  assert.equal(m.suppress, null);
});

test('unsub, bounce and complaint demand immediate suppression', () => {
  assert.equal(mapSmartleadWebhook({ event_type: 'LEAD_UNSUBSCRIBED', email: 'x@y.io' }).suppress, 'unsub');
  assert.equal(mapSmartleadWebhook({ event: 'EMAIL_BOUNCE', to_email: 'x@y.io' }).suppress, 'bounce');
  assert.equal(mapSmartleadWebhook({ type: 'SPAM_COMPLAINT', lead: { email: 'x@y.io' } }).suppress, 'complaint');
  assert.equal(mapSmartleadWebhook({ event_type: 'EMAIL_SENT', lead_email: 'x@y.io' }).suppress, null);
});

test('sent/open/click map for the health math; junk maps to unknown', () => {
  assert.equal(mapSmartleadWebhook({ event_type: 'EMAIL_SENT' }).kind, 'sent');
  assert.equal(mapSmartleadWebhook({ event_type: 'EMAIL_OPEN' }).kind, 'open');
  assert.equal(mapSmartleadWebhook({ event_type: 'EMAIL_LINK_CLICK' }).kind, 'click');
  assert.equal(mapSmartleadWebhook({ event_type: 'SOMETHING_ELSE' }).kind, 'unknown');
  assert.equal(mapSmartleadWebhook(null).kind, 'unknown');
  assert.equal(mapSmartleadWebhook({}).email, null);
});

test('emails are validated + lowercased; garbage stays null', () => {
  assert.equal(mapSmartleadWebhook({ event_type: 'EMAIL_SENT', lead_email: 'not-an-email' }).email, null);
  assert.equal(mapSmartleadWebhook({ event_type: 'EMAIL_SENT', lead_email: '  A@B.CO ' }).email, 'a@b.co');
});

test('emailDomain splits safely', () => {
  assert.equal(emailDomain('a@nimbus.io'), 'nimbus.io');
  assert.equal(emailDomain(null), null);
  assert.equal(emailDomain('junk'), null);
});
