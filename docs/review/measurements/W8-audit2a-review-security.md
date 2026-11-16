# W8-audit2a 웨이브 끝 리뷰(보안 관점): 탈퇴 후기 파기와 16분 뒤 다시 정리

- **무엇**: 웨이브 8 갈래 3 묶음 W8-audit2a(소유자 결정 OPEN[42]·[44], ADR-0278, I-T83)를 보안 눈으로 본 결과다(2026-11-16).
- **리뷰 담당**: `l3w8-rev-security`(claude-opus-5-5). 계획·시험·구현에 관여하지 않았고 코드를 고치지 않았다.
- **본 범위**: 가지 `wave/lane3-w8-audit2`, `git diff c3b0935c..39ebcec3`(커밋 17개). 계획은 `docs/review/plans/W8-audit2a.md`의 `## 계획` 절만 읽었다(리뷰·검증 절은 읽지 않았다). 정본은 `docs/security/data-classification.md`('관람 후기'·'탈퇴 후기 다시 정리 예약' 행), `docs/security/asvs/catalog-review.md` v5.0.0-14.2.7 행, `docs/data.md` §2 '후기 표의 DB 권한'을 `git show 39ebcec3:<경로>`로 읽었다. W8-audit2b(웨이브 9)의 계약·정본은 이번 코드가 쓰지 않아 보지 않았다.
- **본 것**: 파기 범위(그 계정 행만인지, 다른 사람 데이터를 지우지 않는지), 내부 경로 `/purge`의 호출자 검사, 새 마이그레이션 0026의 권한(최소 권한)과 `NOT VALID` CHECK, 다시 정리 예약 표의 칸과 권한, 로그에 실리는 계정 ID·후기 본문, 감사 기록.

## 요약

| 심각도 | 건수 | 번호 |
| --- | --- | --- |
| 높음 | 0 | — |
| 중간 | 1 | S1 |
| 낮음 | 2 | S2, S3 |

- 막는 지적은 없다. 파기는 `where account_id = …` 한 문장으로 그 계정 행만 바꾸고, 다시 정리 예약은 파기와 한 트랜잭션이며, 예약 표 권한은 `core_app`의 읽기·넣기·지우기·`due_at` 고치기뿐이다. 처리기·반복 로그에는 계정 ID가 없다.

## 지적

### S1. 내부 `/purge`는 탈퇴 여부를 보지 않고 누가 불렀는지 남기지 않는다

- **심각도**: 중간
- **ASVS**: v5.0.0-8.2.1(기능 접근을 권한 있는 호출자로 제한), v5.0.0-16.2.1(누가·무엇을 했는지 기록)
- **묶음**: W8-audit2a(I-T83 ③)
- **파일:줄**: `services/core-svc/src/modules/review/inbound/internal-review.controller.ts` 17~23줄(`purge`), `services/core-svc/src/modules/review/application/reviews.ts` 329~333줄(`purgeAccount`)
- **틀린 점**: `POST /internal/v1/reviews/accounts/{accountId}/purge`는 내부 토큰만 맞으면 어떤 계정이든 그 계정의 후기를 모두 파기한다. 계정이 정말 탈퇴했는지(identity 상태나 받은 탈퇴 사건) 보지 않고, 부른 운영자·사유를 어디에도 남기지 않는다. 남는 것은 후기 행의 `deleted_at`뿐이다.
- **근거**: 옛 `/anonymize`는 계정·주문 참조만 끊어 본문·별점이 남았다. 이번 `/purge`는 본문·별점·내용 지문을 비우고 DELETED로 바꿔 되돌릴 수 없다. 내부 토큰은 모든 서비스가 같은 값을 쓰므로, 토큰을 가진 어느 서비스나 사람이 탈퇴하지 않은 팬의 후기를 흔적 없이 지울 수 있다. 계획은 이 경로를 '사건을 잃었을 때 운영자가 손으로 하는 길'로 적었는데, 운영자가 내부 토큰을 직접 쓰는 길이라면 누가 했는지가 남아야 한다.
- **고칠 쪽**: 계획(손으로 하는 길에 탈퇴 확인과 운영자·사유 기록을 둘지, 관제 승인 업무로 옮길지 정본 identity.md §8에 정함) 뒤 구현.
- **확인 필요**: 이 경로를 실제로 부르는 쪽(운영 도구·런북)이 무엇인지.

### S2. 정비 역할이 모든 후기의 작성자·본문 칸을 고칠 수 있게 넓어졌다

- **심각도**: 낮음
- **ASVS**: v5.0.0-13.2.2(서비스 사이·DB 연결은 꼭 필요한 권한만)
- **묶음**: W8-audit2a(리뷰 A2, `review-purge-legacy`)
- **파일:줄**: `services/core-svc/migrations/0026_review_purge_recheck.sql` 31줄·34줄, `services/core-svc/src/modules/review/adapters/db/drizzle-review-store.ts` 319~338줄(`purgeLegacyRows`)
- **틀린 점**: 0026은 `core_maintenance`(정비 역할)에 `review`의 `body`·`rating`·`content_fingerprint`·`author_display`·`account_id`·`basis_order_id`·`deleted_at` 고치기를 준다. 칸 단위 권한은 '어떤 값으로' 고치는지는 묶지 못하므로, 정비 역할로 `account_id`를 다른 팬 ID로 바꾸거나 본문을 덮는 것도 DB가 막지 않는다. 파기 칸 모양을 강제하는 CHECK는 다음 출시 몫이라 지금은 없다.
- **근거**: 이 역할에 필요한 일은 '정해진 파기 칸으로만 바꾸기' 하나다. core-svc는 이미 같은 꼴의 일을 정의자 권한 함수(`public_open_times`, 0004)로 좁힌 적이 있다. 파기 칸을 고정한 정의자 권한 함수 하나에 `EXECUTE`만 주면 표 칸 고치기 권한을 줄 필요가 없다.
- **고칠 쪽**: 계획(지금 꼴을 받아들이고 data.md '후기 표의 DB 권한'에 한계를 적을지, 함수로 좁힐지).
- **확인 필요**: 다음 출시의 파기 행 CHECK가 들어오면 남는 위험이 '살아 있는 행 고치기'뿐인지.

### S3. data-classification '관람 후기' 행의 다시 정리 시각이 15분으로 남았다

- **심각도**: 낮음
- **ASVS**: v5.0.0-14.2.7(보존·파기 일정)
- **묶음**: W8-audit2a(계획 커밋 7901c762의 정본 고침)
- **파일:줄**: `docs/security/data-classification.md` '관람 후기' 행의 보존 칸
- **틀린 점**: 그 행은 "탈퇴 시각 + 15분 뒤 한 번 더 파기한다"고 적었다. 코드(`WITHDRAWAL_RECHECK_DELAY_MS`), identity.md §8, 같은 문서의 새 행 '탈퇴 후기 다시 정리 예약'은 모두 탈퇴 + 16분(토큰 최대 15분 + 여유 1분)이다.
- **근거**: 개인정보 처리 근거 문서끼리 숫자가 다르면 점검 때 어느 쪽이 맞는지 다시 따져야 한다.
- **고칠 쪽**: 계획(정본 한 줄).
- **확인 필요**: 없음.

## 확인했고 문제없던 것

- 파기 범위: 탈퇴 처리(`purgeWithdrawnAccount`)와 다시 정리(`runDueRechecks`)는 `account_id`로만 찾고, 이전 판 행 고치기(`purgeLegacyRows`)는 '지운 행인데 별점·지문·계정 ID가 남음' 또는 '살아 있는데 `account_id = id`(옛 익명화)'만 고른다. 법정 조치 증적 `takedown_action`과 같은 내용 차단 목록 `review_hidden_fingerprint`는 건드리지 않는다. 임시조치 풀기(`expireTemporaryBlocks`)는 HIDDEN 행만 VISIBLE로 돌려 파기한 행을 되살리지 않는다.
- 마이그레이션 0026: `rating`·`content_fingerprint`의 NOT NULL만 풀고, 살아 있는 행 CHECK를 `NOT VALID`로 더해 새로 쓰는 행만 본다(배포 창 동안 이전 판과 함께 돈다). `review`에 대한 `core_app` 권한은 넓히지 않았다. 예약 표는 `core_partner`·`core_ops`·`core_maintenance`에 주지 않았고, `core_app`도 `account_id`·`created_at`은 고치지 못한다.
- 예약 표에는 계정 ID·예약 시각·만든 시각만 있고 pid(사람을 가리키는 조사용 가명)·후기 내용이 없다. 예약 시각에 다시 파기하면서 바로 지운다.
- 로그: 탈퇴 처리기는 `eventKey`와 파기 수만, 다시 정리 반복은 잡은 수·파기 수와 `errorSummary`(쿼리 틀과 DB 오류 코드, 매개변수 없음)만 남긴다. 계정 ID·후기 본문이 로그에 없다.
- 내부 경로: `InternalTokenGuard`가 그대로 걸려 있고, 경로의 계정 ID는 UUID 검사 뒤 소문자로 바꿔 쓴다. 옛 `/anonymize`는 없앴다.
