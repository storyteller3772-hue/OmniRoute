import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeColor,
  buildLoudnormApplyFilter,
  buildVerticalVideoFilter,
  isMeasurable,
  type LoudnormMeasured,
} from "../src/media/filters.js";

const size = { width: 1080, height: 1920 };

test("blur mode fills the frame with a blurred copy and centres the source", () => {
  const f = buildVerticalVideoFilter({ mode: "blur", ...size });
  assert.match(f, /split=2/);
  assert.match(f, /gblur=sigma=/);
  assert.match(f, /force_original_aspect_ratio=increase/, "background fills");
  assert.match(f, /force_original_aspect_ratio=decrease/, "foreground fits");
  assert.match(f, /overlay=\(W-w\)\/2:\(H-h\)\/2/);
  assert.ok(f.endsWith("[v]"), "graph must end in the [v] label the encoder maps");
});

test("crop mode fills and centre-crops without a blurred backdrop", () => {
  const f = buildVerticalVideoFilter({ mode: "crop", ...size });
  assert.match(f, /crop=1080:1920/);
  assert.doesNotMatch(f, /gblur/);
  assert.ok(f.endsWith("[v]"));
});

test("pad mode letterboxes onto the configured colour", () => {
  const f = buildVerticalVideoFilter({ mode: "pad", ...size, padColor: "white" });
  assert.match(f, /pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2:color=white/);
  assert.ok(f.endsWith("[v]"));
});

test("every mode forces yuv420p, which players and TikTok require", () => {
  for (const mode of ["blur", "crop", "pad"] as const) {
    assert.match(buildVerticalVideoFilter({ mode, ...size }), /format=yuv420p/, mode);
  }
});

test("output dimensions come from config, not hardcoded", () => {
  const f = buildVerticalVideoFilter({ mode: "crop", width: 720, height: 1280 });
  assert.match(f, /720:1280/);
});

test("a colour containing filtergraph syntax is rejected", () => {
  for (const evil of [
    "black,drawtext=text=pwned",
    "red;anullsrc",
    "black[x]",
    "'quoted'",
    "a b",
    "",
    "x".repeat(64),
  ]) {
    assert.throws(() => assertSafeColor(evil), /Unsafe PAD_COLOR/, `should reject ${JSON.stringify(evil)}`);
  }
});

test("ordinary colour values are accepted", () => {
  for (const good of ["black", "white", "#RRGGBB", "#1a2b3c", "0xFF0000", "red@0.5"]) {
    assert.equal(assertSafeColor(good), good);
  }
});

test("pad mode refuses to build a graph from an unsafe colour", () => {
  assert.throws(
    () => buildVerticalVideoFilter({ mode: "pad", ...size, padColor: "black,drawtext=x" }),
    /Unsafe PAD_COLOR/
  );
});

const targets = { i: -14, tp: -1.5, lra: 11 };
const measured: LoudnormMeasured = {
  input_i: "-22.5",
  input_tp: "-3.2",
  input_lra: "9.1",
  input_thresh: "-33.0",
  target_offset: "0.4",
};

test("loudnorm runs linear when measurements are available", () => {
  const f = buildLoudnormApplyFilter(targets, measured);
  assert.match(f, /measured_I=-22\.5/);
  assert.match(f, /linear=true/);
});

test("loudnorm falls back to single-pass when there are no measurements", () => {
  const f = buildLoudnormApplyFilter(targets, null);
  assert.equal(f, "loudnorm=I=-14:TP=-1.5:LRA=11");
  assert.doesNotMatch(f, /measured_/);
});

test("a -inf measurement from silent audio is treated as unusable", () => {
  const silent = { ...measured, input_i: "-inf" };
  assert.equal(isMeasurable(silent), false);
  assert.doesNotMatch(buildLoudnormApplyFilter(targets, silent), /measured_/);
});
