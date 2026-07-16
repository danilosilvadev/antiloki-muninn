import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Runtime } from '../runtime';

@Controller('leads')
export class LeadsController {
  constructor(@Inject('RUNTIME') private readonly rt: Runtime) {}

  @Post()
  @HttpCode(202)
  async ingest(@Body() body: { linkedin_url?: string; source?: string }) {
    if (!this.rt.leads) throw new ServiceUnavailableException('db not configured (SUPABASE_DB_URL)');
    const r = await this.rt.leads.ingest(body?.linkedin_url ?? '', body?.source ?? 'api');
    if (r.kind === 'invalid') throw new BadRequestException('linkedin_url must look like linkedin.com/in/<slug>');
    if (r.kind === 'suppressed') throw new ConflictException('suppressed — this person asked not to be contacted');
    if (r.kind === 'existing') return { lead_id: r.leadId, status: r.status, existing: true };
    return { lead_id: r.leadId, status: 'new', existing: false };
  }

  @Get(':id')
  async view(@Param('id') id: string) {
    if (!this.rt.leads) throw new ServiceUnavailableException('db not configured (SUPABASE_DB_URL)');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('id must be a uuid');
    const v = await this.rt.leads.view(id);
    if (!v) throw new NotFoundException();
    return v;
  }
}
