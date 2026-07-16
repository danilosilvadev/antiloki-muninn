# muninn api — slice 1: the raven flies

NestJS service on **loopback `127.0.0.1:41945`** (no auth in v1 — it never leaves the
machine). One field in, a dossier out: `ingest → enrich (FullEnrich) → analyze
(OpenRouter) → Telegram dossier` with ✅ queue / ✏️ note / ❌ park buttons. **No sending
exists here** — sequencing + SendPolicy are slice 3.

## Run

```bash
cd api
npm install
cp ../.env.example .env        # keep the [api] lines, fill the keys (see docs/runbook-slice-1.html)
npm run build && npm start     # → http://127.0.0.1:41945/v1/health
npm test                       # 44 tests: unit + a pglite integration run of the real migrations
```

Missing keys degrade the api instead of killing it — `/v1/health` and the boot banner
name every disabled subsystem.

## HTTP surface (minimal by design — Telegram is the v0 console)

| Route | What |
|---|---|
| `GET /v1/health` | `{ok, db, jobs, workers, telegram, degraded[]}` |
| `POST /v1/leads` | `{linkedin_url}` → 202 `{lead_id}` · 409 suppressed · 400 invalid |
| `GET /v1/leads/:id` | lead + latest enrichment + analysis + the 4 drafts |

## Map

```
src/config/       zod env, .env loader, degraded-mode semantics
src/db/           drizzle schema (mirror of supabase/migrations — DDL lives THERE) + client
src/leads/        URL normalize/dedupe/suppression-check ingest + the lead view
src/enrichment/   fullenrich.adapter (ALL vendor-contract assumptions live here) + idempotent step service
src/analysis/     openrouter client · zod acceptance gate (accept → retry once → fail loud) · ICP rubric prompt · service
src/telegram/     fetch-based bot client · console v0 (operator-locked) · dossier + digest renderers
src/jobs/         pg-boss queues (muninn-enrich/analyze/digest/sequence-tick) + workers
src/runtime.ts    the single wiring point — every subsystem optional by config
```

Conventions carried from the substrate: vendors behind thin adapters with injected
`fetchFn` (tests can never reach a paid API — the constructors throw under the test
runner otherwise); model names come from env, never call sites; every vendor call lands
a `vendor_calls` ledger row; every stage appends an `events` row.

## FullEnrich contract note

The bulk-enrich request/poll shapes in `fullenrich.adapter.ts` are written from vendor
docs and mapped defensively (`mapPollResponse` tolerates several field spellings; the
raw response is stored verbatim on `lead_enrichments.raw`). The first live call — exit
test step in the runbook — is the contract verification. If FullEnrich changed shapes,
only that one file changes.
