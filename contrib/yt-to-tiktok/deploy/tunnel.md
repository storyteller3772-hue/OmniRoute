# Exposing it without a VPS

The app needs one public HTTPS origin so that:

- YouTube's WebSub hub can POST upload notifications to it,
- TikTok can redirect back to it after you authorise,
- TikTok's reviewer can fetch your Terms and Privacy pages.

**The URL must be stable.** It gets registered as your TikTok redirect URI and
submitted as your policy links. If it changes, OAuth fails with a redirect-uri
mismatch and the reviewer gets a dead link.

---

## ngrok

The free tier includes **one static domain**, which is what makes it usable
here. The random URL from a bare `ngrok http 8787` is not.

```bash
# 1. install - https://ngrok.com/download  (macOS: brew install ngrok)

# 2. sign up (free), then from the dashboard's "Your Authtoken" page:
ngrok config add-authtoken <YOUR_TOKEN>

# 3. claim your free static domain:
#    dashboard -> Domains -> Create Domain
#    you get something like  yellowdonut.ngrok-free.app

# 4. bind the tunnel to it
ngrok http 8787 --url=yellowdonut.ngrok-free.app
```

On older ngrok builds the flag is `--domain=` rather than `--url=`. Check with
`ngrok http --help | grep -E "url|domain"`.

```ini
PUBLIC_URL=https://yellowdonut.ngrok-free.app
TIKTOK_REDIRECT_URI=https://yellowdonut.ngrok-free.app/oauth/tiktok/callback
```

### Keeping it running

`ngrok` in a terminal dies when the terminal closes. To keep it up:

```bash
# macOS / Linux, quick and dirty
nohup ngrok http 8787 --url=yellowdonut.ngrok-free.app > ~/ngrok.log 2>&1 &

# or as a systemd user service (Linux)
systemctl --user enable --now ngrok
```

`ngrok`'s local dashboard at <http://127.0.0.1:4040> shows live requests, which
is the fastest way to see whether YouTube's hub is actually reaching you.

### The interstitial — check this before submitting

On the free tier ngrok has historically shown a browser warning page
("You are about to visit...") before the real content, for requests with a
browser user-agent. Machine-to-machine traffic is unaffected, so the WebSub
callback and the token exchange work either way — but **a reviewer opening your
Terms link in a browser would see the interstitial instead of your policy.**

Test it from a device that has never hit your tunnel, on cellular, in a private
window:

```
https://yellowdonut.ngrok-free.app/legal/terms
```

If your policy renders directly, you are fine — use the tunnel URLs everywhere.

If an ngrok warning page appears first, host the two legal pages elsewhere and
keep the tunnel for the callback:

```bash
npm run cli -- legal-export ./legal-export
```

Commit those two files to a repo, enable GitHub Pages, and give TikTok the
Pages URLs. GitHub Pages is free, permanent, has no interstitial, and does not
depend on your laptop being awake — which is arguably where policy links
belong anyway. The redirect URI must still point at the tunnel.

---

## Alternatives

**Tailscale Funnel** — free, stable `https://<machine>.<tailnet>.ts.net`, no
domain and no interstitial.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale funnel --bg 8787
```

**Cloudflare Tunnel (named)** — free and on your own domain, if you have one on
Cloudflare.

```bash
cloudflared tunnel login
cloudflared tunnel create yt2tt
cloudflared tunnel route dns yt2tt yt2tt.yourdomain.com
cloudflared tunnel run yt2tt
```

**Not usable here:** `ngrok http 8787` without `--url`, and
`cloudflared tunnel --url http://localhost:8787`. Both mint a new hostname per
run. The app warns at startup if `PUBLIC_URL` looks like one.

---

## After the tunnel is up

```bash
# what to paste into the TikTok portal
npm run cli -- urls

# confirm the outside world can reach the legal pages
curl -sI https://<your-host>/legal/terms | head -1        # expect 200

# then subscribe to the YouTube feed
npm run cli -- subscribe
npm run cli -- status
```

Your machine has to be awake. On a laptop, uploads published while it is asleep
are picked up by the poller when it wakes rather than in real time.
