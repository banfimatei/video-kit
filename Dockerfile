# video-kit render service. Build context: the repo root (library + service).
FROM node:22-bookworm-slim

# Chrome Headless Shell's shared libraries (Remotion's Linux list), espeak-ng
# for the offline voice, fonts so emoji and non-Latin scripts (CJK included)
# don't render as boxes, and dumb-init as PID 1: it reaps the Chrome
# processes Remotion leaves behind, and turns the SIGTERM a redeploy sends
# into SIGUSR2, which the service takes as "finish running renders, then
# exit" (Remotion itself kills its browsers on SIGTERM).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates dumb-init libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 \
      libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 \
      libcairo2 libcups2 espeak-ng fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies and the headless browser first, in their own layers, so a
# change to the service doesn't reinstall them. npm ci runs the library's
# `prepare` (its build) through the service's file:.. link, so the library's
# own source comes along.
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY service/package.json service/
COPY src src
COPY assets assets
RUN npm ci

# Set to 1 only where remotion.media is unreachable (then provide
# REMOTION_BROWSER_EXECUTABLE at runtime). Railway leaves it at 0.
ARG SKIP_BROWSER_DOWNLOAD=0
RUN if [ "$SKIP_BROWSER_DOWNLOAD" != "1" ]; then cd service && npx remotion browser ensure; fi

# Build the service and bundle the built-in templates.
COPY . .
RUN npm run build --workspace service \
 && npm run bundle --workspace service

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
EXPOSE 8080
WORKDIR /app/service
ENTRYPOINT ["/usr/bin/dumb-init", "--single-child", "--rewrite", "15:12", "--"]
CMD ["node", "dist/src/index.js"]
