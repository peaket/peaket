# Tasks

## 1. 패키지 뼈대

- [x] 1.1 `packages/platform`(package.json·tsconfig·vitest 설정)을 만들고 의존성을 잠금 파일대로 넣는다. `@scarf/scarf` 설치 스크립트는 `allowBuilds: false`(결정 1). 확인: `pnpm install --frozen-lockfile` 통과, 빈 시험이 돈다.

## 2. 시계·남은 시간(결정 4)

- [x] 2.1 남은 시간 시험(받은 값, 상한, 잘못된 값, 다음 호출 시간, 모자람 504, 절대 시각)을 먼저 쓴다. 확인: 모듈이 없어 실패한다.
- [x] 2.2 `Clock`과 남은 시간을 구현한다. 확인: 같은 시험이 통과한다.

## 3. Problem(결정 3)

- [x] 3.1 Problem 시험(이름 붙은 오류, 확장 필드 겹침, 예상하지 못한 오류 500·내부 정보 없음·서버 기록, 이름 없는 오류 `about:blank`, `Retry-After`, 디버그 켬·끔, 시작 설정 검사)을 먼저 쓴다. 확인: 실패한다.
- [x] 3.2 `ProblemError`·전역 필터·설정 검사를 구현한다. 확인: 같은 시험이 통과한다.

## 4. 네 신호 계측(결정 2)

- [x] 4.1 지표 시험(표준 칸 20개와 observability §8 목록 일치, 5xx 오류 카운터, 정상 분기 409 카운터, 처리 중 게이지, 경로 틀 라벨과 `unmatched`, 앱 포트에 `/metrics` 없음)을 먼저 쓴다. 확인: 실패한다.
- [x] 4.2 지표·Fastify 훅·관리 포트·요청 맥락·`createService`를 구현한다. 확인: 같은 시험이 통과한다.

## 5. 문서 뽑기(결정 6)

- [x] 5.1 문서 시험(앱에 문서 경로 없음, `emitOpenApi`가 계약 Zod 응답 스키마를 담은 파일을 씀)을 먼저 쓴다. 확인: 실패한다.
- [x] 5.2 `emitOpenApi`·`contractSchema`를 구현한다. 확인: 같은 시험이 통과하고 `pnpm --filter @peaket/platform build`·`typecheck`가 통과한다.

## 6. 서비스 OpenAPI 차이 비교 본체(D-T38, 결정 7)

- [x] 6.1 `tools/ci/service-openapi.test.mjs`를 먼저 쓴다(계약에 없는 응답 칸, 맡은 작업 빠짐, 계약에 없는 작업, 목록 없음, 매개변수·요청 본문 어긋남, 설명·형식·`nullable`만 다르면 통과, 문서를 못 만들면 실패, `contract-breaking.mjs services` 연결). 확인: 모듈이 없어 실패한다.
- [x] 6.2 `tools/ci/service-openapi.mjs`를 구현하고 `contract-breaking.mjs services`가 부르게 한다. 확인: 같은 시험이 통과하고 `node --test tools/ci/*.test.mjs` 회귀 없음.
- [x] 6.3 실제 도구로 한 번: 계약 Zod로 응답을 단 임시 서비스의 문서를 `emitOpenApi`로 뽑아 실제 `docs/api/openapi.yaml`과 견준다(같으면 통과, 응답 칸 하나를 더하면 실패). 확인: 확인 기록에 적는다.

## 7. CI 서비스 잡(결정 8)

- [x] 7.1 `.github/workflows/ci-node.yml`과 `ci.yml`(잡 `node`, `ci-summary`)을 고친다. 확인: `node tools/ci/check-workflows.mjs` 통과.

## 8. 정본과 기록

- [x] 8.1 docs/observability.md §3(지표 이름, 운영 확인 표)·§8, docs/api/guidelines.md §2·§5, docs/devops.md §3.1(`ci-node.yml`·`contract-check.yml` 지금 있는 것), docs/security/asvs/delivery.md(13.4.2·13.4.5·16.3.4·16.5.1 구현 위치), packages/README.md, tools/ci/README.md, wbs 0.3.1(①② 나눔, 진행)·0.2.1(완료)·0.1.2(md·csv)를 고친다. 확인: 문서 점검 오류 0.

## 8b. 코드 리뷰 반영

- [x] 8b.1 재현 시험을 먼저 써서 실패(플랫폼 5건, 비교기 7건, 범위 2건)를 보고 고친다: 본문을 다 받은 뒤 끊긴 요청의 처리 중 게이지(응답 객체의 close로 내림), statusCode를 단 일반 오류와 4xx·5xx가 아닌 HTTP 예외는 500과 서버 기록, 잘못된 URL(frameworkErrors)도 Problem·지표, contractSchema 기본 입력 기준, 비교기의 Zod null 조각·oneOf와 anyOf·값 목록 union·스칼라 형 union·숫자 열거 형·형 없는 null 열거·요청의 읽기 전용과 응답의 쓰기 전용 칸· 순환, 범위 고르기(ci-node.yml·turbo.json·.nvmrc는 전체 js, observability.md는 js, packages/platform·service-openapi.mjs는 계약 잡). CI 연결: 계약 잡이 서비스를 빌드한 뒤 문서를 뽑고, typecheck·test가 기대는 패키지의 build 뒤에 돌고, ci-node가 서비스 템플릿 시험을 늘 돈다. 계약 전체 대조 시험(contract-sweep.test.ts)을 더했다. 확인: 플랫폼 50/50, CI 도구 145/145, check-workflows 통과, 계약 전체 대조에서 남은 차이는 생성 Zod의 실제 차이 2줄(BAS-040로 넘김).
- [x] 8b.2 다시 본 리뷰의 3건을 고친다: null과 함께 하나로 감싼 조합을 버리던 것(조합이 없어질 때까지 되풀이, 재현 시험 먼저), 비교 본체만 바꾼 PR에서 js 범위가 꺼지던 것(재현 시험 먼저), 라우터 앞 5xx를 서버 기록에 남기지 않던 것(지금 설정에서 일으킬 경로가 없어 시험 없이 고침). 확인: 플랫폼 50/50, CI 도구 146/146, 세 번째 리뷰에서 새 결함 없음.

## 9. 통합 확인

- [x] 9.1 `pnpm test`, `pnpm typecheck`, `pnpm build`, `node --test tools/ci/*.test.mjs`, 저장소 규칙 검사 셋, `node tools/ci/contract-breaking.mjs services`, 문서 점검, OpenSpec 검증, 줄바꿈 LF. 확인: 모두 통과한다.

## 확인 기록

- 2026-11-01 도구 확인: TypeScript 7.0.2는 emitDecoratorMetadata를 내고, Vitest 5(oxc)에서 NestJS 12(ESM)의 생성자 주입이 돈다. @nestjs/swagger 12.0.5의 동반 의존성은 TypeScript ^5.5 || ^6이라 설치 경고 하나가 남는다(쓰지 않는 swagger 플러그인용). swagger-ui-dist의 @scarf/scarf 설치 스크립트가 strictDepBuilds로 설치를 막아 allowBuilds false로 거부했다.
- 시험을 먼저 쓰고 본 실패: deadline.test.ts(모듈 없음) → 14/14. problem·metrics·openapi 시험(구현 없음, 3묶음 실패) → 구현 뒤 시험이 고친 두 곳(지표 출력의 le가 라벨 맨 앞, NestJS POST 기본 201)을 빼고 통과. 본문을 받은 뒤 요청 맥락 시험을 더했고, preValidation 훅을 빼도 Node 24에서는 inject·실제 소켓 모두 맥락이 이어져(방어로 남김) 통과했다. 플랫폼 44/44.
- service-openapi.test.mjs(모듈 없음) → 구현 뒤 1건 실패(시험의 structuredClone이 같은 객체를 가리키던 칸을 하나로 남겨 세 곳이 함께 바뀜) → 시험 복사를 JSON 왕복으로 고친 뒤 15/15. CI 도구 시험 136/136.
- 실제 계약으로(작업 6.3, 임시 시험, 커밋하지 않음): GET /v1/ops/admin-accounts/{adminAccountId}/permission-changes를 계약 Zod(@peaket/contracts)로 단 처리기의 문서를 emitOpenApi(미리 보기 모드)로 뽑아 docs/api/openapi.yaml과 견주니 차이 0건, 응답에 칸 leaked를 더한 판은 그 칸 이름으로 실패했다.
- check-workflows(워크플로 9개)·CODEOWNERS·workspace: 통과. pnpm test --force 7묶음, pnpm typecheck 11, pnpm build 7 통과. 빌드한 dist를 Node로 바로 불러 없는 경로가 404 Problem인 것을 확인했다. 문서 점검 오류 0·경고 0.

- 마지막 확인(2026-11-01): 플랫폼 50/50(계약 전체 대조 포함), CI 도구 146/146, pnpm test 7묶음·typecheck 11·build 7, check-workflows(9)·CODEOWNERS·workspace: 통과, contract-breaking.mjs services(서비스 없음) 통과, pnpm install --frozen-lockfile·gen:check 같음, 문서 점검 오류 0·경고 0, git diff --check와 새 파일 LF 깨끗.
- 코드 리뷰(새 맥락): 1차 결함 9건, 다시 본 3건을 모두 고쳤고 세 번째 확인에서 새 결함이 없었다.
- 대조(verify): 명세 요구사항 8개 모두 구현과 시험에 이어진다. 작업 칸은 모두 끝났다.

## Workflow follow-up

- 대조: OpenSpec 대조(verify 스킬).
- 브라우저 확인: 해당 없음(화면이 없다. 서버 공용 패키지와 CI 도구).
- 코드 리뷰: 새 맥락의 리뷰 에이전트, 나온 것은 이 사이클에서 고친다.
