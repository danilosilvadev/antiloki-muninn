# antiloki-muninn

The GTM engine for antiloki — named for Odin's raven who flies the world and returns
with intelligence. One system, three surfaces:

| Surface | What | Runs on |
|---|---|---|
| **Public** | Landing (wired), publications, privacy, unsubscribe, waitlist endpoints | Static host + Supabase Edge Functions |
| **Always-on** | Postgres system-of-record (waitlist, leads, messages, events, suppressions), job queue, campaign sending | Supabase + Smartlead |
| **Operator** | muninn api (NestJS :41945) + muninn console (React :5177) + Telegram v0 | Operator machine, loopback only |

Companion documents (in the main repo): `antiloki-v3/docs/gtm-audit-and-plan-2026-07-16.html`
(the audit) and `antiloki-v3/docs/muninn-gtm-implementation-plan-2026-07-16.html` (the
six-slice plan this repo implements).

## Layout

```
site/       the public static site — landing (index.html, thank-you v2), paper, manual, deck, privacy
supabase/   migrations (waitlist + engine + gate/send + loop + governance) + edge functions (waitlist-join · unsub · r · webhook-sink · consent · invite · erasure)
api/        muninn api — NestJS :41945 — ingest → enrich → analyze → dossier → SendPolicy → Smartlead · waves + invites (Resend) · governance (erasure/retention/budget)
console/    muninn console — Vite+React :5177 — dashboard · leads · review · control · waitlist · drawer · settings
scripts/    configure-site.mjs (bakes site values) · unsub-link.mjs (exit-test links)
test/       node --test suite over the shared edge-function logic (api has its own suite)
docs/       runbook-slice-0.html … runbook-slice-5.html — the operator runbooks
```

## Slice status

| Slice | Ships | Status |
|---|---|---|
| 0 · Unblock | Landing wired + instrumented · Supabase waitlist · warmup runbook | **built — needs operator deploy (runbook-slice-0)** |
| 1 · The raven flies | ingest → enrich → analyze → Telegram dossier | **built — needs keys + run (runbook-slice-1)** |
| 2 · The console appears | shell + dashboard + CRM + drawer + **settings/keys panel** | **built — run it (runbook-slice-2)** |
| 3 · The gate & the send | SendPolicy + sequences + Smartlead + review queue + webhooks + kill switch | **built — wire Smartlead (runbook-slice-3)** |
| 4 · The loop | control-center + waitlist & waves + referral math + weekly digest + thank-you v2 | **built — wire Resend (runbook-slice-4)** |
| 5 · Governance | erasure (hashed tombstones) + retention clock + spend breaker + export | **built — deploy erasure fn (runbook-slice-5)** |

## Quickstart

```bash
# run it (two terminals — loopback only, boots degraded without keys):
cd api && npm install && npm run build && npm start      # http://127.0.0.1:41945/v1/health
cd console && npm install && npm run dev                 # http://localhost:5177 (strictPort)

# test it:
npm test                      # edge-function core logic (Node 24, zero deps)
cd api && npm test            # api suite: unit + pglite integration over the real migrations
node scripts/configure-site.mjs --help   # bake real values into site/ (domain, Supabase ref, PostHog)
```

**Start here → [`docs/launch-runway.html`](docs/launch-runway.html)** — the operator kit:
five decisions, the exact signup list, the `.env` template, the edge-secrets call,
and the day-by-day path from built to wave 1.

Deploying is the operator's half, runbook by runbook: `docs/runbook-slice-0.html` (funnel
+ warmup) → `runbook-slice-2.html` (run api + console, paste keys, triage from the UI) →
`runbook-slice-3.html` (wire Smartlead + the webhook sink, then approve → send → reply-pause
→ kill switch) → `runbook-slice-4.html` (wire Resend + deploy consent/invite, then wave of
10 → referral moves a position → pause-all survives restart) → `runbook-slice-5.html`
(deploy the erasure endpoint, then erase a seeded person end-to-end and trip the budget
breaker). `runbook-slice-1.html` covers the Telegram-only path and the day-6
manual-outreach play — still valid, but Settings now replaces its hand-edited `.env` steps.

## Rules of this repo

- **Nothing custom deploys to a server.** Public pieces are static files + Supabase Edge
  Functions; operator surfaces bind loopback on the operator machine.
- **Two mail paths, never crossed.** Cold → Smartlead on secondary sending domains.
  Consented (waitlist, invites, digest) → Resend on the canonical domain.
- **Every send passes SendPolicy** (slice 3). Refusals are logged, not remembered.
- **Every paid call passes the budget breaker** (slice 5). Erasure leaves only
  `sha256:` tombstones; retention purges on a clock; secrets stay in `api/.env`
  and Supabase — never in git, never in the console bundle (G4).
- **Flagged work is annotated, never silently built** — see § Pendencies in the plan.
  The LinkedIn auto-send adapter (P1) is operator-owned and not scheduled in any slice.
- Dependencies stay thin: the repo root has zero; the api carries Nest + drizzle +
  pg-boss + zod only — vendors are plain-fetch adapters with injected `fetchFn`
  (tests can never reach a paid API).
