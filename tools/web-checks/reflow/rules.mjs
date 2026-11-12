// FE-T31 재배치·확대·글자 간격 시험의 공용 값(docs/frontend.md §5.11·§5.17, WCAG 1.4.10·1.4.4·1.4.12).
// 브라우저 시험은 tools/web-checks/reflow/reflow.spec.mjs가 하고, 이 파일은 순수 값·판정만 둔다.

/** 1280×1024를 400% 확대한 것과 같은 320×256, 1280×800을 200% 확대한 것과 같은 640×400 [가정] */
export const REFLOW_VIEWPORTS = [
  { name: 'reflow-320', width: 320, height: 256 },
  { name: 'zoom-200', width: 640, height: 400 },
];

/** WCAG 1.4.12 글자 간격: 줄 높이 1.5배, 문단 뒤 2배, 글자 사이 0.12배, 단어 사이 0.16배 */
export const TEXT_SPACING = {
  lineHeight: 1.5,
  paragraphSpacing: 2,
  letterSpacing: 0.12,
  wordSpacing: 0.16,
};

/** 페이지에 넣는 글자 간격 규칙. CSP를 끄지 않도록 시험 스크립트가 CSSOM insertRule로 넣는다 */
export const TEXT_SPACING_CSS =
  '*{line-height:1.5 !important;letter-spacing:0.12em !important;word-spacing:0.16em !important}' +
  'p,li,dd,dt,figcaption,blockquote{margin-block-end:2em !important}';

/** 두 방향 스크롤을 허용하는 상자(표·좌석맵·좌석맵 에디터·그래프). 이 안에서만 민다 */
export const EXCEPTION_SELECTORS = ['table', 'pre', 'code', '[data-reflow-exception]', '.seatmap', '.seatmap-editor', '.graph', '.chart'];

/** 문서 전체 가로 스크롤이 생겼는지. 예외 상자 밖에서만 본다 */
export function hasPageOverflow(metrics) {
  return Number(metrics?.scrollWidth ?? 0) > Number(metrics?.clientWidth ?? 0) + 1;
}

/** 글자를 담은 상자가 잘렸는지. overflow가 보이는 상자는 넘쳐도 잘린 것이 아니다 */
export function clippedTextFindings(items) {
  return (items ?? []).filter((x) => x && x.text === true && x.overflow !== 'visible' && (x.scrollWidth > x.clientWidth + 1 || x.scrollHeight > x.clientHeight + 1));
}

/** 시험할 주요 흐름. 소비자 웹·파트너·관제의 대표 화면만 돈다(전 화면은 출시 후보) */
export const REFLOW_PAGES = [
  { app: 'web', path: '/' },
  { app: 'web', path: '/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01' },
  { app: 'web', path: '/my/tickets' },
  { app: 'web', path: '/search' },
  { app: 'partner', path: '/events' },
  { app: 'console', path: '/' },
];
