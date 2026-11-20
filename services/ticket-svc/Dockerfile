# ticket-svc 이미지(BAT-087 G1). 빌드 맥락은 저장소 뿌리다:
# docker build -f services/ticket-svc/Dockerfile -t peaket/ticket-svc:demo .
# - 기본 이미지·설치·실행 이미지 규칙은 packages/platform/template/Dockerfile과 같다
# - 마이그레이션은 같은 이미지의 scripts/migrate.mjs로 부른다
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /repo
RUN npm install --global pnpm@12.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/ticket-svc/package.json services/ticket-svc/
RUN pnpm install --frozen-lockfile --filter @peaket/ticket-svc... --filter @peaket/config
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY packages/platform packages/platform
COPY services/ticket-svc services/ticket-svc
COPY tools/ci/verify-native-binding.mjs tools/ci/
RUN pnpm --filter @peaket/platform build \
 && pnpm --filter @peaket/contracts build \
 && pnpm --filter @peaket/ticket-svc build \
 && pnpm --filter @peaket/ticket-svc deploy --prod --legacy /out \
 && node tools/ci/verify-native-binding.mjs /out --expect \
 && cd /out \
 && rm -rf src test test-int tsconfig.json tsconfig.build.json vitest.config.mjs vitest.integration.config.mjs Dockerfile

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
