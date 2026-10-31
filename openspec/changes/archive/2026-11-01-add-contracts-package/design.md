# 설계: 계약에서 만든 코드 패키지와 작업 공간 시험 도구

## Context

- 계약 원본은 `docs/api/openapi.yaml`(OpenAPI 3.1.0, 경로 244·작업 271, 구성 요소 스키마 190개)과 `docs/api/asyncapi.yaml`(AsyncAPI 3.0.0, 메시지 34개 가운데 바이너리 5개)이다. AsyncAPI 메시지 본문은 JSON Schema 꼴로 적혀 있다. 기본 형식은 `application/avro`이고, 화면이 받는 SSE·지표 메시지는 `application/json`이다.
- 작업 공간: pnpm 12.16.0, Turborepo 2.11(작업 `build`·`typecheck`·`dev`), TypeScript 7. 공용 설정은 `@peaket/config/tsconfig/base.json`. 패키지는 원본 `.ts`를 `exports`로 바로 내보낸다(`@peaket/ds`와 같다).
- 공급망 설정(devops §4.4): 게시 뒤 3일, `trustPolicy: no-downgrade`, 설치 스크립트 허용 목록(`esbuild`만).
- 2026-11-01 저장소 밖 실험: orval 8.45.0이 계약 원본의 규격 위반 셋 때문에 생성을 거부했다(아래 결정 6). 고친 사본으로는 작업별 Zod(태그별 14파일)와 모델 폴더의 Zod·타입 484파일(구성 요소 190개와 orval이 작업별 매개변수·본문을 따로 꺼낸 294개)을 1.2초에 만들었고, 두 번 만든 결과가 바이트 단위로 같았다. AsyncAPI 메시지 29개도 결정 3의 변환기를 거쳐 같은 방식으로 만들어졌다.

## Goals / Non-Goals

**Goals:**

- 계약 원본 하나에서 요청·응답 Zod 스키마와 TypeScript 타입을 만들어 `packages/contracts`에 둔다(OpenAPI와 AsyncAPI의 JSON 꼴 메시지 본문).
- 계약이 바뀌었는데 다시 만들지 않았거나 생성물을 손으로 고쳤으면 시험과 명령이 실패한다.
- 작업 공간에 Vitest와 `pnpm test`(Turborepo `test`)를 둔다.

**Non-Goals:**

- 깨짐 검사(`oasdiff`·`asyncapi diff`), 서비스 OpenAPI 차이(D-T38), CI 계약 잡: wbs 0.2.1 ②(FND-040).
- gRPC 스텁(proto)과 Avro 코드: proto는 `buf`(contract-check), Avro는 스키마 레지스트리 호환 검사가 맡는다. 그 코드를 쓰는 서비스 단계에서 더한다.
- 호출 클라이언트·TanStack Query 훅·MSW 핸들러: `packages/api-client`(wbs 0.6.4).
- `operationId` 붙이기(wbs 0.2.3). 그때 작업별 스키마 이름이 바뀐다(아래 위험).
- 퍼블리싱 화면의 `node --test` 시험을 Vitest로 옮기기. 화면에 데이터를 잇는 단계에서 그 화면의 시험을 옮긴다(추천 적용 2026-11-01).

## Decisions

1. **생성 코드는 `packages/contracts` 한 곳에 둔다(추천 적용 2026-11-01, ADR-0165).** ADR-0165·devops §2.1·architecture §10이 '계약에서 만든 코드(Zod 스키마, TypeScript 타입, gRPC 스텁)'를 이 패키지에 두고, 그보다 앞서 쓴 frontend §2.2만 `validation/src/gen/`·`api-client/src/gen/`을 적었다. 같은 Zod를 두 곳에 만들면 어느 쪽이 원본인지 흐려지므로, 더 새로운 결정을 따라 한 곳에 만들고 frontend §2.2를 고친다. `@peaket/validation`은 이 스키마를 다시 내보내며 손 규칙만 덧붙이고(guidelines §1), `@peaket/api-client`는 화면 전용 생성물(호출 함수·훅·MSW)만 갖는다.
2. **생성기는 orval 8 하나다.** OpenAPI는 `client: 'zod'`(작업별 경로·쿼리·머리·본문·응답 스키마)와 `schemas.type: 'zod'`(구성 요소마다 Zod 스키마와 `zod.input`·`zod.output` 타입)를 함께 쓴다. 작업별 파일은 태그마다 하나(`mode: 'tags'`)라 계약이 바뀔 때 차이를 읽기 쉽다. 생성은 orval의 `generate()`를 스크립트에서 부른다. 설정 파일을 따로 두지 않아 출력 폴더를 인자로 바꿀 수 있고, 차이 검사가 같은 함수로 임시 폴더에 만든다.
3. **AsyncAPI는 변환기를 거쳐 같은 생성기로 만든다(추천 적용 2026-11-01).** 정본은 AsyncAPI 생성 도구를 정하지 않았다. AsyncAPI 3.0의 메시지 본문은 JSON Schema라 OpenAPI 3.1 구성 요소 스키마와 같은 꼴이다. 그래서 `components.messages`의 본문을 메시지 이름 그대로 `components.schemas`에 옮긴 OpenAPI 문서를 임시 파일로 만들고 orval에 넣는다. 생성기를 하나만 두면 Zod 꼴과 이름 규칙이 OpenAPI 쪽과 같고 의존성이 늘지 않는다. 규칙:
   - 형식이 `application/octet-stream`인 메시지(좌석 델타 같은 바이너리)는 뺀다. 본문이 바이트라 Zod로 볼 것이 없다.
   - `application/avro`(기본)와 `application/json` 메시지는 넣는다. Avro 메시지의 Zod·타입은 디코드한 뒤의 값 모양이다. 보낼 때의 바이트 호환은 Avro 스키마와 레지스트리 검사가 맡는다.
   - AsyncAPI의 `components.schemas`도 옮긴다(지금은 없다). 메시지 이름과 겹치면 실패한다.
   - 본문의 `$ref`가 `#/components/schemas/` 밖(예: `#/components/messages/`)을 가리키면 옮긴 문서에서 풀리지 않으므로 실패한다.
   - 확장 칸(`x-present-when` 등)은 그대로 둔다. 생성기는 읽지 않는다.
4. **생성물은 커밋하고 차이를 검사한다(기술 검토 중간-085).** `pnpm --filter @peaket/contracts gen`이 `src/gen/`을 지우고 다시 만든다. `gen:check`는 운영체제 임시 폴더에 다시 만들어 `src/gen/`과 파일 목록·내용(줄바꿈은 LF로 맞춰)을 견주고, 빠진 파일·더 있는 파일·내용이 다른 파일을 적고 1로 끝난다. 같은 검사를 Vitest 시험으로도 둬서 `pnpm test`가 잡는다. CI의 계약 잡에서 부르는 일은 FND-040이다.
5. **내보내기**: `@peaket/contracts/openapi/<태그>`(작업별 스키마), `@peaket/contracts/openapi/model`(구성 요소 스키마·타입), `@peaket/contracts/asyncapi`(메시지 본문 스키마·타입). 실행 의존성은 `zod` 하나다. 게시하지 않는다(`private: true`, ADR-0165).
6. **계약 원본의 규격 위반을 고친다(구현 중 찾음).** orval은 생성 전에 OpenAPI 3.1 스키마로 계약을 검증하고, 위반이 있으면 아무것도 만들지 않는다. 걸린 것은 ① 내려받기 응답의 응답 형식(text/csv·xlsx)에 둔 `description` 두 곳 ② `staffToken`의 `bearerFormat`(`scheme`이 bearer가 아니다)이다. 뜻(제출 파일만, charset, JWT)은 응답 설명과 인증 방식 설명으로 옮긴다. 이 검증이 생성 단계에 있으므로, 앞으로 계약에 규격 위반이 들어오면 `gen`·`gen:check`·시험이 실패한다. 다만 orval의 `generate()`를 스크립트에서 부르면 기본으로 검증 오류를 로그로만 남기고 정상 종료한다(구현 중 찾음, orval 8.45 `generate.ts`). 그래서 `throwOnError`와 `failOnWarnings`를 켜고, 규격을 어긴 계약이면 생성이 실패하는 시험을 둔다.
7. **시험 도구(wbs 0.6.4에서 앞당김)**: Vitest 5를 정본의 단위 시험 도구로 들인다(frontend §5.17). 지금은 `packages/contracts`만 쓰므로 설정도 그 패키지에 둔다. 함께 쓸 패키지가 생기면 `@peaket/config`로 올린다. Turborepo에 `test` 작업을, 뿌리에 `pnpm test`를 둔다. 그러면 지금 있는 패키지의 `node --test` 시험도 한 명령으로 돈다.
8. **시험(TDD)**: 시험 이름 머리에 근거 ID를 단다(`중간085_`, `ADR0165_`).
   - 변환기: 메시지 본문을 구성 요소로 옮김, 바이너리 메시지 뺌, 기본 형식 따름, 이름 겹침과 풀리지 않는 `$ref`는 실패.
   - 차이 검사: 같으면 차이 없음, 내용이 다르면·빠졌으면·더 있으면 그 파일 이름, 줄바꿈만 다르면 차이 없음.
   - 생성 스키마(계약의 바깥 행동): Problem 본문, 필수 칸이 빠진 응답 거절, 열거 밖 값 거절, AsyncAPI 주문 사건의 필수 칸과 기본값.
   - 생성물이 계약과 같다(결정 4의 시험).
   - 규격을 어긴 계약이면 생성이 실패한다(결정 6), `additionalProperties: false` 바꾸기와 실제 계약에 남는 것이 없음(결정 9), 생성된 행동 신호 요약이 정의 밖 칸을 거절함.
9. **정의 밖 칸을 거절하게 만든다(구현 중 찾음, 추천 적용 2026-11-01).** 권한 표는 요청 스키마가 허용한 칸만 두고(`additionalProperties: false`) 그 밖의 칸이 오면 400으로 거절하라고 한다(docs/security/authz-matrix.md, ASVS 8.2.3·15.3.3, 계약에 70곳). 그런데 orval 8.45는 `additionalProperties: false`를 보지 않고, 엄격 모드(`strict`)를 켜야만 거절하는 객체를 만든다. 엄격 모드(`strict.body`)는 요청 본문과 구성 요소 스키마 전부에 한꺼번에 걸리는데, 구성 요소는 응답에도 쓰인다. 계약이 칸을 닫지 않은 응답 객체까지 닫히면 응답에 칸을 더할 때 응답을 검사하는 옛 화면이 거절한다(guidelines §1은 응답 칸 추가를 깨짐으로 보지 않는다). JSON Schema에서 `additionalProperties: false`와 `additionalProperties: { not: {} }`는 같은 뜻이고, orval은 뒤의 것을 `.catchall(zod.never())`(정의 밖 칸 거절)로 만든다. 그래서 생성기에 넣는 계약 사본에서만 앞의 표기를 뒤의 것으로 바꾼다. 원본 계약은 그대로다. 다만 `.catchall(zod.never())`는 Zod 4가 입력 타입을 `{ [x: string]: never; … }`로 추론해 정상 값도 그 타입에 넣을 수 없으므로(코드 리뷰가 찾음), 생성 뒤 같은 거절을 하는 `.strict()`로 바꾼다. 계약에서 닫히지 않은 요청 본문(124개 중 70개)과 응답에서만 쓰는 닫힌 스키마 넷은 계약 쪽 문제라 BAS-040(wbs 0.2.3)으로 넘긴다. 응답처럼 계약이 칸을 닫지 않은 곳은 Zod 기본대로 모르는 칸을 버린다(응답에 칸을 더하는 것은 깨짐이 아니다, guidelines §1).
10. **생성기가 옮기지 않는 제약(코드 리뷰가 찾음, 추천 적용 2026-11-01).** orval 8.45는 `uniqueItems`(계약에 8곳), `maxProperties`(2곳), `propertyNames`(1곳), `if`/`then`/`else`(1곳)를 Zod로 옮기지 않아 생성 스키마가 계약보다 느슨해진다. 앞의 셋은 orval의 `schemaExtension`으로 생성 스키마에 검사 규칙(`.refine`)을 붙인다. 남은 조건부 필수(파트너 웹훅 본문, 우리가 보내는 값)는 위치를 시험에 적어 두고, 계약에 생성기가 옮기지 않는 키워드가 새로 생기면 그 시험이 실패한다. 확장은 같은 노드에 `type`(array·object)이 있고 `format`이 없을 때만 붙으므로, 그렇지 않은 자리의 셋도 못 옮긴 것으로 센다. 중복 검사는 키를 정렬해 직렬화해 견준다(JSON Schema는 키 순서만 다른 객체를 같은 값으로 본다). 검사 규칙(`.refine`)은 `z.toJSONSchema`로 바꾸면 빠지므로, 핫패스처럼 JSON Schema로 바꿔 쓰는 경로는 그 제약을 따로 건다(지금 검사 규칙 52곳은 조사·관제·스캐너·굿즈 쪽이라 핫패스에는 없다, FND-070).
11. **넘기는 것(코드 리뷰가 찾음)**: 생성 스키마는 계약의 값 형식을 그대로 적는다. 쿼리·경로·머리는 HTTP에서 늘 문자열이고 머리 이름은 소문자로 오므로, 서버가 이 스키마로 검사하기 전에 값을 바꾸는 단계는 서비스 템플릿(FND-070, wbs 0.3.2)에 둔다. orval의 `coerce`는 `'false'`를 참으로 바꾸는 불리언 변환 문제가 있어 생성 단계에서 켜지 않는다.

## Risks / Trade-offs

- **이름이 바뀐다**: 계약에 `operationId`가 없어 작업별 스키마 이름이 경로와 메서드에서 나온다(`GetV1EventsEventIdResponse`). wbs 0.2.3에서 `operationId`를 붙이면 이름이 모두 바뀐다. 지금은 이 스키마를 쓰는 코드가 없어 받아들인다. 구성 요소 스키마 이름(`AdminAccount`)은 그대로다.
- **생성물이 크다**: 설명(`.describe()`)이 계약의 한국어 설명을 그대로 담아 OpenAPI 쪽이 약 3.3MB다. 설명은 런타임 오류 메시지와 화면 도움말에 쓸 수 있어 뺄 수 없는 비용으로 본다.
- **모델 폴더에 작업별 스키마가 한 번 더 있다**: orval은 작업의 매개변수·본문 스키마를 모델 폴더에도 따로 꺼낸다(`GetV1WishesParams`, 태그 파일에는 `GetV1WishesQueryParams`). 작업별 검사는 태그 파일의 것을 쓴다(README).
- **변환기가 AsyncAPI의 일부만 본다**: 메시지 본문과 구성 요소 스키마만 옮기고 채널·작업은 옮기지 않는다. 주제 이름과 키는 계약 문서와 asyncapi 깨짐 검사(FND-040)가 지킨다.
