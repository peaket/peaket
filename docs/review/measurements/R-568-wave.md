# R-568 BAT-465 GAT-300·GAT-310 heavy gate 보고서

- 날짜: 2026-11-14
- 가지: `wave/lane3-BAT-465`
- 기준: heavy gate `14b635e8`(R-569), heavy gate 뒤 `fadaabe5`(R-566, R-570 포함) 위로 rebase
- 범위: ops-svc 명령 실행(`SCALE_CHANGE`→core-svc 규모 변경, `EVENT_CANCEL`→purchase-svc 환급), `DISPATCHED`/`SUCCEEDED`/`FAILED`·시도 횟수·재시도, 실행 전후 SHA-256 감사 체크포인트·목록·상세·검증, console-host SCR-030 명령 목록·상세·2인 승인/거부·재시도·감사 체크포인트, `updatedAfter` 5초 폴링, 내부 명령 사건 수신(eventKey 멱등).

## Docker test-int

- ops-svc 실제 PostgreSQL 18: **22건 통과**(4파일). 새 `command-execution.int.test.ts` 8건이 `0002_command_execution_audit` 적용·재적용(마이그레이션 3개), `attempts`·`last_error`·`executed_at`·`result` 칸, `SUCCEEDED`·`SCALE_CHANGE` 제약, `audit_checkpoint` 표, `SCALE_CHANGE`→core-svc와 `EVENT_CANCEL`→purchase-svc 내부 HTTP, `DISPATCHED`→`SUCCEEDED`/`FAILED`, 재시도 권한·시도 횟수·`lastError` 정리, 체크포인트 루트·직전 사슬·변조 시 실패, 내부 사건 eventKey 멱등, 2인 승인·거부를 확인했다.
- 기존 `event-cancel-dispatch.int.test.ts`도 `SUCCEEDED`·`COMMAND_EXECUTION_STARTED`/`COMMAND_SUCCEEDED` 기준으로 통과했다.
- 컨테이너는 시험마다 정리했고 남은 `ops-r568` 컨테이너가 없다.

## 변이(등급 A)

- 33개 표본: 성공/실패 상태, 시도 횟수, `lastError` 정리, 실행 전후 체크포인트, 대상 실패·예외, 재시도 경계, 1인/2인 승인, 요청자≠승인자, 체크포인트 구간·직전 해시·루트·검증, eventKey 결정성·payload 불일치·결과 상태, core/purchase HTTP 본문·확인자, DB 시도 횟수·lastError, 마이그레이션 제약.
- 결과: **33/33 잡음**. 처음 4개(성공 시 lastError 중복 정리, RetryCommand 방어선, 내부 결과 상태, DB lastError)를 놓쳐 회귀 시험을 더한 뒤 모두 잡았다.

## 4관점 리뷰

- **높음 0.**
- **중간 5(2 고침, 3 문서화·후속)**:
  1. 내부 `COMMAND_RESULT`가 승인 대기 명령도 끝낼 수 있어 승인을 우회했다 → `DISPATCHED`만 결과를 받게 고쳤다.
  2. 같은 eventKey에 다른 내용을 실으면 처음 명령을 조용히 돌려줬다 → payload가 다르면 `accepted:false`로 고쳤다.
  3. 1인 명령을 접수 요청 안에서 동기 실행해 접수 p95 500ms SLO를 넘길 수 있다 → 백그라운드 실행기 후속.
  4. 감사 체크포인트 생성에 동시성 잠금이 없어 같은 구간 체크포인트가 둘 생길 수 있다 → 잠금·유일 제약 후속.
  5. `audit_chain`에 직전 해시를 저장하지 않아 체크포인트 검증이 기록 해시 집합의 불변만 보고 체인 연결 자체는 재계산하지 못한다 → 체인 검증 작업 후속.
- **낮음 2**: `PEAKET_INTERNAL_TOKEN`이 비면 내부 경로가 열리는 기존 패턴(운영 Secret 필수), `PEAKET_CORE_HTTP_URL`/`PEAKET_PURCHASE_HTTP_URL`이 없을 때 시작 경고만 하고 준비 상태를 막지 않는다.

## CI 로컬 등가

- ops-svc 단위 **46건 통과**(기존 42 + heavy gate 회귀 4).
- console-host 단위 **54건 통과**, api-client **113건 통과**.
- root typecheck **42/42**, lint 통과.
- doc-check **오류 0, 경고 4**(기존).
- ledger `--check`·records `--check`·contracts `gen:check` 통과.
- console-host production build(webpack) 통과.
- trace **GAT-300 11건·GAT-310 8건 통과**.

## 브라우저 확인

- console-host dev 3002 + 가짜 ops API 8080에서 SCR-030 목록·상세·승인·반려·재시도·체크포인트 검증·생성·5초 폴링을 확인했다. 자세한 내용은 `docs/review/browser-check/R-568.md`.
- 실제 ops-svc HTTP는 브라우저가 아니라 unit HTTP 시험과 실제 PostgreSQL test-int로 확인했다(가짜 core-svc/purchase-svc HTTP).

## 남은 막힘

- 판매 중지·재개 명령의 실제 집행: purchase-svc/queue-svc의 판매 정지 사본(`s:{event:E}:ctl`·`q:{event:E}:ctl`)을 바꾸는 API가 없어 `target-not-wired`다.
- Kafka 소비자 어댑터: 내부 `POST /internal/v1/ops/command-events` 수신 경로와 eventKey 멱등까지다. 실제 Kafka 소비자 조립은 후속.
- SSE 스트림: `updatedAfter` 폴링만 있다. `/v1/ops/live` SSE는 후속.
- 제어 gRPC ack, 공개 앵커·체크포인트 서명·OpenTimestamps는 후속.
- 동기 1인 실행, 체크포인트 동시 생성 잠금, 감사 체인 연결 검증은 위 리뷰의 후속이다.
