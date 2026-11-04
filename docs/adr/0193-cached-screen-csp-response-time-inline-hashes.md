# ADR-0193: 캐시 화면 CSP는 응답 때 인라인 스크립트 해시로 막는다 — Next.js 해시 방식(SRI)이 App Router 인라인 스크립트를 덮지 못해서

- **상태**: 채택(2026-11-04, 소유자 결정 "응답 때 해시(추천)"). ADR-0065 결정 4의 캐시 화면(묶음 A) 부분을 이 ADR로 다시 정한다. ADR-0065 결정 4가 정한 되돌릴 조건("덮지 못하면 `'unsafe-inline'`을 쓰지 않고 새 ADR로 다시 정한다")에 따른 것이다. 요청 화면(B·E·F)의 nonce와 `'strict-dynamic'`은 그대로다.
- **관련**: ADR-0065(웹 프런트엔드 보안), ADR-0079 결정 14, ADR-0111(style 속성), ADR-0191·0192, [docs/frontend.md](../frontend.md) §2.5·§5.14.1·§5.18·§6.3, [docs/architecture.md](../architecture.md) §6.3, [docs/security/asvs/frontend.md](../security/asvs/frontend.md) 3.4.3, [docs/BUILD_ORDER.md](../BUILD_ORDER.md) HOT-290(wbs 2.10.1 ①)
- **관련 ID**: FE-T30, FE-T35, ASVS v5.0.0-3.4.3, ASVS v5.0.0-3.4.6

## 맥락

- ADR-0065 결정 4는 CDN이 캐시하는 화면(홈·공연 상세·검색 셸·굿즈·정적 문서·복귀 화면·스태프 화면·셔플 검증·월렛 셸)은 Next.js 해시 방식(SRI)으로 `script-src 'self'`와 `integrity`를 쓰고, 그 전에 PoC로 App Router 인라인 스크립트까지 덮이는지 보라고 정했다.
- **PoC(2026-11-04, `tools/web-checks/csp/web.spec.mjs`, Next.js 16.4.3 Turbopack, `experimental.sri`, Cache Components 켬, 판을 고정한 Playwright 컨테이너의 Chromium·WebKit·Firefox)**:
  - 외부 스크립트에는 `integrity`가 붙는다. 다만 통째로 정적인 `/system-notice`에서 10개 가운데 6개다. 화면 데이터가 가리키는 화면별 덩어리 4개에는 붙지 않는다(같은 출처라 `'self'`로는 실린다).
  - App Router가 HTML에 넣는 인라인 스크립트는 SRI가 덮지 않는다. Turbopack 시작 코드(`_R_`), 화면 데이터(`self.__next_f.push(…)`), 재개 시각 기록이고 `/system-notice`에 11개다. 내용이 화면마다, 그리고 화면을 다시 만들 때마다 바뀐다.
  - 통째로 정적인 화면은 빌드 때 HTML의 인라인 스크립트 해시로 막는 CSP를 걸어도 세 엔진 모두 위반이 0이다.
  - 요청 때 내용을 채우는 화면(퍼블리싱의 `?state=`처럼 주소 값을 읽는 화면, 앞으로 재생성하는 공연 상세)은 빌드 셸의 해시만으로는 막힌다(셸 인라인 2개, 응답 인라인 6개, 위반 4건). 응답 전체의 인라인 해시를 쓰면 위반이 0이다.
- 그래서 정본의 '`{h}`는 빌드 때 정한 인라인 스크립트 해시'로는 재생성하는 캐시 화면을 지킬 수 없다. 남는 길은 넷이었다.

| 길 | 고르지 않은 까닭 |
| --- | --- |
| 빌드 때 해시만(캐시 화면을 완전 정적으로 제한) | 잔여석처럼 주기적으로 다시 만드는 공연 상세에 쓸 수 없다 |
| 캐시 화면도 nonce | 요청마다 그려 CDN 캐시가 꺼진다(ADR-0065 대안 표에서 기각) |
| `'unsafe-inline'` 위험 수용 | ASVS 3.4.3의 허용 목록·nonce·해시 조건을 무력화한다(ADR-0065가 금지) |
| 보고 모드 유지 | 캐시 화면에 막는 CSP가 없다 |

## 결정

1. **응답 때 해시**: 소비자 웹 앞에 얇은 서버(`apps/web/server/csp-hash-server.mjs`, 노드 기본 모듈만)를 두고 Next.js 서버는 안쪽 포트(127.0.0.1)에 띄운다(`apps/web/server/start.mjs`). 캐시 화면의 HTML 응답은 끝까지 모은 뒤 실행되는 인라인 스크립트마다 SHA-256 해시를 내어 `script-src 'self' <해시들>`로 막는 CSP를 단다. CDN은 본문과 그 CSP를 함께 캐시하므로 둘이 어긋나지 않고, 화면을 다시 만들어도 맞다.
2. **정책 문자열은 한 곳**: 묶음 A의 정책은 지금처럼 `proxy.ts`가 `packages/config/headers/security-headers.mjs`의 `renderCsp`로 만든다. 해시 자리(고정 값 `HASH_SENTINEL`)를 넣은 틀을 안쪽 머리 `x-peaket-csp-template`에 싣고, 앞 서버는 그 자리에 해시만 채운 뒤 안쪽 머리를 지운다. 앞 서버 없이 뜬 때(`next dev`·`next start` 직접)를 위해 해시 없는 보고 모드 정책도 함께 싣고, 앞 서버는 이것도 지운다.
3. **앞 서버의 규칙**:
   - 틀 머리가 있는 HTML 응답만 모은다(본인확인 기관의 POST 복귀처럼 GET이 아닌 것도). 그 밖(요청 화면, 처리기, 정적 자산)은 그대로 흘려 보낸다.
   - **해시는 Next.js·React가 넣는 모양에만 낸다**: 화면 데이터 시작(`(self.__next_f=self.__next_f||[]).push([0])`), JSON 데이터만 담은 화면 데이터 밀어 넣기(`self.__next_f.push([번호,"…"])`), 이 앱 덩어리 경로·모듈 번호만 담은 Turbopack 목록, 설치된 Next.js 운영 실행 파일에서 서버가 뜰 때 읽은 React 스트리밍 도우미 정의(`$RS`·`$RB/$RV/$RC`·`$RX`·`$RM/$RR`, 재개 시각 기록)와 글자까지 같은 것, 문자열·숫자·null·배열만 넘기는 도우미 부르기(`$RC("B:1","S:1")`). HTML에 끼워 넣은 스크립트는 모양을 흉내 내도 해시를 받지 못해 막힌다. 처음 구현은 모든 인라인 스크립트를 해시해 주입된 스크립트도 허용 목록에 넣었다(새 맥락 리뷰가 찾음, 재현 시험이 있다). Next.js를 올려 도우미 모양이 바뀌면 실행 파일 시험과 세 엔진 화면 시험이 먼저 실패한다.
   - 화면 데이터 요청(RSC)·304·HEAD는 본문을 고치지 않고, CSP 관련 머리를 모두 뺀다.
   - 해시는 압축 전 본문으로 낸다. 그래서 안쪽 서버에는 압축하지 말라고 보낸다(`accept-encoding: identity`, 압축은 CDN이 한다). 압축된 HTML이 오면 해시 없이 막는 CSP를 단다.
   - 2MiB [가정]를 넘는 HTML은 해시 없이 막는 CSP로 머리를 쓰고 그대로 흘려 보낸다. 보호를 풀지 않고 메모리에 다 쌓지 않는다.
   - 안쪽 서버에 닿지 못하면 502다. 안쪽 서버가 본문 도중 끊으면 손님 응답도 끊고, 손님이 끊으면 안쪽 요청도 끊는다.
4. **요청 화면(B·E·F)은 nonce 그대로(FE-T35)**: Cache Components를 켜고, `(request)` 묶음 루트 레이아웃이 `<html>` 전에 요청 nonce(`x-nonce`)를 읽으며 `instant = false`를 둔다. 빌드 산출물에 그 경로의 정적 셸이 없다(사전 렌더 HTML 0바이트, 25개 경로). 응답의 모든 `<script>`에 그 응답의 nonce가 붙고, 두 요청의 nonce가 다르며, 세 엔진에서 위반이 0이다. `(cached)` 묶음은 `instant = false`를 둬 퍼블리싱 화면처럼 주소 값을 읽는 화면을 요청 때 통째로 그리고(요청 값을 읽지 않는 화면은 빌드 때 그린다), 루트에 Suspense를 두지 않는다. 루트 Suspense는 문서 뼈대를 먼저 내보내 화면의 `notFound()`가 404 대신 200(소프트 404)으로 굳었다(새 맥락 리뷰가 찾음). 루트 Suspense를 빼도 Cache Components를 켜면 요청 때 그리는 화면의 `notFound()`는 200에 `noindex`다(끈 빌드는 404, Next.js 'Status codes'). 그런 화면은 지금 `no-store`라 CDN에 캐시되지 않고, 없는 주소를 404로 내는 판정(빌드 때, 또는 `proxy.ts`)은 데이터를 잇는 단계가 화면마다 한다. 경로 표에 없는 주소(없는 화면의 404)와 마지막 조각에 점이 든 주소도 `proxy.ts`를 거쳐 캐시 화면 헤더를 받는다(matcher는 자산 확장자만 건너뛴다).
5. **손님이 보낸 CSP·nonce 요청 머리는 지운다**: Next.js는 요청 CSP(없으면 보고 모드 CSP)의 nonce를 스크립트에 붙인다. 그래서 `proxy.ts`는 모든 요청에서 `Content-Security-Policy`·`Content-Security-Policy-Report-Only`·`x-nonce`를 지우고, 요청 화면에는 서버가 만든 값을 싣는다. 고치기 전에는 손님이 고른 nonce가 캐시 화면 HTML에 들어갔다(PoC 중 찾은 결함, 재현 시험이 있다).
6. **SRI(`experimental.sri`)는 켜 둔다**: 외부 스크립트의 `integrity`는 배포 경로의 변조 확인으로 남는다. CSP의 허용 근거는 `'self'`와 응답 때 해시다.

## 결과

- 좋아지는 점: 캐시 화면도 `'unsafe-inline'` 없이 막는 CSP를 갖는다. CDN 캐시와 재생성을 그대로 쓴다. 해시를 응답마다 다시 내므로 빌드와 배포 사이에 어긋날 일이 없다. 세 엔진에서 캐시 화면 6곳의 위반이 0이다(`csp/web.spec.mjs`).
- 나빠지는 점:
  - 캐시 화면은 조각으로 흘려 보내지 못하고 다 만든 뒤 보낸다. 대부분 CDN이 답하므로 영향은 원본까지 오는 첫 요청과 재생성에 한정된다 [가정, 측정은 프론트엔드 측정 캠페인 wbs 7.5.2].
  - 운영 이미지의 진입점이 Next.js standalone `server.js`가 아니라 `server/start.mjs`가 된다(standalone 서버를 같은 프로세스에서 안쪽 포트로 띄운다. 배포 단계 HOT-450이 `output: 'standalone'`과 함께 연다).
  - 안쪽 머리 하나와 로컬 홉 하나가 는다. 인라인 스크립트가 많은 화면은 CSP 머리가 길어진다(`/system-notice` 11개 593자). 앱이 단 머리라 CloudFront 응답 헤더 정책의 1,783자 상한과는 상관없다.
- 되돌릴 조건: Next.js가 App Router 인라인 스크립트의 해시를 빌드·재생성 때 내 주거나 인라인 스크립트를 없애면, 앞 서버를 빼고 그 방식으로 옮긴다. 앞 서버가 원본 지연 목표(TTFB 0.8초, §5.8)를 넘기면 다시 정한다.
