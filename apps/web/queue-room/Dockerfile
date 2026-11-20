# 대기실 경량 페이지 이미지(BAT-087 G1, ADR-0220). 빌드 맥락은 저장소 뿌리다:
# docker build -f apps/web/queue-room/Dockerfile -t peaket/queue-room:demo .
# - base '/_q/' 산출물을 nginx로 서빙하고, 대기실 경로 세 가지를 셸로 바꾼다(^/queue/{id}/verify는 잡지 않는다)
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /repo
RUN npm install --global pnpm@12.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/ds/package.json packages/ds/
COPY apps/web/queue-room/package.json apps/web/queue-room/
RUN pnpm install --frozen-lockfile --filter @peaket/queue-room...
COPY packages packages
COPY apps/web/queue-room apps/web/queue-room
RUN pnpm --filter @peaket/queue-room build

FROM nginxinc/nginx-unprivileged:1.29.3-alpine@sha256:5aea7cc516b419e3526f47dd1531be31a56a046cfe44754d94f9383e13e2ee99
COPY deploy/local/demo/nginx/queue-room.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/queue-room/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
