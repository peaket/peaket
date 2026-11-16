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

### 8. 리뷰 반영(2026-11-16, 대조 리뷰 `737f3960`의 A1·A2·A3)

- **차례**: 리뷰 반영이다. 지적마다 시험 담당이 먼저 시험을 쓰고 실패를 본다(`Role: review-fix`, `Fix-By: test`, `Finding: A1`·`A2`·`A3`). 그다음 구현 담당이 고친다(`Fix-By: impl`, 같은 `Finding`). A3은 시험만이다. 새 마이그레이션 번호는 쓰지 않는다. A2의 권한은 아직 develop에 없는 **0026**에 더한다.
- **정본(이 계획 커밋에 먼저 씀, 추천 적용 2026-11-16)**: docs/observability.md 운영 확인 표의 '탈퇴 후기 다시 정리' 새 행과 '정비 잡' 행의 한 줄(A1), docs/features/identity.md §10.1 운영 확인 '탈퇴 후기 파기와 다시 정리' 새 행(A1·A2), §8 '이전 판이 남긴 행'(A2), §12 I-T83 ⑤ 보탬(A1)·⑧ 새로(A2), docs/data.md §2 '후기 표의 DB 권한'의 `core_maintenance` 권한과 '후기 파기'의 '이전 판이 남긴 행 고치기'(A2), §6 '탈퇴 후기 다시 정리 예약' 행(A1), docs/streaming.md §2.6(A1), docs/security/data-classification.md '탈퇴 후기 다시 정리 예약' 행(A1), ADR-0278 결정 1·2에 한 줄씩.

#### 8.1 A1 다시 정리 반복이 실패해도 밀린 시간이 보이고 실패가 세진다

**무엇이 틀렸나(리뷰)**: `startReviewRecheckLoop`가 밀린 시간 지표를 `runWithdrawalRechecks`가 성공했을 때만 고친다. 반복이 계속 실패하면 지표가 마지막 값(보통 0)에 머물러 'SEV2 legal'이 울리지 않고, 실패 수·마지막 성공 시각 지표도 없다.

**정한 것(정본 docs/observability.md 운영 확인 '탈퇴 후기 다시 정리' 행)**: 한 번 돌 때마다 성공·실패와 관계없이 `oldestOverdueRecheckMs`를 따로 읽어 `maintenance_retention_overdue_seconds{service="core-svc",table="review_withdrawal_recheck"}`를 고친다(그 읽기도 실패하면 그대로). 실패한 한 번마다 `review_withdrawal_recheck_failures_total{service}`가 1 는다. 성공한 한 번마다 `review_withdrawal_recheck_last_success_timestamp_seconds{service}`를 그때 시각(초)으로 둔다. 경보는 밀린 시간 5일 [가정] 넘음 SEV2, 모든 파드의 마지막 성공이 30분 [가정] 넘게 없음 SEV3(둘 다 `kind` legal).

| 나눔 | 파일 |
| --- | --- |
| 제품 코드 | `services/core-svc/src/consumers/review-recheck.ts`(실패 경로의 지표, 새 지표 둘, `clock` 옵션) |
| 시험 | 고침: `services/core-svc/test/review-recheck.test.ts`(I-T83 ⑤ 반복 시험에 더함) |

```ts
// services/core-svc/src/consumers/review-recheck.ts(바뀌는 곳만)
export interface ReviewRecheckLoopOptions {
  // … 지금 칸 …
  /** 마지막 성공 시각에 쓴다. 기본 systemClock */
  clock?: { now(): number };
}
// registry가 있으면: maintenance_retention_overdue_seconds{service,table}(지금 것), review_withdrawal_recheck_failures_total{service}(카운터),
// review_withdrawal_recheck_last_success_timestamp_seconds{service}(게이지, 유닉스 초). 같은 이름이 이미 등록부에 있으면 그것을 쓴다
```

| 시험 이름 | 단계 | 단언(정본 값) | 비고 |
| --- | --- | --- | --- |
| `I-T83 ⑤ 반복이 실패해도 밀린 시간 지표를 새 값으로 고치고 실패 수를 센다` | 단위 | 대역 `reviews`: 첫 호출 성공(`oldestOverdueRecheckMs` 0) → 지표 0, 마지막 성공 = 가짜 시계 `1_794_000_000_000`ms → `1794000000`. 둘째 `runWithdrawalRechecks`가 던지고 `oldestOverdueRecheckMs`는 `432_000_001`(5일 + 1ms) → 밀린 시간 지표 `432000.001`, 실패 수 1, 마지막 성공은 그대로 `1794000000`. 셋째는 둘 다 던짐 → 밀린 시간 그대로 `432000.001`, 실패 수 2. 경고 줄 글에 계정 ID 모양(UUID) 글자가 없다 | 시간 값은 상수(60초·100개)와 다르게 |
| `I-T83 ⑤ 같은 등록부에 반복을 두 번 켜도 지표를 새로 만들다 실패하지 않는다` | 단위 | 같은 `Registry`로 `startReviewRecheckLoop`를 두 번 → 던지지 않고, 지표 이름마다 등록이 하나 | 지금 밀린 시간 지표가 하는 것과 같게 |

**틀린 구현 표본(A1)**: ⓐ 실패 경로에서 밀린 시간을 고치지 않음(지금 결함) ⓑ 실패 경로에서 밀린 시간을 0으로 둠 ⓒ 실패 수를 성공 때도 올림 ⓓ 실패 때 마지막 성공 시각을 고침 ⓔ 밀린 시간 읽기가 던지면 반복이 멈춤.

#### 8.2 A2 이전 판이 남긴 행을 파기 칸으로 고친다

**무엇이 빠졌나(리뷰)**: 이 출시 전과 배포 창 동안 이전 판의 작성자 지우기가 남긴 DELETED 행(별점·지문·계정 ID가 남음)과, 이전 판 소비자의 옛 익명화가 처리한 탈퇴 계정 후기(`account_id = id`, '탈퇴한 사용자', VISIBLE)를 파기 칸으로 고치는 길이 없다. 새 코드는 둘째 꼴을 계정 ID로 찾지 못하고, 다음 출시의 파기 행 CHECK `VALIDATE`는 첫째 꼴 하나만 있어도 실패한다.

**정한 것(정본 docs/data.md §2 '후기 파기'의 '이전 판이 남긴 행 고치기')**: 0026 안의 한 번짜리 UPDATE가 아니라 core-svc 정비 일 **`review-purge-legacy`**(정비 시간, `when: 'window'`, 정비 역할 `core_maintenance`)로 한다. 마이그레이션은 배포를 시작할 때 한 번 돌아 배포 창·되돌리기 동안 생긴 행을 놓치고, 한 트랜잭션에서 표 전체를 고치면 지운 행을 오래 잠근다. 대상은 `(status = 'DELETED' AND (rating IS NOT NULL OR content_fingerprint IS NOT NULL OR account_id <> id)) OR (status <> 'DELETED' AND account_id = id)`이고, `id` 순 커서로 1,000행 [가정]씩 `FOR UPDATE SKIP LOCKED`로 잡아 지금 파기 칸(`purgeSet`)으로 고치며 묶음마다 커밋한다(잠금 대기 2초 [가정], 멈춤 신호는 묶음 사이). 차례는 0026 → 배포 창 뒤 첫 정비 시간의 정비 일 → 정비 일이 0행을 보고한 뒤 다음 출시 마이그레이션(파기 행 CHECK → 두 CHECK `VALIDATE`) → 정비 일 지우기다.

| 나눔 | 파일 |
| --- | --- |
| 제품 코드 | `services/core-svc/src/modules/review/domain/ports.ts`(`purgeLegacyRows`), `…/review/adapters/db/drizzle-review-store.ts`(같은 `purgeSet`을 쓴다), `…/review/adapters/memory-review-store.ts`, `…/review/application/review-maintenance.ts`(새 정비 일), `services/core-svc/src/maintenance-tasks.ts`(`CORE_MAINTENANCE_TASK_NAMES`에 `review-purge-legacy`) |
| 마이그레이션 | **0026에 더함**(새 번호 없음): `GRANT SELECT ("rating", "content_fingerprint", "account_id", "deleted_at") ON "review" TO core_maintenance;`, `GRANT UPDATE ("body", "rating", "content_fingerprint", "author_display", "account_id", "basis_order_id", "deleted_at") ON "review" TO core_maintenance;`(지금의 `id`·`status`·`notice`·`notice_until` 읽기와 `status`·`notice`·`notice_until`·`updated_at` 고치기는 0022 그대로). `body` 읽기는 주지 않는다. 권한만이라 스냅숏은 바뀌지 않는다 |
| 시험 | 새로: `services/core-svc/test/review-purge-legacy.test.ts`(단위), `test-int/review-purge-legacy.int.test.ts`(PostgreSQL). 고침: `test/review-purge-migration.test.ts`(0026 원문), `test-int/review-grants.int.test.ts`(정비 역할 거부 쪽) |

```ts
// services/core-svc/src/modules/review/domain/ports.ts
export interface ReviewStore {
  /**
   * 이전 판이 남긴 두 꼴(docs/data.md §2 '이전 판이 남긴 행 고치기')을 id가 after보다 큰 것부터 limit개 잡아 파기 칸으로 고친다(한 트랜잭션, SKIP LOCKED).
   * 고친 행 수와 마지막으로 본 id(다음 묶음의 커서, 없으면 undefined)
   */
  purgeLegacyRows(o: { nowMs: number; limit: number; after?: string }): Promise<{ purged: number; last?: string }>;
}

// services/core-svc/src/modules/review/application/review-maintenance.ts
/** reviewMaintenanceTasks(store, clock, o?: { batch?: number })(batch 기본 1,000 [가정])에 { name: 'review-purge-legacy', when: 'window', run(signal) } 를 더한다.
 *  run: last가 없을 때까지(또는 signal 끊김) purgeLegacyRows를 이어 부르고 { purged: 합 }을 돌려준다. 묶음 사이에 signal을 본다 */
```

| 시험 이름 | 단계 | 단언(정본 값) | 비고 |
| --- | --- | --- | --- |
| `I-T83 ⑧ 정비 일은 이전 판이 남긴 두 꼴만 파기 칸으로 고친다` | 단위(메모리) | 행 다섯: ⓐ DELETED·별점 4·지문·계정 A(옛 작성자 지우기) ⓑ VISIBLE·`accountId` = 후기 ID·'탈퇴한 사용자'(옛 익명화) ⓒ HIDDEN·`accountId` = 후기 ID(옛 익명화) ⓓ 제대로 파기된 DELETED ⓔ 계정 B의 VISIBLE. 정비 일 한 번 → `{ purged: 3 }`, ⓐⓑⓒ가 ①의 칸(ⓐ의 지운 시각은 처음 값), ⓓⓔ는 갱신 시각까지 그대로 | 집계: ⓑ가 요약에서 빠진다 |
| `I-T83 ⑧ 정비 일을 다시 돌리면 0행이고 묶음 경계에서 빠지는 행이 없다` | 단위 | `batch` 2, 이전 판 행 다섯(id 차례가 섞이게) → 묶음 셋으로 `{ purged: 5 }`. 둘째 실행 `{ purged: 0 }`. 첫 묶음 뒤 signal을 끊으면 `{ purged: 2 }`에서 멈추고 다음 실행이 나머지 3을 고친다 | 다시 해도 같음·경계 |
| `I-T83 ⑧ 정비 일은 정비 시간 일이고 정비 일 목록에 있다` | 단위 | `when` `'window'`, `CORE_MAINTENANCE_TASK_NAMES`에 `'review-purge-legacy'` | |
| `I-T83 ⑧ 정비 역할로 이전 판 행을 고치고 그 뒤 파기 행 CHECK를 VALIDATE할 수 있다` | 통합(core PostgreSQL, `core_maintenance` 로그인) | 관리자 연결로 0026 전 모양의 행(DELETED에 별점·지문·계정, VISIBLE에 `account_id = id`)을 넣고 정비 일 실행 → 행 칸이 ①과 같다. 그다음 관리자 연결의 트랜잭션에서 파기 행 CHECK(docs/data.md §2 '마이그레이션 나눔'의 글)를 `NOT VALID`로 더하고 `VALIDATE CONSTRAINT` 두 개가 성공한 뒤 되돌린다. 정비 일 전에 같은 VALIDATE는 23514로 실패한다 | 다음 출시의 전제 |
| `I-T83 ⑦⑧ 0026은 정비 역할에 본문 읽기를 주지 않는다` | 단위(SQL 원문) + 통합 | 원문: 위 두 GRANT 줄이 있고 `core_maintenance`에 `"body"` SELECT·표 전체 SELECT·INSERT·DELETE가 없다. 통합: `core_maintenance`로 `SELECT body FROM review` 42501, `INSERT INTO review` 42501 | 최소 권한 |

**틀린 구현 표본(A2)**: ⓐ 정비 일이 둘째 꼴(`account_id = id`인 살아 있는 후기)을 빠뜨림 ⓑ 첫째 꼴을 `rating IS NOT NULL`만으로 찾음(지문·계정만 남은 행을 놓침) ⓒ 커서를 `>=`로 둬 같은 행을 다시 잡거나 `limit`만 보고 커서 없이 처음부터 다시 읽음(끝나지 않음) ⓓ 제대로 파기된 행의 `updated_at`도 고침 ⓔ `deleted_at`을 지금으로 덮음 ⓕ `when: 'daily'`로 둠(정비 시간 밖에 큰 표를 훑는다) ⓖ 0026이 정비 역할에 표 전체 UPDATE를 줌.

#### 8.3 A3 한 트랜잭션 시험의 반대 방향(시험만)

**무엇이 빠졌나(리뷰)**: 구현이 차례를 '예약 upsert → 파기'로 바꿔(교착을 피하려는 것, 맞다), 지금 `I-T83 ④ 파기와 예약은 한 트랜잭션이다`는 첫 문장(예약)을 막는 쪽만 본다. 두 문장을 따로 자동 커밋하는 틀린 구현(예약 먼저)이 통과한다.

| 시험 이름 | 단계 | 단언(정본 값) | 비고 |
| --- | --- | --- | --- |
| `I-T83 ④ 파기가 실패하면 다시 정리 예약도 남지 않는다` | 통합(core PostgreSQL, `core_app`) | 관리자 연결로 `REVOKE UPDATE ("rating") ON review FROM core_app`을 잠시 건다 → `purgeWithdrawnAccount` 거절(42501) 1건, 그 계정의 `review_withdrawal_recheck` 행 0, 후기는 VISIBLE 그대로. 권한을 돌린 뒤 다시 하면 파기와 예약이 둘 다 있다 | 고침: `test-int/review-recheck.int.test.ts`. 제품 코드는 바꾸지 않는다(처음부터 통과 예상) |

**검증 담당 참고**: §2 ⓒ(파기와 예약이 다른 트랜잭션)를 두 차례(파기 먼저 따로 커밋, 예약 먼저 따로 커밋) 모두로 만들어 위 두 시험이 각각 하나씩 잡는지 본다.

#### 8.4 돌릴 통합 시험(리뷰 반영)

- core-svc 폴더에서: `npx vitest run --config vitest.integration.config.mjs test-int/review-purge-legacy.int.test.ts test-int/review-recheck.int.test.ts test-int/review-grants.int.test.ts`
- 싼 게이트: `pnpm --dir D:/ticketpass-lane3-w8b/services/core-svc test`·`typecheck`, 닿는 경로 `npx eslint`, 문서 점검.

### 9. 웨이브 끝 리뷰 반영(2026-11-16, 보안 `aefcc434` S1, 정확성 `4ee414de` C1·C2)

- **차례**: 리뷰 반영이다. 지적마다 시험 담당이 먼저 시험을 쓰고 실패를 본다(`Role: review-fix`, `Fix-By: test`, `Finding: S1`·`C1`·`C2`). 그다음 구현 담당이 고친다(`Fix-By: impl`, 같은 `Finding`). 새 마이그레이션 번호는 쓰지 않는다. S1의 권한은 아직 develop에 없는 **0026**에 더한다.
- **정본(이 계획 커밋에 먼저 씀, 추천 적용 2026-11-16)**: docs/features/identity.md §8 '부르는 길'·'손으로 처리'(S1)·'다시 정리'(C1)·§12 I-T83 ④(C1)·⑧(C2)·⑨ 새로(S1), docs/data.md §2 '후기 표의 DB 권한'(S1의 `held_event` 권한, S2 한계)·'이전 판이 남긴 행 고치기'(C2)·§4의 15 'DB 권한'(S1)·§6 '관람 후기'(16분), docs/security/asvs/catalog-review.md v5.0.0-8.2.1·16.2.1(S1), docs/security/data-classification.md '관람 후기'(보안 리뷰 S3의 15분 → 16분), ADR-0278 결정 1·2.
- **이번에 넣지 않는 것(감독이 정리 목록에 적음)**: 동시 실행 K1·K2·K3, 보안 S2. **S2 판단**: 이번에 넣지 않는다. 0026은 정비 역할에 칸 일곱의 고치기만 주고 본문 읽기는 주지 않는다. 이 역할은 relay 프로세스의 정비 연결만 쓰는 사람 아닌 역할이고, 이미 후기 상태·통보 칸을 고칠 수 있다(임시조치 끝내기). 칸 권한이 값을 묶지 못하는 것은 최소 권한을 크게 어기는 것이 아니라 한계라고 본다. 다음 출시의 파기 행 CHECK가 지운 행의 모양을 묶으므로, 정의자 권한 함수로 좁히는 일은 그때 함께 다시 본다(docs/data.md §2에 한계를 적었다).

#### 9.1 S1 손으로 하는 파기는 보류된 탈퇴 사건이 있는 계정만, 요청자·사유를 남기고

**무엇이 틀렸나(리뷰)**: 내부 `POST /internal/v1/reviews/accounts/{accountId}/purge`는 내부 토큰만 맞으면 어떤 계정이든 후기를 되돌릴 수 없게 파기하고, 누가 왜 불렀는지 남기지 않는다. 내부 토큰은 여러 서비스가 같은 값을 쓴다. 이 경로를 부르는 운영 도구·런북은 아직 없다(저장소 전체를 찾아 확인).

**정한 것(정본 docs/features/identity.md §8 '손으로 처리')**: 경로는 남기되(보류된 탈퇴 사건을 손으로 처리하는 유일한 길이다) 이렇게 좁힌다.
- 본문 `{ reason: string(10~500자), requestedBy: string(1~64자) }`. 모양이 틀리면 400.
- core DB `held_event`에 그 계정의 보류된 탈퇴 사건(토픽 `identity.accounts-withdrawn`, `lower(business_key)` 또는 `lower(msg_key)`가 그 계정 ID, `reprocessed_at IS NULL`)이 하나 이상 있을 때만 한다. 없으면 409 `withdrawal-not-held`이고 아무것도 바꾸지 않는다.
- 한 `core_app` 트랜잭션: 그 보류 행들을 `FOR UPDATE`로 잠근다 → 다시 정리 예약을 쓴다(처리 시각 + 16분, 같은 계정이 있으면 늦은 쪽, 지금 차례처럼 예약 먼저) → 파기한다(`purgeSet`) → 보류 행에 `reprocessed_at = 지금`을 적는다.
- 응답 200 `{ purged, heldEvents }`. 커밋한 뒤 운영 줄 `kind` `review-purge-manual`에 `requestedBy`·`reason`·처리한 보류 사건의 `eventKey` 목록·`purged`를 남긴다(계정 ID 없음).
- 0026에 더함: `GRANT UPDATE ("reprocessed_at") ON "held_event" TO core_app;`(`core_app`의 `held_event` 읽기·넣기는 0022 그대로).

| 나눔 | 파일 |
| --- | --- |
| 제품 코드 | `services/core-svc/src/modules/review/inbound/internal-review.controller.ts`(본문·409), `…/review/application/reviews.ts`(`purgeAccount` → `purgeHeldWithdrawal`), `…/review/domain/ports.ts`, `…/review/adapters/db/drizzle-review-store.ts`, `…/review/adapters/memory-review-store.ts`(시험용 보류 사건 목록) |
| 마이그레이션 | **0026에 더함**: 위 GRANT 한 줄(권한만이라 스냅숏은 그대로) |
| 시험 | 고침: `services/core-svc/test/review-withdrawn.test.ts`(I-T83 ③의 내부 경로 시험), `test/review-purge-migration.test.ts`(0026 원문). 새로: `test-int/review-purge-manual.int.test.ts`(PostgreSQL, `core_app`) |

```ts
// services/core-svc/src/modules/review/domain/ports.ts
export interface ReviewStore {
  /**
   * 그 계정의 보류된 탈퇴 사건이 있으면 한 트랜잭션에서: 보류 행 잠금 → 다시 정리 예약(recheckAtMs) → 파기 → 보류 행 reprocessed_at = nowMs.
   * 보류된 사건이 없으면 아무것도 바꾸지 않고 undefined
   */
  purgeHeldWithdrawal(accountId: string, o: { nowMs: number; recheckAtMs: number }): Promise<{ purged: number; heldEventKeys: string[] } | undefined>;
  // purgeByAccount는 지금 부르는 곳(내부 경로)이 없어지면 지운다
}

// services/core-svc/src/modules/review/application/reviews.ts
class Reviews {
  /**
   * 손으로 처리. recheckAtMs = 지금 + 16분.
   * @throws ReviewProblem('review-invalid', 422) 계정 ID가 UUID가 아님
   * @throws ReviewProblem('withdrawal-not-held', 409) 그 계정의 보류된 탈퇴 사건이 없음
   */
  purgeHeldWithdrawal(accountId: string, by: { reason: string; requestedBy: string }): Promise<{ purged: number; heldEvents: number }>;
}

// services/core-svc/src/modules/review/inbound/internal-review.controller.ts
// POST /internal/v1/reviews/accounts/:accountId/purge, 본문 z.object({ reason: z.string().min(10).max(500), requestedBy: z.string().min(1).max(64) }).strict()
// → 200 { purged, heldEvents }, 409 withdrawal-not-held, 400, 403(InternalTokenGuard 그대로). 커밋 뒤 운영 줄 review-purge-manual
```

| 시험 이름 | 단계 | 단언(정본 값) | 비고 |
| --- | --- | --- | --- |
| `I-T83 ⑨ 보류된 탈퇴 사건이 없는 계정은 손으로 파기할 수 없다` | 단위 + HTTP | 보류 사건 없음(탈퇴하지 않은 팬의 계정) → 409 `withdrawal-not-held`, 그 계정 후기 VISIBLE 그대로·예약 없음. 다른 계정의 보류 사건만 있을 때도 409. 이미 다시 처리한(`reprocessed_at` 있음) 보류 사건뿐이어도 409 | 탈퇴 여부 확인 |
| `I-T83 ⑨ 보류된 탈퇴 사건이 있으면 파기하고 보류 행을 다시 처리로 표시하며 예약을 쓴다` | 단위 + 통합(core PostgreSQL, `core_app`) | 보류 행 둘(업무 키가 그 계정, 하나는 값 없이 Kafka 키만 그 계정) → 200 `{ purged: 2, heldEvents: 2 }`, 후기가 ①의 칸, 두 보류 행의 `reprocessed_at` = 지금, 예약 시각 = 지금 + 16분. 대문자 계정 ID로 불러도 같다. 다시 부르면 409 | 한 트랜잭션: 관리자 연결로 `REVOKE UPDATE ("reprocessed_at") ON held_event FROM core_app`을 잠시 걸면 거절 1건이고 후기·예약·보류 행이 모두 그대로다 |
| `I-T83 ⑨ 사유·요청자 없이는 부를 수 없고 처리하면 운영 줄에 남는다` | HTTP | 본문 없음·`reason` 9자·501자·`requestedBy` ''·65자·모르는 칸 각각 400(바뀐 것 없음). 맞으면 운영 줄 하나: `kind` `review-purge-manual`, `requestedBy`, `reason`, `heldEventKeys`(보류 행의 eventKey), `purged`. 줄 글에 그 계정 ID가 없다. 토큰 없음·틀림 403 | 빠진 칸 거절, 누가·왜 |
| `I-T83 ⑦⑨ 0026은 core_app에 held_event의 reprocessed_at 고치기만 더 준다` | 단위(SQL 원문) + 통합 | 원문에 그 GRANT 한 줄, `held_event`에 대한 DELETE·다른 칸 UPDATE 없음. 통합: `core_app`으로 `UPDATE held_event SET error = 'x'` 42501, `DELETE FROM held_event` 42501 | 최소 권한 |

**틀린 구현 표본(S1)**: ⓐ 보류 사건을 보지 않고 파기(지금 결함) ⓑ `reprocessed_at`이 이미 있는 보류 사건도 인정 ⓒ 다른 토픽의 보류 사건도 인정 ⓓ 업무 키만 보고 Kafka 키를 보지 않음(값 없는 보류를 놓침) ⓔ 보류 행 표시를 파기와 다른 트랜잭션에서 함 ⓕ 409에서도 예약을 씀 ⓖ 운영 줄에 계정 ID를 실음 ⓗ 본문 검사가 빠져 사유 없이 됨.

#### 9.2 C1 예약 셈이 탈퇴 시각을 읽지 못해도 파기한다

**무엇이 틀렸나(리뷰)**: 해독은 계약 Zod(`z.iso.datetime({ offset: true })`)로, 예약 셈(`withdrawalRecheckAt`)은 따로 만든 정규식으로 본다. 두 검사가 받는 글이 다르면 해독을 통과한 사건이 `purgeWithdrawn`에서 던져 파기까지 하지 않고 5회 뒤 보류로 빠진다. 지금 판 Zod 4.6.7은 정규식보다 좁아(초 없는 시각·소문자 `z`·`+0900`을 받지 않는다, 계획 담당이 확인) 실제 빈틈은 아직 없지만, Zod 판이 바뀌면 생긴다.

**정한 것(정본 docs/features/identity.md §8 '다시 정리')**: `Reviews.purgeWithdrawn`은 `withdrawalRecheckAt`이 던지면 예약 시각을 처리 시각 + 16분으로 하고 파기를 그대로 한다(경고 줄 하나, 값 없음). `withdrawalRecheckAt` 자체의 엄격한 검사(검증 살아남음 M49 시험)는 그대로 둔다.

| 나눔 | 파일 |
| --- | --- |
| 제품 코드 | `services/core-svc/src/modules/review/application/reviews.ts`(`purgeWithdrawn`, 대체 예약 시각과 경고. `Reviews`에 경고를 남길 로거가 없으면 처리기의 로거를 쓰도록 결과에 `recheckFallback: true`를 싣는다) |
| 시험 | 고침: `services/core-svc/test/review-recheck.test.ts`, `test/review-withdrawn.test.ts` |

| 시험 이름 | 단계 | 단언(정본 값) | 비고 |
| --- | --- | --- | --- |
| `I-T83 ④ 예약 셈이 읽지 못한 탈퇴 시각이어도 파기하고 처리 시각 + 16분으로 예약한다` | 단위 | 가짜 시계 `2026-11-16T03:03:00Z`, `purgeWithdrawn({ withdrawnAt: '2026-11-16T03:00Z' })`(초 없음)·`'2026-11-16T03:00:00'`(시간대 없음) 각각: 후기가 ①의 칸, 예약 시각 `2026-11-16T03:19:00Z`, 던지지 않음 | 법정 파기 누락 막기 |
| `I-T83 ④ 계약이 받는 탈퇴 시각마다 예약 시각이 나온다` | 단위 | 계약 Zod `AccountWithdrawn`이 받는 글(`…T03:00:00Z`, `…T03:00:00.5Z`, `…T03:00:00.123456789+09:00`, `…T12:00:00+09:00`)을 처리기 `decode` → `handle`로 넣으면 예약 시각이 각자의 시각 + 16분(대체 시각이 아니다) | 두 검사가 어긋나지 않는지 |

**틀린 구현 표본(C1)**: ⓐ 대체 시각 없이 던짐(지금 결함) ⓑ 대체 시각이 탈퇴 시각 기준이라 NaN이 저장됨 ⓒ 대체할 때 파기를 건너뜀 ⓓ 대체를 늘 써서 정상 시각을 무시함.

#### 9.3 C2 이전 판 행 고치기는 남은 대상 수를 보고한다

**무엇이 틀렸나(리뷰)**: `review-purge-legacy`는 `FOR UPDATE SKIP LOCKED`로 잠긴 행을 건너뛰고 `{ purged }`만 돌려준다. 남은 대상이 잠긴 행뿐이어도 `0`을 보고해, 정본의 '0행을 보고한 뒤 VALIDATE'가 너무 일찍 채워질 수 있다.

**정한 것(정본 docs/data.md §2 '이전 판이 남긴 행 고치기')**: 정비 일은 끝에 같은 대상 조건으로 남은 행 수를 잠그지 않고 세어 `{ purged, remaining }`을 돌려준다(멈춤 신호로 끝났으면 센다). 다음 출시의 조건은 '남은 대상 수 0'이다.

| 나눔 | 파일 |
| --- | --- |
| 제품 코드 | `services/core-svc/src/modules/review/domain/ports.ts`(`countLegacyRows`), `…/review/adapters/db/drizzle-review-store.ts`(`purgeLegacyRows`와 같은 조건 글을 한 곳에 두고 함께 쓴다), `…/review/adapters/memory-review-store.ts`, `…/review/application/review-maintenance.ts` |
| 시험 | 고침: `services/core-svc/test/review-purge-legacy.test.ts`, `test-int/review-purge-legacy.int.test.ts` |

```ts
// services/core-svc/src/modules/review/domain/ports.ts
export interface ReviewStore {
  /** 이전 판이 남긴 두 꼴(purgeLegacyRows와 같은 조건)의 행 수. 잠그지 않는다 */
  countLegacyRows(): Promise<number>;
}
// review-purge-legacy의 run → { purged: number; remaining: number }
```

| 시험 이름 | 단계 | 단언(정본 값) | 비고 |
| --- | --- | --- | --- |
| `I-T83 ⑧ 다른 트랜잭션이 잡은 이전 판 행은 남은 대상으로 센다` | 통합(core PostgreSQL) | 이전 판 행 셋 가운데 하나를 다른 연결이 `SELECT … FOR UPDATE`로 잡은 채 정비 일 실행 → `{ purged: 2, remaining: 1 }`. 잡은 연결을 풀고 다시 실행 → `{ purged: 1, remaining: 0 }` | 너무 이른 VALIDATE 막기 |
| `I-T83 ⑧ 남은 대상 수는 고치기와 같은 조건으로 센다` | 단위(메모리) | 대상 두 꼴과 대상이 아닌 행(제대로 파기된 행, 계정 B의 살아 있는 후기)을 섞어 두고 실행 전 `countLegacyRows` = 대상 수 정확히, 실행 뒤 `{ remaining: 0 }`. 멈춤 신호로 첫 묶음 뒤 멈추면 `remaining` = 남은 수 | 결과가 '0행'만으로 통과로 새지 않는지 |

**틀린 구현 표본(C2)**: ⓐ `remaining`을 싣지 않음(지금 결함) ⓑ `remaining`을 `purged`로 셈 ⓒ 셀 때 `SKIP LOCKED`를 써 잠긴 행을 빼고 셈 ⓓ 세는 조건이 고치는 조건과 다름(한 꼴만 셈).

#### 9.4 돌릴 통합 시험(웨이브 끝 리뷰 반영)

- core-svc 폴더에서: `npx vitest run --config vitest.integration.config.mjs test-int/review-purge-manual.int.test.ts test-int/review-purge-legacy.int.test.ts test-int/review-recheck.int.test.ts test-int/review-grants.int.test.ts test-int/review-withdrawn.int.test.ts`
- 싼 게이트: `pnpm --dir D:/ticketpass-lane3-w8b/services/core-svc test`·`typecheck`, 닿는 경로 `npx eslint`, 문서 점검.

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

#### 통합 실행 결과(구현 전, 도커 잠금 아래 2026-11-16 17:13~17:22 KST)

- 따로 폴더 `D:/ticketpass-lane3-w8b-t`(감독 준비, 공용 패키지 dist는 시험 담당이 빌드)에서 core-svc 폴더의 `npx vitest run --config vitest.integration.config.mjs <파일>`로 파일 하나씩 돌렸다(`PEAKET_TEST_CONTAINER_PREFIX=lane3-`). 같은 때 다른 담당의 purchase·ops·kind 시험이 겹쳤지만 **시간 초과(환경)로 난 실패는 없었다.** 파일마다 끝난 뒤 `lane3-` 컨테이너와 Kafka 컨테이너가 남지 않은 것을 `docker ps -a`로 봤다.
- **첫째 판 `69899e30`(첫 시험 커밋, 구현 전)**:

| 파일 | 결과 | 실패 까닭(예상과 같은지) |
| --- | --- | --- |
| `test-int/review-purge.int.test.ts` | 2개 모두 실패 | ⑥ 단언: 지운 행에 별점·지문·계정이 남는다(`toMatchObject` 불일치). ⑦ 단언: `VISIBLE·별점 없음`이 `23502`(NOT NULL)이라 `23514`가 아니다. 예상대로 |
| `test-int/review-recheck.int.test.ts` | 6개 모두 실패 | `relation "review_withdrawal_recheck" does not exist`(0026 없음, `beforeEach`). 예상대로 |
| `test-int/review-withdrawn.int.test.ts` | 1 실패, 1 통과 | ①⑥ 뼈대 '아직 없음'(`purgeByAccount`). K2 실행 계획은 **처음부터 통과(이미 있는 동작)**. 예상대로 |
| `test-int/review-grants.int.test.ts` | 1 실패, 2 통과 | I-T83 ⑥ 단언: 파기 문장이 `23502`. COV2-06 ⑮⑯은 처음부터 통과. 예상대로 |
| `test-int/review.int.test.ts` | 5개 모두 통과 | 바꾸지 않은 기존 시험. 처음부터 통과 |
| `test-int/review-withdrawn-consumer.int.test.ts`(Kafka) | 2개 모두 실패 | 둘 다 '탈퇴 사건 뒤 후기 파기'를 60초 기다리다 끝났다(처리기 뼈대 '아직 없음' → 처리 실패·보류). **환경 시간 초과가 아님을 보려고 이 파일만 한 번 더 돌렸고 같은 자리에서 같게 실패했다**(17:15~17:17, 17:19~17:22). 이 PC에서 네이티브 Kafka 모듈은 막히지 않았다(컨테이너·생산자 연결까지 됐다) |

- **둘째 판 `51a34b49`(리뷰 반영 시험, A1·A2 구현 전. 첫 구현 `7f32f584`는 들어 있다)**:

| 파일 | 결과 | 실패 까닭(예상과 같은지) |
| --- | --- | --- |
| `test-int/review-purge-legacy.int.test.ts` | 2개 모두 실패 | 정비 일 `review-purge-legacy`가 없다(`expected undefined to be defined`). 첫 시험은 그 앞의 대조군(정비 일 전 VALIDATE가 `23514`)을 통과한 뒤 실패했다. 예상대로 |
| `test-int/review-recheck.int.test.ts` | 7개 모두 통과 | A3 '④ 파기가 실패하면 다시 정리 예약도 남지 않는다'는 **처음부터 통과(이미 있는 동작)**(구현이 이미 한 트랜잭션이다. 검증의 '예약 먼저 따로 커밋' 틀린 구현으로 실패를 본다). 나머지 여섯은 첫 구현으로 통과 |
| `test-int/review-grants.int.test.ts` | 1 실패, 3 통과 | I-T83 ⑦⑧ 단언: 허용 쪽 대조군 '찾기 칸 읽기'가 `42501`(0026에 정비 역할 GRANT 없음). 예상대로. I-T83 ⑥은 첫 구현으로 통과 |

- `D:/ticketpass-lane3-w8b-t`는 `51a34b49`(분리된 HEAD)에 그대로 두었다.

- **검증 살아남음 M49·M58(시험 쪽, 2026-11-16)**: `test/review-recheck.test.ts`에 `I-T83 ④ 예약 시각은 날짜만 있거나 시간대가 없는 탈퇴 시각을 받지 않는다`(`2026-11-16`·`2026-11-16T03:00:00`·`…T03:00:00.000`·`…T03:00` 거절, 시간대 단 글 대조군)와 `I-T83 ④ 같은 계정 예약을 고쳐도 만든 시각은 처음 값이다`(메모리 대역, 늦은 쪽·이른 쪽 고치기 모두 `createdAtMs` 03:03 그대로)를 더했다. 지금 코드에서는 **처음부터 통과(이미 있는 동작)**라서 변이를 손으로 넣어 실패를 봤다: M49(`ISO_DATE_TIME` 확인을 빼고 `Date.parse`만) → `2026-11-16`에서 실패, M58(고칠 때 `createdAtMs: o.nowMs`) → 실패. 두 변이는 되돌렸고 `git diff`로 제품 코드가 깨끗함을 봤다. 단위 467개 모두 통과, typecheck 오류 0.

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

### 리뷰 반영(시험 쪽, 계획 §8의 A1·A2·A3, 2026-11-16)

- **누가·언제**: 시험 담당(세션 `l3w8-a2a-test`), 2026-11-16. 리뷰 `737f3960`·계획 보탬 `790dbaf7` 위(구현 `7f32f584` 뒤). Docker 없이 돌렸다.
- **뼈대(동작 없음)**: `consumers/review-recheck.ts`의 `ReviewRecheckLoopOptions.clock?` 칸(A1), `ReviewStore.purgeLegacyRows` 포트와 메모리·Drizzle 저장소의 '아직 없음'(A2), `reviewMaintenanceTasks(store, clock, o?: { batch? })` 셋째 인자(A2, 지금은 쓰지 않는다). 정비 일 `review-purge-legacy`, `CORE_MAINTENANCE_TASK_NAMES`, 0026의 정비 역할 GRANT, 실패 수·마지막 성공 지표는 구현 담당 몫이다.
- **단위**: `pnpm --dir D:/ticketpass-lane3-w8b/services/core-svc test` 시험 465개 가운데 **7개 실패, 458개 통과**(파일 70개 가운데 3개 실패). 실패 7개는 모두 아래 새 시험이다. typecheck 오류 0, 닿은 `src` 경로 eslint 오류 0.

| 지적 | 파일 | 시험 | 결과 | 실패 까닭 |
| --- | --- | --- | --- | --- |
| A1 | `test/review-recheck.test.ts`(더함) | I-T83 ⑤ 반복이 실패해도 밀린 시간 지표를 새 값으로 고치고 실패 수를 센다 | 실패 | 단언: 마지막 성공 지표 `review_withdrawal_recheck_last_success_timestamp_seconds{service="core-svc"}`가 없다. 가짜 시계 `1_794_000_000_000`ms에서 성공(밀린 시간 0, 마지막 성공 `1794000000`) → 30분 − 1ms 뒤 실패(밀린 시간 정확히 5일 = `432000`초, 실패 수 1) → 2ms 뒤 실패(5일 + 1ms = `432000.001`초, 실패 수 2, 마지막 성공 그대로 — 30분 경계 직후) → 실패하고 밀린 시간 읽기도 실패(밀린 시간 그대로, 실패 수 3, 반복은 멈추지 않음) → 31분에 성공(밀린 시간 0, 마지막 성공 `1794001860`, 실패 수 3 그대로). 실패한 한 번마다 경고 한 줄(셋), 글에 UUID 모양 없음. 간격 1,234ms·묶음 7(상수와 다르게) |
| A1 | 〃 | I-T83 ⑤ 같은 등록부에 반복을 두 번 켜도 지표를 새로 만들다 실패하지 않는다 | 실패 | 단언: `review_withdrawal_recheck_failures_total`이 등록부에 없다(세 지표 이름마다 등록이 하나여야 한다) |
| A2 | 새 `test/review-purge-legacy.test.ts` | I-T83 ⑧ 정비 일은 이전 판이 남긴 두 꼴만 파기 칸으로 고친다 | 실패 | 정비 일 `review-purge-legacy`가 아직 없다. 행 일곱: 계획의 다섯(ⓐ 옛 작성자 지우기, ⓑⓒ 옛 익명화 보이는·가린 후기, ⓓ 제대로 파기된 행, ⓔ 다른 계정 후기)에 ⓕ 지문만 남은 DELETED·ⓖ 계정만 남은 DELETED를 더해(별점만 보는 틀린 구현 A2 ⓑ를 잡게) `{ purged: 5 }`. ⓓⓔ는 갱신 시각까지 그대로, ⓑ가 요약 대상에서 빠진다 |
| A2 | 〃 | I-T83 ⑧ 정비 일을 다시 돌리면 0행이고 묶음 경계에서 빠지는 행이 없다 | 실패 | 〃. 묶음 2, id 차례와 다르게 넣은 이전 판 행 다섯 사이에 살아 있는 후기 둘. 저장소 호출의 `limit` `[2,2,2,2]`, 커서 `after` `[없음, 둘째 id, 넷째 id, 다섯째 id]`(마지막 호출이 0건·커서 없음이라 멈춘다), 다시 돌리면 `{ purged: 0 }`·행 그대로 |
| A2 | 〃 | I-T83 ⑧ 정비 일은 묶음 사이에 멈춤 신호를 보고 다음 실행이 나머지를 고친다 | 실패 | 〃. 첫 묶음 뒤 멈춤 → `{ purged: 2 }`·저장소 호출 1번, 다음 실행 `{ purged: 3 }` |
| A2 | 〃 | I-T83 ⑧ 정비 일은 정비 시간 일이고 정비 일 목록에 있으며 한 묶음은 기본 1,000행이다 | 실패 | 〃. `when` `'window'`, 기본 `limit` 1,000·`nowMs` = 시계, `CORE_MAINTENANCE_TASK_NAMES`와 relay 조립 `coreMaintenanceTasks(…)`에 있다 |
| A2 | `test/review-purge-migration.test.ts`(더함) | I-T83 ⑦⑧ 0026은 정비 역할에 본문 읽기를 주지 않는다 | 실패 | 단언: 0026에 `core_maintenance` GRANT가 없다. 기대: `review` SELECT [account_id, content_fingerprint, deleted_at, rating]와 UPDATE [account_id, author_display, basis_order_id, body, content_fingerprint, deleted_at, rating] 두 줄뿐, `body` 읽기·INSERT·DELETE·표 전체 권한·다른 표 권한 없음 |
| A2 | 〃(고침) | I-T83 ⑦ 마이그레이션은 별점·지문 NULL을 허용하고… / I-T83 ⑦ 예약 표 권한은… | **처음부터 통과(이미 있는 동작)** 2 | 'review에 새 GRANT 없음'을 '정비 역할 밖의 review GRANT 없음'으로, 예약 표 권한 검사를 예약 표 문만으로 좁혔다(A2의 정비 역할 GRANT가 이 둘을 깨지 않게) |

- **통합(도커 대기 — 돌리지 않았다)**: core-svc 폴더에서 `npx vitest run --config vitest.integration.config.mjs test-int/review-purge-legacy.int.test.ts test-int/review-recheck.int.test.ts test-int/review-grants.int.test.ts`. 새 시험은 기준 시각을 DB 서버 시각(`select now()`)에서 잡는다.

| 지적 | 파일 | 시험 | 지금(구현 전) 예상 | 까닭 |
| --- | --- | --- | --- | --- |
| A2 | 새 `test-int/review-purge-legacy.int.test.ts` | I-T83 ⑧ 정비 역할로 이전 판 행을 고치고 그 뒤 파기 행 CHECK를 VALIDATE할 수 있다 | 실패 | 정비 일이 없다. 대조군으로 정비 일 전 VALIDATE가 23514인지 먼저 본다. 그 뒤 `core_maintenance` 로그인·묶음 2로 `{ purged: 5 }`, 다섯 행 칸이 ①과 같고(이미 지운 행의 지운 시각 그대로) 다른 두 행은 그대로, 다시 돌리면 0, 관리자 트랜잭션의 파기 행 CHECK `NOT VALID` + 두 `VALIDATE`가 성공(되돌림) |
| A2 | 〃 | I-T83 ⑧ 정비 일은 잠긴 행을 건너뛰고 기다리지 않으며 다음 실행이 고친다 | 실패 | 〃. 관리자 연결이 한 행을 `FOR UPDATE`로 쥔 채 3초 안에 나머지 둘만 고친다(SKIP LOCKED. 잠금 대기 2초 [가정]로 실패해도 안 된다), 풀린 뒤 다음 실행이 1 |
| A2 | `test-int/review-grants.int.test.ts`(더함) | I-T83 ⑦⑧ 0026은 정비 역할에 본문 읽기를 주지 않는다 | 실패 | 허용 쪽 대조군(찾기 칸 읽기, 파기 칸 고치기 한 문장)이 42501이다. 거부 쪽: `body`·`author_display`·`basis_order_id` 읽기, 표 전체 읽기, `event_id`·`created_at`·`edited` 고치기, 지우기, 넣기가 모두 42501 |
| A3 | `test-int/review-recheck.int.test.ts`(더함) | I-T83 ④ 파기가 실패하면 다시 정리 예약도 남지 않는다 | 처음부터 통과 예상 | 구현은 이미 한 트랜잭션이다. `REVOKE UPDATE (rating) ON review FROM core_app` 동안 거절 1건(42501), 예약 행 0, 후기 VISIBLE 그대로, 권한을 돌린 뒤 파기와 예약이 둘 다 있다. 검증 담당이 '예약 먼저 따로 커밋'하는 틀린 구현으로 한 번 실패를 본다 |

- **틀린 구현 표본과 잡을 시험(예상)**: A1 ⓐ 실패 때 밀린 시간 안 고침·ⓑ 0으로 둠 → A1 첫 시험의 둘째·셋째 단계. ⓒ 성공 때도 실패 수 올림 → 다섯째 단계(3 그대로). ⓓ 실패 때 마지막 성공 고침 → 둘째~넷째 단계(가짜 시계를 30분 넘게 옮긴다). ⓔ 밀린 시간 읽기가 던지면 멈춤 → 다섯째 단계가 돈다. A2 ⓐ 둘째 꼴 빠뜨림 → ⑧ 첫 시험 ⓑⓒ. ⓑ 별점만 봄 → ⓕⓖ. ⓒ 커서 `>=`·커서 없음 → 둘째 시험의 커서·호출 수. ⓓ 제대로 파기된 행 고침 → ⓓ 갱신 시각. ⓔ 지운 시각 덮음 → ⓐⓕⓖ의 지운 시각. ⓕ `daily` → 넷째 시험. ⓖ 정비 역할에 표 전체 UPDATE → ⑦⑧ 원문·통합 거부 쪽. A3 '예약 먼저 따로 커밋' → 통합 ④ 새 시험, '파기 먼저 따로 커밋' → 기존 ④.
- **시험 담당이 정한 것**: 메모리 `purgeLegacyRows`의 커서는 '그 묶음에서 고친 마지막 id'이고 0건이면 커서가 없다. 정비 일은 커서가 없을 때까지 이어 부른다(고친 수가 묶음보다 적어도 한 번 더 불러 0건을 본다, SKIP LOCKED로 덜 잡혀도 끝으로 보지 않게). 실패 수·마지막 성공 지표의 칸은 `service="core-svc"` 하나다.

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

### 이의 2(리뷰 반영 A2, 2026-11-16). 기존 통합 시험 하나가 정비 일 목록 전체를 그대로 단언한다

- `services/core-svc/test-int/sale-eligibility.int.test.ts:736`이 `coreMaintenanceTasks(…)`의 정비 일 목록을 `toMatchObject({ tasks: [['sale-eligibility-purge', 'daily'], ['sale-eligibility-copy', 'daily'], ['review-temp-block-expire', 'daily']], … })`로 단언한다. `toMatchObject`는 배열 길이까지 같아야 해서, A2의 새 정비 일 `review-purge-legacy`(정비 시간)가 넷째로 들어가면 이 시험이 실패한다(통합이라 이번에 돌리지 않았다. 빌드한 `dist/maintenance-tasks.js`를 띄우는 시험이다).
- 고칠 길(시험 담당 몫): 기대 목록 끝에 `['review-purge-legacy', 'window']`를 더한다(`coreMaintenanceTasks`는 후기 정비 일을 `review-temp-block-expire` → `review-purge-legacy` 차례로 넣는다). 계획 §8.4의 돌릴 통합 시험에도 이 파일을 더하면 좋다.

### 구현 담당이 정한 것(리뷰 반영 A1·A2)

1. **A1 경고 줄**: 한 번 돌 때 경고는 한 줄까지다. 다시 정리가 실패하면 그 줄 하나(밀린 시간 읽기가 함께 실패해도 줄을 더하지 않는다). 다시 정리가 성공하고 밀린 시간 읽기만 실패하면 그 읽기 실패로 한 줄을 남긴다(실패 수는 늘리지 않고, 마지막 성공 시각은 고친다). 마지막 성공 시각은 `Math.floor(clock.now() / 1000)`(platform 정비 지표와 같다). 세 지표는 같은 이름이 등록부에 있으면 그것을 쓴다.
2. **A2 잠금 대기**: 한 묶음 트랜잭션의 첫 문장에서 `set_config('lock_timeout', '2000ms', true)`로 잠금 대기 한도 2초 [가정]를 건다(행 잠금은 SKIP LOCKED로 기다리지 않는다). 찾기는 `id::text`로 읽어 `order by id`의 마지막 값을 커서로 준다(그 묶음에서 고친 마지막 id). 고치기는 탈퇴 파기와 같은 `purgeSet` 문장을 `id = any(…)`로 쓴다.
3. **A2 권한**: 0026 끝에 계획 §8.2의 GRANT 두 줄만 더했다(새 번호·스냅숏 바뀜 없음).

### 통합 통과 확인(2026-11-16 17:28~17:37, 감독 도커 잠금 아래)

- **누가·어디서**: 구현 담당(세션 `l3w8-a2a-impl`). 따로 폴더 `D:/ticketpass-lane3-w8b-t`(`28397b3b`, W8-audit2a 구현·리뷰 반영·검증 뒤 시험 고침 전부)의 `services/core-svc`에서 돌렸다. 같은 때 ops·purchase Docker 시험이 겹쳐 돌았다.
- **파일 하나씩**(`npx vitest run --config vitest.integration.config.mjs test-int/<파일>`): 여덟 파일 모두 통과, 실패·시간 초과 0, 다시 돌린 파일 없음.

| 파일 | 결과 | 걸린 시간 |
| --- | --- | --- |
| `test-int/review-purge.int.test.ts` | 2 통과 | 21초 |
| `test-int/review-recheck.int.test.ts` | 7 통과 | 20초 |
| `test-int/review-withdrawn.int.test.ts` | 2 통과 | 20초 |
| `test-int/review-grants.int.test.ts` | 4 통과 | 18초 |
| `test-int/review.int.test.ts` | 5 통과 | 23초 |
| `test-int/review-purge-legacy.int.test.ts` | 2 통과 | 18초 |
| `test-int/sale-eligibility.int.test.ts` | 23 통과(정비 일 목록 단언에 `['review-purge-legacy', 'window']`가 든 판, 이의 2 반영) | 68초 |
| `test-int/review-withdrawn-consumer.int.test.ts` | 2 통과(실제 Kafka 컨테이너, 이 PC에서 네이티브 Kafka 모듈이 막히지 않았다) | 48초 |

- **core-svc 통합 전체**(0026을 더해서, `--maxWorkers=3`): 파일 29개 가운데 28 통과·1 건너뜀, 시험 272개 가운데 271 통과·1 건너뜀, 실패 0(17:32:47 시작, 276초). 건너뛴 하나는 `test-int/local-partner-stack.int.test.ts`(`PEAKET_LOCAL_STACK=1`일 때만 도는 로컬 스택 시험, 이 묶음 전부터 그렇다).
- **제품 결함**: 없음. **컨테이너**: 시험 전후 `docker ps -a`를 견주어 이 실행이 남긴 컨테이너가 없다(testcontainers가 지웠다). 다른 갈래 컨테이너는 건드리지 않았고 restart하지 않았다.

## 시험 이의 답

- **누가·언제**: 시험 담당(세션 `l3w8-a2a-test`), 2026-11-16. 구현 커밋 `7f32f584`·이의 커밋 `a450164a` 위.

### 이의 1에 대한 답: 맞다. 시험 쪽만 고쳤다

- 실패 확인 절의 '시험은 두 꼴 모두에서 컴파일된다'는 별점에만 맞았다. 조치 증적(`TakedownRecord.contentFingerprint`)과 차단 목록 지문 포트(`addHiddenFingerprint`·`hasHiddenFingerprint`)는 DB에서 NOT NULL이라 `string`으로 두는 것이 맞고, 시험이 `ReviewRecord.contentFingerprint`(이제 `string | null`)를 거기에 그대로 넣은 것이 잘못이다. 제품 타입은 넓히지 않는다(구현 담당 판단에 동의).
- 고친 곳(살아 있는 후기의 지문을 본문에서 따로 만든다. 값은 전과 같고 단언은 바꾸지 않았다):
  - `test/review-withdrawn.test.ts` I-T83 ①: `a2Fingerprint = contentFingerprint(hiddenBody)`(a2 만들기·조치 증적에 씀), `a1Fingerprint = contentFingerprint(a1.body)`(차단 목록 넣기와 `hasHiddenFingerprint` 단언의 인자). `expect` 줄은 인자 이름만 바뀌었다.
  - `test/review.test.ts` '끝 시각이 지난 임시조치는…': 조치 증적 지문을 `contentFingerprint(r.body)`로(`record()`가 넣은 값과 같다).
- 돌린 것: `pnpm --dir D:/ticketpass-lane3-w8b/services/core-svc typecheck` 오류 0. `pnpm --dir D:/ticketpass-lane3-w8b/services/core-svc test` 시험 458개 모두 통과(파일 69개).

## 리뷰

- **누가·언제**: 리뷰 담당(세션 `l3w8-a2a-review`), 2026-11-16. 가지 `wave/lane3-w8-audit2`, `c3b0935c..5a46763e`(스냅숏 JSON·계약 생성물은 건너뜀)를 계획·정본(docs/features/identity.md §8·§12 I-T83, docs/data.md §2 '후기 파기'·'후기 표의 DB 권한'·§5.1 '탈퇴 파기'·§6, docs/security/data-classification.md 두 행, docs/streaming.md §2.6, docs/security/asvs/catalog-review.md 14.2.7, ADR-0278)과 견줬다. 코드는 고치지 않았고 시험은 돌리지 않았다.
- **맞는 것(짧게)**: 계획 §1·§2의 공개 인터페이스와 손댈 파일이 모두 구현됐다(`review/index.ts`는 바꿀 것이 없었다). 구현 커밋 `7f32f584`는 시험 파일을 건드리지 않았다. 파기 칸(본문·별점·지문·작성자 표시·통보 칸·계정/주문 참조·처음 지운 시각)이 메모리(`purgedReview`)·Drizzle(`purgeSet`)·작성자 지우기에서 같고, 그 계정 모든 상태의 행만 바꾸며 다시 하면 0건이다. 예약 경계는 `<=`, 같은 계정은 `greatest`, 처리한 예약은 같은 트랜잭션에서 지운다. 잠금 차례(예약 → 후기)는 사건 다시 받기와 반복이 겹쳐도 교착이 없게 맞다. 0026은 넓히기·`NOT VALID`만 하고 예약 표 권한은 `core_app`의 읽기·넣기·지우기·`due_at` 고치기뿐이다. 반복은 시작하자마자 돌고(재시작 뒤 놓친 예약도 표에 남아 바로 잡힌다) 멈출 때 소비자보다 먼저 멈춘다. 예약 표·로그에 pid와 계정 ID가 없다.

| 번호 | 심각도 | 파일:줄 | 근거 | 고칠 쪽 |
| --- | --- | --- | --- | --- |
| A1 | 중간 | `services/core-svc/src/consumers/review-recheck.ts:60-69` | 밀린 시간 지표(`overdue.set`)를 `runWithdrawalRechecks`가 성공했을 때만 고친다. 반복이 계속 실패하면(권한 회귀, 문장 시간 초과 등) 지표가 마지막 값(보통 0)에 머물고, 이 반복은 실패 수·마지막 성공 시각 지표도 내지 않는다. 그러면 정본의 '밀리면 지표가 보이고 5일 [가정] 넘으면 SEV2 legal'(data-classification '탈퇴 후기 다시 정리 예약', streaming §2.6)이 바로 그 실패 때 울리지 않고, 남는 신호는 경고 로그뿐이다(법정 파기 의무의 감시가 비는 자리) | 구현: 실패 경로에서도 `oldestOverdueRecheckMs`를 따로 읽어 지표를 고친다(읽기도 실패하면 그대로 둔다). 실패 수 지표를 더할지는 구현 담당 판단. 시험: 단위 ⑤에 '실패한 한 번 뒤 지표가 새 밀린 시간으로 바뀐다'를 더한다. 기록 담당: docs/observability.md:199 '정비 잡' 행에 이 지표가 소비자를 켠 API 파드에서 난다는 것을 한 줄 보탤지 본다(시험 이의 '정본 빈칸'과 같은 거리) |
| A2 | 중간 | `docs/data.md:2423`('후기 파기' 마이그레이션 나눔) | 다음 출시의 파기 행 CHECK·`VALIDATE` 전에 이전 판이 남긴 행을 파기 칸으로 고치는 한 번짜리 갱신이 정본·계획에 없다. ⓐ 이 출시 전과 배포 창 동안 이전 판 작성자 지우기가 남긴 DELETED 행은 별점·지문·계정 ID·주문 ID를 그대로 가진다(ADR-0086 ⑧ 위반이 남고, 탈퇴하지 않은 작성자의 행은 아무 길로도 다시 파기되지 않는다). 이런 행이 하나라도 있으면 다음 출시 `VALIDATE`가 실패한다. ⓑ 배포 창 동안 이전 판 소비자가 옛 익명화로 처리한 탈퇴 사건의 후기는 `account_id = id`·'탈퇴한 사용자'·VISIBLE로 남고, 새 코드가 계정 ID로 찾지 못하며 다시 정리 예약도 없다 | 정본(계획 담당·감독): data.md §2 '후기 파기'에 '배포 창이 끝난 뒤 한 번짜리 갱신(DELETED인데 별점·지문이 남은 행, 옛 익명화 표시 행 → 파기 칸) → 파기 행 CHECK → VALIDATE' 차례를 적는다. 기록 담당: 구간 끝 정리 목록. 확인 필요: 옛 익명화(W7-audit) 판이 돈 환경이 있는지. 운영 전이라 운영 행은 없다 |
| A3 | 낮음 | `services/core-svc/test-int/review-recheck.int.test.ts:89-115`, `services/core-svc/src/modules/review/adapters/db/drizzle-review-store.ts:277-286` | 구현이 차례를 '예약 upsert → 파기'로 바꿨다(시험 이의 '구현 담당이 정한 것' 1, 교착을 피하려는 것이라 맞다). 그래서 `REVOKE INSERT`로 첫 문장을 막는 '④ 파기와 예약은 한 트랜잭션이다'는 두 문장을 따로 자동 커밋하는 틀린 구현(예약 먼저)도 통과시킨다. 계획 §4 '겹친 가드'가 이 시험에 맡긴 §2 ⓒ 가운데 '파기 먼저·따로 커밋'만 잡는다. 놓치는 꼴은 파기가 실패해도 예약이 남아 결국 다시 파기되므로 해는 작지만, 시험 이름의 성질(한 트랜잭션)을 이 시험만으로는 보이지 못한다(정본 I-T83 ④의 '예약 쓰기가 실패하면 파기도 없다' 한쪽만 본다) | 시험: 반대쪽을 더한다(관리자 연결로 `REVOKE UPDATE ("rating") ON review FROM core_app`을 잠시 걸어 파기만 실패하게 한 뒤 거절 1건과 예약 행 없음을 단언하고, 권한을 돌린다). 검증 담당: §2 ⓒ 틀린 구현을 두 차례(파기 먼저·예약 먼저) 모두로 만들어 본다 |

- **확인 필요(지적 아님)**:
  - 통합 시험 여섯 파일은 아직 돌리지 않았다(Docker 대기). `sql.param(ids)`의 `::uuid[]`, `extract(epoch …)`의 float8, `on conflict … greatest`의 권한(`due_at` UPDATE·`account_id` SELECT)은 통합에서만 실제로 확인된다.
  - journal의 0026은 `idx` 26·`when` 1794811994338이다. 갈래 2의 0023 등과 합칠 때 `when` 차례를 감독이 맞춘다(Drizzle 이주기는 마지막으로 적용한 `when`보다 큰 것만 돌리므로, 0026이 먼저 적용된 DB에서는 `when`이 더 작은 뒤 번호가 건너뛰어진다).
  - 후기 사진(`review_image`)이 생기는 단계가 파기 칸에 사진 키와 실제 파일 지우기를 더해야 한다(정본 data.md §2 '후기 파기'에 적혀 있다). 지금 코드는 사진을 받지 않아(422 `review-images-unavailable`) 해당 없다.
- **높음**: 없다.

### 이의 2에 대한 답: 맞다. 시험 쪽만 고쳤다(리뷰 반영 A2)

- `test-int/sale-eligibility.int.test.ts`의 정비 일 조립 단언은 `toMatchObject`의 배열이 길이까지 같아야 해서, A2의 새 정비 일이 넷째로 들어가면 실패한다. 이 단언은 relay가 실제로 띄우는 정비 일 전체를 정본대로 묶어 두는 뜻이라(빠지거나 더해진 일을 잡는다) '들어 있는지만' 보게 느슨하게 하지 않고, 기대 목록 끝에 `['review-purge-legacy', 'window']`를 더했다(`coreMaintenanceTasks`가 `review-temp-block-expire` → `review-purge-legacy` 차례로 넣는다). 나머지 단언(`purge` 결과)은 그대로다.
- 통합이라 돌리지 않았다(도커 대기). 리뷰 반영 통합 명령에 이 파일을 더한다: core-svc 폴더에서 `npx vitest run --config vitest.integration.config.mjs test-int/review-purge-legacy.int.test.ts test-int/review-recheck.int.test.ts test-int/review-grants.int.test.ts test-int/sale-eligibility.int.test.ts`(이 파일은 시험 안에서 `buildDist()`로 빌드한 `dist/maintenance-tasks.js`를 띄운다. 따로 빌드할 것은 없다).

### 다시 보기

- **누가·언제**: 리뷰 담당(세션 `l3w8-a2a-review`), 2026-11-16. `737f3960..ab16df58`(계획·정본 `790dbaf7`, 시험 `51a34b49`·`c4a05752`, 구현 `53a19b01`, 시험 이의·답 `3b09c09b`·`ab16df58`)의 고친 곳만 다시 봤다. 시험은 돌리지 않았다.
- **A1 반영됨**: `consumers/review-recheck.ts`가 한 번 돌 때마다 성공·실패와 관계없이 밀린 시간을 따로 읽어 고치고(읽기도 실패하면 그대로 둔다), 실패하면 `review_withdrawal_recheck_failures_total`을 올리며, 성공했을 때만 `review_withdrawal_recheck_last_success_timestamp_seconds`를 고친다. 이름·칸·경보 기준(5일 SEV2, 30분 SEV3, 둘 다 legal)이 정본 docs/observability.md:200 '탈퇴 후기 다시 정리' 행과 같다. 같은 등록부에 두 번 켜도 지표를 새로 만들다 실패하지 않는다. 경고에는 오류 요약만 싣는다.
- **A2 반영됨**: 정비 일 `review-purge-legacy`(`when: 'window'`, 정비 역할)가 두 꼴(DELETED인데 별점·지문·계정이 남은 행, 살아 있는데 `account_id = id`인 행)만 `id` 커서(`>`)로 1,000행씩 `FOR UPDATE SKIP LOCKED`로 잡아 같은 `purgeSet`으로 고친다. 묶음마다 커밋하고 잠금 대기는 2초다(`drizzle-review-store.ts:319-338`). 멈춤 신호는 묶음 사이에 보고, 0건이 될 때까지 이어 부른다. 0026에 더한 `core_maintenance` 권한은 찾기 칸 넷 읽기와 파기 칸 일곱 고치기뿐이다. 이 문장이 읽는 칸(`id`·`status`·`rating`·`content_fingerprint`·`account_id`·`deleted_at`)과 고치는 칸(0022의 넷과 0026의 일곱)이 꼭 맞는다. `body` 읽기·넣기·지우기는 주지 않았다. 다음 출시 차례(0026 → 정비 일 0행 → 파기 행 CHECK `NOT VALID` → 두 `VALIDATE` → 정비 일 지움)가 docs/data.md §2와 ADR-0278 결정 1에 적혔고, 통합 시험이 정비 일 전 23514와 정비 일 뒤 성공을 함께 본다.
- **A3 반영됨**: `REVOKE UPDATE (rating)`으로 파기만 실패하게 해 예약 행이 남지 않는지 보는 반대쪽 시험이 더해졌다(`test-int/review-recheck.int.test.ts`).
- **새 결함 검토**: 파기가 너무 많아지지 않는다. 둘째 꼴은 `account_id = id`일 때만이고 그 꼴은 옛 익명화만 만든다(새 코드의 `purgeSet`은 같은 문장에서 DELETED로 바꾼다). 이미 제대로 파기된 행과 두 꼴 밖의 살아 있는 남의 후기는 갱신 시각까지 그대로이고, 단위·통합 시험이 이를 단언한다. 파기가 빠지지도 않는다. 0026 전에는 별점이 NOT NULL이라 이전 판의 DELETED 행은 모두 첫째 꼴에 걸리고, 이것만으로 파기 행 CHECK를 지킬 수 있다. API와의 경합도 막혔다. 잠긴 행은 건너뛰고 다음 정비 시간에 고치며, 묶음이 짧은 트랜잭션이라 API가 오래 기다리지 않는다. 구현 커밋 `53a19b01`은 시험 파일을 건드리지 않았다(`c4a05752`의 `sale-eligibility.int.test.ts`는 시험 담당 몫이다).

| 번호 | 심각도 | 파일:줄 | 근거 | 고칠 쪽 |
| --- | --- | --- | --- | --- |
| B1 | 낮음 | `services/core-svc/src/consumers/review-recheck.ts:94` | 마지막 성공 시각 지표는 첫 성공 때 처음 생긴다. 배포 직후처럼 모든 파드가 켜자마자 계속 실패하면 이 계열이 아예 없어서, '모든 파드의 마지막 성공(`max`)이 30분 넘게 없음' 규칙의 식이 빈 결과가 되어 SEV3가 울리지 않을 수 있다. 밀린 시간 지표(5일 SEV2)는 계속 고쳐지므로 결국 잡히지만 늦다 | 구현: 반복을 켤 때 그 파드의 마지막 성공 계열을 켠 시각으로 만들어 둔다(그러면 30분 안에 성공이 없을 때 울린다). 또는 정본: docs/observability.md:200 경보에 '계열이 없거나 실패 수가 늘기만 함'을 함께 적는다. 어느 쪽인지는 감독 판단 |

- **확인 필요(지적 아님)**: 리뷰 반영의 통합 시험 세 파일(`review-purge-legacy`·`review-recheck`·`review-grants`)과 처음 여섯 파일은 아직 돌리지 않았다(Docker 대기). 정비 일은 다음 출시에서 지울 때까지 정비 시간마다 표를 한 번 훑는다. 두 꼴을 찾는 조건에는 색인이 없지만 운영 전이라 문제 없는 크기다.
- **높음·중간**: 없다.

## 검증

- **누가·언제**: 검증 담당(세션 `l3w8-a2a-verify`), 2026-11-16. 가지 `wave/lane3-w8-audit2`, 끝 `3e81c89a` 위. 계획·시험·구현·리뷰에 관여하지 않았다. 바뀐 부분 `c3b0935c..3e81c89a`(스냅숏 JSON·계약 생성물 건너뜀)를 보고 틀린 구현을 하나씩 넣었다. Docker 없이 돌렸다.
- **방법**: 변이 하나마다 제품 코드(또는 0026 원문) 한 곳을 바꾸고 → core-svc 폴더에서 `npx vitest run test/review-withdrawn.test.ts test/review-purge.test.ts test/review-recheck.test.ts test/review-purge-legacy.test.ts test/review-purge-migration.test.ts test/core-consumers.test.ts test/review.test.ts test/review.http.test.ts test/review-grants.test.ts`(시험 58개, 바꾸기 전 모두 통과) → 결과 → `git checkout -- <파일>`. M62·M63은 닿는 파일만 돌렸다.
- **수**: 넣은 63, 잡힌 61, 살아남은 2(M49·M58). 꼭 넣을 것(계획 §4: §1 ⓐⓑⓒⓓ, §2 ⓐⓒⓔ, ⓘⓚ) 가운데 단위로 넣을 수 있는 것은 모두 넣었고 모두 잡혔다. §2 ⓒ(파기와 예약이 다른 트랜잭션)의 두 차례와 Drizzle SQL·SKIP LOCKED·실제 권한은 아래 Docker 대기 목록으로 넘긴다.

### 변이 표(단위, Docker 없음)

| ID | 계획 표본 | 틀린 구현(파일) | 결과 | 잡은 시험(대표) |
| --- | --- | --- | --- | --- |
| M01 | §1 ⓐ | 파기가 별점을 남김(`domain/review.ts` `purgedReview`) | 잡힘 | ⑥ 작성자 지우기, ⑧ 이전 판, ④ 예약 시각에 파기 등 8 |
| M02 | §1 ⓐ | 파기가 내용 지문을 남김(〃) | 잡힘 | ⑥, ⑧, ④ 등 8 |
| M03 | §1 ⓑ | 상태를 DELETED 대신 그대로 둠(집계·공개 목록에 남음, 〃) | 잡힘 | ② 목록·요약·상세에서 빠짐, ⑥, ⑧, ④ 등 10 |
| M04 | 파기 칸 | 본문을 남김(〃) | 잡힘 | ①, ③ 내부 경로, ⑥, ⑧ 등 6 |
| M05 | 파기 칸 | 작성자 표시를 남김(〃) | 잡힘 | ①, ③ 내부 경로, ⑥, ⑧ 등 6 |
| M06 | ⓘ | `notice`·`noticeUntilMs`를 남김(〃) | 잡힘 | ①, ③ 내부 경로, ⑥, ⑧ |
| M07 | §1 ⓔ | 지운 시각을 늘 지금으로 덮음(〃) | 잡힘 | ①, ⑧ 첫 시험 |
| M08 | 파기 칸 | 계정 참조를 끊지 않음(〃) | 잡힘 | ⑧ 셋, ⑥, ③, ④ 등 10 |
| M09 | 파기 칸 | 주문 참조를 끊지 않음(〃) | 잡힘 | ①, ③ 내부 경로, ⑥, ⑧ 등 6 |
| M10 | §1 ⓒ | 계정 조건 없이 모든 행 파기(다른 계정 행 건드림, 메모리 `purgeByAccount`) | 잡힘 | ①(B 행 그대로), ②, ④, ⑤ 등 8 |
| M11 | §1 ⓓ | 이미 지운 DELETED 행은 건너뜀(〃) | 잡힘 | ① |
| M12 | §1 ⓕ | 작성자 지우기가 옛 칸(본문·작성자 표시)만 비움(메모리 `softDeleteReview`) | 잡힘 | ⑥ |
| M13 | §1 ⓖ·예약 빼먹기 | 처리기가 `purgeWithdrawn` 대신 예약 없는 `purgeAccount`를 부름(`account-withdrawn.handler.ts`) | 잡힘 | ④ 셋, ①, ③ 같은 사건 |
| M14 | §2 ⓐ | 예약 시각을 처리 시각 + 16분으로(`withdrawalRecheckAt`) | 잡힘 | ④ min 시험 등 7 |
| M15 | ⓛ | 미래 탈퇴 시각을 그대로 씀(min 없음) | 잡힘 | ④ min 시험, ④ 함께 쓴다 |
| M16 | §2 ⓑ | 15분(여유 1분 없음) | 잡힘 | ④·⑤ 등 7 |
| M17 | §2 ⓑ | 예약 경계 `<=` → `<`(정각에 건너뜀, 메모리 `runDueRechecks`) | 잡힘 | ④ 예약 시각 전에는 다시 정리하지 않고 그 시각에 파기한다 |
| M18 | §2 ⓓ | 같은 계정 예약을 이른 시각으로 덮음(메모리 `purgeWithdrawnAccount`) | 잡힘 | ④ 함께 쓴다 |
| M19 | §2 ⓔ | 처리한 예약을 지우지 않음(메모리 `runDueRechecks`) | 잡힘 | ④ 예약 시각, ⑤ 100개씩 |
| M20 | §2 ⓖ | 반복이 한 번 실패하면 멈춤(`review-recheck.ts`) | 잡힘 | ⑤ 반복, ⑤ 실패 지표 |
| M21 | ⓜ | 100개를 채워도 곧바로 다시 돌지 않음 | 잡힘 | ⑤ 반복 둘 |
| M22 | §2 ⓗ | `start.ts`가 반복을 켜지 않음 | 잡힘 | ⑤ 소비자를 켜면 반복도 켜지고… |
| M23 | 종료 때 안 멈춤 | `stop()`이 반복을 멈추지 않음(`start.ts`) | 잡힘 | 〃 |
| M24 | 멈춤 차례 | 소비자를 먼저 멈추고 반복을 뒤에 멈춤(`start.ts`) | 잡힘 | 〃 |
| M25 | A1 ⓐ | 실패한 한 번에는 밀린 시간을 고치지 않음 | 잡힘 | ⑤ 반복이 실패해도 밀린 시간 지표를… |
| M26 | A1 ⓑ | 실패한 한 번에는 밀린 시간을 0으로 | 잡힘 | 〃 |
| M27 | A1 ⓒ | 성공 때도 실패 수를 올림 | 잡힘 | 〃 |
| M28 | A1 ⓓ | 실패 때 마지막 성공 시각을 고침 | 잡힘 | 〃 |
| M29 | A1 ⓔ | 밀린 시간 읽기가 던지면 반복이 멈춤 | 잡힘 | 〃 |
| M30 | A2 ⓐ | 정비 일 대상에서 둘째 꼴(`account_id = id`인 살아 있는 후기)을 뺌(메모리 `isLegacyRow`) | 잡힘 | ⑧ 첫·둘째 시험 |
| M31 | A2 ⓑ | 첫째 꼴을 별점만으로 찾음(〃) | 잡힘 | ⑧ 첫 시험(지문만·계정만 남은 행) |
| M32 | A2 ⓒ | 정비 일이 커서 없이 처음부터 다시 읽음(`review-maintenance.ts`) | 잡힘 | ⑧ 묶음 경계 |
| M33 | A2 ⓓ·남의 후기 | 제대로 파기된 DELETED 행도 다시 고침(갱신 시각 바뀜, 메모리 `isLegacyRow`) | 잡힘 | ⑧ 셋 |
| M34 | A2 ⓕ | `when: 'daily'` | 잡힘 | ⑧ 정비 시간 일 |
| M35 | 묶음 크기 | 기본 묶음 1,000 → 100 | 잡힘 | 〃 |
| M36 | 멈춤 신호 | 정비 일이 묶음 사이 멈춤 신호를 보지 않음 | 잡힘 | ⑧ 멈춤 신호 |
| M37 | A2 ⓖ·0026 넓히기 | 정비 역할에 `review` 표 전체 UPDATE(0026) | 잡힘 | ⑦⑧ 0026은 정비 역할에 본문 읽기를 주지 않는다 |
| M38 | 0026 넓히기 | 정비 역할 SELECT에 `body`를 더함 | 잡힘 | 〃 |
| M39 | ⓝ·0026 넓히기 | 예약 표 권한을 `core_partner`에도 | 잡힘 | ⑦ 예약 표 권한 |
| M40 | ⓝ·0026 넓히기 | 예약 표 UPDATE를 칸 없이 넓게 | 잡힘 | 〃 |
| M41 | 0026 좁히기 | 예약 표 `core_app`에서 DELETE를 뺌 | 잡힘 | 〃 |
| M42 | NOT VALID 빼기 | 살아 있는 행 CHECK에서 `NOT VALID`를 뺌 | 잡힘 | ⑦ 마이그레이션은 별점·지문 NULL을… |
| M43 | 0026 좁히기 | 내용 지문 `DROP NOT NULL`을 뺌 | 잡힘 | 〃 |
| M44 | ⓚ | 처리기 로그에 계정 ID를 실음 | 잡힘 | ①, ④ 처리기 |
| M45 | 로그 새기 | 반복 경고에 오류 요약 대신 원래 오류(매개변수의 계정 ID)를 실음 | 잡힘 | ⑤ 반복, ⑤ 실패 지표 |
| M46 | ⓙ | 내부 경로에서 내부 토큰 가드를 뺌 | 잡힘 | ③ 내부 파기 경로 |
| M47 | 내부 경로 | 내부 경로 `purgeAccount`가 다시 정리 예약을 만듦 | 잡힘 | ③ 둘 |
| M48 | 입력 확인 | `purgeWithdrawn`이 계정 ID UUID 확인을 뺌 | 잡힘 | ④ 탈퇴 시각을 읽지 못하거나 계정 ID가 틀리면… |
| M49 | 입력 확인 | `withdrawalRecheckAt`이 date-time 모양 확인 없이 `Date.parse`만(날짜만 있는 `2026-11-16`도 받음) | **살아남음** | — |
| M50 | 예약 차례 | 때가 된 예약을 늦은 것부터 잡음(메모리) | 잡힘 | ⑤ 100개씩 예약 시각 차례로 |
| M51 | 밀린 시간 | 밀리지 않은 예약에 음수 밀린 시간(`Math.max(0, …)` 뺌, 메모리) | 잡힘 | ⑤ 밀린 시간은 정각에 0 |
| M52 | 장애 삼킴 | 처리기가 저장소 실패를 삼키고 0건으로 넘어감 | 잡힘 | ④ 처리기는 … 저장소가 실패하면 함께 실패한다 |
| M53 | 묶음 크기 | 반복이 받은 묶음 크기를 넘기지 않음 | 잡힘 | ⑤ 반복 둘 |
| M54 | 시작 | 반복이 켜자마자 돌지 않고 한 간격 쉰 뒤 돎 | 잡힘 | ⑤ 반복 셋 |
| M55 | §2 ⓒ의 단위 몫·예약 빼먹기 | `purgeWithdrawn`이 예약 없는 `purgeByAccount`를 부름 | 잡힘 | ④·⑤ 등 6 |
| M56 | 정비 일 목록 | `CORE_MAINTENANCE_TASK_NAMES`에서 `review-purge-legacy`를 뺌 | 잡힘 | ⑧ 정비 일 목록 |
| M57 | 조립 | `main.ts`가 반복에 처리기와 다른 Reviews(`reviews`)를 넘김 | 잡힘 | ⑤ 소비자를 켜면…(원문 대조) |
| M58 | 예약 고치기 | 같은 계정 예약을 고칠 때 만든 시각도 지금으로 덮음(메모리 `purgeWithdrawnAccount`) | **살아남음** | — |
| M59 | 묶음 크기 | 메모리 `runDueRechecks`가 `limit`을 보지 않음 | 잡힘 | ⑤ 100개씩 |
| M60 | 처음부터 통과(COV2-06 ③) | decode가 계정 ID를 소문자로 바꾸지 않음 | 잡힘 | COV2-06 ③ |
| M61 | 처음부터 통과(COV2-06 ④) | 모양이 틀린 사건을 빈 사건으로 넘김 | 잡힘 | COV2-06 ④ |
| M62 | 처음부터 통과(COV2-06 ⑤) | `eventKeyOf`가 계정 ID를 줌 | 잡힘 | COV2-06 ⑤ |
| M63 | A1 등록 | 실패 수 지표를 등록부에 있어도 새로 만듦 | 잡힘 | ⑤ 같은 등록부에 반복을 두 번 켜도… |

- **같은 뜻이라 넣지 않은 것**: 정비 일 커서 `id > after` → `>=`(A2 ⓒ 앞쪽). 앞 묶음의 마지막 행은 이미 파기 칸이라 대상 조건에 다시 걸리지 않아 결과가 같다(메모리·Drizzle 모두). 해가 없는 변이라 표본에서 뺐다.

### 살아남은 것(시험 담당에게 넘김)

| ID | 무엇이 빈가 | 위험 | 넘김 |
| --- | --- | --- | --- |
| M49 | `I-T83 ④ 예약 시각은 min(탈퇴 시각, 처리 시각) + 16분이고 탈퇴 시각을 읽지 못하면 실패한다`의 거절 목록(`'어제'`·`''`·`'2026-13-45T99:00:00Z'`)에 날짜만 있는 글(`2026-11-16`)이나 시간대 없는 글(`2026-11-16T03:00:00`)이 없다. 구현 담당이 정한 것 5(계약 date-time 모양을 먼저 본다)를 지키는 단언이 없어 모양 확인을 빼도 통과한다 | 낮음. 사건 경로는 decode가 계약 Zod(`iso.datetime({ offset: true })`)로 먼저 거른다. 시간대 없는 글을 `Date.parse`가 지역 시각으로 읽어 예약이 서버 시간대만큼 어긋나는 일은 직접 부르는 길에서만 생긴다 | **시험 담당에게 넘김** |
| M58 | 메모리 저장소에서 같은 계정 예약을 고칠 때 '만든 시각은 처음 값'을 보는 단위 단언이 없다(시험 담당이 정한 것 2가 일부러 단언하지 않았다). 단위 시험은 메모리 대역만 보므로 대역이 정본과 어긋나도 모른다 | 낮음. 실제 저장소는 `core_app`이 `due_at`만 고칠 수 있어(0026) 만든 시각을 덮으면 42501로 실패하고, 통합 `I-T83 ④ 같은 계정 예약은 늦은 쪽을 남긴다`가 Docker에서 그것을 볼 수 있다(아래 D11) | **시험 담당에게 넘김**(단위에 만든 시각 단언 하나를 더하거나, 대역의 뜻이라 두기로 정하면 그렇게 적는다) |

### Docker 대기 목록(돌리지 않았다, 감독이 도커 잠금을 잡은 뒤)

- 먼저 바꾸지 않은 코드로 아래 통합 일곱 파일이 모두 통과하는지 본다(통합은 이 묶음에서 아직 한 번도 돌지 않았다). core-svc 폴더에서: `npx vitest run --config vitest.integration.config.mjs test-int/review-purge.int.test.ts test-int/review-recheck.int.test.ts test-int/review-withdrawn.int.test.ts test-int/review-grants.int.test.ts test-int/review-purge-legacy.int.test.ts test-int/sale-eligibility.int.test.ts test-int/review-withdrawn-consumer.int.test.ts`(마지막은 Kafka 컨테이너. 이 PC에서 네이티브 Kafka 모듈이 막히면 CI에서만).
- 그다음 변이마다 한 곳을 바꾸고 → 표의 파일만 `npx vitest run --config vitest.integration.config.mjs <파일>` → `git -C D:/ticketpass-lane3-w8b checkout -- <바꾼 파일>`. 0026을 바꾸는 변이는 시험 DB가 마이그레이션을 처음부터 다시 돌리는지 확인한다.

| ID | 틀린 구현(`services/core-svc/` 아래) | 돌릴 파일(`test-int/`) | 잡아야 할 시험 |
| --- | --- | --- | --- |
| D01 | `drizzle-review-store.ts` `purgeSet`에서 `rating = null` 빼기(§1 ⓐ) | `review-withdrawn.int.test.ts`, `review-purge.int.test.ts` | ①⑥ Drizzle 파기, ⑥ 작성자 지우기 |
| D02 | `purgeSet`에서 `content_fingerprint = null` 빼기(§1 ⓐ) | 〃 | 〃 |
| D03 | `purgeSet`에서 `notice = null, notice_until = null` 빼기(ⓘ) | `review-withdrawn.int.test.ts` | ①⑥(통보로 가린 행) |
| D04 | `deleted_at = coalesce(deleted_at, …)` → `deleted_at = …`(§1 ⓔ) | `review-withdrawn.int.test.ts`, `review-purge-legacy.int.test.ts` | ①⑥ 지운 시각 그대로, ⑧ |
| D05 | `purgeAccountRows`의 `where account_id = …` → `where id = …`(§1 ⓒ) | `review-withdrawn.int.test.ts` | ①⑥ |
| D06 | `purgeAccountRows`에 `and status <> 'DELETED'` 더하기(§1 ⓓ) | 〃 | ①⑥(이미 지운 행) |
| D07 | `purgeWithdrawnAccount`: 예약 upsert를 `this.database.db`로 트랜잭션 밖에서 먼저 따로 커밋(§2 ⓒ, 예약 먼저) | `review-recheck.int.test.ts` | ④ 파기가 실패하면 다시 정리 예약도 남지 않는다(A3, 처음부터 통과 예상 시험) |
| D08 | `purgeWithdrawnAccount`: 파기를 `this.database.db`로 먼저 따로 커밋한 뒤 예약(§2 ⓒ, 파기 먼저) | 〃 | ④ 파기와 예약은 한 트랜잭션이다 |
| D09 | 잠금 차례 뒤집기: 같은 트랜잭션에서 파기 → 예약 upsert | `review-recheck.int.test.ts`, `review-withdrawn-consumer.int.test.ts` | 예상: 살아남음(교착 40P01을 일으키는 시험이 없다). 살아남으면 시험 담당에게 넘김 |
| D10 | `greatest(review_withdrawal_recheck.due_at, excluded.due_at)` → `excluded.due_at`(§2 ⓓ) | `review-recheck.int.test.ts` | ④ 같은 계정 예약은 늦은 쪽을 남긴다 |
| D11 | `do update set due_at = …, created_at = excluded.created_at`(M58의 실제 저장소 쪽) | 〃 | ④ 같은 계정 예약은 늦은 쪽(42501 예상) |
| D12 | `runDueRechecks`의 `due_at <=` → `<`(§2 ⓑ) | 〃 | ⑤ 두 반복이 겹쳐도…(정각 예약) |
| D13 | `runDueRechecks`에서 `for update skip locked` 빼기(§2 ⓕ) | 〃 | ⑤ 다른 연결이 잠근 예약은 건너뛰고 기다리지 않는다 |
| D14 | `runDueRechecks`에서 예약 `delete` 빼기(§2 ⓔ) | 〃 | ⑤ 두 반복이 겹쳐도… 처리한 예약은 지운다 |
| D15 | `runDueRechecks`에서 `order by due_at` 빼기 | 〃 | 예상이 불분명(살아남으면 넘김) |
| D16 | `oldestOverdueRecheckMs`의 `Math.max(0, …)` 빼기 | 〃 | ⑤ 가장 오래 밀린 예약의 지난 시간 |
| D17 | `purgeLegacyRows` 대상에서 `or (status <> 'DELETED' and account_id = id)` 빼기(A2 ⓐ) | `review-purge-legacy.int.test.ts` | ⑧ 정비 역할로 이전 판 행을… |
| D18 | `purgeLegacyRows` 첫째 꼴을 `rating is not null`만으로(A2 ⓑ) | 〃 | 〃 |
| D19 | `purgeLegacyRows`에서 `for update skip locked` 빼기 | 〃 | ⑧ 잠긴 행을 건너뛰고 기다리지 않으며… |
| D20 | `purgeLegacyRows`에서 `lock_timeout` 설정 빼기 | 〃 | 예상: 살아남음(SKIP LOCKED라 행 잠금은 기다리지 않아 거의 같은 뜻). 기록만 |
| D21 | `softDeleteReview`를 옛 칸(`status`·`body`·`author_display`·`updated_at`)만으로(§1 ⓕ) | `review-purge.int.test.ts` | ⑥ 작성자가 지운 후기도 같은 칸을 비우고… |
| D22 | 0026 정비 역할 UPDATE에서 `"deleted_at"` 빼기(좁히기) | `review-purge-legacy.int.test.ts`, `review-grants.int.test.ts` | ⑧(42501), ⑦⑧ 허용 쪽 대조군 |
| D23 | 0026 `review_live_complete_check`에서 `content_fingerprint is not null` 빼기 | `review-purge.int.test.ts` | ⑦ 살아 있는 후기는 별점·지문 없이 넣을 수 없다 |
| D24 | `purgeAccountRows`의 `where account_id = $1::uuid` → `where account_id::text = $1`(색인을 못 씀) | `review-withdrawn.int.test.ts` | ① 탈퇴 파기는 review_account_idx로 찾는다(COV2-06 K2, 처음부터 통과 예상 시험) |
| D25 | `coreMaintenanceTasks`의 후기 정비 일 차례를 바꾸거나 `review-purge-legacy`를 뺌 | `sale-eligibility.int.test.ts` | 정비 일 조립 단언(시험 이의 2로 기대를 고친 것) |
| D26 | `start.ts`가 반복을 켜지 않음(M22의 실제 쪽, §2 ⓗ) | `review-withdrawn-consumer.int.test.ts` | ④ 실제 Kafka 탈퇴 사건 뒤 예약 행이 생기고 반복이 그 시각에 다시 파기한다 |
| D27 | 0026 예약 표 `core_app`의 `UPDATE ("due_at")`를 칸 없는 `UPDATE`로(ⓝ) | `review-recheck.int.test.ts` | ⑦ 예약 표 권한(`core_app`의 `account_id` 고치기 42501) |

- 처음부터 통과로 적힌 통합 시험 가운데 A3은 D07로, COV2-06 K2는 D24로 실패를 한 번 본다. COV2-06 ⑮⑯과 `review.int.test.ts` 다섯은 이 묶음이 바꾸지 않은 동작이라 바꾸지 않은 코드로 통과하는지만 본다.

### 판정 기준 대조(docs/features/identity.md §12 I-T83 세부 ①~⑧)

| 세부 | 정본 기준 | 단언하는 시험 | 대조 |
| --- | --- | --- | --- |
| ① | A의 후기 모두 '후기 파기' 칸대로 비우고 DELETED, 이미 지운 후기의 지운 시각 그대로, B 그대로 | 단위 ①(review-withdrawn), 통합 ①⑥ | 맞음. 칸 하나씩 남기는 변이(M01~M09)와 계정·상태 변이(M10·M11)가 모두 단위 ①·⑥·⑧에서 잡혔다 |
| ② | 목록·요약(평균 별점·후기 수)에서 빠지고 상세 404 | 단위 ②(review-purge) | 맞음. 처리 전 대조군(3건·3.3)이 있고 M03·M10에서 실패했다 |
| ③ | 같은 사건·`/purge`를 다시 해도 0건, 행 그대로 | 단위 ③ 셋 | 맞음. 가드(M46)·예약(M47)·옛 경로 404까지 본다 |
| ④ | 같은 트랜잭션에 탈퇴 시각 + 16분 예약(미래면 처리 시각 + 16분), −1ms에 남고 정각에 파기, 예약 쓰기가 실패하면 파기도 없다 | 단위 ④ 다섯, 통합 ④ 셋 | 시간·경계는 맞음(M14~M18 잡힘). '한 트랜잭션'은 통합에서만 본다(D07·D08 대기). 날짜 모양 거절은 기준 밖의 빈자리(M49) |
| ⑤ | 마친 예약 지움, 두 파드가 겹쳐도 한 번, 밀린 시간 지표, 실패해도 밀린 시간 새 값·실패 수 증가·마지막 성공 그대로 | 단위 ⑤ 일곱, 통합 ⑤ 셋 | 맞음(M19~M29·M50~M54·M63 잡힘). '두 파드'는 통합에서만(D13·D14 대기) |
| ⑥ | 작성자 지우기도 같은 칸, 같은 회차에 새 후기 | 단위 ⑥, 통합 ⑥ 둘, `review.http.test.ts` 다시 쓰기 | 맞음(M12 잡힘) |
| ⑦ | 살아 있는 후기는 별점·지문 없이 못 넣음, 예약 표는 앱 역할의 읽기·넣기·지우기·예약 시각 고치기만 | 단위 ⑦ 둘(SQL 원문), 통합 ⑦ 둘 | 원문 쪽은 맞음(M39~M43 잡힘). 실제 CHECK·권한 거절은 통합에서만(D23·D27 대기) |
| ⑧ | 이전 판 두 꼴만 고치고 제대로 파기된 행·다른 살아 있는 후기 그대로, 다시 하면 0, 그 뒤 VALIDATE 가능 | 단위 ⑧ 넷, ⑦⑧ 원문, 통합 ⑧ 둘, ⑦⑧ 권한 | 맞음(M30~M38·M56 잡힘). VALIDATE는 통합에서만 |

- **이름만 단 시험**: 찾지 못했다. 단위 I-T83 시험 25개와 처음부터 통과로 적힌 단위 시험(COV2-06 ③④⑤, 0026 원문 ⑦ 둘)은 모두 위 변이 가운데 하나 이상에서 실패했다. `I-T83 ⑤ 소비자를 켜면 반복도 켜지고…`는 원문 대조를 섞지만 동작 쪽(반복이 돈다·멈춤 차례)도 단언해 M22~M24에서 동작으로 실패했다.
- **구현 뒤에 맞춘 기대**: `sale-eligibility.int.test.ts`의 정비 일 목록(시험 이의 2)은 Docker 대기 D25로 실패를 본다. 단위에서는 같은 목록 상수(M56)가 실패를 냈다.
- **되돌림 확인**: 모든 변이 뒤 `git checkout -- <파일>`. 끝난 뒤 `git -C D:/ticketpass-lane3-w8b status --short`·`git diff`에 제품 코드 바뀜이 없다(이 절을 쓰기 전 확인).
