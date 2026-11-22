// SCR-029 실제 값 화면(?state= 없음, ctx.live)에서 원천이 없는 위젯에 '원천 연결 전' 표시가 있는지(F-03-1 리뷰 RV-04).
// 정본: ADR-0360 결정 9(원천이 있는 위젯은 둘, 나머지 일곱은 원천 기능이 붙기 전), docs/features/control-tower.md §12 '그 전에는 퍼블리싱 고정 자료로 그린다'.
// 정본(frontend·d4·d5)에 실제 값 화면에서 고정 자료를 어떻게 표시할지 문구·꼴이 없어, 구현이 따를 표지로 단언한다:
//   원천이 없는 위젯 요소(WidgetFrame id) 또는 그 위 요소에 data-source="pending"이 있고, 원천이 있는 원격 둘의 자리에는 없다.
//   퍼블리싱 화면(ctx.live 아님)에는 표지가 없다(고정 자료가 그 화면의 뜻이다).
// 보드를 React 서버 그리기로 그려 본다(board.test.resolve.mjs가 .tsx를 esbuild로 읽는다).
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('./board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';
globalThis.__SCANNER_ORIGIN__ = 'https://scanner.test';
globalThis.__CONSOLE_BUILD__ = 'mf';

const { createElement } = await import('react');
const { renderToString } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { MainD, valsD } = await import('./board-d.tsx');

/** 원천이 없는 위젯 일곱의 WidgetFrame id(apps/widgets/*) */
const PENDING_WIDGETS = { 'w-entry': '대기열 진입·입장 처리량', 'w-file': '대기 상태 파일', 'w-cdn': 'CDN', 'w-hold': '좌석 홀드 p99', 'w-pay': '결제 허용 실패', 'w-lfun': '퍼널', 'w-lord': '대기 순서' };

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** 서버가 그린 HTML을 태그 차례로 훑어, id 붙은 요소마다 자기와 위 요소들의 속성을 모은다 */
function elementsById(html) {
  const out = new Map();
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:="[^"]*")?)*)\s*(\/?)>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const [, close, tag, rawAttrs, selfClose] = m;
    if (close) {
      const i = stack.map((s) => s.tag).lastIndexOf(tag.toLowerCase());
      if (i >= 0) stack.length = i;
      continue;
    }
    const attrs = Object.fromEntries([...rawAttrs.matchAll(/([^\s"'>/=]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] ?? '']));
    const el = { tag: tag.toLowerCase(), attrs };
    if (attrs.id) out.set(attrs.id, [...stack, el]);
    if (!selfClose && !VOID.has(el.tag)) stack.push(el);
  }
  return out;
}

const render = (state, live) =>
  renderToString(
    createElement(MemoryRouter, { initialEntries: ['/dashboard'] }, createElement(MainD, { v: valsD(state), ctx: { live, slot: 'normal', recentReleased: false, tabHref: (t) => `/dashboard?tab=${t}` } })),
  );

const pendingOf = (chain) => chain.some((e) => e.attrs['data-source'] === 'pending');

test('F-03-1 RV-04 실제 값 화면의 T=0·판매 중 탭에서 원천이 없는 위젯마다 data-source="pending" 표지가 있다', () => {
  const seen = new Set();
  for (const state of ['T=0', '판매 중']) {
    const byId = elementsById(render(state, true));
    for (const [id, title] of Object.entries(PENDING_WIDGETS)) {
      const chain = byId.get(id);
      if (!chain) continue;
      seen.add(id);
      assert.ok(pendingOf(chain), `${state} 탭 ${id}(${title})에 원천 연결 전 표지(data-source="pending")가 없다`);
    }
  }
  // 두 탭이 일곱을 모두 그린다(어느 것도 빠뜨리고 통과하지 않게)
  assert.deepEqual([...seen].sort(), Object.keys(PENDING_WIDGETS).sort());
});

test('F-03-1 RV-04 원천이 있는 원격 둘의 자리와 퍼블리싱 화면에는 pending 표지가 없다', () => {
  const live = render('판매 중', true);
  // 원격 자리는 서버 그리기에서 스켈레톤(제목 글)으로 그려진다. 그 둘레에는 표지가 없다
  for (const title of ['입장 비율·빈자리', '결제사']) assert.ok(live.includes(title), `${title} 자리가 없다`);
  const byIdLive = elementsById(live);
  for (const id of ['w-lrate', 'w-lpg']) assert.equal(byIdLive.has(id), false, `실제 값 화면에 고정 자료 ${id}가 그려졌다`);
  for (const state of ['T=0', '판매 중']) {
    const html = render(state, false);
    assert.doesNotMatch(html, /data-source="pending"/, `퍼블리싱 ${state} 화면에 표지가 있다`);
    const byId = elementsById(html);
    assert.ok(byId.has('w-lrate') || byId.has('w-entry'), `퍼블리싱 ${state} 화면이 위젯을 그리지 않았다(시험이 빈 화면을 보고 있다)`);
  }
});
