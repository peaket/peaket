# 완성 장부: queue-admission

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 `docs/review/ledger-notes.md`). 원천: `docs/features/queue-admission.md`, `docs/security/asvs/queue-admission.md`. 전체 개수와 이 도구의 한계는 `docs/review/ledger/README.md`에 있다.

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 94 | 49 | 2 | 0 | 0 | 4 | 0 | 0 | 42 | 191 |
| B | 33 | 12 | 0 | 0 | 0 | 3 | 0 | 2 | 9 | 59 |
| 합계 | 127 | 61 | 2 | 0 | 0 | 7 | 0 | 2 | 51 | 250 |

## docs/features/queue-admission.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| Q-T1 | — | 로비 셔플 켬·끔 비교(이름 셋 비교를 바꿈, ADR-0118) | T=0 최고 RPS는 로비 셔플을 켠 칸이 끈 칸보다 뚜렷이 낮아야 하고, 두 칸 모두 진입 p99 ≤ 200ms를 유지한다. 봇 유형별 침투 성공률을 칸별로… | 빈칸 | A | — |
| Q-T2 | — | K1 성능 Before/After | 합격은 절대값으로만 판정한다. 로컬 1천·1만·10만 명 실측에서 p99 < 200ms, 오류율 < 0.1%이고, 원 서버 요청이 설계 식 ±10% [가정]… | 측정 | A | HOT-460 · PRF-220 v1 합본 K1 1천·1만 측정(2026-11-11-k1-v1-local-1k-r1~r3·10k-r1~r3). 1천은 entry p99가 한 번 39/1000 위반, 1만은 진입… |
| Q-T3 | — | 도메인 서비스 분리 효과 | (다)는 진입 폭주 100% 중에도 결제 접수 트랜잭션(결제를 받아 처리하는 작업 한 건)의 p99 지연 시간과 가용성 SLO(NFR-005)를 지킨다… | 빈칸 | A | — |
| Q-T4 | — | 1인 1순번 보장 | 정상 순번은 단 1개만 발급되고, 뒤이은 요청은 409 Conflict를 돌려받고 번호를 받지 않는다(선점이 순번 발급보다 먼저다, §3. 장애 전환으로 생긴… | 자동 시험 | A | 시험: services/queue-svc/test/entry-cases.ts, services/v0-monolith/test-int/queue.int.test.ts |
| Q-T5 | — | 단일 키 `INCR` 20만/s 한계 | 단일 샤드 직접 호출로 p99 ≤ 200ms를 충족하면 배치 로직을 빼고, 초과하면 배치 모드를 채택한다. Redis TLS를 켠 상태(운영과 같음)와 끈… | 측정 | A | PRF-220 · `numberbatch` TLS 켬 3·끔 1(2026-11-11-numberbatch-tls-r1~r3·notls-r1). 켬 p99 4.308·4.308·4.265ms, 끔 4.181ms… |
| Q-T6 | — | 100만 건 셔플 연산 검증 | 공시한 drand 라운드를 받은 뒤 5초 이내에 파일 게시를 마친다 [가정, PoC 0.5.3에서 확정]. 라운드는 T=0에서 3초 이상 지나서 나오므로 기준은… | 자동 시험 | A | 시험: packages/shuffle/test/shuffle.test.ts, services/admission-ctrl/test-int/batch-store.int.test.ts 외 4곳 |
| Q-T7 | — | 앞 인원 계산 정밀도 | 파일 생성 시점 기준으로 앞 인원 오차가 정확히 0건임을 검증한다. | 자동 시험 | A | 시험: services/queue-svc/test/state-files.test.ts |
| Q-T8 | — | 입장 비율 보정 로직 | serving 번호가 정확히 100개 증가함을 확인한다. 도착 전의 다음 주기에는 오는 중 80명을 빼서 더 올리지 않는다(ADR-0104). 불린 지 10초… | 자동 시험 | A | 시험: services/admission-ctrl/test-int/leader-store.int.test.ts |
| Q-T9 | — | '곧 입장' 번호 순 배정 | 동시 입장 목표 초과가 0건이다. 200 SOON과 본문 `retryAfterSeconds`(openapi `AdmissionResult`)를 돌려준다… | 자동 시험 | A | 시험: services/queue-svc/test/admission-cases.ts |
| Q-T10 | — | 15분 유예 및 만료 | 14분이 지난 요청은 다음 빈자리로 바로 입장하고, 16분이 지난 요청은 410 Gone으로 만료 처리된다. 차례 시각은… | 자동 시험 | A | 시험: services/admission-ctrl/test-int/leader-store.int.test.ts, services/queue-svc/test/admission-cases.ts |
| Q-T11 | — | 세션 이벤트 유실 방어 | 시작 이벤트가 사라지면 5분 뒤 입장 자리가 자동 회수되고, 종료 이벤트가 사라지면 최대 체류 시한이 되는 즉시 정리된다. 그래서 입장 자리가 영영 묶이는 일이… | 자동 시험 | A | 시험: services/purchase-svc/test-int/purchase-session.int.test.ts, services/purchase-svc/test-int/session-index.int.test.t… |
| Q-T12 | — | admission-ctrl 리더 강제 종료 | serving 번호의 중복 증가가 0건이고, 서비스 공백 시간이 K8s Lease 만료 시간 이내에 머문다. | 자동 시험 | A | 시험: services/admission-ctrl/test-int/leader-store.int.test.ts |
| Q-T13 | — | Redis 장애 페일오버 | 세대 번호를 올려 같은 세대 안 순번 중복이 0건이고(세대가 다른 겹침은 세대 번호로 구분한다, §9), 이미 발급된 대기표는 계속 유효하다. 건너뛴 구간이… | 자동 시험 | A | 시험: packages/platform/test/redis.test.ts, services/admission-ctrl/test/admission-leader.test.ts 외 7곳 |
| Q-T14 | — | 매진 직후 트래픽 급증 | 매진 뒤 1분간 원본 요청 증폭 배수(매진 뒤 1분 ÷ 매진 전 1분)를 두 규모에서 재고, 로컬 캐시 응답 비율이 99% 이상 유지되는지 확인한다. 두 규모의… | 빈칸 | A | — |
| Q-T15 | — | 백그라운드 탭 스로틀링 | 차례가 온 것을 늦게 알아채더라도 15분 유예 기간 안에 정상 입장이 가능하고, 탭 제목 변경과 소리 알림이 정상 작동한다. | 빈칸 | A | — |
| Q-T16 | — | Degraded 진입 경로 검증 | 칸이 닫히기 전에 온 요청끼리는 칸 순서가 뒤바뀐 쌍이 0건이다(같은 100ms 칸 안은 뒤바뀔 수 있다). 칸이 닫힌 뒤 온 요청 1% 이하, 구간이 넘친… | 자동 시험 | A | 시험: services/admission-ctrl/test-int/leader-store.int.test.ts, services/admission-ctrl/test/admission-leader.test.ts 외… |
| Q-T17 | — | 상태 조회 Degraded 경로 | 폴링 주기가 2배로 정상 연장되고 S3 비상 경로로 매끄럽게 전환되어, 상태 반영 p99가 5초 이내를 유지한다. 원본이 S3 사본이어도 주기가 2배로… | 자동 시험 | A | 시험: services/queue-svc/test/state-mirror.test.ts |
| Q-T18 | — | 재접속 순번 보존율 | 이미 발급된 고유 순번이 그대로 유지되고, 앞 인원이 최신 상태로 정상 갱신된다. | 빈칸 | A | — |
| Q-T19 | — | 웹 접근성 보장 | axe Core 위반 사항 0건을 달성하고, 차례가 왔다는 알림이 빠짐없이 화면 낭독기로 나온다. | 빈칸 | A | — |
| Q-T20 | ① | 봇 등급별 혼동 행렬 측정 | ① '공개 자료 기준': 이용 조건을 확인한 공개 실제 사람 기록에서 결과를 보기 전에 사전 등록한 n명(1인 1기록, 조정용과 사람 단위로 나눔, 원천… | 빈칸 | A | — |
| Q-T20 | ② | 봇 등급별 혼동 행렬 측정 | ② '모의 사람(리허설)': 모의 사람 생성기의 세션(원천 `mock`)을 같은 경로로 넣어 측정 절차가 끝까지 도는지 본다. 추가 검증 큐로 간 봇 세션은 그… | 빈칸 | A | — |
| Q-T21 | — | 적응형 공격 대응 검증 | 등급별로 라운드 1과 비교한 마지막 라운드의 하락 폭(%p)과 규칙 변경 내역을 기록한다. 2단계가 95% 아래로 떨어지면 ADR-0039 되돌릴 조건을 따른다 | 빈칸 | A | — |
| Q-T22 | — | 실서비스 하한 지표 추정 | 자동화 봇만 허니팟에 걸리고 화면 낭독기 사용자는 잘못 걸리는 일이 없음을 확인한다. 링크를 미리 여는 확장 프로그램을 켠 브라우저의 적중 수를 따로 세고… | 빈칸 | A | — |
| Q-T23 | — | 동시 도착 구간 묶음 검증(오픈 직후 묶음 켬·끔 비교… | 묶음 안 순번과 실제 도착 시각 사이의 스피어만 상관계수 절댓값이 ≤ 0.05 [가정]로 수렴한다. 사람 모의 도착의 p90이 N 안에 들고, 묶음에 든 사람… | 자동 시험 | A | 시험: services/admission-ctrl/test/publish.test.ts |
| Q-T24 | — | 토큰 발급 시각 정책 검증 | 미리 발급한 토큰만 무작위 묶음 셔플에 들어가고, 오픈 후 발급한 토큰은 묶음 다음의 도착 순서로 배정된다. 무중단 갱신을 해도 최초 발급 시각이 바뀌지 않는다. | 자동 시험 | A | 시험: services/queue-svc/test/batch-cases.ts, services/queue-svc/test/entry-cases.ts |
| Q-T25 | — | 차례 직전 직접 확인 규칙 | 이른 시도는 `NOT_YET`과 남은 예상 시간을 받고, 다음 시도는 그 시각에 맞춰진다. 레이트 리밋 위반 요청은 차단되고, 직접 확인으로 늘어난 origin… | 자동 시험 | A | 시험: apps/web/queue-room/test/autoassign.test.mjs |
| Q-T26 | — | 1장당 획득 비용 산출 | 장부 `k6_cost`에 1장당 획득 비용과 웃돈(20만·90만 원)·적발 확률(1%·5%)별 손익이 남는다. 3단계는 '1장당 획득 비용 ≥ 기준 웃돈 ×… | 빈칸 | A | — |
| Q-T27 | — | 비콘 지연 대기와 비상 처리 | 30초 지연에서는 그 라운드를 받은 뒤 셔플하고, 결과가 공개 재계산과 일치한다. 90초 지연에서는 60초에 셔플이 멈추고 SEV1 경보가 난다. 비상 처리는… | 자동 시험 | A | 시험: apps/web/scripts/mock-api/queue.test.mjs, apps/web/src/_pages/shuffle-proof/model/proof-view.test.mjs 외 16곳 |
| Q-T28 | — | 대기 순서 공정성 지표 | 차례 전 입장이 0건이고, 위조 요청은 거부되며, `queue_admit_before_turn_total`이 늘지 않는다. 지표를 일부러 1 올리면… | 자동 시험 | A | 시험: services/queue-svc/test/admission-cases.ts |
| Q-T29 | — | 도착 시각 쿠키 위조·재사용 | 네 경우 모두 쿠키가 무시되고 일반 진입 순서로 처리되며, 정상 쿠키는 도착 시각 순서대로 순번을 받는다 | 자동 시험 | A | 시험: services/queue-svc/test/arrival-cookie.test.ts, services/queue-svc/test/arrival-slot-cases.ts 외 2곳 |
| Q-T30 | — | 옛 리더 펜싱과 리더 상태 이어받기 | 옛 리더의 쓰기는 모두 `FENCED`로 거절되고 그 파드는 대기 파드로 돌아간다. serving과 묶음 카운터의 중복 전진이 0건이고, 입장 일시정지와 수동… | 자동 시험 | A | 시험: services/admission-ctrl/test-int/leader-store.int.test.ts, services/admission-ctrl/test/admission-leader.test.ts |
| Q-T31 | — | 장애 전환으로 생긴 대기표 두 장 | 먼저 입장 확정한 대기표만 입장하고, 다른 대기표는 409 `DUPLICATE_ADMISSION`을 받으며 그 번호가 빠진 번호로 기록된다. 같은 대기표로 다시… | 자동 시험 | A | 시험: services/queue-svc/test/admission-cases.ts |
| Q-T32 | — | 셔플 결과 분산 조회 | 게시 전 조회가 0건이고, 조회가 분산 창 8초에 고르게 퍼진다(1초 단위 최대가 평균의 1.3배 [가정] 이하). 게시가 늦으면 404 재시도 간격이… | 자동 시험 | A | 시험: services/queue-svc/test/shuffle-proof.test.ts |
| Q-T33 | — | 첫 전진 시각 | 분산 창이 지나기 전에는 serving이 각 구간의 첫 번호를 넘지 않고, 지난 뒤 정상 전진한다. 게시를 공개 예정 시각보다 5초 늦춘 실행에서는 게시 뒤… | 자동 시험 | A | 시험: services/admission-ctrl/test-int/leader-store.int.test.ts, services/admission-ctrl/test/admission-leader.test.ts |
| Q-T34 | ① | 추가 검증 통과자의 입장 | ① 빠진 번호가 되지 않는다 | 자동 시험 | A | 시험: services/admission-ctrl/test-int/batch-store.int.test.ts, services/admission-ctrl/test/publish.test.ts 외 1곳 |
| Q-T34 | ② | 추가 검증 통과자의 입장 | ② 원래 번호의 차례에 ADMITTED | 자동 시험 | A | 시험: services/queue-svc/test-int/verification-admission.int.test.ts, services/queue-svc/test/admission-cases.ts |
| Q-T34 | ③ | 추가 검증 통과자의 입장 | ③ 통과 즉시 ADMITTED(15분은 통과 시각부터) | 자동 시험 | A | 시험: services/queue-svc/test-int/verification-admission.int.test.ts, services/queue-svc/test/admission-cases.ts |
| Q-T34 | ④ | 추가 검증 통과자의 입장 | ④ 원래 번호의 차례에 ADMITTED | 자동 시험 | A | 시험: services/queue-svc/test-int/verification-admission.int.test.ts, services/queue-svc/test/admission-cases.ts |
| Q-T34 | ⑤ | 추가 검증 통과자의 입장 | ⑤ VERIFYING | 자동 시험 | A | 시험: services/queue-svc/test/admission-cases.ts, services/queue-svc/test/admission.test.ts |
| Q-T34 | ⑥ | 추가 검증 통과자의 입장 | ⑥ 거절 | 자동 시험 | A | 시험: services/queue-svc/test-int/verification-admission.int.test.ts, services/queue-svc/test/admission-cases.ts 외 1곳 |
| Q-T34 | ⑦ | 추가 검증 통과자의 입장 | ⑦ 거절 | 자동 시험 | A | 시험: services/queue-svc/test-int/admission-store.int.test.ts, services/queue-svc/test/leave-cases.ts |
| Q-T34 | ⑧ | 추가 검증 통과자의 입장 | ⑧ `verify` 칸이 지워지고 다음 입장 확정은 410이다. 모든 경우에 다른 대기자의 앞 인원이 바뀌지 않고, 차례 전 입장은 0건이다 | 자동 시험 | A | 시험: services/queue-svc/test/admission-cases.ts |
| Q-T35 | ① | 만료 뒤 다시 줄 서기 | ① 410(rejoinAllowed=true) 뒤 맨 뒤 새 번호 | ID만 | A | 시험: services/queue-svc/test-int/admission-store.int.test.ts, services/queue-svc/test/leave-cases.ts 외 1곳 |
| Q-T35 | ② | 만료 뒤 다시 줄 서기 | ② 409(이미 대기 중), 대기 취소 뒤 맨 뒤 새 번호 | 자동 시험 | A | 시험: services/queue-svc/test-int/admission-store.int.test.ts, services/queue-svc/test/leave-cases.ts 외 1곳 |
| Q-T35 | ③ | 만료 뒤 다시 줄 서기 | ③ 409 ALREADY_ADMITTED, 번호 발급 없음 | 자동 시험 | A | 시험: services/queue-svc/test-int/admission-store.int.test.ts |
| Q-T35 | ④ | 만료 뒤 다시 줄 서기 | ④ 410(rejoinAllowed=true) 뒤 맨 뒤 새 번호(ADR-0064) | ID만 | A | 시험: services/queue-svc/test-int/admission-store.int.test.ts, services/queue-svc/test/leave-cases.ts 외 1곳 |
| Q-T36 | ① | 판매 자격 명단 | ① 없는 사람은 로비 참가(오픈 전 참가도 오픈 시각으로 판정)와 진입 모두 대기열에 들지 않고(번호 발급 0) 403… | 자동 시험 | A | 시험: services/queue-svc/test/eligibility-cases.ts, services/queue-svc/test/eligibility-schedule.test.ts |
| Q-T36 | ② | 판매 자격 명단 | ② 있는 사람은 입장 토큰 클레임 `lst`에 그 사람이 든 명단 키만 실린다(든 명단이 없으면 `lst`가 없다) | 자동 시험 | A | 시험: services/queue-svc/test/eligibility-cases.ts |
| Q-T36 | ③ | 판매 자격 명단 | ③ 3매 홀드는 거부된다(1인 2매) | 다른 단계 | A | HOT-252 · 홀드 때의 판매 정책 평가(`lst`·등급·매수, 403 `sale-policy-denied`, 규칙 한도를 홀드 Lua 한도로)는 purchase-svc 몫이다. 감독이 갈래 1 새 단계를… |
| Q-T36 | ④ | 판매 자격 명단 | ④ 판매 기간 끝 + 1일(파기 시각)이 지난 뒤 첫 정비에 명단(DB 행과 구성원)이 지워지고, 사본에 넘긴 수명이 그 파기 시각이다(1ms 전에는 지우지… | 자동 시험 | A | 시험: services/core-svc/test-int/sale-eligibility.int.test.ts |
| Q-T36 | ⑤ | 판매 자격 명단 | ⑤ 잠금 뒤 올리기는 거절되고 명단이 바뀌지 않는다 | 자동 시험 | A | 시험: services/core-svc/test-int/sale-eligibility.int.test.ts, services/core-svc/test/sale-eligibility.http.test.ts |
| Q-T36 | ⑥ | 판매 자격 명단 | ⑥ 올리기 결과는 반영 수·형식 오류 줄(행 번호)·없는 코드 줄(행 번호)만 싣고, 올린 파일은 어디에도 남지 않으며 감사 기록에는 올린 계정·시각·건수·파일… | 자동 시험 | A | 시험: services/core-svc/test-int/sale-eligibility.int.test.ts, services/core-svc/test/sale-eligibility.http.test.ts |
| Q-T36 | ⑦ | 판매 자격 명단 | ⑦ 명단 사본(대기열 Redis `q:{event:E}:elig:{listKey}`)이 그 수명에 지워진다( | 다른 단계 | A | HOT-251 · 명단 사본(대기열 Redis)이 그 수명에 지워지는 것은 사본을 쓰는 core-svc 어댑터가 본다(소유자 결정 2026-11-10, OPEN[33] (가), ADR-0261 결정 9). 어댑터는… |
| Q-T36 | ⑧ | 판매 자격 명단 | ⑧ 화면은 로비 참가·진입의 403 `sale-eligibility-required`를 참가 실패가 아니라 공연 상세의 예매 제한 안내로 돌린다 | 다른 단계 | A | HOT-346 · 로비 참가·진입의 403 `sale-eligibility-required`를 참가 실패가 아니라 공연 상세의 예매 제한 안내로 돌리는 화면 몫이다(apps/web 대기실·공연 상세… |
| Q-T36 | ⑨ | 판매 자격 명단 | ⑨ 창 안인데 그 창 명단의 사본 표지가 없을 때와 자격 설정 칸(`eligGates`·`eligLists`)의 모양이 틀릴 때(창을 모르므로 판매 기간… | 자동 시험 | A | 시험: services/queue-svc/test/eligibility-cases.ts |
| Q-T37 | — | 대기 화면 진행 막대 | 진행률이 0~100% 안에서 계산식대로 움직이고, 오래된 파일은 버려져 막대가 물러나지 않고 앞 인원도 늘지 않는다. serving이 작은 새 파일은 판매… | 빈칸 | A | — |
| Q-T38 | ① | 판매 종료와 사전 셔플 공연의 오픈 뒤 진입 | ① 410 없이 모두 1,001번부터 도착 순 번호, 202 BATCHING 없음 | ID만 | A | 시험: services/queue-svc/test/admission-cases.ts |
| Q-T38 | ② | 판매 종료와 사전 셔플 공연의 오픈 뒤 진입 | ② 앞은 201, 뒤는 410 sale-ended이고 번호 발급 없음 | ID만 | A | 시험: services/queue-svc/test/admission-cases.ts |
| Q-T38 | ③ | 판매 종료와 사전 셔플 공연의 오픈 뒤 진입 | ③ 대기 상태 파일 ENDED, 입장 확정 410 sale-ended, 대기 기록 SALE_END | ID만 | A | 시험: services/queue-svc/test/admission-cases.ts |
| Q-T38 | ④ | 판매 종료와 사전 셔플 공연의 오픈 뒤 진입 | ④ 홀드·결제 시간 안이면 주문·결제 성공 | ID만 | A | 시험: services/queue-svc/test/admission-cases.ts |
| Q-T38 | ⑤ | 판매 종료와 사전 셔플 공연의 오픈 뒤 진입 | ⑤ 410 sale-ended | ID만 | A | 시험: services/queue-svc/test/admission-cases.ts |
| Q-T38 | ⑥ | 판매 종료와 사전 셔플 공연의 오픈 뒤 진입 | ⑥ rejoinAllowed=false | ID만 | A | 시험: services/queue-svc/test/admission-cases.ts |
| Q-T39 | ① | 최초 방문 쿠키와 행동 신호 요약 | ① 응답에 `__Host-peaket_fv`(Secure·HttpOnly·SameSite=Strict, Domain 없음)가 한 번 실린다 | 자동 시험 | A | 시험: services/queue-svc/test/edge-first-visit-function.test.ts |
| Q-T39 | ② | 최초 방문 쿠키와 행동 신호 요약 | ② 새 쿠키 없이 쿠키 나이가 신호로 넘어간다 | 자동 시험 | A | 시험: services/queue-svc/test/edge-first-visit-function.test.ts, services/queue-svc/test/first-visit-cookie.test.ts |
| Q-T39 | ③ | 최초 방문 쿠키와 행동 신호 요약 | ③ 쿠키가 없는 것으로 처리되고 다른 진입은 그대로다 | 자동 시험 | A | 시험: services/queue-svc/test/first-visit-cookie.test.ts |
| Q-T39 | ④ | 최초 방문 쿠키와 행동 신호 요약 | ④ CDN 캐시 응답에 `Set-Cookie`가 없다 | 자동 시험 | A | 시험: services/queue-svc/test/edge-first-visit-function.test.ts |
| Q-T39 | ⑤ | 최초 방문 쿠키와 행동 신호 요약 | ⑤ 400. 요청·로그에 원시 좌표·키 값이 0건이다 | ID만 | A | 시험: apps/web/src/_pages/event-detail/ui/no-set-cookie.test.mjs, apps/web/src/features/behavior-summary/tracker.test.mjs… |
| Q-T40 | ① | 허니팟 기록 조건 | ①만 허니팟 적중으로 기록되고, | ID만 | A | 시험: apps/web/queue-room/test/hidden-link.test.mjs, apps/web/src/shared/config/hidden-link.test.mjs 외 4곳 |
| Q-T40 | ② | 허니팟 기록 조건 | ②는 기록되지 않는다( | ID만 | A | 시험: apps/web/queue-room/test/hidden-link.test.mjs, apps/web/src/shared/config/hidden-link.test.mjs 외 4곳 |
| Q-T40 | ③ | 허니팟 기록 조건 | ③는 기록되지 않는다( | ID만 | A | 시험: apps/web/queue-room/test/hidden-link.test.mjs, apps/web/src/shared/config/hidden-link.test.mjs 외 4곳 |
| Q-T40 | ④ | 허니팟 기록 조건 | ④는 기록되지 않는다( | ID만 | A | 시험: apps/web/queue-room/test/hidden-link.test.mjs, apps/web/src/shared/config/hidden-link.test.mjs 외 4곳 |
| Q-T40 | ⑤ | 허니팟 기록 조건 | ⑤는 기록되지 않는다( … 는 남는 한계로, 다른 신호가 맡는다) | ID만 | A | 시험: apps/web/queue-room/test/hidden-link.test.mjs, apps/web/src/shared/config/hidden-link.test.mjs 외 4곳 |
| Q-T41 | ① | 진입·입장 확정의 사전 요청 없는 형식과 교차 출처 응답 | ① 네트워크 기록에 OPTIONS가 없고 응답을 스크립트가 읽는다 … 의 브라우저 시험이 증명하고, … 에서 OPTIONS가 보이면 ADR-0065 되돌릴… | 자동 시험 | A | 시험: services/queue-svc/test/admission.test.ts |
| Q-T41 | ② | 진입·입장 확정의 사전 요청 없는 형식과 교차 출처 응답 | ② OPTIONS가 먼저 나가고 응답에 `Access-Control-Max-Age: 7200`이 있다 | ID만 | A | 시험: services/queue-svc/test/admission.test.ts, services/queue-svc/test/http.test.ts |
| Q-T41 | ③ | 진입·입장 확정의 사전 요청 없는 형식과 교차 출처 응답 | ③ 415 | 자동 시험 | A | 시험: services/queue-svc/test/http.test.ts |
| Q-T41 | ④ | 진입·입장 확정의 사전 요청 없는 형식과 교차 출처 응답 | ④ 거절 | ID만 | A | 시험: services/queue-svc/test/admission.test.ts, services/queue-svc/test/http.test.ts |
| Q-T41 | ⑤ | 진입·입장 확정의 사전 요청 없는 형식과 교차 출처 응답 | ⑤ 거절 | ID만 | A | 시험: services/queue-svc/test/admission.test.ts, services/queue-svc/test/http.test.ts |
| Q-T41 | ⑥ | 진입·입장 확정의 사전 요청 없는 형식과 교차 출처 응답 | ⑥ 거절(대기표 미발급) | ID만 | A | 시험: services/queue-svc/test/admission.test.ts, services/queue-svc/test/http.test.ts |
| Q-T41 | ⑦ | 진입·입장 확정의 사전 요청 없는 형식과 교차 출처 응답 | ⑦ 읽힌다, `Access-Control-Allow-Credentials`는 없다 | ID만 | A | 시험: services/queue-svc/test/admission.test.ts, services/queue-svc/test/http.test.ts |
| Q-T41 | ⑧ | 진입·입장 확정의 사전 요청 없는 형식과 교차 출처 응답 | ⑧ 서버가 받은 OPTIONS 요청 수와 진입 지연을 기록한다(k6는 브라우저가 아니라 형식만 따르므로, '브라우저가 사전 요청을 보내지 않는다'는 것은 … 은… | ID만 | A | 시험: services/queue-svc/test/admission.test.ts, services/queue-svc/test/http.test.ts |
| Q-T42 | — | 제어 입력 없음과 증액 주기 | 입력 없음으로 판정하고 목표를 바꾸지 않는다(증가 0, 감소 0). 4분 전 값도 입력 없음이다. 명령 1은 반영되고, 결제사 상한으로는 줄어든다. 입력이… | 자동 시험 | A | 시험: services/admission-ctrl/test-int/leader-store.int.test.ts, services/admission-ctrl/test-sim/admission-loop.sim.test… |
| Q-T43 | — | 감축 확인 시간 | AIMD 감축은 한 번(2,500)만 일어난다. 예매 단계 인원이 2,500 아래로 내려오고 감축 뒤 35초가 지나거나, 2분이 지난 뒤에야 다음 감축이… | 자동 시험 | A | 시험: services/admission-ctrl/test/aimd.test.ts |
| Q-T44 | — | 대기 중 재평가 | 그림자: 판정 기록이 6건(`shadow` true)이고 격리는 0건이다. 적용: 아직 기다리는 5명만 빠진 번호와 `VERIFYING`이 기록되고, 입장한… | 빈칸 | A | — |
| Q-T45 | ① | pid 키 전환 기간의 1인 1순번(추천 적용 2026-10-28… | ①은 409 이미 대기 중이다. | 자동 시험 | A | 시험: services/queue-svc/test/lobby-cases.ts, services/queue-svc/test/pid-transition-cases.ts |
| Q-T45 | ② | pid 키 전환 기간의 1인 1순번(추천 적용 2026-10-28… | ②는 번호가 하나만 나간다. | 자동 시험 | A | 시험: services/queue-svc/test/pid-transition-cases.ts |
| Q-T45 | ③ | pid 키 전환 기간의 1인 1순번(추천 적용 2026-10-28… | ③은 409 `ALREADY_ADMITTED`다. | 자동 시험 | A | 시험: services/queue-svc/test/pid-transition-cases.ts |
| Q-T45 | ④ | pid 키 전환 기간의 1인 1순번(추천 적용 2026-10-28… | ④는 새 pid 키로 막힌다. | 자동 시험 | A | 시험: services/queue-svc/test/pid-transition-cases.ts |
| Q-T45 | ⑤ | pid 키 전환 기간의 1인 1순번(추천 적용 2026-10-28… | ⑤는 옛 pid 쪽 선점이 지워지고 503이며, 다시 보내면 번호가 하나 나간다. 전환 기간 내내 위험 판정과 사람별 대기 기록의 pid는 옛 pid다 | 자동 시험 | A | 시험: services/queue-svc/test/lobby-cases.ts, services/queue-svc/test/pid-transition-cases.ts |
| Q-T46 | — | 도착 지연을 넣은 입장 제어 루프(추천 적용 2026-10-28… | 곧 입장 응답이 입장 확정 요청의 1% [가정] 이하, 곧 입장으로 기다린 시간 p99 5초 [가정] 이하, 바꾸기 전 식보다 입장 수 감소 2% [가정]… | 자동 시험 | A | 시험: services/admission-ctrl/test-sim/admission-loop.sim.test.ts |
| Q-T47 | — | 입장 임박 구간 반영 지연(추천 적용 2026-10-28… | 차례 반영 지연(serving이 내 번호를 넘은 전진 시각 → 화면에 그린 시각) p99 2.8초 [가정] 이하다(3초에서 CDN 계층 몫 0.2초를 남긴다… | 자동 시험 | A | 시험: services/queue-svc/test-sim/nginx-expiry.sim.test.ts, services/queue-svc/test-sim/reflect.sim.test.ts |
| Q-T48 | ① | 차단 기기 키와 이의 인정(추천 적용 2026-10-28, 기술 검토… | ① 세 기기 모두 '차단 목록에 있음' 신호가 붙는다. | 자동 시험 | A | 시험: services/trust-svc/test-int/apply-label.int.test.ts |
| Q-T48 | ② | 차단 기기 키와 이의 인정(추천 적용 2026-10-28, 기술 검토… | ② 그 기기의 키가 지워지고, 지운 기록(기기 가명·이의 건 ID·처리자·시각)이 CS 처리함 건과 판정 기록에 남는다. | 다른 단계 | A | GAT-280 · 지운 기록이 CS 처리함 건에 남는 것은 CS 처리함(SCR-045) 몫이고 ops-svc가 아직 없다. trust-svc 쪽(차단 키 지우기, 보안 로그 줄, 라벨 판정 기록)은 B-T9… |
| Q-T48 | ③ | 차단 기기 키와 이의 인정(추천 적용 2026-10-28, 기술 검토… | ③ 차단 목록 신호가 붙지 않는다. | 자동 시험 | A | 시험: services/trust-svc/test-int/apply-label.int.test.ts |
| Q-T48 | ④ | 차단 기기 키와 이의 인정(추천 적용 2026-10-28, 기술 검토… | ④ 남은 두 키가 TTL로 사라진다. | 자동 시험 | A | 시험: services/trust-svc/test-int/apply-label.int.test.ts |
| Q-T48 | ⑤ | 차단 기기 키와 이의 인정(추천 적용 2026-10-28, 기술 검토… | ⑤ 차단 목록 신호가 붙은 기기가 0개다(틀린 '있다'가 없다) | 자동 시험 | A | 시험: services/trust-svc/test-int/apply-label.int.test.ts |
| Q-T49 | — | 에러 버짓 연동 감축의 대상 여정(추천 적용 2026-10-28… | 연동 여정 넷은 목표가 한 번만 2,500으로 줄고 자동 증액이 멈춘다(사유 `budget_alert`·`budget_50`, `journey` 라벨). 다른… | 자동 시험 | A | 시험: services/admission-ctrl/test/aimd.test.ts |
| Q-T50 | ① | 외부 합성 점검용 회차(추천 적용 2026-10-28, 기술 검토… | ①은 대기열 순번 없이 입장 확정을 받는다. | 빈칸 | A | — |
| Q-T50 | ② | 외부 합성 점검용 회차(추천 적용 2026-10-28, 기술 검토… | ②는 우회 없이 일반 대기열로 간다. | 빈칸 | A | — |
| Q-T50 | ③ | 외부 합성 점검용 회차(추천 적용 2026-10-28, 기술 검토… | ③은 거절되고 보안 이벤트로 남는다. | 빈칸 | A | — |
| Q-T50 | ④ | 외부 합성 점검용 회차(추천 적용 2026-10-28, 기술 검토… | ④에서 결제 승인 호출은 0건이고, 남은 결제 시도는 만료로 닫히며 홀드는 세션 종료로 풀린다. 점검 트래픽은 SLO 기록 규칙·퍼널 카운터·관제 실시간… | 빈칸 | A | — |
| Q-T51 | ① | 일시 매진·매진·매진 풀림(추천 적용 2026-10-28… | ①가용 0이 5초 이어지면 파일이 ALL_HELD가 되고 serving 전진이 멈춘다(새 입장 0건). 대기는 끝나지 않고, 만료로 좌석이 돌아오면… | 자동 시험 | A | 시험: services/queue-svc/test/entry-cases.ts |
| Q-T51 | ② | 일시 매진·매진·매진 풀림(추천 적용 2026-10-28… | ② 대기 참여가 SaleEnded로 끝나고(대기 기록의 빠진 사유 `SOLD_OUT`, 기술 검토 낮음-130) 진입·입장 확정이 410 `sold-out`이다 | 자동 시험 | A | 시험: services/queue-svc/test-int/sale-state.int.test.ts, services/queue-svc/test/entry-cases.ts 외 2곳 |
| Q-T51 | ③ | 일시 매진·매진·매진 풀림(추천 적용 2026-10-28… | ③ 매진이 풀려 파일이 ON_SALE이 되고, 취소표 알림 신청자에게 알림이 한 번 가며, serving이 매진 때의 마지막 발급 번호로 옮겨져 새 진입자부터… | 자동 시험 | A | 시험: services/queue-svc/test/sale-state-cases.ts |
| Q-T51 | ④ | 일시 매진·매진·매진 풀림(추천 적용 2026-10-28… | ④ 매진이 풀려 파일이 ON_SALE이 되고, 취소표 알림 신청자에게 알림이 한 번 가며, serving이 매진 때의 마지막 발급 번호로 옮겨져 새 진입자부터… | ID만 | A | 시험: services/admission-ctrl/test-int/leader-store.int.test.ts, services/queue-svc/test-int/consumers.int.test.ts 외 6곳 |
| Q-T51 | ⑤ | 일시 매진·매진·매진 풀림(추천 적용 2026-10-28… | ⑤ 매진이 풀리지 않는다(ADR-0064). 모든 전이가 `EventSaleChanged`의 판 번호 순서와 같다 | ID만 | A | 시험: services/admission-ctrl/test-int/leader-store.int.test.ts, services/queue-svc/test-int/consumers.int.test.ts 외 6곳 |
| Q-T52 | ① | 오픈 직후 표시와 첫 INCR 순서(추천 적용 2026-10-28… | ① 오픈 뒤 `INCR` 번호가 모두 로비 몫(1~1,000)보다 크고, 리더를 기다려 막힌 진입(503)이 0건이다. | 자동 시험 | A | 시험: services/queue-svc/test/batch-cases.ts |
| Q-T52 | ② | 오픈 직후 표시와 첫 INCR 순서(추천 적용 2026-10-28… | ② 오픈 뒤 `INCR` 번호가 모두 로비 몫(1~1,000)보다 크고, 리더를 기다려 막힌 진입(503)이 0건이다. | ID만 | A | 시험: services/admission-ctrl/test/publish.test.ts, services/queue-svc/test/batch-cases.ts 외 3곳 |
| Q-T52 | ③ | 오픈 직후 표시와 첫 INCR 순서(추천 적용 2026-10-28… | ③ 503 `Retry-After` 뒤 다시 와서 묶음 구간보다 큰 번호를 받는다. | 자동 시험 | A | 시험: services/queue-svc/test/batch-cases.ts |
| Q-T52 | ④ | 오픈 직후 표시와 첫 INCR 순서(추천 적용 2026-10-28… | ④ 비콘을 기다리는 동안 온 진입의 번호가 모두 묶음 구간보다 크다. | ID만 | A | 시험: services/admission-ctrl/test/publish.test.ts, services/queue-svc/test/batch-cases.ts 외 3곳 |
| Q-T52 | ⑤ | 오픈 직후 표시와 첫 INCR 순서(추천 적용 2026-10-28… | ⑤로비 목록이 바뀌지 않는다. | 자동 시험 | A | 시험: services/queue-svc/test/leave-cases.ts, services/queue-svc/test/leave-http.test.ts 외 1곳 |
| Q-T52 | ⑥ | 오픈 직후 표시와 첫 INCR 순서(추천 적용 2026-10-28… | ⑥ 표시와 카운터가 같은 값으로 다시 서고, 카운터 건너뛰기는 그 뒤에 한다. 로비 몫과 묶음 몫은 한 번씩만 더해진다 | ID만 | A | 시험: services/admission-ctrl/test/publish.test.ts, services/queue-svc/test/batch-cases.ts 외 3곳 |
| Q-T53 | ① | 선점 직후 파드 종료와 응답을 잃은 재시도(추천 적용… | ① 대기를 취소하지 않고 번호를 하나 받는다. | 자동 시험 | A | 시험: services/queue-svc/test/entry-cases.ts |
| Q-T53 | ② | 선점 직후 파드 종료와 응답을 잃은 재시도(추천 적용… | ② 선점 수명(10초) 동안 409이고, 그 뒤에는 번호를 받는다(그 사람의 번호는 하나). | 자동 시험 | A | 시험: services/queue-svc/test/entry-cases.ts |
| Q-T53 | ③ | 선점 직후 파드 종료와 응답을 잃은 재시도(추천 적용… | ③ 같은 번호의 대기표를 받고 새 번호는 나가지 않는다. | 자동 시험 | A | 시험: services/queue-svc/test/entry-cases.ts |
| Q-T53 | ④ | 선점 직후 파드 종료와 응답을 잃은 재시도(추천 적용… | ④ 다시 보낸 요청은 새 번호를 받고, 아무도 갖지 않은 번호 수를 장부에 남긴다. | 자동 시험 | A | 시험: services/queue-svc/test/entry-cases.ts |
| Q-T53 | ⑤ | 선점 직후 파드 종료와 응답을 잃은 재시도(추천 적용… | ⑤ 그사이 다른 요청이 선점했으면 이 요청의 번호는 빠진 번호가 되고 409다. 모든 경우에 한 사람의 유효 대기표는 하나다 | 자동 시험 | A | 시험: services/queue-svc/test/entry-cases.ts |
| Q-T54 | ① | 매진 전환 순서와 매진 화면(추천 적용 2026-10-28, 기술 검토… | ① 공연 상세의 캐시 무효화와 진입 410(로컬 캐시·엣지 대체)이 대기 상태 파일의 매진 갱신보다 먼저 일어난다(사건 시각 대조, §8). | ID만 | A | 시험: services/queue-svc/test/sale-state-cases.ts, services/queue-svc/test/state-files.test.ts |
| Q-T54 | ② | 매진 전환 순서와 매진 화면(추천 적용 2026-10-28, 기술 검토… | ② 대기 화면은 다음 폴링(먼 구간 최대 약 25초) 안에 매진 화면(SCR-018)으로 바뀌고 폴링을 멈춘다. 새로고침은 원본 호출 없이 로컬 캐시 응답으로… | ID만 | A | 시험: services/queue-svc/test/sale-state-cases.ts, services/queue-svc/test/state-files.test.ts |
| Q-T54 | ③ | 매진 전환 순서와 매진 화면(추천 적용 2026-10-28, 기술 검토… | ③ 대기는 이어지고 `soldOutTiers`에만 R이 들어간다. | 자동 시험 | A | 시험: services/queue-svc/test/sale-state-cases.ts, services/queue-svc/test/state-files.test.ts |
| Q-T54 | ④ | 매진 전환 순서와 매진 화면(추천 적용 2026-10-28, 기술 검토… | ④ 1분 전 신청은 받고, 판매 종료 뒤 신청은 받지 않는다(ADR-0064) | ID만 | A | 시험: services/queue-svc/test/sale-state-cases.ts, services/queue-svc/test/state-files.test.ts |
| Q-T55 | ① | 로비 참가 토큰(추천 적용 2026-10-28, 기술 검토 중간-005) | ① T-10분 전에는 참가 토큰이 나오지 않는다. T-10분부터는 사람 확인을 통과한 뒤 참가 토큰 1장을 받고, 응답에 셔플 결과 공개 예정 시각과 분산 창이… | 자동 시험 | A | 시험: services/queue-svc/test/lobby-cases.ts |
| Q-T55 | ② | 로비 참가 토큰(추천 적용 2026-10-28, 기술 검토 중간-005) | ② 새 토큰은 나오지 않고 기존 토큰의 세션이 이어진다(pid당 유효 토큰 1장). | 자동 시험 | A | 시험: services/queue-svc/test/lobby-cases.ts |
| Q-T55 | ③ | 로비 참가 토큰(추천 적용 2026-10-28, 기술 검토 중간-005) | ③ 진입이 막히고 그 자리에서 본인확인 안내가 나온다(I-T7). 위험 점수가 기준을 넘어 격리되는 경우는 Q-T34가 본다 | ID만 | A | 시험: services/queue-svc/test/http.test.ts, services/queue-svc/test/lobby-cases.ts 외 1곳 |
| Q-T56 | — | 엣지 함수 서명과 비용 PoC(추천 적용 2026-10-29… | 도착 시각 쿠키에 암호 서명이 되고, 완전 매진 플래그를 엣지에서 바로 응답할 수 있음을 보인다. 두 조건을 채우는 쪽 가운데 실행 비용이 낮은 쪽을 고른다 | 빈칸 | A | — |
| Q-T57 | ① | 로비 사람 확인 검증 부하 PoC(추천 적용 2026-10-29… | ① 검증 p99 지연이 로비에 머무는 사용자에게 나쁜 영향을 주지 않는다. 지연이 보이면 로비를 미리 여는 시간을 10분에서 15분으로 늘린다(§9 '사람 확인… | 빈칸 | A | — |
| Q-T57 | ② | 로비 사람 확인 검증 부하 PoC(추천 적용 2026-10-29… | ② 첫 1분의 초당 도착 수 최댓값이 그 1분 평균의 1.5배 [가정] 이하이고, 로비 참가 p99·오류율이 SLO 안이다. trust-svc 판정… | 빈칸 | A | — |
| Q-T57 | ③ | 로비 사람 확인 검증 부하 PoC(추천 적용 2026-10-29… | ③와 견줘 초당 최댓값과 로비 참가 p99가 얼마나 줄었는지 적는다(장치의 효과). 로컬에서 낸 최대 도착률과 설계 식의 100만 값은 '외삽(설계 식)'으로… | 빈칸 | A | — |
| Q-T58 | ① | 봇 판정 서비스 장애 때의 축소 운영(추천 적용 2026-10-29… | ① 서킷 브레이커가 열리고 캐시한 판정 규칙과 보수적인 레이트 리밋으로 바뀐다(§9 'trust-svc 장애' 행) | 빈칸 | A | — |
| Q-T58 | ② | 봇 판정 서비스 장애 때의 축소 운영(추천 적용 2026-10-29… | ② 대기열 진입 성공률이 NFR-001 목표를 지킨다(진입 자체를 막지 않는다) | 빈칸 | A | — |
| Q-T58 | ③ | 봇 판정 서비스 장애 때의 축소 운영(추천 적용 2026-10-29… | ③ 한도는 기기·계정 단위로 걸리고, 통신사 대역에는 IP 제한이 걸리지 않는다 | 빈칸 | A | — |
| Q-T58 | ④ | 봇 판정 서비스 장애 때의 축소 운영(추천 적용 2026-10-29… | ④ 축소 운영 동안 통과한 봇 수와 막힌 정상 사용자 수를 따로 세어 성능 장부에 남긴다(목표는 두지 않는다. 품질 목표 순서에서 가용성이 봇 방어보다 앞이라… | 빈칸 | A | — |
| Q-T58 | ⑤ | 봇 판정 서비스 장애 때의 축소 운영(추천 적용 2026-10-29… | ⑤ trust-svc를 되살리면 정상 판정으로 돌아온다 | 빈칸 | A | — |
| Q-T59 | ① | 예매 제한의 입장 확정 집행(소유자 결정 2026-10-30… | ① 403 `booking-restricted`이고 입장 자리·곧 입장 대기열·전진 기록에 변화가 0이다. 로비 참가·진입은 막지 않는다 | 빈칸 | A | — |
| Q-T59 | ② | 예매 제한의 입장 확정 집행(소유자 결정 2026-10-30… | ② 사본이 바뀌지 않는다(`changed` false) | 빈칸 | A | — |
| Q-T59 | ③ | 예매 제한의 입장 확정 집행(소유자 결정 2026-10-30… | ③ ADMITTED | 빈칸 | A | — |
| Q-T59 | ④ | 예매 제한의 입장 확정 집행(소유자 결정 2026-10-30… | ④ ADMITTED(끝 시각 뒤는 제한이 아니다) | 빈칸 | A | — |
| Q-T59 | ⑤ | 예매 제한의 입장 확정 집행(소유자 결정 2026-10-30… | ⑤ 10분 [가정] 안에 사본이 다시 서고, 그 뒤 입장 확정이 403이다 | 빈칸 | A | — |
| Q-T59 | ⑥ | 예매 제한의 입장 확정 집행(소유자 결정 2026-10-30… | ⑥ `PERMISSION_DENIED` | 빈칸 | A | — |
| Q-T59 | ⑦ | 예매 제한의 입장 확정 집행(소유자 결정 2026-10-30… | ⑦ 입장 확정 p99가 사본 읽기 전보다 나빠진 값을 적고, 제한된 계정의 번호가 입장 자리를 쓰지 않는다 | 빈칸 | A | — |
| Q-T60 | ① | 여정 ID 발급과 옮기기(추천 적용 2026-10-31… | ①는 서로 다른 UUIDv7이고 … 의 `ScoreRisk` `journey_id`와 `TrustVerdict.journeyId`가 토큰 값과 같고, 추가 검증… | ID만 | A | 시험: services/queue-svc/test/admission-cases.ts, services/queue-svc/test/entry-cases.ts 외 3곳 |
| Q-T60 | ② | 여정 ID 발급과 옮기기(추천 적용 2026-10-31… | ②는 서로 다른 UUIDv7이고 … 와 같다. … 의 `ScoreRisk` `journey_id`와 `TrustVerdict.journeyId`가 토큰 값과… | 자동 시험 | A | 시험: services/queue-svc/test/preverify.test.ts |
| Q-T60 | ③ | 여정 ID 발급과 옮기기(추천 적용 2026-10-31… | ③은 | 자동 시험 | A | 시험: services/queue-svc/test/preverify.test.ts |
| Q-T60 | ④ | 여정 ID 발급과 옮기기(추천 적용 2026-10-31… | ④는 서로 다른 UUIDv7이고 | 자동 시험 | A | 시험: services/queue-svc/test/preverify.test.ts |
| Q-T60 | ⑤ | 여정 ID 발급과 옮기기(추천 적용 2026-10-31… | ⑤의 대기표 `jny`는 진입에 쓴 사전 검증 토큰의 값, | ID만 | A | 시험: services/queue-svc/test/admission-cases.ts, services/queue-svc/test/entry-cases.ts 외 3곳 |
| Q-T60 | ⑥ | 여정 ID 발급과 옮기기(추천 적용 2026-10-31… | ⑥의 입장 토큰·`PurchaseSessionStarted`의 값은 대기표(로비 참가자는 참가 토큰)의 값과 같다. | ID만 | A | 시험: services/queue-svc/test/admission-cases.ts, services/queue-svc/test/entry-cases.ts 외 3곳 |
| Q-T60 | ⑦ | 여정 ID 발급과 옮기기(추천 적용 2026-10-31… | ⑦의 `QueueEntryRecord.journeyId`가 그 대기표의 값이다. `jny`만 바꾼 토큰은 서명 불일치로 거절된다. 진입 p99 차이를 성능… | ID만 | A | 시험: services/queue-svc/test/admission-cases.ts, services/queue-svc/test/entry-cases.ts 외 3곳 |
| Q-T61 | ① | 조사용 요청 기록(추천 적용 2026-10-31, ADR-0171… | ① 요청마다 `investigation.requests`에 한 줄이고 `gateway` GW_QUEUE, 맞는 routeKind, 응답 상태, 원문 IP… | 빈칸 | A | — |
| Q-T61 | ② | 조사용 요청 기록(추천 적용 2026-10-31, ADR-0171… | ② 상태 조회·결과 파일은 줄이 없다 | 빈칸 | A | — |
| Q-T61 | ③ | 조사용 요청 기록(추천 적용 2026-10-31, ADR-0171… | ③ 위조 값이 기록에 없다 | 빈칸 | A | — |
| Q-T61 | ④ | 조사용 요청 기록(추천 적용 2026-10-31, ADR-0171… | ④ 분석 저장소에 원문 IP·JA4·`journeyId`가 0건이다 | 빈칸 | A | — |
| Q-T61 | ⑤ | 조사용 요청 기록(추천 적용 2026-10-31, ADR-0171… | ⑤ 진입 p99가 수집기를 켜기 전과 같은 범위이고, 수집기 버린 줄 수를 적는다 | 빈칸 | A | — |
| Q-T62 | ① | 우선 구매 입장(추천 적용 2026-10-31, ADR-0171… | ① 200 ADMITTED와 클레임 `prio`·새 `jny`가 든 입장 토큰, 입장 자리 수는 그대로 | 빈칸 | A | — |
| Q-T62 | ② | 우선 구매 입장(추천 적용 2026-10-31, ADR-0171… | ② 모두 같은 404 `priority-grant-not-found` | 빈칸 | A | — |
| Q-T62 | ③ | 우선 구매 입장(추천 적용 2026-10-31, ADR-0171… | ③ 모두 같은 404 `priority-grant-not-found` | 빈칸 | A | — |
| Q-T62 | ④ | 우선 구매 입장(추천 적용 2026-10-31, ADR-0171… | ④ 모두 같은 404 `priority-grant-not-found` | 빈칸 | A | — |
| Q-T63 | ① | 엣지 매진 표시 켜고 끄기(추천 적용 2026-11-06… | ① 엣지 켬이 `notice`의 `SOLD_OUT` 쓰기보다 먼저다(Q-T54 ①의 차례) | 자동 시험 | A | 시험: services/queue-svc/test/edge-sale-flags.test.ts |
| Q-T63 | ② | 엣지 매진 표시 켜고 끄기(추천 적용 2026-11-06… | ② 끔이 판 번호와 함께 남는다(판매 종료도 끔) | 자동 시험 | A | 시험: services/queue-svc/test/edge-sale-flags.test.ts |
| Q-T63 | ③ | 엣지 매진 표시 켜고 끄기(추천 적용 2026-11-06… | ③ 저장된 판보다 작은 판은 엣지를 바꾸지 않고, `notice`의 지금 판으로 되돌린다. 같은 판의 다시 내기는 60초 [가정] 안에는 다시 쓰지 않는다… | 자동 시험 | A | 시험: services/queue-svc/test/edge-sale-flags.test.ts, services/queue-svc/test/sale-state-cases.ts |
| Q-T63 | ④ | 엣지 매진 표시 켜고 끄기(추천 적용 2026-11-06… | ④ 실패해도 던지지 않고 `notice`는 쓴다. 맞추지 못한 회차 수가 1이고(`want`), 다시 받은 사건이나 다시 맞추기(다른 파드로 넘어간 회차… | 자동 시험 | A | 시험: services/queue-svc/test/edge-sale-flags.test.ts, services/queue-svc/test/sale-state-cases.ts |
| Q-T63 | ⑤ | 엣지 매진 표시 켜고 끄기(추천 적용 2026-11-06… | ⑤ `sale:{회차 ID}` 키만 쓴다 | 자동 시험 | A | 시험: services/queue-svc/test/edge-sale-flags.test.ts |
| Q-T63 | ⑥ | 엣지 매진 표시 켜고 끄기(추천 적용 2026-11-06… | ⑥ 켠 동안은 엣지를 쓰지 않고(손으로 바꾼 값을 되돌리지 않음) 셈이 0이며, 끈 뒤에는 다시 맞춘다. 공백·대소문자를 무시하고 off·false·0은 멈춤… | 자동 시험 | A | 시험: services/queue-svc/test/edge-sale-flags.test.ts |
| Q-T63 | ⑦ | 엣지 매진 표시 켜고 끄기(추천 적용 2026-11-06… | ⑦ 옛 판 쓰기가 늦게 끝나도 새 판의 맞추지 못한 기록이 남고, 옛 판 쓰기의 '저장된 판이 더 큼'을 앞선 회차로 세지 않는다. 뒤 회차도 다음 주기에… | ID만 | A | 시험: services/queue-svc/test/edge-sale-flags.test.ts, services/queue-svc/test/sale-state-cases.ts |
| Q-T64 | ① | 대기 상태 파일의 좌석 수 칸(추천 적용 2026-11-06… | ① 지금 판 이상이고 셈 시각이 더 늦은 셈만 쓰고, 옛 판의 셈과 5초 [가정] 넘게 앞선 셈은 쓰지 않는다. 셈 칸의 모양만 틀린 사건은 셈 칸만 버리고… | 자동 시험 | A | 시험: services/queue-svc/test-int/sale-state.int.test.ts, services/queue-svc/test/sale-state-cases.ts 외 1곳 |
| Q-T64 | ② | 대기 상태 파일의 좌석 수 칸(추천 적용 2026-11-06… | ② 30초 안이고 5초 넘게 앞서지 않으면 `remainingSeats`와 `avgTicketsPerOrder`를 함께 싣고 아니면 둘 다 뺀다 | 자동 시험 | A | 시험: services/queue-svc/test-int/sale-state.int.test.ts, services/queue-svc/test/state-files.test.ts |
| Q-T64 | ③ | 대기 상태 파일의 좌석 수 칸(추천 적용 2026-11-06… | ③ 기본값 2 [가정]를 싣는다 | 자동 시험 | A | 시험: services/queue-svc/test/state-files.test.ts |
| Q-T64 | ④ | 대기 상태 파일의 좌석 수 칸(추천 적용 2026-11-06… | ④ 1 ~ 2^32 − 1이면 `seatmapLayoutPath`가 그 회차의 좌석맵 파일 경로이고, 없거나 틀리면(0 포함) 그 칸만 빠지며 파일은 그대로… | 자동 시험 | A | 시험: services/queue-svc/test-int/sale-state.int.test.ts, services/queue-svc/test/state-files.test.ts |
| Q-T65 | ① | 엣지 진입 함수(추천 적용 2026-11-09, ADR-0223, §4… | ① 410 `sold-out`, 원본에 보내지 않음 | ID만 | A | 시험: services/queue-svc/test/edge-entry-function.test.ts |
| Q-T65 | ② | 엣지 진입 함수(추천 적용 2026-11-09, ADR-0223, §4… | ② 그 기능만 건너뛰고 원본으로 보냄 | ID만 | A | 시험: services/queue-svc/test/edge-entry-function.test.ts |
| Q-T65 | ③ | 엣지 진입 함수(추천 적용 2026-11-09, ADR-0223, §4… | ③ 쿠키가 없거나 틀리면 503 + `Set-Cookie`(queue-svc가 받는 MAC) + 0~15초 `Retry-After`, 맞으면 원본으로 보냄 | ID만 | A | 시험: services/queue-svc/test/edge-entry-function.test.ts |
| Q-T65 | ④ | 엣지 진입 함수(추천 적용 2026-11-09, ADR-0223, §4… | ④ 서명 없이 원본으로 보냄. 원문은 10KB 이하이고 런타임이 받지 않는 문법이 없다 | ID만 | A | 시험: services/queue-svc/test/edge-entry-function.test.ts |
| Q-T65 | ⑤ | 엣지 진입 함수(추천 적용 2026-11-09, ADR-0223, §4… | ⑤ 서명 없이 원본으로 보냄. 원문은 10KB 이하이고 런타임이 받지 않는 문법이 없다 | ID만 | A | 시험: services/queue-svc/test/edge-entry-function.test.ts |
| Q-T66 | ① | 대기 상태 파일의 폴링 힌트와 S3 사본(추천 적용… | ① 구간별 1초·10초·40초 | ID만 | A | 시험: services/queue-svc/test-int/state-snapshots.int.test.ts, services/queue-svc/test/state-mirror.test.ts |
| Q-T66 | ② | 대기 상태 파일의 폴링 힌트와 S3 사본(추천 적용… | ② 0 | ID만 | A | 시험: services/queue-svc/test-int/state-snapshots.int.test.ts, services/queue-svc/test/state-mirror.test.ts |
| Q-T66 | ③ | 대기 상태 파일의 폴링 힌트와 S3 사본(추천 적용… | ③ 임박 구간 사본에 다음 생성 시각의 `Expires`가 실리고 구간별로 매초·5초·10초 주기를 지킨다 | ID만 | A | 시험: services/queue-svc/test-int/state-snapshots.int.test.ts, services/queue-svc/test/state-mirror.test.ts |
| Q-T66 | ④ | 대기 상태 파일의 폴링 힌트와 S3 사본(추천 적용… | ④ 파일 생성은 멈추지 않고 실패 수를 센다 | ID만 | A | 시험: services/queue-svc/test-int/state-snapshots.int.test.ts, services/queue-svc/test/state-mirror.test.ts |
| Q-T66 | ⑤ | 대기 상태 파일의 폴링 힌트와 S3 사본(추천 적용… | ⑤ 한 파드만 쓴다 | ID만 | A | 시험: services/queue-svc/test-int/state-snapshots.int.test.ts, services/queue-svc/test/state-mirror.test.ts |
| Q-T67 | ① | 안전 한계·결제사 상한·합산 상한과 나누기(추천 적용… | ① 하한·상한 안으로 깎인다 | ID만 | A | 시험: services/admission-ctrl/test-int/leader-store.int.test.ts, services/admission-ctrl/test-sim/admission-loop.sim.test… |
| Q-T67 | ② | 안전 한계·결제사 상한·합산 상한과 나누기(추천 적용… | ② 300 TPS는 8,000명·초당 300번호, 50 TPS는 4,500명·초당 50번호이고 하한은 1,000명이다. 낮추면 다음 주기에 바로 줄고… | ID만 | A | 시험: services/admission-ctrl/test-int/leader-store.int.test.ts, services/admission-ctrl/test-sim/admission-loop.sim.test… |
| Q-T67 | ③ | 안전 한계·결제사 상한·합산 상한과 나누기(추천 적용… | ③ 같은 결제사 회차의 전진 속도 합과 목표 합이 그 결제사 상한 안이다 | ID만 | A | 시험: services/admission-ctrl/test-int/leader-store.int.test.ts, services/admission-ctrl/test-sim/admission-loop.sim.test… |
| Q-T67 | ④ | 안전 한계·결제사 상한·합산 상한과 나누기(추천 적용… | ④ 목표 합이 합산 상한 안이고 줄 선 사람이 없는 회차와 매진 회차가 대형 회차의 몫을 줄이지 않으며, 합산 나누기는 AIMD 목표를 바꾸지 않고(나누기가… | ID만 | A | 시험: services/admission-ctrl/test-int/leader-store.int.test.ts, services/admission-ctrl/test-sim/admission-loop.sim.test… |
| Q-T67 | ⑤ | 안전 한계·결제사 상한·합산 상한과 나누기(추천 적용… | ⑤ 위반 수가 1이고 막지는 않는다 | ID만 | A | 시험: services/admission-ctrl/test-int/leader-store.int.test.ts, services/admission-ctrl/test-sim/admission-loop.sim.test… |
| Q-T68 | ① | 대기 취소·로비 참가 취소와 다른 기기에서 다시 참가(추천 적용… | ① 204이고 목록·`verify`·`q:dup`에서 빠지며 다시 참가하면 새 토큰이다. 옛 토큰의 입장 확정은 403이다 | 자동 시험 | A | 시험: services/queue-svc/test-int/admission-store.int.test.ts, services/queue-svc/test/leave-cases.ts 외 1곳 |
| Q-T68 | ② | 대기 취소·로비 참가 취소와 다른 기기에서 다시 참가(추천 적용… | ② 409이고 목록이 그대로다. 대기 취소는 204이고 게시 뒤 그 번호가 빠진 번호다 | 자동 시험 | A | 시험: services/admission-ctrl/test/publish.test.ts, services/queue-svc/test-int/admission-store.int.test.ts 외 1곳 |
| Q-T68 | ③ | 대기 취소·로비 참가 취소와 다른 기기에서 다시 참가(추천 적용… | ③ 번호가 빠진 번호이고 곧 입장 대기열과 `verify` 칸에서 빠지며 다시 진입하면 맨 뒤 번호다. 옛 대기표의 입장 확정은 410… | 자동 시험 | A | 시험: services/queue-svc/test-int/admission-store.int.test.ts, services/queue-svc/test/leave-cases.ts 외 1곳 |
| Q-T68 | ④ | 대기 취소·로비 참가 취소와 다른 기기에서 다시 참가(추천 적용… | ④ 닫히기 전이면 묶음 크기가 줄고, 닫힌 뒤면 게시 때 빠진 번호, 게시 뒤면 바로 빠진 번호다 | 자동 시험 | A | 시험: services/admission-ctrl/test-int/batch-store.int.test.ts, services/admission-ctrl/test/publish.test.ts 외 2곳 |
| Q-T68 | ⑤ | 대기 취소·로비 참가 취소와 다른 기기에서 다시 참가(추천 적용… | ⑤ 두 키 모두 지워진다 | 자동 시험 | A | 시험: services/queue-svc/test/leave-cases.ts |
| Q-T68 | ⑥ | 대기 취소·로비 참가 취소와 다른 기기에서 다시 참가(추천 적용… | ⑥ 대기 취소는 204이고 아무것도 바뀌지 않으며, 로비 참가 취소는 404다 | 자동 시험 | A | 시험: services/queue-svc/test/leave-cases.ts, services/queue-svc/test/leave-http.test.ts |
| Q-T68 | ⑦ | 대기 취소·로비 참가 취소와 다른 기기에서 다시 참가(추천 적용… | ⑦ 어떤 순서로 겹쳐도 그 번호는 빠진 번호다 | 자동 시험 | A | 시험: services/admission-ctrl/test-int/batch-store.int.test.ts, services/admission-ctrl/test/publish.test.ts 외 1곳 |
| Q-T68 | ⑧ | 대기 취소·로비 참가 취소와 다른 기기에서 다시 참가(추천 적용… | ⑧ 503이고 다시 보내면 끝난다 | 자동 시험 | A | 시험: services/queue-svc/test/leave-cases.ts |
| Q-T68 | ⑨ | 대기 취소·로비 참가 취소와 다른 기기에서 다시 참가(추천 적용… | ⑨ 다른 사람의 기록과 새 기록은 그대로이고 추가 검증 표시가 되살아나지 않는다 | 자동 시험 | A | 시험: services/queue-svc/test/leave-cases.ts |
| Q-T68 | ⑩ | 대기 취소·로비 참가 취소와 다른 기기에서 다시 참가(추천 적용… | ⑩ 새 번호 없이 410 `queue-ticket-removed`이고 화면은 '다른 기기에서 취소'다. 다른 기기가 다시 참가한 뒤면 409다. 원래 칸의… | 자동 시험 | A | 시험: apps/web/queue-room/test/controller.test.mjs, services/queue-svc/test/leave-cases.ts 외 1곳 |

## docs/security/asvs/queue-admission.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| v5.0.0-3.2.1 | — | L1 | API 응답·사용자가 올린 파일 등이 잘못된 문맥(HTML 등)으로 그려지지 않게 한다(`Sec-Fetch-*`, CSP sandbox… | 자동 시험 | B | 시험: services/admission-ctrl/test/result-files.test.ts, services/queue-svc/test/sale-state.test.ts 외 2곳 |
| v5.0.0-3.2.2 | — | L1 | HTML이 아니라 글로 보일 내용은 `textContent` 같은 안전한 렌더링 함수로 다룬다. | 자동 시험 | B | 시험: apps/web/src/_pages/queue-verify/model/verify-flow.test.mjs, apps/web/src/_pages/queue-verify/model/view.test.mjs 외… |
| v5.0.0-3.3.1 | — | L1 | 쿠키에 `Secure`를 두고, `__Host-`를 쓰지 않으면 이름에 `__Secure-` 접두사를 붙인다. | 자동 시험 | B | 시험: services/queue-svc/test/edge-entry-function.test.ts, services/queue-svc/test/edge-first-visit-function.test.ts |
| v5.0.0-3.3.2 | — | L2 | 쿠키마다 목적에 맞는 `SameSite`를 둬 CSRF 같은 공격 노출을 줄인다. | 자동 시험 | B | 시험: services/queue-svc/test/edge-first-visit-function.test.ts |
| v5.0.0-3.3.3 | — | L2 | 다른 호스트와 공유하도록 설계한 쿠키가 아니면 이름에 `__Host-` 접두사를 쓴다. | 자동 시험 | B | 시험: services/queue-svc/test/edge-first-visit-function.test.ts |
| v5.0.0-3.3.4 | — | L2 | 스크립트가 읽을 필요 없는 쿠키(세션 토큰 등)는 `HttpOnly`이고 그 값은 `Set-Cookie`로만 보낸다. | 자동 시험 | B | 시험: services/queue-svc/test/edge-first-visit-function.test.ts, services/queue-svc/test/first-visit-cookie.test.ts |
| v5.0.0-3.4.1 | — | L1 | 모든 응답에 HSTS를 둔다(최대 기간 1년 이상, L2부터 하위 도메인 포함). | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-http-rules.test.ts, services/v0-monolith/test/gateway-server.test.ts (영역:… |
| v5.0.0-3.4.2 | — | L1 | CORS `Access-Control-Allow-Origin`은 고정 값으로 두거나 요청의 `Origin`을 신뢰 출처 허용 목록과 대조해 정하고, `*`을… | 자동 시험 | B | 시험: services/queue-svc/test/state-http.test.ts |
| v5.0.0-3.4.3 | — | L2 | HTTP 응답에 CSP를 둬 브라우저가 신뢰한 콘텐츠·자원만 싣고 실행하게 하고, 최소한 `object-src 'none'`·`base-uri 'none'`과… | 자동 시험 | B | 시험: apps/web/server/csp-hash-server.test.mjs, apps/web/src/_app/security/page-headers.test.mjs 외 1곳 |
| v5.0.0-3.4.4 | — | L2 | 모든 응답에 `X-Content-Type-Options: nosniff`를 둔다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test-int/seat.int.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 1곳 (영역:… |
| v5.0.0-3.4.5 | — | L2 | 리퍼러 정책을 둬 URL 경로·쿼리 같은 기술적 민감 데이터가 `Referer` 헤더로 제3자 서비스에 새지 않게 한다. | ID만 | B | 다른 곳 시험: packages/config/headers/headers.test.mjs (영역: apps/web) |
| v5.0.0-3.4.6 | — | L2 | 모든 HTTP 응답에 CSP `frame-ancestors`를 둬 기본적으로 끼워 넣을 수 없게 하고, 필요한 자원만 끼워 넣기를… | 자동 시험 | B | 시험: apps/web/src/_app/security/page-headers.test.mjs |
| v5.0.0-3.5.1 | — | L1 | CORS 사전 요청에 기대지 않는다면 민감 기능 요청이 애플리케이션에서 왔는지 확인한다(위조 방지 토큰, safelisted가 아닌 헤더 요구 등). | 자동 시험 | B | 시험: apps/web/scripts/local-fan-gateway.test.mjs, apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.5.2 | — | L1 | CORS 사전 요청에 기댄다면 사전 요청을 일으키지 않는 요청으로 그 기능을 부를 수 없게 한다(`Origin`·`Content-Type` 확인 등). | 자동 시험 | B | 시험: services/queue-svc/test/admission.test.ts, services/queue-svc/test/http.test.ts 외 2곳 |
| v5.0.0-3.5.3 | — | L1 | 민감 기능은 GET·HEAD·OPTIONS 같은 안전 메서드가 아닌 POST·PUT·PATCH·DELETE 같은 메서드로 부르거나, `Sec-Fetch-*`… | 자동 시험 | B | 시험: services/queue-svc/test/leave-http.test.ts, services/queue-svc/test/shuffle-proof.test.ts 외 1곳 |
| v5.0.0-3.5.4 | — | L2 | 서로 다른 애플리케이션을 다른 호스트 이름에 둬 동일 출처 정책의 제한을 쓴다. | 빈칸 | B | 영역: apps/web, packages/shuffle, services/admission-ctrl, services/queue-svc, tools/edge |
| v5.0.0-3.5.5 | — | L2 | `postMessage`로 받은 메시지는 출처를 믿을 수 없거나 형식이 틀리면 버린다. | 자동 시험 | B | 시험: apps/web/src/features/identity-verify/flow.test.mjs |
| v5.0.0-3.7.1 | — | L2 | 지원이 끝났거나 안전하지 않은 클라이언트 기술(플러그인, Flash 등)을 쓰지 않는다. | 빈칸 | B | 영역: apps/web, packages/shuffle, services/admission-ctrl, services/queue-svc, tools/edge |
| v5.0.0-3.7.2 | — | L2 | 애플리케이션이 통제하지 않는 다른 호스트로 자동 이동시킬 때는 허용 목록에 있는 곳으로만 보낸다. | 자동 시험 | B | 시험: apps/web/queue-room/test/verify-return.test.mjs, apps/web/src/_pages/login/model/state.test.mjs 외 4곳 |
| v5.0.0-9.1.1 | — | L1 | 자체 완결형 토큰은 서명이나 MAC을 검증한 뒤에만 내용을 받아들인다. | 자동 시험 | B | 시험: services/purchase-svc/test-int/purchase-session.int.test.ts, services/purchase-svc/test/admission-token.test.ts 외… |
| v5.0.0-9.1.2 | — | L1 | 자체 완결형 토큰의 생성·검증에는 맥락별 허용 목록의 알고리즘만 쓰고(`none` 제외, 되도록 대칭·비대칭 중 한쪽만), 둘 다 써야 하면 키 혼동을 막는… | 자동 시험 | B | 시험: services/purchase-svc/test/admission-token.test.ts |
| v5.0.0-9.1.3 | — | L1 | 검증 키는 미리 정한 신뢰 출처에서만 얻고 `jku`·`x5u`·`jwk` 헤더를 허용 목록으로 검증한다. | 자동 시험 | B | 시험: services/purchase-svc/test/admission-token.test.ts, services/queue-svc/test/tokens.test.ts |
| v5.0.0-9.2.1 | — | L1 | 유효 기간이 있으면 검증 시각이 그 안일 때만 받는다(`nbf`·`exp`). | 자동 시험 | B | 시험: services/purchase-svc/test-int/purchase-session.int.test.ts, services/purchase-svc/test/admission-token.test.ts 외 5곳 |
| v5.0.0-9.2.2 | — | L2 | 토큰 종류와 목적이 맞는지 확인한 뒤 받는다. | 자동 시험 | B | 시험: services/purchase-svc/test/admission-token.test.ts |
| v5.0.0-9.2.3 | — | L2 | 그 서비스를 위한 토큰(`aud`)만 받는다. | 자동 시험 | B | 시험: services/purchase-svc/test/admission-token.test.ts, services/queue-svc/test/entry-cases.ts |
| v5.0.0-9.2.4 | — | L2 | 같은 개인 키로 여러 대상에 토큰을 발급하면 대상을 고유하게 나타내는 대상 제한을 넣고, 대상 식별자를 동적으로 정하면 발급자가 그 대상을 검증해 대상 사칭을… | ID만 | B | 다른 곳 시험: packages/platform/test/token-verify.test.ts (영역: apps/web, packages/shuffle, services/admission-ctrl… |
| v5.0.0-11.1.1 | — | L2 | NIST SP 800-57 같은 키 관리 표준을 따르는 키 관리 정책과 키 수명 주기를 문서로 두고, 키를 필요 이상의 주체와 공유하지 않는다(공유 비밀은 두… | 빈칸 | B | 영역: services/queue-svc |
| v5.0.0-11.1.2 | — | L2 | 애플리케이션이 쓰는 모든 암호 키·알고리즘·인증서의 암호 목록을 만들어 정기적으로 갱신하고, 키마다 쓸 수 있는 곳과 없는 곳, 보호할 수 있는 데이터와 없는… | 빈칸 | B | 영역: apps/web, packages/shuffle, services/admission-ctrl, services/queue-svc, tools/edge |
| v5.0.0-11.2.1 | — | L2 | 업계에서 검증된 암호 구현(라이브러리, 하드웨어 가속 구현)을 쓴다. | 자동 시험 | B | 시험: services/admission-ctrl/test/quicknet-verifier.test.ts |
| v5.0.0-11.2.2 | — | L2 | 난수·인증 암호화·MAC·해시 알고리즘, 키 길이, 라운드, 암호와 운용 모드를 언제든 바꿀 수 있고 키·비밀번호 교체와 데이터 재암호화도 할 수 있게… | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts (영역: apps/web, packages/shuffle, services/admission-ctrl… |
| v5.0.0-11.2.3 | — | L2 | 모든 암호 기본 요소가 최소 128비트 보안 강도를 갖는다. | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, services/payment-svc/test/portone-gateway.test.ts (영역:… |
| v5.0.0-11.3.1 | — | L1 | ECB 같은 안전하지 않은 블록 모드와 PKCS#1 v1.5 같은 약한 패딩을 쓰지 않는다. | ID만 | B | 다른 곳 시험: services/payment-svc/test/virtual-account-deposit.test.ts (영역: apps/web, packages/shuffle… |
| v5.0.0-11.3.2 | — | L1 | AES-GCM처럼 승인된 암호와 운용 모드만 쓴다. | 자동 시험 | B | 시험: packages/shuffle/test/drand-seal.test.ts, services/admission-ctrl/test/kms-seed-opener.test.ts 외 1곳 |
| v5.0.0-11.3.3 | — | L2 | 암호화한 데이터를 인증 암호화(또는 승인된 암호와 MAC의 조합)로 무단 변경에서 보호한다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/payment-deposit.int.test.ts, services/payment-svc/test/virtual-account-deposit.te… |
| v5.0.0-11.4.1 | — | L1 | 서명·HMAC·KDF·난수 생성 등 일반 암호 용도에는 승인된 해시 함수만 쓰고 MD5 같은 금지 함수는 쓰지 않는다. | 자동 시험 | B | 시험: packages/shuffle/test/shuffle.test.ts |
| v5.0.0-11.4.2 | — | L2 | 비밀번호는 현재 권고 파라미터를 적용한 승인된 비밀번호 해시 함수로 저장한다. | 해당 없음 | B | 해당 없음: 이 기능에는 비밀번호가 없다 |
| v5.0.0-11.4.3 | — | L2 | 서명·데이터 인증·무결성에 쓰는 해시는 충돌 저항성과 알맞은 출력 길이를 갖추고, 출력은 충돌 저항이 필요하면 256비트 이상, 제2 역상 저항만 필요하면… | 자동 시험 | B | 시험: packages/shuffle/test/shuffle.test.ts |
| v5.0.0-11.4.4 | — | L2 | 비밀번호에서 비밀 키를 만들 때 키 스트레칭 파라미터가 있는 승인된 KDF를 쓰고, 그 파라미터는 무차별 대입으로 키가 뚫리지 않게 보안과 성능을 맞춰 정한다. | 해당 없음 | B | 해당 없음: 비밀번호에서 키를 만들지 않는다. 구매 세션 키는 ECDH 공유 비밀에서 HKDF로 만든다 |
| v5.0.0-11.5.1 | — | L2 | 추측되면 안 되는 모든 난수와 문자열은 CSPRNG로 만들고 128비트 이상의 엔트로피를 갖는다(UUID는 이 조건을 만족하지 않는다). | 자동 시험 | B | 시험: services/queue-svc/test/commit-worker.test.ts |
| v5.0.0-11.6.1 | — | L2 | 키 생성·시드 생성과 디지털 서명 생성·검증에는 승인된 알고리즘과 운용 모드만 쓰고, 알려진 공격에 약한 키(페르마 인수분해에 약한 RSA 키 등)를 만들지… | 자동 시험 | B | 시험: services/admission-ctrl/test-int/kms-seed.int.test.ts, services/admission-ctrl/test/quicknet-verifier.test.ts 외 3곳 |
| v5.0.0-12.1.1 | — | L1 | TLS 1.2와 1.3처럼 권장되는 최신 버전만 켜고 가장 최신 버전을 우선한다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-server.test.ts (영역: apps/web, packages/shuffle, services/admission-ctrl… |
| v5.0.0-12.1.2 | — | L2 | 권장 암호 스위트만 켜고 가장 강한 스위트를 우선하며, L3는 순방향 비밀성을 주는 스위트만 지원한다. | 빈칸 | B | 영역: apps/web, packages/shuffle, services/admission-ctrl, services/queue-svc, tools/edge |
| v5.0.0-12.1.3 | — | L2 | mTLS 클라이언트 인증서가 신뢰된 것인지 확인한 뒤에만 그 신원으로 인증·인가한다. | 다른 단계 | B | 운영 확인 · 구현 위치가 '(운영 설계만)'이다 |
| v5.0.0-12.2.1 | — | L1 | 클라이언트와 외부에 노출된 HTTP 서비스 사이의 모든 연결에 TLS를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-server.test.ts 외 1곳 (영역:… |
| v5.0.0-12.2.2 | — | L1 | 외부에 노출된 서비스는 공인 TLS 인증서를 쓴다. | 빈칸 | B | 영역: apps/web, packages/shuffle, services/admission-ctrl, services/queue-svc, tools/edge |
| v5.0.0-12.3.1 | — | L2 | 애플리케이션에 들어오고 나가는 모든 연결(모니터링·관리 도구, 원격 접속, 미들웨어, DB, 파트너 시스템, 외부 API 등)에 TLS 같은 암호화 프로토콜을… | ID만 | B | 다른 곳 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts (영역: apps/web… |
| v5.0.0-12.3.2 | — | L2 | TLS 클라이언트가 서버 인증서를 검증한 뒤 통신한다. | 빈칸 | B | 영역: services/admission-ctrl |
| v5.0.0-12.3.3 | — | L2 | 애플리케이션 안 내부 HTTP 서비스 사이의 모든 연결에 TLS 같은 전송 암호화를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | 다른 단계 | B | 운영 확인 · 구현 위치가 '(운영 설계만)'이다 |
| v5.0.0-12.3.4 | — | L2 | 내부 서비스 사이 TLS는 신뢰한 인증서를 쓰고, 내부 발급·자체 서명 인증서를 쓰면 받는 서비스가 지정한 내부 CA와 지정한 자체 서명 인증서만 신뢰하게 한다. | 다른 단계 | B | 운영 확인 · 구현 위치가 '(운영 설계만)'이다 |
| v5.0.0-13.2.2 | — | L2 | 백엔드 통신을 최소 권한 계정으로 한다. | ID만 | B | 다른 곳 시험: loadtest/test/manifests090.test.mjs, loadtest/test/review060.test.mjs 외 9곳 (영역: services/admission-ctrl) |
| v5.0.0-13.3.1 | — | L2 | 키 보관소 같은 비밀 관리 도구로 백엔드 비밀을 안전하게 만들고 저장·접근 통제·폐기하며, 소스 코드와 빌드 산출물에 비밀을 넣지 않고, L3는 HSM 같은… | 자동 시험 | B | 시험: services/queue-svc/test/first-visit-cookie.test.ts |
| v5.0.0-13.3.2 | — | L2 | 비밀 자산 접근은 최소 권한 원칙을 따른다. | 자동 시험 | B | 시험: services/admission-ctrl/test/kms-seed-opener.test.ts, services/admission-ctrl/test/seed-reveal.test.ts 외 5곳 |
| v5.0.0-2.3.2 | — | L2 | 문서화된 업무 로직 한도를 구현해 악용을 막는다. | 자동 시험 | B | 시험: services/admission-ctrl/test/admission-leader.test.ts, services/admission-ctrl/test/aimd.test.ts 외 11곳 |
| v5.0.0-16.5.2 | — | L2 | 외부 자원 접근이 실패해도 안전하게 동작한다. | 자동 시험 | B | 시험: services/admission-ctrl/test-int/batch-store.int.test.ts, services/admission-ctrl/test/admission-leader.test.ts 외… |
| v5.0.0-14.3.1 | — | L1 | 클라이언트나 세션이 끝나면 브라우저 DOM 같은 클라이언트 저장소에서 인증 뒤 받은 데이터를 지우고, 서버에 연결되지 않을 때도 클라이언트가 스스로 지울 수… | 빈칸 | B | 영역: apps/web, packages/shuffle, services/admission-ctrl, services/queue-svc, tools/edge |
| v5.0.0-14.3.2 | — | L2 | 민감 데이터가 브라우저에 캐시되지 않게 `Cache-Control: no-store` 등 캐시 방지 헤더를 둔다. | 자동 시험 | B | 시험: services/queue-svc/test/admission.test.ts, services/queue-svc/test/shuffle-proof.test.ts 외 2곳 |
| v5.0.0-14.3.3 | — | L2 | 브라우저 저장소(localStorage, sessionStorage, IndexedDB, 쿠키)에 세션 토큰 말고는 민감 데이터를 두지 않는다. | 빈칸 | B | 영역: apps/web, packages/shuffle, services/admission-ctrl, services/queue-svc, tools/edge |
| v5.0.0-11.2.4 | — | L3 | 모든 암호 연산을 상수 시간으로 하고 비교·계산·반환에서 조기 종료하지 않아 정보가 새지 않게 한다. | 자동 시험 | B | 시험: services/queue-svc/test/arrival-cookie.test.ts |
| v5.0.0-15.4.2 | — | L3 | 자원 상태 확인과 그 상태에 따른 동작을 원자적으로 해서 확인 시점과 사용 시점의 경합(TOCTOU)을 막는다. | 자동 시험 | B | 시험: services/admission-ctrl/test-int/batch-store.int.test.ts, services/admission-ctrl/test-int/leader-store.int.test.ts… |
