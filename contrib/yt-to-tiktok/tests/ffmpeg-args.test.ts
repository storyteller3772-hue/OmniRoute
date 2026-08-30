import test from "node:test";
import assert from "node:assert/strict";
import { buildTranscodeArgs, parseLoudnormJson, type TranscodeOptions } from "../src/media/ffmpeg.js";

const base: TranscodeOptions = {
  input: "/masters/dQw4w9WgXcQ.mp4",
  output: "/work/dQw4w9WgXcQ.0.mp4",
  mode: "blur",
  width: 1080,
  height: 1920,
  fps: 30,
  crf: 20,
  preset: "medium",
  audioBitrate: "128k",
  padColor: "black",
  hasAudio: true,
};

/** Reads the value that follows a flag, the way ffmpeg parses argv. */
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test("input and output land in the right argv positions", () => {
  const args = buildTranscodeArgs(base);
  assert.equal(valueAfter(args, "-i"), base.input);
  assert.equal(args.at(-1), base.output);
});

test("encoder settings come from options, not hardcoded values", () => {
  const args = buildTranscodeArgs({ ...base, crf: 23, preset: "veryfast", fps: 24 });
  assert.equal(valueAfter(args, "-crf"), "23");
  assert.equal(valueAfter(args, "-preset"), "veryfast");
  assert.equal(valueAfter(args, "-r"), "24");
});

test("faststart is set so the file starts playing before it finishes downloading", () => {
  assert.equal(valueAfter(buildTranscodeArgs(base), "-movflags"), "+faststart");
});

test("the video graph is mapped from the [v] label", () => {
  const args = buildTranscodeArgs(base);
  assert.ok(args.includes("-map"));
  assert.ok(args.includes("[v]"));
});

test("with audio and loudness the audio graph is built and mapped from [a]", () => {
  const args = buildTranscodeArgs({
    ...base,
    loudness: { targets: { i: -14, tp: -1.5, lra: 11 }, measured: null },
  });
  const graph = valueAfter(args, "-filter_complex")!;
  assert.match(graph, /\[0:a\]loudnorm=.*\[a\]/);
  assert.ok(args.includes("[a]"));
  assert.equal(valueAfter(args, "-c:a"), "aac");
});

test("with audio but no loudness the original audio stream is mapped directly", () => {
  const args = buildTranscodeArgs({ ...base, loudness: null });
  assert.ok(args.includes("0:a:0"));
  const graph = valueAfter(args, "-filter_complex")!;
  assert.doesNotMatch(graph, /loudnorm/);
});

test("a silent source is encoded with -an and no audio codec flags", () => {
  const args = buildTranscodeArgs({ ...base, hasAudio: false });
  assert.ok(args.includes("-an"));
  assert.ok(!args.includes("-c:a"));
  assert.doesNotMatch(valueAfter(args, "-filter_complex")!, /\[0:a\]/);
});

test("a clip seeks before -i and bounds duration after it", () => {
  const args = buildTranscodeArgs({ ...base, clip: { startSec: 90, durationSec: 60 } });
  const ss = args.indexOf("-ss");
  const i = args.indexOf("-i");
  const t = args.indexOf("-t");
  assert.ok(ss !== -1 && ss < i, "-ss must precede -i for a fast seek");
  assert.ok(t > i, "-t must follow -i so it bounds output duration");
  assert.equal(args[ss + 1], "90");
  assert.equal(args[t + 1], "60");
});

test("a full-length encode carries no seek flags at all", () => {
  const args = buildTranscodeArgs(base);
  assert.ok(!args.includes("-ss"));
  assert.ok(!args.includes("-t"));
});

test("every argument is a separate argv entry, so no value can become shell syntax", () => {
  const args = buildTranscodeArgs({
    ...base,
    input: "/masters/my video; rm -rf /.mp4",
  });
  assert.ok(
    args.includes("/masters/my video; rm -rf /.mp4"),
    "the path must survive intact as one argv element"
  );
  assert.ok(
    args.every((a) => typeof a === "string"),
    "argv must be a flat string array, never a joined command line"
  );
});

test("parses the loudnorm JSON block out of ffmpeg's stderr noise", () => {
  const stderr = `frame= 100 fps=25 q=-1.0 size=1000kB
[Parsed_loudnorm_0 @ 0x55] 
{
  "input_i" : "-22.50",
  "input_tp" : "-3.20",
  "input_lra" : "9.10",
  "input_thresh" : "-33.00",
  "output_i" : "-14.00",
  "target_offset" : "0.40"
}`;
  const parsed = parseLoudnormJson(stderr);
  assert.equal(parsed?.input_i, "-22.50");
  assert.equal(parsed?.target_offset, "0.40");
});

test("returns null when stderr carries no usable JSON", () => {
  assert.equal(parseLoudnormJson("no json here"), null);
  assert.equal(parseLoudnormJson('{"input_i": "-22"}'), null, "an incomplete block is unusable");
  assert.equal(parseLoudnormJson("{not json}"), null);
  assert.equal(parseLoudnormJson(""), null);
});
