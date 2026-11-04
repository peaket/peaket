# ADR-0196: api-client는 계약에서 작업 서술 표를 만들고, orval 훅·MSW 처리기는 사용자 함수 하나로 같은 실행 정책을 거친다

- **상태**: 채택(2026-11-05, 추천 적용. wbs 0.2.3 세부는 추천 적용이라는 소유자 승인 2026-10-21·2026-10-28을 따른다). BUILD_ORDER BAS-041(BAS-040의 ②).
- **관련**: ADR-0079 결정 21(api-client 공통 정책), ADR-0165(계약 패키지), ADR-0194(작업 이름·오류 목록·요청 닫힘), ADR-0110(대기 상태 파일 캐시), [docs/frontend.md](../frontend.md) §2.2 '생성물'·§4.1·§5.12, [docs/api/guidelines.md](../api/guidelines.md) §1·§2·§12
- **관련 ID**: FE-T3, FE-T21

## 맥락

- `@peaket/api-client`의 작업 서술(`Operation`: 경로·호스트·작업 종류·멱등 키·쿠키)은 손으로 적었고, 정본(docs/frontend.md §2.2)이 말하는 orval 호출 함수·훅·MSW 처리기는 없었다(BAS-210 넘김). 작업 종류(시간 초과)와 T=0 `text/plain` 두 호출도 손으로 적었다.
- ADR-0194로 모든 작업에 이름(`operationId`)과 이름 붙은 오류 목록이 생겼다. 그래서 생성물의 이름이 정해졌다.
- 정본은 PUT·PATCH의 `If-Match`·412 비교 보기를 api-client 공통 처리로 두었다(기술 검토 낮음-030).

## 결정

1. **작업 서술 표는 생성기가 계약에서 바로 만든다**(`src/gen/operations.ts`, orval 밖). 호스트는 `x-peaket-gateways` 규칙과 경로 `servers`, 멱등 키·`If-Match`는 `IdempotencyKey`·`IfMatch` 매개변수, 쿠키는 그 작업의 `security`(없으면 전역)에 쿠키 방식이 있는지, T=0은 요청 본문에 `text/plain`이 있는지로 읽는다. 작업 종류는 GET 읽기·그 밖 쓰기·`queue-files` 대기 상태 파일·`multipart/form-data` 올리기로 읽고, 정할 수 없는 둘만 작업 확장 칸 `x-peaket-timeout: longpoll`(결제 결과)·`x-peaket-fetch-cache: no-store`(대기 상태 파일)로 적는다. 오류 목록 `src/gen/problem-types.ts`도 같은 생성기가 만든다.
2. **orval은 TanStack Query 5 훅과 fetch 호출 함수를 사용자 함수 `orvalFetch`로 보내게 만든다.** `orvalFetch`는 메서드와 주소로 작업 서술 표에서 작업을 찾아(경로 변수는 풀어 넘긴다) api-client의 `send`로 보낸다. 그래서 생성 훅도 호스트·자격 증명·T=0·멱등 키·`If-Match`·시간 초과·자동 재시도·오류 모양 정책을 한 곳에서 받는다. 계약에 없는 주소는 보내지 않는다. 화면이 준 `Idempotency-Key`·`If-Match` 머리는 그대로 쓴다. orval은 경로 변수를 부호화해 넣고(`urlEncodeParameters`), 사용자 함수는 주소 해석이 경로를 바꾸는 주소(`..`·`.` 구간, 역슬래시, `#`)와 계약에 없는 쿼리를 보내지 않는다(경로 변수 값으로 다른 작업·호스트에 새는 것을 막는다, 새 맥락 리뷰). SSE 흐름(`text/event-stream`)은 생성 함수로 부르지 않고 EventSource로 연다. 생성 함수의 반환 형은 성공 응답만이고(`forceSuccessResponse`), 오류 형은 `ErrorType = ApiError`다.
3. **판 고르기**: MSW는 2.15.0이다(orval 8.45의 처리기가 MSW 2의 `http`·`HttpResponse`를 쓰고, 3.x는 내보내기 구조가 바뀐 새 판이다). faker는 10.6.0, React Query는 5.105.0이다(5.105.3은 저장소의 '게시 뒤 3일' 규칙에 걸렸다). 셋 다 출처 증명이 있어 신뢰 규칙 예외가 없다. orval은 계약 패키지와 같은 8.45를 api-client의 개발 의존성으로 적고, 판 정보(import 확장자·faker 기능)는 이 패키지의 package.json·tsconfig로 정해 생성 결과가 기계마다 같게 한다. React Query는 앱과 한 벌만 쓰도록 피어 의존성이다.
4. **생성 모델 형은 orval의 TypeScript 형을 그대로 둔다**(`src/gen/model`). 계약 패키지의 Zod 형과 겹치지만(약 3.5MB), orval이 다른 패키지의 형을 가져오게 하는 설정이 없어 바꾸지 않았다. 생성물은 손으로 고치지 않고 같은 패키지 시험이 계약에서 다시 만든 것과 견준다.
5. **공통 처리**: `If-Match` 작업은 판 없이 보내지 않고, 412는 다시 보내지 않으며 `isPreconditionFailed`로 가린다. 읽은 응답을 고쳐 다시 보낼 때는 `pickRequestFields`로 요청용 스키마의 칸만 고른다. 올리기는 `FormData`를 처음 한 번 바이트로 만들어 그 경계와 함께 다시 시도에도 쓴다(본문 지문이 같아 멱등 키가 422가 되지 않게). JSON·글자가 아닌 응답은 `Blob`이다. 응답이 `Set-Cookie`를 주는 로그인은 쿠키를 받도록 `include`다. 구매 401은 `purchaseUnauthorizedAction`이 `refresh`·`skip-seq-and-retry`·`session-ended`로 가른다(번호를 건너뛰어 다시 보내는 일은 서명기, wbs 2.10.7). 오류 문구 키는 `PROBLEM_COPY_KEYS`(기본 `problem.<이름>`, docs/frontend.md §5.12 표만 덮음)와 `copyKeyOf`다.

## 결과

- 화면은 `@peaket/api-client/endpoints/<태그>`의 훅이나 `request(OPERATIONS.<작업 이름>, …)`를 쓴다. 앱은 시작 때 `setOrvalClient(createApiClient({ baseUrls }))`를 한 번 부른다.
- 계약이 바뀌면 `pnpm --filter @peaket/api-client gen`으로 다시 만든다. 다시 만들지 않으면 api-client 시험이 실패한다.
- MSW·faker가 api-client의 의존성이 된다. 운영 묶음에 들지 않게 화면 운영 코드는 `@peaket/api-client/mocks`를 가져오지 않는다. 지금 그것을 막는 검사는 없어, 화면이 api-client를 처음 쓰는 HOT-300이 린트(가져오기 금지)로 막고 FE-T21 운영 묶음 검사에 MSW 문자열을 더한다.
- 저장소가 커진다(생성물 약 5MB). 대부분 형이다.

## 다른 선택지

| 길 | 고르지 않은 까닭 |
| --- | --- |
| orval에 작업 서술까지 맡긴다 | orval의 생성 함수는 작업 이름·호스트·작업 종류를 사용자 함수에 넘기지 않는다. 표를 따로 만들고 주소로 찾는 편이 단순하다 |
| 작업마다 사용자 함수를 따로 둔다(orval `operations` 덮어쓰기) | 272개 설정을 손으로 둬야 한다 |
| MSW 3 | orval 8.45가 낸 처리기와 맞는지 확인되지 않았다(내보내기 경로가 바뀌었다) |
| 모델 형을 계약 패키지 Zod 형으로 바꾼다 | 생성 뒤 import를 고쳐 쓰는 후처리가 필요하고, 이름이 다른 응답 형(`ProblemResponse` 등)이 있어 깨지기 쉽다 |
