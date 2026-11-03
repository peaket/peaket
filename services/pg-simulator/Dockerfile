# PG 시뮬레이터 이미지(결제사 대역, 데모 전용 이미지, docs/features/payment.md §2.1, docs/infra.md §3 'v0 배포').
# 운영·스테이징 네임스페이스에는 Kyverno 정책이 이 이미지를 거부한다(docs/devops.md §4.3). PEAKET_ENV가 local·ci·demo·staging이 아니면 시작하지 않는다.
# 빌드 맥락은 저장소 뿌리다: docker build -f services/pg-simulator/Dockerfile -t peaket/pg-simulator:local .
# 기본 이미지는 다이제스트로 고정하고, 의존성은 잠금 파일대로만 설치하며, 실행 이미지에는 원본·시험이 없다(ASVS v5.0.0-13.4.1).
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /repo
RUN npm install --global pnpm@12.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY services/pg-simulator/package.json services/pg-simulator/
RUN pnpm install --frozen-lockfile --filter @peaket/pg-simulator --filter @peaket/config
COPY packages/config packages/config
COPY services/pg-simulator services/pg-simulator
RUN pnpm --filter @peaket/pg-simulator build \
 && pnpm --filter @peaket/pg-simulator deploy --prod --legacy /out \
 && cd /out \
 && rm -rf src test tsconfig.json tsconfig.build.json vitest.config.mjs Dockerfile

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 8790
CMD ["node", "dist/main.js"]
