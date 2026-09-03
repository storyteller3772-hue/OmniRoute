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
