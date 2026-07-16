#!/usr/bin/env node
// Bake real values (domain, Supabase ref, PostHog key, contact, postal) into the
// static site. Re-runnable: current values live in site/site-config.json, and each
// run replaces current → new across the site files, then updates the manifest.
//
//   node scripts/configure-site.mjs --domain antiloki.example --supabase-ref abcdefghij1234567890
//   node scripts/configure-site.mjs --posthog-key phc_XXXX
//   node scripts/configure-site.mjs --contact-email you@antiloki.example --postal "123 Example St #4, City, Country"
//   node scripts/configure-site.mjs --dry-run --domain antiloki.example
//
// Values still at their __MUNINN_*__ placeholders are reported at the end.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HELP = `configure-site — bake deploy values into site/

options:
  --domain <host|origin>     canonical domain, e.g. antiloki.example or https://antiloki.example
  --supabase-ref <ref>       Supabase project ref → also derives the functions base URL
  --functions-base <url>     override the derived https://<ref>.supabase.co/functions/v1
  --posthog-key <phc_...>    PostHog project key
  --posthog-host <url>       PostHog host (default https://us.i.posthog.com)
  --contact-email <email>    contact mailto on the landing footer + privacy page
  --postal <line>            postal line on the privacy page (CAN-SPAM prerequisite)
  --site-dir <path>          site directory (default: <repo>/site — used by tests)
  --dry-run                  report what would change, write nothing
`;

function fail(msg) {
  console.error('error: ' + msg);
  process.exit(1);
}

const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
  if (a === '--dry-run') { opts.dryRun = true; continue; }
  if (!a.startsWith('--')) fail(`unexpected argument: ${a}`);
  const key = a.slice(2);
  const val = args[++i];
  if (val === undefined) fail(`missing value for --${key}`);
  opts[key] = val;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = opts['site-dir'] ? opts['site-dir'] : join(repoRoot, 'site');
const configPath = join(siteDir, 'site-config.json');
const files = ['index.html', 'privacy.html', '_redirects'].map((f) => join(siteDir, f));

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const next = { ...config };

if (opts.domain) {
  const host = opts.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)) {
    fail(`--domain does not look like a hostname: ${opts.domain}`);
  }
  next.origin = 'https://' + host.toLowerCase();
}
if (opts['supabase-ref']) {
  const ref = opts['supabase-ref'].trim();
  if (!/^[a-z0-9-]{10,40}$/.test(ref)) fail(`--supabase-ref does not look like a project ref: ${ref}`);
  next.supabaseRef = ref;
  if (!opts['functions-base']) next.functionsBase = `https://${ref}.supabase.co/functions/v1`;
}
if (opts['functions-base']) next.functionsBase = opts['functions-base'].replace(/\/+$/, '');
if (opts['posthog-key']) next.posthogKey = opts['posthog-key'].trim();
if (opts['posthog-host']) next.posthogHost = opts['posthog-host'].replace(/\/+$/, '');
if (opts['contact-email']) next.contactEmail = opts['contact-email'].trim();
if (opts.postal) next.postalLine = opts.postal.trim();

const changes = Object.keys(next).filter((k) => next[k] !== config[k]);
if (changes.length === 0) {
  console.log('nothing to change — pass at least one option (see --help).');
  reportPlaceholders(next);
  process.exit(0);
}

const contents = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
for (const key of changes) {
  const from = config[key];
  const to = next[key];
  let total = 0;
  for (const [f, text] of contents) {
    const count = text.split(from).length - 1;
    if (count > 0) contents.set(f, text.split(from).join(to));
    total += count;
  }
  const status = total === 0 ? ' (WARNING: current value not found in any site file)' : '';
  console.log(`${key}: ${from} → ${to}   [${total} occurrence${total === 1 ? '' : 's'}]${status}`);
}

if (opts.dryRun) {
  console.log('\n--dry-run: nothing written.');
} else {
  for (const [f, text] of contents) writeFileSync(f, text);
  writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
  console.log(`\nwrote ${files.length} site files + site-config.json`);
}
reportPlaceholders(next);

function reportPlaceholders(cfg) {
  const pending = Object.entries(cfg).filter(([, v]) => typeof v === 'string' && v.includes('__MUNINN_'));
  if (pending.length) {
    console.log('\nstill at placeholders (site works locally, but configure before deploy):');
    for (const [k, v] of pending) console.log(`  · ${k} = ${v}`);
  } else {
    console.log('\nall values configured ✓');
  }
}
