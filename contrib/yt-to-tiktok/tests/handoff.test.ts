import test from "node:test";
import assert from "node:assert/strict";
import { HANDOFF_LIMITS, parseFrameRate, validateForHandoff } from "../src/pipeline/handoff.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db.js";
import { ingestCandidate } from "../src/pipeline/ingest.js";

const ok = { durationSec: 60, width: 1080, height: 1920, fps: 30, bytes: 20 * 1024 * 1024 };

test("a well-formed vertical clip passes with no complaints", () => {
  assert.deepEqual(validateForHandoff(ok), []);
});

test("the duration bounds are enforced at both ends", () => {
  assert.match(validateForHandoff({ ...ok, durationSec: 2 })[0]!, /below the 3s minimum/);
  assert.match(validateForHandoff({ ...ok, durationSec: 601 })[0]!, /exceeds the 600s maximum/);
  assert.deepEqual(validateForHandoff({ ...ok, durationSec: 3 }), [], "the floor itself is allowed");
  assert.deepEqual(validateForHandoff({ ...ok, durationSec: 600 }), [], "the ceiling is allowed");
});

test("the duration message names the setting that fixes it", () => {
  assert.match(validateForHandoff({ ...ok, durationSec: 1 })[0]!, /CLIP_TARGET_SECONDS/);
  assert.match(validateForHandoff({ ...ok, durationSec: 900 })[0]!, /CLIP_THRESHOLD_SECONDS/);
});

test("a frame smaller than 360px on either side is rejected", () => {
  assert.match(validateForHandoff({ ...ok, width: 200 })[0]!, /below 360px/);
  assert.match(validateForHandoff({ ...ok, height: 100 })[0]!, /below 360px/);
  assert.deepEqual(validateForHandoff({ ...ok, width: 360, height: 640 }), []);
});

test("frame rate must sit inside the 23-60 window", () => {
  assert.match(validateForHandoff({ ...ok, fps: 15 })[0]!, /outside the 23-60 range/);
  assert.match(validateForHandoff({ ...ok, fps: 120 })[0]!, /outside the 23-60 range/);
  assert.deepEqual(validateForHandoff({ ...ok, fps: 23 }), []);
  assert.deepEqual(validateForHandoff({ ...ok, fps: 60 }), []);
});

test("a file over 1 GiB is rejected", () => {
  const over = validateForHandoff({ ...ok, bytes: HANDOFF_LIMITS.maxBytes + 1 });
  assert.match(over[0]!, /over the 1024 MiB limit/);
  assert.deepEqual(validateForHandoff({ ...ok, bytes: HANDOFF_LIMITS.maxBytes }), []);
});

test("unmeasurable duration or frame rate is reported, not silently passed", () => {
  assert.match(validateForHandoff({ ...ok, durationSec: Number.NaN })[0]!, /duration could not be determined/);
  assert.match(validateForHandoff({ ...ok, fps: Number.NaN })[0]!, /frame rate could not be determined/);
  assert.match(validateForHandoff({ ...ok, durationSec: 0 })[0]!, /duration could not be determined/);
});

test("every broken rule is reported at once, not just the first", () => {
  const problems = validateForHandoff({
    durationSec: 1,
    width: 100,
    height: 100,
    fps: 5,
    bytes: HANDOFF_LIMITS.maxBytes * 2,
  });
  assert.equal(problems.length, 4, `expected four violations, got: ${problems.join(" | ")}`);
});

test("ffprobe rational frame rates are parsed", () => {
  assert.equal(parseFrameRate("30/1"), 30);
  assert.equal(parseFrameRate("60/1"), 60);
  assert.ok(Math.abs(parseFrameRate("30000/1001") - 29.97) < 0.01);
  assert.equal(parseFrameRate("25"), 25, "a bare integer is valid");
});

test("an unusable frame rate reads as NaN rather than zero or Infinity", () => {
  for (const bad of ["0/0", undefined, "", "abc", "30/0", "x/y"]) {
    assert.ok(Number.isNaN(parseFrameRate(bad)), `expected NaN for ${JSON.stringify(bad)}`);
  }
});

test("handoff mode builds captions to the 150-character title limit", async () => {
  const store = new Store(":memory:");
  try {
    const cfg = loadConfig({
      TIKTOK_PUBLISH_MODE: "handoff",
      CAPTION_HASHTAGS: "",
      CAPTION_MAX_LENGTH: "2200",
    } as NodeJS.ProcessEnv);

    const out = await ingestCandidate(store, cfg, {
      videoId: "dQw4w9WgXcQ",
      channelId: "UCabcdefghijklmnopqrstuv",
      title: "D".repeat(400),
      publishedAt: new Date().toISOString(),
    });
    assert.ok(out.accepted);
    const caption = store.getJob(out.jobIds[0]!)!.caption!;
    assert.ok(
      caption.length <= HANDOFF_LIMITS.maxTitleLength,
      `caption was ${caption.length} chars, over the ${HANDOFF_LIMITS.maxTitleLength} limit`
    );
  } finally {
    store.close();
  }
});

test("the other publish modes keep the full caption budget", async () => {
  const store = new Store(":memory:");
  try {
    const cfg = loadConfig({
      TIKTOK_PUBLISH_MODE: "inbox",
      CAPTION_HASHTAGS: "",
    } as NodeJS.ProcessEnv);

    const out = await ingestCandidate(store, cfg, {
      videoId: "dQw4w9WgXcQ",
      channelId: "UCabcdefghijklmnopqrstuv",
      title: "D".repeat(400),
      publishedAt: new Date().toISOString(),
    });
    assert.ok(out.accepted);
    assert.equal(store.getJob(out.jobIds[0]!)!.caption!.length, 400);
  } finally {
    store.close();
  }
});

test("handoff is a valid publish mode and the default is unchanged", () => {
  assert.equal(
    loadConfig({ TIKTOK_PUBLISH_MODE: "handoff" } as NodeJS.ProcessEnv).TIKTOK_PUBLISH_MODE,
    "handoff"
  );
  assert.equal(loadConfig({} as NodeJS.ProcessEnv).TIKTOK_PUBLISH_MODE, "inbox");
});
