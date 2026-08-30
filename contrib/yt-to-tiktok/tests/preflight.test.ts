import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { checkRuntimeConfig } from "../src/preflight.js";

function check(env: Record<string, string>) {
  return checkRuntimeConfig(loadConfig(env as NodeJS.ProcessEnv));
}

const directPublic = {
  TIKTOK_PUBLISH_MODE: "direct",
  TIKTOK_PRIVACY_LEVEL: "PUBLIC_TO_EVERYONE",
  TIKTOK_CLIENT_KEY: "ck",
  TIKTOK_CLIENT_SECRET: "cs",
  TIKTOK_REDIRECT_URI: "https://example.test/oauth/tiktok/callback",
  REQUIRE_REVIEW: "false",
};

test("direct mode without credentials refuses to start", () => {
  const { fatal } = check({ TIKTOK_PUBLISH_MODE: "direct" });
  assert.ok(fatal.some((f) => /TIKTOK_CLIENT_KEY/.test(f)));
});

test("inbox mode without credentials also refuses to start", () => {
  assert.ok(check({ TIKTOK_PUBLISH_MODE: "inbox" }).fatal.length > 0);
});

test("handoff mode needs no TikTok credentials at all", () => {
  const { fatal } = check({ TIKTOK_PUBLISH_MODE: "handoff" });
  assert.deepEqual(fatal, []);
});

test("DRY_RUN lets the pipeline start without credentials", () => {
  assert.deepEqual(check({ TIKTOK_PUBLISH_MODE: "direct", DRY_RUN: "true" }).fatal, []);
});

test("the unattended public combination is called out explicitly", () => {
  const { warnings } = check(directPublic);
  assert.ok(
    warnings.some((w) => /UNATTENDED PUBLIC POSTING/.test(w)),
    `expected the unattended-public warning, got: ${warnings.join(" | ")}`
  );
});

test("that warning is absent when review is on", () => {
  const { warnings } = check({ ...directPublic, REQUIRE_REVIEW: "true" });
  assert.ok(!warnings.some((w) => /UNATTENDED PUBLIC/.test(w)));
});

test("that warning is absent when posting privately", () => {
  const { warnings } = check({ ...directPublic, TIKTOK_PRIVACY_LEVEL: "SELF_ONLY" });
  assert.ok(!warnings.some((w) => /UNATTENDED PUBLIC/.test(w)));
});

test("a fully configured public setup has no fatal problems", () => {
  const { fatal } = check({
    ...directPublic,
    YOUTUBE_API_KEY: "key",
    YOUTUBE_CHANNEL_ID: "UCabcdefghijklmnopqrstuv",
    PUBLIC_URL: "https://yt2tt.example.test",
    WEBSUB_SECRET: "a-secret-long-enough-to-pass",
  });
  assert.deepEqual(fatal, []);
});

test("command source mode without a command is fatal", () => {
  const { fatal } = check({ TIKTOK_PUBLISH_MODE: "handoff", SOURCE_MODE: "command" });
  assert.ok(fatal.some((f) => /SOURCE_COMMAND/.test(f)));
});

test("handoff mode rejects an fps or clip length it cannot publish", () => {
  assert.ok(
    check({ TIKTOK_PUBLISH_MODE: "handoff", OUTPUT_FPS: "12" }).fatal.some((f) => /OUTPUT_FPS/.test(f))
  );
  assert.ok(
    check({ TIKTOK_PUBLISH_MODE: "handoff", CLIP_TARGET_SECONDS: "900" }).fatal.some((f) =>
      /CLIP_TARGET_SECONDS/.test(f)
    )
  );
});

test("those same values are allowed in the API modes, which have different limits", () => {
  const { fatal } = check({
    ...directPublic,
    OUTPUT_FPS: "12",
    CLIP_TARGET_SECONDS: "900",
  });
  assert.deepEqual(fatal, []);
});

test("missing YouTube settings warn but do not block startup", () => {
  const { fatal, warnings } = check({ TIKTOK_PUBLISH_MODE: "handoff" });
  assert.deepEqual(fatal, []);
  assert.ok(warnings.some((w) => /YOUTUBE_API_KEY/.test(w)));
  assert.ok(warnings.some((w) => /YOUTUBE_CHANNEL_ID/.test(w)));
  assert.ok(warnings.some((w) => /PUBLIC_URL/.test(w)));
});

test("binding beyond loopback without a review token is flagged", () => {
  const { warnings } = check({ TIKTOK_PUBLISH_MODE: "handoff", HOST: "0.0.0.0" });
  assert.ok(warnings.some((w) => /REVIEW_TOKEN/.test(w)));
  const withToken = check({
    TIKTOK_PUBLISH_MODE: "handoff",
    HOST: "0.0.0.0",
    REVIEW_TOKEN: "a-long-enough-token",
  });
  assert.ok(!withToken.warnings.some((w) => /REVIEW_TOKEN/.test(w)));
});

test("trims that swallow the clip threshold are flagged", () => {
  const { warnings } = check({
    TIKTOK_PUBLISH_MODE: "handoff",
    CLIP_THRESHOLD_SECONDS: "60",
    CLIP_HEAD_TRIM_SECONDS: "40",
    CLIP_TAIL_TRIM_SECONDS: "30",
  });
  assert.ok(warnings.some((w) => /CLIP_HEAD_TRIM_SECONDS/.test(w)));
});
