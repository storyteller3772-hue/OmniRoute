import { createHash, randomBytes } from "node:crypto";
import { TIKTOK_API_BASE, TIKTOK_AUTH_BASE } from "./api.js";
import type { Store } from "../db.js";

export const PROVIDER = "tiktok";

/** `video.upload` puts the file in your drafts; `video.publish` posts it directly. */
export const SCOPE_INBOX = ["user.info.basic", "video.upload"];
export const SCOPE_DIRECT = ["user.info.basic", "video.publish"];

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  open_id?: string;
  scope?: string;
  token_type?: string;
}

export function generateCodeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

export function codeChallengeFrom(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildAuthorizeUrl(o: {
  clientKey: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge?: string;
}): string {
  const url = new URL("/v2/auth/authorize/", TIKTOK_AUTH_BASE);
  url.searchParams.set("client_key", o.clientKey);
  url.searchParams.set("scope", o.scopes.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", o.redirectUri);
  url.searchParams.set("state", o.state);
  if (o.codeChallenge) {
    url.searchParams.set("code_challenge", o.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/**
 * The token endpoint answers with a flat body, not the `{data, error}` envelope
 * the rest of the API uses, so it cannot share `callTikTok`.
 */
async function postToken(form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${TIKTOK_API_BASE}/v2/oauth/token/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: new URLSearchParams(form).toString(),
  });

  const text = await res.text();
  let body: TokenResponse & { error?: string; error_description?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`TikTok token endpoint returned a non-JSON response (HTTP ${res.status})`);
  }

  if (body.error || !body.access_token) {
    // error_description can echo request parameters; the grant type is the only
    // part safe to surface.
    throw new Error(
      `TikTok token request failed (${body.error ?? `HTTP ${res.status}`}) for grant_type=${form.grant_type}`
    );
  }
  return body;
}

export function exchangeCode(o: {
  clientKey: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}): Promise<TokenResponse> {
  const form: Record<string, string> = {
    client_key: o.clientKey,
    client_secret: o.clientSecret,
    code: o.code,
    grant_type: "authorization_code",
    redirect_uri: o.redirectUri,
  };
  if (o.codeVerifier) form.code_verifier = o.codeVerifier;
  return postToken(form);
}

export function refreshAccessToken(o: {
  clientKey: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  return postToken({
    client_key: o.clientKey,
    client_secret: o.clientSecret,
    grant_type: "refresh_token",
    refresh_token: o.refreshToken,
  });
}

export function persistTokens(store: Store, t: TokenResponse, now = Date.now()): void {
  store.saveTokens(PROVIDER, {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: new Date(now + t.expires_in * 1000).toISOString(),
    refreshExpiresAt: t.refresh_expires_in
      ? new Date(now + t.refresh_expires_in * 1000).toISOString()
      : null,
    openId: t.open_id ?? null,
    scope: t.scope ?? null,
  });
}

/** Refresh this far ahead of expiry so a long upload cannot straddle it. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

export function needsRefresh(expiresAt: string | null, now = Date.now()): boolean {
  if (!expiresAt) return true;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return true;
  return t - now <= REFRESH_SKEW_MS;
}

/**
 * Returns a usable access token, refreshing it first when it is at or near
 * expiry. Throws with an actionable message when re-authorisation is required.
 */
export async function getAccessToken(
  store: Store,
  creds: { clientKey: string; clientSecret: string },
  now = Date.now()
): Promise<string> {
  const row = store.getTokens(PROVIDER);
  if (!row) {
    throw new Error("No TikTok tokens stored. Run: npm run cli -- tiktok-login");
  }
  if (!needsRefresh(row.expires_at, now)) return row.access_token;

  if (!row.refresh_token) {
    throw new Error("TikTok access token expired and no refresh token is stored. Re-run tiktok-login.");
  }
  if (row.refresh_expires_at && Date.parse(row.refresh_expires_at) <= now) {
    throw new Error("TikTok refresh token has expired. Re-run: npm run cli -- tiktok-login");
  }

  const refreshed = await refreshAccessToken({
    clientKey: creds.clientKey,
    clientSecret: creds.clientSecret,
    refreshToken: row.refresh_token,
  });
  persistTokens(store, refreshed, now);
  return refreshed.access_token;
}
