import { Controller, Get, Inject } from '@nestjs/common';
import type { Runtime } from '../runtime';

@Controller('health')
export class HealthController {
  constructor(@Inject('RUNTIME') private readonly rt: Runtime) {}

  @Get()
  health() {
    return {
      ok: true,
      service: 'muninn-api',
      slice: 1,
      db: !!this.rt.db,
      jobs: !!this.rt.boss,
      workers: this.rt.workersActive,
      telegram: !!this.rt.telegram,
      degraded: this.rt.cfg.degraded,
    };
  }
}
