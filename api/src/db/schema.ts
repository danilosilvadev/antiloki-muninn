// drizzle mirror of supabase/migrations/*.sql — DDL source of truth stays in
// those SQL files (applied with `supabase db push`); this file only types the
// queries. The pglite integration test runs the real SQL against this mirror,
// so any drift between the two explodes there.
import { integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  linkedinUrl: text('linkedin_url').notNull().unique(),
  status: text('status').notNull().default('new'),
  source: text('source').notNull().default('manual'),
  geo: text('geo'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const leadEnrichments = pgTable('lead_enrichments', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id').notNull(),
  provider: text('provider').notNull(),
  raw: jsonb('raw').notNull(),
  email: text('email'),
  emailStatus: text('email_status'),
  company: jsonb('company'),
  costUsd: numeric('cost_usd'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const leadAnalyses = pgTable('lead_analyses', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id').notNull(),
  fitScore: integer('fit_score').notNull(),
  icp: text('icp').notNull(),
  angle: text('angle'),
  pains: jsonb('pains').notNull(),
  hooks: jsonb('hooks').notNull(),
  briefMd: text('brief_md').notNull(),
  model: text('model').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sequences = pgTable('sequences', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id').notNull(),
  template: text('template').notNull(),
  step: integer('step').notNull().default(0),
  status: text('status').notNull().default('draft'),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id').notNull(),
  sequenceId: uuid('sequence_id'),
  channel: text('channel').notNull(),
  direction: text('direction').notNull().default('out'),
  step: integer('step'),
  subject: text('subject'),
  bodyMd: text('body_md').notNull(),
  status: text('status').notNull().default('draft'),
  providerMessageId: text('provider_message_id'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const consents = pgTable('consents', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id'),
  channel: text('channel').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }),
  source: text('source').notNull(),
});

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  wave: integer('wave').notNull(),
  issuedTo: uuid('issued_to'),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
});

export const vendorCalls = pgTable('vendor_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  kind: text('kind').notNull(),
  leadId: uuid('lead_id'),
  costUsd: numeric('cost_usd'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  meta: jsonb('meta'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

// slice-2 console tables
export const reminders = pgTable('reminders', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id').notNull(),
  note: text('note').notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  doneAt: timestamp('done_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const leadSuggestions = pgTable('lead_suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceLeadId: uuid('source_lead_id').notNull(),
  mode: text('mode').notNull(),
  name: text('name'),
  title: text('title'),
  company: text('company'),
  linkedinUrl: text('linkedin_url'),
  provider: text('provider').notNull().default('apollo'),
  raw: jsonb('raw').notNull(),
  state: text('state').notNull().default('pending'),
  leadId: uuid('lead_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// slice-0 tables the api reads/writes too
export const suppressions = pgTable('suppressions', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email'),
  emailDomain: text('email_domain'),
  linkedinUrl: text('linkedin_url'),
  reason: text('reason').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id'),
  messageId: uuid('message_id'),
  kind: text('kind').notNull(),
  payload: jsonb('payload'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});

// slice-3 gate & send tables
export const policyRefusals = pgTable('policy_refusals', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id'),
  messageId: uuid('message_id'),
  channel: text('channel').notNull(),
  code: text('code').notNull(),
  reason: text('reason').notNull(),
  context: jsonb('context'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

export const opsFlags = pgTable('ops_flags', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const smartleadCampaigns = pgTable('smartlead_campaigns', {
  angle: text('angle').primaryKey(),
  campaignId: text('campaign_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const waitlistMembers = pgTable('waitlist_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  source: text('source'),
  referralCode: text('referral_code').notNull().unique(),
  referredBy: text('referred_by'),
  position: integer('position'),
  invitedAt: timestamp('invited_at', { withTimezone: true }),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  prefs: jsonb('prefs'),
  utm: jsonb('utm'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
