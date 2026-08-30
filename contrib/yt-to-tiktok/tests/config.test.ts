import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("an empty environment still yields a usable, safe default config", () => {
  const cfg = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(cfg.PORT, 8787);
  assert.equal(cfg.HOST, "127.0.0.1", "must not bind every interface by default");
  assert.equal(cfg.REQUIRE_REVIEW, true, "review must default to ON");
  assert.equal(cfg.TIKTOK_PUBLISH_MODE, "inbox", "must default to drafts, not public posting");
  assert.equal(cfg.TIKTOK_PRIVACY_LEVEL, "SELF_ONLY", "must default to the most private option");
  assert.equal(cfg.DRY_RUN, false);
});

test("a malformed channel id is rejected at startup, not at first use", () => {
  assert.throws(
    () => loadConfig({ YOUTUBE_CHANNEL_ID: "yellowdonutt" } as NodeJS.ProcessEnv),
    /UC-prefixed/
  );
  assert.throws(() => loadConfig({ YOUTUBE_CHANNEL_ID: "UCtooshort" } as NodeJS.ProcessEnv));
});

test("a valid channel id is accepted", () => {
  const cfg = loadConfig({ YOUTUBE_CHANNEL_ID: "UCabcdefghijklmnopqrstuv" } as NodeJS.ProcessEnv);
  assert.equal(cfg.YOUTUBE_CHANNEL_ID, "UCabcdefghijklmnopqrstuv");
});

test("boolean flags accept true/false and 1/0", () => {
  assert.equal(loadConfig({ REQUIRE_REVIEW: "false" } as NodeJS.ProcessEnv).REQUIRE_REVIEW, false);
  assert.equal(loadConfig({ REQUIRE_REVIEW: "0" } as NodeJS.ProcessEnv).REQUIRE_REVIEW, false);
  assert.equal(loadConfig({ DRY_RUN: "1" } as NodeJS.ProcessEnv).DRY_RUN, true);
});

test("a nonsense boolean is rejected rather than silently read as false", () => {
  assert.throws(() => loadConfig({ REQUIRE_REVIEW: "yes" } as NodeJS.ProcessEnv), /REQUIRE_REVIEW/);
});

test("comma-separated lists are split and trimmed", () => {
  const cfg = loadConfig({ CAPTION_HASHTAGS: " shorts , donut ,, food " } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg.CAPTION_HASHTAGS, ["shorts", "donut", "food"]);
});

test("an empty list yields an empty array, not [''] ", () => {
  assert.deepEqual(loadConfig({ CAPTION_HASHTAGS: "" } as NodeJS.ProcessEnv).CAPTION_HASHTAGS, []);
});

test("the chunk size is constrained to TikTok's 5-64 MiB window", () => {
  assert.throws(() => loadConfig({ TIKTOK_CHUNK_SIZE_MB: "1" } as NodeJS.ProcessEnv));
  assert.throws(() => loadConfig({ TIKTOK_CHUNK_SIZE_MB: "128" } as NodeJS.ProcessEnv));
  assert.equal(loadConfig({ TIKTOK_CHUNK_SIZE_MB: "64" } as NodeJS.ProcessEnv).TIKTOK_CHUNK_SIZE_MB, 64);
});

test("an unknown vertical mode or privacy level is rejected", () => {
  assert.throws(() => loadConfig({ VERTICAL_MODE: "zoom" } as NodeJS.ProcessEnv));
  assert.throws(() => loadConfig({ TIKTOK_PRIVACY_LEVEL: "EVERYONE" } as NodeJS.ProcessEnv));
});

test("a too-short review token is rejected", () => {
  assert.throws(() => loadConfig({ REVIEW_TOKEN: "short" } as NodeJS.ProcessEnv), /REVIEW_TOKEN/);
});

test("a non-URL PUBLIC_URL is rejected", () => {
  assert.throws(() => loadConfig({ PUBLIC_URL: "not a url" } as NodeJS.ProcessEnv), /PUBLIC_URL/);
});

test("the error message names every offending field at once", () => {
  try {
    loadConfig({ PORT: "0", VERTICAL_MODE: "nope" } as NodeJS.ProcessEnv);
    assert.fail("should have thrown");
  } catch (err) {
    const msg = (err as Error).message;
    assert.match(msg, /PORT/);
    assert.match(msg, /VERTICAL_MODE/);
  }
});
