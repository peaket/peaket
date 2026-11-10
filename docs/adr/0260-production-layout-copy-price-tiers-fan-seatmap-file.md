# ADR-0260: 공연용 배치본 저장·가격 등급·팬 좌석맵 파일 게시를 한 저장 경로로 만들고, 오픈 뒤 도형 잠금을 그 경로에 둔다

- **상태**: 채택(2026-11-10, 추천 적용). BUILD_ORDER BAT-155(HOT-240) 계획(docs/review/plans/BAT-155.md).
- **관련**: [docs/features/seat-hold.md](../features/seat-hold.md) §2·§10·S-T38, [docs/data.md](../data.md) §2 `venue`·`section`·`seat`·`price_tier`·§5, [docs/api/openapi.yaml](../api/openapi.yaml) `getPartnerProductionSeatmap`·`putPartnerProductionSeatmap`·`createPartnerProductionEvent`·`SeatMapLayout`·`SeatMapLayoutInput`·`SeatMapColumns`·`EventPublicSummary.priceTiers`, [docs/security/asvs/seat-hold.md](../security/asvs/seat-hold.md) 2.2.2·5.3.1·5.3.2·8.2.3·14.2.2·15.3.3, [docs/security/asvs/catalog-review.md](../security/asvs/catalog-review.md) 2.2.3·8.2.2·8.4.1·16.3.3, [docs/verification.md](../verification.md) §4.1, [docs/api/guidelines.md](../api/guidelines.md) §8·§8.1, ADR-0063, ADR-0066, ADR-0093, ADR-0198 결정 3·4, ADR-0200 결정 4, ADR-0257
- **관련 ID**: S-T38, FR-022, FR-023, FR-052, SCR-021, SCR-022

## 맥락

- 좌석맵 저장(`PUT …/seatmap`)과 불러오기(`GET …/seatmap`)는 계약에만 있고 서버가 없다. 배치본 표(`venue`·`section`·`seat`)에는 계약의 좌석 ID(문자열)·비트맵 색인·등급·판매 제외 칸이 없고, 가격 등급 표 `price_tier`와 `event_seat_price`는 칸이 정해지지 않았다(docs/review/open-items.md 101번 ⑴, 102번 ⑴).
- 팬 좌석맵 파일(`SeatMapColumns`)은 열 위치가 곧 좌석 색인이다. 그래서 게시하는 배치는 구역 차례대로 0부터 빈틈 없이 이어져야 한다(HOT-110이 넘긴 것, seat-hold §2).
- 판매 승인 뒤의 변경은 재승인 대상이고 공개본(`production`·`event` 행)은 늘 마지막 승인 내용이다(ADR-0198 결정 3). 가격·좌석맵도 재승인 대상이다(FR-052).
- 오픈 뒤 도형 잠금 검사는 BUILD_ORDER HOT-230 줄에 적혀 있지만, 저장 경로를 만드는 단계는 HOT-240이다. 저장 경로가 잠금 없이 먼저 나가면, 판매·홀드 기록과 이어진 좌석 ID와 색인을 바꿀 수 있는 저장 경로가 남는다.
- 위저드는 가격 등급을 공연을 등록한 뒤 좌석맵과 함께 정한다고 안내한다(apps/partner `LiveStepRounds.tsx`, d5 §6.4 2단계의 가격 등급 목록은 공연 하나에 하나다).
- 이 PC는 새 패키지를 들일 수 없고 S3 라이브러리가 없다(BAT-145와 같다).

## 결정

1. **단계 경계**: HOT-240이 배치본 불러오기·저장(템플릿 틀을 복제한 초안 포함), 가격 등급, 팬 좌석맵 파일 게시, 회차의 `venue_id`, 공연 상세의 `priceTiers`, **오픈 뒤 도형 잠금**, 회차 더하기의 파일 게시를 한다. HOT-230은 템플릿 10종(정적 자료, 목록·하나 경로, 템플릿에서 만들기)과 휠체어석 W1~W3·좌석 겹침·도형 밖 좌석 경고(가져오기 다시 보기와 저장 둘 다)를 한다. 템플릿에서 만들기의 잠금 409는 HOT-240이 둔 같은 잠금 판정 함수를 부른다. HOT-220은 에디터 화면이다.
2. **저장 표(docs/data.md §2)**:
   - `venue`(LAYOUT 행)에 `version_seq`(마지막으로 잡은 판 번호, 다시 쓰지 않는다)와 `pending_layout`(승인 이력이 있는 공연의 재승인 대기 배치 문서, 아래 6)을 더한다. `layout_version`은 행에 있는 배치(승인 이력이 없으면 마지막 저장, 있으면 마지막 승인)의 판이다. `geometry_locked_at` 칸은 두지 않고 잠금은 계산한다(아래 7. 판매 종료처럼 칸 없이 계산해 회차 일정이 바뀌어도 맞출 칸이 없다, ADR-0064).
   - `section`은 `(venue_id, section_key)`가 기본 키다. `section_key`는 계약의 `sectionId`다. 구역 차례 `sort_order`와 색인 범위 `seat_index_from`·`seat_index_to`를 더한다.
   - `seat`은 `(venue_id, seat_key)`가 기본 키다. `seat_key`는 계약의 `seatId`이고 판매·홀드 기록의 좌석 ID와 같은 값이다. 좌석 ID는 소문자 UUID라(docs/features/seat-hold.md §5 '좌석 ID 글', purchase-svc 홀드의 좌석 ID 꼴·Hard Sale의 uuid 칸) `seat_key`는 uuid 칸이고 서버가 정한다: 보낸 `seatId`가 이 배치본(행 판과 대기 판)에 이미 있는 소문자 UUID면 그대로 두고, 없거나 UUID가 아니거나 이 배치본에 없는 UUID면 새 UUIDv7을 매긴다(새 좌석으로 본다. 잠긴 뒤면 좌석 집합 변경이라 409, 결정 7). 저장마다 행을 바꿔 넣어도 좌석 ID가 그대로다. 응답과 팬 파일은 서버 ID를 싣는다 (추천 적용, 2026-11-10, 리뷰). `seat_index`(배치본 안에서 유일), `tier_id`, `unavailable`을 더한다. `(venue_id, section_key, row_label, number)`가 유일하다.
   - 구역 ID(`section_key`, 계약의 `sectionId`)는 purchase-svc 판 해석의 키 조각 꼴(`^[A-Za-z0-9_-]{1,64}$`, seat-hold §2 '판 해석')이어야 하고 아니면 422 `seatmap-invalid`(`SECTION_ID_INVALID`)다. 가져오기(ADR-0257 결정 8)가 만드는 구역 ID가 이 꼴이 아니면 `s{구역 순번}`으로 바꾼다 (추천 적용, 2026-11-10, 리뷰).
   - 테넌트 표라 `section`·`seat`·`price_tier`에도 `promoter_id`를 둔다(행 보안. TEMPLATE의 구역·좌석은 NULL).
   - **가격 등급 `price_tier`**: `(venue_id, tier_id)` 기본 키, `name`(1~30자), `price`(원 단위 정수 1~10,000,000 [가정]. 결제사 최소 금액은 결제 시도가 본다), `display_order`(0부터 빈틈 없이). 배치본 하나에 1~16개다(팬 파일 `tiers` 상한 16, 좌석 등급 열이 4비트). 같은 공연의 회차는 같은 배치본이라(ADR-0093 결정 1) 가격 등급은 공연 단위다. ERD의 '회차가 가격 등급을 정한다' 선을 '배치본이 가격 등급을 정한다'로 바꾼다.
   - **`event_seat_price`는 지금 만들지 않는다**: 회차·좌석별 등급은 배치본 좌석의 `tier_id`다. 2026-10-28에 비상 홀드 경로를 없앤 뒤(ADR-0121) 이 표를 읽는 곳이 없고, purchase-svc는 좌석맵 판 파일의 좌석 등급을 쓴다(seat-hold §2 '운영 좌석맵 판'). 회차마다 다른 등급 배정이 필요해지면 그때 만든다.
3. **색인 규칙(저장 검사)**: 구역 차례가 곧 색인 차례다. 서버가 첫 구역 0부터 구역마다 `seatIndexRange`를 앞 구역 `to` + 1부터 좌석 수만큼 매기고, 구역 안 좌석 차례대로 `index`를 매긴다. 보낸 `seatIndexRange`·`index`가 있으면 그 값과 같아야 하고 다르면 422 `seatmap-invalid`(항목 코드 `INDEX_MISMATCH`)다. 없으면 서버가 채운다(가져오기의 CSV·SVG 결과는 색인이 없다). 구역 하나의 좌석은 65,536석 이하다(팬 파일 델타 `seatOffset`이 u16). 나머지 검사는 가져오기 다시 보기와 같은 검사기(개수 상한 5만 석·구역 500·꼭짓점 1,000·무대 500 [가정], 캔버스 1~100,000, 모든 좌표가 캔버스 안, 글자 칸 규칙, 같은 구역 ID·같은 구역의 열·번호·좌석 ID 겹침 없음, ADR-0257 결정 8)를 쓴다.
4. **등급과 가격 등급**: 좌석의 등급(좌석 `tierId`, 없으면 구역 `tierId`)이 모든 좌석에 있어야 하고 가격 등급에 있어야 한다(없으면 `TIER_MISSING`·`TIER_UNKNOWN`). 가격 등급은 저장 본문의 선택 칸 `priceTiers`(보이는 순서)로 받는다. 보내지 않으면 지금 가격 등급을 그대로 쓴다. 판 0(새 배치본)에서 좌석이 있는데 가격 등급이 없으면 `TIER_UNKNOWN`이다. 등급 ID는 글자 칸 규칙(30자, 제어 문자 없음)이고 겹치지 않는다. 좌석이 하나도 쓰지 않는 가격 등급도 저장한다(파트너가 미리 정해 둘 수 있게).
5. **판 번호와 저장 차례(data.md §5)**: 판 번호는 다시 쓰지 않는다. 같은 번호로 다른 내용의 파일을 덮어쓰면, 그 사이 누가 받아 둔 장기 캐시가 틀린 배치를 낸다(좌석 색인이 어긋나 다른 좌석을 잡게 된다).
   - 본문 검사(3·4)는 잠금 밖에서 먼저 한다.
   - 트랜잭션 ①(짧게): 공연 행을 `FOR NO KEY UPDATE`로 잡고(등록·회차 더하기·이미지와 같은 잠금) 소유(다른 테넌트·없는 공연 404)·판매 중지(409 `production-suspended`)·승인 이력이면 파트너 관리자(실무자 403 `partner-admin-required`)를 본다. `If-Match`가 지금 판(대기 판이 있으면 그 판, 없으면 `layout_version`, 배치본이 없으면 0)과 같아야 한다(다르면 412, 없으면 428. 본문 `layoutVersion`이 있으면 `If-Match`와 같아야 하고 다르면 412). 잠금(7)을 본다. `version_seq + 1`을 새 판 V로 잡아 커밋한다(배치본 행이 없으면 LAYOUT 행을 `layout_version` 0으로 만든다).
   - 파일 게시(6): 잠금 밖에서 V 판 파일을 쓴다. 실패하면 이미 쓴 V 파일을 지우고(실패는 기록) 503 `seatmap-publish-unavailable`과 `Retry-After: 10` [가정]이다. V는 버린 번호가 된다.
   - 트랜잭션 ②: 공연 행을 다시 잡고, 판매 중지·승인 이력의 관리자 판정과 지금 판이 아직 `If-Match`와 같은지를 다시 본다. 그 사이 다른 저장이 커밋됐으면 412이고 V 파일을 지운다(①과 ② 사이에 승인 이력이 생기거나 없어져도 파일 위치가 달라 412다). 같으면 행을 바꾸거나(승인 이력 없음) 대기 판을 쓰고(승인 이력 있음), 첫 배치본이면(지금 판이 0) 회차의 `venue_id`를 채운다(8. 그 뒤 저장은 회차 행을 고치지 않는다). 잠금은 쓰기 뒤 커밋 바로 앞에 회차를 다시 읽어 본다(② 안에서 오픈 시각이 지날 수 있다) (추천 적용, 2026-11-10, 리뷰). 커밋 뒤에 앞 판의 파일을 지운다(승인된 판의 파일은 남긴다. 실패하면 `seatmap_file_leftover` 기록).
   - **트랜잭션을 연 채 파일을 쓰지 않는다**(core 역할 `idle_in_transaction_session_timeout` 10초, docs/architecture.md §5 시간 제한 표) (추천 적용, 2026-11-10, 리뷰). ① 뒤에 회차가 더해졌으면 ②는 아무것도 쓰지 않고 끝내고, 그 회차의 V 파일을 잠금 밖에서 쓴 뒤 ②를 다시 한다(최대 2번 [가정]). 그래도 회차가 늘면 V 파일을 지우고 503 `seatmap-publish-unavailable`과 `Retry-After: 1` [가정]이다.
   - **남은 시간** (추천 적용, 2026-11-10, 리뷰): 파일을 쓰기 직전에 요청의 남은 시간을 보고, 남은 시간 − 2초 [가정](②와 응답 몫)이 1초 [가정]보다 작으면 504 `deadline-exceeded`다(V는 버린 번호). 게시의 전체 시한은 20초 [가정]와 그 값 가운데 짧은 쪽이다.
   - **커밋 결과를 모를 때** (추천 적용, 2026-11-10, 리뷰): ②의 쓰기를 마친 뒤(커밋 문장을 보낸 뒤) 오류가 나면 커밋됐는지 모르므로 V 파일을 지우지 않고 `seatmap_commit_unknown`(판, 파일 수)을 남긴다(응답 500). 커밋 전에 알 수 있는 오류(거절·쓰기 오류)만 V 파일을 지운다. 남은 파일은 V가 커밋되지 않았으면 쓰이지 않는 이름이라 정리 목록(HOT-200의 작업 원장)이 지운다.
   - **불러오기**는 읽기 전용 REPEATABLE READ 트랜잭션 하나로 배치본 행·구역·좌석·가격 등급을 읽는다(사이에 저장이 커밋돼도 판이 섞이지 않는다) (추천 적용, 2026-11-10, 리뷰).
   - 응답은 200 `SeatMapLayout`(새 판, 서버가 채운 색인, `priceTiers`, 파일을 게시했는지 `fanFilePublished`)과 `ETag: "V"`다. 불러오기와 저장 응답은 `Cache-Control: no-store`다.
6. **팬 좌석맵 파일 게시**:
   - 그 공연의 모든 회차(`event` 행과 변경분의 더한 회차)마다 키 `v1/events/{eventId}/seatmap-layouts/{V}.json`에 같은 바이트를 쓴다(경로는 회차 ID와 정수 판으로만 만든다, ASVS 5.3.2). **승인 이력이 있는 공연의 판(재승인 대기 판)은 공개 위치(1년 `immutable`, 짐작할 수 있는 주소)에 쓰지 않고** 공개 서빙 밖의 준비 위치 `staging/v1/events/{eventId}/seatmap-layouts/{V}.json`에 쓰며, 판매 승인(LCH-080)이 승인할 때 공개 위치로 옮긴다. 승인 이력이 없는 공연은 공개 위치다 (추천 적용, 2026-11-10, 리뷰). 내용은 검사를 마친 배치로 서버가 새로 만든 `SeatMapColumns` JSON이고 객체 메타데이터는 `Content-Type: application/json; charset=utf-8`, `Cache-Control: public, max-age=31536000, immutable`이다. 판매 상태와 개인정보는 싣지 않는다(ASVS 14.2.2).
   - 캔버스 `minX`·`minY`는 0, `tiers`는 가격 등급의 보이는 순서, 좌석 `tier`는 그 색인, `flags`는 휠체어석 1·판매 제외 2, 번호는 글로 낸다. 라벨이 없는 구역은 도형 꼭짓점 평균(반올림)을 라벨 위치로 쓴다. `fillRule`·`gateZone`·`level`은 싣지 않는다.
   - 모든 구역에 좌석이 하나 이상 있을 때만 게시한다(팬 파일의 구역마다 색인 범위가 있어야 한다). 그렇지 않은 저장(도형만 그린 초안, 템플릿에서 막 만든 배치)은 저장하되 게시하지 않고 `fanFilePublished: false`다. 판매 승인(LCH-080)은 게시한 판만 승인한다. 게시 여부는 DB에 남긴다: 행 판은 `venue.published_version`(공개 위치에 게시한 그 판, 아니면 NULL), 대기 판은 `pending_layout.staged`(준비 위치에 썼는지). LCH-080과 회차 더하기는 이 값을 읽고 다시 계산하지 않는다 (추천 적용, 2026-11-10, 리뷰).
   - 파일을 두는 곳은 포트 `PublicFileStore`(쓰기·지우기)다. 이 단계는 메모리 어댑터(시험)와 로컬 폴더 어댑터(개발, 환경 값 `PEAKET_PUBLIC_FILE_DIR`. 공개 위치는 `public/`, 준비 위치는 `staging/` 아래이고 개발 서버는 `public/`만 내준다 (추천 적용, 2026-11-10, 리뷰))만 둔다. S3 어댑터는 이미지의 S3 어댑터와 같은 단계(HOT-200)가 더한다. 게시는 동시 8개 [가정], 전체 20초 [가정] 안이고 넘으면 503이다.
7. **오픈 뒤 잠금**: 판정은 '승인 이력이 있고(`sale_approved_at` 있음), 그 배치본을 쓰는 취소되지 않은 회차 가운데 `open_at` ≤ 지금인 회차가 있다'다(재승인 대기로 오픈 예약이 멈춘 회차도 잠근 쪽으로 본다).
   - 잠긴 뒤 바꿀 수 있는 것은 좌석의 `unavailable`·`wheelchair`·`gateZone`과 구역의 `gateZone`뿐이다(기존 좌석의 속성 변경, data.md §2).
   - 나머지(캔버스, 무대, 구역 집합과 차례, 구역 도형·이름·층·라벨·등급, 좌석 집합과 색인·열·번호·좌표·등급)가 승인된 판과 다르면 409 `seatmap-geometry-locked`이고 보안 사건으로 남긴다(catalog-review 16.3.3 '잠긴 배치본 교체 시도'). 가격 등급이 승인된 판과 다르면 409 `sale-setting-locked`다.
   - 잠금은 트랜잭션 ①·②에서 두 번 본다(그 사이 오픈 시각이 지날 수 있다). ②는 쓰기 뒤 커밋 바로 앞에 본다 (추천 적용, 2026-11-10, 리뷰).
   - 등급은 표기가 아니라 실제 등급(좌석 `tierId`, 없으면 구역 `tierId`)으로 견준다. 구역의 등급 표기를 좌석으로 옮기기만 한 저장은 막지 않는다 (추천 적용, 2026-11-10, 리뷰).
   - 잠긴 뒤에도 재승인 대기 판(9)에 도형·좌석 변경이 남아 있으면, 그 대기 판을 이어 고친 저장은 승인된 판과 달라 409 `seatmap-geometry-locked`이다. 파트너는 [변경 취소](판매 승인 LCH-080의 경로)로 대기 판을 버리고 승인된 판에서 속성만 고친다. 그 409의 보안 사건 `seatmap_locked_attempt`는 승인된 판과 견준 갈래를 싣는다 (추천 적용, 2026-11-10, 리뷰).
   - 잠긴 배치를 옛 `If-Match`로 바꾸려 해 412로 끝나도, 승인된 판과 견줘 도형·좌석이 바뀌었으면 `seatmap_locked_attempt`를 남긴다(catalog-review 16.3.3) (추천 적용, 2026-11-10, 리뷰).
8. **회차의 `venue_id`**: 첫 배치본을 커밋할 때 그 공연의 모든 `event` 행과 변경분의 더한 회차(`pending_revision.addedEvents`의 `venueId`)에 같은 값을 넣는다(ADR-0198 결정 4). 그 뒤 회차를 더하면 지금처럼 다른 회차의 값을 쓰고, 배치본이 있으면 그 회차의 파일(공개 위치에 게시한 행 판, 준비 위치에 쓴 대기 판)을 쓴다. 파일은 트랜잭션 밖에서 쓴다: 회차 ID를 먼저 만들고 잠금 없이 게시한 판을 읽어 파일을 쓴 뒤, 트랜잭션 안에서 게시한 판이 그대로인지 다시 보고 넣는다(바뀌었으면 되돌리고 다시, 최대 2번 [가정], 그래도 바뀌면 503 `Retry-After: 1` [가정]). 회차를 넣지 않게 되면(거절·실패·같은 멱등 키의 다시 보내기) 쓴 파일을 지우고 못 지우면 `seatmap_file_leftover`를 남긴다 (추천 적용, 2026-11-10, 리뷰). 쓰지 못하면 회차를 더하지 않고 503 `seatmap-publish-unavailable`이고 `seatmap_publish_failed`에 판 번호를 싣는다.
9. **승인 이력이 있는 공연**: 파트너 관리자만 저장한다. 행(`section`·`seat`·`price_tier`·`venue`의 캔버스·무대)은 그대로 두고 배치 문서 전체(가격 등급 포함)와 판을 `venue.pending_layout`에 쓴다. `APPROVED`면 `SUBMITTED`로 바꾸고, `SUBMITTED`·`REJECTED`면 그대로다(ADR-0198 결정 3과 같다). 불러오기는 대기 판을 준다. 판매 승인(LCH-080)이 대기 판을 행으로 옮기고 그 판을 공개 판으로 정하며, 준비 위치의 그 판 파일(`staged`가 참일 때)을 공개 위치로 옮기고 `published_version`을 채운다(6). 그래서 이 단계의 저장은 공개 응답(공연 상세, 승인된 판의 팬 파일)을 바꾸지 않고 캐시 무효화가 없다. 대기 판의 파일은 공개 위치에 쓰지 않는다 (추천 적용, 2026-11-10, 리뷰).
10. **불러오기**: 지금 판(대기 판이 있으면 그 판)을 준다. 배치본이 없고 `fromTemplate`가 공개된 TEMPLATE 행이면 그 틀의 캔버스·무대·구역(채우기 규칙 포함, 좌석 없음)을 판 0 초안(`templateVenueId` 채움)으로 준다. 배치본이 있으면 `fromTemplate`는 보지 않는다. 배치본이 없고 `fromTemplate`가 없거나 틀이 없거나 공개되지 않았거나 배치본 ID면 404다. 저장의 `templateVenueId`는 판 0에서만 뜻이 있고 공개된 TEMPLATE 행이어야 한다(아니면 422 `TEMPLATE_INVALID`). 판 1 이상에서는 보내면 저장값과 같아야 한다(다르면 422 `TEMPLATE_INVALID`. 조용히 버리지 않는다).
11. **받기 상한**: 저장 본문은 12MiB [가정]까지 받는다(5만 석 배치 JSON 약 6.5MB [추정]). 요청 하나의 힙이 커서(파싱하면 본문의 몇 배) 좌석맵 저장만의 칸막이 파드당 동시 2개 [가정]를 본문을 읽기 전에 잡는다(이미지 올리기·좌석맵 가져오기 칸막이 4개와 따로, 파트너 DB 풀 4 가운데 2를 다른 파트너 경로에 남긴다). 자리는 처리기가 끝날 때까지 쥔다(손님이 연결을 끊어도 처리 중이면 놓지 않는다) (추천 적용, 2026-11-10, 리뷰). 요청 남은 시간은 60초 [가정]다.
12. **공연 상세의 `priceTiers`**: 회차의 `venue_id`가 가리키는 `price_tier` 행을 보이는 순서로 싣는다(ADR-0200 결정 4). 배치본이 없으면 빈 목록이다. 공개 응답은 승인된 공연만 내고 그 행은 마지막 승인 내용이라, 재승인 대기 가격은 나오지 않는다.
13. **기록**: 저장마다 결과(판, 좌석·구역 수, 결과 코드, 게시 여부·회차 수)를 남긴다. 구역 이름 같은 파트너 글자는 넣지 않는다. 잠긴 배치본 바꾸기 시도와 남의 공연 저장·불러오기는 보안 사건이다.
14. **남은 일수 다시 어림**: HOT-240을 마치면 wbs 2.9.2 설명 칸의 '일수는 처음 묶음을 마친 뒤 다시 어림한다'를 이 묶음의 실측(시간·토큰)으로 HOT-220·HOT-230의 남은 일수로 바꿔 적는다.
15. **구현 세부(2026-11-10 HOT-240 구현에서 정함, [가정] 표시는 정본 반영 대기)**:
   - **배치본 ID는 공연 ID에서 정한다**: LAYOUT 행의 `id`는 UUIDv5(정한 이름공간, 공연 ID)다. 첫 저장의 트랜잭션 ①이 배치본 행을 만들어 판을 잡지만 회차에는 트랜잭션 ②에서야 잇기 때문에(결정 8), 첫 저장이 게시 실패·412로 끝나도 다음 저장이 회차를 거치지 않고 같은 행을 찾아 `version_seq`를 잇는다(판 번호를 다시 쓰지 않는다, 결정 5). 템플릿에서 만들기(HOT-230)도 같은 ID를 쓴다.
   - **묶음 외래키**: `section`·`seat`·`price_tier`·`event`의 (`venue_id`, `promoter_id`)는 `venue`(`id`, `promoter_id`)를 가리킨다(판매자 사본이 배치본의 판매자와 다르게 들어가지 못한다, 틀은 판매자가 없어 걸리지 않는다). 행 보안은 `promoter_id`만 보므로 남의 배치본 ID에 자기 판매자로 넣는 행은 이 외래키가 막는다(23503). 공연 상세의 가격 등급 조회도 회차의 판매자 조건을 함께 건다 (추천 적용, 2026-11-10, 리뷰). 등급 외래키는 두지 않고 등급 규칙(결정 4)은 저장 검사가 본다.
   - **틀 2차 방어**: `venue.template_venue_id`는 트리거가 공개된 TEMPLATE 행만 받는다(값이 바뀔 때만 본다, 23514) (추천 적용, 2026-11-10, 리뷰).
   - **팬·관제 DB 사용자**는 배치본 표 가운데 공연 상세에 필요한 `price_tier`의 칸만 읽는다(`venue`·`section`·`seat`은 읽지 못한다) (추천 적용, 2026-11-10, 리뷰).
   - **도형 이름**(`sections[].shape.name`)도 글자 칸 규칙(30자, NUL·제어 문자 없음, `TEXT_INVALID`)이다 (추천 적용, 2026-11-10, 리뷰).
   - **잠금 판정의 회차**에는 변경분의 더한 회차도 넣는다(`open_at`이 지났으면 잠근 쪽으로 본다) [가정]. 잠긴 뒤 견주지 않는 칸은 받는 속성(결정 7) 말고 에디터 값 `fillRule`과 `templateVenueId`(결정 10이 따로 본다)다 [가정]. 바뀐 갈래 코드는 `CANVAS`·`STAGE`·`SECTION_SET`·`SECTION_GEOMETRY`·`SEAT_SET`·`SEAT_GEOMETRY`다.
   - **두 트랜잭션 사이에 더한 회차**: 트랜잭션 ②가 잠금 안에서 그 회차의 V 판 파일을 쓰고 잇는다(쓰지 못하면 503). 트랜잭션 ②가 거절(412·409·403)하거나 실패하면(커밋 전 DB 오류는 500) 그 판 파일을 모두 지운다.
   - **422 항목 코드**: 결정 3·4·10의 `INDEX_MISMATCH`·`TIER_MISSING`·`TIER_UNKNOWN`·`TEMPLATE_INVALID`와 구역 ID 꼴 `SECTION_ID_INVALID`(결정 2), 가격 등급 ID 겹침 `TIER_DUPLICATE`, 구역 하나 65,536석 초과 `SECTION_TOO_LARGE`(5만 석 상한이 먼저라 지금은 닿지 않는다), 개수 상한 `TOO_MANY_*`(칸 `layout`)다. 등급 ID·이름의 제어 문자·공백뿐은 `TEXT_INVALID`다.
   - **받기**: 본문 상한을 넘으면 이름 없는 413(`about:blank`)이다. 플랫폼 `@BodyLimit`이 기본 상한(1MiB)보다 큰 값을 받으려면 칸막이를 함께 단다(`@BodyLimit(bytes, { bulkhead })`). 두 경로의 `Cache-Control: no-store`는 처리기 앞의 거절(400·401·413·429)에도 단다.
   - **가격 등급 빈 목록**: 저장 본문의 `priceTiers: []`는 '등급 없이 저장'이다(불러오기가 준 빈 목록을 그대로 다시 보낼 수 있다. 좌석이 있으면 `TIER_UNKNOWN`) (추천 적용, 2026-11-10, 리뷰).
   - **기록 칸**: `seatmap_saved`(판·좌석·구역 수·`published`·위치 `where` `public`|`staging`·회차 수 `rounds`), `seatmap_commit_unknown`(판·파일 수), `seatmap_save_rejected`(`status`·`code`), `seatmap_publish_failed`(판·`failed` 회차 수·`reason` `write`|`timeout`), `seatmap_file_leftover`(판·`count`), 보안 사건 `seatmap_locked_attempt`(`changes`)와 `partner_production_denied`(`route` `seatmap`, `action` `load`|`save`, 승인 뒤 실무자 저장은 `reason` `partner_admin_required`).

## 결과

- 좌석 ID와 색인이 저장마다 같은 규칙으로 정해지고, 오픈 뒤에는 바꿀 수 없다. 팬 파일의 열 위치와 좌석 색인이 어긋나지 않는다.
- 판 번호를 다시 쓰지 않아, 실패하거나 진 저장이 남긴 파일이 다음 판의 이름을 차지하지 않는다. 대가로 판 번호에 빈 번호가 생긴다.
- 회차 수만큼 같은 파일을 쓴다(회차 50개 × 5만 석 파일 약 1.5MB [추정] = 저장 한 번에 약 75MB [추정]). 앞 판 파일은 지워 쌓이지 않는다.
- 승인 이력이 있는 공연의 배치 변경은 재승인 때까지 공개본을 바꾸지 않는다. 그 적용은 LCH-080이 한다.
- `event_seat_price`가 없으므로 회차마다 다른 좌석 등급은 지금 지원하지 않는다.

## 되돌릴 조건

- 회차마다 좌석 등급이나 가격을 다르게 팔아야 하면(예: 낮 공연 할인), `event_seat_price`나 회차별 가격 등급을 만들고 팬 파일 `tiers`를 회차별로 낸다.
- 저장 한 번의 파일 쓰기가 회차 수 때문에 20초를 자주 넘으면, 회차 경로를 공연 단위 파일로 돌리는 CDN 규칙(경로 다시 쓰기)을 검토한다(그때 S3 키와 경로가 같아야 한다는 guidelines §10 규칙을 함께 고친다).
