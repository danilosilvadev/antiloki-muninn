// zod-validated env (C1). Missing vendor keys degrade the api instead of
// killing it — each absent subsystem is named in cfg.degraded and surfaced by
// GET /v1/health and the boot banner, so misconfiguration is loud, not silent.
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Minimal .env loader (KEY=VALUE lines, # comments, no expansion — no dotenv dep).
export function loadDotEnv(dir: string): void {
  const file = join(dir, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

const Env = z.object({
  PORT: z.coerce.number().int().default(41945),
  SUPABASE_DB_URL: z.string().min(10).optional(),          // session-pooler URL
  OPENROUTER_API_KEY: z.string().min(10).optional(),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  MUNINN_ANALYSIS_MODEL: z.string().default('anthropic/claude-sonnet-4.5'),
  FULLENRICH_API_KEY: z.string().min(10).optional(),
  FULLENRICH_BASE_URL: z.string().default('https://app.fullenrich.com/api/v1'),
  FULLENRICH_USD_PER_CREDIT: z.coerce.number().default(0.058),
  TELEGRAM_BOT_TOKEN: z.string().min(20).optional(),
  TELEGRAM_OPERATOR_CHAT_ID: z.string().optional(),
  MUNINN_FIT_THRESHOLD: z.coerce.number().int().min(0).max(100).default(70),
  MUNINN_DIGEST_CRON: z.string().default('0 9 * * *'),
});

export type Config = z.infer<typeof Env> & { degraded: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.parse(env);
  const degraded: string[] = [];
  if (!parsed.SUPABASE_DB_URL) degraded.push('db: SUPABASE_DB_URL missing — pipeline + jobs disabled');
  if (!parsed.FULLENRICH_API_KEY) degraded.push('enrichment: FULLENRICH_API_KEY missing');
  if (!parsed.OPENROUTER_API_KEY) degraded.push('analysis: OPENROUTER_API_KEY missing');
  if (!parsed.TELEGRAM_BOT_TOKEN) degraded.push('telegram: TELEGRAM_BOT_TOKEN missing');
  else if (!parsed.TELEGRAM_OPERATOR_CHAT_ID) degraded.push('telegram: TELEGRAM_OPERATOR_CHAT_ID missing — bot replies with your chat id, then set it');
  return { ...parsed, degraded };
}
