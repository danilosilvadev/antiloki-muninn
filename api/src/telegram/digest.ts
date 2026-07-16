// The daily digest (C11 arrives fully in slice 4; this is the slice-1 v0):
// pipeline counts + vendor spend, rendered for Telegram HTML.
import { count, gte, sql, sum } from 'drizzle-orm';
import type { Db } from '../db/db';
import * as t from '../db/schema';

export async function buildDigest(db: Db): Promise<string> {
  const since24h = new Date(Date.now() - 24 * 3600_000);
  const since30d = new Date(Date.now() - 30 * 24 * 3600_000);

  const byStatus = await db.select({ status: t.leads.status, n: count() }).from(t.leads).groupBy(t.leads.status);
  const recent = await db
    .select({ n: count() })
    .from(t.leads)
    .where(gte(t.leads.createdAt, since24h));
  const spend = await db
    .select({ provider: t.vendorCalls.provider, total: sum(t.vendorCalls.costUsd) })
    .from(t.vendorCalls)
    .where(gte(t.vendorCalls.at, since30d))
    .groupBy(t.vendorCalls.provider);
  const waitlist = await db.select({ n: count() }).from(t.waitlistMembers);

  const statusLine = byStatus
    .sort((a, b) => Number(b.n) - Number(a.n))
    .map((r) => `${r.status} ${r.n}`)
    .join(' · ');
  const spendLine =
    spend
      .map((r) => `${r.provider} $${Number(r.total ?? 0).toFixed(2)}`)
      .join(' · ') || 'nothing spent yet';

  return [
    '🐦 <b>muninn digest</b>',
    `pipeline: ${statusLine || 'empty — feed me a linkedin url'}`,
    `last 24h: ${recent[0]?.n ?? 0} ingested`,
    `waitlist: ${waitlist[0]?.n ?? 0} members`,
    `vendor spend (30d): ${spendLine}`,
  ].join('\n');
}

// tiny helper kept next to the digest so slice-4's targets version reuses it
export function usd(n: unknown): string {
  return '$' + Number(n ?? 0).toFixed(2);
}
export const _sql = sql; // re-export keeps drizzle's sql import treeshake-safe if unused elsewhere
