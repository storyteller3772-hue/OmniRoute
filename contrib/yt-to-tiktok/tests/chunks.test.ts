import test from "node:test";
import assert from "node:assert/strict";
import {
  contentRange,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_COUNT,
  MIN_CHUNK_BYTES,
  planChunks,
} from "../src/tiktok/chunks.js";

const MB = 1024 * 1024;

/** Every plan must cover the file exactly once, with no gap and no overlap. */
function assertCoversExactly(plan: ReturnType<typeof planChunks>): void {
  assert.equal(plan.ranges.length, plan.totalChunkCount, "range count must equal total_chunk_count");
  assert.equal(plan.ranges[0]!.start, 0, "first chunk must start at byte 0");
  assert.equal(
    plan.ranges.at(-1)!.end,
    plan.videoSize - 1,
    "last chunk must end at the final byte"
  );
  for (let i = 1; i < plan.ranges.length; i++) {
    assert.equal(
      plan.ranges[i]!.start,
      plan.ranges[i - 1]!.end + 1,
      `chunk ${i} must start immediately after chunk ${i - 1}`
    );
  }
  const total = plan.ranges.reduce((n, r) => n + r.length, 0);
  assert.equal(total, plan.videoSize, "chunk lengths must sum to the file size");
}

test("a file below the 5 MiB minimum uploads as one whole-file chunk", () => {
  const plan = planChunks(2 * MB);
  assert.equal(plan.totalChunkCount, 1);
  assert.equal(plan.chunkSize, 2 * MB);
  assertCoversExactly(plan);
});

test("a file exactly at the minimum is still a single chunk", () => {
  const plan = planChunks(MIN_CHUNK_BYTES);
  assert.equal(plan.totalChunkCount, 1);
  assertCoversExactly(plan);
});

test("an exact multiple of the chunk size tiles evenly", () => {
  const plan = planChunks(50 * MB, 10 * MB);
  assert.equal(plan.chunkSize, 10 * MB);
  assert.equal(plan.totalChunkCount, 5);
  assert.ok(
    plan.ranges.every((r) => r.length === 10 * MB),
    "every chunk should be exactly the chunk size"
  );
  assertCoversExactly(plan);
});

test("the remainder rides along in the FINAL chunk, not a short extra chunk", () => {
  // 55 MiB / 10 MiB = 5 chunks, with the trailing 5 MiB absorbed by the last.
  const plan = planChunks(55 * MB, 10 * MB);
  assert.equal(plan.totalChunkCount, 5, "must be floor(), never ceil()");
  assert.equal(plan.ranges.at(-1)!.length, 15 * MB, "final chunk carries chunk_size + remainder");
  assertCoversExactly(plan);
});

test("a preferred chunk size below the floor is raised to 5 MiB", () => {
  const plan = planChunks(100 * MB, 1 * MB);
  assert.equal(plan.chunkSize, MIN_CHUNK_BYTES);
  assertCoversExactly(plan);
});

test("a preferred chunk size above the ceiling is capped at 64 MiB", () => {
  const plan = planChunks(500 * MB, 200 * MB);
  assert.equal(plan.chunkSize, MAX_CHUNK_BYTES);
  assertCoversExactly(plan);
});

test("a chunk size larger than the file collapses to a single chunk", () => {
  const plan = planChunks(7 * MB, 64 * MB);
  assert.equal(plan.totalChunkCount, 1);
  assert.equal(plan.chunkSize, 7 * MB);
  assertCoversExactly(plan);
});

test("chunk count is grown past the 1000-chunk limit rather than overflowing it", () => {
  // 8 GiB at the 5 MiB floor would be 1638 chunks.
  const plan = planChunks(8 * 1024 * MB, MIN_CHUNK_BYTES);
  assert.ok(plan.totalChunkCount <= MAX_CHUNK_COUNT, `got ${plan.totalChunkCount} chunks`);
  assert.ok(plan.chunkSize > MIN_CHUNK_BYTES, "chunk size should have been increased");
  assertCoversExactly(plan);
});

test("a file too large for 1000 x 64 MiB is rejected rather than silently truncated", () => {
  assert.throws(() => planChunks(70 * 1024 * MB), /too large/);
});

test("invalid sizes are rejected", () => {
  assert.throws(() => planChunks(0));
  assert.throws(() => planChunks(-1));
  assert.throws(() => planChunks(1.5));
});

test("Content-Range uses inclusive byte offsets against the total size", () => {
  const plan = planChunks(55 * MB, 10 * MB);
  assert.equal(contentRange(plan.ranges[0]!, plan.videoSize), `bytes 0-${10 * MB - 1}/${55 * MB}`);
  assert.equal(
    contentRange(plan.ranges.at(-1)!, plan.videoSize),
    `bytes ${40 * MB}-${55 * MB - 1}/${55 * MB}`
  );
});

test("assorted odd sizes all produce a gapless plan", () => {
  for (const size of [5 * MB + 1, 12345678, 99 * MB + 7, 640 * MB - 3, 1023 * MB]) {
    assertCoversExactly(planChunks(size, 10 * MB));
  }
});
