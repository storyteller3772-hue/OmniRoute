import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInside, resolveLocal, resolveSource } from "../src/source/resolver.js";

const VIDEO = "dQw4w9WgXcQ";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "yt2tt-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("finds a master named exactly <videoId>.mp4", async () => {
  await withDir(async (dir) => {
    const path = join(dir, `${VIDEO}.mp4`);
    await writeFile(path, "video-bytes");
    assert.equal(await resolveLocal(dir, VIDEO), path);
  });
});

test("finds a master with any supported extension", async () => {
  for (const ext of [".mov", ".mkv", ".webm", ".m4v"]) {
    await withDir(async (dir) => {
      const path = join(dir, `${VIDEO}${ext}`);
      await writeFile(path, "video-bytes");
      assert.equal(await resolveLocal(dir, VIDEO), path);
    });
  }
});

test("finds a master whose name merely starts with the video id", async () => {
  await withDir(async (dir) => {
    const path = join(dir, `${VIDEO} - final cut.mp4`);
    await writeFile(path, "video-bytes");
    assert.equal(await resolveLocal(dir, VIDEO), path);
  });
});

test("resolves through a manifest.json mapping", async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, "renders"), { recursive: true });
    const target = join(dir, "renders", "donut-ep4.mp4");
    await writeFile(target, "video-bytes");
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({ [VIDEO]: "renders/donut-ep4.mp4" })
    );
    assert.equal(await resolveLocal(dir, VIDEO), target);
  });
});

test("an empty file is not accepted as a master", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, `${VIDEO}.mp4`), "");
    assert.equal(await resolveLocal(dir, VIDEO), null);
  });
});

test("returns null when nothing matches", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "unrelated.mp4"), "x");
    assert.equal(await resolveLocal(dir, VIDEO), null);
  });
});

test("a missing source directory is not an error, just no match", async () => {
  assert.equal(await resolveLocal("/nonexistent/path/for/test", VIDEO), null);
});

test("a non-video file matching the id is ignored", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, `${VIDEO}.txt`), "notes");
    assert.equal(await resolveLocal(dir, VIDEO), null);
  });
});

test("a malformed manifest does not break resolution", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "manifest.json"), "{ not json");
    const path = join(dir, `${VIDEO}.mp4`);
    await writeFile(path, "video-bytes");
    assert.equal(await resolveLocal(dir, VIDEO), path);
  });
});

test("a manifest entry cannot escape the source directory", () => {
  assert.throws(() => assertInside("/masters", "../../etc/passwd"), /escapes SOURCE_DIR/);
  assert.throws(() => assertInside("/masters", "/etc/passwd"), /escapes SOURCE_DIR/);
  assert.throws(() => assertInside("/masters", "sub/../../../etc/shadow"), /escapes SOURCE_DIR/);
});

test("paths inside the source directory are allowed", () => {
  assert.equal(assertInside("/masters", "clip.mp4"), "/masters/clip.mp4");
  assert.equal(assertInside("/masters", "sub/clip.mp4"), "/masters/sub/clip.mp4");
  assert.equal(assertInside("/masters", "/masters/clip.mp4"), "/masters/clip.mp4");
});

test("a directory that merely shares a name prefix is not treated as inside", () => {
  assert.throws(() => assertInside("/masters", "/masters-evil/clip.mp4"), /escapes SOURCE_DIR/);
});

test("an invalid video id is refused before it can reach a path", async () => {
  for (const bad of ["../../etc/passwd", "short", "", "with/slash", "toolongvideoid123"]) {
    await assert.rejects(
      () => resolveLocal("/tmp", bad),
      /invalid video id/,
      `should refuse ${JSON.stringify(bad)}`
    );
  }
});

test("resolveSource reports what it looked for when nothing is found", async () => {
  await withDir(async (dir) => {
    await assert.rejects(
      () =>
        resolveSource(VIDEO, {
          mode: "local",
          sourceDir: dir,
          commandTimeoutMs: 1000,
          waitSeconds: 0,
          workDir: dir,
        }),
      (err: Error) => {
        assert.match(err.message, /No master file/);
        assert.match(err.message, new RegExp(VIDEO), "the message must name the video");
        assert.match(err.message, /manifest\.json/, "and say how to supply one");
        return true;
      }
    );
  });
});

test("command mode requires a configured command", async () => {
  await assert.rejects(
    () =>
      resolveSource(VIDEO, {
        mode: "command",
        sourceDir: "/tmp",
        commandTimeoutMs: 1000,
        waitSeconds: 0,
        workDir: "/tmp",
      }),
    /requires SOURCE_COMMAND/
  );
});

test("command mode passes values through the environment, never the command line", async () => {
  await withDir(async (dir) => {
    // The command writes whatever it was given in the env, proving the values
    // arrived out-of-band rather than interpolated into the script text.
    const out = await resolveSource(VIDEO, {
      mode: "command",
      sourceDir: dir,
      command: 'printf "%s" "$YT2TT_VIDEO_ID" > "$YT2TT_OUTPUT_PATH"',
      commandTimeoutMs: 15_000,
      waitSeconds: 0,
      workDir: dir,
    });
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(out, "utf8"), VIDEO);
  });
});

test("command mode fails loudly when the command writes nothing", async () => {
  await withDir(async (dir) => {
    await assert.rejects(
      () =>
        resolveSource(VIDEO, {
          mode: "command",
          sourceDir: dir,
          command: "true",
          commandTimeoutMs: 15_000,
          waitSeconds: 0,
          workDir: dir,
        }),
      /wrote no file/
    );
  });
});

test("command mode surfaces a non-zero exit", async () => {
  await withDir(async (dir) => {
    await assert.rejects(
      () =>
        resolveSource(VIDEO, {
          mode: "command",
          sourceDir: dir,
          command: "exit 3",
          commandTimeoutMs: 15_000,
          waitSeconds: 0,
          workDir: dir,
        }),
      /exited with code 3/
    );
  });
});
