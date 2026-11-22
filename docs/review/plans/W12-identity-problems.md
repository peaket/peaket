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

리뷰 담당 `w12idp-review`(deepseek-v4.1-flash). (리뷰 담당이 채운다)

## 검증

검증 담당 `w12idp-verify`(deepseek-v4.1-flash). (검증 담당이 채운다)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w12idp-plan | deepseek-v4.1-flash | 2026-11-22T15:05:00+09:00 | 2026-11-22T15:15:00+09:00 |
| test | w12idp-test | deepseek-v4.1-flash | 2026-11-22T15:16:00+09:00 | 2026-11-22T15:30:00+09:00 |
| impl | w12idp-impl | deepseek-v4.1-flash | 2026-11-22T15:31:00+09:00 | 2026-11-22T15:45:00+09:00 |
| review | w12idp-review | deepseek-v4.1-flash | 2026-11-22T15:46:00+09:00 | 2026-11-22T15:55:00+09:00 |
| verify | w12idp-verify | deepseek-v4.1-flash | 2026-11-22T15:56:00+09:00 | 2026-11-22T16:10:00+09:00 |
