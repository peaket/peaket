# 웨이브 보고서: 갈래 3 BAT-615

- 날짜: 2026-11-13
- 가지: `wave/lane3-BAT-615`(바탕 `origin/develop` `8b8da353`, 합치기·푸시 안 함)
- 배치: BAT-615(LCH-070·LCH-080, B, R-528)
- 웨이브 규칙: ADR-0267(배치마다 싼 게이트, 웨이브 끝에 비싼 게이트 한 번)

## 1. 커밋

| R | 커밋 | 내용 |
| --- | --- | --- |
| R-528 | `607bd40f`(heavy gate 전 squash) | LCH-080 설정 사본·관제 승인/반려, BAT-435 부분 적용 기록 |
| R-528 | 이 보고서를 포함한 최종 커밋 | heavy gate에서 찾은 마이그레이션 장부·core_ops 역할·저장소 중복 적용 수정, test-int·변이·리뷰 |

## 2. 게이트

| 게이트 | 결과 |
| --- | --- |
| rebase | `origin/develop` `8b8da353` 위로 완료. `docs/00-summary.md`·`docs/features/seat-hold.md`·`docs/review/consistency-review.md` 충돌은 양쪽을 살려 해소 |
| core-svc 단위 시험 | **258 통과**(S-T41 8개: 설정 사본 4·승인/반려 4) |
| core-svc test-int | **211 통과, 1 건너뜀**(14파일). 실제 PostgreSQL 18, 마이그레이션 0010·0011·0012, `core_app`·`core_partner`·`core_ops` 로그인 |
| test-int 새 파일 | `test-int/sale-approval.int.test.ts` 3개: 승인 트랜잭션·반려·`sale-config-publish` |
| typecheck | core-svc·contracts 통과 |
| lint | `pnpm lint` 통과 |
| doc-check | 오류 0·경고 4(기존 API 3·mermaid 건너뜀) |
| `ledger --batch BAT-615 --require` | 통과(S-T41 자동 시험 1, 미검증 0) |
| trace-check `S-T41` | 단위 보고서 8개·test-int 보고서 3개 통과 |
| records `--check` | 통과 |
| 변이 | **14/14 잡힘, 놓침 0** |
| 4관점 리뷰 | 높음 3(고침), 중간 4(고침), 낮음·남은 문제 4 |
| 브라우저 확인 | 생략(SCR-048 화면 미구현, 이 배치는 관제 REST·저장소만) |
| CI | GitHub Actions는 푸시 금지로 돌리지 않았다. 위 로컬 등가 게이트로 대신했다 |

## 3. test-int에서 찾은 것

1. **마이그레이션 장부 누락(높음)**: `0010_event_sale_config.sql`·`0011_sale_approval_columns.sql`을 `migrations/meta/_journal.json`에 넣지 않아 Drizzle migrator가 적용하지 않았다. test-int가 `column "accessible_seating_check" does not exist`로 전부 실패했다. 0010·0011·0012를 장부에 넣어 고쳤다.
2. **관제 쓰기의 DB 역할(높음)**: `OPS_SALE_STORE`·`DrizzleSaleConfigStore`가 팬 경로 `core_app`(읽기 전용)으로 접속해 승인 UPDATE·`event_sale_config` INSERT가 운영에서 실패한다. `core_ops` 역할(마이그레이션 0012, 최소 칸 권한·RLS 정책)과 `PEAKET_OPS_DATABASE_URL`을 더하고, HTTP·relay 정비 일을 그 연결로 옮겼다.
3. **정비 일의 DB 역할(높음)**: `sale-config-publish`가 `core_maintenance` 연결로 승인 공연을 읽어 칸 권한이 모자랐다. relay가 `PEAKET_OPS_DATABASE_URL`로 `core_ops` 연결을 만들고 역할을 확인한 뒤 그 연결로 읽고 쓰게 했다. 주소가 없으면 그 일을 띄우지 않는다.
4. **저장소의 중복 적용(중간)**: `drizzle-sale-store.approve`가 `applyApproval`이 만든 공개본과 별개로 `pending_revision.eventChanges`·`addedEvents`·`scales`를 다시 적용해, 규칙이 두 곳에 흩어지고 변이가 가려졌다. 저장소는 `after.events`만 쓰도록 고쳤다. 이 변경으로 변이 `approval-event-changes`·`approval-scale`이 잡혔다.
5. **승인 본문(중간)**: `accessibleSeatingCheck`를 컨트롤러가 받지 않아 DB 칸까지 닿지 않았다. 닫힌 본문에 `z.boolean().optional()`로 더했다. `artistIds`·`aliases`는 아직 적용 경로가 없어 조용히 버리지 않도록 본문에서 뺐다(다음 배치에서 파트너 요청과 함께 붙인다).
6. **UUID 검증(중간)**: `placeId`·`scales[].eventId`가 `z.string()`이라 잘못된 값이 DB 캐스팅 500으로 샜다. `z.uuid()`로 400을 내게 했다.

## 4. 변이 14개

| 변이 | 잡은 시험 |
| --- | --- |
| 설정 사본 `salePolicy` 빈 배열 | 단위·test-int |
| `eligGates`를 GENERAL로 | 단위·test-int |
| `rev`에서 정책 판 무시 | test-int |
| 취소 회차 제외 제거 | 단위 |
| 판매 종료를 공연 시작으로 | 단위·test-int |
| 승인 때 pending 규칙 무시 | 단위·test-int |
| 승인 때 회차 고침 무시 | 단위·test-int |
| 승인 때 더한 회차 무시 | test-int |
| 승인 때 규모 무시 | 단위·test-int |
| DB 승인 상태를 SUBMITTED로 | test-int |
| DB pending_revision 비우지 않음 | test-int |
| 메모리 반려를 APPROVED로 | 단위 |
| DB 반려를 APPROVED로 | test-int |
| 승인 전 공연 설정 사본 허용 | 단위 |

- 결과: **14/14 잡힘, 놓침 0, 무효 0**.
- 처음 두 변이(회차 고침·규모)는 저장소의 중복 적용 때문에 놓쳤다. 저장소를 `after.events` 단일 경로로 고친 뒤 다시 넣어 둘 다 잡았다.

## 5. 4관점 리뷰

- **보안**: `core_ops`는 승인에 필요한 칸만 UPDATE하고(판매자·제목·장르 등은 넓히지 않음), production·event·venue·price_tier·sale_eligibility_list·event_sale_config에만 RLS 정책을 둔다. 승인 본문은 닫힌 객체이고 `placeId`·`eventId`는 UUID로 검증한다. 새 PII는 없다(설정 사본은 규칙·시각·명단 키만).
- **정합**: 승인은 `applyApproval` 한 곳에서 pending 규칙·회차 고침·더한 회차·규모를 만들고, 저장소는 그 결과만 쓴다. 반려는 상태만 바꾸고 pending을 남긴다. `event_sale_config.payload`는 대기열 `q:{event:E}:cfg`와 같은 모양이다.
- **시험**: 단위 258·test-int 211·변이 14/14. test-int는 실제 DB 역할과 마이그레이션 장부까지 본다.
- **운영**: `PEAKET_OPS_DATABASE_URL`을 서비스·relay 필수/선택 값으로 문서에 적었다. relay는 주소가 없으면 `sale-config-publish`를 띄우지 않고, 있으면 역할을 확인한다. `sale-config-publish`는 하루 한 번 승인 공연을 다시 훑어 승인 직후 사본 쓰기가 실패한 경우를 복구한다.
- **낮음·남은 문제**:
  1. 반려 사유를 저장·전달하지 않는다(`reject`가 사유를 무시한다). 파트너 요청·SCR-048 화면을 붙이는 다음 배치에서 `rejectionReason`까지 잇는다.
  2. `sale-config-publish`는 승인 공연을 `sale_approved_at` 오름차순으로 최대 500개만 본다. 그보다 많으면 뒤쪽(최신) 공연이 굶을 수 있다. 커서·쪽 나누기를 다음에 더한다.
  3. 회차 설정 사본을 회차마다 순차 INSERT/HSET한다. 회차가 많은 공연의 승인 지연을 재고 묶음 쓰기를 검토한다.
  4. `q:{event:E}:epoch`·`openSale`·`event_sale` UPCOMING은 아직 쓰지 않는다. LCH-080 다음 배치다.

## 6. 브라우저 확인 생략 사유

- SCR-048 관제 판매 승인 화면은 이 배치에 없다. 바뀐 것은 core-svc의 관제 REST 경로·DB 표·relay 정비 일뿐이고, apps·packages의 화면 코드는 바뀌지 않았다. 그래서 브라우저 확인을 생략했다. 화면을 붙이는 배치에서 SCR-048 승인·반려 흐름을 확인한다.

## 7. 컨테이너

- test-int·변이가 만든 PostgreSQL 컨테이너는 각 시험의 `afterAll`이 지웠다. `docker ps -a --filter name=lane3-bat615`와 `lane3-bat615-mut`, `ancestor=postgres:18-alpine`에서 남은 컨테이너가 없음을 확인했다.
