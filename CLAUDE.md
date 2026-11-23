# PEAKET(피켓)

100만 명이 한꺼번에 몰려도 멈추지 않는 공연 티켓 예매·관제 시스템. 문서·코드·배포 상태·부하 시험을 한 저장소에 담은 pnpm + Turborepo 모노레포다.

## 큰 그림

- `services/`: NestJS 12 + Fastify 5 서버. 업무 서비스 10개(queue-svc·admission-ctrl·purchase-svc·payment-svc·ticket-svc·realtime-gw·identity-svc·trust-svc·ops-svc·core-svc)와 보조 넷이다. `v0-monolith`는 v1과 견줄 단순한 비교 기준, `bundle`은 local·ci 전용 한 프로세스 합본 측정 무대(둘 다 운영에 배포하지 않음), `pg-simulator`는 결제사 흉내 서버, `invariant-checker`는 시험 뒤 DB를 대조해 오버셀·이중 결제 등을 센다.
- 서비스 안: 바운디드 컨텍스트 하나가 Nest 모듈 하나이고 `inbound → application → domain`, 포트 구현은 `adapters`다. 의존은 안쪽으로만, 다른 컨텍스트는 그 모듈의 `index.ts`로만 가져온다(`pnpm lint`가 막는다).
- 서비스 사이: REST는 외부 클라이언트 ↔ API 게이트웨이 구간에만 쓴다. 내부 동기 호출은 gRPC, 거래 이벤트는 Kafka(PostgreSQL Transactional Outbox, 파티션 키는 회차 ID), 좌석 변경분은 purchase-svc → realtime-gw Redis 샤드 Pub/Sub, 관제 명령은 ops-svc → admission-ctrl·purchase-svc 제어 gRPC다(`docs/architecture.md` §3.2).
- 게이트웨이는 클라이언트 종류별 다섯(gw-queue·gw-fan·gw-partner·gw-ops·gw-scanner, Envoy Gateway)이다. 팬 트래픽은 관제(ops-svc)에 직접 닿지 않는다.
- `packages/platform`: 모든 서비스의 공용 뼈대(계측·오류 응답·남은 시간 전파·로그). 새 서비스는 `packages/platform/template/`를 복사해 시작한다. 서비스는 빌드된 `dist/`를 읽으므로 platform을 바꾸면 build가 필요하다(Vitest는 별칭으로 원본을 읽는다).
- 계약 원본은 `docs/api/`(openapi·asyncapi·proto·avro)다. `packages/contracts`(Zod 스키마·타입)와 `packages/api-client`(화면 클라이언트·MSW 처리기)는 그 생성물이다.
- `apps/`: 팬 웹·파트너 콘솔(Next), 관제 콘솔 호스트(webpack)와 원격 위젯(`apps/widgets/*`), 스캐너·대기실(`apps/web/queue-room`)·포렌식(Vite). 화면 공용은 `ds`(디자인 토큰·부품), `seatmap`, `telemetry`, `validation`, `console-contract`.
- `deploy/`(Helm 차트·환경 값·Kyverno 정책, Argo CD가 `develop`에서 읽음), `infra/`(Terraform), `loadtest/`(k6·카오스), `tools/local/`(로컬·CI kind 클러스터), `tools/ci/`(CI 검사 스크립트, 각자 `*.test.mjs`), `tools/claude-hooks/`(에이전트 훅: 남의 변경을 섞거나 날리는 git 명령·강제 푸시·생성 파일 편집을 막는다, ADR-0330. 막히면 그 까닭대로 고친다).
- 의존 선언 밖 상대 경로 가져오기가 있다: purchase-svc 시험은 payment-svc·pg-simulator 원본을, core-svc 통합 시험은 `packages/seatmap/src`를, ops-svc 통합 시험은 admission-ctrl·purchase-svc·queue-svc·trust-svc·ops-rt 원본을(F-02-1 제어 E2E는 세 서비스를 실제로 띄운다) 읽는다. 그쪽을 고치면 가져오는 서비스도 타입 검사하고, ops-svc는 통합 시험까지 돌린다(`--affected`가 못 잡는다).

## 자주 쓰는 명령

Node 24(`.nvmrc`), pnpm 12(루트 `package.json`의 `packageManager`에 고정). 모두 저장소 뿌리에서 실행한다.

```bash
corepack pnpm install --frozen-lockfile   # 설치(잠금 파일대로만)
pnpm build                                # turbo run build
pnpm typecheck                            # turbo run typecheck (먼저 의존 패키지를 build한다)
pnpm lint                                 # 뿌리 ESLint: 서비스 층 의존 방향, 서비스·화면 보안 규칙, 브라우저 지원
pnpm test                                 # turbo run test (모든 작업 공간의 단위 시험)
pnpm exec turbo run typecheck test build  # CI(ci-node)의 전체 실행과 같다
pnpm exec turbo run typecheck --filter=@peaket/core-svc   # 패키지 하나만
```

시험 하나만 돌리기:

```bash
# Vitest(services/*, packages/* 대부분): 단위 시험은 test/**/*.test.ts
pnpm --filter @peaket/queue-svc test test/admission-jwks.test.ts
# 통합 시험(test-int/**/*.int.test.ts): Docker 엔진이 필요하다. 없으면 건너뛰지 않고 실패한다
pnpm exec turbo run build --filter=@peaket/core-svc^...   # 통합 시험 전에 의존 패키지 dist를 만든다(CI와 같은 순서)
pnpm --filter @peaket/queue-svc test:integration test-int/admission-store.int.test.ts
# node --test(apps/*, packages/ds·config, tools/*): 그 작업 공간 폴더 기준 경로
pnpm --filter @peaket/web exec node --test src/entities/inquiry/model.test.mjs
node --test "tools/ci/*.test.mjs"
```

그 밖의 검사:

```bash
python tools/doc-check/check_all.py         # 문서 점검(문서만 고쳤을 때의 확인)
pnpm --filter @peaket/contracts gen:check   # 계약 생성물이 docs/api와 같은지
pnpm --filter @peaket/api-client test       # 화면 생성물이 계약과 같은지
```

- 개발 서버(앱 여섯과 가짜 API의 포트, `/preview` 화면 목록)는 `apps/README.md`, 로컬 클러스터는 `tools/local/README.md`, 묶음 검사 도구(완성 장부·시험 ID 대조)는 `docs/architecture.md` §8.6에 있다.
- 브라우저 검사(Playwright)·Storybook·규칙 명세 검사는 뿌리와 따로 둔 작업 공간이다(`tools/web-checks`, `tools/storybook`, `tools/spec-check`, 각자 잠금 파일). 그 폴더에서 `pnpm install --frozen-lockfile` 뒤 그 폴더의 `package.json` scripts를 쓴다.

## 절대 규칙

- 답변과 문서는 한국어로 쓴다. 도메인 지식이 없는 사람도 읽게 쓰고, 전문 용어는 문서마다 처음 나올 때 쉬운 말로 풀거나 비유를 붙이며, 제품 이름보다 기능을 가리키는 쉬운 한국어를 쓴다. 표준 용어는 남긴다. 규칙의 정본은 `docs/planning/03-policies-glossary.md` §5 '문서 쓰기 규칙'이다.
- `docs/` 아래 문서가 정본(명세)이다. 코드는 정본을 따르고, 정본 값을 다른 곳에 옮겨 적지 않고 위치만 가리킨다. `specs/`(Quint 규칙 명세)와 `docs/walkthrough/`(해설서)는 정본이 아니다. 둘이 다르면 정본이 이긴다.
- 기술을 고른 이유는 ADR과 정본 문서로만 댄다. git 태그 `archive-original`의 옛 원문과 학습 목록(1~33장)은 근거로 쓰지 않는다(ADR-0097·0098).
- 기능을 만들기 전에 `docs/security/asvs/<기능>.md` 보안 추적 표(`docs/architecture.md` §8.2)와 기능 설계서의 '운영 확인' 표(§8.4)를 먼저 쓴다.
- 결정은 `docs/adr/NNNN-<요약>.md`로 번호순에 더한다.
- 계약을 고치면 `packages/contracts`·`packages/api-client` 둘 다 `gen`을 돌려 생성물을 함께 커밋한다. 생성 파일은 생성기로만 고친다: 계약 생성물(`src/gen/`), 디자인 토큰(원천 `docs/design/tokens.json`, `pnpm --filter @peaket/ds tokens`), 게이트웨이 라우트(원천 `deploy/gateways/routes/`, `node tools/ci/gateway-routes.mjs --write`), 로컬 대시보드(`node tools/local/dashboards.mjs`).
- 1인 기간에는 작업 가지·PR 없이 `develop`에 스쿼시 형식 커밋을 바로 쌓고 묶음마다 푸시한다(`docs/architecture.md` §8.5 5). 멈추고 소유자에게 물어야 하는 일(`develop` 밖 원격 가지·태그 푸시, 강제 푸시, 비용이 드는 일 등)은 §8.6 '맡기기'에 있다.
- 커밋 메시지는 Conventional Commits 1.0.0이고 끝에 요구사항·시험 ID를 괄호로 단다(예 `fix(gateways): … (LCH-080)`). 시험 이름 자체에도 ID와 세부 번호를 단다(예 `S-T23 ① …`). 장부와 대조 스크립트가 그 이름으로 찾는다.
- 다른 세션이 같은 저장소를 동시에 고친다. 내가 고친 파일만 골라 스테이징하고, 남의 미완 변경이나 낯선 추적 안 된 파일은 건드리지 않는다.

## 작업 전에 읽을 것

- 문서 지도와 역할별 읽는 순서: `docs/00-summary.md` §2.
- 품질·보안 절차: `docs/architecture.md` §8(준수 기준 §8.1, 보안 기본 규칙 §8.3)과 `docs/planning/02-requirements.md` §3.1 'NFR 작성 원칙'. 기준을 바꿀 때는 이 파일이 아니라 그 두 문서를 고친다.
- 작업 단위는 '기능 묶음'이다. 묶음 목록은 `docs/BUILD_ORDER.md` '기능 묶음' 표, 진행 상태는 `docs/PROGRESS.md`, 묶음 절차(계획·시험·구현·리뷰·검증을 서로 다른 에이전트가 맡음, 게이트 항목)는 `docs/architecture.md` §8.6.
- 가지·커밋 규칙: `docs/architecture.md` §8.5와 `docs/devops.md` §2.2. 의존성·설치 규칙: `docs/devops.md` §4.4(`pnpm-workspace.yaml`보다 §4.4가 이긴다).
- 서비스 지도와 통신 규칙: `docs/architecture.md` §3.1·§3.2. 화면 앱 구조: `docs/frontend.md` §2. 데이터: `docs/data.md`. API 규칙: `docs/api/guidelines.md`.
