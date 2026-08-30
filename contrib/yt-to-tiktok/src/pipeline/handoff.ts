/**
 * Preflight for the handoff publish path.
 *
 * The connector re-hosts the file and TikTok validates it on ingest, and some
 * rejections only surface asynchronously - after a publish slot has been spent
 * and the bytes uploaded. Checking the encoded file locally, against the same
 * limits, turns a slow remote failure into an immediate local one.
 */

export const HANDOFF_LIMITS = {
  minDurationSec: 3,
  maxDurationSec: 600,
  minDimension: 360,
  minFps: 23,
  maxFps: 60,
  maxBytes: 1024 * 1024 * 1024,
  /** `title` on the publish call is capped well below a normal TikTok caption. */
  maxTitleLength: 150,
} as const;

export interface HandoffCandidate {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  bytes: number;
}

/**
 * Returns a human-readable violation per broken rule, empty when the file is
 * publishable. Every message names the observed value and the bound, so the
 * operator can map it straight onto a config change.
 */
export function validateForHandoff(c: HandoffCandidate): string[] {
  const problems: string[] = [];
  const L = HANDOFF_LIMITS;

  if (!Number.isFinite(c.durationSec) || c.durationSec <= 0) {
    problems.push("duration could not be determined from the encoded file");
  } else if (c.durationSec < L.minDurationSec) {
    problems.push(
      `duration ${c.durationSec.toFixed(2)}s is below the ${L.minDurationSec}s minimum - raise CLIP_TARGET_SECONDS or skip very short uploads`
    );
  } else if (c.durationSec > L.maxDurationSec) {
    problems.push(
      `duration ${c.durationSec.toFixed(0)}s exceeds the ${L.maxDurationSec}s maximum - lower CLIP_THRESHOLD_SECONDS so long videos are segmented`
    );
  }

  if (c.width < L.minDimension || c.height < L.minDimension) {
    problems.push(
      `frame ${c.width}x${c.height} has a side below ${L.minDimension}px - raise OUTPUT_WIDTH/OUTPUT_HEIGHT`
    );
  }

  if (!Number.isFinite(c.fps) || c.fps <= 0) {
    problems.push("frame rate could not be determined from the encoded file");
  } else if (c.fps < L.minFps || c.fps > L.maxFps) {
    problems.push(
      `frame rate ${c.fps.toFixed(2)} is outside the ${L.minFps}-${L.maxFps} range - set OUTPUT_FPS within it`
    );
  }

  if (c.bytes > L.maxBytes) {
    problems.push(
      `file is ${(c.bytes / 1024 / 1024).toFixed(0)} MiB, over the ${L.maxBytes / 1024 / 1024} MiB limit - raise VIDEO_CRF or shorten the clip`
    );
  }

  return problems;
}

/** Parses ffprobe's `r_frame_rate` ("30000/1001") into frames per second. */
export function parseFrameRate(raw: string | undefined): number {
  if (!raw) return Number.NaN;
  const [num, den] = raw.split("/");
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return Number.NaN;
  return n / d;
}
