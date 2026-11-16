# 웨이브 6 독립 감사 발견

감사 대상: `v0.2.0`(`6bcea3c7`, 2026-11-04)..`develop`(`fabbabac`, R-594, 2026-11-15).
감사 방법과 원칙은 `README.md`를 따른다. 구현에 참여하지 않은 새 에이전트가 코드·계약·시험·마이그레이션을 직접 대조했다. 영역·관점·변이별 상세 보고서는 `reports/<ID>.md`에 있다.

## 요약

| ID | 심각도 | 영역 | 제목 | 상태 |
| --- | --- | --- | --- | --- |
| CONS-01 | 높음 | payment 정산 | 정산서 중복 생성으로 같은 매출 이중 지급 가능 | R-599 수정 |
| CONS-02 | 높음 | payment 지급 | 승인 금액과 실행 지급 금액 불일치 | R-599 수정 |
| OPS-01 | 높음 | ops 감사 | 회차 취소·지급 승인이 감사 체인에 남지 않음 | R-597 수정 |
| C2-01 | 높음 | identity | 탈퇴·계정 병합이 스태프 배정·스캐너 세션을 끝내지 않음 | R-600 수정 |
| B2-1 | 중간 | queue | `q:rst` 사본에 TTL이 없어 보존 기한 위반 | R-595 수정 |
| B2-2 | 중간 | queue | 우선 구매 입장 토큰에 `lst` 누락 | R-595 수정 |
| M2-G1 | 중간 | purchase | 우선 구매 결제 실패 복귀 test-int 없음 | R-598 수정 |
| M2-G2 | 중간 | purchase | 연기 취소 공제 0원 무단언 | R-598 수정 |
| M2-G3 | 중간 | purchase | 권리 만료가 입장 시작에서 잘리는지 무시험 | R-598 수정 |
| M2-G4 | 중간 | purchase | ticket-svc `REFUND_AFTER_CLOSE` 단독 근거 무시험 | R-598 수정 |
| M4-01 | 중간 | ops 지급 | 승인 기한이 전 영업일이 아니라 전날(월요일→일요일) | R-597 수정 |
| M4-02 | 중간 | ops 감사 | 체크포인트 서명 불일치 거절 시험 없음 | R-597 수정 |
| M4-03 | 중간 | ops 감사 | 서명 대상에 체크포인트 ID 결속 시험 없음 | R-597 수정 |
| M4-04 | 중간 | ops 지급 | 지급 재인증 계정 결속 시험 없음 | R-597 수정 |
| M4-05 | 중간 | ops 회차 취소 | 환불 상태 매핑 시험 없음 | R-597 수정 |
| M4-06 | 중간 | ops 회차 취소 | 판정자 자기 판정 반려 차단 시험 없음 | R-597 수정 |
| M4-08 | 중간 | ops 지급 | 지급 승인 저장 낙관적 잠금 없음(추정) | R-597 수정 |
| M5-01 | 중간 | scanner | jkt 시험이 자기 참조라 RFC 7638 순서 회귀를 못 잡음 | R-596 수정 |
| M5-02 | 중간 | platform | DPoP `htu` 호스트 불일치 시험 없음 | R-596 수정 |
| M5-03 | 중간 | identity | `validFrom` 이전 세션 거절 시험 없음 | R-596 수정 |
| M5-04 | 중간 | platform | `valid:false`+role 조합 거절 시험 없음 | R-596 수정 |
| CONS-03 | 중간 | payment 지급 | 지급 건별 결과·부분 실패·재시도 상태가 죽어 있음 | 후속 |
| CONS-04 | 중간 | purchase/queue | 옛 SALE_STOP 재시도가 최신 SALE_RESUME을 되돌림 | 후속 |
| CONS-05 | 중간 | ops 명령 | 2인 승인 10분 기한 미집행 | 후속 |
| CONS-06 | 중간 | payment 환급 | 부분 취소 크래시 복구가 결제사 멱등키 수명에 의존 | 후속 |
| CONS-07 | 중간 | identity 세션 | `refresh_used` 1회 가드 미구현 | R-601 수정 |
| C2-02 | 중간 | identity 초대 | 스태프 초대 수락이 휴대폰 본인확인을 보지 않음 | R-601 수정 |
| C2-03 | 중간 | platform | `InternalTokenGuard` 토큰 미설정 시 fail-open | R-601 수정 |
| C2-05 | 중간 | identity | 스캐너 세션 계정당 1개 불변식 없음 | R-600 수정 |
| OPS-02 | 중간 | core 웹훅 | 발송 워커에 임대·클레임이 없어 중복 발송 | R-602 수정 |
| OPS-03 | 중간 | ops 지급 | 지급 승인 낙관적 잠금 없음 | R-597 수정 |
| OPS-04 | 중간 | ops 감사 | 체크포인트 생성 직렬화·트랜잭션 없음 | R-597 수정 |
| OPS-05 | 중간 | platform | 내부 공유 토큰 미설정 시 무인증(fail-open) | R-601 수정 |
| OPS-06 | 중간 | core 웹훅 | 응답 본문을 상한 없이 읽어 OOM 가능 | R-602 수정 |
| OPS-07 | 중간 | ops 회차 취소 | 확정 저장이 외부 환불 시작 뒤·낙관적 잠금 없음 | R-597 수정 |
| OPS-08 | 중간 | deploy | 리더 Lease create 권한 없음 | R-602 수정 |
| TEST-01 | 중간 | 증거 | ledger `--batch` 보고가 `--require` 없이 "통과"로 기록됨 | R-612 수정 |
| TEST-02 | 중간 | 증거 | `--require`가 미검증·다른 단계를 통과로 셈 | R-612 수정 |
| A1-H2 | 높음 | payment 정산 | 상점(STANDARD/ESCROW) 구분 없이 같은 결제를 두 정산서가 계산 | R-613 수정 |
| A1-H3 | 높음 | payment 정산 | 대사로 닫은 CANCELED 결제가 판매 대금으로 잡힘 | R-613 수정 |
| A1-H7 | 높음 | payment 지급 | 예금주 대조 없이 계좌 등록·지급 | R-613 수정 |
| A1-H10 | 높음 | payment 정산 | 회차 수수료율이 공연 설정이 아니라 기본 1000bp | R-613 수정 |
| B3-H01 | 높음 | ops 명령 | 명령 유형별 역할 강제가 없어 operator가 commander 전용 명령 승인·재시도 | R-614 수정 |
| B3-H03 | 높음 | ops 감사 | 감사 체인 검증이 원본 행 변조를 잡지 못함 | R-614 수정 |
| A2-01 | 높음 | payment 상품 정산 | 상품 정산 원천 쿼리 누락으로 항상 503 | R-605 수정 |
| A2-03 | 높음 | core export | 예매자 명단이 굿즈 주문 원천을 읽음 | R-606 수정 |
| A2-05 | 높음 | payment 정산 | HELD/DISPUTED 정산서 복구 경로 없음 | R-605 수정 |
| A2-06 | 높음 | payment 정산 | 회차 정산 계산이 운영에 배선되지 않음 | R-605 수정 |
| C1-01 | 높음 | scanner | OVERRIDE를 gate_staff·기기 단독이 받고 사후 검토 표시 없음 | R-609 수정 |
| SEC-01 | 높음 | gRPC | 새 자금·권한 gRPC 경로 호출자 인증 없음 | R-608 수정 |
| SEC-02 | 높음 | ops 회차 취소 | 확정이 X-Reauth-Token을 무시 | R-597 수정 |
| M1-F1 | 높음 | payment 지급 | 미수금 상계와 배치 저장이 비트랜잭션 | R-599/605 수정 |
-620 수정
-620 수정
-620 수정
| COV2-01 | 높음 | trust | `ApplyLabel`에 호출자 인증·인가가 없어 차단 목록·감사 행위자 위조 가능 | R-608 수정 |

낮음 항목은 각 감사 보고서와 아래 표에 남긴다.

## 높음

### CONS-01: 정산서 중복 생성으로 같은 매출이 두 번 지급될 수 있다
- 위치: `services/payment-svc/src/modules/settlement/application/settlements.ts:92-147`, `.../drizzle-settlement-store.ts:141-157`, `services/payment-svc/migrations/0015_settlement.sql`
- 증거: `calculateEvent`/`calculateProduct`가 조회 후 삽입만 하고, `settlement_statement`에 유일 제약이 없다. 같은 날 두 번 계산하면 같은 `payout_date`의 정산서 2장이 `CONFIRMED`가 되고 `createPayoutBatch`가 둘 다 집는다. 일일 불변식 M4는 환불 원천만 봐서 잡지 못한다.
- 영향: 같은 매출을 두 번 지급한다. 지급 뒤에는 회수할 방법이 미수금뿐이다.
- 수정: 회차·상품별 부분 유일 인덱스와 `insertStatement`의 충돌 처리. R-599.

### CONS-02: 지급 실행이 승인된 묶음이 아니라 실행 시점의 확정 정산서를 다시 모아 지급한다
- 위치: `.../settlements.ts:317-355`, 특히 `:327`
- 증거: `createPayoutBatch`는 승인 금액·건수를 저장하지만 정산서에 묶음 ID를 쓰지 않는다. `executeBatch`는 `listConfirmed`를 다시 읽어 지급 건을 만든다. 승인 뒤 확정된 정산서가 승인 없이 지급되고, 실제 합계가 `total_amount`와 달라진다.
- 영향: 2인 승인이 "금액 X"를 승인했는데 "금액 Y>X"가 나간다.
- 수정: 정산서에 `payout_batch_id`를 쓰고 실행은 그 묶음의 정산서만 사용, 합계 불일치 409. R-599.

### OPS-01: 회차 취소·지급 승인(2인 확정)이 ops-svc 감사 체인에 전혀 남지 않는다
- 위치: `services/ops-svc/src/app.module.ts:55,73`, `.../event-cancellations/**`, `.../payouts/**`
- 증거: 두 모듈에 `audit: chain`이 전달되지 않고 `AuditChain.append` 호출이 없다. 계약(`transfer-refund.md`, `settlement.md`)은 ops 감사 로그를 요구한다.
- 영향: 2인 승인·회차 취소·지급이라는 가장 민감한 운영 행위의 감사 증거가 없다.
- 수정: 요청·판정·확정·반려·정지·재개·지급 승인/실행/재시도마다 감사 체인에 남긴다. R-597.

### C2-01: 회원 탈퇴·계정 병합이 스태프 배정·스캐너 세션을 끝내지 않는다
- 위치: `services/identity-svc/src/modules/session/application/withdrawal.ts`, `.../merge.ts`, `.../check-scanner-session.ts`
- 증거: 탈퇴·병합이 팬 `session`만 종료한다. `staff_assignment`·`scanner_session`은 그대로이고 `CheckScannerSession`도 계정 상태를 보지 않는다. `STAFF_REVOKED` 사유는 계약에만 있다.
- 영향: 삭제된 계정의 스캐너 토큰이 배정 `valid_until`까지 현장 스캔에 통한다.
- 수정: 탈퇴·병합 시 배정·스캐너 세션 종료, `control.sessions-terminated` 발행, `CheckScannerSession` 계정 상태 확인. R-600.

## 중간

### A1-H2, A1-H3, A1-H7, A1-H10
- A1-H2: 정산서 키에는 `pgStore`가 있지만 결제 원천은 `event_id`·`pg`만 걸러 STANDARD/ESCROW 두 정산서가 같은 결제를 전부 센다. 결제에 상점 구분을 저장하고 원천을 `pgStore`로 걸러야 한다.
- A1-H3: 대사로 `CANCELED` 처리한 결제의 `cancelled_amount`가 비어 정산 원천이 전액을 매출로 센다. 취소·부분 취소 금액을 반영해야 한다.
- A1-H7: `putPayoutAccount`가 예금주 이름을 비교하지 않고 `holderVerified:false`로 저장하며, 배치 생성도 확인하지 않는다. 계좌 등록·변경 시 대조하고 미확인 계좌는 지급을 막아야 한다.
- A1-H10: 회차 수수료율을 공연 설정에서 읽지 않고 호출자 값이 없으면 10%를 쓴다. 설정이 없으면 임의 기본값 대신 닫아야 한다.
- 수정: R-613.

### B3-H01, B3-H03
- B3-H01: `SALE_STOP`·`SALE_RESUME`·`KILL_SWITCH`·`AUTOMATION_STOP` 같은 commander 전용 명령을 operator가 요청·승인·재시도할 수 있다. 명령 유형별 `requesterRoles`·`approverRoles`를 강제해야 한다.
- B3-H03: `audit_chain`에 기록 내용·직전 해시가 없고 `/verification`이 저장된 해시의 루트만 재계산한다. `ops_command.reason`·`command_event.actor_ref`를 고쳐도 `valid:true`다. `record_json`·`prev_hash`를 저장하고 원본과 대조해야 한다.
- 수정: R-614.

### B2-1: `q:rst:{account}`에 TTL이 없어 문서가 정한 보존 기간을 지키지 않는다
- 위치: `services/queue-svc/src/modules/admission/adapters/booking-restriction-lua.ts:3-13`
- 증거: 쓰기 Lua가 `HSET`만 하고 만료를 걸지 않는다. `docs/data.md:2470`은 ACTIVE 종료+1일, LIFTED 30일을 요구한다.
- 영향: 개인정보(계정 ID·제한 ID)가 영구 보존되고 `noeviction`에서 메모리를 계속 먹는다.
- 수정: `PEXPIREAT`와 TTL 시험. R-595.

### B2-2: 우선 구매 입장이 `lst`를 싣지 않는다
- 위치: `services/queue-svc/src/modules/admission/application/confirm-admission.ts:197-220`
- 증거: 일반 입장은 `candidateEligibilityLists`를 `admit`에 넘기지만 `#priority`는 `sign`에 `lists`를 넘기지 않는다. 문서 `queue-admission.md:261`은 "우선 구매 입장도 같다"고 적는다.
- 영향: 선예매 회차에서 우선 구매 권리자가 `sale-policy-denied`를 받을 수 있다(현재 우선 주문이 정책 평가를 타지 않아 잠복).
- 수정: `AdmissionStore.eligibilityLists`로 계정이 든 키만 골라 `lst`에 싣는다. R-595.

### M2-G1..G4
- M2-G1: `RESTORE_PRIORITY_LUA`를 실제 Redis로 부르는 test-int가 없다. 결제 실패 복귀가 깨지면 좌석이 묶이거나 남의 보류를 푼다.
- M2-G2: `EVENT_POSTPONED` 취소의 `deductionBp:0`을 단위·통합 어디서도 단언하지 않는다. 팬이 받을 돈이 줄어든다.
- M2-G3: `entryStartsAtMs`가 2시간 뒤인 회차에서 권리 만료가 입장 시작으로 잘리는지 시험하지 않는다.
- M2-G4: ticket-svc가 `REFUND_AFTER_CLOSE`라고 한 경우를 견적과 독립적으로 확인하지 않는다.
- 수정: R-598.

### M4-01: 지급 승인 기한이 전 영업일이 아니라 전날이다
- 위치: `services/ops-svc/src/modules/payouts/domain/payout-approval.ts:84-87`
- 증거: `payoutDate - 24h + 15h`라 월요일 지급이면 일요일 15시가 된다. 정본은 지급일 전 영업일 15시(KST)다.
- 영향: 월요일 지급 승인 기한이 이틀 일찍 닫혀 운영자가 승인하지 못하거나 다음 영업일로 밀린다.
- 수정: 토·일을 건너뛰는 `previousBusinessDay`. R-597.

### M4-02..M4-08
- M4-02 체크포인트 서명 불일치 거절 시험 없음.
- M4-03 서명 대상에 체크포인트 ID 결속 시험 없음.
- M4-04 지급 재인증 계정 결속 시험 없음.
- M4-05 회차 취소 환불 상태 매핑 시험 없음.
- M4-06 판정자 자기 판정 반려 차단 시험 없음.
- M4-08 지급 승인 저장 낙관적 잠금 없음(추정).
- 수정: R-597.

### M5-01..M5-04
- M5-01 scanner `jktOf` 시험이 자기 참조라 RFC 7638 키 순서 회귀를 못 잡는다. 서버 jose 지문과 어긋나면 모든 기기 로그인이 실패한다.
- M5-02 DPoP `htu`의 호스트를 바꾼 증명을 거절하는 시험이 없다.
- M5-03 `CheckScannerSession`의 `validFrom` 이전 거절 시험이 없다.
- M5-04 `ScannerGuard`가 `{valid:false, role}` 조합을 거절하는지 시험하지 않는다.
- 수정: R-596.

### CONS-03..CONS-07
- CONS-03: 지급 건별 결과·`pgPayoutIds`를 버려 지급 증거·부분 실패·재시도가 성립하지 않는다. `PARTIAL_FAILED`·`payout.IN_PROGRESS/COMPLETED/FAILED`는 죽은 상태다.
- CONS-04: 옛 `SALE_STOP` 재시도가 최신 `SALE_RESUME`을 되돌린다. Redis 사본에 판 번호 가드가 없다.
- CONS-05: 운영 명령 2인 승인의 10분 기한을 아무도 검사하지 않고 `AUTO_EXPIRED`를 쓰지 않는다.
- CONS-06: 부분 취소 크래시 복구가 결제사 멱등키 수명에 의존하고, 실패하면 원장이 미반영으로 남아 추가 환불 창이 생긴다.
- CONS-07: `refreshUsed=true`를 쓰는 곳이 없어 앞 토큰 하나로 30초 동안 무제한 새 쌍을 받는다.

### C2-02, C2-03, C2-05
- C2-02: 스태프 초대 수락이 휴대폰 본인확인을 보지 않는다.
- C2-03: `InternalTokenGuard`가 토큰 미설정이면 통과하고 비교가 비상수시간이다.
- C2-05: `scanner_session`의 계정당 1개 불변식이 DB에 없다.

### TEST-01, TEST-02
- TEST-01: `--batch <묶음>` 보고를 `--require` 없이 "ledger 통과"로 적은 커밋이 있다. 67개 묶음 중 23개가 `--require`에서 실패한다(BAT-425 빈칸 122·ID만 113, BAT-465 96·112, BAT-430 92·113 등). 0항목 통과도 "검증했다"로 읽히게 했다.
- TEST-02: `--require`가 미검증·다른 단계를 통과로 세서 BAT-620(C-T43 미검증)·BAT-202(D-T12 미검증)가 초록이었다.
- 수정: `--require` 기본을 빈칸·ID만·미검증·다른 단계 실패로 바꾸고, 옛 묶음용 `--allow-unverified`를 더했다. `ledger.test.mjs` 30개 통과. R-612.

### OPS-02..OPS-08
- OPS-02: 웹훅 발송 워커가 임대·클레임 없이 모든 복제에서 돌아 중복 발송·상태 역행.
- OPS-03: 지급 승인 상태를 낙관적 잠금 없이 덮어써 `DONE`이 `FAILED`로 뒤집힘.
- OPS-04: 체크포인트 생성이 직렬화되지 않고 체크포인트 행과 체인 추가가 다른 트랜잭션.
- OPS-05: 내부 공유 토큰이 비면 운영에서도 내부 API가 무인증.
- OPS-06: 웹훅 발송기가 응답 본문을 상한 없이 읽어 OOM 가능.
- OPS-07: 회차 취소 확정이 외부 환불 시작 뒤에 저장되고 낙관적 잠금이 없음.
- OPS-08: 리더 Lease create 권한이 없어 Lease 삭제 시 릴레이·정비·Outbox 파티션 생성이 멈춤.

## 낮음

각 감사 보고서의 낮음 항목을 아래에 모은다. 수정은 웨이브 6 안에서 여유가 있으면 하고, 아니면 후속으로 넘긴다.

| ID | 영역 | 내용 |
| --- | --- | --- |
| B2-3 | queue | UUID가 아닌 계정에서 입장 확정 500 |
| B2-4 | docs | ASVS queue-admission 테스트 결과 전부 미실행 |
| M5-05..M5-09 | scanner/identity | DPoP typ·개인키 jwk·등록 jkt 모양·근무 창 밖 승인·flagSeq 시험 공백 |
| M2-01..M2-27 | purchase | PRIORITY_RELEASE 소유자·EXPIRE 경계·s:rst Lua 판·재시도 상한·신청 창 경계·사가 RESERVED 등 시험 공백 |
| CONS-08..CONS-12 | ops/purchase | 도달 불가 상태·EVENT_CANCEL 두 경로·낙관적 판 없음·항목 선점 없음·닫힌 주문 과금 자동 환불 없음 |
| C2-06..C2-11 | identity | 사용자 코드 색인 덮어쓰기·승인 뒤 기기 코드 미폐기·mTLS 정적 비밀·htu 클라이언트 머리·promoter_id 백필·배정 상태 시간 경과 |
| OPS-09..OPS-16 | ops/core/deploy/docs | 웹훅 원장·held_event 보존·merch_order 스키마·asyncapi 설명·마이그레이션 번호·drizzle 스냅샷·RBAC·문서 불일치 |
| M4-07 | ops | 승인 대기 명령 직접 실행 가드 시험 없음 |

## 수정·검증 규칙
- 높음은 배포 전에 고친다. 중간은 웨이브 6 안에서 고치거나, 못 고치면 `PROGRESS.md` 미해결/후속에 정확한 막힘을 남긴다.
- 수정 뒤에는 그 수정을 만든 에이전트가 아닌 다른 감사자가 diff와 시험을 확인한다.
- 감사 커버리지는 `coverage.md`에서 배치·R 번호별로 확인한다.

## 검증 단계 추가 발견

수정 커밋을 만든 에이전트와 다른 독립 검증자가 diff·시험·변이를 다시 봤다. 아래는 그 단계에서 새로 나온 발견이다. 전체 보고서는 `reports/verification/`의 `A1V.md`·`A1V2.md`·`A1V3.md`·`B2V.md`·`OPSV.md`·`CONSV.md`·`C2V.md`·`M5V.md`·`COV2.md`·`B2TA.md`·`R622V.md`·`R623V.md`·`R625V.md`·`R626V.md`·`R627V.md`·`R628V.md`·`L1V.md`·`L1V2.md`에 있다.

| ID | 심각도 | 영역 | 제목 | 상태 |
| --- | --- | --- | --- | --- |
| A1V-01 | 높음 | payment 정산 | 한 배치 안에서 같은 미수금이 여러 정산서에 이중 상계 | R-620 수정 |
| A1V-02 | 높음 | payment 정산 | 스케줄러가 "종료 5영업일 뒤"를 잘못 계산해 지급일이 약 1주 늦음 | R-620 수정 |
| A1V-03 | 높음 | payment 정산 | DISPUTED 정산서를 이의 해소 없이 CONFIRMED로 되돌림 | R-620 수정 |
| A1V-04 | 중간 | payment 정산 | BALANCE·ACCOUNT_MISMATCH·SALE_SUSPENDED HELD를 근거 없이 재확정 | R-620 수정 |
| A1V-07 | 중간 | payment 정산 | 스케줄러 첫 tick이 리더 선출 전·06:00 KST 불일치 | R-620 수정 |
| A1V-08 | 중간 | payment 정산 | confirmDue가 calculateDueEvents 실패에 묶여 하루 밀림 | R-620 수정 |
| A1V-09 | 중간 | core 내부 | settlement-due 내부 경로에 공유 토큰 가드 없음 | R-620 수정 |
| A1V-11 | 중간 | payment 정산 | 메모리 저장소 상계가 원자적이지 않음(운영은 Drizzle) | 문서화 |
| A1V-12 | 중간 | payment 정산 | 재확정 상태 전이에 감사 로그·이벤트 없음 | R-620 수정 |
| B2V-01 | 중간 | queue | TTL 시험이 `PTTL > 0`만 봐 until+1일 값을 고정하지 못함 | R-621 수정 |
| B2V-02 | 낮음 | queue | Redis `eligibilityLists` Lua 실행 시험 없음 | R-621 수정 |
| B2V-03 | 낮음 | queue | 끝 없는 ACTIVE가 같은 판 재전송으로 TTL을 다시 세우지 못함 | R-615 수정 |
| OPSV-01 | 중간 | ops | 감사 append가 상태 저장과 다른 트랜잭션이라 실패 시 RUNNING/EXECUTING 고착 | R-614 수정 |
| OPSV-02 | 중간 | ops | Drizzle 지급 승인 version 조건을 지운 변이 생존 | R-623 수정 |
| OPSV-03 | 중간 | ops | 수기 포트원 실행이 감사 체인에 남지 않음 | R-614 수정 |
| OPSV-04 | 중간 | ops | 체크포인트 payload·원본 행 대조 시험 없음 | R-614 수정 |
| OPSV-05 | 중간 | ops | 재인증 패스키 요구·배선 취약점, identity JWKS 없으면 503 | R-617 부분 |
| OPSV-06..09 | 중간 | ops | 지급 기한 수·목금, 실제 DB 경합, RUNNING 순서·크래시 시험 공백 | R-623 수정 |
| CONSV-01 | 중간 | payment | Drizzle 충돌 경로 시험 없음 | payment 시험 작성 |
| CONSV-02 | 중간 | payment | 묶음 반려 시 정산서 고착 | R-613 수정 |
| CONSV-03 | 중간 | payment | `pg_store` 이중 정산 | R-613 수정 |
| CONSV-04..07 | 낮음 | payment | 배치 결속·합계·마이그레이션·감사 시험 공백 | payment 시험 작성 |
| C2V-01 | 중간 | identity | 병합 경로의 `terminateByAccount` 호출 시험 없음 | R-626 수정 |
| C2V-02 | 중간 | identity | 부분 유일 인덱스 자체를 잡는 시험 없음 | R-626 수정 |
| C2V-03..06 | 낮음 | identity | 교착·정리 실패·감사 문구·계정 잠금 범위 | 후속 |
| M5V-07 | 중간 | ticket | 도메인 `assertJkt` 변이 생존 | R-610 수정 |
| COV2-01 | 높음 | trust | `ApplyLabel`에 호출자 인증·인가가 없어 차단 목록·감사 행위자 위조 가능 | R-608 수정 |
| COV2-02 | 중간 | core 검색 | 다회차 검색 뷰가 지난·다음 회차를 ON_SALE로 오계산 | R-606 수정 |
| COV2-03 | 중간 | core 후기 | 법정 통보 takedown 비멱등·비트랜잭션 | R-617 수정 |
| COV2-04 | 중간 | core 후기 | `GET /v1/ops/reviews/{reviewId}`가 OpenAPI에 없음 | R-617 수정 |
| COV2-05 | 중간 | web 정책 | 처리방침이 미확정 업체·담당자를 공개 | R-618 수정 |
| COV2-06 | 중간 | core 후기 | 탈퇴 계정 후기가 계정 ID·주문 ID와 함께 남음 | R-617 부분(내부 경로만) → W7 갈래 3 W7-audit 배선·0022 권한(파기 vs 익명화 OPEN[42]) |
| COV2-07..11 | 낮음 | core/web | 검색 성능·인앱 브라우저·알림·배치 설명·문서 불일치 | 후속 |
| A2-17R | 중간 | core export | 명단 페이지가 `limit*10`·`slice`·`nextCursor` 폐기로 1,000행 뒤를 놓칠 수 있음 | W7 갈래 3 W7-audit 고침 |
| A2-19R | 중간 | core export | `attendee_export` insert와 접속기록 audit가 별도 트랜잭션 | W7 갈래 3 W7-audit 고침(보기 접속기록·접속지 포함, 저장소 OPEN[43]) |
| SEC-06R | 높음 | core 내부 | `InternalToken401Guard`가 토큰 미설정 시 통과(fail-open) | R-628 수정, W7 갈래 3 W7-audit 회귀 시험 |
| SEC-07R | 중간 | core notify | `NotifyModule`이 `process.env`를 읽어 bundle 배포에서 운영 fake 가능 | R-629 수정(env 주입구) |
| L1V2 | 중간 | platform/identity/web | jti 저장소 fail-open·초안 noindex 미결속·정비 재시도 skip·계정 상태 NULL→ACTIVE | R-608·R-618·R-619 수정 |

### 남은 공백
- **COV2-06 배선**: core에 내부 익명화 경로는 생겼지만 identity 탈퇴·병합이 그 경로를 호출하지 않는다. core에 `identity.accounts-withdrawn` 소비자를 붙이는 후속이 필요하다.
- **COV2-02 검색 뷰**: R-606의 `0018_search_sale_status.sql`이 뷰를 교체했다. 기존 배포 DB에는 마이그레이션 적용 전 뷰 의존 확인이 필요하다.
- **A1V-11 메모리 저장소**: 운영은 Drizzle 트랜잭션이지만 단위 시험은 메모리 저장소라 원자성을 검증하지 못한다. test-int가 이를 덮는다.
- **B2V-03 무기한 제한 TTL**: ops 작업 워커가 아직 없어 현재는 드러나지 않는다. 워커를 붙일 때 같은 판 재전송으로 TTL을 갱신하는 계약이 필요하다.
- **OPSV-05 identity JWKS**: `PEAKET_IDENTITY_JWKS_URL`이 없으면 재인증이 503이다. 배포 환경에서 필수 값으로 고정해야 한다.
