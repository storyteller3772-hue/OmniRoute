# yt-to-tiktok

Auto-repurpose **your own** YouTube uploads to **your own** TikTok account.

When you publish to YouTube, this picks it up within seconds, reformats it to
9:16 with FFmpeg, and pushes it to TikTok through the official Content Posting
API — with a review step in front so nothing posts without your say-so.

Standalone project. It has its own `package.json` and does not import from
OmniRoute; it lives here only for convenience.

---

## Scope

This tool is built for a creator repurposing content they own. Two consequences
shape the whole design:

- **It never downloads from YouTube.** It works from your master files. Your
  master is higher quality than anything re-fetched from a public page, and the
  fetch step is the part that makes this class of tool useful for content theft.
  If you need automation there, `SOURCE_MODE=command` runs a command you supply.
- **It uses official, authenticated APIs.** YouTube Data API v3, the WebSub hub
  YouTube publishes, and TikTok's Content Posting API with your OAuth grant.
  Nothing is reverse-engineered, and there is no logic anywhere in here for
  evading duplicate-content or Content-ID detection. Micro-edits marketed as
  "detection bypass" — 1% contrast shifts, mirroring, pitch drift — are absent
  by design; they degrade your own video and exist only to defeat systems that
  protect creators.

## What it actually does

```
YouTube upload
  │
  ├─ WebSub push (seconds)   ─┐
  └─ API poll (safety net)   ─┴─→ ingest ─→ resolve master ─→ FFmpeg ─→ REVIEW ─→ TikTok
```

1. **Trigger.** A WebSub/PubSubHubbub subscription to your channel's Atom feed.
   YouTube POSTs the moment a video goes public. A polling loop runs alongside it
   because leases lapse and callbacks miss.
2. **Ingest.** Fetches metadata, drops anything that isn't a fresh public upload
   from your channel, and creates one job per clip.
3. **Source.** Finds your master file on disk.
4. **Encode.** 9:16 conversion (blurred fill, centre-crop, or letterbox), EBU
   R128 two-pass loudness normalisation, H.264/AAC with `+faststart`. Long videos
   are segmented into clips.
5. **Review.** The job stops. You approve it in the web UI or the CLI.
6. **Publish.** Chunked upload to TikTok, then status polling until it lands.

## Requirements

- Node.js ≥ 22.5 (uses the built-in `node:sqlite`, so there is no native build step)
- FFmpeg and FFprobe on `PATH`
- A YouTube Data API v3 key
- A TikTok developer app with the Content Posting API product enabled
- A public HTTPS URL for the WebSub callback (Cloudflare Tunnel, ngrok, or a
  reverse proxy). Without one it falls back to polling.

## Setup

```bash
npm install
cp .env.example .env
```

**1. Find your channel id**

```bash
npm run cli -- resolve-channel @yellowdonutt
```

Put the `UC…` value in `YOUTUBE_CHANNEL_ID`. (You can also read it from the
channel page source: search for `"externalId":"UC`.)

**2. Generate the WebSub secret**

```bash
openssl rand -hex 32   # -> WEBSUB_SECRET
```

**3. Point `PUBLIC_URL` at your tunnel**, then start the server and subscribe:

```bash
npm run dev
npm run cli -- subscribe
```

The hub calls back to verify; the server echoes the challenge and the
subscription goes active. Check it with `npm run cli -- status`.

**4. Link TikTok**

```bash
npm run cli -- tiktok-login
```

It prints a `YT2TT_PKCE_VERIFIER` to put in the server's environment and an
authorisation URL to open. Approving it redirects to
`/oauth/tiktok/callback`, which stores the tokens.

**5. Put your masters where it can find them**

`SOURCE_DIR` (default `./data/masters`), named any of:

- `<videoId>.mp4` — e.g. `dQw4w9WgXcQ.mp4`
- `<videoId> anything else.mp4` — prefix match
- anything, mapped in `manifest.json`: `{ "dQw4w9WgXcQ": "renders/ep4-master.mov" }`

Set `SOURCE_WAIT_SECONDS` if your render tends to finish just after the upload.

**6. Check everything**

```bash
npm run cli -- doctor
```

## Publish modes

`TIKTOK_PUBLISH_MODE=inbox` (default) sends the file to your TikTok **drafts**.
You open the app, add sounds or effects, and post. It needs only the
`video.upload` scope and works with an unaudited app — this is the mode to start
in.

`direct` posts straight to your profile. It needs `video.publish` and an audited
app, and it queries `creator_info` first so it never sends a privacy level your
account does not offer.

`TIKTOK_PRIVACY_LEVEL` defaults to `SELF_ONLY`. Raise it once you have watched a
few go through.

## Day to day

The review UI is at `http://127.0.0.1:8787/`. Or:

```bash
npm run cli -- jobs              # list
npm run cli -- approve 12
npm run cli -- reject 13
npm run cli -- ingest dQw4w9WgXcQ --force   # queue one by hand
npm run cli -- status
```

Set `DRY_RUN=true` to run the whole pipeline and stop short of uploading —
useful for checking your framing and loudness settings before anything is live.
Set `REVIEW_TOKEN` if the server is reachable from anywhere but localhost.

## Tuning the look

| Setting | Effect |
| --- | --- |
| `VERTICAL_MODE=blur` | Whole frame visible over a blurred fill. Safest for talking-head and wide shots. |
| `VERTICAL_MODE=crop` | Fills the frame, loses the sides. Good when the subject is centred. |
| `VERTICAL_MODE=pad` | Letterbox onto `PAD_COLOR`. |
| `CLIP_THRESHOLD_SECONDS` | Videos longer than this get segmented. |
| `CLIP_TARGET_SECONDS` / `CLIP_MAX_COUNT` | Length and number of segments. |
| `CLIP_HEAD_TRIM_SECONDS` | Skip your intro when segmenting. |

Clip selection is a plain time-slicer — predictable and free. `planClips()` in
`src/media/clip.ts` is the seam to replace with a transcript-driven picker.

## How failures behave

Jobs retry with exponential backoff up to `MAX_ATTEMPTS`. Failures that cannot
succeed on retry (a 4xx from TikTok, a missing video stream, a privacy level the
account does not allow) fail immediately rather than burning five attempts. A
missing master sends the job back to the sourcing stage so it picks up a file
that arrives late.

Ingestion is idempotent at the database level: a redelivered notification, an
edit to an old video's title, and an upload seen by both the push and poll paths
all resolve to one job.

## Tests

```bash
npm test          # 167 tests, node:test
npm run typecheck
```

Covers the parts where a subtle mistake is expensive: TikTok's chunk arithmetic,
WebSub signature verification, feed parsing against malformed input, caption
truncation across code points, FFmpeg argument construction, path-traversal
guards on the source resolver, and the HTTP surface.

## Layout

```
src/
  config.ts          zod-validated environment
  db.ts              SQLite state, idempotency, job queue
  server.ts          WebSub callback, OAuth callback, review UI
  main.ts            long-running process
  cli.ts             operator commands
  util/              atom parsing, HMAC, captions, time
  youtube/           Data API, WebSub, poller
  source/            master-file resolution
  media/             filtergraphs, clip planning, FFmpeg
  tiktok/            OAuth, chunking, Content Posting API
  pipeline/          ingest and the job state machine
```

## Notes

- `node:sqlite` prints an `ExperimentalWarning` on Node 22. It is stable in
  Node 24.
- The WebSub lease maxes out at ~5 days and is renewed hourly at 80% elapsed. If
  the process is down for longer than a lease, the poller covers the gap and the
  next start re-subscribes.
- Encoded files are deleted once TikTok confirms the post. Masters are never
  touched.
