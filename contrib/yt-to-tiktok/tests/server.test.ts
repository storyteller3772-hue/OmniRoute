import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { loadConfig, type Config } from "../src/config.js";
import { Store } from "../src/db.js";
import { createHttpServer } from "../src/server.js";
import { signBody } from "../src/util/signature.js";
import { topicUrlFor } from "../src/youtube/websub.js";

const CHANNEL = "UCabcdefghijklmnopqrstuv";
const VIDEO = "dQw4w9WgXcQ";
const SECRET = "test-secret-that-is-long-enough";
const TOPIC = topicUrlFor(CHANNEL);

function notification(publishedAt = new Date().toISOString()): Buffer {
  return Buffer.from(
    `<?xml version="1.0"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <yt:videoId>${VIDEO}</yt:videoId>
    <yt:channelId>${CHANNEL}</yt:channelId>
    <title>Donut Review</title>
    <published>${publishedAt}</published>
    <updated>${publishedAt}</updated>
  </entry>
</feed>`,
    "utf8"
  );
}

async function withServer(
  env: Record<string, string>,
  fn: (ctx: { base: string; store: Store; cfg: Config }) => Promise<void>
): Promise<void> {
  const cfg = loadConfig({
    YOUTUBE_CHANNEL_ID: CHANNEL,
    WEBSUB_SECRET: SECRET,
    CAPTION_HASHTAGS: "",
    ...env,
  } as NodeJS.ProcessEnv);
  const store = new Store(":memory:");
  const server = createHttpServer(store, cfg);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, store, cfg });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

/** Ingestion runs after the 204 is sent, so give it a moment to land. */
async function waitFor(check: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

test("health check responds", async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });
});

test("the verification handshake echoes the challenge and activates the subscription", async () => {
  await withServer({}, async ({ base, store }) => {
    const url = `${base}/websub/youtube?hub.mode=subscribe&hub.topic=${encodeURIComponent(TOPIC)}&hub.challenge=challenge-123&hub.lease_seconds=432000`;
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "challenge-123", "the hub only subscribes if we echo this");
    assert.equal(store.getSubscription(TOPIC)?.state, "active");
  });
});

test("a verification for someone else's topic is refused without echoing the challenge", async () => {
  await withServer({}, async ({ base }) => {
    const foreign = topicUrlFor("UCzzzzzzzzzzzzzzzzzzzzzz");
    const res = await fetch(
      `${base}/websub/youtube?hub.mode=subscribe&hub.topic=${encodeURIComponent(foreign)}&hub.challenge=nope`
    );
    assert.equal(res.status, 404);
    assert.notEqual(await res.text(), "nope", "must never confirm a subscription we did not request");
  });
});

test("an unsubscribe handshake marks the subscription inactive", async () => {
  await withServer({}, async ({ base, store }) => {
    await fetch(
      `${base}/websub/youtube?hub.mode=unsubscribe&hub.topic=${encodeURIComponent(TOPIC)}&hub.challenge=c1`
    );
    assert.equal(store.getSubscription(TOPIC)?.state, "inactive");
  });
});

test("a correctly signed notification is accepted and queues the upload", async () => {
  await withServer({}, async ({ base, store }) => {
    const body = notification();
    const res = await fetch(`${base}/websub/youtube`, {
      method: "POST",
      headers: {
        "Content-Type": "application/atom+xml",
        "X-Hub-Signature": signBody("sha1", body, SECRET),
      },
      body,
    });
    assert.equal(res.status, 204);
    assert.ok(await waitFor(() => store.hasVideo(VIDEO)), "the video should have been queued");
    assert.equal(store.listJobs().length, 1);
  });
});

test("an unsigned notification is rejected and nothing is queued", async () => {
  await withServer({}, async ({ base, store }) => {
    const res = await fetch(`${base}/websub/youtube`, { method: "POST", body: notification() });
    assert.equal(res.status, 403);
    assert.equal(store.hasVideo(VIDEO), false);
  });
});

test("a notification signed with the wrong secret is rejected", async () => {
  await withServer({}, async ({ base, store }) => {
    const body = notification();
    const res = await fetch(`${base}/websub/youtube`, {
      method: "POST",
      headers: { "X-Hub-Signature": signBody("sha1", body, "wrong-secret-entirely") },
      body,
    });
    assert.equal(res.status, 403);
    assert.equal(store.hasVideo(VIDEO), false);
  });
});

test("a tampered body fails the signature check even with a real signature attached", async () => {
  await withServer({}, async ({ base, store }) => {
    const original = notification();
    const signature = signBody("sha1", original, SECRET);
    const tampered = Buffer.from(original.toString("utf8").replace("Donut Review", "Hacked Title"));
    const res = await fetch(`${base}/websub/youtube`, {
      method: "POST",
      headers: { "X-Hub-Signature": signature },
      body: tampered,
    });
    assert.equal(res.status, 403);
    assert.equal(store.hasVideo(VIDEO), false);
  });
});

test("the callback refuses notifications outright when no secret is configured", async () => {
  const cfg = loadConfig({ YOUTUBE_CHANNEL_ID: CHANNEL } as NodeJS.ProcessEnv);
  const store = new Store(":memory:");
  const server = createHttpServer(store, cfg);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/websub/youtube`, {
      method: "POST",
      body: notification(),
    });
    assert.equal(res.status, 503, "an unauthenticated callback must never be open");
    assert.equal(store.hasVideo(VIDEO), false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("review endpoints require the bearer token when one is configured", async () => {
  await withServer({ REVIEW_TOKEN: "a-long-enough-review-token" }, async ({ base }) => {
    assert.equal((await fetch(`${base}/jobs`)).status, 401);
    assert.equal((await fetch(`${base}/`)).status, 401);
    assert.equal(
      (await fetch(`${base}/jobs`, { headers: { Authorization: "Bearer wrong-token-here-xx" } }))
        .status,
      401
    );
    const ok = await fetch(`${base}/jobs`, {
      headers: { Authorization: "Bearer a-long-enough-review-token" },
    });
    assert.equal(ok.status, 200);
  });
});

test("approving a held job moves it to approved", async () => {
  await withServer({}, async ({ base, store }) => {
    store.insertVideoIfNew({
      videoId: VIDEO,
      channelId: CHANNEL,
      title: "t",
      publishedAt: new Date().toISOString(),
    });
    const id = store.createJob(VIDEO, 0);
    store.updateJob(id, { state: "awaiting_review" });

    const res = await fetch(`${base}/jobs/${id}/approve`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(store.getJob(id)?.state, "approved");
  });
});

test("rejecting a held job moves it to rejected and it never becomes claimable", async () => {
  await withServer({}, async ({ base, store }) => {
    store.insertVideoIfNew({
      videoId: VIDEO,
      channelId: CHANNEL,
      title: "t",
      publishedAt: new Date().toISOString(),
    });
    const id = store.createJob(VIDEO, 0);
    store.updateJob(id, { state: "awaiting_review" });

    await fetch(`${base}/jobs/${id}/reject`, { method: "POST" });
    assert.equal(store.getJob(id)?.state, "rejected");
    assert.equal(store.claimableJobs().length, 0);
  });
});

test("a job that is not awaiting review cannot be approved", async () => {
  await withServer({}, async ({ base, store }) => {
    store.insertVideoIfNew({
      videoId: VIDEO,
      channelId: CHANNEL,
      title: "t",
      publishedAt: new Date().toISOString(),
    });
    const id = store.createJob(VIDEO, 0);
    const res = await fetch(`${base}/jobs/${id}/approve`, { method: "POST" });
    assert.equal(res.status, 409);
    assert.equal(store.getJob(id)?.state, "pending");
  });
});

test("approving a job that does not exist is a 404", async () => {
  await withServer({}, async ({ base }) => {
    assert.equal((await fetch(`${base}/jobs/9999/approve`, { method: "POST" })).status, 404);
  });
});

test("unknown routes are 404", async () => {
  await withServer({}, async ({ base }) => {
    assert.equal((await fetch(`${base}/admin`)).status, 404);
  });
});
