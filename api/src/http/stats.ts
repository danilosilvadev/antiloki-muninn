// The dashboard's data (D5): KPIs, needs-you, pipeline funnel, activity,
// spend. One query bundle, honest empties — anything slice 3 owns (sends,
// replies, domain health) is reported as not-yet-live rather than zeroed lies.
import { and, count, desc, gte, isNull, lte, sum } from 'drizzle-orm';
import type { Db } from '../db/db';
import * as t from '../db/schema';

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
  slice3: { sends: null; replies: null; domainHealth: null; note: string };
}

export async function buildStats(db: Db): Promise<Stats> {
  const now = Date.now();
  const d1 = new Date(now - 24 * 3600_000);
  const d7 = new Date(now - 7 * 24 * 3600_000);
  const d30 = new Date(now - 30 * 24 * 3600_000);

  const [wlTotal] = await db.select({ n: count() }).from(t.waitlistMembers);
  const wlRecent = await db
    .select({ createdAt: t.waitlistMembers.createdAt })
    .from(t.waitlistMembers)
    .where(gte(t.waitlistMembers.createdAt, d7));
  const sparkline = new Array(7).fill(0);
  for (const r of wlRecent) {
    const day = Math.min(6, Math.max(0, Math.floor((now - r.createdAt.getTime()) / 86_400_000)));
    sparkline[6 - day]++;
  }

  const statusRows = await db.select({ status: t.leads.status, n: count() }).from(t.leads).groupBy(t.leads.status);
  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status] = Number(r.n);
  const [ingested24] = await db.select({ n: count() }).from(t.leads).where(gte(t.leads.createdAt, d1));

  const remindersDue = await db
    .select()
    .from(t.reminders)
    .where(and(isNull(t.reminders.doneAt), lte(t.reminders.dueAt, new Date(now))))
    .orderBy(t.reminders.dueAt)
    .limit(10);

  const parkedErr = await db
    .select({ id: t.leads.id, lastError: t.leads.lastError, updatedAt: t.leads.updatedAt })
    .from(t.leads)
    .where(and(gte(t.leads.updatedAt, d7)))
    .orderBy(desc(t.leads.updatedAt))
    .limit(50);

  const spendRows = await db
    .select({ provider: t.vendorCalls.provider, total: sum(t.vendorCalls.costUsd) })
    .from(t.vendorCalls)
    .where(gte(t.vendorCalls.at, d30))
    .groupBy(t.vendorCalls.provider);

  const activity = await db.select().from(t.events).orderBy(desc(t.events.at)).limit(20);

  return {
    waitlist: { total: Number(wlTotal?.n ?? 0), last7d: wlRecent.length, sparkline },
    pipeline: { byStatus, ingested24h: Number(ingested24?.n ?? 0) },
    needsYou: {
      awaitingReview: byStatus['analyzed'] ?? 0,
      remindersDue: remindersDue.map((r) => ({
        id: r.id,
        leadId: r.leadId,
        note: r.note,
        dueAt: r.dueAt.toISOString(),
      })),
      parkedWithError: parkedErr
        .filter((l) => l.lastError)
        .slice(0, 5)
        .map((l) => ({ leadId: l.id, error: l.lastError! })),
    },
    spend30d: spendRows.map((r) => ({ provider: r.provider, totalUsd: Number(r.total ?? 0) })),
    activity: activity.map((e) => ({
      at: e.at.toISOString(),
      kind: e.kind,
      leadId: e.leadId,
      payload: e.payload,
    })),
    slice3: {
      sends: null,
      replies: null,
      domainHealth: null,
      note: 'sends, replies and domain health arrive with slice 3 (SendPolicy + Smartlead + webhooks)',
    },
  };
}
