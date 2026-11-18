# ADR-0296: realtime-gw의 첫 구현은 입장 토큰을 스스로 확인하고, 구역 수는 좌석맵 판 파일에서 읽고, 묶음은 파드 하나의 100ms 박자로 보낸다(2026-11-18)

- **상태**: 채택(추천 적용, 2026-11-18, BAT-052 계획). 묶음 BAT-052(HOT-090)의 계획 담당이 정본 빈칸을 구현 전에 정했다(docs/architecture.md §8.6 4의 2). [ADR-0240](0240-seat-connection-in-worker-handshake-rejection-probe.md) '확인하지 못한 것'의 게이트웨이 PoC는 이 ADR로 판정을 미룬다(아래 결정 2).
- **관련**: [docs/features/seat-hold.md](../features/seat-hold.md) §7 'realtime-gw의 첫 구현'·§12 S-T31·S-T42, [docs/frontend.md](../frontend.md) §4.4.1, [docs/api/asyncapi.yaml](../api/asyncapi.yaml) `ws.seat-delta`, [ADR-0007](0007-service-boundaries-by-load-availability-runtime.md), [ADR-0110](0110-latency-budgets-nfr002-nfr004-aligned-expiry-100ms-batches-ms-clock.md), [ADR-0121](0121-seat-redis-failover-defer-purchase-drop-db-hold-path.md), [ADR-0183](0183-admission-confirm-first-implementation.md)
- **관련 ID**: S-T31, S-T42, NFR-004, ASVS v5.0.0-4.4.2·4.4.3·4.4.4

## 맥락

- 정본은 realtime-gw가 할 일(구독한 구역만 받기, 100ms 묶음, `maxWaitMs`, `TimeSync` 응답, 닫힘 코드, 구독 상한)과 바이트 형식(docs/frontend.md §4.4.1)을 정했다. 서비스는 아직 없었다.
- 정본은 '게이트웨이가 핸드셰이크에서 하위 프로토콜의 토큰을 확인한다'고 적었고, Envoy Gateway가 그 값을 읽어 확인할 수 있는지는 재지 못했다(ADR-0240). 그 PoC는 kind 위 게이트웨이 설정(`deploy/gateways`)이 필요하고, 그 파일은 지금 갈래 1이 고치는 중이다.
- 구독 요청 검사는 '구역 색인이 그 회차 좌석맵 판의 구역 수 안'이어야 한다(seat-hold §7). 그런데 정본은 realtime-gw가 좌석 Redis의 델타 채널 밖의 데이터 키에 닿지 않는다고 적었고(ADR-0007), 구역 수를 어디서 아는지는 적지 않았다.
- 한 묶음에 같은 구역의 메시지가 둘 이상 오면 어떻게 싣는지, `maxWaitMs`를 어느 시각으로 재는지, 느린 연결과 서버를 내릴 때 무엇을 하는지도 비어 있었다.

## 결정

1. **틀**: `services/realtime-gw`는 서비스 템플릿(`packages/platform`의 `createService`: 앱 포트·관리 포트·로그·지표·준비 확인)을 쓰고, WebSocket은 v0 모놀리스의 변경분 소켓과 같은 `ws` 8.22.0을 앱 HTTP 서버의 업그레이드에 붙인다. 업무 규칙과 저장소가 없어 도메인 층을 두지 않는다(docs/architecture.md §3.1 서비스 표).
2. **입장 토큰은 realtime-gw가 스스로 확인한다**: 핸드셰이크의 `Sec-WebSocket-Protocol`에서 `peaket.auth.` 뒤의 값을 purchase-svc와 같은 규칙(seat-hold §2 '구매 세션 열기와 확인의 첫 구현', ADR-0183 결정 8)으로 확인한다. 게이트웨이의 확인은 그대로 첫 방어선으로 두되, 그것이 되는지와 상관없이 realtime-gw가 토큰 없는 연결을 받지 않는다. 그래서 Envoy가 하위 프로토콜 값을 읽지 못해도 브라우저 계약은 바뀌지 않고, type 17 첫 메시지 인증은 쓰지 않는다(받으면 정하지 않은 `type`이라 4403). 게이트웨이 PoC는 '게이트웨이가 토큰 없는 핸드셰이크를 앞에서 막는가'만 재는 일로 줄어 뒤로 미룬다(갈래 1의 게이트웨이 작업이나 kind 배포 단계).
   - 확인 함수는 `packages/platform`에 둔다(`verifyAdmissionToken`, purchase-svc의 같은 이름 함수와 같은 규칙). purchase-svc를 그 함수로 바꾸는 일은 이 결정에 넣지 않는다(다른 갈래의 코드).
3. **구역 수는 좌석맵 판 파일에서 읽는다**: purchase-svc와 같은 임시 출처(`PEAKET_SEATMAP_DIR`의 `{eventId}.json`, LCH-080 전까지)의 `layout.sections` 개수와 `layout.layoutVersion`만 읽는다. 좌석 층은 보지 않는다. Redis 데이터 키에는 여전히 닿지 않는다(ADR-0007). 파일이 없거나 틀리면 그 회차의 핸드셰이크를 503으로 거절한다(purchase-svc가 판이 없는 회차의 스냅샷을 503으로 답하는 것과 같다).
4. **묶음은 파드 하나의 100ms 박자다**: 연결마다 타이머를 두지 않고 파드에 100ms [가정] 박자 하나를 두어, 박자마다 쌓인 것이 있는 연결에만 묶음 하나를 보낸다. 묶음 대기는 0~100ms로 정본 예산(seat-hold §7 표) 그대로다. 같은 구역의 메시지는 합치지 않고 받은 차례대로 항목 하나씩 싣는다(합치면 `sectionVersion`이 건너뛰어 화면이 스냅샷을 다시 받는다). 세대가 다른 메시지가 오면 쌓인 묶음을 바로 보낸다.
5. **`maxWaitMs` = 묶음의 `serverTimeMs` − 묶음 안 가장 이른 `changedAtMs`**(0 아래는 0, 65,535 위는 65,535). 시작점이 Redis `TIME`이라 Lua → Pub/Sub → realtime-gw 구간도 들어간다. 브라우저 계산(그린 시각 − (`serverTimeMs` − `maxWaitMs`))이 곧 '그린 시각 − 가장 이른 변경 시각'이 된다(ADR-0110 결정 4).
6. **연결 수명**: 토큰 `exp`에 4401로 닫는다. 보내기 버퍼가 1MiB [가정]를 넘은 연결은 1013으로 닫는다(다른 연결을 지키려고. 화면은 '그 밖의 비정상 종료'로 다시 붙고 스냅샷으로 맞춘다). 서버를 내릴 때는 모든 연결을 1012로 닫는다(화면은 0~5초 뒤 다시 붙는다).
7. **값과 차례는 seat-hold §7 'realtime-gw의 첫 구현'이 정본이다**: 핸드셰이크 거절 상태 코드, 프레임 검사 차례, 하트비트 박자, 구독 바꾸기의 1초 창, Redis 구독 관리, 환경 값, 지표 이름, 운영 확인 표를 거기에 적는다.

## 결과

- 게이트웨이 PoC 없이도 토큰 없는 연결이 realtime-gw에 붙지 못하고, 그 확인이 시험된다(S-T42 ①②).
- 구역 색인 검사(S-T31 ③)가 판 파일 하나로 되고, 판이 바뀐 화면은 정본대로 4403을 받아 좌석맵을 다시 받는다.
- 입장 토큰 확인 규칙이 purchase-svc와 platform 두 곳에 있다. purchase-svc가 platform 함수를 쓰게 바꿀 때까지 둘을 같은 정본 값으로 시험한다.
- 파드 박자 하나라 연결 5,000개에서도 타이머가 하나다. 연결마다 박자가 어긋나지 않아 초당 묶음 수가 '바뀐 것이 있는 연결 수 × 10' 이하로 정해진다(S-T12에서 잰다).

### 확인하지 못한 것

- 연결 5,000개·망 지연 주입(S-T12)과 실제 게이트웨이를 지난 연결은 이 결정 때 재지 않았다.
- `ws`가 연결 5,000개에서 CPU를 얼마나 쓰는지 모른다. 파드 한도의 70% [가정]를 넘으면 ADR-0110의 되돌릴 조건(묶음 150ms)을 본다.

## 다른 선택지

| 길 | 고르지 않은 까닭 |
| --- | --- |
| 게이트웨이 확인에만 기댄다(지금 정본 문구 그대로) | Envoy PoC 전에는 토큰 없는 연결이 realtime-gw까지 올 수 있다. 로컬·시험 무대에는 게이트웨이가 없어 확인이 시험되지 않는다 |
| type 17 첫 메시지 인증으로 바로 바꾼다 | 토큰 없는 연결을 일단 받아야 하고(ADR-0240 '다른 선택지'의 첫 줄과 같은 까닭), 하위 프로토콜로 되는 지금 브라우저 길을 바꿀 까닭이 없다 |
| 구역 수를 좌석 Redis의 구역 번호 Hash(`secver`) 칸 수로 센다 | 데이터 키에 닿지 않는다는 경계(ADR-0007)를 깬다. 홀드가 한 번도 없던 구역은 칸이 없어 수가 틀린다 |
| 연결마다 첫 변경이 오면 100ms 타이머를 건다 | 대기가 늘 100ms 가까이 되고(평균이 박자의 두 배), 연결 수만큼 타이머가 생긴다 |
| 같은 구역의 메시지를 마지막 번호 하나로 합친다 | 바이트는 줄지만 화면이 번호 건너뜀으로 보고 스냅샷을 다시 받는다 |
