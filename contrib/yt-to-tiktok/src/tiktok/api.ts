export const TIKTOK_API_BASE = "https://open.tiktokapis.com";
export const TIKTOK_AUTH_BASE = "https://www.tiktok.com";

/**
 * Resolved per call so a test (or an egress proxy) can redirect the API without
 * threading a base URL through every signature. Unset in normal operation.
 */
export function apiBase(): string {
  return process.env.TIKTOK_API_BASE_URL || TIKTOK_API_BASE;
}

export interface TikTokEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string; log_id?: string };
}

export class TikTokApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly logId: string | undefined,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "TikTokApiError";
  }

  /** 4xx that will never succeed on retry. */
  get isTerminal(): boolean {
    if (this.httpStatus === 429) return false;
    if (this.httpStatus >= 500) return false;
    return this.httpStatus >= 400;
  }
}

/**
 * TikTok answers 200 with `error.code = "ok"` on success and a non-ok code on
 * failure, so the HTTP status alone is never sufficient.
 */
export async function callTikTok<T>(
  path: string,
  init: { accessToken: string; body?: unknown; method?: string }
): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: init.method ?? "POST",
    headers: {
      Authorization: `Bearer ${init.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await res.text();
  let parsed: TikTokEnvelope<T>;
  try {
    parsed = text ? (JSON.parse(text) as TikTokEnvelope<T>) : {};
  } catch {
    throw new TikTokApiError(
      `TikTok returned a non-JSON response for ${path}`,
      "invalid_response",
      undefined,
      res.status
    );
  }

  const code = parsed.error?.code ?? (res.ok ? "ok" : "http_error");
  if (code !== "ok") {
    throw new TikTokApiError(
      `TikTok ${path} failed: ${code}${parsed.error?.message ? ` - ${parsed.error.message}` : ""}`,
      code,
      parsed.error?.log_id,
      res.status
    );
  }
  if (!res.ok) {
    throw new TikTokApiError(`TikTok ${path} returned HTTP ${res.status}`, "http_error", undefined, res.status);
  }

  return (parsed.data ?? ({} as T)) as T;
}
