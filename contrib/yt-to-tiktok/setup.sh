#!/usr/bin/env bash
#
# One-shot setup for yt-to-tiktok.
#
# Does everything that can be done without your passwords: checks tools,
# installs, builds, generates secrets, writes .env, brings up the ngrok tunnel,
# starts the app, verifies the outside world can reach it, and prints exactly
# what to paste into the TikTok developer portal.
#
# Safe to re-run. Existing .env values are kept unless you say otherwise.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
YEL=$'\033[33m'; CYA=$'\033[36m'; RST=$'\033[0m'

step()  { printf '\n%s==>%s %s%s%s\n' "$CYA" "$RST" "$BOLD" "$1" "$RST"; }
ok()    { printf '  %s✓%s %s\n' "$GRN" "$RST" "$1"; }
warn()  { printf '  %s!%s %s\n' "$YEL" "$RST" "$1"; }
die()   { printf '\n  %s✗ %s%s\n\n' "$RED" "$1" "$RST" >&2; exit 1; }

PORT="${PORT:-8787}"
ENV_FILE=".env"

# ---------------------------------------------------------------------------
step "Checking prerequisites"
# ---------------------------------------------------------------------------

command -v node >/dev/null 2>&1 || die "node not found. Install Node 22.5+ from https://nodejs.org"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  die "Node $(node -v) is too old. This needs 22.5+ (it uses the built-in node:sqlite)."
fi
ok "node $(node -v)"

if ! command -v ffmpeg >/dev/null 2>&1; then
  case "$(uname -s)" in
    Darwin) die "ffmpeg not found. Install it:  brew install ffmpeg" ;;
    Linux)  die "ffmpeg not found. Install it:  sudo apt install ffmpeg   (or your distro's equivalent)" ;;
    *)      die "ffmpeg not found. Install it from https://ffmpeg.org/download.html" ;;
  esac
fi
ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"

if ! command -v ngrok >/dev/null 2>&1; then
  printf '\n'
  warn "ngrok not found. Install it:"
  case "$(uname -s)" in
    Darwin) printf '      brew install ngrok\n' ;;
    Linux)  printf '      https://ngrok.com/download\n' ;;
  esac
  printf '\n    Then sign up (free) and run:\n'
  printf '      ngrok config add-authtoken <YOUR_TOKEN>\n\n'
  printf '    Claim your free static domain at:\n'
  printf '      https://dashboard.ngrok.com/domains\n\n'
  die "Re-run this script once ngrok is installed and authenticated."
fi
ok "ngrok $(ngrok version 2>/dev/null | awk '{print $3}')"

if ! ngrok config check >/dev/null 2>&1; then
  die "ngrok has no authtoken. Run:  ngrok config add-authtoken <YOUR_TOKEN>"
fi
ok "ngrok authtoken configured"

# ---------------------------------------------------------------------------
step "Installing and building"
# ---------------------------------------------------------------------------

npm install --no-audit --no-fund --silent
ok "dependencies installed"
npm run build --silent
ok "built"

# ---------------------------------------------------------------------------
step "Configuration"
# ---------------------------------------------------------------------------

# Read an existing value out of .env without sourcing it.
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

# Ask only when we do not already have a value.
ask() {
  local key="$1" prompt="$2" default="${3:-}" current answer
  current="$(env_get "$key")"
  if [ -n "$current" ]; then
    printf '  %s%s%s is already set\n' "$DIM" "$key" "$RST"
    printf '%s' "$current"
    return
  fi
  if [ -n "$default" ]; then
    read -r -p "  $prompt [$default]: " answer </dev/tty
    printf '%s' "${answer:-$default}"
  else
    read -r -p "  $prompt: " answer </dev/tty
    printf '%s' "$answer"
  fi
}

YOUTUBE_API_KEY="$(ask YOUTUBE_API_KEY 'YouTube Data API key (console.cloud.google.com)')"
[ -n "$YOUTUBE_API_KEY" ] || die "A YouTube API key is required."

NGROK_DOMAIN="$(ask NGROK_DOMAIN 'Your ngrok static domain (e.g. yellowdonut.ngrok-free.app)')"
[ -n "$NGROK_DOMAIN" ] || die "An ngrok static domain is required. Claim one at https://dashboard.ngrok.com/domains"
NGROK_DOMAIN="${NGROK_DOMAIN#https://}"; NGROK_DOMAIN="${NGROK_DOMAIN%/}"

LEGAL_CONTACT_EMAIL="$(ask LEGAL_CONTACT_EMAIL 'Contact email for the legal pages')"
LEGAL_ENTITY_NAME="$(ask LEGAL_ENTITY_NAME 'Name to show on the legal pages' 'Yellow Donut')"
YT_HANDLE="$(ask YT_HANDLE 'YouTube channel handle' '@yellowdonutt')"

PUBLIC_URL="https://${NGROK_DOMAIN}"

# Secrets are generated, never asked for.
WEBSUB_SECRET="$(env_get WEBSUB_SECRET)"
[ -n "$WEBSUB_SECRET" ] || WEBSUB_SECRET="$(openssl rand -hex 32)"
REVIEW_TOKEN="$(env_get REVIEW_TOKEN)"
[ -n "$REVIEW_TOKEN" ] || REVIEW_TOKEN="$(openssl rand -hex 24)"
ok "secrets ready"

# ---------------------------------------------------------------------------
step "Resolving your channel"
# ---------------------------------------------------------------------------

CHANNEL_ID="$(env_get YOUTUBE_CHANNEL_ID)"
if [ -z "$CHANNEL_ID" ]; then
  RESOLVED="$(YOUTUBE_API_KEY="$YOUTUBE_API_KEY" node dist/cli.js resolve-channel "$YT_HANDLE" 2>&1 || true)"
  CHANNEL_ID="$(printf '%s' "$RESOLVED" | sed -n 's/^id: *//p' | tr -d '[:space:]')"
  if [ -z "$CHANNEL_ID" ]; then
    printf '%s\n' "$RESOLVED"
    die "Could not resolve $YT_HANDLE. Check the handle and that the API key has YouTube Data API v3 enabled."
  fi
fi
ok "channel $CHANNEL_ID"

# ---------------------------------------------------------------------------
step "Writing .env"
# ---------------------------------------------------------------------------

if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%s)"
  ok "backed up existing .env"
fi

cat > "$ENV_FILE" <<ENVEOF
# Generated by setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)

PORT=${PORT}
HOST=127.0.0.1
PUBLIC_URL=${PUBLIC_URL}

YOUTUBE_API_KEY=${YOUTUBE_API_KEY}
YOUTUBE_CHANNEL_ID=${CHANNEL_ID}
WEBSUB_SECRET=${WEBSUB_SECRET}
POLL_INTERVAL_SECONDS=300
MAX_VIDEO_AGE_MINUTES=120

SOURCE_MODE=local
SOURCE_DIR=./data/masters
SOURCE_WAIT_SECONDS=0

VERTICAL_MODE=blur
OUTPUT_FPS=30
LOUDNESS_ENABLED=true

CLIP_THRESHOLD_SECONDS=180
CLIP_TARGET_SECONDS=60
CLIP_MAX_COUNT=3

# Filled in after you create the TikTok app.
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_REDIRECT_URI=${PUBLIC_URL}/oauth/tiktok/callback

# Start private and reviewed. Switch to direct/PUBLIC_TO_EVERYONE after the audit.
TIKTOK_PUBLISH_MODE=direct
TIKTOK_PRIVACY_LEVEL=SELF_ONLY
REQUIRE_REVIEW=true

LEGAL_ENTITY_NAME=${LEGAL_ENTITY_NAME}
LEGAL_CONTACT_EMAIL=${LEGAL_CONTACT_EMAIL}

REVIEW_TOKEN=${REVIEW_TOKEN}
LOG_LEVEL=info

# Used by setup.sh only.
NGROK_DOMAIN=${NGROK_DOMAIN}
YT_HANDLE=${YT_HANDLE}
ENVEOF
chmod 600 "$ENV_FILE"
ok ".env written (mode 600)"

mkdir -p data/masters data/work
ok "data/masters ready - put your master files here, named <videoId>.mp4"

# ---------------------------------------------------------------------------
step "Starting the tunnel"
# ---------------------------------------------------------------------------

tunnel_url() {
  curl -s --max-time 3 http://127.0.0.1:4040/api/tunnels 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const t=(JSON.parse(d).tunnels||[]).find(t=>t.public_url?.startsWith("https"));process.stdout.write(t?t.public_url:"")}catch{}})' 2>/dev/null
}

EXISTING="$(tunnel_url)"
if [ -n "$EXISTING" ]; then
  ok "ngrok already running at $EXISTING"
  if [ "$EXISTING" != "$PUBLIC_URL" ]; then
    warn "that differs from PUBLIC_URL ($PUBLIC_URL)"
    warn "stop it and re-run, or update the domain, or the redirect URI will not match"
  fi
else
  NGROK_FLAG="--url"
  ngrok http --help 2>&1 | grep -q -- '--url' || NGROK_FLAG="--domain"
  nohup ngrok http "$PORT" "$NGROK_FLAG=$NGROK_DOMAIN" > ngrok.log 2>&1 &
  for _ in $(seq 1 20); do
    sleep 1
    [ -n "$(tunnel_url)" ] && break
  done
  if [ -z "$(tunnel_url)" ]; then
    tail -20 ngrok.log || true
    die "ngrok did not come up. See ngrok.log"
  fi
  ok "tunnel up at $(tunnel_url)"
fi

# ---------------------------------------------------------------------------
step "Starting the app"
# ---------------------------------------------------------------------------

if curl -sf --max-time 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  ok "already running on port $PORT"
else
  nohup node dist/main.js > app.log 2>&1 &
  for _ in $(seq 1 20); do
    sleep 1
    curl -sf --max-time 2 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 && break
  done
  if ! curl -sf --max-time 2 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    tail -30 app.log || true
    die "the app did not start. See app.log"
  fi
  ok "app running on port $PORT"
fi

# ---------------------------------------------------------------------------
step "Verifying from the public internet"
# ---------------------------------------------------------------------------

BROWSER_UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
LEGAL_OK=1

for page in terms privacy; do
  BODY="$(curl -sL --max-time 20 -A "$BROWSER_UA" "${PUBLIC_URL}/legal/${page}" 2>/dev/null || true)"
  if printf '%s' "$BODY" | grep -qi "You are about to visit\|ngrok-free.app.*abuse\|ERR_NGROK"; then
    warn "/legal/${page} is behind ngrok's browser interstitial"
    LEGAL_OK=0
  elif printf '%s' "$BODY" | grep -qi "<title>.*\(Terms of Service\|Privacy Policy\).*</title>"; then
    ok "/legal/${page} reachable and rendering"
  else
    warn "/legal/${page} did not return the expected page"
    LEGAL_OK=0
  fi
done

if [ "$LEGAL_OK" -eq 0 ]; then
  printf '\n'
  warn "Host the legal pages statically instead:"
  printf '      node dist/cli.js legal-export ./legal-export\n'
  printf '      then publish those two files via GitHub Pages and use those URLs.\n'
fi

# ---------------------------------------------------------------------------
step "What to paste into the TikTok portal"
# ---------------------------------------------------------------------------

node dist/cli.js urls || true

cat <<NEXTEOF

${BOLD}Remaining steps only you can do:${RST}

  1. developers.tiktok.com -> Manage apps -> Connect an app
     Fill in the name and description from docs/tiktok-app-submission.md,
     and the three URLs printed above.

  2. Add products -> Content Posting API. Enable Direct Post.
     Scopes: user.info.basic, video.publish

  3. Copy the Client key and Client secret into .env:
       TIKTOK_CLIENT_KEY=...
       TIKTOK_CLIENT_SECRET=...
     then restart:  kill \$(pgrep -f 'node dist/main.js'); node dist/main.js &

  4. Link your TikTok account:
       node dist/cli.js tiktok-login
     Follow the printed URL. ${BOLD}Be signed in as the account you want to post to.${RST}

  5. Confirm the destination, then subscribe to your channel:
       node dist/cli.js whoami
       node dist/cli.js subscribe
       node dist/cli.js status

${DIM}Review queue:  http://127.0.0.1:${PORT}/
Review token:  ${REVIEW_TOKEN}
Logs:          tail -f app.log ngrok.log
Requests:      http://127.0.0.1:4040${RST}

Posts start as SELF_ONLY with review on - private to you, nothing public.
Switch to PUBLIC_TO_EVERYONE and REQUIRE_REVIEW=false after the audit clears.
NEXTEOF
