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

### 10. 웨이브 끝 리뷰 반영 다시 보기(2026-11-17)

- **리뷰 담당**: `w8a2-relook-review`(claude-opus-5-5). 이 묶음의 계획·시험·구현은 맡지 않았고, 코드와 시험은 고치지 않았다. '다시 보기'는 고친 곳만 짧게 보는 리뷰다(ADR-0190 결정 2).
- **본 범위**: 시험 커밋 `e55ccab4`와 구현 커밋 `e6cad3c9`(`git diff HEAD~2 HEAD`), develop `d1d31a07` 위로 다시 쌓은 범위(`git range-diff c3b0935c..eed67724 origin/develop..e6cad3c9`). 아래 줄 번호는 `e6cad3c9` 기준이다.
- **돌린 것**: core-svc 단위 시험 여섯 파일(`review-withdrawn`·`review-recheck`·`review-purge-legacy`·`review-purge`·`review-purge-migration`·`migrations-journal`) 37개 모두 통과. 통합 시험(§9.4, 실제 PostgreSQL)은 돌리지 않았다(도커 차례는 감독 몫). 그래서 S1·C2의 DB 쪽 동작(권한·잠금·한 트랜잭션)은 아직 실제 DB에서 확인되지 않았다.

#### 10.1 지적마다 판정

| 지적 | 판정 | 확인한 것 |
| --- | --- | --- |
| S1 손으로 하는 파기 | **고쳐짐**(고치면서 새 결함 N1 하나) | 본문은 `{ reason: 10~500자, requestedBy: 1~64자 }`이고 모르는 칸을 받지 않는다(`internal-review.controller.ts:13`). 검사는 경로 스키마라 인증 가드 뒤에 400이 난다. 보류 행(처리하지 못해 `held_event`에 따로 옮겨 둔 사건) 조건이 §9.1과 같다: 토픽, `reprocessed_at is null`, `lower(business_key)` 또는 `lower(msg_key)`(`drizzle-review-store.ts:327-333`). 한 트랜잭션 안에서 보류 행 잠금(`FOR UPDATE`) → 예약(늦은 쪽, `greatest`) → 파기 → `reprocessed_at` 표시 차례다(`:323-344`). 보류 행이 없으면 아무것도 쓰지 않고 409 `withdrawal-not-held`다(`reviews.ts:339`). 운영 줄은 커밋 뒤에 남고, 칸은 `kind`·`requestedBy`·`reason`·`heldEventKeys`·`purged`뿐이라 계정 ID가 없다(`:340`). 로거는 전역 `PLATFORM_LOGGER`(`packages/platform/src/service.ts:36`, 전역 모듈)로 들어오므로 운영에서도 줄이 남는다. 0026에 GRANT 한 줄이 더해졌다(`0026_review_purge_recheck.sql:37`). 옛 `purgeByAccount`·`purgeAccount`는 지워졌고 부르는 곳도 남지 않았다. |
| C1 예약 셈 실패에도 파기 | **고쳐짐** | `withdrawalRecheckAt`이 던지면 처리 시각 + 16분으로 예약하고, 파기는 그대로 한다(`reviews.ts:351-363`). 처리기는 값과 계정 ID 없이 경고 한 줄을 남긴다(`account-withdrawn.handler.ts:81`). 운영 처리기 로거는 Pino라 `warn`이 있다(`main.ts:184`). `withdrawalRecheckAt` 자체의 엄격한 검사(검증에서 살아남았던 M49의 시험)는 그대로다(`domain/review.ts:220-224`). 대체 시각을 늘 쓰거나 파기를 건너뛰는 꼴(틀린 구현 표본 ⓒⓓ)은 없다. |
| C2 남은 대상 수 | **고쳐짐**(낮음 N2 하나) | 대상 조건 글을 한 곳(`LEGACY_ROWS`, `drizzle-review-store.ts:67`)에 두고 고치기(`:359`)와 세기(`:346-350`)가 같이 쓴다. 세기는 잠그지 않고 `SKIP LOCKED`도 쓰지 않는다(잠긴 행도 센다). 쓰는 칸은 정비 역할이 읽을 수 있는 칸(`id`·`status`·`rating`·`content_fingerprint`·`account_id`)뿐이다. 결과 `{ purged, remaining }`(`review-maintenance.ts:36-38`)는 플랫폼 정비 반복의 '정비 일 끝' 줄 `report`에 실린다(`packages/platform/src/maintenance.ts:101`). |

- **구현 커밋이 시험 파일을 건드렸나**: 건드리지 않았다. `e6cad3c9`는 `src/`와 `migrations/0026`의 아홉 파일만 바꿨다. 시험 커밋 `e55ccab4`의 제품 코드 변경은 뼈대(`throw new Error('아직 없음')`, 메모리 보류 사건 칸, 형식 내보내기)뿐이다.

#### 10.2 새 지적

| 번호 | 등급 | 파일:줄 | 내용 |
| --- | --- | --- | --- |
| N1 | 중간 | `services/core-svc/src/modules/review/adapters/db/drizzle-review-store.ts:342`, `…/adapters/memory-review-store.ts:222`, `…/application/reviews.ts:340-341`, `…/inbound/internal-review.controller.ts:14` | **eventKey가 없는 보류 행은 응답 수에서 빠지고 운영 줄에 흔적이 남지 않는다.** 응답의 `heldEvents`를 `heldEventKeys.length`로 세는데, `heldEventKeys`는 `event_key`가 null인 행을 뺀다. 플랫폼은 해독에 실패한 사건(값이 없거나 깨진 사건)을 `event_key` null로 보류한다(`packages/platform/src/keyed-consumer.ts:435-437`, `held_event.event_key`는 null 허용). 이 경로가 있는 까닭인 '값 없이 Kafka 키만 그 계정인 보류 행'이 바로 그 꼴이다. 그런 행 하나뿐인 계정을 처리하면 200 `{ purged, heldEvents: 0 }`이 나간다(응답 스키마 `positive()`와 어긋나지만, 응답 스키마는 직렬화에만 쓰여 막히지 않는다). 운영 줄에는 계정 ID도 eventKey도 없어 어느 보류 행을 처리했는지 알 수 없다. 보안 리뷰 S1이 든 ASVS 16.2.1('무엇을 했는지 기록')이 이 꼴에서 채워지지 않는다. 시험은 값 없는 행에도 eventKey를 넣어(`test-int/review-purge-manual.int.test.ts:109`, `test/review-withdrawn.test.ts:259`) 이 결함을 덮는다. **고칠 쪽**: 저장소가 처리한 보류 행 수(`held.length`)와 보류 행 ID(`held_event.id`, uuidv7이라 개인정보가 아니다. 또는 파티션·오프셋)를 돌려주고, `heldEvents`는 그 수로 센다. 운영 줄에는 eventKey 옆에 보류 행 ID를 싣는다. 시험은 값 없는 행을 `eventKey: null`로 넣는다. |
| N2 | 낮음 | `services/core-svc/src/modules/review/application/review-maintenance.ts:36-37`, `packages/platform/src/maintenance.ts:97` | 멈춤 신호로 끝났을 때도 남은 수를 센다고 적었지만, 플랫폼 정비 반복은 신호가 끊기면 결과를 적지 않고 빠져나간다(`if (taskSignal.aborted) break`가 '정비 일 끝' 줄보다 앞). 그래서 그때 센 `remaining`은 어디에도 남지 않고, 표 전체를 훑는 세기 한 번만큼 종료·리더 넘김이 늦어진다. 정본 조건('남은 대상 0')은 끝까지 돈 날의 줄로 판정하면 되므로 막는 지적은 아니다. 신호가 끊겼으면 세지 않거나, 주석을 실제 동작에 맞춘다. |
| N3 | 낮음(시험) | `services/core-svc/test-int/review-purge-manual.int.test.ts:127-133` | '보류 행 표시가 실패하면 파기·예약도 남지 않는다' 시험은 `REVOKE UPDATE (reprocessed_at) ON held_event FROM core_app`으로 마지막 문장만 실패하게 한다고 적었다. 그런데 `core_app`의 `held_event` 고치기 권한은 그 칸 하나뿐이고, PostgreSQL의 `SELECT … FOR UPDATE`는 칸 하나 이상의 UPDATE 권한이 있어야 한다. 그래서 첫 문장(보류 행 잠금, `drizzle-review-store.ts:327-333`)에서 42501로 끝나고, 예약·파기는 처음부터 돌지 않는다. '잠금·예약·파기를 한 트랜잭션에 두고 표시만 다른 트랜잭션에서 하는' 틀린 구현(§9.1 ⓔ의 한 꼴)도 이 시험을 통과한다. 고친 곳 검증 담당이 볼 것: 마지막 문장만 실패하게 하는 다른 수단(관리자 연결로 `held_event`에 잠시 `BEFORE UPDATE` 방아쇠를 걸어 오류를 내는 등)을 쓴다. |
| N4 | 낮음(정리) | `services/core-svc/src/modules/review/adapters/memory-review-store.ts:28-34` | 새 상수 `ACCOUNTS_WITHDRAWN`을 `isLegacyRow`의 설명 주석과 함수 사이에 넣어, 그 주석이 상수에 붙었다. 토픽 글은 이미 `ACCOUNTS_WITHDRAWN_TOPIC`(`account-withdrawn.handler.ts:9`)이 있는데 두 저장소에 같은 글을 따로 적었다. 동작에는 영향이 없다. |

- **확인했지만 지적하지 않은 것**
  - 잠금 순서: 손으로 처리는 보류 행 → 예약 행 → 후기, 탈퇴 사건 처리는 예약 행 → 후기, 다시 정리 반복은 예약 행(`SKIP LOCKED`) → 후기다. 플랫폼 다시 처리(RB-11)는 보류 행을 잠그지 않고 읽고, 처리기 트랜잭션이 끝난 뒤 따로 `reprocessed_at`을 적는다. 서로 거꾸로 기다리는 짝이 없어 교착(서로 잡은 것을 기다려 멈춤)이 생기지 않는다.
  - 권한: `core_app`은 0022의 `SELECT, INSERT`에 0026의 `UPDATE (reprocessed_at)`만 더 받는다. `FOR UPDATE`에 필요한 칸 UPDATE 권한도 이것으로 채워진다. 칸 권한이라 다른 토픽의 보류 행도 표시할 수 있는 것은 계획 §9.1이 받아들인 범위다.
  - 손으로 처리는 플랫폼의 업무 키 잠금(advisory lock)을 잡지 않는다. 그래서 같은 때 실시간 소비자가 같은 계정 사건을 새로 보류하면 그 행이 남을 수 있다. 하지만 그 행은 보류 수에 보이고, 다시 부르면 처리된다(409가 아니다). RB-11과 같은 꼴이라 새 결함으로 보지 않는다.
  - 본문 검사는 앞뒤 빈칸을 자르지 않아 빈칸 열 개짜리 사유도 받는다. 계획이 정한 모양 그대로다. 사유·요청자는 로그 가림 칸이 아니라 그대로 남는다. JSON 로그라 줄 바꿈을 넣어 다른 줄인 척하기는 어렵다.
  - 409 문제 응답의 `instance`에는 요청 경로(계정 ID 포함)가 실린다. 하지만 부른 쪽이 이미 아는 값이고, 운영 줄과 접속 줄에는 경로 틀만 남는다.

#### 10.3 충돌 해결 판정

- **`docs/architecture.md` ADR 목록 0278 행**: 맞다. 행 글은 원래 끝 `eed67724`와 한 글자도 다르지 않다. 자리는 develop의 0270 행 뒤, 0282 행 앞이다. `git diff origin/develop HEAD -- docs/architecture.md`는 이 한 줄을 더한 것뿐이고, develop이 더한 0281·0282 행은 그대로다(0281이 0267·0270 사이에 있는 것은 develop 쪽 차례다).
- **`services/core-svc/migrations/meta/_journal.json`**: 맞다. 0000~0023 줄은 develop과 같고, 0026 줄이 그 뒤에 붙었다. `when`은 0023 `1794789200000` < 0026 `1794811994338`로 차례대로 커지며, `migrations-journal.test.ts`가 통과한다. 0026 SQL과 `0026_snapshot.json`은 `eed67724`에서 바뀌지 않았다. 스냅숏의 `prevId`는 0022 스냅숏 ID(`07378a4f…`)여서, 손으로 쓴 0023을 건너뛰고 마지막 스냅숏에 잇는 이 저장소 규칙과 같다. 지금 있는 웨이브·갈래 가지에서 core-svc 0024~0026 파일은 이 가지의 0026뿐이라 번호가 겹치지 않는다.
  - 주의(지적 아님): 0024·0025는 빈 번호로 남는다. 나중에 누가 그 번호를 채우면 `when`이 0026보다 작아야 차례 시험을 통과하는데, 그러면 이미 0026을 돌린 DB에서 Drizzle이 그 파일을 조용히 건너뛴다. docs/PROGRESS.md의 '번호와 `when`은 develop보다 모두 커야 한다' 규칙이 이를 막으므로 다음 core-svc 마이그레이션은 0027부터다(W8-audit2b가 이미 0027).
- **`services/core-svc/src/main.ts`**(range-diff에 함께 나옴): 바뀐 것은 주변 줄(develop의 검색 연결 묶음)뿐이다. 연결 묶음 넷의 역할 확인(`assertDatabaseRole`, `main.ts:112-115`)은 그대로다.

#### 10.4 합쳐도 되나

높음은 없다. N1(중간)을 고치고, §9.4 통합 시험이 실제 DB에서 통과하는 것을 본 뒤 합친다. N2~N4는 정리 목록에 올려도 된다(N3은 고친 곳 검증 담당에게 넘긴다).

#### 10.5 N1·N3 반영 계획(2026-11-17)

- **계획 담당**: `w8a2-n1-plan`(claude-opus-5-5). 이 묶음의 시험·구현·리뷰는 맡지 않았다. 소유자 결정(2026-11-17): N1을 고친 뒤 합친다. N3도 함께 고친다. N2·N4는 갈래 3 구간 끝 정리 목록(docs/lanes/lane3.md, 이 계획 커밋)으로 넘긴다. 절 번호는 §10.1~10.4가 이미 있어 10.5로 했다.
- **차례**: 리뷰 반영이다. 시험 담당이 먼저 시험을 고치고 실패를 본다(`Role: review-fix`, `Fix-By: test`, `Finding: N1`·`N3`). 그다음 구현 담당이 고친다(`Fix-By: impl`, `Finding: N1`). N3은 시험만 고친다. 마이그레이션은 바꾸지 않는다(0026 그대로, 새 번호 없음. `core_app`의 `held_event` 읽기에 `id`가 이미 들어 있다).
- **정본(이 계획 커밋에 먼저 씀)**: docs/features/identity.md §8 '손으로 처리'(셈 기준·상한·응답·운영 줄)와 §12 I-T83 ⑨, docs/data.md §4의 15 '표 정의'(`id` 칸, 해독하지 못한 사건의 빈 `event_key`), docs/security/asvs/catalog-review.md v5.0.0-16.2.1(운영 줄 칸).

**정한 것(정본 docs/features/identity.md §8 '손으로 처리')**
- **셈 기준**: 이 호출이 `reprocessed_at`을 적은 보류 행 수다. `event_key`가 있든 없든 센다.
- **상한**: 한 번에 처리하는 보류 행은 보류 행 ID(`held_event.id`) 차례로 50개 [가정]까지다(`MANUAL_PURGE_HELD_LIMIT`). 한 계정의 탈퇴 사건은 하나라 보류 행은 같은 사건을 다시 받은 만큼(보통 몇 개)이다. 목록만 자르지 않고 처리 자체를 50개로 묶는다. 목록만 자르면 처리했는데 운영 줄에 없는 행이 생기기 때문이다. 남은 행이 있으면 다시 부르고, 409 `withdrawal-not-held`가 끝 신호다.
- **응답 200**: `{ purged: number(0 이상), heldEvents: number(1~50), heldEventIds: string[](uuid 1~50개, 보류 행 ID 차례, 길이 = heldEvents) }`.
- **운영 줄 `review-purge-manual`**(커밋 뒤 하나): `{ kind, requestedBy, reason, purged, heldEvents, held: [{ id, eventKey }] }`. `held`는 응답 `heldEventIds`와 같은 차례이고, 키 없는 행은 `eventKey: null`이다. 옛 칸 `heldEventKeys`는 없앤다. 계정 ID와, 계정 ID와 같은 값인 업무 키·Kafka 키는 싣지 않는다. 보류 행 ID는 보류한 시각과 무작위 값으로 만든 uuidv7이라 개인정보가 아니다.

| 나눔 | 파일·함수 | 고칠 것 |
| --- | --- | --- |
| 도메인 | `services/core-svc/src/modules/review/domain/review.ts`(`WITHDRAWAL_RECHECK_DELAY_MS` 옆, 210줄) | `export const MANUAL_PURGE_HELD_LIMIT = 50;` |
| 포트 | `…/review/domain/ports.ts` `ReviewStore.purgeHeldWithdrawal`(77줄) | 아래 꼴로 바꾼다. 설명 주석에 상한·차례·'키 없는 행 포함'을 적는다 |
| DB 저장소 | `…/review/adapters/db/drizzle-review-store.ts` `purgeHeldWithdrawal`(323~344줄, 리뷰의 342줄) | 잠금 문장을 `order by id limit ${o.limit} for update`로(`order by id`는 이미 있다). 돌려주는 값은 `held: held.map((h) => ({ id: h.id, eventKey: h.event_key }))`이다. 키 없는 행을 빼는 `flatMap`을 없앤다 |
| 메모리 저장소 | `…/review/adapters/memory-review-store.ts` `MemoryHeldEvent`(61줄)·`purgeHeldWithdrawal`(211~223줄, 리뷰의 222줄) | `MemoryHeldEvent`에 `id: string`(필수)을 더한다. 거른 행을 `id` 글자 차례(PostgreSQL uuid 차례와 같다)로 정렬해 `limit`개만 처리하고, `held`를 같은 꼴로 돌려준다 |
| 유스케이스 | `…/review/application/reviews.ts` `Reviews.purgeHeldWithdrawal`(335~342줄, 리뷰의 340~341줄) | 저장소에 `limit: MANUAL_PURGE_HELD_LIMIT`를 넘긴다. 운영 줄을 위 꼴로 바꾼다(`heldEventKeys` 없앰). 돌려주는 값은 `{ purged, heldEvents: r.held.length, heldEventIds: r.held.map((h) => h.id) }`이다. 주석 331줄의 '보류 사건 eventKey'도 고친다 |
| 내부 경로 | `…/review/inbound/internal-review.controller.ts` 응답 스키마 `View`(14줄)·머리 주석 | `z.object({ purged: z.number().int().nonnegative(), heldEvents: z.number().int().min(1).max(MANUAL_PURGE_HELD_LIMIT), heldEventIds: z.array(z.uuid()).min(1).max(MANUAL_PURGE_HELD_LIMIT) })` |
| 시험 | 고침: `services/core-svc/test/review-withdrawn.test.ts`(I-T83 ⑨ HTTP), `test/review-purge.test.ts`(I-T83 ⑨ 유스케이스), `test-int/review-purge-manual.int.test.ts`(N1·N3). 선택으로 단언 하나 더함: `test-int/review-withdrawn-consumer.int.test.ts` | 아래 표. `MemoryHeldEvent`를 넣는 곳(`review-withdrawn.test.ts:256`, `review-purge.test.ts:169`)에는 모두 `id`를 단다 |

```ts
// services/core-svc/src/modules/review/domain/ports.ts
/** 손으로 처리한 보류 행 하나 */
export interface HeldWithdrawalRow {
  /** held_event.id(uuid) */
  id: string;
  /** 해독하지 못한 사건이면 null */
  eventKey: string | null;
}
export interface ReviewStore {
  /**
   * 그 계정의 보류된 탈퇴 사건이 있으면 한 트랜잭션에서: 보류 행을 id 차례로 limit개까지 잠금 → 다시 정리 예약(recheckAtMs) → 파기 → 그 행들 reprocessed_at = nowMs.
   * held는 처리한 행 전부(id 차례, eventKey가 없는 행 포함). 보류된 사건이 없으면 아무것도 바꾸지 않고 undefined
   */
  purgeHeldWithdrawal(accountId: string, o: { nowMs: number; recheckAtMs: number; limit: number }): Promise<{ purged: number; held: HeldWithdrawalRow[] } | undefined>;
}

// services/core-svc/src/modules/review/application/reviews.ts
class Reviews {
  purgeHeldWithdrawal(accountId: string, by: { reason: string; requestedBy: string }): Promise<{ purged: number; heldEvents: number; heldEventIds: string[] }>;
}
// 운영 줄: logger.info({ kind: 'review-purge-manual', requestedBy, reason, purged, heldEvents, held: [{ id, eventKey }] }, '보류된 탈퇴 사건을 손으로 처리했다')
```

| 시험 이름 | 단계 | 단언(정본 값) | 비고 |
| --- | --- | --- | --- |
| `I-T83 ⑨ 키 없는 보류 행만 있는 계정도 처리한 보류 행 수와 ID를 돌려주고 운영 줄에 남긴다` | 단위 HTTP(`review-withdrawn.test.ts`, 새로) | 계정 G의 보류 행은 하나뿐이고 해독하지 못한 꼴이다(`{ id: H_G, eventKey: null, businessKey: 'unreadable-1', msgKey: G를 대문자로 }`). 부르면 200 `{ purged: 1, heldEvents: 1, heldEventIds: [H_G] }`, 그 행 `reprocessedAtMs` = 지금, 예약 = 지금 + 16분. 운영 줄은 정확히 하나이고 `purged: 1`, `heldEvents: 1`, `held: [{ id: H_G, eventKey: null }]`이며 `heldEventKeys` 칸이 없다. 줄 글(JSON)에 G·대문자 G가 없다 | N1의 꼴 그대로. 지금 구현은 `heldEvents: 0`이다 |
| `I-T83 ⑨ 키 있는 행과 없는 행이 섞인 계정은 모두 세고 ID 차례로 싣는다` | 단위 HTTP(`review-withdrawn.test.ts:336` 기존 시험을 고침) | A의 보류 행 셋: 업무 키가 A이고 키 있는 행(`KEY_A1`) 하나, 값을 읽지 못해 Kafka 키(대문자 A)만 A이고 **`eventKey: null`**인 행 둘(지금 시험은 값 없는 행에 `KEY_A2`를 넣어 결함을 덮는다, 리뷰 N1). 대문자 A로 부르면 200 `{ purged: 2, heldEvents: 3, heldEventIds: [세 ID를 글자 차례로] }`. 운영 줄 `held`는 `[{ id, eventKey: KEY_A1 }, { id, eventKey: null }, { id, eventKey: null }]`을 ID 차례로 담고, 응답 차례와 같다. 셋 다 `reprocessedAtMs` = 지금이고 다른 계정의 행은 그대로다. 다시 부르면 409 | ID는 차례가 정해진 고정 글자(예: `0190f3a1-7c2e-7a00-8000-0000000e0a01`~`a03`)로 쓰고, 넣는 차례를 ID 차례와 다르게(a03, a01, a02) 해 정렬을 본다 |
| `I-T83 ⑨ 한 번에 처리하는 보류 행은 50개까지이고 남은 행은 다시 불러 처리한다` | 단위 유스케이스(`review-purge.test.ts`, 새로, 메모리) | 계정 A의 후기 하나와 키 없는 보류 행 51개를 두되 보류 행은 ID 차례와 다른 차례로 넣는다. 첫 호출은 `{ purged: 1, heldEvents: 50, heldEventIds: ID 차례 앞 50개 }`이고, 가장 큰 ID 행만 `reprocessedAtMs`가 없다. 1분 뒤 두 번째 호출은 `{ purged: 0, heldEvents: 1, heldEventIds: [가장 큰 ID] }`이고 예약 = 두 번째 시각 + 16분(늦은 쪽)이다. 세 번째 호출은 409 | 상한·차례·끝 신호 |
| `I-T83 ⑨ 손으로 하는 파기는 계정 ID가 UUID가 아니면 거절하고 …`(`review-purge.test.ts:163` 기존) | 단위 유스케이스 | 기대 값을 `{ purged: 1, heldEvents: 1, heldEventIds: [그 행 ID] }`로 고친다 | 고침만 |
| `I-T83 ⑨ 보류된 탈퇴 사건이 있으면 파기하고 …`(`review-purge-manual.int.test.ts:99` 기존) | 통합(core PostgreSQL, `core_app`) | `h2`를 운영 꼴대로 `eventKey: null`로 넣고(값 없이 Kafka 키만 그 계정, 리뷰가 든 109줄), 키 없는 `h3`(업무 키 `unreadable-…`, Kafka 키 A)을 더한다. 결과는 `{ purged: 2, held: h1·h2·h3을 ID 차례로 }`이고 `h1`만 `eventKey: keyA1`, 나머지는 null이다. 세 행 `reprocessed_at` = 지금, 다른 계정 행은 null | 차례의 기준 값은 관리자 연결로 `order by id`해 읽는다 |
| `I-T83 ⑨ 키 없는 보류 행만 있는 계정도 처리하고 그 행 ID를 돌려준다` | 통합(새로) | 계정 G의 보류 행 하나(`event_key` null, `business_key` `unreadable-…`, `msg_key` 대문자 G). 결과는 `{ purged: 1, held: [{ id: h, eventKey: null }] }`, `reprocessed_at` = 지금, 예약 = 지금 + 16분 | 실제 SQL의 null 처리 |
| `I-T83 ⑨ 한 번에 잠그는 보류 행은 ID 차례로 50개까지다` | 통합(새로) | 계정 A에 키 없는 보류 행 51개(`randomUUID` ID). `limit: 50`으로 부르면 `held`의 ID는 관리자 연결로 `order by id`해 읽은 그 계정 보류 행 ID의 앞 50개와 같고, 나머지 하나만 `reprocessed_at`이 null이다. 다시 부르면 `held`가 그 하나다 | Drizzle 쪽 `limit`·`order by`는 메모리 시험으로 볼 수 없다 |
| `I-T83 ⑨ 보류 행 표시가 실패하면 파기·예약도 남지 않는다`(`review-purge-manual.int.test.ts:127` 기존을 고침, N3) | 통합 | 아래 '한 트랜잭션 증명' 차례대로. 거절 1건, 코드 `P0001`, 오류 글에 `i-t83-n3 recheck=1 review=DELETED`. 그 뒤 후기 VISIBLE, 예약 없음, `reprocessed_at` null. 방아쇠를 지운 뒤 다시 부르면 `purged: 1`, `held`가 `h1` 하나이고 셋 다 남는다 | 마지막 문장만 실패시켜 한 트랜잭션을 증명한다 |
| `I-T83 ① 실제 Kafka의 탈퇴 사건이 …`(`review-withdrawn-consumer.int.test.ts:128` 기존, 선택) | 통합(core Kafka + PostgreSQL) | 읽지 못한 사건의 보류 행 단언에 `event_key`가 null임을 더한다. N1의 전제(운영 소비자가 해독하지 못한 사건을 키 없이 보류한다)를 실제 소비자로 고정한다 | Kafka 네이티브 모듈이 이 PC에서 막히면 CI 몫 |

**한 트랜잭션 증명(N3)**: 리뷰가 짚은 대로 `REVOKE UPDATE (reprocessed_at)`은 쓰지 않는다. `core_app`의 `held_event` 고치기 권한은 그 칸 하나뿐인데 `SELECT … FOR UPDATE`는 칸 하나 이상의 UPDATE 권한이 있어야 해서, 첫 문장(보류 행 잠금)에서 42501로 끝나기 때문이다. 대신 마지막 문장(`update held_event set reprocessed_at …`)에만 걸리는 방아쇠(트리거, 행이 바뀌기 직전에 도는 함수)를 쓴다. 행 잠금(`FOR UPDATE`)은 방아쇠를 부르지 않는다.
1. 관리자 연결로 시험 전용 함수와 방아쇠를 만든다. 함수는 같은 트랜잭션에서 앞 문장들이 이미 돈 흔적을 읽어 오류 글에 싣는다. `<A>`·`<r1>`·`<h1>`은 시험이 만든 `randomUUID` 값을 글로 넣는다.
   ```sql
   create function i_t83_n3_fail() returns trigger language plpgsql as $$
   begin
     raise exception using errcode = 'P0001', message = format('i-t83-n3 recheck=%s review=%s',
       (select count(*) from review_withdrawal_recheck where account_id = '<A>'::uuid),
       (select status from review where id = '<r1>'::uuid));
   end $$;
   create trigger i_t83_n3 before update on held_event for each row when (old.id = '<h1>'::uuid) execute function i_t83_n3_fail();
   ```
   함수는 부른 역할(`core_app`)의 권한으로 돈다. `core_app`은 `review`와 `review_withdrawal_recheck`를 읽을 수 있다(0022). `when (old.id = …)`로 그 행에만 걸어 같은 파일의 다른 시험이 닿지 않게 한다.
2. `core_app` 저장소로 `purgeHeldWithdrawal(A, …)`를 부른다. 거절이 1건이고, 코드(오류 자신이나 `cause`의 `code`)는 `P0001`, 글(같은 곳의 `message`)에 `i-t83-n3 recheck=1 review=DELETED`가 들어 있다. 방아쇠는 그 트랜잭션 안에서 돌므로, 이 글은 잠금 → 예약 → 파기가 표시보다 먼저 **같은 트랜잭션**에서 돌았다는 증거다.
3. 관리자 연결로 보면 후기는 VISIBLE, 예약은 없음, `reprocessed_at`은 null이다(셋 다 되돌려졌다).
4. `finally`에서 `drop trigger if exists i_t83_n3 on held_event`와 `drop function if exists i_t83_n3_fail()`을 한다. 지운 뒤 다시 부르면 셋 다 남는다.

**틀린 구현 표본(N1·N3)**
- ⓐ `heldEvents`를 키 있는 행만 센다(지금 결함). 키 없는 행만 있는 계정의 단위·통합 시험(`heldEvents: 1`, `held` 길이 1)이 잡는다.
- ⓑ 응답 수는 바르게 세지만 운영 줄은 옛 `heldEventKeys`(키 있는 행만)를 그대로 싣거나 `held`에서 키 없는 행을 뺀다. 두 단위 HTTP 시험의 `held` 단언이 잡는다.
- ⓒ 키 없는 행의 `eventKey` 자리에 Kafka 키(`msg_key`)나 업무 키를 대신 싣는다(계정 ID가 운영 줄로 샌다). '줄 글에 G·대문자 G가 없다'와 `eventKey: null` 단언이 잡는다.
- ⓓ 상한 없이 모두 처리하고 목록만 50개로 자른다(처리 수와 목록이 어긋나고 51번째 행이 운영 줄에 없다). 상한 시험(51번째 `reprocessed_at` 없음, `heldEvents: 50`)이 잡는다.
- ⓔ 차례 없이 자른다(Drizzle에서 `order by id` 없이 `limit`, 메모리에서 넣은 차례대로 자름). 상한 시험의 'ID 차례 앞 50개'와 섞인 계정 시험의 차례 단언이 잡는다.
- ⓕ 표시를 파기와 다른 트랜잭션에서 한다. 잠금·예약·파기를 커밋한 뒤 표시하면 후기 DELETED가 남고, 표시를 먼저 따로 하면 방아쇠 오류 글이 `recheck=0 review=VISIBLE`이 된다. 고친 N3 시험이 두 꼴을 다 잡는다. 지금 시험(REVOKE)은 둘 다 첫 문장에서 42501로 끝나 놓친다.

**돌릴 통합 시험(도커 잠금 아래, 합치기 전 조건)**
- core-svc 폴더에서: `cd D:/ticketpass-lane3-w8b/services/core-svc && npx vitest run --config vitest.integration.config.mjs test-int/review-purge-manual.int.test.ts test-int/review-purge-legacy.int.test.ts test-int/review-recheck.int.test.ts test-int/review-grants.int.test.ts test-int/review-withdrawn.int.test.ts`(§9.4와 같은 다섯. 리뷰 §10.4의 '실제 DB에서 통과' 조건을 이것으로 채운다)
- 선택(Kafka): `npx vitest run --config vitest.integration.config.mjs test-int/review-withdrawn-consumer.int.test.ts`
- 싼 게이트: `pnpm --dir D:/ticketpass-lane3-w8b/services/core-svc test`·`typecheck`, 닿는 경로 `npx eslint`, 문서 점검(`python -I -X utf8 tools/doc-check/check_all.py`).

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

### 웨이브 끝 리뷰 반영(시험 쪽, 계획 §9의 S1·C1·C2, 2026-11-16)

- **누가·언제**: 시험 담당(세션 `l3w8-a2a-test`), 2026-11-16. 계획 보탬 `3b02a0a5` 위. Docker 없이 돌렸다.
- **뼈대(동작 없음)**: `ReviewStore.purgeHeldWithdrawal`·`countLegacyRows` 포트와 메모리·Drizzle 저장소의 '아직 없음', `Reviews.purgeHeldWithdrawal` '아직 없음', 메모리 저장소의 시험용 보류 사건 칸 `heldEvents: MemoryHeldEvent[]`(`topic`·`eventKey`·`businessKey`·`msgKey`·`reprocessedAtMs?`, `review/index.ts`에서 형을 내보냄). 내부 경로의 본문·409, `purgeWithdrawn`의 대체 예약 시각, 정비 일의 `remaining`, 0026 GRANT는 구현 담당 몫이다.
- **기존 시험을 고친 것(정본이 바뀌어)**: 옛 내부 경로 시험(본문 없이 어떤 계정이든 파기, 예약 없음)을 S1 시험으로 바꿨다(`review-withdrawn.test.ts`, `review-purge.test.ts`의 `purgeAccount` 시험 → `purgeHeldWithdrawal`). `review-recheck.test.ts`의 '탈퇴 시각을 읽지 못하면 파기도 예약도 하지 않는다'는 C1과 반대라 '계정 ID가 틀리면…'으로 좁히고 탈퇴 시각 쪽을 C1 시험으로 옮겼다. `review-purge-legacy`(단위·통합)의 결과 단언에 `remaining`을 더했다. 통합 `review-grants.int.test.ts` ⑮의 거부 목록에서 'held_event 다시 처리 표시'를 빼고 `error` 고치기·지우기 거부를 넣었다(S1이 그 칸 고치기를 준다). 통합 `review-withdrawn.int.test.ts` ①⑥은 없어질 수 있는 `purgeByAccount` 대신 `purgeWithdrawnAccount`로 부른다(단언 그대로).
- **단위**: `pnpm --dir D:/ticketpass-lane3-w8b/services/core-svc test` 시험 473개 가운데 **11개 실패, 462개 통과**. typecheck 오류 0.

| 지적 | 파일 | 시험 | 결과 | 실패 까닭 |
| --- | --- | --- | --- | --- |
| S1 | `test/review-withdrawn.test.ts`(바꿈) | I-T83 ⑨ 보류된 탈퇴 사건이 없는 계정은 손으로 파기할 수 없다 | 실패 | 단언: 보류 없음(B)이 409가 아니라 200(지금 경로는 어떤 계정이든 파기). 보류 없음·이미 다시 처리한 보류뿐·다른 토픽의 보류뿐·다른 계정의 보류만 있음 각각 409 `withdrawal-not-held`, 유스케이스 409·UUID 아님 422, 후기·보류 행·예약이 그대로 |
| S1 | 〃 | I-T83 ⑨ 사유·요청자 없이는 부를 수 없고 처리하면 운영 줄에 남는다 | 실패 | 단언: '본문 없음'이 400이 아니라 200. 토큰 없음·틀림 403, 본문 없음·사유 9자·501자·요청자 ''·65자·모르는 칸·칸 빠짐 각각 400, 옛 `/anonymize` 404, UUID 아님 400, 바뀐 것 없음 |
| S1 | 〃 | I-T83 ⑨ 보류된 탈퇴 사건이 있으면 파기하고 보류 행을 다시 처리로 표시하며 예약을 쓴다 | 실패 | 단언: 응답이 `{ purged: 0 }`(앞 시험에서 이미 지운 뒤 옛 모양). 경계 안쪽 값(사유 10자·요청자 64자), 대문자 계정 ID, 보류 둘(업무 키·Kafka 키만) → 200 `{ purged: 2, heldEvents: 2 }`, 두 보류 행 `reprocessedAtMs` = 지금·다른 보류 그대로, 예약 = 지금 + 16분, 운영 줄 `review-purge-manual` 하나(요청자·사유·`heldEventKeys`·`purged`, 계정 ID 없음), 다시 부르면 409 |
| S1 | `test/review-purge.test.ts`(바꿈) | I-T83 ⑨ 손으로 하는 파기는 계정 ID가 UUID가 아니면 거절하고 보류 사건을 처리하면 지금 + 16분 예약을 쓴다 | 실패 | 뼈대 '아직 없음'(`purgeHeldWithdrawal`) |
| S1 | `test/review-purge-migration.test.ts`(더함) | I-T83 ⑦⑨ 0026은 core_app에 held_event의 reprocessed_at 고치기만 더 준다 | 실패 | 단언: 0026에 `held_event` GRANT가 없다. 기대 `core_app held_event UPDATE [reprocessed_at]` 하나, 지우기·넣기·읽기·표 전체·다른 역할·REVOKE 없음 |
| C1 | `test/review-recheck.test.ts`(더함) | I-T83 ④ 예약 셈이 읽지 못한 탈퇴 시각이어도 파기하고 처리 시각 + 16분으로 예약한다 | 실패 | 지금은 `탈퇴 시각(withdrawnAt)을 읽지 못했다`로 던진다. `…T03:00Z`(초 없음)·`…T03:00:00`(시간대 없음)·`어제`·'' 각각 파기(①의 칸)·다른 계정 그대로·예약 03:19(처리 03:03 + 16분), 처리기 `handle`에 바로 넣어도 던지지 않고 로그(경고 포함)에 그 값·계정 ID가 없다 |
| C1 | 〃 | I-T83 ④ 계약이 받는 탈퇴 시각마다 예약 시각이 나온다 | **처음부터 통과(이미 있는 동작)** | 계약 Zod가 받는 넷(`Z`, `.5Z`, `.123456789+09:00`, `+09:00`)을 `decode` → `handle`로 넣어 각자의 시각 + 16분. 검증 담당이 'C1 ⓓ 대체를 늘 씀' 틀린 구현으로 실패를 본다 |
| C1 | 〃(좁힘) | I-T83 ④ 계정 ID가 틀리면 파기도 예약도 하지 않는다 | **처음부터 통과(이미 있는 동작)** | 계정 ID 셋(UUID 아님·''·한 글자 더) 각각 422, 후기·예약 그대로 |
| C2 | `test/review-purge-legacy.test.ts`(고침·더함) | I-T83 ⑧ 기존 넷(결과에 `remaining`) | 실패 4 | 단언: 결과에 `remaining`이 없다(`{ purged: 5 }` 등). 끝까지 돌면 `remaining: 0`, 첫 묶음 뒤 멈추면 `remaining: 3` |
| C2 | 〃 | I-T83 ⑧ 남은 대상 수는 고치기와 같은 조건으로 센다 | 실패 | 뼈대 '아직 없음'(`countLegacyRows`). 대상 다섯(두 꼴, 지문만·계정만 남은 DELETED 포함)과 대상 아닌 셋(제대로 파기된 행, 계정 B 후기, 가린 살아 있는 후기)에서 실행 전 5, 멈춤 뒤 `{ purged: 2, remaining: 3 }`·3, 끝까지 `{ purged: 3, remaining: 0 }`·0, 대상 아닌 행 그대로 |

- **통합(도커 대기 — 돌리지 않았다)**: core-svc 폴더에서 `npx vitest run --config vitest.integration.config.mjs test-int/review-purge-manual.int.test.ts test-int/review-purge-legacy.int.test.ts test-int/review-recheck.int.test.ts test-int/review-grants.int.test.ts test-int/review-withdrawn.int.test.ts`(파일 하나씩 돌린다). 새 `test-int/review-purge-manual.int.test.ts`(S1, 기준 시각은 DB 서버 시각): '⑨ 보류된 탈퇴 사건이 없으면 아무것도 바꾸지 않는다'(보류 없음·다시 처리한 보류뿐·다른 토픽 → `undefined`, 예약 없음), '⑨ …파기하고 보류 행을 다시 처리로 표시하며 예약을 쓴다'(업무 키·대문자 Kafka 키 보류 둘, 다른 계정 보류 그대로), '⑨ 보류 행 표시가 실패하면 파기·예약도 남지 않는다'(`REVOKE UPDATE (reprocessed_at) ON held_event FROM core_app` 동안 거절 1건 42501, 후기·예약·보류 행 그대로, 돌린 뒤 셋 다 있음), '⑦⑨ 0026은 core_app에 held_event의 reprocessed_at 고치기만 더 준다'(대조군 OK, `error`·`value`·`business_key` 고치기·지우기·비우기 42501). 고침 `test-int/review-purge-legacy.int.test.ts`(C2): 잠긴 행 시험을 'I-T83 ⑧ 다른 트랜잭션이 잡은 이전 판 행은 남은 대상으로 센다'로 바꿔 `{ purged: 2, remaining: 1 }` → 풀린 뒤 `{ purged: 1, remaining: 0 }`, 첫 시험도 `remaining: 0`. 구현 전에는 모두 실패할 것으로 본다(review-grants ⑮·review-withdrawn ①⑥은 지금 구현으로 통과 예상).
- **틀린 구현 표본과 잡을 시험(예상)**: S1 ⓐ 보류를 안 봄 → ⑨ 첫 시험. ⓑ 다시 처리한 보류 인정 → C 계정. ⓒ 다른 토픽 인정 → D 계정. ⓓ Kafka 키를 안 봄 → 대문자 Kafka 키 보류(`heldEvents: 2`). ⓔ 표시를 다른 트랜잭션 → 통합 '보류 행 표시가 실패하면'. ⓕ 409에서 예약 → 첫 시험 예약 0. ⓖ 운영 줄에 계정 ID → 셋째 시험. ⓗ 본문 검사 빠짐 → 둘째 시험. C1 ⓐ 던짐·ⓑ NaN·ⓒ 파기 건너뜀 → C1 첫 시험, ⓓ 대체를 늘 씀 → '계약이 받는 탈퇴 시각마다'. C2 ⓐ `remaining` 없음·ⓑ `purged`로 셈·ⓓ 한 꼴만 셈 → 새 단위 시험, ⓒ 셀 때 SKIP LOCKED → 통합 '다른 트랜잭션이 잡은…'(`remaining: 1`).

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

### N1·N3 시험(2026-11-17)

- **누가·언제**: 시험 담당(세션 `w8a2-n1-test`, claude-opus-5-5), 2026-11-17. 시험 커밋 `966f754c`(계획 §10.5 `237fd7c6` 위)이고, 제품 동작은 `e6cad3c9` 그대로다. 이 지적의 계획·구현·리뷰는 맡지 않았다.
- **뼈대(동작 없음, 시험이 컴파일되게만)**: `MemoryHeldEvent`에 `id: string`(필수, 아직 쓰지 않음), `DrizzleReviewStore.purgeHeldWithdrawal` 옵션에 `limit?: number`(아직 쓰지 않음. 통합 시험이 `limit: 50`을 넘긴다). 포트(`limit` 필수, 돌려주는 값 `{ purged, held }`), `MANUAL_PURGE_HELD_LIMIT`, 유스케이스 응답·운영 줄, 내부 경로 응답 스키마는 구현 담당 몫이다. 통합 시험은 저장소의 돌려주는 값을 통째로 `toEqual`해 `held` 칸을 읽지 않으므로 지금 모양에서도 컴파일된다.
- **단위**: core-svc 폴더 `node_modules/.bin/vitest run` 전체 **507개 가운데 4개 실패, 503개 통과**(파일 78개 가운데 2개 실패). 실패 넷은 모두 이번에 쓰거나 고친 I-T83 ⑨ 시험이다. `tsc --noEmit` 오류 0, 닿은 `src` 두 파일 eslint 오류 0.

| 파일 | 시험 | 결과 | 실패 까닭 |
| --- | --- | --- | --- |
| `test/review-withdrawn.test.ts`(고침, 옛 이름 '…보류된 탈퇴 사건이 있으면 파기하고…') | I-T83 ⑨ 키 있는 행과 없는 행이 섞인 계정은 모두 세고 ID 차례로 싣는다 | 실패 | 구현이 아직 안 함(ⓐ 그대로): 응답이 `{ purged: 2, heldEvents: 1 }`이다(키 있는 행만 셈, `heldEventIds` 없음). 값 없는 행의 `KEY_A2`를 `eventKey: null`로 바꾸고 키 없는 행을 하나 더해 셋, 넣는 차례 a03·a01·a02. 운영 줄 `held` 세 칸(`eventKey: KEY_A1`·null·null)·`heldEventKeys` 없음·계정 ID 없음, 다른 보류 행 그대로, 다시 부르면 409 |
| 〃(새로) | I-T83 ⑨ 키 없는 보류 행만 있는 계정도 처리한 보류 행 수와 ID를 돌려주고 운영 줄에 남긴다 | 실패 | 구현이 아직 안 함: 응답이 `{ purged: 1, heldEvents: 0 }`이다(리뷰 N1의 꼴 그대로). 운영 줄 `held: [{ id, eventKey: null }]`, 줄 글에 G·대문자 G 없음, 예약 = 지금 + 16분 |
| `test/review-purge.test.ts`(고침) | I-T83 ⑨ 손으로 하는 파기는 계정 ID가 UUID가 아니면 거절하고 보류 사건을 처리하면 지금 + 16분 예약을 쓴다 | 실패 | 구현이 아직 안 함: `heldEventIds`가 없다(`{ purged: 1, heldEvents: 1 }`) |
| 〃(새로) | I-T83 ⑨ 한 번에 처리하는 보류 행은 50개까지이고 남은 행은 다시 불러 처리한다 | 실패 | 구현이 아직 안 함: 첫 호출이 `{ purged: 1, heldEvents: 0 }`이다(키 없는 51개를 모두 처리하고 0으로 셈) |

- 같은 묶음의 다른 ⑨ 둘(409·400)은 보류 행에 `id`를 단 것 말고는 바꾸지 않았고 그대로 통과한다.
- **통합**(도커 잠금 아래 2026-11-17 11:56~11:59 KST, 이 작업 폴더, `PEAKET_TEST_CONTAINER_PREFIX=w8a2n1-`): core-svc 폴더 `node_modules/.bin/vitest run --config vitest.integration.config.mjs <파일>`로 파일 하나씩 돌렸다. 시간 초과(환경)로 난 실패는 없다.

| 파일 | 시험 | 결과(`e6cad3c9` 동작) | 까닭 |
| --- | --- | --- | --- |
| `test-int/review-purge-manual.int.test.ts` | I-T83 ⑨ 보류된 탈퇴 사건이 없으면 아무것도 바꾸지 않는다 | 통과 | `limit: 50`을 넘기게 한 것뿐이다 |
| 〃(고침) | I-T83 ⑨ 보류된 탈퇴 사건이 있으면 파기하고 보류 행을 다시 처리로 표시하며 예약을 쓴다 | 실패 | 구현이 아직 안 함: 돌려주는 값에 `held`가 없다(`heldEventKeys` 꼴). `h2`를 `eventKey: null`로, 키 없는 `h3`(Kafka 키 소문자)을 더했다. 기대 차례는 관리자 연결의 `order by id`이고, 넣은 값(h1만 키 있음)을 먼저 본다 |
| 〃(새로) | I-T83 ⑨ 키 없는 보류 행만 있는 계정도 처리하고 그 행 ID를 돌려준다 | 실패 | 구현이 아직 안 함: `{ purged: 1, heldEventKeys: [] }` |
| 〃(새로) | I-T83 ⑨ 한 번에 잠그는 보류 행은 ID 차례로 50개까지다 | 실패 | 구현이 아직 안 함: `{ purged: 1, heldEventKeys: [] }`(51개를 모두 처리) |
| 〃(고침, N3) | I-T83 ⑨ 보류 행 표시가 실패하면 파기·예약도 남지 않는다 | 실패(마지막 단언만) | 방아쇠 부분(거절 1건, `P0001`, 글에 `i-t83-n3 recheck=1 review=DELETED`, 후기 VISIBLE·예약 없음·`reprocessed_at` null)은 **처음부터 통과(이미 있는 동작)**다. 지금 구현이 이미 한 트랜잭션이기 때문이다. 실패는 방아쇠를 지운 뒤 다시 부른 값이 `held` 꼴이 아니라서다(N1 몫). 방아쇠·함수 만들기·지우기와 `core_app` 권한으로 함수가 도는 것도 이 실행으로 확인됐다 |
| 〃 | I-T83 ⑦⑨ 0026은 core_app에 held_event의 reprocessed_at 고치기만 더 준다 | 통과 | 바꾸지 않았다 |
| `test-int/review-withdrawn-consumer.int.test.ts`(고침, Kafka) | I-T83 ① 실제 Kafka의 탈퇴 사건이 core 후기를 파기하고, 읽지 못한 사건은 pid 없이 held_event에 보류된다 (COV2-06 ⑫) | 통과(파일 2개 모두) | **처음부터 통과(이미 있는 동작)**. 더한 단언: 읽지 못한 사건의 보류 행은 `event_key`가 null이고 `msg_key`가 보낸 Kafka 키다. N1의 전제(운영 소비자가 해독하지 못한 사건을 키 없이 보류한다)를 실제 소비자로 고정한다. 플랫폼 보류 쪽 동작이라 §10.5 ⓐ~ⓕ 가운데 이 단언을 겨누는 것은 없다. 이 PC에서 네이티브 Kafka 모듈은 막히지 않았다 |

- 통합 합계: `review-purge-manual` 6개 가운데 4개 실패·2개 통과, Kafka 파일 2개 통과.
- **이미 통과하는 부분을 틀린 구현으로 확인(손으로 넣고 되돌림, 같은 잠금 안)**: Drizzle `purgeHeldWithdrawal`만 잠시 바꿔 `review-purge-manual`을 다시 돌렸다.
  - 바른 꼴(`order by id limit … for update`, `held: held.map((h) => ({ id: h.id, eventKey: h.event_key }))`)을 넣으면 6개 모두 통과한다. 시험 기대 값이 정본대로 채운 구현과 맞는다.
  - ⓕ 표시를 먼저 따로(잠금·예약·파기 트랜잭션 앞에서 다른 문장으로 `reprocessed_at`을 적음): N3 시험이 오류 글 단언에서 실패했다. 받은 글은 `i-t83-n3 recheck=0 review=VISIBLE`이다.
  - ⓕ 커밋한 뒤 따로 표시: N3 시험이 `expected 'DELETED' to be 'VISIBLE'`에서 실패했다. 오류 글은 `recheck=1 review=DELETED`로 같지만 파기가 이미 커밋돼 남는다. 나머지 5개는 통과했다.
  - ⓔ 차례 없이 limit(`order by id`를 뺌): '50개까지' 시험이 `held` 차례 단언에서 실패했다(넣는 차례를 정해 두어 늘 실패한다). '섞인 계정' 시험도 이번에 함께 실패했지만, 이 시험의 ID는 무작위라 세 행의 넣은 차례가 우연히 ID 차례와 같으면(6분의 1) 통과할 수 있다. 차례는 '50개까지' 시험이 맡는다.
  - 단위도 바른 꼴(메모리 저장소의 ID 차례 정렬·50개, 유스케이스 응답·운영 줄, 내부 경로 응답 스키마)을 잠시 넣으면 두 파일 13개가 모두 통과한다. 이때 응답 스키마 `View`(`internal-review.controller.ts:14`)를 고치지 않으면 HTTP 두 시험이 `heldEventIds` 없음으로 실패했다(직렬화가 스키마에 없는 칸을 버린다). 구현 담당은 §10.5 표의 '내부 경로' 줄을 빠뜨리지 말 것.
  - 모두 되돌린 뒤 `git diff -- services/core-svc/src`가 위 뼈대 두 곳뿐임을 봤다. 이 담당이 띄운 컨테이너(`w8a2n1-`·Kafka)는 남지 않았고 잠금 폴더를 지웠다.
- **시험 담당이 정한 것(계획에 없던 세부)**
  1. 단위 보류 행 ID는 계획 예시(`…0000000e0a01`~`a03`)와 달리 `…0000000d0a01`~`a03`로 했다. 예시의 첫 값이 `KEY_A1`(eventKey)과 같은 글자라, ID 자리에 eventKey를 싣는 틀린 구현을 가려내지 못하기 때문이다. 다른 보류 행(C·D·F·G)에도 같은 꼴의 ID를 달았다.
  2. 단위 상한 시험에는 A의 어느 행보다 ID가 작은 다른 계정(B)의 키 없는 보류 행 하나를 더했다(거르기 전에 자르는 틀린 구현을 잡게). 넣는 차례는 `i × 7 mod 51`이고(맨 끝에 넣는 행은 ids[44]), 둘째 호출은 첫 호출 + 1분이다.
  3. 통합 시험은 저장소에 늘 `limit: 50`을 넘긴다(포트의 `limit`이 필수가 되어도 그대로 컴파일된다). 상한 시험의 ID는 `randomUUID` 51개를 정렬해 `i × 7 mod 51` 차례로 넣는다. 힙 차례가 넣은 차례라, `order by id` 없는 limit은 가장 큰 ID 대신 맨 끝에 넣은 행을 빠뜨린다(위 ⓔ 확인).
  4. 통합 '섞인 계정' 시험의 `h3`는 Kafka 키를 소문자 계정 ID로 넣었다(`h2`는 대문자).
  5. N3 방아쇠와 함수는 `try` 안에서 만들고 `finally`에서 지운다(만들다 실패해도 남지 않게). SQL 글에 넣는 세 값(계정·후기·보류 행 ID)이 UUID 모양인지 먼저 본다. 오류 글은 오류 자신과 `cause`의 `message`를 이어 붙여 본다(Drizzle은 드라이버 오류를 `cause`에 싼다).

### 검증 2에서 살아남은 V12·V24·V26·V27(2026-11-17)

- **누가·언제**: 시험 담당(세션 `w8a2-n1-test`), 2026-11-17. 시험 커밋 `061d9912`(검증 2 `260ed984` 위, 구현 `03a5e8b6` 동작). 시험 파일만 바꿨다.
- **더한·고친 시험**
  - 단위 `test/review-purge.test.ts`(새로)와 통합 `test-int/review-purge-manual.int.test.ts`(새로): `I-T83 ⑨ 손으로 하는 파기는 이미 지금 + 30분인 다시 정리 예약을 그대로 남긴다`. 정본 §8 '손으로 처리'의 '예약은 늦은 쪽이 남는다'를 본다. 대조로 지금 + 1분인 예약은 지금 + 16분으로 늦추고, 두 계정 모두 예약을 만든 시각은 그대로다.
  - 단위 HTTP `test/review-withdrawn.test.ts`(고침): `I-T83 ⑨ 키 없는 보류 행만 있는 계정도…`를 사유 500자·요청자 1자 본문으로 부르고, 운영 줄의 사유·요청자도 그 값으로 본다. 다른 쪽 끝(사유 10자·요청자 64자)은 '섞인 계정' 시험이 그대로 본다.
- **결과**: 지금 구현에서 단위 두 파일 14개, 통합 `review-purge-manual` 7개(도커 잠금 아래, 12:47에 끝) 모두 통과한다. 틀린 구현을 하나씩 손으로 넣고 되돌렸다. 넷 모두 잡혔다.

| 변이 | 넣은 곳 | 잡은 시험 | 실패한 단언 |
| --- | --- | --- | --- |
| V12 늦은 쪽 무시(메모리) | `memory-review-store.ts:227` `Math.max(…)` → `o.recheckAtMs` | 단위 '…지금 + 30분인 다시 정리 예약을 그대로 남긴다' | A의 예약이 지금 + 30분이 아니라 지금 + 16분 |
| V24 늦은 쪽 무시(Drizzle) | `drizzle-review-store.ts:341` `greatest(…)` → `excluded.due_at` | 통합 같은 이름 | A의 `due_at`이 지금 + 16분 |
| V26 사유 상한 500 → 499 | `internal-review.controller.ts:14` | 단위 HTTP '키 없는 보류 행만…' | 200 대신 400 |
| V27 요청자 하한 1 → 2 | 〃 | 〃 | 200 대신 400 |

- 되돌린 뒤 `git diff -- services/core-svc/src`가 비었다. 이 담당이 띄운 컨테이너(`w8a2n1-`)는 남지 않았고, 잠금 폴더를 지웠다.

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

### 다시 보기 2: N1·N3 반영(2026-11-17)

- **누가·언제**: 리뷰 담당(세션 `w8a2-relook-review`, claude-opus-5-5), 2026-11-17. 이 묶음의 계획·시험·구현은 맡지 않았고, 코드와 시험은 고치지 않았다. 웨이브 끝 리뷰 반영 다시 보기(`d5151d5c`, 계획 §10.1~10.4)의 이어 보기다. 그 결과는 §10에 그대로 두었다(§10.5가 그 번호를 이어 쓴다).
- **본 범위**: `git diff d5151d5c 03a5e8b6`. 계획 `237fd7c6`(§10.5와 정본 identity.md §8·§12 I-T83 ⑨, data.md §4의 15, catalog-review 16.2.1), 시험 `966f754c`, 실패 확인 `453bc399`, 구현 `03a5e8b6`. 줄 번호는 `03a5e8b6` 기준이다.
- **돌린 것**: core-svc 단위 `review-withdrawn`·`review-purge` 13개 통과. 통합 23개 통과는 구현 담당 보고(커밋 `03a5e8b6` 본문)대로 받고 다시 돌리지 않았다.
- **N1 고쳐짐**:
  - 셈: 키 없는 행을 빼던 `flatMap`이 없어지고, 처리한(`reprocessed_at`을 적은) 행 전부를 `held: { id, eventKey }[]`로 돌려준다(`drizzle-review-store.ts:344`, `memory-review-store.ts:230`). `heldEvents`는 그 길이다(`reviews.ts:342-347`).
  - 차례와 상한: Drizzle은 `order by id limit ${o.limit}::int for update`로 잠그고, 표시도 그 행에만 한다(`drizzle-review-store.ts:327-343`). 메모리는 거른 뒤 ID 글자 차례로 정렬해 자른다. 상한은 `MANUAL_PURGE_HELD_LIMIT = 50`이다(`domain/review.ts:216`). 목록만 자르는 꼴(§10.5 ⓓ)이 아니다.
  - 응답: 200 `{ purged, heldEvents(1~50), heldEventIds(uuid 1~50개) }`(`internal-review.controller.ts:16-20`).
  - 운영 줄: `{ kind, requestedBy, reason, purged, heldEvents, held: [{ id, eventKey }] }`이고 옛 `heldEventKeys`는 없다(`reviews.ts:344`). 업무 키·Kafka 키는 저장소가 읽지도 돌려주지도 않으므로 줄에 들어갈 길이 없다. 단위 HTTP 시험이 줄 글에 계정 ID(대·소문자)가 없음을 본다(`test/review-withdrawn.test.ts:383`·`:414`).
- **N3 고쳐짐**: REVOKE 대신 그 보류 행에만 걸린 `BEFORE UPDATE` 방아쇠(행이 바뀌기 직전에 도는 함수)를 쓴다(`test-int/review-purge-manual.int.test.ts:193-229`). 행 잠금(`FOR UPDATE`)은 방아쇠를 부르지 않으므로 마지막 문장만 실패한다. 오류 글 `recheck=1 review=DELETED`는 예약·파기가 같은 트랜잭션 안에서 먼저 돌았다는 뜻이다. 실패 뒤 '후기 VISIBLE·예약 없음·표시 없음'은 셋이 함께 되돌려졌다는 뜻이다. 둘을 함께 보므로 '먼저 커밋하고 따로 표시'와 '표시를 먼저 따로' 두 꼴(§10.5 ⓕ)을 모두 잡는다. 방아쇠와 함수는 `finally`에서 지운다. SQL 글에 넣는 값은 시험이 만든 UUID뿐임을 먼저 확인한다.
- **구현 커밋이 시험 파일을 건드렸나**: 건드리지 않았다. `03a5e8b6`는 `src/` 여섯 파일만 바꿨다. 시험 커밋 `966f754c`의 제품 코드 변경은 뼈대(`MemoryHeldEvent.id`, `limit?` 옵션)뿐이다.

| 번호 | 심각도 | 파일:줄 | 근거 | 고칠 쪽 |
| --- | --- | --- | --- | --- |
| N5 | 낮음 | `services/core-svc/src/modules/review/adapters/db/drizzle-review-store.ts:327-335` | PostgreSQL의 `… order by id limit n for update`는 행을 고른 뒤에 잠근다. 같은 계정을 두 번 겹쳐 부르면(운영자가 두 번 누름) 뒤 호출은 앞 호출이 잡은 앞 50개를 기다린다(RB-11 다시 처리와 겹치면 몇 행이 빠질 뿐 0행이 되지는 않는다). 앞 호출이 커밋하면 그 행들은 조건(`reprocessed_at is null`)에서 빠지는데, 51번째 행은 다시 찾지 않는다. 그래서 보류 행이 51개 넘게 남아 있어도 0행 → 409 `withdrawal-not-held`가 나올 수 있다. 정본은 409를 '끝 신호'로 쓰므로, 운영자가 보류 행이 남았는데 끝났다고 볼 수 있다. 한 계정의 보류 행이 50개를 넘는 일도 드물고 겹쳐 부르는 일도 드물어 낮음이다. 이미 파기는 했으므로 남는 것은 보류 행뿐이다. | 계획: 409 앞에 보류 행을 잠그지 않고 한 번 더 세어 남았으면 409 대신 0건 200(또는 재시도 안내)으로 할지, 아니면 런북에 '409 뒤 보류 수 지표로 확인'을 적을지 정한다. 갈래 3 정리 목록 후보 |

- **확인했지만 지적하지 않은 것**: 운영 줄의 `held`는 최대 50개라 한 줄 크기가 크지 않다. `held`·`id`·`eventKey`는 로그 가림 칸이 아니고 개인정보도 아니다(보류 행 ID는 uuidv7). 응답 스키마의 `min`·`max`·`uuid`는 직렬화에만 쓰여 응답을 막지 않지만, 값은 저장소가 늘 1~50개의 uuid로 채운다. 남은 행은 다시 부르면 처리된다(이미 파기한 후기는 0건, 예약은 늦은 쪽).
- **높음·중간**: 없다. **합치기**: N1·N3은 고쳐졌고 N5는 낮음이라 막지 않는다. 합쳐도 된다. 다만 앞 다시 보기 커밋 `d5151d5c`는 결과를 '## 리뷰' 절 밖(§10)에 적었다. 합치기 전 역할 확인에서 그 커밋을 어떻게 다룰지는 감독이 정한다.

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

### 검증 2: 웨이브 끝 리뷰 반영·N1(2026-11-17)

- **누가·언제**: 검증 담당(세션 `w8a2-verify2`, claude-opus-5-5), 2026-11-17. 가지 `wave/lane3-w8-audit2`, 끝 `15280379` 위. 이 묶음의 계획·시험·구현·리뷰는 맡지 않았고, 시험과 제품 코드는 고치지 않았다.
- **본 범위**: 앞 검증 뒤에 고친 제품 코드다. 웨이브 끝 리뷰 S1·C1·C2 구현 `e6cad3c9`(계획 §9.1~9.3)와 다시 보기 N1 구현 `03a5e8b6`(계획 §10.5). 비교 기준은 앞 검증 커밋의 지금 해시 `7a0e45c0`이다(rebase 전 해시 `5d502bc0`와 견주면 develop 변경까지 섞인다). `git diff 7a0e45c0 HEAD -- services/core-svc/src services/core-svc/migrations`는 10파일이다(0026은 GRANT 한 줄).
- **방법**: 틀린 구현(변이) 하나마다 제품 코드나 0026 원문 한 곳을 글 바꾸기로 넣고 → 닿는 시험을 돌리고 → `git checkout -- <파일>`로 되돌렸다. 넣기 전에 바꿀 글이 그 파일에 꼭 한 번 나오는지, 바꾼 파일이 TypeScript 문법으로 읽히는지를 먼저 봤다(문법 오류로 파일째 실패해 '잡힘'으로 세지 않게). 모든 실행에서 시험 수가 단위 68·통합 6(정비 일 파일은 2)으로 같아 파일째 실패한 변이는 없다.
  - 단위(Docker 없음): core-svc 폴더에서 `node_modules/.bin/vitest run test/review-withdrawn.test.ts test/review-purge.test.ts test/review-recheck.test.ts test/review-purge-legacy.test.ts test/review-purge-migration.test.ts test/core-consumers.test.ts test/review.test.ts test/review.http.test.ts test/review-grants.test.ts`. 바꾸기 전 68개 모두 통과.
  - 통합(실제 PostgreSQL 18): 도커 잠금 `D:/ticketpass-locks/docker`를 12:32~12:34, 12:38~12:39 KST에 잡고 core-svc 폴더에서 `node_modules/.bin/vitest run --config vitest.integration.config.mjs test-int/review-purge-manual.int.test.ts`(V25만 `test-int/review-purge-legacy.int.test.ts`). 바꾸기 전 두 파일 8개 통과. 컨테이너 이름 앞머리는 `w8a2v2-`이고, 끝난 뒤 그 이름의 컨테이너와 오늘 만든 빈 볼륨이 남지 않은 것을 보고 잠금을 풀었다.
- **수**: 넣은 30(단위 21, 통합 9), 잡힌 24, 살아남은 6(V12·V14·V23·V24·V26·V27). 같은 뜻이라 셈에서 뺀 것 하나(V03x). 처음 계획한 25개에, 본문 안쪽 경계 둘(V26·V27)과 '처음부터 통과'였거나 아직 한 번도 단언으로 실패하지 않은 시험의 실패를 보려는 셋(V28·V29·V30)을 더했다. V17은 통합에서도 한 번 더 넣었다(셈은 하나).
- 계획의 틀린 구현 꼴 가운데 넣은 것: §9.1 ⓐⓓⓔ(=§10.5 ⓕ)ⓕⓖⓗ, §9.2 ⓐⓓ, §9.3 ⓑⓒⓓ, §10.5 ⓐ~ⓕ(ⓕ는 두 차례 모두). 모두 잡혔다. 살아남은 여섯은 계획에 없던, 이번에 더 떠올린 꼴이다.

#### 변이 표

파일은 `services/core-svc/src/modules/review/` 아래이고(0026만 `services/core-svc/migrations/`), 줄은 `15280379` 기준이다. '잡은 시험'의 이름은 앞의 `I-T83`을 뺐다.

| ID | 꼴(계획 표본) | 넣은 곳 | 틀린 구현 | 결과 | 잡은 시험 |
| --- | --- | --- | --- | --- | --- |
| V01 | 조건 빼기(§9.1 ⓐ) | `adapters/memory-review-store.ts:224` | 보류 행이 없어도 예약·파기를 함 | 잡힘 | 단위 ⑨ '보류된 탈퇴 사건이 없는 계정은 손으로 파기할 수 없다', '키 있는 행과 없는 행이 섞인 계정은…', '키 없는 보류 행만 있는 계정도…', 유스케이스 '…UUID가 아니면 거절하고…', '…50개까지이고…'(5) |
| V02 | 409에서도 예약(§9.1 ⓕ) | `memory-review-store.ts:224-227` | 예약 쓰기를 '보류 없음' 확인 앞으로 옮김 | 잡힘 | 단위 ⑨ '…없는 계정은…'(예약 0개), '…섞인 계정은…'(예약 1개) |
| V03 | 운영 줄에 계정 ID(§9.1 ⓖ) | `application/reviews.ts:344` | 운영 줄에 `target: accountId`를 실음 | 잡힘 | 단위 ⑨ '…섞인 계정은…', '키 없는 보류 행만…'(줄 글에 계정 ID 없음) |
| V04 | 본문 검사 빠짐(§9.1 ⓗ) | `inbound/internal-review.controller.ts:30` | 경로 스키마에서 `body: PurgeBody`를 뺌 | 잡힘 | 단위 ⑨ '사유·요청자 없이는 부를 수 없고…'(400·바뀐 것 없음), '…섞인 계정은…' |
| V05 | 409 조건 뒤집기 | `reviews.ts:341` | 파기 0건이면 409(보류 행 표시는 이미 커밋됨) | 잡힘 | 유스케이스 ⑨ '…50개까지이고…'(둘째 호출 `purged: 0`이 200이어야 함) |
| V06 | 셈에서 키 없는 행 빼기(§10.5 ⓐ) | `reviews.ts:347` | 응답 `heldEvents`를 키 있는 행만 셈 | 잡힘 | 유스케이스 '…50개까지…', 단위 HTTP '…섞인 계정은…', '키 없는 보류 행만…'(3) |
| V07 | 운영 줄에서 키 없는 행 빼기(§10.5 ⓑ) | `reviews.ts:344` | 운영 줄 `held`에서 `eventKey: null` 행을 뺌 | 잡힘 | 단위 HTTP ⑨ 둘(`held` 단언) |
| V08 | Kafka 키로 채우기(§10.5 ⓒ) | `memory-review-store.ts:230` | 키 없는 행의 `eventKey` 자리에 `msgKey` | 잡힘 | 단위 HTTP ⑨ 둘(`eventKey: null`, 줄 글에 대문자 계정 ID 없음) |
| V09 | 목록만 자르기(§10.5 ⓓ) | `memory-review-store.ts:223·230` | 걸린 행을 모두 표시하고 돌려주는 목록만 50개 | 잡힘 | 유스케이스 '…50개까지…'(51번째 표시 없음) |
| V10 | 차례 없이 자르기(§10.5 ⓔ) | `memory-review-store.ts:218-222` | ID 정렬 없이 넣은 차례로 자름 | 잡힘 | 유스케이스 '…50개까지…', 단위 HTTP '…섞인 계정은…'(a01·a02·a03 차례) |
| V11 | 상한 끄기 | `reviews.ts:340` | 유스케이스가 `limit: 10_000`을 넘김 | 잡힘 | 유스케이스 '…50개까지…' |
| V12 | 늦은 쪽 무시(정본 §8 '손으로 처리') | `memory-review-store.ts:227` | 같은 계정 예약이 있으면 늦은 쪽 대신 이번 시각으로 덮음 | **살아남음** | — |
| V13 | 대체 없이 던짐(§9.2 ⓐ) | `reviews.ts:362-367` | 예약 셈이 던지면 그대로 던짐(파기 안 함) | 잡힘 | 단위 ④ '예약 셈이 읽지 못한 탈퇴 시각이어도 파기하고…' |
| V14 | 경고 줄 빠짐(§9.2) | `inbound/account-withdrawn.handler.ts:81` | 대체했을 때 경고 줄을 남기지 않음 | **살아남음** | — |
| V15 | 남은 수를 고친 수로(§9.3 ⓑ) | `application/review-maintenance.ts:38` | `remaining: purged` | 잡힘 | 단위 ⑧ 넷 |
| V16 | 세는 조건이 다름(§9.3 ⓓ) | `memory-review-store.ts:234` | 남은 수를 첫째 꼴(DELETED)만 셈 | 잡힘 | 단위 ⑧ '남은 대상 수는 고치기와 같은 조건으로 센다' |
| V17 | 0026 넓히기 | `migrations/0026_review_purge_recheck.sql:37` | `held_event` UPDATE를 칸 없이 | 잡힘 | 단위 ⑦⑨ '0026은 core_app에 held_event의 reprocessed_at 고치기만 더 준다'(원문), 통합에서도 같은 이름의 시험(`error` 고치기가 42501이 아님) |
| V18 | 조건 빼기(§9.1 ⓓ) | `adapters/db/drizzle-review-store.ts:332` | `or lower(msg_key) = …`를 뺌(Kafka 키만 맞는 행을 놓침) | 잡힘 | 통합 ⑨ '보류된 탈퇴 사건이 있으면 파기하고…', '키 없는 보류 행만…', '한 번에 잠그는 보류 행은 ID 차례로 50개까지다'(3) |
| V19 | 목록만 자르기(§10.5 ⓓ) | `drizzle-review-store.ts:334·344` | `limit` 없이 모두 잠그고 표시, 돌려주는 목록만 자름 | 잡힘 | 통합 '…50개까지다'(51번째도 표시됨) |
| V20 | 차례 없이 자르기(§10.5 ⓔ) | `drizzle-review-store.ts:333` | `order by id` 없이 `limit` | 잡힘 | 통합 '…50개까지다', '…있으면 파기하고…'(이쪽은 무작위 ID 셋이라 우연히 통과할 수 있고, 차례는 '50개까지'가 맡는다) |
| V21 | 트랜잭션 나누기(§10.5 ⓕ, 먼저 커밋) | `drizzle-review-store.ts:327·343` | 잠금·예약·파기를 커밋한 뒤 표시를 따로 | 잡힘 | 통합 '보류 행 표시가 실패하면 파기·예약도 남지 않는다'(후기 DELETED가 남음) |
| V22 | 트랜잭션 나누기(§10.5 ⓕ, 표시 먼저) | `drizzle-review-store.ts:327-344` | 보류 행을 잠그지 않고 찾아 표시를 먼저 따로 커밋, 예약·파기는 뒤 트랜잭션 | 잡힘 | 〃(방아쇠 오류 글에 `recheck=1 review=DELETED`가 없음) |
| V23 | 차례 바꾸기 | `drizzle-review-store.ts:338-342` | 같은 트랜잭션에서 파기 → 예약(잠금 차례 '예약 행 → 후기'가 뒤집힘) | **살아남음** | — |
| V24 | 늦은 쪽 무시(Drizzle) | `drizzle-review-store.ts:341` | `greatest(…)` → `excluded.due_at` | **살아남음** | — |
| V25 | 잠긴 행 빼고 세기(§9.3 ⓒ) | `drizzle-review-store.ts:350` | 남은 수를 `for update skip locked`로 셈 | 잡힘 | 통합 ⑧ '다른 트랜잭션이 잡은 이전 판 행은 남은 대상으로 센다'(`remaining: 0`) |
| V26 | 본문 안쪽 경계 | `internal-review.controller.ts:14` | 사유 상한 500 → 499(500자를 거절) | **살아남음** | — |
| V27 | 본문 안쪽 경계 | `internal-review.controller.ts:14` | 요청자 하한 1 → 2(1자를 거절) | **살아남음** | — |
| V28 | 조건 빼기(§9.1 ⓐ, Drizzle) | `drizzle-review-store.ts:337` | 보류 행이 없어도 예약·파기를 함 | 잡힘 | 통합 ⑨ '보류된 탈퇴 사건이 없으면 아무것도 바꾸지 않는다' 외 셋(4) |
| V29 | 대체를 늘 씀(§9.2 ⓓ) | `reviews.ts:363` | 정상 탈퇴 시각도 처리 시각 + 16분으로 | 잡힘 | 단위 ④ '계약이 받는 탈퇴 시각마다 예약 시각이 나온다' 외 일곱(8) |
| V30 | 입력 확인 빼기 | `reviews.ts:358` | 탈퇴 사건 처리의 계정 ID 모양 확인을 뺌 | 잡힘 | 단위 ④ '계정 ID가 틀리면 파기도 예약도 하지 않는다' |

- **같은 뜻이라 셈에서 뺀 것**: V03x. 운영 줄에 계정 ID를 `accountId`라는 칸 이름으로 실으면 시험이 통과한다. 플랫폼 로거가 `accountId` 칸을 이름으로 가리기 때문이다(`packages/platform/src/log.ts:40` `REDACTED_KEYS`, 대소문자·깊이와 관계없이). 운영도 같은 로거를 써 줄에 값이 나가지 않으므로 같은 뜻으로 본다. 가림 칸이 아닌 이름(V03의 `target`)으로 실으면 잡힌다.
- **넣지 않은 계획 꼴**: §9.1 ⓑⓒ(이미 다시 처리한 보류·다른 토픽의 보류를 인정)는 V01·V28·V18과 같은 거르기 문장이고, 단위 ⑨ '…없는 계정은…'의 C·D 계정과 통합 '…없으면 아무것도 바꾸지 않는다'의 `onlyReprocessed`·`otherTopic` 계정이 단언한다. §9.2 ⓑⓒ(대체 시각 NaN, 대체할 때 파기 건너뜀)는 V13이 잡힌 시험의 예약 03:19·후기 ①의 칸 단언이 본다. §9.3 ⓐ(`remaining` 없음)는 V15를 잡은 단언과 같다. 수를 25개 남짓으로 두려고 넣지 않았다.

#### 살아남은 것과 처리 제안

| ID | 무엇이 빈가 | 위험 | 제안 |
| --- | --- | --- | --- |
| V12·V24 | 손으로 처리가 쓰는 다시 정리 예약이 '늦은 쪽'을 남기는지 보는 시험이 없다. 단위·통합의 두 번째 호출은 모두 첫 호출보다 늦은 시각이라 덮어써도 같은 값이 나온다. 정본 docs/features/identity.md §8 '손으로 처리'("예약은 늦은 쪽이 남는다")와 계획 §9.1이 정한 규칙이고, §12 I-T83 ⑨ 문장에는 없다 | 낮음. 먼저 있던 예약은 사건 처리 때의 '처리 시각 + 16분' 이하이고 손으로 처리는 그 뒤라 보통 이번 시각이 더 늦다. 파드 사이 시계가 어긋날 때만 예약이 앞으로 당겨져, 다시 정리가 탈퇴 전 토큰이 끝나기 전에 돌 수 있다 | **시험 담당에게 넘김**: 단위 `test/review-purge.test.ts`와 통합 `test-int/review-purge-manual.int.test.ts`에 '예약이 이미 지금 + 30분인 계정을 손으로 처리하면 예약은 30분 그대로' 단언 하나씩. 탈퇴 사건 쪽의 같은 단언(단위 ④ '…함께 쓴다', 통합 ④ '같은 계정 예약은 늦은 쪽을 남긴다')을 본뜨면 된다 |
| V14 | C1 대체 때 경고 줄이 나오는지 단언이 없다. 시험은 로그에 그 값과 계정 ID가 없음만 본다 | 낮음(관측만). 정본 §8 '다시 정리'는 경고 줄을 요구하지 않고, 계획 §9.2만 '경고 줄 하나, 값 없음'을 적었다 | 시험 담당 또는 갈래 3 정리 목록: ④ '예약 셈이 읽지 못한…'의 처리기 경로에서 `warn` 줄이 정확히 하나이고, 정상 시각(④ '계약이 받는…')에는 없음을 더한다 |
| V23 | 손으로 처리 안의 문장 차례(예약 → 파기)를 뒤집어도 통과한다. 이 차례는 다시 정리 반복과 잠금 차례(예약 행 → 후기)를 맞춰, 두 트랜잭션이 서로 잡은 것을 기다리다 멈추는 일(교착)을 막으려는 것이다. 둘을 겹쳐 돌려 교착을 일으키는 시험이 없다. 앞 검증 D09(탈퇴 사건 처리 쪽의 같은 꼴)와 같다 | 낮음. 한 계정의 손으로 처리와 그 계정 예약의 다시 정리가 같은 순간에 겹칠 때만이고, 겹쳐도 PostgreSQL이 한쪽을 40P01로 끊어 다시 부르면 된다 | 기록만(뜻은 거의 같다). 겹침 시험은 만들기 비싸 갈래 3 정리 목록 후보로 둔다 |
| V26·V27 | 본문 길이의 안쪽 끝 가운데 사유 500자·요청자 1자가 받아지는지 보지 않는다(사유 10자·요청자 64자만 200으로 본다) | 낮음. 한도를 잘못 좁혀도 긴 사유를 쓴 운영자가 400을 받는 정도다 | **시험 담당에게 넘김**: ⑨ '키 없는 보류 행만…' 호출의 본문을 사유 500자·요청자 1자로 바꾸거나, '…섞인 계정은…' 뒤에 한 번 더 부른다 |

#### 판정 기준 대조(docs/features/identity.md §12 I-T83 ⑨)

| 기준 문장 | 단언하는 시험(파일) | 대조 |
| --- | --- | --- |
| ⑨-1 그 계정의 보류된 탈퇴 사건이 있을 때만 파기한다 | 단위 HTTP '키 있는 행과 없는 행이 섞인 계정은…'·'키 없는 보류 행만 있는 계정도…'(`test/review-withdrawn.test.ts`), 유스케이스 '…UUID가 아니면 거절하고…'(`test/review-purge.test.ts`), 통합 '보류된 탈퇴 사건이 있으면 파기하고…'·'키 없는 보류 행만…'(`test-int/review-purge-manual.int.test.ts`) | 같다. 그 계정 후기는 ①의 칸 전부(`purgedOf`)로, 다른 계정 후기는 행째 그대로임을 본다. V01·V18·V28 잡힘 |
| ⑨-2 보류 행을 다시 처리로 표시한다 | 단위 HTTP 섞인 계정(보류 행 일곱의 다시 처리 시각 지도 전체), 통합 '…있으면…'(h1~h3 = 지금, 다른 계정 행 null), 통합 '보류 행 표시가 실패하면 파기·예약도 남지 않는다'(N3) | 같다. 그 계정 행만 표시되고 다른 행은 그대로임까지 본다. 한 트랜잭션은 §8 정본 문장이고 N3 시험이 두 차례(V21·V22)를 모두 잡았다 |
| ⑨-3 예약을 쓴다 | 단위 HTTP 둘·유스케이스 둘(예약 = 처리 시각 + 16분), 통합 셋(예약 = 넘긴 시각) | 같다. '+ 16분' 셈은 유스케이스가 하므로 단위가 보고, 통합은 저장소에 넘긴 값이 들어가는지 본다. §8의 '늦은 쪽'은 ⑨ 문장 밖이고 단언이 없다(V12·V24) |
| ⑨-4 보류된 사건이 없는 계정(탈퇴하지 않은 팬 포함)은 409이고 후기가 그대로다 | 단위 HTTP '보류된 탈퇴 사건이 없는 계정은 손으로 파기할 수 없다'(B 보류 없음 = 탈퇴하지 않은 팬, C 다시 처리한 보류뿐, D 다른 토픽, E 다른 계정의 보류만 → 각각 409 `withdrawal-not-held`, 유스케이스 409), 통합 '보류된 탈퇴 사건이 없으면 아무것도 바꾸지 않는다'(none·onlyReprocessed·otherTopic → `undefined`, 예약 없음, VISIBLE) | 같고 더 넓다. 후기뿐 아니라 보류 행·예약까지 그대로임을 스냅숏으로 본다. 다시 부른 409(끝 신호)도 단위 HTTP 둘·유스케이스 둘·통합 셋(`undefined`)이 본다. V01·V02·V28 잡힘 |
| ⑨-5 사유·요청자가 없거나 길이 밖이면 400이다 | 단위 HTTP '사유·요청자 없이는 부를 수 없고 처리하면 운영 줄에 남는다'(본문 없음, 사유 9·501자, 요청자 ''·65자, 모르는 칸, 사유 빠짐, 요청자 빠짐 → 400, 바뀐 것 없음, 토큰 없음·틀림 403) | 같다(V04 잡힘). 길이 '안'은 사유 10자·요청자 64자만 200으로 보고 사유 500자·요청자 1자는 보지 않는다(V26·V27) |
| ⑨-6 응답의 처리한 보류 행 수·ID에 `eventKey`가 없는 보류 행도 들어간다 | 단위 HTTP 섞인 계정(`{ purged: 2, heldEvents: 3, heldEventIds: 셋 }`), 키 없는 행만(`{ purged: 1, heldEvents: 1, heldEventIds: [HELD_G] }`), 유스케이스 50개(키 없는 51행 → 50·1), 통합 셋(저장소 `held`에 `eventKey: null` 행) | 같다. 응답을 통째로 `toEqual`해 칸이 더 있거나 빠지면 실패한다. V06·V09·V18 잡힘 |
| ⑨-7 운영 줄의 보류 행 ID에 `eventKey`가 없는 보류 행도 들어간다 | 단위 HTTP 둘(운영 줄 정확히 하나, `held` = `[{ id, eventKey }]`를 응답 차례로, 키 없는 행은 `eventKey: null`, `heldEventKeys` 칸 없음, 줄 글에 계정 ID 대·소문자 없음) | 같다. 통합은 저장소 단계라 운영 줄을 보지 않는다(운영 줄은 유스케이스가 남긴다). V03·V07·V08 잡힘 |
| ⑨-8 한 번에 보류 행 ID 차례로 50개까지 처리한다 | 유스케이스 '한 번에 처리하는 보류 행은 50개까지이고 남은 행은 다시 불러 처리한다'(ID 차례와 다르게 넣은 51행: 앞 50개 → 남은 하나 → 409), 단위 HTTP 섞인 계정(넣은 차례 a03·a01·a02 → 응답 a01·a02·a03), 통합 '한 번에 잠그는 보류 행은 ID 차례로 50개까지다'(무작위 ID 51개, 관리자 `order by id`의 앞 50개) | 같다. 메모리 대역과 실제 SQL을 따로 본다. 상한 50은 시험이 정본 값을 직접 적는다(코드 상수를 가져오지 않는다). V09·V10·V11·V19·V20 잡힘 |

- **같이 바뀐 ④·⑧ 문장(참고)**: ④ '예약 셈이 읽지 못한 탈퇴 시각이어도 파기는 한다'는 단위 '예약 셈이 읽지 못한…'(네 글마다 후기 ①의 칸·예약 03:19·다른 계정 그대로, 처리기 경로)과 '계약이 받는…'(대체가 아닌 각자 + 16분)이 단언한다. 기준과 같다(V13·V29 잡힘). ⑧ '결과에 남은 대상 수가 실리고, 다른 트랜잭션이 잡아 건너뛴 행만큼 남는다'는 단위 ⑧ 다섯의 `{ purged, remaining }`과 통합 '다른 트랜잭션이 잡은…'(`{ 2, 1 }` → 풀린 뒤 `{ 1, 0 }`)이 단언한다. 기준과 같다(V15·V16·V25 잡힘).
- **이름만 단 시험**: 찾지 못했다. ⑨ 단위 일곱(원문 ⑦⑨ 포함)과 통합 여섯은 모두 이번 변이 가운데 하나 이상에서 단언으로 실패했다. 전에 '처음부터 통과'였던 ④ '계약이 받는…'·'계정 ID가 틀리면…'은 V29·V30으로, 통합 '…없으면 아무것도 바꾸지 않는다'(구현 전에는 뼈대로만 실패)는 V28로, 통합 ⑦⑨ 권한은 V17로 실패를 봤다.
- **되돌림 확인**: 변이마다 `git checkout -- <파일>` 뒤 `git status --short -- src migrations`가 비었는지 도구가 확인했다. 모두 끝난 뒤 `git -C D:/ticketpass-lane3-w8b status --short`가 비어 있다(이 절을 쓰기 전 확인). 이 절 밖의 파일은 바꾸지 않았다.
