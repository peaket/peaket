# 현장 스캐너 PWA 이미지(BAT-087 G1). 빌드 맥락은 저장소 뿌리다:
# docker build -f apps/scanner/Dockerfile -t peaket/scanner:demo .
# - Vite 산출물(dist/)을 고정 nginx(루트 아님)로 서빙한다. SPA fallback은 nginx 설정에 있다
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /repo
RUN npm install --global pnpm@12.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/ds/package.json packages/ds/
COPY apps/scanner/package.json apps/scanner/
RUN pnpm install --frozen-lockfile --filter @peaket/scanner...
COPY packages packages
COPY apps/scanner apps/scanner
ENV PEAKET_ENV=local \
    VITE_SCANNER_API_ORIGIN=https://scanner-api.peaket.example:18445
RUN pnpm --filter @peaket/scanner build

FROM nginxinc/nginx-unprivileged:1.29.3-alpine@sha256:5aea7cc516b419e3526f47dd1531be31a56a046cfe44754d94f9383e13e2ee99
COPY deploy/local/demo/nginx/scanner.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/scanner/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
