// The daily digest (slice-1 v0) + the weekly targets digest (C11, slice 4):
// pipeline counts + vendor spend, rendered for Telegram HTML. The weekly
// version measures the machine against its targets — reply rate and
// cost-per-positive — and doubles as the operator email body.
import { and, count, eq, gte, sql, sum } from 'drizzle-orm';
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

export interface WeeklyTargets {
  costPerPositive: number; // ≤ this is on-target
  replyPct: number;        // ≥ this is on-target
}

// C11 — the weekly digest, measured against targets. One render feeds both
// Telegram (HTML subset) and the operator email (same tags are valid HTML).
export async function buildWeeklyDigest(
  db: Db,
  targets: WeeklyTargets,
): Promise<{ subject: string; html: string }> {
  const d7 = new Date(Date.now() - 7 * 24 * 3_600_000);

  const evRows = await db
    .select({ kind: t.events.kind, n: count() })
    .from(t.events)
    .where(gte(t.events.at, d7))
    .groupBy(t.events.kind);
  const ev: Record<string, number> = {};
  for (const r of evRows) ev[r.kind] = Number(r.n);

  const [positives] = await db
    .select({ n: count() })
    .from(t.events)
    .where(and(
      eq(t.events.kind, 'reply_labeled'),
      gte(t.events.at, d7),
      sql`${t.events.payload}->>'label' = 'positive'`,
    ));

  const [meetings] = await db.select({ n: count() }).from(t.leads).where(eq(t.leads.status, 'call'));
  const [spend7] = await db
    .select({ total: sum(t.vendorCalls.costUsd) })
    .from(t.vendorCalls)
    .where(gte(t.vendorCalls.at, d7));
  const [wlTotal] = await db.select({ n: count() }).from(t.waitlistMembers);
  const [wl7] = await db
    .select({ n: count() })
    .from(t.waitlistMembers)
    .where(gte(t.waitlistMembers.createdAt, d7));

  const sent = ev['sent'] ?? 0;
  const replies = ev['reply'] ?? 0;
  const pos = Number(positives?.n ?? 0);
  const spend = Number(spend7?.total ?? 0);

  const replyPct = sent > 0 ? (replies / sent) * 100 : null;
  const cpp = pos > 0 ? spend / pos : null;
  const replyMark = replyPct == null ? '' : replyPct >= targets.replyPct ? ' ✓' : ' ▼';
  const cppMark = cpp == null ? '' : cpp <= targets.costPerPositive ? ' ✓' : ' ▲';

  const html = [
    '📬 <b>muninn weekly</b> — last 7 days vs targets',
    `sent <b>${sent}</b> · replies <b>${replies}</b>` +
      (replyPct == null ? ' (rate — · no sends yet)' : ` (${replyPct.toFixed(1)}%${replyMark} target ≥ ${targets.replyPct}%)`),
    `positive <b>${pos}</b> · meetings booked <b>${Number(meetings?.n ?? 0)}</b>`,
    `spend ${usd(spend)} · cost/positive ` +
      (cpp == null ? '— (no positives yet)' : `<b>${usd(cpp)}</b>${cppMark} (target ≤ ${usd(targets.costPerPositive)})`),
    `waitlist +${Number(wl7?.n ?? 0)} (total ${Number(wlTotal?.n ?? 0)}) · referral visits ${ev['referral_visit'] ?? 0}`,
    `pushes ${ev['sequence_pushed'] ?? 0} · unsubs ${ev['unsub'] ?? 0} · bounces ${ev['bounce'] ?? 0} · complaints ${ev['complaint'] ?? 0}`,
  ].join('\n');

  return { subject: 'muninn weekly — the loop, measured', html };
}
