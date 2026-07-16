// C5 · SendPolicy — the gate every send passes, pure and table-testable.
// "The system refuses, so you don't have to remember." Checks run in a fixed
// order; the FIRST failing check names the refusal. Every refusal carries a
// reason a human can read back later in the refusal log.
//
// Flag note (P5, tier 2): this file IS the anti-spam mechanism the plan
// promised — kill switch, suppression-first, consent-only messengers,
// geo blocks, the conversation ceiling, quiet hours, domain health.

export type RefusalCode =
  | 'pause_all'
  | 'suppressed'
  | 'no_consent'
  | 'geo_blocked'
  | 'not_ready'
  | 'daily_cap'
  | 'quiet_hours'
  | 'domain_health';

export interface PolicyInput {
  channel: 'email' | 'linkedin' | 'whatsapp' | 'telegram';
  pauseAll: boolean;
  suppressedEmail: boolean;
  suppressedLinkedin: boolean;
  hasConsent: boolean; // whatsapp/telegram only
  geo: string | null; // ISO-2, resolved from enrichment; null = unknown
  geoBlocked: string[];
  senderReady: boolean; // sending infra configured (email channel)
  sentToday: number;
  dailyCap: number;
  hourLocal: number; // 0-23, operator clock
  quietStart: number;
  quietEnd: number;
  bounceRate: number | null; // rolling 0-1; null = not enough data yet
  complaintRate: number | null;
}

export type PolicyVerdict =
  | { allowed: true; notes: string[] }
  | { allowed: false; code: RefusalCode; reason: string };

const BOUNCE_CEILING = 0.02; // 2% — pause the domain (Google's line is 0.3% complaints; we rest earlier)
const COMPLAINT_CEILING = 0.001; // 0.1%

// geos where legitimate-interest cold B2B email is workable but must stay
// role-relevant; allowed with a note the operator sees in the review queue
const CAREFUL_GEOS = ['FR', 'NL', 'ES', 'IT', 'PT', 'SE', 'DK', 'FI', 'NO', 'IE', 'BE', 'AT', 'PL', 'AU'];

export function evaluateSendPolicy(i: PolicyInput): PolicyVerdict {
  if (i.pauseAll) {
    return refuse('pause_all', 'pause-all is ON — the kill switch outranks everything');
  }
  if (i.suppressedEmail || i.suppressedLinkedin) {
    return refuse('suppressed', 'this person is on the suppression list — no channel may touch them');
  }
  if ((i.channel === 'whatsapp' || i.channel === 'telegram') && !i.hasConsent) {
    return refuse('no_consent', `${i.channel} is opt-in-only, globally — no consents row exists for this lead`);
  }
  if (i.channel === 'email' && i.geo && i.geoBlocked.includes(i.geo.toUpperCase())) {
    return refuse('geo_blocked', `cold email to ${i.geo.toUpperCase()} is blocked (UWG §7 / CASL posture) — LinkedIn-only geo`);
  }
  if (i.channel === 'email' && !i.senderReady) {
    return refuse('not_ready', 'no sending infrastructure configured — set SMARTLEAD_API_KEY in Settings');
  }
  if (i.channel === 'email' && i.sentToday >= i.dailyCap) {
    return refuse('daily_cap', `daily cap reached (${i.sentToday}/${i.dailyCap}) — the conversation ceiling, not the infra ceiling`);
  }
  if (i.channel === 'email' && inQuietHours(i.hourLocal, i.quietStart, i.quietEnd)) {
    return refuse('quiet_hours', `${i.hourLocal}:00 is inside quiet hours ${i.quietStart}:00–${i.quietEnd}:00`);
  }
  if (i.channel === 'email' && i.bounceRate != null && i.bounceRate > BOUNCE_CEILING) {
    return refuse('domain_health', `bounce rate ${(i.bounceRate * 100).toFixed(1)}% > ${BOUNCE_CEILING * 100}% — domains are resting`);
  }
  if (i.channel === 'email' && i.complaintRate != null && i.complaintRate >= COMPLAINT_CEILING) {
    return refuse('domain_health', `complaint rate ${(i.complaintRate * 100).toFixed(2)}% ≥ ${COMPLAINT_CEILING * 100}% — domains are resting`);
  }

  const notes: string[] = [];
  const geo = i.geo?.toUpperCase() ?? null;
  if (geo === 'GB' || geo === 'UK') {
    notes.push('UK: corporate subscribers only (PECR reg 22) — fine for Ltd/LLP employees, never sole traders');
  } else if (geo && CAREFUL_GEOS.includes(geo)) {
    notes.push(`${geo}: legitimate-interest regime — role-relevant messaging only, easy opt-out`);
  }
  return { allowed: true, notes };
}

function refuse(code: RefusalCode, reason: string): PolicyVerdict {
  return { allowed: false, code, reason };
}

export function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end; // wraps midnight, e.g. 20-8
}

export function parseQuietHours(s: string): { start: number; end: number } {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec((s ?? '').trim());
  if (!m) return { start: 20, end: 8 };
  return { start: Math.min(23, Number(m[1])), end: Math.min(23, Number(m[2])) };
}

export function hourInOffset(nowUtcMs: number, utcOffsetHours: number): number {
  return new Date(nowUtcMs + utcOffsetHours * 3_600_000).getUTCHours();
}

export function parseGeoBlocked(s: string): string[] {
  return (s ?? '')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
}

// Resolve an ISO-2 geo from whatever the enrichment vendor returned.
export function geoFromRaw(raw: unknown): string | null {
  const j = (raw ?? {}) as Record<string, unknown>;
  const datas = (Array.isArray(j['datas']) ? j['datas'] : []) as Record<string, unknown>[];
  const d = datas[0] ?? j;
  for (const src of [d, (d['company'] ?? {}) as Record<string, unknown>, (d['profile'] ?? {}) as Record<string, unknown>]) {
    for (const k of ['country_code', 'countryCode', 'country']) {
      const v = src[k];
      if (typeof v === 'string' && v.trim()) {
        const t = v.trim().toUpperCase();
        if (/^[A-Z]{2}$/.test(t)) return t;
        const byName = COUNTRY_NAMES[t];
        if (byName) return byName;
      }
    }
  }
  return null;
}

const COUNTRY_NAMES: Record<string, string> = {
  'UNITED STATES': 'US', 'USA': 'US', 'UNITED KINGDOM': 'GB', 'GREAT BRITAIN': 'GB',
  'GERMANY': 'DE', 'DEUTSCHLAND': 'DE', 'CANADA': 'CA', 'FRANCE': 'FR', 'NETHERLANDS': 'NL',
  'SPAIN': 'ES', 'ITALY': 'IT', 'PORTUGAL': 'PT', 'SWEDEN': 'SE', 'DENMARK': 'DK',
  'FINLAND': 'FI', 'NORWAY': 'NO', 'IRELAND': 'IE', 'BELGIUM': 'BE', 'AUSTRIA': 'AT',
  'POLAND': 'PL', 'AUSTRALIA': 'AU', 'BRAZIL': 'BR', 'BRASIL': 'BR',
};
