# ADR-0363: 월렛 재발급·웹 푸시 구독·월렛 워커 위치와 로그아웃 정리를 실제 서버에 잇는다(2026-11-23)

- **상태**: 채택(2026-11-23, 추천 적용, BUILD_ORDER 기능 F-05-1 계획 `docs/review/plans/F-05-1.md`). 방향을 바꾸는 결정은 없다. 결정 5는 감독 승인 2026-11-23. 정본(docs/features/offline-gate.md §2·§4·§9.1, docs/frontend.md §4.2.4·§5.4·§5.14.4, docs/features/notify.md §3.4·§3.5, docs/design/d5-screen-blueprint.md §5.13)에 이미 있는 규칙을 코드에 잇다가 비어 있거나 서로 어긋난 곳을 정한다. 키 증명(QR에 서버 서명을 붙이는 선택 기능)의 채택은 이 ADR이 정하지 않는다(결정 9).
- **관련**: [ADR-0050](0050-crypto-corrections-and-key-management.md) 결정 2(재발급 한도), [ADR-0051](0051-gate-process-end-to-end.md) 결정 7·10·11, [ADR-0079](0079-frontend-radio-detailed-design.md) 결정 17·18·19, [ADR-0293](0293-fan-reauth-token-bound-to-receiving-operation.md)(재인증 토큰의 받는 쪽 작업), [ADR-0336](0336-wallet-device-key-server-registration-and-cache-version.md), docs/security/authz-matrix.md §6
- **관련 ID**: FR-012, FR-040, FR-066, POL-018, POL-019, O-T6, O-T32, O-T47, O-T48, O-T49, O-T50, FE-T14, FE-T43, FE-T47, FE-T48

## 맥락

코드를 정본에 대 보니 다음이 비어 있거나 어긋났다(2026-11-23, `origin/develop` `ac6d0d077`).

1. ticket-svc의 기기 키 등록(`POST /v1/tickets/{ticketId}/device-keys`)에 재인증 확인기가 꽂혀 있지 않다(`start.ts`가 `DeviceKeys`에 `reauth`를 주지 않는다). 그래서 재발급(REISSUE)과 입장 시작 뒤 첫 등록은 늘 403이다. 받는 쪽 작업 값 `DEVICE_KEY_ISSUE`와 웹 `purpose` `device-key-issue`는 identity와 웹 앱 서버에 이미 있다.
2. 같은 403 `reauth-required`가 세 경우를 덮는다: 입장 시작 뒤 첫 등록(재인증하면 된다), 다른 휴대폰에 이미 키가 있는 티켓(재인증 뒤 다시 받기), 입장 시작 뒤 키가 있는 티켓(월렛으로는 안 되고 부스로 가야 한다). 월렛은 d5 §5.13의 '다시 확인 필요'·'저장소 유실, 입장 시작 전'·'저장소 유실, 입장 시작 뒤'를 가르지 못한다. 또 저장소는 입장 시작 뒤에도 키가 있는 티켓의 ISSUE를 재인증만 있으면 교체로 받는다(정본은 입장 시작 뒤 온라인 재발급을 막는다).
3. 재발급과 입장 시작 뒤 첫 등록을 계정 이메일·이전 기기에 알리는 길이 없다. ticket-svc에는 Outbox(같은 트랜잭션에 적는 보낼 사건 표)도 Kafka 발행도 없고, core-svc 알림 모듈은 내부 입구(HTTP)로만 사건을 받는다.
4. 월렛 서비스 워커는 `/serwist/sw.js`에서 범위 `/my/tickets`(끝 `/` 없음)로 등록된다. 정본은 `/my/tickets/sw.js`·범위 `/my/tickets/`다. 그런데 서비스 워커 범위는 주소 앞부분 글자 비교라 범위 `/my/tickets/`는 월렛 목록 주소 `/my/tickets` 자체를 맡지 못한다. 정본 §5.4가 캐시하라는 두 꼴 가운데 하나를 워커가 영영 못 받는다(정본끼리 어긋남). 킬 스위치 워커를 내는 방법도 없다.
5. 웹 푸시 구독의 화면 쪽(전용 워커 `/push/sw.js`, 권한 묻기, 구독 등록·다시 묶기·해제)이 없다. 서버(`POST`·`DELETE /v1/push-subscriptions`)는 BAT-455에서 끝났다. 브라우저가 구독을 만들 때 쓸 VAPID 공개키(푸시 서비스에 보낼 서명 키의 공개 쪽)를 화면이 받을 곳이 정해져 있지 않다.
6. 소비자 웹의 로그아웃은 폼으로 `POST /logout`만 보낸다. 대화상자의 '이 기기의 입장 키도 지우기'를 무시하고, §5.14.4의 2~4번(저장물 지우기·월렛 정리·다른 탭 알림)과 5번의 `Clear-Site-Data: "cache"`가 없다. 탈퇴 완료·계정 흡수 뒤에도 부르지 않는다. 대기실 경량 페이지(`queue-room/src/live/logout.ts`)에만 같은 루틴이 있다.
7. 부스 재발급의 서버 몫(부스 본인확인 대조, `booth-requests`, `booth-authorizations`, BOOTH 등록 허용)은 하나도 없고, BUILD_ORDER GAT-190(기능 F-05-6, A 등급)의 남은 것이다.

## 결정

1. **ticket-svc가 기기 키 등록의 재인증 토큰을 확인한다.** 양도·돌려주기가 쓰는 팬 재인증 확인기(`JwksFanReauthGate`)를 기기 키 등록에도 꽂는다. 기대 값은 받는 쪽 작업 `DEVICE_KEY_ISSUE`·작업 묶음 `FAN_SENSITIVE`이고(authz-matrix §6 표), 서명·세션·계정·남은 수명·`jti` 한 번 쓰기 규칙은 그 확인기와 같다. 확인기·`jti` 저장소 장애는 503 `reauth-unavailable`이다. 팬 공개키 묶음 주소가 없을 때의 닫힌 대역(local·ci만 늘 거절)도 양도와 같다.
2. **403을 셋으로 가른다.** 판정 차례는 지금(보유자 확인 → 같은 키 → 입장 시작 → TRANSFER → 키 있음)을 그대로 두고, 거절의 이름만 나눈다.
   - 입장 시작 전, 다른 키가 유효한데 재인증이 없거나 틀림: 403 `reissue-required`("이 티켓은 다른 기기에 입장 키가 있습니다. 다시 로그인한 뒤 이 휴대폰으로 받을 수 있습니다"). 월렛은 '저장소 유실, 입장 시작 전'을 보인다.
   - 입장 시작 뒤, 다른 키가 유효함(재인증이 있어도, 이유가 ISSUE든 REISSUE든): 403 `reissue-at-booth`("입장이 시작되어 현장 부스에서만 다시 받을 수 있습니다"). 키는 바뀌지 않는다. 월렛은 '저장소 유실, 입장 시작 뒤'를 보인다. 지금 저장소가 이 경우의 ISSUE를 교체로 받는 것은 결함이라 고친다.
   - 입장 시작 뒤 첫 등록(유효 키 없음)에 재인증이 없거나 틀림: 지금처럼 403 `reauth-required`. 월렛은 '다시 확인 필요'를 보인다.
   - BOOTH의 403 `booth-not-authorized`, TRANSFER의 403 `transfer-not-allowed`, 24시간 한도 429는 그대로다. 계약(openapi `createTicketDeviceKey`의 403 설명과 문제 이름 목록)에 두 이름을 더한다.
3. **월렛의 재발급 차례.** 403 `reissue-required`면 [ 다시 로그인하고 받기 ]가 탭 저장소 `peaket.wallet.reauth`에 `{ticketId, reason, at}`(토큰 없음)를 남기고 웹 `purpose` `device-key-issue`로 재인증을 떠난다. 돌아오면 그 표시를 한 번 읽고 지운 뒤(남긴 지 10분 [가정] 안일 때만 믿는다), `POST /reauth/token`으로 토큰을 메모리에 받아 같은 공개키로 `reason: REISSUE`와 `X-Reauth-Token`을 보낸다. 이 기기에 키가 없으면(저장소 유실) 그때 키를 새로 만들고 '확인 전'으로 먼저 저장한 뒤 보낸다. 403 `reauth-required`(입장 시작 뒤 첫 등록)는 같은 길로 `reason: ISSUE`를 보낸다. 키 처리: 403 `reissue-required`·`reauth-required`면 이 기기의 키를 두고(돌아와 같은 키로 보낸다), `reissue-at-booth`는 '그 밖의 403'처럼 지운다(부스 흐름은 그때 새 키를 만든다). 나머지 성공·실패 규칙은 docs/frontend.md §4.2.4 '입장용 휴대폰 등록 세부'를 그대로 따른다. 토큰이 만료(403)면 d5 §3의 재인증 만료 문구다.
4. **입장 키 알림은 ticket-svc의 작은 보낼 표에서 core-svc 알림 내부 입구로 보낸다.** 재발급(REISSUE, 또는 키가 있던 티켓의 ISSUE 교체)과 입장 시작 뒤 첫 등록이 성공하면, 같은 트랜잭션에 `device_key_notice` 행 하나(마이그레이션 ticket `0012_device_key_notice.sql`, docs/data.md)를 적는다. ticket-svc 안의 보내기 반복이 보내지 않은 행을 잠가(`FOR UPDATE SKIP LOCKED`) core-svc `POST /internal/v1/notify/ticket-events`로 보내고, 2xx·422면 보낸 것으로 적고, 그 밖은 1분·5분·30분 [가정] 뒤 다시 보낸다. 알림이 실패해도 등록 응답(201)은 바뀌지 않는다. core-svc는 행 ID를 중복 키에 넣어 한 번만 적고, 계정 이메일과 그 계정의 모든 웹 푸시 구독(이전 기기 포함)으로 보낸다. 알림 종류·문안·변수는 docs/features/notify.md §4.7이다. Kafka 발행(`trade.tickets` `KEY_REGISTERED`)과 소비자 배선이 생기면(BUILD_ORDER GAT-250 남은 것) 이 표와 반복을 그쪽으로 옮긴다.
5. **월렛 워커는 `/my/tickets/sw.js`에서 범위 `/my/tickets`(끝 `/` 없음)로 등록한다.** 범위 `/my/tickets/`는 월렛 목록 주소 `/my/tickets`를 맡지 못하므로(맥락 4), ADR-0079 결정 18의 뜻(대기실·좌석·결제를 가로채지 않는다)을 지키는 가장 좁은 범위는 `/my/tickets`다. 스크립트는 `/my/tickets/sw.js`에서 `Service-Worker-Allowed: /my/tickets`로 낸다. 이 범위는 `/my/tickets` 뒤에 `/`가 아닌 글자가 오는 주소(예 `/my/ticketsX`)도 맡으므로, 그런 경로를 만들지 않고 경로 목록 시험이 막는다. 범위 열쇠가 BAT-350 등록과 같아, 월렛을 다시 열면 같은 등록의 스크립트 주소만 새 주소로 바뀐다(옛 등록이 따로 남지 않는다). 옛 경로 `/serwist/*`는 없앤다. 워커 자신(`/my/tickets/sw.js`)은 늘 네트워크로 받고 캐시하지 않는다. 등록을 찾는 곳(`getRegistration`)은 `/my/tickets/`를 써도 같은 등록을 찾는다.
6. **킬 스위치는 같은 이미지의 실행 값으로 낸다.** 빌드 때 보통 워커와 함께 '등록 풀기와 캐시 지우기'만 하는 킬 스위치 워커를 묶어 둔다. 웹 앱 서버 실행 환경 `PEAKET_WALLET_SW_MODE=kill`이면 같은 주소 `/my/tickets/sw.js`가 킬 스위치 워커를 낸다(빌드 값으로 기능을 켜고 끄지 않는 규칙, docs/frontend.md §5.18). 킬 스위치 워커는 설치되자마자 활성화해 `wallet-shell-`·미리 저장 캐시를 지우고 자기 등록을 풀며 열린 월렛 창을 새로 읽힌다. IndexedDB `peaket-wallet`(입장 키)과 웹 푸시 워커(`/push/`)는 건드리지 않는다. 쓰는 때는 RB-23(되돌리기)이다.
7. **웹 푸시 구독은 화면이 전용 워커로 만들고, VAPID 공개키는 공개 빌드 값으로 받는다.** 공개키는 결제사 클라이언트 키처럼 공개해도 되는 값이라 `NEXT_PUBLIC_PEAKET_VAPID_PUBLIC_KEY`(base64url 비압축 P-256 점)로 받는다. 값은 core-svc의 `PEAKET_VAPID_PUBLIC_KEY`와 같아야 하고, local·ci는 core-svc가 쓰는 고정 시험 키다. 값이 없거나 틀린 꼴이면 웹 푸시를 켜지 않고 "이메일로 알려 드립니다"를 보인다. 워커·구독·다시 묶기·해제의 차례는 docs/frontend.md §4.2.4·§5.4와 docs/features/notify.md §3.4·§3.5가 정본이다. 처음 화면은 알림 권한 안내 시트(CMP-068)의 [알림 켜기]이고, 신청 API 호출은 지금처럼 그 화면이 한다.
8. **로그아웃 정리 루틴을 소비자 웹 한 곳에 두고 세 자리에서 부른다.** 셸 대화상자의 [로그아웃], 탈퇴 완료(204·202 직후), 계정 흡수(확정 202의 `requesterRole` MERGED, 흡수 안내로 떠나기 직전)다. 차례는 §5.14.4다: 2번(웹 푸시 해제 `DELETE`를 먼저, 실패해도 이어 감 → §3.12 표에서 지우는 때에 '로그아웃'이 있는 값과 `peaket.staff.fragment`·`peaket.wallet.reauth`) → 3번(체크했을 때만) → 4번(`BroadcastChannel('peaket.session')`의 `logout`) → 서버 로그아웃. 서버 로그아웃은 대기실처럼 같은 출처 `fetch` `POST /logout`(`redirect: 'manual'`)으로 보내고, 이동이나 2xx면 홈으로, 503·연결 실패면 대화상자 안에서 다시 시도를 안내한다. 탈퇴·흡수는 서버가 이미 세션을 끝냈으므로 서버 로그아웃을 보내지 않는다. 웹 푸시 해제 `DELETE`는 그때도 로그아웃과 같이 먼저 시도하고, 실패(세션이 끝나 401인 경우 포함)해도 이어 간다(추천 적용 2026-11-23, F-05-1 시험 결과 3. 탈퇴는 서버가 구독을 지우고, 흡수는 구독을 대표 계정으로 옮기므로 실패해도 남는 구독이 탈퇴 계정에 묶이지 않는다). 다른 탭은 `logout`을 받으면 같은 2번을 하고(3번은 그 탭이 고르지 않았으므로 하지 않는다) 로그인 화면으로 간다. 소비자 웹 앱 서버의 로그아웃 응답은 `Clear-Site-Data: "cache"` 하나를 더한다(`"cookies"`·`"storage"`는 넣지 않는다, §5.14.4 5번). 대기실 루틴과 지우는 목록이 갈라지지 않게 두 루틴이 같은 목록 모듈을 쓴다.
9. **부스 재발급은 나눈다.** 이 기능은 월렛이 403 `reissue-at-booth`를 받아 '저장소 유실, 입장 시작 뒤'의 안내 글을 보이는 데까지다. [ 부스 재발급 요청 ] 버튼과 그 뒤(대조 목적 동의, 부스 본인확인, 부스 코드 QR, BOOTH 등록)는 서버 몫과 함께 BUILD_ORDER GAT-190이 만든다. 그때까지 버튼은 그리지 않는다. 키 증명의 채택은 BUILD_ORDER GAT-030의 PC 측정과 소유자의 실기기 확인 목록 결과를 본 뒤 정한다(ADR-0051 결정 7, 실기기 확인은 소유자 몫).
10. **iOS·홈 화면 안내**(추천 적용): iOS·iPadOS 브라우저 탭(홈 화면 앱이 아님, `display-mode: standalone`이 아니고 `navigator.standalone`도 아님)에서 '이 휴대폰을 입장용으로 등록'을 누르면 키를 만들기 전에 "홈 화면에 추가한 앱에서 등록하세요"와 [ 방법 보기 ](CMP-068 홈 화면 추가 안내)·( 그래도 이 브라우저에 등록 › )를 보인다(데스크톱 안내와 같은 꼴). 등록할 때와 월렛을 열 때마다 `navigator.storage.persist()`를 부르고 결과를 `meta.persistGranted`에 둔다. 이 칸은 이 기능이 새로 넣는다(계획 때 '이미 있는 코드'로 잘못 적었던 것을 2026-11-23 시험 결과 2에 따라 바로잡음). 앱 설치 정보(`manifest.webmanifest`)의 `start_url`은 바꾸지 않는다(홈 화면 앱은 첫 화면에서 열고, 월렛은 한 번 누르면 간다).

## 결과

- 월렛이 재발급·입장 시작 뒤 첫 등록을 실제 ticket-svc로 끝내고, d5 §5.13의 저장소 유실 상태 셋을 서버 응답으로 가른다.
- 알림은 등록과 같은 트랜잭션에 남으므로 core-svc가 잠깐 멈춰도 다시 보낸다. 대신 ticket-svc에 작은 표와 반복이 하나 는다(Kafka 배선 뒤 옮긴다).
- 워커 범위가 끝 `/` 없는 `/my/tickets`로 정본이 바뀐다. `/my/ticketsX` 꼴 경로를 만들지 않는다는 규칙이 하나 생긴다.
- 로그아웃 루틴이 대기실과 소비자 웹에서 같은 목록을 쓴다.
- **남는 한계**: 월렛 목록(`GET /v1/tickets`)을 받는 서비스가 아직 없어 월렛 화면의 티켓은 목업이다. 그래서 '키가 폐기된 뒤' 안내(서버의 유효 keyId와 이 기기의 keyId가 다름)는 그 경로가 생길 때 붙인다. 이 기능의 실제 서버 확인은 화면 흐름 모듈을 실제 ticket-svc에 잇는 연결 시험으로 한다(계획 §8). 부스 재발급 버튼은 GAT-190 전까지 없다.

## 되돌릴 조건

- 브라우저가 범위 `/my/tickets` 등록을 거절하거나 `/my/tickets/` 범위로 목록 주소를 맡는 방법(앞으로 감기 없는 끝 `/` 주소)이 생기면 결정 5를 다시 본다.
- 보낼 표의 밀림이 잦으면(알림 지연이 5분 [가정]을 자주 넘으면) Kafka 배선을 앞당긴다.
