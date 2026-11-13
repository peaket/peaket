# ops-svc 이미지(platform 템플릿 기반, GAT-110 첫 몫). 빌드 맥락은 저장소 뿌리다:
# docker build -f services/ops-svc/Dockerfile -t peaket/ops-svc:local .
# - 기본 이미지는 template/Dockerfile과 같은 다이제스트로 고정한다(amd64·arm64 목록의 다이제스트)
# - 의존성은 잠금 파일대로만 설치한다(--frozen-lockfile, 설치 스크립트 허용 목록은 pnpm-workspace.yaml)
# - 실행 이미지에는 빌드 도구·원본·.git이 없다(ASVS v5.0.0-13.4.1). 비밀은 빌드 인자로 넘기지 않는다
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /repo
RUN npm install --global pnpm@12.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/ops-svc/package.json services/ops-svc/
RUN pnpm install --frozen-lockfile --filter @peaket/ops-svc... --filter @peaket/config
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY packages/platform packages/platform
COPY services/ops-svc services/ops-svc
COPY tools/ci/verify-native-binding.mjs tools/ci/
RUN pnpm --filter @peaket/platform build \
 && pnpm --filter @peaket/contracts build \
 && pnpm --filter @peaket/ops-svc build \
 && pnpm --filter @peaket/ops-svc deploy --prod --legacy /out \
 && node tools/ci/verify-native-binding.mjs /out --expect \
 && cd /out \
 && rm -rf src test test-int tsconfig.json tsconfig.build.json vitest.config.mjs vitest.integration.config.mjs Dockerfile

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ENV NODE_ENV=production
# Kafka 클라이언트(librdkafka)는 TLS 인증서 검증에 시스템 CA 묶음을 쓴다. 기본 이미지에는 없어 넣는다(템플릿과 같은 이유)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 8080 9464
CMD ["node", "--import", "@peaket/platform/telemetry/register", "dist/main.js"]
