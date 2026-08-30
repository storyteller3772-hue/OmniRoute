# Exposing it without a VPS

The app needs one public HTTPS origin so that:

- YouTube's WebSub hub can POST upload notifications to it,
- TikTok can redirect back to it after you authorise,
- TikTok's reviewer can fetch your Terms and Privacy pages.

**The URL must be stable.** It gets registered as your TikTok redirect URI and
submitted as your policy links. If it changes, OAuth breaks and the reviewer
gets a dead link. This rules out throwaway tunnel URLs — see the bottom.

---

## Option A — Tailscale Funnel (recommended)

Free, a stable hostname, a valid certificate, and no domain of your own.

```bash
# 1. install (macOS: brew install tailscale, or see tailscale.com/download)
curl -fsSL https://tailscale.com/install.sh | sh

# 2. log in - creates your tailnet
sudo tailscale up

# 3. find your machine's name
tailscale status --json | grep -i dnsname

# 4. expose the app's port to the public internet
sudo tailscale funnel --bg 8787
```

Funnel prints the public URL, of the form:

```
https://<machine>.<tailnet>.ts.net
```

That is your `PUBLIC_URL`. It survives reboots and reconnects.

```bash
tailscale funnel status      # confirm it is serving
sudo tailscale funnel --https=443 off    # stop
```

Note Funnel only forwards 443/8443/10000, and your tailnet must have
HTTPS certificates and Funnel enabled in the admin console — Tailscale prompts
you with the exact link the first time.

---

## Option B — Cloudflare Tunnel (if you own a domain)

Free, and gives you a URL on your own domain. Requires the domain's nameservers
to be on Cloudflare.

```bash
# install cloudflared, then:
cloudflared tunnel login
cloudflared tunnel create yt2tt
cloudflared tunnel route dns yt2tt yt2tt.yourdomain.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: yt2tt
credentials-file: /home/you/.cloudflared/<TUNNEL-ID>.json

ingress:
  - hostname: yt2tt.yourdomain.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

```bash
cloudflared tunnel run yt2tt
# run it permanently:
sudo cloudflared service install
```

`PUBLIC_URL=https://yt2tt.yourdomain.com`

---

## Option C — ngrok static domain

The free tier includes one static domain, which is enough.

```bash
ngrok config add-authtoken <token>
# claim a domain in the ngrok dashboard, then:
ngrok http 8787 --url=your-name.ngrok-free.app
```

`PUBLIC_URL=https://your-name.ngrok-free.app`

---

## What not to use

```bash
cloudflared tunnel --url http://localhost:8787   # random *.trycloudflare.com
ngrok http 8787                                   # random *.ngrok-free.app
```

Both give a **new URL every restart**. Fine for a one-off test, useless here:
the redirect URI registered with TikTok would stop matching, OAuth would fail
with a redirect-uri mismatch, and your submitted policy links would 404 for the
reviewer. The app warns at startup if `PUBLIC_URL` looks like one of these.

---

## After the tunnel is up

```bash
# 1. put the URL in .env
PUBLIC_URL=https://<your-stable-host>
TIKTOK_REDIRECT_URI=https://<your-stable-host>/oauth/tiktok/callback

# 2. check what to paste into the TikTok portal
npm run cli -- urls

# 3. confirm the world can reach the legal pages
curl -sI https://<your-stable-host>/legal/terms | head -1   # expect 200

# 4. subscribe to the YouTube feed
npm run cli -- subscribe
npm run cli -- status
```

Your machine must be awake for any of this to work. On a laptop, disable sleep
or accept that uploads published while it is closed are caught by the poller
when it wakes rather than in real time.
