-- ═══════════════════════════════════════════════════════════════════════════
-- slice 3 · the gate & the send: SendPolicy refusal log, operational flags,
-- campaign mapping, geo on leads, and a processing watermark on events.
--
--   · policy_refusals — "refusals log a reason" (C5); the control-center's
--     refusal log (D6, slice 4) reads this table
--   · ops_flags       — pause_all and friends; DB rows so the kill switch
--     survives an api restart (a slice-4 exit criterion, honored early)
--   · smartlead_campaigns — angle → campaign id, created once per angle
--   · leads.geo       — ISO-2 country resolved from enrichment, feeds the
--     geo gate (DE/CA blocked per the compliance table)
--   · events.processed_at — the api's drain watermark over webhook events;
--     NULL = not yet reacted to. The row itself stays append-only in spirit:
--     the only mutation ever allowed is stamping this one column.
-- ═══════════════════════════════════════════════════════════════════════════

alter table leads add column if not exists geo text;

alter table events add column if not exists processed_at timestamptz;
create index if not exists events_unprocessed_idx on events (at) where processed_at is null;

create table if not exists policy_refusals (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid,
  message_id uuid,
  channel    text not null,
  code       text not null,   -- pause_all | suppressed | no_consent | geo_blocked | daily_cap | quiet_hours | domain_health | not_ready
  reason     text not null,
  context    jsonb,
  at         timestamptz not null default now()
);
create index if not exists policy_refusals_at_idx on policy_refusals (at desc);

create table if not exists ops_flags (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists smartlead_campaigns (
  angle       text primary key,   -- verification | cant_lie | memory | orchestration
  campaign_id text not null,
  created_at  timestamptz not null default now()
);

alter table policy_refusals     enable row level security;
alter table ops_flags           enable row level security;
alter table smartlead_campaigns enable row level security;
