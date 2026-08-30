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
  status                           Show subscription, token and job summary
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
    case "status":
      return withStore(cfg, (s) => statusCmd(s, cfg));
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
