-- ═══════════════════════════════════════════════════════════════════════════
-- slice 0 · the waitlist backbone (B1 subset) + RLS posture (B2)
--
-- Ships the three tables slice 0 actually touches. The remaining engine
-- tables (leads, lead_enrichments, lead_analyses, sequences, messages,
-- consents, invites) land with slice 1 (B1 full), matching the audit schema.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists waitlist_members (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,            -- normalized (lowercased, trimmed) by waitlist-join
  name          text,
  source        text,                            -- landing | landing:ref | manual
  referral_code text unique not null default substr(md5(random()::text), 1, 8),
  referred_by   text,                            -- referral_code of the referrer, shape-validated only
                                                 -- (referral math + validation land in slice 4 / C10)
  position      serial,                          -- "operator #N" — real join order, gaps possible, never faked
  invited_at    timestamptz,
  activated_at  timestamptz,
  prefs         jsonb not null default '{}',
  utm           jsonb not null default '{}',     -- utm_* + referrer captured at join (A1/A4)
  created_at    timestamptz not null default now()
);

create table if not exists suppressions (
  id           uuid primary key default gen_random_uuid(),
  email        text,
  email_domain text,
  linkedin_url text,
  reason       text not null,                    -- unsub | bounce | complaint | manual | geo_policy
  at           timestamptz not null default now()
);
create index if not exists suppressions_email_idx on suppressions (email);

-- the outreach audit chain: every join, referral visit and unsub is a row here.
-- Slice 3's webhook-sink appends delivered|open|click|reply|bounce|complaint.
create table if not exists events (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid,                               -- FK arrives with the leads table (slice 1)
  message_id uuid,
  kind       text not null,                      -- waitlist_join | referral_visit | unsub | ...
  payload    jsonb,
  at         timestamptz not null default now()
);
create index if not exists events_kind_at_idx on events (kind, at desc);

-- ── RLS posture (B2) ─────────────────────────────────────────────────────────
-- Deny-all: RLS enabled, zero policies. The ONLY write path is the edge
-- functions (service role, bypasses RLS), so honeypot / rate-limit / dedupe
-- cannot be sidestepped with the public anon key.
--
-- Deliberate deviation from the audit's "anon insert-only" sketch: that sketch
-- assumed the landing inserting directly via supabase-js; the approved plan
-- (A1) routes joins through the waitlist-join edge function instead, and an
-- anon insert policy would have left a second, ungoverned write path open.
alter table waitlist_members enable row level security;
alter table suppressions     enable row level security;
alter table events           enable row level security;
