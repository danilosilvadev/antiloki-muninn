// invite — the invite-email link target (C10): stamps the code redeemed on
// first click (later clicks change nothing), logs the event, and lands the
// person on the manual — the "start here" doc. Activation stays a separate,
// operator-confirmed step in the console; a click is interest, not usage.
// GET /invite?c=<code>  or  /invite/<code>
//  → 302 LANDING/antiloki-manual.html?welcome=1   (known code)
//  → 302 LANDING/                                  (unknown code)
import { createClient } from 'npm:@supabase/supabase-js@2';
import { normalizeReferralCode } from '../_shared/core.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);
const LANDING = (Deno.env.get('LANDING_URL') ?? '').replace(/\/+$/, '');

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean); // ["invite"] or ["invite", "<code>"]
  const fromPath = parts.length > 1 ? parts[parts.length - 1] : null;
  // invite codes are 8-hex minted by the api — same tolerant shape as referral codes
  const code = normalizeReferralCode(url.searchParams.get('c') ?? fromPath);

  let known = false;
  if (code) {
    try {
      const { data } = await supabase
        .from('invites')
        .select('id, wave, redeemed_at')
        .eq('code', code)
        .maybeSingle();
      if (data) {
        known = true;
        const first = !data.redeemed_at;
        if (first) {
          await supabase.from('invites').update({ redeemed_at: new Date().toISOString() }).eq('id', data.id);
        }
        await supabase.from('events').insert({
          kind: 'invite_redeemed',
          payload: { code, wave: data.wave, first },
        });
      }
    } catch (e) {
      console.error('invite redeem failed (redirecting anyway):', e);
    }
  }

  if (!LANDING) return new Response('LANDING_URL not configured', { status: 500 });
  return new Response(null, {
    status: 302,
    headers: { location: known ? LANDING + '/antiloki-manual.html?welcome=1' : LANDING + '/' },
  });
});
