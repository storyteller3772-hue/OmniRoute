import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import type { Store } from "./db.js";
import { logger } from "./logger.js";
import { verifyHubSignature } from "./util/signature.js";
import { parseYouTubeFeed } from "./util/atom.js";
import { ingestCandidate } from "./pipeline/ingest.js";
import { topicUrlFor } from "./youtube/websub.js";
import { exchangeCode, persistTokens } from "./tiktok/oauth.js";
import { renderPrivacy, renderTerms } from "./legal.js";

/** Feed notifications are small; anything larger is not one. */
const MAX_BODY_BYTES = 1024 * 1024;

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain"): void {
  res.writeHead(status, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body, null, 2), "application/json");
}

/** Constant-time bearer check so the token cannot be probed byte by byte. */
function authorised(req: IncomingMessage, cfg: Config): boolean {
  if (!cfg.REVIEW_TOKEN) return true;
  const header = req.headers.authorization ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(cfg.REVIEW_TOKEN);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export function createHttpServer(store: Store, cfg: Config) {
  return createServer((req, res) => {
    void handle(req, res, store, cfg).catch((err) => {
      logger.error({ err: (err as Error).message, url: req.url }, "request handler threw");
      if (!res.headersSent) send(res, 500, "internal error");
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  cfg: Config
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/healthz") return send(res, 200, "ok");

  // Public by design: TikTok's reviewer must be able to fetch these without
  // credentials, so they sit outside the REVIEW_TOKEN gate.
  if (path === "/legal/terms" && req.method === "GET") {
    return send(res, 200, renderTerms(cfg), "text/html");
  }
  if (path === "/legal/privacy" && req.method === "GET") {
    return send(res, 200, renderPrivacy(cfg), "text/html");
  }

  // ---- WebSub verification handshake ----
  if (path === "/websub/youtube" && req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const topic = url.searchParams.get("hub.topic");
    const challenge = url.searchParams.get("hub.challenge");
    const lease = Number(url.searchParams.get("hub.lease_seconds") ?? 0);

    const expectedTopic = cfg.YOUTUBE_CHANNEL_ID ? topicUrlFor(cfg.YOUTUBE_CHANNEL_ID) : null;
    if (!challenge || !topic || (expectedTopic && topic !== expectedTopic)) {
      logger.warn({ mode, topic }, "rejecting WebSub verification for an unexpected topic");
      return send(res, 404, "not found");
    }

    if (mode === "subscribe") {
      store.upsertSubscription(topic, url.toString(), {
        state: "active",
        leaseExpiresAt: new Date(Date.now() + (lease || cfg.WEBSUB_LEASE_SECONDS) * 1000).toISOString(),
        verifiedNow: true,
      });
      logger.info({ topic, leaseSeconds: lease }, "WebSub subscription verified");
    } else if (mode === "unsubscribe") {
      store.upsertSubscription(topic, url.toString(), { state: "inactive" });
      logger.info({ topic }, "WebSub subscription cancelled");
    }

    // Echoing the challenge is what confirms the subscription.
    return send(res, 200, challenge);
  }

  // ---- WebSub notification ----
  if (path === "/websub/youtube" && req.method === "POST") {
    const raw = await readRawBody(req);

    if (!cfg.WEBSUB_SECRET) {
      logger.error("WEBSUB_SECRET is not set; refusing to accept unauthenticated notifications");
      return send(res, 503, "not configured");
    }
    if (!verifyHubSignature(req.headers["x-hub-signature"] as string | undefined, raw, cfg.WEBSUB_SECRET)) {
      logger.warn({ ip: req.socket.remoteAddress }, "rejected notification with a bad signature");
      return send(res, 403, "bad signature");
    }

    // Acknowledge before doing any work: the hub retries on a slow callback,
    // and ingestion is already idempotent.
    send(res, 204, "");

    const feed = parseYouTubeFeed(raw.toString("utf8"));
    if (feed.deletedVideoIds.length) {
      logger.info({ ids: feed.deletedVideoIds }, "ignoring deleted-entry notification");
    }

    for (const entry of feed.entries) {
      try {
        const outcome = await ingestCandidate(store, cfg, {
          videoId: entry.videoId,
          channelId: entry.channelId,
          title: entry.title,
          publishedAt: entry.publishedAt,
        });
        if (!outcome.accepted) {
          logger.info({ videoId: outcome.videoId, reason: outcome.reason }, "skipped upload");
        }
      } catch (err) {
        logger.error(
          { videoId: entry.videoId, err: (err as Error).message },
          "ingest failed for feed entry"
        );
      }
    }
    return;
  }

  // ---- TikTok OAuth callback ----
  if (path === "/oauth/tiktok/callback" && req.method === "GET") {
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (error) return send(res, 400, `TikTok authorisation failed: ${error}`);
    if (!code) return send(res, 400, "missing code");
    if (!cfg.TIKTOK_CLIENT_KEY || !cfg.TIKTOK_CLIENT_SECRET || !cfg.TIKTOK_REDIRECT_URI) {
      return send(res, 503, "TikTok credentials are not configured");
    }

    const verifier = process.env.YT2TT_PKCE_VERIFIER;
    const tokens = await exchangeCode({
      clientKey: cfg.TIKTOK_CLIENT_KEY,
      clientSecret: cfg.TIKTOK_CLIENT_SECRET,
      code,
      redirectUri: cfg.TIKTOK_REDIRECT_URI,
      codeVerifier: verifier,
    });
    persistTokens(store, tokens);
    logger.info({ openId: tokens.open_id, scope: tokens.scope }, "TikTok account linked");
    return send(res, 200, "TikTok account linked. You can close this tab.");
  }

  // ---- review gate ----
  if (path === "/jobs" && req.method === "GET") {
    if (!authorised(req, cfg)) return send(res, 401, "unauthorised");
    const state = url.searchParams.get("state") as never;
    return json(res, 200, store.listJobs(state || undefined, 100));
  }

  if (path === "/jobs/ready" && req.method === "GET") {
    if (!authorised(req, cfg)) return send(res, 401, "unauthorised");
    const rows = store.listJobs("awaiting_handoff", 100).map((j) => ({
      jobId: j.id,
      videoId: j.video_id,
      clipIndex: j.clip_index,
      file: j.output_path,
      title: j.caption ?? "",
      sourceUrl: `https://www.youtube.com/watch?v=${j.video_id}`,
    }));
    return json(res, 200, rows);
  }

  const published = /^\/jobs\/(\d+)\/published$/.exec(path);
  if (published && req.method === "POST") {
    if (!authorised(req, cfg)) return send(res, 401, "unauthorised");
    const id = Number(published[1]);
    const job = store.getJob(id);
    if (!job) return json(res, 404, { error: "no such job" });
    if (job.state !== "awaiting_handoff") {
      return json(res, 409, { error: `job is ${job.state}, not awaiting_handoff` });
    }
    const body = await readRawBody(req);
    let postId: string | null = null;
    try {
      postId = (JSON.parse(body.toString("utf8") || "{}") as { postId?: string }).postId ?? null;
    } catch {
      /* an empty or unparseable body just means no post id was supplied */
    }
    store.updateJob(id, {
      state: "published",
      tiktok_status: "PUBLISHED_VIA_HANDOFF",
      publish_id: postId,
      last_error: null,
    });
    logger.info({ jobId: id, postId }, "job marked published via handoff");
    return json(res, 200, { id, state: "published", postId });
  }

  const action = /^\/jobs\/(\d+)\/(approve|reject)$/.exec(path);
  if (action && req.method === "POST") {
    if (!authorised(req, cfg)) return send(res, 401, "unauthorised");
    const id = Number(action[1]);
    const job = store.getJob(id);
    if (!job) return json(res, 404, { error: "no such job" });
    if (job.state !== "awaiting_review") {
      return json(res, 409, { error: `job is ${job.state}, not awaiting_review` });
    }
    const approve = action[2] === "approve";
    store.updateJob(id, { state: approve ? "approved" : "rejected", next_attempt_at: null });
    logger.info({ jobId: id, approve }, "review decision recorded");
    return json(res, 200, { id, state: approve ? "approved" : "rejected" });
  }

  if (path === "/" && req.method === "GET") {
    if (!authorised(req, cfg)) return send(res, 401, "unauthorised");
    return send(res, 200, renderDashboard(store), "text/html");
  }

  send(res, 404, "not found");
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

function renderDashboard(store: Store): string {
  const jobs = store.listJobs(undefined, 50);
  const rows = jobs
    .map((j) => {
      const actions =
        j.state === "awaiting_review"
          ? `<button data-id="${j.id}" data-act="approve">approve</button>
             <button data-id="${j.id}" data-act="reject">reject</button>`
          : "";
      return `<tr>
        <td>${j.id}</td>
        <td><code>${escapeHtml(j.video_id)}</code></td>
        <td>${j.clip_index}</td>
        <td><span class="s s-${escapeHtml(j.state)}">${escapeHtml(j.state)}</span></td>
        <td class="cap">${escapeHtml((j.caption ?? "").slice(0, 90))}</td>
        <td class="err">${escapeHtml((j.last_error ?? "").slice(0, 120))}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html><meta charset="utf-8"><title>yt-to-tiktok</title>
<style>
 body{font:14px system-ui,sans-serif;margin:2rem;max-width:1100px}
 table{border-collapse:collapse;width:100%}
 th,td{border-bottom:1px solid #ddd;padding:.5rem;text-align:left;vertical-align:top}
 code{font-family:ui-monospace,monospace}
 .s{padding:.1rem .4rem;border-radius:.3rem;background:#eee}
 .s-published{background:#d4f5d4}.s-failed{background:#f8d4d4}
 .s-awaiting_review{background:#fdf0c8}
 .cap,.err{max-width:22rem;font-size:12px;color:#555}
 button{margin-right:.3rem}
</style>
<h1>yt-to-tiktok</h1>
<p>Jobs awaiting review must be approved before anything is uploaded.</p>
<table><thead><tr>
<th>#</th><th>video</th><th>clip</th><th>state</th><th>caption</th><th>last error</th><th></th>
</tr></thead><tbody>${rows || '<tr><td colspan="7">No jobs yet.</td></tr>'}</tbody></table>
<script>
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-id]");
  if (!b) return;
  b.disabled = true;
  const r = await fetch("/jobs/" + b.dataset.id + "/" + b.dataset.act, { method: "POST" });
  if (r.ok) location.reload(); else { b.disabled = false; alert("failed: " + r.status); }
});
</script>`;
}
