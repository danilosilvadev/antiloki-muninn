// G2 — retention limits, on a clock: (1) un-engaged leads purge entirely
// after N days via the erasure cascade WITHOUT tombstones — an aged-out lead
// may legitimately come back; (2) raw vendor payloads (the PII-densest rows)
// expire after M days, keeping only the distilled columns the machine
// actually uses. Engaged leads — anything that ever reached a sequence or a
// human conversation — are never touched by the clock.
import { and, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/db';
import * as t from '../db/schema';
import { ErasureService } from './erasure.service';

// never entered a sequence, never replied — the cold dossiers
const UNENGAGED_STATUSES = ['new', 'enriched', 'analyzed', 'parked'];

export interface RetentionCfg {
  leadDays: number; // purge un-engaged leads older than this (0 disables)
  rawDays: number;  // expire raw vendor payloads older than this (0 disables)
}

export async function runRetention(
  db: Db,
  erasure: ErasureService,
  cfg: RetentionCfg,
  notify: (html: string) => Promise<void>,
): Promise<{ purgedLeads: number; expiredRaws: number }> {
  let purgedLeads = 0;
  let expiredRaws = 0;

  if (cfg.leadDays > 0) {
    const cutoff = new Date(Date.now() - cfg.leadDays * 24 * 3_600_000);
    const stale = await db
      .select({ id: t.leads.id })
      .from(t.leads)
      .where(and(inArray(t.leads.status, UNENGAGED_STATUSES), lt(t.leads.updatedAt, cutoff)))
      .limit(200); // one tick's worth — the daily cron drains the rest
    const rows: Record<string, number> = {};
    for (const l of stale) {
      await erasure.purgeLeadRows(l.id, rows);
      purgedLeads++;
    }
  }

  if (cfg.rawDays > 0) {
    const cutoff = new Date(Date.now() - cfg.rawDays * 24 * 3_600_000);
    const expiredAt = new Date().toISOString();
    expiredRaws += (
      await db
        .update(t.leadEnrichments)
        .set({ raw: { expired: true, expired_at: expiredAt } })
        .where(and(lt(t.leadEnrichments.createdAt, cutoff), isNull(sql`${t.leadEnrichments.raw}->>'expired'`)))
        .returning({ id: t.leadEnrichments.id })
    ).length;
    expiredRaws += (
      await db
        .update(t.leadSuggestions)
        .set({ raw: { expired: true, expired_at: expiredAt } })
        .where(and(lt(t.leadSuggestions.createdAt, cutoff), isNull(sql`${t.leadSuggestions.raw}->>'expired'`)))
        .returning({ id: t.leadSuggestions.id })
    ).length;
  }

  if (purgedLeads > 0 || expiredRaws > 0) {
    await db.insert(t.events).values({
      kind: 'retention_run',
      payload: { purged_leads: purgedLeads, expired_raws: expiredRaws, lead_days: cfg.leadDays, raw_days: cfg.rawDays },
    });
    await notify(
      `🧹 <b>retention</b> — purged ${purgedLeads} un-engaged lead(s) older than ${cfg.leadDays}d, ` +
        `expired ${expiredRaws} raw payload(s) older than ${cfg.rawDays}d.`,
    );
  }
  return { purgedLeads, expiredRaws };
}
