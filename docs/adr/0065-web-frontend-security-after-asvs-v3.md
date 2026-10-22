# ADR-0065: 웹 프런트엔드 보안 보강 — ASVS V3 판정 뒤 정한 것(2026-10-15)

- **상태**: 채택 (2026-10-15. 소유자 요청 "이 작업을 여기에서 진행해 주세요: '기존 ASVS 추적 표에 V3 판정 더하기'". 기존 ASVS 추적 표 9개에 OWASP ASVS 5.0.0 V3(웹 프런트엔드 보안) L1·L2 19개를 판정하며 드러난 설계 빈칸을 추천 적용으로 정했다. 결정 하나하나가 소유자 검토 대상이다. 외부 사실은 2026-10-15에 원문으로 확인했다.) 2026-10-21(ADR-0079): 결정 4의 화면별 CSP를 묶음 여섯으로 구체화하고 모든 화면 `connect-src`에 `'self'`를 넣었다. 월렛은 캐시 화면 묶음으로 정했고(architecture §6.3의 미정을 닫음) 대기실은 정적 경량 페이지라 `script-src 'self'`만 둔다. 2026-10-21: 본문의 REST 경로는 ADR-0081의 옛 경로 대응표로 새 경로를 읽는다(경로 이름 규칙 점검).
- **관련**: ADR-0008(클라이언트별 게이트웨이), ADR-0011(토큰 수명주기), ADR-0041(동시 도착 묶음), ADR-0051(현장 입장), ADR-0053(도착 시각 쿠키), ADR-0058(CloudFront 배포 셋), ADR-0063(화면 개편), docs/security/asvs/*.md V3 절, NFR-001, NFR-019

## 맥락

- V3 판정은 docs/security/asvs/catalog-review.md(2026-10-14)에만 있었다. 2026-10-15 auth·queue-admission·bot-defense·payment·transfer-refund·settlement·delivery·offline-gate·analytics 표에 V3 절을 더했다. 판정하며 설계 문서에 없는 것이 여럿 나왔다. 콘솔·스캐너 화면 호스트, 쿠키 이름 접두사, 보안 헤더 값과 붙이는 곳, 소비자 웹의 CSP 방식, 교차 출처 요청의 CORS 사전 요청, 스캐너 mTLS 경로의 CSRF 방어, 외부에서 돌아오는 첫 요청의 쿠키 같은 것들이다.
- 2026-10-15 원문 확인: OWASP ASVS `v5.0.0` V3 장(3.3.1 쿠키 접두사, 3.4.3 CSP 최소 조건 `object-src 'none'`·`base-uri 'none'`과 허용 목록이나 nonce·해시, 3.5.1 사전 요청에 기대지 않으면 위조 방지 토큰이나 safelisted가 아닌 헤더 같은 방법으로 출처를 확인). Next.js 'Content Security Policy' 가이드(2026-03-20 갱신본: nonce를 쓰면 모든 페이지가 동적 렌더링이 되어 정적 최적화·ISR·CDN 캐시가 꺼지고 PPR과 맞지 않는다. 해시 방식 SRI는 정적 생성을 유지하지만 실험 기능이고 App Router 전용이며 빌드 때 만든 스크립트만 다룬다). MDN CORS 가이드와 Fetch 표준(사전 요청이 없는 요청: GET·HEAD·POST, safelisted 헤더만, `Content-Type`은 `application/x-www-form-urlencoded`·`multipart/form-data`·`text/plain`). MDN `Access-Control-Max-Age`(Chromium 상한 2시간, Firefox 24시간, 기본 5초). Auth.js 소스(보안 쿠키 기본 이름 `__Secure-authjs.*`, CSRF 쿠키만 `__Host-`, `SameSite=Lax`). Cloudflare Turnstile 문서(CSP는 nonce나 `script-src`·`frame-src`에 `https://challenges.cloudflare.com`, `api.js`는 프록시·캐시하지 않음). AWS CloudFront 응답 헤더 정책(원본 재정의 끄면 원본 값 유지, CSP 값 1,783자).

## 결정(모두 추천 적용 2026-10-15)

1. **화면 호스트**: 소비자 웹 `www.peaket.example`(지금), 파트너 콘솔 `partner.peaket.example`, 관제 콘솔 `console.peaket.example`(Module Federation 원격 모듈도 같은 출처 `/remotes/`에서 낸다), 스캐너 PWA `scanner.peaket.example`(정적 앱, mTLS 없음). API 호스트(`api`·`queue`·`queue-files`·`partner-api`·`ops-api`·`scanner-api`)는 그대로다. 앱마다 호스트가 달라 동일 출처 정책으로 나뉜다(ASVS 3.5.4).
2. **쿠키 이름**: 모든 쿠키에 `Secure`·`HttpOnly`를 둔다. 여러 호스트가 함께 읽으면 `Domain=peaket.example`과 `__Secure-` 접두사, 한 호스트만 쓰면 `Domain` 없이 `Path=/`와 `__Host-` 접두사를 쓴다. 팬 액세스 `__Secure-peaket_at`, 팬 리프레시 `__Secure-peaket_rt`(갱신 경로로 한정), 파트너 액세스 `__Secure-peaket_partner_at`, 운영자 액세스 `__Host-peaket_ops_at`(관리 쿠키 하나를 파트너·운영자 둘로 나눔), Auth.js `__Host-authjs.*`(Lax), 계정 연결 제안 `__Host-peaket_link`, 도착 시각 `__Host-peaket_arr`, 최초 방문 `__Host-peaket_fv`(결정 9). 남는 것: `Domain` 쿠키는 PEAKET의 모든 하위 호스트로 가므로 하위 호스트에는 PEAKET이 운영하는 앱·게이트웨이만 둔다.
3. **보안 헤더 값과 붙이는 곳**: CloudFront를 거치는 응답은 배포·캐시 동작별 응답 헤더 정책이, 게이트웨이 응답(CloudFront를 거치지 않는 `gw-scanner` 포함)은 Envoy Gateway 공통 정책이 붙인다. HSTS `max-age=31536000; includeSubDomains`(preload는 신청하지 않음), `X-Content-Type-Options: nosniff`는 정책 값으로 통일한다. CSP·Referrer-Policy는 앱이 보낸 값을 둔다(소비자 웹 `strict-origin-when-cross-origin`, 콘솔·스캐너 `no-referrer`). 모든 앱 `frame-ancestors 'none'`. COOP는 소비자 웹 `same-origin-allow-popups`(본인확인 새 창), 콘솔·스캐너 `same-origin`.
4. **소비자 웹 CSP**: CDN이 캐시하는 화면(홈·공연 상세 등 ISR·정적)은 Next.js의 해시 방식(SRI)으로 `script-src 'self'`와 `integrity`를 쓰고, 개인 화면(동적 렌더링: 마이 티켓, 결제 등)은 nonce와 `'strict-dynamic'`을 쓴다. 공통으로 `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`. SRI가 실험 기능이므로 wbs 2.10.1 착수 전에 PoC로 App Router의 인라인 스크립트까지 덮이는지 확인한다. 덮지 못하면 `'unsafe-inline'`을 쓰지 않고, 캐시 화면의 CSP를 어떻게 할지 새 ADR(위험 수용 포함)로 다시 정한다. 파트너 콘솔(동적 렌더링)은 nonce, 관제 콘솔은 `script-src 'self'`(원격 모듈 같은 출처)와 해시. CSP 위반 보고는 `report-to`로 소비자 웹의 수집 경로에 모아 구조화 로그와 지표로 남기고 급증하면 SEV3다 [가정].
5. **CSRF 확인 규칙 하나로**: 쿠키로 인증하는 쓰기 요청은 게이트웨이가 `Origin`을 허용 목록과 대조하고, `Origin`이 없으면 `Sec-Fetch-Site`가 `same-origin`·`same-site`인지 본다. 둘 다 없으면 거절한다. 결제사·파트너 웹훅(서명 검증)과 서버 사이 호출은 예외다(ADR-0008의 'Origin/Referer' 표현을 이 규칙으로 읽는다).
6. **T=0 진입의 CORS 사전 요청을 없앤다**: www에서 `queue` 호스트로 보내는 대기열 진입(`POST /v1/queue/{eventId}/entries`)과 입장 확정(`…/admission`)은 교차 출처라, JSON 본문이면 요청마다 OPTIONS 사전 요청이 붙는다. 사전 요청 캐시는 URL별이고 진입 주소는 회차마다 달라 미리 데울 수 없다. 그래서 T=0의 20만 RPS에 같은 수의 사전 요청과 왕복 한 번이 더해질 수 있는데, 이것이 용량 계산(NFR-001, 대기열 API 배포 한도, 부하 분해)에 없었다. 두 요청은 본문을 JSON 문자열로 담되 `Content-Type: text/plain;charset=UTF-8`로 보내고 safelisted가 아닌 헤더를 쓰지 않아 사전 요청이 생기지 않게 한다. 위조 방지는 본문의 사전 검증 토큰·대기표(허용한 출처만 응답을 읽어 얻는 값)와 결정 5의 `Origin` 확인, `SameSite=Strict` 쿠키가 맡는다(ASVS 3.5.1). 서버는 이 두 경로에서 `text/plain`과 `application/json`만 받고 본문을 JSON으로 검사한다. 그 밖의 교차 출처 API는 JSON과 사전 요청을 그대로 두고 `Access-Control-Max-Age: 7200`을 준다. Phase 2 부하 시험에서 사전 요청이 없는지와 지연을 잰다.
7. **대기열 호스트의 CORS**: `queue-files` 배포와 S3 대체 원본은 `Access-Control-Allow-Origin: https://www.peaket.example`과 `Access-Control-Expose-Headers: Retry-After`를 낸다(쿠키 없음). `queue` API는 같은 출처 값에 `Access-Control-Allow-Credentials: true`, `Vary: Origin`, `Retry-After` 노출을 더한다.
8. **밖에서 돌아오는 첫 요청**: 결제창 복귀, 이메일·알림 링크, 본인확인 복귀처럼 다른 사이트에서 들어오는 첫 요청에는 `SameSite=Strict` 쿠키가 실리지 않는다. 그런 착지 화면은 쿠키 없이 정적 셸만 내고, 쿠키가 필요한 호출은 페이지 스크립트가 같은 사이트 요청으로 한다(identity §5의 규칙을 결제·양도·환불 화면에도 쓴다).
9. **봇 방어의 브라우저 쪽 빈칸**: 최초 방문 쿠키 `__Host-peaket_fv`는 `queue` 호스트의 엣지 함수가 사전 검증(`/preverify`) 응답에서 처음 발급하고 HMAC으로 서명한다(도착 시각 쿠키와 같은 키 체계, 공연 페이지는 CDN 캐시라 사람마다 다른 쿠키를 싣지 않음). 행동 신호 요약은 사전 검증 요청 본문(사람 확인 토큰과 함께)으로 보낸다. 허니팟 경로는 `Sec-Fetch-Site: same-origin`이고 `Sec-Purpose`에 prefetch가 없는 요청만 기록하고 204로 답한다(다른 사이트가 이미지로 부르게 한 요청, 미리 가져오기로 사람을 오탐하지 않게). Turnstile 화면의 CSP에는 `https://challenges.cloudflare.com`을 `script-src`·`frame-src`에 둔다.
10. **스캐너·현장 스태프**: 스캐너 PWA는 `scanner.peaket.example`에서 mTLS 없이 내고 `scanner-api`가 mTLS를 요구한다. 기기 인증만 요구하는 쓰기 경로(기기 승인 요청·토큰·스캔 올리기)는 `Content-Type: application/json`만 받고(그 밖 415) `Origin`이 스캐너 PWA 출처인지 확인한다. 기기 승인 요청 본문을 정의한다(빈 객체도 JSON). 관리형 크롬은 URL 허용 목록으로 스캐너 주소와 본인확인 등 필요한 주소만 연다 [가정]. 교차 출처에서 기기 인증서가 실리는지는 PoC 5.4.3에 넣는다. 초대 수락(SCR-050)·스캐너 승인(SCR-051)은 클라이언트에서 그리고, URL 조각의 토큰은 읽은 뒤 바로 주소에서 지우며 로그인 뒤 돌아갈 주소(`next`)에 넣지 않는다(탭의 세션 저장소에 잠시 둔다).
11. **관리 계정 토큰 갱신**: 파트너·운영자 액세스 토큰(15분)은 유휴 만료(1시간) 안에서 갱신 경로로 새로 받는다. 리프레시 쿠키는 파트너 `__Secure-peaket_partner_rt`(갱신 경로로 한정), 운영자 `__Host-peaket_ops_rt`(`__Host-`는 `Path=/`라 경로를 좁히지 못함)다.
12. **그 밖**: 양도 거절·철회도 수락처럼 `Idempotency-Key`를 받는다(safelisted가 아닌 헤더라 사전 요청이 생긴다). CSV·XLSX 내려받기는 `Content-Disposition: attachment`이고, `=`·`+`·`-`·`@`·탭·CR로 시작하는 칸 앞에 작은따옴표를 붙여 수식으로 읽히지 않게 한다(guidelines). 결제사 SDK의 창 메시지 출처 검사는 wbs 2.10.2에서 확인한다. ArgoCD·Grafana 화면의 쿠키·CSP는 wbs 0.4.4에서 확인하고 못 맞추면 위험 수용 ADR을 낸다.

## 검토한 대안

| 대안 | 고르지 않은 이유 |
|---|---|
| 소비자 웹 전체를 nonce CSP로 | 모든 화면이 동적 렌더링이 되어 ISR·CDN 캐시가 꺼진다(Next.js 문서). 100만 동시 접속의 공연 상세를 엣지에서 내는 구조(architecture §6.3)와 맞지 않는다. |
| CSP에 `'unsafe-inline'` 허용 | ASVS 3.4.3의 허용 목록·nonce·해시 조건을 사실상 무력화한다. |
| 대기열 API를 www와 같은 출처 경로로 받기 | 사전 요청은 없어지지만 ADR-0058의 배포 분리(한도 분리)와 부딪친다. |
| 사전 요청을 CloudFront에서 캐시 | 브라우저 쪽 사전 요청 왕복은 그대로이고 OPTIONS 요청 수도 그대로 엣지에 온다. |
| 모든 쿠키를 `__Host-`로 | `gw-fan`·`gw-queue`·엣지 함수가 같은 팬 쿠키를 읽어야 해서 `Domain`이 필요하다. |

## 결과와 트레이드오프

- 고친 문서: docs/security/asvs/ 9개 표에 V3 절, catalog-review 3.3.1·3.3.3·3.5.4, docs/api/openapi.yaml(쿠키 스킴 `fanCookie`·`partnerCookie`·`opsCookie`·`refreshCookie`, 대기열 두 경로의 `text/plain`, 사전 검증 본문, 기기 승인 본문, 관리 토큰 갱신, 양도 거절·철회), guidelines(CSRF 규칙, CSV 내려받기), infra §4.1·§9(호스트, 헤더 표), devops, architecture §4·§6.3, features(identity·queue-admission·payment·transfer-refund·offline-gate), observability(CSP 위반 지표), planning/01 §5.2(월렛 키의 XSS 한계).
- REST 경로 148개 → 150개, 작업 161개 → 163개(관리 토큰 갱신 두 경로). WBS: 13개 작업에 5일이 늘어 355일 → 360일(72.0주)이다. 늘어난 일수는 모두 [가정]이다.
- 남는 한계: SRI는 실험 기능이라 PoC가 실패하면 캐시 화면의 CSP를 다시 정해야 한다. 월렛 키는 내보낼 수 없게 만들어도(`extractable=false`) 같은 출처의 XSS가 서명을 부를 수 있어 회전 QR을 실시간으로 만들어 넘길 수 있다. `Domain` 쿠키는 PEAKET의 모든 하위 호스트로 간다. 사전 요청 없는 진입은 `Origin`과 본문 토큰에 기대므로 토큰 발급 경로의 CORS 설정이 틀리면 방어가 약해진다.

## 되돌릴 조건

- SRI PoC가 실패하면 결정 4를 바꾸는 새 ADR을 낸다.
- 부하 시험에서 `text/plain` 진입이 사전 요청을 피하지 못하거나(브라우저 동작이 바뀜) 보안 점검이 이 방식을 받아들이지 않으면 같은 출처 경로 안을 다시 본다.
