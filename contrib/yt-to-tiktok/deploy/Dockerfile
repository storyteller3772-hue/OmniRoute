# Build:  docker build -f deploy/Dockerfile -t yt-to-tiktok .
# Run:    docker run -d --name yt2tt --env-file .env \
#           -p 8787:8787 \
#           -v "$PWD/data:/app/data" \
#           -v /path/to/masters:/app/data/masters:ro \
#           yt-to-tiktok

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app

# FFmpeg is the one system dependency; node:sqlite is built into the runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# The masters mount is read-only; only ./data is written.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV WORK_DIR=/app/data/work
ENV HOST=0.0.0.0
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
