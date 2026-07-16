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
  APOLLO_API_KEY: z.string().min(10).optional(),
  APOLLO_BASE_URL: z.string().default('https://api.apollo.io/api/v1'),
  CALENDLY_URL: z.string().optional(),
  SMARTLEAD_API_KEY: z.string().min(10).optional(),
  SMARTLEAD_BASE_URL: z.string().default('https://server.smartlead.ai/api/v1'),
  MUNINN_DAILY_SEND_CAP: z.coerce.number().int().min(1).max(500).default(30),
  MUNINN_QUIET_HOURS: z.string().regex(/^\d{1,2}-\d{1,2}$/).default('20-8'),
  MUNINN_UTC_OFFSET: z.coerce.number().min(-12).max(14).default(-3),
  MUNINN_GEO_BLOCKED: z.string().default('DE,CA'),
  // slice 4 · the loop — consented path (Resend) + wave links + targets
  RESEND_API_KEY: z.string().min(10).optional(),
  RESEND_BASE_URL: z.string().default('https://api.resend.com'),
  MUNINN_INVITE_FROM: z.string().min(3).optional(),
  MUNINN_FUNCTIONS_BASE: z.string().min(10).optional(),
  MUNINN_EDGE_SECRET: z.string().min(8).optional(),
  MUNINN_OPERATOR_EMAIL: z.string().regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/).optional(),
  MUNINN_POSTAL_LINE: z.string().optional(),
  MUNINN_WEEKLY_DIGEST_CRON: z.string().default('0 12 * * 1'),
  MUNINN_MONTHLY_BUDGET_USD: z.coerce.number().min(0).default(280),
  MUNINN_TARGET_COST_PER_POSITIVE: z.coerce.number().min(0).default(25),
  MUNINN_TARGET_REPLY_PCT: z.coerce.number().min(0).default(5.5),
});

export type Config = z.infer<typeof Env> & { degraded: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // empty string = unset, uniformly (panel clears + KEY= lines in .env)
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== ''),
  ) as NodeJS.ProcessEnv;
  const parsed = Env.parse(cleaned);
  const degraded: string[] = [];
  if (!parsed.SUPABASE_DB_URL) degraded.push('db: SUPABASE_DB_URL missing — pipeline + jobs disabled');
  if (!parsed.FULLENRICH_API_KEY) degraded.push('enrichment: FULLENRICH_API_KEY missing');
  if (!parsed.OPENROUTER_API_KEY) degraded.push('analysis: OPENROUTER_API_KEY missing');
  if (!parsed.TELEGRAM_BOT_TOKEN) degraded.push('telegram: TELEGRAM_BOT_TOKEN missing');
  else if (!parsed.TELEGRAM_OPERATOR_CHAT_ID) degraded.push('telegram: TELEGRAM_OPERATOR_CHAT_ID missing — bot replies with your chat id, then set it');
  if (!parsed.SMARTLEAD_API_KEY) degraded.push('sending: SMARTLEAD_API_KEY missing — approvals will be refused (not_ready)');
  if (!parsed.RESEND_API_KEY || !parsed.MUNINN_INVITE_FROM) {
    degraded.push('invites: RESEND_API_KEY / MUNINN_INVITE_FROM missing — wave codes mint, emails skip');
  }
  return { ...parsed, degraded };
}
