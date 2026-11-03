# V-T41 비교 앱 이미지(loadtest/poc/README.md). 빌드 맥락은 저장소 뿌리다:
#   docker build -f packages/platform/bench/vt41/Dockerfile -t peaket/poc-vt41:local .
# 기본 이미지와 pnpm 판은 서비스 뼈대(packages/platform/template/Dockerfile)와 같다. 측정용이라 단계를 나누지 않는다.
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
WORKDIR /repo
RUN npm install --global pnpm@12.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
RUN pnpm install --frozen-lockfile --filter @peaket/platform --filter @peaket/config --filter @peaket/contracts
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY packages/platform packages/platform
RUN pnpm --filter @peaket/contracts build && pnpm --dir packages/platform exec tsc -p bench/vt41/tsconfig.json
WORKDIR /repo/packages/platform/bench/vt41
ENV NODE_ENV=production
EXPOSE 8080 9465
CMD ["node", "dist/bench/vt41/src/main.js"]
