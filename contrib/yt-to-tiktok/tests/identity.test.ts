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
