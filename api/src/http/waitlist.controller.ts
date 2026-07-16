// D7 — waitlist & waves. The inbound half of GTM: who's coming, who's
// referring, who gets the next invite. Wave issuing is deliberately a
// two-step in the UI (preview selection → issue) so the operator SEES who
// jumps the line before any email leaves.
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
import type { Runtime } from '../runtime';
import type { WavesService } from '../waves/waves.service';

const UUID = /^[0-9a-f-]{36}$/i;

@Controller()
export class WaitlistController {
  constructor(@Inject('RUNTIME') private readonly rt: Runtime) {}

  private waves(): WavesService {
    if (!this.rt.waves) throw new ServiceUnavailableException('db not configured — Settings → SUPABASE_DB_URL');
    return this.rt.waves;
  }

  @Get('waitlist')
  async view() {
    return this.waves().view();
  }

  @Post('waitlist/waves')
  async createWave(@Body() body: { size?: number; label?: string; opens_at?: string }) {
    const size = Number(body?.size);
    if (!Number.isInteger(size) || size < 1 || size > 500) {
      throw new BadRequestException('body.size must be an integer 1..500');
    }
    let opensAt: Date | null = null;
    if (body?.opens_at) {
      opensAt = new Date(body.opens_at);
      if (Number.isNaN(opensAt.getTime())) throw new BadRequestException('body.opens_at must be an ISO date');
    }
    const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null;
    return this.waves().createWave({ size, label, opensAt });
  }

  @Get('waitlist/waves/:wave/selection')
  async selection(@Param('wave') waveParam: string) {
    const wave = Number(waveParam);
    if (!Number.isInteger(wave) || wave < 1) throw new BadRequestException('wave must be a positive integer');
    if (!(await this.waves().getWave(wave))) throw new NotFoundException(`wave ${wave} does not exist`);
    return this.waves().selection(wave);
  }

  @Post('waitlist/waves/:wave/issue')
  async issue(@Param('wave') waveParam: string, @Body() body: { member_ids?: string[] }) {
    const wave = Number(waveParam);
    if (!Number.isInteger(wave) || wave < 1) throw new BadRequestException('wave must be a positive integer');
    if (!(await this.waves().getWave(wave))) throw new NotFoundException(`wave ${wave} does not exist`);
    let memberIds: string[] | undefined;
    if (body?.member_ids !== undefined) {
      if (!Array.isArray(body.member_ids) || body.member_ids.some((id) => typeof id !== 'string' || !UUID.test(id))) {
        throw new BadRequestException('body.member_ids must be an array of uuids');
      }
      memberIds = body.member_ids;
    }
    return this.waves().issue(wave, memberIds);
  }

  @Post('waitlist/members/:id/activate')
  async activate(@Param('id') id: string) {
    if (!UUID.test(id)) throw new BadRequestException('id must be a uuid');
    try {
      return await this.waves().activate(id);
    } catch (e) {
      if (e instanceof Error && e.message === 'member not found') throw new NotFoundException(e.message);
      throw e;
    }
  }
}
