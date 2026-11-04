# D-34: 스타일은 왜 Tailwind(유틸리티 클래스로 쓰는 CSS) + 디자인 토큰(색·간격 같은 디자인 값에 붙인 이름)이고, 실행 중에 스타일을 만드는 CSS-in-JS가 아닌가? 폼은 왜 React Hook Form + Zod(스키마 검증 도구)이고, Formik·Enzyme은 왜 쓰지 않나?

- **기준 시점**: ADR-0177까지, 2026-11-01
- **지금 판의 근거**: [ADR-0019](../../adr/0019-reject-aphrodite-fela.md), [ADR-0111](../../adr/0111-csp-style-src-attr-for-server-rendered-seed-style-props.md), [ADR-0020](../../adr/0020-forms-rhf-zod-over-formik.md), [ADR-0018](../../adr/0018-reject-enzyme.md)(모두 상태 줄 포함), [ADR-0097](../../adr/0097-remove-learning-map-appendix-rationale-in-canon.md), docs/architecture.md §6.1의 '일부러 쓰지 않거나 미룬 기술' 표와 §6.5, docs/design/d2-design-system.md §1, docs/frontend.md §2.2·§5.8·§5.14
- **규범이 아니다**: 정본을 풀어 쓴 해설이고 새 결정을 담지 않는다. 숫자와 규칙이 정본과 다르면 정본이 맞다([ADR-0177](../../adr/0177-walkthrough-explain-in-interview.md)).
- **함께 읽기**: [분야 편 6 프론트엔드 구조](../fields/06-frontend.md), [분야 편 5 디자인 시스템](../fields/05-design-system.md), [분야 편 21 보안](../fields/21-security.md), 결정 카드 D-32(화면 그리는 방식). 한 판 문서에는 이 결정의 단계가 없다.

## 1. 풀려던 문제

- 소비자 웹은 Next.js App Router의 React 서버 컴포넌트(서버에서 그려 HTML로 보내는 React 부품)를 쓰고, 공연 상세처럼 CDN(사용자 가까이 복사해 두고 대신 응답하는 전송망)이 캐시하는 화면이 많다(결정 카드 D-32).
- 런타임 CSS-in-JS(Aphrodite·Fela처럼 브라우저가 실행 중에 `<style>`을 만들어 넣는 방식)는 서버 컴포넌트와 맞지 않고, 브라우저에서 스타일 계산 비용이 들어 FCP(첫 내용이 그려지는 시간)와 TBT(메인 스레드가 막힌 시간)를 해친다(ADR-0019 맥락, NFR-012).
- CSS 예산은 홈·상세 25KB, 결제 20KB `[가정]`이다. SEED Design(당근이 공개한 디자인 시스템) 전체 CSS는 gzip 42.2KiB라 싣지 않는다. 2026-10-28에 재 보니 base 7.8KiB에 흔한 부품 34개의 recipe(부품마다 따로 낸 CSS)를 더하면 약 25.5KiB였다(docs/frontend.md §5.8).
- 결제 직전 폼에서 렌더링이 늦으면 이탈로 이어진다. 검증 규칙은 화면과 서버가 같이 써야 한다(ADR-0020 맥락).
- 화면 라이브러리는 React 19다. Enzyme(옛 React 부품 시험 도구)의 공식 어댑터는 React 16까지만 유지됐다(ADR-0018 맥락).
- SEED 부품은 여백·색 값을 HTML `style` 속성으로 넣는다. 서버가 그린 화면에서는 CSP(페이지가 적용할 스크립트·스타일의 출처를 정하는 브라우저 규칙)가 이것을 막아 SEED 값이 빠진다(ADR-0111 맥락).

## 2. 후보 비교

| 후보 | 좋은 점 | 문제 | 판정 |
| --- | --- | --- | --- |
| Tailwind v4 + 디자인 토큰 + SEED | 빌드할 때 CSS를 만들어 서버 컴포넌트와 맞고, 실행 중 스타일 계산이 없다 | CSS 변수와 유틸리티 클래스 규칙을 계속 지켜야 하고, CSS 예산이 빠듯하다 | 채택 |
| Aphrodite·Fela(런타임 CSS-in-JS) | 정본에 없음 | 서버 컴포넌트와 맞지 않고, 실행 비용과 번들(브라우저가 받는 코드 묶음)이 늘며, Tailwind와 역할이 겹친다 | 문서 근거로 기각(ADR-0019) |
| SEED `style` 속성: `style-src-attr 'unsafe-inline'`만 더하기 | SEED 부품을 그대로 쓰고, 스크립트·`<style>` 요소 규칙은 그대로다. 헤더가 32자 늘 뿐이다 | HTML 주입(스크립트 없이 마크업만 끼워 넣는 공격)이 생기면 넣은 요소의 모양을 바꿔 화면을 위장할 수 있다 | 기본안(ADR-0111, PoC(미리 재 보는 시험)로 확정) |
| SEED `style` 속성: 서버 부품은 클래스만 쓰고 린트로 막기 | CSP를 넓히지 않는다 | 웹·파트너의 거의 모든 화면에서 SEED 스타일 속성을 못 쓴다. `next/image`처럼 우리 코드 밖의 속성은 린트로 못 잡는다 | 바꿀 조건이 오면(ADR-0111) |
| `style-src`에 `'unsafe-inline'`(요소까지) | 가장 쉽다 | `<style>` 요소 주입까지 열린다. nonce(응답마다 새로 만드는 일회용 값)가 있는 화면에서는 브라우저가 무시해 효과도 없다 | 쓰지 않는다(ADR-0111) |
| React Hook Form + Zod | 비제어 입력(값을 React 상태가 아니라 입력 요소가 들고 있는 방식)이라 키를 누를 때마다 폼 전체를 다시 그리지 않는다. 화면과 서버가 같은 스키마를 쓴다 | 제어형 외부 UI 부품을 붙일 때 `Controller` 감싸기가 든다 | 채택(ADR-0020) |
| Formik + Yup | 정본에 없음 | 제어 입력이라 키 입력마다 최상위 폼을 다시 평가한다. TypeScript 타입 추론이 Zod보다 약해 서버와 스키마 공유에 불리하다 | 기각(ADR-0020) |
| Enzyme(비공식 React 18 어댑터) | 정본에 없음 | React 19 프로젝트의 공식 시험 기반이 될 수 없고, 서버 컴포넌트를 지원하지 않는다 | 기각(ADR-0018) |

## 3. 고른 이유

- **스타일은 빌드할 때 만든다**: Tailwind v4는 빌드할 때 CSS를 만든다. 런타임 CSS-in-JS는 서버 컴포넌트에서 쓸 수 없고 Tailwind와 역할이 겹친다. 이 판단은 실험이 아니라 문서의 사실로 했고, 약속했던 PoC는 하지 않는다(ADR-0019 상태 줄, ADR-0097).
- **디자인 값은 한 곳에서 나온다**: `docs/design/tokens.json`을 단일 원본으로 두고 Style Dictionary(토큰을 여러 형식으로 바꾸는 빌드 도구)가 CSS 변수, Tailwind `@theme`, TypeScript 상수를 만든다. 원시 색을 직접 참조하면 린트(코드 규칙 검사기)가 막는다(docs/architecture.md §6.5, d2 §1).
- **SEED 값은 속성만 열어 받는다**: 서버가 그린 SEED 부품과 `next/image`(Next.js 이미지 부품)의 `style` 속성은 `style-src-attr 'unsafe-inline'`으로 받는다. 스크립트 규칙(웹 보안 검증 기준 ASVS 3.4.3이 보는 것)과 `<style>` 요소 규칙은 그대로다. 속성 값에는 토큰과 코드 상수만 넣는다(ADR-0111 결정 1~3).
- **폼은 비제어 입력과 계약에서 만든 스키마다**: React Hook Form은 비제어 입력이라 결제 직전 폼의 다시 그리기를 줄인다. 요청·응답 Zod 스키마는 API 계약(openapi)에서 orval(계약에서 코드를 만드는 도구)이 만들어 화면과 서버가 함께 쓴다. 손으로 쓰는 Zod는 계약에 적을 수 없는 규칙만 남긴다(ADR-0020 상태 줄, docs/frontend.md §2.2).
- **시험은 사용자 관점이다**: Enzyme 대신 React Testing Library(사용자가 보는 역할·글자로 부품을 찾는 시험 도구) + Vitest(시험 실행 도구)로 부품을, 실제 브라우저 API는 Vitest 브라우저 모드로, E2E(처음부터 끝까지 사용자처럼 누르는 시험)는 Playwright(브라우저 자동 시험 도구)로 한다(ADR-0018 상태 줄).

## 4. 얻는 것과 치르는 값

**얻는 것**

- 브라우저에서 실행 중 CSS를 만드는 비용이 없다. 대기실 경량 페이지도 같은 토큰의 부분집합 CSS를 쓴다.
- 서버가 그린 화면에서 SEED 값이 살아 있고, 스크립트를 막는 규칙은 그대로다.
- 검증 규칙이 계약 하나에서 나와 화면과 서버가 어긋날 곳이 준다. 시험이 부품 내부 구현에 묶이지 않는다.

**치르는 값**

- CSS 변수와 유틸리티 클래스의 규칙을 계속 지켜야 한다. CSS 예산이 빠듯해, 넘치면 그 화면의 부품을 줄이거나 실측으로 예산을 고친다(docs/frontend.md §5.8).
- HTML 주입이 생기면 `style` 속성으로 결제 버튼 위에 가짜 버튼을 겹치는 식의 화면 위장이 남는다. React 텍스트 출력, `dangerouslySetInnerHTML` 금지 린트, 서식 글 정화, Trusted Types(화면에 넣는 문자열을 검사하는 브라우저 기능) 보고 모드가 막는다(ADR-0111 남는 한계).
- 'HTML에 `style` 속성 0건'이라는 단순한 점검 기준을 쓸 수 없다. `style-src-attr`를 모르는 옛 브라우저에서는 SEED 값이 빠진다.
- 제어형 외부 UI 부품마다 `Controller`를 써야 한다. 얕은 렌더링(부품 하나만 그리고 자식은 그리지 않는 시험 방식)으로 내부 상태를 단언할 수 없다.

## 5. 바꿀 조건

- PoC FE-T30(wbs 2.10.1)에서 지원 브라우저 하나라도 `style-src-attr`로 값을 살리지 못하거나, 보안 점검이 `style` 속성 허용을 받아들이지 않거나, 정화기를 거치지 않고 HTML을 그리는 길이 새로 생기면 '서버 부품은 클래스만' 안으로 바꾼다(ADR-0111 결정 5).
- 서버 HTML의 `style` 속성이 모두 우리 스타일 속성에서만 나와 클래스로 바꿀 수 있거나, SEED가 CSS 변수를 클래스로 넣게 바뀌면 `style-src-attr`를 뺀다(같은 결정).
- 스타일 도구(ADR-0019), 폼 도구(ADR-0020), 시험 도구(ADR-0018)를 다시 볼 조건은 정본에 없다.

## 6. 바뀐 역사

- 2026-10-05·08 ADR-0018·0019·0020: 원문 설계서 §13의 선택을 ADR로 옮겼다. ADR-0019 제목은 'PoC 후 기각'이었다.
- 2026-10-11 ADR-0040: 화면의 시각 토대를 SEED Design으로 정했다(소유자 결정).
- 2026-10-26 4차 점검 3부: ADR-0019의 PoC가 wbs에 없다고 적었다. ADR-0020의 공통 패키지는 `@peaket/validation`으로 읽는다.
- 2026-10-27 ADR-0097: ADR-0019의 PoC는 하지 않는다. 기각 근거는 서버 컴포넌트 비호환과 Tailwind와의 역할 중복이다.
- 2026-10-28 기술 검토 중간-020: ADR-0018의 `@web/test-runner` + mocha + chai + sinon을 Vitest 브라우저 모드로 바꿨다.
- 2026-10-28 기술 검토 중간-085: Zod 스키마의 원본은 openapi 계약이고 orval이 만든다.
- 2026-10-28 ADR-0111: 서버가 그린 SEED 스타일 속성을 `style-src-attr 'unsafe-inline'`으로 받는다.
- 2026-10-28 기술 검토 중간-097·낮음-137: SEED CSS는 쓰는 부품의 recipe만 층 판(CSS 층으로 묶은 판)으로 싣는다. ADR-0019의 'PoC 후 기각'은 '문서 분석으로 기각'으로 읽는다.
- 2026-10-30 ADR-0165: 내부 패키지는 게시하지 않고 `workspace:`로 잇는다. 계약에서 만든 코드는 `packages/contracts`에 둔다.
- 2026-11-01 추천 적용(FND-030, R-219): 요청·응답 Zod는 `contracts` 한 곳에서 만들고 `validation`은 그것을 다시 내보낸다(docs/frontend.md §2.2).

## 7. 꼬리 질문 5단

| 단 | 질문 | 답의 요지 | 근거 |
| --- | --- | --- | --- |
| 왜 | 왜 CSS-in-JS를 안 쓰나요? | 실행 중에 `<style>`을 만드는 방식은 서버 컴포넌트에서 쓸 수 없고, 브라우저 스타일 계산 비용이 들며, 빌드 때 CSS를 만드는 Tailwind와 역할이 겹친다 | ADR-0019 맥락, docs/architecture.md §6.1 |
| 다른 방법은 | Formik은 왜 안 되나요? | 제어 입력이라 키를 누를 때마다 최상위 폼을 다시 평가하고, TypeScript 타입 추론이 Zod보다 약해 서버와 스키마를 나누기 불리하다 | ADR-0020 검토한 대안 |
| 고장 나면 | `style` 속성을 열어 두면 위험하지 않나요? | 스크립트는 여전히 막는다. 남는 위험은 HTML 주입 때의 화면 위장이다. 속성에는 선택자가 없어 다른 요소의 값을 읽는 CSS 공격은 못 하고, 바깥 주소로 보내기는 `img-src`·`font-src`가 같은 출처만 받아 막는다 | ADR-0111 남는 한계 |
| 숫자의 근거는 | CSS 25KB는 어디서 나왔나요? | 경로별 예산은 `[가정]`이다. 42.2KiB·7.8KiB(2026-10-21 PC)와 약 25.5KiB·19.1KiB(2026-10-28)는 SEED 패키지의 CSS를 직접 잰 값이고 성능 장부에는 없다. 그래서 예산이 빠듯하다고 적었다 | docs/frontend.md §5.1·§5.8 |
| 실제로 해 봤나 | Aphrodite·Fela를 재 보고 버렸나요? | 아니다. 문서 근거로 기각했고 PoC는 하지 않는다. FE-T30도 결과가 없다. 지금 화면은 퍼블리싱 단계라 `@peaket/ds`의 겉모양은 캔버스 키트(디자인 시안 모양을 옮긴 CSS)이고, 부품 속을 SEED로 바꾸는 일은 wbs 0.6.2다. `validation` 패키지도 아직 없다 | ADR-0019·0097·0111 상태 줄, docs/frontend.md §2.2 |

## 8. 30초 설명

> "스타일은 Tailwind와 디자인 토큰으로 빌드할 때 CSS를 만듭니다. 실행 중에 스타일을 만드는 CSS-in-JS는 서버 컴포넌트에서 쓸 수 없고 Tailwind와 역할이 겹쳐서, 실험이 아니라 문서 근거로 뺐습니다. 다만 SEED 부품이 여백 값을 `style` 속성으로 넣어서, 화면 CSP는 스크립트와 `<style>` 요소는 그대로 막고 `style` 속성만 받게 했고, PoC로 확정합니다. 폼은 비제어 입력이라 다시 그리기가 적은 React Hook Form에, API 계약에서 만든 Zod 스키마를 화면과 서버가 함께 씁니다. Enzyme은 React 19용 공식 어댑터가 없어 React Testing Library와 Vitest, Playwright로 시험합니다."
