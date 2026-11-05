# FE-T41 서식 글 편집기 PoC 결과(BUILD_ORDER HOT-322, ADR-0204)

- 날짜: 2026-11-05
- 빌드: 파트너 콘솔 PoC 빌드(`PEAKET_POC=rich-text`, `apps/partner/.next-rich-text`). 화면은 `/poc/rich-text?editor=lexical|tiptap`이다.
- 헤더: `apps/partner/proxy.ts`가 그 경로에만 묶음 B CSP와 Trusted Types 보고 모드(`require-trusted-types-for 'script'`)를 단다.
  - 묶음 B CSP: 요청마다 nonce, `'strict-dynamic'`, 파트너 변형
- 판: lexical·@lexical/* 0.53.0, @tiptap/* 3.32.2
- 엔진: Chromium·WebKit(Playwright 1.64.1). Firefox는 이 PC에서 뜨지 않아(spawn UNKNOWN) 재지 못했다. CI 잡은 아직 없다(HOT-180이 실제 위저드로 옮길 때 올린다).
- 다시 재기: 검사 패키지 폴더에서 아래 두 명령을 차례로 돌린다. 잰 값은 `reports/rich-text.json`에 남는다.

```bash
node rich-text/build.mjs
```

```bash
pnpm run rich-text
```

| 기준(FE-T41) | Lexical | Tiptap |
| --- | --- | --- |
| 허용 노드 다섯 밖 노드·속성 | 0 | 0 |
| 다시 그린 글 = 편집기 화면 | 같음 | 같음 |
| 스크립트·이벤트 속성·주소가 문서에 남음 | 없음 | 없음 |
| 굵게 단축키, `textbox`(여러 줄)·`toolbar` 역할 | 됨 | 됨 |
| 블록 차례(h1→h2·문단·글머리 목록 3·번호 목록·문단 셋·h3·문단 둘) | 같음 | 붙여넣은 h1이 문단(제목 단계 2·3 설정) |
| 편집기가 낸 CSP·Trusted Types 위반 | 0 | Trusted Types 1(`DOMParser parseFromString`, ProseMirror 안) |
| 늦게 싣는 덩어리(gzip, 파일 2개) | 88.5kB | 123.8kB |
| 처음 그리기 JS(gzip, PoC 화면) | 146.7kB | 146.7kB |

- 붙여넣은 글은 Word 꼴 HTML이다.
  - Office 꼬리표, `<style>`, 표, 그림(`onerror`), `<script>`, `javascript:` 링크, 색 글자(`onclick`)
  - 제목 h1·h3, 중첩 목록, 인용
- 걷어 내기 전 처음 잰 값(Chromium)에서는 두 후보 모두 CSP 위반(막음)이 났다. `style-src-elem` 1과 `script-src-attr` 2다.
  - 해석하는 문서에서도 Chromium은 `<style>`과 `on…` 속성을 막고 보고한다.
  - 해석 전에 걷게 고쳐(`apps/partner/src/features/rich-text/paste.ts`) 0이 됐다. Lexical은 처리기에서, Tiptap은 `transformPastedHTML`에서 걷는다.
- 늦게 받은 덩어리는 처음 HTML이 가리킨 스크립트와 견줘 가린다(시각에 기대지 않는다). 늦게 받은 파일이 없으면 시험이 실패한다.
- 프레임워크 몫(두 후보 같음): Next.js가 늦게 싣는 덩어리를 `<script src>`로 넣으며 Trusted Types 위반 2(보고 모드). 편집기와 상관없어 따로 센다(ADR-0204 결정 4, OPS-340).
- 판정: Lexical(위반 0, 덩어리가 35kB 작음). 예산은 80KB [가정]에서 90KB로 확정했다(docs/frontend.md §5.6).
