# 작업 계획: W12-ops-command-tests — BAT-620 정책에 시험 기대를 맞춘다

- **무엇**: `develop` `cdcfc748f`에서 `pnpm.cmd --filter @peaket/ops-svc test test/command-role-policy.test.ts test/command-lifecycle-http.test.ts`가 **4건 실패**한다. BAT-620(R-763)이 정본대로 판매 중지(`SALE_STOP`)·판매 재개(`SALE_RESUME`)를 **operator 이상 요청, 요청자 아닌 commander 승인**으로 바꿨는데, 두 시험 파일이 옛 정책(commander 전용 요청)을 그대로 기대한다. 제품 코드는 BAT-620이 맞다. 시험 기대만 새 정책에 맞춘다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane2-sr13`, 가지 `feature/lane3-W12-ops-command-tests`, 출발점 `origin/develop` `cdcfc748f`(R-768).
- **등급·차례**: B, 시험만 묶음(`Batch-Kind: test-only`, `docs/architecture.md` §8.6 4): 계획 → 시험 → 리뷰 → 검증 → 기록. 구현 커밋이 없다. 제품 코드(`services/ops-svc/src/`)·계약은 고치지 않는다.
- **정본**: `docs/planning/03-policies-glossary.md` POL-038 ⑩(승인한 공연의 판매 중지는 operator 이상이 사유 코드·사유를 적어 요청하고 요청자가 아닌 commander가 승인한다. 판매 재개도 같다), `docs/adr/0123-sale-review-suspended-takedown-resume-or-cancel.md` 결정 2(operator 이상 요청 + 요청자 아닌 commander 승인), `docs/features/control-tower.md` §3(명령 3과 판매 중지·재개의 역할 구분: 명령 3은 commander 1인, 판매 중지·재개는 2인 승인)·§4(T4·T6·T7), `docs/security/authz-matrix.md` §3. 제품 정책 표는 `services/ops-svc/src/modules/commands/domain/command.ts:152~153`(`SALE_STOP`·`SALE_RESUME`: requesterRoles `operator`·`commander`, approverRoles `commander`)이다.

## 실패 확인

시험 담당 `w12oct-test`(deepseek-v4.1-flash), 2026-11-22 18:29 KST. 기준 트리 `cdcfc748f`(출발점, 구현·시험 고침 없음)에서 돌렸다.

| 검사 | 결과 | 까닭 |
| --- | --- | --- |
| `pnpm.cmd --filter @peaket/ops-svc test test/command-role-policy.test.ts test/command-lifecycle-http.test.ts` | 2파일 **4 실패 / 26 통과**(30건) | 아래 네 건. 두 파일 모두 새 정책과 옛 기대가 어긋난다 |
| `command-role-policy.test.ts:66` | 실패 | `COMMANDER_ONLY`가 6개(`AUTOMATION_STOP`·`BOT_LEVEL`·`DEGRADED_MODE`·`KILL_SWITCH`·`SALE_RESUME`·`SALE_STOP`)를 기대하지만 제품은 4개다(`SALE_RESUME`·`SALE_STOP` 빠짐) |
| `command-role-policy.test.ts:74` | 실패 | `SALE_RESUME`를 operator 역할로 요청하면 403 `command-role-forbidden`을 기대했지만, 지금은 201에 해당하는 `PENDING_APPROVAL` 명령이 만들어졌다 |
| `command-role-policy.test.ts:98` | 실패 | 정책 이전 행(operator가 요청한 `SALE_STOP`)을 commander가 승인하면 403을 기대했지만, 지금은 `APPROVED`가 됐다 |
| `command-lifecycle-http.test.ts:578` | 실패 | 내부 사건 길의 operator `SALE_STOP` 요청이 `{ accepted: false }`를 기대했지만, 지금은 `{ accepted: true, commandId }`다 |

- 실패는 구현을 요구하는 방향이 아니라 **시험 기대가 낡은** 방향이다. 제품 코드의 정책 표·BAT-620 리뷰 RV-01이 정본과 같고, 두 시험만 BAT-620 이전 판을 그대로 쓴다.

## 계획

### 1. 바꿀 시험과 기대값

| # | 파일·시험 | 지금 | 바꿀 기대 |
| --- | --- | --- | --- |
| 1 | `command-role-policy.test.ts` `COMMANDER_ONLY` | 6개(판매 중지·재개 포함) | 4개(`AUTOMATION_STOP`·`BOT_LEVEL`·`DEGRADED_MODE`·`KILL_SWITCH`). `SALE_STOP`·`SALE_RESUME`는 요청 역할 `operator`·`commander`, 승인 역할 `commander`임을 따로 단언한다 |
| 2 | `command-role-policy.test.ts` operator 요청 시험 | commander 전용 유형의 operator 요청은 모두 403 | commander 전용 4개만 403. `SALE_STOP`·`SALE_RESUME`의 operator 요청은 `PENDING_APPROVAL`·`requestedRole: 'operator'`이고 감사 기록이 남는다 |
| 3 | `command-role-policy.test.ts` 정책 이전 행 시험 | operator가 요청한 `SALE_STOP` 행을 commander가 승인·반려하면 403 | 레거시 행 유형을 `BOT_LEVEL`(operator가 요청할 수 없는 2인 명령)로 바꿔 저장소 층의 역할 거절을 그대로 본다. 판매 중지·재개는 이제 정상 요청이므로 이 시험의 소재가 아니다 |
| 4 | `command-role-policy.test.ts` operator 승인 시험 | commander가 만든 `SALE_STOP`을 operator가 승인·반려하면 403, commander는 승인 가능 | 그대로 유지하고, operator가 요청한 `SALE_STOP`의 자기 승인(operator 역할) 403·요청자 본인이 commander 역할로 승인해도 403 `command-requester-cannot-approve`를 더한다. 다른 commander의 승인·반려도 함께 본다 |
| 5 | `command-lifecycle-http.test.ts` 내부 사건 길 시험 | operator `SALE_STOP` 요청을 `{ accepted: false }`로 기대 | 목록에서 `SALE_STOP`을 빼고 `BOT_LEVEL`(commander 전용 요청)을 넣는다. `SALE_STOP` operator 요청은 `{ accepted: true, commandId }`·`PENDING_APPROVAL`·`requestedRole: 'operator'`로 단언한다. 이 명령은 승인 전이라 실행은 0건이다 |
| 6 | `command-lifecycle-http.test.ts` 내부 사건 길 시험(이어서) | 없음 | 위 `SALE_STOP`을 operator 본인이 승인하면 403 `command-role-forbidden`, 다른 commander가 토큰 없이 승인하면 403 `reauth-required`, 토큰을 달면 200 `SUCCEEDED`다. `SALE_RESUME`도 operator 요청 → operator 반려 403 → commander 반려 200 `REJECTED`를 본다 |
| 7 | `command-lifecycle-http.test.ts` C-T5 재인증 시험 | 킬스위치만 접수 재인증을 본다 | 판매 중지·재개도 2인 명령이라 접수에 재인증이 필요함을 더한다. 토큰 없이 operator 요청은 403 `reauth-required`, 토큰을 달면 201 `PENDING_APPROVAL`이다 |

- 시험 파일 수는 그대로 두고 기존 시험 안에 단언을 더한다(두 파일 30건 유지). 새 시험 파일·새 시험 묶음은 만들지 않는다.
- 제품 동작을 시험에 맞추려고 바꾸지 않는다. `docs/features/control-tower.md` §3의 명령 3(commander 1인)과 판매 중지·재개(2인 승인) 구분은 그대로다.

### 2. 지키는 것

- **거절 경로**: commander 전용 4개 유형의 operator 요청 403, viewer 요청 403, operator의 승인·반려 403, 요청자 본인 승인 403 `command-requester-cannot-approve`, 재인증 없는 위험 명령 접수·승인 403 `reauth-required`.
- **요청자≠승인자**: 판매 중지·재개는 요청자가 operator든 commander든 다른 commander만 승인한다. 같은 사람이 두 번 승인하는 경로(409)와 `command_actor` 회차별 유일 제약 시험은 다른 파일이 이미 본다.
- **시험 이름·주석**: 바뀐 정책의 근거(POL-038 ⑩, ADR-0123 결정 2, `command.ts` 정책 표)을 시험 이름이나 첫 주석에 남긴다.
- **제품 무변경**: `git diff --name-only`에 `services/ops-svc/src/`·계약·마이그레이션이 없어야 한다. 시험만 바꾼다.

### 3. 손댈 파일

- 시험: `services/ops-svc/test/command-role-policy.test.ts`, `services/ops-svc/test/command-lifecycle-http.test.ts`.
- 계획·기록: 이 파일, `docs/review/consistency-review.md`·`docs/00-summary.md`(기록 R-770).
- 제품 코드·계약·마이그레이션: 바꾸지 않는다.

### 4. 게이트

| 검사 | 기대 |
| --- | --- |
| `pnpm.cmd --filter @peaket/ops-svc test test/command-role-policy.test.ts test/command-lifecycle-http.test.ts` | 두 파일 **30/30** |
| `pnpm.cmd --filter @peaket/ops-svc test` | 가능하면 전체 통과(같은 PC 다른 갈래의 흔들림은 따로 적는다) |
| `pnpm.cmd --filter @peaket/ops-svc typecheck` | 오류 0 |
| `pnpm.cmd lint` | 오류 0 |
| `python -I -X utf8 tools/doc-check/check_all.py` | 오류 0(경고는 기존 것) |
| `node tools/ci/roles-check.mjs --base origin/develop --head HEAD` | 통과(plan → test → review → verify, 담당 표) |
| `node tools/ci/records.mjs --check` | 통과(경고는 기존 것) |

### 5. 틀린 구현 표본(검증 담당용)

| # | 틀린 구현 | 잡을 시험 |
| --- | --- | --- |
| S1 | `command.ts`의 `SALE_STOP`·`SALE_RESUME` requesterRoles를 `COMMANDER_ONLY`로 되돌린다(BAT-620 이전) | `command-role-policy`의 operator 요청 시험·정책 표 시험, `command-lifecycle-http`의 내부 사건 길 판매 중지 요청 시험 |
| S2 | `command.ts`의 `SALE_STOP`·`SALE_RESUME` approverRoles를 `ALL_ROLES`로 넓힌다(요청자 아닌 operator도 승인) | `command-role-policy`의 operator 승인 시험·정책 표 시험, `command-lifecycle-http`의 operator 승인 403 시험 |

- 표본은 제품 파일을 잠깐 고쳤다가 `git checkout -- <파일>`로 되돌린다. 표본 때문에 생긴 제품 파일 차이가 남지 않게 한다.

### 6. 범위 밖

- BAT-620의 core-svc 판매 승인 상태·검색 동기화·CDN·집행 연결은 이미 구현·검증됐다(R-763, `docs/review/plans/BAT-620.md` §7~10). 이 묶음은 ops-svc 역할 시험 두 파일만 고친다.
- 다른 ops-svc 시험(`commands.test.ts`·`commands-http.test.ts`·`admin-command-reauth.test.ts` 등)은 BAT-620에서 이미 새 정책으로 고쳐졌다. 이 묶음은 손대지 않는다.
- 판매 중지·재개의 SCR-048 단추·정산 보류·재승인 때 중지 표시 해제는 BAT-620 리뷰 RV-02·RV-03의 남은 위험이다. 이 묶음 밖이다.
- BUILD_ORDER 단계·wbs 상태 변화는 없다. 기록만 R-770으로 남긴다.

## 리뷰

리뷰 담당 `w12oct-review`(deepseek-v4.1-flash), 2026-11-22 18:47~18:55 KST. 받은 것은 `git diff cdcfc748f..72d2d8e01`(계획·시험)와 이 계획 파일이다. 제품 코드·계약·마이그레이션과 정본을 대조했고, 두 시험 파일을 다시 돌려 **30/30**을 확인했다. 코드는 고치지 않았다.

결과: **막는 지적 0**, 낮음 2(남은 위험).

| 번호 | 심각도 | 위치 | 근거 | 고칠 방향 |
| --- | --- | --- | --- | --- |
| RV-01 | 낮음(남은 위험) | `services/ops-svc/test/command-role-policy.test.ts:57~78` | `BOT_LEVEL` 승인 역할은 정본(control-tower §3 5행)이 '요청자 아닌 operator 이상'인데 제품은 commander만이다. 시험은 `DEGRADED_MODE`만 빼고 '승인 역할 ⊆ 요청 역할' 부분집합 검사로 이 어긋남을 통과시킨다(기존 주석대로 BAT-365 몫). 이 묶음이 만든 것이 아니다 | BAT-365에서 `BOT_LEVEL` approverRoles를 operator·commander로 넓히고 이 시험의 예외도 정리한다 |
| RV-02 | 낮음(남은 위험) | `services/ops-svc/test/command-lifecycle-http.test.ts:630` | 반려(`rejections`)는 컨트롤러가 재인증을 보지 않아 commander가 토큰 없이 200으로 닫는다. 시험은 이 제품 동작을 그대로 단언한다. 정본 C-T5는 '접수·승인·재시도'에 재인증을 요구하고 반려는 적지 않아 지금은 어긋나지 않지만, 반려도 위험 명령을 닫는 조작이라 후속 정책에서 확인할 자리다 | 제품 정책이 반려에 재인증을 더하면 시험도 `withToken`을 요구하도록 함께 고친다 |

### 확인한 것(지적 아님)

- **정본**: POL-038 ⑩·ADR-0123 결정 2는 'operator 이상 요청 + 요청자 아닌 commander 승인'이고, 제품 `services/ops-svc/src/modules/commands/domain/command.ts:152~153`이 requesterRoles `operator`·`commander`, approverRoles `commander`로 같다. `approvalModeOf`가 둘 다 `TWO`라 접수·승인에 재인증이 붙는 것도 시험과 맞다.
- **거절 경로 유지**: commander 전용 4유형(`KILL_SWITCH`·`BOT_LEVEL`·`DEGRADED_MODE`·`AUTOMATION_STOP`)의 operator 요청 403, viewer 403, operator 승인·반려 403, 요청자 본인 승인 403 `command-requester-cannot-approve`, 저장소 레거시 행(`BOT_LEVEL` operator 요청) 403, 재시도 403이 모두 남아 있다. 두 파일에 `skip`·`only`·`todo` 0건이다.
- **판매 중지·재개 경로**: 단위 시험은 operator 요청 `PENDING_APPROVAL`, operator 승인 403(자기 요청 포함), 요청자 commander의 자기 승인 403, 다른 commander 승인 `APPROVED`, 다른 commander 반려 `REJECTED`를 본다. HTTP 시험은 토큰 없는 operator 접수 403 `reauth-required`, 토큰 있는 접수 201 `PENDING_APPROVAL`, operator 승인 403, commander 토큰 없는 승인 403 `reauth-required`, 토큰 있는 승인 200 `SUCCEEDED`, commander 반려 200 `REJECTED`를 본다.
- **제품 무변경**: `git diff --name-only cdcfc748f..HEAD`가 계획 파일과 시험 두 파일뿐이다. `services/ops-svc/src/`·계약·마이그레이션 변경 0.
- **실행**: 두 파일 **30/30**, `git diff --check` 공백 오류 0.

## 검증

검증 담당 `w12oct-verify`(deepseek-v4.1-flash), 2026-11-22 18:48~19:10 KST. 구현·시험·리뷰에 관여하지 않았다. 기준 HEAD는 리뷰 커밋 `8f42acfad`이고, 제품 파일은 건드리지 않았다(표본은 잠깐 넣었다가 `git checkout --`로 되돌림).

### 게이트

| 검사 | 결과 |
| --- | --- |
| `pnpm.cmd --filter @peaket/ops-svc test test/command-role-policy.test.ts test/command-lifecycle-http.test.ts` | **30/30 통과**(2파일) |
| `pnpm.cmd --filter @peaket/ops-svc test` | **74파일 518/518 통과**(73.37초) |
| `pnpm.cmd --filter @peaket/ops-svc typecheck` | 오류 0 |
| `pnpm.cmd lint` | 오류 0 |
| `python -I -X utf8 tools/doc-check/check_all.py` | **오류 0, 경고 4**(기존 openapi 3·mermaid 건너뜀 1) |
| `node tools/ci/records.mjs --check` | 기록 표가 맞다(경고는 R-374·R-608·R-763 등 기존 것) |
| `node tools/ci/roles-check.mjs --base origin/develop --head HEAD` | 리뷰 HEAD에서는 verify 커밋·`## 검증`이 없어 실패(예상). 검증 커밋 뒤 다시 본다 |

- `git status --short`에 제품 파일 차이가 없다. `git diff --name-only cdcfc748f..HEAD`는 계획·시험 두 파일뿐이다.
- 표본을 넣고 되돌린 뒤 `git diff --stat`가 비어 있음을 확인했다.

### 틀린 구현 표본

| # | 넣은 틀린 구현 | 잡은 검사(결과) |
| --- | --- | --- |
| S1 | `command.ts`의 `SALE_STOP`·`SALE_RESUME` requesterRoles를 `COMMANDER_ONLY`로 되돌린다(BAT-620 이전) | 두 파일 **5 실패 / 25 통과**: 정책 표(6≠4), operator 요청이 `PENDING_APPROVAL`이 아니라 403, C-T5 판매 중지 접수 재인증, 내부 사건 길의 operator 판매 중지 요청(거절) 등 |
| S2 | `command.ts`의 `SALE_STOP`·`SALE_RESUME` approverRoles를 `ALL_ROLES`로 넓힌다(operator 승인 허용) | 두 파일 **3 실패 / 27 통과**: 승인 역할 표(`['operator','commander']`≠`['commander']`), operator 승인이 403이 아니라 통과, HTTP operator 승인 403 시험 |

- 넣은 수 2, 잡힌 수 2, 놓친 수 0. 표본마다 제품 파일만 되돌렸고, 표본 때문에 남은 제품 파일 차이는 없다.
- roles-check·records --check는 검증 커밋을 만든 뒤 HEAD에서 다시 확인해 이 절과 기록에 덧붙인다.

### 남은 위험

- 리뷰 RV-01(`BOT_LEVEL` 승인 역할의 BAT-365 잔여)과 RV-02(반려의 재인증 미요구)가 그대로 남는다. 둘 다 이 묶음이 만든 것이 아니고 막지 않는다.
- 같은 PC에서 다른 갈래가 함께 돌아 vitest 워커 종료 시간 초과 경고가 섞일 수 있다. 이번 실행은 74파일 518/518로 끝났다.

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w12oct-plan | deepseek-v4.1-flash | 2026-11-22T18:28+09:00 | 2026-11-22T18:42+09:00 |
| test | w12oct-test | deepseek-v4.1-flash | 2026-11-22T18:30+09:00 | 2026-11-22T18:47+09:00 |
| review | w12oct-review | deepseek-v4.1-flash | 2026-11-22T18:47+09:00 | 2026-11-22T18:55+09:00 |
| verify | w12oct-verify | deepseek-v4.1-flash | 2026-11-22T18:55+09:00 | 2026-11-22T19:15+09:00 |
