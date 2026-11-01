# wbs 0.5.1 PoC 측정 도구 이미지(loadtest/poc/README.md). GLIDE가 Windows 실행 파일을 내지 않아 Linux 컨테이너에서 돈다.
# 기본 이미지는 서비스 뼈대(packages/platform/template/Dockerfile)와 같은 다이제스트, pnpm은 뿌리 packageManager와 같은 판이다.
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
RUN npm install --global pnpm@12.16.0
WORKDIR /bench
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY lua ./lua
COPY src ./src
ENTRYPOINT ["node"]
