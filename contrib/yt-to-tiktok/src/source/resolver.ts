import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { logger } from "../logger.js";

/**
 * Locates the master video file for an upload.
 *
 * This module is deliberately narrow. It finds a file you already have, or it
 * runs a command YOU configured. It does not fetch anything from YouTube: your
 * own master is a better source than a re-encoded stream anyway, and keeping
 * the fetch out of the tool keeps the tool pointed at content you own.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"];

export class SourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceNotFoundError";
  }
}

function assertVideoId(videoId: string): string {
  if (!VIDEO_ID.test(videoId)) {
    throw new Error(`refusing to build a path from an invalid video id: ${JSON.stringify(videoId)}`);
  }
  return videoId;
}

/** Keeps a manifest entry from escaping the masters directory via `../`. */
export function assertInside(baseDir: string, candidate: string): string {
  const base = resolve(baseDir);
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`source path escapes SOURCE_DIR: ${candidate}`);
  }
  return target;
}

async function exists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/**
 * Resolution order:
 *   1. `<SOURCE_DIR>/<videoId>.<ext>` - the zero-config convention.
 *   2. `<SOURCE_DIR>/manifest.json`, a `{ "<videoId>": "relative/path.mp4" }` map.
 *   3. Any file in SOURCE_DIR whose name STARTS with the video id, so
 *      `dQw4w9WgXcQ - final cut.mp4` is found too.
 */
export async function resolveLocal(sourceDir: string, videoId: string): Promise<string | null> {
  assertVideoId(videoId);
  const base = resolve(sourceDir);

  for (const ext of VIDEO_EXTENSIONS) {
    const candidate = join(base, `${videoId}${ext}`);
    if (await exists(candidate)) return candidate;
  }

  const manifestPath = join(base, "manifest.json");
  try {
    const raw = await readFile(manifestPath, "utf8");
    const map = JSON.parse(raw) as Record<string, string>;
    const entry = map[videoId];
    if (typeof entry === "string" && entry.trim()) {
      const target = assertInside(base, entry.trim());
      if (await exists(target)) return target;
      logger.warn({ videoId, target }, "manifest entry points at a missing file");
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn({ err: (err as Error).message }, "could not read manifest.json");
    }
  }

  try {
    const entries = await readdir(base, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.startsWith(videoId)) continue;
      const lower = e.name.toLowerCase();
      if (!VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;
      const candidate = join(base, e.name);
      if (await exists(candidate)) return candidate;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }

  return null;
}

/**
 * Runs the operator-configured `SOURCE_COMMAND`.
 *
 * Values reach the command through the ENVIRONMENT, never interpolated into a
 * command line, so a title or id can never become shell syntax.
 */
export async function resolveViaCommand(
  command: string,
  o: { videoId: string; outputPath: string; timeoutMs: number }
): Promise<string | null> {
  assertVideoId(o.videoId);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [], {
      // A configured command is often a one-liner; the shell is scoped to the
      // operator's own static string and receives no interpolated values.
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        YT2TT_VIDEO_ID: o.videoId,
        YT2TT_OUTPUT_PATH: o.outputPath,
        YT2TT_VIDEO_URL: `https://www.youtube.com/watch?v=${o.videoId}`,
      },
    });

    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
    });
    child.stdout.on("data", () => {
      /* drained so the pipe cannot fill and block the child */
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`SOURCE_COMMAND timed out after ${o.timeoutMs}ms`));
    }, o.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`SOURCE_COMMAND failed to start: ${(err as Error).message}`));
    });

    child.on("close", async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`SOURCE_COMMAND exited with code ${code}: ${stderr.slice(-500)}`));
        return;
      }
      resolvePromise((await exists(o.outputPath)) ? o.outputPath : null);
    });
  });
}

export interface ResolveOptions {
  mode: "local" | "command";
  sourceDir: string;
  command?: string;
  commandTimeoutMs: number;
  waitSeconds: number;
  workDir: string;
}

export async function resolveSource(videoId: string, o: ResolveOptions): Promise<string> {
  assertVideoId(videoId);

  if (o.mode === "command") {
    if (!o.command) throw new Error("SOURCE_MODE=command requires SOURCE_COMMAND to be set");
    const outputPath = join(resolve(o.workDir), `${videoId}.source.mp4`);
    const found = await resolveViaCommand(o.command, {
      videoId,
      outputPath,
      timeoutMs: o.commandTimeoutMs,
    });
    if (!found) {
      throw new SourceNotFoundError(
        `SOURCE_COMMAND finished but wrote no file to ${outputPath} for ${videoId}`
      );
    }
    return found;
  }

  const deadline = Date.now() + o.waitSeconds * 1000;
  for (;;) {
    const found = await resolveLocal(o.sourceDir, videoId);
    if (found) return found;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, Math.min(15_000, Math.max(1_000, o.waitSeconds * 100))));
  }

  throw new SourceNotFoundError(
    `No master file for ${videoId} in ${o.sourceDir}. Expected ${videoId}.mp4, a manifest.json entry, or a file whose name starts with ${videoId}.`
  );
}
