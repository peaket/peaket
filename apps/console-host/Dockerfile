# 관제 콘솔 호스트 이미지(BAT-087 G1). 빌드 맥락은 저장소 뿌리다:
# docker build -f apps/console-host/Dockerfile -t peaket/console-host:demo .
# - webpack 산출물(dist/)을 고정 nginx(루트 아님)로 서빙한다. API 주소는 빌드 때 굳는다
# - widgets는 작업 공간 패키지로 이 앱에 묶인다(별 이미지 없음)
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /repo
RUN npm install --global pnpm@12.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api-client/package.json packages/api-client/
COPY packages/config/package.json packages/config/
COPY packages/ds/package.json packages/ds/
COPY packages/seatmap/package.json packages/seatmap/
COPY apps/widgets/purchase/package.json apps/widgets/purchase/
COPY apps/widgets/queue/package.json apps/widgets/queue/
COPY apps/console-host/package.json apps/console-host/
RUN pnpm install --frozen-lockfile --filter @peaket/console-host...
COPY packages packages
COPY apps/widgets apps/widgets
COPY apps/console-host apps/console-host
ENV PEAKET_ENV=local \
    PEAKET_OPS_API_ORIGIN=https://ops-api.peaket.example:18444 \
    PEAKET_SCANNER_ORIGIN=https://scanner.peaket.example:18445
RUN pnpm --filter @peaket/console-host build

FROM nginxinc/nginx-unprivileged:1.29.3-alpine@sha256:5aea7cc516b419e3526f47dd1531be31a56a046cfe44754d94f9383e13e2ee99
COPY deploy/local/demo/nginx/console-host.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/console-host/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
