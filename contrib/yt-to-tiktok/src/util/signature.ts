import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a WebSub `X-Hub-Signature` header against the RAW request body.
 *
 * The body must be the exact bytes received - re-serialising parsed XML will
 * not reproduce the digest. Comparison is constant-time; an attacker who can
 * reach the callback should not be able to learn the secret a byte at a time.
 */
export function verifyHubSignature(
  header: string | undefined,
  rawBody: Buffer,
  secret: string
): boolean {
  if (!header || !secret) return false;

  const eq = header.indexOf("=");
  if (eq <= 0) return false;

  const algo = header.slice(0, eq).toLowerCase();
  const provided = header.slice(eq + 1).trim();
  if (!/^[0-9a-f]+$/i.test(provided)) return false;
  if (algo !== "sha1" && algo !== "sha256" && algo !== "sha384" && algo !== "sha512") return false;

  let expected: Buffer;
  try {
    expected = createHmac(algo, secret).update(rawBody).digest();
  } catch {
    return false;
  }

  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(provided, "hex");
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, which would itself leak.
  if (providedBuf.length !== expected.length) return false;
  return timingSafeEqual(providedBuf, expected);
}

export function signBody(algo: "sha1" | "sha256", body: Buffer, secret: string): string {
  return `${algo}=${createHmac(algo, secret).update(body).digest("hex")}`;
}
