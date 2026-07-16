#!/usr/bin/env node
// Mint a valid unsubscribe link for an email — used by the slice-0 exit test
// and, until the sequencer exists (slice 3), for any manual sends.
//
//   MUNINN_EDGE_SECRET=... node scripts/unsub-link.mjs someone@example.com [functionsBase]
//
// functionsBase defaults to https://$SUPABASE_PROJECT_REF.supabase.co/functions/v1
import { normalizeEmail, unsubToken, unsubUrl } from '../supabase/functions/_shared/core.ts';

const [, , rawEmail, baseArg] = process.argv;
const secret = process.env.MUNINN_EDGE_SECRET;
const ref = process.env.SUPABASE_PROJECT_REF;

const email = normalizeEmail(rawEmail);
if (!email) {
  console.error('usage: MUNINN_EDGE_SECRET=... node scripts/unsub-link.mjs someone@example.com [functionsBase]');
  process.exit(1);
}
if (!secret) {
  console.error('MUNINN_EDGE_SECRET is not set (same value as the deployed function secret).');
  process.exit(1);
}
const base = baseArg ?? (ref ? `https://${ref}.supabase.co/functions/v1` : null);
if (!base) {
  console.error('pass functionsBase as the 2nd arg or set SUPABASE_PROJECT_REF.');
  process.exit(1);
}

console.log(unsubUrl(base, email, await unsubToken(email, secret)));
