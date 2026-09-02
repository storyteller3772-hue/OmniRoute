import type { VerticalMode } from "./filters.js";

/**
 * Chooses the cheapest correct way to produce a publishable file.
 *
 * Re-encoding a clip that is already the right shape and codec costs real time
 * and a generation of quality for no benefit: with a 9:16 source the blur
 * graph scales the foreground to exactly cover the background it just built.
 * When nothing actually needs to change, the file should be remuxed, not
 * re-encoded.
 */

export interface SourceFacts {
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec: string;
}

export interface PlanTarget {
  width: number;
  height: number;
  /** blur/crop/pad always reframe; "auto" reframes only when the aspect differs; "none" never does. */
  verticalMode: VerticalMode | "auto" | "none";
  /** Strategy used when "auto" decides a reframe IS needed. */
  autoReframeMode: VerticalMode;
  loudnessEnabled: boolean;
  clip?: { startSec: number; durationSec: number };
}

export type EncodePlan =
  /** Remux only: change the container, touch no streams. */
  | { kind: "copy"; reason: string }
  /** Keep the video stream untouched, re-encode audio (loudness or codec). */
  | { kind: "audio-only"; reason: string }
  /** Full re-encode through the filtergraph. */
  | { kind: "reframe"; mode: VerticalMode; reason: string };

/** TikTok accepts H.264 video with AAC audio in MP4. */
const VIDEO_OK = new Set(["h264", "avc1"]);
const AUDIO_OK = new Set(["aac"]);

/** Widest frame rate window the downstream publishers accept. */
const FPS_MIN = 23;
const FPS_MAX = 60;
const MIN_DIMENSION = 360;

/** 9:16 is 0.5625; a hair of tolerance absorbs 1080x1919-style rounding. */
const ASPECT_TOLERANCE = 0.01;

export function aspectMatches(src: SourceFacts, target: PlanTarget): boolean {
  if (src.width <= 0 || src.height <= 0 || target.height <= 0) return false;
  return Math.abs(src.width / src.height - target.width / target.height) <= ASPECT_TOLERANCE;
}

export function decideEncodePlan(src: SourceFacts, target: PlanTarget): EncodePlan {
  const mode = target.verticalMode;

  // An explicit framing choice is an instruction, not a hint - honour it.
  const reframeRequested =
    mode === "blur" || mode === "crop" || mode === "pad"
      ? true
      : mode === "auto"
        ? !aspectMatches(src, target)
        : false;

  const reframeMode: VerticalMode =
    mode === "blur" || mode === "crop" || mode === "pad" ? mode : target.autoReframeMode;

  const reasons: string[] = [];
  if (reframeRequested) {
    reasons.push(
      mode === "auto"
        ? `source ${src.width}x${src.height} is not ${target.width}:${target.height}`
        : `VERTICAL_MODE=${mode}`
    );
  }
  // A stream copy cuts at keyframes, so any clip has to be re-encoded to land
  // on the intended frame.
  if (target.clip) reasons.push("clip requires frame-accurate cutting");
  if (!VIDEO_OK.has(src.videoCodec)) reasons.push(`video codec ${src.videoCodec || "unknown"}`);
  if (!Number.isFinite(src.fps) || src.fps < FPS_MIN || src.fps > FPS_MAX) {
    reasons.push(`frame rate ${Number.isFinite(src.fps) ? src.fps.toFixed(2) : "unknown"}`);
  }
  if (src.width < MIN_DIMENSION || src.height < MIN_DIMENSION) {
    reasons.push(`frame ${src.width}x${src.height} below ${MIN_DIMENSION}px`);
  }

  if (reasons.length) {
    return { kind: "reframe", mode: reframeMode, reason: reasons.join("; ") };
  }

  const audioReasons: string[] = [];
  if (src.hasAudio && target.loudnessEnabled) audioReasons.push("loudness normalisation");
  if (src.hasAudio && !AUDIO_OK.has(src.audioCodec)) {
    audioReasons.push(`audio codec ${src.audioCodec || "unknown"}`);
  }

  if (audioReasons.length) {
    return { kind: "audio-only", reason: audioReasons.join("; ") };
  }

  return {
    kind: "copy",
    reason: `already ${src.width}x${src.height} h264/${src.hasAudio ? src.audioCodec : "silent"} at ${src.fps.toFixed(0)}fps`,
  };
}

/** Remux to MP4 with a streamable header. No stream is decoded. */
export function buildCopyArgs(input: string, output: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-y",
    "-i", input,
    "-c", "copy",
    "-movflags", "+faststart",
    output,
  ];
}

/** Keep the video stream byte-for-byte; re-encode audio only. */
export function buildAudioOnlyArgs(
  input: string,
  output: string,
  o: { audioFilter?: string; audioBitrate: string }
): string[] {
  const args = ["-hide_banner", "-nostdin", "-y", "-i", input, "-c:v", "copy"];
  if (o.audioFilter) args.push("-af", o.audioFilter);
  args.push(
    "-c:a", "aac",
    "-b:a", o.audioBitrate,
    "-ar", "48000",
    "-ac", "2",
    "-movflags", "+faststart",
    output
  );
  return args;
}
