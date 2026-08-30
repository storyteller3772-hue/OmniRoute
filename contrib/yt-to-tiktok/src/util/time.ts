/** ISO-8601 duration as YouTube reports it: PT1H2M3S, P1DT10M, PT45S, P0D. */
const ISO_DURATION =
  /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Returns whole seconds, or null when the string is not a duration we can trust.
 * Years and months are deliberately unsupported: they are not fixed-length, and
 * a video is never that long - a match on them means we misread the field.
 */
export function parseIso8601Duration(input: string): number | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  // "P" alone, or "PT" alone, carries no duration.
  if (!trimmed || trimmed === "P" || trimmed === "PT") return null;
  const m = ISO_DURATION.exec(trimmed);
  if (!m) return null;
  const [, years, months, weeks, days, hours, minutes, seconds] = m;
  if (years !== undefined || months !== undefined) return null;
  const total =
    num(weeks) * 604800 + num(days) * 86400 + num(hours) * 3600 + num(minutes) * 60 + num(seconds);
  return Math.round(total);
}

function num(v: string | undefined): number {
  return v === undefined ? 0 : Number(v);
}

/**
 * Exponential backoff, exposed without jitter so it can be asserted on. Attempt
 * is 1-based: the delay after the first failure is `baseMs`.
 */
export function backoffMs(attempt: number, baseMs = 30_000, maxMs = 1_800_000): number {
  if (attempt < 1) return baseMs;
  const exp = baseMs * 2 ** (attempt - 1);
  return Math.min(exp, maxMs);
}

/** Adds up to +/-20% jitter so retries from parallel jobs do not synchronise. */
export function jitter(ms: number, rand: () => number = Math.random): number {
  const factor = 0.8 + rand() * 0.4;
  return Math.round(ms * factor);
}

/** SQLite `datetime()`-compatible timestamp, N ms in the future. */
export function sqlTimestampIn(ms: number, now = Date.now()): string {
  return new Date(now + ms).toISOString().replace("T", " ").slice(0, 19);
}

export function ageMinutes(isoTimestamp: string, now = Date.now()): number {
  const t = Date.parse(isoTimestamp);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (now - t) / 60_000;
}
