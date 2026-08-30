/**
 * Minimal reader for the YouTube uploads Atom feed delivered by the WebSub hub.
 *
 * A full XML parser is deliberately avoided: the feed shape is fixed and narrow,
 * and every value we lift out is re-validated against a strict pattern before it
 * can reach a file path or an API call. Anything that does not validate is
 * dropped rather than repaired.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

export interface FeedEntry {
  videoId: string;
  channelId: string;
  title: string;
  publishedAt: string;
  updatedAt: string;
  url: string;
}

export interface ParsedFeed {
  entries: FeedEntry[];
  /** `at:deleted-entry` refs. Surfaced so callers can log them, never acted on. */
  deletedVideoIds: string[];
}

export function decodeXmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  // Lone surrogates are not valid scalar values and break downstream encoders.
  if (cp >= 0xd800 && cp <= 0xdfff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

function tagText(block: string, tag: string): string | null {
  // Optional namespace prefix; attributes tolerated on the open tag.
  const re = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`);
  const m = re.exec(block);
  return m && m[1] !== undefined ? decodeXmlEntities(m[1]).trim() : null;
}

export function parseYouTubeFeed(xml: string): ParsedFeed {
  const entries: FeedEntry[] = [];
  const deletedVideoIds: string[] = [];

  if (typeof xml !== "string" || !xml.length) return { entries, deletedVideoIds };

  for (const m of xml.matchAll(
    /<(?:[A-Za-z0-9_.-]+:)?deleted-entry\b[^>]*\bref=["']yt:video:([A-Za-z0-9_-]{11})["']/g
  )) {
    if (m[1]) deletedVideoIds.push(m[1]);
  }

  for (const m of xml.matchAll(
    /<(?:[A-Za-z0-9_.-]+:)?entry(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?entry>/g
  )) {
    const block = m[1];
    if (!block) continue;

    const videoId = tagText(block, "videoId");
    const channelId = tagText(block, "channelId");
    if (!videoId || !VIDEO_ID.test(videoId)) continue;
    if (!channelId || !CHANNEL_ID.test(channelId)) continue;

    const published = tagText(block, "published");
    const updated = tagText(block, "updated");
    if (!published || Number.isNaN(Date.parse(published))) continue;

    entries.push({
      videoId,
      channelId,
      title: tagText(block, "title") ?? "",
      publishedAt: new Date(published).toISOString(),
      updatedAt:
        updated && !Number.isNaN(Date.parse(updated))
          ? new Date(updated).toISOString()
          : new Date(published).toISOString(),
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }

  return { entries, deletedVideoIds };
}
