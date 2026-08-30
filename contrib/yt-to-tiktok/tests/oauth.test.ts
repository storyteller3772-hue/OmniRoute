import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthorizeUrl,
  codeChallengeFrom,
  generateCodeVerifier,
  needsRefresh,
  persistTokens,
  REFRESH_SKEW_MS,
  SCOPE_DIRECT,
  SCOPE_INBOX,
} from "../src/tiktok/oauth.js";
import { shouldRenew, topicUrlFor, callbackUrlFor } from "../src/youtube/websub.js";
import { Store } from "../src/db.js";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");

test("the authorize URL carries every parameter TikTok requires", () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientKey: "ck",
      redirectUri: "https://example.test/oauth/tiktok/callback",
      scopes: SCOPE_INBOX,
      state: "xyz",
      codeChallenge: "chal",
    })
  );
  assert.equal(url.origin + url.pathname, "https://www.tiktok.com/v2/auth/authorize/");
  assert.equal(url.searchParams.get("client_key"), "ck");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "user.info.basic,video.upload");
  assert.equal(url.searchParams.get("state"), "xyz");
  assert.equal(url.searchParams.get("code_challenge"), "chal");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("PKCE parameters are omitted when no challenge is supplied", () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientKey: "ck",
      redirectUri: "https://example.test/cb",
      scopes: SCOPE_INBOX,
      state: "s",
    })
  );
  assert.equal(url.searchParams.get("code_challenge"), null);
  assert.equal(url.searchParams.get("code_challenge_method"), null);
});

test("direct posting asks for video.publish, inbox for video.upload", () => {
  assert.ok(SCOPE_DIRECT.includes("video.publish"));
  assert.ok(SCOPE_INBOX.includes("video.upload"));
  assert.ok(!SCOPE_INBOX.includes("video.publish"), "inbox mode must not request publish rights");
});

test("the PKCE challenge is a base64url S256 digest of the verifier", () => {
  const verifier = generateCodeVerifier();
  const challenge = codeChallengeFrom(verifier);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/, "must be base64url with no padding");
  assert.equal(codeChallengeFrom(verifier), challenge, "must be deterministic");
  assert.notEqual(codeChallengeFrom(generateCodeVerifier()), challenge);
});

test("code verifiers are unique and long enough to be unguessable", () => {
  const seen = new Set(Array.from({ length: 50 }, () => generateCodeVerifier()));
  assert.equal(seen.size, 50);
  assert.ok([...seen][0]!.length >= 43, "RFC 7636 requires at least 43 characters");
});

test("a token is refreshed before it expires, not after", () => {
  const soon = new Date(NOW + REFRESH_SKEW_MS - 1000).toISOString();
  const later = new Date(NOW + REFRESH_SKEW_MS + 60_000).toISOString();
  assert.equal(needsRefresh(soon, NOW), true, "inside the skew window it must refresh");
  assert.equal(needsRefresh(later, NOW), false);
});

test("a missing or unparseable expiry forces a refresh", () => {
  assert.equal(needsRefresh(null, NOW), true);
  assert.equal(needsRefresh("not-a-date", NOW), true);
});

test("an already-expired token needs a refresh", () => {
  assert.equal(needsRefresh(new Date(NOW - 1000).toISOString(), NOW), true);
});

test("persisted tokens get absolute expiry timestamps derived from expires_in", () => {
  const store = new Store(":memory:");
  try {
    persistTokens(
      store,
      {
        access_token: "at",
        expires_in: 3600,
        refresh_token: "rt",
        refresh_expires_in: 7200,
        open_id: "oid",
        scope: "video.upload",
      },
      NOW
    );
    const row = store.getTokens("tiktok")!;
    assert.equal(row.expires_at, new Date(NOW + 3_600_000).toISOString());
    assert.equal(row.refresh_expires_at, new Date(NOW + 7_200_000).toISOString());
    assert.equal(row.open_id, "oid");
  } finally {
    store.close();
  }
});

test("a WebSub lease is renewed once 80% of it has elapsed", () => {
  const lease = 432_000; // 5 days
  const expiry = NOW + lease * 1000;
  const at79 = NOW + lease * 1000 * 0.79;
  const at81 = NOW + lease * 1000 * 0.81;
  assert.equal(shouldRenew(new Date(expiry).toISOString(), lease, at79), false);
  assert.equal(shouldRenew(new Date(expiry).toISOString(), lease, at81), true);
});

test("an unknown or expired lease renews immediately", () => {
  assert.equal(shouldRenew(null, 432_000, NOW), true);
  assert.equal(shouldRenew("junk", 432_000, NOW), true);
  assert.equal(shouldRenew(new Date(NOW - 1000).toISOString(), 432_000, NOW), true);
});

test("the feed topic and callback URLs are built correctly", () => {
  assert.equal(
    topicUrlFor("UCabcdefghijklmnopqrstuv"),
    "https://www.youtube.com/xml/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv"
  );
  assert.equal(callbackUrlFor("https://yt2tt.example.test"), "https://yt2tt.example.test/websub/youtube");
  assert.equal(
    callbackUrlFor("https://yt2tt.example.test/base/"),
    "https://yt2tt.example.test/websub/youtube",
    "the callback path is absolute"
  );
});
