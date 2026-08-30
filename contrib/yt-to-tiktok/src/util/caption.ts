export interface CaptionInput {
  title: string;
  description?: string | null;
  videoId: string;
  clipIndex?: number;
  clipCount?: number;
}

export interface CaptionOptions {
  template: string;
  hashtags: string[];
  maxLength: number;
}

/**
 * Renders the post caption from a template, then appends hashtags.
 *
 * When the result is too long the BODY is trimmed and the hashtags are kept:
 * a caption cut mid-hashtag reads as a mistake, and the tags are usually the
 * part that has to survive. Only if the tags alone overflow are they dropped
 * from the end.
 */
export function buildCaption(input: CaptionInput, opts: CaptionOptions): string {
  const clipSuffix =
    input.clipCount && input.clipCount > 1
      ? ` (${(input.clipIndex ?? 0) + 1}/${input.clipCount})`
      : "";

  const body = opts.template
    .replaceAll("{title}", input.title ?? "")
    .replaceAll("{description}", input.description ?? "")
    .replaceAll("{videoId}", input.videoId)
    .replaceAll("{url}", `https://www.youtube.com/watch?v=${input.videoId}`)
    .replaceAll("{clip}", clipSuffix.trim())
    .trim();

  const tags = normaliseHashtags(opts.hashtags);
  const tagText = tags.join(" ");
  const max = Math.max(1, opts.maxLength);

  if (!tagText) return truncateCodePoints(body, max);

  // +1 for the space between body and tags.
  const budget = max - tagText.length - 1;
  if (budget > 0) {
    const trimmedBody = truncateCodePoints(body, budget);
    return trimmedBody ? `${trimmedBody} ${tagText}` : tagText;
  }

  // Tags alone do not fit: drop from the end until they do.
  const kept: string[] = [];
  let used = 0;
  for (const tag of tags) {
    const cost = kept.length ? tag.length + 1 : tag.length;
    if (used + cost > max) break;
    kept.push(tag);
    used += cost;
  }
  return kept.join(" ");
}

export function normaliseHashtags(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    // Strip everything a hashtag cannot contain, including the whitespace that
    // would silently split one tag into two.
    const cleaned = item.trim().replace(/^#+/, "").replace(/[\s#]+/g, "");
    if (!cleaned) continue;
    const tag = `#${cleaned}`;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * Truncates by code point, not UTF-16 unit, so an emoji is never split into a
 * lone surrogate. Adds a single-character ellipsis when it actually cuts.
 */
export function truncateCodePoints(text: string, max: number): string {
  if (max <= 0) return "";
  const points = Array.from(text);
  if (points.length <= max) return text;
  if (max === 1) return "…";
  return `${points.slice(0, max - 1).join("").trimEnd()}…`;
}
