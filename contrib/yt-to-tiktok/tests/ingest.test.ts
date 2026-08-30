import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type Config } from "../src/config.js";
import { Store } from "../src/db.js";
import { ingestCandidate } from "../src/pipeline/ingest.js";

const CHANNEL = "UCabcdefghijklmnopqrstuv";
const OTHER_CHANNEL = "UCzzzzzzzzzzzzzzzzzzzzzz";
const VIDEO = "dQw4w9WgXcQ";
const NOW = Date.parse("2026-08-30T12:00:00.000Z");

// No YOUTUBE_API_KEY: ingest must work from feed data alone, which is also what
// happens when the API is briefly unreachable.
function cfg(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    YOUTUBE_CHANNEL_ID: CHANNEL,
    CAPTION_TEMPLATE: "{title}",
    CAPTION_HASHTAGS: "shorts,donut",
    MAX_VIDEO_AGE_MINUTES: "120",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

function candidate(overrides: Partial<Parameters<typeof ingestCandidate>[2]> = {}) {
  return {
    videoId: VIDEO,
    channelId: CHANNEL,
    title: "Donut Review",
    publishedAt: "2026-08-30T11:55:00.000Z",
    ...overrides,
  };
}

test("a fresh upload from our own channel is queued", async () => {
  const store = new Store(":memory:");
  try {
    const out = await ingestCandidate(store, cfg(), candidate(), { now: NOW });
    assert.equal(out.accepted, true);
    assert.ok(out.accepted && out.jobIds.length === 1);
    assert.equal(store.getVideo(VIDEO)?.state, "queued");
  } finally {
    store.close();
  }
});

test("the queued job carries the rendered caption", async () => {
  const store = new Store(":memory:");
  try {
    const out = await ingestCandidate(store, cfg(), candidate(), { now: NOW });
    assert.ok(out.accepted);
    const job = store.getJob(out.jobIds[0]!)!;
    assert.equal(job.caption, "Donut Review #shorts #donut");
    assert.equal(job.state, "pending");
  } finally {
    store.close();
  }
});

test("an upload from another channel is refused", async () => {
  const store = new Store(":memory:");
  try {
    const out = await ingestCandidate(store, cfg(), candidate({ channelId: OTHER_CHANNEL }), {
      now: NOW,
    });
    assert.equal(out.accepted, false);
    assert.match(out.accepted === false ? out.reason : "", /foreign channel/);
    assert.equal(store.hasVideo(VIDEO), false, "a foreign video must not even be recorded");
  } finally {
    store.close();
  }
});

test("an old video is skipped - this is what stops the backlog replay on first subscribe", async () => {
  const store = new Store(":memory:");
  try {
    const out = await ingestCandidate(
      store,
      cfg(),
      candidate({ publishedAt: "2026-08-20T10:00:00.000Z" }),
      { now: NOW }
    );
    assert.equal(out.accepted, false);
    assert.match(out.accepted === false ? out.reason : "", /MAX_VIDEO_AGE_MINUTES/);
  } finally {
    store.close();
  }
});

test("a redelivered notification for the same video is skipped", async () => {
  const store = new Store(":memory:");
  try {
    const first = await ingestCandidate(store, cfg(), candidate(), { now: NOW });
    assert.equal(first.accepted, true);

    const second = await ingestCandidate(store, cfg(), candidate(), { now: NOW });
    assert.equal(second.accepted, false);
    assert.match(second.accepted === false ? second.reason : "", /already seen/);
  } finally {
    store.close();
  }
});

test("an edit notification (same id, new title) does not queue a second post", async () => {
  const store = new Store(":memory:");
  try {
    await ingestCandidate(store, cfg(), candidate(), { now: NOW });
    const edit = await ingestCandidate(store, cfg(), candidate({ title: "Donut Review (edited)" }), {
      now: NOW,
    });
    assert.equal(edit.accepted, false);
    assert.equal(store.listJobs().length, 1, "exactly one job should exist for this video");
  } finally {
    store.close();
  }
});

test("--force overrides both the age guard and the duplicate guard", async () => {
  const store = new Store(":memory:");
  try {
    await ingestCandidate(store, cfg(), candidate(), { now: NOW });
    const forced = await ingestCandidate(
      store,
      cfg(),
      candidate({ publishedAt: "2020-01-01T00:00:00.000Z" }),
      { now: NOW, force: true }
    );
    assert.equal(forced.accepted, true);
  } finally {
    store.close();
  }
});

test("an upload with no configured channel id is accepted (single-channel setups)", async () => {
  const store = new Store(":memory:");
  try {
    const conf = loadConfig({ CAPTION_HASHTAGS: "" } as NodeJS.ProcessEnv);
    const out = await ingestCandidate(store, conf, candidate(), { now: NOW });
    assert.equal(out.accepted, true);
  } finally {
    store.close();
  }
});
