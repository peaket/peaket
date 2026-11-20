# identity-svc 이미지(BAT-087 G1). 빌드 맥락은 저장소 뿌리다:
# docker build -f services/identity-svc/Dockerfile -t peaket/identity-svc:demo .
# - 기본 이미지는 packages/platform/template/Dockerfile과 같은 다이제스트로 고정한다
# - 의존성은 잠금 파일대로만 설치한다(--frozen-lockfile)
# - 실행 이미지에는 빌드 도구·원본·시험·.git이 없다(ASVS v5.0.0-13.4.1). 비밀은 빌드 인자로 넘기지 않는다
# - 부트스트랩(scripts/seed-demo.mjs)과 마이그레이션(scripts/migrate.mjs)은 같은 이미지에서 다른 명령으로 부른다
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /repo
RUN npm install --global pnpm@12.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/identity-svc/package.json services/identity-svc/
RUN pnpm install --frozen-lockfile --filter @peaket/identity-svc... --filter @peaket/config
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY packages/platform packages/platform
COPY services/identity-svc services/identity-svc
COPY tools/ci/verify-native-binding.mjs tools/ci/
RUN pnpm --filter @peaket/platform build \
 && pnpm --filter @peaket/contracts build \
 && pnpm --filter @peaket/identity-svc build \
 && pnpm --filter @peaket/identity-svc deploy --prod --legacy /out \
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
