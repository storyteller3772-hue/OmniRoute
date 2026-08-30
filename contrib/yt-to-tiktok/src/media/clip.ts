export interface ClipPlanOptions {
  durationSec: number;
  /** Videos at or under this length are posted whole. */
  thresholdSec: number;
  targetSec: number;
  maxCount: number;
  headTrimSec?: number;
  tailTrimSec?: number;
}

export interface Clip {
  index: number;
  startSec: number;
  durationSec: number;
}

/**
 * Splits a long upload into sequential segments.
 *
 * This is intentionally a naive time-slicer, not a highlight detector: it is
 * predictable, has no per-run cost, and is the right seam to swap for a
 * transcript-driven picker later. A video at or under `thresholdSec` yields a
 * single clip covering the whole thing.
 */
export function planClips(opts: ClipPlanOptions): Clip[] {
  const duration = Number(opts.durationSec);
  if (!Number.isFinite(duration) || duration <= 0) return [];

  if (duration <= opts.thresholdSec) {
    return [{ index: 0, startSec: 0, durationSec: round3(duration) }];
  }

  const head = Math.max(0, opts.headTrimSec ?? 0);
  const tail = Math.max(0, opts.tailTrimSec ?? 0);
  const usable = duration - head - tail;

  // Trims that swallow the video are a misconfiguration; fall back to the
  // whole thing rather than emitting zero clips and silently dropping an upload.
  if (usable < opts.targetSec) {
    return [{ index: 0, startSec: 0, durationSec: round3(Math.min(duration, opts.targetSec)) }];
  }

  const possible = Math.floor(usable / opts.targetSec);
  const count = Math.max(1, Math.min(opts.maxCount, possible));

  const clips: Clip[] = [];
  for (let i = 0; i < count; i++) {
    clips.push({
      index: i,
      startSec: round3(head + i * opts.targetSec),
      durationSec: round3(opts.targetSec),
    });
  }
  return clips;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
