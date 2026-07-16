import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Runtime } from '../runtime';
import type { SuggestionsService } from '../leads/suggestions.service';

const STATES = ['pending', 'accepted', 'dismissed'];

@Controller()
export class SuggestionsController {
  constructor(@Inject('RUNTIME') private readonly rt: Runtime) {}

  private svc(): SuggestionsService {
    if (!this.rt.suggestions) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
    return this.rt.suggestions;
  }

  @Post('leads/:id/expand')
  async expand(@Param('id') id: string, @Body() body: { mode?: string }) {
    const mode = body?.mode === 'lookalike' ? 'lookalike' : 'colleagues';
    try {
      return await this.svc().expand(id, mode);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'expand failed');
    }
  }

  @Get('suggestions')
  async list(@Query('state') state?: string) {
    const s = state && STATES.includes(state) ? state : 'pending';
    return { state: s, rows: await this.svc().list(s) };
  }

  @Post('suggestions/:id/accept')
  async accept(@Param('id') id: string) {
    return this.svc().accept(id);
  }

  @Post('suggestions/:id/dismiss')
  async dismiss(@Param('id') id: string) {
    return this.svc().dismiss(id);
  }
}
