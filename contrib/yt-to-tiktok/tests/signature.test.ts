import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { signBody, verifyHubSignature } from "../src/util/signature.js";

const SECRET = "a-sufficiently-long-shared-secret";
const BODY = Buffer.from("<feed><entry>hello</entry></feed>", "utf8");

test("accepts a correct sha1 signature (the algorithm YouTube's hub uses)", () => {
  assert.equal(verifyHubSignature(signBody("sha1", BODY, SECRET), BODY, SECRET), true);
});

test("accepts a correct sha256 signature", () => {
  assert.equal(verifyHubSignature(signBody("sha256", BODY, SECRET), BODY, SECRET), true);
});

test("rejects a signature made with a different secret", () => {
  const forged = signBody("sha1", BODY, "the-wrong-secret-entirely");
  assert.equal(verifyHubSignature(forged, BODY, SECRET), false);
});

test("rejects a valid signature over a DIFFERENT body", () => {
  const sig = signBody("sha1", BODY, SECRET);
  assert.equal(verifyHubSignature(sig, Buffer.from("tampered"), SECRET), false);
});

test("rejects a body altered by a single byte", () => {
  const sig = signBody("sha256", BODY, SECRET);
  const tampered = Buffer.from(BODY);
  tampered[3] = tampered[3]! ^ 0x01;
  assert.equal(verifyHubSignature(sig, tampered, SECRET), false);
});

test("rejects malformed headers rather than throwing", () => {
  for (const header of [
    undefined,
    "",
    "sha1",
    "=abcdef",
    "sha1=",
    "sha1=nothex",
    "sha1=zzzz",
    "md5=00112233445566778899aabbccddeeff",
    "sha1=deadbeef",
  ]) {
    assert.equal(verifyHubSignature(header, BODY, SECRET), false, `header: ${String(header)}`);
  }
});

test("rejects an unsupported digest algorithm even when the digest itself is right", () => {
  const md5 = `md5=${createHmac("md5", SECRET).update(BODY).digest("hex")}`;
  assert.equal(verifyHubSignature(md5, BODY, SECRET), false);
});

test("rejects when no secret is configured", () => {
  assert.equal(verifyHubSignature(signBody("sha1", BODY, SECRET), BODY, ""), false);
});

test("a truncated digest of the correct prefix is rejected", () => {
  const sig = signBody("sha1", BODY, SECRET);
  assert.equal(verifyHubSignature(sig.slice(0, sig.length - 2), BODY, SECRET), false);
});

test("signature comparison is case-insensitive on the hex digest", () => {
  const sig = signBody("sha1", BODY, SECRET);
  assert.equal(verifyHubSignature(sig.toUpperCase().replace("SHA1", "sha1"), BODY, SECRET), true);
});
