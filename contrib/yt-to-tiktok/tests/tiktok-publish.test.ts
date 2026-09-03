import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db.js";
import { tick } from "../src/pipeline/worker.js";
import { planFor, uploadChunks } from "../src/tiktok/publish.js";
import { run } from "../src/media/ffmpeg.js";

/**
 * The direct-post path probes the encoded file to enforce the account's
 * max_video_post_duration_sec, so those cases need a genuine video rather than
 * random bytes.
 */
async function makeRealClip(path: string, seconds = 2): Promise<number> {
  await run("ffmpeg", [
    "-hide_banner", "-nostdin", "-y",
    "-f", "lavfi", "-i", `testsrc=size=360x640:rate=30:duration=${seconds}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-t", String(seconds), path,
  ], { timeoutMs: 120_000 });
  const { stat } = await import("node:fs/promises");
  return (await stat(path)).size;
}

let ffmpegAvailable = false;
try {
  await run("ffmpeg", ["-version"]);
  ffmpegAvailable = true;
} catch {
  ffmpegAvailable = false;
}
const needsFfmpeg = { skip: ffmpegAvailable ? false : "ffmpeg not installed" };

/**
 * Runs the real publish code against a stand-in that enforces the Content
 * Posting API's contract: floor()-based chunk counts, inclusive Content-Range
 * offsets, a final chunk carrying the remainder, and every byte accounted for.
 *
 * This is the path that cannot be exercised with live credentials until the
 * app is registered, and the path where a mistake costs an audit cycle.
 */

interface MockState {
  received: Buffer[];
  ranges: string[];
  initBody: Record<string, unknown> | null;
  postInfo: Record<string, unknown> | null;
  statusCalls: number;
  tokenGrants: string[];
  failFirstChunk: boolean;
  expectedSize: number;
}

function startMock(state: MockState): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const json = (o: unknown, code = 200): void => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };
      const url = req.url ?? "";

      if (url.startsWith("/v2/oauth/token/")) {
        state.tokenGrants.push(new URLSearchParams(body.toString()).get("grant_type") ?? "");
        return json({
          access_token: "at-fresh",
          expires_in: 86400,
          refresh_token: "rt-fresh",
          refresh_expires_in: 31536000,
          open_id: "open-123",
          scope: "user.info.basic,video.publish",
        });
      }

      if (url.startsWith("/v2/post/publish/creator_info/query/")) {
        return json({
          data: {
            creator_username: "yellowdonutt",
            creator_nickname: "Yellow Donut",
            privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
            max_video_post_duration_sec: 600,
          },
          error: { code: "ok" },
        });
      }

      if (url.startsWith("/v2/post/publish/video/init/") || url.startsWith("/v2/post/publish/inbox/video/init/")) {
        const parsed = JSON.parse(body.toString() || "{}") as Record<string, never>;
        state.initBody = (parsed.source_info ?? null) as never;
        state.postInfo = (parsed.post_info ?? null) as never;
        const addr = server.address() as AddressInfo;
        return json({
          data: {
            publish_id: "pub-123",
            upload_url: `http://127.0.0.1:${addr.port}/upload`,
          },
          error: { code: "ok" },
        });
      }

      if (url.startsWith("/upload") && req.method === "PUT") {
        const range = req.headers["content-range"] as string | undefined;
        if (!range) {
          res.writeHead(400);
          return res.end("missing Content-Range");
        }
        state.ranges.push(range);

        if (state.failFirstChunk && state.received.length === 0) {
          state.failFirstChunk = false;
          res.writeHead(503);
          return res.end("transient");
        }

        // bytes START-END/TOTAL, END inclusive.
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
        if (!m) {
          res.writeHead(400);
          return res.end("malformed Content-Range");
        }
        const [, s0, e0, total] = m;
        const start = Number(s0);
        const end = Number(e0);
        if (Number(total) !== state.expectedSize) {
          res.writeHead(400);
          return res.end("wrong total size");
        }
        if (end - start + 1 !== body.length) {
          res.writeHead(400);
          return res.end(`range says ${end - start + 1} bytes, got ${body.length}`);
        }
        state.received[start] = body;
        res.writeHead(end + 1 >= state.expectedSize ? 201 : 206);
        return res.end();
      }

      if (url.startsWith("/v2/post/publish/status/fetch/")) {
        state.statusCalls++;
        return json({
          data: { status: state.statusCalls < 2 ? "PROCESSING_UPLOAD" : "PUBLISH_COMPLETE" },
          error: { code: "ok" },
        });
      }

      res.writeHead(404);
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function freshState(expectedSize: number): MockState {
  return {
    received: [],
    ranges: [],
    initBody: null,
    postInfo: null,
    statusCalls: 0,
    tokenGrants: [],
    failFirstChunk: false,
    expectedSize,
  };
}

function assembled(state: MockState): Buffer {
  return Buffer.concat(Object.keys(state.received).sort((a, b) => Number(a) - Number(b)).map((k) => state.received[Number(k)]!));
}

async function withMock(
  size: number,
  fn: (ctx: { base: string; state: MockState; dir: string; file: string; payload: Buffer }) => Promise<void>,
  mutate?: (s: MockState) => void
): Promise<void> {
  const state = freshState(size);
  mutate?.(state);
  const { server, base } = await startMock(state);
  const dir = await mkdtemp(join(tmpdir(), "yt2tt-pub-"));
  const file = join(dir, "clip.mp4");
  const payload = randomBytes(size);
  await writeFile(file, payload);
  const prev = process.env.TIKTOK_API_BASE_URL;
  process.env.TIKTOK_API_BASE_URL = base;
  try {
    await fn({ base, state, dir, file, payload });
  } finally {
    if (prev === undefined) delete process.env.TIKTOK_API_BASE_URL;
    else process.env.TIKTOK_API_BASE_URL = prev;
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
}

test("a multi-chunk upload delivers every byte, in order, intact", async () => {
  const size = 12 * 1024 * 1024; // 12 MiB -> 2 chunks of 5 MiB + remainder
  await withMock(size, async ({ state, file, payload }) => {
    const plan = planFor(size, 5);
    await uploadChunks(`http://127.0.0.1:${new URL(process.env.TIKTOK_API_BASE_URL!).port}/upload`, file, plan);

    assert.equal(state.ranges.length, plan.totalChunkCount);
    assert.ok(assembled(state).equals(payload), "reassembled upload must match the source byte for byte");
  });
});

test("the final chunk carries the remainder rather than a short tail", async () => {
  const size = 12 * 1024 * 1024;
  await withMock(size, async ({ state, file }) => {
    const plan = planFor(size, 5);
    await uploadChunks(`http://127.0.0.1:${new URL(process.env.TIKTOK_API_BASE_URL!).port}/upload`, file, plan);

    assert.equal(plan.totalChunkCount, 2, "floor(12/5) = 2");
    const last = state.ranges.at(-1)!;
    assert.equal(last, `bytes ${5 * 1024 * 1024}-${size - 1}/${size}`);
  });
});

test("a small file goes up as a single whole-file chunk", async () => {
  const size = 2 * 1024 * 1024;
  await withMock(size, async ({ state, file, payload }) => {
    const plan = planFor(size, 10);
    await uploadChunks(`http://127.0.0.1:${new URL(process.env.TIKTOK_API_BASE_URL!).port}/upload`, file, plan);

    assert.equal(state.ranges.length, 1);
    assert.equal(state.ranges[0], `bytes 0-${size - 1}/${size}`);
    assert.ok(assembled(state).equals(payload));
  });
});

test("a transient 5xx on a chunk is retried, not abandoned", async () => {
  const size = 6 * 1024 * 1024;
  await withMock(
    size,
    async ({ state, file, payload }) => {
      const plan = planFor(size, 5);
      await uploadChunks(`http://127.0.0.1:${new URL(process.env.TIKTOK_API_BASE_URL!).port}/upload`, file, plan);
      assert.ok(assembled(state).equals(payload), "the retried chunk must land intact");
    },
    (s) => {
      s.failFirstChunk = true;
    }
  );
});

test("the whole direct-post path runs end to end and the job reaches published", needsFfmpeg, async () => {
  const size = 3 * 1024 * 1024;
  await withMock(size, async ({ state, dir }) => {
    const file = join(dir, "real.mp4");
    state.expectedSize = await makeRealClip(file);
    const store = new Store(":memory:");
    try {
      const cfg = loadConfig({
        DATA_DIR: dir,
        WORK_DIR: dir,
        TIKTOK_PUBLISH_MODE: "direct",
        TIKTOK_PRIVACY_LEVEL: "PUBLIC_TO_EVERYONE",
        TIKTOK_CLIENT_KEY: "ck",
        TIKTOK_CLIENT_SECRET: "cs",
        TIKTOK_REDIRECT_URI: "https://example.test/cb",
        REQUIRE_REVIEW: "false",
        CAPTION_HASHTAGS: "",
      } as NodeJS.ProcessEnv);

      store.saveTokens("tiktok", {
        accessToken: "at-live",
        refreshToken: "rt-live",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      store.insertVideoIfNew({
        videoId: "dQw4w9WgXcQ",
        channelId: "UCabcdefghijklmnopqrstuv",
        title: "Donut Review",
        publishedAt: new Date().toISOString(),
      });
      const id = store.createJob("dQw4w9WgXcQ", 0);
      store.updateJob(id, { state: "approved", output_path: file, caption: "Donut Review" });

      // publish, then status polls until complete
      for (let i = 0; i < 6; i++) {
        const j = store.getJob(id)!;
        if (j.state === "published" || j.state === "failed") break;
        store.updateJob(id, { next_attempt_at: null });
        await tick(store, cfg);
      }

      const job = store.getJob(id)!;
      assert.equal(job.state, "published", `publish failed: ${job.last_error ?? ""}`);
      assert.equal(job.publish_id, "pub-123");
      assert.equal(job.tiktok_status, "PUBLISH_COMPLETE");

      // The init call must describe the chunk plan the upload actually followed.
      assert.equal(state.initBody?.video_size, state.expectedSize);
      assert.equal(state.initBody?.source, "FILE_UPLOAD");
      assert.equal(state.postInfo?.privacy_level, "PUBLIC_TO_EVERYONE");
      assert.equal(state.postInfo?.title, "Donut Review");
    } finally {
      store.close();
    }
  });
});

test("an expired access token is refreshed before publishing", async () => {
  const size = 1024 * 1024;
  await withMock(size, async ({ state, dir, file }) => {
    const store = new Store(":memory:");
    try {
      const cfg = loadConfig({
        DATA_DIR: dir,
        WORK_DIR: dir,
        TIKTOK_PUBLISH_MODE: "inbox",
        TIKTOK_CLIENT_KEY: "ck",
        TIKTOK_CLIENT_SECRET: "cs",
        TIKTOK_REDIRECT_URI: "https://example.test/cb",
        REQUIRE_REVIEW: "false",
        CAPTION_HASHTAGS: "",
      } as NodeJS.ProcessEnv);

      // Already expired.
      store.saveTokens("tiktok", {
        accessToken: "at-stale",
        refreshToken: "rt-live",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      store.insertVideoIfNew({
        videoId: "dQw4w9WgXcQ",
        channelId: "UCabcdefghijklmnopqrstuv",
        title: "t",
        publishedAt: new Date().toISOString(),
      });
      const id = store.createJob("dQw4w9WgXcQ", 0);
      store.updateJob(id, { state: "approved", output_path: file, caption: "t" });

      await tick(store, cfg);

      assert.ok(state.tokenGrants.includes("refresh_token"), "a refresh should have been performed");
      assert.equal(store.getTokens("tiktok")?.access_token, "at-fresh", "the new token must be stored");
    } finally {
      store.close();
    }
  });
});

test("a privacy level the account does not offer fails before any upload", needsFfmpeg, async () => {
  const size = 1024 * 1024;
  await withMock(size, async ({ state, dir }) => {
    const file = join(dir, "real.mp4");
    state.expectedSize = await makeRealClip(file);
    const store = new Store(":memory:");
    try {
      const cfg = loadConfig({
        DATA_DIR: dir,
        WORK_DIR: dir,
        TIKTOK_PUBLISH_MODE: "direct",
        // The mock offers PUBLIC_TO_EVERYONE and SELF_ONLY only.
        TIKTOK_PRIVACY_LEVEL: "MUTUAL_FOLLOW_FRIENDS",
        TIKTOK_CLIENT_KEY: "ck",
        TIKTOK_CLIENT_SECRET: "cs",
        TIKTOK_REDIRECT_URI: "https://example.test/cb",
        REQUIRE_REVIEW: "false",
        CAPTION_HASHTAGS: "",
      } as NodeJS.ProcessEnv);

      store.saveTokens("tiktok", {
        accessToken: "at-live",
        refreshToken: "rt-live",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      store.insertVideoIfNew({
        videoId: "dQw4w9WgXcQ",
        channelId: "UCabcdefghijklmnopqrstuv",
        title: "t",
        publishedAt: new Date().toISOString(),
      });
      const id = store.createJob("dQw4w9WgXcQ", 0);
      store.updateJob(id, { state: "approved", output_path: file, caption: "t" });

      await tick(store, cfg);

      const job = store.getJob(id)!;
      assert.equal(job.state, "failed");
      assert.match(job.last_error ?? "", /not offered by this account/);
      assert.match(job.last_error ?? "", /audited app/);
      assert.equal(state.ranges.length, 0, "nothing should have been uploaded");
    } finally {
      store.close();
    }
  });
});
