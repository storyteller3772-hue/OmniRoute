import { loadConfig, type Config } from "./config.js";
import { openStore, type Store } from "./db.js";
import { run } from "./media/ffmpeg.js";
import { ingestCandidate } from "./pipeline/ingest.js";
import { getVideoDetails, resolveChannel } from "./youtube/api.js";
import { callbackUrlFor, sendSubscriptionRequest, topicUrlFor } from "./youtube/websub.js";
import {
  buildAuthorizeUrl,
  codeChallengeFrom,
  generateCodeVerifier,
  PROVIDER,
  SCOPE_DIRECT,
  SCOPE_INBOX,
} from "./tiktok/oauth.js";

const USAGE = `yt-to-tiktok

  resolve-channel <@handle|UC...>  Look up the channel id and uploads playlist
  subscribe                        Ask the WebSub hub to start pushing uploads
  unsubscribe                      Cancel the push subscription
  tiktok-login                     Print the TikTok authorisation URL
  ingest <videoId> [--force]       Queue one video by hand
  jobs [state]                     List jobs
  approve <id> | reject <id>       Act on a job awaiting review
  ready                            List encoded files waiting to be published (JSON)
  mark-published <id> [--post-id X]  Record that a handed-off job went live
  mark-failed <id> <reason>        Record that a handed-off job could not be published
  status                           Show subscription, token and job summary
  whoami                           Show WHICH TikTok account posts will go to
  doctor                           Check config and external tools
`;

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const cfg = loadConfig();

  switch (cmd) {
    case "resolve-channel":
      return resolveChannelCmd(cfg, args[0]);
    case "subscribe":
      return subscribeCmd(cfg, "subscribe");
    case "unsubscribe":
      return subscribeCmd(cfg, "unsubscribe");
    case "tiktok-login":
      return tiktokLoginCmd(cfg);
    case "ingest":
      return withStore(cfg, (s) => ingestCmd(s, cfg, args));
    case "jobs":
      return withStore(cfg, (s) => jobsCmd(s, args[0]));
    case "approve":
    case "reject":
      return withStore(cfg, (s) => reviewCmd(s, cmd, args[0]));
    case "ready":
      return withStore(cfg, (s) => readyCmd(s));
    case "mark-published":
      return withStore(cfg, (s) => markPublishedCmd(s, args));
    case "mark-failed":
      return withStore(cfg, (s) => markFailedCmd(s, args));
    case "status":
      return withStore(cfg, (s) => statusCmd(s, cfg));
    case "whoami":
      return withStore(cfg, (s) => whoamiCmd(s, cfg));
    case "doctor":
      return withStore(cfg, (s) => doctorCmd(s, cfg));
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
      return 1;
  }
}

async function withStore(cfg: Config, fn: (s: Store) => Promise<number>): Promise<number> {
  const store = openStore(cfg.DATA_DIR);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

async function resolveChannelCmd(cfg: Config, handle: string | undefined): Promise<number> {
  if (!handle) {
    process.stderr.write("usage: resolve-channel <@handle|UC...>\n");
    return 1;
  }
  if (!cfg.YOUTUBE_API_KEY) {
    process.stderr.write("YOUTUBE_API_KEY is required for this command\n");
    return 1;
  }
  const info = await resolveChannel(cfg.YOUTUBE_API_KEY, handle);
  if (!info) {
    process.stderr.write(`no channel found for ${handle}\n`);
    return 1;
  }
  process.stdout.write(
    `channel:  ${info.title}\n` +
      `id:       ${info.channelId}\n` +
      `uploads:  ${info.uploadsPlaylistId}\n` +
      `feed:     ${topicUrlFor(info.channelId)}\n\n` +
      `Add to .env:\n  YOUTUBE_CHANNEL_ID=${info.channelId}\n`
  );
  return 0;
}

async function subscribeCmd(cfg: Config, mode: "subscribe" | "unsubscribe"): Promise<number> {
  const missing = [
    !cfg.YOUTUBE_CHANNEL_ID && "YOUTUBE_CHANNEL_ID",
    !cfg.PUBLIC_URL && "PUBLIC_URL",
    !cfg.WEBSUB_SECRET && "WEBSUB_SECRET",
  ].filter(Boolean);
  if (missing.length) {
    process.stderr.write(`missing config: ${missing.join(", ")}\n`);
    return 1;
  }

  await sendSubscriptionRequest({
    hub: cfg.WEBSUB_HUB,
    topic: topicUrlFor(cfg.YOUTUBE_CHANNEL_ID as string),
    callback: callbackUrlFor(cfg.PUBLIC_URL as string),
    secret: cfg.WEBSUB_SECRET as string,
    leaseSeconds: cfg.WEBSUB_LEASE_SECONDS,
    mode,
  });

  process.stdout.write(
    `${mode} request accepted by the hub.\n` +
      `The hub will now call ${callbackUrlFor(cfg.PUBLIC_URL as string)} to verify.\n` +
      `The server must be running and publicly reachable for that to succeed.\n`
  );
  return 0;
}

function tiktokLoginCmd(cfg: Config): number {
  if (!cfg.TIKTOK_CLIENT_KEY || !cfg.TIKTOK_REDIRECT_URI) {
    process.stderr.write("TIKTOK_CLIENT_KEY and TIKTOK_REDIRECT_URI are required\n");
    return 1;
  }
  const verifier = generateCodeVerifier();
  const url = buildAuthorizeUrl({
    clientKey: cfg.TIKTOK_CLIENT_KEY,
    redirectUri: cfg.TIKTOK_REDIRECT_URI,
    scopes: cfg.TIKTOK_PUBLISH_MODE === "direct" ? SCOPE_DIRECT : SCOPE_INBOX,
    state: generateCodeVerifier().slice(0, 16),
    codeChallenge: codeChallengeFrom(verifier),
  });

  process.stdout.write(
    `1. Start the server with this in its environment:\n\n` +
      `   YT2TT_PKCE_VERIFIER=${verifier}\n\n` +
      `2. Open this URL and approve:\n\n   ${url}\n\n` +
      `3. TikTok redirects to ${cfg.TIKTOK_REDIRECT_URI}, which stores the tokens.\n`
  );
  return 0;
}

async function ingestCmd(store: Store, cfg: Config, args: string[]): Promise<number> {
  const videoId = args.find((a) => !a.startsWith("--"));
  const force = args.includes("--force");
  if (!videoId) {
    process.stderr.write("usage: ingest <videoId> [--force]\n");
    return 1;
  }
  if (!cfg.YOUTUBE_API_KEY) {
    process.stderr.write("YOUTUBE_API_KEY is required for this command\n");
    return 1;
  }

  const details = await getVideoDetails(cfg.YOUTUBE_API_KEY, videoId);
  if (!details) {
    process.stderr.write(`video ${videoId} not found\n`);
    return 1;
  }

  const outcome = await ingestCandidate(
    store,
    cfg,
    {
      videoId: details.videoId,
      channelId: details.channelId,
      title: details.title,
      publishedAt: details.publishedAt,
    },
    { force }
  );

  if (outcome.accepted) {
    process.stdout.write(`queued ${videoId} as job(s) ${outcome.jobIds.join(", ")}\n`);
    return 0;
  }
  process.stdout.write(`skipped ${videoId}: ${outcome.reason}\n`);
  return 0;
}

async function jobsCmd(store: Store, state: string | undefined): Promise<number> {
  const jobs = store.listJobs(state as never, 100);
  if (!jobs.length) {
    process.stdout.write("no jobs\n");
    return 0;
  }
  for (const j of jobs) {
    process.stdout.write(
      `#${String(j.id).padEnd(4)} ${j.video_id} clip=${j.clip_index} ${j.state.padEnd(16)}` +
        ` attempts=${j.attempts}${j.last_error ? ` err=${j.last_error.slice(0, 70)}` : ""}\n`
    );
  }
  return 0;
}

async function reviewCmd(store: Store, cmd: string, idArg: string | undefined): Promise<number> {
  const id = Number(idArg);
  if (!Number.isInteger(id)) {
    process.stderr.write(`usage: ${cmd} <jobId>\n`);
    return 1;
  }
  const job = store.getJob(id);
  if (!job) {
    process.stderr.write(`no job ${id}\n`);
    return 1;
  }
  if (job.state !== "awaiting_review") {
    process.stderr.write(`job ${id} is ${job.state}, not awaiting_review\n`);
    return 1;
  }
  store.updateJob(id, { state: cmd === "approve" ? "approved" : "rejected", next_attempt_at: null });
  process.stdout.write(`job ${id} ${cmd === "approve" ? "approved" : "rejected"}\n`);
  return 0;
}

/**
 * Emits the handoff queue as JSON so an external publisher can consume it
 * without scraping human-readable output.
 */
async function readyCmd(store: Store): Promise<number> {
  const jobs = store.listJobs("awaiting_handoff", 100);
  const rows = await Promise.all(
    jobs.map(async (j) => ({
      jobId: j.id,
      videoId: j.video_id,
      clipIndex: j.clip_index,
      file: j.output_path,
      title: j.caption ?? "",
      bytes: j.output_path ? await sizeOf(j.output_path) : null,
      sourceUrl: `https://www.youtube.com/watch?v=${j.video_id}`,
    }))
  );
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  return 0;
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const { stat } = await import("node:fs/promises");
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function markPublishedCmd(store: Store, args: string[]): Promise<number> {
  const id = Number(args.find((a) => !a.startsWith("--")));
  const postIdx = args.indexOf("--post-id");
  const postId = postIdx === -1 ? null : (args[postIdx + 1] ?? null);

  const job = await requireHandoffJob(store, id);
  if (!job) return 1;

  store.updateJob(job.id, {
    state: "published",
    tiktok_status: "PUBLISHED_VIA_HANDOFF",
    publish_id: postId,
    last_error: null,
  });

  // The encode is disposable once it is live; the master is untouched.
  if (job.output_path) {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(job.output_path);
    } catch {
      /* cleanup is best effort */
    }
  }
  process.stdout.write(`job ${id} marked published${postId ? ` (post ${postId})` : ""}\n`);
  return 0;
}

async function markFailedCmd(store: Store, args: string[]): Promise<number> {
  const id = Number(args[0]);
  const reason = args.slice(1).join(" ").trim();
  if (!reason) {
    process.stderr.write("usage: mark-failed <id> <reason>\n");
    return 1;
  }
  const job = await requireHandoffJob(store, id);
  if (!job) return 1;

  // Left in awaiting_handoff so it can be retried after the cause is fixed;
  // the reason is recorded for whoever looks next.
  store.updateJob(job.id, { last_error: reason });
  process.stdout.write(`job ${id} flagged: ${reason}\n`);
  return 0;
}

async function requireHandoffJob(store: Store, id: number) {
  if (!Number.isInteger(id)) {
    process.stderr.write("a numeric job id is required\n");
    return null;
  }
  const job = store.getJob(id);
  if (!job) {
    process.stderr.write(`no job ${id}\n`);
    return null;
  }
  if (job.state !== "awaiting_handoff") {
    process.stderr.write(`job ${id} is ${job.state}, not awaiting_handoff\n`);
    return null;
  }
  return job;
}

async function statusCmd(store: Store, cfg: Config): Promise<number> {
  const out: string[] = [];

  if (cfg.YOUTUBE_CHANNEL_ID) {
    const sub = store.getSubscription(topicUrlFor(cfg.YOUTUBE_CHANNEL_ID));
    out.push(
      sub
        ? `websub:  ${sub.state}, lease expires ${sub.lease_expires_at ?? "unknown"}`
        : "websub:  not subscribed"
    );
  } else {
    out.push("websub:  YOUTUBE_CHANNEL_ID not set");
  }

  const tok = store.getTokens(PROVIDER);
  out.push(
    tok
      ? `tiktok:  linked (open_id=${tok.open_id ?? "?"}, scope=${tok.scope ?? "?"}, expires ${tok.expires_at ?? "?"})`
      : "tiktok:  not linked - run: npm run cli -- tiktok-login"
  );

  const counts = new Map<string, number>();
  for (const j of store.listJobs(undefined, 500)) {
    counts.set(j.state, (counts.get(j.state) ?? 0) + 1);
  }
  out.push(
    `jobs:    ${[...counts.entries()].map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`
  );

  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

/**
 * Answers "which account will this post to" authoritatively, by asking TikTok
 * rather than by reading config - the destination is a property of the stored
 * token, and nothing else in the setup names it.
 */
async function whoamiCmd(store: Store, cfg: Config): Promise<number> {
  if (!cfg.TIKTOK_CLIENT_KEY || !cfg.TIKTOK_CLIENT_SECRET) {
    process.stderr.write("TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not configured\n");
    return 1;
  }
  const { getAccessToken } = await import("./tiktok/oauth.js");
  const { queryCreatorInfo } = await import("./tiktok/publish.js");

  const accessToken = await getAccessToken(store, {
    clientKey: cfg.TIKTOK_CLIENT_KEY,
    clientSecret: cfg.TIKTOK_CLIENT_SECRET,
  });
  const info = await queryCreatorInfo(accessToken);
  const options = info.privacy_level_options ?? [];

  process.stdout.write(
    `account:   @${info.creator_username ?? "unknown"}\n` +
      `nickname:  ${info.creator_nickname ?? "-"}\n` +
      `max post:  ${info.max_video_post_duration_sec ?? "?"}s\n` +
      `privacy:   ${options.join(", ") || "unknown"}\n` +
      `configured: ${cfg.TIKTOK_PRIVACY_LEVEL} (mode=${cfg.TIKTOK_PUBLISH_MODE})\n`
  );

  if (options.length && !options.includes(cfg.TIKTOK_PRIVACY_LEVEL)) {
    process.stdout.write(
      `\n  !!  ${cfg.TIKTOK_PRIVACY_LEVEL} is NOT available on this account.\n` +
        `      Public posting requires an audited app.\n`
    );
    return 1;
  }
  return 0;
}

async function doctorCmd(store: Store, cfg: Config): Promise<number> {
  const problems: string[] = [];
  const ok: string[] = [];

  for (const [name, bin] of [
    ["ffmpeg", cfg.FFMPEG_PATH],
    ["ffprobe", cfg.FFPROBE_PATH],
  ] as const) {
    try {
      const { stdout } = await run(bin, ["-version"]);
      ok.push(`${name}: ${stdout.split("\n")[0]}`);
    } catch {
      problems.push(`${name} not runnable at ${JSON.stringify(bin)} - install FFmpeg or set ${name.toUpperCase()}_PATH`);
    }
  }

  if (!cfg.YOUTUBE_CHANNEL_ID) problems.push("YOUTUBE_CHANNEL_ID not set - run resolve-channel");
  if (!cfg.YOUTUBE_API_KEY) problems.push("YOUTUBE_API_KEY not set - metadata and polling are disabled");
  if (!cfg.PUBLIC_URL) problems.push("PUBLIC_URL not set - push notifications are disabled");
  if (!cfg.WEBSUB_SECRET) problems.push("WEBSUB_SECRET not set - the callback will reject notifications");
  if (!cfg.TIKTOK_CLIENT_KEY || !cfg.TIKTOK_CLIENT_SECRET) problems.push("TikTok credentials not set");
  if (!store.getTokens(PROVIDER)) problems.push("TikTok account not linked - run tiktok-login");
  if (cfg.SOURCE_MODE === "command" && !cfg.SOURCE_COMMAND) {
    problems.push("SOURCE_MODE=command but SOURCE_COMMAND is empty");
  }
  if (!cfg.REQUIRE_REVIEW) ok.push("note: REQUIRE_REVIEW is off, encodes publish automatically");

  for (const line of ok) process.stdout.write(`  ok   ${line}\n`);
  for (const line of problems) process.stdout.write(`  !!   ${line}\n`);
  process.stdout.write(problems.length ? `\n${problems.length} issue(s)\n` : "\nall checks passed\n");
  return problems.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  });
