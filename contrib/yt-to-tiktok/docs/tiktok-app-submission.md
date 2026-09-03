# Creating and submitting the TikTok app

Everything the portal asks for, in the order it asks. Replace `[brackets]`.

Two decisions shape the whole thing, so settle them first:

| Decision | If yes | If no |
| --- | --- | --- |
| Post publicly, unattended? | Direct Post + `video.publish` + an audit | Drafts only, `video.upload`, no audit |
| Trigger from the YouTube upload? | Needs a public tunnel for WebSub | `WATCH_MASTERS=true`, no tunnel |

---

## 0. Before you open the portal

You need two URLs the portal will demand, and one decision about where they live.

**Terms of Service and Privacy Policy.** The app serves both at `/legal/terms`
and `/legal/privacy`. The reviewer has to fetch them from the public internet,
so they need somewhere permanent to live. Two options:

- **Tunnel** — if you are already running ngrok for WebSub, use those URLs.
- **Static hosting** — no tunnel required, and does not depend on your machine
  being awake:

  ```bash
  npm run cli -- legal-export ./legal-export
  ```

  Commit the two files to a repo, enable GitHub Pages, and use the resulting
  URLs. This is the better home for policy links regardless.

Set these first so the exported pages carry a real contact:

```ini
LEGAL_ENTITY_NAME=[your name or business name]
LEGAL_CONTACT_EMAIL=[an address you read]
```

**Redirect URI.** After you approve, TikTok redirects *your browser* — it does
not call your server directly. So the URL only has to be reachable from your own
machine:

```
http://localhost:8787/oauth/tiktok/callback
```

Try that first. If the portal rejects it (it may require HTTPS), fall back to
your tunnel:

```
https://[your-ngrok-domain]/oauth/tiktok/callback
```

Whichever you register must match `TIKTOK_REDIRECT_URI` in `.env` exactly —
character for character, including the scheme and any trailing path. A mismatch
is the single most common cause of a failed authorisation.

---

## 1. Create the app

developers.tiktok.com → log in → **Manage apps** → **Connect an app**.

**App name**
```
[Your Channel] Studio
```
Avoid "bot", "auto", "scraper". Accurate for what this is, and those words
invite a closer read.

**Category** — `Content & Publishing`, or the nearest equivalent.

**Short description**
```
A personal publishing tool that reformats my own videos for vertical viewing
and posts them to my own TikTok account.
```

**Long description**
```
This is a single-operator tool I run for my own channel. It takes master files
from my own storage, reformats them for vertical viewing — 9:16 framing where
needed, loudness normalisation, and splitting longer videos into shorter
segments — and posts the result to my own TikTok account through the Content
Posting API.

It has no other users. There is no sign-up, no public interface, and no
processing of anyone else's content. The only account it can post to is the one
that completes the OAuth flow, which is mine.

Before anything is posted the encoded clip is held in a review queue showing its
caption, destination account and privacy level, and I approve it. The app reads
creator_info before each post so the upload respects the account's own privacy
options and maximum post duration.
```

Fill in the icon, Terms of Service URL and Privacy Policy URL from step 0. The
portal blocks products and submission until these exist and resolve.

---

## 2. Add the product

**Add products** → **Content Posting API**.

| Setting | Value | Why |
| --- | --- | --- |
| Direct Post | **on** for public posting; off for drafts | Off restricts you to the inbox |
| Scopes | `user.info.basic` + `video.publish` | `video.upload` instead if drafts only |

Add the redirect URI from step 0 under Login Kit / app settings.

---

## 3. Wire up your side

```bash
npm run cli -- set-tiktok-app   # hidden input, writes .env at mode 600
npm run cli -- urls             # confirms what to paste, with lengths
```

Then, with the server running:

```bash
npm run cli -- tiktok-login     # single-use link, 15-minute expiry
npm run cli -- whoami           # confirms which account is linked
```

Open the login link **signed in as the account you want posts to land on**. The
destination comes from whichever account approves it — nothing else decides.
Set `EXPECTED_TIKTOK_USERNAME` so a mistake here fails loudly instead of
publishing to the wrong profile.

---

## 4. Run privately before submitting

```ini
TIKTOK_PUBLISH_MODE=direct
TIKTOK_PRIVACY_LEVEL=SELF_ONLY
REQUIRE_REVIEW=true
```

Posts land on your own profile, visible only to you. This is where you find out
whether the framing, captions and loudness suit your content — on a private
post rather than a public one.

---

## 5. Submit for audit

Public posting requires it. An unaudited app can call Direct Post but is
restricted to `SELF_ONLY`.

TikTok's Direct Post guidelines require the creator to see a post's content and
settings and confirm before it publishes. Scheduling tools satisfy this by
taking confirmation when the post is scheduled rather than at publish time. The
review queue at `/` is exactly that surface — it shows each clip's caption,
destination account and privacy level, and nothing uploads until approved.
Describe it that way, and keep `REQUIRE_REVIEW=true` while under review.

If asked to demonstrate:

1. A master lands in `data/masters/` (or a video is published on the channel).
2. The job appears in the review queue at `/` with its caption and privacy level.
3. Approving it uploads to TikTok.
4. `npm run cli -- whoami` confirms the destination account.

---

## 6. Go public

Once approved:

```ini
TIKTOK_PRIVACY_LEVEL=PUBLIC_TO_EVERYONE
REQUIRE_REVIEW=false
```

Startup will state the unattended-public combination explicitly in the log. From
then on it runs without you.

---

## Checklist

- [ ] Both legal URLs load publicly over HTTPS, from a device that has never hit them
- [ ] Redirect URI matches `TIKTOK_REDIRECT_URI` exactly
- [ ] `LEGAL_ENTITY_NAME` and `LEGAL_CONTACT_EMAIL` set before exporting the pages
- [ ] `EXPECTED_TIKTOK_USERNAME` set to the destination account
- [ ] `npm run cli -- whoami` returns that account
- [ ] A `SELF_ONLY` post has landed and looked right
