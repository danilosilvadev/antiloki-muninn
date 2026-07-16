// muninn api — loopback only (127.0.0.1), like antiloki-BE. No auth in v1:
// the operator surface never leaves the machine; the console (slice 2) talks
// to this, never to Supabase directly.
import 'reflect-metadata';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig, loadDotEnv } from './config/config';
import { buildRuntime, reloadRuntime, stopRuntime } from './runtime';
import { SettingsService } from './settings/settings.service';

async function main(): Promise<void> {
  const apiRoot = join(__dirname, '..', '..'); // running from dist/src
  loadDotEnv(apiRoot);
  const cfg = loadConfig();
  const rt = await buildRuntime(cfg);
  const settings = new SettingsService(join(apiRoot, '.env'), () => reloadRuntime(rt, loadConfig));

  const app = await NestFactory.create(AppModule.register(rt, settings), { logger: ['log', 'warn', 'error'] });
  app.setGlobalPrefix('v1');
  // the console is the only browser caller — strict allowlist, loopback origins only
  app.enableCors({ origin: ['http://localhost:5177', 'http://127.0.0.1:5177'] });
  await app.listen(cfg.PORT, '127.0.0.1');

  console.log(`\n🐦 muninn api · http://127.0.0.1:${cfg.PORT}/v1/health`);
  if (cfg.degraded.length) {
    console.warn('DEGRADED:\n  - ' + cfg.degraded.join('\n  - '));
  } else {
    console.log('all subsystems configured — the raven flies');
  }

  let closing = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`\n[${sig}] shutting down…`);
    await stopRuntime(rt);
    try {
      await app.close();
    } catch { /* best effort */ }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('fatal boot error:', e);
  process.exit(1);
});
