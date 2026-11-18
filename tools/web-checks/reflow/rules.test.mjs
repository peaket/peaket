// FE-T31 재배치·확대·글자 간격 시험 값(docs/frontend.md §5.11·§5.17, WCAG 1.4.10·1.4.4·1.4.12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXCEPTION_SELECTORS,
  REFLOW_PAGES,
  REFLOW_VIEWPORTS,
  TEXT_SPACING,
  TEXT_SPACING_CSS,
  clippedTextFindings,
  emptyMeasurement,
  hasPageOverflow,
  obscuredFocusFindings,
  overlapFindings,
  stickyInsetFindings,
  unreachableFindings,
} from './rules.mjs';
import { lighthousePages } from '../budgets/pages.mjs';

test('FE-T31 뷰포트 둘은 320×256(400% 확대)과 640×400(200% 확대)이다', () => {
  assert.deepEqual(REFLOW_VIEWPORTS, [
    { name: 'reflow-320', width: 320, height: 256 },
    { name: 'zoom-200', width: 640, height: 400 },
  ]);
});

test('FE-T31 글자 간격 값은 WCAG 1.4.12의 1.5·2·0.12·0.16배다', () => {
  assert.deepEqual(TEXT_SPACING, { lineHeight: 1.5, paragraphSpacing: 2, letterSpacing: 0.12, wordSpacing: 0.16 });
  assert.match(TEXT_SPACING_CSS, /line-height:1\.5/);
  assert.match(TEXT_SPACING_CSS, /letter-spacing:0\.12em/);
  assert.match(TEXT_SPACING_CSS, /word-spacing:0\.16em/);
  assert.match(TEXT_SPACING_CSS, /margin-block-end:2em/);
});

// BAT-170 시험 뒤 정한 것(계획 §11 4, docs/frontend.md §5.17 '예외 상자'): 예외는 셋뿐이고 pre·code·클래스 이름으로 넓히지 않는다
test('FE-T31 두 방향 스크롤 예외는 table·.table-wrap·[data-reflow-exception] 셋뿐이다', () => {
  assert.deepEqual([...EXCEPTION_SELECTORS].sort(), ['.table-wrap', '[data-reflow-exception]', 'table']);
  for (const wide of ['pre', 'code', '.seatmap', '.seatmap-editor', '.graph', '.chart']) assert.equal(EXCEPTION_SELECTORS.includes(wide), false, wide);
});

test('FE-T31 문서 가로 스크롤은 1px 여유를 두고 판정한다', () => {
  assert.equal(hasPageOverflow({ scrollWidth: 320, clientWidth: 320 }), false);
  assert.equal(hasPageOverflow({ scrollWidth: 321, clientWidth: 320 }), false);
  assert.equal(hasPageOverflow({ scrollWidth: 322, clientWidth: 320 }), true);
});

// BAT-170 웨이브 7(T1~T3): 시험 담당(l2w7-BAT170-test)이 판정 구현 전에 썼다(ADR-0270 결정 3). 기준 docs/frontend.md §5.17 '화면 매트릭스와 FE-T31·FE-T18 자동 몫의 세부'.
test('FE-T31 잘림은 overflow가 hidden·clip인 방향만 센다(auto·scroll·visible·줄임표는 뺀다)', () => {
  const box = { text: true, textOverflow: 'clip', scrollWidth: 100, clientWidth: 100, scrollHeight: 10, clientHeight: 10 };
  const items = [
    { ...box, id: 'x-hidden', overflowX: 'hidden', overflowY: 'visible', scrollWidth: 102 },
    { ...box, id: 'x-clip', overflowX: 'clip', overflowY: 'visible', scrollWidth: 102 },
    { ...box, id: 'x-auto', overflowX: 'auto', overflowY: 'visible', scrollWidth: 200 },
    { ...box, id: 'x-scroll', overflowX: 'scroll', overflowY: 'visible', scrollWidth: 200 },
    { ...box, id: 'x-visible', overflowX: 'visible', overflowY: 'visible', scrollWidth: 200 },
    // 1px 여유: 보이는 크기 + 1px까지는 잘림이 아니다
    { ...box, id: 'x-hidden-1px', overflowX: 'hidden', overflowY: 'visible', scrollWidth: 101 },
    { ...box, id: 'y-hidden', overflowX: 'visible', overflowY: 'hidden', scrollHeight: 12 },
    { ...box, id: 'y-clip', overflowX: 'visible', overflowY: 'clip', scrollHeight: 12 },
    { ...box, id: 'y-auto', overflowX: 'visible', overflowY: 'auto', scrollHeight: 50 },
    // 방향이 다르면 세지 않는다: 가로는 숨겼지만 넘친 것은 세로(세로는 보임)
    { ...box, id: 'x-hidden-y-overflow', overflowX: 'hidden', overflowY: 'visible', scrollHeight: 50 },
    // 세로를 숨겼지만 넘친 것은 가로이고 가로는 밀어 볼 수 있다
    { ...box, id: 'y-hidden-x-auto-overflow', overflowX: 'auto', overflowY: 'hidden', scrollWidth: 300 },
    // 줄임표로 줄인 상자는 세지 않는다(전체 글을 볼 수 있는지는 수동, d4 #20)
    { ...box, id: 'x-ellipsis', overflowX: 'hidden', overflowY: 'visible', textOverflow: 'ellipsis', scrollWidth: 200 },
    // 글자를 바로 담지 않은 상자는 세지 않는다
    { ...box, id: 'not-text', text: false, overflowX: 'hidden', overflowY: 'hidden', scrollWidth: 200, scrollHeight: 50 },
  ];
  assert.deepEqual(clippedTextFindings(items).map((x) => x.id).sort(), ['x-clip', 'x-hidden', 'y-clip', 'y-hidden']);
  assert.deepEqual(clippedTextFindings([]), []);
});

test('FE-T31 닿기: 문서 폭 밖·크기 0·가운데 점이 다른 요소면 찾는다', () => {
  const ok = { left: 0, right: 320, width: 320, height: 44, hit: true };
  const items = [
    { ...ok, id: 'edge-both' }, // 왼쪽 정확히 0, 오른쪽 정확히 폭: 통과
    { ...ok, id: 'inside', left: 16, right: 120, width: 104 },
    { ...ok, id: 'left-minus-1', left: -1, right: 100, width: 101 },
    { ...ok, id: 'right-plus-1', left: 200, right: 321, width: 121 },
    { ...ok, id: 'zero-width', left: 10, right: 10, width: 0 },
    { ...ok, id: 'zero-height', height: 0 },
    { ...ok, id: 'covered', hit: false },
  ];
  assert.deepEqual(unreachableFindings(items, 320).map((x) => x.id).sort(), ['covered', 'left-minus-1', 'right-plus-1', 'zero-height', 'zero-width']);
  // 같은 상자도 폭이 다르면 판정이 바뀐다(폭 값을 실제로 쓴다)
  const wide = { ...ok, id: 'w640', left: 0, right: 640, width: 640 };
  assert.deepEqual(unreachableFindings([wide], 640), []);
  assert.deepEqual(unreachableFindings([wide], 639).map((x) => x.id), ['w640']);
  assert.deepEqual(unreachableFindings([], 320), []);
});

test('FE-T18 초점 가림: 초점 상자가 고정·sticky 요소 하나에 완전히 덮일 때만 찾는다', () => {
  const header = { id: 'header', left: 0, top: 0, width: 320, height: 56 };
  const bar = { id: 'bottom-bar', left: 0, top: 200, width: 320, height: 56 };
  const steps = [
    { target: { id: 'under-header', left: 16, top: 8, width: 100, height: 40 }, fixed: [header, bar] }, // 다 덮임
    { target: { id: 'half', left: 16, top: 40, width: 100, height: 40 }, fixed: [header, bar] }, // 일부만 덮임: 통과
    { target: { id: 'edge-exact', left: 0, top: 0, width: 320, height: 56 }, fixed: [header] }, // 가장자리가 꼭 맞게 덮임
    { target: { id: 'below-1px', left: 0, top: 1, width: 320, height: 56 }, fixed: [header] }, // 1px 밖으로 나옴: 통과
    { target: { id: 'under-bar', left: 100, top: 210, width: 40, height: 40 }, fixed: [header, bar] },
    { target: { id: 'clear', left: 16, top: 100, width: 100, height: 40 }, fixed: [header, bar] },
    { target: { id: 'no-fixed', left: 16, top: 8, width: 100, height: 40 }, fixed: [] },
    // 두 고정 요소가 나눠 덮으면 '하나에 완전히'가 아니다: 통과
    {
      target: { id: 'split', left: 0, top: 40, width: 320, height: 180 },
      fixed: [
        { id: 'a', left: 0, top: 0, width: 320, height: 130 },
        { id: 'b', left: 0, top: 130, width: 320, height: 130 },
      ],
    },
  ];
  assert.deepEqual(obscuredFocusFindings(steps).map((x) => x.target.id).sort(), ['edge-exact', 'under-bar', 'under-header']);
  assert.deepEqual(obscuredFocusFindings([]), []);
});

test('FE-T31 빈 결과(화면 0·도착 경로 다름·글자 상자 0·조작 요소 0)는 실패 까닭을 돌려준다', () => {
  const ok = { requestedPath: '/search', finalPath: '/search', textCount: 12, controlCount: 5 };
  assert.equal(emptyMeasurement(ok), null);
  assert.equal(emptyMeasurement({ ...ok, textCount: 1, controlCount: 1 }), null, '하나씩이면 빈 결과가 아니다');
  for (const bad of [
    { ...ok, finalPath: '/login' },
    { ...ok, requestedPath: '/my/tickets', finalPath: '/login?next=%2Fmy%2Ftickets' },
    { ...ok, textCount: 0 },
    { ...ok, controlCount: 0 },
    { ...ok, textCount: 0, controlCount: 0 },
  ]) {
    const why = emptyMeasurement(bad);
    assert.equal(typeof why, 'string', JSON.stringify(bad));
    assert.ok(why.length > 0);
  }
  // 대상 화면이 0개인 목록은 시험 자체가 없으므로 앱마다 화면이 있어야 한다
  for (const app of ['web', 'partner', 'console']) assert.ok(REFLOW_PAGES.filter((p) => p.app === app).length > 0, app);
});

test('FE-T31 화면 목록은 en을 /en 접두 경로로 싣고 파트너·관제는 ko만이다', () => {
  for (const p of REFLOW_PAGES) {
    assert.ok(p.locale === 'ko' || p.locale === 'en', `${p.app} ${p.path} locale=${p.locale}`);
    if (p.locale === 'en') assert.match(p.path, /^\/en\//, `${p.app} ${p.path}`);
    else assert.doesNotMatch(p.path, /^\/en(\/|$)/, `${p.app} ${p.path}`);
  }
  assert.ok(REFLOW_PAGES.some((p) => p.app === 'web' && p.locale === 'en'), '소비자 웹 en 화면이 없다');
  for (const app of ['partner', 'console']) assert.deepEqual([...new Set(REFLOW_PAGES.filter((p) => p.app === app).map((p) => p.locale))], ['ko'], app);
  // 좌석 화면(예외 상자 좌석맵)을 싣는다
  assert.ok(REFLOW_PAGES.some((p) => p.app === 'web' && /^\/booking\/[^/]+\/seats(\?|$)/.test(p.path)), '좌석 화면이 없다');
  // 운영 빌드는 ?state=를 무시하므로 미리보기로 열지 않는다(계획 §11 2, docs/frontend.md §5.17 '빈 결과')
  for (const p of REFLOW_PAGES) assert.doesNotMatch(p.path, /[?&]state=/, `${p.app} ${p.path}`);
  // 같은 앱·경로·로케일이 두 번 들지 않는다
  const keys = REFLOW_PAGES.map((p) => `${p.app} ${p.locale} ${p.path}`);
  assert.equal(new Set(keys).size, keys.length);
});

// BAT-170 시험 뒤 정한 것(계획 §11 2): 좌석 화면은 운영 빌드 그대로, 성능 예산 검사의 좌석 화면 데모와 같은 입장 저장값을 탭 저장소에 먼저 넣고 연다.
// 항목 모양: { app, path, locale, sessionStorage?: Record<키, 문자열> }. reflow.spec이 sessionStorage를 페이지 스크립트보다 먼저 넣는다
test('FE-T31 좌석 화면 항목은 ?state= 없이 성능 예산 좌석 데모와 같은 입장 저장값(sessionStorage)을 싣는다', () => {
  const demo = lighthousePages('127.0.0.1').find((x) => x.name === '좌석 화면 데모');
  assert.ok(demo?.sessionStorage, '성능 예산 좌석 화면 데모를 찾지 못했다');
  const seats = REFLOW_PAGES.filter((p) => p.app === 'web' && /^\/booking\/[^/]+\/seats(\?|$)/.test(p.path));
  assert.ok(seats.length > 0, '좌석 화면이 없다');
  for (const p of seats) {
    assert.equal(p.path, new URL(demo.url).pathname, '좌석 데모와 같은 회차 경로여야 입장 저장값이 맞는다');
    assert.deepEqual(p.sessionStorage, demo.sessionStorage, `${p.path} 입장 저장값`);
    for (const v of Object.values(p.sessionStorage)) assert.equal(typeof v, 'string');
  }
  // 저장값은 객체(키 → 문자열)이고, 다른 항목은 저장값이 없거나 같은 모양이다
  for (const p of REFLOW_PAGES) {
    if (p.sessionStorage === undefined) continue;
    assert.equal(typeof p.sessionStorage, 'object', `${p.app} ${p.path}`);
    for (const v of Object.values(p.sessionStorage)) assert.equal(typeof v, 'string', `${p.app} ${p.path}`);
  }
});

// BAT-171 시험(계획 §3 T1): 시험 담당(l2-bat171-test)이 구현(622e082d) 뒤에 썼다(ADR-0281 결정 3). 기준 docs/frontend.md §5.17 '화면 목록의 경로':
// 앱이 다른 경로로 넘기지 않고 바로 그리는 도착 경로를 적고, 관제 첫 화면 `/`는 라우터가 `/dashboard`로 넘기므로 `/dashboard`를 적는다
test('FE-T31 화면 목록의 경로는 넘김 없는 도착 경로다(관제는 /dashboard이고 /는 없다)', () => {
  const consolePaths = REFLOW_PAGES.filter((p) => p.app === 'console').map((p) => p.path);
  assert.ok(consolePaths.includes('/dashboard'), `관제 항목에 /dashboard가 없다: ${consolePaths.join(', ')}`);
  assert.equal(consolePaths.includes('/'), false, '관제 항목에 넘기는 경로 /가 있다(/dashboard로 넘어가 빈 결과가 된다)');
  // 넘김을 따라간 뒤의 경로는 잰 것으로 치지 않으므로, 목록의 경로는 쿼리·조각 없이 그 화면의 경로 하나다
  for (const p of REFLOW_PAGES) assert.match(p.path, /^\/[^?#]*$/, `${p.app} ${p.path}`);
});

// BAT-171 시험(계획 §3 T2의 판정): 시험 담당(l2-bat171-test)이 구현 뒤에 썼다. 기준 docs/frontend.md §5.11 '초점이 가려지지 않게'
// (여백 = 띠의 실제 높이, 박아 둔 여백이 띠보다 작으면 결함, 위아래 띠와 여백을 빼고도 남는 보이는 높이 > 0). 경계 양쪽을 둔다
test('FE-T18 고정 띠: 그 쪽 스크롤 여백이 띠의 실제 높이 이상이면 통과하고 1px 모자라면 찾으며, 남는 보이는 높이가 0이면 찾는다', () => {
  const ids = (x) => stickyInsetFindings(x).map((f) => f.id);
  const bands = [
    { id: '탭', edge: 'top', height: 39 },
    { id: '예매', edge: 'bottom', height: 192 },
  ];
  // 같으면 통과(위·아래 따로)
  assert.deepEqual(ids({ bands, padding: { top: 39, bottom: 192 }, viewportHeight: 321 }), []);
  // 1px 모자라면 그 띠만 찾는다(위·아래 따로)
  assert.deepEqual(ids({ bands, padding: { top: 38, bottom: 192 }, viewportHeight: 321 }), ['탭']);
  assert.deepEqual(ids({ bands, padding: { top: 39, bottom: 191 }, viewportHeight: 321 }), ['예매']);
  // 소수 높이: 192.5는 192보다 높다(여백을 내림으로 넘기는 결함)
  assert.deepEqual(ids({ bands: [{ id: '예매', edge: 'bottom', height: 192.5 }], padding: { top: 0, bottom: 192 }, viewportHeight: 321 }), ['예매']);
  // 예전 고정값 96px(BAT-171 F2): 안내 글 줄바꿈으로 192px가 된 띠를 덮지 못한다
  const short = stickyInsetFindings({ bands, padding: { top: 56, bottom: 96 }, viewportHeight: 400 });
  assert.deepEqual(short, [{ id: '예매', edge: 'bottom', height: 192, padding: 96 }]);
  // 같은 쪽에 띠가 둘이면 높은 것까지 덮어야 한다
  assert.deepEqual(ids({ bands: [...bands, { id: '안내', edge: 'bottom', height: 200 }], padding: { top: 39, bottom: 192 }, viewportHeight: 400 }), ['안내']);
  // 남는 보이는 높이: 1px 남으면 통과, 0이면 찾는다(여백이 띠보다 크면 여백으로 센다)
  assert.deepEqual(ids({ bands, padding: { top: 39, bottom: 192 }, viewportHeight: 232 }), []);
  assert.deepEqual(stickyInsetFindings({ bands, padding: { top: 39, bottom: 192 }, viewportHeight: 231 }), [{ id: '남는 높이', remaining: 0 }]);
  assert.deepEqual(ids({ bands, padding: { top: 39, bottom: 230 }, viewportHeight: 268 }), ['남는 높이']);
  // 띠가 없으면 남는 높이만 본다(여백 0이면 통과)
  assert.deepEqual(ids({ bands: [], padding: { top: 0, bottom: 0 }, viewportHeight: 320 }), []);
});

test('FE-T31 주요 흐름은 소비자 웹·파트너·관제의 대표 화면이다', () => {
  assert.ok(REFLOW_PAGES.some((p) => p.app === 'web' && p.path === '/my/tickets'));
  assert.ok(REFLOW_PAGES.some((p) => p.app === 'partner'));
  assert.ok(REFLOW_PAGES.some((p) => p.app === 'console'));
});

// BAT-170 검증 뒤 정한 것(계획 §13 V13-1, docs/frontend.md §5.17 '판정'의 겹침): 시험 담당(l2w7-BAT170-test)이 판정 구현 전에 썼다.
// 겹침은 예외 상자 밖에서 보이는 글자 노드 둘의 줄 사각형이 가로·세로 모두 1px 넘게 포개지는 것이다.
test('FE-T31 겹침: 예외 밖 보이는 글자 노드 둘의 줄 사각형이 가로·세로 모두 1px 넘게 포개지면 찾는다', () => {
  const pairs = (rects) => overlapFindings(rects).map(({ a, b }) => [a.node, b.node].sort().join('|'));
  const base = { node: 'a', left: 0, top: 0, width: 100, height: 20 };
  // 가로 경계: 정확히 1px 포갬은 통과, 1.5px는 찾는다(세로는 다 포개짐)
  assert.deepEqual(pairs([base, { node: 'b', left: 99, top: 0, width: 50, height: 20 }]), []);
  assert.deepEqual(pairs([base, { node: 'b', left: 98.5, top: 0, width: 50, height: 20 }]), ['a|b']);
  // 세로 경계: 정확히 1px 포갬은 통과, 1.5px는 찾는다(가로는 다 포개짐)
  assert.deepEqual(pairs([base, { node: 'b', left: 0, top: 19, width: 100, height: 20 }]), []);
  assert.deepEqual(pairs([base, { node: 'b', left: 0, top: 18.5, width: 100, height: 20 }]), ['a|b']);
  // 가로만·세로만 포개진 것은 통과
  assert.deepEqual(pairs([base, { node: 'b', left: 50, top: 100, width: 100, height: 20 }]), [], '가로만');
  assert.deepEqual(pairs([base, { node: 'b', left: 300, top: 5, width: 100, height: 20 }]), [], '세로만');
  // 같은 노드의 두 줄, 숨긴 글, 한쪽이 예외 상자 안이면 세지 않는다
  assert.deepEqual(pairs([base, { node: 'a', left: 10, top: 5, width: 100, height: 20 }]), [], '같은 노드');
  assert.deepEqual(pairs([base, { node: 'b', left: 10, top: 5, width: 100, height: 20, hidden: true }]), [], '숨긴 글');
  assert.deepEqual(pairs([base, { node: 'b', left: 10, top: 5, width: 100, height: 20, exception: true }]), [], '예외 상자 안');
  assert.deepEqual(pairs([{ ...base, exception: true }, { node: 'b', left: 10, top: 5, width: 100, height: 20 }]), [], '앞쪽이 예외 상자 안');
  // 셋 가운데 포개진 짝만
  assert.deepEqual(pairs([base, { node: 'b', left: 50, top: 5, width: 100, height: 20 }, { node: 'c', left: 500, top: 0, width: 10, height: 10 }]), ['a|b']);
  assert.deepEqual(overlapFindings([]), []);
});
