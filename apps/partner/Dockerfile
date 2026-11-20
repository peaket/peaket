# 파트너 콘솔 이미지(BAT-087 G1, docs/frontend.md §5.18). 빌드 맥락은 저장소 뿌리다:
# docker build -f apps/partner/Dockerfile -t peaket/partner:demo .
# - Next.js standalone 산출물만 담고, 정적 자산과 public을 standalone의 같은 자리에 복사한다
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /repo
RUN npm install --global pnpm@12.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api-client/package.json packages/api-client/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ds/package.json packages/ds/
COPY packages/platform/package.json packages/platform/
COPY packages/seatmap/package.json packages/seatmap/
COPY packages/validation/package.json packages/validation/
COPY apps/partner/package.json apps/partner/
RUN pnpm install --frozen-lockfile --filter @peaket/partner...
COPY packages packages
COPY apps/partner apps/partner
ENV NEXT_PUBLIC_PARTNER_API_ORIGIN=https://partner-api.peaket.example:18443 \
    PEAKET_ENV=local
RUN pnpm --filter @peaket/partner build \
 && mkdir -p apps/partner/.next/standalone/apps/partner/.next \
 && cp -a apps/partner/.next/static apps/partner/.next/standalone/apps/partner/.next/static \
 && cp -a apps/partner/public apps/partner/.next/standalone/apps/partner/public

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ENV NODE_ENV=production \
    PEAKET_ENV=local \
    PORT=3001 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/partner/.next/standalone ./
USER node
EXPOSE 3001
CMD ["node", "apps/partner/server.js"]
