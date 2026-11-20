# 소비자 웹 이미지(BAT-087 G1, docs/frontend.md §5.18). 빌드 맥락은 저장소 뿌리다:
# docker build -f apps/web/Dockerfile -t peaket/web:demo .
# - Next.js standalone 산출물만 실행 이미지에 담는다(output: 'standalone', ASVS 13.4.1)
# - server/start.mjs가 찾는 자리(.next/standalone/apps/web/server.js, .next/static, public, server/)를 그대로 둔다
# - 결제창은 데모 시뮬레이터 빌드(NEXT_PUBLIC_PEAKET_PG_SIMULATOR=1)만 넣는다
# - 출처는 이 PC 포트(18441~18445)를 붙인 정본 이름이다(docs/review/plans/BAT-087.md B8)
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /repo
RUN npm install --global pnpm@12.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api-client/package.json packages/api-client/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ds/package.json packages/ds/
COPY packages/platform/package.json packages/platform/
COPY packages/search-normalize/package.json packages/search-normalize/
COPY packages/seatmap/package.json packages/seatmap/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/validation/package.json packages/validation/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @peaket/web...
COPY packages packages
COPY apps/web apps/web
ENV NEXT_PUBLIC_API_ORIGIN=https://api.peaket.example:18441 \
    NEXT_PUBLIC_QUEUE_ORIGIN=https://queue.peaket.example:18442 \
    NEXT_PUBLIC_QUEUE_FILES_ORIGIN=https://queue-files.peaket.example:18442 \
    NEXT_PUBLIC_PARTNER_ORIGIN=https://partner.peaket.example:18443 \
    NEXT_PUBLIC_OPS_API_ORIGIN=https://ops-api.peaket.example:18444 \
    NEXT_PUBLIC_CONSOLE_ORIGIN=https://console.peaket.example:18444 \
    NEXT_PUBLIC_SCANNER_ORIGIN=https://scanner.peaket.example:18445 \
    NEXT_PUBLIC_PEAKET_PG_SIMULATOR=1 \
    PEAKET_ENV=local \
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=cGVha2V0LWRlbW8tc2VydmVyLWFjdGlvbnMta2V5LS0=
# 점 세 개(`...`)는 작업 공간 의존 패키지(@peaket/search-normalize 등)까지 먼저 빌드한다.
# 점이 없으면 Next의 모듈 해석이 `@peaket/search-normalize/refine`을 찾지 못해 빌드가 실패한다
RUN pnpm --filter @peaket/web... build \
 && mkdir -p /out-next \
 && for p in next redis @redis; do if [ -e "apps/web/node_modules/$p" ]; then cp -aL "apps/web/node_modules/$p" /out-next/; fi; done

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
# 데모 전용 상수. 빌드와 같은 값이어야 한다(tools/local/demo-objects.mjs의 DEMO_SERVER_ACTIONS_KEY)
ENV NODE_ENV=production \
    PEAKET_ENV=local \
    PEAKET_NEXT_DIST=.next \
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=cGVha2V0LWRlbW8tc2VydmVyLWFjdGlvbnMta2V5LS0=
WORKDIR /app/apps/web
COPY --from=build --chown=node:node /repo/apps/web/.next ./.next
COPY --from=build --chown=node:node /repo/apps/web/public ./public
COPY --from=build --chown=node:node /repo/apps/web/server ./server
COPY --from=build --chown=node:node /repo/apps/web/package.json ./package.json
# start.mjs가 createRequire(appDir)로 next·redis를 찾는다. standalone이 추적한 node_modules를 앱 폴더에 둔다
RUN mkdir -p node_modules && cp -a .next/standalone/node_modules/. node_modules/
COPY --from=build --chown=node:node /out-next/. ./node_modules/
USER node
EXPOSE 3000
CMD ["node", "server/start.mjs", "--port", "3000", "--host", "0.0.0.0"]
