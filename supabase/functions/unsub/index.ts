// unsub — the always-on unsubscribe endpoint (B3). Works with the operator
// machine off: writes the suppression directly, no muninn api involved.
// GET /unsub?e=<b64url(email)>&t=<hmac>   (POST {e,t} also accepted)
// Token = HMAC-SHA256("unsub:"+email, MUNINN_EDGE_SECRET) — stateless, so links
// can be minted for any recipient before any per-recipient state exists.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { b64urlDecode, escapeHtml, normalizeEmail, verifyUnsubToken } from '../_shared/core.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);
const SECRET = Deno.env.get('MUNINN_EDGE_SECRET') ?? 'dev-secret-set-me';

function page(status: number, title: string, line: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${title}</title>` +
    `<style>body{background:#0E0D0B;color:#EDE8E0;font-family:ui-monospace,Consolas,monospace;` +
    `display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}` +
    `main{max-width:52ch}h1{font-size:18px;letter-spacing:-.01em}` +
    `p{color:#8C8378;font-size:13.5px;line-height:1.7}b{color:#4ADE80}</style></head>` +
    `<body><main><h1>antiloki<span style="color:#E8623A">.</span></h1><p>${line}</p></main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  let e = url.searchParams.get('e');
  let t = url.searchParams.get('t');
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      if (typeof body.e === 'string') e = body.e;
      if (typeof body.t === 'string') t = body.t;
    } catch { /* fall through to whatever the query string had */ }
  }

  const email = normalizeEmail(e ? b64urlDecode(e) : null);
  if (!email || !t || !(await verifyUnsubToken(email, t, SECRET))) {
    return page(400, 'invalid link',
      'This unsubscribe link is invalid or incomplete. Reply to any email from us and a human will remove you.');
  }

  const existing = await supabase
    .from('suppressions')
    .select('id')
    .eq('email', email)
    .eq('reason', 'unsub')
    .maybeSingle();

  if (!existing.data) {
    const ins = await supabase.from('suppressions').insert({
      email,
      email_domain: email.split('@')[1] ?? null,
      reason: 'unsub',
    });
    if (ins.error) {
      console.error('suppression insert failed:', ins.error);
      return page(500, 'error',
        'Something failed on our side. Reply to any email from us and a human will remove you.');
    }
    try {
      await supabase.from('events').insert({
        kind: 'unsub',
        payload: { email_domain: email.split('@')[1] ?? null },
      });
    } catch { /* best effort */ }
  }

  return page(200, 'unsubscribed',
    `<b>Done.</b> ${escapeHtml(email)} is on the suppression list — antiloki will not email it again.`);
});
