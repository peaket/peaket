# 작업 계획: W12-identity-problems — CI가 잡은 오류 유형 두 개를 바로잡는다

- **무엇**: `develop` `a4376818c`에서 공용 서버 패키지 시험 `PRF192_서비스 코드의 이름 붙은 오류는 모두 목록에 있고 상태 코드와 제목이 같다`가 identity-svc의 이름 붙은 오류 두 개 때문에 실패한다. 이 저장소의 CI는 `packages/platform`이 바뀌지 않으면 이 시험을 돌리지 않으므로, platform을 고치는 다른 묶음의 게이트에서 드러난 회귀다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane2-sr13`, 가지 `feature/lane3-W12-identity-problems`, 출발점 `origin/develop` `a4376818c`.
- **정본**: `docs/api/guidelines.md` §2 '`type`·상태 코드·`title`은 한 묶음이다'(한 오류 이름은 늘 같은 상태 코드와 제목), 오류 목록 `docs/api/openapi.yaml` 맨 위 `x-peaket-problem-types`, `docs/features/identity.md` §6.1 GAT-210 문단.
- **등급·차례**: C(문구·계약 정합), 시험 먼저(버그 재현 시험 먼저, `docs/architecture.md` §8.6 5), 짧은 고리.

## 계획

### 1. 틀린 곳 두 군데

`services/identity-svc/src/modules/session/inbound/partner-staff.controller.ts` 19·21행이 오류 목록과 어긋난다.

| 자리 | 지금 | 목록의 같은 이름 | 어긋난 점 |
| --- | --- | --- | --- |
| 19행 `NOT_FOUND` | 404 `not-found` 제목 `없는 회차이거나 이 파트너의 회차가 아닙니다` | `not-found` 404 `찾을 수 없습니다` | 같은 type에 다른 title. 게다가 이 문구는 회차 소유 확인에만 쓰는 구체 사유라 표준 제목 자리에 두면 다른 `not-found`와 뜻이 갈린다 |
| 21행 `MAIL_UNAVAILABLE` | 503 `provider-down` 제목 `지금은 초대 메일을 보낼 수 없습니다` | `provider-down` 503 `지금은 본인확인을 할 수 없습니다` | 본인확인 장애용 이름을 초대 메일 장애에 재사용해 같은 type에 다른 title. 뜻도 다르다 |

### 2. 바른 동작

1. **404는 표준 이름·표준 제목을 쓰고 사유는 `detail`로 내린다.** `not-found` 404 `찾을 수 없습니다`에 `detail: '없는 회차이거나 이 파트너의 회차가 아닙니다'`를 붙인다. `ProblemError`는 `detail`을 본문에 싣고(guidelines §2, `problem-filter.ts`), PRF192는 `detail`을 보지 않는다. 새 type을 만들지 않는다. 없는 회차·판매 승인 전 회차·다른 파트너 회차가 같은 본문이라는 기존 성질(정보 비노출)은 그대로다.
2. **초대 메일 실패는 새 이름 `staff-invite-mail-unavailable`(503, `지금은 초대 메일을 보낼 수 없습니다`)로 뺀다.** `provider-down`은 본인확인기관·휴대폰 본인확인 저장소 장애 전용으로 남긴다. `retryAfterSeconds: 1`은 그대로 둔다.
3. **건드리지 않는 것**: `provider-down`의 다른 쓰임(본인확인 시작·결과, 초대 수락의 휴대폰 본인확인)과 다른 경로의 `not-found` 표준 제목. `staff-invitation-*`·`authz-unavailable` 매핑도 그대로다.

### 3. 손댈 파일

- 서비스: `services/identity-svc/src/modules/session/inbound/partner-staff.controller.ts`(두 줄). `src/modules/session/session.module.ts`·`src/main.ts`의 주석·경고 문구도 새 이름으로 맞춘다.
- 계약: `docs/api/openapi.yaml` `x-peaket-problem-types`에 `staff-invite-mail-unavailable` 한 줄(`staff-invitation-email-mismatch` 뒤, 알파벳 차례), 초대 만들기(5170행)·재발송(5176행) 설명과 503 응답 설명의 `provider-down`을 새 이름으로. 404 설명은 이름(`not-found`)만 적혀 있어 그대로 둔다.
- 생성물: `pnpm --filter @peaket/contracts gen`·`pnpm --filter @peaket/api-client gen`. `packages/api-client/src/gen/problem-types.ts`에 새 이름이, 두 패키지의 파트너 경로 설명 주석에 새 문구가 들어간다. 생성물은 생성기로만 고친다.
- 정본: `docs/features/identity.md` §6.1 GAT-210 문단의 `503 provider-down`을 새 이름으로. `docs/security/asvs/offline-gate.md`에는 초대 메일 실패의 오류 이름을 적은 문장이 없어(초대 메일 링크·쿠키 문장뿐) 고칠 행이 없다. 같은 이유로 새 ASVS 판정도 만들지 않는다. `docs/adr/0353-staff-invitation-event-owner-lookup-via-core-internal-http.md` 결정 7에는 이름이 바뀐 사실을 한 줄 덧붙인다(결정 내용은 그대로). `docs/review/ledger/identity.md`는 생성기 출력이라 손으로 고치지 않는다. 다음 `ledger.mjs` 실행이 정본 문장을 반영한다(지금도 BAT-450C의 I-T87·I-T88 행이 아직 반영되지 않은 상태다).
- 시험: `services/identity-svc/test/partner-staff-invitations.test.ts`의 I-T21 ⑤·⑥.

### 4. 시험(시험 담당이 구현 전 트리에서 실패를 본다)

| 시험 | 자리 | 단언 |
| --- | --- | --- |
| I-T21 ⑤(고침) | `partner-staff-invitations.test.ts` | 없는 회차·다른 파트너 회차 404가 `type` `…/problems/not-found`, `status` 404, `title` `찾을 수 없습니다`이고 `detail`이 두 경우 모두 `없는 회차이거나 이 파트너의 회차가 아닙니다`다. 두 본문의 type·status·title·detail이 같고 행·메일은 0건이다 |
| I-T21 ⑥(고침) | 같은 파일 | 메일 대역이 실패하면 503이 `type` `…/problems/staff-invite-mail-unavailable`, `title` `지금은 초대 메일을 보낼 수 없습니다`, `Retry-After` 1초이고 행을 만들지 않는다 |
| PRF192(기존) | `packages/platform/test/problem-types.test.ts` | 서비스 코드의 두 매핑이 목록의 status·title과 같은지. 구현 전에는 두 제목 차이로, 구현 뒤에는 통과로 본다. 이 시험 파일은 고치지 않는다 |

- (a)·(b)는 구현 전 트리에서 404의 `title` 불일치와 503의 `type` 불일치로 실패해야 한다. (c)는 같은 트리에서 platform 시험이 두 줄을 보고 실패하는 것을 확인한다.
- 시험 이름은 기존 `I-T21 ⑤`·`I-T21 ⑥`을 그대로 쓴다(장부 `identity.md` I-T21 행의 세부 번호를 새로 만들지 않는다).

### 5. 틀린 구현 표본(검증 담당용)

| # | 틀린 구현 | 잡을 시험 |
| --- | --- | --- |
| S1 | 404 제목을 구체 문구 `없는 회차이거나…`로 되돌린다(type·status는 표준) | I-T21 ⑤, PRF192 |
| S2 | 메일 실패를 `provider-down`과 제목 `지금은 초대 메일을 보낼 수 없습니다`로 되돌린다 | I-T21 ⑥, PRF192 |
| S3 | 새 이름을 목록에만 더하고 서비스 코드는 `provider-down`을 유지한다 | I-T21 ⑥ |
| S4 | 404에서 `detail`을 빼 표준 제목만 남긴다 | I-T21 ⑤ |

### 6. 범위 밖

- **다른 `provider-down`**: 본인확인 시작·결과·초대 수락의 휴대폰 본인확인은 본래 뜻이라 그대로다. 초대 수락 HTTP 시험(`staff-invitation-http.test.ts`)의 `provider-down` 단언도 그대로 통과해야 한다(회귀 확인).
- **다른 `not-found`**: 여러 서비스가 표준 제목을 이미 쓴다. 이 묶음은 identity-svc 파트너 초대 네 경로만 본다.
- **지난 계획·기록**: `docs/review/plans/BAT-450B.md`·`BAT-450-scope.md`의 옛 `provider-down` 문장은 그때의 결정 기록이라 다시 쓰지 않는다. ADR-0353만 이름이 바뀐 사실을 덧붙인다.
- **화면**: 오류 `type` → 문구 키 표는 목록에서 생성되므로 새 이름이 자동으로 들어간다. 파트너 화면(SCR-037)은 GAT-360 몫이라 브라우저 확인을 하지 않는다.
- **장부**: 새 시험 ID를 만들지 않고 I-T21 ⑤·⑥을 강화한다. BUILD_ORDER 단계·wbs 상태 변화는 없다.

## 실패 확인

시험 담당 `w12idp-test`(deepseek-v4.1-flash), 2026-11-22 15:14 KST. 기준 트리 `b8b2fec2b`(계획 커밋)에서 구현 없이 시험만 고쳐 돌렸다.

| 시험 | 결과 | 까닭 |
| --- | --- | --- |
| `pnpm --filter @peaket/identity-svc test test/partner-staff-invitations.test.ts` | 13개 중 **2 실패**(I-T21 ⑤·⑥), 11 통과 | ⑤는 404 `title`이 `찾을 수 없습니다`가 아니라 `없는 회차이거나 이 파트너의 회차가 아닙니다`이고 `detail`이 없다. ⑥은 503 `type`이 `staff-invite-mail-unavailable`이 아니라 `provider-down`이다 |
| `pnpm --filter @peaket/platform test test/problem-types.test.ts` | 2개 중 **1 실패**(PRF192) | 두 제목 차이: `identity-svc not-found '없는 회차이거나…'`, `identity-svc provider-down '지금은 초대 메일을 보낼 수 없습니다'` |

- 새 단언이 구현을 요구하는 방향으로 먼저 섰다. ⑤가 먼저 `title`에서 실패해 `detail`·본문 동일성 단언에는 닿지 않았고, ⑥도 `type`에서 실패해 `Retry-After` 단언에는 닿지 않았다.

## 리뷰

리뷰 담당 `w12idp-review`(deepseek-v4.1-flash), 2026-11-22 15:21~15:23 KST. 받은 것은 `git diff origin/develop..27b5057eb`(계획·시험·구현)와 이 계획 파일이다. 코드·계약·생성물·정본을 대조했고, identity I-T21(13개)·platform PRF192(2개)·`bat450b-contract`(4개)를 다시 돌렸다. 코드는 고치지 않았다.

결과: **막는 지적 0**, 낮음 2(남은 위험).

| 번호 | 심각도 | 위치 | 근거 | 고칠 방향 |
| --- | --- | --- | --- | --- |
| RV-01 | 낮음(남은 위험) | `docs/api/openapi.yaml` 5170·5176행의 404 응답 설명 | 설명이 `not-found:` 이름만 적고 표준 제목·`detail` 규칙을 적지 않아, 계약만 보고 구체 사유가 `detail`에 있다는 것을 알 수 없다. 코드·시험은 맞다 | 다음 계약 정리 때 404 설명에 "제목은 표준 `찾을 수 없습니다`, 구체 사유는 `detail`"을 더한다. 지금은 응답 설명을 고치면 생성물 주석이 함께 바뀌어 이 묶음 범위를 넘는다 |
| RV-02 | 낮음(남은 위험) | `docs/review/ledger/identity.md` | 생성기 출력이라 손으로 고치지 않았다. 이 묶음 전에도 정본에 있는 I-T87·I-T88 행이 장부에 없었고, I-T21 ⑤·⑥ 문장도 옛 것이다. `ledger --check`는 기준 트리에서도 실패 상태였다 | 다음 `ledger.mjs` 실행이 정본 문장과 BAT-450C 행을 함께 반영한다. 이 묶음은 생성기를 돌리지 않았다(다른 묶음 행을 섞지 않으려고) |

### 확인한 것(지적 아님)

- **한 이름 한 상태·제목**: `not-found`는 404 `찾을 수 없습니다`, 새 `staff-invite-mail-unavailable`은 503 `지금은 초대 메일을 보낼 수 없습니다`로 서비스 코드·openapi 목록·api-client 생성 표가 글자까지 같다. PRF192가 두 줄을 더 이상 보고하지 않는다.
- **`provider-down` 회귀 없음**: identity-svc `src`에서 남은 두 곳은 본인확인기관(`verification.controller.ts` 22행)과 초대 수락의 휴대폰 본인확인(`staff-invitation.controller.ts` 23행)뿐이다. 둘 다 제목이 표준 `지금은 본인확인을 할 수 없습니다`이고 `staff-invitation-http.test.ts`가 통과한다.
- **사유 비노출**: 404의 `detail`은 고정 글자 `없는 회차이거나 이 파트너의 회차가 아닙니다`이고 요청 값·회차 ID를 끼우지 않는다. 없는 회차와 다른 파트너 회차의 type·status·title·detail이 같아 소유 여부를 가릴 수 없다(I-T21 ⑤).
- **생성물**: `contracts gen:check`·`api-client gen:check`가 같다. 바뀐 것은 파트너 경로 설명 주석과 `problem-types.ts`의 union·표 두 줄뿐이고 손으로 고친 생성물은 없다.
- **화면**: `apps/partner/src/shared/api/problem.ts`의 `isNotFound`는 status 404만 보고 문구도 이미 `찾을 수 없습니다.`다. 새 type에 기대는 화면 코드는 grep으로 0건이다. 오류 문구 키는 `PROBLEM_TYPES`에서 자동으로 만들어져(`problem-copy.ts`) 새 키가 빠질 자리가 없다.
- **시험**: 리뷰가 다시 돌린 identity I-T21 13/13, platform PRF192 2/2, `bat450b-contract` 4/4가 통과했다.

## 검증

검증 담당 `w12idp-verify`(deepseek-v4.1-flash), 2026-11-22 15:22~15:26 KST. 구현·시험·리뷰에 관여하지 않았다. 기준 커밋 `3b84752ed`.

### 게이트

| 검사 | 결과 |
| --- | --- |
| `pnpm --filter @peaket/platform test test/problem-types.test.ts` | **2/2 통과**(PRF192 포함) |
| `pnpm --filter @peaket/identity-svc test test/partner-staff-invitations.test.ts test/staff-invitation-http.test.ts` | **14/14 통과** |
| `pnpm --filter @peaket/contracts gen:check` | 생성물이 계약과 같다 |
| `pnpm --filter @peaket/contracts test` | **48/48 통과** |
| `pnpm --filter @peaket/api-client test` | **116/116 통과** |
| `pnpm --filter @peaket/api-client gen:check` | 생성물이 계약과 같다 |
| typecheck(identity·platform·contracts·api-client) | **8 tasks 통과** |
| `pnpm lint` | 통과(출력 없음) |
| `python -I -X utf8 tools/doc-check/check_all.py` | 오류 0, 경고 4(기존 셋 + mermaid 건너뜀) |
| `node tools/ci/records.mjs --check` | 기록 표가 맞다(경고는 기존 것) |
| `node --test tools/ci/bat450b-contract.test.mjs` | 4/4 통과 |

- identity typecheck는 `services/identity-svc/dist`가 없으면 `scripts/seed-demo.mjs`가 `../dist/...`를 찾지 못해 실패한다(이 묶음 변경과 무관). `pnpm --filter @peaket/identity-svc build` 뒤 같은 명령이 통과했다. CI는 build를 함께 돌린다.
- `ledger --check`는 이 묶음 전 기준 트리에서도 실패 상태였다(정본에 있는 I-T87·I-T88 행이 장부에 없음). 생성기를 돌리면 다른 묶음 행이 섞여 이번에 돌리지 않았다(리뷰 RV-02).

### 틀린 구현 표본

| # | 넣은 틀린 구현 | 잡은 시험(결과) |
| --- | --- | --- |
| S1 | 404 제목을 옛 구체 문구로 되돌리고 `detail`을 뺀다 | I-T21 ⑤(실패), PRF192(실패) |
| S2 | 메일 실패 type을 `provider-down`으로 되돌린다 | I-T21 ⑥(실패), PRF192(실패) |
| S3 | 표준 제목은 두고 `detail`만 뺀다 | I-T21 ⑤(실패), PRF192(통과) |

- 셋 다 잡혔다. 표본마다 관련 시험만 돌렸고, 되돌린 뒤 `git status --short`에 제품 파일 차이가 없었다.
- S3은 PRF192가 `detail`을 보지 않아 통과하고, 강화한 I-T21 ⑤가 잡는다. 정본의 '구체 사유는 `detail`' 규칙이 시험으로 고정됐다.

### 남은 위험

- 리뷰 RV-01(openapi 404 설명에 `detail` 규칙 없음)·RV-02(장부 생성기 미실행)가 그대로 남는다. 둘 다 막지 않는다.

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w12idp-plan | deepseek-v4.1-flash | 2026-11-22T15:05:00+09:00 | 2026-11-22T15:15:00+09:00 |
| test | w12idp-test | deepseek-v4.1-flash | 2026-11-22T15:16:00+09:00 | 2026-11-22T15:30:00+09:00 |
| impl | w12idp-impl | deepseek-v4.1-flash | 2026-11-22T15:31:00+09:00 | 2026-11-22T15:45:00+09:00 |
| review | w12idp-review | deepseek-v4.1-flash | 2026-11-22T15:46:00+09:00 | 2026-11-22T15:55:00+09:00 |
| verify | w12idp-verify | deepseek-v4.1-flash | 2026-11-22T15:56:00+09:00 | 2026-11-22T16:10:00+09:00 |
