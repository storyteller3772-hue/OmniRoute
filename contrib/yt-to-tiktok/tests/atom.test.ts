import test from "node:test";
import assert from "node:assert/strict";
import { decodeXmlEntities, parseYouTubeFeed } from "../src/util/atom.js";

const CHANNEL = "UCabcdefghijklmnopqrstuv";
const VIDEO = "dQw4w9WgXcQ";

function feed(entry: string): string {
  return `<?xml version="1.0"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:at="http://purl.org/atompub/tombstones/1.0"
      xmlns="http://www.w3.org/2005/Atom">
  <title>YouTube video feed</title>
  <updated>2026-08-30T10:00:00+00:00</updated>
  ${entry}
</feed>`;
}

const ENTRY = `<entry>
    <id>yt:video:${VIDEO}</id>
    <yt:videoId>${VIDEO}</yt:videoId>
    <yt:channelId>${CHANNEL}</yt:channelId>
    <title>Donut &amp; Coffee &lt;Ep. 4&gt;</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${VIDEO}"/>
    <author><name>yellowdonutt</name></author>
    <published>2026-08-30T09:58:00+00:00</published>
    <updated>2026-08-30T09:59:00+00:00</updated>
  </entry>`;

test("parses a normal upload notification", () => {
  const { entries } = parseYouTubeFeed(feed(ENTRY));
  assert.equal(entries.length, 1);
  const e = entries[0]!;
  assert.equal(e.videoId, VIDEO);
  assert.equal(e.channelId, CHANNEL);
  assert.equal(e.title, "Donut & Coffee <Ep. 4>");
  assert.equal(e.publishedAt, "2026-08-30T09:58:00.000Z");
  assert.equal(e.updatedAt, "2026-08-30T09:59:00.000Z");
  assert.equal(e.url, `https://www.youtube.com/watch?v=${VIDEO}`);
});

test("takes the entry title, not the feed-level title", () => {
  const { entries } = parseYouTubeFeed(feed(ENTRY));
  assert.notEqual(entries[0]!.title, "YouTube video feed");
});

test("parses multiple entries", () => {
  const second = ENTRY.replace(new RegExp(VIDEO, "g"), "abcdefghijk");
  const { entries } = parseYouTubeFeed(feed(`${ENTRY}\n${second}`));
  assert.deepEqual(
    entries.map((e) => e.videoId),
    [VIDEO, "abcdefghijk"]
  );
});

test("surfaces deleted-entry tombstones separately and never as uploads", () => {
  const tombstone = `<at:deleted-entry ref="yt:video:${VIDEO}" when="2026-08-30T10:00:00+00:00">
      <at:by><name>yellowdonutt</name></at:by>
    </at:deleted-entry>`;
  const parsed = parseYouTubeFeed(feed(tombstone));
  assert.equal(parsed.entries.length, 0);
  assert.deepEqual(parsed.deletedVideoIds, [VIDEO]);
});

test("drops an entry whose video id is not a valid 11-character id", () => {
  const bad = ENTRY.replace(`<yt:videoId>${VIDEO}</yt:videoId>`, "<yt:videoId>../../etc/passwd</yt:videoId>");
  assert.equal(parseYouTubeFeed(feed(bad)).entries.length, 0);
});

test("drops an entry whose channel id is malformed", () => {
  const bad = ENTRY.replace(`<yt:channelId>${CHANNEL}</yt:channelId>`, "<yt:channelId>nope</yt:channelId>");
  assert.equal(parseYouTubeFeed(feed(bad)).entries.length, 0);
});

test("drops an entry with an unparseable published date", () => {
  const bad = ENTRY.replace("<published>2026-08-30T09:58:00+00:00</published>", "<published>not-a-date</published>");
  assert.equal(parseYouTubeFeed(feed(bad)).entries.length, 0);
});

test("falls back to published when updated is missing or invalid", () => {
  const noUpdated = ENTRY.replace("<updated>2026-08-30T09:59:00+00:00</updated>", "");
  const e = parseYouTubeFeed(feed(noUpdated)).entries[0]!;
  assert.equal(e.updatedAt, e.publishedAt);
});

test("returns empty for junk input instead of throwing", () => {
  for (const junk of ["", "not xml at all", "<feed></feed>", "<entry>", "{}"]) {
    const parsed = parseYouTubeFeed(junk);
    assert.deepEqual(parsed.entries, []);
    assert.deepEqual(parsed.deletedVideoIds, []);
  }
});

test("decodes entities including numeric and hex references", () => {
  assert.equal(decodeXmlEntities("a &amp; b"), "a & b");
  assert.equal(decodeXmlEntities("&lt;tag&gt;"), "<tag>");
  assert.equal(decodeXmlEntities("&#65;&#66;"), "AB");
  assert.equal(decodeXmlEntities("&#x1F600;"), "\u{1F600}");
  assert.equal(decodeXmlEntities("&quot;q&quot; &apos;a&apos;"), '"q" \'a\'');
});

test("drops lone surrogates rather than emitting broken UTF-16", () => {
  assert.equal(decodeXmlEntities("&#xD800;"), "");
});

test("decodes &amp; last so &amp;lt; does not become a real tag", () => {
  assert.equal(decodeXmlEntities("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
});
