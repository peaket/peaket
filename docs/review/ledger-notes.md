# 완성 장부 손 기록(notes)

- 무엇: 완성 장부(`tools/ci/ledger.mjs`, ADR-0256 결정 2, docs/architecture.md §8.6)가 시험 이름으로 정하지 못하는 상태와, 원천 문서로 정한 등급을 바꿀 항목을 사람이 적는 곳이다. 장부 결과는 `docs/review/ledger/README.md`와 같은 폴더의 분야별 파일에 있다. 이 파일을 고친 뒤 `node tools/ci/ledger.mjs`로 장부를 다시 쓴다.
- 표 머리는 `| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |`이다. 이 머리를 단 표라면 몇 개로 나눠 적어도 모두 읽는다.
  - **항목**: `S-T23 ⑥`(세부 하나. `S-T23 ①~③`·`S-T23 ⑤⑥`처럼 여럿도 된다), `S-T23`(그 ID의 세부 전부), `NFR-007`, `v5.0.0-1.2.4`(그 ID의 ASVS 행 모두), `payment:v5.0.0-1.2.4`(ASVS 문서 하나의 행). 세부 행이 ID 행보다 앞선다.
  - **상태**: 측정, 사람 확인, 미검증, 다른 단계, 없앰, 해당 없음 가운데 하나. 비우면 등급만 바꾼다. 자동 시험과 ID만은 시험 이름으로만 정하므로 여기에 적지 못한다.
  - **등급**: A(돈, 좌석, 대기 순번, 권한, 개인정보, 법정 의무, 장애 복구), B(일반 기능, 화면, 운영), C(문구, 배치, 문서). 비우면 원천 문서로 정한 기본 등급(`tools/ci/ledger.mjs`의 `GRADE_BY_DOC`)이다.
  - **정할 곳**: 그 항목을 판정할 단계·묶음·측정 ID. '구간 측정'은 구간의 측정 창, '미정'은 `docs/BUILD_ORDER.md`에 그 ID를 단 단계·묶음이 아직 없다는 뜻이다.
  - **근거·사유**: 미검증은 사유가 꼭 있어야 한다(없으면 장부가 오류로 멈춘다).
- 처음 채운 곳(2026-11-10): 시범 묶음의 시험 범위 표(`docs/review/pilot-purchase-path-coverage.md`)의 측정 몫·다른 단계 몫·사람 확인·일부 자동 행. 그 밖의 항목은 시험 이름으로 정해진 지금 상태 그대로 두었다.

## 측정

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| V-T26 | 측정 |  | 미정 | 새 상품 유형 추가 리드타임은 셋째 유형(VIP)을 더하는 PR의 첫 커밋부터 데모 배포까지를 잰다. BAT-600은 기본 유형 둘(`MERCH`·`PARKING`)만 만들고(ADR-0300 결정 1), 셋째 유형 PR과 데모 배포 단계가 BUILD_ORDER에 아직 없다. 유형 검사와 속성 검증 잡의 동작은 V-T46이 시험한다 |
| Q-T2 | 측정 |  | HOT-460 | PRF-220 v1 합본 K1 1천·1만 측정(2026-11-11-k1-v1-local-1k-r1~r3·10k-r1~r3). 1천은 entry p99가 한 번 39/1000 위반, 1만은 진입 p99 132~250/10000·실패 43~141건으로 목표 미달. 10만·외삽·비례 효율은 HOT-460 |
| Q-T5 | 측정 |  | PRF-220 | `numberbatch` TLS 켬 3·끔 1(2026-11-11-numberbatch-tls-r1~r3·notls-r1). 켬 p99 4.308·4.308·4.265ms, 끔 4.181ms, valid. 판정 기준 200ms 통과 |
| SR-T13 ① | 측정 |  | BAT-167 | 오픈 직전 몰림·무작위 입력에서 검색·자동완성 원본 p95와 검색 전용 연결 묶음 대기·503을 로컬 k6로 잰다(ADR-0271 결정 5, 계획 docs/review/plans/BAT-165.md 웨이브 7). 결과 docs/review/measurements/BAT-165-sr-t13-search.md: 미달(2026-11-16 M-1, 공연 1만·2만, 검색 503 65~84%·성공한 검색 서버 p95 0.9~1.7초, 자동완성 받는 쪽 p95 0.5~1초). BAT-166 다시 재기(docs/review/measurements/BAT-166-sr-t13-search.md, 2026-11-19, R-695): 공연 1만 통과, 2만 미달(다시 재기 2의 3회 중 1회 무작위 검색 p95 328ms, 1회 299ms 경계. 503·게이지·자동완성은 기준 안). 남은 몫은 BAT-167에서 같은 무대로 다시 잰다 |
| SR-T13 ② | 측정 |  | BAT-056 | BAT-056 측정 창에서 gw-fan 검색 IP 한도를 클러스터 안 k6로 잼(2026-11-18, 성능 장부 `2026-11-18-bat056-ms-ip-single`·`-many`·`-mixed`·`-v6-64`). 통과: 한 IP 통과 3,000·3,001건 ≤ 상한 3,050, 넘은 요청 모두 429와 `Retry-After`, 서로 다른 IP 1,000개·2만 개는 429 0건. IPv6 /64 안 주소 100개는 429 0건(관찰, W7-CON-05 근거). 결과 docs/review/measurements/BAT-056-gateway-breaker.md §8. 한도 설정을 보는 kind 시험 `SR-T13 ②`(tools/local/e2e/gateways.e2e.mjs)는 BAT-055·BAT-060에서 통과 |
| V-T43 ① | 측정 |  | BAT-056, BAT-058 | 정상 부하 503 0건을 kind에서 스윕으로 잼(2026-11-18, 성능 장부 `2026-11-18-bat056-ma-*`·`-mb-*`). 통과: 고른 동시·연결 128·보류 16에서 3회, 운영 첫 값 2,400·300에서 1회 모두 503 0건·Envoy 넘침 0. 잰 포화 처리량(vCPU 하나 2,600/s)·k(10.6, Envoy 일꾼 32의 고정 몫)가 첫 값의 입력과 달랐다. 결과 docs/review/measurements/BAT-056-gateway-breaker.md. BAT-058 첫 측정(2026-11-19, 일꾼 2·프록시 CPU 요청 100m 무대, 성능 장부 `2026-11-19-bat058-aa*`·`-ma-*`·`-ops-*`·`-mw-*`): r_min 64 3회 통과·k 5.0, 그 값으로 셈한 gw-queue 3,120·390에서 정상 부하 503 0건·넘침 0, 일꾼 수를 지운 틀린 판은 실패. 셈한 값(나머지 넷 7,800·975 포함)은 적용 보류다(감독 결정, 리뷰 RV-01·RV-02). 진단 측정(2026-11-19, gw-queue만 CPU 요청 2, 성능 장부 `2026-11-19-bat058-dx-*`)이 A/A 0.06%·일꾼 2·r_min 48 3회 통과(32와 40 한 번 실패)·k 3.9로 결정 규칙을 채워 운영 값을 gw-queue 2,434·305, 나머지 넷 6,084·761로 정했다. 결과 docs/review/measurements/BAT-058-gateway-workers.md |
| V-T43 ② | 측정 |  | BAT-056, BAT-058 | 과부하(진입 지연 500·100·50ms 고정, 각 3회)를 kind에서 잼(2026-11-18, 성능 장부 `2026-11-18-bat056-mc-*`). 통과: 9단계 모두 게이트웨이 503 p99 0.83~1.42ms ≤ 3ms, 503 모두 `Retry-After: 2`·Problem, 처리 중 최대 ≤ 상한, 결과 파일과 장부 판정이 같음(리뷰 N1 대조). 결과 docs/review/measurements/BAT-056-gateway-breaker.md. BAT-058 첫 측정(2026-11-19, 일꾼 2 무대, r_pc 66, 성능 장부 `2026-11-19-bat058-mc-d500-*`·`-mc-d50-*`): 진입 지연 500·50ms 각 1회 503 p99 2.02·1.54ms, 503 모두 `Retry-After: 2`·Problem, 처리 중 최대 66 ≤ 66, 결과 파일과 장부 판정 같음(그 r_pc를 낸 잰 값은 적용 보류). 진단 측정이 정한 운영 값(r_pc 49)에서 ②는 진단 차례 밖이라 다시 재지 않았다. 결과 docs/review/measurements/BAT-058-gateway-workers.md |
| V-T44 | 측정 |  | BAT-056 | 문서 인용: Istio 1.24 공식 성능 문서(https://istio.io/latest/docs/ops/deployment/performance-and-scalability/, 그림 `istio-1.24.0-fortio-99.png`, 2026-11-18 구현·검증 담당이 대조), 웨이포인트 p99 증가 0.407~0.573ms ≤ 2ms라 앰비언트를 쓴다. 결과는 docs/verification.md V-T44 행 끝 |
| S-T1 | 측정 |  | PRF-220 | 1개 좌석 1,000명 동시 경합. v1 K2 TLS 켬 3·끔 1(2026-11-11-k2-v1-hot-tls-r1~r3·notls-r1)은 발생기 놓침 920~1,504로 모두 무효, p99 271~318ms·서버 p99 250~270ms로 목표(50ms) 미달. 서비스 분리 뒤 HOT-460에서 다시 잰다 |
| S-T8 | 측정 |  | PRF-140 | Hard Sale 최종 경합. 판정이 부하 수치다 |
| S-T9 | 측정 |  | 구간 측정 | Redis 주 노드 장애 복구 |
| S-T10 | 측정 |  | PRF-140 | 교착 방지와 DB 튜닝. 판정이 부하 수치다 |
| S-T11 | 측정 |  | PRF-140 | 트랜잭션 격리 수준 비교. 판정이 부하 수치다 |
| S-T12 ① | 측정 |  | BAT-095 | 실시간 전파 대역폭과 지연의 판정 측정(연결 5,000개, `tc netem`). 2026-11-18 HOT-090(BAT-052)에서 옮김(전체 감독 결정). ②(지표)는 BAT-052 시험 |
| S-T14 ④ | 측정 |  | BAT-095 | 실시간 전파 Degraded Mode의 완화 SLO p99 1.5초와 초과 판매 0건(측정 창 2). ①~③(자동 전환)은 BAT-053(HOT-091) 시험이다(2026-11-19 계획, ADR-0298). 2026-11-19 전체 감독 결정으로 BAT-095에 둠 |
| S-T15 | 측정 |  | 구간 측정 | 대규모 좌석맵 그리기 성능 |
| S-T16 ② | 측정 |  | BAT-090 heavy gate | 탈취 거부(서명 변조·재전송·다른 세션 키)는 `services/purchase-svc/test/purchase-session-theft.test.ts`가 본다. 정상 요청 확인 p99 1ms는 2026-11-13 3회 반복 중앙값 전체 9.7101ms·Redis 제외 3.8070ms·MAC만 1.1281ms로 **미달**(보고서 §4) |
| S-T23 ⑥ | 측정 |  | 구간 측정 | 옮기기·되돌리기 Lua 200개가 이 PC에서 p50 1.6ms·p99 2.0ms로 1ms [가정]을 넘었다(docs/review/pilot-purchase-path-perf.md). 다시 여는 동안의 홀드 p99 50ms는 아직 못 쟀다. ①~⑤는 자동 시험이다 |
| S-T27 | 측정 |  | 구간 측정 | 좌석 샤드 하나의 처리량 상한. 판정이 부하 수치다 |
| S-T35 ⑥ | 측정 |  | PRF-220 | `lua-compare` A/A p50 ±2.1~6.7%·p99 ±4.6~15.9%. `end-session` p50 1.583/1.769, `order-hold` p99 1.216로 A/A 폭을 넘어 S-T35 ⑥는 보류 |
| P-T1 | 측정 |  | HOT-470 | K7 카오스 장애 주입 1만 건. v1 K7 ② 2026-11-11-k7-v1-fault-r1·r2는 발생기 놓침 1,068·1,157, 시나리오 오류 179·199로 무효. P1~P4·P6·S1·S4는 PASS, P3은 새 시작 시각으로 PASS. ticket-svc 5분 중단·이중 발권·일일 대사 불일치는 HOT-160·HOT-480 뒤 HOT-470 |
| P-T4 | 측정 |  | 구간 측정 | 결제 접수 p99 |
| P-T5 | 측정 |  | 구간 측정 | 결제 최종 확정 p99 |
| P-T11 | 측정 |  | 구간 측정 | Degraded 결제 모드 |
| P-T22 | 측정 |  | 구간 측정 | PG 한도 추정 모델 |
| P-T31 | 측정 |  | 구간 측정 | 결제사 전환 훈련과 결제사별 동시 입장 목표 상한 |
| FE-T10 | 측정 |  | LCH-200 | 좌석맵 성능과 네트워크(측정 캠페인) |
| FE-T33 | 측정 |  | LCH-200 | 좌석맵 에디터 편집 캔버스(Konva)의 끌기·돌리기 프레임과 INP(측정 캠페인 wbs 7.5.2). BAT-150(HOT-220)은 같은 조작을 로컬에서 한 번 재어 커밋 본문에 적고, 결과를 남기는 판정은 측정 창에서 한다 |
| FE-T32 | 측정 |  | 구간 측정 | 시범 범위 표의 분류(차례 반영 측정)를 옮겼다. 판정 ①~④는 가짜 시계로 도는 PR 시험으로도 볼 수 있어, 이 영역을 고치는 묶음에서 다시 본다 |
| V-T6 | 측정 |  | 구간 측정 | G-02 대체 장애(로컬 좌석 Redis 주 노드 강제 종료) |
| V-T27 | 측정 |  | HOT-480 | Outbox 폴링 릴레이 측정 |
| V-T28 | 측정 |  | HOT-480 | Outbox 릴레이의 순서와 유실 |
| NFR-007 | 측정 |  | 출시 뒤 운영 측정 | 공연 페이지 30만 RPS는 CloudFront 서버 엣지 계측과 RUM으로 판정한다. 2026-11-12 BAT-210이 30만 RPS의 셈 근거(100만 × 30% × 2회 ÷ 10초 × 5건 [가정])를 docs/architecture.md §9.1에 적었다. 실제 CloudFront·RUM 측정은 출시 뒤 클라우드 계정이 있을 때 한다 |

## 다른 단계

시범 범위 표에서 '다른 단계 몫'이던 행 가운데 S-T2는 옮기지 않았다. 불변식 검사기 시험(`services/invariant-checker`)이 이미 이름을 달고 있어 자동 시험이다.

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| S-T13 | 다른 단계 |  | BAT-182 | 전파 버전 갭 자가 치유. 회복은 화면의 delta-sync라 화면을 realtime-gw에 이은 뒤 잰다(2026-11-18 전체 감독 결정). 서버 몫은 S-T42 ⑤⑥⑩ |
| S-T19 | 측정 |  | BAT-090 heavy gate | 자동 배정 1,000건 동시·1순위 매진·분리 조합. 단위 시험은 후보·분리·수동 전환을 본다. 2026-11-13 측정: 100 동시×10묶음 1,000/1,000·중복 0·수동 0, 문자 그대로 1,000건 동시는 로컬 단일 Valkey 100ms 마감에서 503(무대 한계, 보고서 §5) |
| S-T20 | 측정 |  | BAT-090 heavy gate | 자동 배정 순서 공정성. 2026-11-13 측정: 같은 조건 순차 10건×2회 R0001~R0020 동일·굶주림 0(보고서 §6) |
| S-T21 | 다른 단계 |  | BAT-182 | 확대 표시와 구역 구독(2026-11-18 전체 감독 결정) |
| S-T22 | 다른 단계 |  | 미정 | 판매 종료 뒤 홀드 |
| S-T31 ⑥ | 다른 단계 |  | BAT-182 | 좌석 구독 상한과 프레임 검사의 ⑥ 정상 화면 시나리오(S-T21과 같이 화면을 realtime-gw에 이은 뒤 본다). ①~⑤는 realtime-gw 시험이 BAT-052에서 맡는다(추천 적용 2026-11-18, BAT-052 계획) |
| S-T34 ①~③ | 다른 단계 |  | HOT-420·BAS-140 | 좌석맵 해석 작업 배포의 자격 증명·나가는 통신·메시 신원은 배포 상태(BAS-140)와 메시·NetworkPolicy(HOT-420, D-T36)가 정한다. 코드 몫(자격 증명 환경 값이 있으면 뜨지 않음)은 BAT-145가 [ASVS v5.0.0-15.2.5]로 시험한다(ADR-0257 결정 5) |
| P-T14 | 다른 단계 |  | 미정 | PG 시뮬레이터 전환 |
| P-T18 | 다른 단계 |  | 미정 | 공제율 산정 정확도 |
| P-T19 ② | 다른 단계 | A | GAT-280 | CS 처리함의 '취소 무효' 확정은 CS 처리함 단계가 만든다. ①③(마감 뒤 입장 기록 대조와 환급)은 GAT-090(BAT-420)의 시험 이름으로 정한다(2026-11-16 세부 나눔, docs/features/payment.md §11 P-T19) |
| P-T20 | 다른 단계 |  | 미정 | 회차 취소 일괄 환불 |
| P-T21 |  | A | GAT-080 | 취소 멱등성과 재시도. 2026-11-16 BAT-415 장부 범위로 옮겼다(감독 승인). 이제 이 묶음의 시험 이름(P-T21)으로 상태를 정하므로 '다른 단계'를 지우고 등급만 남긴다(docs/features/payment.md §4.1 '취소 건 기록과 기대 잔액') |
| P-T42 |  | A | LCH-010 | 굿즈 재고 예약 만료(core-svc shop). 2026-11-18 BAT-600 장부 범위로 옮겼다(계획 docs/review/plans/BAT-600.md). 이제 이 묶음의 시험 이름(P-T42)으로 상태를 정하므로 '다른 단계'를 지우고 등급만 남긴다 |
| V-T35 ③ | 다른 단계 | A | LCH-030 | 부가 상품의 구매자 취소(연결 회차 입장 시작 전 전액 환급, 뒤에는 거절)는 취소·반품 상태 기계를 만드는 BAT-605 몫이다. ①②(보유 확인·결제 금액 스냅샷)는 BAT-600이 시험 이름으로 정한다(ADR-0301 결정 6) |
| P-T49 ⑤⑥ | 다른 단계 |  | GAT-310 | `SetBookingRestriction`을 받는 쪽이 생기는 GAT-310 뒤에 본다(시범 범위 표의 끝 문단) |
| O-T23 | 다른 단계 |  | BAT-350 | v0 모놀리스의 입장 시험(services/v0-monolith/test-int/gate.int.test.ts)만 있다. 목표 구조의 오프라인 게이트는 그 묶음(GAT-010)에서 다시 판정한다(2026-11-10 감독 결정) |
| O-T32 | 다른 단계 |  | GAT-140 | BAT-350이 클라이언트 키 생성·보관·QR 표시(등록 버튼, LOCAL 키)를 넣었다. 서버 공개키 등록·폐기·스캐너 keyId 대조는 ticket-svc `POST /v1/tickets/{ticketId}/device-keys` 구현과 `device_key` 표가 없어 GAT-140 후속이다(2026-11-14 R-554) |
| O-T33 | 다른 단계 |  | GAT-180·GAT-190 | BAT-350은 클라이언트 QR v1 형식·base45·서명·15초 재서명을 단위 시험했다(`qr-v1.test.mjs`). 스캐너가 '유효하지 않은 QR/옛 QR/위조 의심' 사유를 가르는 부분은 스캐너 판정·키 목록(GAT-180·GAT-190) 몫이다(2026-11-14 R-554) |
| FE-T9 | 다른 단계 |  | 미정 | 이진 해독기 경계는 좌석맵 패키지 단계 몫이다. 시범에서는 서버와의 맞물림 시험만 더했다 |
| B-T6 ⑤ | 다른 단계 |  | OPS-290 | 서킷이 열리고 닫힐 때의 운영 사건 줄(`ops_event`)은 ops-svc 몫이다. queue-svc의 서킷 지표와 보안 로그는 BOT-050 시험이 본다(B-T6 ②) |
| B-T20 ⑩ | 다른 단계 |  | HOT-400 | `ApplyLabel`을 부르는 신원을 ops-svc로 줄이는 것은 메시 L7 허용 목록이다(identity-svc gRPC와 같다, docs/features/bot-defense.md §9 '첫 구현') |
| B-T21 ④ | 다른 단계 |  | OPS-220 | 분석의 봇 지표(F6 `fct_bot_outcome`)가 그림자 판정을 세지 않는 것은 분석 골드 사실을 만드는 단계에서 본다. trust-svc는 그림자 판정에 `shadow` true를 싣는다(B-T4) |
| Q-T48 ② | 다른 단계 |  | GAT-280 | 지운 기록이 CS 처리함 건에 남는 것은 CS 처리함(SCR-045) 몫이고 ops-svc가 아직 없다. trust-svc 쪽(차단 키 지우기, 보안 로그 줄, 라벨 판정 기록)은 B-T9 ③·B-T27 ④⑤가 본다(정할 곳을 BOT-090에서 GAT-280으로 바꿈, BAT-200 시작 때 2026-11-10) |
| B-T10 ⑥ | 다른 단계 |  | GAT-280 | 처리함에 건이 하나 생기는 것, 결과 반영 호출을 작업 워커가 다시 보내는 것, 건이 열린 동안의 `SetAccountHold`는 ops-svc 몫이다. queue-svc·trust-svc 쪽 멱등은 B-T10 ③⑤가 본다(BAT-200에서 정함, 2026-11-10, ADR-0259) |
| B-T10 ⑦ | 다른 단계 |  | HOT-400 | 메시 L7 허용 목록이 `VerificationAppealService`를 부르는 신원을 ops-svc로 줄인다(B-T20 ⑩과 같다). queue-svc 처리기는 그 신원을 따로 보지 않는다(BAT-200 리뷰 뒤 정함, 2026-11-10, ADR-0259) |
| B-T15 ② | 다른 단계 |  | HOT-400 | `GetVerdictEvidence`를 부르는 신원을 ops-svc로 줄이는 것은 메시 L7 허용 목록이다(B-T20 ⑩과 같다, BAT-200에서 정함, 2026-11-10) |
| I-T56 ⑤ | 다른 단계 |  | HOT-400 | `CheckReverification`을 queue-svc 신원으로만 받는 것은 메시 L7 허용 목록이다(BAT-200에서 정함, 2026-11-10) |
| Q-T36 ⑦ | 다른 단계 |  | HOT-251 | 명단 사본(대기열 Redis)이 그 수명에 지워지는 것은 사본을 쓰는 core-svc 어댑터가 본다(소유자 결정 2026-11-10, OPEN[33] (가), ADR-0261 결정 9). 어댑터는 HOT-251(묶음 BAT-158)이 만든다. 사본에 넘기는 수명은 BAT-157의 Q-T36 ④가 본다(2026-11-10) |
| SR-T8 ③ | 다른 단계 |  | LCH-090·GAT-110 | 판매 중지·재개(LCH-090, 묶음 BAT-620)와 회차 전부 취소(GAT-110, 묶음 BAT-420)를 처리하는 유스케이스가 아직 없다. 그 단계가 같은 트랜잭션에서 `syncSearchReadModel`을 부르고 커밋 뒤 CDN `/v1/search*` 무효화와 `search_removed` 줄을 남기는지 본다. 동기화 함수와 경로 무효화 포트는 BAT-165 웨이브 7이 만든다(ADR-0271 결정 2·8, 2026-11-16) |
| SR-T11 ② | 다른 단계 |  | HOT-450 | CloudFront 캐시 정책이 쿠키를 키에서 빼는지는 배포 구성 검사다. 입구 CDN 배포(HOT-450, 묶음 BAT-070) 몫이고 BAT-165 범위에서 뺐다(2026-11-16) |
| catalog-review:v5.0.0-1.3.9 | 해당 없음 |  | — | memcache를 쓰지 않는다. 자동완성은 core-svc 파드 메모리 사전에서 답하고 사용자 입력을 Redis 키로 쓰지 않는다(ADR-0094) |
| frontend:v5.0.0-3.5.4 | 다른 단계 |  | GAT-040 | 화면 호스트 넷(`www`·`partner`·`console`·`scanner`)은 이미 나뉘어 있다(ADR-0065 결정 1). 남은 몫은 같은 `www`에 둔 월렛 서비스 워커 범위다: 정본은 `/my/tickets/sw.js`·범위 `/my/tickets/`(docs/frontend.md §5.4)인데 BAT-350(R-554)은 `/serwist/sw.js`·`Service-Worker-Allowed: /my/tickets`(끝 `/` 없음)로 냈다. 범위·위치 PoC는 GAT-040(wbs 5.1.4) 몫이고, 관제 원격 위젯 출처는 OPS-350이다. BAT-170 웨이브 7에서 다시 판정(2026-11-16) |
| frontend:v5.0.0-3.4.4 | 다른 단계 |  | HOT-450 | 화면 앱은 `nosniff`를 보내지 않고 배포 응답 헤더 정책이 붙인다(docs/devops.md §6.6 '응답 보안 헤더 정책', `packages/config/headers/security-headers.mjs` 주석, 행의 '공통: delivery.md 판정'). 서비스 워커 스크립트(지금 `/serwist/sw.js`, 앱 서버 경로)와 `remoteEntry.js`(관제 정적 배포)도 같은 정책을 받는지는 CloudFront 캐시 동작별 응답 헤더 정책 몫이라 HOT-450 줄에 넘겼다. 게이트웨이 응답은 kind e2e(`tools/local/e2e/v0-deploy.e2e.mjs` BSL050)가 본다. BAT-170 웨이브 7에서 다시 판정(2026-11-16) |
| frontend:v5.0.0-3.6.1 | 다른 단계 |  | BAT-172 | CSP 시험이 같은 출처 외부 스크립트 26건에서 `integrity` 없음으로 실패했다(BAT-170 웨이브 끝 게이트, 2026-11-16). BAT-171 2차 CI(실행 44361082574)에서 공연 상세 24·추가 검증 16·결제 14건이고, 실행 중 덩어리 적재기가 넣은 태그가 있어 범위 결정이 소유자 질문 OPEN[51]로 갔다. HOT-391은 묶음 BAT-172로 옮겼고(2026-11-19), 시험은 지우지 않고 까닭 `BAT-172(OPEN[51], HOT-391)`을 단 건너뛰기다. BAT-172가 고치면 이 줄을 지운다 |
| D-T50 ⑦ | 다른 단계 |  | HOT-173 | 파트너 API의 테넌트당 600회/분(docs/api/guidelines.md §6). 게이트웨이(BAT-060)는 계정당 한도만 첫 겹으로 건다. 테넌트당 한도는 서비스 층의 테넌트별 공용 카운터가 센다(소유자 결정 2026-11-16 OPEN[41], 토큰 계약 그대로). 그 카운터는 HOT-173(묶음 BAT-173, 갈래 2, 감독 배정 2026-11-16)이 만든다. BAT-173의 시험 담당이 D-T50 ⑦을 이름에 단 시험을 더하는 커밋에서 이 줄을 지운다(남겨 두면 시험 이름과 부딪힌다) |

## 사람 확인

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| S-T16 ① | 사람 확인 |  | BOT-100 | 공격마다 결과를 '방해'와 '이득'으로 나눠 기록하고 소지 증명을 남길지 정하는 것은 사람의 판단이다(ADR-0124 결정 2) |
| S-T18 | 사람 확인 |  | BAT-175 | 화면 낭독기로 사람이 예매를 완주한다(axe 자동 검사는 CI). 확인 목록은 docs/review/manual-a11y/S-T18.md다. VoiceOver(iOS Safari)는 기기를 구할 때까지 미실행이다(ADR-0237) |
| FE-T8 | 사람 확인 |  | 브라우저 확인 | docs/review/browser-check/HOT-356-358.md에서 시뮬레이터 성공과 새로고침을 봤다. 포트원 복귀와 쿠키 없는 첫 요청은 아직 못 봤다 |
| FE-T18 | 사람 확인 |  | BAT-580 | 화면 낭독기·키보드 완주는 사람이 본다. 이름을 단 자동 시험(axe·목록 구조)은 그 일부다. 3조합·3시나리오 확인 목록은 docs/review/manual-a11y/LCH-190.md(2026-11-13) |
| POL-027 | 사람 확인 | C | BAT-590 | 법률 항목 표기 규칙과 검토 목록은 docs/review/legal/BAT-590-legal-review.md에 정리했다. 변호사 검토 제출과 결론 반영은 소유자 몫이다(2026-11-13) |

## 미검증

시범 범위 표는 아래 둘을 사람 확인으로 적었다. 실제 결제사 계정이 있어야 판정할 수 있어 ADR-0256 결정 2의 미검증으로 옮겼다.

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| P-T33 | 미검증 |  | 포트원 테스트 채널 | 실제 포트원 리디렉션 결제가 필요한데 포트원 테스트 채널 계정이 없다(HOT-145) |
| P-T38 | 미검증 |  | 실제 결제창 | 실제 결제창(토스 이동 방식, 포트원 리디렉션 방식)에서 돌아온 첫 요청은 결제사 계정이 있어야 본다. 브라우저 확인은 시뮬레이터로만 했다 |
| C-T43 | 미검증 | B | BAT-620 | 수요 예측식·기본 비율·규모 올리기·T-30분·LARGE 간격·commander 예외는 core-svc 시험으로 확인했다. 화면의 '규모 올리기 검토'·SEV3 알림(24시간 뒤 SEV2)·감사 로그·변경 동결 달력 재계산은 ops-svc·감사·배포 단계가 없어 아직 볼 수 없다 |
| D-T12 ② | 미검증 | B | BAT-202 | 조직 Actions 정책은 GitHub 조직 설정이라 저장소 시험으로 보지 못한다. 2026-11-10 조직 API에서 `sha_pinning_required: true`·허용 목록을 읽었지만 동작은 보지 않았다. 소유자가 `infra/stacks/global/github`의 `actions_patterns_allowed`(Scorecard 액션 더함)를 적용한 뒤 태그로 참조한 시험 워크플로가 실패하는지 한 번 보면 '사람 확인'으로 바꾼다(BAT-202 계획 7장 1·2) |
| SR-T15 ③ | 미검증 |  | AWS 계정 뒤(OPEN 후보) | Aurora 읽기 전용 복제본에서 `REPEATABLE READ` 읽기 전용 트랜잭션이 되는지는 AWS 계정과 클러스터 비용이 있어야 본다(소유자 자원 한도). 대역은 SR-T15 ②의 로컬 PostgreSQL 18 핫 스탠바이 통합 시험이다. BAT-165 범위에서 뺐다(2026-11-16) |

## 등급

원천 문서의 기본 등급(요구사항·정책은 B)을 ADR-0256 결정 10의 등급 뜻(A는 돈·좌석·대기 순번의 핵심 로직과 그 데이터의 복구)에 맞춰 바꾼 항목이다. 2026-11-10 결정 10으로 개인정보(NFR-018)와 법정 조치(POL-024)는 기본값 B로 돌렸다(표본에 꼭 넣는다).

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| V-T35 ①② |  | A |  | 티켓 보유 확인(권한)과 산 주문의 결제 금액·옵션 스냅샷(돈)이다(ADR-0301) |
| POL-007 |  | A |  | 대기열 인원의 기준(대기 순번) |
| I-T84 |  | A | BAT-010 | 탈퇴 미룸은 법정 파기 시점(개인정보)과 입금 대기 주문의 입금 전 취소(돈)에 닿는다(2026-11-18 BAT-010 계획, ADR-0284) |
| POL-043 |  | C |  | 홈 섹션 구성(배치) |
| S-T40 |  | B |  | 좌석맵 템플릿과 휠체어석·겹침·도형 밖 경고는 좌석 판매·홀드의 핵심 로직이 아니다(경고는 저장을 막지 않고, 템플릿은 출발점일 뿐이다. 잠금 409는 A로 증명한 S-T38 ⑤의 판정 함수를 부른다, ADR-0264) |

## BAT-050 ticket-svc 범위 밖(2026-11-13)

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| payment:v5.0.0-2.1.3 | 다른 단계 | B | 결제 공통 후속 | 결제 공통 경로·게이트웨이의 기존 시험이 맡는다. BAT-050은 ticket-svc 발권·취소·월렛만 본다. |
| payment:v5.0.0-3.3.2 | 다른 단계 | B | 결제 공통 후속 | 결제 공통 경로·게이트웨이의 기존 시험이 맡는다. BAT-050은 ticket-svc 발권·취소·월렛만 본다. |
| payment:v5.0.0-3.4.1 | 다른 단계 | B | 결제 공통 후속 | 결제 공통 경로·게이트웨이의 기존 시험이 맡는다. BAT-050은 ticket-svc 발권·취소·월렛만 본다. |
| payment:v5.0.0-3.4.2 | 다른 단계 | B | 결제 공통 후속 | 결제 공통 경로·게이트웨이의 기존 시험이 맡는다. BAT-050은 ticket-svc 발권·취소·월렛만 본다. |
| payment:v5.0.0-3.4.4 | 다른 단계 | B | 결제 공통 후속 | 결제 공통 경로·게이트웨이의 기존 시험이 맡는다. BAT-050은 ticket-svc 발권·취소·월렛만 본다. |
| payment:v5.0.0-3.4.5 | 다른 단계 | B | 결제 공통 후속 | 결제 공통 경로·게이트웨이의 기존 시험이 맡는다. BAT-050은 ticket-svc 발권·취소·월렛만 본다. |
| payment:v5.0.0-3.5.2 | 다른 단계 | B | 결제 공통 후속 | 결제 공통 경로·게이트웨이의 기존 시험이 맡는다. BAT-050은 ticket-svc 발권·취소·월렛만 본다. |
| payment:v5.0.0-3.5.3 | 다른 단계 | B | 결제 공통 후속 | 결제 공통 경로·게이트웨이의 기존 시험이 맡는다. BAT-050은 ticket-svc 발권·취소·월렛만 본다. |
| payment:v5.0.0-3.5.4 | 다른 단계 | B | 결제 공통 후속 | 결제 공통 경로·게이트웨이의 기존 시험이 맡는다. BAT-050은 ticket-svc 발권·취소·월렛만 본다. |
| payment:v5.0.0-3.7.1 | 다른 단계 | B | 결제 공통 후속 | 결제 공통 경로·게이트웨이의 기존 시험이 맡는다. BAT-050은 ticket-svc 발권·취소·월렛만 본다. |
| payment:v5.0.0-11.2.2 | 다른 단계 | B | 결제 공통 후속 | payment-svc·플랫폼의 TLS·KMS 경로가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-12.2.1 | 다른 단계 | B | 결제 공통 후속 | payment-svc·플랫폼의 TLS·KMS 경로가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-12.2.2 | 다른 단계 | B | 결제 공통 후속 | payment-svc·플랫폼의 TLS·KMS 경로가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-12.3.2 | 다른 단계 | B | 결제 공통 후속 | payment-svc·플랫폼의 TLS·KMS 경로가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-12.3.3 | 다른 단계 | B | 결제 공통 후속 | payment-svc·플랫폼의 TLS·KMS 경로가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-12.3.4 | 다른 단계 | B | 결제 공통 후속 | payment-svc·플랫폼의 TLS·KMS 경로가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-13.3.2 | 다른 단계 | B | 결제 공통 후속 | payment-svc·플랫폼의 TLS·KMS 경로가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-15.1.1 | 다른 단계 | B | 결제 공통 후속 | 배포·로깅·공급망 공통 통제가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-15.1.2 | 다른 단계 | B | 결제 공통 후속 | 배포·로깅·공급망 공통 통제가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-15.3.4 | 다른 단계 | B | 결제 공통 후속 | 배포·로깅·공급망 공통 통제가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-16.2.1 | 다른 단계 | B | 결제 공통 후속 | 배포·로깅·공급망 공통 통제가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-16.2.2 | 다른 단계 | B | 결제 공통 후속 | 배포·로깅·공급망 공통 통제가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-16.2.3 | 다른 단계 | B | 결제 공통 후속 | 배포·로깅·공급망 공통 통제가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-16.2.4 | 다른 단계 | B | 결제 공통 후속 | 배포·로깅·공급망 공통 통제가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-16.3.1 | 다른 단계 | B | 결제 공통 후속 | 배포·로깅·공급망 공통 통제가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-16.5.1 | 다른 단계 | B | 결제 공통 후속 | 배포·로깅·공급망 공통 통제가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-2.3.5 | 다른 단계 | B | 결제 공통 후속 | 배포·로깅·공급망 공통 통제가 맡는다. BAT-050 범위 밖이다. |
| payment:v5.0.0-3.4.7 | 다른 단계 | B | 결제 공통 후속 | 배포·로깅·공급망 공통 통제가 맡는다. BAT-050 범위 밖이다. |
| P-T39 | 다른 단계 | A | PRF-170·GAT-280 | 발권 재시도·기한·CS TICKET_NOT_ISSUED 건은 purchase-svc 실행기와 GAT-280 몫이다. ticket-svc는 IssueTickets 멱등·거절만 제공한다. |
| I-T26 | 다른 단계 | A | PRF-174 | 탈퇴 참여자의 결제한 미사용 티켓 취소·환급(§1.5 ①, 돈)은 PRF-174(BAT-013)가 맡는다(2026-11-18 BAT-010 계획이 빈칸을 찾음, ADR-0283 결정 6). |
| I-T43 | 다른 단계 | B | GAT-050·GAT-090 | 받은 티켓·양도 요청이 있는 탈퇴는 양도 단계(GAT-050), 가상계좌 지연 환급의 202 미룸은 GAT-090이 탈퇴 참여자에 더한다. 참여자의 틀과 결제 대기·입금 대기 주문 몫은 PRF-169(BAT-010)가 만들었고 그 판정은 I-T84·P-T55다(2026-11-18 BAT-010 계획에서 정할 곳의 PRF-169를 뺐다. 그 전 기록: 2026-11-16 BAT-420 계획) |
| payment:v5.0.0-14.1.1 | 다른 단계 | B | core-svc 판매 자격 후속 | core-svc 판매 자격 시험이 맡는다. BAT-050은 ticket-svc 발권만 본다. |
| payment:v5.0.0-14.1.2 | 다른 단계 | B | core-svc 판매 자격 후속 | core-svc 판매 자격 시험이 맡는다. BAT-050은 ticket-svc 발권만 본다. |
| payment:v5.0.0-14.2.2 | 다른 단계 | B | core-svc 좌석맵 후속 | core-svc 좌석맵 저장 시험이 맡는다. BAT-050은 ticket-svc 발권만 본다. |

## BAT-610 화면 몫(2026-11-14)

| ID | 상태 | 등급 | 담당 | 근거·이유 |
| --- | --- | --- | --- | --- |
| I-T53 | 다른 계약 | B | apps/partner 재인증 화면·core-svc export | 화면은 `act BOOKER_EXPORT`·패스키 단계·403 `reauth-required`를 부르고, 서버는 core-svc `JwksBookersReauth`가 identity 관리 키로 `typ reauth+jwt`·act·passkey를 확인한다. 시험은 `apps/partner/src/shared/api/reauth.test.mjs`·`problem.test.mjs`·`_pages/settlement/model/roster-live.test.mjs`와 `services/core-svc/test/export.test.ts`가 본다. jti 한 번 쓰기는 identity-svc 몫이다. |
| J-T18 | 다른 계약 | A | payment-svc 정산·core-svc 상품 원천 | 회차 정산서 계산·이의·KYC 게이트·지급 묶음·수기 포트원 실행을 R-574에서 넣었고, 이번에 상품 정산서(주 단위·항목별 수수료율·+4영업일)와 미수금 상계를 `services/payment-svc/test/settlement.test.ts`, 상품 기준일 규칙을 `services/core-svc/test/export.test.ts`가 본다. 토스 지급대행 JWE·포트원 출금 대사·KYC 셀러 원천은 실계정 뒤다. |
| J-T26 | 다른 계약 | A | core-svc export·purchase-svc 명단 원천 | 내려받기 사유·재인증·보유 기간·다운로드 이력은 화면(`roster-live.test.mjs`)과 core-svc `export.test.ts`가 본다. 명단 원천은 core-svc `merch_order`·`merch_order_item`(0016)이고, CSV/XLSX는 수식 주입을 막는다. 50만 행 스트리밍 RSS·첫 바이트 2초는 heavy gate 측정 몫이다. |
| N-T15 | 다른 계약 | B | core-svc notify 모듈 | endpoint·delivery 표와 관리 API(등록·고치기·비밀 재발급·발송 이력·다시 보내기)를 R-567에서 넣었고, 이번에 발송기·재시도(1분~12시간)·DEAD·FAILING 비활성화·Standard Webhooks 서명을 `services/core-svc/test/webhook-dispatcher.test.ts`와 `notify-webhook.http.test.ts`가 본다. 화면은 `webhooks/model/live.test.mjs`다. Secrets Manager·알림함·Kafka outbox 소비자는 남았다. |

서버 잔여(R-567)로 core-svc shop·notify 관리 API와 `product`·`product_stock`·`webhook_endpoint`·`webhook_delivery` 표(0014·0015, 테넌트 RLS)를 넣었다. N-T15의 관리 API 부분은 `services/core-svc/test/notify-webhook.http.test.ts`가 본다. J-T18·J-T26과 N-T15의 발송기·재시도·DLQ는 위 사유대로 막혀 있다.

payment 잔여(R-574)로 payment-svc settlement 모듈과 `settlement_statement`·`statement_source`·`statement_dispute`·`payout_batch`·`payout`·`seller_kyc`·`payout_account` 표(0015)를 넣었다. J-T18의 회차 정산서·이의·KYC·지급 묶음·수기 포트원 실행은 `services/payment-svc/test/settlement.test.ts`가 본다. 상품 정산서 원천·토스 지급대행 JWE·포트원 지급 내역/출금 대사·KYC 원천·ops-svc 승인·core-svc export는 위 사유대로 막혀 있다.
잔여(R-588)는 core-svc `merch_order`·`merch_order_item`·`attendee_export`(0016)와 `BOOKER_EXPORT` 재인증, notify 발송기·DLQ, payment-svc 상품 정산서·미수금 상계(0016), ops-svc `payout_approval`(0009), 토스 지급 웹훅 서명·포트원 출금 대사 규칙을 넣었다. 실제 키·계정이 없어 토스 실행은 503이고, KYC 셀러 조회·Secrets Manager·지급 실행 화면은 남았다.
- Q-T59(2026-11-15, R-593): queue-svc·purchase-svc가 `SetBookingRestriction` gRPC로 `q:rst:{account}`·`s:rst:{account}`에 판 번호가 클 때만 사본을 쓴다. 시험은 단위 `services/queue-svc/test/booking-restriction.test.ts`·`services/purchase-svc/test/booking-restriction.test.ts`와 실제 Valkey·gRPC test-int `services/queue-svc/test-int/booking-restriction.int.test.ts`·`services/purchase-svc/test-int/booking-restrictions.int.test.ts`가 본다. heavy gate에서 변이 6/6을 잡았다. ops-svc 승인 업무·10분 재전송 작업 워커와 화면은 아직 없다.
