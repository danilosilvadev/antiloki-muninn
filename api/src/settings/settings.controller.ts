import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import type { Runtime } from '../runtime';
import type { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(
    @Inject('RUNTIME') private readonly rt: Runtime,
    @Inject('SETTINGS') private readonly settings: SettingsService,
  ) {}

  @Get()
  get() {
    return {
      keys: this.settings.status(),
      degraded: this.rt.cfg.degraded,
      db: !!this.rt.db,
      workers: this.rt.workersActive,
      telegram: !!this.rt.telegram,
    };
  }

  @Put()
  async put(@Body() body: { values?: Record<string, unknown> }) {
    return this.settings.update(body?.values ?? {});
  }
}
