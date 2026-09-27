# video-kit render service. Build context: the repo root (library + service).
FROM node:22-bookworm-slim

# Chrome Headless Shell's shared libraries (Remotion's Linux list), espeak-ng
# for the offline voice, and fonts so emoji and non-Latin glyphs don't render
# as boxes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 \
      libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 \
      libcairo2 libcups2 espeak-ng fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Set to 1 only where remotion.media is unreachable (then provide
# REMOTION_BROWSER_EXECUTABLE at runtime). Railway leaves it at 0.
ARG SKIP_BROWSER_DOWNLOAD=0

# npm ci runs the library's `prepare` (its build); then build the service,
# bundle its built-in templates, and download the headless browser at build
# time so a cold start never has to.
RUN npm ci \
 && npm run build --workspace service \
 && npm run bundle --workspace service \
 && if [ "$SKIP_BROWSER_DOWNLOAD" != "1" ]; then cd service && npx remotion browser ensure; fi

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
EXPOSE 8080
WORKDIR /app/service
CMD ["node", "dist/src/index.js"]
