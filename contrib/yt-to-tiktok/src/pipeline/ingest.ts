import type { Config } from "../config.js";
import type { Store } from "../db.js";
import { logger } from "../logger.js";
import { buildCaption } from "../util/caption.js";
import { ageMinutes } from "../util/time.js";
import { planClips } from "../media/clip.js";
import { HANDOFF_LIMITS } from "./handoff.js";
import { getVideoDetails, type VideoDetails } from "../youtube/api.js";
import { probe } from "../media/ffmpeg.js";
import type { WatchedFile } from "../source/watcher.js";

export type IngestOutcome =
  | { accepted: true; videoId: string; jobIds: number[] }
  | { accepted: false; videoId: string; reason: string };

export interface IngestCandidate {
  videoId: string;
  channelId: string;
  title: string;
  publishedAt: string;
}

/**
 * Turns a discovered upload into one or more publish jobs.
 *
 * Every rejection path returns a reason rather than throwing: a feed delivers
 * things we do not want (edits to old videos, a backlog replay on first
 * subscribe, livestreams), and none of those are errors.
 */
export async function ingestCandidate(
  store: Store,
  cfg: Config,
  candidate: IngestCandidate,
  opts: { force?: boolean; now?: number } = {}
): Promise<IngestOutcome> {
  const { videoId } = candidate;
  const now = opts.now ?? Date.now();

  // A feed should only ever carry our own channel. If it does not, something is
  // misconfigured and we must not process it.
  if (cfg.YOUTUBE_CHANNEL_ID && candidate.channelId !== cfg.YOUTUBE_CHANNEL_ID) {
    return { accepted: false, videoId, reason: `foreign channel ${candidate.channelId}` };
  }

  if (!opts.force) {
    const age = ageMinutes(candidate.publishedAt, now);
    if (age > cfg.MAX_VIDEO_AGE_MINUTES) {
      return {
        accepted: false,
        videoId,
        reason: `published ${Math.round(age)}m ago, older than MAX_VIDEO_AGE_MINUTES=${cfg.MAX_VIDEO_AGE_MINUTES}`,
      };
    }
  }

  // The idempotency gate. The hub redelivers, and re-notifies on metadata edits;
  // both land here and both stop here.
  const isNew = store.insertVideoIfNew({
    videoId,
    channelId: candidate.channelId,
    title: candidate.title,
    publishedAt: candidate.publishedAt,
  });
  if (!isNew && !opts.force) {
    return { accepted: false, videoId, reason: "already seen" };
  }

  let details: VideoDetails | null = null;
  if (cfg.YOUTUBE_API_KEY) {
    try {
      details = await getVideoDetails(cfg.YOUTUBE_API_KEY, videoId);
    } catch (err) {
      logger.warn({ videoId, err: (err as Error).message }, "could not fetch video details");
    }
  }

  if (details) {
    store.updateVideoMetadata(videoId, {
      title: details.title || candidate.title,
      description: details.description,
      durationSec: details.durationSec,
      privacyStatus: details.privacyStatus,
    });

    if (!cfg.ALLOWED_PRIVACY_STATUSES.includes(details.privacyStatus)) {
      store.updateVideoMetadata(videoId, { state: "skipped" });
      return { accepted: false, videoId, reason: `privacy status ${details.privacyStatus}` };
    }

    // A live or scheduled item has no final file yet.
    if (details.liveBroadcastContent && details.liveBroadcastContent !== "none") {
      store.updateVideoMetadata(videoId, { state: "skipped" });
      return { accepted: false, videoId, reason: `live/upcoming (${details.liveBroadcastContent})` };
    }
  }

  const title = details?.title || candidate.title;
  const durationSec = details?.durationSec ?? null;

  // Without a known duration we cannot segment, so post the whole thing and let
  // the encode stage work with what the master actually contains.
  const clips = durationSec
    ? planClips({
        durationSec,
        thresholdSec: cfg.CLIP_THRESHOLD_SECONDS,
        targetSec: cfg.CLIP_TARGET_SECONDS,
        maxCount: cfg.CLIP_MAX_COUNT,
        headTrimSec: cfg.CLIP_HEAD_TRIM_SECONDS,
        tailTrimSec: cfg.CLIP_TAIL_TRIM_SECONDS,
      })
    : [{ index: 0, startSec: 0, durationSec: 0 }];

  const jobIds: number[] = [];
  for (const clip of clips) {
    const caption = buildCaption(
      {
        title,
        description: details?.description ?? null,
        videoId,
        clipIndex: clip.index,
        clipCount: clips.length,
      },
      {
        template: cfg.CAPTION_TEMPLATE,
        hashtags: cfg.CAPTION_HASHTAGS,
        // The handoff publisher caps the title far below a native TikTok
        // caption, so build to the tighter limit rather than truncating later.
        maxLength:
          cfg.TIKTOK_PUBLISH_MODE === "handoff"
            ? Math.min(cfg.CAPTION_MAX_LENGTH, HANDOFF_LIMITS.maxTitleLength)
            : cfg.CAPTION_MAX_LENGTH,
      }
    );

    const id = store.createJob(
      videoId,
      clip.index,
      // A zero-duration clip means "whole video": store no clip bounds at all.
      clip.durationSec > 0 && clips.length > 1
        ? { start: clip.startSec, duration: clip.durationSec }
        : undefined
    );
    if (id > 0) {
      store.updateJob(id, { caption });
      jobIds.push(id);
    }
  }

  store.updateVideoMetadata(videoId, { state: "queued" });
  logger.info({ videoId, title, jobs: jobIds.length }, "queued upload for repurposing");
  return { accepted: true, videoId, jobIds };
}


/**
 * Queues a master file directly, without involving YouTube at all.
 *
 * Duration comes from the file itself rather than the Data API, which is what
 * lets clip planning work with no API key. The file is already in hand, so the
 * jobs skip the sourcing stage entirely.
 */
export async function ingestLocalFile(
  store: Store,
  cfg: Config,
  file: WatchedFile
): Promise<IngestOutcome> {
  const { videoId } = file;

  const isNew = store.insertVideoIfNew({
    videoId,
    channelId: cfg.YOUTUBE_CHANNEL_ID ?? "local",
    title: file.title,
    publishedAt: new Date().toISOString(),
    privacyStatus: "local",
  });
  if (!isNew) return { accepted: false, videoId, reason: "already seen" };

  let durationSec: number | null = null;
  try {
    durationSec = (await probe(cfg.FFPROBE_PATH, file.path)).durationSec || null;
  } catch (err) {
    // Without a duration we cannot segment, but we can still post it whole.
    logger.warn(
      { file: file.path, err: (err as Error).message },
      "could not read duration; posting the file whole"
    );
  }
  store.updateVideoMetadata(videoId, { durationSec });

  const clips = durationSec
    ? planClips({
        durationSec,
        thresholdSec: cfg.CLIP_THRESHOLD_SECONDS,
        targetSec: cfg.CLIP_TARGET_SECONDS,
        maxCount: cfg.CLIP_MAX_COUNT,
        headTrimSec: cfg.CLIP_HEAD_TRIM_SECONDS,
        tailTrimSec: cfg.CLIP_TAIL_TRIM_SECONDS,
      })
    : [{ index: 0, startSec: 0, durationSec: 0 }];

  const jobIds: number[] = [];
  for (const clip of clips) {
    const caption = buildCaption(
      { title: file.title, videoId, clipIndex: clip.index, clipCount: clips.length },
      {
        template: cfg.CAPTION_TEMPLATE,
        hashtags: cfg.CAPTION_HASHTAGS,
        maxLength:
          cfg.TIKTOK_PUBLISH_MODE === "handoff"
            ? Math.min(cfg.CAPTION_MAX_LENGTH, HANDOFF_LIMITS.maxTitleLength)
            : cfg.CAPTION_MAX_LENGTH,
      }
    );

    const id = store.createJob(
      videoId,
      clip.index,
      clip.durationSec > 0 && clips.length > 1
        ? { start: clip.startSec, duration: clip.durationSec }
        : undefined
    );
    if (id > 0) {
      // The file is already here, so skip sourcing and go straight to encoding.
      store.updateJob(id, { caption, source_path: file.path, state: "processing" });
      jobIds.push(id);
    }
  }

  store.updateVideoMetadata(videoId, { state: "queued" });
  logger.info(
    { videoId, file: file.path, title: file.title, jobs: jobIds.length },
    "queued local master for publishing"
  );
  return { accepted: true, videoId, jobIds };
}
