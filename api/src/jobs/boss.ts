// pg-boss on the same Supabase Postgres (B4) — delayed jobs, retries, cron,
// zero extra vendor. Queues are created idempotently at boot.
import PgBoss from 'pg-boss';

export const QUEUES = {
  enrich: 'muninn-enrich',
  analyze: 'muninn-analyze',
  digest: 'muninn-digest',
  sequenceTick: 'muninn-sequence-tick', // consumed from slice 3; created now per B4
  weeklyDigest: 'muninn-weekly-digest', // slice 4 · C11 — the targets digest
  retention: 'muninn-retention', // slice 5 · G2 — the retention clock
} as const;

export async function startBoss(dbUrl: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: dbUrl, max: 3 });
  boss.on('error', (e) => console.error('[boss]', e));
  await boss.start();
  for (const q of Object.values(QUEUES)) {
    try {
      await boss.createQueue(q);
    } catch {
      /* queue already exists */
    }
  }
  return boss;
}
