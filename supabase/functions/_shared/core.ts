// Pure, dependency-free logic shared by the slice-0 edge functions.
// Imported by Deno (Supabase Edge Functions) AND by Node 24's test runner via
// type stripping — keep it import-free and erasable-syntax-only (no enums).

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/; // same shape the landing validates client-side
export const MAX_EMAIL_LEN = 254;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LEN) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

export function clampText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

// The landing renders a visually-hidden "company" field humans never see or fill.
export function honeypotTripped(body: Record<string, unknown>): boolean {
  const v = body['company'];
  return typeof v === 'string' && v.trim().length > 0;
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'referrer'] as const;

export function pickUtm(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === null || typeof raw !== 'object') return out;
  for (const k of UTM_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 300);
  }
  return out;
}

// DB default mints substr(md5(...),1,8) → [0-9a-f]{8}; accept a tolerant superset.
export const REFERRAL_CODE_RE = /^[a-z0-9]{4,20}$/;

export function normalizeReferralCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toLowerCase();
  return REFERRAL_CODE_RE.test(code) ? code : null;
}

export function referralUrl(origin: string, code: string): string {
  return origin.replace(/\/+$/, '') + '/r/' + code;
}

export function operatorLine(position: number, deduped: boolean): string {
  return (deduped ? '✓ already in line — operator #' : '✓ operator #') + position +
    ' — share your link to skip the line';
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

// ── CORS ────────────────────────────────────────────────────────────────────
export function parseAllowedOrigins(env: string | undefined): string[] {
  return (env ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

export function corsHeadersFor(origin: string | null, allowed: string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin.replace(/\/+$/, ''))) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Vary': 'Origin',
  };
}

// ── crypto (Web Crypto — global in both Deno and Node ≥20) ──────────────────
const te = new TextEncoder();

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', te.encode(input));
  return hex(new Uint8Array(digest));
}

export function b64urlEncode(s: string): string {
  const bytes = te.encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

// Unsub tokens are stateless: hex HMAC-SHA256 over the normalized email.
// One secret (MUNINN_EDGE_SECRET), no per-recipient rows needed before sends exist.
export async function unsubToken(email: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, te.encode('unsub:' + email));
  return hex(new Uint8Array(sig));
}

export async function verifyUnsubToken(email: string, token: string, secret: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(token)) return false;
  const expected = await unsubToken(email, secret);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export function unsubUrl(functionsBase: string, email: string, token: string): string {
  return functionsBase.replace(/\/+$/, '') + '/unsub?e=' + b64urlEncode(email) + '&t=' + token;
}
