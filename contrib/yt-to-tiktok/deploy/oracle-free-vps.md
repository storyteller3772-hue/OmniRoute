# Running it free on an Oracle Cloud VPS

A laptop cannot publish while it is asleep. This is the always-on box that can,
at no cost, using Oracle Cloud's Always Free tier.

**The shape of this deployment:** the app listens on loopback only and is never
exposed to the internet. Masters arrive by folder sync, the folder watcher fires
on them, and the one browser step — authorising TikTok — happens through an SSH
tunnel. No tunnel service, no ngrok, no YouTube API key, no inbound ports beyond
SSH and the sync.

---

## Why Oracle and not the others

The deciding number is egress, because this uploads video.

| | Oracle Always Free | Google Cloud e2-micro | AWS / Azure free |
| --- | --- | --- | --- |
| Egress per month | **10 TB** | **1 GB** | 12 months, then billed |
| Duration | indefinite | indefinite | 12 months |

Google's 1 GB/month is roughly 110 posts at ~9 MB and bills after that. Compute
is irrelevant here either way: a vertical master stream-copies in about two
seconds, so even the smallest shape is oversized.

### Two things to know before you commit

- Oracle **halved** the Always Free ARM allowance from 4 OCPU/24 GB to 2 OCPU/12 GB
  on 15 June 2026 and began terminating over-limit instances on 18 August. Still
  far more than this needs, but the terms do move.
- **Idle instances get reclaimed.** Oracle evaluates Always Free compute over a
  rolling 7-day window. A pipeline that posts a few times a week and idles the
  rest is a plausible candidate. See "Keeping it alive" below.

If either bothers you, a ~€4/month VPS from Hetzner or similar removes both
problems and every step below still applies unchanged apart from §1.

---

## 0. What you have to do yourself

- **Create the Oracle account.** It requires a credit card for identity
  verification. It is not charged on Always Free, but the card is mandatory.
- **Authorise TikTok** (§6) — your login, your click.
- **Accept the TikTok Developer Terms** when registering the app.

Everything else below can be pasted.

---

## 1. Create the instance

Console → Compute → Instances → Create instance.

**Shape.** Two options, both free:

| Shape | Specs | Trade-off |
| --- | --- | --- |
| `VM.Standard.A1.Flex` (ARM) | up to 2 OCPU / 12 GB | Much roomier. Frequently "out of capacity" in busy regions. |
| `VM.Standard.E2.1.Micro` (x86) | 1/8 OCPU, 1 GB | Nearly always available. Enough for stream-copy; painful if you ever feed it landscape footage that needs the blur graph. |

Take ARM if you can get it. If you hit **"Out of host capacity"**, that is
normal — retry at a different hour, or pick a less busy availability domain.

**Image.** Canonical Ubuntu 24.04 (or 22.04). The commands below assume Ubuntu.

**Boot volume.** Raise it to ~100 GB — you have 200 GB free across the account,
and masters are large. Keep the default otherwise.

**SSH keys.** Upload your public key. If you do not have one:

```bash
ssh-keygen -t ed25519 -C "yt2tt"
```

Then connect (Ubuntu images use the `ubuntu` user):

```bash
ssh ubuntu@<YOUR_INSTANCE_PUBLIC_IP>
```

---

## 2. Oracle's two firewalls

This is the step that wastes everyone's afternoon. Oracle filters traffic in
**two independent places**, and opening one does nothing on its own:

1. **The VCN Security List** (in the web console) — Networking → Virtual Cloud
   Networks → your VCN → Subnet → Security List → Add Ingress Rules.
2. **iptables on the instance itself** — Oracle's Ubuntu images ship with a
   restrictive `iptables` ruleset that is *not* ufw.

For this deployment you need almost nothing open, because the app binds to
loopback. You need SSH (already open) and, if you want Syncthing to connect
directly rather than through a public relay, TCP 22000:

```bash
# on the instance
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 22000 -j ACCEPT
sudo netfilter-persistent save
```

Add the matching ingress rule for TCP 22000 in the Security List. Skip both if
you are happy for Syncthing to use relays — it will work, just slower.

**Do not open 8787.** Nothing needs to reach the app from outside.

---

## 3. System setup

Ubuntu's packaged Node is too old. This project needs **Node ≥ 22.9** — the
start scripts load `.env` with `--env-file-if-exists`, which older builds reject
as an unknown flag before any of the code runs. Use Node 24, where the built-in
`node:sqlite` is stable rather than experimental:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git ffmpeg
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version    # must be >= 22.9; expect v24.x
ffmpeg -version | head -1
```

Both `ffmpeg` and `ffprobe` come from the one `ffmpeg` package. NodeSource
publishes arm64, so this is identical on either shape.

---

## 4. Install the app

The systemd unit expects `/opt/yt-to-tiktok` and a `yt2tt` service user:

```bash
sudo useradd --system --create-home --home-dir /opt/yt-to-tiktok --shell /usr/sbin/nologin yt2tt
sudo -u yt2tt git clone https://github.com/storyteller3772-hue/OmniRoute.git /tmp/omniroute
sudo -u yt2tt cp -r /tmp/omniroute/contrib/yt-to-tiktok/. /opt/yt-to-tiktok/
sudo rm -rf /tmp/omniroute

cd /opt/yt-to-tiktok
sudo -u yt2tt npm ci
sudo -u yt2tt npm run build
sudo -u yt2tt mkdir -p data/masters data/work
```

Configure it. Start from the example — every key it cannot supply ships
commented out, so it boots as-is:

```bash
sudo -u yt2tt cp .env.example .env
sudo -u yt2tt nano .env
```

The watch-only, no-credentials starting point:

```ini
WATCH_MASTERS=true
SOURCE_DIR=./data/masters
VERTICAL_MODE=auto
DRY_RUN=true
REQUIRE_REVIEW=true
TIKTOK_PRIVACY_LEVEL=SELF_ONLY
EXPECTED_TIKTOK_USERNAME=jdidhdududjdjjdjdidjf
```

Lock the file down — it will hold a client secret:

```bash
sudo chmod 600 /opt/yt-to-tiktok/.env
sudo chown yt2tt:yt2tt /opt/yt-to-tiktok/.env
```

Install the service:

```bash
sudo cp deploy/yt-to-tiktok.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now yt-to-tiktok
journalctl -u yt-to-tiktok -f
```

You should see `yt-to-tiktok listening`, `dryRun: true`, and
`watching for new master files`.

> The unit passes `.env` via systemd's `EnvironmentFile=`, not via the npm
> script, so the `--env-file-if-exists` flag is not involved here. It still
> matters for anything you run by hand with `npm run cli`.

---

## 5. Getting masters onto the box

The watcher fires on a file appearing in `data/masters` **on the server**. Your
editor exports to your laptop. Something has to bridge that, and it is on the
critical path — this is what makes "posted before anyone can repost it"
actually work.

**Syncthing** is the fit: a folder on your laptop mirrors continuously to the
server, with no cloud service in the middle. It writes to a temporary name and
renames into place, which is exactly the pattern the watcher handles correctly.

On the server:

```bash
sudo apt-get install -y syncthing
sudo systemctl enable --now syncthing@yt2tt
# admin UI on loopback only; reach it from your laptop with:
#   ssh -L 8384:localhost:8384 ubuntu@<IP>
# then open http://localhost:8384
```

Add your laptop as a device, share a folder, and point it at
`/opt/yt-to-tiktok/data/masters`. Set the folder to **Send Only** on the laptop
and **Receive Only** on the server so nothing propagates backwards.

Then your workflow is: export → the file syncs → it posts. Nothing else to do.

**Do not use TeraBox for this.** It has corrupted files silently before.

Two habits worth keeping:

- **Rename before you drop the file in, never after.** Renaming inside the watch
  folder queues the name the watcher saw; that job now fails immediately with
  `master no longer exists` rather than retrying, but it is still a wasted job.
- **Name the file what you want the caption to be.** See §7.

---

## 6. TikTok: the app, and authorising it

Full copy for the portal is in `docs/tiktok-app-submission.md`.

### The legal pages, without a public server

TikTok's reviewer must be able to fetch your Terms and Privacy pages. The app
serves them at `/legal/terms` and `/legal/privacy`, but it is on loopback — so
export them as static files and host them free instead:

```bash
cd /opt/yt-to-tiktok
sudo -u yt2tt npm run cli -- legal-export ./legal-pages
```

Commit those two HTML files to a GitHub Pages repo. The resulting
`https://<user>.github.io/<repo>/terms.html` URLs are what go in the portal.
This is why the app itself never needs to be reachable.

### The redirect URI

Try **`http://localhost:8787/oauth/tiktok/callback`** first. TikTok redirects
the *browser*, not the server, so this works even though the app runs remotely —
you just need your browser's `localhost:8787` to reach the server's. That is one
SSH flag:

```bash
# from your laptop, and leave it open for the whole login
ssh -L 8787:localhost:8787 ubuntu@<YOUR_INSTANCE_PUBLIC_IP>
```

If the portal rejects a plain-HTTP or localhost redirect URI, fall back to a
real domain with HTTPS in front of the app — see `deploy/tunnel.md`. Try
localhost first; it removes an entire dependency.

### Authorise

With the tunnel open:

```bash
# on the server
cd /opt/yt-to-tiktok
sudo -u yt2tt npm run cli -- set-tiktok-app     # hidden input; writes .env
sudo -u yt2tt npm run cli -- tiktok-login       # prints a single-use link
```

Open that link **in a browser signed into `@jdidhdududjdjjdjdidjf`**, not
whichever account happens to be logged in. Then confirm where posts would go:

```bash
sudo -u yt2tt npm run cli -- whoami
sudo systemctl restart yt-to-tiktok
```

`EXPECTED_TIKTOK_USERNAME` is already set, so a login approved on the wrong
account fails the job rather than quietly posting to a stranger's profile.

---

## 7. Going live, in the right order

The audit is the long pole, so do it in this sequence:

1. **`DRY_RUN=true`** — confirm masters sync and encode on the server. Nothing
   uploads.
2. **`DRY_RUN=false`, `TIKTOK_PUBLISH_MODE=inbox`** — videos land in your TikTok
   drafts. You open the app and post them. Proves the upload path end to end
   with an unaudited app.
3. **`TIKTOK_PUBLISH_MODE=direct`, `TIKTOK_PRIVACY_LEVEL=SELF_ONLY`** — posts
   reach your profile privately. Only you can see them. Watch a few land.
4. **Submit for audit.** Ask for `video.publish`.
5. **Approved → `TIKTOK_PRIVACY_LEVEL=PUBLIC_TO_EVERYONE`, `REQUIRE_REVIEW=false`.**
   Now it is fully automatic and public.

Steps 1–3 need no audit. Only step 5 does, and until then an unaudited app is
restricted to `SELF_ONLY` no matter what you set.

### Fix the caption before step 5

The default is `CAPTION_TEMPLATE={title}`, and the title is derived from the
filename. A file called `bro gave a tip for that.mp4` posts as exactly that.
That is fine; `WhatsApp Video 2026-09-04 at 5.48.23 PM.mp4` is not. Either name
your exports deliberately or set a template:

```ini
CAPTION_TEMPLATE={title}
CAPTION_HASHTAGS=fyp,shorts
```

---

## Keeping it alive

Oracle reclaims Always Free instances judged idle over a rolling 7-day window,
and this workload is idle almost all the time. Options, cheapest first:

- **Upgrade to Pay As You Go.** Always Free resources stay free, the instance
  becomes exempt from reclamation, and the older 4 OCPU/24 GB ARM allowance is
  restored. The catch is a card that *can* bill you if you exceed free limits.
- **Take backups regardless.** `data/yt2tt.sqlite` holds your OAuth tokens and
  job history. If the instance is reclaimed you re-authorise from scratch.

```bash
# from your laptop, occasionally
scp ubuntu@<IP>:/opt/yt-to-tiktok/data/yt2tt.sqlite ./yt2tt-backup.sqlite
```

---

## Checks and troubleshooting

```bash
sudo -u yt2tt npm run cli -- doctor     # what is still missing
sudo -u yt2tt npm run cli -- status     # tokens, subscription, job counts
sudo -u yt2tt npm run cli -- jobs       # every job and its state
journalctl -u yt-to-tiktok -f           # live logs
```

| Symptom | Cause |
| --- | --- |
| `unknown option --env-file-if-exists` | Node < 22.9. Reinstall from NodeSource. |
| `ffmpeg exited with code 4294967294` | Unsigned −2, ENOENT: a path that does not exist. The log now carries ffmpeg's own stderr line — read that. |
| `master no longer exists` | The file was renamed or removed after the watcher queued it. Rename before dropping it in. |
| Job stuck in `awaiting_review` | `REQUIRE_REVIEW=true`. `cli approve <id>`, or set it false. |
| Posts land private | Unaudited app, or `TIKTOK_PRIVACY_LEVEL=SELF_ONLY`. Both must be resolved. |
| Video appears in drafts, never posts | `TIKTOK_PUBLISH_MODE=inbox`. That is what inbox means. |
| `Out of host capacity` at creation | ARM contention. Retry later or use the E2 micro shape. |

---

## What this deliberately does not do

- **No WebSub, no public URL, no ngrok.** The trigger is your export, not your
  YouTube publish. That is earlier, needs no credentials, and uses the master
  rather than a re-download of your own upload.
- **No YouTube API key.** Nothing queries YouTube.
- **Port 8787 is never exposed.** The only browser step goes through SSH.
