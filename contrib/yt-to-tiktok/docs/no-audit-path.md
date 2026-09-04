# Getting posts out without waiting for the audit

The most automation TikTok allows an unaudited app, what it costs you, and the
exact configuration for it.

---

## The constraint, stated plainly

There is no configuration of your own TikTok app that publishes **publicly**,
**automatically**, **without an audit**. TikTok enforces this server-side:

| Your app | Mode | Where the video lands |
| --- | --- | --- |
| Unaudited | `inbox` | Your TikTok **drafts**. You tap Post. |
| Unaudited | `direct` | Your profile, forced **`SELF_ONLY`** — only you can see it. |
| Audited | `direct` | Public, no human involved. |

`SELF_ONLY` is not a setting this app chooses; an unaudited app is restricted to
it regardless of `TIKTOK_PRIVACY_LEVEL`. So the audit buys exactly one thing:
removing the tap. Everything before the tap can be fully automatic today.

**Do not automate TikTok's app or web uploader to get around this.** It is what
the accounts reposting your videos do. It violates the terms, and the thing at
risk is the account your videos live on.

---

## The no-audit setup

Everything up to publication runs unattended: detect, download or read the
master, encode to spec, normalise loudness, upload to TikTok. The video is fully
uploaded and waiting in drafts. You open the app and tap Post.

```ini
TIKTOK_PUBLISH_MODE=inbox
REQUIRE_REVIEW=false
DRY_RUN=false

TIKTOK_CLIENT_KEY=...
TIKTOK_CLIENT_SECRET=...
TIKTOK_REDIRECT_URI=http://localhost:8787/oauth/tiktok/callback
EXPECTED_TIKTOK_USERNAME=jdidhdududjdjjdjdidjf
```

`inbox` needs only the `video.upload` scope, which an unaudited app can hold.
`REQUIRE_REVIEW=false` is safe here *because* inbox mode already ends in a
manual step — the draft is the review.

Then pick a trigger.

---

## Trigger A — the export (recommended, and it wins the race)

Fires when a master lands in `SOURCE_DIR`. No YouTube credentials, no tunnel.

```ini
WATCH_MASTERS=true
SOURCE_MODE=local
SOURCE_DIR=./data/masters
VERTICAL_MODE=auto
```

This is verified working on real footage. It also **wins the race against
reposters**, because it fires when you export — before YouTube has the video at
all. Post the draft, then publish on YouTube, and you are first by construction
at any speed.

## Trigger B — the YouTube upload

Fires when a video goes public on your channel. Needs a YouTube Data API key
(polling) or a public HTTPS URL (WebSub push), and it has to fetch the file back
down, because there is no built-in YouTube download.

```ini
WATCH_MASTERS=false
YOUTUBE_API_KEY=...
YOUTUBE_CHANNEL_ID=UC...        # npm run cli -- resolve-channel @yellowdonutt
POLL_INTERVAL_SECONDS=300

SOURCE_MODE=command
SOURCE_COMMAND=yt-dlp -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b" --merge-output-format mp4 -o "$YT2TT_OUTPUT_PATH" "$YT2TT_VIDEO_URL"
SOURCE_COMMAND_TIMEOUT_SECONDS=900
```

The command receives `YT2TT_VIDEO_URL`, `YT2TT_VIDEO_ID` and
`YT2TT_OUTPUT_PATH` through the environment — never interpolated into the
command line — and must write a file to `YT2TT_OUTPUT_PATH`. Install with
`sudo apt-get install -y yt-dlp` or `pipx install yt-dlp`.

> **Untested.** Every other path in this project was verified by running it;
> this one was not, because installing yt-dlp was outside what could be run
> here. Try it once by hand before trusting it:
> `YT2TT_VIDEO_URL=... YT2TT_OUTPUT_PATH=/tmp/t.mp4 sh -c '<the command>'`

**Two things to know before choosing B.** It re-downloads your own upload, so
you get YouTube's compressed copy rather than the master you already have — a
second generation, visibly softer. And it **cannot win the race**: it starts
when YouTube goes public, which is the same gun the reposters start on, and they
are not waiting on an audit. If being first is the point, use trigger A.

---

## What each option actually costs

| | Public automatically | Audit | Server | Wins the race |
| --- | --- | --- | --- | --- |
| Trigger A + `inbox` | one tap | no | yes | **yes** |
| Trigger B + `inbox` | one tap | no | yes | no |
| Either + `direct`, audited | yes | **yes** | yes | yes, with A |
| An approved partner tool | yes | no | **no** | yes, if you post before YouTube |

The last row is the only way to get *zero* human steps without your own audit:
tools like Buffer, Metricool or SocialMate already hold TikTok Content Posting
API approval, so you connect your account to their audited app instead of
submitting your own. It replaces most of this pipeline, costs a subscription,
and cannot attach trending sounds (no API exposes TikTok's music library).

---

## Order to do this in

1. Register the TikTok app, request `user.info.basic` and `video.upload`.
   Copy in `docs/tiktok-app-submission.md`.
2. `npm run cli -- set-tiktok-app`, then `tiktok-login` signed in as the
   destination account. `npm run cli -- whoami` to confirm where posts go.
3. Run the no-audit config above with trigger A. Drafts start appearing.
4. **Only if the tap becomes the thing that annoys you**, submit for audit and
   switch to `direct` + `PUBLIC_TO_EVERYONE` + `REQUIRE_REVIEW=false`.

Steps 1–3 need no audit and no waiting.
