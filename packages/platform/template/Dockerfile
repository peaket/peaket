# 서비스 이미지 뼈대(docs/devops.md §3.1 build-image.yml ①, §4.1). 서비스는 이 파일을 옮겨 SERVICE·시작 파일만 바꾼다.
# 빌드 맥락은 저장소 뿌리다: docker build -f packages/platform/template/Dockerfile -t peaket/example-svc:local .
# - 기본 이미지는 다이제스트로 고정한다(여러 플랫폼 목록의 다이제스트, amd64·arm64 둘 다)
# - 의존성은 잠금 파일대로만 설치한다(--frozen-lockfile, 설치 스크립트 허용 목록은 pnpm-workspace.yaml)
# - 미리 빌드한 Kafka 바인딩은 게시 다이제스트와 견준 뒤에만 실행 단계로 옮긴다(docs/devops.md §4.4, tools/ci/verify-native-binding.mjs)
# - 실행 이미지에는 빌드 도구·원본·.git이 없다(.dockerignore, ASVS v5.0.0-13.4.1). 비밀은 빌드 인자로 넘기지 않는다
# 시작 명령: 서비스 node --import @peaket/platform/telemetry/register template/dist/main.js
#           Outbox 릴레이(같은 이미지·다른 명령) node --import @peaket/platform/telemetry/register template/dist/relay.js
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /repo
RUN npm install --global pnpm@12.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
RUN pnpm install --frozen-lockfile --filter @peaket/platform --filter @peaket/config
COPY packages/config packages/config
COPY packages/platform packages/platform
COPY tools/ci/verify-native-binding.mjs tools/ci/
RUN pnpm --filter @peaket/platform build \
 && pnpm --dir packages/platform exec tsc -p template/tsconfig.build.json \
 && pnpm --filter @peaket/platform deploy --prod --legacy /out \
 && node tools/ci/verify-native-binding.mjs /out --expect \
 && cd /out \
 && rm -rf src test test-int tsconfig.json tsconfig.build.json vitest.config.mjs vitest.integration.config.mjs \
           template/src template/Dockerfile template/tsconfig.build.json template/drizzle.config.ts

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ENV NODE_ENV=production
# Kafka 클라이언트(librdkafka)는 TLS 인증서 검증에 시스템 CA 묶음을 쓰는데 기본 이미지에는 없다. 없으면 MSK(TLS)에 붙지 못한다
# (2026-11-01 코드 리뷰, openspec 변경 add-foundation-poc). Node 자체는 내장 CA를 써서 이것과 상관없다
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 8080 9464
CMD ["node", "--import", "@peaket/platform/telemetry/register", "template/dist/main.js"]
