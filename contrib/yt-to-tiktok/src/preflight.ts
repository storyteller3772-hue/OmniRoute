import type { Config } from "./config.js";
import { HANDOFF_LIMITS } from "./pipeline/handoff.js";

export interface PreflightResult {
  /** Misconfigurations that would fail at the first publish. Refuse to start. */
  fatal: string[];
  /** Things worth stating loudly but which do not stop the process. */
  warnings: string[];
}

/**
 * Catches configuration that only breaks much later - at the first upload, or
 * silently by never triggering at all.
 *
 * This matters most for an unattended setup: with review off there is no human
 * in the loop to notice a job failing every retry, so the mistakes have to be
 * caught before the process starts serving.
 */
/**
 * Quick-tunnel hostnames are randomly regenerated per run. Named Cloudflare
 * tunnels use the operator's own domain and are not matched here.
 */
export function isEphemeralTunnel(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // e.g. shy-mountain-1234.trycloudflare.com, 1a2b3c4d.ngrok-free.app
  if (host.endsWith(".trycloudflare.com")) return true;
  if (/^[0-9a-f]{8,}\./.test(host) && /\.ngrok(-free)?\.(app|io|dev)$/.test(host)) return true;
  if (/\.loca\.lt$/.test(host)) return true;
  return false;
}

export function checkRuntimeConfig(cfg: Config): PreflightResult {
  const fatal: string[] = [];
  const warnings: string[] = [];

  const needsTikTokCreds = cfg.TIKTOK_PUBLISH_MODE !== "handoff" && !cfg.DRY_RUN;
  if (needsTikTokCreds && (!cfg.TIKTOK_CLIENT_KEY || !cfg.TIKTOK_CLIENT_SECRET)) {
    fatal.push(
      `TIKTOK_PUBLISH_MODE=${cfg.TIKTOK_PUBLISH_MODE} needs TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET`
    );
  }
  if (needsTikTokCreds && !cfg.TIKTOK_REDIRECT_URI) {
    fatal.push("TIKTOK_REDIRECT_URI is required to complete the OAuth flow");
  }
  if (cfg.SOURCE_MODE === "command" && !cfg.SOURCE_COMMAND) {
    fatal.push("SOURCE_MODE=command requires SOURCE_COMMAND");
  }
  if (cfg.CLIP_HEAD_TRIM_SECONDS + cfg.CLIP_TAIL_TRIM_SECONDS >= cfg.CLIP_THRESHOLD_SECONDS) {
    warnings.push(
      "CLIP_HEAD_TRIM_SECONDS + CLIP_TAIL_TRIM_SECONDS is at or above CLIP_THRESHOLD_SECONDS; long videos will fall back to a single clip"
    );
  }

  // The unattended-public combination. Stated plainly because it is the one
  // configuration where a bad encode reaches an audience with nobody watching.
  if (
    cfg.TIKTOK_PUBLISH_MODE === "direct" &&
    !cfg.REQUIRE_REVIEW &&
    cfg.TIKTOK_PRIVACY_LEVEL === "PUBLIC_TO_EVERYONE"
  ) {
    warnings.push(
      "UNATTENDED PUBLIC POSTING: every upload will go live on your profile with no approval step"
    );
  }

  if (cfg.TIKTOK_PUBLISH_MODE === "handoff") {
    if (cfg.CLIP_TARGET_SECONDS > HANDOFF_LIMITS.maxDurationSec) {
      fatal.push(
        `CLIP_TARGET_SECONDS=${cfg.CLIP_TARGET_SECONDS} exceeds the ${HANDOFF_LIMITS.maxDurationSec}s handoff limit`
      );
    }
    if (cfg.OUTPUT_FPS < HANDOFF_LIMITS.minFps || cfg.OUTPUT_FPS > HANDOFF_LIMITS.maxFps) {
      fatal.push(
        `OUTPUT_FPS=${cfg.OUTPUT_FPS} is outside the ${HANDOFF_LIMITS.minFps}-${HANDOFF_LIMITS.maxFps} range the handoff publisher accepts`
      );
    }
  }

  if (!cfg.PUBLIC_URL && !cfg.WATCH_MASTERS) {
    warnings.push("PUBLIC_URL is not set: no push notifications, polling only");
  } else if (cfg.PUBLIC_URL && isEphemeralTunnel(cfg.PUBLIC_URL)) {
    // A URL that changes on restart breaks the registered redirect URI and
    // leaves the submitted policy links dead.
    warnings.push(
      `PUBLIC_URL=${cfg.PUBLIC_URL} looks like a throwaway tunnel. It will change on restart, ` +
        "breaking OAuth and your submitted policy links. Use a stable hostname - see deploy/tunnel.md"
    );
  }
  if (!cfg.WEBSUB_SECRET && cfg.PUBLIC_URL) {
    warnings.push("WEBSUB_SECRET is not set: the callback will reject every notification");
  }
  if (!cfg.YOUTUBE_API_KEY && !cfg.WATCH_MASTERS) {
    warnings.push("YOUTUBE_API_KEY is not set: no metadata, no duration, no polling fallback");
  }
  if (cfg.WATCH_MASTERS && !cfg.YOUTUBE_API_KEY && !cfg.PUBLIC_URL) {
    warnings.push(
      "running in watch-only mode: drop a master into SOURCE_DIR to publish it (no YouTube credentials in use)"
    );
  }
  if (cfg.TIKTOK_PUBLISH_MODE !== "handoff" && !cfg.EXPECTED_TIKTOK_USERNAME) {
    warnings.push(
      "EXPECTED_TIKTOK_USERNAME is not set: if the authorisation was approved while signed into the wrong TikTok account, nothing will catch it"
    );
  }
  if (!cfg.YOUTUBE_CHANNEL_ID) {
    warnings.push("YOUTUBE_CHANNEL_ID is not set: uploads from any channel would be accepted");
  }
  if (cfg.HOST !== "127.0.0.1" && cfg.HOST !== "localhost" && !cfg.REVIEW_TOKEN) {
    warnings.push(
      `HOST=${cfg.HOST} exposes the review UI beyond loopback with no REVIEW_TOKEN set`
    );
  }

  return { fatal, warnings };
}
