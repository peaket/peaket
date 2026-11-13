# BAT-585 웨이브 끝 비싼 검사

- **무엇**: 웨이브 5 BAT-585(LCH-150·LCH-160)의 `heavy gate go` 결과다.
- **가지**: `wave/lane2-BAT-585`. `origin/develop` `7c859748`(BAT-051 R-535 포함) 위로 rebase했고, 커밋은 R-538 하나다.
- **정본**: docs/BUILD_ORDER.md BAT-585, docs/review/plans/BAT-585.md, docs/planning/02 FR-016·FR-033·FR-070, docs/planning/03 POL-024·POL-042·POL-044, ADR-0066, docs/security/asvs/catalog-review.md, docs/features/control-tower.md C-T22.
- **DB 변경**: core-svc `0013_review.sql`, ticket-svc는 기존 표만 읽는다. Docker test-int를 실제 PostgreSQL 18에서 돌렸다.

## 1. 게이트 요약

| 게이트 | 결과 |
| --- | --- |
| rebase | 성공. `7c859748` 위 R-538. 충돌은 `app.module.ts`(BAT-051 `SaleConfigStore`와 review 모듈)와 생성 장부뿐이었고 양쪽을 살렸다 |
| Docker test-int(core-svc) | **219 통과·1 건너뜀**(17 파일, 순차 실행). `0013_review` 적용·후기 자격·한 회차 하나·신고 한도·같은 내용 지문·조치 트랜잭션·동시 신고 포함 |
| Docker test-int(ticket-svc) | **10 통과**. 실제 DB의 `CheckReviewEligibility`(종료 시각·결제자·유효 티켓·근거 주문) 포함 |
| 변이 | **30개 넣어 30개 잡음**(첫 회 M17 신고 한도 1개 놓침 → 단위 시험 추가 뒤 잡음) |
| 4관점 리뷰 | 높음 1(고침)·중간 6(4 고침·2 남김)·낮음 2(남김) |
| core-svc 단위 | **279 통과** |
| ticket-svc 단위 | **22 통과** |
| typecheck | core-svc·ticket-svc **0** |
| 뿌리 lint | **0** |
| doc-check | **오류 0**, 경고 4(기존 openapi 3·mermaid 건너뜀 1) |
| contracts `gen:check` | **통과** |
| api-client 시험 | **113 통과** |
| ledger `--batch BAT-585 --require` | **6항목**(자동 5·다른 단계 1, 빈칸 0) |
| ledger `--check` | **통과** |
| trace-check | **6 ID**, 시험 301개 |
| records `--check` | **통과**(과거 R-374·R-473 경고만) |
| 브라우저 확인 | **생략**. SCR-016 모달이 아직 `entities/review` 목업(`REVIEW_ITEMS`·`REVIEW_SUMMARY`·`getReview`)을 그리고, 관제 콘솔에도 후기 조치 화면이 없다. 새 API를 누르는 화면이 아니라서 실제 목록·쓰기·신고·조치를 확인할 수 없다. 화면 연결 배치에서 다시 본다 |

- core-svc test-int 전체를 파일 병렬로 돌리면 `seatmap-editor`가 한 번 흔들렸고, 그 파일만 다시 돌리면 11개 통과했다. 최종 판정은 순차 실행 219 통과·1 건너뜀이다.

## 2. 변이 30개

| 변이 | 시험 | 결과 |
| --- | --- | --- |
| 별점 하한 0 | review.test | 잡음 |
| 본문 하한 끔 | review.test | 잡음 |
| 본문 상한 끔 | review.test | 잡음 |
| 지문이 문장부호를 남김 | review.test | 잡음 |
| 작성자 가림이 첫 글자를 잃음 | review.test | 잡음 |
| 일반 통보 기한 10시간 | review.test | 잡음 |
| 임시조치 31일 허용 | review.test | 잡음 |
| 위반 사유 검사 끔 | review.test | 잡음 |
| 통보·같은 내용 가림이 남에게 보임 | review.test | 잡음 |
| 요약이 가린 후기를 셈 | review.test | 잡음 |
| RIGHTS 자세한 내용 검사 끔 | review.test | 잡음 |
| OTHER 자세한 내용 검사 끔 | review.test | 잡음 |
| 신고 처리 가림이 본문을 노출 | review.test | 잡음 |
| 자격이 이미 쓴 후기를 무시 | review.http.test | 잡음 |
| 새 후기가 같은 내용 지문을 무시 | review.http.test | 잡음 |
| 같은 회차 중복 검사 끔 | review.http.test | 잡음 |
| 신고 한도 11건 | review.http.test | **첫 회 놓침** → 단위 시험 추가 뒤 잡음 |
| 내 후기 신고 허용 | review.http.test | 잡음 |
| 같은 후기 중복 신고 허용 | review.http.test | 잡음 |
| 불법 촬영물 즉시 가림 끔 | review.http.test | 잡음 |
| RIGHTS_REQUEST를 CONTENT_REPORT로 | review.http.test | 잡음 |
| 해제가 가림 기록을 복원하지 않음 | review.http.test | 잡음 |
| 통보 지문을 저장하지 않음 | review.http.test | 잡음 |
| 통보 종류를 무시 | review.http.test | 잡음 |
| `event_ends_at` 무시 | ticket-domain.test | 잡음 |
| 환불 티켓을 유효로 셈 | ticket-domain.test | 잡음 |
| 보유자를 결제자로 셈 | ticket-domain.test | 잡음 |
| 근거 주문을 빼고 자격 답 | ticket-domain.test | 잡음 |
| `event_ends_at` 없는 요청 허용 | ticket-grpc.test | 잡음 |
| 취소 회차 무시 | ticket-domain.test | 잡음 |

## 3. 4관점 리뷰

- **보안(높음 0·중간 1·낮음 0)**: 중간 — `DELETED` 후기가 계정 ID와 사진 키를 비우지 않는다. 사진 표가 아직 없어 이번에는 본문·작성자 표시만 비운다. 사진·파기 단계에서 계정 ID와 사진 키를 함께 지운다.
- **정합(높음 1·중간 3·낮음 1)**: 높음 — 후기 조치·조치 기록·신고 처리 완료가 각각 다른 DB 호출이라 한 트랜잭션이 아니었다(ASVS 2.3.3). `ReviewStore.moderate`로 묶어 한 트랜잭션으로 고쳤다. 중간 — 모양이 틀린 후기·회차 ID가 500이 되던 것을 404로, 자격 답에 근거 주문이 없으면 빈 UUID 저장 대신 503으로 고쳤다. 중간(남김) — 통보로 가린 후기를 RELEASE할 때 통보 철회 여부를 확인하지 않는다. 통보 문서·철회는 ops-svc 단계에서 잇는다. 낮음 — `GrpcReviewEligibility` 어댑터를 직접 부르는 단위 시험은 없다(ticket-svc gRPC·실제 DB 시험이 계약을 덮는다).
- **시험(높음 0·중간 1·낮음 0)**: 중간 — 신고 하루 한도 변이를 단위 시험이 잡지 못했다. `review.http.test.ts`에 10건·11건 시험을 더해 잡았다.
- **운영(높음 0·중간 2·낮음 1)**: 중간 — 임시조치 끝 시각이 지나도 자동으로 풀리지 않았다. 정비 일 `review-temp-block-expire`를 더해 매일 풀게 했다. 중간(남김) — 통보 문서 원본·철회·조치 결과서는 ops-svc 몫이다. 낮음 — `content_report` 1년 보관과 `review_hidden_fingerprint` 정리 작업은 아직 없다.

## 4. 브라우저 확인 생략 사유

- `apps/web/src/widgets/reviews/ui/ReviewModalsClient.tsx`는 `entities/review`의 `REVIEW_ITEMS`·`REVIEW_SUMMARY`·`getReview` 목업을 그린다. 후기 목록·쓰기·신고가 새 core-svc API를 부르지 않는다.
- 관제 콘솔에는 후기 신고·조치 화면이 없다.
- 그래서 SCR-016의 실제 목록·쓰기·신고·운영자 조치를 눌러도 이번 웨이브 API를 확인할 수 없다. 화면 연결 배치에서 브라우저 확인을 다시 한다. 이번에는 HTTP·gRPC·DB 시험으로 대신했다.

## 5. 남은 문제

1. 후기 사진(`review_image`·검사·파생본), SCR-016 모달의 API 연결, 관제 콘솔 후기 조치 화면.
2. ops-svc·support 모듈의 CS 처리함·소명·통보 문서·조치 결과서.
3. identity-svc 팬 닉네임 내부 계약(지금 작성자 표시는 `***`).
4. 삭제 후기의 계정 ID·사진 키 비우기.
5. `content_report` 1년 보관·`review_hidden_fingerprint` 정리 작업.
6. `GrpcReviewEligibility` 어댑터 직접 시험.
