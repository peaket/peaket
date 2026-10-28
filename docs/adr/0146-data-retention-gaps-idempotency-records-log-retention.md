# ADR-0146: 상위 설계와 하위 문서 대조에서 나온 데이터·보존 보완(추천 적용 묶음, 2026-10-29)

- **상태**: 채택 (2026-10-29. 소유자 요청 "이제 /docs 경로에 있는 설계문서들의 내용이 그 아래 경로인 /api, /features, /quality, /security 에 온전히 잘 반영되어있는지 검토해주고 미진한 부분은 보완 다해주세요."에 따른 대조 점검(review R-166)의 판단이다. 방향은 소유자 요청이고, 세부는 모두 추천 적용이다.) 2026-10-29(문서 대조 반영 뒤 고쳐 읽기, R-166): 결정 4의 PostgreSQL 로그 30일은 pgAudit 세션 기록(관리자 접속기록, 2년 이상)에는 해당하지 않는다. pgAudit 줄은 로그 그룹의 구독 필터로 골라 서울 Firehose를 거쳐 서울 S3 감사 버킷(Object Lock)에 옮긴다.
- **관련**: ADR-0052(분석 마감), ADR-0053(감사 체인), ADR-0075(공개 앵커), ADR-0089(법정 접속기록), ADR-0099(스트림 작업자), ADR-0113(주문 상태 전이), ADR-0140(결제 결과 당기기), [docs/data.md](../data.md) §2·§6, [docs/security/data-classification.md](../security/data-classification.md), [docs/observability.md](../observability.md) §9

## 맥락

API·보안 문서는 값을 이미 쓰는데 데이터 정본(docs/data.md)에 표나 칸이 없는 곳, 그리고 보존 기간이 어디에도 없는 로그가 대조 점검에서 나왔다.

## 결정

1. **서비스마다 멱등 기록 표**: openapi가 `Idempotency-Key`를 요구하는 쓰기 가운데 홀드(Redis)와 주문 세 작업(`order_idempotency`) 밖의 작업은 그 서비스 DB의 `idempotency_record(account_ref, operation, idempotency_key, request_hash, result_ref, created_at)`에 남긴다. 기본 키는 앞의 셋이고, `operation`은 그 서비스 작업 목록으로 제한한다. 24시간 [가정] 뒤 정비 시간에 지운다. purchase의 `order_idempotency`는 지금 이름 그대로 둔다(같은 꼴).
2. **주문의 결제 사건 순번 칸**: `purchase_order`에 `payment_event_seq bigint NOT NULL DEFAULT 0`을 둔다. 결제 결과 반영 UPDATE는 주문 상태 전이 함수 안에서 `WHERE payment_event_seq < $seq` 조건으로 한다. 사건과 당기기(ADR-0140) 어느 길로 와도 같은 결과를 두 번 반영하지 않는다. `payment_event`의 칸(`payment_id`, `seq`, `event_key`, 종류, 내보냄 여부, `occurred_at`)도 data.md에 그린다.
3. **운영 명령 감사 기록의 분류**: `command_event`·`command_approval`(요청자·승인자 관리 계정 ID, 사유, 재인증·서명, 시각)을 data-classification 개인정보 목록에 P2로 올린다. 보존은 NFR-017대로 영구다. 다만 관리 계정 ID를 퇴직 뒤까지 영구히 두는 법적 근거는 문서만으로 확인하지 못해 '확인 필요'로 둔다(POL-027). 일정 기간 뒤 계정 ID를 역할 이름과 가명 참조로 바꾸는 안(감사 체인은 잎 솔트로 해시 유지)은 review/open-items.md에 소유자 결정으로 남긴다.
4. **PostgreSQL 로그 보존**: Aurora 로그 내보내기로 CloudWatch Logs(서울)에 쌓는 PostgreSQL 로그(`auto_explain` 실행 계획, 잠금 대기, 임시 파일, 오류 줄)는 30일 [가정, wbs 4.1.2] 보존으로 정한다. 로그 그룹의 기본값이 '만료 없음'이라 정하지 않으면 끝없이 남는다. 쿼리 문장·오류 상세에 값이 섞일 수 있어 P2로 분류하고, KMS 암호화와 DB 담당 역할만 읽게 한다.
5. **경보 기록 표 보존**: ops-svc가 받은 경보(ADR-0145 결정 9)는 ops DB 경보 기록 표에 13개월 [가정] 둔다. 월 경보 위생 보고와 분기 탐지 경로 집계, 분석 마감 R0~R3을 덮는 길이다.
6. **법정 접속기록 DB의 ClickHouse 사용자**: 넣는 사용자 `al_ingest`(INSERT만), 관리 계정 줄 읽기 `al_admin_reader`(행 정책), 수사 대응 읽기 `al_investigation`(개인 계정, POL-025)을 둔다 [가정]. 마이그레이션 역할은 따로 둔다. `access-log-export` 사본 버킷 쓰기 역할과 RB-38 복원 역할은 IAM 쪽에 적는다.
7. **실시간 원시 표 보존을 넘는 판매 기간**: 판매 기간(오픈~판매 종료)이 400일 [가정]을 넘는 회차는 판매 승인 때 경고하고, 그 회차의 R3 실시간 대비 대조는 '판정 보류(원시 표 보존 초과)'로 둔다. 보존을 회차마다 늘리는 열은 두지 않는다.
8. **`QueueAggregate`의 파드 값**: 실시간 원시 표의 파드 값은 메시지 키 '회차:파드'의 ':' 뒤에서 꺼낸다. 계약(asyncapi·Avro)에는 `pod` 필드를 더하지 않는다.

## 검토한 대안

- 멱등 기록을 Redis에만: 재시작·장애 조치 때 기록을 잃어 같은 요청이 두 번 처리될 수 있다.
- 결제 사건 순번을 따로 표로: 주문 상태 전이 함수 한 곳의 조건부 UPDATE가 더 단순하다.
- 운영 명령 감사 기록에서 계정 ID를 바로 지우기: 감사 추적이 끊긴다. 소유자 결정으로 남긴다.

## 결과와 트레이드오프

- 서비스 DB 표가 하나씩 늘고 정리 작업이 하나 는다.
- 로그·경보 기록에 끝이 생긴다. 그보다 오래된 원인 분석은 할 수 없다.

## 남는 한계

- 운영 명령 감사 기록의 영구 보존 근거는 확인 필요다.
- 판매 기간이 400일을 넘는 회차는 실시간 대비 대조를 하지 못한다.
