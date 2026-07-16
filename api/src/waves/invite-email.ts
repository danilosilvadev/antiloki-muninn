// The invite email (C10) — rendered here, sent via the Resend adapter on the
// canonical domain (consented path). Every link the email carries is built
// here too, including the unsub link: same HMAC contract as the edge
// functions' _shared/core.ts (hex HMAC-SHA256 over 'unsub:' + email), so the
// deployed unsub function honors tokens this file signs.
import { createHmac } from 'node:crypto';
import { escapeHtml } from '../telegram/dossier';

export function unsubTokenNode(email: string, secret: string): string {
  return createHmac('sha256', secret).update('unsub:' + email).digest('hex');
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unsubUrlNode(functionsBase: string, email: string, secret: string): string {
  return functionsBase.replace(/\/+$/, '') + '/unsub?e=' + b64url(email) + '&t=' + unsubTokenNode(email, secret);
}

export function redeemUrl(functionsBase: string, code: string): string {
  return functionsBase.replace(/\/+$/, '') + '/invite?c=' + code;
}

export interface InviteEmailInput {
  name: string | null;
  email: string;
  position: number | null;
  code: string;
  wave: number;
  opensAt: Date | null;
  redeemUrl: string;
  unsubUrl: string | null;
  postalLine: string | null;
}

export function renderInviteEmail(i: InviteEmailInput): { subject: string; html: string; text: string } {
  const who = i.name ? i.name.split(/\s+/)[0] : i.position != null ? `operator #${i.position}` : 'operator';
  const opens = i.opensAt
    ? i.opensAt.toISOString().slice(0, 10)
    : null;
  const waveLine = opens ? `wave ${i.wave} · opens ${opens}` : `wave ${i.wave} · open now`;
  const subject = i.position != null
    ? `your antiloki seat is open — operator #${i.position}`
    : 'your antiloki seat is open';

  const text = [
    `${who} —`,
    '',
    `you're in. ${waveLine}.`,
    '',
    `your invite code: ${i.code}`,
    `claim your seat: ${i.redeemUrl}`,
    '',
    `clicking marks your code redeemed; I'll reach out the same day to point antiloki at your repo and watch your architecture appear.`,
    '',
    `— Danilo, antiloki`,
    ...(i.unsubUrl ? ['', `unsubscribe: ${i.unsubUrl}`] : []),
    ...(i.postalLine ? [i.postalLine] : []),
  ].join('\n');

  const html = [
    `<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:1.6;color:#1a1a1a;max-width:560px">`,
    `<p>${escapeHtml(who)} —</p>`,
    `<p>you're in. <b>${escapeHtml(waveLine)}</b>.</p>`,
    `<p>your invite code:</p>`,
    `<p style="font-size:18px;letter-spacing:2px;background:#f4f2ee;border:1px solid #ddd;border-radius:8px;padding:12px 16px;display:inline-block"><b>${escapeHtml(i.code)}</b></p>`,
    `<p><a href="${escapeHtml(i.redeemUrl)}" style="color:#e05e2b;font-weight:600">claim your seat →</a></p>`,
    `<p>clicking marks your code redeemed; I'll reach out the same day to point antiloki at your repo and watch your architecture appear.</p>`,
    `<p>— Danilo, antiloki</p>`,
    `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px">`,
    `<p style="font-size:11px;color:#888">${
      [
        i.unsubUrl ? `<a href="${escapeHtml(i.unsubUrl)}" style="color:#888">unsubscribe</a>` : '',
        i.postalLine ? escapeHtml(i.postalLine) : '',
      ].filter(Boolean).join(' · ')
    }</p>`,
    `</div>`,
  ].join('\n');

  return { subject, html, text };
}
