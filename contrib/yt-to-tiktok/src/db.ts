import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * State lives in SQLite because every guarantee this pipeline makes is a
 * durability guarantee: an upload must be processed exactly once even if the
 * hub redelivers the notification, the process restarts mid-encode, or a
 * publish is retried.
 *
 * Uses node:sqlite (built in since Node 22.5) to avoid a native build step.
 */

export type JobState =
  | "pending"
  | "sourcing"
  | "processing"
  | "awaiting_review"
  | "awaiting_handoff"
  | "approved"
  | "publishing"
  | "published"
  | "failed"
  | "rejected"
  | "skipped";

export interface VideoRow {
  video_id: string;
  channel_id: string;
  title: string;
  description: string | null;
  published_at: string;
  duration_sec: number | null;
  privacy_status: string | null;
  state: string;
  created_at: string;
}

export interface JobRow {
  id: number;
  video_id: string;
  clip_index: number;
  clip_start_sec: number | null;
  clip_duration_sec: number | null;
  state: JobState;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  source_path: string | null;
  output_path: string | null;
  caption: string | null;
  publish_id: string | null;
  tiktok_status: string | null;
  created_at: string;
  updated_at: string;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS videos (
     video_id       TEXT PRIMARY KEY,
     channel_id     TEXT NOT NULL,
     title          TEXT NOT NULL,
     description    TEXT,
     published_at   TEXT NOT NULL,
     duration_sec   INTEGER,
     privacy_status TEXT,
     state          TEXT NOT NULL DEFAULT 'discovered',
     created_at     TEXT NOT NULL DEFAULT (datetime('now'))
   );`,
  `CREATE TABLE IF NOT EXISTS jobs (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     video_id          TEXT NOT NULL REFERENCES videos(video_id),
     clip_index        INTEGER NOT NULL DEFAULT 0,
     clip_start_sec    REAL,
     clip_duration_sec REAL,
     state             TEXT NOT NULL DEFAULT 'pending',
     attempts          INTEGER NOT NULL DEFAULT 0,
     next_attempt_at   TEXT,
     last_error        TEXT,
     source_path       TEXT,
     output_path       TEXT,
     caption           TEXT,
     publish_id        TEXT,
     tiktok_status     TEXT,
     created_at        TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (video_id, clip_index)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, next_attempt_at);`,
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
     provider           TEXT PRIMARY KEY,
     access_token       TEXT NOT NULL,
     refresh_token      TEXT,
     expires_at         TEXT,
     refresh_expires_at TEXT,
     open_id            TEXT,
     scope              TEXT,
     updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
   );`,
  `CREATE TABLE IF NOT EXISTS oauth_pending (
     state         TEXT PRIMARY KEY,
     code_verifier TEXT NOT NULL,
     provider      TEXT NOT NULL DEFAULT 'tiktok',
     expires_at    TEXT NOT NULL,
     created_at    TEXT NOT NULL DEFAULT (datetime('now'))
   );`,
  `CREATE TABLE IF NOT EXISTS websub_subscriptions (
     topic            TEXT PRIMARY KEY,
     callback         TEXT NOT NULL,
     state            TEXT NOT NULL DEFAULT 'pending',
     lease_expires_at TEXT,
     last_verified_at TEXT,
     updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
   );`,
];

/**
 * node:sqlite returns loosely-typed `Record<string, SQLOutputValue>` rows. These
 * two helpers put the widening in one place instead of scattering casts, so the
 * row shapes above stay the single description of the schema.
 */
function rows<T>(v: unknown): T[] {
  return v as T[];
}

function row<T>(v: unknown): T | undefined {
  return v as T | undefined;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    // This file holds OAuth access and refresh tokens. Left at the default
    // umask it is world-readable, which on a shared machine hands anyone with
    // a login the ability to post as the operator.
    if (path !== ":memory:") restrictPermissions(path);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("BEGIN");
    try {
      for (const sql of MIGRATIONS) this.db.exec(sql);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------- videos ----------

  /**
   * Records a newly discovered upload. Returns false when the video was already
   * known - this is the idempotency gate that makes hub redeliveries and
   * edit-notifications harmless.
   */
  insertVideoIfNew(v: {
    videoId: string;
    channelId: string;
    title: string;
    publishedAt: string;
    description?: string | null;
    durationSec?: number | null;
    privacyStatus?: string | null;
  }): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO videos
           (video_id, channel_id, title, description, published_at, duration_sec, privacy_status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        v.videoId,
        v.channelId,
        v.title,
        v.description ?? null,
        v.publishedAt,
        v.durationSec ?? null,
        v.privacyStatus ?? null
      );
    return res.changes > 0;
  }

  updateVideoMetadata(
    videoId: string,
    patch: {
      title?: string;
      description?: string | null;
      durationSec?: number | null;
      privacyStatus?: string | null;
      state?: string;
    }
  ): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (patch.title !== undefined) (sets.push("title = ?"), vals.push(patch.title));
    if (patch.description !== undefined)
      (sets.push("description = ?"), vals.push(patch.description));
    if (patch.durationSec !== undefined)
      (sets.push("duration_sec = ?"), vals.push(patch.durationSec));
    if (patch.privacyStatus !== undefined)
      (sets.push("privacy_status = ?"), vals.push(patch.privacyStatus));
    if (patch.state !== undefined) (sets.push("state = ?"), vals.push(patch.state));
    if (!sets.length) return;
    vals.push(videoId);
    this.db.prepare(`UPDATE videos SET ${sets.join(", ")} WHERE video_id = ?`).run(...vals);
  }

  getVideo(videoId: string): VideoRow | undefined {
    return row<VideoRow>(this.db.prepare("SELECT * FROM videos WHERE video_id = ?").get(videoId));
  }

  hasVideo(videoId: string): boolean {
    return this.getVideo(videoId) !== undefined;
  }

  // ---------- jobs ----------

  createJob(videoId: string, clipIndex = 0, clip?: { start: number; duration: number }): number {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs (video_id, clip_index, clip_start_sec, clip_duration_sec)
         VALUES (?, ?, ?, ?)`
      )
      .run(videoId, clipIndex, clip?.start ?? null, clip?.duration ?? null);
    if (res.changes === 0) {
      const existing = this.db
        .prepare("SELECT id FROM jobs WHERE video_id = ? AND clip_index = ?")
        .get(videoId, clipIndex) as { id: number } | undefined;
      return existing?.id ?? -1;
    }
    return Number(res.lastInsertRowid);
  }

  getJob(id: number): JobRow | undefined {
    return row<JobRow>(this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id));
  }

  /** Jobs that are due to run now, oldest first. */
  claimableJobs(limit = 5): JobRow[] {
    return rows<JobRow>(
      this.db
        .prepare(
          `SELECT * FROM jobs
            WHERE state IN ('pending','sourcing','processing','approved','publishing')
              AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
            ORDER BY id ASC
            LIMIT ?`
        )
        .all(limit)
    );
  }

  listJobs(state?: JobState, limit = 50): JobRow[] {
    return state
      ? rows<JobRow>(
          this.db
            .prepare("SELECT * FROM jobs WHERE state = ? ORDER BY id DESC LIMIT ?")
            .all(state, limit)
        )
      : rows<JobRow>(this.db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit));
  }

  updateJob(id: number, patch: Partial<Omit<JobRow, "id" | "video_id" | "created_at">>): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      vals.push(v as string | number | null);
    }
    if (!sets.length) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  // ---------- oauth ----------

  saveTokens(
    provider: string,
    t: {
      accessToken: string;
      refreshToken?: string | null;
      expiresAt?: string | null;
      refreshExpiresAt?: string | null;
      openId?: string | null;
      scope?: string | null;
    }
  ): void {
    this.db
      .prepare(
        `INSERT INTO oauth_tokens
           (provider, access_token, refresh_token, expires_at, refresh_expires_at, open_id, scope, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(provider) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
           expires_at = excluded.expires_at,
           refresh_expires_at = COALESCE(excluded.refresh_expires_at, oauth_tokens.refresh_expires_at),
           open_id = COALESCE(excluded.open_id, oauth_tokens.open_id),
           scope = COALESCE(excluded.scope, oauth_tokens.scope),
           updated_at = datetime('now')`
      )
      .run(
        provider,
        t.accessToken,
        t.refreshToken ?? null,
        t.expiresAt ?? null,
        t.refreshExpiresAt ?? null,
        t.openId ?? null,
        t.scope ?? null
      );
  }

  getTokens(provider: string): TokenRow | undefined {
    return row<TokenRow>(
      this.db.prepare("SELECT * FROM oauth_tokens WHERE provider = ?").get(provider)
    );
  }

  // ---------- pending oauth logins ----------

  /**
   * Records a login the operator actually started. The callback will only
   * accept a `state` that appears here, which is what stops anyone who can
   * reach the public callback from having their own authorisation code
   * exchanged and their account stored in place of the operator's.
   */
  createPendingLogin(state: string, codeVerifier: string, ttlMs: number, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO oauth_pending (state, code_verifier, expires_at)
         VALUES (?, ?, ?)`
      )
      .run(state, codeVerifier, new Date(now + ttlMs).toISOString());
  }

  /**
   * Single use: the row is deleted whether or not it had expired, so a state
   * cannot be replayed even if the exchange that follows fails.
   */
  consumePendingLogin(state: string, now = Date.now()): { codeVerifier: string } | null {
    const found = row<{ state: string; code_verifier: string; expires_at: string }>(
      this.db.prepare("SELECT * FROM oauth_pending WHERE state = ?").get(state)
    );
    this.db.prepare("DELETE FROM oauth_pending WHERE state = ?").run(state);
    if (!found) return null;
    if (Date.parse(found.expires_at) <= now) return null;
    return { codeVerifier: found.code_verifier };
  }

  /** Housekeeping so abandoned logins do not accumulate. */
  purgeExpiredLogins(now = Date.now()): number {
    return Number(
      this.db
        .prepare("DELETE FROM oauth_pending WHERE expires_at <= ?")
        .run(new Date(now).toISOString()).changes
    );
  }

  // ---------- websub ----------

  upsertSubscription(
    topic: string,
    callback: string,
    patch: { state?: string; leaseExpiresAt?: string | null; verifiedNow?: boolean }
  ): void {
    this.db
      .prepare(
        `INSERT INTO websub_subscriptions (topic, callback, state, lease_expires_at, last_verified_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(topic) DO UPDATE SET
           callback = excluded.callback,
           state = COALESCE(excluded.state, websub_subscriptions.state),
           lease_expires_at = COALESCE(excluded.lease_expires_at, websub_subscriptions.lease_expires_at),
           last_verified_at = COALESCE(excluded.last_verified_at, websub_subscriptions.last_verified_at),
           updated_at = datetime('now')`
      )
      .run(
        topic,
        callback,
        patch.state ?? "pending",
        patch.leaseExpiresAt ?? null,
        patch.verifiedNow ? new Date().toISOString() : null
      );
  }

  getSubscription(topic: string): SubscriptionRow | undefined {
    return row<SubscriptionRow>(
      this.db.prepare("SELECT * FROM websub_subscriptions WHERE topic = ?").get(topic)
    );
  }
}

export interface TokenRow {
  provider: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  refresh_expires_at: string | null;
  open_id: string | null;
  scope: string | null;
}

export interface SubscriptionRow {
  topic: string;
  callback: string;
  state: string;
  lease_expires_at: string | null;
  last_verified_at: string | null;
}

/**
 * Tightens the database and its WAL sidecars to owner-only. Best effort: on
 * filesystems without POSIX modes this is a no-op rather than a failure.
 */
function restrictPermissions(path: string): void {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(f, 0o600);
    } catch {
      /* not yet created, or a filesystem without modes */
    }
  }
}

export function openStore(dataDir: string): Store {
  return new Store(join(dataDir, "yt2tt.sqlite"));
}
