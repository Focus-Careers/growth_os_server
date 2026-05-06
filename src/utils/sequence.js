const STANDARD_DELAYS = [0, 3, 5, 7, 10, 14, 18, 22];

function hasValidDelays(sequence) {
  return sequence.every((email, i) => i === 0 || email.delay_in_days > sequence[i - 1].delay_in_days);
}

/**
 * Ensures sequence delays are strictly increasing.
 * If any duplicates or out-of-order values are found, replaces all delays
 * with the standard pattern while preserving email content.
 */
export function fixSequenceDelays(sequence) {
  if (!sequence?.length) return sequence;
  if (hasValidDelays(sequence)) return sequence;

  const original = sequence.map(s => s.delay_in_days).join(', ');
  const fixed = sequence.map((email, i) => ({
    ...email,
    delay_in_days: i < STANDARD_DELAYS.length
      ? STANDARD_DELAYS[i]
      : STANDARD_DELAYS[STANDARD_DELAYS.length - 1] + (i - STANDARD_DELAYS.length + 1) * 4,
  }));
  const corrected = fixed.map(s => s.delay_in_days).join(', ');
  console.warn(`[sequence] Fixed non-increasing delays: [${original}] → [${corrected}]`);
  return fixed;
}
