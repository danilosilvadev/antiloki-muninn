import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Runtime } from '../runtime';
import { buildStats } from './stats';

@Controller('stats')
export class StatsController {
  constructor(@Inject('RUNTIME') private readonly rt: Runtime) {}

  @Get()
  async stats() {
    if (!this.rt.db) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
    const stats = await buildStats(this.rt.db);
    return {
      ...stats,
      fitThreshold: this.rt.cfg.MUNINN_FIT_THRESHOLD,
      calendlyUrl: this.rt.cfg.CALENDLY_URL ?? null,
      workers: this.rt.workersActive,
      degraded: this.rt.cfg.degraded,
    };
  }
}
