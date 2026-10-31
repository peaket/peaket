# Tasks

## 1. 정본 먼저

- [x] 1.1 ASVS 추적 표(docs/security/asvs/delivery.md 14.2.3·15.3.2·16.2.1·16.2.2·16.2.5·16.3.4·16.4.1)와 운영 확인 표(docs/observability.md §3 서비스 템플릿 표)를 이 설계대로 먼저 고친다. 확인: 문서 점검 오류 0.

## 2. 가명·IP 앞부분·표본(결정 3·4)

- [x] 2.1 가명·IP 앞부분·문턱·User-Agent 계열 시험을 먼저 쓴다. 확인: 모듈이 없어 실패한다.
- [x] 2.2 `pseudonym.ts`·`sampling.ts`·`client-family.ts`를 구현한다. 확인: 같은 시험이 통과한다.

## 3. 정규 로그 줄(결정 2·3·5)

- [x] 3.1 정규 로그 줄 시험(필드, KST 시각, `requestLog()`, 가명, 오류 `err`, 4xx 메시지 없음, 라우터 앞·끊긴 요청, 문턱·전수·진입 경로, 가림, 키 없음 시작 실패)을 먼저 쓰고 FND-050의 오류 기록 시험을 줄 기준으로 바꾼다. 확인: 실패한다.
- [x] 3.2 로거·요청 기록·훅·필터·설정을 구현하고 `reportToStderr`를 없앤다. 확인: 같은 시험과 FND-050 시험이 통과한다.

## 4. 추적 문맥과 SDK(결정 6·7)

- [x] 4.1 SDK 시험(서버 span 경로 틀·표본 속성·IP 앞부분·쿼리 없음, 메시 모드 부모 잇기)과 V-T31 ③ 시험(외부 클라이언트 헤더 없음, 기본 `fetch`는 잡힘, 리디렉트 안 따름, 남은 시간, 허용 목록 모드), 앱 서버용 모드 시험을 먼저 쓴다. 확인: 실패한다.
- [x] 4.2 `telemetry.ts`·`trace-boundary.ts`·`http-client.ts`·`testing.ts`와 패키지 내보내기(`./telemetry`·`./telemetry/register`·`./testing`)를 구현한다. 확인: 같은 시험이 통과하고 `build`·`typecheck`가 통과한다.

## 5. 마무리

- [x] 5.1 정본(observability §6·§7, verification V-T31, devops §4.4, secrets-and-keys)과 README, BUILD_ORDER 넘김(HOT-400, FND-090, BAS-010, 앱 서버 단계)을 고친다. 확인: 문서 점검 오류 0, `pnpm test`·`typecheck`·`build` 회귀 없음.
- [x] 5.2 새 맥락 코드 리뷰의 실제 결함을 재현 시험부터 고친다. 확인: 다시 본 리뷰에 새 결함이 없다.
