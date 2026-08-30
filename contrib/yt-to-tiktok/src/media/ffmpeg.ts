import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import {
  buildLoudnormAnalysisFilter,
  buildLoudnormApplyFilter,
  buildVerticalVideoFilter,
  type LoudnormMeasured,
  type LoudnormTargets,
  type VerticalMode,
} from "./filters.js";

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderrTail: string
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

/**
 * Runs a binary with an argv ARRAY - never a shell string. No value taken from
 * a feed, a filename, or config is ever concatenated into a command line.
 */
export function run(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ?? process.env,
    });

    let stdout = "";
    let stderr = "";
    // FFmpeg writes progress to stderr; keep only the tail so a long encode
    // cannot grow this unbounded.
    const cap = 64 * 1024;

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > cap) stdout = stdout.slice(-cap);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > cap) stderr = stderr.slice(-cap);
    });

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new FfmpegError(`${bin} timed out after ${opts.timeoutMs}ms`, null, stderr.slice(-4000)));
      }, opts.timeoutMs);
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(
        new FfmpegError(
          `failed to spawn ${bin}: ${(err as Error).message}. Is it installed and on PATH?`,
          null,
          ""
        )
      );
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new FfmpegError(`${bin} exited with code ${code}`, code, stderr.slice(-4000)));
    });
  });
}

export async function probe(ffprobePath: string, file: string): Promise<ProbeResult> {
  const { stdout } = await run(ffprobePath, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
  };

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  const duration = Number(parsed.format?.duration ?? video?.duration ?? 0);

  return {
    durationSec: Number.isFinite(duration) ? duration : 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
  };
}

/** Parses the JSON block FFmpeg's loudnorm prints to stderr on the analysis pass. */
export function parseLoudnormJson(stderr: string): LoudnormMeasured | null {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const obj = JSON.parse(stderr.slice(start, end + 1)) as Partial<LoudnormMeasured>;
    if (
      obj.input_i === undefined ||
      obj.input_tp === undefined ||
      obj.input_lra === undefined ||
      obj.input_thresh === undefined ||
      obj.target_offset === undefined
    ) {
      return null;
    }
    return obj as LoudnormMeasured;
  } catch {
    return null;
  }
}

export async function measureLoudness(
  ffmpegPath: string,
  file: string,
  targets: LoudnormTargets,
  clip?: { startSec: number; durationSec: number }
): Promise<LoudnormMeasured | null> {
  const args = ["-hide_banner", "-nostdin"];
  if (clip) args.push("-ss", String(clip.startSec));
  args.push("-i", file);
  if (clip) args.push("-t", String(clip.durationSec));
  args.push("-af", buildLoudnormAnalysisFilter(targets), "-f", "null", "-");

  try {
    const { stderr } = await run(ffmpegPath, args);
    return parseLoudnormJson(stderr);
  } catch {
    // Measurement is an optimisation, not a requirement - pass 2 can still run
    // in dynamic mode.
    return null;
  }
}

export interface TranscodeOptions {
  input: string;
  output: string;
  mode: VerticalMode;
  width: number;
  height: number;
  fps: number;
  crf: number;
  preset: string;
  audioBitrate: string;
  padColor: string;
  hasAudio: boolean;
  clip?: { startSec: number; durationSec: number };
  loudness?: { targets: LoudnormTargets; measured: LoudnormMeasured | null } | null;
}

/**
 * Assembles the encode argv. Kept pure and exported so the filtergraph and flag
 * set can be asserted in tests without invoking FFmpeg.
 */
export function buildTranscodeArgs(o: TranscodeOptions): string[] {
  const graphs = [buildVerticalVideoFilter({
    mode: o.mode,
    width: o.width,
    height: o.height,
    padColor: o.padColor,
  })];

  if (o.hasAudio && o.loudness) {
    graphs.push(`[0:a]${buildLoudnormApplyFilter(o.loudness.targets, o.loudness.measured)}[a]`);
  }

  const args = ["-hide_banner", "-nostdin", "-y"];

  // Input-side seek: fast, and still frame-accurate because the output is
  // re-encoded rather than stream-copied.
  if (o.clip) args.push("-ss", String(o.clip.startSec));
  args.push("-i", o.input);
  if (o.clip) args.push("-t", String(o.clip.durationSec));

  args.push("-filter_complex", graphs.join(";"), "-map", "[v]");

  if (o.hasAudio) {
    args.push("-map", o.loudness ? "[a]" : "0:a:0");
    args.push("-c:a", "aac", "-b:a", o.audioBitrate, "-ar", "48000", "-ac", "2");
  } else {
    args.push("-an");
  }

  args.push(
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-preset",
    o.preset,
    "-crf",
    String(o.crf),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(o.fps),
    "-movflags",
    "+faststart",
    o.output
  );

  return args;
}

export async function transcode(
  ffmpegPath: string,
  o: TranscodeOptions,
  timeoutMs = 3_600_000
): Promise<{ path: string; bytes: number }> {
  await run(ffmpegPath, buildTranscodeArgs(o), { timeoutMs });
  const s = await stat(o.output);
  if (s.size === 0) throw new FfmpegError("encode produced an empty file", null, "");
  return { path: o.output, bytes: s.size };
}
