# 완성 장부: search

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 `docs/review/ledger-notes.md`). 원천: `docs/features/search.md`. 전체 개수와 이 도구의 한계는 `docs/review/ledger/README.md`에 있다.

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B | 9 | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 5 | 17 |
| 합계 | 9 | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 5 | 17 |

## docs/features/search.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| SR-T1 | — | 정규화가 브라우저와 서버에서 같다(전각, 대소문자, 제로폭·한글 채움… | 정규화가 브라우저와 서버에서 같다(전각, 대소문자, 제로폭·한글 채움 문자, 연속 공백). 호환 자모 입력 'ㄹ'·'ㄹㅁ'·'ㄳ'과 반각 'ﾡ'이 호환… | 자동 시험 | B | 시험: packages/search-normalize/test/normalize.test.ts |
| SR-T2 | — | 조합 중 글자: '루', '룸', '루메', '루멘'이 모두 '루멘'… | 조합 중 글자: '루', '룸', '루메', '루멘'이 모두 '루멘' 후보를 낸다 | 자동 시험 | B | 시험: packages/search-normalize/test/normalize.test.ts, services/core-svc/test/search.http.test.ts |
| SR-T3 | ① | ① 초성만 판정: 'ㄹㅁ'·'ㄱㅅ'·겹자음 'ㄳ'(→ 'ㄱㅅ')은… | ① 초성만 판정: 'ㄹㅁ'·'ㄱㅅ'·겹자음 'ㄳ'(→ 'ㄱㅅ')은 초성으로, 'ㄹㅏ'·'ㅏ'·'루ㅁ'은 초성이 아닌 것으로 본다. | 자동 시험 | B | 시험: packages/search-normalize/test/normalize.test.ts |
| SR-T3 | ② | ① 초성만 판정: 'ㄹㅁ'·'ㄱㅅ'·겹자음 'ㄳ'(→ 'ㄱㅅ')은… | ② 초성 'ㄹㅁ'과 겹받침·겹모음이 든 이름(예: '값', '과')이 맞고, 낱자만 친 'ㄹ'이 '루멘' 후보를 낸다 | 자동 시험 | B | 시험: packages/search-normalize/test/normalize.test.ts |
| SR-T4 | — | 'fnaps'는 0건 뒤 '루멘'으로 바꿔 찾고 알린다… | 'fnaps'는 0건 뒤 '루멘'으로 바꿔 찾고 알린다. 'LUMEN'은 바꾸지 않는다 | 자동 시험 | B | 시험: services/core-svc/test/search.http.test.ts, services/core-svc/test/search.test.ts |
| SR-T5 | — | 다른 이름('올림픽체조경기장', 'LUMEN')으로 맞고, 일치 위치가… | 다른 이름('올림픽체조경기장', 'LUMEN')으로 맞고, 일치 위치가 §4.2대로다 | 자동 시험 | B | 시험: services/core-svc/test/search.http.test.ts |
| SR-T6 | — | `%`·`_`·`\\` 입력이 글자 그대로 비교되고 전체 일치나 오류가… | `%`·`_`·`\\` 입력이 글자 그대로 비교되고 전체 일치나 오류가 나지 않는다 | 자동 시험 | B | 시험: services/core-svc/test/search.http.test.ts |
| SR-T7 | — | DB 문자 분류 설정이 C·POSIX가 아니고, 조각 비교 확장을… | DB 문자 분류 설정이 C·POSIX가 아니고, 조각 비교 확장을 넣으면 `show_trgm`·`show_bigm('루멘')`이 비지 않는다 | 빈칸 | B | — |
| SR-T8 | — | 승인 전·반려·판매 중지·회차 전부 취소 공연은 없다. 승인 취소(판매… | 승인 전·반려·판매 중지·회차 전부 취소 공연은 없다. 승인 취소(판매 중지, ADR-0123)는 같은 트랜잭션으로 빠지고 CDN 무효화를 부르며, 판매… | 빈칸 | B | — |
| SR-T9 | — | 같은 점수 공연 30개로 1·2쪽에 중복·누락이 없다. `limit`… | 같은 점수 공연 30개로 1·2쪽에 중복·누락이 없다. `limit` 20 밖과 `page × 20 > 1,000`은 400이다 | 자동 시험 | B | 시험: services/core-svc/test/search.http.test.ts, services/core-svc/test/search.test.ts |
| SR-T10 | — | `isComposing`이 참이거나 `keyCode` 229인… | `isComposing`이 참이거나 `keyCode` 229인 Enter가 검색을 보내지 않는다 | 사람 확인 | B | BAT-165 browser check · 한글 조합 중 Enter·Esc를 처리하지 않는 것은 실제 브라우저 입력기로 확인한다. 코드는 `isComposing`·`keyCode 229`를… |
| SR-T11 | — | 순서·대소문자가 다른 같은 검색이 같은 요청 주소가 된다. CDN 캐시… | 순서·대소문자가 다른 같은 검색이 같은 요청 주소가 된다. CDN 캐시 정책이 쿠키를 키에서 뺀다 | 자동 시험 | B | 시험: apps/web/src/widgets/app-shell/model/autocomplete.test.mjs, services/core-svc/test/search.http.test.ts 외 1곳 |
| SR-T12 | — | 골든 세트(검색어 100개 [가정], §3·§5의 모든 경우)의… | 골든 세트(검색어 100개 [가정], §3·§5의 모든 경우)의 정답률이 NFR-028을 넘는다. 입력을 한 글자씩 늘려 가는 순서 경우도 넣고, 이 경우는… | 빈칸 | B | — |
| SR-T13 | — | 오픈 직전 몰림과 무작위 입력에서 원본 p95, 연결 묶음 대기, 요청… | 오픈 직전 몰림과 무작위 입력에서 원본 p95, 연결 묶음 대기, 요청 한도가 목표 안이다 | 측정 | B | BAT-165 heavy gate · 오픈 직전 몰림·무작위 입력에서 검색 p95, 검색 전용 연결 묶음 포화, 요청 한도는 k6 시나리오 몫이다. 1차 단위 시험은 순위·쪽만 본다 |
| SR-T14 | — | `/search` 셸에 noindex가 있고 sitemap에 없다 | `/search` 셸에 noindex가 있고 sitemap에 없다 | 사람 확인 | B | BAT-165 browser check · `/search`의 noindex·sitemap 제외는 브라우저 확인과 화면 머리 검사로 본다. 화면 주석과 metadata는 `SearchPage`에 있다 |
| SR-T15 | — | 판이 바뀌면 10초 [가정] 안에 사전에 반영된다. 판매 승인… | 판이 바뀌면 10초 [가정] 안에 사전에 반영된다. 판매 승인 취소·회차 전부 취소로 빠진 공연과 지운 다른 이름이, 통째로 읽기 없이 증분 갱신 한 번 안에… | 빈칸 | B | — |
| SR-T17 | — | 검색어 가리기와 0건 목록의 최소 빈도(추천 적용 2026-10-28… | 검색어 가리기와 0건 목록의 최소 빈도(추천 적용 2026-10-28, 기술 검토 낮음-173): `010-1234-5678`·`01012345678`·a@b… | 빈칸 | B | — |
