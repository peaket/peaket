# BAT-465 잔여(R-584) cheap gate 기록

- **범위**: 갈래 3, BAT-465 GAT-300·GAT-310 잔여. 가지 `wave/lane3-BAT-465-remainder`(갈래 2 merge `65b3ea48` 위로 rebase, 기준 `5b73c33b`).
- **한 일**: 판매 중지·재개 집행(`SALE_STOP`/`SALE_RESUME` 2인 승인 → purchase-svc `sale_control` 0019·좌석 Redis 사본, queue-svc 대기열 사본), `ops.command-events` Kafka 소비자(HTTP 호환), SSE `/v1/ops/live`(console-host SCR-030 폴링 제거), 제어 gRPC `ControlReceiver.ApplyControl` ack, 감사 체크포인트 Ed25519 공개 앵커·검증 경로.
- **돌린 때**: 2026-11-15. cheap gate와 heavy gate(test-int·변이·4관점 리뷰·브라우저)를 이 갈래 하나가 Docker를 쓰며 돌렸다.

## rebase·재번호(갈래 2 merge 뒤)

- **rebase 충돌**: ops `http-command-executor`(갈래 2의 gRPC 환급·EVENT_REFUND_PAUSE/RESUME + 갈래 3의 판매 중지·제어 gRPC), ops `app.module`·`main`(AlertsModule·환급 클라이언트 + LiveModule·Kafka·앵커), purchase `_journal`·`0018_snapshot`(add/add), `purchase-schema.test.ts`, `docs/00-summary`·`consistency-review`(R-583·R-584 행), `openapi.yaml`(명령 유형 enum·설명). 모두 **양쪽을 살려** 풀었다.
- **재번호**: purchase `0018_sale_control` → `0019_sale_control`, ops `0003_sale_stop_command_type` → `0004_sale_stop_command_type`, `0004_held_event` → `0005_held_event`, `0005_audit_anchor` → `0006_audit_anchor`. 갈래 2의 `0018_event_refund_window_runner`·`0003_ops_alert_and_refund_commands`는 그대로.
- **스냅샷 사슬**: 0019 snapshot의 `prevId` = 갈래 2 `0018_snapshot.json`의 `id`(`93d3a95c…`). 0019는 갈래 2의 표·칸(`event_refund_attempt` 포함)에 `sale_control`을 더한 누적본이다.
- **시험 기대값**: purchase test-int 마이그레이션 수 20(0018 + 0019). ops는 새 `test/migration-0004-0006.test.ts`로 0004~0006 내용을 확인한다.
- **계약 생성물**: rebase 뒤 `packages/contracts`·`api-client`를 둘 다 다시 `gen`했고 `gen:check` 통과.
- **찾은 결함**: 0004가 명령 유형 CHECK를 다시 만들며 갈래 2의 `EVENT_REFUND_PAUSE`·`EVENT_REFUND_RESUME`을 빠뜨릴 뻔했다(시험으로 잡아 넣었다).

## cheap gate

| 게이트 | 명령 | 결과 |
| --- | --- | --- |
| ops-svc 단위 | `node node_modules/vitest/vitest.mjs run` | 79 통과(18 파일, 갈래 2 시험 포함 + 새 0004~0006 마이그레이션 시험) |
| purchase-svc 단위 | 같음 | 3846 통과(109 파일, 갈래 2가 늘린 시험 포함) |
| queue-svc 단위 | 같음 | 685 통과(38 파일) |
| console-host 단위 | `node --test` | 57 통과 |
| platform 단위 | 같음 | 532 통과 |
| contracts 단위 | 같음 | 41 통과 |
| api-client 단위 | 같음 | 113 통과 |
| typecheck | ops·purchase·queue·console-host·contracts·api-client `tsc --noEmit` | 통과 |
| lint | 뿌리 `eslint`(services·apps·packages) | 통과 |
| doc-check | `python tools/doc-check/check_all.py` | 오류 0·경고 4(기존 API 3·mermaid 1) |
| ledger | `node tools/ci/ledger.mjs --batch BAT-465` | 235항목(자동 시험 7·ID만 105·빈칸 103·해당 없음 20). 이번 몫의 시험은 ID 접두사가 GAT라 장부 자동 시험 수에는 잡히지 않는다 |
| trace-check | `node tools/ci/trace-check.mjs --ids "GAT-300,GAT-310" --report ops.json` | GAT-300 11·GAT-310 8 통과 |
| records | `node tools/ci/records.mjs --check` | "기록 표가 맞다" |
| contracts `gen:check` | `node scripts/check-generated.mjs` | 통과 |
| console-host build | `webpack --mode production` | 성공(SCR-030 청크 17.5KiB) |

## heavy gate 결과(2026-11-15)

| 게이트 | 결과 |
| --- | --- |
| ops test-int | **28 통과**(5 파일: command-execution·ops-command-audit·event-cancel-dispatch·commands-http·sale-stop-control) |
| purchase test-int | **94 통과**(4 파일: purchase-migration(마이그레이션 20)·event-refund(20)·priority-hold·sale-control) |
| queue test-int | **19 통과**(2 파일: sale-state·sale-suspension) |
| 변이 | **22/22 잡음**. 처음 1건(`pur-db-revision`)이 살아남아 판 번호 20 시험을 더해 잡았다 |
| 4관점 리뷰 | 높음 0(heavy gate에서 찾은 높음 2건은 고침), 중간 4(문서화·후속) |
| SCR-030 브라우저 | **통과**. SSE 연결·실시간 배지·`SALE_RESUME` 즉시 반영·끊김 뒤 `Last-Event-ID: 100` 재연결·reset 뒤 REST 재읽기(호출 2→4). browse 미연결로 Chrome headless CDP 사용(`docs/review/browser-check/GAT-310.md`) |
| 컨테이너 | 시험 뒤 `docker ps` 빈 목록(자동 정리 확인) |

### heavy gate에서 찾아 고친 것

- **높음**: `0004_sale_stop_command_type.sql`이 명령 유형 CHECK를 다시 만들며 갈래 2의 `EVENT_REFUND_PAUSE`·`EVENT_REFUND_RESUME`을 빠뜨렸다. 재번호 때 합치고 `test/migration-0004-0006.test.ts`로 지킨다.
- **높음**: `audit_checkpoint.signature`가 `text` 칸인데 Drizzle 저장소가 bytea(`decode(...)`)로 넣어 서명이 깨졌다(실제 DB 통합 시험에서 잡음). base64 글자를 그대로 넣게 고쳤다.
- **중간(고침)**: 판 번호가 큰 제어 gRPC 갱신을 잡는 시험이 없어 변이 1건이 살아남았다. `version 20` 사례를 더해 잡았다.
- **중간(문서화·후속)**: ① SSE 훑기가 한 번에 100건이라 같은 밀리초에 100건 넘게 바뀌면 일부가 다음 훑기에서도 밀릴 수 있다(사람 승인 속도에서는 드묾, 후속: `updatedAt` 오름차순 페이징). ② 제어 gRPC 판 번호가 `updatedAtMs`라 같은 밀리초의 두 명령은 나중 것이 무시될 수 있다(후속: 명령 원장의 단조 판 번호). ③ SSE가 끊긴 채 프록시가 막으면 수동 새로 고침 전까지 갱신이 없다(EventSource 재시도 + 새로 고침 버튼). ④ 제어 gRPC ack는 서비스 주소 한 파드만 본다(전 파드 집계는 후속).

## heavy gate 시나리오(기록)

1. **test-int**
   - ops-svc: `command-execution.int.test.ts`, `ops-command-audit.int.test.ts`, `event-cancel-dispatch.int.test.ts`, `commands-http.int.test.ts`(0019·0004·0005·0006 마이그레이션 포함), 새 `sale-stop-control.int.test.ts`(구매·대기열 내부 HTTP와 제어 gRPC ack를 실제 PostgreSQL·Redis로).
   - purchase-svc: `purchase-migration.int.test.ts`·`event-refund.int.test.ts`(마이그레이션 수 20), `priority-hold.int.test.ts`, 새 `sale-control.int.test.ts`(sale_control 조건부 upsert·판 번호).
   - queue-svc: `sale-state.int.test.ts`, 새 `sale-suspension.int.test.ts`(notice·ctl 사본, 대기 상태 파일 PAUSED).
2. **변이**: ops-svc `execute-command`·`http-command-executor`·`handle-command-event`·`ops-live-feed`·`audit-anchor`, purchase-svc `set-sale-suspension`·`drizzle-sale-control-store`·`control-server`, queue-svc `set-sale-suspension-copy`·`redis-sale-suspension-copies`·`control-server`.
3. **브라우저 확인(SCR-030)**: console-host가 5초 폴링 대신 SSE를 쓰는지, `Last-Event-ID` 재연결·reset 뒤 REST 재읽기, SALE_STOP/SALE_RESUME 유형 표시·2인 승인·실패 재시도. 가짜 ops API(SSE 포함)로 돌리고 실제 HTTP는 unit/test-int가 본다. 결과는 `docs/review/browser-check/` 폴더의 GAT-310 파일에 남긴다.
4. **4관점 리뷰**: 보안(2인 승인·판 번호 비교·공개 앵커 서명), 동시성(같은 회차의 중지/재개 경합, 재시도 멱등), 장애(Kafka·Redis·gRPC 실패), 화면(SSE 끊김).

## 남은 막힘

- 외부 불변 저장소(S3 Object Lock)·OpenTimestamps 앵커는 AWS 계정·버킷이 없어 `anchorRef`를 `local:<checkpointId>`로 둔다.
- 제어 gRPC ack는 서비스 주소 하나로 보내 한 파드의 ack만 본다. 전 파드 ack 집계(헤드리스 Service의 모든 엔드포인트 해석)는 후속이다.
- core-svc `RecordSaleReviewResult`(비공개·검색·홈·오픈 예약 멈춤)와 정산 보류(`SALE_SUSPENDED`), SCR-048 화면은 이번 몫이 아니다.
- 예매 제한 집행(`SetBookingRestriction`, Q-T59)은 아직이다.
