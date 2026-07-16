import { Module, type DynamicModule } from '@nestjs/common';
import { ControlController } from './http/control.controller';
import { HealthController } from './http/health.controller';
import { LeadExtrasController, LeadsController } from './http/leads.controller';
import { StatsController } from './http/stats.controller';
import { SuggestionsController } from './http/suggestions.controller';
import { WaitlistController } from './http/waitlist.controller';
import { SettingsController } from './settings/settings.controller';
import type { SettingsService } from './settings/settings.service';
import type { Runtime } from './runtime';

@Module({})
export class AppModule {
  static register(rt: Runtime, settings: SettingsService): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        LeadsController,
        LeadExtrasController,
        StatsController,
        SuggestionsController,
        ControlController,
        WaitlistController,
        SettingsController,
      ],
      providers: [
        { provide: 'RUNTIME', useValue: rt },
        { provide: 'SETTINGS', useValue: settings },
      ],
    };
  }
}
