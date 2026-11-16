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
