# Handoff

You are picking this up on the operator's laptop, continuing work that was built
in a cloud container. Read this first, then `README.md`.

**Say hello, run `npm test` to confirm the tree is healthy, then ask which of the
open decisions below they want to settle first.** Do not re-derive the design —
it is settled and tested.

---

## What this is

A pipeline that takes the operator's own video masters, reformats them for
TikTok, and publishes them to their own TikTok account. Standalone project under
`contrib/` with its own `package.json`; it does not import from OmniRoute.

**313 tests, all passing. Typecheck and build clean.** If anything is red on
first run, that is an environment problem (Node < 22.5, or FFmpeg missing), not
a code problem.

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

1. **ngrok account** — only if they need a tunnel (see open decisions)
2. **TikTok developer app** — `docs/tiktok-app-submission.md` has all the copy
   ready to paste. Accepting the Developer Terms is theirs.
3. **The authorize click** — `cli tiktok-login`, signed in as the destination
   account. Their password, their decision.
4. **A YouTube Data API key** — only if they want YouTube-triggered publishing

## Open decisions

Ask about these rather than assuming.

**1. Where does it run?** This is the one that actually matters to them. They
want posts to go out while their laptop is asleep, which a laptop-bound install
cannot do. A small VPS solves it and `deploy/` is ready. They said earlier they
have no VPS; the constraint may have changed now that they understand it is the
blocker.

**2. Redirect URI: localhost or tunnel?** TikTok redirects the *browser*, not
the server, so `http://localhost:8787/oauth/tiktok/callback` should work and
removes the need for ngrok entirely. Unverified — the portal may demand HTTPS.
**Have them try localhost first.** If it is accepted, and they use
`WATCH_MASTERS=true`, they need no tunnel and no YouTube API key at all.

**3. Trigger: YouTube upload, or the file?** WebSub fires off the YouTube
publish and needs a public tunnel. The folder watcher fires off the export and
needs nothing. If they are exporting a master anyway, the watcher is the same
effort with two fewer credentials.

## Things learned the hard way

Worth knowing before changing any of this.

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
npm test                         # 313 tests
npm run cli -- doctor            # what is missing
npm run cli -- set-tiktok-app    # credentials, hidden input
npm run cli -- tiktok-login      # single-use auth link
npm run cli -- whoami            # which account is linked
npm run cli -- add <file>        # queue a master directly
npm run cli -- urls              # what to paste into the portal
```

## The zero-credential rehearsal

Suggest this early. It works today, with no accounts and no network:

```ini
WATCH_MASTERS=true
DRY_RUN=true
```

Drop a real export into `data/masters/`. It encodes their actual footage and
shows exactly what would post. It is where they would find out the captions or
clip lengths need adjusting — before the TikTok audit, not after.
