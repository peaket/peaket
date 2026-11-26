# F-11-2 표본 검토 마감 기록 — 절차 마감·판정 보류

- **상태**: **절차 마감·판정 보류**. 이 기록은 검토 완료가 아니다.
- **바탕**: `freeze/lane1-F-11-2`, 출발 `8a7081d94`, 리뷰 `81cdaf302`. 정본은 docs/features/bot-defense.md §9·§12·§13·§14·§19, docs/perf-ledger.md §10.5·§10.6, docs/security/asvs/bot-defense.md '측정 요구사항' 행, docs/data.md의 `bot_sample_review` 행이다.
- **한 줄 결론**: 표본 검토의 절차는 정했지만, 첫 온세일 회차·표본 후보 원장·검토자·판정 기록이 없어 실제 판정은 보류한다. 0건을 200건처럼 채우지 않는다.

## 1. 상태

| 항목 | 지금 상태 | 까닭 |
| --- | --- | --- |
| 절차 | 마감 | 표본 선택·검토자·판정·보존·체크리스트를 이 기록으로 확정했다 |
| 판정 | **보류** | 첫 온세일 회차와 표본이 없다 |
| 원장 적재 주인 | **미정** | OPS-220은 dbt 15사실·11차원으로 끝났고 `data/`에 `bot_sample_review` 표가 없다. BOT-080도 `표본 배정 대기`다 |
| 검토자 | 미배정 | 판정할 표본이 없어 검토자를 띄우지 않았다 |
| 산출물 상태 | `절차 마감·판정 보류` | 검토 완료가 아니다 |

- **검토 완료가 아니다**: 이 문장은 상태를 오해하지 않게 두는 표시다. 실제 표본 판정이 끝나면 이 파일을 덮어쓰지 않고, 출시 뒤 회차·날짜를 붙인 새 측정 기록을 만든다.
- **첫 온세일 전에 필요한 것**: `bot_sample_review` DDL·적재기, `bot-review-assign` 스케줄러, 검토자 배정, `PASSED_SAMPLE` 가림 보완, 중복 판정 재사용, `PASSED_SAMPLE` BOT 근거 강제. 앞의 둘은 원장 적재 주인(미정)이 정해져야 한다.

## 2. 표본 선택

| 항목 | 정한 것 | 근거 |
| --- | --- | --- |
| 첫째 묶음 | 적용 판과 그림자 판이 모두 통과시킨 세션. 그림자 판이 없는 회차는 적용 판이 통과시킨 세션 | bot-defense §13, perf-ledger §10.6 |
| 둘째 묶음 | 그림자 판이 추가 검증으로 보낸 세션 | 같다 |
| `PASSED_SAMPLE` 배치 | 첫째 묶음만 200건 [가정] | BOT-080 배정 |
| `HUMAN_BASELINE` 배치 | 두 묶음을 섞어 200+200건 [가정]. 그림자 판이 없는 회차는 200+0 | BOT-080 배정 |
| 최소 표본 | 묶음마다 200건 [가정]. 묶음 전체가 200건 이하이면 전수 검토하고, 그 묶음의 비율은 구간 없이 그 값을 쓴다 | bot-defense §13 |
| 뽑기 | 회차·묶음별 모집단(`population`)에서 원장의 `ORDER BY rand()`로 뽑는다. 이 선택은 **재현 불가**다. 배치의 `seed`는 뽑힌 행의 섞기 순서만 재현한다 | BOT-080 `bot-review-assign`, `clickhouse-bot-review-source.ts` |
| 섞기 | 두 묶음을 섞어 무작위 순서로 낸다. `HUMAN_BASELINE`은 묶음을 가리지만 `PASSED_SAMPLE`은 경로(`reviewKind`)가 첫째 묶음임을 알려 준다(승인된 한계) | bot-defense §13, SCR-067 |
| 가림 | `HUMAN_BASELINE`은 API가 `riskBand`·`behaviorSummaryBand`를 null로 주고 판정·묶음을 응답에 싣지 않는다. `PASSED_SAMPLE`은 화면이 `riskBand`·`behaviorSummaryBand`를 보여 준다. 정본 §13은 두 묶음 모두 가리라고 하므로 `PASSED_SAMPLE`은 **가림 미완**이다 | bot-defense §13, BOT-080 `sampleView` |
| 표본 수 기록 | `sampled`·`human`·`bot`·`unsure`·`population`을 `fp_review.csv` 형식으로 남긴다. 세션 ID·사람 코드는 넣지 않는다 | perf-ledger §10.5 |

- **작은 회차**: 둘째 묶음이 200건에 못 미쳐도 전수 검토로 판정할 수 있다. `population`이 0인 묶음은 "표본 없음"이고, 그 사실을 상태에 적는다. 0건을 200건처럼 채우지 않는다.
- **모집단이 0인 경우**: 그림자 판이 돌지 않은 회차는 `HUMAN_BASELINE`의 둘째 묶음 모집단이 0이다. 첫째 묶음만 검토하고, "실제 사람 기준 오탐 추정 불가(그림자 판 없음)"를 한계에 적는다. `BehaviorScore`를 적용 판으로 옮기는 판정은 하지 않는다.
- **`PASSED_SAMPLE` 가림 미완**: `sampleView`가 `PASSED_SAMPLE`에도 `riskBand`·`behaviorSummaryBand`를 null로 주는 작은 변경이 필요하다. 이 변경은 BOT-080 잔여이고, 이 기능은 코드를 고치지 않는다(감독 결정 2). `reviewKind` 노출은 승인된 한계다.

### 2.1 fp_review.csv 행 매핑

| `fp_review.csv` `batch` | 어느 배치·묶음에서 만드나 | `unsure` 셈 |
| --- | --- | --- |
| `pass` | `PASSED_SAMPLE`의 `PASSED` 묶음, 또는 `HUMAN_BASELINE`의 `PASSED` 부분 가운데 **한 곳만** | 사람이 아닌 것으로 센다 |
| `shadow_challenge` | `HUMAN_BASELINE`의 `SHADOW_CHALLENGED` 부분만 | 사람으로 센다 |

- `HUMAN_BASELINE` 전체(두 묶음이 섞인 비율)를 `shadow_challenge` 행으로 쓰지 않는다. 두 묶음을 나누기 전에는 `pass`·`shadow_challenge` 비율을 계산하지 않는다.
- 같은 회차에서 `PASSED_SAMPLE`과 `HUMAN_BASELINE`을 모두 돌리면 `pass` 행은 `PASSED_SAMPLE`에서만 만든다. `HUMAN_BASELINE`의 `PASSED` 부분은 가림 검토·중복 확인에만 쓰고 `fp_review.csv`에 다시 넣지 않는다. 같은 세션을 두 번 세지 않기 위해서다.
- `fp_review.csv` 행은 집계다. `session_ref`·`verdict_event_key`·pid를 넣지 않는다.

### 2.2 두 배치의 중복

- 같은 첫째 묶음 세션이 `PASSED_SAMPLE`과 `HUMAN_BASELINE`의 `PASSED` 부분에 모두 들어갈 수 있다.
- `HUMAN_BASELINE`의 `PASSED` 부분에 이미 `PASSED_SAMPLE`에서 판정한 세션이 있으면 **그 판정을 재사용하고 `ApplyLabel`을 두 번 부르지 않는다**(감독 결정 3). 배정에서 세션을 빼는 방식은 첫째 묶음의 무작위성을 깨므로 쓰지 않는다.
- 판정 재사용 코드는 아직 없다. 그래서 지금은 `verdict_event_key`·`session_ref`로 중복을 찾아 표로 남기고, 재사용 전에는 이중 판정·이중 라벨 위험을 한계로 적는다.
- 중복 표에는 표본 ID, 배치, `verdict_event_key`, `session_ref`, 먼저 기록한 판정, 재사용 여부, `ApplyLabel` 결과를 적는다. 같은 세션의 두 판정이 다르면 평균 내지 않고, 어느 쪽을 정본으로 쓸지 감독이 정한다.

## 3. 검토자

| 항목 | 정한 것 | 근거·비고 |
| --- | --- | --- |
| 자격 | 관제 콘솔 `/bot-review`에 들어갈 수 있는 CS 담당(`cs_agent`·`cs_lead`) 가운데 표본 검토 지침을 읽고 확인한 사람 | BOT-080 권한(`x-peaket-roles`). 새 역할을 만들지 않는다 |
| 검토자 목록 | 검토자 자리(`R1`·`R2`), 로그 가명, 교육 확인일, 담당 회차를 적은 목록을 둔다 | TR-14 |
| 독립성 | 봇 규칙·가중치·기준값을 정하거나 구현한 사람, 표본 검토 화면을 구현한 세션은 검토자가 될 수 없다. 카드에 pid·계정 ID가 없어 '그 표본의 계정 소유자'는 검토자가 확인할 수 없다. 검토자 목록과 이해관계 self-declaration으로 확인하고, 이해관계가 있으면 다른 검토자로 바꾼다 | 추천 적용. 제품 강제가 아니다 |
| 가림 | 판정·묶음·위험 범주를 보지 않는다. `PASSED_SAMPLE`은 위험·행동 범주와 첫째 묶음이 보이는 승인된 한계가 있다. 검토 전에 집계·다른 검토자의 판정·`fp_review.csv`를 보지 않는다 | bot-defense §13, 감독 결정 2·5 |
| 한 표본 한 검토자 | 한 표본은 한 검토자가 한 번만 판정한다. 같은 표본을 두 사람이 따로 판정해 평균을 내지 않는다 | BOT-080 '표본마다 한 번' |
| 표본 밖 교차 확인 | 표본 200건 밖의 20건 [가정]을 두 검토자가 **함께 보고** 라벨 기준을 맞춘다. 한 카드는 **한 사람만 기록**하고, 20건은 판정 기록·`ApplyLabel`에 넣지 않는다. BOT-080은 두 번째 판정을 409로 막고 판 2 경로가 없어 제품 안 교차 확인이 불가능하다 | 추천 적용, TR-02 |
| 피로 | 50건마다 쉬고, 검토자 한 사람이 하루에 200건을 넘기지 않는다. 넘기면 다음 날 이어서 한다 | 추천 적용 |
| 기록 | 판정자 신원은 보안 로그 줄 `ops_bot_review_judgement`의 처리자 로그 가명(`accountRef`)으로 남는다. 이 기록에는 검토자 자리와 로그 가명만 쓰고 관리 계정 원문 ID는 쓰지 않는다 | ASVS 16.3.3, docs/observability.md §7 |
| 교육 | 라벨 정의(사람·봇·판단 불가), 봇 라벨의 '행동 요약 밖 근거' 규칙, 판단 불가의 보수적 셈을 읽고 확인한다 | bot-defense §13, perf-ledger §10.6 |

- **왜 새 역할을 만들지 않나**: BOT-080의 판정 API는 이미 `Principal`을 `acted_by`로 받고 감사 로그에 로그 가명을 남긴다. 새 역할을 만들면 권한 표·계약·화면을 함께 고쳐야 해서 이 기능의 동결 범위를 넘는다.
- **검토자 수가 하나뿐일 때**: 표본 밖 20건 교차 확인을 못 했다는 사실과 그로 인한 한계(한 사람의 기준이 라벨에 섞임)를 이 기록에 적는다. "검토 완료"로 쓰지 않는다.

## 4. 판정

| 항목 | 정한 것 | 근거 |
| --- | --- | --- |
| 라벨 | `HUMAN`·`BOT`·`UNDECIDED` 셋뿐이다. 새 라벨을 만들지 않는다 | bot-defense §13, BOT-080 계약 |
| 봇 근거 | 행동 요약 밖의 근거가 하나 이상 있을 때만 `BOT`을 붙인다. 근거 종류는 `CONFIRMED_SIGNAL`(확정 신호)·`SHARED_DEVICE_OR_PAYMENT`(같은 기기·결제 수단 공유)·`POST_LABEL`(사후 라벨)·`VERIFICATION_FAILED`(추가 검증 실패)다. `OTHER` 하나만으로는 `BOT`을 붙이지 않는다(추천 적용, 제품은 강제하지 않는다) | bot-defense §13, BOT-080 판정 근거 종류 |
| 판단 불가 | `UNDECIDED`는 trust-svc로 보내지 않고 ops DB 판정 기록에만 남긴다. `HUMAN_BASELINE`에서는 사람으로, `PASSED_SAMPLE`에서는 사람이 아닌 것으로 센다 | bot-defense §13, §9 |
| 사람 라벨 | `HUMAN`은 `ApplyLabel`로 반영한다. 그 판정의 근거에 차단 기기 목록이 있었으면 키를 지운다. 부정 예매 조치(`FRAUD_ACTIONED`)가 올린 키는 지우지 않는다 | bot-defense §9, B-T9 |
| 봇 라벨 | `BOT`은 `ApplyLabel`로 반영한다. 차단 키는 그 표본의 `verdict_event_key`가 가리키는 판정 근거의 기기만 바꾼다. 같은 사람의 다른 기기·다른 판정은 바꾸지 않는다 | bot-defense §9, B-T9 |
| 한 번만 | 한 표본은 한 번만 판정한다. 다시 판정하는 길은 이 기능에서 열지 않는다. 정정은 CS 이의 인정(§12)으로만 한다 | BOT-080 '표본마다 한 번' |
| 반영 실패 | `ApplyLabel`이 실패하면 판정 행을 쓰지 않고 화면은 503 `bot-review-label-unavailable`을 받는다. 같은 표본을 다시 판정해 반영한다. 실패를 판정 완료로 세지 않는다 | BOT-080, ASVS 16.3.4 |
| 기록할 것 | 표본 ID, 묶음(`review_batch`), 라벨, 근거 종류, 판정 시각, `applied_verdict`, `verdict_event_key`, `ApplyLabel` 결과(`APPLIED`·`UNCHANGED`·`DEVICE_NOT_FOUND`·`SKIPPED`), 503 재시도 수 | BOT-080 판정 표·감사 로그 |

- **`PASSED_SAMPLE` 근거 구멍**: BOT-080의 `evidenceRequired()`는 `HUMAN_BASELINE`의 `BOT`에만 걸린다. 그래서 `PASSED_SAMPLE`은 근거 0개로도 `BOT` 200이 될 수 있다. 감독 결정 4로 `evidenceRequired()`를 두 `reviewKind`에 거는 것을 BOT-080 잔여로 승인했다. 이 기능은 코드를 고치지 않고 현재 상태를 한계·체크리스트 9에 적는다.
- **판정 순서**: 카드의 세션 기록(행동 요약, 타임라인, 근거 후보)을 읽고 라벨을 정하고 근거 종류를 고른 뒤 저장한다. 저장 전에 다른 카드의 판정·집계를 보지 않는다.
- **판단 불가의 예**: 기록이 잘려 사람·봇을 가를 수 없음, 확장 프로그램 때문에 허니팟이 눌린 것으로 보임, 기기 공유가 가족·PC방일 수 있음. 이때는 `UNDECIDED`로 두고 이유를 한 줄 적는다.

## 5. 보존

| 자료 | 보존 | 이 기능에서 |
| --- | --- | --- |
| 표본 후보 원장 `bot_sample_review` | `open_at` + 30일 [가정]. 30일 뒤 세션 ID를 지우고 등급별 집계만 남긴다 | 적재 주인이 미정이다. OPS-220은 dbt 범위로 끝났고 `data/`에 표가 없다. BOT-080은 표본 배정 대기다 |
| 표본 검토 배치 `bot_review_batch` | `retention_until`(오픈 + 30일 [가정])·`r2_due_at`(오픈 + 7일 [가정]). 30일이 지나면 목록·판정 API가 410 `retention-ended`다 | BOT-080이 구현했다. 이 기능은 값을 바꾸지 않는다 |
| 표본 카드 `bot_review_sample` | 배치와 같은 수명. pid·IP·기기 가명·계정 ID·점수 원값·가중치를 두지 않는다 | 같다 |
| 판정 `bot_review_judgement` | 표본과 같은 수명. 표본 ID·라벨·근거 종류·라벨 결과·시각만 둔다. 검토자 원문 ID를 두지 않는다 | 같다. 물리 삭제 작업은 아직 없다(남는 한계) |
| 판정 감사 로그 `ops_bot_review_judgement` | 로그 보존 규칙을 따른다. 처리자의 로그 가명만 둔다 | ASVS 16.3.3, docs/observability.md §7 |
| `fp_review.csv` | 두 묶음의 집계. 세션 ID·사람 코드가 없다 | R2 마감에 쓴다. 이번에는 실값이 없다 |
| 행동 신호 원시 `trust.behavior_raw` | 30일 | 표가 아직 없다(OPS-180). 표본 검토의 원천이 생기면 이 보존 안에서만 본다 |

- **30일을 늘리지 않는다**: 표본 검토 때문에 보존을 늘리거나 새 사본을 만들지 않는다. 30일 안에 검토를 끝내는 것이 원칙이고, 못 끝내면 `판정 보류`다.
- **R2와의 관계**: R2(오픈 + 7일) 전에 검토를 끝내야 한다. 끝내지 못하면 봇 지표는 `판정 보류`이고 `BehaviorScore`는 그림자에 남는다(ADR-0174 '되돌릴 조건', perf-ledger §10.6).
- **물리 삭제의 빈틈**: ops DB의 배치·카드·판정 행을 30일 뒤 지우는 작업은 BOT-080에 없다. API는 410으로 막지만 행은 남는다. 이 기능은 삭제 작업을 만들지 않고, 남는 한계에 적는다.
- **원장 적재 주인 없음**: `bot_sample_review` DDL·적재기와 `bot-review-assign` 스케줄러의 주인이 없다. 첫 온세일 전에 정하지 않으면 표본 검토가 시작되지 않는다. `docs/lanes/lane1-cleanup.md`와 소유자 결정 목록에 있다(감독 결정 1).

## 6. 마감 체크리스트

체크리스트 15줄이다. `미완`이 하나라도 있으면 전체 상태는 `절차 마감·판정 보류`다.

| # | 확인할 것 | 상태·근거 |
| --- | --- | --- |
| 1 | 첫 온세일 회차가 정해졌다 | 미완. 출시 전이라 회차가 없다 |
| 2 | `PASSED_SAMPLE`·`HUMAN_BASELINE` 배치가 있다 | 미완. 배치를 만들 회차·모집단이 없다 |
| 3 | 후보 원장 `bot_sample_review`가 채워졌다 | 미완. 원장 적재 주인 미정. OPS-220은 dbt 범위로 끝났고 표가 없다 |
| 4 | 묶음마다 200건 [가정] 이상이거나 전수 검토다 | 미완. 표본 0건 |
| 5 | 무작위 정렬(`ORDER BY rand()`)·섞기 `seed`·`population`이 기록됐다. 뽑기 선택은 재현 불가임을 적었다 | 미완 |
| 6 | 카드 가림(판정·묶음·위험 범주)을 확인했다 | `HUMAN_BASELINE`은 완료. `PASSED_SAMPLE`은 가림 미완(위험·행동 범주와 `reviewKind` 노출). 승인된 한계다 |
| 7 | 검토자 목록·이해관계·교육을 확인했다 | 미완. 검토자를 배정하지 않았다 |
| 8 | 모든 표본을 한 번씩 판정했다 | 미완. 표본 0건 |
| 9 | `BOT`마다 행동 요약 밖 근거가 있다 | 미완. 판정 0건. `PASSED_SAMPLE`은 지금 근거 0개로도 `BOT` 200이 가능하다(BOT-080 잔여) |
| 10 | `UNDECIDED`를 보수적 방향으로 셌다 | 미완 |
| 11 | `ApplyLabel` 결과를 표본마다 남겼다 | 미완 |
| 12 | `fp_review.csv`의 `pass`·`shadow_challenge` 행을 2.1 매핑대로 만들었다 | 미완 |
| 13 | R2(오픈 + 7일) 전에 끝냈다 | 미완 |
| 14 | 수치 주장이 허용 목록 밖으로 나가지 않았다 | 이 기록·블로그 검사로 확인 |
| 15 | 두 배치의 중복 세션을 찾아 판정 재사용 여부를 기록했다 | 미완. 배치가 없어 중복을 셀 수 없다 |

## 7. 수치와 한계

- F-11-1 K6는 미실행·재지 못했다. 그래서 탐지율·오탐률·봇 점유율의 **실측값 없음**이다. 이 기록은 표본·가정·한계만 적는다.
- 30,000건/초·100만·K 수치는 이 기능이 재지 않았고 새로 주장하지 않는다. `fp_review.csv` 실값도 없다.
- 표본 검토의 수치 주장은 아래 표의 설계 값으로만 한다. 측정 결과처럼 읽히는 새 값을 만들지 않는다.

### 숫자 표

| 숫자 | 표시 | 정본 |
| --- | --- | --- |
| 200건 | [가정] | docs/features/bot-defense.md §13 |
| 30일 | [가정] | docs/features/bot-defense.md §14 |
| 7일 | [가정] | docs/perf-ledger.md §10.6 |
| 20건 | [가정] | docs/features/bot-defense.md §13 |
| 0.5% | 설계 목표 상한 | docs/planning/02-requirements.md NFR-022 |
| 95% | 설계 목표 | docs/planning/02-requirements.md NFR-022 |
| 5% | 설계 목표 | docs/features/bot-defense.md §19·docs/planning/01-overview.md §5.2 |

- **남는 한계**: 첫 온세일 전이라 실제 표본·검토자·판정이 없다. `PASSED_SAMPLE` 가림 미완, `reviewKind` 노출, `PASSED_SAMPLE` BOT 근거 0개 허용, 두 배치 중복 위험, 원장 적재 주인 미정, ops DB 물리 삭제 작업 없음이 남는다. F-11-1 K6와 F-11-3 시뮬레이터가 없어 탐지율·오탐률을 말할 수 없다.

## 8. 경계와 하지 않은 것

| 이웃 | 이 기능이 하지 않는 것 |
| --- | --- |
| F-11-1(K6) | K6를 대신 돌리지 않고 혼동 행렬·탐지율·오탐률·경제성 수치를 만들지 않는다. K6는 미실행 사실로만 적는다 |
| F-11-3(BAS-250) | 모의 봇을 만들지 않고 12칸 등급표를 새로 정의하지 않는다. `F-11-3`은 범위 밖이다 |
| F-04-18(포렌식) | `F-04-18`의 2D 캔버스·추천 패널을 만들지 않고, 사후 조사 라벨(`FRAUD_ACTIONED`·`FRAUD_APPEAL_ACCEPTED`)을 표본 검토 라벨로 바꾸지 않는다. `FRAUD_ACTIONED`는 차단 키 보존 규칙에만 나온다 |
| BOT-080 | REST·화면·판정 코드를 고치지 않는다. `PASSED_SAMPLE` 가림, `evidenceRequired`, 중복 재사용, `bot-review-assign` 스케줄러는 BOT-080 잔여다. BUILD_ORDER 단계는 `표본 배정 대기`다 |
| BOT-090 | 표본 재판정을 이의 처리로 대신하지 않는다. 정정은 CS 이의 인정으로만 한다 |
| OPS-220 | dbt 15사실·11차원으로 끝났고 `bot_sample_review` 적재는 그 범위에 없다. **원장 적재 주인**은 **미정**이다 |
| F-08-7 | 블로그 목차의 행·순서를 바꾸지 않고 M3 행의 상태·링크만 고친다 |

## 9. 출처

- docs/features/bot-defense.md §9(차단 기기 목록·라벨 반영)·§12(이의)·§13(표본 검토)·§14(보존)·§19(남는 한계)
- docs/perf-ledger.md §10.5(`fp_review.csv`)·§10.6(출시 뒤 실제 사람 기준)
- docs/security/asvs/bot-defense.md '측정 요구사항' 행, ASVS 16.3.3
- docs/data.md의 `bot_sample_review` 행, docs/BUILD_ORDER.md BAT-197·BOT-080·OPS-220 줄
- docs/review/plans/F-11-2.md §3·§13·§14, 감독 결정 2026-11-26
- ADR-0039·0048·0128·0174·0258·0259·0373·0386
