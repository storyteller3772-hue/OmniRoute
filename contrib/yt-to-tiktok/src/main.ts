import { loadConfig } from "./config.js";
import { openStore } from "./db.js";
import { logger } from "./logger.js";
import { checkRuntimeConfig } from "./preflight.js";
import { createHttpServer } from "./server.js";
import { startWorker } from "./pipeline/worker.js";
import { startPoller } from "./youtube/poller.js";
import { callbackUrlFor, ensureSubscription, topicUrlFor } from "./youtube/websub.js";

async function main(): Promise<void> {
  const cfg = loadConfig();

  // Refuse to start on configuration that would only fail at the first publish.
  const { fatal, warnings } = checkRuntimeConfig(cfg);
  for (const w of warnings) logger.warn(w);
  if (fatal.length) {
    for (const f of fatal) logger.fatal(f);
    throw new Error(`${fatal.length} fatal configuration problem(s); refusing to start`);
  }

  const store = openStore(cfg.DATA_DIR);

  const server = createHttpServer(store, cfg);
  await new Promise<void>((resolve) => server.listen(cfg.PORT, cfg.HOST, resolve));
  logger.info(
    { host: cfg.HOST, port: cfg.PORT, publishMode: cfg.TIKTOK_PUBLISH_MODE, dryRun: cfg.DRY_RUN },
    "yt-to-tiktok listening"
  );

  if (cfg.REQUIRE_REVIEW) {
    logger.info("REQUIRE_REVIEW is on - nothing uploads until you approve it");
  } else {
    logger.warn(
      { mode: cfg.TIKTOK_PUBLISH_MODE, privacy: cfg.TIKTOK_PRIVACY_LEVEL },
      "REQUIRE_REVIEW is OFF - encodes will publish automatically"
    );
  }

  // WebSub subscription plus renewal. The lease is finite, so renewal is not
  // optional: miss it and the push path goes quiet with no error anywhere.
  let renewTimer: NodeJS.Timeout | undefined;
  if (cfg.PUBLIC_URL && cfg.YOUTUBE_CHANNEL_ID && cfg.WEBSUB_SECRET) {
    const topic = topicUrlFor(cfg.YOUTUBE_CHANNEL_ID);
    const callback = callbackUrlFor(cfg.PUBLIC_URL);
    const subscribe = async (): Promise<void> => {
      try {
        await ensureSubscription(store, {
          hub: cfg.WEBSUB_HUB,
          topic,
          callback,
          secret: cfg.WEBSUB_SECRET as string,
          leaseSeconds: cfg.WEBSUB_LEASE_SECONDS,
        });
      } catch (err) {
        logger.error({ err: (err as Error).message }, "WebSub subscription failed");
      }
    };
    await subscribe();
    renewTimer = setInterval(subscribe, 60 * 60 * 1000);
  } else {
    logger.warn(
      "PUBLIC_URL, YOUTUBE_CHANNEL_ID or WEBSUB_SECRET missing - push notifications are disabled, falling back to polling"
    );
  }

  const worker = startWorker(store, cfg);
  const poller = startPoller(store, cfg);

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutting down");
    worker.stop();
    poller.stop();
    if (renewTimer) clearInterval(renewTimer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
    // Do not let an in-flight upload hold the process open indefinitely.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, "failed to start");
  process.exit(1);
});
