import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import { Store } from "../src/db.js";
import { probe, run } from "../src/media/ffmpeg.js";
import { tick } from "../src/pipeline/worker.js";
import { planClips } from "../src/media/clip.js";

/**
 * End-to-end exercise of the real pipeline: a real file on disk, real FFmpeg
 * encodes, the real job state machine. Publishing runs under DRY_RUN, which is
 * the only step that cannot be tested without live credentials.
 *
 * Skipped when FFmpeg is unavailable rather than failing, so the suite stays
 * green on machines that only run the unit tests.
 */

const VIDEO = "dQw4w9WgXcQ";
const CHANNEL = "UCabcdefghijklmnopqrstuv";

let ffmpegAvailable = false;
try {
  await run("ffmpeg", ["-version"]);
  ffmpegAvailable = true;
} catch {
  ffmpegAvailable = false;
}

const maybe = { skip: ffmpegAvailable ? false : "ffmpeg not installed" };

/** Builds a real 16:9 test master: colour bars plus a tone, or silent. */
async function makeMaster(
  path: string,
  seconds: number,
  opts: { width?: number; height?: number; silent?: boolean } = {}
): Promise<void> {
  const w = opts.width ?? 1280;
  const h = opts.height ?? 720;
  const args = [
    "-hide_banner", "-nostdin", "-y",
    "-f", "lavfi", "-i", `testsrc=size=${w}x${h}:rate=30:duration=${seconds}`,
  ];
  if (!opts.silent) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
  }
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-t", String(seconds));
  if (!opts.silent) args.push("-c:a", "aac", "-shortest");
  args.push(path);
  await run("ffmpeg", args, { timeoutMs: 120_000 });
}

interface Ctx {
  dir: string;
  store: Store;
  cfg: Config;
}

async function withPipeline(
  env: Record<string, string>,
  fn: (ctx: Ctx) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "yt2tt-e2e-"));
  const store = new Store(":memory:");
  try {
    const cfg = loadConfig({
      DATA_DIR: dir,
      WORK_DIR: join(dir, "work"),
      SOURCE_DIR: join(dir, "masters"),
      YOUTUBE_CHANNEL_ID: CHANNEL,
      CAPTION_HASHTAGS: "",
      DRY_RUN: "true",
      REQUIRE_REVIEW: "false",
      // Keep the encodes fast; correctness of the graph is what is under test.
      VIDEO_PRESET: "ultrafast",
      LOUDNESS_ENABLED: "false",
      ...env,
    } as NodeJS.ProcessEnv);
    await fn({ dir, store, cfg });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function seed(store: Store, durationSec: number): void {
  store.insertVideoIfNew({
    videoId: VIDEO,
    channelId: CHANNEL,
    title: "Donut Review",
    publishedAt: new Date().toISOString(),
    durationSec,
  });
}

/** Drives the worker until every job settles or the budget runs out. */
async function drain(store: Store, cfg: Config, maxTicks = 40): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    const pending = store
      .listJobs(undefined, 100)
      .filter((j) => !["published", "failed", "rejected", "awaiting_review", "awaiting_handoff"].includes(j.state));
    if (!pending.length) return;
    await tick(store, cfg);
  }
}

test("a short upload is encoded whole and reaches published", maybe, async () => {
  await withPipeline({}, async ({ dir, store, cfg }) => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "masters"), { recursive: true });
    await makeMaster(join(dir, "masters", `${VIDEO}.mp4`), 6);

    seed(store, 6);
    store.createJob(VIDEO, 0);

    await drain(store, cfg);

    const job = store.listJobs()[0]!;
    assert.equal(job.state, "published", `job failed: ${job.last_error ?? "(no error)"}`);
    assert.equal(job.tiktok_status, "DRY_RUN");
  });
});

test("the encoded output is genuinely 1080x1920 with audio preserved", maybe, async () => {
  await withPipeline({}, async ({ dir, store, cfg }) => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "masters"), { recursive: true });
    await makeMaster(join(dir, "masters", `${VIDEO}.mp4`), 5);

    seed(store, 5);
    const id = store.createJob(VIDEO, 0);

    // Stop before publish so the encoded file is still on disk.
    await tick(store, cfg); // source
    await tick(store, cfg); // encode

    const job = store.getJob(id)!;
    assert.ok(job.output_path, `no output produced: ${job.last_error ?? ""}`);

    const out = await probe(cfg.FFPROBE_PATH, job.output_path);
    assert.equal(out.width, 1080, "width must be the configured output width");
    assert.equal(out.height, 1920, "height must be the configured output height");
    assert.ok(out.hasAudio, "audio must survive the vertical conversion");
    assert.ok(Math.abs(out.durationSec - 5) < 1.5, `duration drifted: ${out.durationSec}`);
    assert.ok(out.fps >= 23 && out.fps <= 60, `fps out of range: ${out.fps}`);
  });
});

test("a long upload is split into the planned clips, each encoded separately", maybe, async () => {
  await withPipeline(
    { CLIP_THRESHOLD_SECONDS: "10", CLIP_TARGET_SECONDS: "5", CLIP_MAX_COUNT: "2" },
    async ({ dir, store, cfg }) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, "masters"), { recursive: true });
      await makeMaster(join(dir, "masters", `${VIDEO}.mp4`), 24);

      seed(store, 24);
      const clips = planClips({
        durationSec: 24,
        thresholdSec: 10,
        targetSec: 5,
        maxCount: 2,
      });
      assert.equal(clips.length, 2, "planner should produce two clips");
      for (const c of clips) {
        store.createJob(VIDEO, c.index, { start: c.startSec, duration: c.durationSec });
      }

      await drain(store, cfg, 60);

      const jobs = store.listJobs(undefined, 10);
      assert.equal(jobs.length, 2);
      for (const j of jobs) {
        assert.equal(j.state, "published", `clip ${j.clip_index} failed: ${j.last_error ?? ""}`);
      }
    }
  );
});

test("a silent master encodes without an audio stream instead of failing", maybe, async () => {
  await withPipeline({}, async ({ dir, store, cfg }) => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "masters"), { recursive: true });
    await makeMaster(join(dir, "masters", `${VIDEO}.mp4`), 4, { silent: true });

    seed(store, 4);
    const id = store.createJob(VIDEO, 0);

    await tick(store, cfg);
    await tick(store, cfg);

    const job = store.getJob(id)!;
    assert.ok(job.output_path, `no output: ${job.last_error ?? ""}`);
    const out = await probe(cfg.FFPROBE_PATH, job.output_path);
    assert.equal(out.hasAudio, false, "a silent source must not gain a phantom audio stream");
    assert.equal(out.width, 1080);
  });
});

test("the review gate genuinely holds the job until approved", maybe, async () => {
  await withPipeline({ REQUIRE_REVIEW: "true" }, async ({ dir, store, cfg }) => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "masters"), { recursive: true });
    await makeMaster(join(dir, "masters", `${VIDEO}.mp4`), 4);

    seed(store, 4);
    const id = store.createJob(VIDEO, 0);

    await drain(store, cfg);
    assert.equal(store.getJob(id)!.state, "awaiting_review", "must stop for review");

    store.updateJob(id, { state: "approved" });
    await drain(store, cfg);
    assert.equal(store.getJob(id)!.state, "published");
  });
});

test("a missing master fails the job with an actionable message", maybe, async () => {
  await withPipeline({}, async ({ dir, store, cfg }) => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "masters"), { recursive: true });

    seed(store, 5);
    const id = store.createJob(VIDEO, 0);

    for (let i = 0; i < 3; i++) await tick(store, cfg);

    const job = store.getJob(id)!;
    assert.ok(job.last_error, "an error should have been recorded");
    assert.match(job.last_error, /No master file/);
    assert.match(job.last_error, new RegExp(VIDEO));
  });
});

test("crop and pad framing modes both produce a valid vertical file", maybe, async () => {
  for (const mode of ["crop", "pad"] as const) {
    await withPipeline({ VERTICAL_MODE: mode }, async ({ dir, store, cfg }) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, "masters"), { recursive: true });
      await makeMaster(join(dir, "masters", `${VIDEO}.mp4`), 3);

      seed(store, 3);
      const id = store.createJob(VIDEO, 0);
      await tick(store, cfg);
      await tick(store, cfg);

      const job = store.getJob(id)!;
      assert.ok(job.output_path, `${mode} produced nothing: ${job.last_error ?? ""}`);
      const out = await probe(cfg.FFPROBE_PATH, job.output_path);
      assert.equal(out.width, 1080, `${mode} width`);
      assert.equal(out.height, 1920, `${mode} height`);
    });
  }
});

test("loudness normalisation runs its two passes and still produces valid audio", maybe, async () => {
  await withPipeline({ LOUDNESS_ENABLED: "true" }, async ({ dir, store, cfg }) => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "masters"), { recursive: true });
    await makeMaster(join(dir, "masters", `${VIDEO}.mp4`), 4);

    seed(store, 4);
    const id = store.createJob(VIDEO, 0);
    await tick(store, cfg);
    await tick(store, cfg);

    const job = store.getJob(id)!;
    assert.ok(job.output_path, `loudnorm path failed: ${job.last_error ?? ""}`);
    const out = await probe(cfg.FFPROBE_PATH, job.output_path);
    assert.ok(out.hasAudio, "audio must survive loudnorm");
  });
});

test("handoff preflight accepts a real encode and holds it", maybe, async () => {
  await withPipeline(
    { TIKTOK_PUBLISH_MODE: "handoff", CLIP_THRESHOLD_SECONDS: "600" },
    async ({ dir, store, cfg }) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, "masters"), { recursive: true });
      await makeMaster(join(dir, "masters", `${VIDEO}.mp4`), 5);

      seed(store, 5);
      const id = store.createJob(VIDEO, 0);
      await drain(store, cfg);

      assert.equal(
        store.getJob(id)!.state,
        "awaiting_handoff",
        `expected a hold, got: ${store.getJob(id)!.last_error ?? ""}`
      );
    }
  );
});

test("handoff preflight rejects an encode that is too short to publish", maybe, async () => {
  await withPipeline(
    { TIKTOK_PUBLISH_MODE: "handoff", CLIP_THRESHOLD_SECONDS: "600" },
    async ({ dir, store, cfg }) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, "masters"), { recursive: true });
      // Under the 3s floor the publisher enforces.
      await makeMaster(join(dir, "masters", `${VIDEO}.mp4`), 2);

      seed(store, 2);
      const id = store.createJob(VIDEO, 0);
      await drain(store, cfg);

      const job = store.getJob(id)!;
      assert.equal(job.state, "failed");
      assert.match(job.last_error ?? "", /below the 3s minimum/);
    }
  );
});
