# 웨이브 8 갈래 3 끝 리뷰 — 정확성(W8-audit2a)

- 리뷰 담당: `l3w8-rev-correct`(claude-opus-5-5), 2026-11-16. 계획·시험·구현에 관여하지 않았고 코드는 고치지 않았다.
- 본 범위: 가지 `wave/lane3-w8-audit2`, `c3b0935c..39ebcec3`(탈퇴 후기 파기·16분 뒤 다시 정리, I-T83). 파일은 모두 `git show 39ebcec3:<경로>`로 읽었다. 아래 줄 번호도 그 커밋 기준이다.
- 계획은 `docs/review/plans/W8-audit2a.md`의 `## 계획` 절만 읽었다(앞선 리뷰·검증 절은 읽지 않았다). 스냅숏 JSON·생성물은 건너뛰었다.
- 관점: 파기 칸이 정본(docs/data.md §2 '후기 파기')과 같은가, 예약 시각 경계(min(탈퇴 시각, 지금) + 16분, 정각 포함), 한 트랜잭션·잠금 차례, 이전 판 행 고치기의 대상 조건·커서·1,000행 묶음, 마이그레이션이 기존 행에서 실패하지 않는가, 권한.

## 요약

| 묶음 | 높음 | 중간 | 낮음 |
| --- | --- | --- | --- |
| W8-audit2a | 0 | 0 | 2 (C1, C2) |

막는 지적은 없다. 파기 칸(`purgeSet`)은 정본과 같고(지운 시각은 `coalesce`로 처음 값), 탈퇴 사건 처리는 예약 → 파기 차례로 한 트랜잭션이며 다시 정리 반복도 예약 행 → 후기 차례로 잠가 교착이 없다. 예약 시각 판정은 `due_at <= 지금`(정각 포함)이고 같은 계정은 `greatest`로 늦은 쪽을 남긴다.

## 지적

### C1 (낮음, ② 다시 정리) 계약은 받은 탈퇴 시각을 예약 셈이 거절하면 파기까지 하지 않는다

- 파일:줄: `services/core-svc/src/modules/review/domain/review.ts:213`(초까지 있어야 하는 모양 검사), `:220-222`(맞지 않으면 Error), `…/application/reviews.ts:341-344`(`purgeWithdrawn`이 파기 트랜잭션 전에 예약 시각을 센다), `…/inbound/account-withdrawn.handler.ts`(`handle`이 그대로 던진다 → 플랫폼이 5회 뒤 보류).
- 틀린 점: 사건 해독은 계약 Zod `AccountWithdrawn.pick(...)`의 `withdrawnAt: zod.iso.datetime({ offset: true })`로 보고, 예약 셈은 따로 만든 정규식으로 본다. 두 검사가 받는 글이 다르면(예: Zod가 초 없는 `2026-11-16T03:00Z`를 받는 경우) 해독은 통과하고 `withdrawalRecheckAt`이 던져, 그 계정의 후기 파기(법정 의무)가 다섯 번 실패한 뒤 보류로 빠진다. 파기 자체는 탈퇴 시각이 필요 없다.
- 근거: 계획 §2 공개 인터페이스는 'withdrawnAt을 읽지 못하면 Error'로 적었지만, 해독을 통과한 사건이 파기를 막는 경우는 정하지 않았다.
- 고칠 쪽: 계획(해독을 통과했는데 시각을 셀 수 없으면 '지금 + 16분'으로 예약하고 파기는 한다로 정할지) → 구현(같은 모양 검사를 쓰거나 대체 시각) → 시험(계약이 받는 모양 하나하나에 예약 시각이 나온다).
- 확인 필요: 쓰는 Zod 판이 `z.iso.datetime({ offset: true })`에서 초 없는 시각·소수 초 자릿수를 받는지. 받지 않으면 지금은 빈틈이 없고, 두 검사를 하나로 묶는 정리 몫만 남는다.

### C2 (낮음, ② A2 이전 판 행 고치기) 잠긴 행을 건너뛴 실행도 '0행'으로 보고해 다음 출시의 VALIDATE 조건을 잘못 채울 수 있다

- 파일:줄: `services/core-svc/src/modules/review/adapters/db/drizzle-review-store.ts:319-334`(`for update skip locked`, 커서는 잡은 행의 마지막 ID), `…/application/review-maintenance.ts`(`review-purge-legacy`가 `{ purged: 합 }`만 돌려준다).
- 틀린 점: 정본 차례는 '정비 일이 0행을 보고한 뒤 다음 출시 마이그레이션(파기 행 CHECK → 두 CHECK VALIDATE)'이다. 그런데 잠긴(예: 그때 고쳐지던) 이전 판 행은 건너뛰고 커서가 그 뒤로 넘어가므로, 남은 대상이 잠긴 행뿐이면 그 실행은 `{ purged: 0 }`을 보고한다. 이 값만 보고 VALIDATE를 넣으면 23514로 배포가 실패한다.
- 근거: `purged`는 바꾼 행 수이지 '남은 대상 수'가 아니다. 건너뛴 수나 마지막에 남은 대상 수를 세는 곳이 없다.
- 고칠 쪽: 계획(다음 출시의 조건을 '정비 일 0행'이 아니라 '남은 대상 0건'(대상 조건으로 센 수)으로 적기) → 구현(실행 끝에 같은 조건으로 남은 수를 세어 결과에 싣기) → 시험(잠긴 행 하나가 남으면 남은 수 1).

## 확인했지만 지적하지 않은 것

- 0026: `rating`·`content_fingerprint` NOT NULL 풀기와 살아 있는 행 CHECK `NOT VALID`는 기존 행을 검사하지 않고, 이전 판 코드가 쓰는 행(VISIBLE·HIDDEN은 별점·지문 있음, 옛 작성자 지우기는 DELETED)도 통과한다. 새 표·색인·권한(`core_app`은 SELECT·INSERT·DELETE·UPDATE(`due_at`)만, `core_maintenance`는 본문 읽기 없이 정해진 칸만)이 계획 §2·§8.2와 같다.
- 이전 판 행 대상 조건: `(DELETED이고 별점·지문 가운데 하나가 남거나 account_id <> id) 또는 (DELETED 아니고 account_id = id)`가 계획 §8.2와 같고, 커서는 `id >`(같은 행 다시 잡지 않음), 묶음 1,000행, 잠금 대기 2초, 묶음 사이 멈춤 신호, `when: 'window'`.
- 집계: 요약·목록은 VISIBLE이고 별점이 있는 행만 센다. 파기한 행의 내용 지문이 비어 같은 내용 차단 목록을 고칠 때 건너뛴다(`content_fingerprint === null`). 법정 조치 증적(`takedown_action`)의 임시 조치 풀기는 증적 행의 `ends_at`으로 하므로 후기 행의 `notice_until`을 비워도 풀린다.
- 밀린 시간 지표: 성공·실패와 관계없이 따로 읽어 고치고, 실패 수·마지막 성공 시각은 실패 때 실패 수만 올린다(계획 §8.1).
