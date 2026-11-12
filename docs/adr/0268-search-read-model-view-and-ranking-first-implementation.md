# ADR-0268: 검색 읽기 모델 1차는 뷰로 두고, 순위·필터·0건 제안을 core-svc에서 한다

- **상태**: 채택(2026-11-12, 추천 적용, BUILD_ORDER HOT-270·HOT-280 / BAT-165).
- **관련**: [docs/features/search.md](../features/search.md) §2.2·§4~§6, [docs/data.md](../data.md) `search_document`, ADR-0094, ADR-0242.
- **관련 ID**: SR-T1~SR-T17, HOT-270, HOT-280.

## 맥락

- HOT-270은 검색 포트 `SearchIndex`, PostgreSQL·메모리 어댑터, 검색 읽기 모델(`search_document`·`search_term`·`search_version`), 정규화·낱자·초성 칸, 자동완성 메모리 사전을 요구한다.
- 카탈로그를 바꾸는 모든 트랜잭션에서 읽기 모델을 함께 고치는 일은 아직 없다. 1차에서 별도 동기화 작업을 먼저 만들면, 그 작업이 실패했을 때 검색이 조용히 낡는다.
- PostgreSQL 18의 `now()`와 기존 표를 조인하면 읽기 모델을 뷰로 만들 수 있다. 공연 수가 적은 1차에서는 뷰가 항상 지금 값을 보여 주는 장점이 크다.

## 결정

1. **`search_document`는 1차에서 뷰**다. `production`·`event`·`place`·`artist`·`production_artist`·`search_alias`·`production_image`·`wish`를 모아 공개 공연(판매 승인·판매 중지 아님) 한 줄을 만든다. `search_term`·`search_version`은 표로 두고, 사전 확장과 판 읽기 자리를 남긴다.
2. **검색 문서의 판매 상태**는 회차 시각으로 계산한다. `open_at > now()`는 UPCOMING, `starts_at - 24시간 <= now()`는 ENDED, 나머지는 ON_SALE이다. `purchase-svc event_sale`의 SOLD_OUT·ALL_HELD를 받는 경로는 아직 없으므로 1차에서는 SOLD_OUT을 만들지 않는다(후속 배치가 event_sale 사본을 더한다).
3. **순위·필터·쪽·0건 제안·관련 공연은 core-svc 유스케이스**가 한다. `SearchIndex` 포트가 문서를 주고, `searchDocuments`·`suggestDocuments`가 등급(정확·앞부분·낱말·중간) → 판매 상태 → 관심도 → 이름 → ID 순으로 정렬한다. 필터는 장르·공연장·아티스트·기간·상태다.
4. **자동완성 사전**은 core-svc 파드 메모리에 10초 [가정] 둔다. 공연 5·아티스트 2·공연장 1 몫을 먼저 채우고 빈 몫은 다른 종류로 채운다. `matches`는 정규화가 글자 수를 바꾸지 않을 때만 UTF-16 위치를 싣는다.
5. **한/영 변환**은 `packages/search-normalize`의 `convertQwertyToHangul`를 쓴다. `noConvert=true`면 변환하지 않고, 변환으로 찾았으면 응답 `query.converted`에 원문과 바꾼 값을 싣는다.
6. **쪽 상한**은 20개씩 50쪽(1,000건)이다. `total`은 1,000에서 멈추고 `totalCapped`를 싣는다. `limit`은 20만 받는다.

## 결과

- 검색은 별도 동기화 없이 항상 지금 카탈로그를 본다. 공연 수가 늘면 뷰 스캔이 느려질 수 있으므로 HOT-280 이후 materialized view·`search_term` 사전·`updated_version` 증분 읽기로 바꾼다.
- SOLD_OUT은 event_sale 사본이 생길 때까지 나오지 않는다. 화면은 ON_SALE·UPCOMING·ENDED만 받는다.
- `search_term`·`search_version` 표는 1차에서 자리만 잡는다. 사전 확장과 판 읽기는 후속 배치가 쓴다.

## 되돌릴 조건

- 검색 p95 300ms [가정]를 뷰 스캔이 넘거나, 공연 1만 건에서 메모리 문서가 파드 메모리를 넘으면 materialized view·증분 동기화로 바꾼다.
- `purchase-svc event_sale` 사본이 생기면 SOLD_OUT·ALL_HELD를 문서에 더한다.
