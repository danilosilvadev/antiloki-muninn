// Review-queue actions (D4) + the kill switch. The full control-center screen
// is slice 4; the switch itself cannot wait — it's a slice-3 exit criterion.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import * as t from '../db/schema';
import { FLAG_HEALTH_PAUSED, FLAG_PAUSE_ALL } from '../policy/policy.service';
import type { Runtime } from '../runtime';

const UUID = /^[0-9a-f-]{36}$/i;

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
    const [pauseAll, healthPaused, sentToday, refusals, campaigns, health] = await Promise.all([
      this.rt.policy.getFlag<boolean>(FLAG_PAUSE_ALL, false),
      this.rt.policy.getFlag<{ on?: boolean; rates?: unknown; at?: string }>(FLAG_HEALTH_PAUSED, {}),
      this.rt.policy.pushesToday(),
      this.rt.policy.recentRefusals(20),
      this.rt.sequences ? this.rt.sequences.allCampaigns() : Promise.resolve([]),
      this.rt.policy.healthRates(),
    ]);
    return {
      pauseAll,
      healthPaused: healthPaused?.on === true ? healthPaused : { on: false },
      sentToday,
      dailyCap: this.rt.cfg.MUNINN_DAILY_SEND_CAP,
      health,
      campaigns,
      refusals,
      senderReady: Boolean(this.rt.cfg.SMARTLEAD_API_KEY),
    };
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
}
