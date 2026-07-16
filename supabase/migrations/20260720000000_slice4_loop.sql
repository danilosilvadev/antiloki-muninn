-- ═══════════════════════════════════════════════════════════════════════════
-- slice 4 · the loop: waves + invites machinery (C10), consent capture from
-- the thank-you page (A8), and per-angle sequence timing templates (D6).
--
--   · waves — one row per invite wave: size is the slot count, opens_at the
--     (soft) date blocking-decision #5 names. invites.wave stays a plain int
--     (no FK) so a backfilled code can precede its wave row.
--   · invites.issued_at — when the code was minted + emailed. redeemed_at
--     (slice 1) keeps meaning "the person clicked their invite link";
--     activation stays on waitlist_members.activated_at, operator-confirmed.
--   · consents.email / handle — the thank-you page grants consent BEFORE any
--     lead exists, keyed by waitlist email; handle carries the WhatsApp
--     number / Telegram username the person volunteered. Opt-in only (P6).
--   · sequence_templates — per-angle step delays (delay-in-days per email
--     step) the control-center editor writes and ensureCampaign reads at
--     campaign-creation time. Words stay per-lead; only timing lives here.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists waves (
  wave       int primary key,
  label      text,
  opens_at   timestamptz,
  size       int not null check (size > 0),
  created_at timestamptz not null default now()
);

alter table invites  add column if not exists issued_at timestamptz not null default now();
create index if not exists invites_wave_idx on invites (wave);

alter table consents add column if not exists email  text;
alter table consents add column if not exists handle text;
create index if not exists consents_channel_idx on consents (channel);

create table if not exists sequence_templates (
  angle      text primary key,   -- verification | cant_lie | memory | orchestration
  delays     jsonb not null,     -- [0, 6, 6] — delay-in-days per email step
  updated_at timestamptz not null default now()
);

-- Same RLS posture as every slice: deny-all, service-role-only writers.
alter table waves              enable row level security;
alter table sequence_templates enable row level security;
