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
  Put,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { LeadsService } from '../leads/leads.service';
import type { Runtime } from '../runtime';

const UUID = /^[0-9a-f-]{36}$/i;
const CONSOLE_STATUSES = ['queued', 'parked'] as const;

function leadsOr503(rt: Runtime): LeadsService {
  if (!rt.leads) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
  return rt.leads;
}

function uuidOr400(id: string): string {
  if (!UUID.test(id)) throw new BadRequestException('id must be a uuid');
  return id;
}

@Controller('leads')
export class LeadsController {
  constructor(@Inject('RUNTIME') private readonly rt: Runtime) {}

  @Post()
  @HttpCode(202)
  async ingest(@Body() body: { linkedin_url?: string; source?: string }) {
    const leads = leadsOr503(this.rt);
    const r = await leads.ingest(body?.linkedin_url ?? '', body?.source ?? 'api');
    if (r.kind === 'invalid') throw new BadRequestException('linkedin_url must look like linkedin.com/in/<slug>');
    if (r.kind === 'suppressed') throw new ConflictException('suppressed — this person asked not to be contacted');
    if (r.kind === 'existing') return { lead_id: r.leadId, status: r.status, existing: true };
    return { lead_id: r.leadId, status: 'new', existing: false };
  }

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('angle') angle?: string,
    @Query('fitMin') fitMin?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const leads = leadsOr503(this.rt);
    return leads.list({
      status: status || undefined,
      angle: angle || undefined,
      fitMin: fitMin ? Number(fitMin) : undefined,
      q: q || undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Post('bulk-status')
  async bulkStatus(@Body() body: { ids?: string[]; status?: string }) {
    const leads = leadsOr503(this.rt);
    const status = body?.status as (typeof CONSOLE_STATUSES)[number];
    if (!CONSOLE_STATUSES.includes(status)) {
      throw new BadRequestException(`status must be one of: ${CONSOLE_STATUSES.join(', ')}`);
    }
    const ids = (body?.ids ?? []).filter((i) => UUID.test(i));
    if (!ids.length) throw new BadRequestException('ids must be a non-empty array of uuids');
    return leads.bulkStatus(ids, status);
  }

  @Get(':id')
  async view(@Param('id') id: string) {
    const leads = leadsOr503(this.rt);
    const v = await leads.view(uuidOr400(id));
    if (!v) throw new NotFoundException();
    return v;
  }

  @Get(':id/timeline')
  async timeline(@Param('id') id: string) {
    const leads = leadsOr503(this.rt);
    return { items: await leads.timeline(uuidOr400(id)) };
  }

  @Post(':id/status')
  async setStatus(@Param('id') id: string, @Body() body: { status?: string; note?: string }) {
    const leads = leadsOr503(this.rt);
    const status = body?.status as (typeof CONSOLE_STATUSES)[number];
    if (!CONSOLE_STATUSES.includes(status)) {
      throw new BadRequestException(`status must be one of: ${CONSOLE_STATUSES.join(', ')}`);
    }
    await leads.setStatus(uuidOr400(id), status, body?.note ?? 'via console');
    return { ok: true, status };
  }

  @Post(':id/notes')
  async note(@Param('id') id: string, @Body() body: { note?: string }) {
    const leads = leadsOr503(this.rt);
    if (!body?.note?.trim()) throw new BadRequestException('note is required');
    await leads.saveNote(uuidOr400(id), body.note.trim());
    return { ok: true };
  }

  @Post(':id/reminders')
  async reminder(@Param('id') id: string, @Body() body: { note?: string; due_at?: string }) {
    const leads = leadsOr503(this.rt);
    const due = body?.due_at ? new Date(body.due_at) : null;
    if (!body?.note?.trim() || !due || Number.isNaN(due.getTime())) {
      throw new BadRequestException('note and a valid due_at (ISO) are required');
    }
    return leads.addReminder(uuidOr400(id), body.note.trim(), due);
  }
}

@Controller()
export class LeadExtrasController {
  constructor(@Inject('RUNTIME') private readonly rt: Runtime) {}

  // Draft editing (the drawer's compose). Sending stays impossible until
  // slice 3 — the server is the source of that truth, not a disabled button.
  @Put('messages/:id')
  async editDraft(@Param('id') id: string, @Body() body: { subject?: string | null; body_md?: string }) {
    const leads = leadsOr503(this.rt);
    const r = await leads.updateDraft(uuidOr400(id), { subject: body?.subject, bodyMd: body?.body_md });
    if (!r.ok) throw new BadRequestException(r.error);
    return { ok: true, canSend: false, reason: 'sending arrives with slice 3 (SendPolicy + review queue)' };
  }

  @Post('reminders/:id/done')
  async reminderDone(@Param('id') id: string) {
    const leads = leadsOr503(this.rt);
    await leads.completeReminder(uuidOr400(id));
    return { ok: true };
  }
}
