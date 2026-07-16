// Slice-4 integration on pglite + real SQL (the slice-4 migration runs for
// real here): referral math (3-referrals-jump-a-wave, position never faked),
// wave lifecycle (create → selection → issue → redeem → activate), the
// Resend invite path with its money-guard, the sequence timing editor, and
// the weekly targets digest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import * as t from '../src/db/schema';
import type { Db } from '../src/db/db';
import { ResendAdapter } from '../src/channels/resend.adapter';
import { SequenceService } from '../src/channels/sequence.service';
import { SmartleadAdapter } from '../src/channels/smartlead.adapter';
import { PolicyService } from '../src/policy/policy.service';
import { buildWeeklyDigest } from '../src/telegram/digest';
import { redeemUrl, renderInviteEmail, unsubTokenNode, unsubUrlNode } from '../src/waves/invite-email';
import { WavesService } from '../src/waves/waves.service';

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

async function seedMember(db: Db, email: string, code: string, referredBy: string | null = null, name: string | null = null) {
  await db.insert(t.waitlistMembers).values({ email, referralCode: code, referredBy, name });
  const [row] = await db.select().from(t.waitlistMembers).where(eq(t.waitlistMembers.email, email)).limit(1);
  return row;
}

function resendFetch() {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const fn = (async (url: any, init?: any) => {
    calls.push({
      url: String(url),
      auth: (init?.headers as Record<string, string>)?.['authorization'] ?? null,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return { ok: true, status: 200, json: async () => ({ id: 're_' + calls.length }) } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

const WAVES_CFG = {
  functionsBase: 'https://ref.supabase.co/functions/v1',
  edgeSecret: 's3cret',
  postalLine: 'Av. Paulista 1000, São Paulo, BR',
};

function makeWaves(db: Db, withResend = true) {
  const rf = resendFetch();
  const resend = withResend
    ? new ResendAdapter({ apiKey: 're-key-000000', baseUrl: 'https://resend.example', from: 'Danilo <dani@antiloki.dev>', fetchFn: rf.fn })
    : null;
  const notes: string[] = [];
  const waves = new WavesService(db, resend, WAVES_CFG, async (h) => {
    notes.push(h);
  });
  return { waves, rf, notes };
}

// ── referral math ─────────────────────────────────────────────────────────────

test('referral math: every 3 confirmed referrals lifts a tier; tiers outrank join order; position never mutates', async () => {
  const db = await makeDb();
  const a = await seedMember(db, 'a@x.co', 'codea001');        // position 1
  await seedMember(db, 'b@x.co', 'codeb001');                  // position 2
  const e = await seedMember(db, 'e@x.co', 'codee001');        // position 3, will bank 3 referrals
  await seedMember(db, 'r1@x.co', 'coder001', 'codee001');     // referred by e
  await seedMember(db, 'r2@x.co', 'coder002', 'codee001');
  await seedMember(db, 'r3@x.co', 'coder003', 'codee001');
  await seedMember(db, 'j@x.co', 'codej001', 'deadbeef');      // junk referrer — owned by nobody

  const { waves } = makeWaves(db);
  const standings = await waves.standings();

  const eS = standings.find((m) => m.email === 'e@x.co')!;
  const aS = standings.find((m) => m.email === 'a@x.co')!;
  assert.equal(eS.referrals, 3);
  assert.equal(eS.tier, 1);
  assert.equal(eS.effectiveRank, 1); // jumped past two earlier joiners
  assert.equal(aS.effectiveRank, 2); // join order intact below the tier
  assert.equal(eS.position, e.position); // the REAL position column untouched
  assert.equal(aS.position, a.position);

  const view = await waves.view();
  assert.equal(view.funnel.referred, 3); // junk referred_by never counts
  assert.equal(view.leaderboard[0].email, 'e@x.co');
  assert.equal(view.leaderboard[0].tier, 1);
});

// ── wave lifecycle ────────────────────────────────────────────────────────────

test('wave lifecycle: selection honors tiers + skips suppressed; issue mints codes, stamps invited_at, emails via Resend', async () => {
  const db = await makeDb();
  await seedMember(db, 'a@x.co', 'codea001', null, 'Ada');     // pos 1 — will be suppressed
  await seedMember(db, 'b@x.co', 'codeb001', null, 'Bo');      // pos 2
  await seedMember(db, 'c@x.co', 'codec001');                  // pos 3
  await seedMember(db, 'e@x.co', 'codee001', null, 'Eve');     // pos 4 + 3 refs → tier 1
  await seedMember(db, 'r1@x.co', 'coder001', 'codee001');
  await seedMember(db, 'r2@x.co', 'coder002', 'codee001');
  await seedMember(db, 'r3@x.co', 'coder003', 'codee001');
  await db.insert(t.suppressions).values({ email: 'a@x.co', reason: 'unsub' });

  const { waves, rf, notes } = makeWaves(db);
  const { wave } = await waves.createWave({ size: 3, opensAt: new Date('2026-08-12T00:00:00Z'), label: 'first ten' });
  assert.equal(wave, 1);

  const sel = await waves.selection(1);
  assert.equal(sel.remaining, 3);
  // Eve's tier jumps her over everyone; Ada (pos 1) is suppressed and absent
  assert.deepEqual(sel.picks.map((p) => p.email), ['e@x.co', 'b@x.co', 'c@x.co']);

  const r = await waves.issue(1);
  assert.equal(r.issued.length, 3);
  assert.equal(r.emailsSkippedReason, null);
  assert.ok(r.issued.every((i) => i.emailed));
  assert.ok(r.issued.every((i) => /^[0-9a-f]{8}$/.test(i.code)));

  // codes landed as invite rows, members stamped, audit events written
  const invites = await db.select().from(t.invites);
  assert.equal(invites.length, 3);
  const [eveRow] = await db.select().from(t.waitlistMembers).where(eq(t.waitlistMembers.email, 'e@x.co'));
  assert.ok(eveRow.invitedAt);
  const events = await db.select().from(t.events).where(eq(t.events.kind, 'invite_issued'));
  assert.equal(events.length, 3);
  const vendor = await db.select().from(t.vendorCalls).where(eq(t.vendorCalls.provider, 'resend'));
  assert.equal(vendor.length, 3);

  // the email itself: right recipient, code + redeem link + unsub + postal line
  assert.equal(rf.calls.length, 3);
  const first = rf.calls[0];
  assert.equal(first.auth, 'Bearer re-key-000000');
  assert.equal(first.body['from'], 'Danilo <dani@antiloki.dev>');
  assert.deepEqual(first.body['to'], ['e@x.co']);
  const eveCode = r.issued.find((i) => i.email === 'e@x.co')!.code;
  assert.match(String(first.body['subject']), /operator #\d+/);
  assert.ok(String(first.body['html']).includes(eveCode));
  assert.ok(String(first.body['html']).includes(`/invite?c=${eveCode}`));
  assert.ok(String(first.body['html']).includes('/unsub?e='));
  assert.ok(String(first.body['html']).includes('Av. Paulista 1000'));
  assert.ok(String(first.body['text']).includes(eveCode));

  // wave full → second issue is a no-op; explicit re-issue names the reason
  const again = await waves.issue(1);
  assert.equal(again.issued.length, 0);
  const eveId = sel.picks[0].id;
  const explicit = await waves.issue(1, [eveId]);
  assert.equal(explicit.issued.length, 0);
  assert.equal(explicit.skipped[0].reason, 'already_invited');

  assert.ok(notes.some((n) => n.includes('wave 1')));
});

test('no Resend configured: codes still mint, emails skip with the reason named', async () => {
  const db = await makeDb();
  await seedMember(db, 'b@x.co', 'codeb001');
  const { waves } = makeWaves(db, false);
  await waves.createWave({ size: 1 });
  const r = await waves.issue(1);
  assert.equal(r.issued.length, 1);
  assert.equal(r.issued[0].emailed, false);
  assert.match(r.emailsSkippedReason ?? '', /RESEND_API_KEY/);
});

test('redeem (edge-side stamp) + operator activation close the funnel, per wave and in total', async () => {
  const db = await makeDb();
  await seedMember(db, 'b@x.co', 'codeb001');
  await seedMember(db, 'c@x.co', 'codec001');
  const { waves } = makeWaves(db);
  await waves.createWave({ size: 2 });
  const r = await waves.issue(1);

  // the invite edge function's write, verbatim: stamp redeemed_at once
  const bCode = r.issued.find((i) => i.email === 'b@x.co')!.code;
  await db.update(t.invites).set({ redeemedAt: new Date() }).where(eq(t.invites.code, bCode));

  const bId = r.issued.find((i) => i.email === 'b@x.co')!.memberId;
  const act = await waves.activate(bId);
  assert.deepEqual(act, { ok: true, already: false });
  const act2 = await waves.activate(bId);
  assert.deepEqual(act2, { ok: true, already: true });

  const view = await waves.view();
  assert.equal(view.funnel.invited, 2);
  assert.equal(view.funnel.redeemed, 1);
  assert.equal(view.funnel.activated, 1);
  const w1 = view.waves.find((w) => w.wave === 1)!;
  assert.equal(w1.issued, 2);
  assert.equal(w1.redeemed, 1);
  assert.equal(w1.activated, 1);
  const bInvite = w1.invites.find((i) => i.email === 'b@x.co')!;
  assert.ok(bInvite.redeemedAt);
  assert.ok(bInvite.activatedAt);
});

// ── the consented-path adapter ────────────────────────────────────────────────

test('money-guard: ResendAdapter without fetchFn under tests throws', () => {
  assert.throws(
    () => new ResendAdapter({ apiKey: 're-key-000000', baseUrl: 'https://resend.example', from: 'x <x@y.z>' }),
    /money-guard/,
  );
});

test('invite email helpers: unsub token matches the edge contract (pinned vector), links keep shape', () => {
  // hex HMAC-SHA256('s3cret', 'unsub:a@b.co') — the same value _shared/core.ts unsubToken() mints
  assert.equal(unsubTokenNode('a@b.co', 's3cret'), '7bac7f93dd00a92ed2d8a55997cf490c2a0f177088e840e4cd64745c792d8cc3');
  assert.equal(
    unsubUrlNode('https://ref.supabase.co/functions/v1/', 'a@b.co', 's3cret'),
    'https://ref.supabase.co/functions/v1/unsub?e=YUBiLmNv&t=7bac7f93dd00a92ed2d8a55997cf490c2a0f177088e840e4cd64745c792d8cc3',
  );
  assert.equal(redeemUrl('https://ref.supabase.co/functions/v1/', 'abcd1234'), 'https://ref.supabase.co/functions/v1/invite?c=abcd1234');

  const mail = renderInviteEmail({
    name: 'Ada <script>',
    email: 'a@b.co',
    position: 7,
    code: 'abcd1234',
    wave: 1,
    opensAt: new Date('2026-08-12T00:00:00Z'),
    redeemUrl: 'https://r.example/invite?c=abcd1234',
    unsubUrl: null,
    postalLine: null,
  });
  assert.match(mail.subject, /operator #7/);
  assert.ok(mail.html.includes('abcd1234'));
  assert.ok(mail.html.includes('wave 1 · opens 2026-08-12'));
  assert.ok(!mail.html.includes('<script>')); // names are escaped
  assert.ok(mail.text.includes('https://r.example/invite?c=abcd1234'));
});

// ── the sequence timing editor (D6) ──────────────────────────────────────────

function slFetch() {
  const calls: { url: string; method: string; body: any }[] = [];
  const fn = (async (url: any, init?: any) => {
    const entry = { url: String(url), method: String(init?.method ?? 'GET'), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(entry);
    let json: unknown = {};
    if (entry.url.includes('/campaigns?')) json = [];
    if (entry.url.includes('/campaigns/create')) json = { id: 900 };
    return { ok: true, status: 200, json: async () => json } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

test('timing editor: delays persist, push to a live campaign, and seed the next campaign creation', async () => {
  const db = await makeDb();
  const sl = slFetch();
  const smartlead = new SmartleadAdapter({ apiKey: 'sl-key-000000', baseUrl: 'https://sl.example/api/v1', fetchFn: sl.fn });
  const policy = new PolicyService(db, { dailyCap: 30, quietHours: '0-0', utcOffset: 0, geoBlocked: 'DE,CA', senderReady: true });
  const sequences = new SequenceService(db, policy, smartlead, async () => {});

  // default before any edit
  assert.deepEqual(await sequences.templateDelays('verification'), [0, 6, 6]);

  // live campaign exists → edit pushes to Smartlead
  await db.insert(t.smartleadCampaigns).values({ angle: 'verification', campaignId: '900' });
  const r = await sequences.setTemplateDelays('verification', [0, 3, 9]);
  assert.equal(r.pushedToSmartlead, true);
  const push = sl.calls.find((c) => c.url.includes('/campaigns/900/sequences'));
  assert.ok(push);
  assert.equal(push!.body.sequences[1].seq_delay_details.delay_in_days, 3);
  assert.equal(push!.body.sequences[2].seq_delay_details.delay_in_days, 9);
  assert.deepEqual(await sequences.templateDelays('verification'), [0, 3, 9]);

  // no campaign yet → edit persists only; ensureCampaign uses it at creation
  const r2 = await sequences.setTemplateDelays('memory', [0, 4, 8]);
  assert.equal(r2.pushedToSmartlead, false);
  await sequences.ensureCampaign('memory');
  const create = sl.calls.filter((c) => c.url.includes('/campaigns/900/sequences'));
  assert.equal(create[create.length - 1].body.sequences[1].seq_delay_details.delay_in_days, 4);
});

// ── the weekly targets digest (C11) ──────────────────────────────────────────

test('weekly digest: measures the 7d window against reply + cost-per-positive targets', async () => {
  const db = await makeDb();
  for (let i = 0; i < 5; i++) await db.insert(t.events).values({ kind: 'sent', payload: {} });
  await db.insert(t.events).values({ kind: 'reply', payload: {} });
  await db.insert(t.events).values({ kind: 'reply_labeled', payload: { label: 'positive' } });
  await db.insert(t.events).values({ kind: 'reply_labeled', payload: { label: 'negative' } });
  await db.insert(t.vendorCalls).values({ provider: 'fullenrich', kind: 'enrich', costUsd: '10' });
  await seedMember(db, 'w@x.co', 'codew001');

  const w = await buildWeeklyDigest(db, { costPerPositive: 25, replyPct: 5.5 });
  assert.ok(w.html.includes('sent <b>5</b>'));
  assert.ok(w.html.includes('(20.0% ✓ target ≥ 5.5%)'));
  assert.ok(w.html.includes('positive <b>1</b>'));
  assert.ok(w.html.includes('cost/positive <b>$10.00</b> ✓'));
  assert.ok(w.html.includes('waitlist +1 (total 1)'));
});

test('weekly digest: honest empties — no sends, no positives', async () => {
  const db = await makeDb();
  const w = await buildWeeklyDigest(db, { costPerPositive: 25, replyPct: 5.5 });
  assert.ok(w.html.includes('(rate — · no sends yet)'));
  assert.ok(w.html.includes('— (no positives yet)'));
});
