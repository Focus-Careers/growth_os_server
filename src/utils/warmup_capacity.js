/**
 * Estimated daily sending capacity for a warming mailbox.
 * Capacity ramp (not a gate): mailboxes ACTIVE from day 1, capacity grows.
 *   Day 1:  ~10
 *   Week 1: ~15–25
 *   Week 2: ~30–40
 *   Week 3+: 50 (ceiling)
 * Formula: min(50, 8 + daysSinceWarmup * 2)
 */
export function estimateCapacity(warmupStartedAt, now = new Date()) {
  if (!warmupStartedAt) return 50; // no warmup tracked → assume ceiling
  const startMs = new Date(warmupStartedAt).getTime();
  if (Number.isNaN(startMs)) return 50;
  const days = Math.max(0, Math.floor((now.getTime() - startMs) / (1000 * 60 * 60 * 24)));
  return Math.min(50, 8 + days * 2);
}

/**
 * Sum of capacities across a list of senders. Each `sender.warmup_started_at` may be null.
 */
export function sumCapacity(senders, now = new Date()) {
  return (senders ?? []).reduce((total, s) => total + estimateCapacity(s.warmup_started_at, now), 0);
}
