# 웨이브 7 갈래 2 끝 리뷰: 보안 관점(BAT-165, BAT-170, BAT-040)

이 파일은 검토 기록이고 규범이 아니다. 정본은 ADR과 `docs/` 정본 문서이고, 아래 지적을 받아들일지와 고치는 법은 감독·계획 담당이 정본에 적는다.

- **누가·언제**: 웨이브 끝 리뷰 담당 `l2w7-rev-security`(ADR-0270 결정 4, ADR-0267), 2026-11-16. 계획·시험·구현·묶음 리뷰에 관여하지 않았다.
- **본 코드**: 커밋 `29034c57`, `git diff 982a78a8..29034c57 -- apps services packages tools loadtest .github`. 줄 번호는 모두 `29034c57` 판이다. 시험은 돌리지 않았고 코드를 읽어 판정했다.
- **기준**: `docs/security/asvs/catalog-review.md`·`docs/security/asvs/frontend.md`의 계획이 가리킨 행, 계획 세 파일(`docs/review/plans/BAT-165.md`·`BAT-170.md`·`BAT-040.md`)의 '웨이브 7 계획'과 '정한 것' 절, ADR-0271·ADR-0272, 그리고 지적마다 적은 정본 자리.
- **겹침 피하기**: 세 계획의 '## 리뷰'·'## 검증'(R165-1~23, R170-1~8, V170-1~48, R040-1~6, V040)에 이미 있는 지적은 적지 않았다. 비슷한 자리를 다른 까닭으로 보는 것은 그 관계를 적었다.
- **심각도**: 높음(이 웨이브 안에서 고치는 편이 맞다), 중간(합치기 전이나 구간 끝 정리에서), 낮음(정리 목록·다른 단계로 넘겨도 된다).

## 지적

### W7L2-S1(높음, BAT-170): 공유 캐시의 키 수가 요청 주소만큼 끝없이 늘고 30일 남아, 로그인 세션과 함께 쓰는 클러스터를 채울 수 있다

- **위치**: `apps/web/server/cache-store.mjs:15`(값 TTL 상한 30일), `cache-store.mjs`의 `setEntry`(크기만 보고 키 수·메모리 몫은 보지 않음), `apps/web/server/use-cache-handler.mjs:79`·`apps/web/server/cache-handler.mjs:73`(모든 항목을 공유 저장소에 씀). 부르는 쪽: `apps/web/src/_pages/event-detail/api/load-event.ts:23~26`(이 웨이브 전 코드. `'use cache'` 함수 안에서 ID 꼴을 보므로 꼴 밖 문자열도 `{ kind: 'missing' }` 항목 하나가 된다).
- **무엇이**: 이 웨이브 전에는 'use cache'·미리 그린 화면 캐시가 파드 메모리(Next.js 기본, 크기 상한이 있고 오래된 것부터 지움)에 있었다. 이제는 모든 항목이 Redis 세션·캐시 클러스터에 가고, 항목의 만료와 30일 가운데 짧은 쪽만큼 남는다.
  - 로그인 없이 `/events/<아무 글>`(로케일 경로 `/[locale]/events/[id]`, `shuffle-proof` 포함)을 서로 다른 값으로 부르면 CDN이 받아 주지 못하고(주소마다 다름), 요청마다 `web:data:` 항목이 하나씩 생긴다.
  - `loadEvent`는 `cacheLife({ revalidate: 300 })`만 준다. 만료(`expire`)를 따로 주지 않아 기본 프로필의 만료를 물려받으면 그 항목의 TTL은 상한 30일이 된다(추정. Next.js 16.4의 `cacheLife` 부분 값 처리는 확인하지 않았다). 없는 회차의 404가 미리 그린 화면 캐시(`web:isr:`, 항목 하나가 수십 kB인 HTML·RSC)에도 들어가는지는 확인하지 못했다. 들어간다면 같은 요청 수로 메모리가 수십 배 빨리 찬다.
  - 미리 그린 화면 키에 빌드 칸이 들어가므로(R170-2 고침) 배포할 때마다 같은 화면의 새 사본이 생기고, 옛 판 사본도 30일 남는다. 하루 여러 번 배포하면 정상 사용만으로도 사본 수가 배포 수에 비례해 쌓인다.
- **정본과 어디가 어긋나나**: 이 클러스터는 `maxmemory-policy noeviction`이다(docs/data.md:2558). 메모리가 차면 지우지 않고 쓰기가 오류다. 같은 클러스터에 identity 사용자 세션 `id:sess:{sid}`와 전역 레이트 리밋 카운터 `rl:`가 있다(docs/data.md:20·2560). 그래서 웹 캐시가 메모리를 채우면 세션 만들기·레이트 리밋 쓰기까지 실패한다(로그인 전체 장애). 정본은 '모든 키에 TTL'과 '항목 크기 상한(1MB)'만 두고 키 수·메모리 몫의 상한은 없다(정본 빈틈). 검색 쪽은 같은 위험을 catalog-review 2.4.1(캐시가 빗나가는 무작위 입력은 메모리 사전·전용 연결 묶음이 받는다)로 막았는데, 웹 공유 캐시에는 그런 문장이 없다. IP별 레이트 리밋은 HOT-400 몫이라 아직 없다.
- **재현 시험 아이디어**: (test-int, 실제 Valkey) `createUseCacheHandler`로 `loadEvent`와 같은 모양의 항목(만료 없음)을 서로 다른 키 1만 개로 쓴 뒤 `DBSIZE`와 표본 키의 `TTL`을 본다. 지금은 1만 개가 모두 남고 TTL이 약 2,592,000초다. 기대: 없음·404 결과는 짧은 TTL(예: revalidate와 같은 300초)이거나 쓰지 않는다. (무거운 게이트) Valkey를 붙인 standalone 서버에 `/events/<무작위>` 1,000번을 보낸 뒤 `web:isr:*` 키 수를 세어 404가 저장되는지 확인한다.
- **고치는 방향(구현·계획 몫)**: ID 꼴 검사를 `'use cache'` 함수 밖으로 빼고, 없음·404·410은 짧게 두거나 저장하지 않는다. 값 TTL 상한을 30일이 아니라 그 항목의 revalidate 몇 배로 묶는다. 웹 캐시에 메모리 몫(예: 별도 클러스터, 또는 웹 키 전용 사용자와 경보)을 정본(docs/data.md 메모리 규칙)에 적는다.

### W7L2-S2(중간, BAT-040): 주소 조각 하나로 자격 있는 팬·비회원의 예매 버튼을 끌 수 있다

- **위치**: `apps/web/src/_pages/event-detail/model/sale.ts:128`(`eligibilityGate`: 창 안이면 팬 자격과 로그인 상태보다 먼저 '자격 없음'), `sale.ts:185`(`deniedWindow`: 조각이 없으면 문서 동안), `apps/web/src/_pages/event-detail/ui/sale-live.ts:151`(`location.hash`만 보고 켬).
- **무엇이**: 명단 밖 알림은 누가 그 조각을 붙였는지 보지 않는다. 그래서 누구나 `/events/<회차>#sale-eligibility-required` 링크를 만들어 퍼뜨릴 수 있다(팬 커뮤니티의 '예매 바로가기' 같은 꼴). 그 링크로 들어온 사람은 다음처럼 된다.
  - 선예매 명단에 있는 팬(서버 자격 `eligible` true)도 [대기열 들어가기]·[로비 입장]이 `aria-disabled`이고 "이 회차의 선예매 대상이 아닙니다"를 본다. 창은 그 선예매 조각이 끝날 때까지다.
  - 선예매가 없는 일반 판매 회차(`salePhases` 없음)에서는 창 끝이 없어 **문서 내내** 버튼이 꺼진다. 비회원도 같다(`session.status` 확인보다 앞에 있다).
  - 고치는 길은 새로고침뿐인데, 화면은 '대상이 아님'이라고 말하므로 팬이 새로고침할 까닭을 모른다. 오픈 순간 경쟁이 센 공연에서 남의 예매를 늦추는 데 쓸 수 있다.
- **정본과 어디가 어긋나나**: ADR-0272 결정 4가 "창 안에서는 팬 자격과 상관없이 '자격 없음' 모양"으로 정했고, 조각의 출처를 확인하라는 문장이 없다(정본 빈틈). R040-3(같은 창 안에서 '선예매 대상' 줄과 글이 엇갈림)은 화면 글의 모순만 보았고, 링크 위조는 다루지 않았다. 대기실 경량 페이지는 소비자 웹과 같은 `www` 출처다(asvs/frontend.md 3.5.4 행). 그래서 대기실이 같은 출처 저장소에 남긴 표시처럼 바깥 링크가 만들 수 없는 신호를 쓸 수 있다.
- **재현 시험 아이디어**: (단위, `model/sale.test.mjs`) `deniedWindow([], 오픈, 지금)`의 값과 `fan: { status: 'known', phases: [PRESALE eligible true] }`·`session: member`를 `eligibilityGate`에 넣으면 지금은 이유 글이 나온다(기대: `null`). 비회원·`salePhases` 없음도 같다. (브라우저 확인) 비로그인으로 선예매 없는 회차의 `#sale-eligibility-required` 주소를 열면 지금은 버튼이 꺼진다.
- **고치는 방향**: 대기실이 403을 받을 때 `sessionStorage`에 회차 ID와 짧은 만료(예: 1분)를 적고, 공연 상세는 조각과 그 표시가 함께 있을 때만 켠다. 또는 서버 자격이 `eligible`로 확인됐거나 판정 조각이 `PRESALE`이 아니면 덮지 않는다. 어느 쪽이든 ADR-0272 결정 4에 먼저 적는다.

### W7L2-S3(중간, BAT-165): 파트너 DB 역할(core_partner)이 검색 읽기 모델 표 전체를 행 보안 없이 쓰고 읽는다

- **위치**: `services/core-svc/migrations/0023_search_read_model_tables.sql:155`(`search_document`·`search_term`에 SELECT·INSERT·UPDATE·DELETE), `:157`(`search_removal`), `:159`(`search_version` SELECT·UPDATE), `:111`(원천 함수 실행 권한).
- **무엇이**: 포스터 게시 트랜잭션이 같은 트랜잭션에서 동기화를 부르려고(ADR-0271 결정 2) 파트너 역할에 네 표 쓰기 권한을 주었다. 네 표에는 행 보안이 없다. 그래서 파트너 연결로 도는 코드에 결함(주입·잘못된 ID 넘기기 등)이 하나 생기면, 테넌트와 상관없이 다음이 된다.
  - 다른 판매자 공연을 공개 검색에서 지우거나(`DELETE search_document`), 이름 줄을 바꿔 자동완성에 아무 글이나 띄운다(`UPDATE search_term.display_name`).
  - `search_version`의 판과 따라잡기 임대 칸을 바꿔 사전 갱신·시작 따라잡기를 막는다.
  - `search_document.interest`(찜 수로 센 관심도. 공개 API에는 없는 값)로 다른 판매자 공연의 수요를 읽는다. 원천 함수도 `p_ids`를 비워 부르면 같은 값을 준다.
- **정본과 어디가 어긋나나**: 지금까지 core_partner가 쓰는 표는 모두 행 보안을 켰다(0004·0006·0007·0008·0014·0015). catalog-review 8.4.1은 '테넌트 표의 행 보안(2차 방어)'을 둔다. ADR-0241은 파트너 행 보안을 시작 확인까지 두어 지킨다. 0008:158의 '2차 방어(리뷰 S6)'처럼, 앱 코드가 막더라도 DB 권한이 마지막으로 막는다는 것이 이 저장소의 규칙이다. 묶음 리뷰는 원천 함수의 `SECURITY DEFINER`·`search_path`·`REVOKE`만 보았고 이 표 권한은 다루지 않았다.
- **재현 시험 아이디어**: (test-int, D) core_partner 연결에 `app.tenant_id` = 테넌트 A를 걸고 테넌트 B 공연의 `search_document` 줄을 `DELETE`, `search_term`을 `UPDATE`, `interest`를 `SELECT`하면 지금은 모두 된다(기대: 권한 오류). 대조군으로 같은 연결의 포스터 게시가 검색 줄을 고치는지 본다.
- **고치는 방향**: 동기화를 `SECURITY DEFINER` 함수 하나(공연 ID 목록·시각을 받고, 파트너 역할이면 `app.tenant_id`의 공연만 받는다)로 감싸 파트너에게는 그 함수 실행 권한만 준다. 또는 포스터 변경의 동기화를 커밋 뒤 운영 역할(core_ops) 쪽 일로 넘긴다(그러면 '같은 트랜잭션' 결정을 ADR-0271에서 고친다).

### W7L2-S4(낮음, BAT-165): 검색어 가리기가 흔한 전화번호·카드 번호 꼴을 놓친다

- **위치**: `services/core-svc/src/modules/catalog/domain/search.ts:859~861`.
- **무엇이**: 정본 문장(0으로 시작하는 9~11자리, 사이 구분자 한 글자)대로라 다음은 `search_query` 줄에 그대로 남는다. `+82 10-1234-5678`(국제 꼴), `010 - 1234 - 5678`(구분자가 세 글자), `(010)1234-5678`, `1234 5678 9012 3456`(네 자리씩 띄운 카드 번호), `hong @ example.com`(띄운 이메일). 0건 목록은 5번 이상만 보이지만, 로그 줄 자체에는 남는다.
- **정본**: docs/features/search.md:286(가리기 규칙), catalog-review 16.2.5('민감 데이터는 보호 등급에 따라 로그에', 검색어는 정규화한 값 50자). 구현은 정본과 맞고, 정본 규칙이 좁다(정본 빈틈).
- **재현 시험 아이디어**: (단위, `test/search-log.test.ts`) 위 다섯 값을 `loggedQuery`에 넣어 숫자 네 자리 이상이 이어지거나 `@`가 남는지 본다. 정본에 국제 꼴(`+82`)·여러 글자 구분자·네 자리 묶음 넷을 더한 뒤 시험을 고친다.

### W7L2-S5(낮음, BAT-165): 검색 품질 사건 요청의 `Referer`에 검색어가 든 주소가 실린다

- **위치**: `apps/web/src/widgets/app-shell/model/search-quality-client.ts:13`(`fetch` 설정에 `referrerPolicy` 없음), `packages/config/headers/security-headers.mjs:100`(소비자 웹 `Referrer-Policy: strict-origin-when-cross-origin`).
- **무엇이**: 이 정책은 같은 출처 요청에 전체 주소를 `Referer`로 싣는다. 결과 화면(`/search?q=…`)에서 `pagehide`로 보내는 `/_t/rum` 요청에 검색어(가리기 전 값)가 실린다. 본문에는 검색어가 없지만, 수집 경로의 접근 로그·텔레메트리 처리기가 그 머리를 받는다.
- **정본**: catalog-review 14.2.3 행('검색 품질 사건도 검색어 없이 수만 같은 출처 수집 경로로'), docs/features/search.md §11('브라우저가 검색어 없이 사건 수만'). 계획 §3 표의 14.2.3 닫는 법도 '검색어·쿼리 문자열이 없다'다. CDN 접근 로그에 쿼리가 남는다는 정본 문장(search.md:286 끝)은 화면 요청에 대한 것이고, 수집 경로는 다른 시스템이라 같은 보존 규칙이라고 볼 근거가 없다.
- **재현 시험 아이디어**: (Playwright, budgets 또는 reflow 묶음) `/search?q=01012345678`을 열고 다른 화면으로 옮겨 `/_t/rum` 요청을 가로채 `referer` 머리에 `q=`가 없는지 본다. 고침은 `fetch(..., { referrerPolicy: 'no-referrer' })`(또는 `'origin'`).

### W7L2-S6(낮음, BAT-165): 검색 전용 연결이 core 전체 읽기 역할(core_app)이다

- **위치**: `services/core-svc/src/main.ts:92`(`assertDatabaseRole(searchDatabase, 'core_app')`), 0023:161(`core_app`에 검색 표 SELECT).
- **무엇이**: 검색은 로그인 없는 아무 입력을 가장 많이 받는 경로이고, 그 연결은 검색 표 넷만 읽으면 된다. 지금은 core_app으로 붙어 그 연결로 다른 core 표(찜·후기·판매 자격 등)도 읽을 수 있다. 질의는 모두 매개변수이고 `LIKE`도 이스케이프해 지금 새는 길은 찾지 못했다. 최소 권한(2차 방어)만의 문제다.
- **정본**: 정본에 검색 전용 DB 역할이 없다(정본 빈틈). docs/features/search.md §7.2·catalog-review 2.4.1은 연결 묶음·복제본만 정했다. 검색 표 넷의 SELECT만 가진 역할(예: `core_search`)을 두고, 시작 때 역할을 확인하는 지금 방식(ADR-0241, `assertDatabaseRole`)으로 그 역할인지 보는 길이 있다.
- **재현 시험 아이디어**: (test-int, D) 검색 연결로 `select count(*) from wish`가 권한 오류인지 본다(지금은 된다).

### W7L2-S7(낮음, BAT-170): 웹 공유 캐시 연결의 TLS와 키 접두사 권한이 코드·정본 어디에서도 강제되지 않는다

- **위치**: `apps/web/server/cache-store.mjs:109`(`createClient({ url })`: `redis://`도 받는다), `cache-env.mjs`(운영 환경에서도 주소 꼴을 보지 않음).
- **무엇이**: 웹 앱 서버는 인터넷 요청을 바로 그리는 넓은 공격면이고, 같은 클러스터에 사용자 세션 `id:sess:{sid}`가 있다(docs/data.md:20·2560). 웹이 쓰는 Redis 사용자가 `web:*`만 다루게 묶이지 않으면, 웹 서버가 뚫렸을 때 세션 키를 읽거나 지울 수 있다. 또 미리 그린 HTML을 담은 값이 평문 연결로 오가면 중간에서 바꿔 모든 파드에 퍼뜨릴 수 있다(저장형 스크립트 주입).
- **정본**: ADR-0007(같은 Redis를 나눠 써도 키 접두사·계정 권한(ACL)으로 격리), docs/infra-handover.md:395('키 접두사·ACL로 나눔'). Redis ACL은 HOT-430 몫이고, 그 줄의 대기열 사본처럼 웹 사용자(`~web:*`, `get`·`set`·`mget`만)를 적어 두지 않으면 빠지기 쉽다.
- **재현 시험 아이디어**: (단위) `PEAKET_ENV`가 `local`·`ci`·`demo` 밖인데 주소가 `redis://`면 `selectRuntime`·`assertCacheEnv`가 던지는지. (기록) 감독이 HOT-430 줄에 웹 캐시 사용자 ACL과 TLS를 한 줄 더한다.

### W7L2-S8(낮음, BAT-165): 측정용 채우기 스크립트에 환경 가드가 없다

- **위치**: `services/core-svc/scripts/fill-search.mjs:15`.
- **무엇이**: `PEAKET_DATABASE_URL`만 있으면 어느 DB에든 판매 승인된 가짜 공연을 최대 20만 개 넣고 따라잡기까지 돈다. 주소를 잘못 주면 운영 검색에 가짜 공연이 바로 공개된다. `services/identity-svc/scripts/mock-idv.mjs` 등은 `PEAKET_ENV`를 본다.
- **재현 시험 아이디어**: (단위) `PEAKET_ENV`가 `local`·`ci` 밖이면 접속 전에 끝나는지.

### W7L2-S9(낮음, BAT-165): 연결 묶음 포화 보안 사건 줄이 503마다 하나라 공격 중에 로그가 몰린다

- **위치**: `services/core-svc/src/modules/catalog/application/search.ts:66`.
- **무엇이**: 무작위 입력 공격으로 묶음이 넘치면 503 응답마다 `warn` 줄이 하나씩 남는다. 공격 요청 수만큼 로그가 늘어 수집·보존 비용과 다른 보안 사건의 가시성을 해친다.
- **정본**: catalog-review 16.3.3('검색 전용 연결 묶음 포화(503)를 기록')은 기록 자체만 정했고 묶음·표본 규칙이 없다. 게이지 `search_pool_waiting`(search.md:271~273)과 503 수 지표가 있으니, 사건 줄은 파드마다 일정 시간에 한 번(그 사이 수를 함께)으로 줄이는 길이 있다.
- **재현 시험 아이디어**: (HTTP, 메모리) 묶음 포화 대역으로 1초 안에 100번 부르면 `search_pool_saturated` 줄이 몇 줄인지 본다(지금 100줄).

## 합계

- 높음 1(W7L2-S1), 중간 2(W7L2-S2·S3), 낮음 6(W7L2-S4~S9).

## 본 범위

- BAT-165: 마이그레이션 0023 전체(원천 함수의 `SECURITY DEFINER`·`search_path`·권한, 표 권한), `drizzle-search-read-model.ts`(질의 조립·`sql.raw` 고정 글·UUID 확인), `drizzle-search-index.ts` 앞부분(LIKE 이스케이프·필터·시간 상한·503 판정), `search.controller.ts`(캐시 머리), `catalog.module.ts`의 `searchNoStore`·제공자 연결, `application/search.ts`(로그 줄 칸·가리기·50자), `domain/search.ts`의 가리기·0건 집계, `main.ts` 조립, 포스터·판매 승인의 동기화 부르는 자리, `cdn-invalidation.ts`, `@peaket/platform` 준비 표시 바뀐 곳, 웹 품질 사건 보내기와 부르는 자리, `fill-search.mjs`·`loadtest/scenarios/v1-search.js` 앞부분.
- BAT-170: `cache-env.mjs`·`cache-store.mjs`·`cache-handler.mjs`·`use-cache-handler.mjs`(키·TTL·실패 때 동작·역직렬화), `start.mjs`·`standalone.mjs`(점 파일 거르기), `next.config.ts`, `app/sw.ts`·`sw-rules.ts`(캐시 범위·`no-store`·메시지), 인앱 열 주소 `open-href.ts`·`target.ts`(열린 이동), eslint 예외 한 줄, `apps/web/package.json`의 `redis`·잠금 파일 판, `ci-web.yml` `reflow` 잡·`ci-node.yml` 한 줄, CSP 시험의 3.6.1 몫.
- BAT-040: 대기실 `controller.ts`의 403 처리, `sale.ts`의 `eligibilityGate`·`deniedWindow`·`isDeniedHash`, `sale-live.ts`(상태 파일·판매 자격 받기의 자격 증명·캐시 설정, 조각 읽기), `eligibility-store.ts`·`live-sale-store.ts`·`live-sale.ts`, `failure.ts`, 가짜 API의 새 경로(127.0.0.1 묶음, `private, no-store`).
- 다른 갈래 3과 세 계획의 리뷰·검증 절은 겹침을 피하려고만 읽었다.

## 못 본 범위

- 시험·`test-int`·이야기·fixture의 내용(골든 세트 1,507줄, `search-read-model.int.test.ts` 1,300줄 등)은 이름만 훑었다. 시험은 하나도 돌리지 않았고 Docker도 쓰지 않았다.
- Next.js 16.4의 실제 동작 두 가지(W7L2-S1): `cacheLife`에 revalidate만 줄 때의 만료 값, 없는 회차의 404가 미리 그린 화면 캐시에 저장되는지. 설치된 `next` 코드를 읽지 않았다.
- `drizzle-search-index.ts` 뒷부분(관련 공연·필터 이름 질의), `memory-search-index.ts`, `search-maintenance.ts`의 정리 주기 세부, `SuggestionDictionary` 본문, `@peaket/search-normalize/refine.ts`.
- `tools/web-checks`의 reflow·budgets·ds·seo 시험과 `rules.mjs`, `tools/ci/brief.mjs`, ds 부품(OTPField·PasswordField·SearchField·WebShell 이야기, SeatMapEditorCanvas·TimeSeriesChart), console-host·partner의 작은 바뀐 곳, 웹 화면 부품(`Booking.tsx`·`DetailPersonal.tsx`·월렛 토스트)의 그리기 세부.
- 서비스 워커 등록 위치·범위(`/serwist/sw.js`·`/my/tickets`)는 계획이 GAT-040으로 넘긴 몫이라 보지 않았다. 실제 CDN·게이트웨이·ElastiCache 설정은 저장소에 없어 보지 못했다.
