// D8 — CSV/JSON export: your data leaves whenever you ask. Flat rows, fixed
// column order, RFC-4180 quoting — the boring shape every spreadsheet opens.
import { desc, inArray } from 'drizzle-orm';
import type { Db } from '../db/db';
import * as t from '../db/schema';

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown): string => {
    if (v == null) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

export const LEAD_COLUMNS = [
  'id', 'linkedin_url', 'status', 'source', 'geo', 'email', 'email_status',
  'company', 'fit', 'angle', 'icp', 'last_error', 'created_at', 'updated_at',
];

export async function exportLeads(db: Db): Promise<Record<string, unknown>[]> {
  const leads = await db.select().from(t.leads).orderBy(desc(t.leads.createdAt)).limit(10_000);
  const ids = leads.map((l) => l.id);
  const analyses = ids.length
    ? await db.select().from(t.leadAnalyses).where(inArray(t.leadAnalyses.leadId, ids)).orderBy(desc(t.leadAnalyses.createdAt))
    : [];
  const enrichments = ids.length
    ? await db.select().from(t.leadEnrichments).where(inArray(t.leadEnrichments.leadId, ids)).orderBy(desc(t.leadEnrichments.createdAt))
    : [];
  const aBy = new Map<string, (typeof analyses)[number]>();
  for (const a of analyses) if (!aBy.has(a.leadId)) aBy.set(a.leadId, a);
  const eBy = new Map<string, (typeof enrichments)[number]>();
  for (const e of enrichments) if (!eBy.has(e.leadId)) eBy.set(e.leadId, e);

  return leads.map((l) => {
    const a = aBy.get(l.id) ?? null;
    const e = eBy.get(l.id) ?? null;
    const company = (e?.company ?? {}) as Record<string, unknown>;
    return {
      id: l.id,
      linkedin_url: l.linkedinUrl,
      status: l.status,
      source: l.source,
      geo: l.geo,
      email: e?.email ?? null,
      email_status: e?.emailStatus ?? null,
      company: typeof company['name'] === 'string' ? company['name'] : null,
      fit: a?.fitScore ?? null,
      angle: a?.angle ?? null,
      icp: a?.icp ?? null,
      last_error: l.lastError,
      created_at: l.createdAt,
      updated_at: l.updatedAt,
    };
  });
}

export const WAITLIST_COLUMNS = [
  'email', 'name', 'position', 'referral_code', 'referred_by', 'source',
  'invited_at', 'activated_at', 'created_at',
];

export async function exportWaitlist(db: Db): Promise<Record<string, unknown>[]> {
  const members = await db.select().from(t.waitlistMembers).orderBy(t.waitlistMembers.position).limit(10_000);
  return members.map((m) => ({
    email: m.email,
    name: m.name,
    position: m.position,
    referral_code: m.referralCode,
    referred_by: m.referredBy,
    source: m.source,
    invited_at: m.invitedAt,
    activated_at: m.activatedAt,
    created_at: m.createdAt,
  }));
}
