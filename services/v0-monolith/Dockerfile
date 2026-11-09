# v0 모놀리스 이미지(docs/infra.md §3 'v0 배포', wbs 1.1.4). 앱(dist/main.js)과 입구(dist/gateway/main.js)가 같은 이미지라 배포 단위는 하나다.
# 빌드 맥락은 저장소 뿌리다: docker build -f services/v0-monolith/Dockerfile -t peaket/v0-monolith:local .
# - 기본 이미지는 다이제스트로 고정한다(여러 플랫폼 목록의 다이제스트, amd64·arm64 둘 다). 서비스 뼈대(packages/platform/template/Dockerfile)와 같다
# - 의존성은 잠금 파일대로만 설치한다(--frozen-lockfile, 설치 스크립트 허용 목록은 pnpm-workspace.yaml)
# - 미리 빌드한 Kafka 바인딩(플랫폼 패키지가 끌고 온다)은 게시 다이제스트와 견준 뒤에만 실행 단계로 옮긴다(docs/devops.md §4.4)
# - 실행 이미지에는 빌드 도구·원본·시험·.git이 없다(.dockerignore, ASVS v5.0.0-13.4.1). 비밀은 빌드 인자로 넘기지 않는다
# - payment-svc는 v0가 쓰는 공개 면(결제 포트·시뮬레이터, src/modules/payment/index.ts)만 컴파일한다(build:lib). 서버 쪽과 packages/contracts는 v0에 필요 없다(BUILD_ORDER PRF-180 코드 리뷰)
# 시작 명령: 앱   node --import @peaket/platform/telemetry/register dist/main.js
#           입구 node dist/gateway/main.js
#           마이그레이션 잡 node scripts/migrate.mjs
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /repo
RUN npm install --global pnpm@12.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/invariant-checker/package.json services/invariant-checker/
COPY services/pg-simulator/package.json services/pg-simulator/
COPY services/payment-svc/package.json services/payment-svc/
COPY services/v0-monolith/package.json services/v0-monolith/
RUN pnpm install --frozen-lockfile --filter @peaket/v0-monolith --filter @peaket/payment-svc --filter @peaket/platform --filter @peaket/config
COPY packages/config packages/config
COPY packages/platform packages/platform
COPY services/payment-svc services/payment-svc
COPY services/v0-monolith services/v0-monolith
COPY tools/ci/verify-native-binding.mjs tools/ci/
RUN pnpm --filter @peaket/platform build \
 && pnpm --filter @peaket/payment-svc build:lib \
 && pnpm --filter @peaket/v0-monolith build \
 && pnpm --filter @peaket/v0-monolith deploy --prod --legacy /out \
 && node tools/ci/verify-native-binding.mjs /out --expect \
 && cd /out \
 && rm -rf src test test-int tsconfig.json tsconfig.build.json tsconfig.web.json vitest.config.mjs vitest.integration.config.mjs \
           drizzle.config.ts Dockerfile scripts/local-demo.mjs scripts/local-gateway.mjs \
 && cd node_modules/.pnpm/@peaket+payment-svc@*/node_modules/@peaket/payment-svc \
 && rm -rf src test test-int scripts migrations drizzle.config.ts tsconfig.json tsconfig.build.json tsconfig.lib.json tsconfig.drizzle.json \
           vitest.config.mjs vitest.integration.config.mjs

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 8080 8443 9464
CMD ["node", "--import", "@peaket/platform/telemetry/register", "dist/main.js"]
