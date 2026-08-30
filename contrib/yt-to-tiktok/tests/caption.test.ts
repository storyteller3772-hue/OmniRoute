import test from "node:test";
import assert from "node:assert/strict";
import { buildCaption, normaliseHashtags, truncateCodePoints } from "../src/util/caption.js";

const base = { title: "Donut Review", videoId: "dQw4w9WgXcQ" };
const opts = { template: "{title}", hashtags: [], maxLength: 2200 };

test("renders the title template", () => {
  assert.equal(buildCaption(base, opts), "Donut Review");
});

test("substitutes every supported placeholder", () => {
  const out = buildCaption(
    { ...base, description: "tasty" },
    { ...opts, template: "{title} | {description} | {videoId} | {url}" }
  );
  assert.equal(out, "Donut Review | tasty | dQw4w9WgXcQ | https://www.youtube.com/watch?v=dQw4w9WgXcQ");
});

test("appends a clip counter only when there is more than one clip", () => {
  assert.equal(
    buildCaption({ ...base, clipIndex: 1, clipCount: 3 }, { ...opts, template: "{title} {clip}" }),
    "Donut Review (2/3)"
  );
  assert.equal(
    buildCaption({ ...base, clipIndex: 0, clipCount: 1 }, { ...opts, template: "{title} {clip}" }),
    "Donut Review"
  );
});

test("appends normalised hashtags", () => {
  const out = buildCaption(base, { ...opts, hashtags: ["shorts", "#food"] });
  assert.equal(out, "Donut Review #shorts #food");
});

test("trims the body, never the hashtags, when the caption is too long", () => {
  const out = buildCaption(
    { ...base, title: "x".repeat(200) },
    { ...opts, hashtags: ["shorts"], maxLength: 40 }
  );
  assert.ok(out.length <= 40, `caption was ${out.length} chars`);
  assert.ok(out.endsWith("#shorts"), `hashtags must survive: ${out}`);
  assert.ok(out.includes("…"), "the trimmed body should be marked with an ellipsis");
});

test("drops hashtags from the end when they alone overflow the limit", () => {
  const out = buildCaption(base, { ...opts, hashtags: ["aaaaa", "bbbbb", "ccccc"], maxLength: 12 });
  assert.ok(out.length <= 12, `got ${out.length}: ${out}`);
  assert.equal(out, "#aaaaa");
});

test("never splits an emoji into a lone surrogate", () => {
  const out = truncateCodePoints("🍩🍩🍩🍩🍩", 3);
  assert.equal(out, "🍩🍩…");
  assert.equal(Array.from(out).length, 3);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), "no dangling high surrogate");
});

test("truncation is a no-op when the text already fits", () => {
  assert.equal(truncateCodePoints("short", 20), "short");
  assert.equal(truncateCodePoints("exact", 5), "exact");
});

test("a zero or negative budget yields an empty string", () => {
  assert.equal(truncateCodePoints("anything", 0), "");
  assert.equal(truncateCodePoints("anything", -5), "");
});

test("hashtag normalisation strips leading hashes, spaces and duplicates", () => {
  assert.deepEqual(normaliseHashtags(["#food", "food", "  travel  ", "###vlog", "", "  "]), [
    "#food",
    "#travel",
    "#vlog",
  ]);
});

test("hashtag normalisation collapses inner whitespace so one tag stays one tag", () => {
  assert.deepEqual(normaliseHashtags(["day in the life"]), ["#dayinthelife"]);
});

test("hashtag de-duplication is case-insensitive", () => {
  assert.deepEqual(normaliseHashtags(["#Food", "#food", "#FOOD"]), ["#Food"]);
});

test("caption output never exceeds the configured maximum", () => {
  for (const max of [1, 5, 20, 100]) {
    const out = buildCaption(
      { ...base, title: "y".repeat(500) },
      { ...opts, hashtags: ["one", "two", "three"], maxLength: max }
    );
    assert.ok(out.length <= max, `max=${max} produced ${out.length} chars`);
  }
});
