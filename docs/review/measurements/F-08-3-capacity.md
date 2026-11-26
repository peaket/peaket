# F-08-3 용량 산정서

- **작성일**: 2026-11-26
- **상태**: 초안(검토 대기)
- **기준 커밋**: 19b33ba85
- **성격**: 이 문서는 정본이 아니다. `docs/review/measurements/F-08-2-msr020.md`, `docs/review/measurements/F-08-8-after.md`, `docs/review/ledger-notes.md`와 정본(`docs/planning/02-requirements.md` NFR-021, `docs/architecture.md` §9.1·§9.5, `docs/verification.md` §3.3~§3.5)을 인용해 정리한 검토 기록이며, 정본과 다르면 정본이 이긴다.

## 1. 입력과 표시 규칙

이 산정서는 새 부하 측정을 하지 않고, `docs/review/measurements/F-08-3-facts.json`에 등록한 사실만 인용한다. 수치는 `docs/perf-ledger.md` §7과 `docs/verification.md` §3.3 기준에 따라 **실측(PC)**·**외삽**·**문서 인용**·**계산**·**설계 목표**로 구분한다.

| 입력 원천 | 쓰는 범위 | 한계와 제외 · 대표 사실 ID |
| --- | --- | --- |
| `docs/review/measurements/F-08-2-msr020.md` | 진입 `X₁`·`E(N)`·진입 설계 식 결과·`R` 인용 | 새 재계산·재측정 없음(`docs/perf-ledger/runs/2026-11-24-msr020-*`, `F082-X1`, `F082-N250`, `F082-E8`, `F082-R`) |
| `docs/review/measurements/F-08-8-after.md` | K1·K2·K7 After 판정과 병목 수치 | 2GiB 무대 편차, 미달·무효·부분 상태 그대로 인용(`F088-K1-1K-P99`, `F088-K2-R2-P99`, `F088-K7B`) |
| `docs/review/ledger-notes.md` | V-T4 `판정 못 함`·V-T5 사람 확인 상태 | 상태 변경 없음(`F082-VT4`) |
| `docs/planning/02-requirements.md` NFR-021·`docs/architecture.md` §9.5 | 다수 공연 합산 및 1~3년 성장 전망 | 모두 `설계 목표`·`계산`이며 실측 아님(`NFR021-WAIT-Y1`, `ARCH95-ENTRY-LIMIT`) |

## 2. 100만(한 공연)

단일 공연 동시 대기 100만 명 규모는 F-08-2 창 1의 K1 v1 측정(1천·1만·10만 세 점)과 창 2의 MSR-020(진입 서버 비례 점검)으로 나누어 살피며, 100만 외삽 자체는 판정 못 함 상태다.

- **100만 외삽(MSR-010) 판정 상태**: MSR-010(100만 외삽) 보고서는 없고, 창 1 K1 v1 측정에서 10만 규모가 발생기 한계(`dropped_iterations`)로 2회 연속 무효(`F088-K1-100K`)·3차 skip되어 V-T4는 **판정 못 함**이다(`F082-VT4`). 따라서 단일 공연 100만 규모의 대기 상태 파일·원 서버 응답 외삽은 값을 내지 않는다(`docs/perf-ledger/runs/2026-11-24-k1-v1-local-100k-r1-f088`).
- **200,000 RPS 진입 설계 식(MSR-020)**: T=0 오픈 직후 진입 피크 목표인 200,000 RPS(`ARCH95-ENTRY-LIMIT`, `docs/architecture.md` §9.1)에 대해서는 `docs/review/measurements/F-08-2-msr020.md`가 진입 설계 식 `min(N × X₁, R)`을 적용했다.
  - 1 vCPU 기준 진입 서버 1대 실측(PC) 처리량 `X₁`은 3회 중앙값 `800 req/s`(720·800·800, 편차 80)이다(`F082-X1`).
  - Redis 단일 키 최대 처리량 `R`은 2026-11-01 TLS 켬 실측 인용값 `490,800 ops/s`이다(`F082-R`, `docs/perf-ledger/runs/2026-11-01-incrmax-tls-r1-local-poc`).
  - 설계 식 `⌈200,000 ÷ 800⌉`의 결과는 **필요한 대수 250**(측정 최대 대수 8, 외삽 배수 31.25)이다(`F082-N250`). 이 값은 **외삽(측정 범위의 4배 초과)**이며 **비례 전제 확인 못 함**으로 표시하고 확정 용량으로 쓰지 않는다.
  - 250이라는 진입 서버 필요 대수는 200,000 RPS 진입 설계 식(`F082-N250`)의 산출물이지, MSR-010 100만 외삽(`F082-VT4`) 판정 값이 아니다. 두 항목은 서로 다른 검증 대상이다.
  - 0.5 vCPU 몫에서 N=1이 무효(`F082-N1`)라 임시 분모 `320 req/s`(`F082-X1POD-TMP`)로 계산한 `E(8) = 0.250`(`F082-E8`, N=8 중앙값 `640 req/s` `F082-N8-X`) 역시 기준 0.9에 크게 못 미쳐 비례 전제를 확인하지 못했다.

| 구분 | 값·상태 | 표시 | 근거 · 사실 ID |
| --- | --- | --- | --- |
| 단일 공연 100만 외삽(MSR-010, V-T4) | 판정 못 함(10만 2회 무효·r3 skip) | 문서 인용 | `F082-VT4`, `F088-K1-100K` |
| 진입 서버 1 vCPU `X₁` | `800 req/s`(3회 중앙값 720·800·800, 편차 80) | 실측(PC) | `F082-X1` |
| Redis 단일 키 `R`(TLS 켬 인용) | `490,800 ops/s`(2026-11-01 실측 인용) | 문서 인용 | `F082-R` |
| 200,000 RPS 진입 설계 식 필요 대수 | 필요 대수 250(측정 최대 8, 외삽 배수 31.25; 비례 전제 확인 못 함) | 외삽(측정 범위의 4배 초과) | `F082-N250` |
| 0.5 vCPU N=1 · N=8 · 비례 효율 `E(8)` | N=1 무효, N=8 `640 req/s`, 임시 분모 320 기준 `E(8)=0.250` | 실측(PC) · 계산 | `F082-N1`, `F082-N8-X`, `F082-X1POD-TMP`, `F082-E8` |

## 3. 200만(여러 공연)

합산 동시 대기 200만 명 시나리오는 단일 공연 100만 규모를 늘려 구한 외삽이 아니라, `docs/planning/02-requirements.md` **NFR-021**과 `docs/architecture.md` **§9.5**가 정의한 **여러 공연 동시 판매 설계 목표**다.

- **오픈 간격 제어(POL-030)**: 대형 공연끼리는 티켓 오픈 시각을 최소 30분 이상(`NFR021-GAP-LARGE`) 떼어 한 윈도우에 대형 공연 1개만 허용하고, 일반 공연도 최소 5분 이상(`NFR021-GAP-NORMAL`) 간격을 강제한다(NFR-021, `docs/architecture.md` §9.5).
- **진입 버스트 설계 기준**: 위 오픈 간격 제어로 T=0 진입 급증이 여러 공연에서 동시에 겹치지 않도록 설계하므로, 진입 피크 설계 기준은 여전히 공연 하나 기준인 `200,000 RPS`(`ARCH95-ENTRY-LIMIT`)로 둔다(`설계 목표`).
- **1년차 합산 동시 규모(설계 목표)**: 판매 시간대가 겹치는 최대 동시 온세일 공연 3개(대형 1 + 중형 2, `NFR021-CONC-Y1`)가 겹칠 때 합산 동시 대기는 `2,000,000명`(`NFR021-WAIT-Y1`), 합산 동시 입장 상한은 `10,000명`(`NFR021-ADMIT-Y1`)이다. 단, 좌석·결제 계층의 부하 시험이 전제이며, 그 전에는 합산 동시 입장 상한을 `5,000명`(`NFR021-ADMIT-PRE`)으로 통제한다(NFR-021, §9.5).

| 항목 | 1년차 값 | 표시 | 근거 · 사실 ID |
| --- | --- | --- | --- |
| 동시 온세일 공연 수(대형 1 + 중형 2) | 최대 3개(대형 30분·일반 5분 간격) | 설계 목표 | `NFR021-CONC-Y1`, `NFR021-GAP-LARGE`, `NFR021-GAP-NORMAL` |
| 합산 최대 동시 대기자 수 | 2,000,000명 | 설계 목표 | `NFR021-WAIT-Y1` |
| 합산 동시 입장 상한(부하 시험 전 통제) | 10,000명(시험 전 5,000명 통제) | 설계 목표 | `NFR021-ADMIT-Y1`, `NFR021-ADMIT-PRE` |
| T=0 진입 피크 설계 기준(단일 공연 기준) | 200,000 RPS(POL-030 전제) | 설계 목표 | `ARCH95-ENTRY-LIMIT` |

## 4. 1~3년 전망

아래 1~3년 성장 전망과 장기 용량 수치는 모두 `docs/planning/02-requirements.md` **NFR-021** 및 `docs/architecture.md` **§9.5**에서 인용한 **설계 목표** 및 **계산** 값이다. 이 문서에서 새 성장률을 가정하거나 추가 계산하지 않는다.

| 성장 항목 | 1년차 | 2년차 | 3년차 | 표시 | 사실 ID |
| --- | --- | --- | --- | --- | --- |
| 대형 공연(대기 50만 이상, 평균 50,000석) | 연간 24회 | 연간 36회 | 연간 48회 | 설계 목표 | `NFR021-LARGE-Y1`, `NFR021-LARGE-Y2`, `NFR021-LARGE-Y3` |
| 중형 공연(대기 10만~50만, 평균 15,000석) | 연간 120회 | 연간 180회 | 연간 240회 | 설계 목표 | `ARCH95-MEDIUM-Y1`, `ARCH95-MEDIUM-Y2`, `ARCH95-MEDIUM-Y3` |
| 소형 공연(대기 10만 미만, 평균 500석) | 연간 2,000회 | 연간 3,000회 | 연간 4,500회 | 설계 목표 | `ARCH95-SMALL-Y1`, `ARCH95-SMALL-Y2`, `ARCH95-SMALL-Y3` |
| 중첩 가능 최대 동시 온세일 공연 수 | 3개 | 4개 | 5개 | 설계 목표 | `NFR021-CONC-Y1`, `NFR021-CONC-Y2`, `NFR021-CONC-Y3` |
| 플랫폼 합산 최대 동시 대기자 수 | 2,000,000명 | 2,500,000명 | 3,000,000명 | 설계 목표 | `NFR021-WAIT-Y1`, `NFR021-WAIT-Y2`, `NFR021-WAIT-Y3` |
| 플랫폼 합산 동시 입장 상한 | 10,000명 | 12,500명 | 15,000명 | 설계 목표 | `NFR021-ADMIT-Y1`, `NFR021-ADMIT-Y2`, `NFR021-ADMIT-Y3` |
| 연간 총 티켓 발권량 | 4,000,000장 | 6,000,000장 | 8,250,000장 | 설계 목표 | `NFR021-TICKET-Y1`, `NFR021-TICKET-Y2`, `NFR021-TICKET-Y3` |
| 연간 총 주문 처리 건수 | 2,000,000건 | 3,000,000건 | 약 4,120,000건 | 설계 목표 | `ARCH95-ORDERS-Y1`, `ARCH95-ORDERS-Y2`, `ARCH95-ORDERS-Y3` |
| 결제 승인 요구 피크 트래픽 | 300 TPS | 300 TPS | 300 TPS | 설계 목표 | `ARCH95-PG-PEAK` |

3년차(합산 대기 3,000,000명 `NFR021-WAIT-Y3`, 동시 입장 15,000명 `NFR021-ADMIT-Y3`) 기준 아키텍처 영향도(`docs/architecture.md` §9.5)는 다음과 같다.

| 계층 · 항목 | 3년차 값 | 표시 | 사실 ID |
| --- | --- | --- | --- |
| 대기 상태 정적 파일 수 | 약 3,000개 | 계산 | `ARCH95-FILES-Y3` |
| 대기 상태 조회 CDN 엣지 요청 | 초당 약 160,000건 | 설계 목표 | `ARCH95-CDN-Y3` |
| 대기 상태 조회 백엔드 Origin 요청 | 초당 약 3,000건 | 계산 | `ARCH95-ORIGIN-Y3` |
| 셔플 결과 조회 중첩 시 대기열 파일 배포 요청 | 초당 약 285,000건 | 계산 | `ARCH95-SHUFFLE-Y3` |
| 좌석 홀드 피크(합산 입장 15,000명) | 초당 최대 약 6,000건 | 설계 목표 | `ARCH95-HOLD-Y3` |
| 최종 판매 확정(15,000명 ÷ 체류 180초) | 초당 약 83건 | 계산 | `ARCH95-COMMIT-Y3` |
| 5년 누적 데이터 규모(주문 · 티켓) | 주문 약 17,000,000건 · 티켓 약 35,000,000장 | 설계 목표 | `ARCH95-DB-ORDERS-5Y`, `ARCH95-DB-TICKETS-5Y` |

## 5. 병목과 여유

창 1(`F-08-8-after.md`)과 창 2(`F-08-2-msr020.md`)에서 확인한 실제 병목과 동결로 측정하지 않은 항목은 다음과 같다.

| 영역 · 기능 | 측정 상태 및 결과 | 표시 | 근거 · 사실 ID |
| --- | --- | --- | --- |
| 진입 서버 비례 확인(F-08-2 MSR-020) | 0.5 vCPU N=1 무효, N=2~8 임시 `E(8)=0.250`으로 0.9 미달(`비례 전제 확인 못 함`). 2GiB(N=8은 1GiB) 무대 | 실측(PC) · 계산 | `F082-N1`, `F082-N8-X`, `F082-E8` |
| K1 대기열(F-08-8 Q-T2) | 1,000명 `1/3`만 통과(r3 status p99 `0.5ms`·오류 `0%`, 부분), 10,000명 3회 모두 미달(r1 status p99 `0.5ms`·오류 `0.66%`), 100,000명 2회 무효·r3 skip. status·admission보다 **진입 경로**가 병목 | 실측(PC) | `F088-K1-1K-P99`, `F088-K1-1K-ERR`, `F088-K1-10K`, `F088-K1-10K-P99`, `F088-K1-10K-ERR`, `F088-K1-100K` |
| K2 좌석 홀드(F-08-8 S-T1) | 인기 좌석 TLS 켬 r2 `253.3ms`(오류 `0.77%`), r3 `262.6ms`(오류 `0.85%`)로 모두 S-T1 목표 50ms 미달(r1·흩음 무효). 불변식은 3회 모두 통과 | 실측(PC) | `F088-K2-R2-P99`, `F088-K2-R2-ERR`, `F088-K2-R3-P99`, `F088-K2-R3-ERR` |
| K7 ① 결제 피크(F-08-8 NFR-006) | 300/s 결제 r1·r1b 연속 무효(dropped 7,459·3,844), r2·r3 skip. 유효 실행 0으로 판정 못 함/무효 | 실측(PC) | `F088-K7A` |
| K7 ② 결제 장애 주입(F-08-8 P-T1) | 3회 모두 발생기 무효(dropped 2,335~2,698) 및 동결 선행 미측정으로 `부분` 판정. 단 불변식은 3회 모두 PASS 15(이중 결제·P6·좌석 누수 `0건`) | 실측(PC) | `F088-K7B`, `F088-K7B-ZERO` |

- **동결로 측정 없는 항목**:
  - `F-08-4`(정렬 설정 켬/끔 10만 비교): **측정 없음(F-08-4 동결)**.
  - `F-08-5`(장시간 시험)·`F-08-6`(Game Day)·`F-08-9`(ticket-svc 중단·망 끊김·대사)·`F-08-10`(세 구성 서비스 분리)·`F-08-11~F-08-15`: **동결로 측정 없음**.

## 6. 가정과 한계

- **무대 차이**: F-08-8과 F-08-2는 합본 512Mi·1GiB OOMKilled로 인해 **2GiB** 무대(MSR-020 N=8만 1GiB)에서 측정했으며, 과거 512Mi Before 수치와 직접 비교하지 않는다.
- **발생기·PC 환경 한계**: 로컬 PC 단일 노드 kind 환경에서 k6 발생기와 대상 파드가 CPU·메모리·루프백을 공유하므로 클라우드 운영 한계와 다르다.
- **미측정·동결 범위**: 100만 외삽(MSR-010, `F082-VT4`), F-08-4(정렬 설정 켬/끔 10만 비교), F-08-5(장시간 시험), F-08-6(Game Day), F-08-9(ticket-svc 중단·망 끊김·대사), F-08-10(세 구성 서비스 분리), F-08-11~F-08-15는 동결로 이번 용량 산정에 실측 근거가 없다.
- **정본 미변경**: 이 보고서는 `docs/infra.md` §11·`docs/verification.md`·`docs/architecture.md` 등 정본을 고치지 않으며, 실측 기반 정본 개정은 동결 해제 뒤 반영 제안으로 남긴다.
- **주장하지 않는 것**: 이 용량 산정서는 `30,000건/초`(`30,000 RPS`), 단일 공연 `100만` 달성·외삽 통과, `K1`·`K2`·`K7` 전체 통과를 주장하지 않는다.

## 7. 사실 대장 인용

원천 파일 및 장부 실행 목록: `docs/review/measurements/F-08-2-msr020.md`, `docs/review/measurements/F-08-8-after.md`, `docs/review/ledger-notes.md`, `docs/planning/02-requirements.md`, `docs/architecture.md`, `docs/perf-ledger/runs/2026-11-24-msr020-n1-c1-r1-f082-s1`, `docs/perf-ledger/runs/2026-11-24-k1-v1-local-1k-r3-f088`, `docs/perf-ledger/runs/2026-11-24-k1-v1-local-10k-r1-f088`, `docs/perf-ledger/runs/2026-11-24-k1-v1-local-100k-r1-f088`, `docs/perf-ledger/runs/2026-11-24-k2-v1-hot-tls-r2-f088`, `docs/perf-ledger/runs/2026-11-24-k2-v1-hot-tls-r3-f088`, `docs/perf-ledger/runs/2026-11-24-k7-v1-fault-r1-f088`, `docs/perf-ledger/runs/2026-11-01-incrmax-tls-r1-local-poc`.

| 사실 ID | 값 · 상태 | 표시 | 원천 |
| --- | --- | --- | --- |
| `F082-X1` | `800 req/s`(3회 중앙값 720·800·800, 편차 80) | 실측(PC) | `F-08-2-msr020.md` |
| `F082-N250` | `250 servers`(목표 200,000, 측정 최대 8, 외삽 배수 31.25) | 외삽 | `F-08-2-msr020.md` |
| `F082-VT4` | `null` (`판정 못 함`, MSR-010 보고서 없음) | 문서 인용 | `ledger-notes.md` |
| `F082-E8` | `0.25 ratio`(임시 분모 320 기준 N=8 `E(8)`) | 계산 | `F-08-2-msr020.md` |
| `F082-R` | `490,800 ops/s`(2026-11-01 TLS 켬 실측 인용) | 문서 인용 | `F-08-2-msr020.md` |
| `F082-N1` | `null` (`무효`, 0.5 vCPU N=1: 320·200·찾지 못함) | 실측(PC) | `F-08-2-msr020.md` |
| `F082-N8-X` | `640 req/s`(0.5 vCPU N=8 1GiB 무대, 편차 0) | 실측(PC) | `F-08-2-msr020.md` |
| `F082-X1POD-TMP` | `320 req/s`(N=1 유효값 320·200 최댓값 임시 분모) | 계산 | `F-08-2-msr020.md` |
| `F088-K1-1K-P99` | `0.5 ms`(r3 status p99; 1/3 통과, `부분`) | 실측(PC) | `F-08-8-after.md` |
| `F088-K1-1K-ERR` | `0 %`(r3 진입 오류율; 1/3 통과, `부분`) | 실측(PC) | `F-08-8-after.md` |
| `F088-K1-10K` | `null` (`미달`, 3회 모두 fail) | 문서 인용 | `F-08-8-after.md` |
| `F088-K1-10K-P99` | `0.5 ms`(r1 status p99; `미달`) | 실측(PC) | `F-08-8-after.md` |
| `F088-K1-10K-ERR` | `0.66 %`(r1 진입 오류율; `미달`) | 실측(PC) | `F-08-8-after.md` |
| `F088-K1-100K` | `null` (`무효`, r1·r2 dropped 무효, r3 skip) | 실측(PC) | `F-08-8-after.md` |
| `F088-K2-R2-P99` | `253.3 ms`(r2 hold p99; `미달`) | 실측(PC) | `F-08-8-after.md` |
| `F088-K2-R2-ERR` | `0.77 %`(r2 오류율; `미달`) | 실측(PC) | `F-08-8-after.md` |
| `F088-K2-R3-P99` | `262.6 ms`(r3 hold p99; `미달`) | 실측(PC) | `F-08-8-after.md` |
| `F088-K2-R3-ERR` | `0.85 %`(r3 오류율; `미달`) | 실측(PC) | `F-08-8-after.md` |
| `F088-K7A` | `null` (`무효`, 300/s 유효 실행 0) | 실측(PC) | `F-08-8-after.md` |
| `F088-K7B` | `null` (`부분`, PASS 15·발생기 무효·동결 선행 미측정) | 실측(PC) | `F-08-8-after.md` |
| `F088-K7B-ZERO` | `0 violations`(이중 결제·P6·좌석 누수 0건; `부분`) | 실측(PC) | `F-08-8-after.md` |
| `NFR021-WAIT-Y1` · `NFR021-WAIT-Y2` · `NFR021-WAIT-Y3` | `2,000,000` · `2,500,000` · `3,000,000 users` | 설계 목표 | `02-requirements.md` NFR-021 |
| `NFR021-ADMIT-Y1` · `NFR021-ADMIT-Y2` · `NFR021-ADMIT-Y3` | `10,000` · `12,500` · `15,000 users` | 설계 목표 | `02-requirements.md` NFR-021 |
| `NFR021-ADMIT-PRE` | `5,000 users`(시험 전 통제) | 설계 목표 | `02-requirements.md` NFR-021 |
| `NFR021-LARGE-Y1` · `NFR021-LARGE-Y2` · `NFR021-LARGE-Y3` | `24` · `36` · `48 events/year` | 설계 목표 | `02-requirements.md` NFR-021 |
| `NFR021-CONC-Y1` · `NFR021-CONC-Y2` · `NFR021-CONC-Y3` | `3` · `4` · `5 events` | 설계 목표 | `02-requirements.md` NFR-021 |
| `NFR021-TICKET-Y1` · `NFR021-TICKET-Y2` · `NFR021-TICKET-Y3` | `4,000,000` · `6,000,000` · `8,250,000 tickets/year` | 설계 목표 | `02-requirements.md` NFR-021 |
| `NFR021-GAP-LARGE` · `NFR021-GAP-NORMAL` | `30 minutes` · `5 minutes`(POL-030) | 설계 목표 | `02-requirements.md` NFR-021 |
| `ARCH95-MEDIUM-Y1` · `ARCH95-MEDIUM-Y2` · `ARCH95-MEDIUM-Y3` | `120` · `180` · `240 events/year` | 설계 목표 | `docs/architecture.md` §9.5 |
| `ARCH95-SMALL-Y1` · `ARCH95-SMALL-Y2` · `ARCH95-SMALL-Y3` | `2,000` · `3,000` · `4,500 events/year` | 설계 목표 | `docs/architecture.md` §9.5 |
| `ARCH95-ORDERS-Y1` · `ARCH95-ORDERS-Y2` · `ARCH95-ORDERS-Y3` | `2,000,000` · `3,000,000` · `4,120,000 orders/year` | 설계 목표 | `docs/architecture.md` §9.5 |
| `ARCH95-PG-PEAK` | `300 TPS` | 설계 목표 | `docs/architecture.md` §9.5 |
| `ARCH95-ENTRY-LIMIT` | `200,000 req/s` | 설계 목표 | `docs/architecture.md` §9.5 |
| `ARCH95-FILES-Y3` · `ARCH95-CDN-Y3` · `ARCH95-ORIGIN-Y3` · `ARCH95-SHUFFLE-Y3` | `3,000 files` · `160,000 req/s` · `3,000 req/s` · `285,000 req/s` | 계산 · 설계 목표 | `docs/architecture.md` §9.5 |
| `ARCH95-HOLD-Y3` · `ARCH95-COMMIT-Y3` | `6,000 ops/s` · `83 ops/s` | 설계 목표 · 계산 | `docs/architecture.md` §9.5 |
| `ARCH95-DB-ORDERS-5Y` · `ARCH95-DB-TICKETS-5Y` | `17,000,000` · `35,000,000 rows` | 설계 목표 | `docs/architecture.md` §9.5 |
