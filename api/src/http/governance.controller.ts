// G1 + D8 — the governance surface: data-subject erasure (the console's
// "erase person" and the operator's answer to a public request) and the
// CSV/JSON exports. Loopback-only like everything else on this api.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Runtime } from '../runtime';
import { exportLeads, exportWaitlist, LEAD_COLUMNS, toCsv, WAITLIST_COLUMNS } from '../governance/export';

const UUID = /^[0-9a-f-]{36}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// structural — keeps @types/express out of the dependency tree
interface HeaderSettable {
  setHeader(name: string, value: string): void;
}

@Controller()
export class GovernanceController {
  constructor(@Inject('RUNTIME') private readonly rt: Runtime) {}

  @Post('erasure')
  async erase(@Body() body: { lead_id?: string; email?: string; linkedin_url?: string }) {
    if (!this.rt.erasure) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
    const leadId = typeof body?.lead_id === 'string' && body.lead_id.trim() ? body.lead_id.trim() : undefined;
    const email = typeof body?.email === 'string' && body.email.trim() ? body.email.trim().toLowerCase() : undefined;
    const linkedinUrl = typeof body?.linkedin_url === 'string' && body.linkedin_url.trim() ? body.linkedin_url.trim() : undefined;
    if (!leadId && !email && !linkedinUrl) {
      throw new BadRequestException('one of lead_id, email, linkedin_url is required');
    }
    if (leadId && !UUID.test(leadId)) throw new BadRequestException('lead_id must be a uuid');
    if (email && !EMAIL.test(email)) throw new BadRequestException('email is not an email');
    return this.rt.erasure.erase({ leadId, email, linkedinUrl });
  }

  @Get('export/:what')
  async export(
    @Param('what') what: string,
    @Query('format') format = 'csv',
    @Res({ passthrough: true }) res: HeaderSettable,
  ) {
    if (!this.rt.db) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
    if (what !== 'leads' && what !== 'waitlist') throw new BadRequestException('what must be leads or waitlist');
    if (format !== 'csv' && format !== 'json') throw new BadRequestException('format must be csv or json');

    const rows = what === 'leads' ? await exportLeads(this.rt.db) : await exportWaitlist(this.rt.db);
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      res.setHeader('content-disposition', `attachment; filename="muninn-${what}-${stamp}.json"`);
      return rows;
    }
    const columns = what === 'leads' ? LEAD_COLUMNS : WAITLIST_COLUMNS;
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="muninn-${what}-${stamp}.csv"`);
    return toCsv(columns, rows);
  }
}
