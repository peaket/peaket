# BAT-465 잔여 2차 측정·게이트 기록

- 가지: `wave/lane3-BAT-465-remainder-2`(기준 `origin/develop` `ce9ee2c0`, R-591)
- 커밋: R-593(amend)
- 선택 배치: **Q-T59 예매 제한 집행 쓰기 경로**(queue-svc·purchase-svc `SetBookingRestriction` 수신) + **외부 불변 저장소·OpenTimestamps 앵커 포트/가짜 어댑터**

## 1. 선택 배치와 범위

- `docs/BUILD_ORDER.md` BAT-465 행의 남은 몫 가운데 Q-T59가 갈래 3에서 바로 구현 가능한 배치였다. S3 Object Lock·OpenTimestamps는 외부 버킷·달력이 없어 포트·계약·가짜 어댑터·503만 남겼다.
- core-svc `RecordSaleReviewResult`(비공개·검색·홈·오픈 예약 멈춤)·SCR-048 실제 API 연결·payment-svc `SALE_SUSPENDED` 정산 보류·제어 gRPC 전 파드 ack 집계는 이번 배치에 넣지 않았다. 다음 배치 후보로 남긴다.
- 마이그레이션은 추가하지 않았다(core 0017·payment 0017·ops 0012를 쓰지 않았다).

## 2. 구현

- queue-svc `BookingRestrictions.apply`: `q:rst:{account}`에 `st`·`until`·`rid`·`ver`를 Lua 한 번으로 쓰고, 저장한 판보다 큰 판만 반영한다. 옛 판은 `changed:false`다. `BookingRestrictionService.SetBookingRestriction` gRPC 수신을 등록했다.
- purchase-svc `BookingRestrictions.apply`: `s:rst:{account}`에 같은 규칙으로 쓰고, `BookingRestrictionService.SetBookingRestriction` gRPC 수신을 등록했다. 주문 생성은 기존처럼 `read`로 막는다.
- ops-svc audit에 `ImmutableAnchorStore`·`OpenTimestampsAnchor` 포트, `S3ObjectLockAnchorStore`·`OpenTimestampsAnchorAdapter`(설정 없으면 503 `anchor-unavailable`), `MemoryImmutableAnchorStore`·`MemoryOpenTimestampsAnchor` 가짜 어댑터, `anchorCheckpoint`(하나라도 실패하면 로컬 앵커 유지·오류 기록)를 넣었다. 기존 Ed25519 로컬 앵커는 그대로다.
- 새 문제 유형 `anchor-unavailable`(503)을 `x-peaket-problem-types`에 더하고 contracts·api-client 생성물을 다시 만들었다.

## 3. cheap gate (2026-11-15)

| 검사 | 결과 |
| --- | --- |
| ops-svc 단위 | 93 통과(22 파일) |
| core-svc 단위 | 346 통과(43 파일) |
| payment-svc 단위 | 2936 통과(39 파일) |
| purchase-svc 단위 | 3858 통과(111 파일) |
| queue-svc 단위 | 687 통과(39 파일) |
| console-host 단위 | 57 통과 |
| platform 단위 | 542 통과(43 파일) |
| contracts 단위 | 41 통과(11 파일) |
| api-client 단위 | 113 통과(8 파일) |
| typecheck | 42 작업 통과 |
| lint | 오류 0 |
| doc-check | 오류 0, 경고 4(기존 openapi 410/504 설명·mermaid 도구) |
| ledger `--batch BAT-465` | 자동 시험 7·ID만 112·빈칸 96(배치 전체 기준. Q-T59는 자동 시험으로 바뀜) |
| trace-check GAT-300/GAT-310 | GAT-300 11·GAT-310 10 통과(시험 4638개 대조) |
| records `--check` | 통과(기존 R 번호 중복 경고만) |
| contracts `gen:check` | 통과 |
| console-host build | 통과 |

## 4. 남은 막힘

- 외부 불변 저장소(S3 Object Lock)와 OpenTimestamps 달력·비트코인 노드는 자격 증명·계약 뒤다. 지금은 503과 로컬 앵커만 남는다.
- core-svc `RecordSaleReviewResult`: 판매 중지 시 비공개·검색·홈·오픈 예약 멈춤을 한 트랜잭션으로 반영하는 gRPC와 SCR-048 실제 API 연결이 아직 없다(디자인 보드 미리보기만 있다).
- payment-svc 정산 보류 `SALE_SUSPENDED`: 판매 중지 결과를 정산서 HELD로 옮기는 내부 경로가 아직 없다.
- 제어 gRPC 전 파드 ack 집계: 지금은 호출한 파드의 ack 판만 본다. 파드 수·전 파드 ack 집합은 배포·Lease 단계다.
- Q-T59의 ops-svc 승인 업무·10분 재전송 작업 워커와 화면은 아직 없다. 이번에는 두 서비스의 수신·판 번호 가드까지다.

## 5. rebase·heavy gate (2026-11-15)

- 갈래 1 merge `ce9ee2c0`(R-591) 위로 rebase했다. 충돌은 `docs/00-summary.md`·`docs/review/consistency-review.md` 두 곳이었고 R-591·R-593 행을 모두 남겼다. 나머지 문서·계약·서비스 파일은 자동 병합됐다. 마이그레이션은 추가하지 않았고 purchase 마이그레이션 파일 수는 21이다.
- 계약 생성물: `pnpm --filter @peaket/contracts gen`·`pnpm --filter @peaket/api-client gen` 뒤 `gen:check` 통과.
- cheap gate 재확인: ops 93·core 346·payment 2936·purchase 3858·queue 687·console-host 57·platform 542·contracts 41·api-client 113, typecheck 42·lint 0·doc-check 0(경고 4)·ledger BAT-465(자동 7·ID만 112·빈칸 96)·trace GAT-300 11/GAT-310 10·records 0·console-host build.
- Docker test-int(대상 파일): queue `booking-restriction.int.test.ts` 4 통과, purchase `booking-restrictions.int.test.ts` 35 통과, ops `immutable-anchor.int.test.ts` 3 통과. 실제 Valkey 8.1·gRPC로 판 번호 가드·옛 판 무시·`q:rst`/`s:rst`·`until` 제거·INVALID_ARGUMENT, S3/OTS 설정 없음 503·가짜 저장소를 확인했다.
- 변이 6/6 잡힘: queue/purchase Lua 판 번호 `>=`→`>`, `bookingRestricted`가 LIFTED도 막게, queue Lua until `HDEL` 제거, `anchorCheckpoint` localOnly false 고정, 앵커 오류 재던짐. 각 변이에서 해당 단위·test-int가 실패했고 되돌렸다.
- 4관점 리뷰: 높음 0. 중간 1 고침(purchase `MemoryBookingRestrictions.read`가 Redis에 없는 `rid`·`ver`를 돌려주던 불일치), 중간 4 문서화·후속(§6).
- 브라우저: SCR-030 `/commands`에서 명령 3건·SSE 실시간·`SALE_STOP` 승인→성공·감사 체크포인트 검증 통과. SCR-048 `/sale-reviews/...` 디자인 보드에서 판매 중지 요청·승인 대기·중지됨 세 상태 확인. SCR-048은 보드 미리보기이고 실제 API에 연결되지 않았다. 기록 `docs/review/browser-check/R-593.md`.
- 컨테이너: test-int가 만든 Valkey/PostgreSQL 컨테이너는 각 시험의 afterAll에서 지웠고, `docker ps`에 남은 것이 없다. 콘솔 dev·가짜 API 프로세스도 종료했다.

## 6. 4관점 리뷰

- **보안**: gRPC `SetBookingRestriction`의 신원 확인은 메시 웨이포인트 L7 허용 목록에 맡긴다(기존 `PriorityGrantService`와 같은 경계). 앱 계층 `PERMISSION_DENIED`는 없다. 중간(문서화·후속).
- **정합**: purchase `MemoryBookingRestrictions.read`가 Redis read에 없는 `rid`·`ver`를 돌려주던 불일치를 고쳤다. `q:rst`/`s:rst`의 `ver` 칸이 망가진 경우 Lua tonumber가 nil이라 쓰기가 INTERNAL로 닫힌다(제한 없음으로 숨기지 않는 fail-closed). 복구 절차·검증은 후속. 중간.
- **시험**: 판 번호·ACTIVE/LIFTED·until·앵커 실패를 변이 6건으로 확인했다. 새 쓰기 경로의 Redis 일시 장애(UNAVAILABLE) 매핑은 단위 시험이 아직 없다. 중간(후속).
- **운영**: 앵커 실패는 `errors`에 `e.name`만 남고 지표·경보가 없다. `q:rst`/`s:rst`에 TTL이 없어 ACTIVE(끝 없음) 사본은 ops가 LIFTED를 보낼 때까지 남는다(fail-closed). S3 버킷·리전을 줘도 실제 PUT은 아직 503이다. 중간·막힘으로 기록.
