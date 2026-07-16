// webhook-sink (B3) — always-on. Smartlead posts here; rows wait in Postgres
// until the operator machine drains them. The machine-off guarantees live in
// THIS function: an unsubscribe/bounce/complaint writes its suppression row
// immediately — opt-out honored with zero operator-side moving parts.
//
// Auth: shared token in the URL (?t=...), compared against MUNINN_EDGE_SECRET.
// Smartlead's webhook UI takes a plain URL, so the token rides the query.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { emailDomain, mapSmartleadWebhook } from '../_shared/webhook-core.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);
const SECRET = Deno.env.get('MUNINN_EDGE_SECRET') ?? 'dev-secret-set-me';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const url = new URL(req.url);
  if (url.searchParams.get('t') !== SECRET) return new Response('bad token', { status: 401 });

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_json' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const mapped = mapSmartleadWebhook(payload);

  // best-effort lead resolution by prospect email
  let leadId: string | null = null;
  if (mapped.email) {
    const { data } = await supabase
      .from('lead_enrichments')
      .select('lead_id')
      .eq('email', mapped.email)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    leadId = (data?.lead_id as string | undefined) ?? null;
  }

  const { error } = await supabase.from('events').insert({
    lead_id: leadId,
    kind: mapped.kind,
    payload: {
      via: 'webhook-sink',
      email: mapped.email,
      sending_account: mapped.sendingAccount,
      campaign_id: mapped.campaignId,
      reply_text: mapped.replyText,
      raw: payload,
    },
  });
  if (error) {
    console.error('event insert failed:', error);
    return new Response(JSON.stringify({ ok: false }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  // the <1s opt-out: suppression lands here, not in the api
  if (mapped.suppress && mapped.email) {
    const existing = await supabase
      .from('suppressions')
      .select('id')
      .eq('email', mapped.email)
      .eq('reason', mapped.suppress)
      .maybeSingle();
    if (!existing.data) {
      const ins = await supabase.from('suppressions').insert({
        email: mapped.email,
        email_domain: emailDomain(mapped.email),
        reason: mapped.suppress,
      });
      if (ins.error) console.error('suppression insert failed:', ins.error);
    }
  }

  return new Response(JSON.stringify({ ok: true, kind: mapped.kind }), {
    headers: { 'content-type': 'application/json' },
  });
});
