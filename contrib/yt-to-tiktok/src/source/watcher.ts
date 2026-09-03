import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { logger } from "../logger.js";

/**
 * Watches the masters directory and treats a new file as a publish trigger.
 *
 * This exists so the pipeline can run with no YouTube credentials and no public
 * tunnel: dropping an export into the folder is the whole trigger. The WebSub
 * path stays available for hands-off operation, but it is no longer required.
 */

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);

export interface WatchedFile {
  path: string;
  videoId: string;
  title: string;
  sizeBytes: number;
}

/**
 * Derives a stable 11-character id from the filename.
 *
 * Same shape as a YouTube id so it flows through the existing validation and
 * path handling unchanged, and deterministic so re-scanning the same file maps
 * to the same job rather than queuing a duplicate.
 */
export function localVideoId(filePath: string): string {
  const name = basename(filePath);
  // Accept a leading YouTube-shaped id followed by a separator, matching how
  // resolveLocal() finds masters by id prefix ("dQw4w9WgXcQ - final cut.mp4").
  if (/^[A-Za-z0-9_-]{11}([.\s_-]|$)/.test(name)) return name.slice(0, 11);
  const digest = createHash("sha256").update(name).digest("base64url");
  return digest.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 11);
}

/** Filename minus extension, tidied into something usable as a caption. */
export function titleFromFilename(filePath: string): string {
  return basename(filePath, extname(filePath))
    .replace(/[_]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(name).toLowerCase());
}

/**
 * Lists candidates whose size has settled.
 *
 * A file still being copied or exported would otherwise be probed mid-write:
 * ffprobe reads a truncated moov atom, reports a wrong duration or fails, and
 * the job dies on a file that was about to be perfectly good. Two matching
 * measurements `stableMs` apart is the cheap, portable way to wait it out.
 */
export async function scanStable(
  dir: string,
  seen: Map<string, number>,
  stableMs: number,
  now = Date.now()
): Promise<WatchedFile[]> {
  const base = resolve(dir);
  let entries: string[];
  try {
    entries = (await readdir(base, { withFileTypes: true }))
      .filter((e) => e.isFile() && isVideoFile(e.name))
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const ready: WatchedFile[] = [];

  for (const name of entries) {
    const path = join(base, name);
    let size: number;
    let mtimeMs: number;
    try {
      const s = await stat(path);
      size = s.size;
      mtimeMs = s.mtimeMs;
    } catch {
      continue;
    }
    if (size === 0) continue;

    const previous = seen.get(path);
    if (previous === undefined || previous !== size) {
      // First sighting, or still growing - remember the size and wait.
      seen.set(path, size);
      continue;
    }
    // Size matched the previous scan; also require the write to have settled.
    if (now - mtimeMs < stableMs) continue;

    ready.push({
      path,
      videoId: localVideoId(path),
      title: titleFromFilename(path),
      sizeBytes: size,
    });
  }

  return ready;
}

export interface WatcherOptions {
  dir: string;
  intervalMs: number;
  stableMs: number;
  onFile: (file: WatchedFile) => Promise<void>;
}

export function startWatcher(o: WatcherOptions): { stop: () => void } {
  const seen = new Map<string, number>();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      for (const file of await scanStable(o.dir, seen, o.stableMs)) {
        try {
          await o.onFile(file);
        } catch (err) {
          logger.error(
            { file: file.path, err: (err as Error).message },
            "failed to ingest watched file"
          );
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "watch scan failed");
    }
    if (!stopped) timer = setTimeout(loop, o.intervalMs);
  };

  void loop();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
