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

(시험 담당이 채운다)

## 리뷰

(리뷰 담당이 채운다)

## 검증

(검증 담당이 채운다)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane3-bat450c-plan | deepseek-v4.1-flash | 2026-11-22T13:45:00+09:00 | 2026-11-22T14:05:00+09:00 |
| test | lane3-bat450c-test | deepseek-v4.1-flash | 2026-11-22T14:06:00+09:00 | 2026-11-22T14:25:00+09:00 |
| impl | lane3-bat450c-impl | deepseek-v4.1-flash | 2026-11-22T14:26:00+09:00 | 2026-11-22T14:50:00+09:00 |
| review | lane3-bat450c-review | deepseek-v4.1-flash | 2026-11-22T14:51:00+09:00 | 2026-11-22T15:05:00+09:00 |
| verify | lane3-bat450c-verify | deepseek-v4.1-flash | 2026-11-22T15:06:00+09:00 | 2026-11-22T15:30:00+09:00 |
