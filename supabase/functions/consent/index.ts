// consent — the thank-you page's opt-in write path (A8, P6 discipline): a
// person who just joined volunteers a WhatsApp number or Telegram handle so
// their invite can reach them there too. Opt-in ONLY — a row here is created
// by the person themself; no cold WhatsApp/Telegram exists anywhere.
// POST { email, channel, handle, company? (honeypot) }
//  → { ok, channel, handle }
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  corsHeadersFor, honeypotTripped, normalizeConsentChannel, normalizeEmail,
  normalizeHandle, parseAllowedOrigins, sha256Hex,
} from '../_shared/core.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);
const ALLOWED = parseAllowedOrigins(Deno.env.get('ALLOWED_ORIGINS'));
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
  const channel = normalizeConsentChannel(body.channel);
  const handle = channel ? normalizeHandle(channel, body.handle) : null;
  if (!email) return json(400, { ok: false, error: 'invalid_email' }, cors);
  if (!channel) return json(400, { ok: false, error: 'invalid_channel' }, cors);
  if (!handle) return json(400, { ok: false, error: 'invalid_handle' }, cors);

  // Bots that fill the hidden field get a success-shaped answer and no row.
  if (honeypotTripped(body)) return json(200, { ok: true, channel, handle }, cors);

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const ipHash = await sha256Hex('ip:' + SECRET + ':' + ip);

  // Same fails-open rate-limit pattern as waitlist-join, over consent events.
  try {
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const { count, error } = await supabase
      .from('events')
      .select('id', { count: 'exact', head: true })
      .eq('kind', 'consent_granted')
      .gte('at', oneHourAgo)
      .eq('payload->>ip_hash', ipHash);
    if (!error && (count ?? 0) >= RATE_LIMIT) {
      return json(429, { ok: false, error: 'rate_limited' }, cors);
    }
  } catch (e) {
    console.error('rate-limit check failed (failing open):', e);
  }

  // The gate: consent attaches only to an email that actually joined.
  const member = await supabase
    .from('waitlist_members')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  if (member.error) return json(500, { ok: false, error: 'lookup_failed' }, cors);
  if (!member.data) return json(404, { ok: false, error: 'not_on_waitlist' }, cors);

  // One row per (email, channel): re-posting updates the handle.
  const existing = await supabase
    .from('consents')
    .select('id')
    .eq('email', email)
    .eq('channel', channel)
    .maybeSingle();
  if (existing.error) return json(500, { ok: false, error: 'lookup_failed' }, cors);

  const now = new Date().toISOString();
  const write = existing.data
    ? await supabase.from('consents').update({ handle, granted_at: now, source: 'thank-you' }).eq('id', existing.data.id)
    : await supabase.from('consents').insert({ email, channel, handle, granted_at: now, source: 'thank-you' });
  if (write.error) return json(500, { ok: false, error: 'write_failed' }, cors);

  // Audit row — best effort, never fails the grant.
  try {
    await supabase.from('events').insert({
      kind: 'consent_granted',
      payload: { channel, ip_hash: ipHash, updated: Boolean(existing.data) },
    });
  } catch (e) {
    console.error('event insert failed:', e);
  }

  return json(200, { ok: true, channel, handle }, cors);
});
