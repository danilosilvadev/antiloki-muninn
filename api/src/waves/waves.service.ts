// C10 — waves + invites + referral math. The honest-exclusivity engine:
// position stays the REAL join order (slice-0 rule: never faked). Referral
// standing is DERIVED — every 3 confirmed referrals lifts a member one tier,
// and tiers outrank raw position when a wave selects who gets in. Nothing
// here mutates position; a referral "moves" you because the ranking is
// recomputed, not because history was rewritten.
import { randomBytes } from 'node:crypto';
import { and, count, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/db';
import * as t from '../db/schema';
import { ResendAdapter } from '../channels/resend.adapter';
import { redeemUrl, renderInviteEmail, unsubUrlNode } from './invite-email';

export const REFERRALS_PER_JUMP = 3;

export interface WavesCfg {
  functionsBase: string | null; // redeem + unsub links in the invite email
  edgeSecret: string | null;    // signs unsub links (same secret as the edge fns)
  postalLine: string | null;    // CAN-SPAM footer
}

export interface Standing {
  id: string;
  email: string;
  name: string | null;
  position: number | null;
  referralCode: string;
  referrals: number;
  tier: number;
  effectiveRank: number;
  invitedAt: Date | null;
  activatedAt: Date | null;
  suppressed: boolean;
}

export interface WaveSummary {
  wave: number;
  label: string | null;
  opensAt: Date | null;
  size: number;
  issued: number;
  redeemed: number;
  activated: number;
  createdAt: Date;
  invites: {
    memberId: string | null;
    email: string | null;
    name: string | null;
    code: string;
    issuedAt: Date;
    redeemedAt: Date | null;
    activatedAt: Date | null;
  }[];
}

export interface IssueResult {
  wave: number;
  issued: { memberId: string; email: string; code: string; emailed: boolean }[];
  skipped: { memberId: string; email: string; reason: 'already_invited' | 'suppressed' | 'capacity' | 'unknown' }[];
  emailsSkippedReason: string | null;
  emailErrors: { email: string; error: string }[];
}

export class WavesService {
  constructor(
    private readonly db: Db,
    private readonly resend: ResendAdapter | null,
    private readonly cfg: WavesCfg,
    private readonly notify: (html: string) => Promise<void>,
  ) {}

  // ── referral math ──────────────────────────────────────────────────────────
  // Standings: every member ranked by (tier DESC, position ASC). tier =
  // floor(confirmed referrals / 3). Confirmed = the referred person is a real
  // row whose referred_by carries THIS member's code — junk codes never count
  // because we only read counts for codes that belong to someone.
  async standings(): Promise<Standing[]> {
    const members = await this.db.select().from(t.waitlistMembers);
    const refRows = await this.db
      .select({ code: t.waitlistMembers.referredBy, n: count() })
      .from(t.waitlistMembers)
      .where(isNotNull(t.waitlistMembers.referredBy))
      .groupBy(t.waitlistMembers.referredBy);
    const refs = new Map<string, number>();
    for (const r of refRows) if (r.code) refs.set(r.code, Number(r.n));

    const suppressedRows = await this.db
      .select({ email: t.suppressions.email })
      .from(t.suppressions)
      .where(isNotNull(t.suppressions.email));
    const suppressed = new Set(suppressedRows.map((r) => r.email!.toLowerCase()));

    const ranked = members
      .map((m) => {
        const n = refs.get(m.referralCode) ?? 0;
        return {
          id: m.id,
          email: m.email,
          name: m.name,
          position: m.position,
          referralCode: m.referralCode,
          referrals: n,
          tier: Math.floor(n / REFERRALS_PER_JUMP),
          effectiveRank: 0,
          invitedAt: m.invitedAt,
          activatedAt: m.activatedAt,
          suppressed: suppressed.has(m.email.toLowerCase()),
        };
      })
      .sort((a, b) => b.tier - a.tier || (a.position ?? 1e9) - (b.position ?? 1e9));
    ranked.forEach((m, i) => (m.effectiveRank = i + 1));
    return ranked;
  }

  // ── waves ──────────────────────────────────────────────────────────────────
  async createWave(input: { size: number; label?: string | null; opensAt?: Date | null }): Promise<{ wave: number }> {
    const [maxRow] = await this.db.select({ max: sql<number>`coalesce(max(${t.waves.wave}), 0)` }).from(t.waves);
    const wave = Number(maxRow?.max ?? 0) + 1;
    await this.db.insert(t.waves).values({
      wave,
      size: input.size,
      label: input.label ?? null,
      opensAt: input.opensAt ?? null,
    });
    await this.db.insert(t.events).values({ kind: 'wave_created', payload: { wave, size: input.size } });
    return { wave };
  }

  async getWave(wave: number) {
    const [row] = await this.db.select().from(t.waves).where(eq(t.waves.wave, wave)).limit(1);
    return row ?? null;
  }

  // Who WOULD get this wave's remaining slots, in standings order: never
  // invited, never suppressed, best tier first.
  async selection(wave: number): Promise<{ remaining: number; picks: Standing[] }> {
    const row = await this.getWave(wave);
    if (!row) throw new Error(`wave ${wave} does not exist`);
    const [issuedRow] = await this.db.select({ n: count() }).from(t.invites).where(eq(t.invites.wave, wave));
    const remaining = Math.max(0, row.size - Number(issuedRow?.n ?? 0));
    const all = await this.standings();
    const picks = all.filter((m) => !m.invitedAt && !m.suppressed).slice(0, remaining);
    return { remaining, picks };
  }

  // ── issue: mint codes + stamp invited_at + send Resend invites ─────────────
  async issue(wave: number, memberIds?: string[]): Promise<IssueResult> {
    const waveRow = await this.getWave(wave);
    if (!waveRow) throw new Error(`wave ${wave} does not exist`);

    const { remaining, picks } = await this.selection(wave);
    let queue: Standing[];
    const skipped: IssueResult['skipped'] = [];

    if (memberIds && memberIds.length > 0) {
      const all = await this.standings();
      const byId = new Map(all.map((m) => [m.id, m]));
      queue = [];
      for (const id of memberIds) {
        const m = byId.get(id);
        if (!m) skipped.push({ memberId: id, email: '?', reason: 'unknown' });
        else if (m.invitedAt) skipped.push({ memberId: id, email: m.email, reason: 'already_invited' });
        else if (m.suppressed) skipped.push({ memberId: id, email: m.email, reason: 'suppressed' });
        else if (queue.length >= remaining) skipped.push({ memberId: id, email: m.email, reason: 'capacity' });
        else queue.push(m);
      }
    } else {
      queue = picks;
    }

    const emailsSkippedReason = !this.resend
      ? 'RESEND_API_KEY / MUNINN_INVITE_FROM missing — codes minted, emails skipped'
      : !this.cfg.functionsBase
        ? 'MUNINN_FUNCTIONS_BASE missing — codes minted, emails skipped (no redeem link to send)'
        : null;

    const issued: IssueResult['issued'] = [];
    const emailErrors: IssueResult['emailErrors'] = [];

    for (const m of queue) {
      const code = await this.mintCode(wave, m.id);
      await this.db
        .update(t.waitlistMembers)
        .set({ invitedAt: new Date() })
        .where(eq(t.waitlistMembers.id, m.id));
      await this.db.insert(t.events).values({
        kind: 'invite_issued',
        payload: { wave, member_id: m.id, code, tier: m.tier, referrals: m.referrals },
      });

      let emailed = false;
      if (!emailsSkippedReason) {
        const link = redeemUrl(this.cfg.functionsBase!, code);
        const unsub = this.cfg.edgeSecret ? unsubUrlNode(this.cfg.functionsBase!, m.email, this.cfg.edgeSecret) : null;
        const mail = renderInviteEmail({
          name: m.name,
          email: m.email,
          position: m.position,
          code,
          wave,
          opensAt: waveRow.opensAt,
          redeemUrl: link,
          unsubUrl: unsub,
          postalLine: this.cfg.postalLine,
        });
        try {
          const id = await this.resend!.send({ to: m.email, ...mail });
          await this.db.insert(t.vendorCalls).values({
            provider: 'resend',
            kind: 'invite',
            meta: { wave, member_id: m.id, resend_id: id },
          });
          emailed = true;
        } catch (e) {
          const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
          emailErrors.push({ email: m.email, error });
          await this.db.insert(t.events).values({
            kind: 'invite_email_failed',
            payload: { wave, member_id: m.id, error },
          });
        }
      }
      issued.push({ memberId: m.id, email: m.email, code, emailed });
    }

    if (issued.length > 0) {
      const emailed = issued.filter((i) => i.emailed).length;
      await this.notify(
        `🌊 <b>wave ${wave}</b> issued — ${issued.length} code(s), ${emailed} email(s)` +
          (emailsSkippedReason ? `\n⚠ ${emailsSkippedReason}` : '') +
          (emailErrors.length ? `\n⚠ ${emailErrors.length} email(s) failed — codes still valid, reissue from the console` : ''),
      );
    }
    return { wave, issued, skipped, emailsSkippedReason, emailErrors };
  }

  private async mintCode(wave: number, memberId: string): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = randomBytes(4).toString('hex');
      try {
        await this.db.insert(t.invites).values({ code, wave, issuedTo: memberId });
        return code;
      } catch (e) {
        if (attempt === 2) throw e; // three hex collisions in a row is not luck — surface it
      }
    }
    throw new Error('unreachable');
  }

  // Activation is operator-confirmed: the person actually started using the
  // product, not merely clicked a link. Redemption (the click) is stamped by
  // the invite edge function; this is the second, human gate.
  async activate(memberId: string): Promise<{ ok: true; already: boolean }> {
    const [m] = await this.db.select().from(t.waitlistMembers).where(eq(t.waitlistMembers.id, memberId)).limit(1);
    if (!m) throw new Error('member not found');
    if (m.activatedAt) return { ok: true, already: true };
    await this.db
      .update(t.waitlistMembers)
      .set({ activatedAt: new Date() })
      .where(eq(t.waitlistMembers.id, memberId));
    await this.db.insert(t.events).values({ kind: 'member_activated', payload: { member_id: memberId } });
    return { ok: true, already: false };
  }

  // ── the D7 payload ─────────────────────────────────────────────────────────
  async view() {
    const d7 = new Date(Date.now() - 7 * 24 * 3_600_000);
    const all = await this.standings();
    const ownedCodes = new Set(all.map((m) => m.referralCode));

    const [visits7] = await this.db
      .select({ n: count() })
      .from(t.events)
      .where(and(eq(t.events.kind, 'referral_visit'), gte(t.events.at, d7)));

    const membersRows = await this.db
      .select({ createdAt: t.waitlistMembers.createdAt, referredBy: t.waitlistMembers.referredBy })
      .from(t.waitlistMembers);
    const joined = membersRows.length;
    const joined7d = membersRows.filter((m) => m.createdAt >= d7).length;
    const referred = membersRows.filter((m) => m.referredBy && ownedCodes.has(m.referredBy)).length;

    const invited = all.filter((m) => m.invitedAt).length;
    const activated = all.filter((m) => m.activatedAt).length;

    const inviteRows = await this.db.select().from(t.invites).orderBy(desc(t.invites.issuedAt));
    const redeemed = inviteRows.filter((i) => i.redeemedAt).length;

    const byId = new Map(all.map((m) => [m.id, m]));
    const waveRows = await this.db.select().from(t.waves).orderBy(desc(t.waves.wave));
    const waves: WaveSummary[] = waveRows.map((w) => {
      const inv = inviteRows.filter((i) => i.wave === w.wave);
      return {
        wave: w.wave,
        label: w.label,
        opensAt: w.opensAt,
        size: w.size,
        issued: inv.length,
        redeemed: inv.filter((i) => i.redeemedAt).length,
        activated: inv.filter((i) => i.issuedTo && byId.get(i.issuedTo)?.activatedAt).length,
        createdAt: w.createdAt,
        invites: inv.map((i) => {
          const m = i.issuedTo ? byId.get(i.issuedTo) : undefined;
          return {
            memberId: i.issuedTo,
            email: m?.email ?? null,
            name: m?.name ?? null,
            code: i.code,
            issuedAt: i.issuedAt,
            redeemedAt: i.redeemedAt,
            activatedAt: m?.activatedAt ?? null,
          };
        }),
      };
    });

    const leaderboard = all
      .filter((m) => m.referrals > 0)
      .sort((a, b) => b.referrals - a.referrals || (a.position ?? 1e9) - (b.position ?? 1e9))
      .slice(0, 10)
      .map((m) => ({
        memberId: m.id,
        email: m.email,
        name: m.name,
        referrals: m.referrals,
        tier: m.tier,
        position: m.position,
        toNextJump: REFERRALS_PER_JUMP - (m.referrals % REFERRALS_PER_JUMP),
      }));

    const consentRows = await this.db
      .select({ channel: t.consents.channel, n: count() })
      .from(t.consents)
      .where(isNotNull(t.consents.grantedAt))
      .groupBy(t.consents.channel);
    const consentBy: Record<string, number> = {};
    for (const r of consentRows) consentBy[r.channel] = Number(r.n);

    return {
      totals: { members: joined, last7d: joined7d },
      funnel: {
        joined,
        referred,
        invited,
        redeemed,
        activated,
        referralVisits7d: Number(visits7?.n ?? 0),
      },
      waves,
      leaderboard,
      consents: { email: joined, whatsapp: consentBy['whatsapp'] ?? 0, telegram: consentBy['telegram'] ?? 0 },
      referralsPerJump: REFERRALS_PER_JUMP,
    };
  }
}
