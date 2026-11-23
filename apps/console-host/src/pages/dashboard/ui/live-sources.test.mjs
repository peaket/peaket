// SCR-029 실제 값 화면(?state= 없음, ctx.live)에서 원천이 없는 위젯에 '원천 연결 전' 표시가 있는지(F-03-1 리뷰 RV-04).
// 정본: ADR-0360 결정 9(원천이 있는 위젯은 둘, 나머지 일곱은 원천 기능이 붙기 전), docs/features/control-tower.md §12 '그 전에는 퍼블리싱 고정 자료로 그린다'.
// 정본(frontend·d4·d5)에 실제 값 화면에서 고정 자료를 어떻게 표시할지 문구·꼴이 없어, 구현이 따를 표지로 단언한다:
//   원천이 없는 위젯 요소(WidgetFrame id) 또는 그 위 요소에 data-source="pending"이 있고, 원천이 있는 원격 둘의 자리에는 없다.
//   퍼블리싱 화면(ctx.live 아님)에는 표지가 없다(고정 자료가 그 화면의 뜻이다).
// 보드를 React 서버 그리기로 그려 본다(board.test.resolve.mjs가 .tsx를 esbuild로 읽는다).
import { readFileSync } from 'node:fs';
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
const { TAB_STATE } = await import('../states.ts');

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

// ---------- 리뷰 반영 2(재리뷰 RV-04 남은 몫): 보드가 직접 그리는 칸까지 모든 .widget 칸 ----------
// 정본: docs/frontend.md §5.7 '원천 연결 전 위젯'(위젯 칸에 data-source="pending"과 머리의 '원천 연결 전' 배지, 원천이 있는 원격 위젯 자리에는 달지 않는다),
// ADR-0360 결정 9(원천이 있는 위젯 키는 queue-admission-rate·purchase-pg-status 둘).
// 칸 id를 손으로 적지 않는다: 그린 HTML의 class="widget" 칸을 모두 모으고, 원천 있는 칸(원격 둘의 자리)만 뺀 나머지 모두에 표지를 요구한다.

/** ADR-0360 결정 9의 원천 있는 위젯(원격 위젯 이름) */
const SOURCED = ['queue-admission-rate', 'purchase-pg-status'];
/** 호스트가 그리는 원천 있는 칸(F-04-1: 관제 실시간 표 rt-sales.summary를 RtSalesCell이 그린다, control-tower §12 '관제 실시간 표는 … 붙였고') */
const HOST_SOURCED = ['구역별 잔여석'];
/** 원격 자리의 제목: 보드 원본의 <RemoteWidget name=… title=…>에서 읽는다(서버 그리기에서는 그 제목의 스켈레톤 칸이 된다) */
const remoteTitles = (() => {
  const src = readFileSync(new URL('./board-d.tsx', import.meta.url), 'utf8');
  const out = new Map();
  for (const m of src.matchAll(/<RemoteWidget\b[^>]*?\bname="([^"]+)"[^>]*?\btitle="([^"]+)"/g)) out.set(m[1], m[2]);
  return out;
})();
/** 실제 값 화면이 그리는 상태: ?tab= 탭마다의 대표 상태와 #w-auto로 여는 '자동 조치 걸림'(Page.tsx fallback) */
const LIVE_STATES = [...new Set([...Object.values(TAB_STATE), '자동 조치 걸림'])];

/** class 목록에 widget이 있는 칸마다 자기·위 요소 속성과 안쪽 HTML을 모은다 */
function widgetCells(html) {
  const cells = [];
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:="[^"]*")?)*)\s*(\/?)>/g;
  const closeFrom = (i, at) => {
    for (const e of stack.slice(i)) if (e.cell) e.cell.inner = html.slice(e.innerFrom, at);
    stack.length = i;
  };
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const [, close, tag, rawAttrs, selfClose] = m;
    if (close) {
      const i = stack.map((s) => s.tag).lastIndexOf(tag.toLowerCase());
      if (i >= 0) closeFrom(i, m.index);
      continue;
    }
    const attrs = Object.fromEntries([...rawAttrs.matchAll(/([^\s"'>/=]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] ?? '']));
    const el = { tag: tag.toLowerCase(), attrs, innerFrom: re.lastIndex };
    if ((attrs.class ?? '').split(/\s+/).includes('widget')) {
      el.cell = { attrs, chain: [...stack.map((s) => s.attrs), attrs], inner: '' };
      cells.push(el.cell);
    }
    if (!selfClose && !VOID.has(el.tag)) stack.push(el);
  }
  closeFrom(0, html.length);
  return cells;
}
const nameOf = (c) => c.attrs['aria-labelledby'] ?? c.attrs['aria-label'] ?? c.attrs.id ?? c.inner.replace(/<[^>]+>/g, ' ').trim().slice(0, 30);

test("F-03-1 RV-04 ② 실제 값 화면의 모든 탭에서 원천 있는 원격 둘의 자리 밖 .widget 칸(보드가 직접 그리는 칸 포함)마다 data-source=\"pending\"과 '원천 연결 전' 배지가 있고, 원격 둘의 자리에는 없다", () => {
  assert.deepEqual([...remoteTitles.keys()].sort(), [...SOURCED].sort(), '보드의 원격 자리가 ADR-0360 결정 9의 원천 있는 위젯 둘과 다르다');
  const sourcedTitles = new Set([...remoteTitles.values(), ...HOST_SOURCED]);
  const missing = [];
  const seenSourced = new Set();
  let unsourced = 0;
  for (const state of LIVE_STATES) {
    const html = render(state, true);
    const cells = widgetCells(html);
    // 칸 찾기가 HTML의 widget 칸을 하나도 놓치지 않는다(시험이 빈 목록을 보고 통과하지 않게)
    assert.equal(cells.length, html.match(/class="widget(?:\s[^"]*)?"/g)?.length ?? 0, `${state} 탭의 칸 찾기가 widget 칸을 놓쳤다`);
    assert.ok(cells.length > 0, `${state} 탭이 위젯 칸을 그리지 않았다`);
    for (const c of cells) {
      const pendingInChain = c.chain.some((a) => a['data-source'] === 'pending');
      if (sourcedTitles.has(c.attrs['aria-label'])) {
        seenSourced.add(c.attrs['aria-label']);
        assert.equal(pendingInChain, false, `${state} 탭의 원천 있는 자리 ${c.attrs['aria-label']}에 pending 표지가 있다`);
        assert.doesNotMatch(c.inner, /원천 연결 전/, `${state} 탭의 원천 있는 자리 ${c.attrs['aria-label']}에 '원천 연결 전' 배지가 있다`);
        continue;
      }
      unsourced += 1;
      if (!pendingInChain || !c.inner.includes('원천 연결 전')) missing.push(`${state}:${nameOf(c)}${pendingInChain ? '(배지 없음)' : ''}`);
    }
  }
  // 원격 둘의 자리를 실제로 봤다(제목이 바뀌어 원천 있는 칸이 '없는 칸'으로 섞이지 않게)
  assert.deepEqual([...seenSourced].sort(), [...sourcedTitles].sort());
  assert.ok(unsourced >= 7, `원천 없는 칸이 ${unsourced}개뿐이다(팀 위젯 일곱보다 적다)`);
  assert.deepEqual(missing, [], `원천 연결 전 표지가 없는 칸 ${missing.length}개`);
});

test('F-04-1 C-T20 실제 값 화면의 구역별 잔여석 칸은 관제 실시간 표 원천(RtSalesCell)이 그리고, 퍼블리싱 화면은 고정 자료 그대로다', () => {
  for (const state of ['T=0', '판매 중']) {
    const live = render(state, true);
    // 서버 그리기는 값을 받기 전이라 스켈레톤(aria-busy)이고, 고정 자료 숫자(R1 4석 등)를 그리지 않는다
    assert.match(live, /aria-label="구역별 잔여석" aria-busy="true"/, `${state} 실제 값 화면에 실시간 표 칸 자리가 없다`);
    assert.doesNotMatch(live, /R1 4석, R2 12석/, `${state} 실제 값 화면에 고정 자료 잔여석이 그려졌다`);
    const pub = render(state, false);
    assert.match(pub, /R1 4석, R2 12석/, `${state} 퍼블리싱 화면의 고정 자료가 없다`);
  }
});
