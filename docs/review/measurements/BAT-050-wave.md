# 웨이브 보고서: 갈래 1 BAT-050

- 날짜: 2026-11-13
- 가지: `wave/lane1-BAT-050-ticket`(바탕 `origin/develop` `1ef9e0c7`, 합치기·푸시 안 함)
- 배치: BAT-050(HOT-160, A, R-533)
- 웨이브 규칙: ADR-0267(배치마다 싼 게이트, 웨이브 끝에 비싼 게이트 한 번)

## 1. 커밋·rebase

| R | 커밋 | 내용 |
| --- | --- | --- |
| R-533 | `ff53cfb0`(rebase 전 `5007d69d`) | ticket-svc 최소 발권·취소·월렛, payment-svc `TicketIssuer` 포트·gRPC 어댑터 |
| R-533 amend | 이 보고서를 포함한 최종 커밋 | heavy gate에서 찾은 동시 취소 멱등·마이그레이션 실행기·지문·상태 CHECK·응답 좌석 검증·종료 순서 수정, test-int·문서 |

- `origin/develop` `1ef9e0c7` 위로 rebase 완료. 충돌 없음.
- `wave/lane1-BAT-090`은 `f17b26f5` 그대로 두었다.

## 2. 게이트

| 게이트 | 결과 |
| --- | --- |
| ticket-svc 단위·계약 | **19건 통과** — 도메인 5, 서비스 8, gRPC 3, proto 3 |
| ticket-svc 실제 PostgreSQL test-int | **9건 통과** — `0000_ticket.sql`·마이그레이션 재적용, 발권 멱등·동시 발권, 내용 지문 충돌, 키 해시·QR, 취소표·키 폐기, 요청자/보유자/양도/입장 시작, `FOR UPDATE` 동시 취소, 같은 `cancellation_id` 동시 취소, 월렛 커서, payment-svc `TicketGrpcIssuer` 실제 gRPC |
| payment-svc 전체 | **2,907건 통과**(새 `ticket-issuer` 3건 포함) |
| 변이 | **17개 넣어 17개 잡음, 놓침 0, 무효 0** |
| 4관점 리뷰 | 높음 2(고침), 중간 4(고침), 낮음 2(1 고침·1 남김) |
| typecheck·build | ticket-svc·payment-svc 통과 |
| lint | 바뀐 `src` 통과(test-int는 eslint 설정 밖) |
| doc-check | 오류 0, 경고 4(기존 API 3·mermaid 건너뜀) |
| `ledger --batch BAT-050 --require` | 통과(자동 시험 59, ID만 0, 빈칸 0, 다른 단계 38) |
| `trace-check P-T15` | 통과(시험 22개) |
| `records --check` | 통과(R-374·R-473 기존 경고만) |
| generated contracts | `check-generated` 통과 |
| 브라우저 확인 | **생략** — ticket-svc 서버·gRPC·DB 경로만 바뀌었고 화면 렌더링 변경이 없다. 월렛 HTTP 연결은 후속이다. |
| CI | GitHub Actions는 푸시 금지로 돌리지 않았다. 위 로컬 등가 게이트로 대신했다 |

## 3. test-int 조건

- PostgreSQL `postgres:18-alpine` 컨테이너, 무작위 포트, Docker 29.8.1.
- `scripts/migrate.mjs`가 `migrations/*.sql`을 이름 순으로 적용하고 `ticket_migration`에 기록한다. 같은 실행을 두 번 해도 새 적용 0건이다.
- `DrizzleTicketStore`로 실제 INSERT/UPDATE/SELECT/FOR UPDATE를 돈다.
- 마지막 시험은 ticket-svc gRPC 서버를 띄우고 payment-svc `TicketGrpcIssuer`가 실제 gRPC로 `IssueTickets`를 부른다(재요청 같은 티켓).

## 4. 변이 17개

- 발권: 같은 주문·세대 기존 발권 무시, 지문에서 발권 세대 제거, 지문에서 좌석 제거, Drizzle 충돌 무시 제거.
- 키: 티켓 키 해시가 원문 반환.
- 취소: 같은 `cancellation_id` 취소표 무시(메모리·Drizzle 행 잠금 뒤), 요청자=결제자=보유자 검사 제거, 양도 요청 검사 제거, 입장 시작 판정 제거, 이미 환급·무효 검사 제거, 키 폐기 시각 제거, 취소표 INSERT 제거, `FOR UPDATE` 제거.
- gRPC·payment: 입력 오류를 INTERNAL로, UNAVAILABLE을 재시도 불가로, 발권 실패를 성공 빈 목록으로.

결과: **17/17 잡힘**. 결과 파일 `.cache/bat050-mutations.md`.

## 5. 4관점 리뷰

- **높음 2(고침)**
  1. 같은 `cancellation_id`가 동시에 오면 Drizzle 취소가 행 잠금 전 취소표만 보고 둘째를 `ALREADY_CANCELLED`로 답했다. 행 잠금 뒤 취소표를 다시 보고 같은 결과(`REFUND_NOW`)를 돌려주게 고쳤고, 같은 ID 동시 취소 test-int를 더했다.
  2. `scripts/migrate.mjs`가 Drizzle 메타 저널 없이 `0000_ticket.sql`만 있어 실제 실행이 되지 않았다. `ticket_migration` 표와 SQL 파일 순차 적용으로 바꾸고 test-int가 이 실행기를 쓰게 했다.
- **중간 4(고침)**
  1. 멱등 지문에 `event_starts_at`(표시 값)이 들어가 회차 시작 시각이 보정된 재요청이 충돌했다. 지문에서 뺐다.
  2. DB CHECK가 네 상태만 허용해 정본 `ticket.status`의 `TRANSFER_PENDING`·`CANCEL_REQUESTED`·`FLAGGED`와 어긋났고, 그 행을 읽으면 `recordOf`가 던졌다. CHECK와 상태 타입·취소 판정을 일곱 상태로 맞췄다.
  3. payment-svc `TicketGrpcIssuer`가 응답 좌석이 요청과 달라도 성공으로 받았다. 좌석 집합·중복·상태를 검증하고 불일치는 `unknown` 실패로 바꿨다.
  4. `start.ts`가 `createService`·gRPC 시작 실패 때 DB 풀을 닫지 않았고, 종료 때 `service.close()`가 던지면 DB를 닫지 않았다. 실패·종료 모두 DB를 닫게 고쳤다.
- **낮음 2**
  1. gRPC 취소가 `Date.now()`를 써 주입 시계를 무시했다. `TicketGrpcUseCases.nowMs`로 주입하게 고쳤다.
  2. 월렛 HTTP `GET /v1/tickets` 연결, `gate_zone` 채우기, 기기 키·회전 QR(ADR-0025), 나머지 RPC는 후속으로 남겼다.

## 6. 남은 문제

1. 실제 Saga 연결(PRF-170 `TicketIssueRunner`가 `TicketIssuer`를 부르는 일), CS `TICKET_NOT_ISSUED` 건, 보상(T20)은 후속.
2. `gate_zone`은 좌석 배치 연결 전이라 빈 값. 기기 키 등록·회전 QR(ADR-0025)도 후속.
3. `VoidTickets`·`OperatorCancelTickets`·`CheckReviewEligibility`·`ListHeldTickets`·`ScannerDeviceService`는 이 최소 서버에서 `UNIMPLEMENTED`.
4. 월렛 HTTP 경로는 gRPC `ListTickets`만 있고 게이트웨이 연결은 후속.
5. 이번 웨이브는 성능 측정 대상이 아니다. Docker test-int만 돌렸고, 부하 측정은 하지 않았다.

## 7. 컨테이너

- test-int의 PostgreSQL 컨테이너는 `afterAll`에서 `docker rm -f -v`로 지운다. 웨이브 마지막에 `docker ps -a`로 남은 `postgres:18-alpine` 컨테이너가 없는지 확인한다.
