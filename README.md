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
supabase/   migrations + edge functions (waitlist-join · unsub · r)
api/        muninn api — NestJS            (arrives in slice 1)
console/    muninn console — React         (arrives in slice 2)
scripts/    configure-site.mjs — bakes domain / endpoints / keys into site/
test/       node --test suite over the shared edge-function logic
docs/       runbook-slice-0.html — the operator's deploy + warmup runbook
```

## Slice status

| Slice | Ships | Status |
|---|---|---|
| 0 · Unblock | Landing wired + instrumented · Supabase waitlist · warmup runbook | **built — needs operator deploy (runbook)** |
| 1 · The raven flies | ingest → enrich → analyze → Telegram dossier | pending |
| 2 · The console appears | shell + dashboard + CRM + lead drawer | pending |
| 3 · The gate & the send | SendPolicy + sequences + Smartlead + review queue | pending |
| 4 · The loop | control-center + waitlist & waves + referral + digest | pending |
| 5 · Governance | erasure + retention + spend breaker + settings | pending |

## Quickstart

```bash
npm test                      # unit tests for the edge-function core logic (Node 24, zero deps)
node scripts/configure-site.mjs --help   # bake real values into site/ (domain, Supabase ref, PostHog)
```

Deploying slice 0 end-to-end is the operator's runbook: open `docs/runbook-slice-0.html`.

## Rules of this repo

- **Nothing custom deploys to a server.** Public pieces are static files + Supabase Edge
  Functions; operator surfaces bind loopback on the operator machine.
- **Two mail paths, never crossed.** Cold → Smartlead on secondary sending domains.
  Consented (waitlist, invites, digest) → Resend on the canonical domain.
- **Every send passes SendPolicy** (arrives slice 3). Refusals are logged, not remembered.
- **Flagged work is annotated, never silently built** — see § Pendencies in the plan.
  The LinkedIn auto-send adapter (P1) is operator-owned and not scheduled in any slice.
- Zero runtime npm dependencies in this repo until the api lands (slice 1).
