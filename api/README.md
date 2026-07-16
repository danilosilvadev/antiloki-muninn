# muninn api

NestJS service on **loopback `127.0.0.1:41945`** (no auth in v1 — it never leaves the
machine). The full pipeline: `ingest → enrich (FullEnrich) → analyze (OpenRouter) →
dossier → review/approve → SendPolicy → Smartlead → webhooks → reply-pause`. Cold mail
leaves ONLY through Smartlead on secondary domains; the console (slice 2) and Telegram
(slice 1) are the operator surfaces.

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
src/leads/        ingest (normalize/dedupe/suppression-check) · lead view/list/timeline · suggestions inbox
src/enrichment/   fullenrich + apollo adapters (ALL vendor-contract assumptions here) + idempotent step service
src/analysis/     openrouter client · zod acceptance gate · ICP rubric prompt (+ reject-reason steering) · service
src/policy/       SendPolicy — pure ordered gate (send-policy.ts) + the service that gathers reality & logs refusals
src/channels/     smartlead.adapter · sequence machine (approve→push) · reply classifier (labels only)
src/telegram/     fetch-based bot client · console v0 (operator-locked) · dossier + digest renderers
src/jobs/         pg-boss queues + workers + the every-minute tick (drain webhooks · kill switch · health · linkedin-due)
src/http/         controllers: health · leads · stats · suggestions · control (review/approve/pause-all)
src/settings/     keys-on-panel: masked status + atomic .env write + in-place runtime reload
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
