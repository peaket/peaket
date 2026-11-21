# ADR-0349: 결제사 지정 명령 12·결제 감내 모드·사후 검토 보고서·운영 사건 줄·만료 차단 정리 작업의 첫 구현 세부(2026-11-22)

- **상태**: 채택(추천 적용, 2026-11-22, BUILD_ORDER BAT-360 OPS-290 계획). [ADR-0044](0044-dual-pg-selection-and-switchover.md)·[ADR-0062](0062-open-items-delegated-decisions.md)·[ADR-0078](0078-aiops-review-demand-forecast-action-exits-correlation.md)·[ADR-0095](0095-sale-pause-single-commander-and-two-person-approval-demo.md)·[ADR-0143](0143-settings-commands-pg-switch-over-grpc-applied-version-outbox.md)·[ADR-0162](0162-data-request-commander-approval-demo-self-review-waf-expirer-settlement-views.md)의 결정은 그대로 두고, 처음 구현하며 정본에 없던 세부만 정한다. 2인 승인 시연의 데모 도우미와 회차 마감 목록·결제사 판정 경로의 갈래 넘김은 BAT-360 계획 '감독에게'에 올렸다.
- **관련**: [docs/features/control-tower.md](../features/control-tower.md) §3('명령 12와 결제 감내 모드의 첫 구현')·§5('만료 차단 정리의 첫 구현')·§6('사후 검토 보고서의 첫 구현')·§14, [docs/features/payment.md](../features/payment.md) §2.2, [docs/data.md](../data.md) `command_post_review`·§4 6번·§5, [docs/observability.md](../observability.md) '운영 사건 줄', [docs/api/guidelines.md](../api/guidelines.md) §8·§8.1, [docs/review/plans/BAT-360.md](../review/plans/BAT-360.md)
- **관련 ID**: OPS-290, POL-021, POL-036, C-T10 ②, C-T45 ①, C-T46 ②, C-T47 ①, C-T61, P-T46 ①②

## 맥락

- ops-svc에는 명령 12(`PG_ASSIGN`)의 유형과 역할만 있고 매개변수 검사·온세일 윈도우·하위 결제사 판정·전송이 없다. 결제사 판정 규칙과 회차 지정 쓰임새 `AssignEventPg`는 payment-svc에 있다(PRF-203). `control.settings`를 읽는 플랫폼 코드는 있으나 아직 어느 서비스도 켜지 않았고, Avro 부호기는 갈래 1 BAT-059가 만든다.
- 명령 6 '대체 결제사 전환'의 승인 역할이 코드에서 commander만이다. 정본(control-tower §3 6행, payment §2.2)은 commander 요청 + 요청자 아닌 operator 이상 1인 승인이다.
- 사후 검토 보고서는 계약(`post-review`·`post-review-confirmation`)만 있고 저장·기한·경보가 없다. `ops_event` 줄과 만료 차단 정리 작업 `waf-block-expirer`도 없다.

## 결정

1. **명령 12 매개변수.** `{eventId, primaryPg, fallbackPg}`를 허용 목록으로 닫는다. 회차는 소문자 UUID, 결제사는 `TOSS`·`PORTONE`, 대체는 없을 수 있다. 기본과 대체가 같으면 422 `invalid-command`다. 요청은 operator 이상 1인이고 재인증은 없다.
2. **온세일 윈도우.** core-svc 내부 판매 설정(`GET /internal/v1/events/{eventId}/sale-config`)의 판매 시작 T로 [T − 10분, T + 60분)이면 422 `command-out-of-range`다(T − 10분 − 1ms는 받고, T − 10분 정각은 거절, T + 60분 정각은 받는다). 404(판매 승인 전)는 창 밖으로 본다. 그 밖의 실패와 5초 초과는 503 `onsale-window-unavailable`이고 명령·감사 기록이 없다. 미리보기·접수·실행 직전에 본다. 실행 직전에 걸리면 `FAILED`(`command-out-of-range`)다.
3. **하위 결제사 판정.** payment-svc 새 RPC `PaymentService.CheckEventPgAssignment`(회차, 기본, 대체 → 허용 여부, 걸린 하위 결제사와 까닭, 지금 지정, 결제사별 승인 상한)가 PRF-203 규칙 함수를 부르고 아무것도 쓰지 않는다. 걸리면 422 `pg-fallback-same-provider`(값은 하위 결제사 이름과 까닭뿐)다. 무응답·실패(데드라인 2초 [가정])는 503 `pg-check-unavailable`이고 명령이 없다. 미리보기·접수·실행 직전에 묻는다.
4. **dry-run.** 예측 값으로 동시 입장 목표 상한의 지금 → 새 값을 docs/features/queue-admission.md §5 '결제사별 상한' 식으로 보이고 식·넣은 값(3의 승인 상한)·가정을 함께 싣는다. 상한을 받지 못하면 `unavailable`이다.
5. **전송(갈래 1 BAT-059 합친 뒤).** 실행기는 상태 쓰기와 같은 트랜잭션에서 ops Outbox에 `control.settings` 사건(키 `<회차>:PG_ASSIGNMENT:pg`, 값 `PgAssignmentValue`, 행위자 가명 참조, `occurredAt`은 실행 시각)을 쓰고 성공은 `ACKED`다(설정형 명령의 적용 확인 표시는 OPS-300). payment-svc는 설정 저장소의 `PG_ASSIGNMENT` 변경마다 `AssignEventPg`를 부르고 지정 시각은 사건의 `occurredAt`이다. core-svc의 회차 칸 저장은 그 칸을 만드는 LCH-080·LCH-090, admission-ctrl의 결제사별 상한은 OPS-300이 같은 사건을 읽어 한다. payment §2.2의 '지정 시각은 core-svc가 저장한 시각'은 core-svc가 같은 `occurredAt`을 저장 시각으로 쓰는 것으로 읽는다.
6. **결제 감내 모드.** 명령 6 매개변수의 결제 갈래 `{mode: PAYMENT_PG_FALLBACK, scope: EVENT|PLATFORM, eventIds, toPg}`를 닫는다. `EVENT`면 회차 1~100개 [가정], `PLATFORM`이면 회차가 없다. `toPg`는 없을 수 있다. 승인 역할은 정본대로 요청자 아닌 operator 이상으로 고치고(지금 commander만), 둘 다 재인증이다. dry-run 예측은 대체 결제사 채널 상한으로 다시 계산한 동시 입장 목표 상한이다. 전송·`pg_switch`·해제는 OPS-310이다.
7. **사후 검토 보고서.** 대상은 승인 없이 실행한 명령 3·11이다. 작성 기한은 처음 `DISPATCHED` 시각 + 48시간, 검토 기한은 제출 + 7일이고, 정각이면 넘긴 것이다. 넘기면 SEV3 ops 경보 `post-review-overdue`·`post-review-confirm-overdue`(명령마다 하나)이고, 늦은 제출·검토도 받아 `late`로 적는다. 표 `command_post_review`(명령마다 한 행)를 사건 `POST_REVIEW_OPENED`·`POST_REVIEW_SUBMITTED`·`POST_REVIEW_CONFIRMED`와 같은 트랜잭션에서 고친다. 제출은 실행한 commander만(아니면 403 `post-review-not-executor`), 검토는 실행자가 아닌 commander만(403 `post-review-self-confirm`)이다. 활성 commander가 실행자 한 명뿐이면(identity `ListAdminAccounts`) 실행자의 검토를 받고 감사 기록에 '1인 기간 자기 검토'를 남긴다. identity에 닿지 못하면 503이고 자기 검토를 받지 않는다. ★ 칸은 ops DB로 채우고(실행 기록, 정지부터 재개까지 같은 범위의 명령, 재개 시각과 승인자) 지표 칸은 원천이 생길 때까지 `unavailable`이다. 조회 `GET /v1/ops/commands/{commandId}/post-review`(viewer 이상)를 더한다. 런북으로 실행한 명령 3도 같은 함수로 할 일을 연다(OPS-310).
8. **운영 사건 줄.** 명령 사건이 커밋된 뒤 표본 없이 한 줄을 남긴다. 칸은 docs/observability.md의 `opsEvent`(`<번호>:<유형>`, 카탈로그 밖은 `-:<유형>`)·`stage`·`eventId`·`actorRole`에 `commandId`를 더한 것이다. 단계는 `REQUESTED`·`APPROVED`·`REJECTED`·`ACKED`·`FAILED`·`EXTENDED`·`REVERT_REQUESTED`·`REVERTED`·`AUTO_EXPIRED`와 자동 조치의 `AUTO_ACTION_STARTED`다. 계정·이름·가명 참조는 싣지 않는다. 자동 조치의 끝 줄은 끝내는 조건을 만드는 단계가 같은 함수로 남긴다.
9. **만료 차단 정리 작업.** 진입점은 `services/ops-svc/src/jobs/waf-block-expirer.ts`다. WAF IP 집합은 주소 판 하나만 담으므로 IPv4·IPv6 둘(`PEAKET_WAF_IPSET_V4`·`PEAKET_WAF_IPSET_V6`, 이름과 ID, `PEAKET_WAF_SCOPE`)이다. 보기 `waf_block_expiry_v`는 명령 4의 대역 하나마다 한 행(명령 ID, 정규화한 CIDR, 만료 시각, 상태)이고, 역할 `waf_block_expirer`는 그 보기 읽기만 갖는다. 뺄 대역은 만료가 지난 `ACKED` 명령 4의 대역 가운데 만료 전 `ACKED` 명령 4에 없고 IP 집합에 있는 것이다. 읽은 목록과 잠금 토큰으로 전체를 바꾸고, `WAFOptimisticLockException`이면 다시 읽어 한 번 더 한 뒤 또 실패하면 끝 코드 1이다. 뺀 대역·명령 ID는 JSON 한 줄(`kind` waf-block-expired)이다. ASN 차단의 만료는 IP 집합이 아니라 규칙이라 이 작업 밖이다(명령 4 전송, OPS-310).
10. **ops-svc의 만료 적기.** 명령 4를 받을 때 `ops_command.expires_at`에 만료를 적는다. 정비 바퀴가 만료가 지난 `ACKED` 명령 4마다 IP 집합 둘을 읽어, 그 명령의 대역이 모두 집합에 없거나 만료 전 다른 명령 4가 덮으면 `AUTO_EXPIRED`(SYSTEM)로 적는다. WAF를 읽지 못하면 그대로 두고 다음 바퀴에 다시 본다.
11. **2인 승인 시연의 서버 몫.** 데모 환경(`PEAKET_ENV` demo)의 감사 기록 payload에 `demo: true`를 붙인다. 검사 분기가 아니라 표시이고 다른 환경에는 칸이 없다. 데모 승인자 계정, 데모 막대, 데모 도우미는 이 결정 밖이다.
12. **계약.** 새 Problem type 넷(`onsale-window-unavailable` 503, `pg-check-unavailable` 503, `post-review-not-executor` 403, `post-review-self-confirm` 403), 보고서 조회 경로, 명령 6 결제 갈래·명령 12의 `params` 칸, payment.proto의 새 RPC는 구현 커밋이 계약과 생성물을 함께 고친다. `CommandState.postReviewDueAt`은 7의 작성 기한이다.

## 결과

- 명령 12가 콘솔에서 하위 결제사 규칙과 온세일 윈도우를 지키고, 결제 감내 모드의 승인 역할이 정본과 맞는다. 사후 검토와 만료 차단 정리가 사람 손 없이 기한·경보·기록을 남긴다.
- 남는 한계: 받는 쪽 셋 가운데 이 결정이 잇는 것은 payment-svc뿐이고 core-svc·admission-ctrl은 뒤 단계다. 정리 작업의 CronJob·IAM·kube-state-metrics 경보는 구간 5(인프라 구축)에서 본다. 사후 검토의 지표 칸은 원천이 생기기 전까지 비어 있다.
