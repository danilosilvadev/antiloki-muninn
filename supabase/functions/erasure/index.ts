// erasure — the public data-subject request endpoint (G1). Two-layer design,
// same spirit as the webhook sink: the EDGE acts instantly with the operator
// machine off (suppress the email so nothing new is ever sent), and the api
// drains the request into an operator notification. The DELETION itself is
// executed by the operator after a human identity check — an unauthenticated
// endpoint must never let anyone erase anyone.
// POST { email, company? (honeypot) } → { ok, message } (same answer whether
// the email is known or not — no membership oracle).
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  corsHeadersFor, honeypotTripped, normalizeEmail, parseAllowedOrigins, sha256Hex,
} from '../_shared/core.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);
const ALLOWED = parseAllowedOrigins(Deno.env.get('ALLOWED_ORIGINS'));
const SECRET = Deno.env.get('MUNINN_EDGE_SECRET') ?? 'dev-secret-set-me';
const RATE_LIMIT = Number(Deno.env.get('RATE_LIMIT_PER_HOUR') ?? '20');

const ACK = 'request received — sending to this address stops now; deletion completes after a manual identity check.';

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
  if (honeypotTripped(body)) return json(200, { ok: true, message: ACK }, cors);

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const ipHash = await sha256Hex('ip:' + SECRET + ':' + ip);

  // Same fails-open rate-limit pattern as the other public functions.
  try {
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const { count, error } = await supabase
      .from('events')
      .select('id', { count: 'exact', head: true })
      .eq('kind', 'erasure_requested')
      .gte('at', oneHourAgo)
      .eq('payload->>ip_hash', ipHash);
    if (!error && (count ?? 0) >= RATE_LIMIT) {
      return json(429, { ok: false, error: 'rate_limited' }, cors);
    }
  } catch (e) {
    console.error('rate-limit check failed (failing open):', e);
  }

  // Layer 1 — act now, machine off: suppress the address (idempotent).
  try {
    const existing = await supabase
      .from('suppressions')
      .select('id')
      .eq('email', email)
      .eq('reason', 'erasure_request')
      .maybeSingle();
    if (!existing.data) {
      await supabase.from('suppressions').insert({ email, reason: 'erasure_request' });
    }
  } catch (e) {
    console.error('suppression insert failed:', e);
  }

  // Layer 2 — file the request; the api tick turns it into an operator ping.
  try {
    await supabase.from('events').insert({
      kind: 'erasure_requested',
      payload: { email, ip_hash: ipHash },
    });
  } catch (e) {
    console.error('event insert failed:', e);
    return json(500, { ok: false, error: 'request_failed' }, cors);
  }

  return json(200, { ok: true, message: ACK }, cors);
});
