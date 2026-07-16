// Keys & knobs via the admin panel (pulled forward from D8/G4 by operator
// decision, 2026-07-16). G4's spirit is kept intact: values are written ONLY
// to api/.env on the operator machine — the console posts them once over
// loopback and never gets them back (secrets report configured + length, no
// value, no last4). A successful update hot-reloads the runtime.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { BadRequestException } from '@nestjs/common';
import { loadConfig } from '../config/config';

export interface KeyDef {
  name: string;
  group: 'core' | 'vendors' | 'telegram' | 'tuning';
  secret: boolean;
  hint: string;
}

export const KEY_DEFS: KeyDef[] = [
  { name: 'SUPABASE_DB_URL', group: 'core', secret: true, hint: 'session-pooler URI — dashboard → Connect → Session pooler' },
  { name: 'OPENROUTER_API_KEY', group: 'vendors', secret: true, hint: 'openrouter.ai → Keys (set a monthly limit there too)' },
  { name: 'FULLENRICH_API_KEY', group: 'vendors', secret: true, hint: 'fullenrich.com → API' },
  { name: 'APOLLO_API_KEY', group: 'vendors', secret: true, hint: 'apollo.io → API — powers “find similar” (slice 2)' },
  { name: 'TELEGRAM_BOT_TOKEN', group: 'telegram', secret: true, hint: '@BotFather → /newbot' },
  { name: 'TELEGRAM_OPERATOR_CHAT_ID', group: 'telegram', secret: false, hint: 'message the bot once — it replies with this id' },
  { name: 'MUNINN_ANALYSIS_MODEL', group: 'tuning', secret: false, hint: 'any capable OpenRouter model slug' },
  { name: 'MUNINN_FIT_THRESHOLD', group: 'tuning', secret: false, hint: 'park below this fit score (0-100)' },
  { name: 'MUNINN_DIGEST_CRON', group: 'tuning', secret: false, hint: 'daily digest, UTC cron (5 fields)' },
  { name: 'FULLENRICH_USD_PER_CREDIT', group: 'tuning', secret: false, hint: 'cost-ledger conversion (starter: 29/500 = 0.058)' },
  { name: 'CALENDLY_URL', group: 'tuning', secret: false, hint: 'the “book a call” link in the lead drawer' },
];

export interface KeyStatus extends KeyDef {
  configured: boolean;
  value: string | null;  // non-secrets only
  length: number | null; // secrets only
}

export function keyStatuses(env: NodeJS.ProcessEnv = process.env): KeyStatus[] {
  return KEY_DEFS.map((d) => {
    const raw = env[d.name];
    const configured = typeof raw === 'string' && raw.trim().length > 0;
    return {
      ...d,
      configured,
      value: !d.secret && configured ? raw!.trim() : null,
      length: d.secret && configured ? raw!.trim().length : null,
    };
  });
}

// Rewrites KEY=value lines in place, appends missing ones, atomic-ish swap.
export function upsertEnvFile(envPath: string, patch: Record<string, string>): void {
  const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
  const done = new Set<string>();
  const out = lines.map((line) => {
    if (line.trim().startsWith('#')) return line;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && Object.prototype.hasOwnProperty.call(patch, m[1])) {
      done.add(m[1]);
      return `${m[1]}=${patch[m[1]]}`;
    }
    return line;
  });
  const missing = Object.keys(patch).filter((k) => !done.has(k));
  if (missing.length) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    for (const k of missing) out.push(`${k}=${patch[k]}`);
  }
  const tmp = envPath + '.tmp';
  writeFileSync(tmp, out.join('\n').replace(/\n*$/, '') + '\n');
  renameSync(tmp, envPath);
}

export interface ReloadResult {
  degraded: string[];
  workersActive: boolean;
}

export class SettingsService {
  private updating = false;

  constructor(
    private readonly envPath: string,
    private readonly reload: () => Promise<ReloadResult>,
  ) {}

  status(): KeyStatus[] {
    return keyStatuses();
  }

  async update(values: Record<string, unknown>): Promise<{ ok: true } & ReloadResult> {
    if (this.updating) throw new BadRequestException('another settings update is in flight — retry in a moment');
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(values ?? {})) {
      if (!KEY_DEFS.some((d) => d.name === k)) throw new BadRequestException(`unknown setting: ${k}`);
      if (typeof v !== 'string') throw new BadRequestException(`${k}: value must be a string`);
      if (/[\r\n]/.test(v)) throw new BadRequestException(`${k}: value must be a single line`);
      patch[k] = v.trim();
    }
    if (Object.keys(patch).length === 0) throw new BadRequestException('no settings in body.values');

    // dry-validate the merged env BEFORE touching disk or process state
    const merged: NodeJS.ProcessEnv = { ...process.env, ...patch };
    try {
      loadConfig(merged);
    } catch (e) {
      throw new BadRequestException('invalid value: ' + (e instanceof Error ? e.message : String(e)).slice(0, 300));
    }

    this.updating = true;
    try {
      upsertEnvFile(this.envPath, patch);
      for (const [k, v] of Object.entries(patch)) {
        if (v === '') delete process.env[k]; // empty string = unset
        else process.env[k] = v;
      }
      const r = await this.reload();
      return { ok: true, ...r };
    } finally {
      this.updating = false;
    }
  }
}
