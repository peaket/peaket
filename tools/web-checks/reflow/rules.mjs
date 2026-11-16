// FE-T31 재배치·확대·글자 간격 시험의 공용 값(docs/frontend.md §5.11·§5.17, WCAG 1.4.10·1.4.4·1.4.12).
// 브라우저 시험은 tools/web-checks/reflow/reflow.spec.mjs·keyboard.spec.mjs가 하고, 이 파일은 순수 값·판정만 둔다.
// 판정 기준은 docs/frontend.md §5.17 '화면 매트릭스와 FE-T31·FE-T18 자동 몫의 세부'(BAT-170 웨이브 7)다.
import { lighthousePages } from '../budgets/pages.mjs';

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

/**
 * 두 방향 스크롤을 허용하는 상자: 표, 표를 감싼 .table-wrap, data-reflow-exception 속성을 단 상자(좌석맵·좌석맵 에디터·그래프 부품의 바깥 상자).
 * 예외는 이 셋뿐이다. pre·code나 클래스 이름으로 넓히면 그 안의 재배치 결함이 가려진다(docs/frontend.md §5.17 '예외 상자')
 */
export const EXCEPTION_SELECTORS = ['table', '.table-wrap', '[data-reflow-exception]'];

/** 문서 전체 가로 스크롤이 생겼는지. 예외 상자 밖에서만 본다 */
export function hasPageOverflow(metrics) {
  return Number(metrics?.scrollWidth ?? 0) > Number(metrics?.clientWidth ?? 0) + 1;
}

/** 그 방향을 잘라 보이지 않게 하는 overflow 값(auto·scroll은 밀어서 볼 수 있어 잘림이 아니다) */
const CLIPS = new Set(['hidden', 'clip']);

/**
 * 글자를 바로 담은 상자가 잘렸는지: overflow-x나 overflow-y가 hidden·clip인 방향에서 그 방향의 scroll 크기가 보이는 크기보다 1px 넘게 크다.
 * text-overflow: ellipsis로 줄인 상자는 세지 않는다(전체 글을 볼 수 있는지는 수동, docs/design/d4 #20)
 */
export function clippedTextFindings(items) {
  return (items ?? []).filter((x) => {
    if (!x || x.text !== true || x.textOverflow === 'ellipsis') return false;
    const ox = x.overflowX ?? x.overflow;
    const oy = x.overflowY ?? x.overflow;
    const clippedX = CLIPS.has(ox) && Number(x.scrollWidth) > Number(x.clientWidth) + 1;
    const clippedY = CLIPS.has(oy) && Number(x.scrollHeight) > Number(x.clientHeight) + 1;
    return clippedX || clippedY;
  });
}

/**
 * 닿기('모든 조작 요소에 닿는다', docs/frontend.md §5.17 화면 매트릭스 세부): 예외 상자 밖 조작 요소마다 scrollIntoView 뒤 잰 상자.
 * 항목은 { id, left, right, width, height, hit }(hit: 상자 가운데 점의 맨 위 요소가 그 요소이거나 그 안쪽). 닿지 않는 항목을 돌려준다.
 * 시험 담당이 먼저 둔 빈 뼈대다(BAT-170 웨이브 7). 판정은 구현 담당이 쓴다.
 */
export function unreachableFindings(items, viewportWidth) {
  const vw = Number(viewportWidth);
  return (items ?? []).filter((x) => !(Number(x.left) >= 0 && Number(x.right) <= vw && Number(x.width) > 0 && Number(x.height) > 0 && x.hit === true));
}

/**
 * 초점 가림(FE-T18, WCAG 2.4.11): Tab 한 번마다 { target: { id, left, top, width, height }, fixed: [{ id, left, top, width, height }] }.
 * fixed는 position fixed·sticky인 다른 요소의 상자다. 초점 상자가 그 가운데 하나에 완전히 덮인 단계를 돌려준다.
 * 시험 담당이 먼저 둔 빈 뼈대다(BAT-170 웨이브 7). 판정은 구현 담당이 쓴다.
 */
export function obscuredFocusFindings(steps) {
  const covers = (f, t) => f.left <= t.left && f.top <= t.top && f.left + f.width >= t.left + t.width && f.top + f.height >= t.top + t.height;
  return (steps ?? []).filter((s) => s?.target && (s.fixed ?? []).some((f) => f.id !== s.target.id && covers(f, s.target)));
}

/**
 * 빈 결과: 요청한 경로와 도착 경로가 다르거나(로그인으로 넘어감 등) 잰 글자 상자·조작 요소가 0개면 실패 까닭 문자열, 아니면 null.
 * 시험 담당이 먼저 둔 빈 뼈대다(BAT-170 웨이브 7). 판정은 구현 담당이 쓴다.
 */
export function emptyMeasurement({ requestedPath, finalPath, textCount, controlCount }) {
  if (finalPath !== requestedPath) return `도착 경로가 다르다: ${requestedPath} → ${finalPath}`;
  if (!(Number(textCount) > 0)) return '잰 글자 상자가 0개다';
  if (!(Number(controlCount) > 0)) return '잰 조작 요소가 0개다';
  return null;
}

/**
 * 겹침(FE-T31, docs/frontend.md §5.17 '판정'): 예외 상자 밖에서 보이는 글자 노드 둘의 줄 사각형(문서 좌표)이 가로·세로 모두 1px 넘게 포개진 짝.
 * 항목은 { node, left, top, width, height, hidden?, exception? }(node: 글자 노드 번호). 같은 노드의 줄끼리, 숨긴 글, 예외 상자 안의 글은 세지 않는다.
 * 돌려주는 것은 [{ a, b }](a·b는 포개진 두 항목). 정확히 1px 포갬은 겹침이 아니다(BAT-170 계획 §13 V13-1).
 */
export function overlapFindings(rects) {
  /** 한 축에서 포개진 길이 */
  const span = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);
  const shown = (rects ?? []).filter((r) => r && !r.hidden && !r.exception);
  const out = [];
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i];
      const b = shown[j];
      if (a.node === b.node) continue;
      const x = span(Number(a.left), Number(a.left) + Number(a.width), Number(b.left), Number(b.left) + Number(b.width));
      const y = span(Number(a.top), Number(a.top) + Number(a.height), Number(b.top), Number(b.top) + Number(b.height));
      if (x > 1 && y > 1) out.push({ a, b });
    }
  }
  return out;
}

/** 좌석 화면은 운영 빌드 그대로, 성능 예산 검사의 좌석 화면 데모와 같은 경로·입장 저장값으로 연다(docs/frontend.md §5.17 '빈 결과') */
const seatDemo = lighthousePages('127.0.0.1').find((x) => x.name === '좌석 화면 데모');
if (!seatDemo?.sessionStorage) throw new Error('budgets/pages.mjs에 좌석 화면 데모(입장 저장값)가 없다');

/**
 * 시험할 주요 흐름. 소비자 웹·파트너·관제의 대표 화면만 돈다(전 화면은 출시 후보). 항목은 { app, path, locale, sessionStorage? }.
 * - 소비자 웹 en은 주소 접두 /en으로 돈다(§5.12). en 접두 경로가 있는 화면만(지금은 공연 상세) en을 싣는다. 파트너·관제는 ko만이다.
 * - sessionStorage(키 → 문자열)는 reflow.spec이 페이지 스크립트보다 먼저 넣는다. 운영 빌드는 ?state=를 무시하므로 미리보기로 열지 않는다
 */
export const REFLOW_PAGES = [
  { app: 'web', locale: 'ko', path: '/' },
  { app: 'web', locale: 'ko', path: '/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01' },
  { app: 'web', locale: 'en', path: '/en/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01' },
  { app: 'web', locale: 'ko', path: new URL(seatDemo.url).pathname, sessionStorage: { ...seatDemo.sessionStorage } },
  { app: 'web', locale: 'ko', path: '/my/tickets' },
  { app: 'web', locale: 'ko', path: '/search' },
  { app: 'partner', locale: 'ko', path: '/events' },
  { app: 'console', locale: 'ko', path: '/' },
];
