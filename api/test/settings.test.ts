import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEY_DEFS, SettingsService, keyStatuses, upsertEnvFile } from '../src/settings/settings.service';

function tmpEnvPath(initial?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'muninn-env-'));
  const p = join(dir, '.env');
  if (initial !== undefined) writeFileSync(p, initial);
  return p;
}

test('keyStatuses: secrets report configured + length only, never a value', () => {
  const env = {
    OPENROUTER_API_KEY: 'sk-or-supersecret-1234',
    MUNINN_ANALYSIS_MODEL: 'test/model-1',
  } as NodeJS.ProcessEnv;
  const statuses = keyStatuses(env);
  const secret = statuses.find((s) => s.name === 'OPENROUTER_API_KEY')!;
  assert.equal(secret.configured, true);
  assert.equal(secret.value, null);
  assert.equal(secret.length, 'sk-or-supersecret-1234'.length);
  const open = statuses.find((s) => s.name === 'MUNINN_ANALYSIS_MODEL')!;
  assert.equal(open.value, 'test/model-1');
  const missing = statuses.find((s) => s.name === 'FULLENRICH_API_KEY')!;
  assert.equal(missing.configured, false);
  assert.equal(missing.value, null);
  assert.equal(missing.length, null);
  // and no status object ever leaks a secret value under any key
  for (const s of statuses.filter((x) => x.secret)) assert.equal(s.value, null);
});

test('upsertEnvFile: creates, updates in place, preserves comments, appends missing', () => {
  const p = tmpEnvPath('# muninn api env\nOPENROUTER_API_KEY=old-key\nPORT=41945\n');
  upsertEnvFile(p, { OPENROUTER_API_KEY: 'new-key', TELEGRAM_BOT_TOKEN: '123:abc' });
  const text = readFileSync(p, 'utf8');
  assert.match(text, /^# muninn api env$/m);            // comment preserved
  assert.match(text, /^OPENROUTER_API_KEY=new-key$/m);  // replaced in place
  assert.doesNotMatch(text, /old-key/);
  assert.match(text, /^PORT=41945$/m);                  // untouched line preserved
  assert.match(text, /^TELEGRAM_BOT_TOKEN=123:abc$/m);  // appended

  const fresh = tmpEnvPath();
  upsertEnvFile(fresh, { MUNINN_FIT_THRESHOLD: '65' });
  assert.match(readFileSync(fresh, 'utf8'), /^MUNINN_FIT_THRESHOLD=65$/m);
});

test('update: rejects unknown keys, non-strings, newline injection, invalid values', async () => {
  const svc = new SettingsService(tmpEnvPath(), async () => ({ degraded: [], workersActive: false }));
  await assert.rejects(() => svc.update({ EVIL_KEY: 'x' }), /unknown setting/);
  await assert.rejects(() => svc.update({ MUNINN_FIT_THRESHOLD: 42 as unknown as string }), /must be a string/);
  await assert.rejects(
    () => svc.update({ OPENROUTER_API_KEY: 'line1\nMALICIOUS=1' }),
    /single line/,
  );
  await assert.rejects(() => svc.update({ MUNINN_FIT_THRESHOLD: 'not-a-number' }), /invalid value/);
  await assert.rejects(() => svc.update({}), /no settings/);
});

test('update: writes the file, mutates process.env, triggers reload', async () => {
  const p = tmpEnvPath();
  let reloads = 0;
  const svc = new SettingsService(p, async () => {
    reloads++;
    return { degraded: ['x'], workersActive: false };
  });
  const before = process.env.MUNINN_FIT_THRESHOLD;
  try {
    const r = await svc.update({ MUNINN_FIT_THRESHOLD: '65' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.degraded, ['x']);
    assert.equal(reloads, 1);
    assert.equal(process.env.MUNINN_FIT_THRESHOLD, '65');
    assert.match(readFileSync(p, 'utf8'), /^MUNINN_FIT_THRESHOLD=65$/m);
  } finally {
    if (before === undefined) delete process.env.MUNINN_FIT_THRESHOLD;
    else process.env.MUNINN_FIT_THRESHOLD = before;
  }
});

test('every KEY_DEF the panel offers is a single-purpose, named setting', () => {
  const names = KEY_DEFS.map((d) => d.name);
  assert.equal(new Set(names).size, names.length);
  for (const d of KEY_DEFS) {
    assert.ok(d.hint.length > 8, `${d.name} needs a real hint`);
    assert.ok(['core', 'vendors', 'telegram', 'tuning'].includes(d.group));
  }
});
