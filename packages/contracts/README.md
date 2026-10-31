# @peaket/contracts

계약 원본(`docs/api/openapi.yaml`·`docs/api/asyncapi.yaml`)에서 만든 Zod 스키마와 TypeScript 타입이다. 화면과 서버가 함께 쓰는 요청·응답 검사의 원본은 이 생성물이다(docs/api/guidelines.md §1, 기술 검토 중간-085). 게시하지 않고 `workspace:`로만 잇는다(ADR-0165).

- 만든 곳: openspec 변경 `add-contracts-package`(2026-11-01, BUILD_ORDER FND-030). 설계와 이유는 그 변경의 design.md에 있다.
- `src/gen/`은 손으로 고치지 않는다. 계약을 고친 PR은 다시 만든 생성물을 함께 커밋한다.

## 명령

| 명령 | 하는 일 |
| --- | --- |
| `pnpm --filter @peaket/contracts gen` | 임시 폴더에 계약에서 다시 만들고, 다 만들어지면 `src/gen/`을 그것으로 바꾼다(실패하면 `src/gen/`은 그대로) |
| `pnpm --filter @peaket/contracts gen:check` | 운영체제 임시 폴더에 다시 만들어 `src/gen/`과 견준다. 빠진 파일·남은 파일·다른 파일을 적고 1로 끝난다 |
| `pnpm --filter @peaket/contracts test` | Vitest 시험(변환기, 차이 검사, 생성 스키마의 행동, 생성물이 계약과 같은지) |
| `pnpm --filter @peaket/contracts typecheck` | 타입 검사 |

## 내보내기

| 가져오는 이름 | 내용 |
| --- | --- |
| `@peaket/contracts/openapi/model` | openapi `components.schemas`(190개)마다 Zod 스키마와 타입 둘(`X`는 `zod.input`, `XOutput`은 `zod.output`). orval이 작업별 매개변수·본문을 따로 꺼낸 스키마(`GetV1WishesParams` 등)도 함께 있다. 작업별 검사에는 태그 파일의 것을 쓴다 |
| `@peaket/contracts/openapi/<태그>` | 태그(`queue`, `seats`, `orders`, `ops` …)마다 작업별 경로·쿼리·머리·본문·응답 Zod 스키마. 계약에 `operationId`가 아직 없어 이름은 메서드와 경로에서 나온다(`PostV1QueuesEventIdLobbyParticipantsBody`). wbs 0.2.3에서 `operationId`를 붙이면 이름이 바뀐다 |
| `@peaket/contracts/asyncapi` | asyncapi 메시지 본문마다 Zod 스키마와 타입(메시지 이름 그대로, 예: `OrderEvent`) |

내보내기는 원본 `.ts`를 가리키고, 생성된 모음 파일은 확장자 없이 다시 내보낸다(`@peaket/ds`와 같은 관례). 그래서 번들러·Vitest·Next.js로는 읽히지만 Node만으로는 읽히지 않는다. 서버에서 쓰는 빌드 방식은 서버가 이 생성물을 실행 중에 처음 쓰는 단계(요청 검사, BUILD_ORDER FND-070)에서 정한다. 서비스 템플릿(`packages/platform`, FND-050)은 실행 중에 이 패키지를 읽지 않는다(문서 뽑기의 `contractSchema`는 서비스가 넘긴 Zod를 받는다). 2026-11-01 확인: esbuild로 묶으면 NestJS 생성자 주입에 필요한 데코레이터 메타데이터가 빠지므로, 확장자 없는 다시 내보내기를 Node가 읽게 하는 방법(생성 뒤 확장자 붙이기 등)과 함께 그 단계에서 견준다.

## 생성 규칙

- 생성기는 orval 8 하나다(`client: 'zod'`, `schemas.type: 'zod'`). 생성 전에 orval이 OpenAPI 3.1 규격으로 계약을 검증하고, 위반이나 경고가 있으면 아무것도 쓰지 않고 실패한다.
- 생성기에 넣기 전에 계약 사본의 `additionalProperties: false`를 같은 뜻의 `{ not: {} }`로 바꾼다. orval 8.45는 앞의 것을 무시해 정의 밖 칸을 조용히 버리는 스키마를 만들고, 뒤의 것은 거절하는 스키마(`.catchall(zod.never())`)로 만든다. 그 표기는 입력 타입이 never가 되어 쓸 수 없으므로 생성 뒤 같은 거절을 하는 `.strict()`로 바꾼다. 권한 표는 요청 스키마의 정의 밖 칸을 400으로 거절하라고 한다(docs/security/authz-matrix.md, ASVS 8.2.3).
- orval이 옮기지 않는 제약 가운데 `uniqueItems`·`maxProperties`·`propertyNames.maxLength`는 `scripts/schema-extensions.mjs`가 검사 규칙(`.refine`)으로 붙인다. 못 옮기는 것(지금은 파트너 웹훅 본문의 조건부 필수 하나)은 `test/untranslated-constraints.test.ts`에 위치를 적어 두고, 계약에 새로 생기면 그 시험이 실패한다.
- 쿼리·경로·머리 스키마는 계약의 값 형식(숫자 등)을 그대로 적는다. HTTP의 문자열 값을 바꾸는 일은 서비스 템플릿이 검사 전에 한다(BUILD_ORDER FND-070).
- asyncapi는 메시지 본문을 OpenAPI 구성 요소로 옮긴 임시 문서를 거쳐 같은 생성기로 만든다. 바이너리 메시지(`application/octet-stream`, 좌석 델타 등)는 뺀다. Avro 메시지의 스키마·타입은 디코드한 뒤의 값 모양이고, 보낼 때의 바이트 호환은 `docs/api/avro/`와 스키마 레지스트리 검사가 맡는다.
- 응답 스키마는 정의 밖 칸을 버리기만 하고 거절하지 않는다(계약에 `additionalProperties: false`가 없는 한). 응답에 칸을 더하는 것은 깨짐이 아니기 때문이다(docs/api/guidelines.md §1).
