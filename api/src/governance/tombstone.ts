// The tombstone contract (G1): after erasure, the ONLY trace of a person is
// a suppression row holding `sha256:<hex>` of the exact stored value —
// normalized lowercase email, or the normalized linkedin url. Deterministic
// and unsalted on purpose: ingest and SendPolicy must be able to recompute
// it forever, across secret rotations. The migration header documents this.
import { createHash } from 'node:crypto';

export const TOMBSTONE_PREFIX = 'sha256:';

export function tombstoneOf(value: string): string {
  return TOMBSTONE_PREFIX + createHash('sha256').update(value).digest('hex');
}

export function isTombstone(value: string | null): boolean {
  return typeof value === 'string' && value.startsWith(TOMBSTONE_PREFIX);
}
