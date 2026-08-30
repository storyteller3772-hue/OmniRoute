import { parseIso8601Duration } from "../util/time.js";

const BASE = "https://www.googleapis.com/youtube/v3";

export class YouTubeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string
  ) {
    super(message);
    this.name = "YouTubeApiError";
  }
}

async function get<T>(path: string, params: Record<string, string>, apiKey: string): Promise<T> {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", apiKey);

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();

  if (!res.ok) {
    let reason: string | undefined;
    try {
      reason = (JSON.parse(text) as { error?: { errors?: Array<{ reason?: string }> } }).error
        ?.errors?.[0]?.reason;
    } catch {
      /* body was not the usual error envelope */
    }
    // The URL carries the API key; never echo it back in an error.
    throw new YouTubeApiError(
      `YouTube ${path} failed with HTTP ${res.status}${reason ? ` (${reason})` : ""}`,
      res.status,
      reason
    );
  }
  return JSON.parse(text) as T;
}

export interface ChannelInfo {
  channelId: string;
  title: string;
  uploadsPlaylistId: string;
}

/** Resolves an @handle to its UC channel id and uploads playlist in one call. */
export async function resolveChannel(
  apiKey: string,
  handleOrId: string
): Promise<ChannelInfo | null> {
  const isId = /^UC[A-Za-z0-9_-]{22}$/.test(handleOrId);
  const params: Record<string, string> = { part: "snippet,contentDetails" };
  if (isId) params.id = handleOrId;
  else params.forHandle = handleOrId.startsWith("@") ? handleOrId : `@${handleOrId}`;

  const body = await get<{
    items?: Array<{
      id: string;
      snippet?: { title?: string };
      contentDetails?: { relatedPlaylists?: { uploads?: string } };
    }>;
  }>("channels", params, apiKey);

  const item = body.items?.[0];
  if (!item) return null;
  const uploads = item.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return null;

  return { channelId: item.id, title: item.snippet?.title ?? "", uploadsPlaylistId: uploads };
}

export interface VideoDetails {
  videoId: string;
  channelId: string;
  title: string;
  description: string;
  tags: string[];
  publishedAt: string;
  durationSec: number | null;
  privacyStatus: string;
  /** YouTube marks livestreams and premieres here; they need different handling. */
  liveBroadcastContent: string;
}

export async function getVideoDetails(
  apiKey: string,
  videoId: string
): Promise<VideoDetails | null> {
  const body = await get<{
    items?: Array<{
      id: string;
      snippet?: {
        channelId?: string;
        title?: string;
        description?: string;
        tags?: string[];
        publishedAt?: string;
        liveBroadcastContent?: string;
      };
      contentDetails?: { duration?: string };
      status?: { privacyStatus?: string };
    }>;
  }>("videos", { part: "snippet,contentDetails,status", id: videoId }, apiKey);

  const item = body.items?.[0];
  if (!item) return null;

  return {
    videoId: item.id,
    channelId: item.snippet?.channelId ?? "",
    title: item.snippet?.title ?? "",
    description: item.snippet?.description ?? "",
    tags: item.snippet?.tags ?? [],
    publishedAt: item.snippet?.publishedAt ?? new Date().toISOString(),
    durationSec: item.contentDetails?.duration
      ? parseIso8601Duration(item.contentDetails.duration)
      : null,
    privacyStatus: item.status?.privacyStatus ?? "unknown",
    liveBroadcastContent: item.snippet?.liveBroadcastContent ?? "none",
  };
}

export interface UploadItem {
  videoId: string;
  publishedAt: string;
  title: string;
}

export async function listRecentUploads(
  apiKey: string,
  uploadsPlaylistId: string,
  maxResults = 10
): Promise<UploadItem[]> {
  const body = await get<{
    items?: Array<{
      snippet?: { title?: string; publishedAt?: string; resourceId?: { videoId?: string } };
      contentDetails?: { videoId?: string; videoPublishedAt?: string };
    }>;
  }>(
    "playlistItems",
    {
      part: "snippet,contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults: String(Math.min(50, Math.max(1, maxResults))),
    },
    apiKey
  );

  const out: UploadItem[] = [];
  for (const item of body.items ?? []) {
    const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
    out.push({
      videoId,
      // videoPublishedAt is when the VIDEO went live; snippet.publishedAt is
      // when it was added to the playlist. They differ for scheduled uploads.
      publishedAt:
        item.contentDetails?.videoPublishedAt ??
        item.snippet?.publishedAt ??
        new Date().toISOString(),
      title: item.snippet?.title ?? "",
    });
  }
  return out;
}
