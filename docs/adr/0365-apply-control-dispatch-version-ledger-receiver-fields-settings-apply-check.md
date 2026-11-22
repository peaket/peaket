# ADR-0365: 제어 gRPC `ApplyControl`의 첫 전면 구현 — 판 번호 원장, 받는 파드 찾기와 ack, 받는 쪽 칸 이름, 판매 일시정지 중 유휴 시계, 설정형 명령의 적용 확인, 사전 모의 센 값(2026-11-23)

- **상태**: 채택(추천 적용, 2026-11-23, BUILD_ORDER F-02-1 OPS-300 계획). [ADR-0102](0102-control-plane-direct-grpc-dedicated-pool-ops-db-audit-chain-worker-break-glass.md)(제어 전용 gRPC)·[ADR-0103](0103-control-as-state-startup-sync-broadcast-topics-compacted-settings.md)(제어는 상태, 판 번호, ack의 뜻)·[ADR-0143](0143-settings-commands-pg-switch-over-grpc-applied-version-outbox.md)(설정형 명령의 적용 확인)·[ADR-0340](0340-ops-command-lifecycle-dry-run-expiry-revert-actor-refs.md) 결정 11(사전 모의 센 값은 받는 쪽이 준다)이 정한 방향은 그대로 두고, 정본에 값이 없어 구현이 정해야 하는 세부만 정한다. 값마다 [가정]이고 측정·운영 뒤 바꿀 수 있다. 구현 몫: 결정 1~8은 F-02-1, 결정 9~11은 F-02-5가 구현한다(감독 결정 2026-11-23, 크기 5일 어림으로 나눔).
- **관련**: [docs/features/control-tower.md](../features/control-tower.md) §5 '제어 상태'·'설정형 명령의 적용 확인', §14 C-T6·C-T50·C-T51·C-T54, [docs/features/queue-admission.md](../features/queue-admission.md) §5(리더 상태·펜싱), [docs/features/seat-hold.md](../features/seat-hold.md) §2 '구매 세션 종료와 정리', [docs/data.md](../data.md) §3 `q:{event:E}:ctl`·`q:{admission}:ctl`·`q:{event:E}:notice`·`s:{event:E}:ctl`, docs/planning/03 §2.2 T11, `docs/api/proto/peaket/control/v1/control.proto`, openapi `CommandState.delivery`, [ADR-0056](0056-admission-leader-fencing-and-admission-person-recheck.md), [ADR-0073](0073-third-consistency-audit-delegated-decisions.md) 결정 17, [ADR-0123](0123-sale-review-suspended-takedown-resume-or-cancel.md), [ADR-0226](0226-aimd-safety-limits-and-control-input-first-implementation.md) 결정 7
- **관련 ID**: OPS-300, C-T6 ①, C-T50, C-T51, C-T54, Q-T30, ASVS v5.0.0-1.4.2·2.1.1·15.1.3·15.3.5

## 맥락

- 제어 gRPC는 판매 중지·재개(`CONTROL_KIND_SALE_SUSPENSION`, 2026-11-15 R-584)만 purchase-svc·queue-svc에 보낸다. 주소 하나로 한 파드만 부르고, 판 번호는 명령 기록의 바뀐 시각(`updatedAtMs`)이다. admission-ctrl에는 제어 포트가 없고, 리더는 `q:{event:E}:ctl`의 운영자 칸을 읽기만 한다.
- 정본은 판 번호를 '그 범위·종류에서 늘어나기만 하는 수이고 ops-svc 명령 원장이 매긴다'(ADR-0103 결정 1)로만 적었다. 매기는 법, 같은 저장소 칸에 종류가 둘 이상일 때의 판 칸 이름, 준비된 파드를 찾는 법, 바라는 상태 JSON의 꼴은 비어 있다.
- purchase DB `sale_control`은 한 행(범위)에 판매 일시정지(`paused`)와 판매 중지(`suspended`)를 함께 두고 판 번호 칸(`revision`)은 하나다. 두 종류의 판을 한 칸에서 견주면 서로를 막을 수 있다.
- 상태 기계 T11(docs/planning/03 §2.2)은 '판매 일시정지(명령 3) 동안은 유휴를 세지 않는다'고만 적었다. 구매 세션 정리 반복(`SessionSweeper`)은 정지를 보지 않는다(PRF-138이 넘긴 것).
- 설정형 명령의 적용 확인(ADR-0143 결정 2)은 Prometheus 질의의 꼴, 받는 서비스의 목록, '준비된 파드'를 세는 법이 비어 있다. 사전 모의의 `PreviewControl`(ADR-0340 결정 11)은 RPC 꼴과 센 값의 정의가 비어 있다.

## 결정

1. **판 번호 원장.** ops DB에 `control_version`(범위, 제어 종류, 마지막 판, 명령 ID, 바꾼 시각, 기본 키는 범위·종류)을 둔다. 명령이 처음 `DISPATCHED`가 될 때 같은 트랜잭션에서 새 판 = max(마지막 판 + 1, 지금 밀리초)를 매기고 명령 기록에 남긴다. 다시 보내기·ops-svc 재시작 뒤 이어 보내기는 같은 판이다. 되돌리기·연장·만료 되돌림은 새 판이다. 판매 중지·재개도 이 원장을 쓴다(지금의 `updatedAtMs` 대신). 밀리초를 바닥으로 두어 R-584가 받는 쪽에 이미 남긴 판보다 작아지지 않는다. 판은 64비트 정수이고 0 이하·안전 정수 밖은 받는 쪽이 `INVALID_ARGUMENT`로 거절한다(ASVS 1.4.2·15.3.5).
2. **명령과 제어 종류·바라는 상태.** 이 결정이 닫는 꼴이다(명령 6의 두 갈래는 F-02-2가 정한다).

   | 명령 | 종류 | 범위 | 받는 쪽 | `desired_state_json` |
   | --- | --- | --- | --- | --- |
   | 1 동시 입장 목표 | `ADMISSION_TARGET` | 회차 | admission-ctrl 리더 | `{"target": 정수, "untilMs": 밀리초}`(지정 시각 + 15분, ADR-0226 결정 7). 되돌리기는 `{"target": null, "resumeAtMs": 밀리초}`(자동 조절 복귀 확인 `aimdResumeAt`) |
   | 2 입장 일시정지 | `ADMISSION_PAUSE` | 회차 | admission-ctrl 리더 | `{"paused": 참거짓, "expiresAtMs": 밀리초 또는 null}`. 연장은 같은 꼴의 새 판 |
   | 3 판매 일시정지 | `SALE_PAUSE` | 회차·`PLATFORM` | purchase-svc 준비된 모든 파드, admission-ctrl 리더, queue-svc 준비된 모든 파드 | `{"paused": 참거짓}` |
   | 7 대기실 공지 | `LOBBY_BANNER` | 회차·`PLATFORM` | queue-svc 준비된 모든 파드 | `{"banner": 글 또는 null}`(1~500자 [가정], NFC, 제어 문자 없음) |
   | 11 자동 제어 긴급 정지 | `AUTOMATION_STOP` | `PLATFORM` | admission-ctrl 리더 | `{"stopped": 참거짓}` |

   모르는 칸이 있거나 꼴이 틀리면 받는 쪽은 `INVALID_ARGUMENT`이고 아무것도 쓰지 않는다. 받지 않는 종류는 `UNIMPLEMENTED`다.
3. **받는 파드 찾기.** ops-svc는 포트 `ControlTargets`로 서비스마다 부를 주소를 얻는다. 운영 어댑터는 헤드리스 Service `<서비스>-control`의 DNS A 기록을 보낼 때마다 다시 푼다(클러스터 DNS는 EndpointSlice의 준비된 주소만 돌려준다. 그래서 ops-svc에 쿠버네티스 API 권한을 더하지 않는다). admission-ctrl은 리더 전용 Service의 주소 하나다. local·ci는 환경 값 `PEAKET_<서비스>_CONTROL_GRPC_ADDRS`(쉼표 목록, 지금의 `…_ADDR` 하나도 받는다)다. 운영에서 대상 서비스의 주소 설정이 없으면 ops-svc 시작이 실패한다. 주소는 이 설정에서만 오고 명령 값에서 오지 않는다(ASVS 1.3.6).
4. **퍼뜨리기와 ack.** 카탈로그 명령은 `DISPATCHED`를 커밋한 뒤 같은 프로세스의 배경 작업이 보낸다(접수·승인 응답은 `DISPATCHED`로 돌아온다). 대상 주소마다 데드라인 1초로 동시에 부르고, `applied_version`이 판 이상이면 그 파드의 ack다. 실패·낮은 판은 1초 [가정]마다 같은 명령 ID·판으로 다시 보낸다. 모든 주소가 ack하면 주소를 다시 풀어 그사이 준비된 파드도 부르고, 다시 푼 목록에 ack하지 않은 파드가 없으면 `ACKED`다. 명령 3은 세 받는 쪽이 모두 그래야 `ACKED`다. 처음 보낸 때부터 10초(ADR-0073 결정 17)가 지나면 `FAILED`(사유 `ack-timeout:<서비스>`)이고 다시 하기는 같은 판이다. 파드마다의 ack(서비스, 파드 이름, 적용한 판, 시각)는 ops DB `command_delivery`에 남겨 openapi `CommandState.delivery`(`kind: ACK`, `ackedCount`, `targetCount`, `unackedTargets`)로 보인다. 프로세스가 보내는 중에 멈추면 정비 바퀴가 `DISPATCHED`로 남은 명령을 같은 판으로 이어 보낸다. 판매 중지·재개(1회 실행 명령)는 지금처럼 응답 안에서 차례대로 보내되(ADR-0123) 같은 찾기·ack를 쓴다.
5. **admission-ctrl 받는 쪽.** 리더만 쓴다. 리더가 아닌 파드는 `UNAVAILABLE`(`not-leader`)이고 쓰지 않는다. 리더는 쓰기 직전에 자기 리더 세대를 다시 보고, 쓰기는 `q:{event:E}:leader`(전체 범위는 `q:{admission}:leader`)와 세대를 견주는 Lua 하나로 한다. 세대가 낮으면 `FENCED`로 거절하고 그 파드는 대기 파드로 돌아가며 `UNAVAILABLE`(`fenced`)로 답한다(ADR-0056, Q-T30). 같은 Lua가 판이 지금 칸보다 클 때만 쓰고, 지금 판을 돌려준다.
6. **받는 쪽 칸 이름.** 종류마다 판·명령 칸을 따로 둔다(한 저장소에 종류가 여럿이라 서로 막지 않게). R-584가 쓴 `suspRev`·`suspCmd`(판매 중지)는 그대로다.

   | 저장소 | 종류 | 값 칸(정본) | 판·명령 칸(이 결정) |
   | --- | --- | --- | --- |
   | `q:{event:E}:ctl` | 1 | `target`·`targetUntil`, 되돌리기는 `aimdResumeAt` | `targetRev`·`targetCmd` |
   | `q:{event:E}:ctl` | 2 | `admitPaused`·`admitPausedUntil` | `admitRev`·`admitCmd` |
   | `q:{event:E}:ctl` | 3 회차 | `paused` | `pausedRev`·`pausedCmd` |
   | `q:{admission}:ctl` | 3 전체 | `allPaused`(`1`·`0`, 이 결정) | `allPausedRev`·`allPausedCmd` |
   | `q:{admission}:ctl` | 11 | `autoStopped` | `autoStoppedRev`·`autoStoppedCmd` |
   | `q:{event:E}:notice`·`q:{event:PLATFORM}:notice` | 3 | `paused` | `pausedRev`·`pausedCmd`. HOT-010의 `version`·`commandId`는 마지막으로 적용한 제어(종류 무관)를 그대로 쓴다 |
   | 같은 notice | 7 | `banner`(없으면 칸을 지움) | `bannerRev`·`bannerCmd` |
   | purchase DB `sale_control` | 3 | `paused` | 새 칸 `paused_revision`·`paused_command_id`·`paused_changed_at`(purchase-svc 마이그레이션 0033). 지금의 `revision`·`command_id`는 판매 중지 몫으로 읽는다 |
   | `s:{event:E}:ctl` | 3 회차 | `paused` | `pausedRev`·`pausedCmd`(data.md의 `rev`·`cmd`는 판매 중지 몫으로 읽는다) |
   | `s:{event:E}:ctl` | 3 전체 | `allPaused` | `allRev`·`allCmd`(data.md 그대로) |

   리더는 `q:{admission}:ctl`의 `allPaused`가 `1`이면 모든 회차의 serving 전진을 0으로 둔다(회차 `paused`와 같다).
7. **purchase-svc 시작·다시 맞춤.** `sale_control`을 플랫폼 시작 작업의 제어 상태(`ControlStateSource`)로 넘겨, 읽지 못하면 준비 상태가 되지 않는다. 2초마다 다시 읽어 파드 메모리(결제 시도·결제 접수의 정지 확인)를 맞추고, 정지가 걸린 행이 있는 회차(전체 정지면 `s:ctl:events`의 모든 회차)의 `s:{event:E}:ctl`을 원본대로 다시 쓴다(C-T50 '지워도 2초 안에 다시'). 사본 쓰기는 판이 칸보다 클 때만이다.
8. **판매 일시정지 중 유휴 시계(PRF-138).** `SessionSweeper`는 그 회차(또는 전체)가 일시정지인 동안 유휴 시한으로 세션을 끝내지 않고 다음 볼 시각만 미룬다. 정지가 풀린 뒤 처음 볼 때, 유휴 시한이 '풀린 시각 + 5분 [가정]'보다 이른 세션은 유휴 시한을 그 값으로 다시 쓴다(정지 동안 쓴 시간을 돌려준다). 최대 체류는 그대로 센다(정본이 적은 예외는 유휴뿐이다). 정지 여부는 결정 7의 파드 메모리 상태로 본다.
9. **설정형 명령 내기(F-02-5가 구현).** 명령 5·7(purchase-svc 공지)·8·9는 명령 12처럼 `ACKED` 상태 쓰기와 같은 트랜잭션에 `publishSetting`으로 설정 사건 하나를 쓴다(ADR-0349 결정 5, 값 꼴은 asyncapi `SettingChanged`). 명령 8의 만료(30분)는 정비 바퀴가 `AUTO_EXPIRED`와 같은 트랜잭션에 기본값(`INFO`)의 새 사건을 쓴다. 명령 9를 되돌리면 `enabled: true`의 새 사건이다.
10. **설정형 명령의 적용 확인(F-02-5가 구현).** `ACKED`인 설정형 명령(5·7 purchase-svc·8·9·12)의 `delivery`는 `kind: APPLY_CHECK`다. 상태는 차례로 다음과 같다.
    - `OUTBOX_WAITING`: 그 명령의 Outbox 행이 5초 넘게 나가지 않았다(ADR-0143 결정 4).
    - `CHECKING`: 나간 뒤 30초까지. 정비 바퀴가 5초 [가정]마다 본다.
    - `CONFIRMED`: 받는 서비스마다 Prometheus `up{service="<서비스>"} == 1`인 파드가 모두 `control_settings_applied_version{service="<서비스>", key="<설정 키>"}` ≥ 그 판(`occurredAt` 밀리초)이다.
    - `UNCONFIRMED`: 30초에 못 미친 파드가 있다. 파드 이름과 그 파드의 판을 `unackedTargets`에 싣고 SEV3 ops 경보 `settings-apply-unconfirmed`(명령마다 하나)를 연다. 그 뒤 10분 동안 1분마다 다시 보고, 모두 맞으면 `CONFIRMED`로 바꾸고 경보를 닫는다.
    - `UNKNOWN`: Prometheus에 닿지 못했다(2초 [가정] 시간 초과). 다음 바퀴에 다시 본다.
    - 받는 서비스: `LOG_LEVEL:<서비스>`는 그 서비스, `FEATURE_FLAG:reviews`는 core-svc, `PG_ASSIGNMENT`는 payment-svc, `BOT_LEVEL`은 trust-svc, purchase-svc 공지(`LOBBY_BANNER`)는 purchase-svc다 [가정]. 표에 없는 설정은 `UNKNOWN`이다. 주소는 `PEAKET_PROMETHEUS_URL`이고 운영에서 없으면 ops-svc 시작이 실패한다.
11. **사전 모의 센 값 `PreviewControl`(F-02-5가 구현).** `ControlReceiver`에 읽기 전용 `PreviewControl(scope, kind, keys) → counts[{key, value, source, measured_at}], unavailable[{key, reason}], pod_name`을 더한다. 아무것도 쓰지 않는다. ops-svc는 키마다 정한 받는 쪽 하나(admission-ctrl은 리더, purchase-svc·queue-svc는 아무 파드 하나)를 데드라인 1초로 부르고, 실패하면 그 키를 `unavailable`에 적는다(0으로 적지 않는다).

    | 키(ADR-0340 `DRY_RUN_KEYS`) | 받는 쪽 | 센 값 |
    | --- | --- | --- |
    | `currentTarget`·`slotsUsed`·`soonAdmitted`·`inFlight`·`admitRatio`·`avgDwellSeconds`·`servingRateCap`·`servingRate` | admission-ctrl 리더 | 그 회차의 마지막 리더 주기 값(`targetNow`, 예매 단계 인원, 곧 입장 대기, 오는 중, 입장 비율, 최근 10분 평균 체류, 전진 속도 상한, 최근 10초 serving 증가 속도). 센 시각은 그 주기의 시각 |
    | `purchaseSessions` | purchase-svc | 정리 색인 `s:{event:E}:sessions`의 멤버 수 |
    | `paymentSessions` | purchase-svc | 그 가운데 Paying 표시(`pay`)가 있는 세션 수 |
    | `holdsPerSecond5m`·`paymentAcceptsPerSecond5m` | purchase-svc | 최근 5분 홀드 성공·결제 접수 수 ÷ 300(파드 메모리 계수가 아니라 저장소 기록에서 센다. 기록 원천이 없으면 `unavailable`, 사유 `no-source`) |
    | `waiting` | queue-svc | 대기열 발급 번호(`q:{event:E}:seq`) − serving − 건너뛴 구간의 번호 수 |

12. **시험 이름.** C-T50·C-T51·C-T54·C-T6 ①·Q-T30과 ASVS 행은 그 ID를 단다. 장부 항목 밖의 세부(판 원장, 대상 찾기, 칸 이름, 유휴 시계)는 `F021-` 번호를 단다.

## 검토한 대안

| 대안 | 판단 |
| --- | --- |
| 판 번호를 명령 기록의 바뀐 시각으로 그대로 둔다 | 기각. 시계가 되돌아가거나 같은 밀리초에 두 명령이 나면 늘어나기만 하는 수가 아니다. 원장에 남겨야 다시 보내기가 같은 판이다. |
| 쿠버네티스 EndpointSlice API를 ops-svc가 직접 읽는다 | 기각(지금). ops-svc 서비스 계정에 API 읽기 권한이 더 든다. 헤드리스 DNS가 같은 준비된 주소를 준다. DNS 캐시로 늦는 몫은 '다시 풀어 새 파드도 부른다'가 메운다. |
| 한 범위의 판 번호를 종류와 상관없이 하나로 둔다 | 기각. ADR-0103 결정 1은 범위·종류마다다. 판매 중지(승인 업무)와 판매 일시정지(명령)는 다른 원장에서 오므로 한 칸이면 서로를 막는다. |
| 응답 안에서 10초까지 ack를 기다린다 | 기각. 3초를 넘는 '전파 지연'을 화면이 볼 수 없고 요청이 데드라인 상한에 닿는다. |
| 판매 일시정지 동안 최대 체류도 멈춘다 | 보류. 정본 T11은 유휴만 적었다. 긴 정지 뒤 한꺼번에 끝나는 문제가 보이면 다시 본다. |

## 결과

- 명령 1·2·3·7·11이 받는 쪽 저장소에 판과 함께 서고, 새로 뜨거나 늘어난 파드도 같은 상태로 시작한다. 옛 리더의 명령 쓰기는 펜싱으로 막힌다.
- 대가: ops DB 표 둘(`control_version`·`command_delivery`)과 purchase DB 칸 셋이 늘고, 정비 바퀴가 `DISPATCHED`·적용 확인 명령을 더 본다.
- 남는 한계: 헤드리스 DNS의 캐시만큼 새 파드를 늦게 볼 수 있다(다시 풀기와 새 파드의 시작 읽기가 메운다). 적용 확인은 관측이라 지표 수집 간격만큼 늦다(ADR-0143). 리더 전용 Service·`role=leader` 라벨·Lease 권한·`<서비스>-control` Service는 배포 차트 몫이고 구간 5(인프라 구축, ADR-0332)에서 kind로 본다.

## 되돌릴 조건

- C-T48 측정(구간 5)에서 DNS 다시 풀기로 새 파드를 3초 넘게 놓치면 EndpointSlice 읽기를 다시 본다.
- 적용 확인 `UNKNOWN`이 온세일 동안 잦으면 질의 시간 초과와 주기를 다시 잰다.

## 확인

- F-02-1·F-02-5 기록 커밋에서 시험 이름(결정 12)과 장부 항목을 대조하고 이 절에 결과를 적는다.
