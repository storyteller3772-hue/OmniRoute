import { z } from "zod";

/**
 * All configuration is environment-driven and validated at startup. A bad value
 * should stop the process immediately rather than surface as a mangled FFmpeg
 * invocation or a half-authenticated publish three steps later.
 */

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const csv = z
  .string()
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

const schema = z.object({
  // ---- server ----
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default("127.0.0.1"),
  /** Public HTTPS origin the WebSub hub can reach, e.g. https://yt2tt.example.com */
  PUBLIC_URL: z.string().url().optional(),

  // ---- storage ----
  DATA_DIR: z.string().default("./data"),
  WORK_DIR: z.string().default("./data/work"),

  // ---- youtube ----
  YOUTUBE_API_KEY: z.string().min(1).optional(),
  /** UC-prefixed channel id. Resolve from a @handle with `npm run cli -- resolve-channel`. */
  YOUTUBE_CHANNEL_ID: z
    .string()
    .regex(/^UC[A-Za-z0-9_-]{22}$/, "must be a UC-prefixed 24-char channel id")
    .optional(),
  /** Shared secret for WebSub X-Hub-Signature verification. Generate with `openssl rand -hex 32`. */
  WEBSUB_SECRET: z.string().min(16).optional(),
  WEBSUB_HUB: z.string().url().default("https://pubsubhubbub.appspot.com/subscribe"),
  WEBSUB_LEASE_SECONDS: z.coerce.number().int().min(300).max(864000).default(432000),
  /** Poller runs as a safety net for missed/expired push notifications. 0 disables. */
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(300),
  /**
   * Ignore feed entries whose publish time is older than this. YouTube replays
   * recent uploads when a subscription is first verified, and re-notifies on
   * metadata edits of old videos; without this guard a fresh install would
   * enqueue the whole visible backlog.
   */
  MAX_VIDEO_AGE_MINUTES: z.coerce.number().int().min(1).default(120),
  /** Only repurpose uploads with these privacy statuses. */
  ALLOWED_PRIVACY_STATUSES: csv.default("public"),

  // ---- source resolution ----
  /** How the master video file for an upload is located. */
  SOURCE_MODE: z.enum(["local", "command"]).default("local"),
  /** `local` mode: directory holding your master files. */
  SOURCE_DIR: z.string().default("./data/masters"),
  /**
   * `command` mode: an operator-supplied executable. Receives YT2TT_VIDEO_ID,
   * YT2TT_OUTPUT_PATH and YT2TT_VIDEO_URL via the environment - never
   * interpolated into a shell string.
   */
  SOURCE_COMMAND: z.string().optional(),
  SOURCE_COMMAND_TIMEOUT_SECONDS: z.coerce.number().int().min(10).default(900),
  /** `local` mode: how long to wait for a master file to appear before failing. */
  SOURCE_WAIT_SECONDS: z.coerce.number().int().min(0).default(0),

  // ---- media ----
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  VERTICAL_MODE: z.enum(["blur", "crop", "pad"]).default("blur"),
  OUTPUT_WIDTH: z.coerce.number().int().default(1080),
  OUTPUT_HEIGHT: z.coerce.number().int().default(1920),
  OUTPUT_FPS: z.coerce.number().int().min(1).max(60).default(30),
  VIDEO_CRF: z.coerce.number().int().min(0).max(51).default(20),
  VIDEO_PRESET: z.string().default("medium"),
  AUDIO_BITRATE: z.string().default("128k"),
  PAD_COLOR: z.string().default("black"),
  /** Two-pass EBU R128 normalisation. Disable to keep the master's own levels. */
  LOUDNESS_ENABLED: bool.default("true"),
  LOUDNESS_TARGET_I: z.coerce.number().default(-14),
  LOUDNESS_TARGET_TP: z.coerce.number().default(-1.5),
  LOUDNESS_TARGET_LRA: z.coerce.number().default(11),

  // ---- clipping (long-form -> shorts) ----
  /** Videos longer than this get segmented into clips. */
  CLIP_THRESHOLD_SECONDS: z.coerce.number().int().min(0).default(180),
  CLIP_TARGET_SECONDS: z.coerce.number().int().min(5).default(60),
  CLIP_MAX_COUNT: z.coerce.number().int().min(1).max(20).default(3),
  /** Skip this much of the head/tail when segmenting (intros and outros). */
  CLIP_HEAD_TRIM_SECONDS: z.coerce.number().int().min(0).default(0),
  CLIP_TAIL_TRIM_SECONDS: z.coerce.number().int().min(0).default(0),

  // ---- tiktok ----
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  TIKTOK_REDIRECT_URI: z.string().url().optional(),
  /**
   * `inbox` sends the file to your TikTok drafts for you to finish and post -
   * works with an unaudited app and the `video.upload` scope. `direct` publishes
   * straight to the profile and needs `video.publish` plus an audited app.
   * `handoff` stops after encoding and holds the file for an external publisher
   * (see README - "Handoff mode"); the pipeline never talks to TikTok itself.
   */
  TIKTOK_PUBLISH_MODE: z.enum(["inbox", "direct", "handoff"]).default("inbox"),
  TIKTOK_PRIVACY_LEVEL: z
    .enum([
      "PUBLIC_TO_EVERYONE",
      "MUTUAL_FOLLOW_FRIENDS",
      "FOLLOWER_OF_CREATOR",
      "SELF_ONLY",
    ])
    .default("SELF_ONLY"),
  TIKTOK_DISABLE_COMMENT: bool.default("false"),
  TIKTOK_DISABLE_DUET: bool.default("false"),
  TIKTOK_DISABLE_STITCH: bool.default("false"),
  /** Preferred upload chunk size in MiB; clamped to TikTok's 5-64 MiB window. */
  TIKTOK_CHUNK_SIZE_MB: z.coerce.number().int().min(5).max(64).default(10),

  // ---- caption ----
  CAPTION_TEMPLATE: z.string().default("{title}"),
  CAPTION_HASHTAGS: csv.default(""),
  CAPTION_MAX_LENGTH: z.coerce.number().int().min(1).default(2200),

  // ---- legal pages ----
  /**
   * Identity shown on the served Terms and Privacy pages. TikTok requires both
   * to be publicly reachable before an app can add products or be submitted.
   */
  LEGAL_ENTITY_NAME: z.string().min(1).default("The operator of this service"),
  LEGAL_CONTACT_EMAIL: z.string().email().optional(),
  LEGAL_EFFECTIVE_DATE: z.string().optional(),

  // ---- safety ----
  /**
   * Nothing reaches TikTok until a human approves it. Turning this off is a
   * deliberate choice, not a default.
   */
  REQUIRE_REVIEW: bool.default("true"),
  /**
   * Required as `Authorization: Bearer <token>` on the review and job endpoints.
   * The WebSub callback is exempt - it authenticates with its own HMAC.
   */
  REVIEW_TOKEN: z.string().min(8).optional(),
  DRY_RUN: bool.default("false"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test seam - lets a test swap in a config without touching process.env. */
export function setConfig(c: Config): void {
  cached = c;
}
