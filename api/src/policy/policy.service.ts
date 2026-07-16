// Gathers the PolicyInput from reality (DB + config), runs the pure gate,
// and logs every refusal into policy_refusals — the log D6 reads.
import { and, count, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/db';
import * as t from '../db/schema';
import {
  evaluateSendPolicy, hourInOffset, parseGeoBlocked, parseQuietHours,
  type PolicyVerdict,
} from './send-policy';

export interface PolicyConfig {
  dailyCap: number;
  quietHours: string;
  utcOffset: number;
  geoBlocked: string;
  senderReady: boolean;
}

export const FLAG_PAUSE_ALL = 'pause_all';
export const FLAG_PAUSE_APPLIED = 'pause_all_applied';
export const FLAG_HEALTH_PAUSED = 'domain_health_paused';
export const FLAG_ANGLE_PAUSED = 'angle_paused'; // { [angle]: true } — operator-paused angles

export class PolicyService {
  constructor(
    private readonly db: Db,
    private readonly cfg: PolicyConfig,
  ) {}

  async getFlag<T>(key: string, fallback: T): Promise<T> {
    const [row] = await this.db.select().from(t.opsFlags).where(eq(t.opsFlags.key, key)).limit(1);
    return row ? (row.value as T) : fallback;
  }

  async setFlag(key: string, value: unknown): Promise<void> {
    const existing = await this.db.select({ key: t.opsFlags.key }).from(t.opsFlags).where(eq(t.opsFlags.key, key)).limit(1);
    if (existing.length > 0) {
      await this.db.update(t.opsFlags).set({ value, updatedAt: new Date() }).where(eq(t.opsFlags.key, key));
    } else {
      await this.db.insert(t.opsFlags).values({ key, value });
    }
  }

  // Rolling 7-day health across all sending accounts. Below 20 sends the
  // rates are statistical noise — reported as null (not enough data).
  async healthRates(): Promise<{ sent: number; bounceRate: number | null; complaintRate: number | null }> {
    const since = new Date(Date.now() - 7 * 24 * 3_600_000);
    const rows = await this.db
      .select({ kind: t.events.kind, n: count() })
      .from(t.events)
      .where(and(gte(t.events.at, since), inArray(t.events.kind, ['sent', 'bounce', 'complaint'])))
      .groupBy(t.events.kind);
    const by: Record<string, number> = {};
    for (const r of rows) by[r.kind] = Number(r.n);
    const sent = by['sent'] ?? 0;
    if (sent < 20) return { sent, bounceRate: null, complaintRate: null };
    return { sent, bounceRate: (by['bounce'] ?? 0) / sent, complaintRate: (by['complaint'] ?? 0) / sent };
  }

  async pushesToday(): Promise<number> {
    // "today" on the operator clock: midnight in the configured offset
    const nowLocal = new Date(Date.now() + this.cfg.utcOffset * 3_600_000);
    const midnightUtcMs = Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate()) - this.cfg.utcOffset * 3_600_000;
    const [row] = await this.db
      .select({ n: count() })
      .from(t.events)
      .where(and(eq(t.events.kind, 'sequence_pushed'), gte(t.events.at, new Date(midnightUtcMs))));
    return Number(row?.n ?? 0);
  }

  async check(
    lead: { id: string; linkedinUrl: string; geo: string | null },
    channel: 'email' | 'linkedin' | 'whatsapp' | 'telegram',
    opts: { email?: string | null; messageId?: string } = {},
  ): Promise<PolicyVerdict> {
    const [pauseAll, health, sentToday] = await Promise.all([
      this.getFlag<boolean>(FLAG_PAUSE_ALL, false),
      this.healthRates(),
      this.pushesToday(),
    ]);
    const healthPaused = await this.getFlag<{ on?: boolean }>(FLAG_HEALTH_PAUSED, {});

    let suppressedEmail = false;
    if (opts.email) {
      const hit = await this.db
        .select({ id: t.suppressions.id })
        .from(t.suppressions)
        .where(eq(t.suppressions.email, opts.email.toLowerCase()))
        .limit(1);
      suppressedEmail = hit.length > 0;
    }
    const linkHit = await this.db
      .select({ id: t.suppressions.id })
      .from(t.suppressions)
      .where(eq(t.suppressions.linkedinUrl, lead.linkedinUrl))
      .limit(1);

    let hasConsent = true;
    if (channel === 'whatsapp' || channel === 'telegram') {
      const consent = await this.db
        .select({ id: t.consents.id })
        .from(t.consents)
        .where(and(eq(t.consents.leadId, lead.id), eq(t.consents.channel, channel), isNotNull(t.consents.grantedAt)))
        .limit(1);
      hasConsent = consent.length > 0;
    }

    const q = parseQuietHours(this.cfg.quietHours);
    const verdict = evaluateSendPolicy({
      channel,
      pauseAll,
      suppressedEmail,
      suppressedLinkedin: linkHit.length > 0,
      hasConsent,
      geo: lead.geo,
      geoBlocked: parseGeoBlocked(this.cfg.geoBlocked),
      senderReady: this.cfg.senderReady,
      sentToday,
      dailyCap: this.cfg.dailyCap,
      hourLocal: hourInOffset(Date.now(), this.cfg.utcOffset),
      quietStart: q.start,
      quietEnd: q.end,
      bounceRate: healthPaused?.on ? 1 : health.bounceRate, // an applied health pause holds until cleared
      complaintRate: health.complaintRate,
    });

    if (!verdict.allowed) {
      await this.db.insert(t.policyRefusals).values({
        leadId: lead.id,
        messageId: opts.messageId ?? null,
        channel,
        code: verdict.code,
        reason: verdict.reason,
        context: { geo: lead.geo, sentToday, cap: this.cfg.dailyCap },
      });
    }
    return verdict;
  }

  async recentRefusals(limit = 20) {
    return this.db.select().from(t.policyRefusals).orderBy(desc(t.policyRefusals.at)).limit(limit);
  }
}
