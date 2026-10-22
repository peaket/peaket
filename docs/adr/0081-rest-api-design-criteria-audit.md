# ADR-0081: REST 설계 기준을 API 규칙으로 들이고, 기준에 어긋난 경로 64개 작업을 바꾼다 — 명사 경로, 복수 컬렉션, 2단계 깊이, 한 오류 형식(2026-10-21)

- **상태**: 채택 (2026-10-21. 소유자가 REST API 설계 기준 노트를 보이며 "지금 이 프로젝트가 이 기준에 걸맞는지 봐주시고 아니면 개선해주세요"라고 요청했다. 기준을 API 규칙으로 들이는 것은 소유자 요청이고, 경로 이름과 기준과 다르게 정한 부분은 추천 적용이다. 추천 적용 목록은 아래 '소유자 검토 대상'에 모았다)
- **관련**: ADR-0008(게이트웨이 분리), ADR-0011(토큰), ADR-0041·0058(대기열 결과 파일), ADR-0060(다른 기기에서 다시 참가), ADR-0063(검색 페이지 번호), ADR-0064(판매 종료 410), ADR-0065(웹 보안 헤더·쿠키), ADR-0066(좌석맵 템플릿), ADR-0079(프론트엔드 상세 설계, wbs 0.2.3), docs/api/guidelines.md §2·§3·§10~§12

## 맥락

- **소유자가 준 기준(요약)**
  - URI는 행동이 아니라 자원을 가리키고 명사를 쓴다(`/getUsers`, `/createOrder`는 안티패턴·터널링). 자원 이름은 복수형이다.
  - 관계는 계층 경로로 나타내되 깊이는 웬만하면 2단계까지, 3단계는 가지 않는다(`/users/{userId}/orders/{orderId}`가 2단계). 끝 슬래시는 혼란을 주므로 일관되게 한다. 여러 단어는 하이픈으로 잇고 밑줄은 쓰지 않는다.
  - 큰 목록은 페이지로 나누고 클라이언트가 필요한 페이지를 요청할 수 있게 한다(`?page=2&limit=50`, offset·count 방식 예).
  - 검색은 GET과 쿼리 문자열이다. 조건이 페이지 파라미터와 섞여 헷갈리면 `q`로 묶는다(`?q=name%3Dcho.region%3Dseoul`). 전역 검색 `/search?q=`, 지역 검색 `/users?q=`.
  - 부분 응답(`?fields=`)은 종종 유용하다. HATEOAS는 좋지만 의존성 때문에 바꾸기 어렵다.
  - 조회에 성공했는데 데이터가 없으면 404가 아니라 200이다.
  - 오류는 표준 JSON 형식으로 원인을 알리고 상태 코드와 메시지가 일관돼야 한다. 스택은 응답에 넣지 않고 개발·QA 환경에서만 로그 레벨 옵션으로 낸다.
  - 안티패턴: GET·POST 터널링, 자기 서술성(이해하기 쉬움) 부족, 상태 코드 오용.
- **점검 결과(2026-10-21, openapi 경로 165·작업 180)**
  - 지킨 것: 경로 단어는 모두 소문자·하이픈이고 밑줄과 끝 슬래시가 없었다. 오류 형식은 RFC 9457로 정해져 있었고 스택을 응답에 넣지 않는 규칙이 있었다. 상태를 바꾸는 GET은 없었다. 목록 대부분이 커서로 나뉘었고 빈 목록은 200이었다. 전역 검색 `GET /v1/search`가 있었다.
  - 어긋난 것
    - 동사이거나 동사로 읽히는 끝 단어: 37개 경로(`approve`, `reject`, `accept`, `withdraw`, `extend`, `revert`, `resend`, `confirm`, `complete`, `pause`, `resume`, `revoke`, `start`, `refresh`, `login`, `preverify`, `suggest`, `separate`, `import`, `export`, `return`, `lookup`).
    - ID 앞의 단수 이름: `/v1/queue/{eventId}`(11개 경로), `/v1/identity/verification/{verificationId}`, `state/{segment}`, `shuffle/{hashPrefix}`, `batch/{hashPrefix}`, `seatmap/layout/{layoutVersion}`.
    - 3단계 이상: 14개 경로(`/v1/events/{eventId}/seatmap/snapshot`, `/v1/partner/events/{eventId}/staff/{assignmentId}/resend` 등).
    - 컬렉션 바로 뒤 ID 자리의 고정 단어: 10곳(예: `transfers/recipient-lookup`, `reviews/images`, `staff-invitations/lookup`·`accept`, `device-approvals/lookup`, `reviews/summary`).
    - 컬렉션에 보내는 DELETE로 '내 항목'을 지움: 로비 참가 취소, 대기 취소.
    - 근무 정보 읽기와 준비 완료 보고를 한 POST에 섞음: `POST /v1/scanner/shift`.
    - 한 페이지 건수 이름이 `limit`과 `size`로 갈림(검색·문의). 커서 없는 큰 목록 5개(마이 티켓, 굿즈 상품, 미수금, 스캐너 기기, 스캐너 이상 표시).
    - 오류 응답 242개 가운데 Problem 본문을 선언한 것은 6개였다. 401에 `WWW-Authenticate`(RFC 9110 §15.5.2 MUST)가 없었고 429·503에 `Retry-After`가 선언되지 않았다. 매진 엣지 응답(410)은 Problem이 아니었고, 게이트웨이가 직접 내는 오류의 형식은 정해지지 않았다. 좌석맵 저장 422는 Problem이 아닌 본문이었다.
    - 201 응답 38개에 `Location`이 하나도 없었다(그중 GET으로 다시 읽을 수 있는 자원은 양도 요청·후기·문의 셋).
    - 끝 슬래시·디버그 정보·검색 파라미터·부분 응답·하이퍼미디어 규칙이 문서에 없었다. NestJS 기본 HTTP 어댑터(Express)는 `/users`와 `/users/`를 같은 경로로 받는다.
- **확인한 외부 사실(2026-10-21, 원문)**
  - RFC 9110: §9.2.1(GET·HEAD·OPTIONS·TRACE가 안전), §9.2.2(PUT·DELETE와 안전한 메서드가 멱등), §15.3.2(201의 새 자원은 `Location`이나, 없으면 요청 URI가 가리킨다), §15.5.2(401은 `WWW-Authenticate`를 MUST), §15.5.4(존재를 숨기려면 403 대신 404), §15.5.6(405는 `Allow`를 MUST), §15.5.11(410은 영구에 가깝고 휴리스틱 캐시 대상), §4.2.3(정규화하면 같아지는 URI로 다른 자원을 가리키지 않는다).
  - RFC 3986은 `/users`와 `/users/`를 같다고 보지 않는다(같게 보는 것은 빈 경로와 `/`뿐, §6.2.3).
  - RFC 9457: `type`을 열면 설명 문서가 SHOULD(§3.1.1), `title`은 번역 말고는 바꾸지 않는다(§3.1.3), 스택 덤프 같은 구현 세부를 내보내지 않도록 권한다(§5).
  - OpenAPI 3.1.0 Reference Object는 `$ref` 옆의 `summary`·`description`이 참조 대상의 값을 덮어쓴다(그 밖의 속성은 무시).
  - Google AIP-122(컬렉션 이름과 ID를 번갈아), AIP-136(사용자 정의 메서드는 `:verb`), AIP-156(싱글턴은 단수), AIP-160(필터는 `filter` 문자열 하나). Zalando RESTful API 지침 [129] 케밥 경로, [130] 쿼리는 snake_case, [134] 복수형(싱글턴은 개수 1인 컬렉션, `self` 예외), [136] 끝 슬래시 금지, [141] 동사 없는 URL('취소 우편함'), [147] 하위 단계 3 이하 권장, [157] `fields`, [160] 커서 권장, [163] HATEOAS는 일반적으로 권하지 않음, [254] 전체 건수 피하기. Microsoft 웹 API 설계 지침('collection/item/collection'보다 복잡한 URI를 피하고 동사 대신 명사). Rails 라우팅 안내서 'Shallow Nesting'.
  - HTTP QUERY 메서드는 RFC 10008(2026-06, 안전·멱등)이다. CloudFront 캐시 동작이 고를 수 있는 메서드는 GET·HEAD, +OPTIONS, +PUT·PATCH·POST·DELETE 세 묶음뿐이다.
  - IANA HTTP 인증 방식 등록부에 쿠키 방식이 없다. RFC 6750의 Bearer 토큰 전달 방법은 헤더·폼 본문·쿼리 셋이고 쿠키가 없다. 쿠키 인증 초안(draft-broyer-http-cookie-auth)은 2009년에 만료됐다.
  - Fastify는 `routerOptions.ignoreTrailingSlash` 기본값이 false다(두 주소를 다르게 본다). Express 5는 strict 라우팅이 꺼진 것이 기본이고 NestJS 기본 어댑터가 Express다.
  - Envoy `local_reply_config`는 직접 만든 응답의 본문을 `json_format`과 `content_type`으로 바꿀 수 있다. CloudFront Functions는 만든 응답에 `body`를 실을 수 있다.
  - OWASP ASVS v5.0.0-13.4.2(운영 환경의 디버그 모드 끄기, L2), v5.0.0-16.5.1(예상 못 한 오류에 일반 문구, 스택·쿼리 없음, L2).
- **이 프로젝트의 사정**: API는 설계 단계 계약(`1.0.0-draft`)이고 배포된 클라이언트가 없다. 가짜 API로 도는 프로토타입(prototype/)만 이 경로를 부른다.

## 결정

1. **기준을 API 규칙으로 들인다(소유자 요청)**
   - docs/api/guidelines.md에 §10 URI 설계 규칙, §11 검색·부분 응답·하이퍼미디어, §12 메서드와 상태 코드를 새로 두고 §2 오류·§3 페이지를 보강한다. 이 ADR의 나머지 결정은 그 규칙을 이 API에 적용한 것이다.
2. **동작은 '그 동작이 남기는 기록'의 명사 하위 자원으로 쓴다(추천 적용)**
   - 승인 `approvals`, 거절 `rejections`·`rejection`, 수락 `acceptance`, 철회 `withdrawal`, 연장 `extension`·`extensions`, 되돌리기 `reversions`, 폐기 `revocation`, 완료 `completion`, 확인 `confirmation`·`post-review-confirmation`, 정지·재개 `pauses`·`resumptions`, 돌려주기 `returns`(Zalando [141]).
   - 여러 번 쌓일 수 있는 기록은 복수형, 부모마다 한 번만 생기는 결과는 단수형이다. 운영 승인 흐름(명령·승인 업무·회차 취소·판매 승인)은 승인·거절이 다시 생길 수 있어 복수형이고, 양도 요청의 수락·거절·철회는 한 번뿐이라 단수형이다.
   - 로그인은 세션 만들기(`auth/sessions`), 토큰 갱신은 액세스 토큰 만들기(`access-tokens`)다. 리프레시 쿠키의 `Path`도 새 경로로 바꾼다(`/v1/identity/access-tokens`, `/v1/partner/auth/access-tokens`).
   - 사용자 정의 메서드(`POST …:accept`, Google AIP-136)는 쓰지 않는다. 소유자 기준이 경로의 동사를 막기 때문이다.
3. **컬렉션은 복수형, 싱글턴은 단수형이고, 네임스페이스 바로 뒤에는 ID가 오지 않는다(추천 적용)**
   - `/v1/queue/{eventId}/…` → `/v1/queues/{eventId}/…`, `/v1/identity/verification/…` → `/v1/identity/verifications/…`, 결과 파일은 `segment-states`·`shuffle-results`·`batch-results`, 좌석맵 파일은 `seatmap-layouts`다.
   - 부모마다 하나뿐인 하위 자원은 단수 명사로 둔다(`seatmap`, `entry-policy`, `wish`, `admission`, `cancellation`, Google AIP-156). Zalando [134]처럼 개수 1인 컬렉션으로 바꾸지 않는다.
   - 네임스페이스는 `partner`·`ops`·`scanner`(호출 주체)와 `identity`·`shop`·`auth`·`compliance`·`webhooks`(모듈)뿐이고 깊이에 세지 않는다.
4. **깊이는 2단계로 줄인다(추천 적용)**
   - 하위 자원이 전역 ID를 가지면 목록·생성만 부모 아래 두고 단건 경로를 올린다(얕은 중첩): `/v1/partner/staff/{assignmentId}`, `/v1/scanner/flags/{flagId}/resolution`. 서버는 그 ID가 요청자의 파트너·회차 것인지 확인한다.
   - 두 단어를 하이픈으로 이어 한 단계로 만든다: `seatmap-snapshot`, `review-summary`, `review-eligibility`, `payment-acceptance`, `device-placements/{deviceId}`, `seatmap-imports`, `attendee-exports`.
5. **ID 자리에 고정 단어를 두지 않는다(추천 적용)**
   - 비밀값으로 찾는 조회와 수락은 위로 올린 하이픈 컬렉션이다: `/v1/transfer-recipient-lookups`, `/v1/staff-invitation-lookups`, `/v1/staff-invitation-acceptances`, `/v1/device-approval-lookups`, `/v1/review-images`(Google AIP-122).
6. **'내 항목'은 예약 ID `me`로 가리킨다(추천 적용)**
   - `DELETE /v1/queues/{eventId}/lobby-participants/me`, `DELETE /v1/queues/{eventId}/entries/me`. 처음 기기가 없어도 취소할 수 있어야 해서(ADR-0060) 대기표 ID를 요구하지 않는다. 로비 참가는 `POST /v1/queues/{eventId}/lobby-participants`다.
   - 알림 신청 끄기 `DELETE /v1/events/{eventId}/subscriptions?kind=`는 `kind`로 고른 내 신청만 지우는 필터 삭제라 그대로 둔다.
7. **읽기와 쓰기를 한 POST에 섞지 않는다(추천 적용)**
   - 스캐너 근무 준비를 `GET /v1/scanner/shift`(근무 정보, `no-store`)와 `PUT /v1/scanner/shift/readiness`(준비 완료 보고, 204)로 나눈다.
   - 비밀값으로 찾는 조회 셋은 POST로 둔다. URL에 비밀을 넣지 않는 규칙(guidelines §9) 때문이고, 본문을 싣는 안전한 메서드 QUERY(RFC 10008)는 CloudFront가 받지 않는다. 응답은 200과 `no-store`이고 상태를 바꾸지 않는다.
8. **같은 자원의 경로를 합친다(추천 적용)**
   - 템플릿에서 좌석맵 만들기는 `POST /v1/partner/events/{eventId}/seatmap`(201)이다. 같은 경로의 GET이 읽기, PUT이 통째 저장이다.
   - 예매자 명단 내보내기와 그 이력은 한 컬렉션이다: `POST`·`GET /v1/partner/events/{eventId}/attendee-exports`.
9. **페이지는 커서를 기본으로 두고 이름을 `limit` 하나로 맞춘다(추천 적용)**
   - 검색·문의의 `size`를 `limit`으로 바꾼다(응답 필드도). 마이 티켓, 굿즈 상품, 미수금, 스캐너 기기, 스캐너 이상 표시에 `cursor`·`limit`을 더한다. 나누지 않는 목록은 건수 상한이 정해진 것뿐이다(로그인 기기 5대, 로그인 수단 3종 등).
   - 소유자 기준은 페이지 번호·offset 방식을 예로 들지만 커서를 기본으로 둔다. 오프셋은 뒤 페이지로 갈수록 느려지고 새 행이 들어오면 중복·누락이 생긴다(Zalando [160]). 화면이 페이지 번호를 보여 주는 검색·문의만 페이지 번호 방식이다(ADR-0063·0066).
10. **검색 조건을 `q` 하나에 이어 붙이지 않는다(추천 적용)**
    - 자유 입력은 `q`, 조건은 필드 이름과 같은 파라미터다. 예약 이름 `q`·`cursor`·`limit`·`page`·`sort`·`fields`를 필터 이름으로 쓰지 않는 것으로 '조건과 페이지 파라미터가 섞이는' 문제를 푼다.
    - 이어 붙이는 형식을 쓰지 않는 이유: 공개 검색의 CDN 캐시 키가 갈리고, 필터별 스키마 검사를 쓸 수 없고, 값에 구분자가 들어갈 때의 이스케이프 규칙이 필요하다.
11. **부분 응답과 하이퍼미디어는 규칙만 정하고 켜지 않는다(추천 적용)**
    - `fields`(쉼표, 점 표기, 모르는 필드는 400, 권한 검사는 그대로)는 측정으로 응답 크기·조인 비용이 문제가 된 경로에만 켠다. CDN이 캐시하는 공개 읽기에는 쓰지 않는다.
    - 응답 속 링크는 넣지 않고 `Location`·`Retry-After`·`nextCursor`·`type` URI와 상태 필드로 다음 행동을 알린다(Zalando [163]).
12. **오류 본문은 어디서 나든 Problem 하나다(추천 적용)**
    - openapi의 4xx·5xx 응답 244개 가운데 243개가 Problem을 선언한다(`$ref`와 `description` 덮어쓰기). 나머지 1개는 기기 승인 토큰 엔드포인트의 400(RFC 8628의 OAuth 오류, 새 스키마 `OAuthError`)이다.
    - 게이트웨이가 직접 내는 오류는 Envoy `local_reply_config`, API 경로의 매진 410은 CloudFront Function이 Problem 본문(`type` `sold-out`)으로 낸다. 정적 파일 배포의 404만 본문을 약속하지 않는다.
    - 좌석맵 저장의 422는 Problem(`type` `seatmap-invalid`)의 확장 필드 `result`에 검증 결과를 싣는다.
    - 한 `type`은 언제나 같은 상태 코드와 같은 `title`이다. 점검에서 이름 있는 `type`은 모두 상태 코드가 하나였다. 전체 목록과 이름 없는 오류의 이름은 wbs 0.2.3에서 정한다.
13. **스택과 디버그 정보는 로컬·CI에서만 낸다(추천 적용)**
    - Problem의 `debug` 확장 필드는 `PEAKET_DEBUG_ERRORS=true`인 로컬·CI(kind)에서만 싣는다. 데모·스테이징·운영 설정에서 켜면 서비스가 시작하지 않는다(ASVS v5.0.0-13.4.2·16.5.1).
    - 소유자 기준은 QA 환경에서 켜는 것을 허용하지만 데모에서는 켜지 않는다. 데모는 운영과 같은 다이제스트를 검증하는 곳이고 임시 클라우드 데모로 외부에 열릴 수 있다.
14. **상태 코드와 헤더를 맞춘다(추천 적용)**
    - 201은 만든 자원을 GET으로 읽을 수 있으면 `Location`을 준다(양도 요청·후기·문의). 본인확인 시작 두 경로는 본인확인 건을 만들므로 200에서 201로 바꾼다.
    - 429·503 응답은 `Retry-After`를 선언한다(19개). 401은 `WWW-Authenticate`를 싣는다(16개): 스캐너 `Bearer realm="peaket-scanner"`(RFC 6750), 쿠키 경로 `Cookie realm="peaket"`, 입장 토큰 경로 `AdmissionToken realm="peaket"`. 쿠키·입장 토큰 방식은 등록된 이름이 없어 프로젝트 이름을 쓴다. Bearer라고 쓰면 RFC 6750에 없는 전달 방법을 Bearer라고 부르게 되기 때문이다.
    - 개인·거래 기록(양도 요청·문의·정산서)은 남의 것이면 404로 존재를 숨기고, 공개된 공연·회차의 하위 자원은 403이다.
15. **끝 슬래시는 404이고 리다이렉트하지 않는다(추천 적용)**
    - Fastify 서비스는 기본값을 두고, Express 어댑터 서비스는 strict 라우팅을 켠다. 빈 단계(`//`)도 받지 않는다.
16. **제자리에서 바꾸고 옛 경로를 남기지 않는다(추천 적용)**
    - 배포된 클라이언트가 없는 설계 계약이라 `v1` 안에서 바꾸고 `Deprecation`·`Sunset` 병행 기간을 두지 않는다. 운영에 나간 뒤의 경로 변경은 guidelines §1(새 메이저 버전, 파트너 공개 API는 90일 병행)을 따른다.
    - 프로토타입의 화면 호출과 가짜 API를 새 경로로 바꾼다. ADR 본문과 검토 기록(review/)의 옛 경로는 이력이라 고치지 않고 아래 대응표로 읽는다.

## 검토한 대안

| 대안 | 판단 |
| --- | --- |
| 동작을 동사 경로(컨트롤러 자원)로 두기(`POST …/approve`) | 기각. 소유자 기준이 경로의 동사를 막는다. 같은 일을 하는 경로가 늘어나기 쉽다 |
| Google AIP-136 사용자 정의 메서드(`POST …:approve`) | 기각. 동사가 경로에 남는다. 콜론 경로는 CDN·게이트웨이 경로 규칙과 문서에서 낯설다 |
| 상태 필드 PATCH(`PATCH /transfers/{id}` + `status`) | 기각. 전이마다 권한·재인증·멱등키·감사 기록이 다른데 한 PATCH에 섞으면 보안 추적 표의 권한 행이 흐려진다 |
| 모든 전이를 복수형으로(`acceptances`) | 기각. 한 번뿐인 결과를 복수로 쓰면 '여러 개가 쌓인다'로 읽힌다. Zalando [134]의 '개수 1인 컬렉션'보다 Google AIP-156의 싱글턴을 따른다 |
| 옛 경로를 별칭으로 남기고 Sunset 90일 | 기각. 배포된 클라이언트가 없어 별칭은 경로 수와 시험만 늘린다 |
| 페이지 번호·offset을 기본으로 | 기각. 큰 목록에서 느려지고 중복·누락이 생긴다. 화면이 번호를 쓰는 두 목록만 예외 |
| 검색 조건을 `q`에 이어 붙이기 | 기각. CDN 캐시 키·필드별 검사·이스케이프 문제(결정 10) |
| `fields`를 모든 목록에 바로 켜기 | 기각. 측정된 필요가 없고 공개 읽기의 캐시를 쪼갠다 |
| HAL `_links`로 하이퍼미디어 | 기각. 클라이언트가 모두 생성한 우리 앱이고 응답이 커진다 |
| 비밀값 조회를 QUERY 메서드로 | 기각. CloudFront 캐시 동작이 QUERY를 받지 않는다 |
| 쿠키 경로 401에 Bearer challenge | 기각. RFC 6750의 전달 방법에 쿠키가 없어 뜻이 틀린다 |
| 끝 슬래시를 같은 자원으로 받기(정규화, Zalando [136] 권고) | 기각. 한 자원에 주소가 둘이면 CDN 캐시가 갈린다. 404로 한 주소만 둔다 |

## 결과와 트레이드오프

- **좋은 점**: 경로만 보고 무엇을 하는지 알 수 있고 예외는 이유와 함께 목록으로 고정했다. 오류 본문이 서비스·게이트웨이·엣지에서 하나다. 프로토타입이 새 경로로 동작하는 것을 확인했다(화면 호출 151개가 모두 가짜 API 경로와 맞고, 대기열 진입·취소, 사전 검증, 대기 상태 파일, 스캐너 근무 준비·준비 보고, 스태프 초대 재발송·해제, 마이 티켓을 브라우저에서 눌러 확인).
- **남는 한계**
  - 단수·복수는 '한 번뿐인가'로 판단하므로 경계 사례가 남는다(입장 확정 `admission`은 단수지만 차례가 올 때까지 여러 번 POST한다).
  - `Cookie`·`AdmissionToken`은 등록되지 않은 인증 방식 이름이다. 브라우저는 무시하므로 동작에는 영향이 없지만 표준 이름은 아니다.
  - `operationId`(0/181)와 전체 `type` 목록, 화면이 쓰는데 openapi에 없는 읽기 경로(공연 상세 `GET /v1/events/{eventId}` 등)는 이번에 하지 않았다(wbs 0.2.3).
  - 커서 방식은 원하는 페이지 번호로 바로 건너뛸 수 없다.
  - 디자인 캔버스 보드 안의 경로 글자는 이번에 보지 않았다.
  - ADR 본문과 review/ 기록의 옛 경로는 그대로다. 아래 대응표로 읽는다.
- **반영 수치(2026-10-21)**
  - REST 경로 165 → 166, 작업 180 → 181(근무 준비를 GET과 PUT으로 나눔, 템플릿 만들기·명단 내보내기 이력을 합침, 내 항목 삭제 `…/me` 둘). 바뀐 작업 64개(아래 표).
  - 오류 응답의 Problem 선언 6 → 243(나머지 1개는 OAuth 오류, 오류 응답 242 → 244), 401 `WWW-Authenticate` 0 → 16, 429·503 `Retry-After` 0 → 19, 201 `Location` 0 → 3, 커서 목록 +5.
  - ADR 80 → 81, 검토 기록 R-90. WBS 일정 그대로(wbs 0.2.3의 설명만 고침).

## 되돌릴 조건

- 외부에 여는 파트너 공개 API를 만들면 그 API는 처음부터 이 규칙을 따르고, 운영에 나간 뒤의 이름 변경은 새 메이저 버전과 병행 기간으로 한다.
- CloudFront가 QUERY 메서드를 받게 되면 비밀값 조회를 QUERY로 다시 본다.
- IANA에 쿠키 인증 방식이 등록되면 그 이름으로 바꾼다.
- 검색 조건을 AND·OR로 묶어야 하면 `filter` 문법(Google AIP-160)을 새 ADR로 정한다.
- 측정에서 응답 크기나 조인 비용이 문제가 되면 그 경로에 `fields`를 켠다.

## 소유자 검토 대상(추천 적용)

1. 페이지는 커서가 기본이고 페이지 번호는 검색·문의만(기준의 예는 페이지 번호·offset).
2. 검색 조건을 `q` 하나에 이어 붙이지 않음(기준이 권하는 형식).
3. 디버그 정보는 로컬·CI만, 데모에서도 끔(기준은 QA 환경 허용).
4. 쿠키 경로 401의 `WWW-Authenticate`에 등록되지 않은 이름 `Cookie`·`AdmissionToken`을 씀.
5. 한 번뿐인 결과는 단수형(`acceptance`), 쌓이는 기록은 복수형(`approvals`).
6. 옛 경로를 남기지 않고 제자리에서 바꿈.

## 옛 경로 대응표

| 옛 경로 | 새 경로 |
| --- | --- |
| `POST /v1/queue/{eventId}/lobby` | `POST /v1/queues/{eventId}/lobby-participants` |
| `DELETE /v1/queue/{eventId}/lobby` | `DELETE /v1/queues/{eventId}/lobby-participants/me` |
| `POST /v1/queue/{eventId}/preverify` | `POST /v1/queues/{eventId}/pre-verifications` |
| `POST /v1/queue/{eventId}/entries` | `POST /v1/queues/{eventId}/entries` |
| `DELETE /v1/queue/{eventId}/entries` | `DELETE /v1/queues/{eventId}/entries/me` |
| `GET /v1/queue/{eventId}/state/{segment}.json` | `GET /v1/queues/{eventId}/segment-states/{segment}.json` |
| `GET /v1/queue/{eventId}/shuffle/{hashPrefix}.json` | `GET /v1/queues/{eventId}/shuffle-results/{hashPrefix}.json` |
| `GET /v1/queue/{eventId}/batch/{hashPrefix}.json` | `GET /v1/queues/{eventId}/batch-results/{hashPrefix}.json` |
| `GET /v1/queue/{eventId}/shuffle-proof` | `GET /v1/queues/{eventId}/shuffle-proof` |
| `POST /v1/queue/{eventId}/admission` | `POST /v1/queues/{eventId}/admission` |
| `POST /v1/queue/{eventId}/verification` | `POST /v1/queues/{eventId}/verification` |
| `GET /v1/events/{eventId}/seatmap/snapshot` | `GET /v1/events/{eventId}/seatmap-snapshot` |
| `GET /v1/events/{eventId}/seatmap/layout/{layoutVersion}.json` | `GET /v1/events/{eventId}/seatmap-layouts/{layoutVersion}.json` |
| `POST /v1/holds/{holdId}/extend` | `POST /v1/holds/{holdId}/extension` |
| `POST /v1/orders/{orderId}/payments/accept` | `POST /v1/orders/{orderId}/payment-acceptance` |
| `POST /v1/transfers/recipient-lookup` | `POST /v1/transfer-recipient-lookups` |
| `POST /v1/transfers/{offerId}/accept` | `POST /v1/transfers/{offerId}/acceptance` |
| `POST /v1/transfers/{offerId}/reject` | `POST /v1/transfers/{offerId}/rejection` |
| `POST /v1/transfers/{offerId}/withdraw` | `POST /v1/transfers/{offerId}/withdrawal` |
| `POST /v1/tickets/{ticketId}/return` | `POST /v1/tickets/{ticketId}/returns` |
| `POST /v1/staff-invitations/lookup` | `POST /v1/staff-invitation-lookups` |
| `POST /v1/staff-invitations/accept` | `POST /v1/staff-invitation-acceptances` |
| `POST /v1/device-approvals/lookup` | `POST /v1/device-approval-lookups` |
| `GET /v1/search/suggest` | `GET /v1/search/suggestions` |
| `GET /v1/events/{eventId}/reviews/summary` | `GET /v1/events/{eventId}/review-summary` |
| `GET /v1/events/{eventId}/reviews/eligibility` | `GET /v1/events/{eventId}/review-eligibility` |
| `POST /v1/reviews/images` | `POST /v1/review-images` |
| `POST /v1/identity/verification/start` | `POST /v1/identity/verifications`(201) |
| `POST`·`GET /v1/identity/verification/{verificationId}/result` | `POST`·`GET /v1/identity/verifications/{verificationId}/result` |
| `POST /v1/identity/token/refresh` | `POST /v1/identity/access-tokens` |
| `POST /v1/identity/link-proposals/{proposalId}/separate` | `POST /v1/identity/link-proposals/{proposalId}/separate-account` |
| `POST /v1/identity/merge-proposals/{proposalId}/confirm` | `POST /v1/identity/merge-proposals/{proposalId}/confirmation` |
| `POST /v1/partner/auth/login` | `POST /v1/partner/auth/sessions` |
| `POST /v1/partner/auth/token/refresh` | `POST /v1/partner/auth/access-tokens` |
| `DELETE /v1/partner/events/{eventId}/staff/{assignmentId}` | `DELETE /v1/partner/staff/{assignmentId}` |
| `POST /v1/partner/events/{eventId}/staff/{assignmentId}/resend` | `POST /v1/partner/staff/{assignmentId}/invitation` |
| `PUT /v1/partner/events/{eventId}/devices/{deviceId}/placement` | `PUT /v1/partner/events/{eventId}/device-placements/{deviceId}` |
| `POST /v1/partner/events/{eventId}/seatmap/import` | `POST /v1/partner/events/{eventId}/seatmap-imports` |
| `POST /v1/partner/events/{eventId}/seatmap/from-template` | `POST /v1/partner/events/{eventId}/seatmap` |
| `POST /v1/partner/events/{eventId}/attendees/export` | `POST /v1/partner/events/{eventId}/attendee-exports` |
| `GET /v1/partner/events/{eventId}/attendees/exports` | `GET /v1/partner/events/{eventId}/attendee-exports` |
| `POST /v1/ops/auth/login` | `POST /v1/ops/auth/sessions` |
| `POST /v1/ops/auth/token/refresh` | `POST /v1/ops/auth/access-tokens` |
| `POST /v1/ops/commands/{commandId}/approve` | `POST /v1/ops/commands/{commandId}/approvals` |
| `POST /v1/ops/commands/{commandId}/reject` | `POST /v1/ops/commands/{commandId}/rejections` |
| `POST /v1/ops/commands/{commandId}/revert` | `POST /v1/ops/commands/{commandId}/reversions` |
| `POST /v1/ops/commands/{commandId}/extend` | `POST /v1/ops/commands/{commandId}/extensions` |
| `POST /v1/ops/commands/{commandId}/post-review/confirm` | `POST /v1/ops/commands/{commandId}/post-review-confirmation` |
| `POST /v1/ops/compliance/access-reviews/{reviewId}/complete` | `POST /v1/ops/compliance/access-reviews/{reviewId}/completion` |
| `POST /v1/ops/approvals` | `POST /v1/ops/approval-requests` |
| `POST /v1/ops/approvals/{approvalId}/approve` | `POST /v1/ops/approval-requests/{approvalId}/approvals` |
| `POST /v1/ops/approvals/{approvalId}/reject` | `POST /v1/ops/approval-requests/{approvalId}/rejections` |
| `POST /v1/ops/event-cancellations/{requestId}/approve` | `POST /v1/ops/event-cancellations/{requestId}/approvals` |
| `POST /v1/ops/event-cancellations/{requestId}/reject` | `POST /v1/ops/event-cancellations/{requestId}/rejections` |
| `POST /v1/ops/event-cancellations/{requestId}/pause` | `POST /v1/ops/event-cancellations/{requestId}/pauses` |
| `POST /v1/ops/event-cancellations/{requestId}/resume` | `POST /v1/ops/event-cancellations/{requestId}/resumptions` |
| `POST /v1/ops/sale-reviews/{eventId}/approve` | `POST /v1/ops/sale-reviews/{eventId}/approvals` |
| `POST /v1/ops/sale-reviews/{eventId}/reject` | `POST /v1/ops/sale-reviews/{eventId}/rejections` |
| `POST /v1/ops/scanner-devices/{deviceId}/revoke` | `POST /v1/ops/scanner-devices/{deviceId}/revocation` |
| `POST /v1/scanner/device-enrollment` | `POST /v1/scanner/device-enrollments` |
| `POST /v1/scanner/shift`(근무 정보와 `readyReport`) | `GET /v1/scanner/shift`(근무 정보), `PUT /v1/scanner/shift/readiness`(준비 완료 보고) |
| `PUT /v1/scanner/events/{eventId}/devices/{deviceId}/placement` | `PUT /v1/scanner/events/{eventId}/device-placements/{deviceId}` |
| `POST /v1/scanner/events/{eventId}/flags/{flagId}/resolution` | `POST /v1/scanner/flags/{flagId}/resolution` |
| 쿼리 `size`(`GET /v1/search`, `GET /v1/inquiries`) | 쿼리 `limit`(응답 필드도 `limit`) |
