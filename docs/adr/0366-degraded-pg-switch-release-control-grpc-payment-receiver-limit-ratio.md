# ADR-0366: 명령 6 결제 갈래의 전송 — 대체 결제사 전환·해제를 제어 gRPC로 payment-svc와 admission-ctrl에 보내고, 낮춘 채널 상한을 입장 제어에 잇는다(2026-11-23)

- **상태**: 채택(추천 적용, 2026-11-23, BUILD_ORDER F-02-2 OPS-310 계획). [ADR-0143](0143-settings-commands-pg-switch-over-grpc-applied-version-outbox.md) 결정 1(대체 결제사 전환은 제어 gRPC), [ADR-0105](0105-payment-entry-pause-probe-trial-reopen-manual-release.md) 결정 7(commander 해제), [ADR-0250](0250-payment-entry-pause-manual-release-contract.md)(해제 종류와 `{pg}`), [ADR-0226](0226-aimd-safety-limits-and-control-input-first-implementation.md) 결정 9(`ctl`의 `pgKey`·`pgTps`), [ADR-0349](0349-pg-assign-command-payment-degraded-post-review-ops-event-waf-expirer.md) 결정 6(명령 6 결제 갈래 매개변수)과 [ADR-0365](0365-apply-control-dispatch-version-ledger-receiver-fields-settings-apply-check.md)(판 원장·보내기·ack)의 방향은 그대로 두고, 정본에 값이 없어 구현이 정해야 하는 세부만 정한다. 값마다 [가정]이고 측정·운영 뒤 바꿀 수 있다. 명령 6의 다른 갈래(진입·상태 조회 Degraded, S3 사본 고정, 매진 정적 응답), 명령 4 전송, 비상 런북은 이 결정 밖이다(F-02-2 계획 2절 1의 나누는 안).
- **바꿈(2026-11-23, F-02-2 시험 결과)**: 결정 8의 해제 바라는 상태를 `{"pg"}`에서 `{"pg", "actor"}`로 바꿨다. 결정 9가 요구하는 요청자 관리 계정 ID를 받는 쪽에 전할 칸이 없었다. 같은 날 결정 7에 되돌림을 보내지 못한 때의 모양(openapi `createOpsCommandReversion` 502, ADR-0340 결정 5)을 더했다.
- **관련**: [docs/features/control-tower.md](../features/control-tower.md) §3 명령 6·§5 '제어 상태', [docs/features/payment.md](../features/payment.md) §2 '낮춘 상한의 유지·전파·회복'·'정지 판정자의 첫 구현'·§2.2 '선택기의 첫 구현', [docs/features/queue-admission.md](../features/queue-admission.md) §5 '결제사 상한', [docs/data.md](../data.md) §3 `q:{event:E}:ctl`·`q:{admission}:ctl`, `docs/api/proto/peaket/control/v1/control.proto`, `docs/api/proto/peaket/payment/v1/payment.proto`, docs/planning/03 §1.3 POL-029 '결제 트랜잭션'
- **관련 ID**: OPS-310, C-T53, C-T44 ②, P-T43 ②, ASVS v5.0.0-16.5.2(Kafka 몫)

## 맥락

- 명령 6 결제 갈래 '대체 결제사 전환'(`DEGRADED_MODE`, `mode: PAYMENT_PG_FALLBACK`)은 매개변수와 승인(commander 요청 + 요청자 아닌 operator 이상 1인)만 있고 보내는 길이 없다(BAT-360). 제어 gRPC의 `CONTROL_KIND_PG_SWITCH`는 proto에 있으나 바라는 상태를 `{"switched": true}` [가정]으로만 적었다.
- payment-svc에는 제어 포트가 없다. `pg_switch` 쓰기 함수(`applySwitch`, 판 번호가 클 때만)와 해제 쓰임새(`ReleaseEntryPause`)는 있으나 부르는 쪽이 없다(PRF-190·202).
- admission-ctrl 리더는 `q:{event:E}:ctl`의 `pgKey`·`pgTps`를 `cfg`보다 먼저 읽는다(HOT-030). 쓰는 쪽이 없고, 전체 범위 전환의 자리가 없다. ops-svc는 회차마다 대체 결제사와 그 결제사의 승인 상한을 알지 못한다(지정은 payment DB `event_pg_config`, 상한은 payment-svc 설정).
- 명령 6 해제(Degraded Mode 모두 해제)는 commander 1인·재인증이고, 결제사 장애로 payment-svc가 스스로 건 새 결제 진입 정지도 연다(ADR-0105 결정 7). 자동 정지는 명령 없이 걸리므로 '되돌릴 명령 6'이 없을 수 있다.
- PRF-203은 낮춘 채널 상한(`payment_channel_limit`의 비율)을 payment-svc 파드끼리 맞췄지만 admission-ctrl에 전하지 않았다. payment-svc는 대기열 Redis에 닿지 않고 제어 포트를 부를 신원도 없다.

## 결정

1. **보낼 곳과 종류.** 명령 6 결제 갈래는 범위(회차 1~100개 또는 `PLATFORM`, ADR-0349 결정 6)마다 `CONTROL_KIND_PG_SWITCH`를 두 받는 쪽에 보낸다: payment-svc 준비된 모든 파드와 admission-ctrl 리더. 판 원장·찾기·ack·다시 보내기·10초 실패는 ADR-0365 결정 1·3·4 그대로이고, 두 받는 쪽이 모두 판 이상을 답해야 `ACKED`다. 회차 범위는 회차마다 따로 판을 매긴다(범위·종류마다 원장 한 행). 제어 포트 번호는 50061이다(`deploy/platform/mesh/port-allow.yaml`의 [가정]을 확정, 메시 쌍은 그대로).
2. **payment-svc의 바라는 상태.** `{"switched": 참거짓, "toPg": "TOSS"|"PORTONE"|null}`이다. 받은 파드는 `pg_switch`(범위 = 요청 범위)에 `active = switched`, `from_pg = null`(어느 기준 결제사든), `to_pg = toPg`, `version = 판`, `changed_at = 지금`을 판이 클 때만 쓰고(`applySwitch`), 자기 파드의 결제사 선택 캐시를 그 범위(전체면 모두)만큼 바로 비운다. `applied_version`은 쓴 뒤 다시 읽은 그 범위 행의 판이다. 모르는 칸·틀린 꼴은 `INVALID_ARGUMENT`이고 쓰지 않는다.
3. **새 파드와 다시 맞춤.** payment-svc는 시작할 때 `pg_switch`를 한 번 읽어야 준비 상태가 된다(플랫폼 시작 작업의 제어 상태, ADR-0103). 그 뒤의 '2초마다 다시 맞춤'은 지금의 선택 캐시 수명 1초 [가정](매 결제 시도가 1초 안의 DB 값을 본다)이 맡고 따로 돌지 않는다.
4. **admission-ctrl의 바라는 상태와 칸.** `{"switched": 참거짓, "pgKey": 글 또는 null, "pgTps": 정수 또는 null}`이다(켤 때 둘 다 있음, 끌 때 둘 다 null). 회차 범위면 `q:{event:E}:ctl`의 `pgKey`·`pgTps`를 쓰고 끌 때 두 칸을 지운다(ADR-0226 결정 9). 판·명령 칸은 `pgRev`·`pgCmd`(지울 때도 남긴다)이고, 쓰기는 ADR-0365 결정 5의 리더 세대 확인 Lua 하나다. 전체 범위면 `q:{admission}:ctl`의 같은 네 칸이다. 리더가 회차의 결제사 묶음을 고르는 차례는 회차 `ctl` > 전체 `ctl` > `cfg`다.
5. **ops-svc가 `pgKey`·`pgTps`를 얻는 길.** payment-svc `PaymentService`에 읽기 전용 `ResolvePgSwitch(event_ids, to_pg) → routes[{event_id, pg, approvals_per_second}], approval_limits`를 더한다. payment-svc가 선택기(`selectPg`)와 같은 규칙으로 '전환이 켜졌을 때 그 회차의 새 결제 시도가 갈 결제사'를 정하고 그 결제사의 승인 상한(설정 값)을 싣는다. ops-svc는 보내기 직전(처음 `DISPATCHED`를 쓰기 전)에 데드라인 2초 [가정]로 부르고, 실패하면 명령을 쓰지 않고 503 `pg-check-unavailable`(BAT-360과 같은 글)이다. 회차 범위의 admission 바라는 상태는 `pgKey = pg`(결제사 이름), `pgTps = 내림(approvals_per_second)`(1 미만이면 1)이다. 전체 범위는 `toPg`가 있으면 그 결제사의 이름·상한, 없으면 `pgKey = "PG_FALLBACK"`, `pgTps` = 고를 수 있는 결제사(TOSS·PORTONE) 상한의 최솟값이다(회차마다 대체가 달라도 낮은 쪽으로 안전하게 [가정]). 부르는 쪽은 ops-svc뿐이고 메시 L7 허용 목록에 그 메서드를 더한다.
6. **설정 사건.** ops-svc는 `ACKED`를 쓰는 트랜잭션에서 `publishSetting`으로 `DEGRADED_MODE` 사건 하나(대상 `PAYMENT_PG_FALLBACK`, 값 `DegradedModeValue {enabled}`, `occurredAt` = 판 번호 밀리초)를 쓴다(분석·감사·표시용, ADR-0143 결정 1). Kafka가 멈춰 있으면 Outbox에 남았다가 돌아오면 나간다. 효력은 제어 gRPC가 맡으므로 payment-svc·admission-ctrl은 이 사건으로 `pg_switch`·`ctl`을 쓰지 않는다(그래서 같은 판을 다시 적용하지 않는다, C-T53).
7. **되돌리기(대체 결제사 전환 끄기).** 결제 갈래 명령 6의 되돌리기는 T13(한 단계)이고 commander만 하며 재인증이 필요하다(control-tower §3 명령 6 행, BAT-355 RV-03). 새 판으로 두 받는 쪽에 `switched: false`를 보내고, 이어 결정 8의 해제를 결제사 TOSS·PORTONE 각각에 보낸다(Degraded Mode 모두 해제). 모두 ack해야 `REVERTED`다. 하나라도 10초 안에 ack되지 않으면 502 `command-dispatch-failed`이고 명령은 `ACKED` 그대로, `REVERT_FAILED` 사건이 남으며 다시 해도 된다(openapi `createOpsCommandReversion`, ADR-0340 결정 5). 이미 적용된 끄기·해제는 되돌리지 않는다(끄는 쪽이 안전하고, 다시 하면 남은 받는 쪽만 새로 적용한다).
8. **해제만 하는 명령(`mode: PAYMENT_ENTRY_RELEASE`).** 자동 정지는 되돌릴 명령이 없으므로 명령 6에 해제 갈래를 둔다: 매개변수 `{mode: "PAYMENT_ENTRY_RELEASE", pg: "TOSS"|"PORTONE"|"SIMULATOR"}`(SIMULATOR는 local·ci만, 모르는 칸은 거절). commander만 요청하고 승인 대기가 없으며(1인) 재인증을 요구한다. 종류는 `CONTROL_KIND_ENTRY_PAUSE_RELEASE`(proto에 9로 더함, ADR-0250 결정 1)이고 범위 `PLATFORM`, 바라는 상태 `{"pg": …, "actor": …}`로 payment-svc 준비된 모든 파드에 보낸다. `actor`는 그 명령 요청자의 관리 계정 ID(1~128자, ADR-0250 결정 3의 `actor`)이고 가명 참조 `actor_ref`가 아니다. 가명 참조 규칙(ADR-0149 결정 1, ADR-0340 결정 8)은 ops의 덧붙이기만 하는 감사 기록 몫이고, `payment_entry_pause.actor`는 다음 전이에 덮이는 지금 상태 칸이라 ADR-0250 결정 3대로 계정 ID를 둔다. ops 쪽 명령 기록은 지금처럼 `actor_ref`만 적는다. 되돌리기(결정 7)의 해제는 되돌리기 요청자의 계정 ID를 싣는다. 모르는 칸·`actor` 빈 글·128자 넘음은 `INVALID_ARGUMENT`다. 모두 ack하면 `ACKED`이고 되돌리기는 409 `command-not-revertible`이다(다시 멈추는 자동 조건이 되돌림 몫을 한다). 사후 검토 할 일은 만들지 않는다(정본은 명령 3·11만 적었다).
9. **payment-svc의 해제 받기.** 받은 파드는 `ReleaseEntryPause`를 바라는 상태의 `actor`(명령 요청자의 관리 계정 ID, 결정 8)로 부른다(`SYSTEM`이 아니므로 모든 파드가 서킷을 한 번 닫는다, payment.md §2 PRF-202 ①). 사유는 넘기지 않는다(감사 기록은 ops-svc 명령 기록이다, ADR-0250 결정 5). ADR-0250 결정 3에 조건 하나를 더한다: 정지 행의 `since`가 요청 판 번호(밀리초로 읽음)보다 늦으면(명령을 낸 뒤 새로 걸린 정지) 열지 않고 '이미 열림'과 같이 답한다. 그래서 같은 명령을 다시 보내도(파드가 다시 떠 메모리를 잃어도) 새 정지를 열지 않는다. 처리 뒤 그 파드의 정지 캐시를 바로 비우고(`CachedEntryPauseReader.invalidate`) 요청 판을 `applied_version`으로 답한다. 파드마다 받은 가장 큰 판을 메모리에 두고 같거나 작은 판은 쓰기 없이 그 값을 답한다. 저장소 오류는 `UNAVAILABLE`(ops-svc가 다시 보낸다).
10. **낮춘 채널 상한을 입장 제어에 잇기(PRF-203이 넘긴 것).** admission-ctrl 리더는 제어 입력을 읽는 주기마다 Prometheus에서 `min by (pg) (payment_pg_limit_ratio)`를 함께 읽는다(이미 쓰는 `PEAKET_PROMETHEUS_URL`과 조회 한도, ADR-0226). 회차가 고른 결제사 묶음의 `pgKey`가 결제사 이름(TOSS·PORTONE·SIMULATOR)이면 쓰는 승인 상한은 max(1, 내림(`pgTps` × 그 결제사 비율 ÷ 100))이고, `PG_FALLBACK`이면 비율의 최솟값을 쓴다. 비율이 없거나 25~100 밖이면 100으로 본다. 조회가 실패하면 마지막으로 읽은 비율을 쓴다(낮춘 쪽으로 안전하게, PRF-203의 '읽기 실패는 마지막 값'과 같다). 전진 속도 상한과 동시 입장 상한이 함께 그 값으로 다시 계산된다(queue-admission §5 '결제사 상한'). BUILD_ORDER 단계 줄의 '명령 6이 쓰는 칸에 비율을 싣는다'는 쓰는 주체가 없어(payment-svc는 대기열 Redis와 제어 포트 신원이 없다) 이 읽기로 대신한다. `ctl`에는 비율 칸을 두지 않는다.
11. **기록.** 명령의 감사 기록·`ops_event`(단계마다 한 줄, 사유·계정 없음)는 BAT-355·360의 수명주기 그대로다. 해제(결정 8)와 되돌리기의 `ops_event` 이름은 `PAYMENT_ENTRY_RELEASE`·`DEGRADED_MODE`다. 받는 쪽 로그는 명령 ID·판·범위·결제사·결과 한 줄이다(계정 ID는 payment-svc의 `released` 로그 줄만, ADR-0250 결정 5 그대로).
12. **시험 이름.** C-T53·C-T44 ②·P-T43 ②는 그 ID를 단다. 장부 밖 세부는 `F022-` 번호를 단다.

## 검토한 대안

| 대안 | 판단 |
| --- | --- |
| 설정 사건 `control.settings`로 전환을 퍼뜨린다 | 기각. ADR-0143 결정 1이 Kafka와 함께 흔들리는 장애를 이유로 제어 gRPC로 정했다. 설정 사건은 표시용으로만 낸다(결정 6). |
| admission-ctrl이 대체 결제사의 상한을 스스로 안다(결제사별 상한 설정을 admission-ctrl에도 둔다) | 기각. 같은 값이 두 서비스 설정에 생겨 어긋날 수 있다. 회차의 대체 결제사도 payment DB에만 있다. |
| ops-svc가 `CheckEventPgAssignment`를 다시 쓴다 | 기각. 그 RPC는 '이 지정을 받아도 되는가'를 묻고 기본 결제사를 입력으로 받는다. 전환 뒤 갈 곳은 선택기 규칙이라 payment-svc가 정해야 한 곳에 남는다. |
| 해제를 결제 갈래 명령 6의 되돌리기로만 둔다 | 기각. 자동 정지는 명령이 없이 걸려 되돌릴 명령이 없다(RB-07의 '정지가 잘못 걸렸으면 해제'). |
| 낮춘 비율을 payment-svc가 ops-svc를 거쳐 `ApplyControl`로 `ctl`에 싣는다 | 기각(지금). ops-svc가 멈추면 끊기고, 낮춤마다 명령 원장 행이 생긴다. Prometheus는 리더가 이미 읽는 입력이다. 남는 한계는 아래 '결과'. |
| 해제 판을 payment DB 표에 남긴다 | 기각. 마이그레이션이 늘고, 결정 9의 `since` 비교로 다시 보내기·다시 뜬 파드에서도 새 정지를 열지 않는다. |

## 결과

- 결제사 장애 때 Kafka가 함께 멈춰도 commander·operator 두 사람이 낸 전환이 payment-svc 모든 파드와 리더에 퍼지고, 새로 뜬 payment-svc 파드도 `pg_switch`를 읽은 뒤에 받는다. 자동 정지는 commander 한 사람이 바로 연다.
- 대가: payment-svc 제어 포트 하나, payment.proto RPC 하나와 그 메시 허용 한 줄, control.proto 종류 하나. 마이그레이션은 없다(`pg_switch` 칸 이름 맞추기는 그 표를 바꾸는 다음 마이그레이션 몫으로 남는다, data.md §4 PRF-190 줄).
- 남는 한계: 비율은 Prometheus 수집 간격(15초 [가정])만큼 늦게 입장 제어에 닿는다. 그동안 넘는 승인 호출은 payment-svc의 재시도 대기열이 받는다(payment.md §9). 전체 범위의 대체 미지정 전환은 결제사 상한의 최솟값으로 묶어 입장이 필요보다 적을 수 있다. Prometheus가 오래 멈추면 마지막 비율이 그대로 남는다(회복은 Prometheus가 돌아온 뒤).

## 되돌릴 조건

- 측정(wbs 2.12.1)에서 비율이 입장 제어에 닿기 전 재시도 대기열이 승인 기한을 넘기면 결정 10을 ops-svc 경유나 payment-svc → admission-ctrl 직접 RPC로 다시 본다.
- 결제사가 셋 이상이 되거나 회차마다 대체가 크게 달라 전체 범위 전환의 최솟값이 판매를 막으면 결정 5의 전체 범위를 회차 목록 펼치기로 바꾼다.

## 확인

- F-02-2 기록 커밋에서 시험 이름(결정 12)과 장부 항목을 대조하고 이 절에 결과를 적는다.
