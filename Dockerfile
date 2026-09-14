FROM node:22-slim AS build

ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY requirements-media.lock /tmp/requirements-media.lock
RUN python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --require-hashes -r /tmp/requirements-media.lock \
    && rm /tmp/requirements-media.lock

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts/reels-smoke.mjs ./scripts/reels-smoke.mjs
COPY scripts/news-smoke.mjs ./scripts/news-smoke.mjs

USER node
CMD ["node", "dist/index.js"]
