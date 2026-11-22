# BAT-450 남은 몫 조사 — GAT-210·GAT-220 (초안)

- 조사일: 2026-11-22
- 기준: `origin/develop` `452e5d714`
- 가지: `feature/lane3-BAT-450-scope` (커밋·합치기·푸시 없음)
- 성격: **조사 초안**. 제품 코드·시험은 고치지 않았고, 이 파일만 만들었다.
- 읽은 기록: `docs/review/measurements/BAT-450-wave.md`, `BAT-450-gat220.md`, `BAT-450-gat220-remainder.md`

## 0. 결론 요약

1. **GAT-210 단계 줄은 지금 체크할 수 없다.** 서버의 초대 조회·수락·거절은 있지만, 파트너가 초대를 **만드는** 경로(여러 명·회차 소유 확인·24시간 토큰·URL 조각), 초대 메일, 파트너 명단·해제·재발송, ASVS 재판정, C2-10(`promoter_id` 백필)·C2-11(지난 배정 상태)이 없다.
2. **GAT-220 단계 줄도 지금은 체크할 수 없다.** 핵심 기능(기기 승인·`cnf.jkt` 토큰·세션 1개·교대·대리 승인·서버 해제 확인·SCR-036)은 기록상 끝났지만, ⑴ 감사 낮음 C2-06·C2-07·C2-09가 남아 있고, ⑵ 장부에서 GAT-220 수용 기준 6개(I-T23·I-T24·I-T25·I-T37·I-T38·I-T39)가 **빈칸**이며, ⑶ 같은 기기 동시 승인이 500이 될 수 있는 경합이 남아 있다. `wbs 5.5.2`는 아직 SCR-037을 포함하는데 BUILD_ORDER 589는 "SCR-037은 GAT-360"이라 적어 서로 어긋난다. 이도 정리해야 한다.
3. **파트너 초대 화면은 BAT-450 몫이 아니다.** 파트너 콘솔 SCR-037은 `GAT-360`(BAT-405, 갈래 2), 팬 휴대폰 SCR-050·051·061은 `GAT-230`·`GAT-240`(BAT-400, 갈래 2)이다. BAT-450은 서버·링크·메일까지 하고, 화면은 그 묶음들이 붙인다.
4. **메일은 개발·시험에서 파일 대역으로 충분하다.** 정본은 이메일 대행사를 아직 정하지 않았고(`OPEN[57]`), 관리 계정 초대도 local·ci 파일 대역(`FileAdminMailer`)을 쓴다. 다만 운영에서 실제 초대를 보내려면 대행사가 필요하므로, BAT-450은 메일 포트와 파일 대역까지 만들고 운영 어댑터는 `GAT-250`/BAT-455 또는 별도 계약으로 넘긴다.

## 1. 읽은 정본·기록과 없는 문서

| 문서 | 확인한 내용 |
| --- | --- |
| `docs/BUILD_ORDER.md` 172, 588, 589 | BAT-450 묶음 줄, GAT-210·GAT-220 단계 줄(둘 다 `- [ ]`) |
| `docs/wbs/wbs.md` 286·287 | wbs 5.5.1·5.5.2, 상태 `진행` |
| `docs/wbs/wbs.csv` 225·226 | 같은 두 줄, 상태 `진행` |
| `docs/features/identity.md` 448~505 | §6.1 흐름, 초대 조건, URL 조각, GAT-210/GAT-220 구현 메모 |
| `docs/security/asvs/offline-gate.md` 88·90·280 등 | GAT-210·GAT-220이 닿는 ASVS 행. `테스트 결과`는 자동 리포트 칸 |
| `docs/features/notify.md` 60·67·150·216~219·525 | 이메일 대행사 미정, `core-notify-sender` 첫 몫, local 대역 |
| `docs/review/audit/reports/C2.md` 105~174 | C2-06·C2-07·C2-09·C2-10·C2-11 |
| `docs/review/audit/findings.md` 187 | C2-06..C2-11 한 줄 요약 |
| `docs/api/proto/README.md` 146 | 회차 판매자 대조 경로가 정본에 없다는 미해결 항목 |
| `docs/api/openapi.yaml` 5160~5167, 6184 | 파트너 초대·명단·해제·재발송, 내 배정 목록 계약은 이미 있다 |
| `docs/security/data-classification.md` 88·92 | 초대 이메일 P2, 수락/24시간 만료 시 즉시 파기, 배정 원장 1년 |
| `docs/security/authz-matrix.md` 87~95·351~352 | 배정 회차 데이터 규칙, AZ-T3(테넌트 넘는 쓰기) |

없는 문서·파일:

- **`docs/security/asvs/identity.md`는 없다.** GAT-210·GAT-220의 ASVS 행은 `docs/security/asvs/offline-gate.md`에 있고, 로그인 공통 행은 `docs/security/asvs/auth.md`가 `offline-gate.md`를 가리킨다. 조사 지시의 파일 경로는 잘못이다.
- **`docs/review/plans/BAT-450.md`는 없다.** BAT-450 계획 파일은 아직 없다. 이 파일은 계획이 아니라 조사 초안이다.

## 2. GAT-210 수용 기준: 충족/미충족

GAT-210의 단계 문구는 `ASVS 판정 갱신`, `현장 스태프 배정·초대(여러 명 초대, 24시간 1회 토큰, URL 조각)`이다.

| 수용 기준 | 판정 | 근거 | 남은 것 |
| --- | --- | --- | --- |
| 초대 조회·수락·거절 API | 충족 | `session/inbound/staff-invitation.controller.ts` 36~89, `application/staff-invitations.ts` 67~112, R-548 | 없음(서버) |
| 초대 토큰 SHA-256만 저장 | 부분 | 수락·거절 시 해시 대조와 파기(`staff-invitations.ts` 39·80~107, `drizzle-staff-assignment-store.ts` 80~104) | **토큰을 만드는 코드가 없다.** 32바이트 난수·해시·24시간 만료를 만드는 경로가 없다 |
| 24시간·1회용 | 부분 | 소비할 때 `inviteExpiresAtMs`와 `status=INVITED`를 본다. test-int는 시드로 넣은 만료만 본다 | 발급 시 24시간을 정하고, 발급→만료→사용됨을 한 흐름으로 시험해야 한다 |
| 검증 이메일 = 초대 이메일 | 충족 | `staff-invitations.ts` 82~84, 단위 시험 | 네이버만 연결한 계정(검증 표시 없음)을 이름 붙인 시험으로 남기면 더 분명하다 |
| 휴대폰 본인확인 요구 | 충족(코드·시험) / 운영 막힘 | R-601, `STAFF_PHONE_VERIFICATION`, `verification-staff-phone.ts` | 외부 본인확인기관 계약 전이라 운영은 기록이 없다. **개발·시험은 저장된 기록으로 가능**하다 |
| 두 동의·같은 동의 판 | 충족 | `staff-invitations.ts` 95~96, 단위·test-int | 없음 |
| `hasStaffAssignment` 채움 | 부분 | `hasAssigned`가 `status='ASSIGNED'`만 본다 | C2-11: `valid_until`이 지나도 계속 true다 |
| 탈퇴·병합 때 배정·세션 종료 | 충족 | R-600·R-619, `withdraw-account.ts` 71, `confirm-merge.ts` 119, `maintenance-tasks.ts` 28~47 | 없음 |
| 여러 명 초대(최대 200명)·역할 | **미충족** | OpenAPI·생성 클라이언트에만 있다. `identity-svc`에 만들기 유스케이스·컨트롤러·저장소 메서드가 없다 | `createInvitations` 계열 전부 |
| 회차 소유 확인(core-svc 판매자) | **미충족** | `docs/api/proto/README.md` 146이 "정본에 확인 길이 없다"고 적는다. `identity-svc`에 core 호출이 없다. `gw-partner`는 이 경로를 core-svc로 보낸다(`gw-partner.yaml` 268~271·330~335) | core-svc 회차 판매자 조회 계약·허용 목록 결정, identity-svc 호출 |
| 24시간 토큰 + URL 조각 링크 | **미충족** | 초대를 만드는 코드가 없다. `identity.md` 481~482가 링크 규칙만 정본으로 둔다 | 링크 생성·`#token=`·`next`에 조각 없음 시험 |
| 초대 메일 발송 | **미충족** | `identity-svc`에 스태프 초대 메일 포트가 없다. 관리 계정 메일만 `ADMIN_MAILER`·`FileAdminMailer`가 있다 | 메일 포트, local·ci 파일 대역, 발송 결과 기록 |
| 파트너 명단·해제·재발송 | **미충족** | OpenAPI 5162~5167과 `api-client` 생성물은 있다. 서버 구현이 없다 | `GET /v1/partner/events/{eventId}/staff`, `DELETE /v1/partner/staff/{assignmentId}`, `POST …/invitation` |
| ASVS `offline-gate.md` 재판정 | **미충족** | `asvs-report`로 현재 스캔하면 `offline-gate.md` 156행 중 108행이 `미실행`, 48행이 태그 없음이다. 6.5.1은 "적용"이라 적혀 있지만 C2-07과 어긋난다 | 관련 행의 적용 여부·근거를 다시 쓰고, 시험에 `[ASVS v5.0.0-x.y.z]` 태그를 붙여 리포트를 갱신 |
| C2-10 `promoter_id` 백필 | **미충족** | `0032_staff_promoter_and_scanner_session_unique.sql`에 백필이 없다. 초대 생성 경로도 아직 없다 | 백필 마이그레이션 또는 "운영 데이터 없음"을 정본에 적고, 생성 경로가 반드시 채우게 한다 |
| C2-11 지난 배정 상태 | **미충족** | `hasAssigned`·`listSelf`가 상태만 본다. `maintenance-tasks.ts`에 배정 만료 일이 없다(관리 계정 초대 만료 일은 64행에 있다) | 만료 정비(INVITED→EXPIRED, ASSIGNED→ENDED)와 읽기 시 시간 필터 |
| SCR-037 파트너 화면 | 단계 밖(GAT-360) | `apps/partner/src/_pages/field-staff/ui/StaffPanel.tsx`는 정적 폼·픽스처다. `type="button"`에 API 호출이 없다 | BAT-405에서 연결 |
| SCR-050·061 팬 화면 | 단계 밖(GAT-230·240) | `apps/web/src/_pages/staff-invitations`·`staff-home`은 정적이다. `InviteConsentForm`은 `router.push`만 한다 | BAT-400에서 연결 |

### GAT-210에서 특히 중요한 공백

- **`I-T21` 장부 상태가 실제보다 넓다.** `staff-invitations.test.ts`의 `I-T21` 시험 하나가 수락 조건을 보지만, 24시간 토큰 **발급**과 네이버만 연결한 계정은 시험하지 않는다. 지금 `ledger --batch BAT-450`이 통과하는 것은 장부 범위가 `I-T21` 하나이고, 그 하나가 "자동 시험"으로 세어지기 때문이다. 초대 생성 경로가 생기기 전에는 "24시간 1회용"을 실패시킬 수 있는 시험이 없다.
- **파트너 명단의 이메일·계정 ID 노출 금지**가 계약에 이미 있다(`StaffAssignment` 설명, `authz-matrix` 148). 서버 구현 때 이 약속을 지켜야 한다.
- **같은 회차·같은 이메일의 중복 초대**를 막는 제약이 없다. `UNIQUE(event_id, account_id)`는 `account_id`가 NULL인 INVITED 행끼리 충돌하지 않는다. 초대 생성 때 애플리케이션 검사 또는 부분 유일 인덱스가 필요하다.

## 3. GAT-220 수용 기준: 충족/미충족

GAT-220의 단계 문구는 `기기 승인 로그인(RFC 8628, 8자 확인 코드·시도 제한)`, `현장 스태프 토큰(cnf.jkt)`, `세션 1개·교대·대리 승인`, `해제의 서버 확인`, `SCR-036·037`이다.

| 수용 기준 | 판정 | 근거 | 남은 것 |
| --- | --- | --- | --- |
| RFC 8628 기기 승인 시작·폴링 | 충족 | `start-device-authorization.ts`, `poll-scanner-token.ts`, `device-authorization.controller.ts`; R-566 | C2-06·C2-07 |
| 8자 확인 코드·시도 제한 | 충족 | `device-approval.test.ts` 14건, R-566 | C2-06(색인 덮어쓰기) |
| `cnf.jkt` 스태프 토큰, 만료=역할 유효 끝 | 충족 | `scanner-token-signer.test.ts`, `scanner-authorization.controller.ts` | mTLS `cnf.x5t#S256` 발급은 막힘 |
| 기기당·계정당 세션 1개, 교대 | 충족 | `device-approvals.ts` 146~166, `drizzle-staff-assignment-store.ts` 186~220, R-619 | 같은 기기 동시 승인 500 가능성 |
| 대리 승인(`gate_lead`만, 역할 `gate_staff` 강등) | 충족 | `device-approvals.ts` 133~135, 단위·test-int | 없음 |
| 해제의 서버 확인 | 충족 | `check-scanner-session.ts` 24~29(끝남·만료·REVOKED·시간 밖) | 파트너 해제 **경로**는 GAT-210 몫 |
| 기기 폐기 때 세션 종료·`SESSION_TERMINATED` | 충족 | R-582·R-586, `terminate-scanner-sessions.ts`, ticket-svc `scanner-devices.ts` 138~152 | 없음 |
| SCR-036 실제 로그인 | 충족 | `apps/scanner` 46건, R-586 브라우저 확인 | 없음 |
| SCR-037 | 단계 밖(GAT-360) | 파트너 화면 정적 | BAT-405 |
| mTLS `cnf.x5t#S256` 토큰 발급 | 막힘 | R-591은 판정 함수·계약·시험만. identity 토큰은 `cnf.jkt`만 발급 | GAT-170 mTLS PoC 뒤 |
| 휴대폰 카메라 승인 흐름 확인 | 막힘 | SCR-051 화면은 정적(`staff-approve`), 관리형 기기 PoC 없음 | GAT-230·관리형 기기 PoC 뒤 |
| C2-06 사용자 코드 색인 유일성 | **미충족** | `redis-device-authorizations.ts`의 `SAVE`가 `id:devcode:{userCode}`를 조건 없이 `SET`한다. C2 보고서 105~116 | `SET NX`+재시도 또는 색인 목록 |
| C2-07 승인 뒤 기기 코드 파기 | **미충족** | `POLL`이 `APPROVED`를 계속 돌려주고 `DEL`하지 않는다. C2 보고서 118~128, ASVS `offline-gate.md` 90의 "적용"과 어긋남 | 첫 토큰 발급 때 레코드·색인 삭제, 이후 `expired_token` |
| C2-09 DPoP `htu` 신뢰 | **미충족** | `packages/platform/src/auth.ts` `requestUrlOf`가 `x-forwarded-*`를 먼저 쓴다. C2 보고서 143~153 | 설정된 공개 출처를 쓰고 forwarded는 대체로 |
| 같은 기기 동시 승인 500 | **미충족** | R-566 중간 3. 계정 잠금은 다른 계정이 같은 기기를 동시에 승인하는 경우를 직렬화하지 않는다. `createScannerSession`이 `23505`를 잡지 않는다 | `ALREADY_HANDLED`/409로 사상 |
| I-T23·24·25·37·38·39 | **장부 빈칸 6개** | `ledger --scope` 실측: I-T23·I-T24·I-T25·I-T37·I-T38·I-T39가 빈칸. 코드·시험은 대부분 있으나 시험 이름에 ID가 없다. I-T24는 파트너 해제 경로가 필요하고, I-T25는 403 시험은 있으나 "감사 기록"을 함께 단언하는 시험이 없다(`scan_event.staff_account_id`는 기록된다) | 시험 이름에 ID를 붙이고, I-T24 해제 흐름·I-T25 기록 단언을 보강 |
| 기기 승인 성공·실패 감사 | **미충족** | `scanner_session`은 성공 기록이지만 실패 시도는 Redis 한도뿐이다. identity에 감사 표·감사 호출이 없다 | 감사 기록 방식 결정(표 또는 ops 감사 접수) |
| SCR-051 파트너 이름(I-T62) | 단계 밖(GAT-230) | 화면 정적, `DeviceApprovalView`는 서버에서 이름을 주지 않는 설계 | BAT-400 |

### GAT-220에서 특히 중요한 공백

- **I-T37·I-T38·I-T39는 코드가 이미 있는데 장부만 빈칸이다.** `device-approval.test.ts`의 한도·교대 시험, `packages/platform/test/scanner-auth.test.ts`의 `gate_staff` 거부·`cnf.jkt` 결속 시험에 ID를 붙이면 대부분 닫힌다. 단, **I-T24는 파트너 해제 경로가 없으면 끝까지 시험할 수 없고**, **I-T25는 "감사 로그가 기록된다"를 확인할 시험이 없다.**
- **C2-07은 ASVS 6.5.1의 "적용"을 거짓으로 만든다.** GAT-210의 ASVS 재판정과 GAT-220의 "8자 코드 일회용" 모두에 걸리므로, 어느 한쪽에서 먼저 고쳐야 한다.
- **`wbs 5.5.2`는 아직 `SCR-036·037`을 포함한다.** BUILD_ORDER 589는 "SCR-037은 GAT-360"이라 적는다. 단계 줄을 체크하려면 wbs 쪽 문구를 `SCR-036`만 남기거나 "SCR-037은 GAT-360"을 명시해야 한다.

## 4. 단계 줄을 체크해도 되는가

### 4.1 GAT-210

- 체크 위치: `docs/BUILD_ORDER.md` 588 `- [ ] GAT-210 …`
- wbs: `docs/wbs/wbs.md` 286(상태 `진행`), `docs/wbs/wbs.csv` 225(상태 `진행`)
- **판정: 지금은 체크 불가.**
- 막는 빈칸:
  1. 파트너 초대 생성(여러 명·회차 소유 확인·24시간 토큰·URL 조각) 없음.
  2. 초대 메일 발송·재발송 없음.
  3. 파트너 명단·해제·재발송 없음.
  4. ASVS `offline-gate.md` 재판정 미완료(특히 6.5.1과 C2-07 충돌).
  5. C2-10 `promoter_id` 백필, C2-11 지난 배정 상태.
  6. `I-T21` 시험이 24시간 발급·네이버만 연결한 계정을 덮지 않는다.
- 체크 조건(초안):
  1. BAT-450B(초대 서버)·BAT-450C(마감)가 끝난다.
  2. `I-T21`에 발급→24시간→1회용 시험과 네이버만 연결한 계정 거절 시험이 붙는다.
  3. ASVS 재판정 범위를 GAT-210이 닿는 행으로 좁혀(또는 전체를) 갱신하고, 시험 태그 리포트를 돌린다.
  4. C2-10·C2-11을 고치거나 "운영 데이터 없음/다른 단계"로 정본에 명시한다.
  5. 묶음 절차 10단계(역할별 커밋·장부 재생성·기록·`--require`)를 통과한다.

### 4.2 GAT-220

- 체크 위치: `docs/BUILD_ORDER.md` 589 `- [ ] GAT-220 …`
- wbs: `docs/wbs/wbs.md` 287(상태 `진행`), `docs/wbs/wbs.csv` 226(상태 `진행`)
- **판정: 지금은 체크 불가.** 단, "핵심 기능이 없다"가 아니라 "검증·감사 정리가 안 됐다"에 가깝다.
- 막는 빈칸:
  1. C2-06·C2-07·C2-09.
  2. 같은 기기 동시 승인 500 가능성.
  3. 장부 6개 빈칸(I-T23·I-T24·I-T25·I-T37·I-T38·I-T39). I-T24는 파트너 해제 경로(GAT-210)가 필요하고, I-T25는 403 시험은 있으나 "감사 기록" 단언이 시험 이름·내용에 없다.
  4. `wbs 5.5.2`의 `SCR-037`과 BUILD_ORDER 589의 "SCR-037은 GAT-360" 불일치.
  5. mTLS `cnf.x5t#S256` 발급·휴대폰 카메라 흐름은 다른 단계/외부 PoC 막힘이다. 이 둘을 "단계 범위 밖"으로 명시해야 한다.
- 체크 조건(초안):
  1. C2-06·C2-07·C2-09를 고치고 시험을 붙인다.
  2. 같은 기기 동시 승인 경합을 409/`ALREADY_HANDLED`로 닫는다.
  3. I-T23·I-T25·I-T37·I-T38·I-T39에 ID 달린 시험을 붙이고, I-T24는 파트너 해제 뒤 401·`OUT_OF_SESSION`까지 시험한다.
  4. wbs 5.5.2에서 SCR-037을 빼거나 "GAT-360"으로 표시한다.
  5. mTLS·카메라 흐름을 "다른 단계/막힘"으로 단계 줄에 적는다.
  6. 묶음 절차 10단계를 통과한다.

### 4.3 장부 실측

```text
$ node tools/ci/ledger.mjs --batch BAT-450
범위: BAT-450 'I-T21' (항목 1개, 묶음 등급 B)
상태: 자동 시험 1, ID만 0, 측정 0, 사람 확인 0, 미검증 0, 다른 단계 0, 없앰 0, 해당 없음 0, 빈칸 0
```

```text
$ node tools/ci/ledger.mjs --scope "I-T21,I-T22,I-T23,I-T24,I-T25,I-T37,I-T38,I-T39,I-T47,I-T62"
범위: … (항목 13개)
상태: 자동 시험 2, ID만 0, 측정 0, 사람 확인 0, 미검증 0, 다른 단계 0, 없앰 0, 해당 없음 0, 빈칸 11
빈칸 I-T23 [B] …
빈칸 I-T24 [B] …
빈칸 I-T25 [B] …
빈칸 I-T37 [B] …
빈칸 I-T38 [B] …
빈칸 I-T39 [B] …
빈칸 I-T47 [B] …
빈칸 I-T62 ①~④ [B] …
```

- `--batch BAT-450`이 통과하는 것은 **장부 범위가 I-T21 하나**이기 때문이다. GAT-220 수용 기준 6개는 그 범위 밖이라 통과에 걸리지 않는다. 이 착시를 단계 줄 체크 근거로 쓰면 안 된다.
- I-T47·I-T62는 GAT-230(휴대폰 화면) 몫이라 BAT-450에서 닫을 필요는 없다. 다만 GAT-220 단계 줄에 SCR-036·037이 적혀 있으므로, 화면 몫을 어디까지 볼지 정본에 분명히 해야 한다.

### 4.4 체크할 때 고칠 파일·줄(초안)

| 파일 | 줄 | 바꿀 것 |
| --- | --- | --- |
| `docs/BUILD_ORDER.md` | 588·589 | `- [ ]` → `- [x]`, 끝낸 날짜·R 번호·계획 파일·검증 요약을 한 줄로 |
| `docs/BUILD_ORDER.md` | 172 | BAT-450 묶음 비고를 "일부 구현"에서 "끝"으로, 남은 화면 몫의 위치를 명시 |
| `docs/wbs/wbs.md` | 286·287 | 상태 `진행` → `완료`(필요하면 실제 일수) |
| `docs/wbs/wbs.csv` | 225·226 | 상태 칸 `진행` → `완료` |
| `docs/lanes/lane3.md` | 진행 로그 | 끝낸 묶음 한 줄 |
| `docs/PROGRESS.md` | 해당 절 | 필요하면 한 줄. 40KB를 넘으면 `progress-archive.md`로 이동 |
| `docs/review/ledger/*` | identity·offline-gate | `ledger.mjs`로 재생성(손으로 고치지 않는다) |
| `docs/review/plans/BAT-450.md` | 새 파일 | 역할별 커밋·실패 확인·리뷰·검증·담당 표를 갖춘 묶음 계획(이 조사 파일과 별개) |

## 5. 남은 구현 묶음 제안

WBS 일수는 [가정]이다. 원래 BAT-450은 4일이고, 아래 합은 4~5일이다.

### BAT-450A — GAT-220 마감 (먼저 할 수 있음)

| 항목 | 내용 |
| --- | --- |
| 범위 | C2-06(사용자 코드 색인 `SET NX`+재시도), C2-07(첫 토큰 발급 때 기기 코드·색인 삭제, 이후 `expired_token`), C2-09(공개 출처 설정으로 `htu` 구성), 같은 기기 동시 승인 `23505`→`ALREADY_HANDLED` |
| 시험 | I-T23·I-T25·I-T37·I-T38·I-T39에 ID 달린 시험, I-T24는 서버 해제 확인·`OUT_OF_SESSION`까지, C2-06 충돌·C2-07 재폴링·C2-09 forwarded 위조 |
| 선행 | 없음. `PEAKET_PUBLIC_ORIGIN` 같은 설정 이름만 정하면 된다 |
| 등급/크기 | B / 1.0~1.25일 |
| 끝의 조건 | `ledger --scope` 6개 빈칸 0, GAT-220 단계 줄 체크 |

### BAT-450B — GAT-210 파트너 초대 서버

| 항목 | 내용 |
| --- | --- |
| 범위 | ⑴ core-svc 회차 판매자·회차 시각 조회 계약(정본 결정), ⑵ identity-svc `POST /v1/partner/events/{eventId}/staff-invitations`, `GET …/staff`, `DELETE /v1/partner/staff/{assignmentId}`, `POST …/{assignmentId}/invitation`, ⑶ 32바이트 토큰·SHA-256·24시간·URL 조각 링크, ⑷ 메일 포트+local·ci 파일 대역, ⑸ `gw-partner` 라우트를 core-svc에서 identity-svc로 이동, ⑹ 계약·생성물 |
| 시험 | 최대 200명, 같은 이메일 중복, 다른 파트너 회차 404/403(AZ-T3), 24시간 만료, 1회용, 링크에 `#token=`만, 메일 파일 내용, 해제 뒤 스캐너 401, 재발송 뒤 옛 토큰 무효 |
| 선행 | ① **회차 판매자 대조 경로 결정**: core-svc `GET /internal/v1/events/{eventId}/sale-config`를 identity-svc가 부르게 할지(ADR-0285 결정 9·NetworkPolicy·내부 토큰 갱신), 아니면 core→identity gRPC를 새로 둘지. ② 메일 전달 방식(동기 발송 vs 알림 행+재시도)을 정본에 쓴다 |
| 등급/크기 | B / 2.0~2.5일 |
| 끝의 조건 | HTTP·단위·test-int 통과, 파트너가 초대를 만들고 메일 파일에서 링크를 확인할 수 있다 |

### BAT-450C — GAT-210 마감

| 항목 | 내용 |
| --- | --- |
| 범위 | ⑴ 배정 만료 정비(`INVITED`→`EXPIRED`, 이메일·토큰 파기 / `ASSIGNED`→`ENDED`), ⑵ `hasAssigned`·`listSelf`의 시간 필터, ⑶ C2-10 백필 또는 "운영 데이터 없음" 정본화, ⑷ ASVS `offline-gate.md`의 GAT-210·GAT-220 행 재판정+시험 태그, ⑸ I-T21 보강(24시간 발급·네이버만 연결), ⑹ 단계 줄·기록 |
| 시험 | 만료 정비가 이메일·토큰을 지우는지, 지난 배정이 `hasStaffAssignment=false`·`listSelf=ENDED`인지, 백필, ASVS 리포트 |
| 선행 | BAT-450B |
| 등급/크기 | B / 1.0~1.5일 |
| 끝의 조건 | GAT-210 단계 줄 체크, C2-10·C2-11 닫힘, ASVS 관련 행 갱신 |

### 선택: BAT-450D — 스태프 초대·해제 감사

| 항목 | 내용 |
| --- | --- |
| 범위 | 초대 생성·재발송·해제·수락의 행위자·시각·사유를 불변 기록으로 남긴다. identity에 새 표를 둘지, ops-svc `POST /internal/v1/ops/audit-records`에 recordType을 더할지 결정 |
| 선행 | 감사 기록 방식 결정(현재 감사 접수는 `SHUFFLE_COMMIT_DISCLOSED`만 받고 사람 칸을 받지 않는다) |
| 등급/크기 | B / 0.5~1.0일 |
| 비고 | BAT-450C에 합쳐도 되지만, 정본 결정이 필요해 별도로 두는 편이 안전하다 |

### BAT-450 밖이지만 의존하는 것

- **GAT-230**(BAT-400): SCR-050 초대 수락·SCR-051 승인 화면·URL 조각·`next` 규칙·I-T47·I-T62.
- **GAT-240**(BAT-400): SCR-061 내 현장 배정, 초대 거절 화면.
- **GAT-360**(BAT-405): SCR-037 파트너 현장 스태프·현장 운영 탭(초대 폼·명단·해제·재발송).
- **GAT-250**(BAT-455): 실제 이메일 대행·발송 원장.
- **GAT-170**: mTLS `cnf.x5t#S256` 발급 PoC.
- **외부**: 본인확인기관 계약(운영 수락), 이메일 대행사 계약(운영 초대).

## 6. 메일 발송: 실제가 필요한가, 대역으로 충분한가

- **정본**: `docs/features/identity.md` §6.1 흐름은 `I-->>M: 초대 메일`로 identity가 보내는 모양이다. `docs/security/data-classification.md` 88은 초대 이메일을 P2로 두고 수락/24시간 만료 시 즉시 파기하라고 정한다. `docs/features/notify.md` 60·216은 이메일 대행사를 아직 정하지 않았고(`OPEN[57]`), 대행사 어댑터 하나로 가두라고 한다.
- **개발·시험**: **파일 대역으로 충분하다.** 관리 계정 초대가 `FileAdminMailer`(`PEAKET_ADMIN_MAIL_DIR`, local·ci만)로 같은 문제를 푼다. 스태프 초대도 `STAFF_INVITE_MAILER` 같은 포트와 파일 대역을 두고, 시험이 파일에서 `#token=` 링크·수신자·24시간을 확인하면 된다.
- **운영**: 실제 대행사가 필요하다. 대행사 없이 초대를 만들면 링크를 전달할 길이 없다. 다만 이 계약은 BAT-450의 코드 선행이 아니며, `GAT-250`/BAT-455 또는 별도 계약으로 넘긴다. 운영에서 어댑터가 없을 때 조용히 초대를 만든 척하면 안 되고, 503 `provider-down`으로 닫거나 "발송 대기"를 남기고 경보해야 한다. 어느 쪽인지는 BAT-450B 계획에서 정본에 정한다.
- **하지 말 것**: API 응답에 초대 토큰·링크를 실어 파트너 화면에 보여 주는 것. 토큰은 메일 링크의 URL 조각에만 두고, 응답에는 배정 ID·상태·만료 시각만 싣는다. 파트너가 링크를 복사해 다른 경로로 보내면 URL 조각·Referer 규칙이 깨진다.

## 7. 위험: 개인정보·권한·감사

| 위험 | 왜 | 놓치기 쉬운 곳 | 줄이는 방법 |
| --- | --- | --- | --- |
| 초대 이메일 보존 | P2 개인정보. 수락/24시간 만료 시 즉시 파기해야 한다 | `staff_assignment.invite_email`이 만료 정비 없이 남는다. 현재 만료 정비가 없다 | BAT-450C의 만료 정비에서 이메일·토큰 해시를 함께 지운다. 이미 지난 INVITED 행이 있으면 먼저 정리 |
| 초대 토큰 노출 | 링크가 메일·브라우저·프록시에 남으면 1회용이 깨진다 | API 응답·로그·`next`·Referer·메일 대역 파일 | 응답에 토큰 금지, `#token=`만, 화면이 읽고 `replaceState`, `next`에는 경로만, 대역 파일은 커밋 금지 |
| 테넌트 넘는 초대 | A 파트너가 B 회차에 스태프를 넣으면 B 공연 입장 권한이 생긴다 | `gw-partner`가 현재 core-svc로 보내고, identity에 소유 확인이 없다 | 회차 `promoter_id`를 core에서 받아 `me.tenantId`와 대조. AZ-T3 시험 |
| `promoter_id`를 호출자 값으로 채움 | 기기 승인 때 "기기 파트너=배정 파트너" 대조가 무력화된다 | 생성 경로가 이벤트가 아니라 요청 본문/테넌트를 그대로 넣는 실수 | 반드시 core가 준 회차 판매자로 채운다. C2-10 |
| 역할 상승 | `partner_member`도 `gate_lead`를 초대할 수 있다(정본 권한 매트릭스) | 초대 폼에서 `gate_lead` 선택 | 정본대로 두되, 초대·해제 감사와 파트너 관리자 알림을 둔다. 필요하면 `gate_lead` 초대는 `partner_admin`만으로 좁히는 결정을 별도로 한다 |
| 대량 초대·메일 폭탄 | 한 요청 200명, 반복 호출 | 파트너 관리자 계정 탈취 | 파트너/계정별 시간당 한도, 중복 이메일 거절, 422 행 오류, 발송량 지표 |
| 초대 명단 개인정보 | 파트너가 이메일·계정 ID를 보면 안 된다 | `StaffAssignment` 응답에 이메일을 넣기 쉽다 | 계약대로 닉네임·역할·상태·건수만. 초대 전 행은 이메일 없이 표시 |
| 감사 공백 | 누가 초대·해제·승인했는지 불변 기록이 없다 | `invited_by`는 있지만 해제 행위자·사유, 승인 실패가 없다 | BAT-450D 또는 C에 감사 기록을 넣는다. ASVS 16.3.1 |
| C2-07 | 같은 기기 코드로 5분간 여러 토큰이 나온다 | `POLL`이 `APPROVED`를 반복 반환 | 첫 발급 때 삭제. ASVS 6.5.1과 일치 |
| 같은 기기 동시 승인 | 두 계정이 동시에 승인하면 500 | `scanner_session_device_active_key` 위반을 잡지 않는다 | `23505`를 `ALREADY_HANDLED`/409로 |
| 지난 배정 표시 | 끝난 배정이 `ASSIGNED`로 보여 "현장 근무"가 남는다 | `hasAssigned`·`listSelf` | C2-11 |
| 회차 취소·연기 | 취소된 회차의 초대가 살아 있다 | 초대 생성 뒤 회차 상태를 다시 보지 않는다 | 생성 때 판매 상태·회차 시각 확인, 취소 사건 때 INVITED 정리(후속) |
| 파트너 계정 삭제 | 삭제된 관리자가 만든 초대가 남는다 | `invited_by`는 FK가 아니다 | 삭제·역할 회수 때 그 계정이 만든 INVITED를 유지할지 정본에 정한다 |
| 스캐너 세션 보존 | 배정 원장 1년 보존인데 정비가 없다 | `scanner_session` 행 | 회차 종료 1년 뒤 파기 작업(후속, BAT-450C에 넣을지 결정) |

## 8. 다음에 바로 할 일 1~3개

1. **BAT-450A(GAT-220 마감)를 먼저 연다.** 선행이 없고 1일 안쪽이다. C2-06·C2-07·C2-09와 같은 기기 동시 승인 500을 고치고, I-T23·I-T25·I-T37·I-T38·I-T39에 ID 달린 시험을 붙인 뒤 GAT-220 단계 줄을 체크한다.
2. **GAT-210의 회차 판매자 조회 계약을 정본에 먼저 쓴다.** `docs/api/proto/README.md` 146의 미해결 항목이다. core-svc `GET /internal/v1/events/{eventId}/sale-config`를 identity-svc가 부르는 안(ADR-0285 결정 9·NetworkPolicy·내부 토큰 갱신)과 core→identity gRPC 안을 비교해 하나를 정하고, 메일 전달 방식(동기 vs 알림 행+재시도)도 함께 적는다.
3. **그 뒤 BAT-450B(파트너 초대 서버)를 연다.** 초대 생성·명단·해제·재발송, 메일 파일 대역, `gw-partner` 라우트 이동, 계약·시험까지. 화면(SCR-037·050·051·061)은 BAT-405·BAT-400에 맡기고 BAT-450에서 만들지 않는다.

## 9. 이번에 확인한 명령과 결과

| 명령 | 결과 |
| --- | --- |
| `node tools/ci/ledger.mjs --batch BAT-450` | 통과(항목 1, 자동 시험 1, 빈칸 0) |
| `node tools/ci/ledger.mjs --scope "I-T21,…,I-T62"` | 항목 13, 자동 시험 2, **빈칸 11**(GAT-220 6개 포함) |
| `pnpm --filter @peaket/identity-svc test test/staff-invitations.test.ts test/device-approval.test.ts test/check-scanner-session.test.ts` | 3파일 32건 통과 |
| `pnpm --filter @peaket/scanner test` | 46건 통과 |
| `pnpm --filter @peaket/ticket-svc test test/scanner-device-lookup.test.ts test/scanner-device-grpc.test.ts` | 2파일 7건 통과 |
| `node tools/ci/asvs-report.mjs --scan services` | 시험 보고서 0개. `offline-gate.md` 156행 중 108행 `미실행`, 48행 태그 없음(리포트를 넣어야 갱신된다) |

Docker test-int는 이번 조사에서 새로 돌리지 않았다. R-548·R-566·R-586·R-600·R-601·R-619 기록의 test-int 결과를 근거로 삼았다.

## 10. 남은 한계

- SCR-050·051·061은 정적 화면이라 실제 브라우저 흐름을 확인하지 못했다. 화면 몫은 BAT-400이다.
- 외부 본인확인기관·이메일 대행사가 없어 운영 경로는 확인할 수 없다. 개발·시험 경로만 확인했다.
- ASVS 표의 `테스트 결과`는 CI 리포트가 없어 `미실행`으로 보인다. 실제 시험 태그와 리포트를 붙인 뒤 다시 봐야 한다.
- 같은 기기 동시 승인 500은 코드 대조로 판단했다. 실제 PostgreSQL 2세션 재현은 BAT-450A에서 해야 한다.
- `docs/security/asvs/identity.md`가 없어, 지시된 경로 대신 `offline-gate.md`를 읽었다.
