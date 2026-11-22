# 완성 장부: search

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 `docs/review/ledger-notes.md`). 원천: `docs/features/search.md`. 전체 개수와 이 도구의 한계는 `docs/review/ledger/README.md`에 있다.

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B | 19 | 0 | 2 | 0 | 1 | 1 | 0 | 0 | 0 | 23 |
| 합계 | 19 | 0 | 2 | 0 | 1 | 1 | 0 | 0 | 0 | 23 |

## docs/features/search.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| SR-T1 | — | 정규화가 브라우저와 서버에서 같다(전각, 대소문자, 제로폭·한글 채움… | 정규화가 브라우저와 서버에서 같다(전각, 대소문자, 제로폭·한글 채움 문자, 연속 공백). 호환 자모 입력 'ㄹ'·'ㄹㅁ'·'ㄳ'과 반각 'ﾡ'이 호환… | 자동 시험 | B | 시험: packages/search-normalize/test/normalize.test.ts |
| SR-T2 | — | 조합 중 글자: '루', '룸', '루메', '루멘'이 모두 '루멘'… | 조합 중 글자: '루', '룸', '루메', '루멘'이 모두 '루멘' 후보를 낸다 | 자동 시험 | B | 시험: packages/search-normalize/test/normalize.test.ts, services/core-svc/test/search.http.test.ts |
| SR-T3 | ① | ① 초성만 판정: 'ㄹㅁ'·'ㄱㅅ'·겹자음 'ㄳ'(→ 'ㄱㅅ')은… | ① 초성만 판정: 'ㄹㅁ'·'ㄱㅅ'·겹자음 'ㄳ'(→ 'ㄱㅅ')은 초성으로, 'ㄹㅏ'·'ㅏ'·'루ㅁ'은 초성이 아닌 것으로 본다. | 자동 시험 | B | 시험: packages/search-normalize/test/normalize.test.ts |
| SR-T3 | ② | ① 초성만 판정: 'ㄹㅁ'·'ㄱㅅ'·겹자음 'ㄳ'(→ 'ㄱㅅ')은… | ② 초성 'ㄹㅁ'과 겹받침·겹모음이 든 이름(예: '값', '과')이 맞고, 낱자만 친 'ㄹ'이 '루멘' 후보를 낸다 | 자동 시험 | B | 시험: packages/search-normalize/test/normalize.test.ts |
| SR-T4 | — | 'fnaps'는 0건 뒤 '루멘'으로 바꿔 찾고 알린다… | 'fnaps'는 0건 뒤 '루멘'으로 바꿔 찾고 알린다. 'LUMEN'은 바꾸지 않는다. 변환 값을 만들 수 없는… | 자동 시험 | B | 시험: packages/search-normalize/test/normalize.test.ts, services/core-svc/test-int/search-bat166.int.test.ts 외 5곳 |
| SR-T5 | — | 다른 이름('올림픽체조경기장', 'LUMEN')으로 맞고, 일치 위치가… | 다른 이름('올림픽체조경기장', 'LUMEN')으로 맞고, 일치 위치가 §4.2대로다 | 자동 시험 | B | 시험: services/core-svc/test/search.http.test.ts |
| SR-T6 | — | `%`·`_`·`\\` 입력이 글자 그대로 비교되고 전체 일치나 오류가… | `%`·`_`·`\\` 입력이 글자 그대로 비교되고 전체 일치나 오류가 나지 않는다 | 자동 시험 | B | 시험: services/core-svc/test-int/search-read-model.int.test.ts, services/core-svc/test/search.http.test.ts |
| SR-T7 | — | DB 문자 분류 설정이 C·POSIX가 아니고, 조각 비교 확장을… | DB 문자 분류 설정이 C·POSIX가 아니고, 조각 비교 확장을 넣으면 `show_trgm`·`show_bigm('루멘')`이 비지 않는다 | 자동 시험 | B | 시험: services/core-svc/test-int/search-read-model.int.test.ts |
| SR-T8 | ① | ① 승인 전·반려·판매 중지·회차 전부 취소 공연은 없다. ② 승인… | ① 승인 전·반려·판매 중지·회차 전부 취소 공연은 없다. | 자동 시험 | B | 시험: services/core-svc/test-int/search-read-model.int.test.ts |
| SR-T8 | ② | ① 승인 전·반려·판매 중지·회차 전부 취소 공연은 없다. ② 승인… | ② 승인 취소(판매 중지, ADR-0123)를 적는 트랜잭션이 읽기 모델을 함께 고쳐 커밋과 함께 빠지고(되돌리면 남는다), 판매 재개하면 다시 나온다. … 의… | 자동 시험 | B | 시험: services/core-svc/test-int/search-read-model.int.test.ts |
| SR-T8 | ③ | ① 승인 전·반려·판매 중지·회차 전부 취소 공연은 없다. ② 승인… | ③ 판매 중지·회차 전부 취소 처리(BUILD_ORDER LCH-090·GAT-110)가 | 자동 시험 | B | 시험: services/core-svc/test-int/sale-suspension.int.test.ts, services/core-svc/test-int/search-read-model.int.test.ts |
| SR-T9 | — | 같은 점수 공연 30개로 1·2쪽에 중복·누락이 없다. `limit`… | 같은 점수 공연 30개로 1·2쪽에 중복·누락이 없다. `limit` 20 밖과 `page × 20 > 1,000`은 400이다 | 자동 시험 | B | 시험: services/core-svc/test/search.http.test.ts, services/core-svc/test/search.test.ts |
| SR-T10 | — | `isComposing`이 참이거나 `keyCode` 229인… | `isComposing`이 참이거나 `keyCode` 229인 Enter가 검색을 보내지 않는다 | 자동 시험 | B | 시험: tools/web-checks/ds/behavior.spec.mjs |
| SR-T11 | ① | ① 순서·대소문자가 다른 같은 검색이 같은 요청 주소가 된다. ②… | ① 순서·대소문자가 다른 같은 검색이 같은 요청 주소가 된다. | 자동 시험 | B | 시험: apps/web/src/widgets/app-shell/model/autocomplete.test.mjs |
| SR-T11 | ② | ① 순서·대소문자가 다른 같은 검색이 같은 요청 주소가 된다. ②… | ② CDN 캐시 정책이 쿠키를 키에서 뺀다(BUILD_ORDER HOT-450, 세부 나눔 추천 적용, 2026-11-16) | 다른 단계 | B | HOT-450 · CloudFront 캐시 정책이 쿠키를 키에서 빼는지는 배포 구성 검사다. 입구 CDN 배포(HOT-450, 묶음 BAT-070) 몫이고 BAT-165 범위에서 뺐다(2026-11-16) |
| SR-T12 | — | 골든 세트(검색어 100개 [가정], §3·§5의 모든 경우)의… | 골든 세트(검색어 100개 [가정], §3·§5의 모든 경우)의 정답률이 NFR-028을 넘는다. 입력을 한 글자씩 늘려 가는 순서 경우도 넣고, 이 경우는… | 자동 시험 | B | 시험: apps/web/src/widgets/app-shell/model/autocomplete.test.mjs, packages/search-normalize/test/refine.test.ts 외 2곳 |
| SR-T13 | ① | ① 오픈 직전 몰림과 무작위 입력에서 원본 p95와 검색 전용 연결… | ① 오픈 직전 몰림과 무작위 입력에서 원본 p95와 검색 전용 연결 묶음 대기가 목표 안이고, 묶음이 넘치면 503이다. 측정 판정(추천 적용… | 측정 | B | BAT-167 · 오픈 직전 몰림·무작위 입력에서 검색·자동완성 원본 p95와 검색 전용 연결 묶음 대기·503을 로컬 k6로 잰다(ADR-0271 결정 5, 계획… |
| SR-T13 | ② | ① 오픈 직전 몰림과 무작위 입력에서 원본 p95와 검색 전용 연결… | ② gw-fan의 IP별 요청 한도가 목표 안이다(BUILD_ORDER HOT-400, 세부 나눔 추천 적용, 2026-11-16). 측정 판정(추천 적용… | 측정 | B | BAT-056 · BAT-056 측정 창에서 gw-fan 검색 IP 한도를 클러스터 안 k6로 잼(2026-11-18, 성능 장부 `2026-11-18-bat056-ms-ip-single`·`-many`·-mixe… |
| SR-T14 | — | `/search` 셸에 noindex가 있고 sitemap에 없다… | `/search` 셸에 noindex가 있고 sitemap에 없다. 출시 전에는 다른 화면도 전역 색인 제외이므로, `/search`의 값이 전역 값이 아니라… | 자동 시험 | B | 시험: tools/web-checks/budgets/seo.spec.mjs |
| SR-T15 | ① | ① 판이 바뀌면 10초 [가정] 안에 사전에 반영된다. 판매 승인… | ① 판이 바뀌면 10초 [가정] 안에 사전에 반영된다. 판매 승인 취소·회차 전부 취소로 빠진 공연과 지운 다른 이름이, 통째로 읽기 없이 증분 갱신 한 번… | 자동 시험 | B | 시험: services/core-svc/test/search-dictionary.test.ts, services/core-svc/test/search.http.test.ts |
| SR-T15 | ② | ① 판이 바뀌면 10초 [가정] 안에 사전에 반영된다. 판매 승인… | ② 판은 새것이고 줄은 옛것인 복제본 지연을 흉내 내도(판과 줄을 다른 연결로 읽게 만든 판) 같은 트랜잭션 규칙을 지키는 판은 빠짐이 없고, 로컬… | 자동 시험 | B | 시험: services/core-svc/test-int/search-read-model.int.test.ts, services/core-svc/test-int/search-standby.int.test.ts |
| SR-T15 | ③ | ① 판이 바뀌면 10초 [가정] 안에 사전에 반영된다. 판매 승인… | ③ Aurora 읽기 전용 복제본에서 `REPEATABLE READ` 읽기 전용 트랜잭션이 되는지 본다(기술 검토 중간-089. AWS 계정이 생긴 뒤, 세부… | 미검증 | B | AWS 계정 뒤(OPEN 후보) · Aurora 읽기 전용 복제본에서 `REPEATABLE READ` 읽기 전용 트랜잭션이 되는지는 AWS 계정과 클러스터 비용이 있어야 본다(소유자 자원 한도). 대역은… |
| SR-T17 | — | 검색어 가리기와 0건 목록의 최소 빈도(추천 적용 2026-10-28… | 검색어 가리기와 0건 목록의 최소 빈도(추천 적용 2026-10-28, 기술 검토 낮음-173): `010-1234-5678`·`01012345678`·a@b… | 자동 시험 | B | 시험: services/core-svc/test/search-log.test.ts, services/core-svc/test/search.http.test.ts |
