import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db.js";
import { createHttpServer } from "../src/server.js";
import { LOGIN_TTL_MS, startLogin } from "../src/tiktok/oauth.js";

/**
 * The OAuth callback is publicly reachable by necessity. These cover the CSRF
 * boundary: only a login this instance actually started may be completed.
 */

const cfg = () =>
  loadConfig({
    TIKTOK_CLIENT_KEY: "ck",
    TIKTOK_CLIENT_SECRET: "cs",
    TIKTOK_REDIRECT_URI: "https://example.test/oauth/tiktok/callback",
    YOUTUBE_CHANNEL_ID: "UCabcdefghijklmnopqrstuv",
    CAPTION_HASHTAGS: "",
  } as NodeJS.ProcessEnv);

async function withServer(fn: (base: string, store: Store) => Promise<void>): Promise<void> {
  const store = new Store(":memory:");
  const server = createHttpServer(store, cfg());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

test("a callback with no state is rejected", async () => {
  await withServer(async (base, store) => {
    const res = await fetch(`${base}/oauth/tiktok/callback?code=attacker-code`);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /missing state/);
    assert.equal(store.getTokens("tiktok"), undefined, "no tokens may be stored");
  });
});

test("a callback with an unknown state is rejected - the CSRF case", async () => {
  // An attacker who knows the public callback URL submitting their own code.
  await withServer(async (base, store) => {
    const res = await fetch(
      `${base}/oauth/tiktok/callback?code=attacker-code&state=made-up-state`
    );
    assert.equal(res.status, 403);
    assert.equal(store.getTokens("tiktok"), undefined, "attacker tokens must not be stored");
  });
});

test("a state is single use - replaying it is rejected", async () => {
  const store = new Store(":memory:");
  try {
    const { state } = startLogin(store, {
      clientKey: "ck",
      redirectUri: "https://example.test/cb",
      scopes: ["video.publish"],
    });
    assert.ok(store.consumePendingLogin(state), "first use succeeds");
    assert.equal(store.consumePendingLogin(state), null, "replay must fail");
  } finally {
    store.close();
  }
});

test("an expired state is rejected and cleaned up", () => {
  const store = new Store(":memory:");
  try {
    const now = Date.now();
    const { state } = startLogin(
      store,
      { clientKey: "ck", redirectUri: "https://example.test/cb", scopes: [] },
      now
    );
    assert.equal(store.consumePendingLogin(state, now + LOGIN_TTL_MS + 1000), null);
  } finally {
    store.close();
  }
});

test("a failed exchange still consumes the state, so it cannot be retried", () => {
  const store = new Store(":memory:");
  try {
    const { state } = startLogin(store, {
      clientKey: "ck",
      redirectUri: "https://example.test/cb",
      scopes: [],
    });
    store.consumePendingLogin(state);
    assert.equal(store.consumePendingLogin(state), null);
  } finally {
    store.close();
  }
});

test("each login gets a distinct, unguessable state and verifier", () => {
  const store = new Store(":memory:");
  try {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const { state } = startLogin(store, {
        clientKey: "ck",
        redirectUri: "https://example.test/cb",
        scopes: [],
      });
      assert.ok(state.length >= 24, "state must be long enough to resist guessing");
      seen.add(state);
    }
    assert.equal(seen.size, 25);
  } finally {
    store.close();
  }
});

test("the authorize URL carries the state that was recorded", () => {
  const store = new Store(":memory:");
  try {
    const { url, state } = startLogin(store, {
      clientKey: "ck",
      redirectUri: "https://example.test/cb",
      scopes: ["video.publish"],
    });
    assert.equal(new URL(url).searchParams.get("state"), state);
    assert.ok(new URL(url).searchParams.get("code_challenge"), "PKCE must still be present");
  } finally {
    store.close();
  }
});

test("an error response is reflected safely and bounded", async () => {
  await withServer(async (base) => {
    const nasty = "access_denied<script>alert(1)</script>" + "A".repeat(500);
    const res = await fetch(
      `${base}/oauth/tiktok/callback?error=${encodeURIComponent(nasty)}`
    );
    const body = await res.text();
    assert.equal(res.status, 400);
    assert.ok(!body.includes("<script>"), "markup must not survive reflection");
    assert.ok(body.length < 200, `reflected body was ${body.length} chars`);
  });
});

test("expired pending logins are purged in bulk", () => {
  const store = new Store(":memory:");
  try {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      store.createPendingLogin(`state-${i}`, "verifier", 1000, now);
    }
    store.createPendingLogin("fresh", "verifier", 60_000, now);
    assert.equal(store.purgeExpiredLogins(now + 5000), 3);
    assert.ok(store.consumePendingLogin("fresh", now + 5000), "the live login survives");
  } finally {
    store.close();
  }
});
