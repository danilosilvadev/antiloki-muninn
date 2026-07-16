// r — the referral link target (B3): logs the visit into the audit chain,
// then bounces to the landing with ?ref=<code> so the join attributes itself.
// GET /r?c=<code>  or  /r/<code>  → 302 LANDING_URL/?ref=<code>
import { createClient } from 'npm:@supabase/supabase-js@2';
import { normalizeReferralCode, sha256Hex } from '../_shared/core.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);
const LANDING = (Deno.env.get('LANDING_URL') ?? '').replace(/\/+$/, '');
const SECRET = Deno.env.get('MUNINN_EDGE_SECRET') ?? 'dev-secret-set-me';

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean); // ["r"] or ["r", "<code>"]
  const fromPath = parts.length > 1 ? parts[parts.length - 1] : null;
  const code = normalizeReferralCode(url.searchParams.get('c') ?? fromPath);

  if (code) {
    try {
      const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
      const { data } = await supabase
        .from('waitlist_members')
        .select('id')
        .eq('referral_code', code)
        .maybeSingle();
      await supabase.from('events').insert({
        kind: 'referral_visit',
        payload: { code, known: Boolean(data), ip_hash: await sha256Hex('ip:' + SECRET + ':' + ip) },
      });
    } catch (e) {
      console.error('referral_visit log failed:', e);
    }
  }

  if (!LANDING) return new Response('LANDING_URL not configured', { status: 500 });
  return new Response(null, {
    status: 302,
    headers: { location: LANDING + (code ? '/?ref=' + code : '/') },
  });
});
