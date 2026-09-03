import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVideoFile, localVideoId, scanStable, titleFromFilename } from "../src/source/watcher.js";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "yt2tt-watch-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Backdates mtime so the "write has settled" check passes without waiting. */
async function backdate(path: string, seconds = 120): Promise<void> {
  const when = new Date(Date.now() - seconds * 1000);
  await utimes(path, when, when);
}

test("a filename that already is a video id is used as-is", () => {
  assert.equal(localVideoId("/masters/dQw4w9WgXcQ.mp4"), "dQw4w9WgXcQ");
  assert.equal(localVideoId("/masters/dQw4w9WgXcQ - final.mp4"), "dQw4w9WgXcQ");
});

test("any other filename maps to a stable 11-character id", () => {
  const id = localVideoId("/masters/donut review ep 4.mp4");
  assert.match(id, /^[A-Za-z0-9_-]{11}$/);
  assert.equal(id, localVideoId("/elsewhere/donut review ep 4.mp4"), "must depend only on the name");
  assert.notEqual(id, localVideoId("/masters/donut review ep 5.mp4"));
});

test("titles are derived from the filename, not the extension", () => {
  assert.equal(titleFromFilename("/m/Donut Review Ep 4.mp4"), "Donut Review Ep 4");
  assert.equal(titleFromFilename("/m/donut_review_ep_4.mov"), "donut review ep 4");
});

test("only video extensions are considered", () => {
  for (const good of ["a.mp4", "a.MOV", "a.mkv", "a.webm", "a.m4v"]) {
    assert.equal(isVideoFile(good), true, good);
  }
  for (const bad of ["a.txt", "a.jpg", "a.mp3", "manifest.json", "a"]) {
    assert.equal(isVideoFile(bad), false, bad);
  }
});

test("a file is not picked up on first sight - it may still be copying", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "clip.mp4");
    await writeFile(f, "x".repeat(1000));
    await backdate(f);

    const seen = new Map<string, number>();
    assert.deepEqual(await scanStable(dir, seen, 1000), [], "first scan only records the size");
  });
});

test("a file whose size has settled is picked up on the next scan", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "clip.mp4");
    await writeFile(f, "x".repeat(1000));
    await backdate(f);

    const seen = new Map<string, number>();
    await scanStable(dir, seen, 1000);
    const ready = await scanStable(dir, seen, 1000);

    assert.equal(ready.length, 1);
    assert.equal(ready[0]!.path, f);
    assert.equal(ready[0]!.title, "clip");
    assert.equal(ready[0]!.sizeBytes, 1000);
  });
});

test("a file that is still growing is never picked up", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "clip.mp4");
    const seen = new Map<string, number>();

    for (let i = 1; i <= 4; i++) {
      await writeFile(f, "x".repeat(1000 * i));
      await backdate(f);
      assert.deepEqual(
        await scanStable(dir, seen, 1000),
        [],
        `scan ${i} picked up a file that was still growing`
      );
    }

    // Growth stops; the next matching measurement releases it.
    const ready = await scanStable(dir, seen, 1000);
    assert.equal(ready.length, 1);
  });
});

test("a file written moments ago is held back until the write settles", async () => {
  await withDir(async (dir) => {
    const f = join(dir, "clip.mp4");
    await writeFile(f, "x".repeat(500));
    const seen = new Map<string, number>();
    await scanStable(dir, seen, 60_000);
    assert.deepEqual(
      await scanStable(dir, seen, 60_000),
      [],
      "a fresh mtime must hold the file back even when the size matches"
    );
  });
});

test("empty and non-video files are ignored", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "empty.mp4"), "");
    await writeFile(join(dir, "notes.txt"), "hello");
    await writeFile(join(dir, "manifest.json"), "{}");
    for (const n of ["empty.mp4", "notes.txt", "manifest.json"]) await backdate(join(dir, n));

    const seen = new Map<string, number>();
    await scanStable(dir, seen, 1000);
    assert.deepEqual(await scanStable(dir, seen, 1000), []);
  });
});

test("a missing directory is not an error", async () => {
  assert.deepEqual(await scanStable("/nonexistent/watch/dir", new Map(), 1000), []);
});

test("several settled files are all returned", async () => {
  await withDir(async (dir) => {
    for (const n of ["a.mp4", "b.mov", "c.mkv"]) {
      await writeFile(join(dir, n), "x".repeat(2000));
      await backdate(join(dir, n));
    }
    const seen = new Map<string, number>();
    await scanStable(dir, seen, 1000);
    const ready = await scanStable(dir, seen, 1000);
    assert.equal(ready.length, 3);
    assert.equal(new Set(ready.map((r) => r.videoId)).size, 3, "ids must be distinct");
  });
});
