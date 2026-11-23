# alert-issue-relay 이미지(기능 F-01-6). 빌드 맥락은 저장소 뿌리다:
# docker build -f services/alert-issue-relay/Dockerfile -t peaket/alert-issue-relay:local .
# - 기본 이미지·설치·실행 이미지 규칙은 packages/platform/template/Dockerfile과 같다
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /repo
RUN npm install --global pnpm@12.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/platform/package.json packages/platform/
COPY services/alert-issue-relay/package.json services/alert-issue-relay/
RUN pnpm install --frozen-lockfile --filter @peaket/alert-issue-relay... --filter @peaket/config
COPY packages/config packages/config
COPY packages/platform packages/platform
COPY services/alert-issue-relay services/alert-issue-relay
COPY tools/ci/verify-native-binding.mjs tools/ci/
RUN pnpm --filter @peaket/platform build \
  && pnpm --filter @peaket/alert-issue-relay build \
  && pnpm --filter @peaket/alert-issue-relay deploy --prod --legacy /out \
  && node tools/ci/verify-native-binding.mjs /out --expect \
  && cd /out \
  && rm -rf src test tsconfig.json tsconfig.build.json vitest.config.mjs Dockerfile

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 8080 9464
CMD ["node", "--import", "@peaket/platform/telemetry/register", "dist/main.js"]
