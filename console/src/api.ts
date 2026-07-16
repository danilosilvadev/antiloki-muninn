// The console's ONLY data path: the muninn api on loopback. Never Supabase
// directly — one audit path, one policy chokepoint, no keys in this bundle.
const BASE = (import.meta.env.VITE_MUNINN_API as string | undefined) ?? 'http://127.0.0.1:41945/v1';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { headers: { 'content-type': 'application/json' }, ...init });
  } catch {
    throw new ApiError(0, 'api unreachable — is muninn running on 127.0.0.1:41945?');
  }
  const json = (await res.json().catch(() => null)) as { message?: string | string[] } | null;
  if (!res.ok) {
    const msg = Array.isArray(json?.message) ? json?.message.join('; ') : json?.message;
    throw new ApiError(res.status, msg ?? res.statusText);
  }
  return json as T;
}

export interface Health {
  ok: boolean;
  db: boolean;
  jobs: boolean;
  workers: boolean;
  telegram: boolean;
  degraded: string[];
}

export interface Stats {
  waitlist: { total: number; last7d: number; sparkline: number[] };
  pipeline: { byStatus: Record<string, number>; ingested24h: number };
  needsYou: {
    awaitingReview: number;
    remindersDue: { id: string; leadId: string; note: string; dueAt: string }[];
    parkedWithError: { leadId: string; error: string }[];
  };
  spend30d: { provider: string; totalUsd: number }[];
  activity: { at: string; kind: string; leadId: string | null; payload: unknown }[];
  slice3: { note: string };
  fitThreshold: number;
  calendlyUrl: string | null;
  workers: boolean;
  degraded: string[];
}

export interface LeadRow {
  id: string;
  linkedinUrl: string;
  status: string;
  source: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  fit: number | null;
  angle: string | null;
  icp: string | null;
  email: string | null;
  emailStatus: string | null;
  company: string | null;
}

export interface LeadView {
  lead: { id: string; linkedinUrl: string; status: string; source: string; geo: string | null; lastError: string | null };
  enrichment: { email: string | null; emailStatus: string | null; company: unknown; raw: unknown } | null;
  analysis: {
    fitScore: number;
    icp: string;
    angle: string | null;
    pains: { pain: string; evidence: string; source: string }[];
    hooks: { hook: string; evidence: string }[];
    briefMd: string;
    model: string;
  } | null;
  drafts: { id: string; step: number | null; channel: string; subject: string | null; bodyMd: string; status: string }[];
}

export interface TimelineItem {
  at: string;
  kind: string;
  detail: unknown;
}

export interface KeyStatus {
  name: string;
  group: 'core' | 'vendors' | 'telegram' | 'tuning';
  secret: boolean;
  hint: string;
  configured: boolean;
  value: string | null;
  length: number | null;
}

export interface SettingsView {
  keys: KeyStatus[];
  degraded: string[];
  db: boolean;
  workers: boolean;
  telegram: boolean;
}

export interface Suggestion {
  id: string;
  sourceLeadId: string;
  mode: string;
  name: string | null;
  title: string | null;
  company: string | null;
  linkedinUrl: string | null;
  state: string;
}

export interface ApproveResult {
  ok: boolean;
  code?: string;
  reason?: string;
  campaignId?: string;
  notes?: string[];
}

export interface AngleStat {
  angle: string;
  campaignId: string | null;
  paused: boolean;
  pushed: number;
  replied: number;
  positive: number;
}

export interface VendorStat {
  provider: string;
  configured: boolean;
  spend30dUsd: number;
  calls30d: number;
}

export interface TemplateRow {
  angle: string;
  delays: number[];
  edited: boolean;
  updatedAt: string | null;
}

export interface Control {
  pauseAll: boolean;
  healthPaused: { on: boolean; rates?: unknown; at?: string };
  sentToday: number;
  dailyCap: number;
  quietHours: string;
  utcOffset: number;
  geoBlocked: string;
  health: { sent: number; bounceRate: number | null; complaintRate: number | null };
  campaigns: { angle: string; campaignId: string }[];
  angles: AngleStat[];
  templates: TemplateRow[];
  vendors: VendorStat[];
  budget: { monthUsd: number; spentMonthUsd: number; note: string };
  suppressionsCount: number;
  refusals: { id: string; channel: string; code: string; reason: string; at: string; leadId: string | null }[];
  senderReady: boolean;
}

export interface Suppression {
  id: string;
  email: string | null;
  emailDomain: string | null;
  linkedinUrl: string | null;
  reason: string;
  at: string;
}

export interface StandingRow {
  id: string;
  email: string;
  name: string | null;
  position: number | null;
  referralCode: string;
  referrals: number;
  tier: number;
  effectiveRank: number;
  invitedAt: string | null;
  activatedAt: string | null;
  suppressed: boolean;
}

export interface WaveInvite {
  memberId: string | null;
  email: string | null;
  name: string | null;
  code: string;
  issuedAt: string;
  redeemedAt: string | null;
  activatedAt: string | null;
}

export interface WaveRow {
  wave: number;
  label: string | null;
  opensAt: string | null;
  size: number;
  issued: number;
  redeemed: number;
  activated: number;
  createdAt: string;
  invites: WaveInvite[];
}

export interface WaitlistView {
  totals: { members: number; last7d: number };
  funnel: {
    joined: number;
    referred: number;
    invited: number;
    redeemed: number;
    activated: number;
    referralVisits7d: number;
  };
  waves: WaveRow[];
  leaderboard: {
    memberId: string;
    email: string;
    name: string | null;
    referrals: number;
    tier: number;
    position: number | null;
    toNextJump: number;
  }[];
  consents: { email: number; whatsapp: number; telegram: number };
  referralsPerJump: number;
}

export interface IssueResult {
  wave: number;
  issued: { memberId: string; email: string; code: string; emailed: boolean }[];
  skipped: { memberId: string; email: string; reason: string }[];
  emailsSkippedReason: string | null;
  emailErrors: { email: string; error: string }[];
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  health: () => http<Health>('/health'),
  stats: () => http<Stats>('/stats'),

  settings: () => http<SettingsView>('/settings'),
  saveSettings: (values: Record<string, string>) =>
    http<{ ok: boolean; degraded: string[]; workersActive: boolean }>('/settings', {
      method: 'PUT',
      body: JSON.stringify({ values }),
    }),

  leads: (f: { status?: string; angle?: string; fitMin?: number; q?: string; limit?: number; offset?: number }) =>
    http<{ total: number; rows: LeadRow[] }>(`/leads${qs(f)}`),
  lead: (id: string) => http<LeadView>(`/leads/${id}`),
  timeline: (id: string) => http<{ items: TimelineItem[] }>(`/leads/${id}/timeline`),
  ingest: (linkedin_url: string) =>
    http<{ lead_id: string; status: string; existing: boolean }>('/leads', {
      method: 'POST',
      body: JSON.stringify({ linkedin_url, source: 'console' }),
    }),
  setStatus: (id: string, status: 'queued' | 'parked', note?: string) =>
    http<{ ok: boolean }>(`/leads/${id}/status`, { method: 'POST', body: JSON.stringify({ status, note }) }),
  bulkStatus: (ids: string[], status: 'queued' | 'parked') =>
    http<{ changed: number }>('/leads/bulk-status', { method: 'POST', body: JSON.stringify({ ids, status }) }),
  addNote: (id: string, note: string) =>
    http<{ ok: boolean }>(`/leads/${id}/notes`, { method: 'POST', body: JSON.stringify({ note }) }),
  addReminder: (id: string, note: string, due_at: string) =>
    http<{ id: string }>(`/leads/${id}/reminders`, { method: 'POST', body: JSON.stringify({ note, due_at }) }),
  reminderDone: (id: string) => http<{ ok: boolean }>(`/reminders/${id}/done`, { method: 'POST' }),
  editDraft: (id: string, patch: { subject?: string | null; body_md?: string }) =>
    http<{ ok: boolean; canSend: boolean; reason: string }>(`/messages/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  expand: (leadId: string, mode: 'colleagues' | 'lookalike') =>
    http<{ found: number; inserted: number }>(`/leads/${leadId}/expand`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  suggestions: (state = 'pending') => http<{ rows: Suggestion[] }>(`/suggestions?state=${state}`),
  acceptSuggestion: (id: string) =>
    http<{ ok: boolean; result: string }>(`/suggestions/${id}/accept`, { method: 'POST' }),
  dismissSuggestion: (id: string) => http<{ ok: boolean }>(`/suggestions/${id}/dismiss`, { method: 'POST' }),

  reviewQueue: () => http<{ total: number; items: LeadView[] }>('/review/queue'),
  approve: (id: string) => http<ApproveResult>(`/leads/${id}/approve`, { method: 'POST' }),
  reject: (id: string, reason: string) =>
    http<{ ok: boolean }>(`/leads/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
  markSent: (messageId: string) => http<{ ok: boolean }>(`/messages/${messageId}/mark-sent`, { method: 'POST' }),

  control: () => http<Control>('/control'),
  pauseAll: (on: boolean) =>
    http<{ ok: boolean; pauseAll: boolean }>('/control/pause-all', { method: 'POST', body: JSON.stringify({ on }) }),
  clearHealthPause: () => http<{ ok: boolean; note: string }>('/control/clear-health-pause', { method: 'POST' }),

  suppressions: (q?: string) => http<{ rows: Suppression[] }>(`/control/suppressions${qs({ q })}`),
  addSuppression: (body: { email?: string; email_domain?: string; linkedin_url?: string }) =>
    http<{ ok: boolean }>('/control/suppressions', { method: 'POST', body: JSON.stringify(body) }),
  saveTemplate: (angle: string, delays: number[]) =>
    http<{ ok: boolean; pushedToSmartlead: boolean; note: string }>(`/control/templates/${angle}`, {
      method: 'PUT',
      body: JSON.stringify({ delays }),
    }),
  anglePause: (angle: string, on: boolean) =>
    http<{ ok: boolean; campaignApplied: boolean; note: string | null }>(`/control/angles/${angle}/pause`, {
      method: 'POST',
      body: JSON.stringify({ on }),
    }),

  waitlist: () => http<WaitlistView>('/waitlist'),
  createWave: (size: number, opensAt?: string, label?: string) =>
    http<{ wave: number }>('/waitlist/waves', {
      method: 'POST',
      body: JSON.stringify({ size, opens_at: opensAt || undefined, label: label || undefined }),
    }),
  waveSelection: (wave: number) =>
    http<{ remaining: number; picks: StandingRow[] }>(`/waitlist/waves/${wave}/selection`),
  issueWave: (wave: number, memberIds?: string[]) =>
    http<IssueResult>(`/waitlist/waves/${wave}/issue`, {
      method: 'POST',
      body: JSON.stringify(memberIds ? { member_ids: memberIds } : {}),
    }),
  activateMember: (id: string) =>
    http<{ ok: boolean; already: boolean }>(`/waitlist/members/${id}/activate`, { method: 'POST' }),
};

export function slugName(url: string): string {
  const slug = url.slice(url.lastIndexOf('/') + 1);
  const parts = slug
    .split('-')
    .filter((p) => p && !/^\d+$/.test(p) && !/^[0-9a-f]{6,}$/i.test(p))
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1));
  return parts.join(' ') || slug;
}

export function fmtWhen(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}
