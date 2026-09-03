/**
 * Accepts any of the forms a creator actually has to hand: a bare handle, an
 * @handle, or a profile URL pasted straight out of the TikTok share sheet
 * (which carries `?_r=` and `?_t=` tracking parameters that are dropped).
 *
 * Returns null when the input names no handle - notably a vm.tiktok.com short
 * link, which resolves only by following a redirect and so cannot be trusted to
 * name an account offline.
 */
export function parseTikTokHandle(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  let candidate = raw;

  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    // Short links carry an opaque id, not a handle.
    if (host === "vm.tiktok.com" || host === "vt.tiktok.com") return null;
    if (host !== "tiktok.com" && !host.endsWith(".tiktok.com")) return null;

    const segment = url.pathname.split("/").filter(Boolean)[0] ?? "";
    if (!segment.startsWith("@")) return null;
    candidate = segment;
  }

  const handle = candidate.replace(/^@+/, "").trim().toLowerCase();
  // TikTok usernames: letters, digits, underscore and period, 1-24 chars.
  if (!/^[a-z0-9._]{1,24}$/.test(handle)) return null;
  return handle;
}

import type { CreatorInfo } from "./publish.js";

/**
 * Confirms the linked TikTok account is the one the operator named.
 *
 * The destination is a property of the stored OAuth token, not a setting, so
 * approving the authorisation link while signed into a different account
 * retargets every future post with nothing to notice it. Comparing against a
 * handle the operator wrote down is the only check available.
 */
export function checkExpectedAccount(
  info: Pick<CreatorInfo, "creator_username">,
  expected: string | undefined
): { ok: true } | { ok: false; message: string } {
  if (!expected) return { ok: true };

  const actual = (info.creator_username ?? "").trim().replace(/^@+/, "").toLowerCase();
  if (!actual) {
    return {
      ok: false,
      message:
        `EXPECTED_TIKTOK_USERNAME is @${expected} but TikTok did not report a username for the ` +
        "linked account, so the destination cannot be confirmed",
    };
  }
  if (actual !== expected) {
    return {
      ok: false,
      message:
        `linked TikTok account is @${actual}, not the expected @${expected}. ` +
        "Re-run `cli tiktok-login` signed in as the right account, or update EXPECTED_TIKTOK_USERNAME.",
    };
  }
  return { ok: true };
}
