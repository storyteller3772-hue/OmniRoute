import test from "node:test";
import assert from "node:assert/strict";
import { planClips } from "../src/media/clip.js";

const base = { thresholdSec: 180, targetSec: 60, maxCount: 3 };

test("a short video is posted whole as a single clip", () => {
  const clips = planClips({ ...base, durationSec: 45 });
  assert.deepEqual(clips, [{ index: 0, startSec: 0, durationSec: 45 }]);
});

test("a video exactly at the threshold is still posted whole", () => {
  const clips = planClips({ ...base, durationSec: 180 });
  assert.equal(clips.length, 1);
  assert.equal(clips[0]!.durationSec, 180);
});

test("a long video is split into sequential, non-overlapping segments", () => {
  const clips = planClips({ ...base, durationSec: 600 });
  assert.equal(clips.length, 3, "capped by maxCount");
  assert.deepEqual(
    clips.map((c) => [c.startSec, c.durationSec]),
    [
      [0, 60],
      [60, 60],
      [120, 60],
    ]
  );
});

test("the number of clips is capped by what the runtime actually allows", () => {
  const clips = planClips({ ...base, durationSec: 200, maxCount: 10 });
  assert.equal(clips.length, 3, "200s of usable footage fits three 60s clips");
});

test("head and tail trims shift the window and shrink the usable range", () => {
  const clips = planClips({ ...base, durationSec: 600, headTrimSec: 30, tailTrimSec: 30 });
  assert.equal(clips[0]!.startSec, 30, "first clip starts after the intro");
  assert.equal(clips.length, 3);
  const last = clips.at(-1)!;
  assert.ok(last.startSec + last.durationSec <= 600 - 30, "must not run into the trimmed outro");
});

test("clip indices are contiguous from zero", () => {
  const clips = planClips({ ...base, durationSec: 900, maxCount: 5 });
  assert.deepEqual(
    clips.map((c) => c.index),
    [0, 1, 2, 3, 4]
  );
});

test("trims that swallow the video fall back to one clip instead of dropping it", () => {
  const clips = planClips({ ...base, durationSec: 240, headTrimSec: 200, tailTrimSec: 200 });
  assert.equal(clips.length, 1);
  assert.ok(clips[0]!.durationSec > 0);
});

test("a zero or invalid duration produces no clips", () => {
  assert.deepEqual(planClips({ ...base, durationSec: 0 }), []);
  assert.deepEqual(planClips({ ...base, durationSec: -10 }), []);
  assert.deepEqual(planClips({ ...base, durationSec: Number.NaN }), []);
});

test("segments never overlap", () => {
  const clips = planClips({ ...base, durationSec: 1200, maxCount: 8, targetSec: 45 });
  for (let i = 1; i < clips.length; i++) {
    const prevEnd = clips[i - 1]!.startSec + clips[i - 1]!.durationSec;
    assert.ok(clips[i]!.startSec >= prevEnd, `clip ${i} overlaps its predecessor`);
  }
});
