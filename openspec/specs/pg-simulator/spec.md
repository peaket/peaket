# pg-simulator Specification

## Purpose
결제사(PG) 흉내 서버(`services/pg-simulator`)와 payment-svc의 시뮬레이터 어댑터가 밖으로 보이는 행동이다: 시험 키·실행 환경 제한, 토스페이먼츠 모양의 승인 규칙, 시험이 넣는 장애와 원장 내보내기, 결제사 응답의 표준 결과. 규칙의 정본은 docs/features/payment.md §2.1과 ADR-0029이다(openspec 변경 add-invariant-checker-and-pg-simulator, 2026-11-02, BUILD_ORDER BSL-010).

## Requirements

### Requirement: 시뮬레이터는 시험 키만 받고 운영에서는 시작하지 않는다

PG 시뮬레이터는 `sim_sk_`로 시작하는 시험 키의 기본 인증만 받고, 실행 환경이 없거나 `prod`면 SHALL 시작하지 않는다. 기본 주소는 루프백이다(docs/features/payment.md §2.1 '테스트 자격증명', ASVS v5.0.0-13.3.1·13.4.2).

#### Scenario: 운영 환경

- **WHEN** `PEAKET_ENV`가 없거나 `prod`인 채로 시뮬레이터를 띄운다
- **THEN** 시작하지 않고 실패한다

#### Scenario: 키가 다르다

- **WHEN** 다른 키로 승인을 부른다
- **THEN** 401 `UNAUTHORIZED_KEY`이고 결제 상태가 바뀌지 않는다

### Requirement: 시뮬레이터는 결제사 승인 규칙을 흉내 낸다

시뮬레이터는 결제창 인증 뒤 10분 승인 기한, 승인된 주문 ID 재사용 금지, 멱등키 응답 재생과 처리 중 409, 같은 결제의 동시 승인 거절, 이미 승인된 결제의 재승인 거절, 금액 대조, 남은 금액 안의 부분 취소를 SHALL 지킨다(payment §2.1 PG사별 기술 명세 대조).

#### Scenario: 승인 기한

- **WHEN** 결제창 인증 뒤 10분 1초에 승인을 부른다
- **THEN** 승인되지 않고, 그 결제는 다시 승인할 수 없다

#### Scenario: 같은 멱등키

- **WHEN** 같은 멱등키로 승인을 두 번 부른다
- **THEN** 두 응답이 같고 원장의 승인은 1건이다

#### Scenario: 기본 승인 지연

- **WHEN** 시험이 지연을 넣지 않고 승인을 1만 번 부른다(고정 시드)
- **THEN** 지연의 중앙값은 300ms ± 10%, p99는 1.5초 ± 15% 안이다

### Requirement: 시험은 장애를 넣고 원장을 꺼낸다

시험은 제어 API로 작업·주문·횟수를 골라 거절·처리 중·결제사 오류·응답 유실·한도 초과·지연을 넣고, 원장을 불변식 검사기가 읽는 기록 형식으로 SHALL 꺼낸다(ADR-0029 결정 6, docs/verification.md §2.5).

#### Scenario: 응답 유실

- **WHEN** 승인에 '반영 뒤 응답 유실'을 넣고 어댑터로 승인을 부른다
- **THEN** 어댑터는 결과 모름(`UNKNOWN`)을 돌려주고, 단독 조회는 승인(`APPROVED`)을 돌려준다

#### Scenario: 원장 내보내기

- **WHEN** 결제 셋을 승인하고 하나를 부분 취소한 뒤 원장을 꺼낸다
- **THEN** `pg_charge` 세 줄이 나오고 부분 취소한 줄의 취소 금액이 맞다

### Requirement: 결제 포트 어댑터는 결제사 응답을 표준 결과로 바꾼다

시뮬레이터 어댑터는 결제 포트의 승인·조회·취소·결제창 값·웹훅 해석을 제공하고, 응답을 표준 결과(`APPROVED`·`ALREADY_APPROVED`·`IN_PROGRESS`·`DECLINED`·`WAITING_FOR_DEPOSIT`·`UNKNOWN`, 취소 `CANCELLED`·`CANCEL_PENDING`·`REJECTED`·`UNKNOWN`)와 실패 범주로 SHALL 바꾼다. 공통 계약 시험 묶음(결제창 값 생성, 정상 승인, 한도 초과 거절, 동시 처리 중 경합, 이미 승인된 건 재요청, 시간 초과 뒤 단독 조회로 확정, 승인 기한 만료, 부분 취소, 전액 환불, 웹훅 중복 수신)을 통과한다(payment §2.1 '어댑터 계약 테스트', ADR-0029 결정 3).

#### Scenario: 한도 초과 거절

- **WHEN** 승인에 결제사 거절 `REJECT_CARD_PAYMENT`를 넣는다
- **THEN** `DECLINED`이고 실패 범주는 `CARD_DECLINED`다

#### Scenario: 이미 승인된 건 재요청

- **WHEN** 승인된 결제를 다른 멱등키로 다시 승인한다
- **THEN** 조회로 금액을 맞춘 뒤 `ALREADY_APPROVED`를 돌려주고 원장의 승인은 1건이다

#### Scenario: 동시 처리 중 경합

- **WHEN** 같은 멱등키로 승인 둘을 동시에 부른다
- **THEN** 하나는 `APPROVED`, 하나는 `IN_PROGRESS`이고 원장의 승인은 1건이다

#### Scenario: 웹훅 중복 수신

- **WHEN** 같은 상태 바뀜 웹훅을 두 번 해석한다
- **THEN** 두 번 모두 같은 중복 제거 키와 결제 참조를 돌려주고, 상태는 싣지 않는다(조회로 확정하는 신호, ADR-0029 결정 5)
