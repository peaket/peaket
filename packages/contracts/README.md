# @peaket/contracts

계약 원본(`docs/api/openapi.yaml`·`docs/api/asyncapi.yaml`)에서 만든 Zod 스키마와 TypeScript 타입이다. 화면과 서버가 함께 쓰는 요청·응답 검사의 원본은 이 생성물이다(docs/api/guidelines.md §1, 기술 검토 중간-085). 게시하지 않고 `workspace:`로만 잇는다(ADR-0165).

- 만든 곳: openspec 변경 `add-contracts-package`(2026-11-01, BUILD_ORDER FND-030). 설계와 이유는 그 변경의 design.md에 있다.
- `src/gen/`은 손으로 고치지 않는다. 계약을 고친 PR은 다시 만든 생성물을 함께 커밋한다.

## 명령

| 명령 | 하는 일 |
| --- | --- |
| `pnpm --filter @peaket/contracts gen` | 임시 폴더에 계약에서 다시 만들고, 다 만들어지면 `src/gen/`을 그것으로 바꾼다(실패하면 `src/gen/`은 그대로) |
| `pnpm --filter @peaket/contracts gen:check` | 운영체제 임시 폴더에 다시 만들어 `src/gen/`과 견준다. 빠진 파일·남은 파일·다른 파일을 적고 1로 끝난다 |
| `pnpm --filter @peaket/contracts build` | `tsc`로 `dist/`를 만든다(서버가 Node로 읽는다) |
| `pnpm --filter @peaket/contracts test` | Vitest 시험(변환기, 차이 검사, 생성 스키마의 행동, 생성물이 계약과 같은지, 빌드한 패키지를 Node가 읽는지) |
| `pnpm --filter @peaket/contracts typecheck` | 타입 검사 |

## 내보내기

| 가져오는 이름 | 내용 |
| --- | --- |
| `@peaket/contracts/openapi/model` | openapi `components.schemas`(190개)마다 Zod 스키마와 타입 둘(`X`는 `zod.input`, `XOutput`은 `zod.output`). orval이 작업별 매개변수·본문을 따로 꺼낸 스키마(`GetV1WishesParams` 등)도 함께 있다. 작업별 검사에는 태그 파일의 것을 쓴다 |
| `@peaket/contracts/openapi/<태그>` | 태그(`queue`, `seats`, `orders`, `ops` …)마다 작업별 경로·쿼리·머리·본문·응답 Zod 스키마. 계약에 `operationId`가 아직 없어 이름은 메서드와 경로에서 나온다(`PostV1QueuesEventIdLobbyParticipantsBody`). wbs 0.2.3에서 `operationId`를 붙이면 이름이 바뀐다 |
| `@peaket/contracts/asyncapi` | asyncapi 메시지 본문마다 Zod 스키마와 타입(메시지 이름 그대로, 예: `OrderEvent`) |

내보내기 조건은 셋이다. `types`와 `development`는 원본 `.ts`, `default`는 `tsc`로 만든 `dist/`의 `.js`다. 그래서 Node(서비스 실행)는 `dist/`를 읽고, Vitest와 번들러의 개발 조건은 원본을 읽는다(빌드 없이 시험). 생성된 모음 파일은 상대 다시 내보내기에 `.js`를 붙인다(`export * from './adminAccount.zod.js'`). TypeScript(NodeNext·Bundler)와 Vite는 `.js`를 원본 `.ts`로 찾는다. 서비스는 묶지 않고 `tsc`로만 빌드한다. esbuild로 묶으면 NestJS 생성자 주입에 필요한 데코레이터 메타데이터가 빠지기 때문이다(2026-11-01 확인, openspec 변경 `add-service-structure-and-request-checks` 결정 10, BUILD_ORDER FND-070).

## 생성 규칙

- 생성기는 orval 8 하나다(`client: 'zod'`, `schemas.type: 'zod'`). 생성 전에 orval이 OpenAPI 3.1 규격으로 계약을 검증하고, 위반이나 경고가 있으면 아무것도 쓰지 않고 실패한다.
- 생성기에 넣기 전에 계약 사본의 `additionalProperties: false`를 같은 뜻의 `{ not: {} }`로 바꾼다. orval 8.45는 앞의 것을 무시해 정의 밖 칸을 조용히 버리는 스키마를 만들고, 뒤의 것은 거절하는 스키마(`.catchall(zod.never())`)로 만든다. 그 표기는 입력 타입이 never가 되어 쓸 수 없으므로 생성 뒤 같은 거절을 하는 `.strict()`로 바꾼다. 권한 표는 요청 스키마의 정의 밖 칸을 400으로 거절하라고 한다(docs/security/authz-matrix.md, ASVS 8.2.3).
- orval이 옮기지 않는 제약 가운데 `uniqueItems`·`maxProperties`·`propertyNames.maxLength`는 `scripts/schema-extensions.mjs`가 검사 규칙(`.refine`)으로 붙이고, 같은 JSON Schema 낱말을 Zod 메타데이터(`.meta()`)로도 단다. `z.toJSONSchema()`는 `.refine`을 옮기지 못하지만 메타데이터는 싣기 때문에, Fastify 경로 스키마와 서비스 문서 비교(D-T38)도 그 제약을 본다(2026-11-01, FND-070). 모르는 모양의 `.refine`이 생기면 생성이 실패한다. 못 옮기는 것(지금은 파트너 웹훅 본문의 조건부 필수 하나)은 `test/untranslated-constraints.test.ts`에 위치를 적어 두고, 계약에 새로 생기면 그 시험이 실패한다.
- 쿼리·경로·머리 스키마는 계약의 값 형식(숫자 등)을 그대로 적는다. HTTP의 문자열 값을 바꾸는 일은 서비스 템플릿이 검사 전에 한다(BUILD_ORDER FND-070).
- asyncapi는 메시지 본문을 OpenAPI 구성 요소로 옮긴 임시 문서를 거쳐 같은 생성기로 만든다. 바이너리 메시지(`application/octet-stream`, 좌석 델타 등)는 뺀다. Avro 메시지의 스키마·타입은 디코드한 뒤의 값 모양이고, 보낼 때의 바이트 호환은 `docs/api/avro/`와 스키마 레지스트리 검사가 맡는다.
- 응답 스키마는 정의 밖 칸을 버리기만 하고 거절하지 않는다(계약에 `additionalProperties: false`가 없는 한). 응답에 칸을 더하는 것은 깨짐이 아니기 때문이다(docs/api/guidelines.md §1).
