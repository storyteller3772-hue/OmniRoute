/**
 * Chunking rules for TikTok's FILE_UPLOAD source.
 *
 * The constraint that catches people out: `total_chunk_count` is
 * floor(video_size / chunk_size), so the byte ranges do NOT tile evenly - the
 * FINAL chunk carries the remainder on top of its own chunk_size. Sending
 * ceil() chunks, or a short last chunk, is rejected.
 */
export const MIN_CHUNK_BYTES = 5 * 1024 * 1024; // 5 MiB
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024; // 64 MiB
export const MAX_CHUNK_COUNT = 1000;

export interface ChunkRange {
  index: number;
  start: number;
  /** Inclusive, as required by the Content-Range header. */
  end: number;
  length: number;
}

export interface ChunkPlan {
  videoSize: number;
  chunkSize: number;
  totalChunkCount: number;
  ranges: ChunkRange[];
}

export function planChunks(videoSize: number, preferredChunkSize = 10 * 1024 * 1024): ChunkPlan {
  if (!Number.isInteger(videoSize) || videoSize <= 0) {
    throw new Error(`invalid video size: ${videoSize}`);
  }

  // Anything below the minimum chunk size must go up as a single whole-file chunk.
  if (videoSize < MIN_CHUNK_BYTES) {
    return {
      videoSize,
      chunkSize: videoSize,
      totalChunkCount: 1,
      ranges: [{ index: 0, start: 0, end: videoSize - 1, length: videoSize }],
    };
  }

  let chunkSize = clamp(Math.floor(preferredChunkSize), MIN_CHUNK_BYTES, MAX_CHUNK_BYTES);
  // A chunk larger than the file itself would yield a count of 0.
  if (chunkSize > videoSize) chunkSize = videoSize;

  let count = Math.floor(videoSize / chunkSize);

  // Too many chunks: grow them until the count fits.
  if (count > MAX_CHUNK_COUNT) {
    chunkSize = Math.min(MAX_CHUNK_BYTES, Math.ceil(videoSize / MAX_CHUNK_COUNT));
    count = Math.floor(videoSize / chunkSize);
    if (count > MAX_CHUNK_COUNT) {
      throw new Error(
        `video is too large to upload: ${videoSize} bytes exceeds ${MAX_CHUNK_COUNT} chunks of ${MAX_CHUNK_BYTES} bytes`
      );
    }
  }

  const ranges: ChunkRange[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    // The last chunk runs to EOF, absorbing the remainder.
    const end = i === count - 1 ? videoSize - 1 : start + chunkSize - 1;
    ranges.push({ index: i, start, end, length: end - start + 1 });
  }

  return { videoSize, chunkSize, totalChunkCount: count, ranges };
}

export function contentRange(range: ChunkRange, videoSize: number): string {
  return `bytes ${range.start}-${range.end}/${videoSize}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
