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
site/       the public static site — landing (index.html), paper, manual, deck, privacy
supabase/   migrations (waitlist + full engine schema) + edge functions (waitlist-join · unsub · r)
api/        muninn api — NestJS :41945 — ingest → enrich → analyze → Telegram dossier
console/    muninn console — Vite+React :5177 — dashboard · leads/CRM · drawer · settings(keys)
scripts/    configure-site.mjs (bakes site values) · unsub-link.mjs (exit-test links)
test/       node --test suite over the shared edge-function logic (api has its own suite)
docs/       runbook-slice-0.html · runbook-slice-1.html — the operator runbooks
```

## Slice status

| Slice | Ships | Status |
|---|---|---|
| 0 · Unblock | Landing wired + instrumented · Supabase waitlist · warmup runbook | **built — needs operator deploy (runbook-slice-0)** |
| 1 · The raven flies | ingest → enrich → analyze → Telegram dossier | **built — needs keys + run (runbook-slice-1)** |
| 2 · The console appears | shell + dashboard + CRM + drawer + **settings/keys panel** | **built — run it (runbook-slice-2)** |
| 3 · The gate & the send | SendPolicy + sequences + Smartlead + review queue | pending |
| 4 · The loop | control-center + waitlist & waves + referral + digest | pending |
| 5 · Governance | erasure + retention + spend breaker + settings | pending |

## Quickstart

```bash
npm test                      # edge-function core logic (Node 24, zero deps)
cd api && npm install && npm test    # api suite: unit + pglite integration over the real migrations
node scripts/configure-site.mjs --help   # bake real values into site/ (domain, Supabase ref, PostHog)
```

Deploying is the operator's half: `docs/runbook-slice-0.html` (funnel + warmup), then
`docs/runbook-slice-2.html` (run api + console, paste keys in Settings, triage from the
UI). `runbook-slice-1.html` covers the Telegram-only path and the day-6 manual-outreach
play — still valid, but the Settings panel now replaces its hand-edited `.env` steps.

## Rules of this repo

- **Nothing custom deploys to a server.** Public pieces are static files + Supabase Edge
  Functions; operator surfaces bind loopback on the operator machine.
- **Two mail paths, never crossed.** Cold → Smartlead on secondary sending domains.
  Consented (waitlist, invites, digest) → Resend on the canonical domain.
- **Every send passes SendPolicy** (arrives slice 3). Refusals are logged, not remembered.
- **Flagged work is annotated, never silently built** — see § Pendencies in the plan.
  The LinkedIn auto-send adapter (P1) is operator-owned and not scheduled in any slice.
- Dependencies stay thin: the repo root has zero; the api carries Nest + drizzle +
  pg-boss + zod only — vendors are plain-fetch adapters with injected `fetchFn`
  (tests can never reach a paid API).
