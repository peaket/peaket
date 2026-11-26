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
| SR-T13 ① | 측정 |  | BAT-167 | 오픈 직전 몰림·무작위 입력에서 검색·자동완성 원본 p95와 검색 전용 연결 묶음 대기·503을 로컬 k6로 잰다(ADR-0271 결정 5, 계획 docs/review/plans/BAT-165.md 웨이브 7). 결과 docs/review/measurements/BAT-165-sr-t13-search.md: 미달(2026-11-16 M-1, 공연 1만·2만, 검색 503 65~84%·성공한 검색 서버 p95 0.9~1.7초, 자동완성 받는 쪽 p95 0.5~1초). BAT-166 다시 재기(docs/review/measurements/BAT-166-sr-t13-search.md, 2026-11-19, R-695): 공연 1만 통과, 2만 미달(다시 재기 2의 3회 중 1회 무작위 검색 p95 328ms, 1회 299ms 경계. 503·게이지·자동완성은 기준 안). 남은 몫은 BAT-167에서 같은 무대로 다시 잰다. BAT-167(docs/review/measurements/BAT-167-sr-t13-search.md, 2026-11-20, R-715): 공연 1만·2만 모두 통과(유효 회차 각 3). 2만 무작위 검색 받는 쪽 p95 112~116ms, 검색 503 0%, 게이지 0%. 1만은 가장 느린 회차가 검색 149ms·503 0.17% |
| SR-T13 ② | 측정 |  | BAT-056 | BAT-056 측정 창에서 gw-fan 검색 IP 한도를 클러스터 안 k6로 잼(2026-11-18, 성능 장부 `2026-11-18-bat056-ms-ip-single`·`-many`·`-mixed`·`-v6-64`). 통과: 한 IP 통과 3,000·3,001건 ≤ 상한 3,050, 넘은 요청 모두 429와 `Retry-After`, 서로 다른 IP 1,000개·2만 개는 429 0건. IPv6 /64 안 주소 100개는 429 0건(관찰, W7-CON-05 근거). 결과 docs/review/measurements/BAT-056-gateway-breaker.md §8. 한도 설정을 보는 kind 시험 `SR-T13 ②`(tools/local/e2e/gateways.e2e.mjs)는 BAT-055·BAT-060에서 통과 |
| V-T43 ① | 측정 |  | BAT-056, BAT-058 | 정상 부하 503 0건을 kind에서 스윕으로 잼(2026-11-18, 성능 장부 `2026-11-18-bat056-ma-*`·`-mb-*`). 통과: 고른 동시·연결 128·보류 16에서 3회, 운영 첫 값 2,400·300에서 1회 모두 503 0건·Envoy 넘침 0. 잰 포화 처리량(vCPU 하나 2,600/s)·k(10.6, Envoy 일꾼 32의 고정 몫)가 첫 값의 입력과 달랐다. 결과 docs/review/measurements/BAT-056-gateway-breaker.md. BAT-058 첫 측정(2026-11-19, 일꾼 2·프록시 CPU 요청 100m 무대, 성능 장부 `2026-11-19-bat058-aa*`·`-ma-*`·`-ops-*`·`-mw-*`): r_min 64 3회 통과·k 5.0, 그 값으로 셈한 gw-queue 3,120·390에서 정상 부하 503 0건·넘침 0, 일꾼 수를 지운 틀린 판은 실패. 셈한 값(나머지 넷 7,800·975 포함)은 적용 보류다(감독 결정, 리뷰 RV-01·RV-02). 진단 측정(2026-11-19, gw-queue만 CPU 요청 2, 성능 장부 `2026-11-19-bat058-dx-*`)이 A/A 0.06%·일꾼 2·r_min 48 3회 통과(32와 40 한 번 실패)·k 3.9로 결정 규칙을 채워 운영 값을 gw-queue 2,434·305, 나머지 넷 6,084·761로 정했다. 결과 docs/review/measurements/BAT-058-gateway-workers.md |
| V-T43 ② | 측정 |  | BAT-056, BAT-058 | 과부하(진입 지연 500·100·50ms 고정, 각 3회)를 kind에서 잼(2026-11-18, 성능 장부 `2026-11-18-bat056-mc-*`). 통과: 9단계 모두 게이트웨이 503 p99 0.83~1.42ms ≤ 3ms, 503 모두 `Retry-After: 2`·Problem, 처리 중 최대 ≤ 상한, 결과 파일과 장부 판정이 같음(리뷰 N1 대조). 결과 docs/review/measurements/BAT-056-gateway-breaker.md. BAT-058 첫 측정(2026-11-19, 일꾼 2 무대, r_pc 66, 성능 장부 `2026-11-19-bat058-mc-d500-*`·`-mc-d50-*`): 진입 지연 500·50ms 각 1회 503 p99 2.02·1.54ms, 503 모두 `Retry-After: 2`·Problem, 처리 중 최대 66 ≤ 66, 결과 파일과 장부 판정 같음(그 r_pc를 낸 잰 값은 적용 보류). 진단 측정이 정한 운영 값(r_pc 49)에서 ②는 진단 차례 밖이라 다시 재지 않았다. 결과 docs/review/measurements/BAT-058-gateway-workers.md |
| V-T44 | 측정 |  | BAT-056 | 문서 인용: Istio 1.24 공식 성능 문서(https://istio.io/latest/docs/ops/deployment/performance-and-scalability/, 그림 `istio-1.24.0-fortio-99.png`, 2026-11-18 구현·검증 담당이 대조), 웨이포인트 p99 증가 0.407~0.573ms ≤ 2ms라 앰비언트를 쓴다. 결과는 docs/verification.md V-T44 행 끝 |
| S-T1 | 측정 |  | PRF-220 | 1개 좌석 1,000명 동시 경합. v1 K2 TLS 켬 3·끔 1(2026-11-11-k2-v1-hot-tls-r1~r3·notls-r1)은 발생기 놓침 920~1,504로 모두 무효, p99 271~318ms·서버 p99 250~270ms로 목표(50ms) 미달. 서비스 분리 뒤 HOT-460에서 다시 잰다 |
| S-T8 | 측정 |  | PRF-140 | Hard Sale 최종 경합. 판정이 부하 수치다 |
| S-T9 | 측정 |  | 구간 측정 | Redis 주 노드 장애 복구 |
| S-T16 ② | 측정 |  | BAT-090 heavy gate | 탈취 거부(서명 변조·재전송·다른 세션 키)는 `services/purchase-svc/test/purchase-session-theft.test.ts`가 본다. 정상 요청 확인 p99 1ms는 2026-11-13 3회 반복 중앙값 전체 9.7101ms·Redis 제외 3.8070ms·MAC만 1.1281ms로 **미달**(보고서 §4) |
| S-T23 ⑥ | 측정 |  | 구간 측정 | 옮기기·되돌리기 Lua 200개가 이 PC에서 p50 1.6ms·p99 2.0ms로 1ms [가정]을 넘었다(docs/review/pilot-purchase-path-perf.md). 다시 여는 동안의 홀드 p99 50ms는 아직 못 쟀다. ①~⑤는 자동 시험이다 |
| S-T27 | 측정 |  | 구간 측정 | 좌석 샤드 하나의 처리량 상한. 판정이 부하 수치다 |
| S-T35 ⑥ | 측정 |  | PRF-220 | `lua-compare` A/A p50 ±2.1~6.7%·p99 ±4.6~15.9%. `end-session` p50 1.583/1.769, `order-hold` p99 1.216로 A/A 폭을 넘어 S-T35 ⑥는 보류 |
| P-T1 | 측정 |  | HOT-470 | K7 카오스 장애 주입 1만 건. v1 K7 ② 2026-11-11-k7-v1-fault-r1·r2는 발생기 놓침 1,068·1,157, 시나리오 오류 179·199로 무효. P1~P4·P6·S1·S4는 PASS, P3은 새 시작 시각으로 PASS. F-08-8(HOT-470)이 v1 합본 무대에서 이중 결제·P3·P6·좌석 누수를 다시 잰다(계획 docs/review/plans/F-08-8.md). ticket-svc 5분 중단·망 끊김·웹훅 중복 주입·이중 발권·일일 대사 불일치는 측정 못 함(ADR-0373 동결 선행): 그 몫을 넘겨받은 HOT-480(F-08-9)이 동결이고, v1 합본 무대에는 ticket-svc가 없다(늘 발권하는 대역) |
| P-T4 | 측정 |  | 구간 측정 | 결제 접수 p99 |
| P-T5 | 측정 |  | 구간 측정 | 결제 최종 확정 p99 |
| P-T11 | 측정 |  | 구간 측정 | Degraded 결제 모드 |
| P-T22 | 측정 |  | 구간 측정 | PG 한도 추정 모델 |
| FE-T10 | 측정 |  | LCH-200 | 좌석맵 성능과 네트워크(측정 캠페인) |
| FE-T33 | 측정 |  | LCH-200 | 좌석맵 에디터 편집 캔버스(Konva)의 끌기·돌리기 프레임과 INP(측정 캠페인 wbs 7.5.2). BAT-150(HOT-220)은 같은 조작을 로컬에서 한 번 재어 커밋 본문에 적고, 결과를 남기는 판정은 측정 창에서 한다 |
| FE-T32 | 측정 |  | 구간 측정 | 시범 범위 표의 분류(차례 반영 측정)를 옮겼다. 판정 ①~④는 가짜 시계로 도는 PR 시험으로도 볼 수 있어, 이 영역을 고치는 묶음에서 다시 본다 |
| V-T6 | 측정 |  | 구간 측정 | G-02 대체 장애(로컬 좌석 Redis 주 노드 강제 종료) |
| V-T27 | 측정 |  | HOT-480 | Outbox 폴링 릴레이 측정 |
| V-T28 | 측정 |  | HOT-480 | Outbox 릴레이의 순서와 유실 |
| NFR-007 | 측정 |  | 출시 뒤 운영 측정 | 공연 페이지 30만 RPS는 CloudFront 서버 엣지 계측과 RUM으로 판정한다. 2026-11-12 BAT-210이 30만 RPS의 셈 근거(100만 × 30% × 2회 ÷ 10초 × 5건 [가정])를 docs/architecture.md §9.1에 적었다. 실제 CloudFront·RUM 측정은 출시 뒤 클라우드 계정이 있을 때 한다 |
| D-T19 ④ | 측정 |  | BAT-075 | 쿠버네티스 기본 준비 프로브(10초·시간 초과 1초·연속 3회)로 이벤트 루프를 2초씩 막는 비교를 로컬 kind에서 돌려, Service에서 빠진 파드 수와 그 시각을 적는다(판정이 아니라 값의 근거 기록, docs/devops.md D-T19 ④). 결과 docs/review/measurements 폴더의 새 파일 `BAT-075-probes.md`. ①~③은 BAT-075 시험이다(2026-11-19 계획) |
| D-T33 ③ | 측정 |  | BAT-085 | 로컬 kind가 끌어오기 비밀 없이 공개 GHCR 이미지의 다이제스트를 받는지 잰다(예: Kyverno 이미지). 우리 패키지의 실제 익명 끌어오기는 첫 출시 후보 게시와 패키지 공개 설정(소유자 몫) 뒤로 미룬다(docs/devops.md D-T33, ADR-0318 결정 6). 결과 docs/review/measurements/BAT-085-ghcr.md. 2026-11-20 구현 시점에는 Docker/kind를 돌리지 않았다(시험·검증 담당 몫, Docker 잠금 필요). 2026-11-20 BAT-085 완료(R-717) 때도 재지 않았다: 검증 2의 kind e2e 5/5는 GHCR 익명 끌어오기를 넣지 않았고, 계획·감독 결정대로 첫 출시 뒤로 미룬다 |
| Q-T22 | 측정 |  | OPS-220 | 허니팟 정밀도 표본 검토(100건 [가정])의 정밀도 추정은 BAT-197에서 뺐다(새 `reviewKind`·원천·집계와 화면 상태가 필요해 따로 묶는다, 감독 결정 2026-11-21). OPS-220이 하한 측정과 함께 정한다 |

## BAT-085 완료(2026-11-20, R-717)

BAT-085(BAS-150)가 2026-11-20에 끝났다. 아래 항목의 상태·수는 바꾸지 않고 근거만 더한다(자동 시험 8·측정 1 그대로).

| 항목 | 근거 |
| --- | --- |
| D-T11 ② | kind e2e: 테스트 키로 서명한 로컬 이미지 입장, 서명 없음·다른 키·초기 컨테이너 서명 없음 거부(검증 2, `tools/local/e2e/kyverno.e2e.mjs`) |
| D-T18 ② | kind e2e: command·`NODE_OPTIONS`·`sh -c "node …"`·`--inspect` 다섯 사례 판정(검증 2) |
| D-T28 | `gitops-check --check`: prod 오버레이 렌더와 메시 필수 검사 통과(통과 2·건너뜀 3) |
| D-T32 ② | 단위 시험 GV-02·RV-05(빌드 잡 캐시 금지·release/hotfix `--no-cache`) |
| D-T32 ③ | 단위 시험 GV-03·GV-04(고정물). 실제 cosign 출력은 승격 이미지가 없어 첫 승격 PR에서 더 본다 |
| D-T33 ① | 정적 `GV-05 [ASVS v5.0.0-13.2.5]` + kind 데모 Audit 입장 |
| D-T33 ② | 정적 `GV-06` + kind 운영 Deny(GHCR·`peaket-evil`·다른 계정 ECR 거부, PEAKET ECR 입장) |
| delivery:v5.0.0-13.2.5 | `[ASVS v5.0.0-13.2.5]` 태그가 붙은 GV-05·GV-06 + 정책 적용 |
| D-T33 ③ | 측정은 미룸(첫 출시 뒤). 위 측정 표의 행 그대로 |

## 다른 단계

시범 범위 표에서 '다른 단계 몫'이던 행 가운데 S-T2는 옮기지 않았다. 불변식 검사기 시험(`services/invariant-checker`)이 이미 이름을 달고 있어 자동 시험이다.

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| C-T31 ③ | 다른 단계 | B | F-03-7(동결) | 동결(ADR-0373), 맡는 기능 없음. 입력 없음 뒤 '자동 조절 복귀 확인'을 받는 경로가 없다(F-03-4 계획 서버 빈칸) |
| C-T8 | 다른 단계 | B | F-03-7(동결) | 동결(ADR-0373), 맡는 기능 없음 |
| S-T19 | 측정 |  | BAT-090 heavy gate | 자동 배정 1,000건 동시·1순위 매진·분리 조합. 단위 시험은 후보·분리·수동 전환을 본다. 2026-11-13 측정: 100 동시×10묶음 1,000/1,000·중복 0·수동 0, 문자 그대로 1,000건 동시는 로컬 단일 Valkey 100ms 마감에서 503(무대 한계, 보고서 §5) |
| S-T20 | 측정 |  | BAT-090 heavy gate | 자동 배정 순서 공정성. 2026-11-13 측정: 같은 조건 순차 10건×2회 R0001~R0020 동일·굶주림 0(보고서 §6) |
| S-T22 | 다른 단계 |  | 미정 | 판매 종료 뒤 홀드 |
| S-T34 ①~③ | 다른 단계 |  | HOT-420·BAS-140 | 좌석맵 해석 작업 배포의 자격 증명·나가는 통신·메시 신원은 배포 상태(BAS-140)와 메시·NetworkPolicy(HOT-420, D-T36)가 정한다. 코드 몫(자격 증명 환경 값이 있으면 뜨지 않음)은 BAT-145가 [ASVS v5.0.0-15.2.5]로 시험한다(ADR-0257 결정 5) |
| P-T14 | 다른 단계 |  | 미정 | PG 시뮬레이터 전환 |
| P-T18 | 다른 단계 |  | 미정 | 공제율 산정 정확도 |
| P-T19 ② | 다른 단계 | A | GAT-300 | CS 처리함의 '취소 무효' 확정은 예외 환불과 같은 돈·티켓 상태 전이라 GAT-300이 만든다(2026-11-23 GAT-280에서 옮김, ADR-0364 결정 7). 건 열기·기한은 GAT-280(F-06-2)이다. ①③(마감 뒤 입장 기록 대조와 환급)은 GAT-090(BAT-420)의 시험 이름으로 정한다(2026-11-16 세부 나눔, docs/features/payment.md §11 P-T19) |
| P-T20 | 다른 단계 |  | 미정 | 회차 취소 일괄 환불 |
| P-T21 |  | A | GAT-080 | 취소 멱등성과 재시도. 2026-11-16 BAT-415 장부 범위로 옮겼다(감독 승인). 이제 이 묶음의 시험 이름(P-T21)으로 상태를 정하므로 '다른 단계'를 지우고 등급만 남긴다(docs/features/payment.md §4.1 '취소 건 기록과 기대 잔액') |
| P-T42 |  | A | LCH-010 | 굿즈 재고 예약 만료(core-svc shop). 2026-11-18 BAT-600 장부 범위로 옮겼다(계획 docs/review/plans/BAT-600.md). 이제 이 묶음의 시험 이름(P-T42)으로 상태를 정하므로 '다른 단계'를 지우고 등급만 남긴다 |
| P-T59 |  | A | LCH-030 | 택배 결제대금예치 결제(에스크로 상점·`escrowProducts`·`pg_store`, ADR-0313). BAT-605가 구현했고 시험 이름으로 상태를 정한다 |
| P-T60 |  | A | LCH-030 | 굿즈 가상계좌 입금 대기(O2~O4, 입금 기한·재고 연장·상태 표시, ADR-0314). BAT-605가 구현했고 시험 이름으로 상태를 정한다 |
| P-T61 |  | A | LCH-030 | 구매자 취소(I2·I16, 배송비·부분 취소·에스크로 전체 취소, ADR-0315). BAT-605가 구현했고 시험 이름으로 상태를 정한다 |
| P-T62 |  | A | LCH-030 | 구매자 반품 요청(I7~I10, 7일·3개월·LOCKED, ADR-0315). BAT-605가 구현했고 시험 이름으로 상태를 정한다 |
| P-T63 |  | A | LCH-030 | 굿즈 취소의 환불 계좌와 재인증(`SHOP_CANCEL_REFUND_ACCOUNT`, ADR-0293·0315). BAT-605가 구현했고 시험 이름으로 상태를 정한다 |
| P-T64 |  | A | LCH-030 | 굿즈 환급의 멱등·재시도·계좌 거절(취소 ID·`cancel-{ID}`·1→6시간, ADR-0315). BAT-605가 구현했고 시험 이름으로 상태를 정한다 |
| V-T35 ③ |  | A | LCH-030 | 부가 상품의 구매자 취소(연결 회차 입장 시작 전 전액 환급·공제 0, 뒤에는 409 `entry-started`). BAT-605가 구현했고 시험 이름으로 상태를 정한다. ①②(보유 확인·결제 금액 스냅샷)는 BAT-600이 시험 이름으로 정한다(ADR-0301 결정 6) |
| P-T49 ⑤⑥ | 다른 단계 |  | GAT-310 | `SetBookingRestriction`을 받는 쪽이 생기는 GAT-310 뒤에 본다(시범 범위 표의 끝 문단) |
| FE-T9 | 다른 단계 |  | 미정 | 이진 해독기 경계는 좌석맵 패키지 단계 몫이다. 시범에서는 서버와의 맞물림 시험만 더했다 |
| B-T6 ⑤ | 다른 단계 |  | OPS-290 | 서킷이 열리고 닫힐 때의 운영 사건 줄(`ops_event`)은 ops-svc 몫이다. queue-svc의 서킷 지표와 보안 로그는 BOT-050 시험이 본다(B-T6 ②) |
| B-T20 ⑩ | 다른 단계 |  | HOT-400 | `ApplyLabel`을 부르는 신원을 ops-svc로 줄이는 것은 메시 L7 허용 목록이다(identity-svc gRPC와 같다, docs/features/bot-defense.md §9 '첫 구현') |
| B-T21 ④ | 다른 단계 |  | OPS-220 | 분석의 봇 지표(F6 `fct_bot_outcome`)가 그림자 판정을 세지 않는 것은 분석 골드 사실을 만드는 단계에서 본다. trust-svc는 그림자 판정에 `shadow` true를 싣는다(B-T4) |
| B-T10 ⑦ | 다른 단계 |  | HOT-400 | 메시 L7 허용 목록이 `VerificationAppealService`를 부르는 신원을 ops-svc로 줄인다(B-T20 ⑩과 같다). queue-svc 처리기는 그 신원을 따로 보지 않는다(BAT-200 리뷰 뒤 정함, 2026-11-10, ADR-0259) |
| B-T15 ② | 다른 단계 |  | HOT-400 | `GetVerdictEvidence`를 부르는 신원을 ops-svc로 줄이는 것은 메시 L7 허용 목록이다(B-T20 ⑩과 같다, BAT-200에서 정함, 2026-11-10) |
| I-T56 ⑤ | 다른 단계 |  | HOT-400 | `CheckReverification`을 queue-svc 신원으로만 받는 것은 메시 L7 허용 목록이다(BAT-200에서 정함, 2026-11-10) |
| Q-T36 ⑦ | 다른 단계 |  | HOT-251 | 명단 사본(대기열 Redis)이 그 수명에 지워지는 것은 사본을 쓰는 core-svc 어댑터가 본다(소유자 결정 2026-11-10, OPEN[33] (가), ADR-0261 결정 9). 어댑터는 HOT-251(묶음 BAT-158)이 만든다. 사본에 넘기는 수명은 BAT-157의 Q-T36 ④가 본다(2026-11-10) |
| SR-T11 ② | 다른 단계 |  | HOT-450 | CloudFront 캐시 정책이 쿠키를 키에서 빼는지는 배포 구성 검사다. 입구 CDN 배포(HOT-450, 묶음 BAT-070) 몫이고 BAT-165 범위에서 뺐다(2026-11-16) |
| catalog-review:v5.0.0-1.3.9 | 해당 없음 |  | — | memcache를 쓰지 않는다. 자동완성은 core-svc 파드 메모리 사전에서 답하고 사용자 입력을 Redis 키로 쓰지 않는다(ADR-0094) |
| frontend:v5.0.0-3.4.4 | 다른 단계 |  | HOT-450 | 화면 앱은 `nosniff`를 보내지 않고 배포 응답 헤더 정책이 붙인다(docs/devops.md §6.6 '응답 보안 헤더 정책', `packages/config/headers/security-headers.mjs` 주석, 행의 '공통: delivery.md 판정'). 서비스 워커 스크립트(지금 `/serwist/sw.js`, 앱 서버 경로)와 `remoteEntry.js`(관제 정적 배포)도 같은 정책을 받는지는 CloudFront 캐시 동작별 응답 헤더 정책 몫이라 HOT-450 줄에 넘겼다. 게이트웨이 응답은 kind e2e(`tools/local/e2e/v0-deploy.e2e.mjs` BSL050)가 본다. BAT-170 웨이브 7에서 다시 판정(2026-11-16) |
| D-T18 ② | 다른 단계 |  | BAS-150 | `--disable-sigusr1`이 없는 Node 파드를 거부하는 Kyverno 정책은 Kyverno CEL 정책 단계(BUILD_ORDER BAS-150, 묶음 BAT-085)가 만든다. ①(주석으로 진단 수집)은 BAT-075 시험이다(2026-11-19 계획). BAT-085의 시험 담당이 D-T18 ②를 이름에 단 시험을 더하는 커밋에서 이 줄을 지운다 |
| C-T6 ① | 다른 단계 |  | BAT-365 | dry-run 센 값이 같은 시각의 원천(대기열 Redis·purchase DB·게이트웨이 집계)에서 직접 센 값과 같은지는 받는 쪽이 센 값을 주는 읽기 전용 `ControlReceiver.PreviewControl`이 생겨야 본다. 그 RPC(proto)와 받는 쪽은 OPS-300(묶음 BAT-365)이 만든다(감독 결정 2026-11-21, ADR-0340 결정 11). BAT-355는 `DryRunSource` 포트·기록·예측·비교와 `unavailable` 어댑터까지이고 ②③을 시험한다. BAT-365의 시험 담당이 C-T6 ①을 이름에 단 시험을 더하는 커밋에서 이 줄을 지운다 |
| delivery:v5.0.0-16.1.1 | 다른 단계 |  | INF-020 | 로그 목록은 docs/observability.md §9 보존 표와 docs/devops.md §10.4에 있다. 그 목록과 실제로 띄운 수집기 내보내기·Loki·Tempo 보존 설정이 맞는지는 그 설정을 만드는 구간 5 배포 묶음(ADR-0331 결정 9, ADR-0332)이 대조 시험으로 본다. 서비스 쪽 몫(정규 로그 줄)은 16.2.1·16.2.4가 본다(2026-11-22, BAT-215 계획) |
| delivery:v5.0.0-16.2.3 | 다른 단계 |  | INF-020 | 목록 밖으로 내보내지 않게 막는 것은 OTel 수집기 셋의 내보내기 설정과 그 정책 시험이다. 수집기는 배포 쪽(Helm·kind)이라 구간 5 배포 묶음이 만든다(ADR-0331 결정 9, ADR-0332 결정 7). BAT-215는 서비스가 표준 출력과 OTLP 말고 로그를 내보내지 않는지만 본다(2026-11-22, BAT-215 계획) |
| C-T75 ① | 다른 단계 |  | F-02-1(OPS-300, 옛 BAT-365) | `LOG_SAMPLING`을 내는 쪽은 ops-svc의 `control.settings` Outbox와 릴레이가 있어야 한다(asyncapi publishSettingChanged). ops-svc는 갈래 4 영역이고 갈래 1 마이그레이션 몫이 없어 생산은 미뤘다(감독 결정 2026-11-22, BAT-215 계획 감독에게 2 (나)). Outbox 표·릴레이는 갈래 4 BAT-360이 만들고, 온세일 구간의 `LOG_SAMPLING` 내기와 이 판정은 BAT-365가 한다. C-T75 ③의 생산 쪽 절반(겹친 구간에서 끝을 늦춘 사건을 한 번 더 냄)도 그 묶음이 본다. 생산 규칙은 ADR-0334 결정 3 |
| C-T75 ④ | 다른 단계 |  | F-02-1(OPS-300, 옛 BAT-365) | ops-svc 복제 둘이 같은 구간에 같은 `eventKey`를 내는지는 생산 쪽이 생겨야 본다(C-T75 ①과 같은 까닭). 소비 쪽 한 번만 적용은 BAT-215가 C-T75 ② 시험에서 본다 |

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
| C-T43 | 다른 단계 | B | LCH-100·운영 묶음(ops-svc 경보·감사·배포) | 수요 예측식·기본 비율·규모 올리기·T-30분·LARGE 간격·commander 예외는 core-svc 시험으로 확인했다. 남은 것은 화면의 '규모 올리기 검토', 상단 초과 SEV3(24시간 뒤 SEV2) 경보, 감사 로그, 변경 동결 달력 재계산(10분 안)이고 ops-svc 경보·감사·배포 단계와 LCH-100 정산 묶음 몫이다. BAT-620 장부 범위에서 뺐다(2026-11-22 배치, R-763) |
| D-T12 ② | 미검증 | B | BAT-202 | 조직 Actions 정책은 GitHub 조직 설정이라 저장소 시험으로 보지 못한다. 2026-11-10 조직 API에서 `sha_pinning_required: true`·허용 목록을 읽었지만 동작은 보지 않았다. 소유자가 `infra/stacks/global/github`의 `actions_patterns_allowed`(Scorecard 액션 더함)를 적용한 뒤 태그로 참조한 시험 워크플로가 실패하는지 한 번 보면 '사람 확인'으로 바꾼다(BAT-202 계획 7장 1·2) |
| SR-T15 ③ | 미검증 |  | AWS 계정 뒤(OPEN 후보) | Aurora 읽기 전용 복제본에서 `REPEATABLE READ` 읽기 전용 트랜잭션이 되는지는 AWS 계정과 클러스터 비용이 있어야 본다(소유자 자원 한도). 대역은 SR-T15 ②의 로컬 PostgreSQL 18 핫 스탠바이 통합 시험이다. BAT-165 범위에서 뺐다(2026-11-16) |
| C-T38 ② | 다른 단계 | B | 구간 5(인프라 구축, ADR-0332)·출시 전, BAT-365 넘김 | 실제 OpenTimestamps 캘린더로 찍고 몇 시간 뒤 비트코인 확정 증명으로 바꾸는 일은 밖으로 나가는 연결과 확정 시간이 있어야 본다. CI와 local 시험은 가짜 캘린더만 쓴다. 공개 위치에 거는 일은 소유자 몫이다. 구간 5 인프라·BAT-365 몫이고 BAT-360 장부 범위 밖이다(2026-11-22 BAT-360 계획·기록 R-751, ADR-0348 결정 5·6) |
| C-T61 ⑦ | 다른 단계 | B | 구간 5(인프라 구축, ADR-0332), BAT-365 넘김 | 작업의 마지막 성공 시각(kube-state-metrics `kube_cronjob_status_last_successful_time`)으로 내는 SEV2는 kind 클러스터와 경보 규칙이 있어야 본다. 구간 5 인프라·BAT-365 몫이고 BAT-360 장부 범위 밖이다(kind 보류, 2026-11-22 BAT-360 계획·기록 R-751) |
| C-T61 ⑧ | 다른 단계 | B | 구간 5(인프라 구축, ADR-0332), C-T58과 같은 정책 시험, BAT-365 넘김 | 작업 역할이 그 IP 집합의 읽기·갱신만 갖는지는 Terraform 정책 시험·IAM 정책 판정의 설계 검사이고 AWS 계정이 없다. 구간 5 인프라·BAT-365 몫이고 BAT-360 장부 범위 밖이다(2026-11-22 BAT-360 계획·기록 R-751) |

## 등급

원천 문서의 기본 등급(요구사항·정책은 B)을 ADR-0256 결정 10의 등급 뜻(A는 돈·좌석·대기 순번의 핵심 로직과 그 데이터의 복구)에 맞춰 바꾼 항목이다. 2026-11-10 결정 10으로 개인정보(NFR-018)와 법정 조치(POL-024)는 기본값 B로 돌렸다(표본에 꼭 넣는다).

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| V-T35 ①② |  | A |  | 티켓 보유 확인(권한)과 산 주문의 결제 금액·옵션 스냅샷(돈)이다(ADR-0301) |
| POL-007 |  | A |  | 대기열 인원의 기준(대기 순번) |
| I-T84 |  | A | BAT-010 | 탈퇴 미룸은 법정 파기 시점(개인정보)과 입금 대기 주문의 입금 전 취소(돈)에 닿는다(2026-11-18 BAT-010 계획, ADR-0284) |
| I-T26 |  | A | BAT-013 | 결제한 미사용 티켓의 취소·환급은 돈(공제·환급·이중 환급)에 닿는다(2026-11-19 BAT-013 계획, ADR-0284 결정 7) |
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
| P-T39 ① | 다른 단계 | A | PRF-170 | 발권 재시도·기한은 purchase-svc 실행기 몫이다(끝난 단계). |
| P-T39 ② | 다른 단계 | A | PRF-175 | CS 처리함 `TICKET_NOT_ISSUED` 건은 GAT-280의 CS 건 요청 계약 뒤에 연다(PRF-175). |
| P-T39 ③ |  | A | PRF-173 | 회차 취소 확정의 보상 세 걸음은 PRF-173이 만든다(BAT-011). ticket-svc는 `BlockTicketIssuance`로 발권을 막고, 이미 만든 티켓을 폐기한다. |
| P-T39 ④ | 다른 단계 | A | PRF-175 | 자동 재시도를 멈춘 `TICKET_NOT_ISSUED` 건은 GAT-280의 CS 건 요청 계약 뒤에 연다(PRF-175). |
| P-T39 ⑤ | 다른 단계 | A | PRF-170 | 승인 사건과 당기기를 함께 막는 불변식 SEV1은 PRF-170·PRF-171 몫이다(끝난 단계). |
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

## BAT-425(2026-11-20)

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| P-T76 |  | A | BAT-425 | 지연 환급 계좌 다시 받기의 새 시도 번호·`FAILED(SUPERSEDED)`·앞 진행 중 행 조회 닫기(ADR-0316). 돈이 나가는 이중 환불 가드라 A다. 정본 표는 `docs/features/payment.md` §11 P-T76이고 시험 이름으로 상태를 정한다. BAT-425 완료(2026-11-20, R-716). |
| P-T74 ③ |  | A | BAT-425 | 지연 환급 계좌·배상 계좌의 은행 코드 26개 허용 목록(목록 밖 `99`는 400). 돈이 나갈 계좌를 가리는 입력이라 A다. 정본은 `docs/features/payment.md` §11 P-T74 ③(2026-11-20 고침). BAT-425 완료(2026-11-20, R-716). |
| P-T63 ③ |  | A | BAT-425 | 굿즈 지연 환급 계좌의 같은 26개 허용 목록(목록 밖 400, 계좌 거절은 422·새 행 `REJECTED`). 정본은 `docs/features/transfer-refund.md` §11 P-T63 ③(2026-11-20 고침). BAT-425 완료(2026-11-20, R-716). |
| R-T42 |  | A | BAT-425 | 예매 취소의 지연 환급 계좌 다시 받기(본인·계좌 대기·시도 상한·재인증 `REFUND_ACCOUNT`·계좌 미저장·시도별 멱등키). 돈이 나가는 환급 경로라 A다. 정본 표는 `docs/features/transfer-refund.md` §11 R-T42이고 시험 이름으로 상태를 정한다(ADR-0316). BAT-425 완료(2026-11-20, R-716). |
| R-T43 |  | A | BAT-425 | 굿즈 취소의 지연 환급 계좌 다시 받기(core-svc shop 새 경로·새 `merch_refund` 행·`SHOP_CANCEL_REFUND_ACCOUNT`). 돈이 나가는 환급 경로라 A다. 정본은 `docs/features/transfer-refund.md` §11 R-T43(ADR-0315·0316). BAT-425 완료(2026-11-20, R-716). |
| R-T45 |  | B | BAT-425 | 일괄 환불 자동 정지의 결제사 서킷 연결(10초 캐시·`open`만 멈춤·읽기 실패는 계속). 환급을 멈추는 운영 동작이라 B다. 정본은 `docs/features/transfer-refund.md` §11 R-T45. BAT-425 완료(2026-11-20, R-716). |
| R-T46 |  | A | BAT-425 | 배상 대상 행·목록(주문 단위 10%·원 미만 올림, 결제자 본인만, 계좌 끝 4자리만). 금액과 개인정보에 닿아 A다. 정본은 `docs/features/transfer-refund.md` §11 R-T46(ADR-0317). BAT-425 완료(2026-11-20, R-716). |
| R-T47 |  | A | BAT-425 | 배상 계좌 입력·송금(재인증 `COMPENSATION_ACCOUNT`, `UNAVAILABLE` 503, `FAILED` 422·CS `COMPENSATION_PENDING`). 돈이 나가는 송금 경로라 A다. 정본은 `docs/features/transfer-refund.md` §11 R-T47(ADR-0317). BAT-425 완료(2026-11-20, R-716). |
| J-T28 |  | A | BAT-425 | 배상금 미리 지급의 `COMPENSATION_ADVANCE` 미수금 생성·결제사 무관 상계·이중 상계 금지. 파트너 정산 금액에 닿아 A다. 정본은 `docs/features/settlement.md` §13 J-T28(ADR-0317). BAT-425 완료(2026-11-20, R-716). |

- ASVS 여덟 행(transfer-refund 2.3.3·2.3.4·8.2.2·8.2.3·16.2.5, payment 2.3.4·8.2.3·16.2.5)은 구현 위치가 이미 있고, 새 시험이 같은 태그를 달아 근거를 더한다(2026-11-20 B·기록 담당 확인. RV-15에 따라 '여섯'을 '여덟'으로 고침). P-T74 ③·P-T63 ③은 기존 시나리오의 세부 번호를 고친 것이라 같은 줄에 적는다.
- **BAT-425가 닫은 장부 항목(2026-11-20, R-716)**: GAT-120의 자동 정지 서킷 연결을 BAT-425가 끝냈다. R-T9의 '서킷 열림이면 그 몫만 멈춘다' 갈래는 `services/purchase-svc/test/pg-circuits.test.ts`(R-T45)와 `services/purchase-svc/test/event-refund-gat130.test.ts`(R-T9)가 보고, R-T22의 수동 일시정지·재개는 기존 시험이 그대로 본다. 이 절 표의 아홉 항목은 시험 이름으로 상태를 정하므로 상태 칸은 비워 두고 근거만 더했다(항목 수·상태는 바꾸지 않았다).
- **R-T43 구현 몫(core-svc shop, 2026-11-20 C)**: core 0032가 `merch_refund.replaces_refund_id`(자기 참조, nullable)와 부분 유일 인덱스 `merch_refund_replaces_uq`(`replaces_refund_id is not null`)를 더하고, 멱등 작업 목록에 `SHOP_CANCEL_REFUND_ACCOUNT`를 넣었다. `MerchRefundAccount`는 주문 행 잠금 안에서 사슬 끝 행을 다시 보고 새 행·새 항목 자리·멱등 기록을 커밋한 뒤 새 취소 ID·시도 번호(`refund_attempt`)로 `CancelPayment`를 부른다. 시험은 R-T43 ①~③이 시험 담당 몫이고, 이 줄은 구현 위치만 남긴다.
## BAT-615 계약 조건·수수료율(2026-11-20)

| ID | 상태 | 등급 | 담당 | 근거·이유 |
| --- | --- | --- | --- | --- |
| J-T29 | 자동 시험 | B | core-svc·ops-svc 승인 업무·SCR-065 | 계약 조건 저장·기간 이력·2인 승인·반려·철회·동시 요청을 `services/core-svc/test/ops-promoter.http.test.ts`·`services/ops-svc/test/contract-approval.test.ts`·`services/ops-svc/test/approval-visibility.test.ts`가 보고, 실제 PostgreSQL 부분 유일 인덱스·계약 기간 겹침은 `services/ops-svc/test-int/approval-request.int.test.ts`·`services/core-svc/test-int/promoter-contract.int.test.ts`가 본다. J-T29 ⑨의 장애 주입(감사·core 적용)은 단위 시험이 맡는다. BAT-615 완료(2026-11-20, R-719). |
| J-T30 | 자동 시험 | B | core-svc 판매 승인·상품·payment-svc 정산 | 첫 승인·재승인의 수수료율 고정과 설정 사본·대기열 사본을 `services/core-svc/test/product-commission.test.ts`·`services/core-svc/test-int/promoter-contract.int.test.ts`가, 상품 게시 원천을 같은 두 파일이, 회차 정산이 503으로 닫히지 않는 길을 `services/payment-svc/test/settlement.test.ts`가 본다. 기존 파트너 백필·기간 겹침은 `services/core-svc/test-int/promoter-contract.int.test.ts`가 본다. BAT-615 완료(2026-11-20, R-719). |
| settlement:v5.0.0-2.3.3 | 자동 시험 | B | core-svc 계약 적용·ops-svc 승인 | 승인 상태·투표·감사와 계약 기간·현재 값·대기 표시를 같은 트랜잭션에 쓰고 같은 승인 ID로 멱등을 맞춘다. 시험 이름에 `[ASVS v5.0.0-2.3.3]`을 단다(J-T29 ⑨, J-T30 ①~③). BAT-615 완료(2026-11-20, R-719). |
| settlement:v5.0.0-2.3.4 | 자동 시험 | B | core-svc 계약 기간·ops-svc 부분 유일 | 한 파트너에 열린 변경 하나(core 대기 ID + ops 부분 유일 인덱스)와 기간 겹침 없음(`WITHOUT OVERLAPS`)을 동시 요청·동시 승인 시험이 본다. 시험 이름에 `[ASVS v5.0.0-2.3.4]`을 단다(J-T29 ④ ⑨, J-T30 ⑤). BAT-615 완료(2026-11-20, R-719). |
| settlement:v5.0.0-8.2.2 | 자동 시험 | B | core-svc 관제 경로 | 계약 승인 상세는 요청자·commander만, 파트너사 상세는 viewer 403·CS 읽기다. 시험 이름에 `[ASVS v5.0.0-8.2.2]`을 단다(J-T29 ⑦ ⑧). BAT-615 완료(2026-11-20, R-719). |
| settlement:v5.0.0-8.2.3 | 자동 시험 | B | core-svc 관제 경로 | 응답에 계좌번호 전체·토스 셀러 ID·포트원 파트너 ID가 없고 `payoutAccount`는 null이다. 시험 이름에 `[ASVS v5.0.0-8.2.3]`을 단다(J-T29 ⑧). BAT-615 완료(2026-11-20, R-719). |

## BAT-086 V-T7(2026-11-21 구현·시험)

V-T7(빈 PC에서 데모 재현 스크립트 실행 — 한 명령으로 시연 흐름이 뜨고 걸린 시간이 기록된다)의 상태는 `자동 시험`이다. `tools/local/demo.test.mjs`에 `V-T7 ①`~`V-T7 ⑦`·`DM-08`·`DM-09`·`CP-01` 이름으로 29개 시험(리뷰 반영 RV-01·02·03·05·09·10·11 시험과 `Finding: V-T7-seed-seatmap` 시험 포함)을 두었고, `tools/local/demo-seed.test.mjs`에 좌석맵 판 파일 모양·경로를 보는 시험 2개를 더했다. `node tools/ci/ledger.mjs --batch BAT-086 --require`가 통과한다. 실제 kind 재생은 `node tools/local/demo.mjs all --skip-build`로 S1~S9 9/9이고(좌석맵 고침 뒤 2026-11-21, purchase `event_sale` 7행·`/tmp/seatmaps` 파일 7개) 측정은 `docs/review/measurements/BAT-086-demo.md`(실행별 `BAT-086-demo-<runId>.md`도 함께)에 있다. D-T48은 시연만 하고 장부 범위에 넣지 않았다(`docs/review/ledger/devops.md:125`). BAT-086 완료(2026-11-21, R-729).

| 항목 | 시험 이름·근거 |
| --- | --- |
| V-T7 ①(시나리오 정의) | `tools/local/demo.test.mjs`의 `V-T7 ① ...` 네 시험. `validateScenarios`·`publicPlan`이 정본 d5 §10.6과 화면 순서·필수 checks(S1·S3·S7·S8·S9)·`evidenceOnlyScreens`를 대조하고, 시나리오를 빼거나 화면 순서·증거 화면 이름을 바꾸면 실패한다. `node tools/local/demo.mjs plan --check`. 공용 게이트웨이 출처가 화면 하나인지, 데모 패치만 gw-fan에 대기실·스캐너 출처를 더하는지도 본다(RV-01) |
| V-T7 ②(선행 없으면 닫힌 실패) | `V-T7 ② ...` 세 시험. 가짜 뿌리에서 시드·이미지 목록·오버레이·Playwright 패키지·chromium 실행 파일·도구가 하나씩 빠질 때 exit 1, 빠진 경로·이름을 모두 나열하고 클러스터 명령 0회(RV-09) |
| V-T7 ③(조용한 건너뛰기 없음) | `V-T7 ③ ...` 두 시험. 가짜 `node:child_process`가 파드 미준비를 돌려주면 `play` exit 1·`pods-not-ready`·시나리오 결과 없음, 모르는 시나리오·인자 exit 2 |
| V-T7 ④(빈 PC 한 명령 재생) | `V-T7 ④ ...` 여덟 시험. 측정 파일 9/9·콜드 스타트·정리, 재생기의 S2 매진 픽스처·S7 맥락 둘·S8 기기 키 보존·S9 2인 승인·깨끗한 빌드 build-arg, all 시작~첫 화면 콜드 스타트 값(RV-02), 필수 화면 방문 실패=시나리오 실패·`ticket-qr` 화면 QR 요소(RV-05). 실제 실행은 `docs/review/measurements/BAT-086-demo.md`, 실제 all e2e는 검증 담당이 실행한다 |
| V-T7 ⑤(두 번 돌리기·정리) | `V-T7 ⑤ ...` 두 시험. `up`의 무대 재사용, `down`의 데모 네임스페이스+kind 클러스터 삭제·`--keep-cluster`, 다른 클러스터 보존, `all --keep` exit 0·정리 실패는 `통과(정리 실패)`(RV-03). 시드 멱등은 `demo-seed.test.mjs` DS-06 |
| V-T7 ⑥(비밀·개인정보 없음) | `V-T7 ⑥ ...` 시험. 시드 `checkSeed`(비밀 값 칸·실제 이메일·전화번호 0), `redact`가 Bearer·password·TOTP·JWT·세션 쿠키를 가림, `plan`·`doctor` 출력에 비밀 값 0 |
| V-T7 ⑦(측정 기록) | `V-T7 ⑦ ...` 네 시험. 성공·실패 측정의 커밋·콜드 스타트·전체 시간·시나리오별 결과·실패 단계·정리, 선행 없음 `all`이 `결과: 실패(선행 없음)`와 미실행을 남김, 0건 실행은 `건너뜀`(RV-10), 실행별 측정 파일 분리(RV-11) |
| DM-08·DM-09(D-T48 시연) | `DM-08 ...`·`DM-09 ...` 시험과 실제 `node tools/local/demo.mjs compat`. 같은 커밋 0, `v0.0.0` 태그와 견주면 응답 필드(`type`) 삭제로 1, 도구 오류(exit 2)는 통과 아님, 복제본 밖 태그 그대로. 결과 `docs/review/measurements/BAT-086-compat.md` |
| CP-01(클라우드 값) | `CP-01 ...` 시험과 `node tools/local/demo.mjs cloud-plan --check`. TTL 6시간·예산 딱 경계 통과·1원 초과 실패·정리 여섯 항목 누락 실패·서명 GHCR·실행 없음 |

## BAT-182 완료(2026-11-20, R-721)

BAT-182(HOT-357)가 2026-11-20에 끝났다. 아래 항목의 상태·수는 바꾸지 않고 근거만 더한다(자동 시험 4·다른 단계 0, 등급 A 3·B 1 그대로). 네 항목 모두 시험 이름이 상태를 정하는 자동 시험이라 상태 칸은 두지 않는다.

| 항목 | 근거 |
| --- | --- |
| FE-T11 | 화면 배선 시험을 더했다: `packages/seatmap/test/stream-worker.test.ts`(T1~T6), `apps/web/src/_pages/seats/{model/connection-view,ui/seat-stream-wiring}.test.mjs`(T8), `apps/web/scripts/mock-api.test.mjs`(T12). 기존 연결·갭·재시도·상태 기계 시험은 그대로다. seatmap 128·web 1,010 통과. BAT-182 완료(2026-11-20, R-721). |
| S-T13 | `packages/seatmap/test/s-t13-gap.test.ts`(T7): 버전 갭 3,000번, 실패 0, 가장 느린 회복 2,650ms(한도 30,000ms), 503 주입 21번, 정확 이항 단측 95% 상한 0.0998%(판정 0.0999% 이하). 측정 근거는 `docs/review/measurements/BAT-182-wave.md` §2. A등급이라 M5(갭 스냅샷 요청 0)로 틀린 구현도 확인했다. BAT-182 완료(2026-11-20, R-721). |
| S-T21 | `tools/web-checks/seats/s-t21.spec.mjs`(T9·T10): 5만 석에서 전체 보기 0·확대 1·옆 구역 이동 1(A 빠짐)·축소 0구독, p99 20~44.6ms(판정 300ms 이하, 표본 100), Long Task 0, 전체 보기 4,999ms 요청 0·5,000ms 1. 측정 근거는 `docs/review/measurements/BAT-182-wave.md` §4. BAT-182 완료(2026-11-20, R-721). |
| S-T31 ⑥ | 같은 화면 시나리오(T11): 최대 구독 1(상한 16), 4403·4429·1013·1009 닫힘 0, `TimeSync` 1(연결 직후, 다음 60초), `BatchInterval` 100 유지. 서버는 Docker 없는 realtime-gw 대역이고 Chromium 1엔진이다. 측정 근거는 `docs/review/measurements/BAT-182-wave.md` §4. BAT-182 완료(2026-11-20, R-721). |

## BAT-045(2026-11-20)

- **장부 범위**: 이 묶음은 BUILD_ORDER BAT-045 행의 범위를 `I-T46 ④⑤, I-T52 ①②③, I-T53 ②③⑤, I-T61 ①~④, AZ-T14 ①~⑥, C-T69, auth:v5.0.0-7.4.5, auth:v5.0.0-7.5.1, auth:v5.0.0-8.2.1, auth:v5.0.0-8.2.2, auth:v5.0.0-8.2.3, auth:v5.0.0-9.2.2`로 좁혔다. `Batch-Order: impl-first`라 구현 커밋에는 시험이 없고, `ledger --batch BAT-045`가 시험 전 '다른 단계'로 남는 것은 정상이다. 시험 담당(다음 커밋)이 시험 이름에 ID·세부 번호와 ASVS 태그를 달면 상태가 자동·ID만으로 정해진다.
- **ASVS 여섯 행**(auth 7.4.5·7.5.1·8.2.1·8.2.2·8.2.3·9.2.2)은 구현 위치를 채웠고, 결과 칸은 시험 담당이 채운다. delivery 15.2.1·16.3.1·16.3.2도 DAST·관리 계정 감사·허용 IP 거절 기록을 더했다.
- **남은 몫**: I-T46 ④·I-T52 ②는 기존 `csrf`가 있어 구현 전 트리에서도 통과할 수 있고, I-T52 ③은 파트너 앱 정적 시험, AZ-T14 ⑦은 doc-check `roles` 규칙이 이미 본다(장부 범위 밖). BOT-140의 AWS 자원과 BOT-152의 초대 수락·SCR-064 화면, BOT-161의 데모·운영 실제 점검은 다른 묶음·소유자 몫이고, BOT-140·152·161 줄은 '끝'으로 체크하지 않았다.
- **시험(2026-11-20, `ses_pending_test_bat045`)**: 장부 25항목이 모두 `자동 시험`이다. 파일: `deploy/gateways/test/admin-auth.test.mjs`(9), `services/ops-svc/test/admin-reauth.test.ts`(5)·`admin-command-reauth.test.ts`(4)·`admin-accounts-authz.test.ts`(8), `services/identity-svc/test/admin-session-termination.test.ts`(4), `apps/partner/src/_pages/partner-auth/no-authjs-cookies.test.mjs`(2), `tools/ci/dast-gate.test.mjs`(6)·`scan-tools.test.mjs`(ZAP 4 추가)·`check-workflows.test.mjs`(BOT-161 5 추가), kind `tools/local/e2e/gateway-admin-auth.e2e.mjs`·`dast.e2e.mjs`, 통합 `services/ops-svc/test-int/admin-accounts.int.test.ts`(3). 기존 `commands-http`·`command-execution-http`·`event-cancellations-http`와 ops `test-int` 여섯 파일에 `X-Reauth-Token`(act=OPS_COMMAND)을 붙였고, `identity-svc/test-int/admin-account-management.int.test.ts`에 AZ-T14 ④, `admin-designation.test.ts`에 C-T69, `admin-account-http.test.ts`에 AZ-T14 ⑥ 이름을 달았다.
- **시험 결과**: ops 단위 309, identity 단위 673, partner 187, ops 통합 98, identity 통합 191, tools/ci 네 파일 117 통과. `ledger --batch BAT-045 --require`, typecheck, lint, doc-check(오류 0) 통과. `trace-check`는 I-T52·I-T53·I-T61·AZ-T14·C-T69 58개 통과, **I-T46만 없음**.
- **남은 결함(제품, 시험 담당이 고치지 않음)**: ① 게이트웨이 수준 `EnvoyExtensionPolicy`의 `filterContext`(`requireOriginVerify`·`opsAllowedIpsEnv`·`refreshCookie`)가 라우트 수준 정책에 덮여 `/v1/ops/commands`·`/v1/partner/events/...`에 적용되지 않는다(kind 8개 중 6개 실패, 공개 로그인 라우트는 통과). ② Envoy csrf가 끝 슬래시 `Origin: https://console.peaket.example/`을 같은 출처로 본다. ③ `route-contract.test.mjs`의 `/v1/ops/auth/sessions/me`는 문서·처리기가 ops-svc인데 라우트 원천이 identity-svc다(시험에 표류로 기록, BAT-425 배상 경로 4건도 이 묶음 전부터 표류). ④ DAST e2e 미끼 점검은 Docker Desktop에서 Windows 호스트 127.0.0.1에 ZAP 컨테이너가 닿지 못해 종료 코드 3이다(미끼 없이 www 직접 점검은 High 0·Low 2·Info 2). Linux CI 야간 점검은 이 환경 문제가 없다.
- **리뷰 반영(2026-11-21, `ses_pending_fix2_test_bat045`·`ses_pending_fix2_impl_bat045`)**: 위 ①②③은 구현 고침 커밋(`fix(gateways,ops)`)에서 고쳤고 kind `gateway-admin-auth.e2e.mjs`가 8/8로 확인됐다. 리뷰 지적 RV-01(개발 위로 다시 쌓기·approval_request ALTER 병합)·RV-02(gRPC 오류→404·400·503)·RV-03(승인 412·409·감사 일관성)·RV-04(Idempotency-Key 필수·본문 해시)·RV-05(재삭제 200)·RV-06(FAILED 재승인)·RV-07(초대 역할 선검사)·RV-08(배포 JWKS·Redis·시작 실패)·RV-09(세션 종료 PostgreSQL 시험)을 고쳤다. ④(DAST e2e Docker Desktop 환경)만 남는다.


## BAT-045 완료(2026-11-21, R-722)

BAT-045(BOT-132·BOT-140·BOT-152·BOT-161)가 2026-11-21에 끝났다. 아래 항목의 상태·수는 바꾸지 않고 근거만 더한다(자동 시험 25·다른 단계 0 그대로). 여섯 항목 모두 시험 이름이 상태를 정하는 자동 시험이라 상태 칸은 두지 않는다.

| 항목 | 근거 |
| --- | --- |
| I-T46 ④⑤ | kind `tools/local/e2e/gateway-admin-auth.e2e.mjs`가 다른 출처·빈 값·`null`·다른 콘솔·끝 슬래시 `Origin`을 403으로 막고, 갱신 경로 밖에서 `__Host-peaket_ops_rt`를 지우면서 `at`는 남기며(Cookie 머리 둘·큰따옴표·빈칸 포함), 파트너 `rt`도 갱신 경로 밖에서 빠지는 것을 본다. 정적 `deploy/gateways/test/admin-auth.test.mjs`(I-T46 ⑤·W-02)가 같은 규칙을 본다. `trace-check` I-T46 4 통과. BAT-045 완료(2026-11-21, R-722). |
| I-T52 ①②③ | kind I-T52 ①②가 파트너 로그인 응답의 `Set-Cookie` 둘을 그대로 넘기고 본문 토큰 0·`Cache-Control: no-store`이며, 운영자·파트너 로그인의 `Origin` 다섯 상태를 403/통과로 가른다. `apps/partner/src/_pages/partner-auth/no-authjs-cookies.test.mjs` 2건이 Auth.js·`authjs.*` 쿠키 0과 쿠키 이름 둘만을 본다. `trace-check` I-T52 4 통과. BAT-045 완료(2026-11-21, R-722). |
| I-T53 ②③⑤ | `services/ops-svc/test/admin-reauth.test.ts` 5건이 패스키 없는 토큰을 403 `reauth-required`로 막고 identity·감사 0을 확인하며 act·sid·aud·exp·typ과 같은 `jti` 재사용 403·`503` Retry-After를 본다. `admin-command-reauth.test.ts` 4건이 위험 명령 셋(킬스위치·`BLOCK_ASN_IP`·`SALE_STOP`)의 재인증과 `LOG_LEVEL` 201·승인·재시도를 본다. `trace-check` I-T53 9 통과. BAT-045 완료(2026-11-21, R-722). |
| I-T61 ①~④ | `services/identity-svc/test/admin-session-termination.test.ts` 4건과 `test-int/admin-session-termination.int.test.ts` 3건이 전체/하나 종료, `ended_count`·가드 401·`ADMIN_FORCE` 사건, 남의·없는 세션 404, 같은 `request_id` 멱등, 계정 상태 불변을 본다. ops `admin-accounts-authz.test.ts`의 I-T61 ④가 viewer 403·identity 0, operator·commander 204를 본다. `trace-check` I-T61 8 통과. BAT-045 완료(2026-11-21, R-722). |
| AZ-T14 ①~⑥ | ops `admin-accounts-authz.test.ts`·`admin-accounts-regressions.test.ts`가 viewer·CS의 11경로 403, operator의 관제·CS 계정 변경 403(identity 호출 0), 자기 지정 403·commander 아닌 대상 422, 세션 강제 종료 권한을 본다. identity 통합이 지정을 거둔 직후 분석 경로 403(AZ-T14 ④)과 A 파트너 계정만·이메일 가림(AZ-T14 ⑥)을 본다. ⑦은 장부 범위 밖이고 doc-check `roles` 규칙이 본다. `trace-check` AZ-T14 13 통과. BAT-045 완료(2026-11-21, R-722). |
| C-T69 | identity 통합이 `FRAUD_INVESTIGATOR`·`PSEUDONYM_HANDLER` 충돌 두 순서를 422로 거절하고 `cs_lead` 역할 변경 때 같은 트랜잭션에서 지정을 거두는 것을 본다. ops가 identity의 `DESIGNATION_CONFLICT`·`DESIGNATION_TARGET_NOT_ELIGIBLE`을 409·422 Problem으로 바꾸고 감사 `FAILED` 1·성공 내역 0을 남기는 것을 같은 장부 범위에서 본다. `trace-check` C-T69 2 통과. BAT-045 완료(2026-11-21, R-722). |

- 위 `## BAT-045(2026-11-20)` 절의 "`trace-check`는 … I-T46만 없음"은 시험 담당 때 상태다. 리뷰 반영(RV-01~09) 뒤 검증에서 I-T46 4를 포함한 6개 ID·68시험이 통과했고, 이 절이 그 근거다(RV-14). 항목 수·상태는 바꾸지 않았다.
## BAT-421 완료(2026-11-21, R-723)

BAT-421(SCR-038·SCR-044·SCR-047 화면 잇기, 갈래 2)이 2026-11-21에 끝났다. 아래 두 항목의 상태·수는 바꾸지 않고 근거만 더한다(자동 시험 2, B 2 그대로).

| 항목 | 근거 |
| --- | --- |
| transfer-refund:v5.0.0-3.2.2 | 세 화면이 서버·사용자 글(공연명·사유·증빙 참조·반려·판정·팬 통지 사유·미리보기 숫자)을 React 텍스트 노드로만 그리고 `dangerouslySetInnerHTML`·`innerHTML`을 쓰지 않는 것을 `[ASVS v5.0.0-3.2.2] SCR038_견적·결과·오류는_서버_글을_텍스트로만_그린다`·`[ASVS v5.0.0-3.2.2] SCR044_사유·증명·반려_사유는_텍스트로만_그린다`·`[ASVS v5.0.0-3.2.2] SCR047_파트너_사유·판정_사유·미리보기_숫자는_텍스트로만_그린다`·`[ASVS v5.0.0-3.2.2] SCR047_서버_글은_텍스트로만_그리고_모르는_값은_알_수_없음으로_둔다`가 본다. 모르는 칸·모양 틀린 값은 버리고(`previewOf`·`detailView`), 계좌번호는 입력 칸 밖(URL·저장소·로그·HTML)으로 내지 않는다(M7 주입이 `SCR038_계좌_칸은_재인증_뒤에_견적이_필요할_때만_보이고_본문에만_실린다`에 잡힘). BAT-421 완료(2026-11-21, R-723). |
| transfer-refund:v5.0.0-3.5.3 | 취소·회차 취소 요청·판정·확정·재인증은 POST만 쓰고 GET(견적·티켓·파트너 상태·관제 상세·목록)은 읽기 전용인 것을 `[ASVS v5.0.0-3.5.3] SCR038_취소는_POST로만_보낸다`·`SCR044_요청은_POST·상태는_GET이고_멱등키를_보낸다`·`[ASVS v5.0.0-3.5.3] SCR047_판정·확정은_POST·조회는_GET이다`가 본다. ASVS 3.5.3 구현 위치에 세 앱 경로를 더했다(감독 결정 8). `trace-check`가 두 ID 각각 통과 3, 시험 41개 대조로 통과했다. BAT-421 완료(2026-11-21, R-723). |

## BAT-197 완료(2026-11-21, R-725)

BAT-197(BOT-080의 REST·화면 몫)이 2026-11-21에 끝났다. 아래 FR-049와 ASVS 여섯 행의 상태·수는 바꾸지 않고 근거만 더한다(장부 29항목: 자동 시험 28·측정 1 그대로). BOT-080 단계 줄은 표본 후보 원장(OPS-220)과 운영 표본 배정이 남아 체크하지 않았다.

| 항목 | 근거 |
| --- | --- |
| FR-049 | ops-svc `bot-review` 모듈이 REST 3경로(진행·목록·판정)를 내고, `cs_agent`·`cs_lead`만 부르며 viewer·operator·commander는 403이다. 판정은 HUMAN·BOT만 `ApplyLabel`(SAMPLE_REVIEW·판 1·묶음·적용 판정·판정 사건 키)을 부르고 UNDECIDED는 부르지 않으며, 실패는 503이고 판정 행을 쓰지 않는다. 같은 표본 두 번째 판정은 409, 같은 `Idempotency-Key` 재시도는 같은 200이고, 표본 단위 선점으로 동시 두 판정은 200 하나·409 하나·판정 행 1·ApplyLabel 1이다. 진행은 UNDECIDED를 뺀 BOT 비율의 Wilson 95%, 0건이면 null이고 30일·7일 기한을 넘으면 410이다. 배정은 200+200을 섞고 모집단이 작으면 전수하며 같은 회차·종류에 두 번 돌려도 하나다. 시험은 `services/ops-svc/test/bot-review-http.test.ts` 13·`bot-review-progress.test.ts` 5·`bot-review-judgement.test.ts` 9·`bot-review-assign.test.ts` 4, 통합 `test-int/bot-review.int.test.ts` 8·`bot-review-label.int.test.ts` 4·`bot-review-wiring.int.test.ts` 3(15/15), 화면 `apps/console-host/src/pages/bot-review/model/review.test.mjs` 4·`ui/wiring.test.mjs` 5다. 장부 `ledger --batch BAT-197 --require`가 29항목(자동 시험 28·측정 1·ID만 0·빈칸 0)으로 통과했고, 허니팟 정밀도 표본 검토(Q-T22)는 OPS-220 측정 행 그대로다. BAT-197 완료(2026-11-21, R-725). |
| ASVS 3.2.1 | `services/ops-svc/test/bot-review-http.test.ts`의 `[ASVS v5.0.0-3.2.1] 표본 검토 응답은 JSON뿐이고 다른 형식은 415·400이다`가 진행·목록·판정 응답의 형식과 415·400을 본다. BAT-197 완료(2026-11-21, R-725). |
| ASVS 3.2.2 | `apps/console-host/src/pages/bot-review/ui/wiring.test.mjs`의 `[ASVS v5.0.0-3.2.2] 카드의 세션 가명·범주·타임라인은 글자 노드로만 그린다`가 카드 값이 `innerHTML`이 아니라 글자 노드로만 그려지는 것을 본다. BAT-197 완료(2026-11-21, R-725). |
| ASVS 3.4.3 | `packages/config/headers/headers.test.mjs`의 `[ASVS v5.0.0-3.4.3] 관제 콘솔 CSP(C 묶음)가 /bot-review에도 적용되고 관제 API만 연결한다`가 `/bot-review` 라우트의 CSP를 본다(11건 가운데 새 사례). 실제 브라우저의 위반 보고 0은 로컬 스택이 없어 확인하지 못했고 `docs/review/browser-check/BOT-080.md`의 미확인 그대로다. BAT-197 완료(2026-11-21, R-725). |
| ASVS 3.5.3 | `services/ops-svc/test/bot-review-http.test.ts`의 `[ASVS v5.0.0-3.5.3] 판정은 POST만 받고 GET·HEAD로는 바꿀 수 없다`가 판정 경로의 POST만 허용과 GET·HEAD 거절을 본다. BAT-197 완료(2026-11-21, R-725). |
| ASVS 16.3.3 | `services/ops-svc/test/bot-review-judgement.test.ts`의 `[ASVS v5.0.0-16.3.3] 판정과 라벨 반영 결과를 보안 로그 줄로 남기고 pid·기기 가명은 싣지 않는다`가 판정·라벨 로그 줄과 가림을 본다. BAT-197 완료(2026-11-21, R-725). |
| ASVS 16.3.4 | `services/ops-svc/test/bot-review-judgement.test.ts`의 `[ASVS v5.0.0-16.3.4] 라벨 실패와 원천 실패를 지표·경고 줄로 남긴다`가 `ops_bot_review_label_failures_total`과 경고 로그 줄을 본다. BAT-197 완료(2026-11-21, R-725). |
## BAT-616 판매 승인 요청·판매 열기(2026-11-20)

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| S-T41 |  | A | BAT-616·BAT-617 | 판매 승인 요청·변경 취소·반려 사유·관제 목록·상세는 `services/core-svc/test/sale-review-request.http.test.ts`·`services/core-svc/test/ops-sale-review.http.test.ts`(메모리)와 `services/core-svc/test-int/sale-review-db.int.test.ts`(실제 PostgreSQL 0034·0044)가, 승인 뒤 판매 열기·대기열 사본·CDN은 `services/core-svc/test-int/sale-open.int.test.ts`·`services/core-svc/test-int/queue-sale-config.int.test.ts`(실제 PostgreSQL·Valkey)가, purchase의 UPCOMING·`seat_rebuild` 판 1·비트맵·세대 키·오픈 경계·503은 `services/purchase-svc/test-int/sale-open.int.test.ts`(실제 PostgreSQL·Valkey)가, BAT-051 회귀는 `services/purchase-svc/test-int/seat-store.int.test.ts`가 본다. 화면 ⑫는 `apps/partner/src/_pages/event-wizard/model/sale-review-live.test.mjs`·`ui/wiring.test.mjs`와 `apps/console-host/src/pages/sale-review/model/sale-review.test.mjs`·`ui/wiring.test.mjs`, 계약은 `packages/api-client/test/sale-review-contract.test.ts`가 본다. S-T41은 seat-hold 장부에서 A라 판매 열기·UPCOMING·세대 키에 A 증명(장애 주입·경계)을 붙인다. 시험 이름에 `S-T41 ①`~`S-T41 ⑫`과 `[ASVS v5.0.0-8.2.2]`·`[ASVS v5.0.0-8.2.3]`을 단다. 상태는 시험 이름으로 정한다. BAT-616 완료(2026-11-21, R-726), BAT-617 완료(2026-11-22, R-758, 아티스트 연결은 LCH-080 잔여). |

- **⑫의 두 몫**: seat-hold S-T41 ⑫는 화면(SCR-021 5단계·SCR-048)과 승인된 공연의 설정 사본(`salePolicy`·`eligGates`·`eligLists`·취소 회차 제외·승인 전 409)을 함께 적는다. 설정 사본은 `services/core-svc/test/event-sale-config.test.ts`의 시험 넷이, 화면은 BAT-617의 파트너·관제 모델·배선 시험과 api-client 계약 시험이 본다(2026-11-22 BAT-617).

- **코드 영역**: `services/core-svc/src/modules/catalog/**`·`services/purchase-svc/src/modules/inventory/**`다. `tools/ci/ledger.mjs`의 기능별 코드 영역은 넓히지 않았다. purchase-svc·queue-svc 파일이 다른 기능의 태그를 잘못 세는 것을 막으려는 것이고(BAT-615 RV-11), 이 묶음 시험 파일 목록은 위 S-T41 줄에 적었다.
- **범위 밖**: 5분·대형 30분 간격, 휠체어석 수·위치 재계산, 결제사 지정 고정, 판매 중지·재개 2인 승인과 SCR-048 단추는 LCH-090, 지급대행 등록·예금주·KYC는 LCH-110, 아티스트·다른 이름 연결(운영자가 기존 아티스트·공연장에 잇기, 새로 만들기)은 LCH-080 잔여다. 이 항목은 장부 범위에 넣지 않는다.

## BAT-360 기록(2026-11-22, R-751)

BAT-360(OPS-280·OPS-290)을 2026-11-22에 끝냈다. 계획 5.1대로 셋은 **다른 단계**(구간 5 인프라·BAT-365)로 넘겼고 BAT-360 장부 범위 밖이다. 이 묶음의 장부 범위는 27항목이고 모두 자동 시험이다. `ledger.mjs --batch BAT-360 --require`는 0이다.

- **C-T38 ②**: 실제 OpenTimestamps 캘린더로 찍고 몇 시간 뒤 비트코인 완료 증명으로 바꾸는 것, 실제 KMS·Object Lock·출시 주소는 구간 5(ADR-0332)·BAT-365 몫이다. 통합 시험은 가짜 캘린더·moto·local P-256 서명기로 본다.
- **C-T61 ⑦**: 작업이 마지막으로 성공한 시각(kube-state-metrics `kube_cronjob_status_last_successful_time`)이 늦은 SEV2 경보·kind 클러스터·경보 규칙은 구간 5·BAT-365 몫이다.
- **C-T61 ⑧**: 작업 역할이 IP 집합을 읽고 바꾸는 권한이 Terraform 정책 검사·IAM 정책 검사에 드는지, AWS 실물 검사는 구간 5·BAT-365 몫이다.

## W12-merch-replay(2026-11-22)

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| P-T77 |  | A | W12-merch-replay | 굿즈 결제 시도의 결과 참조를 시도 ID로 줄이고 재생 때 `PrepareCheckout`을 다시 불러 지금 설정의 결제창 값을 만든다(ADR-0352). 결제창 공개 키·돌아올 주소가 바뀌면 팬이 다른 상점으로 가는 돈·보안 경로라 A다. 정본 표는 `docs/features/payment.md` §11 P-T77이고 시험 이름으로 상태를 정한다. W12-merch-replay 완료(2026-11-22, R-760). |

## BAT-430에서 좁힌 ASVS 행(2026-11-22)

BAT-430 계획(`docs/review/plans/BAT-430.md` §5)이 장부 범위를 `Q-T62, S-T37`로 좁혔다. offline-gate ASVS 표 전체는 다른 묶음(BAT-350·355·435·450·455 등)의 범위에 그대로 남아 있고, 그 가운데 스캐너 앱의 판정·저장·업로드·화면에 직접 닿는 행은 GAT-140 잔여로 넘긴다. 아래 행은 이 묶음이 판정하지 않는다.

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| offline-gate:v5.0.0-2.3.2 | 다른 단계 |  | GAT-135 | 우선 구매 48시간·한 권리 한 주문·재발급 24시간 한도는 여러 서비스에 흩어져 있다. 이 묶음은 판매 상태 홀드 셈·회차 빼기만 닫았고, 남은 한도 시험은 GAT-135 잔여(권리 상태 대조·DB 재시도)와 함께 본다. |
| offline-gate:v5.0.0-3.5.5 | 다른 단계 |  | F-05-10 | 판정 Worker와 서비스 워커 메시지 경계가 아직 없다. Worker를 붙이는 단계에서 정해진 형식만 받는 시험을 더한다. 2026-11-23 F-05-4 계획이 판정 Worker·서비스 워커를 F-05-10으로 나눴다. |


## F-01-2에서 뗀 몫(2026-11-23)

F-01-2 계획(`docs/review/plans/F-01-2.md` §2)이 장부 범위를 V-T39 ①③·V-T47 ①~⑤와 delivery ASVS 셋으로 좁혔다. 아래 둘은 이 기능이 만들지 않아 정할 곳을 따로 둔다(ADR-0356 결정 7).

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| V-T39 ② | 다른 단계 |  | 미정 | 브라우저 Sentry SDK를 대기실 경량 페이지를 뺀 앱에 싣는 일(docs/frontend.md §5.16 '오류 도구', 첫 JS 몫은 §5.8 '관측 라이브러리의 몫')이 어느 WBS 단계에도 없다. F-01-2는 서버 SDK만 한다. 감독이 맡을 기능을 정한다(계획 '감독에게' 1) |
| V-T47 ⑥ | 미검증 |  | INF-040 | 실제 Grafana·Mimir에 올려 조직 둘·폴더·보존·골라 보내기가 먹는지는 kind 클러스터가 있어야 본다(ADR-0332 결정 4·5, kind 보류). 파일끼리 맞는지는 V-T47 ①~⑤가 tools-check에서 본다 |

## F-04-2에서 뗀 몫(2026-11-23)

F-04-2 계획(`docs/review/plans/F-04-2.md` §2)이 장부 범위를 A-T26 ①②③⑤·ST-T16 ②와 ASVS 셋으로 좁혔다. 아래 하나는 이 기능이 만들지 않아 정할 곳을 따로 둔다(ADR-0357 결정 9).

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| A-T26 ④ | 다른 단계 |  | 미정 | queue-svc의 사람별 대기 기록 `QueueEntryRecord`·1초 집계 `QueueAggregate` 발행(BUILD_ORDER OPS-190 줄의 PRF-080·HOT-060이 넘긴 것)은 queue-svc에 Kafka 생산자·사람별 칸 저장·판매 종료 정리가 새로 필요해 F-04-2의 5일 상한 밖이다. 감독이 맡을 기능을 정한다(계획 '감독에게' 1) |

## F-01-3에서 뗀 몫(2026-11-23)

F-01-3 계획(`docs/review/plans/F-01-3.md` §2)이 장부 범위를 OPS-060 몫(V-T30 ①②, V-T49 ①~⑤, delivery 16.2.5)으로 좁혔다. 아래 하나는 kind 클러스터가 있어야 보므로 정할 곳을 따로 둔다.

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| V-T30 ③ | 미검증 |  | INF-040 | gw-queue의 Envoy가 trace를 0.1%만 고르고(`samplingFraction`) 고르지 않은 요청의 queue-svc span이 내보내지지 않는지는 게이트웨이와 수집기를 kind에 올려야 본다(ADR-0331 결정 9, kind 보류). 수집기 설정과 꼬리 표본 정책은 V-T49가 Docker로 본다 |

## F-01-4에서 뗀 몫(2026-11-23)

F-01-4 계획(`docs/review/plans/F-01-4.md` §2)이 장부 범위를 OPS-080 앞 몫(V-T30 ④, V-T50 ①~⑦, delivery 16.2.4)으로 좁혔다. 아래 둘은 F-01-3(수집기 2단)의 설정·서비스 템플릿 고침 위에 쌓아야 해서 정할 곳을 따로 둔다.

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| V-T50 ⑧ | 다른 단계 |  | OPS-080 뒤 몫(새 기능 행 제안, F-01-4 계획 '감독에게' 1) | 서비스 템플릿이 남길 trace의 지연 점에만 exemplar를 다는 규칙은 F-01-3이 서버 span에 다는 `peaket.slo.exceeded`와 같은 파일(`packages/platform/src/http-hooks.ts`)에 기댄다. F-01-3을 합친 뒤 쌓는다 |
| V-T50 ⑨ | 다른 단계 |  | OPS-080 뒤 몫(새 기능 행 제안, F-01-4 계획 '감독에게' 1) | Loki 라벨 넷을 다는 곳은 F-01-3이 만드는 게이트웨이 수집기 설정(`deploy/platform/observability/collector/gateway.yaml`)이다. Loki 쪽 허용 목록과 한도는 V-T50 ④·V-T30 ④가 Docker로 본다 |

## 측정 못 함(ADR-0373 동결 선행, F-08-8 계획 2026-11-23)

ADR-0373 결정 2의 '동결로 미검증'이다. 완성 판정에서 빼고 완성 보고에 수를 따로 적는다. 완성 뒤 다시 열면 상태를 측정으로 되돌리고 정할 곳의 단계에서 잰다.

| 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
| --- | --- | --- | --- | --- |
| S-T10 | 미검증 |  | HOT-460(K3, 완성 뒤) | 측정 못 함(ADR-0373 동결 선행): 감독 결정(2026-11-23)으로 F-08-8은 K1·K2·K7만 잰다(계획 docs/review/plans/F-08-8.md 3.2). K3(교착 방지와 DB 튜닝)에 붙은 합성 5년치 데이터의 실행 계획 회귀·파티션 없는 표 대조를 만드는 도구가 없다. v0 쪽 K3는 2026-11-03 Before 실행에 있다 |
| S-T11 | 미검증 |  | HOT-460(K3, 완성 뒤) | 측정 못 함(ADR-0373 동결 선행): 감독 결정(2026-11-23)으로 F-08-8은 K1·K2·K7만 잰다(계획 docs/review/plans/F-08-8.md 3.2). K3(트랜잭션 격리 수준 비교)도 같은 까닭이다 |
| S-T12 ① | 미검증 |  | BAT-095(K4, 완성 뒤) | 측정 못 함(ADR-0373 동결 선행): 감독 결정(2026-11-23)으로 F-08-8은 K1·K2·K7만 잰다(계획 docs/review/plans/F-08-8.md 3.2). K4(연결 5,000개·`tc netem` 판정 측정)는 realtime-gw가 v1 합본 무대에 없고 데모 무대에만 있으며 v1 부하 클라이언트가 없다. 그 배포·측정 몫은 INF-020(F-09-8의 동결 몫)이다. ②(지표)는 BAT-052 시험 |
| S-T14 ④ | 미검증 |  | BAT-095(K4, 완성 뒤) | 측정 못 함(ADR-0373 동결 선행): 감독 결정(2026-11-23)으로 F-08-8은 K1·K2·K7만 잰다(계획 docs/review/plans/F-08-8.md 3.2). Degraded Mode 완화 SLO p99 1.5초와 초과 판매 0건도 K4 무대가 필요하다(S-T12 ①과 같은 까닭). ①~③(자동 전환)은 BAT-053(HOT-091) 시험이다 |
| S-T15 | 미검증 |  | LCH-200(K5, 완성 뒤) | 측정 못 함(ADR-0373 동결 선행): 감독 결정(2026-11-23)으로 F-08-8은 K1·K2·K7만 잰다(계획 docs/review/plans/F-08-8.md 3.2). K5 랩 판정 도구 `loadtest/k5/seatmap-lab.mjs`는 v0 입구 고정이고 v1 좌석맵 랩 판정은 LCH-200(F-08-1, 동결)이다 |
| P-T31 | 미검증 |  | 구간 측정(완성 뒤) | 측정 못 함(ADR-0373 동결 선행): 감독 결정(2026-11-23)으로 F-08-8은 K1·K2·K7만 잰다(계획 docs/review/plans/F-08-8.md 3.2). 결제사 전환 훈련과 결제사별 동시 입장 목표 상한은 스테이징 무대가 필요하다(F-09 클라우드 기반, 동결) |

## F-09-2 이름 기준 자동 시험과 실제 미실행(2026-11-27, RV092-05)

- **D-T8**: `migration-check.test.mjs`의 정적 n1 시험과 `migrations.int.test.ts`의 합성 N-1 질의 시험 이름이 장부를 '자동 시험'으로 채운다. 정본이 요구하는 **identity-svc N-1 앱 통합 시험 묶음**은 Docker·DB가 필요해 이번 동결 로컬 턴에는 `미실행`이다. 구현·검증 차례에 `pnpm --filter @peaket/identity-svc test:integration`을 확장 스키마 위에서 돌리기 전에는 완료로 보고하지 않는다(계획 §8 완료의 정의 3).
- **D-T44 ⑤**: 차트·스크립트 문자열 시험 이름이 장부를 채우지만, 정본 행동은 **DDL 역할로 실제 접속**하는 것이다. `migrations.int.test.ts`의 `D-T44 ⑤ DDL 역할로 직접 붙어 마이그레이션한다`를 Docker 잠금 아래에서 돌리기 전에는 `미실행`이다(계획 §8 완료의 정의 4).
- **D-T44 이관**: 기존 `ops_migration`·`ticket_migration`·`drizzle.__drizzle_migrations`를 `peaket_migration`으로 옮기는 실제 DB 이관은 이번 턴 `미실행`이다. 단위·통합 시험 이름만 있다(계획 §8 완료의 정의 5).
