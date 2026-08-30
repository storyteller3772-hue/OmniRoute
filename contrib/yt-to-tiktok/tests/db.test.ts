import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.js";

const VIDEO = "dQw4w9WgXcQ";
const CHANNEL = "UCabcdefghijklmnopqrstuv";

function freshStore(): Store {
  return new Store(":memory:");
}

function seed(store: Store, videoId = VIDEO): boolean {
  return store.insertVideoIfNew({
    videoId,
    channelId: CHANNEL,
    title: "Donut Review",
    publishedAt: "2026-08-30T10:00:00.000Z",
  });
}

test("a new video is recorded and reported as new", () => {
  const store = freshStore();
  try {
    assert.equal(seed(store), true);
    assert.equal(store.hasVideo(VIDEO), true);
    assert.equal(store.getVideo(VIDEO)?.title, "Donut Review");
  } finally {
    store.close();
  }
});

test("re-inserting the same video is a no-op - the idempotency gate", () => {
  const store = freshStore();
  try {
    assert.equal(seed(store), true);
    assert.equal(seed(store), false, "a redelivered notification must not re-enter the pipeline");
    assert.equal(seed(store), false);
  } finally {
    store.close();
  }
});

test("metadata updates patch only the fields provided", () => {
  const store = freshStore();
  try {
    seed(store);
    store.updateVideoMetadata(VIDEO, { durationSec: 300, privacyStatus: "public" });
    const v = store.getVideo(VIDEO)!;
    assert.equal(v.duration_sec, 300);
    assert.equal(v.privacy_status, "public");
    assert.equal(v.title, "Donut Review", "untouched fields must survive");
  } finally {
    store.close();
  }
});

test("jobs are unique per (video, clip) and creating a duplicate returns the original id", () => {
  const store = freshStore();
  try {
    seed(store);
    const first = store.createJob(VIDEO, 0);
    const again = store.createJob(VIDEO, 0);
    assert.equal(again, first, "must not create a second job for the same clip");

    const second = store.createJob(VIDEO, 1);
    assert.notEqual(second, first, "a different clip index is a different job");
  } finally {
    store.close();
  }
});

test("a job starts pending and is immediately claimable", () => {
  const store = freshStore();
  try {
    seed(store);
    const id = store.createJob(VIDEO, 0);
    const job = store.getJob(id)!;
    assert.equal(job.state, "pending");
    assert.equal(job.attempts, 0);
    assert.ok(store.claimableJobs().some((j) => j.id === id));
  } finally {
    store.close();
  }
});

test("a job scheduled into the future is not claimable yet", () => {
  const store = freshStore();
  try {
    seed(store);
    const id = store.createJob(VIDEO, 0);
    store.updateJob(id, { next_attempt_at: "2099-01-01 00:00:00" });
    assert.equal(store.claimableJobs().some((j) => j.id === id), false);
  } finally {
    store.close();
  }
});

test("terminal and review states are excluded from the work queue", () => {
  const store = freshStore();
  try {
    seed(store);
    for (const [i, state] of ["published", "failed", "rejected", "awaiting_review"].entries()) {
      const id = store.createJob(VIDEO, i);
      store.updateJob(id, { state: state as never });
    }
    assert.deepEqual(store.claimableJobs(), [], "nothing terminal or held should be picked up");
  } finally {
    store.close();
  }
});

test("approving a held job puts it back in the queue", () => {
  const store = freshStore();
  try {
    seed(store);
    const id = store.createJob(VIDEO, 0);
    store.updateJob(id, { state: "awaiting_review" });
    assert.equal(store.claimableJobs().length, 0);
    store.updateJob(id, { state: "approved" });
    assert.equal(store.claimableJobs().length, 1);
  } finally {
    store.close();
  }
});

test("listJobs filters by state", () => {
  const store = freshStore();
  try {
    seed(store);
    const a = store.createJob(VIDEO, 0);
    const b = store.createJob(VIDEO, 1);
    store.updateJob(a, { state: "published" });
    store.updateJob(b, { state: "failed" });
    assert.deepEqual(store.listJobs("published").map((j) => j.id), [a]);
    assert.deepEqual(store.listJobs("failed").map((j) => j.id), [b]);
    assert.equal(store.listJobs().length, 2);
  } finally {
    store.close();
  }
});

test("tokens round-trip and a refresh preserves the existing refresh token", () => {
  const store = freshStore();
  try {
    store.saveTokens("tiktok", {
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: "2026-08-30T12:00:00.000Z",
      openId: "open-1",
      scope: "video.upload",
    });
    // A refresh response often omits a new refresh token.
    store.saveTokens("tiktok", { accessToken: "at-2", expiresAt: "2026-08-30T13:00:00.000Z" });

    const row = store.getTokens("tiktok")!;
    assert.equal(row.access_token, "at-2");
    assert.equal(row.refresh_token, "rt-1", "the refresh token must not be wiped");
    assert.equal(row.open_id, "open-1", "identity must not be wiped");
    assert.equal(row.scope, "video.upload");
  } finally {
    store.close();
  }
});

test("subscription state upserts and survives a partial update", () => {
  const store = freshStore();
  try {
    const topic = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${CHANNEL}`;
    store.upsertSubscription(topic, "https://example.test/websub/youtube", { state: "pending" });
    store.upsertSubscription(topic, "https://example.test/websub/youtube", {
      state: "active",
      leaseExpiresAt: "2026-09-04T10:00:00.000Z",
      verifiedNow: true,
    });
    const sub = store.getSubscription(topic)!;
    assert.equal(sub.state, "active");
    assert.equal(sub.lease_expires_at, "2026-09-04T10:00:00.000Z");
  } finally {
    store.close();
  }
});

test("a job cannot be created for a video that was never recorded", () => {
  const store = freshStore();
  try {
    assert.throws(() => store.createJob("neverseen00", 0), /FOREIGN KEY|constraint/i);
  } finally {
    store.close();
  }
});
