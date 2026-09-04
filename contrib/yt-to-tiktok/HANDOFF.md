# Handoff

Built in a cloud container, then verified and fixed on the operator's laptop
against their own footage. Read this first, then `README.md`.

**The design and all three deployment decisions are settled — do not reopen
them.** What remains is the operator's own accounts, and it is listed under
"What is NOT done". The next concrete step is
[`deploy/oracle-free-vps.md`](deploy/oracle-free-vps.md).

---

## What this is

A pipeline that takes the operator's own video masters, reformats them for
TikTok, and publishes them to their own TikTok account. Standalone project under
`contrib/` with its own `package.json`; it does not import from OmniRoute.

**317 tests. 313 pass on Windows; all pass on Linux.** Typecheck and build clean.

The four Windows failures are test-side POSIX assumptions, not defects: two
assert file modes `chmod` cannot set on NTFS, one hardcodes a `/`-rooted path,
and one runs a POSIX shell one-liner through `cmd.exe`. **Node ≥ 22.9** is the
floor now — the start scripts load `.env` with `--env-file-if-exists`, which
older 22.x rejects as an unknown flag before any code runs.

## What is already done

Everything except the operator's own accounts:

- Trigger: WebSub push, API poller, and a folder watcher — all three built
- Ingest with idempotency (redeliveries, edit-notifications and push/poll
  overlap all collapse to one job)
- Source resolution from local masters, with a path-traversal guard
- Encoding: 9:16 conversion, EBU R128 loudness, clip segmentation, and a
  passthrough planner that stream-copies already-vertical footage
- Preflight validation against the publisher's limits
- Review gate, job queue with retries and backoff
- TikTok Content Posting API: OAuth with PKCE and CSRF-protected callback,
  chunked upload, status polling, token refresh
- Terms and Privacy pages, served at `/legal/terms` and `/legal/privacy`
- `setup.sh`, systemd unit, Dockerfile
- End-to-end tests that run real FFmpeg encodes, and a mock TikTok that
  enforces the Content Posting API contract

## What is NOT done — and needs the operator

These need their identity and consent. Help them through these; do not attempt
them on their behalf.

1. **An Oracle Cloud account** — requires a credit card for identity
   verification. Not charged on Always Free, but mandatory, and theirs to enter.
   Then follow [`deploy/oracle-free-vps.md`](deploy/oracle-free-vps.md).
2. **TikTok developer app** — `docs/tiktok-app-submission.md` has all the copy
   ready to paste. Accepting the Developer Terms is theirs.
3. **The authorize click** — `cli tiktok-login`, signed in as the destination
   account. Their password, their decision.
4. **A caption template.** The rehearsal's real finding. `CAPTION_TEMPLATE`
   defaults to `{title}` and the title comes from the filename, so a master
   named `WhatsApp Video 2026-09-04 at 5.48.23 PM.mp4` posts under exactly that.
   Editorial, so it is theirs — but it must be settled before anything goes
   public.

Not needed under the settled decisions: **ngrok** (no public URL — the legal
pages go on GitHub Pages via `cli legal-export`, and OAuth goes through an SSH
tunnel) and a **YouTube Data API key** (nothing queries YouTube).

## The decisions, now settled

All three were open at the last handoff. They are decided; do not reopen them.

**1. Where does it run — a free Oracle Cloud VPS.** The full runbook is
[`deploy/oracle-free-vps.md`](deploy/oracle-free-vps.md). Oracle is the only
free tier that survives the requirement, and the deciding number is egress, not
CPU: Oracle gives 10 TB/month, Google's e2-micro gives 1 GB, which is ~110 posts
before it bills. Two caveats are written into the runbook — Oracle halved the
free ARM allowance in June 2026, and it reclaims instances judged idle over a
rolling 7-day window, which this workload plausibly is.

**2. Redirect URI — try `http://localhost:8787/oauth/tiktok/callback` first.**
Still unverified against the portal, but on a VPS it is *still* the right first
attempt: TikTok redirects the browser, so `ssh -L 8787:localhost:8787` makes the
operator's browser reach the server's loopback. `HOST` defaults to `127.0.0.1`,
so nothing is exposed. Fall back to `deploy/tunnel.md` only if the portal
rejects it.

**3. Trigger — the folder watcher, and it is not close.** Verified on real
footage. There is no built-in YouTube download: `SOURCE_MODE` is only `local` or
`command`, so a WebSub trigger still has to get the file to the box somehow —
either it is already synced there, or `command` re-downloads the operator's own
upload, which is a lossy second generation of a master they already have. The
watcher fires on the *export*, which is earlier than the YouTube publish, needs
no credentials, and uses the master. Masters reach the server by Syncthing (§5
of the runbook).

Also worth knowing: the operator is being reposted on TikTok within ~20s of a
YouTube publish. They cannot win that race through the official API, because
their side is gated by an audit and the reposters' is not. Posting on export
rather than on publish sidesteps it entirely — they become the earlier upload on
both platforms.

## Things learned the hard way

Worth knowing before changing any of this.

**Found by running it on a real laptop with real footage, after the cloud
session had declared it done:**

- **Nothing read `.env`.** Neither `main.ts` nor `config.ts` loaded it, so the
  npm scripts saw only `process.env`. Invisible in a container, because systemd
  supplies values through `EnvironmentFile=` and Docker through its own env —
  but on a workstation every setting silently fell back to its default, and the
  zero-credential rehearsal refused to start demanding credentials it had been
  told it did not need. Fixed with `--env-file-if-exists`, which is also why the
  Node floor moved to 22.9.
- **`.env.example` could not boot.** It shipped 13 keys with empty values, and
  an empty string fails schema validation where an absent key falls back to a
  default. `cp .env.example .env` produced a file that refused to start.
- **`WORK_DIR` was never created on the watcher path.** The only
  `mkdir(WORK_DIR)` lived in `stageSource`, but `ingestLocalFile()` puts a
  watched file straight into `processing` — the master is already on disk — and
  skips it. ffmpeg was told to write into a directory nobody made and exited −2.
  **This broke the folder watcher on every install where `setup.sh` had not
  run**, which is the credential-free trigger and so the most likely first run.
  The e2e test for that exact path passed throughout, because the *test* created
  `data/work` before driving the pipeline. Setup a test does that production
  does not is how a suite goes blind; that line is gone and the test now fails
  without the fix.
- **ffmpeg's stderr was captured and never logged.** `FfmpegError` has always
  carried `stderrTail`. Nothing read it, so an encode failure reported only
  `exited with code 4294967294` — an unsigned −2 — while the line naming the
  cause sat unread in the error object. It is in the log now, trimmed.
- **A vanished master burned five retries.** Renaming a file inside `SOURCE_DIR`
  queues the name the watcher saw; it is gone by the time the encoder looks. Now
  terminal on the first attempt. This matters more on a server, where a sync tool
  writing a temp name and renaming into place is the normal arrival path.

**Found earlier, in the cloud session:**

- **The publish path had never run.** A mock enforcing the API contract found a
  real bug immediately. Do not trust that path on inspection alone; there is a
  mock in `tests/tiktok-publish.test.ts` — use it.
- **`DRY_RUN` used to beat handoff mode** in `stagePublish`, marking jobs
  published and leaving the queue permanently empty. Order matters there.
- **Failed jobs leaked encoded files.** Fixing it exposed two ordering bugs:
  `output_path` must be recorded before preflight can throw, and the failure
  handler must re-read the job rather than trusting the pre-tick snapshot.
- **The OAuth callback had no `state` check.** It is publicly reachable, so
  anyone could have had their own code exchanged and their account stored.
  Fixed with single-use pending logins — do not weaken that.
- **Already-vertical footage was being fully re-encoded** through the blur graph
  for nothing: 16.3s of CPU on a 6s clip, and the file grew 155KB to 229KB.
  `VERTICAL_MODE=auto` now stream-copies it. The operator shoots 9:16, so this
  is their normal path.
- **The watcher must wait for a file to settle.** ffprobe on a truncated moov
  atom either reports a wrong duration or fails, killing a job on a file that
  was about to be fine.

## Their setup

- YouTube: `@yellowdonutt`
- TikTok destination: `@jdidhdududjdjjdjdidjf` — worth confirming this is right;
  it looks like a throwaway handle and it gates every publish
- They shoot vertical, so `VERTICAL_MODE=auto` passes footage through untouched
- Goal: fully automatic, public posting

## Commands

```bash
./setup.sh                       # everything automatable, safe to re-run
npm test                         # 317 tests (4 fail on Windows only)
npm run cli -- doctor            # what is missing
npm run cli -- set-tiktok-app    # credentials, hidden input
npm run cli -- tiktok-login      # single-use auth link
npm run cli -- whoami            # which account is linked
npm run cli -- add <file>        # queue a master directly
npm run cli -- urls              # what to paste into the portal
```

## The zero-credential rehearsal — done, and what it found

Run on the operator's laptop against their own footage, with no credentials and
no network. It earned its keep: three of the five bugs above were found by it,
including the one that broke the folder watcher outright.

Verified end to end on a real 1080×1920 60fps export, through both `npm run dev`
and the built `dist/main.js` (the path systemd actually runs):

| | Source | Encoded |
| --- | --- | --- |
| Video | h264 1080×1920 60fps | identical — stream-copied |
| Audio | aac 44.1 kHz | aac 48 kHz, loudness-normalised |
| Size | 8,790,435 | 8,801,630 |
| Time | | **~2 seconds** |

`plan: "audio-only", reason: "loudness normalisation"` — `VERTICAL_MODE=auto`
correctly refused to touch an already-vertical video stream. The 16.3 s of CPU
on a 6 s clip is genuinely gone.

Then watch → ingest → encode → review gate → approve → `DRY_RUN: skipping
upload`. The only untested link is the TikTok upload itself, which needs
credentials.

**What it surfaced, exactly as intended:** the caption is the raw filename. See
item 4 under "What is NOT done".

To re-run it after any change:

```ini
WATCH_MASTERS=true
DRY_RUN=true
```
