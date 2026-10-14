# BeatBlade – Multi-Stage-Build: Core + Server + Web bauen, schlankes Laufzeit-Image mit ffmpeg.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
ARG BASE_PATH=/beatblade
RUN BASE_PATH=$BASE_PATH pnpm build
# mitgelieferte CC-BY-Songs laden (Lizenz/Quelle in seed-songs/credits.json)
RUN node scripts/download-seeds.mjs seed-songs || true
# nur Laufzeit-Abhaengigkeiten behalten
RUN rm -rf node_modules packages/*/node_modules apps/*/node_modules && CI=true pnpm install --prod --frozen-lockfile

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl && rm -rf /var/lib/apt/lists/*
# YouTube-Import: yt-dlp als eigenstaendiges Programm (aktualisiert sich beim Serverstart selbst, yt-dlp -U)
ARG TARGETARCH
RUN set -e; case "${TARGETARCH:-amd64}" in arm64) f=yt-dlp_linux_aarch64 ;; *) f=yt-dlp_linux ;; esac; \
    curl -fsSL -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$f" && chmod 755 /usr/local/bin/yt-dlp
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production DATA_DIR=/data SEED_DIR=/app/seed-songs WEB_DIR=/app/apps/web/dist PORT=3000 BASE_PATH=/beatblade
VOLUME /data
EXPOSE 3000
WORKDIR /app/apps/server
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+process.env.BASE_PATH+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
