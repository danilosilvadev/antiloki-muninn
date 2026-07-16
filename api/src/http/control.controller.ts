// Review-queue actions (D4) + the full control-center (D6): the kill switch,
// per-angle campaigns with their timing editor, vendor spend vs budget, the
// compliance board (geo + suppressions), and the SendPolicy refusal log.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, count, desc, eq, gte, ilike, or, sql, sum } from 'drizzle-orm';
import * as t from '../db/schema';
import { FLAG_ANGLE_PAUSED, FLAG_HEALTH_PAUSED, FLAG_PAUSE_ALL } from '../policy/policy.service';
import type { Runtime } from '../runtime';

const UUID = /^[0-9a-f-]{36}$/i;
const ANGLES = ['verification', 'cant_lie', 'memory', 'orchestration'] as const;
const VENDOR_PROVIDERS = ['fullenrich', 'openrouter', 'apollo', 'smartlead', 'resend'] as const;

@Controller()
export class ControlController {
  constructor(@Inject('RUNTIME') private readonly rt: Runtime) {}

  @Post('leads/:id/approve')
  async approve(@Param('id') id: string) {
    if (!UUID.test(id)) throw new BadRequestException('id must be a uuid');
    if (!this.rt.sequences) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
    const r = await this.rt.sequences.approve(id);
    // refusals are a first-class answer, not an error: the queue shows the reason
    return r;
  }

  @Post('leads/:id/reject')
  async reject(@Param('id') id: string, @Body() body: { reason?: string }) {
    if (!UUID.test(id)) throw new BadRequestException('id must be a uuid');
    if (!this.rt.sequences) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
    if (!body?.reason?.trim()) throw new BadRequestException('reason is required — it steers the next dossiers');
    await this.rt.sequences.reject(id, body.reason.trim());
    return { ok: true };
  }

  // the manual day-3 LinkedIn touch: operator sent it in the real UI, records it here
  @Post('messages/:id/mark-sent')
  async markSent(@Param('id') id: string) {
    if (!UUID.test(id)) throw new BadRequestException('id must be a uuid');
    if (!this.rt.db) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
    const [msg] = await this.rt.db.select().from(t.messages).where(eq(t.messages.id, id)).limit(1);
    if (!msg) throw new NotFoundException();
    if (msg.channel !== 'linkedin') throw new BadRequestException('only the manual LinkedIn touch is marked by hand');
    await this.rt.db.update(t.messages).set({ status: 'sent', sentAt: new Date() }).where(eq(t.messages.id, id));
    await this.rt.db.insert(t.events).values({
      leadId: msg.leadId,
      messageId: msg.id,
      kind: 'linkedin_sent_manual',
      payload: { step: msg.step },
    });
    return { ok: true };
  }

  @Get('review/queue')
  async reviewQueue() {
    if (!this.rt.leads || !this.rt.db) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
    const rows = await this.rt.db
      .select({ id: t.leads.id })
      .from(t.leads)
      .where(and(eq(t.leads.status, 'analyzed')))
      .orderBy(t.leads.updatedAt)
      .limit(50);
    const views = [];
    for (const r of rows.slice(0, 20)) {
      const v = await this.rt.leads.view(r.id);
      if (v) views.push(v);
    }
    return { total: rows.length, items: views };
  }

  @Get('control')
  async control() {
    if (!this.rt.policy || !this.rt.db) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
    const [pauseAll, healthPaused, anglePaused, sentToday, refusals, campaigns, health] = await Promise.all([
      this.rt.policy.getFlag<boolean>(FLAG_PAUSE_ALL, false),
      this.rt.policy.getFlag<{ on?: boolean; rates?: unknown; at?: string }>(FLAG_HEALTH_PAUSED, {}),
      this.rt.policy.getFlag<Record<string, boolean>>(FLAG_ANGLE_PAUSED, {}),
      this.rt.policy.pushesToday(),
      this.rt.policy.recentRefusals(20),
      this.rt.sequences ? this.rt.sequences.allCampaigns() : Promise.resolve([]),
      this.rt.policy.healthRates(),
    ]);
    const [angles, vendors, budget, suppressionsCount, templates] = await Promise.all([
      this.angleStats(campaigns, anglePaused),
      this.vendorBoard(),
      this.budgetBoard(),
      this.rt.db.select({ n: count() }).from(t.suppressions).then((r) => Number(r[0]?.n ?? 0)),
      this.templateBoard(),
    ]);
    return {
      pauseAll,
      healthPaused: healthPaused?.on === true ? healthPaused : { on: false },
      sentToday,
      dailyCap: this.rt.cfg.MUNINN_DAILY_SEND_CAP,
      quietHours: this.rt.cfg.MUNINN_QUIET_HOURS,
      utcOffset: this.rt.cfg.MUNINN_UTC_OFFSET,
      geoBlocked: this.rt.cfg.MUNINN_GEO_BLOCKED,
      health,
      campaigns,
      angles,
      templates,
      vendors,
      budget,
      suppressionsCount,
      refusals,
      senderReady: Boolean(this.rt.cfg.SMARTLEAD_API_KEY),
    };
  }

  // Per-angle machine numbers: pushes from the audit chain (sequence_pushed
  // carries its angle), replies/positives joined through the lead's sequence.
  private async angleStats(
    campaigns: { angle: string; campaignId: string }[],
    anglePaused: Record<string, boolean>,
  ) {
    const db = this.rt.db!;
    const pushedRows = await db
      .select({ angle: sql<string>`${t.events.payload}->>'angle'`, n: count() })
      .from(t.events)
      .where(eq(t.events.kind, 'sequence_pushed'))
      .groupBy(sql`${t.events.payload}->>'angle'`);
    const repliedRows = await db
      .select({ angle: t.sequences.template, n: sql<number>`count(distinct ${t.leads.id})` })
      .from(t.leads)
      .innerJoin(t.sequences, eq(t.sequences.leadId, t.leads.id))
      .where(eq(t.leads.status, 'replied'))
      .groupBy(t.sequences.template);
    const positiveRows = await db
      .select({ angle: t.sequences.template, n: sql<number>`count(distinct ${t.events.id})` })
      .from(t.events)
      .innerJoin(t.sequences, eq(t.sequences.leadId, t.events.leadId))
      .where(and(eq(t.events.kind, 'reply_labeled'), sql`${t.events.payload}->>'label' = 'positive'`))
      .groupBy(t.sequences.template);

    const toMap = (rows: { angle: string | null; n: unknown }[]) => {
      const m: Record<string, number> = {};
      for (const r of rows) if (r.angle) m[r.angle] = Number(r.n);
      return m;
    };
    const pushed = toMap(pushedRows);
    const replied = toMap(repliedRows);
    const positive = toMap(positiveRows);
    const campBy = new Map(campaigns.map((c) => [c.angle, c.campaignId]));

    const names = new Set<string>([...ANGLES, ...campaigns.map((c) => c.angle)]);
    return [...names].map((angle) => ({
      angle,
      campaignId: campBy.get(angle) ?? null,
      paused: anglePaused[angle] === true,
      pushed: pushed[angle] ?? 0,
      replied: replied[angle] ?? 0,
      positive: positive[angle] ?? 0,
    }));
  }

  private async vendorBoard() {
    const db = this.rt.db!;
    const d30 = new Date(Date.now() - 30 * 24 * 3_600_000);
    const rows = await db
      .select({ provider: t.vendorCalls.provider, total: sum(t.vendorCalls.costUsd), calls: count() })
      .from(t.vendorCalls)
      .where(gte(t.vendorCalls.at, d30))
      .groupBy(t.vendorCalls.provider);
    const spend = new Map(rows.map((r) => [r.provider, { total: Number(r.total ?? 0), calls: Number(r.calls) }]));
    const cfg = this.rt.cfg;
    const configured: Record<string, boolean> = {
      fullenrich: Boolean(cfg.FULLENRICH_API_KEY),
      openrouter: Boolean(cfg.OPENROUTER_API_KEY),
      apollo: Boolean(cfg.APOLLO_API_KEY),
      smartlead: Boolean(cfg.SMARTLEAD_API_KEY),
      resend: Boolean(cfg.RESEND_API_KEY && cfg.MUNINN_INVITE_FROM),
    };
    const names = new Set<string>([...VENDOR_PROVIDERS, ...spend.keys()]);
    return [...names].map((provider) => ({
      provider,
      configured: configured[provider] ?? true, // a provider with spend rows was configured when it spent
      spend30dUsd: spend.get(provider)?.total ?? 0,
      calls30d: spend.get(provider)?.calls ?? 0,
    }));
  }

  private async budgetBoard() {
    const db = this.rt.db!;
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [row] = await db
      .select({ total: sum(t.vendorCalls.costUsd) })
      .from(t.vendorCalls)
      .where(gte(t.vendorCalls.at, monthStart));
    return {
      monthUsd: this.rt.cfg.MUNINN_MONTHLY_BUDGET_USD,
      spentMonthUsd: Number(row?.total ?? 0),
      note: 'display only in slice 4 — the enforcing circuit-breaker is slice 5 (G3)',
    };
  }

  private async templateBoard() {
    const db = this.rt.db!;
    const rows = await db.select().from(t.sequenceTemplates);
    const by = new Map(rows.map((r) => [r.angle, r]));
    return ANGLES.map((angle) => {
      const row = by.get(angle);
      const d = row?.delays;
      const delays = Array.isArray(d) && d.length === 3 ? (d as number[]) : [0, 6, 6];
      return { angle, delays, edited: Boolean(row), updatedAt: row?.updatedAt ?? null };
    });
  }

  @Post('control/pause-all')
  async pauseAll(@Body() body: { on?: boolean }) {
    if (!this.rt.policy) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
    if (typeof body?.on !== 'boolean') throw new BadRequestException('body.on must be a boolean');
    await this.rt.policy.setFlag(FLAG_PAUSE_ALL, body.on);
    if (this.rt.requestTick) await this.rt.requestTick(); // applied within one tick — usually this one
    return { ok: true, pauseAll: body.on };
  }

  @Post('control/clear-health-pause')
  async clearHealth() {
    if (!this.rt.policy) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
    await this.rt.policy.setFlag(FLAG_HEALTH_PAUSED, { on: false, clearedAt: new Date().toISOString() });
    return { ok: true, note: 'campaigns stay paused until you resume them (pause-all off + Smartlead), by design' };
  }

  // ── D6 · the compliance board: suppressions ────────────────────────────────
  @Get('control/suppressions')
  async suppressions(@Query('q') q?: string) {
    if (!this.rt.db) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
    const needle = typeof q === 'string' && q.trim() ? `%${q.trim()}%` : null;
    const where = needle
      ? or(
          ilike(t.suppressions.email, needle),
          ilike(t.suppressions.emailDomain, needle),
          ilike(t.suppressions.linkedinUrl, needle),
        )
      : undefined;
    const base = this.rt.db.select().from(t.suppressions);
    const rows = await (where ? base.where(where) : base).orderBy(desc(t.suppressions.at)).limit(50);
    return { rows };
  }

  @Post('control/suppressions')
  async addSuppression(@Body() body: { email?: string; email_domain?: string; linkedin_url?: string }) {
    if (!this.rt.db) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
    const email = typeof body?.email === 'string' && body.email.trim() ? body.email.trim().toLowerCase() : null;
    const emailDomain = typeof body?.email_domain === 'string' && body.email_domain.trim()
      ? body.email_domain.trim().toLowerCase().replace(/^@/, '')
      : null;
    const linkedinUrl = typeof body?.linkedin_url === 'string' && body.linkedin_url.trim() ? body.linkedin_url.trim() : null;
    if (!email && !emailDomain && !linkedinUrl) {
      throw new BadRequestException('one of email, email_domain, linkedin_url is required');
    }
    await this.rt.db.insert(t.suppressions).values({ email, emailDomain, linkedinUrl, reason: 'manual' });
    await this.rt.db.insert(t.events).values({
      kind: 'suppression_added',
      payload: { email, email_domain: emailDomain, linkedin_url: linkedinUrl, via: 'console' },
    });
    return { ok: true };
  }

  // ── D6 · the sequence timing editor ────────────────────────────────────────
  // Step 1 is always day-0; steps 2 and 3 are delays after the previous step.
  @Put('control/templates/:angle')
  async putTemplate(@Param('angle') angle: string, @Body() body: { delays?: unknown }) {
    if (!(ANGLES as readonly string[]).includes(angle)) {
      throw new BadRequestException(`angle must be one of: ${ANGLES.join(', ')}`);
    }
    if (!this.rt.sequences) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
    const d = body?.delays;
    const valid = Array.isArray(d) && d.length === 3 &&
      d.every((x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 90) && d[0] === 0;
    if (!valid) throw new BadRequestException('delays must be [0, d2, d3] — integer days 0..90, step 1 fixed at day 0');
    const r = await this.rt.sequences.setTemplateDelays(angle, d as number[]);
    return {
      ok: true,
      angle,
      delays: d,
      pushedToSmartlead: r.pushedToSmartlead,
      note: r.pushedToSmartlead
        ? 'live campaign updated on Smartlead'
        : 'applies when this angle’s campaign is first created',
    };
  }

  // ── D6 · per-angle pause/resume ────────────────────────────────────────────
  @Post('control/angles/:angle/pause')
  async angleStatus(@Param('angle') angle: string, @Body() body: { on?: boolean }) {
    if (!(ANGLES as readonly string[]).includes(angle)) {
      throw new BadRequestException(`angle must be one of: ${ANGLES.join(', ')}`);
    }
    if (typeof body?.on !== 'boolean') throw new BadRequestException('body.on must be a boolean');
    if (!this.rt.policy || !this.rt.db) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
    const map = await this.rt.policy.getFlag<Record<string, boolean>>(FLAG_ANGLE_PAUSED, {});
    if (body.on) map[angle] = true;
    else delete map[angle];
    await this.rt.policy.setFlag(FLAG_ANGLE_PAUSED, map);

    const pauseAll = await this.rt.policy.getFlag<boolean>(FLAG_PAUSE_ALL, false);
    let campaignApplied = false;
    if (this.rt.sequences && (body.on || !pauseAll)) {
      // resuming under pause-all leaves the campaign paused — pause-all owns it
      campaignApplied = await this.rt.sequences.setAngleCampaignStatus(angle, body.on ? 'PAUSED' : 'START');
    }
    await this.rt.db.insert(t.events).values({
      kind: 'angle_pause',
      payload: { angle, on: body.on, campaign_applied: campaignApplied },
    });
    return {
      ok: true,
      angle,
      on: body.on,
      campaignApplied,
      note: !body.on && pauseAll ? 'pause-all is ON — the campaign stays paused until you lift the kill switch' : null,
    };
  }
}
