-- ═══════════════════════════════════════════════════════════════════════════
-- slice 1 · the engine tables (B1 full) + the vendor cost ledger (C2)
--
-- Completes the audit schema: every lead, every touch, every consent, every
-- refusal is a row. Additions over the audit sketch, each deliberate:
--   · leads.updated_at / leads.last_error — operational sanity for the pipeline
--   · vendor_calls — the per-call cost ledger C2 requires ("cost ledger per
--     call"); slice 5's spend circuit-breaker (G3) reads its sums
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists leads (
  id           uuid primary key default gen_random_uuid(),
  linkedin_url text unique not null,             -- normalized: https://www.linkedin.com/in/<slug>
  status       text not null default 'new',      -- new→enriched→analyzed→queued→in_sequence→replied→call→partner|parked|suppressed
  source       text not null default 'manual',   -- manual | telegram | expand:<lead_id> | waitlist
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists leads_status_idx on leads (status);

create table if not exists lead_enrichments (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid references leads not null,
  provider     text not null,                    -- fullenrich | apollo (slice 2) | ...
  raw          jsonb not null,                   -- vendor response, verbatim — the contract-drift insurance
  email        text,
  email_status text,                             -- verified | catch_all | not_found
  company      jsonb,
  cost_usd     numeric(8,4),
  created_at   timestamptz not null default now()
);
create index if not exists lead_enrichments_lead_idx on lead_enrichments (lead_id);

create table if not exists lead_analyses (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid references leads not null,
  fit_score  int not null check (fit_score between 0 and 100),
  icp        text not null,                      -- agency_owner | cto_ai_startup | ai_native_builder | other
  angle      text,                               -- verification | cant_lie | memory | orchestration
  pains      jsonb not null,                     -- [{pain, evidence, source}] — evidence-cited or absent
  hooks      jsonb not null,                     -- [{hook, evidence}]
  brief_md   text not null,                      -- the human-readable dossier
  model      text not null,
  created_at timestamptz not null default now()
);
create index if not exists lead_analyses_lead_idx on lead_analyses (lead_id);

create table if not exists sequences (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid references leads not null,
  template    text not null,                     -- the angle the drafts follow
  step        int not null default 0,
  status      text not null default 'draft',     -- draft→approved→running→done|stopped
  next_run_at timestamptz
);
create index if not exists sequences_lead_idx on sequences (lead_id);

create table if not exists messages (
  id                  uuid primary key default gen_random_uuid(),
  lead_id             uuid references leads not null,
  sequence_id         uuid references sequences,
  channel             text not null check (channel in ('email','linkedin','whatsapp','telegram')),
  direction           text not null default 'out',
  step                int,                       -- 0=day0 email · 1=day3 linkedin · 2=day6 email · 3=day12 breakup
  subject             text,
  body_md             text not null,
  status              text not null default 'draft',  -- draft→approved→scheduled→sent→failed
  provider_message_id text,
  sent_at             timestamptz,
  created_at          timestamptz not null default now()
);
create index if not exists messages_lead_idx on messages (lead_id);
create index if not exists messages_status_idx on messages (status);

create table if not exists consents (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid,
  channel    text not null,                      -- whatsapp | telegram | email
  granted_at timestamptz,
  source     text not null                       -- thank-you page (slice 4) | manual
);

create table if not exists invites (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  wave        int not null,
  issued_to   uuid references waitlist_members,
  redeemed_at timestamptz
);

-- the per-call vendor cost ledger (C2). One row per outbound vendor call,
-- success or failure — slice 5's budget breaker halts on sum(cost_usd).
create table if not exists vendor_calls (
  id         uuid primary key default gen_random_uuid(),
  provider   text not null,                      -- fullenrich | openrouter | apollo | smartlead | resend
  kind       text not null,                      -- enrich_start | enrich_poll | analyze | ...
  lead_id    uuid,
  cost_usd   numeric(10,6),
  tokens_in  int,
  tokens_out int,
  meta       jsonb,
  at         timestamptz not null default now()
);
create index if not exists vendor_calls_provider_at_idx on vendor_calls (provider, at desc);

-- Same RLS posture as slice 0: deny-all, service-role-only. The muninn api and
-- the edge functions are the only writers; the console (slice 2) goes through
-- the api, never through Supabase directly.
alter table leads            enable row level security;
alter table lead_enrichments enable row level security;
alter table lead_analyses    enable row level security;
alter table sequences        enable row level security;
alter table messages         enable row level security;
alter table consents         enable row level security;
alter table invites          enable row level security;
alter table vendor_calls     enable row level security;
