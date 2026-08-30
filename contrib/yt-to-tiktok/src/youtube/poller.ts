import type { Config } from "../config.js";
import type { Store } from "../db.js";
import { logger } from "../logger.js";
import { ingestCandidate } from "../pipeline/ingest.js";
import { listRecentUploads, resolveChannel } from "./api.js";

/**
 * Safety net for the push path.
 *
 * WebSub is the fast trigger, but a lease can lapse, a callback can be
 * unreachable during a redeploy, and the hub does not retry forever. Polling
 * every few minutes closes that gap; ingestion is idempotent, so an upload seen
 * by both paths is still processed once.
 */
export async function pollOnce(store: Store, cfg: Config): Promise<number> {
  if (!cfg.YOUTUBE_API_KEY || !cfg.YOUTUBE_CHANNEL_ID) return 0;

  const channel = await resolveChannel(cfg.YOUTUBE_API_KEY, cfg.YOUTUBE_CHANNEL_ID);
  if (!channel) {
    logger.warn({ channelId: cfg.YOUTUBE_CHANNEL_ID }, "poller could not resolve channel");
    return 0;
  }

  const uploads = await listRecentUploads(cfg.YOUTUBE_API_KEY, channel.uploadsPlaylistId, 10);
  let accepted = 0;

  for (const item of uploads) {
    if (store.hasVideo(item.videoId)) continue;
    const outcome = await ingestCandidate(store, cfg, {
      videoId: item.videoId,
      channelId: channel.channelId,
      title: item.title,
      publishedAt: item.publishedAt,
    });
    if (outcome.accepted) {
      accepted++;
      logger.info({ videoId: item.videoId }, "poller picked up an upload the push path missed");
    }
  }
  return accepted;
}

export function startPoller(store: Store, cfg: Config): { stop: () => void } {
  if (cfg.POLL_INTERVAL_SECONDS <= 0) return { stop: () => {} };

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      await pollOnce(store, cfg);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "poll failed");
    }
    if (!stopped) timer = setTimeout(loop, cfg.POLL_INTERVAL_SECONDS * 1000);
  };

  timer = setTimeout(loop, cfg.POLL_INTERVAL_SECONDS * 1000);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
