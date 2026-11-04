# PEAKET 설계 해설서: 길잡이

- **기준 시점**: ADR-0177까지, 2026-11-02(빌드 루프의 FND-130 커밋까지). 2026-11-03에 ADR-0179~0182, 정본의 v0 베이스라인 절, 새 계정 표 셋, 검증 §3.9·§3.10의 설명을 더했다
- **이 해설서가 하는 일**: PEAKET의 설계 전체(docs/ 아래 정본)를 면접관 앞에서 설명할 수 있게 이해하도록 돕는다.
- **규범이 아니다**: 해설서는 정본을 풀어 쓴 것이고 새 결정을 담지 않는다. 숫자와 규칙이 정본과 다르면 정본이 맞고, 해설서를 고친다. 정본에 근거가 없는 것은 지어내지 않는다([ADR-0177](../adr/0177-walkthrough-explain-in-interview.md)).

## 1. '설명할 수 있다'의 뜻

이 해설서는 다음 두 가지를 목표로 한다.

- **길이를 바꿔 말할 수 있다**: 같은 주제를 10초, 30초, 3분으로 말한다.
- **꼬리 질문에 막히지 않는다**: 다섯 단의 질문에 답한다.

| 단 | 면접관의 질문 | 답할 거리 |
| --- | --- | --- |
| 1 | 왜 이렇게 했나요? | 풀려던 문제와 조건(숫자) |
| 2 | 다른 방법은요? | 검토한 대안과 기각한 이유 |
| 3 | 그게 고장 나면요? | 장애 때 동작과 남는 위험 |
| 4 | 그 숫자는 어디서 나왔나요? | 어림의 계산과 `[가정]` 여부 |
| 5 | 실제로 해 봤나요? | 만든 것, 잰 것, 아직 재지 않은 것과 잴 방법 |

## 2. 구성

| 문서 | 하는 일 | 상태 |
| --- | --- | --- |
| [한 판 문서](01-system-design.md) | 시스템 디자인 면접 순서로, 요구사항에서 완성된 구조까지 그림 하나를 키워 가며 한 번에 따라간다(18단계) | 씀(2026-11-01) |
| [현황 한 장](00-status.md) | 만든 것, 설계만 한 것, 잰 것. 면접 직전에 다시 센다 | 씀(2026-11-01), 고침(2026-11-02) |
| 분야 편 23편 | 정본 문서 묶음마다 한 편. 절마다 '무엇을, 왜'를 풀어 정본을 읽을 수 있게 한다(§3) | 23편 모두 씀(2026-11-01~02) |
| [결정 카드](decisions/README.md) | 기술·기법마다 고른 이유, 후보 비교, 얻는 것과 치르는 값, 바꿀 조건, 꼬리 질문. 34장과 ADR 182건 자리표 | 씀(2026-11-01) |
| DB 설계 편 14편 | DB 면접 순서로 한 단계씩(1~11편), 그다음 전체 지도(12편)로 한눈에 보고, 표 사전(13·14편)으로 표와 키를 하나씩 찾는다(§4) | 1~11편 씀(2026-11-01), 12~14편 씀(2026-11-02) |
| [덮개 표](coverage.md) | 정본의 큰 절, ADR, FR·NFR·POL·SCR·CMP마다 그것을 설명하는 편. 빈칸이 0이면 docs 전체를 덮었다고 본다 | 씀(2026-11-02) |

docs/architecture.md는 한 판 문서와 결정 카드가 맡고, docs/data.md는 DB 설계 편이 맡는다. 나머지 정본은 아래 분야 편이 맡는다.

## 3. 분야 편 23편

'중요도'는 면접에서 설명할 일이 얼마나 많은지다. '상'은 설명할 수 있게, '하'는 무엇이 있고 어디서 찾는지 알게 읽는다.

| 번호 | 분야 편 | 맡는 정본 | 중요도 | 상태 |
| --- | --- | --- | --- | --- |
| 1 | [무엇을 왜 만드나](fields/01-why-and-what.md) | docs/planning/00-executive-summary.md, docs/planning/01-overview.md | 상 | 씀(2026-11-01) |
| 2 | [요구사항 FR·NFR](fields/02-requirements.md) | docs/planning/02-requirements.md, docs/quality/quality-requirements.md | 상 | 씀(2026-11-01) |
| 3 | [정책과 용어](fields/03-policies-glossary.md) | docs/planning/03-policies-glossary.md | 중 | 씀(2026-11-01) |
| 4 | [화면 흐름](fields/04-screens-and-flows.md) | docs/planning/04-ia-flows-screens.md, docs/design/d1-brief.md, docs/design/d3-screens.md, docs/design/d5-screen-blueprint.md | 중 | 씀(2026-11-01) |
| 5 | [디자인 시스템](fields/05-design-system.md) | docs/design/d2-design-system.md, docs/design/d4-handoff-checklist.md | 하 | 씀(2026-11-01) |
| 6 | [프론트엔드 구조](fields/06-frontend.md) | docs/frontend.md | 중 | 씀(2026-11-01) |
| 7 | [API 규칙과 계약](fields/07-api-contracts.md) | docs/api/guidelines.md, docs/api/proto/README.md, docs/api/avro/README.md | 중 | 씀(2026-11-01) |
| 8 | [로그인·본인확인·계정](fields/08-identity.md) | docs/features/identity.md | 상 | 씀(2026-11-01) |
| 9 | [대기열·입장](fields/09-queue-admission.md) | docs/features/queue-admission.md | 상 | 씀(2026-11-01) |
| 10 | [좌석](fields/10-seat-hold.md) | docs/features/seat-hold.md | 상 | 씀(2026-11-01) |
| 11 | [결제](fields/11-payment.md) | docs/features/payment.md | 상 | 씀(2026-11-01) |
| 12 | [양도·환불·정산](fields/12-transfer-refund-settlement.md) | docs/features/transfer-refund.md, docs/features/settlement.md | 상 | 씀(2026-11-01) |
| 13 | [현장 입장](fields/13-offline-gate.md) | docs/features/offline-gate.md | 상 | 씀(2026-11-01) |
| 14 | [봇 방어](fields/14-bot-defense.md) | docs/features/bot-defense.md | 상 | 씀(2026-11-01) |
| 15 | [알림·검색](fields/15-notify-search.md) | docs/features/notify.md, docs/features/search.md | 중 | 씀(2026-11-01) |
| 16 | [관제탑](fields/16-control-tower.md) | docs/features/control-tower.md | 중 | 씀(2026-11-01) |
| 17 | [분석·사후 포렌식](fields/17-analytics-forensics.md) | docs/features/analytics.md, docs/features/forensic-replay.md | 중 | 씀(2026-11-01) |
| 18 | [이벤트 흐름](fields/18-streaming.md) | docs/streaming.md | 중 | 씀(2026-11-01) |
| 19 | [관측](fields/19-observability.md) | docs/observability.md | 중 | 씀(2026-11-01) |
| 20 | [인프라·배포](fields/20-infra-devops.md) | docs/infra.md, docs/devops.md, docs/infra-handover.md | 중 | 씀(2026-11-01) |
| 21 | [보안](fields/21-security.md) | docs/security/ 아래 문서 여섯과 기능별 ASVS 점검표 17편과 v0 베이스라인 표 | 상 | 씀(2026-11-01) |
| 22 | [검증과 측정](fields/22-verification.md) | docs/verification.md, docs/perf-ledger.md | 상 | 씀(2026-11-01) |
| 23 | [일정·진행·검토 기록](fields/23-plans-progress-reviews.md) | docs/wbs/wbs.md, docs/BUILD_ORDER.md, docs/PROGRESS.md, docs/review/ 아래 문서 셋, docs/00-summary.md, docs/00-diagnosis.md, docs/features/README.md | 하 | 씀(2026-11-02) |

## 4. DB 설계 편 14편

1~11편은 면접관의 질문으로 시작해 '단순한 답 → 어디서 깨지나 → 지금 설계 → 트레이드오프 → 꼬리 질문' 순서로 간다(2026-11-01). 12~14편은 그 질문들을 다 지난 뒤 DB 전체를 한 번에 보는 편이다(2026-11-02). 12편은 저장소와 표 전체를 한 장으로 보여 주고, 13·14편은 표와 키를 하나도 빼지 않고 풀이한다. PostgreSQL 표 152개와 ERD 밖의 표, Redis 키 67줄, ClickHouse 표, S3와 기기 저장소를 모두 다룬다.

1. [무엇을 얼마나 저장하나: 읽고 쓰는 방식과 양 어림](db/01-what-and-how-much.md)
2. [저장소 고르기: 쓰는 저장소와 쓰지 않기로 한 저장소](db/02-choose-stores.md)
3. [핵심 표와 관계](db/03-core-tables.md)
4. [같은 좌석을 두 번 팔지 않기](db/04-no-double-sale.md)
5. [일관성과 트랜잭션 경계](db/05-consistency-transactions.md)
6. [동시에 고칠 때: 잠금, 펜싱 토큰, 멱등](db/06-concurrency.md)
7. [인덱스와 쿼리](db/07-indexes-queries.md)
8. [Redis 키 설계](db/08-redis-keys.md)
9. [커질 때: 표 나누기와 복제본](db/09-scaling.md)
10. [분석 저장소](db/10-analytics-store.md)
11. [개인정보: 암호화, 보존, 파기](db/11-privacy.md)
12. [전체 지도: 저장소와 표를 한눈에](db/12-whole-map.md)
13. [표 사전 ①: PostgreSQL 표 전부](db/13-table-dictionary-postgres.md)
14. [표 사전 ②: Redis 키, ClickHouse 표, S3, 기기 안 저장소](db/14-table-dictionary-redis-clickhouse.md)

## 5. 읽는 순서

1. [한 판 문서](01-system-design.md)로 전체 구조를 한 번 훑는다. 단계마다 '꼭' 표시만 먼저 읽어도 된다.
2. 구매 길 분야 편(8~14)을 읽고, 거기서 나오는 결정 카드와 DB 설계 편 1~11을 함께 본다. DB 설계 편을 다 읽으면 12편 '전체 지도'로 DB 전체를 한 번에 보고, 모르는 표는 13·14편 표 사전에서 찾는다.
3. 나머지 분야 편을 읽는다.
4. 덮개 표로 빈칸이 없는지 확인한다.

## 6. 연습하는 법

읽기만 해서는 설명할 수 있게 되지 않는다. 한 단계나 한 편을 읽은 뒤 이렇게 한다.

1. 책을 덮고 직접 설명한다. 말로 해도 되고 글로 써도 된다.
2. Claude에게 "한 판 문서 8단계 면접해 줘"처럼 부탁한다. Claude가 면접관이 되어 꼬리 질문을 다섯 단까지 낸다.
3. 답을 정본과 대조해 틀리거나 빠진 곳을 짚는다.
4. 막힌 질문은 점검표에 남기고, 다음 연습 때 다시 묻는다.

## 7. 표시 읽는 법

| 표시 | 뜻 |
| --- | --- |
| `[가정]` | 정본이 가정한 값이다. 면접에서도 "가정한 값"이라고 말한다 |
| `[실측 전]` | 설계 목표값이고 아직 재지 않았다. 측정 기록이 생기면 바꾼다 |
| 실측(PC) | PC 한 대에서 잰 기반 PoC 숫자다([ADR-0176](../adr/0176-foundation-poc-results.md)). 부품을 고르는 근거이고 운영 규모의 증거는 아니다 |
| 꼭 / 시간 남으면 | 한 판 문서의 단계 표시. 짧은 면접은 '꼭'만, 긴 면접은 전부 말한다 |
| 기준 시점 | 그 문서가 어느 ADR까지, 어느 날짜까지의 정본을 따랐는지 |
