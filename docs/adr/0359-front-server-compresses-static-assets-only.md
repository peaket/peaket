# ADR-0359: 앞 서버는 정적 덩어리(/_next/static/)에만 손님의 압축 요청을 넘긴다 — HTML 해시는 그대로, CSS·JS는 원 서버가 압축

- **상태**: 채택(추천 적용, 2026-11-23, 감독 승인). [ADR-0193](0193-cached-screen-csp-response-time-inline-hashes.md) 결정 3의 넷째 점("해시는 압축 전 본문으로 낸다. 그래서 안쪽 서버에는 압축하지 말라고 보낸다")을 HTML이 될 수 있는 요청으로 좁힌다. HTML의 응답 때 해시와 압축된 HTML의 해시 없는 막는 CSP는 그대로다.
- **관련**: [ADR-0193](0193-cached-screen-csp-response-time-inline-hashes.md) 결정 3, [ADR-0326](0326-csp-same-origin-script-integrity.md)(SRI 바이트 대조), [docs/frontend.md](../frontend.md) §5.8 'Lighthouse CI'·§5.14.1, [docs/BUILD_ORDER.md](../BUILD_ORDER.md) BAT-176·BAT-177, [docs/review/plans/BAT-177-r2.md](../review/plans/BAT-177-r2.md), OPEN[52]
- **관련 ID**: BAT-177-r2, ASVS v5.0.0-3.4.3

## 맥락

- LCP(가장 큰 글·그림이 화면에 그려지기까지의 시간)를 재는 Lighthouse는 느린 휴대폰 회선(초당 1.6메가비트, 왕복 150ms)을 흉내 내고, 받은 바이트 수로 시간을 셈한다. 월렛 첫 화면 LCP 한도는 7,255ms(기준선 5,804ms에 여유 25%)다(docs/frontend.md §5.8).
- develop CI의 `budgets-reports` 산출물 다섯 개에서 월렛 LCP 다섯 번 가운데 값은 7,141 / 8,121 / 8,119 / 7,149 / 8,121ms였다. 25회 모두 LCP 요소는 QR 뼈대 그림이었고, 느리게 하지 않은 실제 분해(첫 바이트 13.7~17.1ms, 그리기 지연 110.9~132.5ms)는 작았다.
- 화면 그리기를 막는 자원(renderBlocking)에 늘 첫 화면 CSS 파일 하나가 263,674바이트로 있었고, 이것만으로 흉내 회선에서 1.5~1.65초가 들었다. 빌드 다섯 개에서 한 바이트도 다르지 않았다. 압축 없이 원본 크기로 나갔다는 뜻이다.
- 원인은 앞 서버(`apps/web/server/csp-hash-server.mjs`)였다. ADR-0193은 HTML 안 인라인 스크립트 해시를 압축 전 본문으로 내려고 **모든** 요청에 `accept-encoding: identity`를 붙여 안쪽 Next.js에 보냈고, 압축은 CDN 몫으로 두었다. 그래서 HTML이 아닌 `/_next/static/`의 CSS·JS까지 압축 없이 나갔다. CI 측정 무대와 CDN 앞 원 서버 구간에는 그 CDN 압축이 없다.
- 해시가 필요한 것은 HTML뿐이다. `/_next/static/`은 `apps/web/proxy.ts`의 matcher 밖이라 CSP 틀 머리(`x-peaket-csp-template`)를 받지 않고, 앞 서버는 지금도 그 응답을 그대로 흘려 보낸다.

## 결정

1. **정적 덩어리 요청만 손님의 `accept-encoding`을 그대로 넘긴다.** 메서드가 `GET`·`HEAD`이고, 경로(`?` 앞)가 대소문자까지 정확히 `/_next/static/`으로 시작하며, 퍼센트 인코딩(`%`)·역슬래시·빈 마디·`.`·`..` 마디가 없고 접두 뒤가 비지 않은 요청이다(`isStaticAssetRequest`). 손님 값이 빈 글이 아닌 문자열일 때만 고치지 않고 넘기고, 없거나 배열이거나 빈 글이면 `identity`다(`upstreamAcceptEncoding`). 압축은 Next.js 기본 `compress`(gzip)가 한다.
2. **그 밖은 `identity` 그대로다.** 화면 주소, 화면 데이터(RSC), `/_next/image`, public 파일(`/seed-color-mode.js` 등), 처리기, POST가 모두 여기에 든다.
3. **경로로 고른다.** Accept 머리는 손님(CDN의 원 서버 요청 포함)마다 달라 믿을 수 없고, 응답 형식은 요청 때 모른다. `/_next/static/`은 matcher 밖이라 틀 머리를 받지 않는다.
4. **판정이 틀려도 보호는 풀리지 않는다.** 정적 길로 HTML이 압축되어 와도 앞 서버는 틀 머리가 있는 압축 HTML에 해시 없이 막는 CSP를 단다(ADR-0193 결정 3). 화면이 깨질 뿐 열림 실패가 아니다(닫힘 실패). 그래서 거부 목록을 넓게 잡는다.
5. **앞 서버는 압축하지 않는다.** 위 서버의 상태·머리(`content-encoding`·`vary` 포함)와 바이트를 풀거나 다시 싸지 않고 흘린다. HTML 압축은 지금처럼 CDN 몫이다.

## 검토한 대안

- **모든 요청에 손님 압축을 넘기고 앞 서버가 풀어서 해시를 낸다**: 노드 기본 모듈로 풀 수 있지만, 캐시 화면 HTML을 다시 싸야 하고 2MiB 상한·스트리밍 처리가 복잡해진다. HTML 압축은 CDN이 이미 한다. 고르지 않았다.
- **앞 서버가 정적 응답을 스스로 압축한다**: Next.js가 이미 압축할 수 있어 같은 일을 두 번 만든다. 고르지 않았다.
- **확장자(`.css`·`.js`)나 Accept 머리로 고른다**: 확장자는 경로 판정보다 넓고(화면 주소 마지막 조각에도 점이 들 수 있다), Accept는 손님마다 다르다. 고르지 않았다.
- **한도를 넓히거나 기준선을 다시 잡는다**(OPEN[52] (가)): 원인을 고치지 않고 숫자를 옮긴다. 이 고침으로 안 풀릴 때 다시 묻는다.

## 결과

- 좋아지는 점: 정적 CSS·JS의 전송 바이트가 줄어든다(첫 화면 CSS는 수만 바이트대로 [가정]). CI 측정과 CDN 앞 원 서버 대역이 함께 준다.
- 나빠지는 점: 정적 응답에 `Vary: Accept-Encoding`이 붙어 CDN 캐시 열쇠가 인코딩마다 갈린다 [가정]. 원 서버 CPU가 조금 는다.
- 그대로인 것: HTML의 응답 때 해시, 2MiB 상한, 압축된 HTML의 해시 없는 막는 CSP, 304·HEAD·RSC 처리, 첫 JS 예산(받은 글을 스스로 gzip해 잰다), SRI 바이트 대조(풀린 본문으로 잰다, ADR-0326).
- 되돌릴 조건: CDN이 원 서버의 압축 응답을 다루지 못하거나, 정적 길(`/_next/static/`)로 HTML이 나오는 경로가 생기면 다시 정한다.
