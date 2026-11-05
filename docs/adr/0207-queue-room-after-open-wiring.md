# ADR-0207: 대기실 오픈 뒤 경로를 계약에 잇는 데 필요한 빈칸을 채운다

- **상태**: 채택(2026-11-05, 추천 적용). BUILD_ORDER HOT-340 ①.
- **관련**: [docs/frontend.md](../frontend.md) §3.1 화면 데이터 표·§3.4 대기실 상태표·§3.12 저장소·§4.2.1 진입 도우미·§5.1 폴링, [docs/features/queue-admission.md](../features/queue-admission.md) §2·§4, [docs/api/openapi.yaml](../api/openapi.yaml) `/v1/queues/{eventId}/entries`·`admission`·`segment-states`·`batch-results`, ADR-0058, ADR-0110, ADR-0183, ADR-0185
- **관련 ID**: SCR-008, FE-T4, Q-T47

## 맥락

- 대기실 경량 페이지(`apps/web/queue-room`)는 퍼블리싱 목업이었다. 화면 상태는 주소의 `?state=`로 골랐다.
- HOT-340 ①은 오픈 뒤 경로를 계약에 잇는다: 진입 → 묶음 결과 → 대기 상태 파일 폴링 → 입장 확정 → 좌석 화면.
- 정본을 모아 읽으니 빈칸과 어긋남이 있었다(2026-11-05 정본 대조).
  - 202 본문을 어디에 둘지가 두 군데에서 달랐다.
  - 결과 파일 지연의 바이트 범위가 문서마다 달랐다.
  - §3.4 상태표에 빠진 응답이 있었다(진입 403·404·409 `queue-not-open`·429, 입장 확정 401·403·410 `sold-out`·`queue-ticket-removed`·503).
  - `NOT_YET` 뒤 동작, 속도 0일 때 폴링 주기, 입장 뒤 저장소 정리가 없었다.

## 결정

1. **오픈 뒤 경로만 이 단계에서 잇고 나머지는 나눈다.**
   - HOT-340 ①: 한 탭의 오픈 뒤 경로다.
   - HOT-341: 로비 경로, 여러 탭 리더(Web Locks·BroadcastChannel, FE-T6), 차례 도래 유예, 자동 배정 공연의 이른 확인.
   - HOT-342: 공연 상세의 진입 상태와 사전 사람 확인 카드(사전 검증 토큰을 `peaket.queue.{eventId}`에 쓴다), 좌석 자원 미리 받기, FE-T3·FE-T15·FE-T4 브라우저 칸.
   - ①에서 여러 탭은 이렇게만 한다: 숨긴 탭은 입장 확정을 보내지 않고, 보이게 되면 그때 보낸다(§5.1 '여러 탭'의 한 부분).
2. **대기실은 React용 api-client를 쓰지 않는다.** 대기실은 React·`apps/web/src`를 가져오지 못한다(§2.3). 그래서 진입·입장 확정·상태 파일·결과 파일을 부르는 작은 `fetch` 층을 대기실에 둔다. 규칙은 api-client와 같다: T=0 두 호출은 `text/plain`이고 사용자 헤더가 없다, 파일은 `credentials: 'omit'`, 상태 파일은 `cache: 'no-store'`, 시간 초과 5초, `Retry-After`는 0 이상 정수 초나 HTTP 날짜만.
3. **묶음 진입(202)**
   - 202 본문과 그때 보낸 사전 검증 토큰을 localStorage `peaket.queue.{eventId}`에 둔다(§3.1 표의 '메모리'를 고친다).
   - 결과 파일의 키는 그 토큰의 `h = SHA-256(UTF-8(토큰))`이다. 받는 시각의 지연은 `u32be(h의 바이트 2~5) mod (spreadSec × 1000)` 밀리초다. 파일 이름의 앞 세 자리(바이트 0~1.5)와 겹치지 않는 네 바이트다.
   - 결과를 받으면 같은 `entryRequestId`와 같은 토큰으로 다시 진입해 대기표를 받는다.
   - 페이지를 다시 열었을 때 요청 ID와 202 본문만 있으면 `boot`가 `batching`으로 간다.
4. **사전 검증 토큰이 없거나 진입이 403 `preverify-invalid`면 공연 상세(SCR-002)로 돌려보낸다.** 사람 확인은 공연 상세가 한다(HOT-342). 403 `identity-verification-required`와 404 `queue-not-found`, 409 `queue-not-open`(오픈 전)도 공연 상세로 보낸다. 공연 상세가 그 상태(본인확인 필요·오픈 전·대기열 없음)를 그린다.
5. **§3.4에 빠진 응답을 채운다.**
   - 진입 429: `Retry-After` 뒤 같은 요청 ID로 다시 보낸다. 그동안 "요청이 많아 잠시 기다려야 합니다. N초 뒤 자동으로 다시 시도합니다"(d5 '진입 혼잡').
   - 입장 확정 401: 팬 토큰을 한 번 갱신하고(Web Locks `peaket.refresh`) 다시 보낸다. 또 401이면 `login-expired`.
   - 입장 확정 403 `booking-restricted` → `restricted`, 403 `queue-ticket-invalid` → `duplicate`(화면 '다른 곳에서 이미 입장'), 403 `identity-verification-required` → 공연 상세.
   - 입장 확정 410 `sold-out` → `sold-out`, `queue-ticket-removed` → `cancelled-elsewhere`, 503 → `Retry-After` 뒤 같은 대기표로.
   - `rejoinAllowed`가 거짓인 410 `queue-ticket-expired`는 [다시 줄 서기] 없이 만료 화면이다.
   - 위 표에 없는 4xx와 꼴이 틀린 응답은 실패로 세어 다시 묻는다. 연속 실패는 `stale`로 간다.
6. **`NOT_YET`이면 `waiting`으로 돌아가고, `retryAfterMs`가 지나기 전에는 입장 확정을 다시 보내지 않는다(지터 없음).** serving ≥ 내 순번이 이어져도 그 시각까지 기다린다.
7. **폴링 주기에서 `servingRate`가 0이면** 예상 대기를 셀 수 없다. 이때 내 구간이 serving의 구간이나 바로 다음 구간이면 0.5초, 아니면 20초다. 서버의 입장 임박 정의(속도가 0이면 serving 구간과 다음 구간, queue-admission §4)와 맞춘다. 묶음 첫 전진을 기다리는 동안 차례가 가까운 사람이 20초마다 묻지 않게 하려는 것이다.
8. **저장소**
   - `peaket.queue.{eventId}`에 처음 보인 예상 대기 `firstEtaSec`와 그때의 보정된 서버 시각 `firstEtaAtMs`를 둔다. 입장 확정 본문에 실어 `queue_eta_error_ratio`를 쌓는다(ADR-0183 결정 10).
   - `ADMITTED`를 받으면 `peaket.queue.{eventId}`를 모두 지운다(사전 검증 토큰 포함). 다시 열었을 때 쓴 대기표나 토큰으로 다시 줄 서지 않게 한다. 입장 뒤 [뒤로]로 돌아왔고 `peaket.admission.{eventId}`의 구매 세션이 남았으면 `boot`가 좌석 화면으로 보낸다.
   - 410은 저장소를 지운다(§3.12). 다만 `rejoinAllowed`인 `queue-ticket-expired`는 [다시 줄 서기]에 쓸 사전 검증 토큰만 남긴다.
   - `peaket.admission.{eventId}`에 `purchaseSessionExpiresAt`도 둔다.
9. **예상 대기 표기**: 분으로 반올림하고 1분 미만도 '약 1분'이다. 60분부터 '약 N시간 M분'이다(퍼블리싱 그대로).
10. **`?state=`를 걷는다.** 대기실의 화면 상태는 상태 기계와 응답만으로 정한다. 시각 회귀(FE-T40)는 대기열 호출을 Playwright 경로 가로채기로 흉내 내 같은 네 상태(waiting·soon·paused·stale)를 만든다. 화면 목록(`/preview`)은 개발 서버에서 가짜 API의 상태 바꾸기로 연다.
11. **머리와 매진 화면의 공연 값은 공연 공개 요약(`GET /v1/events/{eventId}`, CDN 300초)에서 한 번 받는다.** 대기열 경로를 막지 않게 따로 받고, 받기 전·실패하면 빈 머리다. 공연명, 회차 일시·공연장(KST), 정렬 방식(순번 안내 시트), 같은 공연 다른 회차(매진 화면)를 읽는다. 대기실은 계정 요약을 받지 않으므로 데스크톱 계정 메뉴는 이름 없이 '계정'이다.
12. **①에서 뒤로 넘기는 화면 조각.** 데이터 연결 화면에서 동작하지 않는 것은 보이지 않게 두고 뒤 단계가 잇는다. HOT-341: [차례 알림 받기](알림 권한·알림음·웹 푸시)와 계정 메뉴의 로그아웃(대기실 CSP의 `form-action`이 웹 `/logout` 보내기를 막는다. §5.14.4의 저장소 정리 포함). HOT-342: 매진 화면의 [취소표 알림 받기](알림 신청 API), 예매 제한 화면의 ( 소명하기 › )(소명 건 ID는 403에 없다. 그동안은 공연 상세로), 앞 인원이 바뀔 때 숫자가 굴러 내려오는 움직임(d5 '값이 바뀌는 순간'. 지금은 제자리에서 숫자만 바꾼다)은 HOT-342가 잇는다.

## 결과

- 로컬과 브라우저 확인은 계약 모양 가짜 API(ADR-0199 결정 2)에 대기열 경로를 더해 한다. queue-svc는 아직 `saleStatus`의 `PAUSED`·`ALL_HELD`·`SOLD_OUT`, 운영 공지, 남은 좌석, 묶음 결과 파일 게시(HOT-050)를 내지 않는다. 그래서 그 상태는 가짜 API로만 볼 수 있다.
- 차례 도래 유예(15분)의 남은 시간은 브라우저가 차례가 온 시각을 알 길이 없어 HOT-341에서 정한다. 그때까지 대기실은 유예 화면을 그리지 않는다.

## 다른 선택지

| 길 | 고르지 않은 까닭 |
| --- | --- |
| 대기실이 api-client를 쓴다 | 생성 작업 묶음이 `@tanstack/react-query`를 가져오고, `.` 진입점이 작업 서술 표 전체를 실어 대기실 JS 예산(§5.1)을 넘기기 쉽다 |
| 사전 검증 토큰이 없으면 대기실이 사람 확인을 띄운다 | 사람 확인 위젯은 공연 상세(사전 확인)와 로비에만 둔다(d5). 같은 확인을 두 화면에 두면 문구와 상태가 둘이 된다 |
| `?state=`를 남겨 시각 회귀에 쓴다 | 운영 셸이 목업 상태를 그릴 수 있게 된다. 다른 화면 단계(HOT-300·321)와 같이 걷는다 |
