# ADR-0340: 운영 명령 수명주기의 첫 구현 세부 — dry-run 미리보기·기록·실행 뒤 비교, 승인 기한, 되돌리기·연장·자동 만료, 멱등, 사람 칸의 가명 참조(2026-11-21)

- **상태**: 채택(추천 적용, 2026-11-21, BAT-355 계획). 정본(control-tower §3·§4·§7, docs/data.md `command_event`·`command_actor`)이 정한 수명주기를 ops-svc에 처음 다 구현하면서 정본에 없던 세부를 정한다. 소유자 결정이 아니다. dry-run 센 값의 원천을 부르는 길은 같은 날 감독이 BAT-355 계획 '감독에게' 1의 (가)로 정했다(결정 11).
- **관련**: [docs/features/control-tower.md](../features/control-tower.md) §3·§4('명령 수명주기의 첫 구현' 문단)·§7, [docs/data.md](../data.md) `ops_command`·`command_event`·`command_approval`·`command_actor`·§5, [docs/security/authz-matrix.md](../security/authz-matrix.md) §6, [ADR-0062](0062-open-items-delegated-decisions.md)(연장·사후 검토), [ADR-0073](0073-third-consistency-audit-delegated-decisions.md)(되돌리기 2인), [ADR-0095](0095-sale-pause-single-commander-and-two-person-approval-demo.md), [ADR-0149](0149-command-audit-actor-pseudonym-reference-and-3-year-mapping.md), [ADR-0322](0322-admin-account-rest-session-and-role-change-approval.md), [ADR-0339](0339-block-command-protected-ranges-and-two-person-rule.md), `docs/review/plans/BAT-355.md`
- **관련 ID**: OPS-260, C-T3, C-T4, C-T5, C-T6 ②③, AZ-T10, I-T53 ⑤, ASVS v5.0.0-2.2.1·2.3.1·2.3.2·2.3.3·2.3.5·8.2.3·8.3.1

## 맥락

- ops-svc의 명령 모듈(GAT-110·BAT-465·BAT-045)은 접수·2인 승인·거부·실행·재시도·위험 명령 재인증까지 있다. DRY_RUN 단계, 승인 기한 만료, 되돌리기·연장·자동 만료, `Idempotency-Key`, 사람 칸의 가명 참조(ADR-0149)는 없다.
- 화면의 단계는 사유 → 파라미터 → dry-run → 재인증 → 2인 승인 → ack다(docs/design/d5-screen-blueprint.md SCR-030). 1인 명령은 접수하자마자 실행되므로, 요청자가 실행 전에 dry-run을 보려면 저장하지 않는 미리보기가 따로 있어야 한다. openapi에는 그런 경로가 없다.
- BAT-465가 더한 1회 실행 명령(회차 취소·일괄 환불 멈춤·재개·규모 올리기·판매 중지·재개)은 성공하면 `SUCCEEDED`로 끝난다. 정본 전이 표(control-tower §4)에는 그 상태가 없다.
- ADR-0149의 `command_actor` 유일 제약 `(command_id, admin_account_id)`를 그대로 두면, 판매 일시정지를 낸 commander가 그 명령의 되돌리기를 요청할 수 없고 같은 운영자가 연장을 두 번 할 수 없다.

## 결정

1. **끝 상태 둘**: 카탈로그 명령 1~12는 받는 쪽 ack(판 N 이상 적용, ADR-0103)로 `ACKED`가 성공 상태이고 되돌릴 수 있다. 1회 실행 명령(`EVENT_CANCEL`·`EVENT_REFUND_PAUSE`·`EVENT_REFUND_RESUME`·`SCALE_CHANGE`·`SALE_STOP`·`SALE_RESUME`)은 `SUCCEEDED`가 끝이고 되돌리지 않는다. 실행 포트 결과에 `ACKED`(답한 시각 포함)를 더한다. 카탈로그 명령의 전송(제어 gRPC·설정 사건·WAF)은 OPS-300·310이 잇고, 그 전에는 지금처럼 `FAILED`(`target-not-wired`)다.
2. **dry-run 미리보기와 기록**:
   - 새 경로 `POST /v1/ops/command-dry-runs`(operator·commander, 저장하지 않음, 재인증·`Idempotency-Key` 없음). 본문은 `Command`와 같고, 접수와 같은 검사(유형별 역할 403, 꼴 422, 안전 한계 422)를 한 뒤 `CommandDryRun`을 준다. 감사 기록을 남기지 않는다(읽기만 한다).
   - `CommandDryRun`: `version`(1), `approvalMode`(`NONE`·`ONE`·`TWO`), `reauthRequired`, `counted[]`(`key`, `value`, 원천 `source`, 센 시각 `measuredAt`), `predicted[]`(`key`, `value`, 식 `formula`, 넣은 값 `inputs`, 가정 `assumptions[]`), `unavailable[]`(세지 못한 값의 `key`·`source`·`reason`), `limits`(그 명령에 건 안전 한계 값), `protectedRangeHits[]`·`protectedRangesVersion`(명령 4만, ADR-0339).
   - 접수(`POST /v1/ops/commands`)는 같은 계산을 다시 해 `command_event`의 `DRY_RUN` 사건 `dry_run` 칸에 남긴다. 승인자에게 보이는 dry-run은 이 기록이다. `CommandState.dryRun`(상세만)이 이 기록을 준다.
   - 센 값은 명령 유형마다 포트 `DryRunSource`로 센다. 원천이 없거나 실패하면 `unavailable`에 적고 접수를 막지 않는다(dry-run은 판단을 돕는 값이고, 권한·한계 검사는 따로 한다). 원천 어댑터는 이 ADR 밖이다.
   - 예측 식은 명령 1만 이 묶음에서 낸다(control-tower §4 '예측 값'의 식). 그 밖의 유형은 `predicted`가 빈 목록이다. 명령 12의 상한 변화는 OPS-290이 같은 포트로 더한다.
3. **실행 뒤 비교**: 처음 `DISPATCHED`가 된 때 + 5분 [가정]을 `ops_command.compare_due_at`에 적는다(예측이 있는 명령만). 정비 작업(30초 [가정] 간격, `FOR UPDATE SKIP LOCKED`)이 때가 된 명령의 실제 값을 같은 원천으로 세어 `DRY_RUN_COMPARED` 사건(예측·실제·센 시각·차이)을 남기고 칸을 비운다. 원천을 세지 못하면 그 사실을 `unavailable`로 남긴다. 빈 결과를 '일치'로 적지 않는다.
4. **승인 기한**: `approval_expires_at`(만든 시각 + 10분)과 같거나 늦은 승인·거부는 409 `command-not-pending`이고, 같은 트랜잭션에서 명령을 `REJECTED`(행위자 SYSTEM, 사유 `approval-expired`)로 닫는다. 정비 작업도 지난 것을 같은 모양으로 닫는다. `REVERT_PENDING`의 기한도 10분이고, 지나면 `REVERT_EXPIRED` 사건과 함께 `ACKED`로 돌아간다(명령은 그대로).
5. **되돌리기·연장·자동 만료**:
   - `POST …/reversions`: `ACKED`인 카탈로그 명령만(그 밖은 409 `command-not-revertible`). 명령 3·11은 commander·재인증 → 202 `REVERT_PENDING`, 요청자가 아닌 operator 이상이 재인증해 `…/approvals`로 승인하면 되돌림을 보내고 `REVERTED`. 거부는 `ACKED`로 돌아간다. 그 밖의 명령은 그 유형을 요청할 수 있는 역할 1인이 되돌리고 200 `REVERTED`다.
   - `POST …/extensions`: 명령 2만, `ACKED`이고 만료 전(그 밖은 409). operator 이상, 재인증 없음. 새 만료 = 지금 + 10분. `EXTENDED` 사건(사유·행위자·새 만료) 뒤 실행 포트로 바뀐 만료를 보내 ack를 받으면 200이다.
   - 되돌림·연장을 보내지 못하면 명령은 `ACKED`와 원래 만료 그대로이고 `REVERT_FAILED`·`EXTEND_FAILED` 사건을 남기며 502 `command-dispatch-failed`(새 type, 다시 해도 된다)다.
   - 자동 만료(T17): `ops_command.expires_at`이 있는 명령 2(첫 ack + 10분, 연장하면 바뀜)·8(첫 ack + 30분)이 `ACKED`이고 그 시각이 지나면 정비 작업이 `AUTO_EXPIRED`(행위자 SYSTEM)로 적는다. 명령 4는 `waf-block-expirer`가 거둔 것을 확인한 뒤 적으므로 OPS-290 몫이다.
6. **시스템 자동 조치(T12)**: 내부 명령 사건(`/internal/v1/ops/command-events`와 `ops.command-events`)에 종류 `AUTO_ACTION`(`eventKey`, `type`, `params`, `reason`, `occurredAt`)을 더한다. 행위자 SYSTEM으로 승인 없이 `DISPATCHED`를 만들고, 뒤의 `COMMAND_RESULT`(status에 `ACKED`를 더함)로 끝낸다. 받는 유형은 명령 1의 목표 낮추기뿐이다(AIMD·버짓 연동 감축, control-tower §4). 바깥 REST 본문은 행위자·승인자·상태·판 번호·ack 시각을 받지 않으므로 SYSTEM 행위자를 만들 수 없다.
7. **멱등**: `POST /v1/ops/commands`는 `Idempotency-Key`(UUIDv4)가 필요하다(없거나 틀리면 400 `idempotency-key-invalid`). 범위는 부른 계정 × 작업 `CREATE_OPS_COMMAND` × 키다(ops `idempotency_record`). 같은 키·같은 본문이면 처음 명령을 다시 주고 새 일을 하지 않으므로 재인증 토큰을 다시 보지 않는다. 같은 키·다른 본문은 422 `idempotency-key-reused`다. 처음 요청이 재인증·검사에서 막혔으면 기록이 없어 다시 보내기도 처음처럼 본다.
8. **사람 칸의 가명 참조(ADR-0149 첫 구현)**: `ops_command.requested_by`, `command_event.actor_ref`, `command_approval.approver_ref`, 감사 체인 기록의 사람 칸에는 기록마다 새 UUIDv4를 적는다. `command_actor`(actor_ref, command_id, 회차 `round`, side `REQUESTER`·`APPROVER`·`ACTOR`, admin_account_id, recorded_at, delete_hold_ref)가 관리 계정으로 잇는다. `round`는 명령이 0이고 되돌리기 요청마다 1씩 오른다. 2인 분리는 `UNIQUE (command_id, round, admin_account_id) WHERE side IN ('REQUESTER','APPROVER')`가 지키고, 응용 층도 먼저 본다(요청자 본인 403 `command-requester-cannot-approve`, 같은 사람 두 번 409). 연장·재시도·되돌림 실행은 side `ACTOR`(유일 제약 없음)다. 시스템 행위자는 `actor_role` `system`, `actor_ref`는 모든 자리가 0인 빈 UUID이고 대응 행이 없다. 응답의 `requestedBy`·`approvals`·`canApprove`는 대응 표로 푼다. 3년 [가정] 지난 대응 행은 하루 한 번 지운다(`delete_hold_ref`가 있으면 남긴다). 마이그레이션은 옛 행에 같은 값 대응(actor_ref = 옛 계정 ID)을 넣는다(local·ci 자료뿐이라 그 행은 가명이 아니다).
9. **안전 한계의 자리와 거절**: 명령 1 목표의 절대 상·하한(8,000·1,000, control-tower §3. 그 회차 결제사 상한은 원천이 생긴 뒤 더한다), 명령 2 10분, 명령 4 만료 24시간·항목 100개 [가정], 명령 8 30분, 승인 기한 10분은 ops-svc 도메인 상수 한 곳(정적 설정)에 둔다. 한계 밖은 422 `command-out-of-range`(새 type, `detail`에 걸린 한계 이름)이고 저장 전에 거른다(명령 행·사건·감사 기록·실행 0건). 미리보기도 같은 함수로 거른다.
10. **사유 글**: 앞뒤 공백을 지우고 NFC로 한 번 정규화한 뒤 길이(1~2,000자)를 본다. 제어 문자와 양방향 제어 문자(U+202A~U+202E, U+2066~U+2069)가 있으면 422 `invalid-command`다(ASVS control-tower 1.1.1·1.3.3).
11. **센 값의 원천은 받는 쪽이 준다(감독 결정 2026-11-21, BAT-355 계획 '감독에게' 1의 (가))**: 제어 gRPC `ControlReceiver`에 읽기 전용 `PreviewControl`(범위·종류 → 센 값·원천·센 시각, admission-ctrl 리더는 그 회차 결제사 상한도)을 더하고, 받는 쪽(admission-ctrl·purchase-svc·queue-svc)과 proto는 OPS-300(묶음 BAT-365)이 함께 만든다. 까닭: 센 값의 원천은 받는 쪽 저장소(대기열 Redis·purchase DB)라 그 서비스가 같은 시각에 세는 것이 정본(C-T6 ①)에 맞고, `ApplyControl` 받는 쪽을 만드는 묶음이 같은 서버·같은 신원 검사를 쓰므로 한 번에 만드는 것이 싸다. ops-svc가 남의 저장소를 바로 읽으면 서비스 경계(architecture §3.2)를 넘고, Prometheus 지표는 '원천에서 직접'이 아니다. 그래서 BAT-355는 포트 `DryRunSource`·기록·예측·비교와 늘 `unavailable`을 주는 어댑터까지 하고, C-T6 ①의 정할 곳은 BAT-365다(docs/review/ledger-notes.md '다른 단계'). 명령 4의 '대역별 최근 5분 요청 수'는 게이트웨이 집계 원천이 정본에 없어 OPS-310 때 정하고, 그 회차 결제사 상한도 `PreviewControl`이 생긴 뒤 결정 9의 한계 검사에 더한다.

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 |
| --- | --- | --- | --- |
| A. 저장하지 않는 미리보기 경로 + 접수 때 다시 계산해 기록(이 결정) | 1인 명령도 실행 전에 본다. 승인자가 보는 값이 기록으로 고정된다 | 미리보기와 기록 사이 몇 초의 값 차이가 있다 | 고른다 |
| B. 접수가 DRY_RUN에서 멈추고 확정 호출을 따로 받는다 | 미리본 값과 기록이 같다 | 지금 접수 계약(201에 PENDING_APPROVAL·실행 결과)과 내부 사건 길을 모두 바꾼다 | 쓰지 않는다 |
| C. `SUCCEEDED`를 없애고 모두 `ACKED`로 | 상태가 하나 준다 | BAT-465 계약·화면이 이미 쓰고, 1회 실행 명령은 되돌릴 수 없어 뜻이 다르다 | 쓰지 않는다 |
| D. `command_actor` 유일 제약을 그대로 둔다 | ADR-0149 글 그대로다 | 멈춘 사람이 재개를 요청하지 못하고, 연장을 두 번 못 한다 | 회차·side로 좁힌다 |
| E. 센 값을 BAT-355에서 세 서비스의 내부 읽기 경로로 받는다 | 이 묶음에서 C-T6 ①까지 닫는다 | 다른 갈래 코드를 고치고 약 1.5일 [추정] 늘어 묶음이 5일을 넘는다 | 쓰지 않는다(결정 11) |
| F. 센 값을 Prometheus 지표로 센다 | 새 계약이 없다 | 같은 시각의 원천 값이 아니라 C-T6 ①과 다르다 | 쓰지 않는다(결정 11) |

## 결과

- 명령 수명주기의 전이 T1~T17이 ops-svc에 다 있고, 위험 명령·2인 명령·되돌리기가 같은 검사를 지난다. 승인자가 보는 dry-run은 기록이다.
- 대가: openapi에 경로 하나(`/v1/ops/command-dry-runs`)·스키마 하나(`CommandDryRun`)·Problem type 셋(`command-out-of-range`·`command-not-revertible`·`command-dispatch-failed`), asyncapi `ops.command-events`에 `AUTO_ACTION`·`ACKED`가 생긴다. ops 마이그레이션 0021이 `command_actor`·`ops_command.expires_at`·`compare_due_at`을 더한다.
- 남는 한계: BAT-365가 `PreviewControl`을 만들기 전에는 센 값이 늘 `unavailable`이고 명령 1 목표는 절대 상·하한만 거른다(결정 11). 게이트웨이 집계 원천과 카탈로그 명령의 실제 전송은 이 ADR 밖이다. 동시성 잠금 플래그(control-tower §4, 같은 회차·유형의 명령이 이미 진행 중) 표시는 화면 단계(OPS-390)에서 정한다.

## 되돌릴 조건

- 미리보기와 기록의 차이로 승인자가 잘못 판단한 사례가 나오면 대안 B(확정 호출)를 다시 본다.
- 승인 기한 10분이 운영에서 자주 넘치면(같은 명령을 다시 내는 일이 잦으면) 기한을 다시 본다.
