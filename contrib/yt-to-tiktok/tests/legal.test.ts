import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db.js";
import { createHttpServer } from "../src/server.js";
import { renderPrivacy, renderTerms } from "../src/legal.js";

const cfg = (env: Record<string, string> = {}) =>
  loadConfig({
    LEGAL_ENTITY_NAME: "Yellow Donut",
    LEGAL_CONTACT_EMAIL: "hello@example.test",
    LEGAL_EFFECTIVE_DATE: "2026-08-30",
    ...env,
  } as NodeJS.ProcessEnv);

test("both pages render the operator identity and contact", () => {
  for (const html of [renderTerms(cfg()), renderPrivacy(cfg())]) {
    assert.match(html, /Yellow Donut/);
    assert.match(html, /hello@example\.test/);
    assert.match(html, /2026-08-30/);
  }
});

test("the entity name is HTML-escaped, so it cannot inject markup", () => {
  const html = renderTerms(cfg({ LEGAL_ENTITY_NAME: '<script>alert(1)</script>' }));
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw script tag must not survive");
  assert.match(html, /&lt;script&gt;/);
});

test("a missing contact email renders a visible placeholder rather than a broken link", () => {
  const html = renderPrivacy(loadConfig({} as NodeJS.ProcessEnv));
  assert.match(html, /LEGAL_CONTACT_EMAIL/);
  assert.ok(!html.includes("mailto:undefined"));
});

test("the effective date falls back to today when unset", () => {
  const html = renderTerms(loadConfig({} as NodeJS.ProcessEnv));
  assert.match(html, new RegExp(new Date().toISOString().slice(0, 10)));
});

test("each page is a complete, titled HTML document", () => {
  const terms = renderTerms(cfg());
  assert.match(terms, /^<!doctype html>/i);
  assert.match(terms, /<title>Terms of Service<\/title>/);
  assert.match(renderPrivacy(cfg()), /<title>Privacy Policy<\/title>/);
});

test("the pages cross-link to each other", () => {
  assert.match(renderTerms(cfg()), /href="\/legal\/privacy"/);
  assert.match(renderPrivacy(cfg()), /href="\/legal\/terms"/);
});

test("the privacy policy names both data destinations and denies the rest", () => {
  const html = renderPrivacy(cfg());
  assert.match(html, /YouTube Data API/);
  assert.match(html, /TikTok/);
  assert.match(html, /No analytics/);
  assert.match(html, /No data sold/);
});

test("the terms state the operator's content-rights obligation", () => {
  const html = renderTerms(cfg());
  assert.match(html, /own or are licensed to publish/);
  assert.match(html, /does not download video from YouTube/);
});

async function withServer(
  env: Record<string, string>,
  fn: (base: string) => Promise<void>
): Promise<void> {
  const store = new Store(":memory:");
  const server = createHttpServer(store, cfg(env));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

test("both pages are served as HTML", async () => {
  await withServer({}, async (base) => {
    for (const path of ["/legal/terms", "/legal/privacy"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/, path);
      assert.match(await res.text(), /Yellow Donut/, path);
    }
  });
});

test("the legal pages stay public even when a review token is set", async () => {
  // TikTok's reviewer fetches these unauthenticated; gating them fails the audit.
  await withServer({ REVIEW_TOKEN: "a-long-enough-review-token" }, async (base) => {
    assert.equal((await fetch(`${base}/legal/terms`)).status, 200);
    assert.equal((await fetch(`${base}/legal/privacy`)).status, 200);
    assert.equal((await fetch(`${base}/jobs`)).status, 401, "but the review API stays gated");
  });
});

test("a trailing slash resolves to the same page", async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/legal/terms/`)).status, 200);
  });
});
