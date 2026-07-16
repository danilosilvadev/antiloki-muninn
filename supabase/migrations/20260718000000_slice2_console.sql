-- ═══════════════════════════════════════════════════════════════════════════
-- slice 2 · console support: reminders (D3) + expansion suggestions (C3)
--
-- Additions over the audit sketch, both driven by approved slice-2 tasks:
--   · reminders — D3's "notes/reminders/book"; mutable done-state doesn't fit
--     the append-only events table, so it gets its own row
--   · lead_suggestions — C3's "find similar → suggestions only, never
--     auto-queued": the inbox the operator accepts (→ ingest) or dismisses
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists reminders (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid references leads not null,
  note       text not null,
  due_at     timestamptz not null,
  done_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists reminders_due_idx on reminders (due_at) where done_at is null;

create table if not exists lead_suggestions (
  id             uuid primary key default gen_random_uuid(),
  source_lead_id uuid references leads not null,
  mode           text not null,                  -- colleagues | lookalike
  name           text,
  title          text,
  company        text,
  linkedin_url   text,                           -- normalized when present
  provider       text not null default 'apollo',
  raw            jsonb not null,                 -- vendor person object, verbatim
  state          text not null default 'pending',-- pending | accepted | dismissed
  lead_id        uuid references leads,          -- set when accepted → ingested
  created_at     timestamptz not null default now()
);
create index if not exists lead_suggestions_state_idx on lead_suggestions (state);
create unique index if not exists lead_suggestions_dedupe_idx
  on lead_suggestions (source_lead_id, linkedin_url) where linkedin_url is not null;

alter table reminders        enable row level security;
alter table lead_suggestions enable row level security;
