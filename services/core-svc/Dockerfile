# core-svc 이미지(BAT-087 G1). 빌드 맥락은 저장소 뿌리다:
# docker build -f services/core-svc/Dockerfile -t peaket/core-svc:demo .
# - 기본 이미지·설치·실행 이미지 규칙은 packages/platform/template/Dockerfile과 같다
# - 좌석맵 작업자(seatmap-worker)는 같은 이미지의 다른 명령(node dist/seatmap-worker/main.js)으로 띄운다
# - seed/seatmap-templates는 배포 때 넣는 정적 JSON이라 실행 이미지에 남긴다
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /repo
RUN npm install --global pnpm@12.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY packages/search-normalize/package.json packages/search-normalize/
COPY packages/validation/package.json packages/validation/
COPY services/core-svc/package.json services/core-svc/
RUN pnpm install --frozen-lockfile --filter @peaket/core-svc... --filter @peaket/config
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY packages/platform packages/platform
COPY packages/search-normalize packages/search-normalize
COPY packages/validation packages/validation
COPY services/core-svc services/core-svc
COPY tools/ci/verify-native-binding.mjs tools/ci/
RUN pnpm --filter @peaket/platform build \
 && pnpm --filter @peaket/contracts build \
 && pnpm --filter @peaket/validation build \
 && pnpm --filter @peaket/search-normalize build \
 && pnpm --filter @peaket/core-svc build \
 && pnpm --filter @peaket/core-svc deploy --prod --legacy /out \
 && node tools/ci/verify-native-binding.mjs /out --expect \
 && cd /out \
 && rm -rf src test test-int tsconfig.json tsconfig.build.json vitest.config.mjs vitest.integration.config.mjs drizzle.config.ts Dockerfile

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 8080 9464 50051
CMD ["node", "--import", "@peaket/platform/telemetry/register", "dist/main.js"]
