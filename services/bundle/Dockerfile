# 한 프로세스 합본 이미지(docs/verification.md §3.8 '합본의 v1 무대', BUILD_ORDER PRF-215, ADR-0262 결정 4). 합본과 그 릴레이가 같은 이미지다.
# 빌드 맥락은 저장소 뿌리다: docker build -f services/bundle/Dockerfile -t peaket/bundle:local .
# - 기본 이미지는 v0 모놀리스(services/v0-monolith/Dockerfile)와 같은 다이제스트로 고정한다(여러 플랫폼 목록의 다이제스트, amd64·arm64 둘 다)
# - 의존성은 잠금 파일대로만 설치한다(--frozen-lockfile, 설치 스크립트 허용 목록은 pnpm-workspace.yaml)
# - 미리 빌드한 Kafka 바인딩(플랫폼 패키지가 끌고 온다)은 게시 다이제스트와 견준 뒤에만 실행 단계로 옮긴다(docs/devops.md §4.4)
# - 실행 이미지에는 빌드 도구·원본·시험·.git이 없다(.dockerignore, ASVS v5.0.0-13.4.1). 비밀은 빌드 인자로 넘기지 않는다(시험 키는 kind의 Secret으로만)
# - 시험 도구다: 합본은 PEAKET_ENV local·ci에서만 시작한다(src/bundle.ts). 운영 배포 단위가 아니다
# 시작 명령: 합본        node --import @peaket/platform/telemetry/register dist/main.js
#           릴레이        node --import @peaket/platform/telemetry/register node_modules/@peaket/purchase-svc/dist/relay.js (payment-svc도 같은 꼴)
#           마이그레이션  node node_modules/@peaket/purchase-svc/scripts/migrate.mjs (payment-svc도 같은 꼴, 그 패키지 폴더에서)
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /repo
RUN npm install --global pnpm@12.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY packages/shuffle/package.json packages/shuffle/
COPY packages/validation/package.json packages/validation/
COPY services/pg-simulator/package.json services/pg-simulator/
COPY services/queue-svc/package.json services/queue-svc/
COPY services/admission-ctrl/package.json services/admission-ctrl/
COPY services/purchase-svc/package.json services/purchase-svc/
COPY services/payment-svc/package.json services/payment-svc/
COPY services/bundle/package.json services/bundle/
RUN pnpm install --frozen-lockfile --filter @peaket/bundle... --filter @peaket/config
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY packages/platform packages/platform
COPY packages/shuffle packages/shuffle
COPY packages/validation packages/validation
COPY services/pg-simulator services/pg-simulator
COPY services/queue-svc services/queue-svc
COPY services/admission-ctrl services/admission-ctrl
COPY services/purchase-svc services/purchase-svc
COPY services/payment-svc services/payment-svc
COPY services/bundle services/bundle
COPY tools/ci/verify-native-binding.mjs tools/ci/
RUN pnpm --filter @peaket/platform build \
 && pnpm --filter @peaket/contracts build \
 && pnpm --filter @peaket/validation build \
 && pnpm --filter @peaket/shuffle build \
 && pnpm --filter @peaket/queue-svc build \
 && pnpm --filter @peaket/admission-ctrl build \
 && pnpm --filter @peaket/purchase-svc build \
 && pnpm --filter @peaket/payment-svc build \
 && pnpm --filter @peaket/bundle build \
 && pnpm --filter @peaket/bundle deploy --prod --legacy /out \
 && node tools/ci/verify-native-binding.mjs /out --expect \
 && cd /out \
 && rm -rf src test test-int tsconfig.json tsconfig.build.json vitest.config.mjs vitest.integration.config.mjs Dockerfile \
 && for d in node_modules/.pnpm/@peaket+*/node_modules/@peaket/*; do \
      (cd "$d" && rm -rf src test test-int test-sim edge tsconfig*.json vitest*.mjs drizzle.config.ts Dockerfile); \
    done

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 8080 8081 8082 8084 9464 50051
CMD ["node", "--import", "@peaket/platform/telemetry/register", "dist/main.js"]
