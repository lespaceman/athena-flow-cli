/**
 * Shared timing constants for the permission/question relays.
 *
 * Pending entries older than `PENDING_TTL_MS` with no claim are evicted by a
 * sweep that runs every `SWEEP_INTERVAL_MS`. 15 minutes matches the longest
 * realistic agent-to-human round-trip; the sweep keeps the eviction
 * granularity coarse enough that timer load is negligible.
 */
export const PENDING_TTL_MS = 15 * 60 * 1000;
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
