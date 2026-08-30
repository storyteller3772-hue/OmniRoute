import { open } from "node:fs/promises";
import { callTikTok, TikTokApiError } from "./api.js";
import { contentRange, planChunks, type ChunkPlan } from "./chunks.js";
import { backoffMs, jitter } from "../util/time.js";

export interface CreatorInfo {
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options?: string[];
  max_video_post_duration_sec?: number;
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
}

export interface InitResult {
  publish_id: string;
  upload_url: string;
}

export interface PublishStatus {
  status: string;
  fail_reason?: string;
  publicaly_available_post_id?: string[];
  uploaded_bytes?: number;
}

/**
 * Required before a direct post: it returns the privacy levels this account
 * actually allows and the interaction toggles that are already disabled at the
 * account level. Posting a privacy level the account does not offer is rejected.
 */
export function queryCreatorInfo(accessToken: string): Promise<CreatorInfo> {
  return callTikTok<CreatorInfo>("/v2/post/publish/creator_info/query/", { accessToken });
}

export function initInboxUpload(accessToken: string, plan: ChunkPlan): Promise<InitResult> {
  return callTikTok<InitResult>("/v2/post/publish/inbox/video/init/", {
    accessToken,
    body: {
      source_info: {
        source: "FILE_UPLOAD",
        video_size: plan.videoSize,
        chunk_size: plan.chunkSize,
        total_chunk_count: plan.totalChunkCount,
      },
    },
  });
}

export interface DirectPostInfo {
  title: string;
  privacyLevel: string;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  coverTimestampMs?: number;
}

export function initDirectPost(
  accessToken: string,
  plan: ChunkPlan,
  post: DirectPostInfo
): Promise<InitResult> {
  return callTikTok<InitResult>("/v2/post/publish/video/init/", {
    accessToken,
    body: {
      post_info: {
        title: post.title,
        privacy_level: post.privacyLevel,
        disable_comment: post.disableComment,
        disable_duet: post.disableDuet,
        disable_stitch: post.disableStitch,
        video_cover_timestamp_ms: post.coverTimestampMs ?? 1000,
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: plan.videoSize,
        chunk_size: plan.chunkSize,
        total_chunk_count: plan.totalChunkCount,
      },
    },
  });
}

export function fetchPublishStatus(accessToken: string, publishId: string): Promise<PublishStatus> {
  return callTikTok<PublishStatus>("/v2/post/publish/status/fetch/", {
    accessToken,
    body: { publish_id: publishId },
  });
}

/**
 * PUTs each chunk to the pre-signed upload URL.
 *
 * Chunks are read into memory one at a time - bounded by chunk_size (<= 64 MiB)
 * rather than by file size, so an hour-long master does not blow the heap.
 */
export async function uploadChunks(
  uploadUrl: string,
  filePath: string,
  plan: ChunkPlan,
  opts: { maxAttempts?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const handle = await open(filePath, "r");
  try {
    for (const range of plan.ranges) {
      const buf = Buffer.allocUnsafe(range.length);
      const { bytesRead } = await handle.read(buf, 0, range.length, range.start);
      if (bytesRead !== range.length) {
        throw new Error(
          `short read for chunk ${range.index}: expected ${range.length} bytes, got ${bytesRead}`
        );
      }

      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const res = await fetch(uploadUrl, {
            method: "PUT",
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(range.length),
              "Content-Range": contentRange(range, plan.videoSize),
            },
            body: buf,
          });
          // 201 closes the upload on the final chunk; 206 acknowledges a partial.
          if (res.status === 200 || res.status === 201 || res.status === 206) {
            lastErr = undefined;
            break;
          }
          const detail = (await res.text().catch(() => "")).slice(0, 300);
          const err = new TikTokApiError(
            `chunk ${range.index} upload returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
            "upload_failed",
            undefined,
            res.status
          );
          if (err.isTerminal) throw err;
          lastErr = err;
        } catch (e) {
          if (e instanceof TikTokApiError && e.isTerminal) throw e;
          lastErr = e;
        }
        if (attempt < maxAttempts) {
          await sleep(jitter(backoffMs(attempt, 2_000, 30_000)));
        }
      }
      if (lastErr) throw lastErr;

      opts.onProgress?.(range.index + 1, plan.totalChunkCount);
    }
  } finally {
    await handle.close();
  }
}

export function planFor(videoSize: number, preferredChunkMb: number): ChunkPlan {
  return planChunks(videoSize, preferredChunkMb * 1024 * 1024);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
