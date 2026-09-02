import { mkdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "../config.js";
import type { JobRow, Store } from "../db.js";
import { logger } from "../logger.js";
import { backoffMs, jitter, sqlTimestampIn } from "../util/time.js";
import { buildTranscodeArgs, measureLoudness, probe, run, transcode } from "../media/ffmpeg.js";
import { buildAudioOnlyArgs, buildCopyArgs, decideEncodePlan } from "../media/plan.js";
import { buildLoudnormApplyFilter } from "../media/filters.js";
import { resolveSource, SourceNotFoundError } from "../source/resolver.js";
import { validateForHandoff } from "./handoff.js";
import { TikTokApiError } from "../tiktok/api.js";
import { getAccessToken } from "../tiktok/oauth.js";
import {
  fetchPublishStatus,
  initDirectPost,
  initInboxUpload,
  planFor,
  queryCreatorInfo,
  uploadChunks,
} from "../tiktok/publish.js";

/** Terminal TikTok statuses reported by the status endpoint. */
const DONE = new Set(["PUBLISH_COMPLETE", "SEND_TO_USER_INBOX"]);
const FAILED = new Set(["FAILED"]);

export class TerminalJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalJobError";
  }
}

export async function runJobOnce(store: Store, cfg: Config, job: JobRow): Promise<void> {
  switch (job.state) {
    case "pending":
    case "sourcing":
      return stageSource(store, cfg, job);
    case "processing":
      return stageEncode(store, cfg, job);
    case "approved":
      return stagePublish(store, cfg, job);
    case "publishing":
      return stagePollStatus(store, cfg, job);
    default:
      return;
  }
}

async function stageSource(store: Store, cfg: Config, job: JobRow): Promise<void> {
  store.updateJob(job.id, { state: "sourcing" });
  await mkdir(resolve(cfg.WORK_DIR), { recursive: true });

  const path = await resolveSource(job.video_id, {
    mode: cfg.SOURCE_MODE,
    sourceDir: cfg.SOURCE_DIR,
    command: cfg.SOURCE_COMMAND,
    commandTimeoutMs: cfg.SOURCE_COMMAND_TIMEOUT_SECONDS * 1000,
    waitSeconds: cfg.SOURCE_WAIT_SECONDS,
    workDir: cfg.WORK_DIR,
  });

  logger.info({ jobId: job.id, videoId: job.video_id, path }, "resolved master file");
  store.updateJob(job.id, { source_path: path, state: "processing", last_error: null });
}

async function stageEncode(store: Store, cfg: Config, job: JobRow): Promise<void> {
  if (!job.source_path) throw new TerminalJobError("job reached encode with no source path");

  const info = await probe(cfg.FFPROBE_PATH, job.source_path);
  if (!info.hasVideo) throw new TerminalJobError(`${job.source_path} has no video stream`);

  const clip =
    job.clip_start_sec !== null && job.clip_duration_sec
      ? { startSec: job.clip_start_sec, durationSec: job.clip_duration_sec }
      : undefined;

  const output = join(resolve(cfg.WORK_DIR), `${job.video_id}.${job.clip_index}.mp4`);

  const targets = {
    i: cfg.LOUDNESS_TARGET_I,
    tp: cfg.LOUDNESS_TARGET_TP,
    lra: cfg.LOUDNESS_TARGET_LRA,
  };

  // Decide the cheapest correct path before doing any work.
  const plan = decideEncodePlan(
    {
      width: info.width,
      height: info.height,
      fps: info.fps,
      hasAudio: info.hasAudio,
      videoCodec: info.videoCodec,
      audioCodec: info.audioCodec,
    },
    {
      width: cfg.OUTPUT_WIDTH,
      height: cfg.OUTPUT_HEIGHT,
      verticalMode: cfg.VERTICAL_MODE,
      autoReframeMode: cfg.AUTO_REFRAME_MODE,
      loudnessEnabled: cfg.LOUDNESS_ENABLED,
      clip,
    }
  );

  logger.info(
    { jobId: job.id, plan: plan.kind, reason: plan.reason, clip: clip ?? "full" },
    plan.kind === "copy"
      ? "source already publishable - remuxing without re-encoding"
      : plan.kind === "audio-only"
        ? "keeping video stream, re-encoding audio only"
        : "encoding vertical cut"
  );

  if (plan.kind === "copy") {
    await run(cfg.FFMPEG_PATH, buildCopyArgs(job.source_path, output), { timeoutMs: 3_600_000 });
  } else if (plan.kind === "audio-only") {
    const measured = await measureLoudness(cfg.FFMPEG_PATH, job.source_path, targets, clip);
    await run(
      cfg.FFMPEG_PATH,
      buildAudioOnlyArgs(job.source_path, output, {
        audioFilter: cfg.LOUDNESS_ENABLED ? buildLoudnormApplyFilter(targets, measured) : undefined,
        audioBitrate: cfg.AUDIO_BITRATE,
      }),
      { timeoutMs: 3_600_000 }
    );
  } else {
    const loudness =
      cfg.LOUDNESS_ENABLED && info.hasAudio
        ? {
            targets,
            measured: await measureLoudness(cfg.FFMPEG_PATH, job.source_path, targets, clip),
          }
        : null;

    await transcode(cfg.FFMPEG_PATH, {
      input: job.source_path,
      output,
      mode: plan.mode,
      width: cfg.OUTPUT_WIDTH,
      height: cfg.OUTPUT_HEIGHT,
      fps: cfg.OUTPUT_FPS,
      crf: cfg.VIDEO_CRF,
      preset: cfg.VIDEO_PRESET,
      audioBitrate: cfg.AUDIO_BITRATE,
      padColor: cfg.PAD_COLOR,
      hasAudio: info.hasAudio,
      clip,
      loudness,
    });
  }

  const { size: bytes } = await stat(output);

  // In handoff mode the file is validated against the publisher's limits now,
  // while the cause is still local and cheap to fix, rather than after an
  // upload that TikTok may only reject asynchronously.
  if (cfg.TIKTOK_PUBLISH_MODE === "handoff") {
    const encoded = await probe(cfg.FFPROBE_PATH, output);
    const problems = validateForHandoff({
      durationSec: encoded.durationSec,
      width: encoded.width,
      height: encoded.height,
      fps: encoded.fps,
      bytes,
    });
    if (problems.length) {
      throw new TerminalJobError(`encoded file is not publishable: ${problems.join("; ")}`);
    }
  }

  const nextState = cfg.REQUIRE_REVIEW ? "awaiting_review" : "approved";
  logger.info({ jobId: job.id, output, bytes, nextState }, "encode complete");
  store.updateJob(job.id, { output_path: output, state: nextState, last_error: null });
}

async function stagePublish(store: Store, cfg: Config, job: JobRow): Promise<void> {
  if (!job.output_path) throw new TerminalJobError("job reached publish with no encoded file");

  // Checked BEFORE DRY_RUN: handing off is not an outbound action, so there is
  // nothing for a dry run to suppress. Letting DRY_RUN win here would mark the
  // job published, leave the handoff queue permanently empty, and report
  // success for work that was never handed to anyone.
  if (cfg.TIKTOK_PUBLISH_MODE === "handoff") {
    logger.info(
      { jobId: job.id, output: job.output_path },
      "encoded and held for handoff - run `cli ready` to collect it"
    );
    store.updateJob(job.id, { state: "awaiting_handoff", last_error: null });
    return;
  }

  if (cfg.DRY_RUN) {
    logger.warn({ jobId: job.id }, "DRY_RUN: skipping upload to TikTok");
    store.updateJob(job.id, {
      state: "published",
      publish_id: "dry-run",
      tiktok_status: "DRY_RUN",
    });
    return;
  }

  if (!cfg.TIKTOK_CLIENT_KEY || !cfg.TIKTOK_CLIENT_SECRET) {
    throw new TerminalJobError("TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not configured");
  }

  const accessToken = await getAccessToken(store, {
    clientKey: cfg.TIKTOK_CLIENT_KEY,
    clientSecret: cfg.TIKTOK_CLIENT_SECRET,
  });

  const { size } = await stat(job.output_path);
  const plan = planFor(size, cfg.TIKTOK_CHUNK_SIZE_MB);

  store.updateJob(job.id, { state: "publishing" });

  let init: { publish_id: string; upload_url: string };
  if (cfg.TIKTOK_PUBLISH_MODE === "direct") {
    const creator = await queryCreatorInfo(accessToken);

    // Name the destination in the log. On an unattended public setup this is
    // the only place the account being posted to is ever stated.
    logger.info(
      {
        jobId: job.id,
        account: creator.creator_username ?? "unknown",
        privacyLevel: cfg.TIKTOK_PRIVACY_LEVEL,
      },
      "posting directly to TikTok profile"
    );

    const allowed = creator.privacy_level_options ?? [];
    if (allowed.length && !allowed.includes(cfg.TIKTOK_PRIVACY_LEVEL)) {
      throw new TerminalJobError(
        `TIKTOK_PRIVACY_LEVEL=${cfg.TIKTOK_PRIVACY_LEVEL} is not offered by this account (allowed: ${allowed.join(", ")}). ` +
          `PUBLIC_TO_EVERYONE requires an audited app; an unaudited one can only post SELF_ONLY.`
      );
    }

    // The per-creator duration cap is returned by creator_info and varies by
    // account. Checking it here costs one ffprobe; skipping it costs a full
    // upload followed by a rejection.
    const cap = creator.max_video_post_duration_sec;
    if (typeof cap === "number" && cap > 0) {
      const encoded = await probe(cfg.FFPROBE_PATH, job.output_path);
      if (encoded.durationSec > cap) {
        throw new TerminalJobError(
          `clip is ${encoded.durationSec.toFixed(0)}s but this account may post at most ${cap}s - ` +
            `lower CLIP_TARGET_SECONDS to ${cap} or less`
        );
      }
    }
    init = await initDirectPost(accessToken, plan, {
      title: job.caption ?? "",
      privacyLevel: cfg.TIKTOK_PRIVACY_LEVEL,
      // The account-level toggles win: asking to enable what the account
      // disables is rejected outright.
      disableComment: cfg.TIKTOK_DISABLE_COMMENT || Boolean(creator.comment_disabled),
      disableDuet: cfg.TIKTOK_DISABLE_DUET || Boolean(creator.duet_disabled),
      disableStitch: cfg.TIKTOK_DISABLE_STITCH || Boolean(creator.stitch_disabled),
    });
  } else {
    init = await initInboxUpload(accessToken, plan);
  }

  logger.info(
    { jobId: job.id, publishId: init.publish_id, chunks: plan.totalChunkCount, bytes: size },
    "uploading to TikTok"
  );

  await uploadChunks(init.upload_url, job.output_path, plan, {
    onProgress: (done, total) =>
      logger.debug({ jobId: job.id, done, total }, "chunk uploaded"),
  });

  store.updateJob(job.id, {
    publish_id: init.publish_id,
    state: "publishing",
    tiktok_status: "PROCESSING_UPLOAD",
    last_error: null,
    // Give TikTok a moment before the first status poll.
    next_attempt_at: sqlTimestampIn(15_000),
  });
}

async function stagePollStatus(store: Store, cfg: Config, job: JobRow): Promise<void> {
  if (!job.publish_id) {
    // Upload never got as far as an id; send it back to be re-initiated.
    store.updateJob(job.id, { state: "approved" });
    return;
  }
  if (!cfg.TIKTOK_CLIENT_KEY || !cfg.TIKTOK_CLIENT_SECRET) {
    throw new TerminalJobError("TikTok credentials are not configured");
  }

  const accessToken = await getAccessToken(store, {
    clientKey: cfg.TIKTOK_CLIENT_KEY,
    clientSecret: cfg.TIKTOK_CLIENT_SECRET,
  });
  const status = await fetchPublishStatus(accessToken, job.publish_id);

  if (DONE.has(status.status)) {
    logger.info({ jobId: job.id, status: status.status }, "published to TikTok");
    store.updateJob(job.id, { state: "published", tiktok_status: status.status });
    await cleanupWorkFile(job.output_path);
    return;
  }
  if (FAILED.has(status.status)) {
    throw new TerminalJobError(`TikTok publish failed: ${status.fail_reason ?? "unknown reason"}`);
  }

  // Still processing - poll again shortly without burning an attempt.
  store.updateJob(job.id, {
    tiktok_status: status.status,
    next_attempt_at: sqlTimestampIn(20_000),
  });
}

async function cleanupWorkFile(path: string | null): Promise<void> {
  if (!path) return;
  try {
    await unlink(path);
  } catch {
    /* the encode is disposable; a failed cleanup is not worth failing the job */
  }
}

function isTerminal(err: unknown): boolean {
  if (err instanceof TerminalJobError) return true;
  if (err instanceof TikTokApiError) return err.isTerminal;
  return false;
}

export async function tick(store: Store, cfg: Config): Promise<number> {
  const jobs = store.claimableJobs(3);
  let handled = 0;

  for (const job of jobs) {
    try {
      await runJobOnce(store, cfg, job);
      handled++;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const attempts = job.attempts + 1;
      const terminal = isTerminal(err) || attempts >= cfg.MAX_ATTEMPTS;

      if (terminal) {
        logger.error({ jobId: job.id, attempts, err: message }, "job failed permanently");
        store.updateJob(job.id, { state: "failed", attempts, last_error: message });
      } else {
        const delay = jitter(backoffMs(attempts));
        logger.warn(
          { jobId: job.id, attempts, retryInMs: delay, err: message },
          "job failed, will retry"
        );
        store.updateJob(job.id, {
          attempts,
          last_error: message,
          next_attempt_at: sqlTimestampIn(delay),
          // A missing master is worth re-checking from the sourcing stage.
          state: err instanceof SourceNotFoundError ? "pending" : job.state,
        });
      }
    }
  }
  return handled;
}

export function startWorker(store: Store, cfg: Config, intervalMs = 5_000): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      await tick(store, cfg);
    } catch (err) {
      logger.error({ err: (err as Error).message }, "worker tick failed");
    }
    if (!stopped) timer = setTimeout(loop, intervalMs);
  };

  void loop();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
