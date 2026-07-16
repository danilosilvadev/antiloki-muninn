// One wiring point. Every subsystem is optional by config; whatever is missing
// is named in cfg.degraded, printed at boot and served by /v1/health.
import type PgBoss from 'pg-boss';
import type { Config } from './config/config';
import { createDb, type Db } from './db/db';
import { AnalysisService } from './analysis/analysis.service';
import { OpenRouterClient } from './analysis/openrouter.client';
import { EnrichmentService } from './enrichment/enrichment.service';
import { FullEnrichAdapter } from './enrichment/fullenrich.adapter';
import { ApolloAdapter } from './enrichment/apollo.adapter';
import { QUEUES, startBoss } from './jobs/boss';
import { registerWorkers } from './jobs/workers';
import { LeadsService } from './leads/leads.service';
import { SuggestionsService } from './leads/suggestions.service';
import { buildDigest } from './telegram/digest';
import { renderDossier } from './telegram/dossier';
import { TelegramClient } from './telegram/telegram.client';
import { TelegramService } from './telegram/telegram.service';

export interface Runtime {
  cfg: Config;
  db: Db | null;
  endDb: (() => Promise<void>) | null;
  boss: PgBoss | null;
  leads: LeadsService | null;
  suggestions: SuggestionsService | null;
  telegram: TelegramService | null;
  workersActive: boolean;
}

export async function stopRuntime(rt: Runtime): Promise<void> {
  try {
    rt.telegram?.stop();
  } catch { /* best effort */ }
  try {
    if (rt.boss) await rt.boss.stop();
  } catch { /* best effort */ }
  try {
    if (rt.endDb) await rt.endDb();
  } catch { /* best effort */ }
}

// Settings updates hot-swap the runtime: stop everything, rebuild from the
// fresh env, and mutate the SAME object the controllers hold by reference.
export async function reloadRuntime(
  rt: Runtime,
  loadCfg: () => Config,
): Promise<{ degraded: string[]; workersActive: boolean }> {
  await stopRuntime(rt);
  const fresh = await buildRuntime(loadCfg());
  Object.assign(rt, fresh);
  console.log('[runtime] reloaded — degraded:', rt.cfg.degraded.length ? rt.cfg.degraded.join(' | ') : 'none');
  return { degraded: rt.cfg.degraded, workersActive: rt.workersActive };
}

export async function buildRuntime(cfg: Config): Promise<Runtime> {
  let db: Db | null = null;
  let endDb: (() => Promise<void>) | null = null;
  let boss: PgBoss | null = null;
  let leads: LeadsService | null = null;
  let suggestions: SuggestionsService | null = null;
  let telegram: TelegramService | null = null;
  let workersActive = false;

  if (cfg.SUPABASE_DB_URL) {
    const created = createDb(cfg.SUPABASE_DB_URL);
    db = created.db;
    endDb = created.end;
    boss = await startBoss(cfg.SUPABASE_DB_URL);
    leads = new LeadsService(db, boss);
    const apollo = cfg.APOLLO_API_KEY
      ? new ApolloAdapter({ apiKey: cfg.APOLLO_API_KEY, baseUrl: cfg.APOLLO_BASE_URL })
      : null;
    suggestions = new SuggestionsService(db, apollo, leads);
  }

  const tgClient = cfg.TELEGRAM_BOT_TOKEN ? new TelegramClient({ token: cfg.TELEGRAM_BOT_TOKEN }) : null;
  const chatId = cfg.TELEGRAM_OPERATOR_CHAT_ID ?? null;
  const notify = async (html: string): Promise<void> => {
    if (tgClient && chatId) {
      try {
        await tgClient.sendMessage(chatId, html);
        return;
      } catch (e) {
        console.error('[notify] telegram send failed:', e instanceof Error ? e.message : e);
      }
    }
    console.log('[notify]', html.replace(/<[^>]+>/g, ''));
  };

  if (db && boss && leads) {
    const enrichment = cfg.FULLENRICH_API_KEY
      ? new EnrichmentService(
          db,
          new FullEnrichAdapter({
            apiKey: cfg.FULLENRICH_API_KEY,
            baseUrl: cfg.FULLENRICH_BASE_URL,
            usdPerCredit: cfg.FULLENRICH_USD_PER_CREDIT,
          }),
        )
      : null;
    const analysis = cfg.OPENROUTER_API_KEY
      ? new AnalysisService(
          db,
          new OpenRouterClient({
            apiKey: cfg.OPENROUTER_API_KEY,
            baseUrl: cfg.OPENROUTER_BASE_URL,
            model: cfg.MUNINN_ANALYSIS_MODEL,
          }),
          cfg.MUNINN_FIT_THRESHOLD,
        )
      : null;

    if (enrichment && analysis) {
      const leadsSvc = leads;
      await registerWorkers({
        db,
        boss,
        enrichment,
        analysis,
        notify,
        sendDossier: async (leadId, violations) => {
          const view = await leadsSvc.view(leadId);
          if (!view) return;
          const { html, keyboard } = renderDossier(view, violations);
          if (tgClient && chatId) await tgClient.sendMessage(chatId, html, keyboard);
          else console.log('[dossier]\n' + html.replace(/<[^>]+>/g, ''));
        },
        digest: async () => {
          await notify(await buildDigest(db!));
        },
      });
      await boss.schedule(QUEUES.digest, cfg.MUNINN_DIGEST_CRON);
      workersActive = true;
    } else {
      console.warn('[runtime] workers NOT registered — vendor keys missing (see /v1/health degraded list)');
    }
  }

  if (tgClient) {
    telegram = new TelegramService({
      client: tgClient,
      operatorChatId: chatId,
      pipelineReady: workersActive,
      degraded: cfg.degraded,
      ingest: leads ? (url) => leads!.ingest(url, 'telegram') : null,
      setStatus: leads ? (id, status, note) => leads!.setStatus(id, status, note) : null,
      saveNote: leads ? (id, note) => leads!.saveNote(id, note) : null,
      digest: db ? () => buildDigest(db!) : null,
    });
    telegram.start();
  }

  return { cfg, db, endDb, boss, leads, suggestions, telegram, workersActive };
}
