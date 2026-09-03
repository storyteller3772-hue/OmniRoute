import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setEnvValues, updateEnvFile } from "../src/envfile.js";

test("an existing key is replaced in place", () => {
  const out = setEnvValues("A=1\nB=2\nC=3", { B: "changed" });
  assert.equal(out, "A=1\nB=changed\nC=3");
});

test("comments, blank lines and ordering survive untouched", () => {
  const input = "# header\n\nA=1\n# about B\nB=2\n\n# trailing note\n";
  const out = setEnvValues(input, { B: "new" });
  assert.match(out, /# header/);
  assert.match(out, /# about B/);
  assert.match(out, /# trailing note/);
  assert.equal(out.indexOf("A=1") < out.indexOf("B=new"), true, "order must be preserved");
});

test("a key the file does not mention is appended", () => {
  const out = setEnvValues("A=1", { NEW_KEY: "value" });
  assert.match(out, /^A=1$/m);
  assert.match(out, /^NEW_KEY=value$/m);
});

test("a commented-out key is not mistaken for a real one", () => {
  const out = setEnvValues("# SECRET=old\nOTHER=1", { SECRET: "new" });
  assert.match(out, /^# SECRET=old$/m, "the comment must stay a comment");
  assert.match(out, /^SECRET=new$/m, "and the real key is appended");
});

test("values containing = and special characters round-trip", () => {
  const tricky = "abc=def+/g==";
  const out = setEnvValues("K=old", { K: tricky });
  assert.equal(out, `K=${tricky}`);
});

test("only the requested keys change", () => {
  const out = setEnvValues("A=1\nB=2\nC=3", { B: "x" });
  assert.match(out, /^A=1$/m);
  assert.match(out, /^C=3$/m);
});

test("indentation on an existing key is preserved", () => {
  assert.equal(setEnvValues("  A=1", { A: "2" }), "  A=2");
});

test("writing backs up the previous file and locks permissions down", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yt2tt-env-"));
  try {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "TIKTOK_CLIENT_KEY=\nOTHER=keep\n", "utf8");

    await updateEnvFile(envPath, {
      TIKTOK_CLIENT_KEY: "aw-key",
      TIKTOK_CLIENT_SECRET: "sekrit",
    });

    const written = await readFile(envPath, "utf8");
    assert.match(written, /^TIKTOK_CLIENT_KEY=aw-key$/m);
    assert.match(written, /^TIKTOK_CLIENT_SECRET=sekrit$/m);
    assert.match(written, /^OTHER=keep$/m, "unrelated values must survive");

    assert.match(await readFile(`${envPath}.bak`, "utf8"), /TIKTOK_CLIENT_KEY=$/m);

    const mode = (await stat(envPath)).mode & 0o777;
    assert.equal(mode & 0o077, 0, `.env holds a client secret but is mode ${mode.toString(8)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writing to a file that does not exist yet works", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yt2tt-env-new-"));
  try {
    const envPath = join(dir, ".env");
    await updateEnvFile(envPath, { TIKTOK_CLIENT_KEY: "k" });
    assert.match(await readFile(envPath, "utf8"), /^TIKTOK_CLIENT_KEY=k$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
