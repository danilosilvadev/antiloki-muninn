// waitlist-join — the landing form's only write path (A1).
// POST { email, name?, ref?, utm?, source?, company? (honeypot) }
//  → { ok, position, referral_code, referral_url, deduped, message }
//
// Validates + normalizes, honeypots bots (fake success, no row), rate-limits
// per ip-hash via the events audit table, dedupes by email (resubmit returns
// the original position), captures UTM, and answers with the operator number.
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  clampText, corsHeadersFor, honeypotTripped, normalizeEmail, normalizeReferralCode,
  operatorLine, parseAllowedOrigins, pickUtm, referralUrl, sha256Hex,
} from '../_shared/core.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);
const ALLOWED = parseAllowedOrigins(Deno.env.get('ALLOWED_ORIGINS'));
const LANDING = (Deno.env.get('LANDING_URL') ?? '').replace(/\/+$/, '');
const SECRET = Deno.env.get('MUNINN_EDGE_SECRET') ?? 'dev-secret-set-me';
const RATE_LIMIT = Number(Deno.env.get('RATE_LIMIT_PER_HOUR') ?? '20');

function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
  });
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req.headers.get('origin'), ALLOWED);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' }, cors);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'invalid_json' }, cors);
  }

  const email = normalizeEmail(body.email);
  if (!email) return json(400, { ok: false, error: 'invalid_email' }, cors);

  // Bots that fill the hidden field get a success-shaped answer and no row.
  if (honeypotTripped(body)) {
    return json(200, {
      ok: true, position: null, referral_code: null, referral_url: null,
      deduped: false, message: '✓ You’re on the list. We’ll be in touch.',
    }, cors);
  }

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const ipHash = await sha256Hex('ip:' + SECRET + ':' + ip);

  // Rate limit joins per ip-hash per hour, counted in events. Fails open:
  // a broken counter must never turn real signups away.
  try {
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const { count, error } = await supabase
      .from('events')
      .select('id', { count: 'exact', head: true })
      .eq('kind', 'waitlist_join')
      .gte('at', oneHourAgo)
      .eq('payload->>ip_hash', ipHash);
    if (!error && (count ?? 0) >= RATE_LIMIT) {
      return json(429, { ok: false, error: 'rate_limited' }, cors);
    }
  } catch (e) {
    console.error('rate-limit check failed (failing open):', e);
  }

  const existing = await supabase
    .from('waitlist_members')
    .select('position, referral_code')
    .eq('email', email)
    .maybeSingle();
  if (existing.error) return json(500, { ok: false, error: 'lookup_failed' }, cors);

  let row = existing.data;
  let deduped = Boolean(row);

  if (!row) {
    const insert = await supabase
      .from('waitlist_members')
      .insert({
        email,
        name: clampText(body.name, 120),
        source: clampText(body.source, 60) ?? 'landing',
        referred_by: normalizeReferralCode(body.ref),
        utm: pickUtm(body.utm),
      })
      .select('position, referral_code')
      .single();
    if (insert.error) {
      if (insert.error.code === '23505') { // unique race: this email landed a moment ago
        const again = await supabase
          .from('waitlist_members')
          .select('position, referral_code')
          .eq('email', email)
          .maybeSingle();
        if (again.data) {
          row = again.data;
          deduped = true;
        }
      }
      if (!row) return json(500, { ok: false, error: 'insert_failed' }, cors);
    } else {
      row = insert.data;
    }
  }

  // Audit row — best effort, never fails the join.
  try {
    await supabase.from('events').insert({
      kind: 'waitlist_join',
      payload: { ip_hash: ipHash, deduped, source: clampText(body.source, 60) ?? 'landing' },
    });
  } catch (e) {
    console.error('event insert failed:', e);
  }

  return json(200, {
    ok: true,
    position: row.position,
    referral_code: row.referral_code,
    referral_url: LANDING ? referralUrl(LANDING, row.referral_code) : null,
    deduped,
    message: operatorLine(row.position, deduped),
  }, cors);
});
