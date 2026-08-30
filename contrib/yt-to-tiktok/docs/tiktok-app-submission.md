# TikTok app submission

Copy for registering the app at [developers.tiktok.com](https://developers.tiktok.com)
and submitting it for audit. Replace anything in `[brackets]`.

Everything here describes what the software actually does. Do not overstate the
scope — a description that does not match observed behaviour is a common reason
for an audit to come back.

---

## App details

**App name**
```
Yellow Donut Studio
```
Avoid "bot", "auto", "scraper" — accurate for what this is (a creator's own
publishing tool), and those words invite a closer read.

**Category** — `Content & Publishing` (or nearest equivalent)

**Description** (short)
```
A personal publishing tool that reformats my own YouTube uploads for vertical
viewing and posts them to my own TikTok account.
```

**Description** (long)
```
This is a single-operator tool I run for my own channel. When I publish a video
to my YouTube channel, it takes the master file from my own storage, reformats
it for vertical viewing — 9:16 framing, loudness normalisation, and splitting
longer videos into shorter segments — and posts the result to my own TikTok
account through the Content Posting API.

It has no other users. There is no sign-up, no public interface, and no
processing of anyone else's content. The only account it can post to is the one
that completes the OAuth flow, which is mine.

Before anything is posted, the encoded clip is held in a review queue with its
caption and destination shown, and I approve it. The app reads creator_info
before each post so the upload respects the account's own privacy options and
maximum post duration.
```

**Terms of Service URL**
```
https://[your-public-url]/legal/terms
```

**Privacy Policy URL**
```
https://[your-public-url]/legal/privacy
```

Both are served by the app itself and are publicly reachable without
authentication — the reviewer must be able to fetch them.

**Redirect URI**
```
https://[your-public-url]/oauth/tiktok/callback
```
Must match `TIKTOK_REDIRECT_URI` in `.env` exactly.

---

## Products and scopes

| Item | Value |
| --- | --- |
| Product | Content Posting API |
| Direct Post | **enabled** |
| Scopes | `user.info.basic`, `video.publish` |

`video.upload` instead of `video.publish` if you only ever want drafts.

---

## What the reviewer is checking

TikTok's Direct Post guidelines require the creator to see a post's content and
settings and confirm before it publishes. Scheduling tools satisfy this by
taking confirmation when the post is scheduled rather than at publish time.

Run with `REQUIRE_REVIEW=true` while under review, and describe the review
queue as the confirmation surface — it is one. The dashboard shows each clip's
caption, destination account, and privacy level, and nothing uploads until it
is approved.

If asked for a demonstration, the flow to show is:

1. A video is published on the YouTube channel.
2. The job appears in the review queue at `/`, with caption and privacy level.
3. Approving it uploads to TikTok.
4. `npm run cli -- whoami` confirms the destination account.

---

## Before you submit

- [ ] Both legal URLs load publicly over HTTPS
- [ ] Redirect URI matches `.env` exactly
- [ ] `LEGAL_ENTITY_NAME` and `LEGAL_CONTACT_EMAIL` are set, so the pages carry
      a real contact
- [ ] `npm run cli -- whoami` returns the intended account
- [ ] A test post has landed (`TIKTOK_PRIVACY_LEVEL=SELF_ONLY` posts privately
      to your own profile — visible only to you)
