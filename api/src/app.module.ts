import { Module, type DynamicModule } from '@nestjs/common';
import { HealthController } from './http/health.controller';
import { LeadsController } from './http/leads.controller';
import type { Runtime } from './runtime';

@Module({})
export class AppModule {
  static register(rt: Runtime): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, LeadsController],
      providers: [{ provide: 'RUNTIME', useValue: rt }],
    };
  }
}
