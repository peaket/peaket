# 묶음 계획: W8-audit2a(웨이브 8 갈래 3, 감사 잔여 둘째 몫 ① — 소유자 결정 OPEN[42]·[44], ADR-0278)

- **무엇**: 웨이브 7 W7-audit가 소유자 결정으로 남긴 셋 가운데 OPEN[42](탈퇴 계정 후기 파기)와 OPEN[44](탈퇴 + 15분 뒤 한 번 더 정리)의 작업 목록이다(docs/architecture.md §8.6 4의 1, ADR-0270 결정 1·2). 남은 OPEN[43](파트너 명단 접속기록을 ops 감사 저장소로)은 [W8-audit2b](W8-audit2b.md)(웨이브 9)다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane3-w8b`, 가지 `wave/lane3-w8-audit2`, 출발점 `origin/develop` `c3b0935c`(소유자 결정 R-651). 2026-11-16 작성. 처음에는 가칭 `W8-audit2` 하나로 계획했고, 감독 결정(메인 감독 세션, 2026-11-16)으로 2a(웨이브 8)·2b(웨이브 9)로 나눴다. BUILD_ORDER 묶음 표에는 넣지 않고 `docs/lanes/lane3.md`와 계획 파일로 간다.
- **등급**: B(개인정보·법정 의무 — 탈퇴 파기). 틀린 구현 표본에 탈퇴 파기 항목을 꼭 넣는다(아래 §4).
- **근거로 읽은 것**: 지시서 `brief-W8-audit2.md`·`brief-W8-common.md`, docs/review/plans/W7-audit.md §4·§5·§7, docs/review/measurements/W7-lane3-review-security.md S2·S6·S7, W7-lane3-review-concurrency.md K3·K4, 커밋 `c3b0935c` 본문, 아래 '손댈 파일'의 기존 코드(core-svc review·consumers·main.ts·relay.ts·0013·0022, platform maintenance).

## 계획

### 0. 범위·크기·차례

| 묶음 | 결정 | 하는 일 | WBS [가정] | 웨이브 |
| --- | --- | --- | --- | --- |
| `W8-audit2a`(이 파일) | OPEN[42]·[44] | core-svc 후기 파기(탈퇴·작성자 지움), 탈퇴 + 15분 뒤 다시 정리 예약과 반복 | 2.5일 | 8 |
| [`W8-audit2b`](W8-audit2b.md) | OPEN[43] | 사건 계약 `audit.data-accessed`, core 명단 접속기록을 Outbox 사건으로, ops `admin_data_access`·감사 체인·소비자·점검 읽기 | 3일 | 9 |

- 둘을 합치면 5.5일 [가정]로 턴 규칙 '묶음 크기'의 5일을 넘는다. [43]은 계약·두 서비스에 걸쳐 [42]·[44]와 손대는 파일이 거의 겹치지 않는다.
- **마이그레이션(감독 배정 2026-11-16)**: core-svc **0026**(파일 이름 예 `0026_review_purge_recheck.sql`: `review`의 `rating`·`content_fingerprint` NULL 허용, 살아 있는 행 CHECK `NOT VALID`, 새 표 `review_withdrawal_recheck`와 `core_app` 권한, §1·§2). 2b는 core **0027**, ops **0015**다. 다음 출시 몫(이 묶음 아님, 정본에만 적음): 파기 행 CHECK와 두 CHECK의 `VALIDATE`(docs/data.md §2 '후기 파기').
- **ADR**: [ADR-0278](../../adr/0278-withdrawn-review-purge-and-partner-access-log-to-ops-audit.md)(감독 배정). 정본의 '소유자 결정 2026-11-16 OPEN[n]' 옆에 ADR-0278을 달았다.
- **다른 갈래와 닿는 곳**:
  - core-svc 마이그레이션 번호: develop 마지막은 0022이고, 갈래 2 `wave/lane2-w7`이 0023을 쓰는 중이다. 이 묶음은 감독이 준 0026을 쓴다. `migrations/meta/_journal.json`은 합칠 때 차례대로 맞춘다.
  - 같은 정본 문서를 다른 가지가 고친다: `docs/features/identity.md`(갈래 1 `wave/lane1-w7-b060`, 342줄 근처), `docs/data.md`(갈래 1·`wave/lane3-w8`, 다른 절), `docs/api/asyncapi.yaml`(`wave/lane3-w8`의 `CaseRequested.kind`, `wave/lane2-w7`의 `RumSample.counters`), `docs/architecture.md` §11 ADR 표(`wave/lane2-w7`이 0271·0272 줄을 0270 뒤에 더한다). 이 커밋은 다른 줄만 고친다.

### 0.1 정본 고침(이 계획 커밋, 2a·2b 공통)

- 이 계획 커밋은 소유자 결정 셋의 정본을 한 번에 먼저 고쳤다. 2b 몫(OPEN[43])의 정본도 여기서 썼다. 2b 계획은 웨이브 9 시작 때 출발점에서 이 정본을 다시 확인한다.
  - 2a 몫: docs/features/identity.md §8 '후기 파기'·§12 I-T83, docs/data.md §2 `review` 그림·'후기 파기'·'후기 표의 DB 권한'·§5.1 '탈퇴 파기'·§6 '관람 후기'·'탈퇴 후기 다시 정리 예약', docs/streaming.md §2.6 'core-svc 소비자', docs/security/data-classification.md '관람 후기'·'탈퇴 후기 다시 정리 예약', docs/security/asvs/catalog-review.md v5.0.0-14.2.7, docs/api/asyncapi.yaml `identity.accounts-withdrawn` 설명·`consumeAccountWithdrawn`.
  - 2b 몫: docs/api/asyncapi.yaml `audit.data-accessed`·`DataAccessed`·두 작업, docs/api/avro/peaket/audit/DataAccessed.avsc·README §1·§4·§6, docs/streaming.md §2.4·§2.6 'ops-svc 접근 기록 소비자', docs/data.md 그림 `admin_data_access`·§2 '예매자 명단 내려받기 이력과 접속기록'·'관리 계정 개인정보 열람·내려받기 기록'·§6 '관리자 계정 접속 로그', docs/features/settlement.md §9·J-T26 ⑤⑥, docs/features/control-tower.md §7·C-T19, docs/security/data-classification.md '관리자 시스템 접속기록', docs/security/internal-management-plan.md §4.5, docs/security/asvs/settlement.md v5.0.0-16.2.1·16.4.2.
  - 공통: ADR-0278과 docs/architecture.md §11 ADR 표 줄.
- **계약 생성물(2a 구현 담당 몫)**: 이 커밋이 asyncapi에 `DataAccessed`를 더해 `pnpm --dir packages/contracts gen:check`가 2건 다르다(새 `asyncapi/model/dataAccessed.zod.ts`, `asyncapi/model/index.ts`). 2b는 웨이브 9라 웨이브 8을 합칠 때 CI 생성물 검사가 실패하지 않도록, **2a 구현 담당이 `pnpm --dir D:/ticketpass-lane3-w8b/packages/contracts gen`으로 두 파일을 다시 만들어 구현 커밋에 넣는다**(내용은 계약 그대로이고, 그것을 쓰는 코드는 2b다). 계획 커밋은 docs만 담는다.

### 0.2 공통 규칙

- 시험 이름에 정본 시험 ID와 세부 번호를 단다: `I-T83 ①`~`⑦`(새로, docs/features/identity.md §12 표). 정본 표의 세부 번호는 이 커밋이 썼다.
- 단언 값은 코드 상수를 가져오지 않고 정본 값을 적는다: 다시 정리 예약 = 탈퇴 시각 + 16분(15분 + 여유 1분 [가정], identity.md §8), 반복 간격 60초 [가정], 한 번에 100개 [가정].
- 시험의 시간 값은 상수와 다르게 고른다(예: 탈퇴 시각과 처리 시각을 3분 어긋나게, 예약 경계는 −1ms·0ms). 건수는 두 자리까지 넣는다.
- '처음부터 통과 예상'은 이미 있는 동작을 묶는 시험이다. 실패 확인 절에 그렇게 적고, 검증 담당의 틀린 구현으로 한 번은 실패를 본다(ADR-0270 결정 3).
- 공개 인터페이스가 바뀌어 **기존 시험 파일도 시험 담당이 고친다**(구현 담당은 고치지 않는다): `services/core-svc/test/review-withdrawn.test.ts`(COV2-06 ①②⑨의 익명화 단언 → 파기 단언, 내부 경로 `/anonymize` → `/purge`), `test/core-consumers.test.ts`(처리기 대역의 `anonymizeAccount` → `purgeWithdrawn`), `test/review.test.ts`(작성자 지우기 뒤 `'***'` 단언), `test-int/review-withdrawn.int.test.ts`, `test-int/review-withdrawn-consumer.int.test.ts`, `test-int/review-grants.int.test.ts`(지우기 뒤 칸).

### 1. ① OPEN[42] 탈퇴 계정 후기 파기(작성자 지우기 포함)

**무엇이 틀렸나(코드 확인)**: 탈퇴 사건 처리기(`account-withdrawn.handler.ts`)가 부르는 `ReviewStore.anonymizeByAccount`는 `account_id`·`basis_order_id`를 후기 ID로, `author_display`를 '탈퇴한 사용자'로 바꿀 뿐이고 `status`·`body`·`rating`·`content_fingerprint`·`notice`는 그대로다. 그래서 탈퇴한 계정의 후기가 공개 목록·요약에 그대로 남는다. 작성자 지우기(`softDeleteReview`)도 Drizzle은 `body`·`author_display`만 비우고 `rating`·`content_fingerprint`·`account_id`를 남기며(메모리 저장소는 `rating: 0`), 정본 ADR-0086 ⑧·docs/data.md §6 '관람 후기'(본문·별점·사진 키·계정 ID를 바로 비움)와 다르다. `review.rating`·`content_fingerprint`는 0013에서 NOT NULL이라 비울 수 없다. 후기 사진(`review_image`)은 아직 없다(쓰기에서 422 `review-images-unavailable`).

**정한 파기 칸(정본 docs/data.md §2 '후기 파기', 이 계획 커밋)**: `status` DELETED, `body` '', `rating` NULL, `content_fingerprint` NULL, `author_display` '', `notice`·`notice_until` NULL, `account_id`·`basis_order_id` = 그 후기 ID, `deleted_at` = 처음 지운 시각(이미 있으면 그대로), `updated_at` = 지금. 남는 칸은 `id`·`event_id`·`status`·`edited`·`created_at`·`updated_at`·`deleted_at`이다. 대상은 그 계정의 모든 행(VISIBLE·HIDDEN·작성자가 이미 지운 DELETED)이다. 같은 내용 차단 목록 `review_hidden_fingerprint`와 법정 조치 증적 `takedown_action`(3년)은 건드리지 않는다.

**손댈 파일**

| 나눔 | 파일 |
| --- | --- |
| 제품 코드 | `services/core-svc/src/modules/review/domain/review.ts`(`ReviewRecord`의 `rating`·`contentFingerprint` null 허용, 파기 칸 상수), `…/review/domain/ports.ts`(`purgeByAccount`, `softDeleteReview` 뜻, `anonymizeByAccount` 지움), `…/review/application/reviews.ts`(`purgeAccount`, `delete`), `…/review/adapters/db/drizzle-review-store.ts`, `…/review/adapters/db/schema.ts`(두 칸 NULL 허용), `…/review/adapters/memory-review-store.ts`, `…/review/inbound/internal-review.controller.ts`(경로 `/purge`), `…/review/inbound/account-withdrawn.handler.ts`(아래 §2와 함께), `…/review/index.ts` |
| 마이그레이션 | 새 `services/core-svc/migrations/0026_review_purge_recheck.sql`(감독 배정, §2의 표·권한과 같은 파일), `migrations/meta/_journal.json`, 그 번호의 스냅숏(`pnpm --dir D:/ticketpass-lane3-w8b/services/core-svc db:generate` 뒤 CHECK·GRANT는 손으로 확인) |
| 시험 | 새로: `services/core-svc/test/review-purge.test.ts`(단위), `test/review-purge-migration.test.ts`(SQL 원문), `test-int/review-purge.int.test.ts`(PostgreSQL). 고침: §0.2의 목록 |
| 정본(이 계획 커밋) | docs/features/identity.md §8 '후기 파기'·§12 I-T83, docs/data.md §2 `review` 그림·'후기 파기'·'후기 표의 DB 권한'·§5.1 '탈퇴 파기'·§6 '관람 후기', docs/security/data-classification.md '관람 후기', docs/security/asvs/catalog-review.md v5.0.0-14.2.7, docs/streaming.md §2.6 'core-svc 소비자', docs/api/asyncapi.yaml `identity.accounts-withdrawn` 설명·`consumeAccountWithdrawn` |

**공개 인터페이스**

```ts
// services/core-svc/src/modules/review/domain/review.ts
export interface ReviewRecord {
  // … 지금 칸 …
  /** 파기한 행(status DELETED)에서만 null */
  readonly rating: number | null;
  /** 파기한 행(status DELETED)에서만 null */
  readonly contentFingerprint: string | null;
}

// services/core-svc/src/modules/review/domain/ports.ts
export interface ReviewStore {
  /** 작성자 지우기. 그 후기 한 행을 파기 칸대로 비운다(docs/data.md §2 '후기 파기') */
  softDeleteReview(reviewId: string, nowMs: number): Promise<void>;
  /** 그 계정의 후기를 상태와 관계없이 모두 파기 칸대로 비운다. 바꾼 행 수. 이미 바꾼 행은 그 계정 ID로 더 찾히지 않아 다시 하면 0 */
  purgeByAccount(accountId: string, nowMs: number): Promise<number>;
  // anonymizeByAccount는 지운다(부르는 곳이 남지 않게)
}

// services/core-svc/src/modules/review/application/reviews.ts
class Reviews {
  /** 손으로 다시 하는 길(내부 경로). UUID가 아니면 ReviewProblem('review-invalid', 422). 다시 정리 예약은 만들지 않는다 */
  purgeAccount(accountId: string): Promise<{ purged: number }>;
  // anonymizeAccount는 지운다
}

// services/core-svc/src/modules/review/inbound/internal-review.controller.ts
// POST /internal/v1/reviews/accounts/:accountId/purge → 200 { purged: number }(InternalTokenGuard 그대로). /anonymize는 지운다(404)
```

- Drizzle `purgeByAccount`: `update review set status = 'DELETED', body = '', rating = null, content_fingerprint = null, author_display = '', notice = null, notice_until = null, account_id = id, basis_order_id = id, deleted_at = coalesce(deleted_at, $now), updated_at = $now where account_id = $1 returning id` 한 문장(색인 `review_account_idx`, 0022). `softDeleteReview`는 같은 칸을 `where id = $1`로.
- 메모리 저장소도 같은 칸으로 바꾼다(지금 `rating: 0`은 null로).
- 읽기 경로(`findReview`·`#mine`·`get`·`moderate`·`reportedReview`)는 DELETED를 404로 보는 지금 동작을 그대로 두고, null 칸을 화면 모양으로 옮기지 않는다(`reviewView`는 DELETED를 받지 않는다).
- 집계(`listVisibleByProduction`은 VISIBLE만, `listReviews`는 DELETED 제외)는 바꾸지 않는다. 상태가 DELETED가 되므로 빠진다.

**마이그레이션(core-svc 0026, §2와 같은 파일)**

- `ALTER TABLE "review" ALTER COLUMN "rating" DROP NOT NULL; ALTER TABLE "review" ALTER COLUMN "content_fingerprint" DROP NOT NULL;`(넓히기라 이전 판 코드와 함께 돌아도 된다).
- `ALTER TABLE "review" ADD CONSTRAINT "review_live_complete_check" CHECK ("status" = 'DELETED' OR ("rating" IS NOT NULL AND "content_fingerprint" IS NOT NULL)) NOT VALID;`(살아 있는 행은 지금처럼 별점·지문이 있다. 이전 판 코드도 지킨다).
- 파기 행 CHECK(`status <> 'DELETED' OR (body = '' AND rating IS NULL AND content_fingerprint IS NULL AND account_id = id AND basis_order_id = id)`)와 두 CHECK의 `VALIDATE`는 **넣지 않는다**: 이전 판의 작성자 지우기가 별점을 남겨 배포 창 동안 실패한다(docs/devops.md §7.1 원칙 2·3, W7-audit 리뷰 K1과 같다). 다음 출시 마이그레이션 몫으로 docs/data.md에 적었다.
- 권한은 바꾸지 않는다: 0022가 `core_app`에 준 `review` UPDATE 칸 목록이 파기 칸을 모두 덮는다(`rating`·`body`·`status`·`notice`·`notice_until`·`content_fingerprint`·`author_display`·`updated_at`·`deleted_at`·`account_id`·`basis_order_id`).

**시험 목록(2a ①)**

| 시험 이름 | 단계 | 단언(정본 값) | 비고 |
| --- | --- | --- | --- |
| `I-T83 ① 탈퇴 사건을 받으면 그 계정 후기를 모두 파기 칸대로 비운다` | 단위 | 메모리 저장소: 계정 A 후기 셋(VISIBLE, HIDDEN+`notice` RIGHTS_TEMP, 작성자가 이미 지운 DELETED), 계정 B 후기 하나. 처리 뒤 A의 세 행 모두 `status` DELETED, `body` '', `rating` null, `contentFingerprint` null, `authorDisplay` '', `notice`·`noticeUntilMs` 없음, `accountId`·`basisOrderId` = 각자의 후기 ID, `updatedAtMs` = 가짜 시계. 이미 지운 행의 지운 시각은 처음 값 그대로. B 행은 모든 칸 그대로. 처리 결과 `purged` 3 | 파기 칸 전부. 기존 COV2-06 ① 대체 |
| `I-T83 ② 파기한 후기는 공연 후기 목록·요약·상세에서 빠진다` | 단위(유스케이스) | 같은 공연 두 회차에 A 후기 둘(별점 1·5)과 B 후기 하나(별점 4). 처리 전 요약 후기 수 3·평균 3.3(소수 첫째 자리 반올림), 처리 뒤 후기 수 1·평균 4. 목록(LATEST·RATING_DESC)에 A 후기가 없고, A 후기 상세 `get`은 404 | 집계에서 빠짐 |
| `I-T83 ③ 같은 사건을 다시 받거나 내부 경로를 다시 불러도 결과가 같다` | 단위 + HTTP | 둘째 처리 `purged` 0, 행(갱신 시각 포함) 첫 처리 뒤와 같음. 내부 경로 `POST /internal/v1/reviews/accounts/{A}/purge` 토큰 맞음 → 200 `{ purged: 0 }`, 없음·틀림 403, UUID 아님 400, 옛 경로 `/anonymize` 404 | 다시 해도 결과 같음. 기존 COV2-06 ⑨ 고침 |
| `I-T83 ⑥ 작성자가 지운 후기도 같은 칸을 비운다` | 단위 + 통합 | 단위: `delete` 뒤 그 행이 ①과 같은 칸(지운 시각 = 지금). 통합(core PostgreSQL, `core_app` 로그인): `DELETE /v1/reviews/{id}` 뒤 그 행의 `rating`·`content_fingerprint` IS NULL, `body` '', `account_id` = `id`. 같은 회차에 새 후기를 다시 쓸 수 있다 | ADR-0086 ⑧ |
| `I-T83 ①⑥ Drizzle 파기는 그 계정 행만 바꾸고 다시 해도 0건이다` | 통합(core PostgreSQL, `core_app` 로그인) | A의 두 회차 후기(하나는 HIDDEN+통보 가림 조치)·B의 후기. 첫 호출 2, A 행 칸이 ①과 같고 B 행 그대로, `takedown_action`·`review_hidden_fingerprint` 행 그대로, 회차·계정 부분 유일 색인 위반 없음. 둘째 호출 0 | 기존 COV2-06 ⑪ 고침 |
| `I-T83 ⑦ 마이그레이션은 별점·지문 NULL을 허용하고 살아 있는 행 CHECK를 NOT VALID로 더하며 권한을 넓히지 않는다` | 단위(SQL 원문) | `ALTER COLUMN "rating" DROP NOT NULL`, `ALTER COLUMN "content_fingerprint" DROP NOT NULL`, `review_live_complete_check` 글과 `NOT VALID`, 파기 행 CHECK·`VALIDATE CONSTRAINT`가 **없다**, `review`에 대한 새 GRANT 없음, journal 항목의 tag가 파일 이름과 같다 | 0022 시험과 같은 방식 |
| `I-T83 ⑦ 살아 있는 후기는 별점·지문 없이 넣을 수 없다` | 통합(core PostgreSQL) | `status` VISIBLE·`rating` NULL 넣기 23514, `content_fingerprint` NULL 23514, `status` DELETED·`rating` NULL은 들어간다 | |

**틀린 구현 표본(2a ①, 개인정보·법정 의무)**: `purgeByAccount`가 ⓐ `rating`이나 `content_fingerprint`를 남김 ⓑ `status`를 그대로 둠(집계에 남음) ⓒ `where account_id = …`를 빠뜨리거나 `id`로 찾음(다른 계정 행을 지움) ⓓ 작성자가 이미 지운 행(DELETED)은 건너뜀(`status <> 'DELETED'` 조건) ⓔ `deleted_at`을 늘 지금으로 덮음. 작성자 지우기가 ⓕ 옛 칸(`body`·`author_display`)만 비움. 처리기가 ⓖ `purge` 대신 옛 익명화를 부름.

### 2. ② OPEN[44] 탈퇴 + 15분 뒤 한 번 더 정리

**무엇이 틀렸나(코드 확인)**: 처리기는 사건을 받자마자 한 번만 정리한다. 탈퇴 전에 받은 액세스 토큰(최대 15분)으로 그 뒤에 쓴 후기는 그 계정의 사건이 다시 오지 않아 영영 남는다(W7 리뷰 K3). 같은 사건을 읽는 queue-svc는 같은 까닭으로 `withdrawnAt + 15분`에 처리한다(docs/streaming.md §2.6, ADR-0214 결정 7). core의 정비 반복(platform `MaintenanceRunner`)은 하루 한 번 일만 다뤄 15분 늦춤에 쓸 수 없다.

**정한 것(정본 docs/features/identity.md §8 '다시 정리'·docs/data.md §2·docs/streaming.md §2.6, 이 계획 커밋)**:
- 사건을 받으면 파기(§1)와 '다시 정리 예약' 한 행을 **같은 트랜잭션**에 쓴다. 예약 시각 = min(사건의 `withdrawnAt`, 지금) + 16분(액세스 토큰 최대 15분 + 그때 처리 중이던 쓰기 요청이 끝날 여유 1분 [가정], 추천 적용). 같은 계정의 예약이 이미 있으면 늦은 쪽 시각을 남긴다. `withdrawnAt`이 미래(시계 어긋남)여도 지금 + 16분을 넘지 않는다.
- 소비자를 켠 파드마다 60초 [가정]마다 반복이 때가 된 예약을 100개 [가정]씩 잠가(`FOR UPDATE SKIP LOCKED`) 그 계정을 다시 파기하고 예약을 지운다(한 트랜잭션). 여러 파드가 겹쳐도 한 예약은 한 번만 잡히고, 겹쳐 파기해도 결과가 같다.
- 예약 표 `review_withdrawal_recheck`에는 계정 ID·예약 시각·만든 시각만 둔다(pid 없음). 처리하면 지운다. 밀린 시간은 `maintenance_retention_overdue_seconds{service="core-svc", table="review_withdrawal_recheck"}`로 보인다(경보는 정비 보존과 같은 규칙: 5일 [가정] 넘으면 SEV2 legal, docs/observability.md 운영 확인 '정비 잡' 행).
- 내부 경로(`/purge`)는 예약을 만들지 않는다(사건을 잃었을 때 나중에 손으로 하는 길이다).
- 소비자를 켜지 않은 local·ci에는 반복도 없다.

**손댈 파일**

| 나눔 | 파일 |
| --- | --- |
| 제품 코드 | `services/core-svc/src/modules/review/domain/review.ts`(`WITHDRAWAL_RECHECK_DELAY_MS`, `withdrawalRecheckAt`), `…/review/domain/ports.ts`(`purgeWithdrawnAccount`·`runDueRechecks`·`oldestOverdueRecheckMs`), `…/review/application/reviews.ts`(`purgeWithdrawn`·`runWithdrawalRechecks`), `…/review/adapters/db/drizzle-review-store.ts`, `…/review/adapters/db/schema.ts`(`reviewWithdrawalRecheck`), `…/review/adapters/memory-review-store.ts`, `…/review/inbound/account-withdrawn.handler.ts`, 새 `services/core-svc/src/consumers/review-recheck.ts`(Kafka 모듈을 싣지 않는 반복), `src/consumers/start.ts`(반복 함께 시작·멈춤), `src/main.ts`(소비자 유스케이스를 반복에 넘김) |
| 마이그레이션 | §1과 같은 core-svc 0026: `CREATE TABLE "review_withdrawal_recheck" ("account_id" uuid PRIMARY KEY, "due_at" timestamptz NOT NULL, "created_at" timestamptz NOT NULL)`, `CREATE INDEX "review_withdrawal_recheck_due_idx" ON … ("due_at")`, `GRANT SELECT, INSERT, DELETE, UPDATE ("due_at") ON "review_withdrawal_recheck" TO core_app`(그 밖의 역할에는 주지 않는다) |
| 시험 | 새로: `services/core-svc/test/review-recheck.test.ts`(단위, 가짜 시계), `test-int/review-recheck.int.test.ts`(PostgreSQL). 고침: `test-int/review-withdrawn-consumer.int.test.ts`(Kafka 사건 뒤 예약 행) |
| 정본(이 계획 커밋) | §1과 같고, docs/data.md §2 '다시 정리 예약'·§6 행, docs/security/data-classification.md '탈퇴 후기 다시 정리 예약' 행 |

**공개 인터페이스**

```ts
// services/core-svc/src/modules/review/domain/review.ts
/** 액세스 토큰 최대 15분 + 처리 중이던 쓰기 요청의 여유 1분 [가정](docs/features/identity.md §8 '다시 정리') */
export const WITHDRAWAL_RECHECK_DELAY_MS: number;
/** min(withdrawnAt, nowMs) + 16분. withdrawnAt을 읽지 못하면 Error */
export function withdrawalRecheckAt(withdrawnAtIso: string, nowMs: number): number;

// services/core-svc/src/modules/review/domain/ports.ts
export interface ReviewStore {
  /** 파기(purgeByAccount와 같은 칸)와 다시 정리 예약 쓰기를 한 트랜잭션에. 예약이 있으면 늦은 시각을 남긴다. 둘 중 하나라도 실패하면 둘 다 없다 */
  purgeWithdrawnAccount(accountId: string, o: { nowMs: number; recheckAtMs: number }): Promise<number>;
  /** due_at <= nowMs인 예약을 limit개까지 SKIP LOCKED로 잠가 그 계정들을 파기하고 예약을 지운다(한 트랜잭션) */
  runDueRechecks(nowMs: number, limit: number): Promise<{ accounts: number; purged: number }>;
  /** 가장 오래 밀린 예약이 예약 시각을 넘긴 시간(ms). 없거나 밀리지 않았으면 0 */
  oldestOverdueRecheckMs(nowMs: number): Promise<number>;
}

// services/core-svc/src/modules/review/application/reviews.ts
class Reviews {
  /** 탈퇴 사건 처리: UUID 확인 → purgeWithdrawnAccount(accountId, { nowMs, recheckAtMs: withdrawalRecheckAt(withdrawnAt, nowMs) }) */
  purgeWithdrawn(e: { accountId: string; withdrawnAt: string }): Promise<{ purged: number }>;
  /** 반복 한 번의 몸통 */
  runWithdrawalRechecks(limit?: number /* 기본 100 */): Promise<{ accounts: number; purged: number }>;
  oldestOverdueRecheckMs(): Promise<number>;
}

// services/core-svc/src/modules/review/inbound/account-withdrawn.handler.ts
export class ReviewAccountWithdrawnHandler {
  constructor(reviews: Pick<Reviews, 'purgeWithdrawn'>, codec?: AccountWithdrawnCodec, o?: { logger?: { info(o: object, msg?: string): void } });
  /** reviews.purgeWithdrawn({ accountId, withdrawnAt })를 기다린다. 로그에는 eventKey와 purged 수만(계정 ID 없음). 저장소 일시 장애는 그대로 던진다 */
  handle(e: ReviewWithdrawnEvent): Promise<void>;
  // decode·keyOf·eventKeyOf는 그대로
}

// services/core-svc/src/consumers/review-recheck.ts(새, Kafka 모듈을 싣지 않는다)
export interface ReviewRecheckLoopOptions {
  reviews: Pick<Reviews, 'runWithdrawalRechecks' | 'oldestOverdueRecheckMs'>;
  everyMs?: number;   // 기본 60_000 [가정]
  limit?: number;     // 기본 100 [가정]
  registry?: Registry; // maintenance_retention_overdue_seconds{service:'core-svc', table:'review_withdrawal_recheck'}
  logger?: { warn(o: object, msg?: string): void; info?(o: object, msg?: string): void };
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>; // 시험이 바꾼다
}
/** 한 번 돌 때 accounts가 limit과 같으면 곧바로 다시 돈다(밀린 것을 비울 때까지). 실패는 경고 한 줄(계정 ID 없음) 뒤 다음 간격에 다시 한다 */
export function startReviewRecheckLoop(o: ReviewRecheckLoopOptions): { stop(): Promise<void> };

// services/core-svc/src/consumers/start.ts
export interface CoreConsumersOptions { /* … 지금 칸 … */ recheck: ReviewRecheckLoopOptions['reviews']; recheckEveryMs?: number }
// startCoreConsumers는 소비자와 함께 반복을 켜고, stop()은 반복을 먼저 멈춘 뒤 소비자를 멈춘다
```

- `main.ts`: 지금 만든 `consumerReviews`(소비자 전용 `core_app` 풀)를 `recheck`로 넘긴다. 다른 조립은 그대로다.
- Drizzle `purgeWithdrawnAccount`: `database.transaction(tx => { 파기 update; insert into review_withdrawal_recheck (account_id, due_at, created_at) values (…) on conflict (account_id) do update set due_at = greatest(review_withdrawal_recheck.due_at, excluded.due_at) })`.
- Drizzle `runDueRechecks`: 한 트랜잭션에서 `select account_id from review_withdrawal_recheck where due_at <= $now order by due_at limit $n for update skip locked` → 계정마다 파기 update(또는 `account_id = any($ids)` 한 문장) → `delete from review_withdrawal_recheck where account_id = any($ids)`.

**시험 목록(2a ②)**

| 시험 이름 | 단계 | 단언(정본 값) | 비고 |
| --- | --- | --- | --- |
| `I-T83 ④ 탈퇴 사건 처리는 파기와 탈퇴 시각 + 16분 예약을 함께 쓴다` | 단위 | 가짜 시계 `2026-11-16T03:03:00Z`, 사건 `withdrawnAt` `2026-11-16T03:00:00Z` → 예약 시각 `2026-11-16T03:16:00Z`(처리 시각 + 16분인 03:19가 아니다). `withdrawnAt` `2026-11-16T09:00:00Z`(미래) → `03:19:00Z`. 같은 계정 사건을 다시 받아 더 이른 시각이 와도 예약은 늦은 쪽 그대로 | 시간 값은 상수와 다르게 |
| `I-T83 ④ 예약 시각 전에는 다시 정리하지 않고 그 시각에 파기한다` | 단위 | 사건 처리 뒤 A가 새 후기를 쓴다(탈퇴 전 토큰 흉내). `runWithdrawalRechecks`를 예약 − 1ms에 부르면 `{ accounts: 0, purged: 0 }`이고 새 후기 VISIBLE, 예약 그대로. 예약 시각 정각에 부르면 `{ accounts: 1, purged: 1 }`, 새 후기가 ①의 칸, 예약 없음 | 경계 양쪽 |
| `I-T83 ④ 파기와 예약은 한 트랜잭션이다` | 통합(core PostgreSQL, `core_app`) | 예약 넣기만 실패하게 관리자 연결로 `REVOKE INSERT ON review_withdrawal_recheck FROM core_app`을 잠시 건다 → `purgeWithdrawnAccount` 거절(42501), 그 계정 후기는 파기되지 않았다(VISIBLE 그대로). 권한을 돌린 뒤 다시 하면 파기와 예약이 둘 다 있다 | 같은 트랜잭션. 끊긴 사례가 실제로 있었는지(거절 수 1) 단언 |
| `I-T83 ⑤ 두 반복이 겹쳐도 한 예약은 한 번만 잡고 처리한 예약은 지운다` | 통합(core PostgreSQL) | 때가 된 예약 셋(계정 셋, 후기 각 하나)과 때가 안 된 예약 하나. 두 연결에서 `runDueRechecks(now, 2)`를 동시에 → 둘의 `accounts` 합 3, 겹친 계정 없음, 파기된 후기 셋, 남은 예약은 때가 안 된 하나뿐. 다시 부르면 0 | SKIP LOCKED·다시 해도 같음 |
| `I-T83 ⑤ 반복은 밀린 것을 비울 때까지 돌고 실패해도 멈추지 않으며 밀린 시간을 낸다` | 단위 | 대역 `reviews`: 첫 호출 `accounts` 100(= limit) → 곧바로 다시, 둘째 37 → 다음 간격. 셋째가 던지면 경고 한 줄(글에 계정 ID 없음) 뒤 다음 간격에 다시 부른다. 등록부의 `maintenance_retention_overdue_seconds{service="core-svc",table="review_withdrawal_recheck"}` = `oldestOverdueRecheckMs` / 1000. `stop()` 뒤 더 부르지 않는다 | 반복 간격 값(60초)은 가짜 sleep으로 본다 |
| `I-T83 ⑤ 소비자를 켜면 반복도 켜지고 멈출 때 반복을 먼저 멈춘다` | 단위(원문 대조) | `start.ts`가 `startReviewRecheckLoop(`를 부르고 `stop` 차례가 반복 → 소비자, `main.ts`가 `recheck: consumerReviews`를 넘긴다 | 시작 파일 조립. 약한 검사라 아래 통합이 실제 동작을 본다 |
| `I-T83 ④ 실제 Kafka 탈퇴 사건 뒤 예약 행이 생기고 반복이 그 시각에 다시 파기한다` | 통합(core Kafka + PostgreSQL) | 맞는 JSON 사건(`withdrawnAt` = 지금 − 16분 + 2초) → 후기 파기, 예약 행 1. 사건 뒤 같은 계정 후기를 저장소로 직접 넣고 반복 간격 200ms로 켜면 3초 안에 그 후기가 파기되고 예약 행 0 | 기존 COV2-06 ⑫ 파일에 더함. Kafka 네이티브 모듈이 이 PC에서 막히면 CI에서만 돈다 |
| `I-T83 ⑦ 예약 표 권한은 core_app의 읽기·넣기·지우기·예약 시각 고치기뿐이다` | 단위(SQL 원문) + 통합 | 원문: `GRANT SELECT, INSERT, DELETE, UPDATE ("due_at") ON "review_withdrawal_recheck" TO core_app` 한 줄뿐, `core_partner`·`core_maintenance`·`core_ops` GRANT 없음. 통합: `core_app`으로 `UPDATE … SET account_id = …` 42501, `core_partner`로 SELECT 42501 | 최소 권한 |

**틀린 구현 표본(2a ②)**: ⓐ 예약 시각을 처리 시각 기준으로(`now + 16분`) 셈 ⓑ 15분으로 셈(여유 없음) 또는 `<`를 `<=` 반대로(예약 시각 정각에 건너뜀) ⓒ 예약을 파기와 다른 트랜잭션에 씀 ⓓ `ON CONFLICT DO UPDATE`가 이른 시각으로 덮음 ⓔ 처리한 예약을 지우지 않음(계정 ID가 남음) ⓕ `SKIP LOCKED` 빠짐(겹쳐 돌면 기다림·두 번 잡음) ⓖ 반복이 한 번 실패하면 멈춤 ⓗ `start.ts`가 반복을 켜지 않음.

### 3. 돌릴 통합 시험(도커 잠금 아래, 파일 거르기가 먹는 명령)

- core-svc 폴더에서: `npx vitest run --config vitest.integration.config.mjs test-int/review-purge.int.test.ts test-int/review-recheck.int.test.ts test-int/review-withdrawn.int.test.ts test-int/review-grants.int.test.ts test-int/review.int.test.ts test-int/review-withdrawn-consumer.int.test.ts`(마지막은 Kafka 컨테이너가 필요하다. 네이티브 Kafka 모듈이 이 PC에서 막히면 CI에서만 돈다)
- 싼 게이트: `pnpm --dir D:/ticketpass-lane3-w8b/services/core-svc test`·`typecheck`, 닿는 경로 `npx eslint`, `pnpm --dir D:/ticketpass-lane3-w8b/packages/contracts gen:check`(§0.1의 생성물을 다시 만든 뒤 통과해야 한다), 문서 점검, `node tools/ci/trace-check.mjs --ids "I-T83" --report <보고서>`.

### 4. 틀린 구현 표본(B등급, 21개)

§1의 ⓐ~ⓖ(7개)와 §2의 ⓐ~ⓗ(8개)에 아래 여섯을 더한다. 꼭 넣는 것(개인정보·법정 의무): §1 ⓐⓑⓒⓓ, §2 ⓐⓒⓔ, 아래 ⓘⓚ.

- ⓘ 파기가 `notice`·`notice_until`을 남긴다(통보 가림 정보가 남는다).
- ⓙ 내부 경로가 아직 `/anonymize`를 받거나 `/purge`가 내부 토큰 가드 없이 열린다.
- ⓚ 처리기 로그에 계정 ID를 싣는다.
- ⓛ `withdrawalRecheckAt`이 미래 `withdrawnAt`을 그대로 쓴다(min 없음 → 예약이 늦게 돈다).
- ⓜ 반복이 한 번에 100개를 채워도 곧바로 다시 돌지 않는다(밀린 것을 비우지 못한다).
- ⓝ 예약 표 권한을 `core_partner`에도 주거나 `UPDATE` 칸을 넓게 준다.

겹친 가드(자주 놓친 결함): §2 ⓒ(파기와 예약이 다른 트랜잭션)는 반복이 결국 다시 파기해 가려질 수 있다. `I-T83 ④ 파기와 예약은 한 트랜잭션이다`가 이것만 따로 잡는지 본다.

### 5. 정본 빈칸과 정한 것(이 계획 커밋에 씀)

- (OPEN[42]) identity.md §8을 '후기 파기'로 바꿨다. 파기 칸 목록, 작성자 지우기도 같은 칸(ADR-0086 ⑧ 그대로, 코드가 어긋나 있었다), `rating`·`content_fingerprint` NULL 허용, 살아 있는 행 CHECK `NOT VALID`, 파기 행 CHECK·VALIDATE는 다음 출시(docs/data.md §2 '후기 파기', 추천 적용). 내부 경로 이름 `/purge`(추천 적용). 작성자 표시는 ''(추천 적용).
- (OPEN[44]) 예약 시각 = min(withdrawnAt, 지금) + 16분, 같은 트랜잭션, 소비자 파드의 60초 [가정] 반복, SKIP LOCKED 100개 [가정], 예약 표 칸·권한, 밀린 시간 지표는 정비 보존 지표 `maintenance_retention_overdue_seconds`를 다시 씀(identity.md §8, data.md §2, streaming.md §2.6, data-classification, 추천 적용).
- ASVS catalog-review 14.2.7은 '부분 적용' 그대로이고 빠진 몫을 '보류된 탈퇴 사건(S7)'만 남겼다. 시험 칸은 '미실행' 그대로(구현 뒤 기록 담당이 고친다).
- 결정의 까닭과 버린 대안은 ADR-0278이다.

### 6. OPEN 후보·감독에게 넘길 것

- **OPEN 후보**: 없다. 세 결정은 정본의 방향과 맞고, 위 세부는 모두 추천 적용으로 정했다.
- **구간 끝 정리 목록 후보(기록 담당)**: 보류된 탈퇴 사건(S7, 파기와 예약이 없다), 파기된 후기를 가리키는 신고의 CS 건(지금도 작성자가 지운 후기와 같은 404).
- **막힌 것**: 없다.

### 7. 이 계획 커밋의 게이트(2026-11-16)

- `python -I -X utf8 tools/doc-check/check_all.py`: 오류 0. 경고는 이 커밋 전부터 있던 openapi 셋과 mermaid 건너뜀(이 폴더에 의존성이 없다)이다. 바꾼 `docs/data.md` ER 그림 둘은 메인 폴더 `tools/doc-check/mermaid`의 같은 `parse.mjs`로 따로 읽어 통과했다(한도 50,000자 안).
- `node tools/ci/avro-schema.mjs`: 통과(22개 파일).
- `pnpm --dir packages/contracts gen:check`: 2건 다르다(§0.1). 2a 구현 담당이 다시 만든다.

## 실패 확인

- **누가·언제**: 시험 담당(세션 `l3w8-a2a-test`), 2026-11-16. 가지 `wave/lane3-w8-audit2`, 계획 커밋 `7901c762` 위. Docker 없이 돌렸다.
- **준비**: 이 작업 폴더에는 공용 패키지의 `dist`가 없어 core-svc 시험·typecheck가 `@peaket/search-normalize`·`@peaket/platform/stream-worker`를 찾지 못했다. `pnpm --dir D:/ticketpass-lane3-w8b/packages/<contracts·search-normalize·validation·platform> build`를 한 번씩 돌렸다(git이 무시하는 `dist`만 생긴다). 다른 담당도 그대로 쓰면 된다.

### 뼈대와 모양만 바꾼 제품 코드(동작은 그대로이거나 '아직 없음')

| 파일 | 한 것 | 구현 담당이 할 것 |
| --- | --- | --- |
| `review/domain/review.ts` | `withdrawalRecheckAt` 뼈대('아직 없음'). `ReviewRecord`에 선택 칸 `deletedAtMs?`(처음 지운 시각)를 더함 | 채운다. 상수 `WITHDRAWAL_RECHECK_DELAY_MS`를 더한다. `rating`·`contentFingerprint`를 `number \| null`·`string \| null`로 바꾼다(제품 코드 열다섯 곳 남짓이 함께 바뀌어 시험 담당이 손대지 않았다. 시험은 두 꼴 모두에서 컴파일된다). 메모리·Drizzle 저장소가 `deletedAtMs`를 채운다 |
| `review/domain/ports.ts` | `purgeByAccount`·`purgeWithdrawnAccount`·`runDueRechecks`·`oldestOverdueRecheckMs` 더함 | `anonymizeByAccount`를 뺀다. `softDeleteReview`의 뜻(파기 칸)을 주석에 맞춘다 |
| `review/adapters/memory-review-store.ts` | 예약 칸 `rechecks: Map<계정 ID, { dueAtMs, createdAtMs }>`, 네 메서드 뼈대 | 채운다. `softDeleteReview`를 파기 칸으로(지금 `rating: 0`·`'***'`), `runDueRechecks`는 예약 시각 차례(docs/data.md §5.1 `ORDER BY due_at`) |
| `review/adapters/db/drizzle-review-store.ts` | 네 메서드 뼈대 | 채운다(계획 §1·§2 SQL). `softDeleteReview` 파기 칸, `recordOf`가 `deleted_at`을 옮긴다 |
| `review/application/reviews.ts` | `purgeAccount`·`purgeWithdrawn`·`runWithdrawalRechecks`·`oldestOverdueRecheckMs` 뼈대 | 채우고 `anonymizeAccount`를 뺀다 |
| `review/inbound/account-withdrawn.handler.ts` | 생성자가 `Pick<Reviews, 'purgeWithdrawn'>`를 받음. `handle`은 '아직 없음'(옛 익명화 호출을 뺐다) | 채운다 |
| 새 `src/consumers/review-recheck.ts` | `ReviewRecheckLoopOptions`·`startReviewRecheckLoop` 뼈대(Kafka 모듈을 싣지 않는다) | 채운다 |
| `src/consumers/start.ts` | `CoreConsumersOptions`에 `recheck?`·`recheckEveryMs?`(main.ts가 아직 넘기지 않아 선택 칸) | `recheck`를 필수로 바꾸고 반복을 켠다. `main.ts`가 `recheck: consumerReviews`를 넘긴다 |
| 손대지 않음 | `internal-review.controller.ts`(경로 `/purge`), `schema.ts`, `main.ts`, 마이그레이션 0026·journal | 계획대로 |

### 단위 시험(Docker 없음)

명령: `pnpm --dir D:/ticketpass-lane3-w8b/services/core-svc test`(= core-svc 폴더에서 `npx vitest run`). **시험 458개 가운데 18개 실패, 440개 통과**(파일 69개 가운데 5개 실패). 실패 18개는 모두 이 묶음이 새로 쓰거나 고쳐 쓴 I-T83 시험이고, 그 밖의 기존 시험은 모두 통과했다. `pnpm --dir … typecheck` 오류 0. 닿은 `src` 경로 `npx eslint` 오류 0(시험 파일은 eslint 설정이 보지 않는다).

| 파일 | 시험 | 결과 | 실패 까닭 |
| --- | --- | --- | --- |
| `test/review-withdrawn.test.ts`(고침) | I-T83 ① 탈퇴 사건을 받으면 그 계정 후기를 모두 파기 칸대로 비운다 (COV2-06 ①) | 실패 | 뼈대 '아직 없음'(`handle`). 보이는 것·통보로 가린 것(RIGHTS_TEMP)·2026-11-16 전 작성자가 지운 것(별점·지문이 남은 꼴)·다른 계정 행, 조치 증적·차단 지문을 두고 칸 전부를 정본 값으로 단언한다 |
| 〃 | I-T83 ③ 같은 사건을 다시 받아도 0건이고 행이 그대로다 (COV2-06 ②) | 실패 | 〃 |
| 〃 | I-T83 ③ 내부 파기 경로는 토큰이 없거나 틀리면 403이고 맞으면 파기한 건수를 주며 다시 불러도 0건이다 (COV2-06 ⑨) | 실패 | 단언: `/purge`가 404(경로가 아직 없다). 옛 `/anonymize` 404, 내부 경로가 예약을 만들지 않음도 본다 |
| 〃 | COV2-06 ③④⑤(decode·keyOf, 그대로) | **처음부터 통과(이미 있는 동작)** 3 | 바꾸지 않았다 |
| 새 `test/review-purge.test.ts` | I-T83 ② 파기한 후기는 공연 후기 목록·요약·상세에서 빠진다 | 실패 | 뼈대 '아직 없음'(`purgeWithdrawn`). 처리 전 요약 3건·3.3을 먼저 단언해 대조군을 둔다 |
| 〃 | I-T83 ⑥ 작성자가 지운 후기도 같은 칸을 비운다 | 실패 | 단언: 지금 메모리 `softDeleteReview`가 `rating: 0`·`'***'`를 남기고 지운 시각이 없다 |
| 〃 | I-T83 ③ purgeAccount는 계정 ID가 UUID가 아니면 거절하고 다시 정리 예약을 만들지 않는다 | 실패 | 뼈대 '아직 없음'(422 `review-invalid`가 아님) |
| 새 `test/review-recheck.test.ts` | I-T83 ④ 예약 시각은 min(탈퇴 시각, 처리 시각) + 16분이고 탈퇴 시각을 읽지 못하면 실패한다 | 실패 | 뼈대 '아직 없음'(`withdrawalRecheckAt`) |
| 〃 | I-T83 ④ 탈퇴 사건 처리는 파기와 탈퇴 시각 + 16분 예약을 함께 쓴다 | 실패 | 뼈대 '아직 없음'(`handle`) |
| 〃 | I-T83 ④ 예약 시각 전에는 다시 정리하지 않고 그 시각에 파기한다 | 실패 | 〃 |
| 〃 | I-T83 ④ 탈퇴 시각을 읽지 못하거나 계정 ID가 틀리면 파기도 예약도 하지 않는다 | 실패 | 뼈대 '아직 없음'(대조군 `purgeWithdrawn`). 거절 쪽은 뼈대도 던져 대조군에서 실패한다 |
| 〃 | I-T83 ④ 처리기는 탈퇴 시각을 그대로 넘기고 저장소가 실패하면 함께 실패한다 | 실패 | 뼈대 '아직 없음'(`handle`) |
| 〃 | I-T83 ⑤ 다시 정리 한 번은 기본 100개씩 예약 시각 차례로 처리하고 가장 오래 밀린 시간을 ms로 준다 | 실패 | 뼈대 '아직 없음'(101개 예약, 넘긴 묶음 크기 7) |
| 〃 | I-T83 ⑤ 밀린 시간은 예약 시각 정각에 0이고 1ms 뒤부터 센다 | 실패 | 뼈대 '아직 없음'(`oldestOverdueRecheckMs`) |
| 〃 | I-T83 ⑤ 반복은 밀린 것을 비울 때까지 돌고 실패해도 멈추지 않으며 밀린 시간을 낸다 | 실패 | 뼈대 '아직 없음'(`startReviewRecheckLoop`). 가짜 sleep으로 간격 60,000ms, 묶음 100, 실패 경고 한 줄(Drizzle 오류의 매개변수에 든 계정 ID가 실리지 않음), 지표 90.5초, `stop()` 뒤 호출 없음을 본다 |
| 〃 | I-T83 ⑤ 반복은 받은 간격·묶음 크기를 쓰고 stop은 돌던 한 번이 끝난 뒤에 풀린다 | 실패 | 〃(간격 1,234ms·묶음 7, 상수와 다른 값) |
| 새 `test/review-purge-migration.test.ts` | I-T83 ⑦ 마이그레이션은 별점·지문 NULL을 허용하고 살아 있는 행 CHECK를 NOT VALID로 더하며 권한을 넓히지 않는다 | 실패 | `migrations/0026_*.sql`이 아직 없다 |
| 〃 | I-T83 ⑦ 예약 표 권한은 core_app의 읽기·넣기·지우기·예약 시각 고치기뿐이다 | 실패 | 〃 |
| `test/core-consumers.test.ts`(고침) | I-T83 ⑤ 소비자를 켜면 반복도 켜지고 멈출 때 반복을 먼저 멈춘다 | 실패 | 단언: 2초 안에 반복이 돌지 않는다(`start.ts`가 아직 켜지 않는다). 동작(소비자가 멈추는 동안 반복이 돌지 않음)과 원문(`start.ts`의 `startReviewRecheckLoop(`, 반복 파일에 `stream-worker` 없음, `main.ts`의 `recheck` 값이 처리기의 Reviews와 같은 이름)을 함께 본다 |
| 〃 | COV2-06 K2(처리기 대역을 `purgeWithdrawn`으로, `recheck` 대역을 더함), 나머지 COV2-06 | **처음부터 통과(이미 있는 동작)** | 대역 모양만 바꿨다 |

- 요약: 새로 쓰거나 고쳐 쓴 I-T83 단위 시험 18개 모두 실패(뼈대 '아직 없음' 13, 단언 3, 마이그레이션 파일 없음 2). 처음부터 통과는 손대지 않거나 대역 모양만 바꾼 기존 COV2-06 시험뿐이다.
- `test/review.test.ts`는 고치지 않았다: 계획 §0.2의 '작성자 지우기 뒤 `'***'` 단언'은 이 파일에 없다(`maskAuthor(undefined)`의 `'***'`는 쓰기 때의 작성자 표시라 그대로다). `test/review.http.test.ts`의 '지운 뒤 같은 회차에 다시 쓸 수 있다'도 파기 뒤에 그대로 맞다.

### 통합 시험(도커 대기 — 돌리지 않았다)

돌릴 통합 시험(core-svc 폴더, 감독이 Docker 차례를 알린 뒤): `npx vitest run --config vitest.integration.config.mjs test-int/review-purge.int.test.ts test-int/review-recheck.int.test.ts test-int/review-withdrawn.int.test.ts test-int/review-grants.int.test.ts test-int/review.int.test.ts test-int/review-withdrawn-consumer.int.test.ts`(마지막 파일은 Kafka 컨테이너. 네이티브 Kafka 모듈이 이 PC에서 막히면 CI에서만 돈다). 파일 하나만은 `npx vitest run --config vitest.integration.config.mjs <파일>`.

| 파일 | 시험 | 지금(구현 전) 예상 | 까닭 |
| --- | --- | --- | --- |
| `test-int/review-withdrawn.int.test.ts`(고침) | I-T83 ①⑥ Drizzle 파기는 그 계정 행만 바꾸고 다시 해도 0건이다 (COV2-06 ⑪) | 실패 | 뼈대 '아직 없음'(`purgeByAccount`). A 행 셋(보이는 것·통보로 가린 것·이미 지운 것 — 계획의 2건에 이미 지운 행을 더해 3건)·B 행, `takedown_action`·`review_hidden_fingerprint` 행 그대로, 지운 시각 그대로, 같은 회차 새 후기 넣기 |
| 〃 | I-T83 ① 탈퇴 파기는 review_account_idx로 찾는다 (COV2-06 K2) | 처음부터 통과 예상 | 실행 계획만 본다(파기 문장으로 바꿈) |
| 새 `test-int/review-purge.int.test.ts` | I-T83 ⑥ 작성자가 지운 후기도 같은 칸을 비우고 같은 회차에 다시 쓸 수 있다 | 실패 | 단언: 지금 Drizzle 지우기가 별점·지문·계정을 남긴다. 서비스는 `core_app` 로그인·실제 시계라 지운 시각은 요청 앞뒤의 실제 시각과 견준다(고정 날짜 없음) |
| 〃 | I-T83 ⑦ 살아 있는 후기는 별점·지문 없이 넣을 수 없다 | 실패 | 0026 전에는 NOT NULL 위반(23502)이라 23514가 아니다. `convalidated = false`(NOT VALID)도 본다 |
| 새 `test-int/review-recheck.int.test.ts` | I-T83 ④ 파기와 예약은 한 트랜잭션이다 / ④ 같은 계정 예약은 늦은 쪽을 남긴다 / ⑤ 다른 연결이 잠근 예약은 건너뛰고 기다리지 않는다 / ⑤ 두 반복이 겹쳐도 한 예약은 한 번만 잡고 처리한 예약은 지운다 / ⑤ 가장 오래 밀린 예약의 지난 시간을 ms로 준다 / ⑦ 예약 표 권한은 core_app의 읽기·넣기·지우기·예약 시각 고치기뿐이다 | 실패 6 | `beforeEach`의 예약 표 비우기가 42P01(표 없음). ④는 `REVOKE INSERT` 동안 거절 1건(42501)과 후기 VISIBLE을 단언한다(끊긴 사례가 실제로 있었는지). ⑤ 겹침은 두 풀 동시 실행(합 3)에 더해, 관리자 연결이 한 행을 `FOR UPDATE`로 쥔 채 3초 안에 나머지 둘만 처리하는지로 SKIP LOCKED를 따로 잡는다(동시 실행만으로는 차례에 따라 빠짐이 숨는다). 예약 경계는 정각(때가 됨)·+1ms(아직). ⑦은 `core_partner`·`core_maintenance`·`core_ops` 각각의 거부와 `core_app`의 `account_id`·`created_at` 고치기·비우기 거부를 본다 |
| `test-int/review-grants.int.test.ts`(더함) | I-T83 ⑥ core_app은 파기 칸(별점·지문 NULL 포함)을 한 문장으로 비울 수 있다 | 실패 | 0026 전 23502. COV2-06 ⑮⑯은 처음부터 통과 예상 |
| `test-int/review.int.test.ts` | 기존 다섯 | 처음부터 통과 예상 | 바꾸지 않았다 |
| `test-int/review-withdrawn-consumer.int.test.ts`(고침) | I-T83 ① 실제 Kafka의 탈퇴 사건이 core 후기를 파기하고, 읽지 못한 사건은 pid 없이 held_event에 보류된다 (COV2-06 ⑫) | 실패 | 뼈대 '아직 없음'(`handle`) → 다섯 번 뒤 보류, 파기 기다림이 60초에 끝난다. 예약 행 due_at = 탈퇴 시각 + 16분도 본다 |
| 〃 | I-T83 ④ 실제 Kafka 탈퇴 사건 뒤 예약 행이 생기고 반복이 그 시각에 다시 파기한다 | 실패 | 〃. 소비자는 `recheck: reviews`·`recheckEveryMs: 200`으로 켠다. 기준 시각은 소비자·반복이 쓰는 실제 시계(`Date.now()`)이고, 예약을 지금 + 20초로 두어 사건 처리가 먼저 끝나게 했다(계획의 + 2초보다 여유를 둠). 예약 전 1초 동안 새 후기가 남고, 예약 뒤 3초 안에 파기·예약 지움, 다시 파기한 시각 ≥ 예약 시각 |

### 시험 담당이 정한 것(계획에 없던 세부, 구현 담당·검증 담당 참고)

1. `ReviewRecord.deletedAtMs?`를 더했다. 단위 ①의 '이미 지운 행의 지운 시각은 처음 값 그대로'를 메모리 저장소에서 보려면 필요하다.
2. 메모리 저장소 예약 칸의 모양은 `rechecks: Map<계정 ID, { dueAtMs, createdAtMs }>`이고, 첫 예약의 `createdAtMs`는 처리 시각이다(같은 계정 예약을 고칠 때 `createdAtMs`는 단언하지 않는다).
3. 처리기는 `purgeWithdrawn`에 `{ accountId, withdrawnAt }` 두 칸만 넘기고(사건의 탈퇴 시각 그대로), 로그 객체에 `eventKey`와 `purged` 수를 싣는다(계정 ID 없음).
4. 반복: 시작하자마자 한 번 돈다(첫 쉼 없음). `runWithdrawalRechecks(limit)`에 묶음 크기를 넘긴다. 곧바로 다시 도는 자리의 `sleep(0)`은 세지 않는다. 지표 값은 `oldestOverdueRecheckMs / 1000`(초)이다. `stop()`은 돌던 한 번이 끝난 뒤에 풀린다(소비자 멈춤·풀 닫기 전에 반복이 끝나야 한다).
5. 마이그레이션 원문 시험은 0026의 문을 계획의 여섯 꼴(별점·지문 NOT NULL 풀기, 살아 있는 행 CHECK, 예약 표, 예약 시각 색인, GRANT)로만 허락한다. CHECK 식은 괄호·공백·표 이름 접두를 지우고 견준다(괄호 위치의 뜻은 통합 ⑦이 본다). 뜻이 같은 다른 글로 쓰면 '시험 이의'로 알려 달라.
6. 시험 위치: '⑤ 소비자를 켜면 반복도 켜지고…'는 Kafka 모듈 대역(`vi.mock`)이 있는 `test/core-consumers.test.ts`에 두었다. 옛 COV2-06 ①②⑨·⑪·⑫는 I-T83 시험으로 바꾸면서 이름 끝에 `(COV2-06 ①)`처럼 옛 번호를 남겼다(장부의 옛 세부가 이어지게).

### 틀린 구현 표본과 잡을 시험(예상, 검증 담당 참고)

- §1 ⓐ 별점·지문 남김 → 단위 ①·⑥, 통합 ①⑥·⑥. ⓑ 상태 그대로 → 단위 ①·②. ⓒ `where` 빠짐·`id`로 찾음 → 단위 ①(B 행 그대로), 통합 ①⑥. ⓓ DELETED 건너뜀 → 단위 ①·통합 ①⑥의 이미 지운 행. ⓔ 지운 시각 덮음 → 같은 행의 `deletedAtMs`·`deleted_at`. ⓕ 작성자 지우기 옛 칸 → 단위·통합 ⑥. ⓖ 옛 익명화 호출 → 단위 ①.
- §2 ⓐ 처리 시각 기준 → 단위 ④(03:16 대 03:19). ⓑ 15분·`<` → 단위 ④ 경계 정각, 통합 ⑤ 정각 예약. ⓒ 다른 트랜잭션 → 통합 ④ 한 트랜잭션(반복이 가리는 겹친 가드를 이것만 따로 잡는다). ⓓ 이른 시각으로 덮음 → 단위 ④·통합 ④ 늦은 쪽. ⓔ 예약 안 지움 → 단위 ④·⑤, 통합 ⑤. ⓕ SKIP LOCKED 빠짐 → 통합 ⑤ 잠근 행 건너뛰기. ⓖ 실패하면 멈춤 → 단위 ⑤ 반복. ⓗ 반복 안 켬 → 단위 ⑤ 시작과 멈춤, Kafka 통합 ④.
- §4 ⓘ notice 남김 → 단위 ①·⑥. ⓙ `/anonymize` 남음·가드 없음 → 단위 ③ 내부 경로. ⓚ 로그에 계정 ID → 단위 ①·④ 처리기. ⓛ min 없음 → 단위 ④ 미래 탈퇴 시각. ⓜ 100개 채워도 쉼 → 단위 ⑤ 반복. ⓝ 다른 역할 권한·넓은 UPDATE → 단위 ⑦ 원문, 통합 ⑦.

## 시험 이의

- **누가·언제**: 구현 담당(세션 `l3w8-a2a-impl`), 2026-11-16. 시험 파일은 고치지 않았다.

### 이의 1. 시험 두 파일이 `contentFingerprint: string | null`에서 컴파일되지 않는다(typecheck 오류 4, 실행은 통과)

- 계획 '공개 인터페이스'대로 `ReviewRecord.rating`을 `number | null`, `contentFingerprint`를 `string | null`로 바꾸자 `pnpm --dir services/core-svc typecheck`가 **시험 파일에서만** 오류 4건을 낸다(제품 코드 오류 0). 실패 확인 절의 '시험은 두 꼴 모두에서 컴파일된다'는 별점에만 맞고 내용 지문에는 맞지 않다. vitest는 타입을 보지 않아 단위 시험 458개는 모두 통과한다.
  - `test/review-withdrawn.test.ts:135` `TakedownRecord.contentFingerprint`(string)에 `a2.contentFingerprint`(string | null)를 넣는다.
  - `test/review-withdrawn.test.ts:137` `store.addHiddenFingerprint(a1.contentFingerprint, …)`
  - `test/review-withdrawn.test.ts:162` `store.hasHiddenFingerprint(a1.contentFingerprint)`
  - `test/review.test.ts:84`(이 묶음 전부터 있던 시험) `TakedownRecord.contentFingerprint`에 `r.contentFingerprint`를 넣는다.
- 제품 쪽에서 맞추지 않은 까닭: 조치 증적 `takedown_action.content_fingerprint`와 차단 목록 `review_hidden_fingerprint.fingerprint`는 DB에서 NOT NULL이라 `TakedownRecord`·지문 포트를 null 허용으로 넓히면 틀린 모양이 된다. `ReviewRecord.contentFingerprint`를 `string`으로 두면 파기 행의 런타임 null과 타입이 어긋난다.
- 고칠 길(시험 담당 몫): 네 자리에서 살아 있는 후기의 지문임을 밝힌다(예 `a2.contentFingerprint!`, 또는 시험 도움 함수 `review()`·`record()`가 만든 값을 지문 변수로 따로 둔다). 단언 값은 바뀌지 않는다.

### 구현 담당이 정한 것(계획에 없던 세부, 검증·리뷰 참고)

1. **잠금 차례**: Drizzle `purgeWithdrawnAccount`는 계획 §2의 '파기 update → 예약 insert' 대신 **예약 upsert → 파기 update** 차례로 쓴다. 다시 정리 반복(`runDueRechecks`)도 예약 행(`FOR UPDATE SKIP LOCKED`) → 후기 차례로 잠가, 같은 계정의 사건 다시 받기와 예약 처리가 겹쳐도 교착(40P01)이 나지 않게 했다. 한 트랜잭션이라는 성질과 REVOKE INSERT 시험(④)의 결과는 같다.
2. **0026 journal**: `idx` 26, `when` 1794811994338(drizzle-kit이 만든 값, 2026-11-16T06:53Z, develop 마지막 0022의 1794789168699보다 크다). 스냅숏 `meta/0026_snapshot.json`의 `prevId`는 0022 스냅숏 ID다. drizzle-kit이 만든 SQL을 0026으로 옮기고 CHECK에 `NOT VALID`, 예약 표 GRANT, 주석을 손으로 더했다. 다시 `db:generate`하면 '바뀐 것 없음'이다. 갈래 2의 0023 등과 합칠 때 journal 차례는 감독이 맞춘다(`when`이 뒤 번호보다 작아지지 않게).
3. **밀린 시간 지표**: 반복은 정비 보존 지표 이름 `maintenance_retention_overdue_seconds`를 받은 지표 저장소에 이미 있으면 다시 쓰고, 없으면 platform `maintenanceMetrics`와 같은 이름·도움말·칸으로 만든다. main.ts에서는 API 파드의 `/metrics`(소비자 지표와 같은 저장소)에 실린다. 다른 표의 같은 지표는 relay 프로세스가 낸다(경보 규칙은 이름·`table` 칸으로 걸리므로 그대로 잡힌다고 보았다).
4. **반복 실패 경고**: 오류는 platform `errorSummary`로 요약한다(Drizzle 쿼리 오류는 쿼리 틀과 DB 오류 코드만, 매개변수의 계정 ID 없음). 한 번 돌 때 경고는 한 줄이다(지표 읽기 실패도 같은 줄). 잡은 예약이 있으면 info 한 줄(`accounts`·`purged` 수만)을 낸다.
5. **`withdrawalRecheckAt`**: 계약 date-time 모양(시간대 표기 필수)을 먼저 보고 `Date.parse`한다(날짜만 있는 글을 받지 않는다). 오류 글에 값을 싣지 않는다.
6. **살아 있는 후기의 지문·별점**: 신고·조치·CS 상세(`report`·`moderate`·`reportedReview`)는 별점·지문이 null이면 없는 후기(404)로 본다(살아 있는 행은 `review_live_complete_check`가 막아 실제로는 오지 않는다). 공개 모양(`reviewView`)은 null 별점을 싣지 않는다.

### 정본 빈칸

- 없다(위 세부는 코드 몫이다). 3의 지표가 API 파드에서 나는 것은 docs/observability.md 운영 확인 '정비 잡' 행이 relay 프로세스만 적었다면 한 줄 보탤 거리다(이 묶음에서는 고치지 않았다, 기록 담당 판단).

### 돌릴 통합 시험(감독이 Docker 차례를 알린 뒤, core-svc 폴더)

- `npx vitest run --config vitest.integration.config.mjs test-int/review-purge.int.test.ts test-int/review-recheck.int.test.ts test-int/review-withdrawn.int.test.ts test-int/review-grants.int.test.ts test-int/review.int.test.ts test-int/review-withdrawn-consumer.int.test.ts`(마지막 파일은 Kafka 컨테이너. 네이티브 Kafka 모듈이 이 PC에서 막히면 CI에서만 돈다)

## 시험 이의 답

- **누가·언제**: 시험 담당(세션 `l3w8-a2a-test`), 2026-11-16. 구현 커밋 `7f32f584`·이의 커밋 `a450164a` 위.

### 이의 1에 대한 답: 맞다. 시험 쪽만 고쳤다

- 실패 확인 절의 '시험은 두 꼴 모두에서 컴파일된다'는 별점에만 맞았다. 조치 증적(`TakedownRecord.contentFingerprint`)과 차단 목록 지문 포트(`addHiddenFingerprint`·`hasHiddenFingerprint`)는 DB에서 NOT NULL이라 `string`으로 두는 것이 맞고, 시험이 `ReviewRecord.contentFingerprint`(이제 `string | null`)를 거기에 그대로 넣은 것이 잘못이다. 제품 타입은 넓히지 않는다(구현 담당 판단에 동의).
- 고친 곳(살아 있는 후기의 지문을 본문에서 따로 만든다. 값은 전과 같고 단언은 바꾸지 않았다):
  - `test/review-withdrawn.test.ts` I-T83 ①: `a2Fingerprint = contentFingerprint(hiddenBody)`(a2 만들기·조치 증적에 씀), `a1Fingerprint = contentFingerprint(a1.body)`(차단 목록 넣기와 `hasHiddenFingerprint` 단언의 인자). `expect` 줄은 인자 이름만 바뀌었다.
  - `test/review.test.ts` '끝 시각이 지난 임시조치는…': 조치 증적 지문을 `contentFingerprint(r.body)`로(`record()`가 넣은 값과 같다).
- 돌린 것: `pnpm --dir D:/ticketpass-lane3-w8b/services/core-svc typecheck` 오류 0. `pnpm --dir D:/ticketpass-lane3-w8b/services/core-svc test` 시험 458개 모두 통과(파일 69개).
