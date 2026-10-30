# ADR-0111: 서버가 그린 화면의 SEED 스타일 속성을 화면 CSP에서 받는다 — `style-src-attr 'unsafe-inline'`만 더하고 요소·스크립트 규칙은 그대로 두며, PoC로 확정한다(2026-10-28)

- **상태**: 채택 (2026-10-28. 기술 검토(review/tech-review.md)의 높음-27 '화면 CSP의 `style-src`가 SEED Design React의 인라인 스타일 속성과 부딪쳐, 서버가 그린 화면에서 스타일이 빠진다'에 소유자가 "나머지 건수들은 모두 추천안에 동의합니다. 그렇게 모두 수정해주세요."라고 정했다. 방향은 소유자 결정(추천안 승인: PoC로 확인해 (가)·(나) 가운데 하나를 고른다)이고, (가)를 기본안으로 고른 것과 시험·기준값 같은 세부는 추천 적용이다. PoC FE-T30(wbs 2.10.1)의 결과는 아직 없다. 결과가 나오면 이 줄에 덧붙인다)
- **관련**: ADR-0040(SEED Design 채택, 소유자 결정. 바꾸지 않는다), ADR-0065(결정 4 소비자 웹 CSP), ADR-0079(결정 14 화면 묶음별 헤더, 결정 25 시험 ID), ADR-0091(Chart.js와 CSP를 확인함), NFR-012, NFR-019, NFR-020, [docs/frontend.md](../frontend.md) §5.14.1·§5.17·§6.1·§6.3·§6.4, [docs/security/asvs/frontend.md](../security/asvs/frontend.md) 3.4.3, [docs/architecture.md](../architecture.md) §6.3, [design/d2-design-system.md](../design/d2-design-system.md) §1, planning/01 §5.2, guide/17 §3.10, wbs 2.10.1, [review/tech-review.md](../review/tech-review.md)(높음-27)

## 맥락

- **지금 규칙**: 소비자 웹과 파트너 콘솔의 CSP(페이지가 실행하거나 적용할 수 있는 스크립트·스타일의 출처를 정하는 브라우저 규칙)는 화면 묶음마다 다르다(docs/frontend.md §5.14.1).
  - 캐시 화면 묶음 A(홈·공연 상세·월렛 셸 등)는 `style-src 'self'`다.
  - 요청마다 그리는 묶음 B(로그인·`/my/*`·파트너 콘솔 등)와 그 위에 더하는 E(결제)·F(좌석)는 `style-src 'self' 'nonce-{n}'`이다. nonce는 응답마다 새로 만드는 일회용 값이다.
- **SEED 부품이 스타일을 넣는 방식**(daangn/seed-design `dev` 가지, 2026-10-27 커밋 69ae3e6, 2026-10-28 원문 확인):
  - Box와 그 위에 만든 Flex·Stack, ActionButton, Dialog 본문은 여백·색·크기 같은 스타일 속성(`p`·`gap`·`bg` 등)을 `useStyleProps`(`packages/react/src/utils/styled.tsx`)로 CSS 변수(이름을 붙인 스타일 값, 예: `--seed-box-padding`)로 바꿔 HTML 요소의 `style` 속성에 넣는다.
  - Text는 `--seed-text-color`·`--seed-font-size` 등을, Grid는 `--seed-grid-columns` 등을 같은 방식으로 넣는다.
  - 값을 넘긴 스타일 속성만 나간다. React의 서버 렌더링은 빈 값을 건너뛰고, 남는 값이 없으면 `style` 속성을 쓰지 않는다(facebook/react `ReactFizzConfigDOM.js`의 `pushStyleAttribute`).
- **Next.js 이미지 부품**(`next/image`)도 `style` 속성을 낸다. 기본으로 `color: transparent`를 넣고, 부모 상자를 채우는 `fill` 이미지에는 위치·크기 값을 넣는다(vercel/next.js `get-img-props.ts`, 2026-10-28 확인).
- **서버 렌더링**(SSR: 서버가 화면 HTML을 먼저 만들어 보내는 것): Next.js는 클라이언트 컴포넌트도 서버에서 먼저 HTML로 그린다. 그래서 위 값이 HTML의 `style="…"` 속성으로 나간다.
- **CSP가 막는 것**(MDN `style-src`·`style-src-attr`·CSP 원문 문서, 2026-10-28 확인):
  - `'unsafe-inline'`이 없으면 HTML의 `style` 속성과, 스크립트가 쓰는 `setAttribute('style', …)`·`cssText`를 막는다.
  - 스크립트가 `element.style.속성 = 값`이나 `style.setProperty`로 넣는 값은 막지 않는다.
  - nonce는 `<style>`·`<link>` 요소에만 걸리고 속성에는 걸리지 않는다. 한 지시어에 nonce나 해시가 함께 있으면 브라우저는 `'unsafe-inline'`을 무시한다.
- **하이드레이션**(서버가 보낸 HTML에 브라우저 쪽 React를 붙여 움직이게 하는 일)은 속성이 서버와 달라도 고쳐 넣는다는 보장이 없다(react.dev `hydrateRoot` 문서). 그래서 서버가 그린 화면에서 SEED 값이 빠진 채로 남는다. 그 부품의 값이 브라우저에서 바뀔 때 바뀐 값만 들어간다. 막힌 속성마다 위반 보고가 생길 수 있어, CSP 위반 수집(`/_t/csp`)과 급증 경보도 흐려진다.
- **막히지 않는 앱**: 브라우저에서만 그리는 관제 콘솔·스캐너·포렌식 데모는 React가 `style.setProperty`·`style[이름]`으로 값을 넣어 막히지 않는다(facebook/react `CSSPropertyOperations.js`). ADR-0091은 Chart.js가 이 방식만 쓴다는 것을 확인했다. 대기실 경량 페이지는 React와 SEED를 쓰지 않는다.
- **어느 ADR도 다루지 않았다**: SEED 채택(ADR-0040, 소유자 결정)과 화면 CSP(ADR-0065 결정 4, ADR-0079 결정 14)가 서로 부딪치는데, 두 쪽 모두 이 조합을 보지 않았다. SEED 채택은 그대로 둔다.
- **브라우저 지원**(MDN 브라우저 호환 자료 `http/headers/Content-Security-Policy.json`, 2026-10-28 확인): `style-src-attr`는 Chrome 75·Firefox 108·Safari 15.4부터 쓴다. NFR-019의 지원 범위(최신 2개 판, iOS·iPadOS 16.4 이상)는 모두 든다. 요소만 따로 정하는 `style-src-elem`은 Safari 15.4~26.1에서 읽기만 하고 효과가 없었다(WebKit 버그 276931, 26.2에서 고침).
- **ASVS 3.4.3**(OWASP ASVS 5.0 원문): CSP를 두는 목적을 '악성 JavaScript 실행을 줄이는 것'으로 적고, `object-src 'none'`·`base-uri 'none'`과 허용 목록이나 nonce·해시를 담은 정책을 요구한다. 스타일 속성은 이 조건에 들지 않는다.

## 결정

1. **PoC로 확인해 (가)·(나) 가운데 하나를 고른다(소유자 승인). 지금 기본안은 (가)다(추천 적용).**
   - (가) 화면 묶음 A·B(그 위의 E·F 포함)에 `style-src-attr 'unsafe-inline'`만 더한다.
   - (나) 서버가 그리는 부품은 SEED 스타일 속성 대신 클래스(Tailwind·SEED 레시피)만 쓰게 하고 린트로 막는다.
   - (가)를 기본으로 고른 이유: SEED 부품을 그대로 쓴다(ADR-0040 결정 6). 스크립트 규칙과 `<style>` 요소 규칙은 그대로다. 우리 코드 밖에서 나오는 속성(`next/image`)도 함께 산다. (나)는 Next 앱이 클라이언트 컴포넌트까지 서버에서 그리므로 소비자 웹·파트너 콘솔의 거의 모든 화면에서 SEED 스타일 속성을 쓰지 못하게 하고, 우리 코드 밖의 속성은 린트로 잡지 못한다.
2. **(가)의 정책 문자열(추천 적용).**
   - `style-src`는 그대로다. A는 `'self'`, B·E·F는 `'self' 'nonce-{n}'`이다. `<style>` 요소와 스타일시트 파일은 이것으로만 받는다.
   - `style-src-attr`에는 `'unsafe-inline'` 하나만 둔다. 해시나 nonce를 섞으면 `'unsafe-inline'`이 무시되므로 섞지 않는다.
   - `style-src-elem`은 두지 않는다. Safari 26.2 전에는 효과가 없어, 요소 쪽 제한은 `style-src`가 맡게 둔다.
   - A′(대기실 경량 페이지)·C(관제)·D(스캐너)·G(포렌식 데모)는 바꾸지 않는다.
   - 헤더는 32자 늘어난다. CloudFront 응답 헤더 정책의 CSP 상한 1,783자(ADR-0065) 안이다.
3. **스타일 속성의 값은 토큰과 코드 상수에서만 온다(추천 적용).**
   - SEED 스타일 속성과 `style`에는 디자인 토큰 이름이나 코드에 적은 값만 넣는다. 사용자·파트너가 넣은 값(색·크기·글)은 넣지 않는다. React는 이 값을 HTML 문자로만 바꿔 쓰고 CSS 문법은 거르지 않는다(React 소스 주석).
   - 토큰 린트(design/d4 #2)가 SEED 스타일 속성에 토큰 밖의 값과 바깥 입력에서 온 변수를 넣는 것을 막는다.
   - 코드에서 `<style>` 요소를 만들지 않는다. 정화한 서식 글(공연 설명)은 지금처럼 속성·스타일을 지운다(docs/security/asvs/catalog-review.md 1.3.1).
4. **PoC FE-T30으로 잰다(추천 적용).** wbs 2.10.1의 CSP PoC에 넣는다.
   - 대상: 운영 빌드와 운영 헤더(묶음 A·B·E·F)로 서버가 그린 시험 화면. SEED 부품(Box·Flex·Stack·Text·ActionButton·Dialog·Grid)과 `next/image`(`fill` 포함)를 담는다.
   - 방법: Playwright(브라우저 자동 시험 도구)의 세 엔진(Chromium·Firefox·WebKit)에서 CSP를 끄지 않고(`bypassCSP` 없이) 연다. 서버가 그린 부품의 계산된 스타일을 같은 부품을 브라우저에서만 그린 것과 비교한다.
   - 함께 잴 것: (가)를 넣기 전과 뒤의 style 속성 위반 보고 수, 경로별 서버 HTML의 `style` 속성 수와 그 출처(우리 스타일 속성·SEED 내부·`next/image`). nonce 없는 `<style>` 요소와 인라인 스크립트를 넣어 보고 계속 막히는지도 본다.
   - 합격: 세 엔진 모두 계산된 스타일 차이 0, style 속성 위반 보고 0, nonce 없는 `<style>`·인라인 스크립트는 막힘, 헤더 값이 docs/frontend.md §5.14.1과 같다(FE-T16).
   - 결과는 docs/frontend.md §6.3과 이 ADR의 상태 줄에 적는다. 지금은 결과가 없다.
5. **바꿀 조건(추천 적용).**
   - (나)로 바꾼다: FE-T30에서 지원 브라우저 하나라도 `style-src-attr`로 값을 살리지 못할 때, 보안 점검(ASVS 판정·침투 시험)이 style 속성 허용을 받아들이지 않을 때, 정화기를 거치지 않고 HTML을 그리는 길이 새로 생길 때다. 그때는 서버 HTML의 `style` 속성을 0으로 막는 검사를 FE-T30에 더하고, `next/image`처럼 우리 코드 밖에서 속성을 내는 부품은 감싼 부품으로 바꾼다.
   - `style-src-attr`를 뺀다(조인다): FE-T30에서 서버 HTML의 `style` 속성이 모두 우리 스타일 속성에서만 나오고 그것을 클래스로 바꿀 수 있을 때, 또는 SEED가 CSS 변수를 속성 대신 클래스로 넣게 바뀔 때다.
6. **정본 반영(추천 적용).** docs/frontend.md §5.14.1(머리 문단과 묶음 A·B 문자열)·§5.17(FE-T30)·§6.1·§6.3(PoC 줄과 남는 한계)·§6.4(확인한 사실), docs/security/asvs/frontend.md 3.4.3, docs/architecture.md §6.3, design/d2-design-system.md §1, planning/01 §5.2, guide/17 §3.10을 고친다. ADR-0065(결정 4)·ADR-0079(결정 14)는 상태 줄에만 적는다.
7. **일정(추천 적용).** wbs 2.10.1에 FE-T30을 더해 7일을 7.25일로 본다(WBS 반영은 메인 세션이 한다).

## 검토한 대안

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 |
| --- | --- | --- | --- |
| (가) `style-src-attr 'unsafe-inline'`만 더한다(이 결정) | SEED 부품을 그대로 쓴다. 스크립트·`<style>` 요소 규칙이 그대로다. `next/image` 속성도 산다. 헤더가 32자 늘 뿐이다 | HTML 주입이 생기면 주입한 요소의 모양을 바꿔 화면을 위장할 수 있다(남는 한계) | 기본안 |
| (나) 서버가 그리는 부품은 클래스만 쓰고 린트로 막는다 | CSP를 넓히지 않는다 | 웹·파트너의 거의 모든 화면에서 SEED 스타일 속성을 쓸 수 없다. `next/image`(`fill`)처럼 우리 코드 밖의 속성은 린트로 잡지 못해 감싸야 한다. SEED 판을 올리며 속성이 늘면 다시 깨진다 | 바꿀 조건(결정 5)이 오면 |
| 속성 값을 해시로 허용(`'unsafe-hashes'`와 해시) | 정해 둔 값만 받는다 | 값이 부품·화면마다 달라 빌드 때 모든 조합을 셀 수 없다. 해시가 늘면 CSP 상한(1,783자)에 걸린다 | 쓰지 않는다 |
| `style-src`에 `'unsafe-inline'`(요소까지) | 가장 쉽다 | `<style>` 요소 주입까지 열려 선택자로 화면 전체를 바꿀 수 있다. B·E·F는 nonce가 있어 브라우저가 `'unsafe-inline'`을 무시하므로 효과도 없다 | 쓰지 않는다 |
| SEED 부품을 서버에서 그리지 않는다(`ssr: false`) | CSP를 넓히지 않는다 | 첫 화면이 비어 LCP(화면에서 가장 큰 요소가 그려지는 시간, NFR-012)와 검색 노출이 나빠진다. 캐시 화면 구조(ADR-0065)와 맞지 않는다 | 쓰지 않는다 |
| 하이드레이션 뒤 스크립트로 값을 다시 넣는다 | CSP를 넓히지 않는다 | 스크립트가 돌기 전까지 모양이 틀려 화면이 밀린다(CLS, NFR-012). 모든 부품을 감싸야 한다 | 쓰지 않는다 |
| SEED 부품을 고쳐 값을 nonce 붙은 `<style>`로 낸다 | 속성을 쓰지 않는다 | SEED를 고쳐 써야 한다(ADR-0040 결정 6의 '그대로 쓰거나 그 위에 변형만 더한다'와 다르다). 캐시 화면 A는 nonce를 쓸 수 없다 | 쓰지 않는다 |

## 결과와 트레이드오프

- 서버가 그린 화면에서 SEED 값이 살아 있게 된다. PoC 전이라 아직 기본안이다.
- 스크립트 실행을 막는 규칙(ASVS 3.4.3이 보는 것)은 그대로다. ADR-0065가 검토한 대안 'CSP에 `'unsafe-inline'` 허용'을 버린 이유는 스크립트 조건을 무력화하기 때문이었다. 이 결정은 스크립트에 `'unsafe-inline'`을 두지 않으므로 그 판단과 부딪치지 않는다.
- 'HTML에 `style` 속성이 0'이라는 단순한 점검 기준은 쓸 수 없다. 대신 속성 값의 출처 규칙(결정 3)과 FE-T30의 출처 집계로 본다.
- 새 시험 ID는 FE-T30이다. 문제 대장 R- 번호와 질문 번호, WBS 반영은 메인 세션이 붙인다.

## 되돌릴 조건

- 결정 5의 조건이 오면 (나)로 바꾸거나 `style-src-attr`를 뺀다.
- FE-T30에서 기본안이 합격하지 못하면 결과를 이 ADR의 상태 줄에 적고 (나)로 다시 정한다.

## 남는 한계

- HTML 주입(스크립트 없이 마크업만 끼워 넣는 공격)이 생기면, 공격자는 넣은 요소의 `style` 속성으로 화면 일부를 덮거나 숨겨 사용자를 속일 수 있다(예: 결제 버튼 위에 가짜 버튼 겹치기). 속성에는 선택자가 없어 다른 요소의 값을 읽는 CSS 공격은 할 수 없다. 바깥 주소로 무언가를 보내는 것은 `img-src`·`font-src`가 같은 출처(와 `data:`·`blob:`)만 받아 막는다.
  - 막는 것: React 텍스트 출력, `dangerouslySetInnerHTML` 금지 린트, 서식 글 정화(속성·스타일 제거), Trusted Types(보고 모드부터, docs/frontend.md §5.14.1).
  - 남는 것: 이 장치들이 뚫렸을 때의 화면 위장이다.
- PoC 결과가 나오기 전에는 기본안이다.
- 지원 범위 밖의 옛 브라우저(`style-src-attr`를 모르는 판)에서는 `style-src`로 되돌아가 SEED 값이 빠진다.
