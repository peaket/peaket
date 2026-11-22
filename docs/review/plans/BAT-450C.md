# BAT-450C 계획·기록 — GAT-210 배정 만료·정본 마감

- 묶음: BAT-450C, 갈래 3, 구간 3, 등급 B(권한·개인정보·보안 통제). 단계 `GAT-210`(wbs 5.5.1)의 **마감 몫**이다. WBS 일 1.0 [가정].
- 장부 범위: `I-T21, I-T87, I-T88`. `I-T21`은 BAT-450B가 ①~⑪을 채웠고, 이 묶음이 ⑫(네이버만 연결한 계정)를 더한다. 새 번호는 identity §12의 마지막 `I-T86` 다음인 `I-T87`(배정 만료 정비·시간 필터)과 `I-T88`(`promoter_id` 정본화)을 쓴다. I-T87은 C2-11, I-T88은 C2-10의 시험 이름이다.
- 기준: `origin/develop` `f1ab39829`. 작업 폴더 `D:/ticketpass-lane3`, 가지 `feature/lane3-BAT-450C`.
- 출처: 조사 초안 `docs/review/plans/BAT-450-scope.md` §2·§4·§7, BAT-450B '넘기는 것'(§1), `docs/features/identity.md` §6.1, `docs/security/asvs/offline-gate.md` 6.5.x·8.2.x·14.2.x·14.3.2·16.2.5·16.3.x 행, `docs/security/data-classification.md` 88, `docs/data.md` `staff_assignment`(392~407행)·422행, `docs/review/audit/reports/C2.md` 105~178행.
- 차례: 계획 → 시험(실패 확인) → 구현 → 리뷰 → 검증 → 기록. BAT-450B와 같이 정방향 꼬리말은 달지 않는다.
- 이 파일은 역할마다 자기 절만 쓴다: 계획(아래), 실패 확인(시험), 리뷰(리뷰), 검증(검증), 담당 표(각 역할이 자기 줄).

## 계획

계획 담당 `lane3-bat450c-plan`(deepseek-v4.1-flash), 2026-11-22. 제품 코드·시험은 쓰지 않았다.

### 1. 이 묶음이 끝내는 것과 넘기는 것

GAT-210의 서버 기능(초대 만들기·명단·해제·재발송·메일)은 BAT-450B에서 끝났다. 남은 것은 **시간이 지나면 데이터가 끝나게 하는 일**과 **그 판정을 화면·명단·ASVS에 맞추는 일**이다. 이 묶음 뒤에 GAT-210 단계 줄을 체크한다.

| 정본 | 지금 적힌 것 | 이 묶음이 맞추는 것 |
| --- | --- | --- |
| `docs/data.md` `staff_assignment.status` | OnDuty는 저장하지 않고 `ASSIGNED`이면서 지금이 `valid_from`~`valid_until` 사이인 것으로 계산한다 | `hasStaffAssignment`가 그 식을 쓰고, 지난 배정은 `ENDED`로 끝낸다 |
| `docs/data.md` `staff_assignment.invite_email` | 수락·해제·만료 시 파기 | 24시간 만료 정비가 `EXPIRED`로 끝내며 이메일·토큰 해시를 파기한다 |
| `docs/security/data-classification.md` 88 | 초대 이메일 P2, 수락/24시간 만료 시 즉시 파기 | 정비 일 `staff-assignment-expired`가 그 파기를 실제로 한다 |
| `docs/features/identity.md` 481·501 | 기간이 지나면 `EXPIRED`, 남은 것은 BAT-450C | 만료 정비·시간 필터·`promoter_id` 정본화를 여기서 닫는다 |
| `docs/security/asvs/offline-gate.md` | GAT-210이 닿는 행의 근거가 BAT-450B까지만 갱신됨 | 6.5.1·6.5.3·6.5.5·8.2.1·8.2.2·14.2.1·14.2.4·14.3.2·16.2.5·16.3.1·16.3.2를 다시 판정하고 시험 태그를 단다 |
| C2 보고서 155~178행 | C2-10(`promoter_id` 백필 없음), C2-11(지난 배정이 `ASSIGNED`로 남음) | 정비·읽기 필터·정본 문장으로 닫는다 |

**넘기는 것(이 묶음이 하지 않는다)**

- **BAT-450D(불변 감사)**: 초대 만들기·재발송·해제의 행위자·사유를 남기는 불변 감사 기록. 이 묶음은 배정 상태·세션 종료·`control.sessions-terminated`까지만 본다. ASVS 16.3.1은 `부분 적용`으로 내리고 그 까닭을 BAT-450D로 적는다.
- **화면**: SCR-037 파트너 현장 스태프 화면은 GAT-360/BAT-405, SCR-050·051·061 팬 화면은 GAT-230·240/BAT-400. 이 묶음은 서버가 주는 상태·명단 값까지이고 브라우저 확인을 하지 않는다.
- **운영 이메일 대행사**: GAT-250/BAT-455. 이 묶음은 local·ci 파일 대역의 만료·파기만 본다.
- **본인확인기관 계약**: 외부 계약 전이라 운영 수락은 계속 막힌다(기존 한계). 개발·시험은 저장된 본인확인 기록으로 판정한다.
- **초대 만료 전 재발송의 옛 토큰**: BAT-450B가 이미 처리했다. 이 묶음은 정비가 `EXPIRED`로 끝낸 뒤 재발송이 409가 되는 것만 확인한다.
- **`scanner_session` 보존 1년 뒤 파기**: 이 묶음 범위 밖이다. 배정 원장 1년 보존은 data-classification대로 남는다.

### 2. 배정 만료 정비(C2-11)

정비 일 두 개를 identity-svc `maintenance-tasks.ts`에 더한다. 둘 다 하루 한 번(`daily`), 멱등, 돌려준 값은 `{ invitations, assignments }`다(플랫폼 정비 실행기가 지표로 센다).

| 정비 일 | 바꾸는 행 | 결과 |
| --- | --- | --- |
| `staff-assignment-expired` | `INVITED`이면서 `invite_expires_at <= now` **또는** `valid_until < now` | `EXPIRED`, `invite_email`·`invite_token_hash` NULL |
| 같은 일 | `ASSIGNED`이면서 `valid_until < now` | `ENDED`, `invite_email`·`invite_token_hash` NULL(옛 데이터의 잔여 파기 백스톱) |
| `staff-promoter-missing` | `promoter_id`가 NULL인 `INVITED` | `EXPIRED`, 이메일·토큰 NULL |
| 같은 일 | `promoter_id`가 NULL인 `ASSIGNED` | `ENDED`, 이메일·토큰 NULL |

- **경계**: `invite_expires_at == now`는 만료다(`<=`). `valid_until == now`는 아직 유효다(`<`만 끝냄). `hasAssigned`의 `valid_until >= now`와 같은 쪽으로 맞춘다.
- **초대의 역할 유효 끝**: 초대를 회차 끝 30분 전에 만들면 `valid_until`이 24시간보다 먼저 지난다. 그런 `INVITED`는 수락해도 쓸 수 없고 개인정보만 남으므로 정비가 `valid_until`도 함께 본다. 조회·수락도 `valid_until < now`면 410이다.
- **정비 전 창**: 정비는 하루 한 번이라 만료 뒤 최대 하루는 `INVITED`로 남을 수 있다. 그동안 조회·수락은 410이고 재발송은 새 24시간을 준다(기존 I-T21 ⑩). 정비가 `EXPIRED`로 끝내 이메일을 파기한 뒤에는 재발송이 409 `staff-invitation-already-accepted`이고, 파트너는 같은 이메일로 **새 초대**를 만든다. 이 차이를 정본에 적는다(화면 SCR-037은 GAT-360).
- **인덱스**: 마이그레이션 `0037_staff_assignment_expiry.sql`에 부분 인덱스 둘을 더한다. `staff_assignment_invite_expiry_idx (invite_expires_at) WHERE status='INVITED'`, `staff_assignment_assigned_valid_until_idx (valid_until) WHERE status='ASSIGNED'`. `_journal.json`에 idx 37을 더한다.
- **세션**: `scanner_session.expires_at`이 곧 배정의 `valid_until`이고 `CheckScannerSession`이 시간을 보므로 정비가 세션을 따로 끝내지 않는다(C2 보고서의 '선택'). 이미 끝난 세션을 다시 쓰지 않는다.

### 3. 시간 필터와 표시(C2-11)

| 곳 | 지금 | 바꿀 것 |
| --- | --- | --- |
| `hasAssigned(accountId)` | `status='ASSIGNED'`만 본다 | `hasAssigned(accountId, nowMs)`: `status='ASSIGNED' AND valid_from <= now AND valid_until >= now`. data.md의 OnDuty 식과 같다 |
| `listSelf` | 상태를 그대로 준다 | `nowMs`를 받아 `ASSIGNED`이면서 `valid_until < now`인 행을 **읽을 때** `ENDED`로 바꿔 준다 |
| 파트너 명단 `listByEvent` | 상태를 그대로 준다 | 같은 식으로 `ENDED`를 보인다(정비 전 최대 하루의 표시 차이를 없앤다) |
| 초대 조회·수락 | 토큰 만료만 본다 | `valid_until < now`도 410 `INVITATION_INVALID`로 닫는다 |

- `hasStaffAssignment`는 openapi 설명이 "지금 ASSIGNED인 배정"이므로 미래 배정은 세지 않는다. 시작 전 배정은 `listSelf`에는 보인다(상태 `ASSIGNED`).
- REVOKED·EXPIRED는 `listSelf`에 넣지 않는다(기존). REVOKED는 명단에는 보인다(기존).

### 4. C2-10 `promoter_id` 정본화

identity-svc는 회차 판매자를 자기 DB에 갖지 않는다(ADR-0007, core 데이터). 그래서 0032 이전에 만들어진 `promoter_id IS NULL` 행은 **백필할 수 없다**. 대신 두 가지로 닫는다.

1. **새 행은 반드시 채운다**: `NewStaffInvitationRow.promoterId`는 이미 필수이고 BAT-450B의 초대 만들기가 core 판매 설정의 `promoterId`를 넣는다(I-T21 ③, I-T86 ③). 이 묶음은 그 사실을 정본에 못박고 시험으로 다시 확인하지 않는다(이미 자동 시험).
2. **옛 행은 정본화해 끝낸다**: 정비 `staff-promoter-missing`이 NULL인 `INVITED`를 `EXPIRED`(이메일·토큰 파기), NULL인 `ASSIGNED`를 `ENDED`로 끝낸다. 기기 승인은 이미 `promoterId`가 없는 배정을 `OTHER_PARTNER_DEVICE`로 보므로(device-approvals 76~81행) 살아 있는 NULL 배정은 원인 모를 403만 만든다. 끝내는 편이 정직하고 개인정보도 줄인다.
3. **정본**: `docs/data.md` `staff_assignment.promoter_id` 설명과 422행 아래에 "백필하지 않는다, NULL 행은 정비가 끝낸다, 새 초대는 core 판매자가 채운다"를 적는다. `docs/features/identity.md` §6.1 BAT-450C 문단에도 같은 문장을 둔다.

### 5. ASVS 재판정(GAT-210이 닿는 행)

`offline-gate.md`에는 `GAT-210`이라는 글자가 따로 없고, GAT-210이 닿는 ASVS 행이 6.5.x·8.2.x·14.x·16.x에 흩어져 있다(BAT-450B 계획 §6과 같은 범위). 이 묶음은 그 행의 **적용 여부·구현 위치·미적용 사유**를 실제 코드·시험에 맞춰 다시 쓰고, 새 시험에 `[ASVS v5.0.0-x.y.z]` 태그를 단다. `테스트 결과` 칸은 자동 리포트 몫이라 손으로 고치지 않는다.

| ASVS | 이 묶음의 판정 |
| --- | --- |
| 6.5.1 | 적용 유지. 초대 토큰은 수락 1회, 재발송은 옛 토큰을 410으로, 정비는 만료 초대를 쓸 수 없게 끝낸다 |
| 6.5.3 | 적용 유지. 32바이트 CSPRNG |
| 6.5.5 | 적용 유지. 24시간, 만료 정비의 경계를 시험한다 |
| 8.2.1 | 적용 유지. 파트너 네 작업의 역할 제한은 BAT-450B 그대로 |
| 8.2.2 | 적용 유지. `promoter_id` 없는 배정을 끝내 기기 승인의 파트너 대조가 살아 있게 한다 |
| 14.2.1 | 적용 유지. 링크 조각에만 토큰 |
| 14.2.4 | 적용 유지. **만료 때 파기**를 이제 정비가 실제로 한다 |
| 14.3.2 | 적용 유지. `no-store` |
| 16.2.5 | 적용 유지. 로그·응답에 토큰 원문 없음 |
| 16.3.1 | **부분 적용으로 내림**. 초대 수락·기기 승인은 요청 로그에 남지만, 초대 만들기·재발송·해제의 행위자·사유를 담은 불변 감사 기록은 BAT-450D 몫이다 |
| 16.3.2 | 적용 유지. 403·404 실패 인가 시도를 요청 로그로 남긴다 |

### 6. 시험 계획(시험 담당이 구현 전 트리에서 실패를 본다)

| ID | 시험(새 이름) | 잡는 것 |
| --- | --- | --- |
| I-T21 ⑫ | identity `I-T21 ⑫` 네이버만 연결한 계정(검증 이메일 없음)은 403, 검증된 같은 이메일 계정은 수락 | 검증 이메일 조건의 빈칸(구현 전에도 통과하는 성질 시험) |
| I-T87 ① | identity `I-T87 ①` 24시간 만료 `INVITED`를 `EXPIRED`로 끝내고 이메일·토큰을 파기한다. 발급→만료→정비→재사용 불가를 한 흐름으로 보고, 경계(정각/1ms 전)와 멱등을 본다 `[ASVS v5.0.0-6.5.5]` `[ASVS v5.0.0-14.2.4]` | 만료 정비·PII 파기 |
| I-T87 ② | identity `I-T87 ②` `valid_until`이 지난 `ASSIGNED`를 `ENDED`로 끝내고 이메일·토큰을 파기한다. 정각은 그대로, 1ms 뒤는 끝나며 두 번 돌려도 0건 | 종료 정비·경계·멱등 |
| I-T87 ③ | identity `I-T87 ③` `hasAssigned`는 지금 창 안의 `ASSIGNED`만 센다(미래·지난·REVOKED false, 시작·끝 정각 true) `[ASVS v5.0.0-6.5.1]` | 시간 필터 |
| I-T87 ④ | identity `I-T87 ④` `listSelf`·파트너 명단은 정비 전에도 지난 `ASSIGNED`를 `ENDED`로 보이고, 역할 유효 끝이 지난 `INVITED` 조회·수락은 410이다 | 표시·수락 창 |
| I-T88 ① | identity `I-T88 ①` `promoter_id`가 없는 `INVITED`는 `EXPIRED`(이메일·토큰 파기), 없는 `ASSIGNED`는 `ENDED`로 끝내고 promoter가 있는 행은 그대로 둔다. 다시 돌리면 0건 | C2-10 정본화 |
| — | identity `test-int` 같은 이름의 ①~④·①(실제 PostgreSQL·0037 인덱스·동시성 없음) | 저장소 두 곳의 같은 규칙 |

- 단위 시험은 `test/staff-assignment-maintenance.test.ts`(새 파일)와 `test/staff-invitations.test.ts`(I-T21 ⑫)다. 메모리 저장소와 `fakeClock`으로 돈다.
- 통합 시험은 `test-int/staff-invitations.int.test.ts`에 describe 하나를 더한다. 실제 PostgreSQL에서 마이그레이션 0037과 정비 SQL·읽기 필터를 본다(Docker 잠금).
- `test-int/withdrawal.int.test.ts`의 정비 일 이름 목록에 두 이름을 더한다(조립 확인).
- ASVS 태그 시험은 `asvs-report --scan services`로 모양을 본다(리포트가 없어 `테스트 결과`는 `미실행` 그대로).

### 7. 정본·파일

- `docs/data.md`: `staff_assignment` 블록의 `promoter_id`·`invite_email`·`status` 설명, 422행 아래 '만료 정비·`promoter_id` 정본화' 문단.
- `docs/features/identity.md`: §6.1 BAT-450C 문단, §12 I-T21 ⑫·I-T87·I-T88 행.
- `docs/security/asvs/offline-gate.md`: 위 §5의 행.
- `docs/BUILD_ORDER.md`: BAT-450C 행(계획 커밋), GAT-210 단계 줄(기록 커밋, 수용 기준을 모두 채웠을 때만).
- `docs/wbs/wbs.md`·`wbs.csv`: 5.5.1 상태는 `records.mjs`가 BUILD_ORDER 단계 줄을 보고 올린다(손으로 고치지 않는다).
- `docs/lanes/lane3.md`·`docs/PROGRESS.md`·`docs/00-summary.md`·`docs/review/consistency-review.md`: 기록 단계에서 `records.mjs`와 R-762.
- 제품: `services/identity-svc/src/modules/session/domain/staff.ts`, `domain/ports.ts`, `adapters/memory-staff-assignment-store.ts`, `adapters/db/drizzle-staff-assignment-store.ts`, `application/staff-invitations.ts`, `application/partner-staff-invitations.ts`, `application/get-account-summary.ts`, `maintenance-tasks.ts`, `migrations/0037_staff_assignment_expiry.sql`, `migrations/meta/_journal.json`.

### 8. 게이트

```bash
pnpm --filter @peaket/identity-svc typecheck
pnpm --filter @peaket/identity-svc test
pnpm --filter @peaket/identity-svc test:integration test-int/staff-invitations.int.test.ts
pnpm lint
python -I -X utf8 tools/doc-check/check_all.py
node tools/ci/trace-check.mjs --ids "I-T21,I-T87,I-T88" --report <vitest JSON>
node tools/ci/ledger.mjs --batch BAT-450C --require
node tools/ci/roles-check.mjs --base origin/develop --head HEAD
node tools/ci/records.mjs --check
```

- Docker 시험은 Git Bash `bash /d/ticketpass-locks/lock.sh take docker lane3-BAT-450C`로 잠그고, 끝나면 `drop`한 뒤 `docker ps`에 peaket 컨테이너 0을 확인한다.
- 틀린 구현 표본은 최소 6개를 넣고 관련 시험만 돌린 뒤 `git checkout -- <파일>`로 되돌린다(제품 파일 차이 0).

### 9. 자주 놓친 결함을 이 묶음에 대 본 것

| 항목 | 이 묶음 |
| --- | --- |
| 값 단언(모양만 아님) | 상태·`invite_email`·`invite_token_hash`·정비 건수를 값으로 본다 |
| 경계값 양쪽 | 초대 만료 정각/1ms 전, `valid_until` 정각/1ms 뒤, `valid_from` 정각/1ms 전, `hasAssigned` 미래/현재/과거 |
| 지우거나 옮기는 연산은 키를 모두 확인 | 만료·종료·정본화마다 이메일·토큰 해시 NULL, 멱등 두 번째 0건 |
| 판정 함수만 말고 부르는 쪽 | `GetAccountSummary`가 `clock.now()`를 넘기는지, 정비 일 조립 목록, 파트너 명단 HTTP |
| 같은 규칙 두 곳 | 메모리·Drizzle 저장소, 읽기 필터와 정비, 단위·test-int |
| 시험 값이 상수와 같으면 숨음 | 계정·회차·토큰은 코드 상수와 다른 고정 값 |
| 장애 주입이 끝까지 닿는가 | 정비 SQL 실패는 다음 날 다시 잡는다(부분 실패를 숨기지 않는다) |
| 시간 한도 | 24시간, 역할 유효 끝, 하루 한 번 정비의 최대 하루 창 |
| 시작 파일 조립 | `maintenance-tasks.ts`에 두 일이 들어가는지 test-int 목록 시험 |

## 실패 확인

시험 담당 `lane3-bat450c-test`(deepseek-v4.1-flash), 2026-11-22 13:57~14:04 KST. 기준 트리 `bd34095bf`(계획 커밋)에서 구현 없이 시험만 더해 돌렸다. Docker 잠금 `lane3-BAT-450C`를 잡고(14:03) 실제 PostgreSQL 통합 시험까지 돌린 뒤 놓았다.

### 단위·통합(구현 전)

| 파일 | 결과 | 실패한 시험(까닭) |
| --- | --- | --- |
| `services/identity-svc/test/staff-assignment-maintenance.test.ts` | **7개 중 7 실패** | I-T87 ①~④·I-T88 ①이 `store.expireDueAssignments is not a function`·`store.closeLegacyAssignments is not a function`으로 실패했다. I-T87 ③은 지금 구현이 시간 창을 보지 않아 미래·취소 배정을 true로 셌고, I-T87 ④는 지난 `ASSIGNED`를 `ASSIGNED`로 보였다. 정비 일 목록 시험은 `staff-assignment-expired`가 없어 실패했다 |
| `services/identity-svc/test/staff-invitations.test.ts` | **8개 중 8 통과** | I-T21 ⑫(네이버만 연결한 계정 403)는 기존 구현이 이미 지키는 성질이라 구현 전에도 통과한다(성질 시험). `hasAssigned`·`listSelf` 호출에 `nowMs`를 넘기도록 맞췄다 |
| `services/identity-svc/test/check-scanner-session.test.ts` | **통과** | 기존 `BOT047_hasStaffAssignment` 시험이 시간 창이 없는 시드로 true를 기대해, 시드에 `validFrom`·`validUntil`을 넣었다(새 계약의 시간 필터를 시험이 실제로 본다) |
| `services/identity-svc/test-int/staff-assignment-maintenance.int.test.ts` | **5개 중 5 실패** | `expireDueAssignments`·`closeLegacyAssignments`가 없어 TypeError, `hasAssigned`는 미래 배정을 true로 셈, `listSelf`는 지난 `ASSIGNED`를 그대로 보였다. 0037 인덱스도 아직 없다 |
| `services/identity-svc/test-int/withdrawal.int.test.ts` | **실행하지 않음** | 정비 일 목록 기대값에 두 이름을 더했다. 구현 전에는 목록에 없어 실패할 것이고, 구현 뒤 같은 시험으로 다시 확인한다(검증 단계) |

### 판정

- 새 동작(만료 정비·promoter 정리·시간 필터·읽기 표시·유효 끝 지난 초대 410)은 구현 전 트리에서 **모듈 없음(TypeError)·값 불일치**로 실패했다. 시험이 구현을 요구하는 방향으로 먼저 섰다.
- I-T21 ⑫는 기존 구현의 성질을 이름 붙인 시험이라 구현 전에도 통과한다. 이 묶음의 목적은 "24시간 발급·네이버만 연결" 가운데 시험 이름이 없던 빈칸을 채우는 것이다.
- 통합 시험은 실제 PostgreSQL에서 돌려 실패를 봤고, 끝나고 `docker ps`에 peaket 컨테이너가 없음을 확인했다.

## 리뷰

리뷰 담당 `lane3-bat450c-review`(deepseek-v4.1-flash), 2026-11-22 14:30~14:38 KST. 받은 것은 `git diff origin/develop..a52b52945`(계획·시험·구현)와 이 계획 파일이다. 코드·시험·계약·정본·마이그레이션을 대조했고, 시험·Docker는 돌리지 않았다. 코드는 고치지 않았다.

결과: **중간 1(고침), 낮음 1(고침), 낮음 6(남은 위험)**. 시간 경계·테넌트·토큰 비노출의 방향은 맞다.

| 번호 | 심각도 | 위치 | 근거 | 고칠 방향 |
| --- | --- | --- | --- | --- |
| RV-01 | 중간 | `drizzle-staff-assignment-store.ts` `expireDueAssignments`, `memory-staff-assignment-store.ts` 같은 메서드 | 정비는 이번에 상태를 바꾸는 `INVITED`·`ASSIGNED` 행의 이메일·토큰만 지운다. 이미 `REVOKED`·`ENDED`·`EXPIRED`인 행에 옛 경로·시드·수동 입력이 남긴 `invite_email`·`invite_token_hash`가 있으면 영원히 남는다. data-classification 88은 수락·만료 시 즉시 파기라고 정한다 | `staff-assignment-expired`가 종료 상태의 잔여 초대 이메일·토큰도 한 번에 지우게 한다(건수에는 세지 않는다). 단위·통합 시험에 종료 행의 잔여 값 파기를 더한다 |
| RV-02 | 낮음 | `partner-staff-invitations.ts` `reissue` | 역할 유효 끝(`valid_until`)이 지난 `INVITED`는 조회·수락이 410인데 재발송은 새 24시간 링크를 보낸다. 정비 전 최대 하루 동안 파트너가 받는 사람에게 죽은 링크를 보낸다 | 재발송도 `valid_until < now`면 409 `staff-invitation-already-accepted`로 닫는다. 시험을 더한다 |
| RV-03 | 낮음(남은 위험) | `scanner_session` | 배정이 `ENDED`가 되어도 그 배정의 세션 행 `terminated_at`은 비어 있다. `CheckScannerSession`이 시간으로 거부하고 새 승인이 이전 세션을 끝내므로 보안 영향은 없다. 다만 "살아 있는 세션" 수가 실제와 다르다 | 후속 정비(만료 세션의 `terminated_at` 채우기)로 둔다. 이 묶음은 배정 상태에 집중한다 |
| RV-04 | 낮음(남은 위험) | `offline-gate.md` 16.3.1 | 초대 만들기·재발송·해제의 행위자·사유를 담은 불변 감사 기록이 없다. 이 묶음은 `부분 적용`으로 내리고 까닭을 BAT-450D로 적었다 | BAT-450D에서 감사 표 또는 ops 감사 접수로 붙인다. GAT-210 단계 줄은 "ASVS 판정 갱신"이 수용 기준이라 이 공백을 이유로 막지 않는다 |
| RV-05 | 낮음(남은 위험) | 운영 수락 | 본인확인기관 계약 전이라 운영에서 초대 수락이 403/503으로 막힌다. GAT-210의 코드·시험 수용 기준은 개발·시험 기록으로 충족한다 | GAT-250/외부 계약 뒤 운영 확인. BUILD_ORDER GAT-210 줄에 이미 적힌 한계다 |
| RV-06 | 낮음(남은 위험) | 0037 인덱스 | `staff_assignment_invite_expiry_idx`는 `invite_expires_at`만 덮어 `valid_until < now`인 INVITED 분기는 인덱스를 타지 않는다. INVITED 행 수가 적어 지금은 문제가 아니다 | 행이 많아지면 `(valid_until) WHERE status='INVITED'`를 더한다 |
| RV-07 | 낮음(남은 위험) | `listByEvent` 읽기 표시 | 정비 전에는 DB 상태가 `ASSIGNED`인데 명단은 `ENDED`로 보인다. 그 행을 해제하면 `revokeAssignment`가 `ASSIGNED`를 보고 `REVOKED`로 바꾼다(204). 표시와 저장 상태가 하루 동안 다를 수 있다 | 정비를 하루 한 번보다 자주 돌리거나, 해제가 읽기 표시를 따르게 하는 후속. 지금은 파트너 화면이 GAT-360이라 영향이 작다 |
| RV-08 | 낮음 | 이 계획 파일 담당 표 | 계획 때 적은 시작·끝 시각은 예상값이다. 실제 역할 시각으로 기록 단계에서 고친다 | 기록 담당이 실제 시각으로 맞춘다 |

- **RV-01·RV-02 고침 순서**: 리뷰 반영도 시험 먼저다. `Fix-By: test` 커밋이 종료 행 잔여 파기와 역할 유효 끝 지난 재발송 409를 시험에 더하고, `Fix-By: impl` 커밋이 저장소 두 곳과 재발송을 고친다.
- **RV-01·RV-02 고침(2026-11-22, review-fix)**: `staff-assignment-expired`가 종료 상태(`REVOKED`·`ENDED`·`EXPIRED`)의 잔여 `invite_email`·`invite_token_hash`도 지운다(메모리·Drizzle 두 저장소, 건수에는 세지 않는다). 재발송은 `valid_until < now`면 409 `staff-invitation-already-accepted`이고 메일을 보내지 않는다. 고친 뒤 단위 28·통합 5가 통과했고, 전체 게이트는 검증 단계에서 다시 본다.

### 확인한 것(지적 아님)

- **시간 경계**: `invite_expires_at <= now`(만료), `valid_until < now`(종료·거부), `hasAssigned`는 `valid_from <= now <= valid_until`이다. 정비와 읽기 필터와 수락 거부가 같은 쪽을 본다. `valid_until` 정각은 아직 유효하고 1ms 뒤에 끝난다.
- **개인정보 파기**: 만료·종료·정본화가 상태를 바꾸는 행의 `invite_email`·`invite_token_hash`를 NULL로 만든다. 정비는 토큰·이메일 원문을 로그에 남기지 않고 건수만 돌려준다. RV-01 고침으로 이미 끝난 행의 잔여 값도 지운다.
- **권한·테넌트**: 파트너 네 작업의 `RolesGuard`·`tenantId`·core 판매자 대조는 바뀌지 않았다. 정비는 전역 일이고 테넌트 입력을 받지 않는다. `listByEvent`의 `nowMs`는 표시만 바꾸고 필터·정렬·커서를 바꾸지 않는다.
- **멱등**: 두 정비 모두 `WHERE status=...`로 한 번만 상태를 바꾸고, 두 번째 실행은 0건이다. 메모리·Drizzle 저장소가 같은 규칙을 쓴다.
- **읽기 필터**: `hasAssigned`가 `valid_from`·`valid_until`을 모두 보고, `listSelf`·`listByEvent`는 `ENDED`를 읽을 때 만든다. `EXPIRED`는 `listSelf`에 넣지 않고 `REVOKED`는 기존대로 보인다.
- **계약·정본**: BUILD_ORDER BAT-450C 장부 범위가 `I-T21, I-T87, I-T88`이고, identity.md I-T87·I-T88 행이 4칸 표 모양을 지킨다. data.md `staff_assignment`의 `promoter_id`·`status` 설명과 422행 아래 문단이 코드와 같다.
- **ASVS**: 6.5.1·6.5.3·6.5.5·8.2.1·8.2.2·14.2.1·14.2.4·14.3.2·16.2.5·16.3.2는 `적용`, 16.3.1은 `부분 적용`(BAT-450D)이다. 새 시험 태그는 6.5.5·14.2.4·8.2.2에만 달았다(시간 필터에는 맞는 행이 없다).
- **마이그레이션**: 0037은 부분 인덱스 둘만 만들고 데이터를 바꾸지 않는다. `_journal.json` idx 37이 0036 뒤에 있다. 정비 SQL은 상태·시각 조건으로만 쓰고 값을 문자열로 붙이지 않는다.

## 검증

(검증 담당이 채운다)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane3-bat450c-plan | deepseek-v4.1-flash | 2026-11-22T13:45:00+09:00 | 2026-11-22T14:05:00+09:00 |
| test | lane3-bat450c-test | deepseek-v4.1-flash | 2026-11-22T14:06:00+09:00 | 2026-11-22T14:25:00+09:00 |
| impl | lane3-bat450c-impl | deepseek-v4.1-flash | 2026-11-22T14:26:00+09:00 | 2026-11-22T14:50:00+09:00 |
| review | lane3-bat450c-review | deepseek-v4.1-flash | 2026-11-22T14:30:00+09:00 | 2026-11-22T14:38:00+09:00 |
| verify | lane3-bat450c-verify | deepseek-v4.1-flash | 2026-11-22T15:06:00+09:00 | 2026-11-22T15:30:00+09:00 |
