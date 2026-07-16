// muninn api — loopback only (127.0.0.1), like antiloki-BE. No auth in v1:
// the operator surface never leaves the machine; the console (slice 2) talks
// to this, never to Supabase directly.
import 'reflect-metadata';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig, loadDotEnv } from './config/config';
import { buildRuntime } from './runtime';

async function main(): Promise<void> {
  loadDotEnv(join(__dirname, '..', '..')); // api/.env (running from dist/src)
  const cfg = loadConfig();
  const rt = await buildRuntime(cfg);

  const app = await NestFactory.create(AppModule.register(rt), { logger: ['log', 'warn', 'error'] });
  app.setGlobalPrefix('v1');
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
    try {
      rt.telegram?.stop();
    } catch { /* best effort */ }
    try {
      if (rt.boss) await rt.boss.stop();
    } catch { /* best effort */ }
    try {
      if (rt.endDb) await rt.endDb();
    } catch { /* best effort */ }
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
