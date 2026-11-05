# ADR-0204: 서식 글 편집기(CMP-070)는 Lexical로 하고, 붙여넣은 HTML은 걷어 낸 뒤 해석 전용 Trusted Types 정책으로 해석한다

- **상태**: 채택(2026-11-05, 추천 적용). BUILD_ORDER HOT-322.
  - 판정 규칙은 정본에 있다(FE-T41: "두 후보가 모두 통과하면 덩어리가 작은 쪽을 고른다").
  - 다만 이 PoC에서 기준 둘을 바꿨다. 덩어리 80KB는 [가정]이었고 FE-T41이 확정할 값이라, 잰 값으로 90KB로 정했다. 위반 0은 편집기가 낸 위반으로 좁혔다. Next.js가 늦게 싣는 덩어리의 위반은 편집기와 상관없이 늦게 싣는 모든 화면에 있다(결정 4).
- **관련**: [docs/design/d2-design-system.md](../design/d2-design-system.md) CMP-070, [docs/frontend.md](../frontend.md) §5.6 늦게 싣기 표·§5.14.3 '출력'·FE-T41, [docs/security/asvs/catalog-review.md](../security/asvs/catalog-review.md) 1.3.1, [tools/web-checks/rich-text/RESULT.md](../../tools/web-checks/rich-text/RESULT.md)
- **관련 ID**: FE-T41, CMP-070, SCR-021

## 맥락

- 공연 설명(SCR-021 1단계)은 서식 글이다.
  - 기본안은 HTML이 아니라 허용 노드 다섯만 담은 구조 문서(JSON)로 저장하는 것이다. 다섯은 문단·줄바꿈·강조·목록·제목이다.
  - 보여 줄 때는 노드마다 React 요소로 그린다.
- 편집기 후보는 Lexical과 Tiptap이다. FE-T41은 두 후보를 파트너 운영 헤더(묶음 B)와 Trusted Types 보고 모드에서 열어 본다.
  - Word·웹 페이지 글을 붙여넣는다.
  - 구조 문서로 저장하고 다시 그린다.
  - 늦게 싣는 덩어리 크기와 키보드·역할을 잰다.

## 결정

1. **편집기는 Lexical(0.53.0)이다.**
   - 2026-11-05 PoC(`tools/web-checks/rich-text`, Chromium·WebKit)에서 두 후보 모두 구조 문서 기준을 넘었다. 허용 노드 밖 노드·속성 0, 다시 그린 글이 편집기 화면과 같음, 굵게 단축키, `textbox`·`toolbar` 역할이다.
   - 차이는 둘이다.
     - 편집기가 낸 위반: Lexical은 0이다. Tiptap은 ProseMirror 안의 `DOMParser.parseFromString`이 Trusted Types 위반을 냈다. 해석이 라이브러리 안에 있어 우리 정책을 넘길 수 없고, 막는 모드로 가면 넓은 `default` 정책이 필요하다.
     - 늦게 싣는 덩어리(gzip): Lexical 88.5kB, Tiptap 123.8kB다.
     - 붙여넣은 h1: Lexical은 제목(h2)으로 남기고, Tiptap은 제목 단계를 2·3으로 두면 문단으로 바꾼다.
2. **붙여넣은 HTML은 해석하기 전에 걷어 낸다**(`precleanPastedHtml`).
   - Chromium은 해석만 하는 문서에서도 `<style>`과 이벤트 속성(`on…`)을 막고 CSP 위반을 보고한다. Word 글에는 `<style>`이 늘 있다. 그래서 다음을 지운다.
     - `<style>`·`<script>`·`<meta>`·`<link>`·`<img>`
     - 주석
     - `on…`·`style` 속성
   - 해석은 이름 붙인 Trusted Types 정책 `peaket-paste`로 한다. 해석한 문서는 화면에 붙이지 않고 노드만 읽는다.
   - 막는 모드에서 그 이름이 허용 목록에 없어 정책을 만들지 못하면, HTML을 해석하지 않고 글자판으로 넣는다. OPS-340이 허용 목록에 `peaket-paste`를 넣는다.
   - 거름은 꼬리표 안의 따옴표를 지키고, 바뀌지 않을 때까지(8번까지) 되풀이한다. 걷은 자리에서 꼬리표가 되살아나지 않게 하려는 것이다.
   - 안전은 저장할 때의 구조 문서 거름이 맡는다(`fromLexical`, `validateDoc`, 서버 Zod). 이 단계는 위반 보고를 줄이는 거름이다.
3. **덩어리 예산을 90KB로 확정한다.** docs/frontend.md §5.6의 80KB [가정]이다. 잰 값 88.5kB에 여유를 조금 두었다.
4. **Next.js가 늦게 싣는 덩어리의 Trusted Types 위반은 따로 넘긴다.** `next/dynamic`이 덩어리를 `<script src>`로 넣으면서 위반 두 건이 났다. 편집기와 상관없이 늦게 싣는 모든 화면에 있다. 관제·파트너 콘솔 CSP와 보안 헤더 단계(BUILD_ORDER OPS-340)가 Next.js의 Trusted Types 정책 이름을 허용 목록에 넣을지 함께 정한다.
5. **구조 문서와 변환 함수는 파트너 콘솔에 둔다**(`apps/partner/src/features/rich-text/doc.ts`). 공연 등록 위저드 단계(HOT-180)가 실제 CMP-070을 만들 때 다음을 한다.
   - 소비자 웹 그리기(`DocView`)와 서버 Zod(core-svc)를 같은 규칙으로 옮긴다.
   - PoC 시험(`tools/web-checks/rich-text`)을 실제 위저드 화면으로 옮긴 뒤(Firefox와 CI 잡도) PoC 화면과 Tiptap 의존성을 걷는다.

## 결과

- 공연 설명은 HTML 정화 대체안(DOMPurify)을 쓰지 않는다. 그래서 docs/frontend.md §5.14.3의 `dangerouslySetInnerHTML` 예외가 생기지 않는다.
- Lexical 붙여넣기는 우리 처리기(`PASTE_COMMAND`, 높은 우선순위)가 맡는다.
  - Lexical 판을 올릴 때 이 처리기와 `$generateNodesFromDOM`·`$insertGeneratedNodes`가 그대로인지 시험으로 다시 본다.
  - 지금 시험 명령은 `node rich-text/build.mjs` 뒤 `pnpm run rich-text`다. HOT-180이 이 시험을 실제 위저드 화면으로 옮긴다.
- Firefox는 이 PC에서 Playwright가 뜨지 않아 재지 못했다. 이 시험의 CI 잡은 아직 없고, HOT-180이 시험을 옮길 때 Firefox와 함께 올린다.

## 다른 선택지

| 길 | 고르지 않은 까닭 |
| --- | --- |
| Tiptap(+ `default` Trusted Types 정책) | `default` 정책은 모든 HTML 싱크를 통과시키는 넓은 길이라 Trusted Types의 뜻이 약해지고, 덩어리가 35kB 크다 |
| HTML 정화 대체안(DOMPurify, asvs/catalog-review 1.3.1) | 두 후보 모두 구조 문서 기준을 넘어 갈 까닭이 없다. 정화한 HTML을 넣는 예외 컴포넌트가 생긴다 |
| 붙여넣기를 걷지 않고 위반 보고를 받아들인다 | 붙여넣을 때마다 보고가 쌓여 진짜 위반이 묻힌다 |
