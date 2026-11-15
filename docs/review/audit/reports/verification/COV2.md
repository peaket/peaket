# 웨이브 6 독립 감사 · COV2 — 미배정 구현 배치 9개 후속 감사

- 감사자: 독립 감사자(구현 미참여), 작업 위치 `D:\ticketpass-audit-ro3`
- 범위: COV-01이 지적한 7개 영역 밖 구현 배치 9개 — BAT-165·170·195·197·202·205·580·585·590
- 읽기 전용: 코드·계약·문서를 고치지 않았다. 작업 뒤 `git status --short`는 비어 있었다.
- 상한 45분, 표적 단위 시험만 실행. Docker·test-int·전체 빌드는 돌리지 않았다.

## 0. 요약

**높음 1, 중간 5, 낮음 5.** (발견 11개)

가장 중요한 것:
1. **BAT-195 trust-svc `ApplyLabel`에 호출자 인증·인가가 없다.** 차단 기기 목록을 바꾸는 gRPC에 호출자 신원 검사가 없고, `acted_by`(감사 행위자)를 호출자가 그대로 정한다. (COV2-01, 높음)
2. **BAT-165 PostgreSQL 검색 뷰가 다회차 공연의 판매 상태를 잘못 계산한다.** 지난 회차 + 아직 오픈 전인 다음 회차가 있으면 `ON_SALE`로 나온다. 메모리 어댑터(`cardSaleStatus`)와 결과가 다르다. (COV2-02, 중간)
3. **BAT-585 법정 통보 takedown이 멱등이 아니다.** 같은 통보를 다시 보내면 `takedown_action`이 중복되고 `applied`가 부풀며, 여러 후기 중 일부 실패 시 트랜잭션도 없다. (COV2-03, 중간)
4. **BAT-585 `GET /v1/ops/reviews/{reviewId}`가 OpenAPI에 없다.** 코드·주석은 계약에 있다고 하지만 계약에는 POST moderation만 있다. (COV2-04, 중간)
5. **BAT-590 처리방침이 공개 경로에 "업체 미정"·"[운영 담당자]"를 그대로 렌더한다.** 법률 검토 목록의 핵심 항목 8개가 "제출 전"인데 유효일은 2026-11-01이다. (COV2-05, 중간)

### COV-01 정정

COV.md는 BAT-197을 "BAT-195 커밋으로 함께 구현(대체ID)"으로 분류했다. **틀렸다.** 커밋 `e71ee1c0` 본문은 "BOT-080(표본 검토 화면 SCR-067)은 표본 검토 REST가 ops-svc 몫인데 ops-svc(OPS-260)·관제 게이트웨이(HOT-400)가 없어 화면을 실제 서버에 붙이지 못했다. 이 묶음 BAT-197은 …"라고 적는다. BAT-197은 **미착수**다. COV.md의 표·요약을 정정했다(대체ID 9→8, 미착수 7→8, 배정 필요 9→8, 대상 아님 10→11).

따라서 COV-01의 "구현됐는데 담당 없는 배치"는 **8개**다: BAT-165·170·195·202·205·580·585·590. 이번 감사가 그 8개를 덮는다.

### 요청 설명과 실제 커밋 범위

이번 지시의 배치 설명 일부가 실제 커밋과 다르다. 실제 코드를 기준으로 감사했고, 차이는 COV2-10에 적었다.

| 배치 | 요청 설명 | 실제 커밋 |
| --- | --- | --- |
| BAT-170 | 전시·상세페이지·SEO·구조화 데이터·공유 | 인앱 브라우저 안내(SCR-058)·standalone 배포·재배치/정적 자산 보존 |
| BAT-197 | trust 표시·라벨(파트너 콘솔) | **미착수**(선행 OPS-260·HOT-400) |
| BAT-580 | 대량 알림 4종·발송·재시도 | 구매 조건 알림 4개 언어·로케일 경로·접근성(발송 아님) |
| BAT-585 | 파기·키 관리·운영 문서·권한 | 후기·신고·운영자 조치·같은 내용 자동 가림 |
| BAT-590 | 처리 방침 10개 조항·10개 문서·권한 | 처리방침 10개 조항 + 약관 10개 조항, 문서 7개(terms·privacy·dispute·sale-terms·community·business·security-notice) |

## 1. 발견

### [높음] COV2-01: trust-svc `ApplyLabel`에 호출자 인증·인가가 없어 차단 기기 목록과 감사 행위자를 위조할 수 있다
- 영역/배치: BAT-195(trust-svc 라벨·차단 기기 목록)
- 위치: `services/trust-svc/src/modules/scoring/inbound/trust.grpc.ts:3-4`, `:183-204`; `services/trust-svc/src/modules/scoring/application/apply-label.ts:113-115`; `services/trust-svc/src/grpc-server.ts:17`
- 증거:
  - `trust.grpc.ts:3-4` 주석: "부르는 쪽 신원 확인은 아직 이 저장소의 배포 설정(deploy·infra)에 없다. … ApplyLabel을 ops-svc로 줄이는 것도 메시 L7 허용 목록이 한다."
  - `trust.grpc.ts:184-204` `ApplyLabel` 처리기는 인터셉터·토큰·mTLS 신원 검사 없이 `uc.run(input)`을 호출한다.
  - `grpc-server.ts:17` `grpc.ServerCredentials.createInsecure()`로 `0.0.0.0:50051`에 바인딩한다(메시 없는 로컬·CI는 평문, 운영은 메시 mTLS 전제).
  - `apply-label.ts:113-115` 감사 로그 `actedBy`는 요청의 `acted_by` 문자열을 그대로 쓴다. `labels.ts:92-93`은 길이만 검사한다.
  - `docs/features/bot-defense.md:315`도 "ApplyLabel을 ops-svc로 줄이는 것은 메시 L7 허용 목록"이며 "미구현(B-T20 ⑩, HOT-400)"이라고 적는다.
  - `services/queue-svc/test-int/appeal-resolve.int.test.ts:156-157`는 실제로 자격 증명 없이 `127.0.0.1:50051`에 `createInsecure()`로 붙어 `ApplyLabel`을 부른다.
- 왜 문제인가: 신뢰 경계 안의 아무 프로세스(또는 gRPC 포트에 닿는 쪽)가 임의 기기를 차단 목록에 넣거나 뺄 수 있고, 감사 로그에는 원하는 `acted_by`를 남길 수 있다. 좌석·대기 순번 공정성과 부정 예매 조사 기록의 무결성이 깨진다. `deploy/workloads`에 trust-svc가 아직 없어 현재 배포에서는 노출 범위가 제한되지만, 배포 전 반드시 닫아야 하는 권한 결함이다.
- 재현/확인: 단위·통합 시험이 자격 증명 없이 `ApplyLabel`을 호출한다(`appeal-resolve.int.test.ts`). `git grep -n "createInsecure" services/trust-svc`로 확인.
- 제안 수정: (가) 메시 mTLS 신원(SPIFFE) + L7 허용 목록(ops-svc만) 또는 내부 토큰 인터셉터를 추가한다. (나) `acted_by`를 요청 값이 아니라 인증된 호출자 신원에서 채운다. (다) 허용 목록 밖 호출은 `PERMISSION_DENIED`로 거절한다. (라) 배포 전 `AuthorizationPolicy`/`NetworkPolicy`를 필수 값으로 만든다.
- 확신도: 높음(코드), 중간(현재 배포 노출도 — trust-svc 워크로드 없음)

### [중간] COV2-02: BAT-165 PostgreSQL 검색 뷰가 지난 회차 + 다음 회차 공연을 `ON_SALE`로 잘못 표시한다
- 영역/배치: BAT-165(검색 읽기 모델·판매 상태)
- 위치: `services/core-svc/migrations/0009_search.sql:68-72`; `services/core-svc/src/modules/catalog/domain/production.ts:93-100`; `services/core-svc/src/modules/catalog/domain/search.ts:374`
- 증거:
  - 뷰: `CASE WHEN MIN(e.open_at) > now() THEN 'UPCOMING' WHEN MAX(e.starts_at) - interval '24 hours' <= now() THEN 'ENDED' ELSE 'ON_SALE' END`.
  - 도메인: `cardSaleStatus`는 회차별 `EventSaleState`로 "판매 중 회차가 하나라도 있으면 ON_SALE, 없고 UPCOMING이 있으면 UPCOMING"을 고른다.
  - 예: 회차 A(open 11-01, start 11-10, 종료) + 회차 B(open 11-20, start 12-01), 지금 11-15. 뷰는 `MIN(open_at)=11-01 <= now`, `MAX(starts_at)-24h=11-30 > now` → **ON_SALE**. 도메인은 A=ENDED, B=UPCOMING → **UPCOMING**.
- 왜 문제인가: 검색 카드가 "판매 중"으로 보이지만 실제로 지금 살 수 있는 회차가 없다. 사용자가 카드를 눌러도 구매 가능한 회차가 없어 혼란을 준다. 메모리 어댑터와 DB 어댑터가 같은 문서 모양을 낸다는 계약도 깨진다.
- 재현/확인: `search.int.test.ts` 2건은 다회차(과거+미래) 상태를 다루지 않는다. SQL 로직과 `cardSaleStatus`를 나란히 읽으면 재현된다.
- 제안 수정: 뷰의 `sale_status`를 회차별 `event_sale` 상태(또는 `cardSaleStatus`와 같은 규칙)로 계산한다. `event_sale` 사본이 없으면 최소한 "미래 오픈 회차만 있으면 UPCOMING"이 되도록 `MAX`/`MIN` 조건을 고친다. 과거+미래 회차 통합 시험을 더한다.
- 확신도: 높음

### [중간] COV2-03: BAT-585 법정 통보 takedown이 멱등이 아니고 트랜잭션도 없다
- 영역/배치: BAT-585(후기·신고·법정 통보)
- 위치: `services/core-svc/src/modules/review/application/reviews.ts:262-280`; `services/core-svc/src/modules/review/adapters/db/drizzle-review-store.ts:229-231`; `services/core-svc/migrations/0013_review.sql:60-75`
- 증거:
  - `applyNoticeTakedown`은 `reviewIds`를 돌며 `updateReview` + `insertTakedown` + `addHiddenFingerprint`를 각각 호출하고 `applied += 1` 한다.
  - `insertTakedown`은 단순 `insert`이고, `takedown_action`에는 `(notice_id, review_id)` 유일 제약이 없다. `review_hidden_fingerprint`만 `onConflictDoNothing`이다.
  - 루프 전체를 감싸는 트랜잭션이 없다.
- 왜 문제인가: 같은 법정 통보를 재시도하면 `takedown_action` 행이 중복되어 감사 기록이 부풀고, `applied`도 매번 증가한다. 여러 후기 중 하나에서 실패하면 앞선 후기는 이미 가려진 채 남아 부분 실패가 된다. 법정 통보 처리의 재현성·감사 무결성이 약하다.
- 재현/확인: 같은 `noticeId`·`reviewIds`로 `applyNoticeTakedown`을 두 번 호출하고 `takedown_action` 수를 세면 2배가 된다. 기존 시험은 1회 호출만 본다(`review.http.test.ts:205-241`).
- 제안 수정: `takedown_action`에 `(notice_id, review_id)` 부분 유일 인덱스를 두고 `onConflictDoNothing`/upsert로 바꾼다. 루프를 트랜잭션으로 묶고, 이미 적용된 후기는 `applied`에서 빼거나 `alreadyApplied`로 구분한다. 재시도 시험을 더한다.
- 확신도: 높음

### [중간] COV2-04: BAT-585 `GET /v1/ops/reviews/{reviewId}`가 OpenAPI에 없고 호출자도 없다
- 영역/배치: BAT-585(CS 처리함 상세)
- 위치: `services/core-svc/src/modules/review/inbound/ops-review.controller.ts:1`, `:42-47`; `docs/api/openapi.yaml:5306-5307`; `packages/api-client/src/gen/operations.ts`
- 증거:
  - 컨트롤러 주석: "openapi GET /v1/ops/reviews/{reviewId}, POST …/moderation".
  - 실제 OpenAPI에는 `/v1/ops/reviews/{reviewId}/moderation`만 있고 `/v1/ops/reviews/{reviewId}` GET은 없다.
  - `packages/api-client`의 `operations.ts`에도 `getOpsReview`가 없다. `git grep reportedReview`는 core-svc 정의와 테스트만 찾는다.
  - 컨트롤러는 손으로 쓴 `OpsReviewDetail` Zod 스키마(`.passthrough()`)로 응답을 검증한다. 생성 계약과 독립이다.
- 왜 문제인가: CS 상세 화면이 쓸 GET 경로가 계약·클라이언트에 없어, ops-svc가 이 경로를 프록시하려면 수동 구현해야 한다. 문서·코드·계약이 서로 다르고, 계약 검사(`gen:check`)도 이 경로를 보지 못한다.
- 재현/확인: `grep -n "getOpsReview" docs/api/openapi.yaml packages/api-client/src/gen/operations.ts` → 없음.
- 제안 수정: (가) GET을 OpenAPI에 추가하고 생성물을 갱신해 ops-svc/core-svc가 같은 계약을 쓰게 한다. 또는 (나) GET 컨트롤러를 제거하고 CS 상세를 다른 계약 경로로 일원화한다. 손으로 쓴 `OpsReviewDetail` 대신 생성 스키마를 쓴다.
- 확신도: 높음

### [중간] COV2-05: BAT-590 처리방침이 공개 경로에 미확정 업체·담당자를 그대로 노출한다
- 영역/배치: BAT-590(처리방침·약관)
- 위치: `apps/web/src/entities/policy-doc/model.ts:210-221`(pp-3), `:267`(pp-7); `apps/web/app/(cached)/policy/[slug]/page.tsx`; `tools/ci/policy-check.test.mjs:8-14`; `apps/web/src/entities/policy-doc/model.test.mjs:30-34`
- 증거:
  - pp-3 위탁 표: `['본인확인기관(업체 미정)', '…']`, `['알림 발송 업체(업체 미정)', '…']`.
  - pp-7: `개인정보 보호책임자는 [운영 담당자]…`, `연락처는 [운영 담당자]…`.
  - `POLICY_DOCS`는 `/policy/[slug]`에서 그대로 렌더된다. 초안 배너·noindex가 없다.
  - `docs/review/legal/BAT-590-legal-review.md`의 법률 검토 항목 30~37번이 모두 "제출 전" 상태다.
  - `model.test.mjs`는 `kind:"placeholder"` 블록만 없는지 보고, 본문 안의 "미정"·"[…]"는 검사하지 않는다.
- 왜 문제인가: 개인정보 처리방침은 위탁 업체·보호책임자·연락처를 정확히 공개해야 한다. 미정 값을 유효일 2026-11-01로 공개하면 PIPA 고지 의무를 충족하지 못하고, 사용자는 초안을 최종본으로 오해한다.
- 재현/확인: `/policy/privacy`를 열거나 `model.ts`의 pp-3·pp-7을 읽는다. `policy-check.test.mjs`는 통과한다.
- 제안 수정: (가) 업체·담당자·연락처를 채우기 전에는 공개 페이지를 초안 배너 + `noindex`로 막거나 게시하지 않는다. (나) 유효일을 실제 게시일로 바꾼다. (다) 공개 정책 본문에 `미정`·`[` 패턴이 있으면 실패하는 시험을 더한다.
- 확신도: 높음

### [중간] COV2-06: BAT-585 후기가 계정 탈퇴 뒤에도 계정 ID·주문 ID와 함께 남는다
- 영역/배치: BAT-585(후기 보존·파기)
- 위치: `services/core-svc/src/modules/review/adapters/db/drizzle-review-store.ts:143-145`; `docs/review/plans/BAT-585.md` "후속" 목록
- 증거:
  - `softDeleteReview`는 `status='DELETED'`, `body=''`, `authorDisplay='***'`만 바꾼다. `account_id`, `basis_order_id`, `content_fingerprint`는 남는다.
  - `git grep AccountWithdrawn -- services/core-svc` → 없다. `identity.accounts-withdrawn` 소비자는 queue-svc뿐이다.
  - BAT-585 계획은 "후속: 탈퇴 계정 ID·사진 파일 비우기 — 지금은 본문·작성자 표시만 비운다"라고 스스로 적는다.
- 왜 문제인가: 탈퇴 계정의 후기가 `VISIBLE`로 남으면 본문(개인정보 포함 가능)과 계정 ID가 계속 공개·보관된다. PIPA 파기·정정 요구와 충돌할 수 있고, 후기 작성자 탈퇴 후에도 `basis_order_id`로 구매 이력이 연결된다.
- 재현/확인: `AccountWithdrawn` 처리기 부재, `softDeleteReview` 갱신 칸 확인.
- 제안 수정: `identity.accounts-withdrawn`을 core-svc가 구독해 해당 계정 후기를 익명화/삭제하고 ID·주문 참조를 비운다. 후기 사진 파일도 함께 지운다. 법적 보존이 필요하면 분리 보관·사유를 문서화한다.
- 확신도: 높음(코드), 중간(법적 심각도)

### [낮음] COV2-07: BAT-165 검색이 요청마다 전체 문서를 읽고 메모리 색인을 다시 만든다
- 영역/배치: BAT-165(검색 성능)
- 위치: `services/core-svc/src/modules/catalog/application/search.ts:21-25`; `services/core-svc/src/modules/catalog/domain/search.ts:140-157`; `services/core-svc/src/modules/catalog/adapters/db/drizzle-search-index.ts:50-52`; `docs/features/search.md:251`
- 증거: `search()`는 매 요청 `index.documents()`로 `select * from search_document`를 읽고, `matchGrades`가 `indexNames`를 매번 만든다. 자동완성만 10초 캐시한다. `search_document`는 production·event·artist·alias·wish를 모으는 라이브 뷰다. NFR-028 목표는 검색 p95 300ms [가정]이고, 계획은 "1차는 뷰, 늘면 materialized view"라고 적는다.
- 왜 문제인가: 공개 검색의 캐시 미스가 몰리면 DB·CPU·메모리 사용이 요청 수에 비례한다. p95 목표를 측정한 증거가 이번 커밋에 없다(SR-T13은 후속).
- 재현/확인: 코드 경로. `search.int.test.ts` 2건은 성능을 재지 않는다.
- 제안 수정: 검색 문서도 `search_version` 기반 TTL 캐시를 두거나, materialized view/DB 측 검색으로 옮긴다. SR-T13 k6 측정을 배치 게이트에 넣는다.
- 확신도: 높음(코드), 중간(영향)

### [낮음] COV2-08: BAT-205 Schema Registry 등록 Job이 인증·TLS 없이 꺼져 있다
- 영역/배치: BAT-205(공급망·Avro 등록)
- 위치: `tools/ci/register-avro.mjs:23`; `tools/ci/avro-schema.mjs:244-247`; `deploy/charts/peaket-service/values.yaml` `schemaRegistry`
- 증거: `registerToRegistry`는 `fetch(..., { headers: { 'content-type': ... } })`만 보낸다. 인증 헤더·TLS 설정이 없다. 차트 기본값은 `schemaRegistry.enabled: false`, `image: ""`, `registryUrl: ""`이고 Job env도 URL 하나뿐이다.
- 왜 문제인가: 인증이 필요한 운영 레지스트리에서는 등록 Job이 실패한다. 기본 비활성이라 실제 등록 경로가 배포에서 검증되지 않았고, "등록 Job이 있다"는 BUILD_ORDER 주장은 골격 수준이다.
- 재현/확인: `values.yaml`과 `register-avro.mjs`를 읽는다. CI는 로컬 레지스트리 시험만 돈다.
- 제안 수정: 인증 방식(베이직/토큰/mTLS)을 Secret으로 주입하고, 스테이징에서 Job을 한 번 실제 실행해 검증한다. 실패 시 PreSync가 멈추는지 확인한다.
- 확신도: 높음(코드), 중간(운영 영향)

### [낮음] COV2-09: BAT-202 CodeQL 게이트가 `security-severity` 없는 결과를 막지 않는다
- 영역/배치: BAT-202(보안 검사 게이트)
- 위치: `tools/ci/scan-gate.mjs:230-232`; `.github/workflows/security-scan.yml:126`
- 증거: `blockingKind`는 CodeQL에서 `PROTOTYPE_QUERIES` 포함 또는 `f.severity !== undefined && f.severity >= 7.0`만 막는다. `severity`가 없는 CodeQL 결과는 알림으로 간다. Trivy는 `severity === undefined`도 막는다.
- 왜 문제인가: CodeQL SARIF에 `security-severity`가 빠진 보안 결과가 있으면 게이트를 통과한다. 드문 경우지만, "높은 등급만 막는다"는 정책의 사각지대다.
- 재현/확인: `scan-gate.test.mjs`의 등급 시험은 6.9/7.0 경계를 보지만, CodeQL severity 없음 케이스는 별도로 확인되지 않는다.
- 제안 수정: CodeQL은 `kind: fail`/보안 쿼리 결과를 기본 차단하고, 예외는 `scan-exceptions.json`으로만 허용한다. severity 없음 결과를 실패로 보는 시험을 더한다.
- 확신도: 중간

### [낮음] COV2-10: 요청 설명과 실제 커밋 범위가 다르다(SEO·대량 알림·파기·10개 문서)
- 영역/배치: BAT-170·197·580·585·590
- 위치: `docs/BUILD_ORDER.md` 해당 행, `git show --stat 4184a425 fb9e60c1 721df9fb 1ef9e0c7 e71ee1c0`
- 증거: §0의 표. BAT-170에는 SEO·구조화 데이터·공유 코드가 없고, BAT-580은 알림 발송이 아니라 UI 문구, BAT-585는 파기·키 관리가 아니라 후기, BAT-590은 문서 7개, BAT-197은 미착수다.
- 왜 문제인가: 감사·커버리지 표가 실제 코드와 다른 영역을 "감사했다"고 표시할 수 있다. SEO·대량 알림·키 관리가 정말 다른 배치에 있다면 그 배치가 누락된다.
- 재현/확인: `git show --stat`와 `git grep`으로 확인.
- 제안 수정: 배치 설명을 실제 구현에 맞추고, SEO·대량 알림·키 관리는 담당 배치를 명시한다. BAT-197은 미착수로 표기한다.
- 확신도: 높음

### [낮음] COV2-11: BAT-585 CS 상세가 후기 작성자의 계정 ID·주문 ID·지문을 그대로 준다
- 영역/배치: BAT-585(CS 처리함)
- 위치: `services/core-svc/src/modules/review/application/reviews.ts:283-299`; `services/core-svc/src/modules/review/inbound/ops-review.controller.ts:9-35`
- 증거: `reportedReview`는 `review: ReviewRecord`를 그대로 반환하고, `OpsReviewDetail`은 `accountId`·`basisOrderId`·`contentFingerprint`를 포함한 뒤 `.passthrough()`한다. 주석은 "신고자 계정은 싣지 않는다"만 보장한다.
- 왜 문제인가: CS 역할에는 필요할 수 있지만, 화면에 필요한 최소 필드보다 많은 내부 식별자를 노출한다. `contentFingerprint`는 내부 차단 키다.
- 재현/확인: 컨트롤러 스키마와 `ReviewRecord` 필드 비교.
- 제안 수정: CS 상세 응답을 `reviewId·eventId·rating·body·status·notice·authorDisplay` 정도로 좁히고, 계정·주문 참조는 별도 권한·감사 경로로만 준다.
- 확신도: 중간

## 2. 검토한 시험·명령

| 대상 | 명령 | 결과 |
| --- | --- | --- |
| BAT-165 검색 | `pnpm --filter @peaket/core-svc exec vitest run test/search.test.ts test/search.http.test.ts` | 2파일 12시험 통과 |
| BAT-585 후기 | `pnpm --filter @peaket/core-svc exec vitest run test/review.test.ts test/review.http.test.ts` | 2파일 19시험 통과 |
| BAT-195 trust | `pnpm --filter @peaket/trust-svc exec vitest run test/label-grpc.test.ts test/block-list-source.test.ts test/device-refs.test.ts test/shadow.test.ts` | 4파일 32시험 통과 |
| BAT-170·580·590 웹 | `node --test apps/web/src/shared/lib/in-app-browser.test.mjs apps/web/src/shared/lib/safe-next.test.mjs apps/web/src/shared/i18n/catalog.test.mjs apps/web/src/shared/i18n/integration.test.mjs apps/web/src/entities/policy-doc/model.test.mjs apps/web/src/_pages/policy/ui/policy-page.test.mjs` | 21시험 통과 |
| BAT-202·205·580·590 CI | `node --test tools/ci/scan-gate.test.mjs tools/ci/avro-schema.test.mjs tools/ci/i18n-check.test.mjs tools/ci/policy-check.test.mjs` | 40시험 통과 |

- 모든 시험은 통과했다. 위 발견은 시험이 잡지 못한 경로(다회차 판매 상태, 반복 통보, 계약 밖 GET, 공개 정책의 인라인 미정 값, 호출자 인증)에서 나왔다.
- `git status --short`는 작업 전후 모두 비어 있었다.

## 3. 한계

- Docker·test-int는 돌리지 않았다. BAT-165 뷰 버그와 BAT-585 takedown 중복은 코드·마이그레이션 대조로 확인했고, 실제 PostgreSQL에서 재현하지는 않았다.
- BAT-195의 높음은 코드 기준이다. 현재 `deploy/workloads`에 trust-svc가 없어 운영 노출도는 배포 구성에 달려 있다.
- BAT-590의 법적 심각도는 법률 검토 문서가 "제출 전"이라는 전제에 기댄다. 실제 게시 여부는 배포·라우팅 확인이 필요하다.
- 요청 설명과 실제 커밋 범위가 달라, SEO·대량 알림 발송·키 관리가 다른 배치에 있는지는 이번 45분 안에 추적하지 못했다. COV2-10의 후속 확인이 필요하다.

## 4. 배치별 감사 상태

| 배치 | 커밋 | 상태 | 발견 | 비고 |
| --- | --- | --- | --- | --- |
| BAT-165 | 7c839935 | **발견** | COV2-02(중간), COV2-07(낮음) | 검색 판매 상태 불일치·성능 |
| BAT-170 | 4184a425 | **통과** | COV2-10(낮음) | 코드 결함 없음. 요청 설명(SEO)과 실제 범위 불일치 |
| BAT-195 | e71ee1c0 | **발견** | COV2-01(높음) | ApplyLabel 호출자 인증 없음 |
| BAT-197 | (없음) | **해당 없음** | COV-01 정정 | 미착수(선행 OPS-260·HOT-400) |
| BAT-202 | a8547992, 35b2585e | **통과** | COV2-09(낮음) | 게이트는 fail-closed. CodeQL severity 사각지대만 |
| BAT-205 | 8c9a9787 | **발견** | COV2-08(낮음) | 등록 Job 인증·TLS 없음, 기본 비활성 |
| BAT-580 | fb9e60c1 | **통과** | COV2-10(낮음) | 1개 키·machine 번역. 요청 설명(대량 알림)과 불일치 |
| BAT-585 | 721df9fb, 718a31c3 | **발견** | COV2-03·04·06(중간), COV2-11(낮음) | 법정 takedown 멱등·GET 계약·탈퇴 후기 |
| BAT-590 | 1ef9e0c7 | **발견** | COV2-05(중간), COV2-10(낮음) | 공개 정책의 미정 값 |
