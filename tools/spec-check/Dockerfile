# 규칙 모델 검사 실행 이미지(wbs 0.9.1, tools/spec-check/README.md). 이 PC(Windows)에는 Java가 없고 Quint Rust 평가기도 Linux 실행 파일을
# 쓰는 편이 CI(ubuntu)와 같아서, 로컬은 이 컨테이너 안에서 돌린다. CI는 같은 스크립트를 러너에서 바로 돌린다(.github/workflows/spec-check.yml).
# - Java: Temurin 21 JRE(Apalache 0.62.x는 Java 17 이상). Node 기본 이미지는 서비스 뼈대와 같은 다이제스트, pnpm은 뿌리 packageManager와 같은 판
# - Apalache 묶음(TLC 포함)과 평가기는 fetch-tools.mjs가 고정 해시로 받아 QUINT_HOME에 둔다
FROM eclipse-temurin:21-jre-noble@sha256:0eda5830ed7b669abc246a8dc520ea8a23cab06f9a8d4b6964109e2f2394e46f AS jre
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
COPY --from=jre /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk PATH=/opt/java/openjdk/bin:$PATH QUINT_HOME=/opt/quint-home
RUN npm install --global pnpm@12.16.0
WORKDIR /opt/spec-check
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY fetch-tools.mjs ./
RUN node fetch-tools.mjs && java -version
ENV QUINT_BIN=/opt/spec-check/node_modules/@informalsystems/quint/dist/src/cli.js
WORKDIR /repo
ENTRYPOINT ["node"]
