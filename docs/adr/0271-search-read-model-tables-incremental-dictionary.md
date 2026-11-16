# ADR-0271: 검색 읽기 모델을 정본대로 표로 바꾸고, 검색은 후보만 읽으며, 자동완성 사전은 판으로 증분 갱신한다

- **상태**: 채택(2026-11-16, 추천 적용, BAT-165 웨이브 7 계획 `l2w7-BAT165-plan`). [ADR-0268](0268-search-read-model-view-and-ranking-first-implementation.md) 결정 1(읽기 모델 1차는 뷰)과 결정 4의 '10초 동안 통째로 들고 있기'를 바꾼다. ADR-0268 결정 2(시각으로 판매 상태 계산, SOLD_OUT은 event_sale 사본 뒤)·3(순위 규칙)·5·6은 그대로다.
- **관련**: [docs/features/search.md](../features/search.md) §2.2·§2.3·§4.4·§7.1·§7.2·§10·§11, [docs/data.md](../data.md) `search_document`·`search_term`·`search_removal`·`search_version`과 '공연 검색'·'자동완성 사전 증분 갱신' 쿼리 줄, ADR-0094, ADR-0242, 감사 COV2-02·COV2-07(docs/review/audit/reports/verification/COV2.md).
- **관련 ID**: HOT-270, HOT-280, SR-T7, SR-T8, SR-T12, SR-T13, SR-T15, SR-T17, NFR-028.

## 맥락

- 정본(features/search.md §2.2~§2.3, data.md)은 처음부터 읽기 모델을 표 넷으로 두고 카탈로그와 같은 트랜잭션에서 고치며, 자동완성 사전은 판(`search_version`)과 지운 표시(`search_removal`)로 증분 갱신하고, 검색은 `search_term`의 앞부분 인덱스로 후보를 찾는다고 적었다. ADR-0268은 1차 구현을 뷰로 줄이고 "HOT-280 이후 materialized view·`search_term` 사전·`updated_version` 증분 읽기로 바꾼다"고 적었다.
- 2026-11-16 웨이브 6 감사가 두 가지를 찾았다. COV2-02: 뷰가 지난 회차 + 오픈 전 다음 회차 공연을 판매 중으로 셌다(R-606 `0018_search_sale_status.sql`이 회차별 판정으로 고쳤다). COV2-07: 검색이 요청마다 `search_document` 전체를 읽고 메모리 색인을 다시 만든다. 자동완성만 10초 동안 들고 있다.
- 뷰 설계로는 정본의 판정 기준 둘을 만족할 수 없다. SR-T15는 "통째로 읽기 없이 증분 갱신 한 번 안에 빠진다"를 요구하는데 뷰에는 바뀐 줄의 판이 없다(`updated_version`이 모든 줄에 지금 판이다). HOT-270 단계 줄은 `search_term`의 정규화·낱자·초성 칸을 요구하는데 뷰 설계는 그 표를 비워 둔다.
- 캐시를 비켜 가는 무작위 입력(features/search.md §8)은 요청마다 원본에 온다. 요청마다 전체 문서를 읽으면 DB·CPU 비용이 공연 수 × 요청 수로 는다. ADR-0268의 되돌릴 조건(p95 300ms 초과)은 아직 재지 않았지만, 정본 설계로 돌아가는 것은 방향을 바꾸는 일이 아니라 미뤄 둔 정본을 따르는 일이다.

## 결정

1. **`search_document`는 표다.** 0018의 계산(회차별 판매 상태, COV2-02 규칙)은 원천 뷰 `search_document_source`로 이름을 바꿔 남기고(뷰는 시각을 받는 SQL 함수 `search_document_source_at(at timestamptz)`를 `now()`로 부른다. 동기화는 앱 시계의 시각을 넘겨, 시험이 경계 시각을 정확히 줄 수 있게 한다), 대표 회차는 ADR-0093 결정 8의 차례(판매 중 회차는 판매 종료가 가장 이른 것, 지난 회차뿐이면 가장 최근에 공연한 것)로 고친다(0018은 판매 중 회차를 오픈 시각 순, 지난 회차를 오래된 순으로 골라 메모리 `representativeEvent`와 어긋난다, 2026-11-16 계획에서 찾음), 표 `search_document`에 `updated_version`을 둔다. `search_term`은 공연명·다른 이름·아티스트·공연장 이름마다 한 줄이고, 정규화·띄어쓰기 없앤 값·낱자·초성은 `packages/search-normalize`의 같은 함수(§3.1)로 앱이 계산한다(SQL로 다시 짜지 않는다. 브라우저·서버·DB가 같은 코드를 쓰게).
2. **동기화는 한 함수이고 같은 트랜잭션에서 부른다.** `syncSearchReadModel(tx, productionIds)`가 원천 뷰에서 그 공연들의 줄을 다시 계산해 `search_document`·`search_term`을 고치고, 빠진 공연과 없어진 이름 줄은 `search_removal`에 적으며, `search_version`을 트랜잭션마다 한 번 1 올린다(`UPDATE … RETURNING`, data.md `search_version`). 지금 부르는 자리는 판매 승인(첫 승인·재승인 반영) 트랜잭션, 포스터 게시·지우기 트랜잭션, 아래 3의 정리 작업이다. 판매 중지·재개(BUILD_ORDER LCH-090), 회차 전부 취소(GAT-110), 운영자의 다른 이름 지우기·이름 바꾸기는 그 단계가 같은 함수를 부른다(SR-T8 ③). 승인 전 공연의 파트너 편집(회차·이미지·다른 이름)은 공개본을 바꾸지 않으므로 부르지 않는다(ADR-0093 결정 7, `isPublic` 주석).
   - 부르는 자리를 빠뜨리면 검색이 조용히 낡는다(ADR-0268 맥락). 그래서 통합 시험 하나가 지금 있는 쓰기 API를 차례로 부른 뒤 `search_document`가 `search_document_source`와 같은지(어긋난 줄 0) 본다. 운영에서 사전 쪽 어긋남은 §10의 `search_dictionary_drift_entries`가 잡는다.
3. **1분 [가정] 정리 작업**이 회차의 오픈·판매 종료 시각이 지난 공연만 다시 동기화하고(features/search.md §2.2), 하루 [가정] 지난 지운 표시를 지운다. 관심도(1차 구현은 찜 수, data.md `interest`)는 1시간 [가정]마다 다시 센다. 찜 쓰기마다 판을 올리지 않는다(오픈 순간 찜이 몰릴 때 한 줄 판에 쓰기가 몰리지 않게).
4. **검색은 후보만 읽는다(COV2-07).** `DrizzleSearchIndex`는 `search_term`에서 앞부분(`LIKE '…%'`, 이스케이프, `text_pattern_ops`)과 두 음절 이상 입력의 중간 일치(훑기)로 후보 이름 줄을 찾고(data.md '공연 검색' 줄), 그 후보에만 `matchGrade`로 등급을 다시 매긴 뒤 `search_document`에서 그 공연들을 읽어 ADR-0268 결정 3의 순위·필터·쪽 규칙을 쓴다. 검색어가 없는 목록·관련 공연·인기 대체는 `search_document`의 정렬 쿼리로 읽는다. 등급 규칙은 메모리 어댑터와 같은 TS 함수 하나다(두 어댑터가 갈라져 COV2-02 같은 어긋남이 다시 생기지 않게).
5. **검색 전용 연결 묶음**: 검색 질의는 파드마다 따로 만든 연결 묶음(연결 10개, 대기 100ms, 질의 시간 상한 300ms [가정], features/search.md §7.2)을 쓴다. 연결을 못 받거나 시간을 넘으면 503(openapi `ServiceUnavailable`, `Retry-After`)과 `cache-control: no-store`를 내고(CDN이 `stale-if-error`로 직전 응답을 낸다), 보안 사건 줄 `search_pool_saturated`를 남긴다(catalog-review 16.3.3). 운영에서는 읽기 전용 복제본 주소를 쓰고, 로컬·시험은 같은 DB를 쓴다.
6. **자동완성 사전은 증분 갱신한다.** 10초 [가정]마다 한 읽기 전용 트랜잭션(`REPEATABLE READ`)에서 판을 먼저 읽고, 바뀌었으면 `updated_version > 지난 판`인 `search_term`·`search_document` 줄과 `version > 지난 판`인 지운 표시를 읽어 판 순서대로, 같은 판 안에서는 지운 표시를 먼저 반영한다(data.md '자동완성 사전 증분 갱신' 줄). 처음 뜰 때, 판이 1,000 [가정] 넘게 뛰었을 때, 마지막 갱신이 1시간 [가정]보다 오래됐을 때만 통째로 읽는다. 사전 구조는 §4.4(낱자 키 정렬 배열의 이분 탐색, 음절 두 글자 조각 역색인)이고 한 요청이 사전 전체를 훑지 않는다. 게이지 `search_dictionary_version_lag_seconds`·`search_dictionary_entries`·`search_dictionary_drift_entries`를 낸다(§10).
7. **로그 줄과 가리기**: 검색 원본은 `search_query`(가린 정규화 검색어 50자 이하, 결과 수, 필터 종류, 쪽, 소요 ms), `search_suggest`(입력 길이, 후보 수, 사전 판), `search_removed`(공연 ID, 이유, 판, CDN 무효화 요청 ID)를 남긴다. 가리기는 순수 함수 `maskSearchQuery`(§11 규칙)이고, 0건 목록은 순수 함수 `zeroResultQueries`(한 주, 서로 다른 줄 5번 [가정] 이상, 상위 50)로 모은다. 로그 저장소에서 주마다 읽어 운영자에게 보이는 연결은 관측 단계 몫이다.
8. **CDN 검색 경로 무효화**는 `CdnInvalidation` 포트에 경로 무효화(`/v1/search*`)를 더해 부른다. 공연 태그 무효화(`production:{id}`)와 같은 포트이고 개발 어댑터는 기록만 한다. 경로 무효화는 CDN이 준 무효화 요청 ID(CloudFront `CreateInvalidation` 응답의 `Invalidation.Id`)를 돌려주고, `search_removed` 줄의 `invalidationRequestId` 칸에 싣는다. 감사 기록과 CDN 쪽 무효화를 맞춰 보는 열쇠다(features/search.md §10). 개발·메모리 어댑터는 겹치지 않는 가짜 ID를 돌려준다. 무효화가 실패하면 그 칸은 null이고 `cdn_invalidation_failed` 경고를 남긴다(추천 적용, 2026-11-16, 시험 뒤 정함).
9. **DB 문자 분류 점검**: 새 마이그레이션의 첫 문장이 지금 DB의 문자 분류(`pg_database.datctype`, `current_database()`의 줄)가 `C`·`POSIX`면 오류로 멈춘다(SR-T7, features/search.md §2.2 'DB 설정'). PostgreSQL 16부터 읽기 전용 설정 값 `lc_ctype`이 없어졌으므로(PostgreSQL 16 출시 노트, DB마다 다를 수 있어서) `current_setting('lc_ctype')`로 보지 않는다(2026-11-16 시험 뒤 바로잡음).
10. **원본의 캐시 기만 방지(catalog-review 14.2.5의 원본 몫)**: `/v1/search` 아래 정의 밖 경로(`/v1/search/x.css` 등)는 404와 `cache-control: no-store`이고, 공개 캐시 머리는 200 JSON 응답에만 단다. `Set-Cookie`를 싣지 않는다. CDN의 경로별 캐시 정책 표는 HOT-450 몫이다.
11. **브라우저 거르기 함수**(§4.5, 지금 `apps/web` `refineLocally`·`inputKind`)는 `packages/search-normalize`로 옮기고 웹이 다시 내보낸다. 골든 세트(SR-T12)가 서버 쪽에서 같은 함수를 거쳐 순서 경우를 보기 때문이다.

## 결과

- 검색 한 번은 후보 이름 줄과 그 공연 줄만 읽는다. 중간 일치는 `search_term`을 훑으므로, NFR-028을 넘으면 정본대로 pg_bigm GIN 인덱스를 먼저 넣는다(ADR-0086).
- 쓰기 쪽은 판매 승인·포스터·정리 작업 세 자리에서 동기화를 부른다. 나중 단계(LCH-090·GAT-110·운영자 다른 이름)가 부르는 것을 잊지 않도록 SR-T8 ③을 그 묶음 범위에 넣었다.
- 판 한 줄에 쓰기가 모인다. 카탈로그 쓰기는 파트너·운영 업무라 드물고, 찜은 판을 올리지 않으므로 [가정] 괜찮다. 측정(SR-T13)에서 판 잠금 대기가 보이면 다시 본다.
- 표와 원천 뷰가 함께 있어 마이그레이션이 하나 는다. 뷰는 동기화의 계산 원천이고 질의가 직접 읽지 않는다.

## 되돌릴 조건

- 동기화 누락이 어긋남 시험에서나 운영에서 한 번이라도 잡히면, 부르는 자리 목록 대신 DB 트리거로 판 올리기와 지운 표시를 강제하는 방법을 견준다.
- SR-T13에서 검색 원본 p95가 300ms [가정]를 넘고 쿼리·인덱스(pg_bigm 포함) 조정으로 안 풀리면 features/search.md §7.1의 바꿀 조건 ④대로 OpenSearch 비교 측정을 한다(ADR-0094 결정 4).

## 확인

- BAT-165 웨이브 7 계획: docs/review/plans/BAT-165.md '웨이브 7 계획(2026-11-16)'.
