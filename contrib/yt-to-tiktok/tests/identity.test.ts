import test from "node:test";
import assert from "node:assert/strict";
import { checkExpectedAccount } from "../src/tiktok/identity.js";
import { loadConfig } from "../src/config.js";

test("no expectation configured means no check", () => {
  assert.deepEqual(checkExpectedAccount({ creator_username: "anyone" }, undefined), { ok: true });
});

test("a matching account passes", () => {
  assert.deepEqual(checkExpectedAccount({ creator_username: "yellowdonutt" }, "yellowdonutt"), {
    ok: true,
  });
});

test("comparison ignores case and a leading @", () => {
  for (const actual of ["YellowDonutt", "@yellowdonutt", "@YELLOWDONUTT"]) {
    const r = checkExpectedAccount({ creator_username: actual }, "yellowdonutt");
    assert.equal(r.ok, true, actual);
  }
});

test("a different account is rejected, naming both sides", () => {
  const r = checkExpectedAccount({ creator_username: "someoneelse" }, "yellowdonutt");
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.message : "", /@someoneelse/);
  assert.match(r.ok === false ? r.message : "", /@yellowdonutt/);
  assert.match(r.ok === false ? r.message : "", /tiktok-login/);
});

test("a missing username is treated as unconfirmable, not as a pass", () => {
  for (const missing of [undefined, "", "   "]) {
    const r = checkExpectedAccount({ creator_username: missing }, "yellowdonutt");
    assert.equal(r.ok, false, JSON.stringify(missing));
    assert.match(r.ok === false ? r.message : "", /cannot be confirmed/);
  }
});

test("the configured handle is normalised at load time", () => {
  for (const raw of ["@YellowDonutt", "yellowdonutt", "  @yellowdonutt  "]) {
    assert.equal(
      loadConfig({ EXPECTED_TIKTOK_USERNAME: raw } as NodeJS.ProcessEnv).EXPECTED_TIKTOK_USERNAME,
      "yellowdonutt",
      raw
    );
  }
});

test("preflight warns when no expected account is set", async () => {
  const { checkRuntimeConfig } = await import("../src/preflight.js");
  const { warnings } = checkRuntimeConfig(
    loadConfig({
      TIKTOK_PUBLISH_MODE: "direct",
      TIKTOK_CLIENT_KEY: "ck",
      TIKTOK_CLIENT_SECRET: "cs",
      TIKTOK_REDIRECT_URI: "https://example.test/cb",
    } as NodeJS.ProcessEnv)
  );
  assert.ok(warnings.some((w) => /EXPECTED_TIKTOK_USERNAME/.test(w)));
});

test("that warning goes away once it is set", async () => {
  const { checkRuntimeConfig } = await import("../src/preflight.js");
  const { warnings } = checkRuntimeConfig(
    loadConfig({
      TIKTOK_PUBLISH_MODE: "direct",
      TIKTOK_CLIENT_KEY: "ck",
      TIKTOK_CLIENT_SECRET: "cs",
      TIKTOK_REDIRECT_URI: "https://example.test/cb",
      EXPECTED_TIKTOK_USERNAME: "@yellowdonutt",
    } as NodeJS.ProcessEnv)
  );
  assert.ok(!warnings.some((w) => /EXPECTED_TIKTOK_USERNAME/.test(w)));
});

// ---------------------------------------------------------------------------
// handle parsing
// ---------------------------------------------------------------------------

import { parseTikTokHandle } from "../src/tiktok/identity.js";

test("a profile URL from the share sheet yields the handle, tracking dropped", () => {
  assert.equal(
    parseTikTokHandle("https://www.tiktok.com/@jdidhdududjdjjdjdidjf?_r=1&_t=ZS-99QPAI9vevV"),
    "jdidhdududjdjjdjdidjf"
  );
});

test("the plain forms all work", () => {
  for (const input of ["@yellowdonutt", "yellowdonutt", "  @YellowDonutt  "]) {
    assert.equal(parseTikTokHandle(input), "yellowdonutt", input);
  }
});

test("URL variants are accepted", () => {
  for (const input of [
    "https://tiktok.com/@yellowdonutt",
    "https://www.tiktok.com/@yellowdonutt",
    "https://www.tiktok.com/@yellowdonutt/",
    "https://www.tiktok.com/@yellowdonutt/video/7412345678901234567",
    "HTTPS://WWW.TIKTOK.COM/@YellowDonutt",
  ]) {
    assert.equal(parseTikTokHandle(input), "yellowdonutt", input);
  }
});

test("a short link is refused rather than guessed at", () => {
  // These resolve only by following a redirect, so nothing offline can trust them.
  assert.equal(parseTikTokHandle("https://vm.tiktok.com/ZS99QPAI9/"), null);
  assert.equal(parseTikTokHandle("https://vt.tiktok.com/ZS99QPAI9/"), null);
});

test("URLs that name no account are refused", () => {
  for (const input of [
    "https://www.tiktok.com/",
    "https://www.tiktok.com/foryou",
    "https://www.tiktok.com/tag/donut",
    "https://example.com/@yellowdonutt",
    "https://notiktok.com/@yellowdonutt",
  ]) {
    assert.equal(parseTikTokHandle(input), null, input);
  }
});

test("malformed handles are refused", () => {
  for (const input of ["", "   ", "@", "with space", "a".repeat(25), "bad!chars", "@@"]) {
    assert.equal(parseTikTokHandle(input), null, JSON.stringify(input));
  }
});

test("periods and underscores are valid in a handle", () => {
  assert.equal(parseTikTokHandle("@yellow.donut_t"), "yellow.donut_t");
});

test("config rejects an unparseable expected account at startup", () => {
  assert.throws(
    () => loadConfig({ EXPECTED_TIKTOK_USERNAME: "https://vm.tiktok.com/ZS99/" } as NodeJS.ProcessEnv),
    /profile URL/
  );
  assert.throws(
    () => loadConfig({ EXPECTED_TIKTOK_USERNAME: "not a handle!" } as NodeJS.ProcessEnv),
    /EXPECTED_TIKTOK_USERNAME/
  );
});

test("config accepts the pasted share-sheet URL", () => {
  const cfg = loadConfig({
    EXPECTED_TIKTOK_USERNAME: "https://www.tiktok.com/@jdidhdududjdjjdjdidjf?_r=1&_t=ZS-99QPAI9vevV",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.EXPECTED_TIKTOK_USERNAME, "jdidhdududjdjjdjdidjf");
});
