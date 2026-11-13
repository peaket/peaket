# 완성 장부: seat-hold

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 `docs/review/ledger-notes.md`). 원천: `docs/features/seat-hold.md`, `docs/security/asvs/seat-hold.md`. 전체 개수와 이 도구의 한계는 `docs/review/ledger/README.md`에 있다.

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 79 | 13 | 15 | 2 | 0 | 21 | 1 | 0 | 0 | 131 |
| B | 85 | 30 | 0 | 0 | 0 | 4 | 0 | 15 | 22 | 156 |
| 합계 | 164 | 43 | 15 | 2 | 0 | 25 | 1 | 15 | 22 | 287 |

## docs/features/seat-hold.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| S-T1 | — | 1개 좌석 1,000명 동시 경합 | 단 1명만 홀드에 성공(201)하고, 나머지 999명은 ≤ 50ms 이내에 409 Conflict를 받는다. 초과 판매 0건, p99 50ms 및 p99.9… | 측정 | A | PRF-220 · 1개 좌석 1,000명 동시 경합. v1 K2 TLS 켬 3·끔 1(2026-11-11-k2-v1-hot-tls-r1~r3·notls-r1)은 발생기 놓침 920~1,504로 모두 무효, p99… |
| S-T2 | — | 데이터베이스 불변식 검사기 | 무결성 위반 0건을 검증한다. | 자동 시험 | A | 시험: services/invariant-checker/test-int/invariants.int.test.ts |
| S-T3 | — | 다중 탭 및 분산 기기 한도 검증 | 1인당 매수 한도 초과 0건을 입증한다. 한도 초과로 실패한 요청은 어떤 좌석도 홀드하지 않는다. | 자동 시험 | A | 시험: services/purchase-svc/test/hold-cases.ts, services/v0-monolith/test-int/seat.int.test.ts |
| S-T4 | — | 다중 좌석 원자적 홀드 검증 | 요청 전체가 한꺼번에 실패(409)하고 부분 홀드가 0건임을 입증한다. | 자동 시험 | A | 시험: services/purchase-svc/test-int/seat-snapshot.int.test.ts, services/purchase-svc/test-int/seat-store.int.test.ts 외 8곳 |
| S-T5 | — | 펜싱 토큰 기반 구버전 무시 | 비동기 원장 적재 워커와 실시간 델타 전파기가 토큰을 비교해 옛 버전 이벤트를 안전하게 무시한다. | 자동 시험 | A | 시험: services/purchase-svc/test-int/seat-hold-ledger.int.test.ts, services/purchase-svc/test-int/seat-rebuild.int.test.ts… |
| S-T6 | — | 홀드 TTL 만료 및 연장 검증 | 만료 좌석이 p99 3초 안에 다시 보이고 사용자 보유 수가 줄어든다. 두 번째 연장 시도는 409 Conflict를 받는다. | 자동 시험 | A | 시험: apps/web/src/_pages/seats/model/hold-lifecycle.test.mjs, services/purchase-svc/test-int/hold-lifecycle.int.test.ts… |
| S-T7 | — | 홀드 만료 후 결제 접수 처리 | 좌석이 비어 있으면 Hard Sale PENDING 예약에 성공한다. 다른 사람이 홀드했으면 무과금 안내로 끝낸다. | 자동 시험 | A | 시험: services/purchase-svc/test-int/saga-e2e.int.test.ts, services/purchase-svc/test-int/seat-rebuild.int.test.ts 외 4곳 |
| S-T8 | — | Hard Sale 최종 경합 검증 | PostgreSQL 유니크 제약조건 위반으로 1건만 최종 예약된다. 진 주문은 PG 승인 호출 없이 무과금으로 끝난다. | 측정 | A | PRF-140 · Hard Sale 최종 경합. 판정이 부하 수치다 (이름을 단 시험도 있다) |
| S-T9 | — | Redis 프라이머리 노드 장애 복구 | 장애 조치 동안 그 회차의 구매 요청은 503 `seat-store-unavailable`과 `Retry-After`를 받고, 두 곳에서 홀드를 주는 일(이중… | 측정 | A | 구간 측정 · Redis 주 노드 장애 복구 |
| S-T10 | — | 데드락 방지 및 DB 튜닝 검증 | `pg_stat_database.deadlocks` 발생 건수 0건을 유지한다. 핵심 쿼리 p95 지연시간(요청 백 건 중 아흔다섯 건이 이 시간 안에 끝난다는… | 측정 | A | PRF-140 · 교착 방지와 DB 튜닝. 판정이 부하 수치다 (이름을 단 시험도 있다) |
| S-T11 | — | 트랜잭션 격리 수준 비교 실험 | 부분 유니크 인덱스가 격리 수준과 무관하게 최종 오버셀을 막는 마지막 방어선임을 입증한다. | 측정 | A | PRF-140 · 트랜잭션 격리 수준 비교. 판정이 부하 수치다 (이름을 단 시험도 있다) |
| S-T12 | — | 실시간 전파 대역폭 및 지연시간 | 합격은 절대값으로만 판정한다. 상태가 바뀐 뒤(홀드 Lua의 변경 시각, 묶음 대기 포함) 화면에 그려지기까지의 종단 p99 지연시간 300ms… | 측정 | A | HOT-090 · 실시간 전파 대역폭과 지연 (이름을 단 시험도 있다) |
| S-T13 | — | 전파 버전 갭 자가 치유 검증 | 30초 이내에 그 섹션 스냅샷을 다시 받아, 99.9% 확률로 완전히 회복됨을 입증한다. 버전 건너뜀을 3,000번 이상 만들고, 30초 안에 회복하지 못한… | 다른 단계 | A | 미정 · 전파 버전 갭 자가 치유 |
| S-T14 | — | 실시간 전파 Degraded Mode 검증 | 1초 배치 주기로 자동 완화 전환되어 완화 SLO p99 1.5초를 지키고, 초과 판매 0건을 유지한다. | 측정 | A | 구간 측정 · 실시간 전파 Degraded Mode |
| S-T15 | — | 대규모 좌석맵 그리기 성능 검증 | 5만 석 화면 표시 1초 미만, 4배 스로틀 환경에서 INP ≤ 200ms, 조작 경로 Long Task 0건, 화면 이동 뒤 메모리 누수 0건. v0 대비 힙… | 측정 | A | 구간 측정 · 대규모 좌석맵 그리기 성능 (이름을 단 시험도 있다) |
| S-T16 | ① | 구매 세션 탈취 재현과 소지 증명 검증(ADR-0124) | ①은 공격마다 결과를 '방해'(좌석·한도·시간을 묶음)와 '이득'(돈이나 티켓이 공격자 쪽으로 감)으로 나눠 기록하고, ADR-0124 결정 2대로 소지 증명을… | 사람 확인 | A | BOT-100 · 공격마다 결과를 '방해'와 '이득'으로 나눠 기록하고 소지 증명을 남길지 정하는 것은 사람의 판단이다(ADR-0124 결정 2) |
| S-T16 | ② | 구매 세션 탈취 재현과 소지 증명 검증(ADR-0124) | ②는 서버 계층에서 바로 401로 거부되고, 정상 요청의 확인 p99가 1ms 예산 안에서 끝난다 | 측정 | A | BAT-090 heavy gate · 탈취 거부(서명 변조·재전송·다른 세션 키)는 `services/purchase-svc/test/purchase-session-theft.test.ts`가 본다. 정상 요청… |
| S-T17 | — | (없앰 2026-10-28) 스냅샷 헤지(Hedged) 요청 검증 | — | 없앰 | A | — |
| S-T18 | — | 화면 낭독기 웹 접근성 검증 | 모든 회차가 완주해 예매 완주율 100%를 달성하고(개발자 수동 시험으로 표시), axe Core 자동 검사 위반 건수 0건을 충족한다… | 사람 확인 | A | BAT-175 · 화면 낭독기로 사람이 예매를 완주한다(axe 자동 검사는 CI). 확인 목록은 docs/review/manual-a11y/S-T18.md다. VoiceOver(iOS Safari)는 기기를 구할… |
| S-T19 | — | 자동 좌석 배정 모드 검증 | 배정 좌석이 희망 조건 규칙(1순위 연석, 분리 허용 시 1순위 분리, 2순위 순)대로 정확히 할당되고, 중복 홀드는 0건이다. 모든 후보가 실패하면 아무… | 측정 | A | BAT-090 heavy gate · 자동 배정 1,000건 동시·1순위 매진·분리 조합. 단위 시험은 후보·분리·수동 전환을 본다. 2026-11-13 측정: 100 동시×10묶음 1,000/1,000·중복… |
| S-T20 | — | 자동 배정 순서 공정성 | 순번과 배정 순서의 스피어만 상관계수 0.99 이상, 봇의 평균 순위 이득(순번 순위 − 배정 순위)이 입장 제어 루프 1주기분(약 6명) 이하 [가정… | 측정 | A | BAT-090 heavy gate · 자동 배정 순서 공정성. 2026-11-13 측정: 같은 조건 순차 10건×2회 R0001~R0020 동일·굶주림 0(보고서 §6) (이름을 단 시험도 있다) |
| S-T21 | — | 확대 표시와 구역 구독 | 좌석이 보이는 구역만 구독되고(전체 보기에서 0개) 축소하면 해제된다. 보이는 좌석의 다른 분 선택은 p99 300ms 안에 바뀌고, 전체 보기의 구역 상태는… | 다른 단계 | A | 미정 · 확대 표시와 구역 구독 |
| S-T22 | ① | 판매 종료 뒤 홀드 | ① 앞은 201, 뒤는 410 `sale-ended`이고 좌석을 잡지 않는다 | 다른 단계 | A | 미정 · 판매 종료 뒤 홀드 |
| S-T22 | ② | 판매 종료 뒤 홀드 | ② 홀드 TTL·연장·결제창 유지 규칙 안에서 성공한다 | 다른 단계 | A | 미정 · 판매 종료 뒤 홀드 |
| S-T22 | ③ | 판매 종료 뒤 홀드 | ③ 비트맵은 풀리지만 새 홀드는 410이라 다시 팔리지 않는다 | 다른 단계 | A | 미정 · 판매 종료 뒤 홀드 |
| S-T23 | ① | 결제 일시 정지 중 홀드 시간 멈춤 | ① 멈춘 동안 회수 0건이고, 다시 열린 뒤 남은 3분에서 이어 센다(±1초) | 자동 시험 | A | 시험: services/purchase-svc/test-int/hold-lifecycle-edge.int.test.ts, services/purchase-svc/test-int/hold-lifecycle.int.te… |
| S-T23 | ② | 결제 일시 정지 중 홀드 시간 멈춤 | ② 둘 다 원래 시각에 회수된다 | 자동 시험 | A | 시험: services/purchase-svc/test-int/hold-lifecycle-edge.int.test.ts, services/purchase-svc/test-int/hold-lifecycle.int.te… |
| S-T23 | ③ | 결제 일시 정지 중 홀드 시간 멈춤 | ③ 최대 체류 시각에 회수된다 | 자동 시험 | A | 시험: services/purchase-svc/test-int/hold-lifecycle.int.test.ts, services/purchase-svc/test/manage-holds.test.ts |
| S-T23 | ④ | 결제 일시 정지 중 홀드 시간 멈춤 | ④ 10초 [가정] 뒤 다시 열린 것으로 보아 §5 표 아래 … 대로 멈춘 홀드를 되돌린다(본문을 따른다, 추천 적용 2026-11-09, BUILD_ORDER… | 자동 시험 | A | 시험: services/purchase-svc/test/hold-pause-view.test.ts |
| S-T23 | ⑤ | 결제 일시 정지 중 홀드 시간 멈춤 | ⑤ 멈춘 홀드는 만료 인덱스에 없고, 버린 주문 전 홀드가 원래 시각 +1초 안에 회수된다 | 자동 시험 | A | 시험: services/purchase-svc/test-int/hold-lifecycle.int.test.ts |
| S-T23 | ⑥ | 결제 일시 정지 중 홀드 시간 멈춤 | ⑥ 옮기기·되돌리기 Lua 한 번(200개)의 실행 시간을 적고(1ms [가정] 이하), 다시 여는 동안 그 회차 홀드 p99가 50ms 이하다 | 측정 | A | 구간 측정 · 옮기기·되돌리기 Lua 200개가 이 PC에서 p50 1.6ms·p99 2.0ms로 1ms [가정]을 넘었다(docs/review/pilot-purchase-path-perf.md). 다시 여는… |
| S-T24 | ① | 홀드 멱등키(추천 적용 2026-10-28, 기술 검토 중간-046) | ① 좌석은 한 번만 잡히고(보유 수 증가 1번) 두 응답의 holdId가 같다 | 자동 시험 | A | 시험: services/purchase-svc/test/hold-cases.ts, services/purchase-svc/test/hold-seats.test.ts 외 1곳 |
| S-T24 | ② | 홀드 멱등키(추천 적용 2026-10-28, 기술 검토 중간-046) | ② 422 `idempotency-key-reused`이고 아무 좌석도 잡지 않는다 | 자동 시험 | A | 시험: services/purchase-svc/test/hold-cases.ts, services/purchase-svc/test/hold-seats.test.ts 외 1곳 |
| S-T24 | ③ | 홀드 멱등키(추천 적용 2026-10-28, 기술 검토 중간-046) | ③ 새로 시도한다 | 자동 시험 | A | 시험: services/purchase-svc/test/hold-cases.ts |
| S-T24 | ④ | 홀드 멱등키(추천 적용 2026-10-28, 기술 검토 중간-046) | ④ 남의 응답을 받지 않고 따로 처리된다 | 자동 시험 | A | 시험: services/purchase-svc/test/hold-cases.ts |
| S-T24 | ⑤ | 홀드 멱등키(추천 적용 2026-10-28, 기술 검토 중간-046) | ⑤ 새 요청으로 처리된다. 홀드 p99 지연은 이전 방식(Lua 밖 확인)보다 나빠지지 않는다 | 자동 시험 | A | 시험: services/purchase-svc/test/hold-cases.ts, services/purchase-svc/test/hold-seats.test.ts |
| S-T25 | ① | 회차 판매 상태 판정(추천 적용 2026-10-28, ADR-0122) | ① 5초 뒤 ALL_HELD | 자동 시험 | A | 시험: services/purchase-svc/test/sale-state-domain.test.ts |
| S-T25 | ② | 회차 판매 상태 판정(추천 적용 2026-10-28, ADR-0122) | ② 처음 0이 된 때부터 5초가 지나도 ALL_HELD가 되지 않고, 다시 0이 된 때부터 5초 뒤에 된다 | 자동 시험 | A | 시험: services/purchase-svc/test/sale-state-domain.test.ts |
| S-T25 | ③ | 회차 판매 상태 판정(추천 적용 2026-10-28, ADR-0122) | ③ ALL_HELD를 지킨다(결제 중 9) | 자동 시험 | A | 시험: services/purchase-svc/test/sale-state-domain.test.ts |
| S-T25 | ④ | 회차 판매 상태 판정(추천 적용 2026-10-28, ADR-0122) | ④ 두 번 이어진 판정 뒤 SOLD_OUT(입금 대기는 팔린 쪽) | 자동 시험 | A | 시험: services/purchase-svc/test/sale-state-domain.test.ts, services/purchase-svc/test/sale-state-judge.test.ts |
| S-T25 | ⑤ | 회차 판매 상태 판정(추천 적용 2026-10-28, ADR-0122) | ⑤ SOLD_OUT | 자동 시험 | A | 시험: services/purchase-svc/test/sale-state-domain.test.ts |
| S-T25 | ⑥ | 회차 판매 상태 판정(추천 적용 2026-10-28, ADR-0122) | ⑥ ON_SALE(매진 풀림) | 자동 시험 | A | 시험: services/purchase-svc/test/sale-state-domain.test.ts, services/purchase-svc/test/sale-state-judge.test.ts |
| S-T25 | ⑦ | 회차 판매 상태 판정(추천 적용 2026-10-28, ADR-0122) | ⑦ 같은 회차를 두 파드가 함께 판정하지 않고, 판 번호가 거꾸로 가는 `EventSaleChanged`가 0건이다 | 자동 시험 | A | 시험: services/purchase-svc/test/sale-state-judge.test.ts |
| S-T25 | ⑧ | 회차 판매 상태 판정(추천 적용 2026-10-28, ADR-0122) | ⑧ 판매 중·일시 매진·매진 회차는 같은 `version`·`eventKey`에 새 셈과 `countedAt`으로 5초 [가정]마다 다시 나간다… | 자동 시험 | A | 시험: services/purchase-svc/test/sale-state-domain.test.ts, services/purchase-svc/test/sale-state-judge.test.ts |
| S-T25 | ⑨ | 회차 판매 상태 판정(추천 적용 2026-10-28, ADR-0122) | ⑨ 두 번 이어져야 `soldOutTiers`에 들고 판 번호가 오른다(상태는 그대로). 좌석이 돌아오면 바로 빠지고 판 번호가 오른다 | 자동 시험 | A | 시험: services/purchase-svc/test-int/sale-state.int.test.ts, services/purchase-svc/test/sale-state-domain.test.ts 외 1곳 |
| S-T25 | ⑩ | 회차 판매 상태 판정(추천 적용 2026-10-28, ADR-0122) | ⑩ 99건이면 `avgTicketsPerOrder`가 없고, 100건이면 소수 둘째 자리 값이다 | 자동 시험 | A | 시험: services/purchase-svc/test-int/sale-state.int.test.ts, services/purchase-svc/test/sale-state-domain.test.ts 외 1곳 |
| S-T25 | ⑪ | 회차 판매 상태 판정(추천 적용 2026-10-28, ADR-0122) | ⑪ SOLD_OUT이 되지 않고 `purchase_event_sale_guard_blocked_total`이 오른다 | 자동 시험 | A | 시험: services/purchase-svc/test-int/sale-state.int.test.ts, services/purchase-svc/test/sale-state-domain.test.ts 외 1곳 |
| S-T25 | ⑫ | 회차 판매 상태 판정(추천 적용 2026-10-28, ADR-0122) | ⑫ 판정과 쓰기를 하지 않아 상태가 그대로이고 `purchase_event_sale_skipped_total{reason="not_ready"}`이 오른다 | 자동 시험 | A | 시험: services/purchase-svc/test-int/sale-state.int.test.ts, services/purchase-svc/test/sale-state-judge.test.ts |
| S-T25 | ⑬ | 회차 판매 상태 판정(추천 적용 2026-10-28, ADR-0122) | ⑬ 행의 마지막 셈으로 ENDED가 된다 | ID만 | A | 시험: services/purchase-svc/test-int/hold-lifecycle-edge.int.test.ts, services/purchase-svc/test-int/purchase-migration.in… |
| S-T25 | ⑭ | 회차 판매 상태 판정(추천 적용 2026-10-28, ADR-0122) | ⑭ SOLD_OUT 그대로이고 `purchase_event_sale_guard_blocked_total`이 오르며 회차 경고가 남는다 | ID만 | A | 시험: services/purchase-svc/test-int/hold-lifecycle-edge.int.test.ts, services/purchase-svc/test-int/purchase-migration.in… |
| S-T26 | ① | 회차 세대와 준비 표시(추천 적용 2026-10-28, 기술 검토… | ① 세대가 오르고, 모든 연결이 1초 [가정] 안에 구독 구역의 스냅샷을 다시 받아 맞춘다. 장애 조치 뒤 새 델타를 버린 연결이 0이다 | ID만 | A | 시험: services/purchase-svc/test-int/relay-app.int.test.ts, services/purchase-svc/test-int/saga-e2e.int.test.ts 외 27곳 |
| S-T26 | ② | 회차 세대와 준비 표시(추천 적용 2026-10-28, 기술 검토… | ② 세대는 한 번만 오른다 | ID만 | A | 시험: services/purchase-svc/test-int/relay-app.int.test.ts, services/purchase-svc/test-int/saga-e2e.int.test.ts 외 27곳 |
| S-T26 | ③ | 회차 세대와 준비 표시(추천 적용 2026-10-28, 기술 검토… | ③ 503 `seat-store-unavailable`이고 좌석을 잡지 않는다 | 자동 시험 | A | 시험: services/purchase-svc/test-int/seat-store.int.test.ts, services/purchase-svc/test/expiry-cases.ts 외 10곳 |
| S-T26 | ④ | 회차 세대와 준비 표시(추천 적용 2026-10-28, 기술 검토… | ④ 다시 만들기가 끝나 세대 키가 서기 전에는 모든 홀드가 503이고, 끝난 뒤 판매된 좌석은 '판매', 원장의 만료 전 홀드는 '다른 분 선택'으로 보이며… | 자동 시험 | A | 시험: services/purchase-svc/test-int/saga-e2e.int.test.ts, services/purchase-svc/test/order-saga.test.ts 외 1곳 |
| S-T27 | ① | 좌석 샤드 하나의 처리량 상한(추천 적용 2026-10-28, 기술… | ① 모두 홀드 Lua 실행 시간 p99 0.3ms 이하 가정, SLOWLOG(기록 기준 10ms로 둔다)에 남은 기록 0, 그 샤드 엔진 CPU 50% 이하… | 측정 | A | 구간 측정 · 좌석 샤드 하나의 처리량 상한. 판정이 부하 수치다 |
| S-T27 | ② | 좌석 샤드 하나의 처리량 상한(추천 적용 2026-10-28, 기술… | ② 모두 홀드 Lua 실행 시간 p99 0.3ms 이하 가정, SLOWLOG(기록 기준 10ms로 둔다)에 남은 기록 0, 그 샤드 엔진 CPU 50% 이하… | 측정 | A | 구간 측정 · 좌석 샤드 하나의 처리량 상한. 판정이 부하 수치다 |
| S-T28 | ① | 구매 세션의 회차 묶기(추천 적용 2026-10-30, §2… | ①은 gw-fan에서 모두 403이고 좌석·한도·주문에 변화가 0건이다 | 자동 시험 | A | 시험: services/purchase-svc/test/open-purchase-session.test.ts, services/purchase-svc/test/purchase-session-cases.ts |
| S-T28 | ② | 구매 세션의 회차 묶기(추천 적용 2026-10-30, §2… | ②는 닫힘 코드 4403이고 회차 B의 델타를 한 프레임도 받지 않는다 | 자동 시험 | A | 시험: services/purchase-svc/test/purchase-session-cases.ts |
| S-T28 | ③ | 구매 세션의 회차 묶기(추천 적용 2026-10-30, §2… | ③은 purchase-svc가 구매 세션 상태의 회차와 대조해 403으로 막는다. 거절은 보안 이벤트로 남는다 | 자동 시험 | A | 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts 외 4곳 |
| S-T28 | ④ | 구매 세션의 회차 묶기(추천 적용 2026-10-30, §2… | ④는 그 구매 세션의 홀드 목록에 없어 404이고 주문이 생기지 않는다(주문·결제 경로는 주소에 회차가 없어 자기 것만 규칙으로 막는다, 추천 적용… | 자동 시험 | A | 시험: services/purchase-svc/test/open-purchase-session.test.ts, services/purchase-svc/test/purchase-session-cases.ts |
| S-T29 | ① | 자기 홀드만 해제·연장(추천 적용 2026-10-30, §3… | ①는 같은 404이고 본문이 같다. B의 홀드·만료 시각·보유 수는 그대로다 | 자동 시험 | A | 시험: services/purchase-svc/test-int/hold-lifecycle-edge.int.test.ts, services/purchase-svc/test-int/hold-lifecycle.int.te… |
| S-T29 | ② | 자기 홀드만 해제·연장(추천 적용 2026-10-30, §3… | ②는 같은 404이고 본문이 같다. B의 홀드·만료 시각·보유 수는 그대로다 | 자동 시험 | A | 시험: services/purchase-svc/test-int/hold-lifecycle-edge.int.test.ts, services/purchase-svc/test-int/hold-lifecycle.int.te… |
| S-T29 | ③ | 자기 홀드만 해제·연장(추천 적용 2026-10-30, §3… | ③은 그 세션 목록에 없어 404다 | 자동 시험 | A | 시험: services/purchase-svc/test-int/hold-lifecycle-edge.int.test.ts, services/purchase-svc/test-int/hold-lifecycle.int.te… |
| S-T29 | ④ | 자기 홀드만 해제·연장(추천 적용 2026-10-30, §3… | ④는 Lua가 holdId·소유 계정 대조에서 바꾸지 않는다(좌석 상태 변화 0) | 자동 시험 | A | 시험: services/purchase-svc/test-int/hold-lifecycle.int.test.ts |
| S-T29 | ⑤ | 자기 홀드만 해제·연장(추천 적용 2026-10-30, §3… | ⑤은 404이고 B의 주문·결제 시도에 변화가 없다( … 은 추천 적용 2026-10-30) | 자동 시험 | A | 시험: services/payment-svc/test-int/purchase-path-e2e.int.test.ts |
| S-T29 | ⑥ | 자기 홀드만 해제·연장(추천 적용 2026-10-30, §3… | ⑥은 404이고 B의 주문·결제 시도에 변화가 없다( … 은 추천 적용 2026-10-30) | 자동 시험 | A | 시험: services/purchase-svc/test-int/accept-e2e.int.test.ts, services/purchase-svc/test/accept-http.test.ts 외 1곳 |
| S-T30 | ⑤ | 홀드 좌석 ID 검사(추천 적용 2026-10-30, §3… | ⑤도 부분 홀드가 0건이다 | 자동 시험 | A | 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts |
| S-T31 | ① | 좌석 구독 상한과 프레임 검사(추천 적용 2026-10-30, §7… | ①는 닫힘 코드 4429다 | 다른 단계 | A | 미정 · 좌석 구독 상한과 프레임 검사 |
| S-T31 | ② | 좌석 구독 상한과 프레임 검사(추천 적용 2026-10-30, §7… | ②는 닫힘 코드 4429다 | 다른 단계 | A | 미정 · 좌석 구독 상한과 프레임 검사 |
| S-T31 | ③ | 좌석 구독 상한과 프레임 검사(추천 적용 2026-10-30, §7… | ③는 4403이다 | 다른 단계 | A | 미정 · 좌석 구독 상한과 프레임 검사 |
| S-T31 | ④ | 좌석 구독 상한과 프레임 검사(추천 적용 2026-10-30, §7… | ④는 4403이다 | 다른 단계 | A | 미정 · 좌석 구독 상한과 프레임 검사 |
| S-T31 | ⑤ | 좌석 구독 상한과 프레임 검사(추천 적용 2026-10-30, §7… | ⑤는 두 번째 `TimeSync`에 답이 없다 | 다른 단계 | A | 미정 · 좌석 구독 상한과 프레임 검사 |
| S-T31 | ⑥ | 좌석 구독 상한과 프레임 검사(추천 적용 2026-10-30, §7… | ⑥은 상한에 닿지 않아 닫힘이 0번이다. 4429로 닫힌 화면은 10초 넘게 지난 뒤 다시 붙는다(docs/frontend.md §4.4.1) | 다른 단계 | A | 미정 · 좌석 구독 상한과 프레임 검사 |
| S-T32 | ① | 좌석맵 가져오기 공격 파일(추천 적용 2026-10-30, §10… | ①는 422이고 바깥 연결이 0번이다(시험 서버 접속 기록) | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts |
| S-T32 | ② | 좌석맵 가져오기 공격 파일(추천 적용 2026-10-30, §10… | ②는 422이고 바깥 연결이 0번이다(시험 서버 접속 기록) | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts |
| S-T32 | ③ | 좌석맵 가져오기 공격 파일(추천 적용 2026-10-30, §10… | ③은 정한 도형만 읽고 나머지는 검증 결과의 경고로 나온다 | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts |
| S-T32 | ④ | 좌석맵 가져오기 공격 파일(추천 적용 2026-10-30, §10… | ④는 413·422다 | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-import.int.test.ts |
| S-T32 | ⑤ | 좌석맵 가져오기 공격 파일(추천 적용 2026-10-30, §10… | ⑤은 422다 | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts |
| S-T32 | ⑥ | 좌석맵 가져오기 공격 파일(추천 적용 2026-10-30, §10… | ⑥은 422다 | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts |
| S-T32 | ⑦ | 좌석맵 가져오기 공격 파일(추천 적용 2026-10-30, §10… | ⑦은 422다 | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-import.int.test.ts |
| S-T32 | ⑧ | 좌석맵 가져오기 공격 파일(추천 적용 2026-10-30, §10… | ⑧은 그 문자를 지운 이름으로 읽는다. 어느 경우든 원본 파일이 저장소에 남지 않는다 | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts 외 1곳 |
| S-T33 | ① | 방금 놓은 좌석 다시 잡기(소유자 결정 2026-10-30… | ① 409 `seat-recently-released`이고 `reholdAvailableAt`이 해제 시각 + 30초(±1초)다. 좌석·보유 수에 변화가 없다 | 자동 시험 | A | 시험: services/purchase-svc/test-int/hold-lifecycle-edge.int.test.ts, services/purchase-svc/test-int/hold-lifecycle.int.te… |
| S-T33 | ② | 방금 놓은 좌석 다시 잡기(소유자 결정 2026-10-30… | ② B는 201 | 자동 시험 | A | 시험: services/purchase-svc/test-int/hold-lifecycle.int.test.ts |
| S-T33 | ③ | 방금 놓은 좌석 다시 잡기(소유자 결정 2026-10-30… | ③ 29초는 409, 31초는 201 | 자동 시험 | A | 시험: services/purchase-svc/test/expiry-cases.ts, services/purchase-svc/test/expiry-sweeper.test.ts |
| S-T33 | ④ | 방금 놓은 좌석 다시 잡기(소유자 결정 2026-10-30… | ④ 409이고 부분 홀드가 0건이다 | 자동 시험 | A | 시험: services/purchase-svc/test/hold-cases.ts, services/purchase-svc/test/hold-seats.test.ts 외 1곳 |
| S-T33 | ⑤ | 방금 놓은 좌석 다시 잡기(소유자 결정 2026-10-30… | ⑤ 같은 좌석이 다시 배정되지 않는다(남은 좌석이 있으면 다른 좌석, 없으면 `manual-selection-required`) | ID만 | A | 시험: apps/web/src/_pages/seats/model/hold-lifecycle.test.mjs, services/payment-svc/test-int/purchase-path-e2e.int.test.ts… |
| S-T33 | ⑥ | 방금 놓은 좌석 다시 잡기(소유자 결정 2026-10-30… | ⑥ 409(계정 단위) | 자동 시험 | A | 시험: services/payment-svc/test-int/purchase-path-e2e.int.test.ts, services/purchase-svc/test/manage-holds.test.ts 외 2곳 |
| S-T33 | ⑦ | 방금 놓은 좌석 다시 잡기(소유자 결정 2026-10-30… | ⑦ 409 `seat-already-held`(경합이 먼저) | 자동 시험 | A | 시험: services/purchase-svc/test/hold-cases.ts, services/purchase-svc/test/hold-seats.test.ts 외 1곳 |
| S-T33 | ⑧ | 방금 놓은 좌석 다시 잡기(소유자 결정 2026-10-30… | ⑧ 홀드 p99가 50ms 이하이고, 홀드 Lua 실행 p99가 이 확인을 넣기 전보다 나빠진 값을 적는다 | ID만 | A | 시험: apps/web/src/_pages/seats/model/hold-lifecycle.test.mjs, services/payment-svc/test-int/purchase-path-e2e.int.test.ts… |
| S-T34 | ① | 좌석맵 해석 작업 격리(소유자 결정 2026-10-30… | ① DB·Kafka·Redis 자격 증명과 AWS 권한이 0개다 | 다른 단계 | A | HOT-420·BAS-140 · 좌석맵 해석 작업 배포의 자격 증명·나가는 통신·메시 신원은 배포 상태(BAS-140)와 메시·NetworkPolicy(HOT-420, D-T36)가 정한다. 코드 몫(자격 증명… |
| S-T34 | ② | 좌석맵 해석 작업 격리(소유자 결정 2026-10-30… | ② 모든 연결이 막힌다 | 다른 단계 | A | HOT-420·BAS-140 · 좌석맵 해석 작업 배포의 자격 증명·나가는 통신·메시 신원은 배포 상태(BAS-140)와 메시·NetworkPolicy(HOT-420, D-T36)가 정한다. 코드 몫(자격 증명… |
| S-T34 | ③ | 좌석맵 해석 작업 격리(소유자 결정 2026-10-30… | ③ `PERMISSION_DENIED` | 다른 단계 | A | HOT-420·BAS-140 · 좌석맵 해석 작업 배포의 자격 증명·나가는 통신·메시 신원은 배포 상태(BAS-140)와 메시·NetworkPolicy(HOT-420, D-T36)가 정한다. 코드 몫(자격 증명… |
| S-T34 | ④ | 좌석맵 해석 작업 격리(소유자 결정 2026-10-30… | ④ CPU는 422, 메모리는 파드 재시작과 503이고, core-svc 파드와 다른 가져오기 요청은 영향이 없다 | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-import.int.test.ts |
| S-T34 | ⑤ | 좌석맵 해석 작업 격리(소유자 결정 2026-10-30… | ⑤ 503과 `Retry-After` | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-import.int.test.ts |
| S-T34 | ⑥ | 좌석맵 해석 작업 격리(소유자 결정 2026-10-30… | ⑥ core-svc가 422로 거절한다(다시 검사) | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-import.int.test.ts |
| S-T34 | ⑦ | 좌석맵 해석 작업 격리(소유자 결정 2026-10-30… | ⑦ 413이고 작업을 부르지 않는다 | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-import.int.test.ts |
| S-T35 | ① | 홀드 시도의 조사용 칸(추천 적용 2026-10-31… | ①은 `seatIds`가 잡은 좌석이고 `heldAt`이 같은 홀드의 SeatEvent HELD `occurredAt`·`seat_hold.held_at`과 같다 | 자동 시험 | A | 시험: services/purchase-svc/test/hold-cases.ts, services/purchase-svc/test/hold-seats.test.ts |
| S-T35 | ② | 홀드 시도의 조사용 칸(추천 적용 2026-10-31… | ②는 `seatIds`가 요청한 좌석이고 `heldAt`이 없다 | 자동 시험 | A | 시험: services/purchase-svc/test/hold-seats.test.ts |
| S-T35 | ③ | 홀드 시도의 조사용 칸(추천 적용 2026-10-31… | ③는 `seatIds`가 요청한 좌석이고 `heldAt`이 없다 | 자동 시험 | A | 시험: services/purchase-svc/test/hold-seats.test.ts |
| S-T35 | ④ | 홀드 시도의 조사용 칸(추천 적용 2026-10-31… | ④는 `seatIds`가 요청한 좌석이고 `heldAt`이 없다 | 자동 시험 | A | 시험: services/purchase-svc/test/hold-seats.test.ts |
| S-T35 | ⑤ | 홀드 시도의 조사용 칸(추천 적용 2026-10-31… | ⑤ 성공은 `seatIds`·`heldAt`이 잡은 좌석·시각이고, 실패는 둘 다 없다 | ID만 | A | 시험: services/purchase-svc/test-int/consumers.int.test.ts, services/purchase-svc/test-int/purchase-session.int.test.ts 외… |
| S-T35 | ⑥ | 홀드 시도의 조사용 칸(추천 적용 2026-10-31… | ⑥ 홀드 p99가 50ms 이하이고, 홀드 Lua 실행 p99가 칸을 더하기 전보다 나빠진 값을 적는다 | 측정 | A | PRF-220 · `lua-compare` A/A p50 ±2.1~6.7%·p99 ±4.6~15.9%. `end-session` p50 1.583/1.769, `order-hold` p99 1.216로 A/A 폭을… |
| S-T36 | ① | 좌석 화면 행동 요약(추천 적용 2026-10-31, ADR-0171… | ① `BehaviorSignal`(screen `SEAT`, `journeyId`, pid, 회차) 1건이고 `netClass`·`asn`·기기 가명·좌석… | ID만 | A | 시험: services/purchase-svc/test/seat-behavior.test.ts |
| S-T36 | ② | 좌석 화면 행동 요약(추천 적용 2026-10-31, ADR-0171… | ② 그 구매 세션의 신호는 1건 그대로다 | ID만 | A | 시험: services/purchase-svc/test/seat-behavior.test.ts |
| S-T36 | ③ | 좌석 화면 행동 요약(추천 적용 2026-10-31, ADR-0171… | ③ 처음 응답(201)을 받고 신호가 늘지 않는다 | ID만 | A | 시험: services/purchase-svc/test/seat-behavior.test.ts |
| S-T36 | ④ | 좌석 화면 행동 요약(추천 적용 2026-10-31, ADR-0171… | ④ 신호가 0건이다 | ID만 | A | 시험: services/purchase-svc/test/seat-behavior.test.ts |
| S-T36 | ⑤ | 좌석 화면 행동 요약(추천 적용 2026-10-31, ADR-0171… | ⑤ 홀드는 정상 응답이고 버린 신호가 `telemetry_dropped_total`로 세어진다 | ID만 | A | 시험: services/purchase-svc/test/seat-behavior.test.ts |
| S-T36 | ⑥ | 좌석 화면 행동 요약(추천 적용 2026-10-31, ADR-0171… | ⑥ 홀드 p99가 50ms 이하다. `trust-reassess`의 원시 적재와 분석 저장소에 screen `SEAT` 신호가 0건이다 | ID만 | A | 시험: services/purchase-svc/test/seat-behavior.test.ts |
| S-T37 | ① | 우선 구매 보류(추천 적용 2026-10-31, ADR-0171, §5… | ① 같은 좌석이 PRIORITY로 잡히고 비트가 켜지며 7분 만료 인덱스에 없다 | 다른 단계 | A | GAT-135 · 우선 구매 보류 |
| S-T37 | ② | 우선 구매 보류(추천 적용 2026-10-31, ADR-0171, §5… | ② 같은 등급 좌석 하나가 잡힌다 | 다른 단계 | A | GAT-135 · 우선 구매 보류 |
| S-T37 | ③ | 우선 구매 보류(추천 적용 2026-10-31, ADR-0171, §5… | ③ `NO_SEAT`이고 아무것도 잡히지 않는다 | 다른 단계 | A | GAT-135 · 우선 구매 보류 |
| S-T37 | ④ | 우선 구매 보류(추천 적용 2026-10-31, ADR-0171, §5… | ④ 판매 종료 뒤인데도 홀드·주문이 되고 금액은 원래 가격, 다른 팬은 409 | 다른 단계 | A | GAT-135 · 우선 구매 보류 |
| S-T37 | ⑤ | 우선 구매 보류(추천 적용 2026-10-31, ADR-0171, §5… | ⑤ 실패 뒤 권리는 OFFERED 그대로이고 좌석이 PRIORITY로 돌아가며, 다시 사서 결제를 마치면 USED | 다른 단계 | A | GAT-135 · 우선 구매 보류 |
| S-T37 | ⑥ | 우선 구매 보류(추천 적용 2026-10-31, ADR-0171, §5… | ⑥ 409 `priority-seat-only` | 다른 단계 | A | GAT-135 · 우선 구매 보류 |
| S-T37 | ⑦ | 우선 구매 보류(추천 적용 2026-10-31, ADR-0171, §5… | ⑦ 좌석이 풀리고 권리는 EXPIRED, 보상 건은 생기지 않는다 | 다른 단계 | A | GAT-135 · 우선 구매 보류 |
| S-T38 | ① | 배치본 저장과 팬 좌석맵 파일(추천 적용 2026-11-10, §10… | ① 모두 422 `seatmap-invalid`(`INDEX_MISMATCH`)이고 판이 오르지 않고 파일이 0개다 | 자동 시험 | A | 시험: services/core-svc/test-int/catalog.int.test.ts, services/core-svc/test-int/seatmap-save.int.test.ts 외 3곳 |
| S-T38 | ② | 배치본 저장과 팬 좌석맵 파일(추천 적용 2026-11-10, §10… | ② 판 1이 되고 세 회차 모두 같은 `venue_id`를 가지며, 회차마다 `seatmap-layouts/1.json`이 하나씩 생기고(승인 이력이 있는… | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test-int/seatmap-save.int.test.ts 외 2곳 |
| S-T38 | ③ | 배치본 저장과 팬 좌석맵 파일(추천 적용 2026-11-10, §10… | ③ 412·428이고, 동시 둘은 하나만 200이며 진 쪽이 잡은 판 번호는 다음 저장에도 쓰이지 않고 이긴 판의 파일 바이트가 바뀌지 않는다 | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-save.int.test.ts |
| S-T38 | ④ | 배치본 저장과 팬 좌석맵 파일(추천 적용 2026-11-10, §10… | ④ 503 `seatmap-publish-unavailable`이고 판·행이 그대로이며 그 판의 파일이 남지 않는다 | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-save.int.test.ts |
| S-T38 | ⑤ | 배치본 저장과 팬 좌석맵 파일(추천 적용 2026-11-10, §10… | ⑤도형·좌석 쪽은 409 `seatmap-geometry-locked`이고 보안 사건이 남으며, 가격은 409 `sale-setting-locked`이고… | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-save.int.test.ts, services/core-svc/test/seatmap-layout.test.ts |
| S-T38 | ⑥ | 배치본 저장과 팬 좌석맵 파일(추천 적용 2026-11-10, §10… | ⑥ 실무자는 403 `partner-admin-required`, 관리자는 200이고 구역·좌석·가격 행과 승인된 판의 파일이 그대로이며 판매 승인이… | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-save.int.test.ts, services/core-svc/test/public-file-store.test.ts |
| S-T38 | ⑦ | 배치본 저장과 팬 좌석맵 파일(추천 적용 2026-11-10, §10… | ⑦ 404이고 행 보안이 다른 테넌트 행을 0건으로 읽으며, 정의 밖 칸은 400이다 | 자동 시험 | A | 시험: services/core-svc/test-int/rls.int.test.ts, services/core-svc/test-int/seatmap-save.int.test.ts |
| S-T38 | ⑧ | 배치본 저장과 팬 좌석맵 파일(추천 적용 2026-11-10, §10… | ⑧ 공연 상세 `priceTiers`가 보이는 순서의 `tierId`·`name`·`price`이고 팬 파일에 판매 상태·개인정보 칸이 없으며 불러오기·저장… | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-save.int.test.ts, services/core-svc/test/partner-seatmap.http.test.ts 외 1곳 |
| S-T38 | ⑨ | 배치본 저장과 팬 좌석맵 파일(추천 적용 2026-11-10, §10… | ⑨ 판 0 초안이 틀의 구역을 담고 저장 뒤 틀 행은 바뀌지 않으며, 배치본 ID를 틀로 넣으면 불러오기는 404·저장은 422다 | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-save.int.test.ts, services/core-svc/test/partner-seatmap.http.test.ts |
| S-T38 | ⑩ | 배치본 저장과 팬 좌석맵 파일(추천 적용 2026-11-10, §10… | ⑩ 저장은 200이고 `fanFilePublished`가 false이며 파일이 0개다 | 자동 시험 | A | 시험: services/core-svc/test-int/seatmap-save.int.test.ts, services/core-svc/test/seatmap-layout.test.ts |
| S-T39 | ① | 판매 정책 평가와 1인 한도 합치기(추천 적용 2026-11-10… | ① 거부, 2, 2이고 규칙 없음은 회차 한도(4)다 | 자동 시험 | A | 시험: packages/validation/test/sale-policy.test.ts |
| S-T39 | ② | 판매 정책 평가와 1인 한도 합치기(추천 적용 2026-11-10… | ② `from`·`to` − 1ms만 적용되고 `from` − 1ms·`to`·다른 회차는 적용되지 않는다 | 자동 시험 | A | 시험: packages/validation/test/sale-policy.test.ts |
| S-T39 | ③ | 판매 정책 평가와 1인 한도 합치기(추천 적용 2026-11-10… | ③ 표대로 참·거짓이고 `lte`·`gte`는 같은 값에서 참이다 | 자동 시험 | A | 시험: packages/validation/test/sale-policy.test.ts |
| S-T39 | ④ | 판매 정책 평가와 1인 한도 합치기(추천 적용 2026-11-10… | ④ 창 안 명단 없음만 `PRESALE_ONLY`로 들이지 않고, 등급·매수 조건만으로 거부하는 규칙은 진입을 막지 않는다 | 자동 시험 | A | 시험: packages/validation/test/sale-policy.test.ts |
| S-T39 | ⑤ | 판매 정책 평가와 1인 한도 합치기(추천 적용 2026-11-10… | ⑤ 20:00 회차는 `PRESALE`(20:00~22:00, 2) 뒤 `GENERAL`(22:00~판매 종료, 회차 한도)이고, 19:00 회차는 그 앞에… | 자동 시험 | A | 시험: packages/validation/test/sale-policy.test.ts |
| S-T39 | ⑥ | 판매 정책 평가와 1인 한도 합치기(추천 적용 2026-11-10… | ⑥ 넷 다 거절되고 코드가 `LIMIT_ABOVE_EVENT`·`REFUND_RATE_ABOVE_CAP`·`REFUND_BAND_OVERLAP`·UNKNOWN_… | 자동 시험 | A | 시험: packages/validation/test/sale-policy.test.ts, services/core-svc/test-int/sale-policy.int.test.ts 외 1곳 |
| S-T40 | ① | 좌석맵 템플릿과 휠체어석·겹침·도형 밖 경고(추천 적용… | ① 목록은 공개된 템플릿(코드·이름·변형·개략도 주소)이고, 하나는 도형·구역별 `fillRule`·등급 기본값을 주며 좌석 좌표가 없다. 공개되지 않은… | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-templates.int.test.ts, services/core-svc/test/seatmap-templates.http.test.ts 외 1곳 |
| S-T40 | ② | 좌석맵 템플릿과 휠체어석·겹침·도형 밖 경고(추천 적용… | ② 201이고 구역별 `fillRule` 목표 수의 합이 목표 좌석 수이며 좌석이 0개다. 좌석이 있으면 409… | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-templates.int.test.ts, services/core-svc/test/seatmap-templates.http.test.ts 외 1곳 |
| S-T40 | ③ | 좌석맵 템플릿과 휠체어석·겹침·도형 밖 경고(추천 적용… | ③ 2,400석의 12석은 W1(기준 20석, 8석 부족)이고 0석도 W1이다. 1,234석은 기준 13석이라 13석은 경고가 없고 12석은 W1이다 | 자동 시험 | B | 시험: packages/validation/test/seatmap-checks.test.ts |
| S-T40 | ④ | 좌석맵 템플릿과 휠체어석·겹침·도형 밖 경고(추천 적용… | ④ 양옆 2석인 묶음만 W2이고 1석인 묶음·열 끝·번갈아 있는 열은 경고가 없다 | 자동 시험 | B | 시험: packages/validation/test/seatmap-checks.test.ts |
| S-T40 | ⑤ | 좌석맵 템플릿과 휠체어석·겹침·도형 밖 경고(추천 적용… | ⑤ W3이다 | 자동 시험 | B | 시험: packages/validation/test/seatmap-checks.test.ts |
| S-T40 | ⑥ | 좌석맵 템플릿과 휠체어석·겹침·도형 밖 경고(추천 적용… | ⑥ 24cm 짝과 이웃 구역 짝은 두 좌석이 모두 `SEAT_OVERLAP`에 들고 25cm 짝은 들지 않는다 | 자동 시험 | B | 시험: packages/validation/test/seatmap-checks.test.ts |
| S-T40 | ⑦ | 좌석맵 템플릿과 휠체어석·겹침·도형 밖 경고(추천 적용… | ⑦ 밖 좌석만 `SEAT_OUTSIDE_SHAPE`이고 변 위·안 좌석은 아니다 | 자동 시험 | B | 시험: packages/validation/test/seatmap-checks.test.ts |
| S-T40 | ⑧ | 좌석맵 템플릿과 휠체어석·겹침·도형 밖 경고(추천 적용… | ⑧가져오기 결과와 저장 응답의 `warnings`가 같은 코드·좌석이고 저장은 200으로 판이 오른다. 좌석 ID는 경고마다 100개까지이고… | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-templates.int.test.ts, services/core-svc/test/seatmap-warnings.http.test.ts |

## docs/security/asvs/seat-hold.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| v5.0.0-1.1.1 | — | L2 | 입력은 그 형식으로 인코딩된 데이터가 기대될 때만 정규 형식으로 한 번만 디코딩(이스케이프 해제 포함)하고, 검증·정화 같은 다음 처리보다 먼저 한다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts 외 1곳 |
| v5.0.0-1.1.2 | — | L2 | 출력 인코딩·이스케이프는 그 값을 쓰는 해석기 바로 앞의 마지막 단계에서 하거나 해석기가 직접 한다. | 자동 시험 | B | 시험: apps/partner/src/_pages/seatmap-editor/model/golden.test.mjs |
| v5.0.0-1.2.1 | — | L1 | HTTP 응답·HTML·XML 출력은 문맥(HTML 요소·속성·주석, CSS, HTTP 헤더)에 맞게 인코딩해 메시지·문서 구조가 바뀌지 않게 한다. | 자동 시험 | B | 시험: apps/partner/src/_pages/seatmap-editor/model/import-check.test.mjs, apps/web/src/_pages/event-detail/model/detail.te… |
| v5.0.0-1.2.2 | — | L1 | URL을 동적으로 만들 때 신뢰하지 않는 값을 문맥에 맞게 인코딩하고 안전한 프로토콜만 허용한다(`javascript:`·`data:` 금지). | 자동 시험 | B | 시험: apps/web/queue-room/test/preload.test.mjs |
| v5.0.0-1.2.3 | — | L1 | JavaScript·JSON을 동적으로 만들 때 인코딩·이스케이프해 구조가 바뀌지 않게 한다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts |
| v5.0.0-1.2.4 | — | L1 | 데이터 조회·DB 쿼리는 파라미터 쿼리, ORM 등으로 SQL 등 DB 주입을 막는다(저장 프로시저 포함). | 자동 시험 | B | 시험: services/purchase-svc/test-int/booking-restrictions.int.test.ts, services/purchase-svc/test-int/order-holds.int.test… |
| v5.0.0-1.2.5 | — | L1 | OS 명령 주입을 막고 OS 호출은 파라미터화하거나 명령줄 인코딩을 쓴다. | 해당 없음 | B | 해당 없음(이 기능은 OS 명령을 부르지 않는다) |
| v5.0.0-1.2.6 | — | L2 | LDAP 주입을 막는다. | 해당 없음 | B | 해당 없음(LDAP을 쓰지 않는다) |
| v5.0.0-1.2.7 | — | L2 | XPath 주입을 쿼리 파라미터화·사전 컴파일로 막는다. | 해당 없음 | B | 해당 없음(XPath를 쓰지 않는다. 좌석맵 SVG에서 도형을 고를 때도 사용자 값으로 경로식을 만들지 않고 정한 요소 이름만 본다) |
| v5.0.0-1.2.8 | — | L2 | LaTeX 처리기를 안전하게 설정하고(`--shell-escape` 금지) 명령 허용 목록을 쓴다. | 해당 없음 | B | 해당 없음(LaTeX을 쓰지 않는다) |
| v5.0.0-1.2.9 | — | L2 | 정규식의 특수 문자를 이스케이프해 메타 문자로 해석되지 않게 한다. | 해당 없음 | B | 해당 없음(사용자 값을 정규식에 넣지 않는다. CSV의 꼭짓점 열('x y;x y;…')은 고정 구분자로 나눈다) |
| v5.0.0-1.3.1 | — | L1 | WYSIWYG 편집기 등에서 오는 신뢰하지 않는 HTML 입력은 모두 잘 알려진 안전한 HTML 정화 라이브러리나 프레임워크 기능으로 정화한다. | 해당 없음 | B | 해당 없음(HTML 입력을 받지 않는다. 좌석맵 SVG는 HTML로 다루지 않고 도형 데이터만 뽑는다, 1.3.4) |
| v5.0.0-1.3.2 | — | L1 | `eval()` 같은 동적 코드 실행을 피하고, 불가피하면 사용자 입력을 실행 전에 정화한다. | 자동 시험 | B | 시험: apps/partner/src/_pages/seatmap-editor/security.test.mjs |
| v5.0.0-1.3.3 | — | L2 | 위험할 수 있는 문맥에 넘기는 데이터는 그 문맥에 안전한 문자만 허용하고 너무 긴 입력을 자르는 등 미리 정화한다. | 자동 시험 | B | 시험: services/core-svc/test/search.http.test.ts, services/purchase-svc/test/hold-seats.test.ts 외 3곳 |
| v5.0.0-1.3.4 | — | L2 | 사용자가 준 SVG는 애플리케이션에 안전한 태그·속성만 담도록 검증하거나 정화한다(`script`·`foreignObject` 제외). | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts 외 1곳 |
| v5.0.0-1.3.5 | — | L2 | 사용자가 넣은 Markdown·CSS·XSL·BBCode 같은 스크립트·표현식 템플릿 내용을 정화하거나 끈다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts |
| v5.0.0-1.3.6 | — | L2 | 다른 서비스를 부르는 데 쓰기 전에 신뢰하지 않는 값을 프로토콜·도메인·경로·포트 허용 목록과 대조하고 위험할 수 있는 문자를 정화해 SSRF를 막는다. | 자동 시험 | B | 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/seatmap-import.int.test.ts |
| v5.0.0-1.3.7 | — | L2 | 신뢰하지 않는 입력으로 템플릿을 만들지 않아 템플릿 주입을 막고, 불가피하면 템플릿에 넣는 신뢰하지 않는 입력을 정화하거나 엄격히 검증한다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-1.3.8 | — | L2 | JNDI 조회에 넣기 전에 입력을 정화하고 JNDI를 안전하게 설정한다. | 해당 없음 | B | 해당 없음(JNDI를 쓰지 않는다) |
| v5.0.0-1.3.9 | — | L2 | memcache로 보내기 전에 내용을 정화한다. | 해당 없음 | B | 해당 없음(memcache를 쓰지 않는다. 좌석 Redis 키는 서버가 정한 회차 ID·계정 ID·좌석 색인과, UUID 형식을 확인한 멱등키로만 만든다(UUID가 아니면 400… |
| v5.0.0-1.3.10 | — | L2 | 예상과 다르거나 악의적으로 해석될 수 있는 형식 문자열은 처리 전에 정화한다. | 자동 시험 | B | 시험: apps/web/src/shared/i18n/catalog.test.mjs |
| v5.0.0-1.3.11 | — | L2 | 메일 시스템에 넘기기 전에 사용자 입력을 정화해 SMTP·IMAP 주입을 막는다. | 해당 없음 | B | 해당 없음(이 기능은 메일을 보내지 않는다) |
| v5.0.0-1.4.1 | — | L2 | 메모리 안전한 문자열·메모리 복사·포인터 연산으로 스택·버퍼·힙 오버플로를 찾아내거나 막는다. | 해당 없음 | B | 해당 없음(애플리케이션 코드는 메모리 관리 언어(TypeScript)다. Lua는 관리형 Valkey 엔진 안에서 돌고, 엔진은 공급자가 관리하는 구성 요소라 조치 기한(15.1.1, 공통)으로 관리한다) |
| v5.0.0-1.4.2 | — | L2 | 부호·범위·입력 검증으로 정수 오버플로를 막는다. | 자동 시험 | B | 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts |
| v5.0.0-1.4.3 | — | L2 | 할당한 메모리와 자원을 해제하고 해제된 참조를 지워 use-after-free를 막는다. | 해당 없음 | B | 해당 없음(메모리 관리 언어만 쓴다) |
| v5.0.0-1.5.1 | — | L1 | XML 파서를 제한적으로 설정하고 외부 엔터티 해석 같은 위험 기능을 꺼 XXE를 막는다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts |
| v5.0.0-1.5.2 | — | L2 | 신뢰하지 않는 데이터의 역직렬화는 허용 객체 타입 목록 등으로 안전하게 처리하고, 안전하지 않다고 알려진 방식은 쓰지 않는다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/sale-policy.http.test.ts 외 3곳 |
| v5.0.0-2.1.1 | — | L1 | 데이터 항목이 기대 구조에 맞는지 확인하는 입력 검증 규칙을 문서에 정의한다. | 자동 시험 | B | 시험: services/purchase-svc/test/auto-assign.test.ts, services/purchase-svc/test/end-purchase-session.test.ts 외 4곳 |
| v5.0.0-2.1.2 | — | L2 | 여러 데이터 항목을 함께 볼 때의 논리적·문맥적 일관성을 검증하는 방법을 문서에 정의한다. | 자동 시험 | B | 시험: services/purchase-svc/test/seat-layout.test.ts |
| v5.0.0-2.1.3 | — | L2 | 사용자별·시스템 전체의 업무 로직 한도와 검증 기대값을 문서화한다. | ID만 | B | 다른 곳 시험: services/core-svc/test/search.http.test.ts (영역: apps/partner, apps/web, packages/seatmap… |
| v5.0.0-2.2.1 | — | L1 | 입력이 업무·기능 기대를 만족하는지 허용 목록(값·패턴·범위)이나 미리 정한 규칙의 기대 구조·논리 한도로 검증하고, L1은 업무·보안 결정에 쓰는 입력에… | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/media-rules.test.ts 외 38곳 |
| v5.0.0-2.2.2 | — | L1 | 입력 검증을 신뢰할 수 있는 서비스 계층에서 강제하고 클라이언트 검증에 의존하지 않는다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test-int/seatmap-save.int.test.ts 외 6곳 |
| v5.0.0-2.2.3 | — | L2 | 관련 데이터 항목의 조합이 미리 정한 규칙에 맞는지 확인한다. | 자동 시험 | B | 시험: services/purchase-svc/test-int/order-store.int.test.ts, services/purchase-svc/test-int/seat-store.int.test.ts 외 8곳 |
| v5.0.0-2.3.1 | — | L1 | 같은 사용자의 업무 흐름을 정해진 순서대로만 처리하고 단계를 건너뛰지 못하게 한다. | 자동 시험 | B | 시험: services/purchase-svc/test-int/consumers.int.test.ts, services/purchase-svc/test-int/order-accepts.int.test.ts 외 24곳 |
| v5.0.0-2.3.2 | — | L2 | 문서화된 업무 로직 한도를 구현해 악용을 막는다. | 다른 단계 | B | HOT-252 · 이 행의 판매 정책 한도 몫(Q-T36 ③, HOT-250이 더함)은 갈래 1 새 단계가 시험한다. 이름을 단 기존 시험(1인 한도 Lua 등)은 규칙 한도를 보지 않는다(BAT-157 계획… |
| v5.0.0-2.3.3 | — | L2 | 업무 로직 수준의 트랜잭션으로 작업이 전부 성공하거나 이전의 올바른 상태로 되돌아가게 한다. | 자동 시험 | B | 시험: services/purchase-svc/test-int/accept-e2e.int.test.ts, services/purchase-svc/test-int/order-accepts.int.test.ts 외… |
| v5.0.0-2.3.4 | — | L2 | 한정 수량 자원이 로직 조작으로 이중 예약되지 않도록 업무 수준 잠금을 쓴다. | 자동 시험 | B | 시험: services/purchase-svc/test-int/accept-e2e.int.test.ts, services/purchase-svc/test-int/order-accepts.int.test.ts 외… |
| v5.0.0-2.4.1 | — | L2 | 데이터 유출, 쓰레기 데이터, 할당량 소진, 레이트 리밋 위반, 서비스 거부, 비싼 자원 남용으로 이어지는 과도한 호출을 막는 자동화 방지 통제를 둔다. | ID만 | B | 다른 곳 시험: services/core-svc/test/wish.http.test.ts, services/identity-svc/test/login-verdict.test.ts 외 24곳 (영역:… |
| v5.0.0-3.2.1 | — | L1 | API 응답·사용자가 올린 파일 등이 잘못된 문맥(HTML 등)으로 그려지지 않게 한다(`Sec-Fetch-*`, CSP sandbox… | 자동 시험 | B | 시험: services/purchase-svc/test/snapshot-http.test.ts |
| v5.0.0-3.2.2 | — | L1 | HTML이 아니라 글로 보일 내용은 `textContent` 같은 안전한 렌더링 함수로 다룬다. | 자동 시험 | B | 시험: apps/partner/src/_pages/seatmap-editor/model/import-check.test.mjs, apps/web/src/_pages/queue-verify/model/verify-fl… |
| v5.0.0-3.3.1 | — | L1 | 쿠키에 `Secure`를 두고, `__Host-`를 쓰지 않으면 이름에 `__Secure-` 접두사를 붙인다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.3.2 | — | L2 | 쿠키마다 목적에 맞는 `SameSite`를 둬 CSRF 같은 공격 노출을 줄인다. | ID만 | B | 다른 곳 시험: services/queue-svc/test/edge-first-visit-function.test.ts (영역: apps/partner, apps/web, packages/seatmap… |
| v5.0.0-3.3.3 | — | L2 | 다른 호스트와 공유하도록 설계한 쿠키가 아니면 이름에 `__Host-` 접두사를 쓴다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.3.4 | — | L2 | 스크립트가 읽을 필요 없는 쿠키(세션 토큰 등)는 `HttpOnly`이고 그 값은 `Set-Cookie`로만 보낸다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.4.1 | — | L1 | 모든 응답에 HSTS를 둔다(최대 기간 1년 이상, L2부터 하위 도메인 포함). | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-http-rules.test.ts, services/v0-monolith/test/gateway-server.test.ts (영역:… |
| v5.0.0-3.4.2 | — | L1 | CORS `Access-Control-Allow-Origin`은 고정 값으로 두거나 요청의 `Origin`을 신뢰 출처 허용 목록과 대조해 정하고, `*`을… | ID만 | B | 다른 곳 시험: services/queue-svc/test/state-http.test.ts (영역: apps/partner, apps/web, packages/seatmap… |
| v5.0.0-3.4.3 | — | L2 | HTTP 응답에 CSP를 둬 브라우저가 신뢰한 콘텐츠·자원만 싣고 실행하게 하고, 최소한 `object-src 'none'`·`base-uri 'none'`과… | 자동 시험 | B | 시험: apps/partner/src/_pages/seatmap-editor/security.test.mjs, apps/web/server/csp-hash-server.test.mjs 외 2곳 |
| v5.0.0-3.4.4 | — | L2 | 모든 응답에 `X-Content-Type-Options: nosniff`를 둔다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test-int/seat.int.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 1곳 (영역:… |
| v5.0.0-3.4.5 | — | L2 | 리퍼러 정책을 둬 URL 경로·쿼리 같은 기술적 민감 데이터가 `Referer` 헤더로 제3자 서비스에 새지 않게 한다. | ID만 | B | 다른 곳 시험: packages/config/headers/headers.test.mjs (영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc) |
| v5.0.0-3.4.6 | — | L2 | 모든 HTTP 응답에 CSP `frame-ancestors`를 둬 기본적으로 끼워 넣을 수 없게 하고, 필요한 자원만 끼워 넣기를… | 자동 시험 | B | 시험: apps/web/src/_app/security/page-headers.test.mjs |
| v5.0.0-3.5.1 | — | L1 | CORS 사전 요청에 기대지 않는다면 민감 기능 요청이 애플리케이션에서 왔는지 확인한다(위조 방지 토큰, safelisted가 아닌 헤더 요구 등). | 자동 시험 | B | 시험: apps/web/scripts/local-fan-gateway.test.mjs, apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.5.2 | — | L1 | CORS 사전 요청에 기댄다면 사전 요청을 일으키지 않는 요청으로 그 기능을 부를 수 없게 한다(`Origin`·`Content-Type` 확인 등). | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/golden.test.mjs, apps/partner/src/_pages/seatmap-editor/model/save… |
| v5.0.0-3.5.3 | — | L1 | 민감 기능은 GET·HEAD·OPTIONS 같은 안전 메서드가 아닌 POST·PUT·PATCH·DELETE 같은 메서드로 부르거나, `Sec-Fetch-*`… | ID만 | B | 다른 곳 시험: services/core-svc/test/seatmap-templates.http.test.ts, services/queue-svc/test/leave-http.test.ts 외 3곳 (영역:… |
| v5.0.0-3.5.4 | — | L2 | 서로 다른 애플리케이션을 다른 호스트 이름에 둬 동일 출처 정책의 제한을 쓴다. | 빈칸 | B | 영역: apps/partner |
| v5.0.0-3.5.5 | — | L2 | `postMessage`로 받은 메시지는 출처를 믿을 수 없거나 형식이 틀리면 버린다. | 자동 시험 | B | 시험: apps/web/src/features/identity-verify/flow.test.mjs |
| v5.0.0-3.7.1 | — | L2 | 지원이 끝났거나 안전하지 않은 클라이언트 기술(플러그인, Flash 등)을 쓰지 않는다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-3.7.2 | — | L2 | 애플리케이션이 통제하지 않는 다른 호스트로 자동 이동시킬 때는 허용 목록에 있는 곳으로만 보낸다. | 자동 시험 | B | 시험: apps/web/queue-room/test/verify-return.test.mjs, apps/web/src/_pages/login/model/state.test.mjs 외 4곳 |
| v5.0.0-4.1.1 | — | L1 | 본문이 있는 모든 HTTP 응답에 실제 내용과 맞는 `Content-Type`을 두고, 텍스트·XML처럼 IANA 미디어 타입이 정하는 경우 안전한 문자… | 자동 시험 | B | 시험: services/purchase-svc/test/http.test.ts |
| v5.0.0-4.1.2 | — | L2 | 브라우저로 직접 여는 사용자 화면만 HTTP에서 HTTPS로 자동 리디렉션하고, 그 밖의 서비스·엔드포인트는 리디렉션하지 않는다. | 빈칸 | B | 영역: apps/web |
| v5.0.0-4.1.3 | — | L2 | 로드밸런서·프록시·BFF 같은 중간 계층이 넣어 애플리케이션이 쓰는 헤더(`X-Real-IP`·`X-Forwarded-*`·`X-User-ID` 등)는 최종… | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 4곳… |
| v5.0.0-4.2.1 | — | L2 | 로드밸런서·방화벽 등 모든 구성요소가 HTTP 버전에 맞게 메시지 경계를 정해 요청 밀반입을 막는다(HTTP/1.x는 `Transfer-Encoding`이… | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-4.3.1 | — | L2 | 허용 쿼리 목록, 깊이·개수 제한, 쿼리 비용 분석 가운데 하나 이상으로 비싼 중첩 쿼리에 의한 GraphQL·데이터 계층 표현식 서비스 거부를 막는다. | 해당 없음 | B | 해당 없음(좌석 API는 REST와 WebSocket이고 GraphQL을 쓰지 않는다) |
| v5.0.0-4.3.2 | — | L2 | GraphQL을 외부에 공개하는 경우가 아니면 운영 환경에서 인트로스펙션을 끈다. | 해당 없음 | B | 해당 없음(위와 같다) |
| v5.0.0-4.4.1 | — | L1 | 모든 WebSocket 연결에 WSS를 쓴다. | 자동 시험 | B | 시험: packages/seatmap/test/connection.test.ts |
| v5.0.0-4.4.2 | — | L2 | WebSocket 첫 HTTP 핸드셰이크에서 `Origin`을 허용 출처 목록과 대조한다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test-int/seat-review.int.test.ts, services/v0-monolith/test-int/seat.int.test.ts (영역:… |
| v5.0.0-4.4.3 | — | L2 | 표준 세션 관리를 쓸 수 없으면 세션 관리 요구사항을 따르는 전용 토큰을 쓴다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-4.4.4 | — | L2 | 전용 WebSocket 세션 토큰은 인증된 HTTPS 세션으로 처음 받거나 검증한다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-5.1.1 | — | L2 | 업로드 기능마다 허용 파일 형식·확장자·최대 크기(풀린 크기 포함)와, 최종 사용자가 내려받아 처리해도 안전하게 만드는 방법(악성 파일을 찾았을 때의 동작… | 자동 시험 | B | 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/seatmap-import.int.test.ts 외 2곳 |
| v5.0.0-5.2.1 | — | L1 | 성능 저하나 서비스 거부 없이 처리할 수 있는 크기의 파일만 받는다. | 자동 시험 | B | 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test/sale-eligibility.http.test.ts |
| v5.0.0-5.2.2 | — | L1 | 단독이든 zip 같은 압축 파일 안이든 받는 파일의 확장자가 기대한 것인지와 내용이 그 형식과 맞는지(매직 바이트, 이미지 다시 쓰기 등) 검증하고, L1은… | 자동 시험 | B | 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/seatmap-import.int.test.ts 외 4곳 |
| v5.0.0-5.2.3 | — | L2 | 압축 파일은 풀기 전에 풀린 크기와 파일 수 상한을 확인한다. | 해당 없음 | B | 해당 없음(압축 파일을 받지 않는다, 5.1.1) |
| v5.0.0-5.3.1 | — | L1 | 신뢰하지 않는 입력으로 올라오거나 만들어져 공개 폴더에 저장된 파일은 HTTP 요청으로 직접 열어도 서버 쪽 코드로 실행되지 않게 한다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test-int/seatmap-save.int.test.ts 외 1곳 |
| v5.0.0-5.3.2 | — | L1 | 파일 작업 경로는 사용자가 보낸 파일 이름 대신 내부에서 만들거나 믿을 수 있는 값으로 만들고, 사용자 파일 이름·메타데이터를 써야 하면 엄격히 검증·정화해… | 자동 시험 | B | 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/seatmap-import.int.test.ts 외 4곳 |
| v5.0.0-5.4.1 | — | L2 | JSON·JSONP·URL 파라미터에 담긴 것을 포함해 사용자가 보낸 파일 이름은 검증하거나 무시하고, 응답의 `Content-Disposition`에 파일… | 자동 시험 | B | 시험: apps/partner/src/_pages/seatmap-editor/model/export.test.mjs, apps/partner/src/_pages/seatmap-editor/model/golden.te… |
| v5.0.0-5.4.2 | — | L2 | 내주는 파일 이름을 인코딩·정화해 문서 구조를 지키고 주입을 막는다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-5.4.3 | — | L2 | 신뢰하지 않는 출처의 파일은 백신으로 검사해 알려진 악성 파일을 내려주지 않는다. | 해당 없음 | B | 해당 없음(신뢰하지 않는 출처의 파일을 내려주지 않는다. 가져오기 원본은 저장하지 않고, 공개 좌석맵 파일은 서버가 검증한 데이터로 만든다) |
| v5.0.0-8.1.1 | — | L1 | 인가 문서에 호출자 권한과 자원 속성에 따라 기능 수준·데이터 수준 접근을 제한하는 규칙을 정한다. | 자동 시험 | B | 시험: services/purchase-svc/test/purchase-session-leave-http.test.ts, services/purchase-svc/test/snapshot-http.test.ts |
| v5.0.0-8.1.2 | — | L2 | 인가 문서에 호출자 권한과 자원 속성(상태 등)에 따라 필드 수준 읽기·쓰기 접근을 제한하는 규칙을 정한다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-8.2.1 | — | L1 | 기능 접근을 명시적 권한이 있는 호출자로 제한한다. | 자동 시험 | B | 시험: services/core-svc/test-int/sale-eligibility.int.test.ts, services/core-svc/test-int/sale-policy.int.test.ts 외 16곳 |
| v5.0.0-8.2.2 | — | L1 | 데이터 접근을 그 데이터 항목에 명시적 권한이 있는 호출자로 제한해 IDOR·BOLA를 막는다. | 자동 시험 | B | 시험: services/purchase-svc/test-int/accept-e2e.int.test.ts, services/purchase-svc/test-int/order-holds.int.test.ts 외 20곳 |
| v5.0.0-8.2.3 | — | L2 | 필드 수준 접근을 그 필드에 명시적 권한이 있는 호출자로 제한해 BOPLA를 막는다. | 자동 시험 | B | 시험: services/purchase-svc/test/start-payment-http.test.ts, services/purchase-svc/test/start-payment.test.ts |
| v5.0.0-8.3.1 | — | L1 | 인가 규칙을 신뢰할 수 있는 서비스 계층에서 강제하고 클라이언트 쪽 제어에 기대지 않는다. | 자동 시험 | B | 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts |
| v5.0.0-8.4.1 | — | L2 | 다중 테넌트 애플리케이션은 테넌트 사이 통제로 호출자의 작업이 상호작용 권한이 없는 테넌트에 영향을 주지 않게 한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/rls.int.test.ts 외 4곳 (영역:… |
| v5.0.0-12.1.1 | — | L1 | TLS 1.2와 1.3처럼 권장되는 최신 버전만 켜고 가장 최신 버전을 우선한다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-server.test.ts (영역: apps/partner, apps/web, packages/seatmap… |
| v5.0.0-12.1.2 | — | L2 | 권장 암호 스위트만 켜고 가장 강한 스위트를 우선하며, L3는 순방향 비밀성을 주는 스위트만 지원한다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-12.1.3 | — | L2 | mTLS 클라이언트 인증서가 신뢰된 것인지 확인한 뒤에만 그 신원으로 인증·인가한다. | 다른 단계 | B | 운영 확인 · 구현 위치가 '(운영 설계만)'이다 |
| v5.0.0-12.2.1 | — | L1 | 클라이언트와 외부에 노출된 HTTP 서비스 사이의 모든 연결에 TLS를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-server.test.ts 외 1곳 (영역:… |
| v5.0.0-12.2.2 | — | L1 | 외부에 노출된 서비스는 공인 TLS 인증서를 쓴다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-12.3.1 | — | L2 | 애플리케이션에 들어오고 나가는 모든 연결(모니터링·관리 도구, 원격 접속, 미들웨어, DB, 파트너 시스템, 외부 API 등)에 TLS 같은 암호화 프로토콜을… | ID만 | B | 다른 곳 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts (영역:… |
| v5.0.0-12.3.2 | — | L2 | TLS 클라이언트가 서버 인증서를 검증한 뒤 통신한다. | 빈칸 | B | 영역: services/purchase-svc |
| v5.0.0-12.3.3 | — | L2 | 애플리케이션 안 내부 HTTP 서비스 사이의 모든 연결에 TLS 같은 전송 암호화를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | 다른 단계 | B | 운영 확인 · 구현 위치가 '(운영 설계만)'이다 |
| v5.0.0-12.3.4 | — | L2 | 내부 서비스 사이 TLS는 신뢰한 인증서를 쓰고, 내부 발급·자체 서명 인증서를 쓰면 받는 서비스가 지정한 내부 CA와 지정한 자체 서명 인증서만 신뢰하게 한다. | 다른 단계 | B | 운영 확인 · 구현 위치가 '(운영 설계만)'이다 |
| v5.0.0-13.1.1 | — | L2 | 애플리케이션의 통신 필요(의존하는 외부 서비스, 사용자가 외부 위치를 줄 수 있는 경우 포함)를 모두 문서화한다. | 자동 시험 | B | 시험: services/purchase-svc/test/consumers.test.ts |
| v5.0.0-13.2.1 | — | L2 | 표준 사용자 세션을 쓰지 않는 백엔드 구성 요소 사이 통신을 개별 서비스 계정·단기 토큰·인증서로 인증하고, 바뀌지 않는 비밀번호·API 키를 쓰지 않는다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/portone-gateway.int.test.ts, services/payment-svc/test-int/toss-gateway.int.test… |
| v5.0.0-13.2.2 | — | L2 | 백엔드 통신을 최소 권한 계정으로 한다. | 자동 시험 | B | 시험: services/purchase-svc/test-int/seat-store.int.test.ts, services/purchase-svc/test/consumers.test.ts |
| v5.0.0-13.2.3 | — | L2 | 서비스 인증에 기본 자격 증명을 쓰지 않는다. | ID만 | B | 다른 곳 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts (영역:… |
| v5.0.0-13.2.4 | — | L2 | 애플리케이션이 통신할 수 있는 외부 자원의 허용 목록을 정의한다. | 자동 시험 | B | 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts |
| v5.0.0-13.2.5 | — | L2 | 서버가 요청을 보내거나 자원을 불러올 수 있는 대상의 허용 목록을 설정한다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts |
| v5.0.0-13.3.1 | — | L2 | 키 보관소 같은 비밀 관리 도구로 백엔드 비밀을 안전하게 만들고 저장·접근 통제·폐기하며, 소스 코드와 빌드 산출물에 비밀을 넣지 않고, L3는 HSM 같은… | ID만 | B | 다른 곳 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, loadtest/test/runner.test.mjs 외 13곳 (영역: apps/partner, apps/web… |
| v5.0.0-13.3.2 | — | L2 | 비밀 자산 접근은 최소 권한 원칙을 따른다. | ID만 | B | 다른 곳 시험: services/admission-ctrl/test/kms-seed-opener.test.ts, services/admission-ctrl/test/seed-reveal.test.ts 외 5곳… |
| v5.0.0-13.4.1 | — | L1 | 배포물에 `.git`·`.svn` 같은 소스 관리 메타데이터가 없거나, 있어도 외부와 애플리케이션 모두 접근할 수 없다. | 자동 시험 | B | 시험: apps/web/server/deployment-id.test.mjs, apps/web/server/standalone.test.mjs |
| v5.0.0-13.4.2 | — | L2 | 운영 환경의 모든 구성요소에서 디버그 모드를 끈다. | ID만 | B | 다른 곳 시험: packages/platform/test/problem.test.ts, services/pg-simulator/test/simulator.test.ts (영역: apps/partner… |
| v5.0.0-13.4.3 | — | L2 | 의도한 경우가 아니면 웹 서버가 디렉터리 목록을 보여 주지 않는다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-13.4.4 | — | L2 | 운영 환경에서 HTTP TRACE 메서드를 지원하지 않는다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-13.4.5 | — | L2 | 내부 API 문서와 모니터링 엔드포인트는 의도한 경우가 아니면 노출하지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/metrics.test.ts, services/pg-simulator/test/simulator.test.ts 외 2곳 (영역:… |
| v5.0.0-14.1.1 | — | L2 | 애플리케이션이 만들고 처리하는 민감 데이터를 Base64·JWT 본문처럼 인코딩만 된 것까지 모두 찾아, 따라야 할 데이터 보호·개인정보 법규와 표준을 반영한… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/sale-eligibility.int.test.ts, services/v0-monolith/test-int/gate.int.test.ts 외 4곳… |
| v5.0.0-14.1.2 | — | L2 | 보호 등급마다 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, DB 수준 암호화, 개인정보 보호 기술 같은 보호 요구사항을… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/sale-eligibility.int.test.ts (영역: apps/partner, apps/web, packages/seatmap… |
| v5.0.0-14.2.1 | — | L1 | 민감 데이터는 HTTP 본문이나 헤더로만 서버에 보내고 URL·쿼리 문자열에 넣지 않는다. | 자동 시험 | B | 시험: apps/web/src/features/identity-verify/flow.test.mjs, apps/web/src/features/identity-verify/server/return-post.test.m… |
| v5.0.0-14.2.2 | — | L2 | 민감 데이터가 로드밸런서·애플리케이션 캐시 같은 서버 구성요소에 캐시되지 않게 하거나 사용 뒤 안전하게 지운다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-save.int.test.ts, services/core-svc/test/seatmap-layout.test.ts |
| v5.0.0-14.2.3 | — | L2 | 정의된 민감 데이터를 신뢰하지 않는 제3자(사용자 추적 도구 등)에게 보내지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/telemetry.test.ts, services/payment-svc/test/portone-gateway.test.ts 외 1곳 (영역:… |
| v5.0.0-14.2.4 | — | L2 | 보호 등급 문서에 정한 대로 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, 개인정보 보호 기술을 구현한다. | 자동 시험 | B | 시험: services/purchase-svc/test-int/accept-e2e.int.test.ts, services/purchase-svc/test-int/order-accepts.int.test.ts 외 5곳 |
| v5.0.0-14.3.1 | — | L1 | 클라이언트나 세션이 끝나면 브라우저 DOM 같은 클라이언트 저장소에서 인증 뒤 받은 데이터를 지우고, 서버에 연결되지 않을 때도 클라이언트가 스스로 지울 수… | 자동 시험 | B | 시험: apps/web/queue-room/test/logout.test.mjs |
| v5.0.0-14.3.2 | — | L2 | 민감 데이터가 브라우저에 캐시되지 않게 `Cache-Control: no-store` 등 캐시 방지 헤더를 둔다. | 자동 시험 | B | 시험: services/purchase-svc/test/accept-http.test.ts, services/purchase-svc/test/snapshot-http.test.ts 외 1곳 |
| v5.0.0-14.3.3 | — | L2 | 브라우저 저장소(localStorage, sessionStorage, IndexedDB, 쿠키)에 세션 토큰 말고는 민감 데이터를 두지 않는다. | 자동 시험 | B | 시험: apps/web/queue-room/test/autoassign.test.mjs, apps/web/src/_pages/seats/model/storage.test.mjs |
| v5.0.0-15.1.1 | — | L1 | 취약한 서드파티 구성요소와 라이브러리 갱신의 위험 기반 조치 기한을 문서에 정한다. | ID만 | B | 다른 곳 시험: tools/ci/vuln-deadline.test.mjs (영역: services/core-svc) |
| v5.0.0-15.1.2 | — | L2 | 모든 서드파티 라이브러리의 목록(SBOM)을 유지하고, 미리 정한 믿을 수 있고 계속 관리되는 저장소에서 오는지 확인한다. | ID만 | B | 다른 곳 시험: tools/ci/sbom-find.test.mjs, tools/web-checks/static/assets.test.mjs (영역: apps/partner, apps/web… |
| v5.0.0-15.1.3 | — | L2 | 시간이 오래 걸리거나 자원을 많이 쓰는 기능을 문서에 밝히고, 그 남용으로 가용성을 잃지 않는 방법과 응답 만들기가 호출자의 시간 초과보다 길어지지 않게 하는… | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts |
| v5.0.0-15.2.1 | — | L1 | 문서에 정한 갱신·조치 기한을 넘긴 구성요소가 없다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-15.2.2 | — | L2 | 시간이 오래 걸리거나 자원을 많이 쓰는 기능에 문서대로 가용성 방어를 구현한다. | 자동 시험 | B | 시험: services/purchase-svc/test-int/seat-stream-relay.int.test.ts, services/purchase-svc/test/seat-stream-relay.test.ts |
| v5.0.0-15.2.3 | — | L2 | 운영 환경에는 필요한 기능만 두고 시험 코드·예제·개발 기능을 노출하지 않는다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-15.3.1 | — | L1 | 데이터 객체에서 필요한 필드만 돌려준다. | 자동 시험 | B | 시험: services/purchase-svc/test/http.test.ts, services/purchase-svc/test/read-seat-snapshot.test.ts 외 2곳 |
| v5.0.0-15.3.2 | — | L2 | 백엔드가 외부 URL을 부를 때 의도하지 않은 리디렉션을 따라가지 않는다. | ID만 | B | 다른 곳 시험: packages/config/eslint/service-security.test.mjs, packages/platform/test/telemetry.test.ts 외 2곳 (영역:… |
| v5.0.0-15.3.3 | — | L2 | 컨트롤러·액션마다 허용 필드를 제한해 대량 할당 공격을 막는다. | 자동 시험 | B | 시험: services/purchase-svc/test/accept-http.test.ts, services/purchase-svc/test/http.test.ts |
| v5.0.0-15.3.4 | — | L2 | 모든 프록시·미들웨어가 사용자의 원래 IP를 최종 사용자가 조작할 수 없는 신뢰 필드로 넘기고, 애플리케이션·웹 서버는 그 값을 로그와 레이트 리밋 같은 보안… | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-15.3.5 | — | L2 | 변수 타입을 확인하고 엄격한 동등·비교 연산을 써서 타입 혼동을 막는다. | 자동 시험 | B | 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts |
| v5.0.0-15.3.6 | — | L2 | 프로토타입 오염을 막도록 JavaScript를 작성한다(객체 리터럴 대신 `Set`·`Map` 등). | ID만 | B | 다른 곳 시험: packages/api-client/test/policy.test.ts, packages/config/eslint/js-security.test.mjs 외 4곳 (영역: function… |
| v5.0.0-15.3.7 | — | L2 | HTTP 파라미터 오염 공격을 막는다. | 자동 시험 | B | 시험: services/purchase-svc/test/read-seat-snapshot.test.ts, services/purchase-svc/test/snapshot-http.test.ts |
| v5.0.0-16.1.1 | — | L2 | 기술 스택의 계층마다 어떤 이벤트를 어떤 형식으로 기록하는지, 로그를 어디에 두고 어디에 쓰는지, 접근을 어떻게 통제하는지, 얼마나 보관하는지를 적은 로그… | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts |
| v5.0.0-16.2.1 | — | L2 | 로그 항목에 언제, 어디서, 누가, 무엇을 같은 조사용 메타데이터를 넣는다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-log.test.ts, services/core-svc/test-int/production-image.int.test.ts (영역:… |
| v5.0.0-16.2.2 | — | L2 | 로그 구성요소의 시각을 동기화하고 UTC 또는 시간대 오프셋을 쓴다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-16.2.3 | — | L2 | 로그 목록에 적힌 파일과 서비스로만 로그를 저장·전송한다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-16.2.4 | — | L2 | 쓰고 있는 로그 처리기가 로그를 읽고 서로 연관 지을 수 있게 하고, 되도록 공통 로그 형식을 쓴다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-16.2.5 | — | L2 | 민감 데이터는 보호 등급에 따라 로그에 남긴다(자격 증명·결제 정보는 남기지 않고, 일부는 해시·마스킹). | 자동 시험 | B | 시험: services/purchase-svc/test-int/purchase-session.int.test.ts, services/purchase-svc/test-int/sale-state.int.test.ts… |
| v5.0.0-16.3.1 | — | L2 | 성공·실패를 포함한 모든 인증 작업을 기록하고, 인증 방식이나 쓴 인증 요소 같은 메타데이터도 남긴다. | 자동 시험 | B | 시험: services/purchase-svc/test/open-purchase-session.test.ts, services/purchase-svc/test/snapshot-http.test.ts |
| v5.0.0-16.3.2 | — | L2 | 실패한 인가 시도를 기록하고, L3는 민감 데이터 접근을 포함한 모든 인가 결정을 그 데이터는 빼고 기록한다. | 자동 시험 | B | 시험: services/purchase-svc/test/accept-http.test.ts, services/purchase-svc/test/accept-payment.test.ts 외 1곳 |
| v5.0.0-16.3.3 | — | L2 | 문서화한 보안 이벤트와 보안 통제를 우회하려는 시도를 기록한다. | 자동 시험 | B | 시험: services/trust-svc/test-int/apply-label.int.test.ts, services/trust-svc/test-int/main-label.int.test.ts 외 2곳 |
| v5.0.0-16.3.4 | — | L2 | 예상하지 못한 오류와 보안 통제 실패를 기록한다. | 자동 시험 | B | 시험: services/purchase-svc/test-int/sale-state.int.test.ts, services/purchase-svc/test-int/seat-snapshot.int.test.ts 외… |
| v5.0.0-16.4.1 | — | L2 | 모든 로그 구성요소가 로그 주입을 막도록 데이터를 인코딩한다. | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-recheck.test.ts |
| v5.0.0-16.4.2 | — | L2 | 로그를 권한 없는 접근과 수정에서 보호한다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-16.4.3 | — | L2 | 로그를 분석·탐지·경보용으로 논리적으로 분리된 시스템에 안전하게 보낸다. | 빈칸 | B | 영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc |
| v5.0.0-16.5.1 | — | L2 | 예상하지 못한 오류나 보안상 민감한 오류에는 일반 메시지를 돌려주고 내부 정보를 드러내지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/problem.test.ts (영역: apps/partner, apps/web, packages/seatmap, services/purchase-svc) |
| v5.0.0-16.5.2 | — | L2 | 외부 자원 접근이 실패해도 안전하게 동작한다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-call-guard.int.test.ts, services/payment-svc/test-int/payment-circuit.int.test… |
| v5.0.0-16.5.3 | — | L2 | 예외가 나도 안전하게 실패하고, 검증 오류가 있는데도 거래를 처리하는 fail-open을 막는다. | 자동 시험 | B | 시험: services/purchase-svc/test-int/booking-restrictions.int.test.ts, services/purchase-svc/test-int/identity-grpc.int.te… |
| v5.0.0-15.4.1 | — | L3 | 여러 스레드가 함께 쓰는 객체(캐시, 파일, 메모리 속 객체)는 스레드에 안전한 타입과 잠금·세마포어 같은 동기화로 다뤄 경합과 데이터 손상을 막는다. | 자동 시험 | B | 시험: services/purchase-svc/test-int/accept-e2e.int.test.ts, services/purchase-svc/test-int/consumers.int.test.ts 외 13곳 |
| v5.0.0-15.4.2 | — | L3 | 자원 상태 확인과 그 상태에 따른 동작을 원자적으로 해서 확인 시점과 사용 시점의 경합(TOCTOU)을 막는다. | 자동 시험 | B | 시험: services/purchase-svc/test-int/payment-result-e2e.int.test.ts, services/purchase-svc/test-int/pin-failed-mark.int.te… |
| v5.0.0-15.4.3 | — | L3 | 서로 기다리거나 끝없이 다시 시도하다 멈추지 않도록 잠금을 일관되게 쓰고, 잠금 처리는 그 자원을 맡은 코드 안에만 두어 바깥 코드가 잠금을 실수나 악의로… | 자동 시험 | B | 시험: services/purchase-svc/test-int/seat-sales.int.test.ts |
| v5.0.0-15.4.4 | — | L3 | 스레드 풀 같은 자원 배분 규칙으로 자원을 공정하게 나눠, 우선순위가 낮은 스레드도 알맞은 시간 안에 나아가게 하고 스레드 굶주림을 막는다. | 자동 시험 | B | 시험: services/purchase-svc/test-int/sale-state.int.test.ts, services/purchase-svc/test-int/seat-store.int.test.ts 외 4곳 |
| v5.0.0-15.2.5 | — | L3 | 문서에 '위험한 기능'이 있거나 '위험 구성 요소'를 쓴다고 적은 부분에 샌드박스·캡슐화·컨테이너·네트워크 격리 같은 추가 보호를 둬, 한 부분을 뚫은 공격자가… | 자동 시험 | B | 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/media-rules.test.ts 외 1곳 |
