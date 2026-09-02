import test from "node:test";
import assert from "node:assert/strict";
import {
  aspectMatches,
  buildAudioOnlyArgs,
  buildCopyArgs,
  decideEncodePlan,
  type PlanTarget,
  type SourceFacts,
} from "../src/media/plan.js";

const vertical: SourceFacts = {
  width: 1080,
  height: 1920,
  fps: 30,
  hasAudio: true,
  videoCodec: "h264",
  audioCodec: "aac",
};

const target: PlanTarget = {
  width: 1080,
  height: 1920,
  verticalMode: "auto",
  autoReframeMode: "blur",
  loudnessEnabled: false,
};

test("an already-vertical h264/aac source is copied, not re-encoded", () => {
  const plan = decideEncodePlan(vertical, target);
  assert.equal(plan.kind, "copy");
  assert.match(plan.reason, /already 1080x1920/);
});

test("a 16:9 source is reframed with the configured auto strategy", () => {
  const plan = decideEncodePlan({ ...vertical, width: 1920, height: 1080 }, target);
  assert.equal(plan.kind, "reframe");
  assert.equal(plan.kind === "reframe" && plan.mode, "blur");
  assert.match(plan.reason, /not 1080:1920/);
});

test("auto honours a different fallback strategy", () => {
  const plan = decideEncodePlan(
    { ...vertical, width: 1920, height: 1080 },
    { ...target, autoReframeMode: "crop" }
  );
  assert.equal(plan.kind === "reframe" && plan.mode, "crop");
});

test("an explicit framing mode always reframes, even on vertical input", () => {
  for (const mode of ["blur", "crop", "pad"] as const) {
    const plan = decideEncodePlan(vertical, { ...target, verticalMode: mode });
    assert.equal(plan.kind, "reframe", mode);
    assert.equal(plan.kind === "reframe" && plan.mode, mode);
    assert.match(plan.reason, new RegExp(`VERTICAL_MODE=${mode}`));
  }
});

test('"none" never reframes, even on a 16:9 source', () => {
  const plan = decideEncodePlan(
    { ...vertical, width: 1920, height: 1080 },
    { ...target, verticalMode: "none" }
  );
  assert.equal(plan.kind, "copy");
});

test("a vertical source at a different resolution is still copied, not upscaled", () => {
  // 720x1280 is 9:16 and above the floor. Upscaling adds no information.
  const plan = decideEncodePlan({ ...vertical, width: 720, height: 1280 }, target);
  assert.equal(plan.kind, "copy");
});

test("loudness normalisation re-encodes audio but leaves the video stream alone", () => {
  const plan = decideEncodePlan(vertical, { ...target, loudnessEnabled: true });
  assert.equal(plan.kind, "audio-only");
  assert.match(plan.reason, /loudness/);
});

test("a silent vertical source is copied even with loudness enabled", () => {
  const plan = decideEncodePlan(
    { ...vertical, hasAudio: false, audioCodec: "" },
    { ...target, loudnessEnabled: true }
  );
  assert.equal(plan.kind, "copy");
});

test("a non-AAC audio track is re-encoded without touching the video", () => {
  const plan = decideEncodePlan({ ...vertical, audioCodec: "opus" }, target);
  assert.equal(plan.kind, "audio-only");
  assert.match(plan.reason, /audio codec opus/);
});

test("a non-H.264 video stream forces a full re-encode", () => {
  for (const codec of ["hevc", "vp9", "av1", ""]) {
    const plan = decideEncodePlan({ ...vertical, videoCodec: codec }, target);
    assert.equal(plan.kind, "reframe", codec);
    assert.match(plan.reason, /video codec/);
  }
});

test("clipping forces a re-encode, because a stream copy cuts at keyframes", () => {
  const plan = decideEncodePlan(vertical, {
    ...target,
    clip: { startSec: 30, durationSec: 15 },
  });
  assert.equal(plan.kind, "reframe");
  assert.match(plan.reason, /frame-accurate/);
});

test("a frame rate outside 23-60 forces a re-encode", () => {
  assert.equal(decideEncodePlan({ ...vertical, fps: 15 }, target).kind, "reframe");
  assert.equal(decideEncodePlan({ ...vertical, fps: 120 }, target).kind, "reframe");
  assert.equal(decideEncodePlan({ ...vertical, fps: Number.NaN }, target).kind, "reframe");
  assert.equal(decideEncodePlan({ ...vertical, fps: 60 }, target).kind, "copy");
  assert.equal(decideEncodePlan({ ...vertical, fps: 23 }, target).kind, "copy");
});

test("a frame below 360px forces a re-encode rather than shipping a reject", () => {
  const plan = decideEncodePlan({ ...vertical, width: 180, height: 320 }, target);
  assert.equal(plan.kind, "reframe");
  assert.match(plan.reason, /below 360px/);
});

test("every failing condition is named, not just the first", () => {
  const plan = decideEncodePlan(
    { ...vertical, videoCodec: "vp9", fps: 5 },
    { ...target, clip: { startSec: 0, durationSec: 5 } }
  );
  assert.match(plan.reason, /frame-accurate/);
  assert.match(plan.reason, /video codec vp9/);
  assert.match(plan.reason, /frame rate/);
});

test("aspect comparison tolerates rounding, rejects real differences", () => {
  assert.equal(aspectMatches({ ...vertical, width: 1080, height: 1920 }, target), true);
  assert.equal(aspectMatches({ ...vertical, width: 1079, height: 1920 }, target), true);
  assert.equal(aspectMatches({ ...vertical, width: 1920, height: 1080 }, target), false);
  assert.equal(aspectMatches({ ...vertical, width: 1080, height: 1350 }, target), false, "4:5");
  assert.equal(aspectMatches({ ...vertical, width: 0, height: 0 }, target), false);
});

test("the copy command decodes nothing and stays streamable", () => {
  const args = buildCopyArgs("/in.mp4", "/out.mp4");
  assert.ok(args.includes("-c"));
  assert.ok(args.includes("copy"));
  assert.equal(args[args.indexOf("-movflags") + 1], "+faststart");
  assert.equal(args.at(-1), "/out.mp4");
  assert.ok(!args.includes("-filter_complex"), "a copy must not build a filtergraph");
  assert.ok(!args.includes("libx264"));
});

test("the audio-only command copies video and applies the loudness filter", () => {
  const args = buildAudioOnlyArgs("/in.mp4", "/out.mp4", {
    audioFilter: "loudnorm=I=-14",
    audioBitrate: "128k",
  });
  assert.equal(args[args.indexOf("-c:v") + 1], "copy", "video must not be re-encoded");
  assert.equal(args[args.indexOf("-af") + 1], "loudnorm=I=-14");
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
});

test("the audio-only command omits the filter when loudness is off", () => {
  const args = buildAudioOnlyArgs("/in.mp4", "/out.mp4", { audioBitrate: "128k" });
  assert.ok(!args.includes("-af"));
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
});
