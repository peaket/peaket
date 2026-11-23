// SCR-029 실제 값 화면(ctx.live)의 모든 '자세히 보기 ↗'가 정한 Grafana·Sentry로 가는 새 탭(rel="noopener") 링크이고 프레임이 없는지(F-03-3 T9, 시험 먼저 ADR-0372).
// 정본: docs/features/control-tower.md §2·§12('위젯마다 자세히 보기 ↗를 두어 같은 회차·같은 시간대로 맞춘 Grafana(오류 위젯은 Sentry)를 새 탭으로 연다',
// '새 탭 링크(rel="noopener")', 'Grafana 패널을 iframe으로 끼워 넣지 않는다'), C-T30 ③, 계획 1-12·6-10(주소 틀은 빌드 값).
// 구현 전 트리는 목업 주소(grafana.ops.peaket.example)·rel="noreferrer"라 실패한다. 원격 위젯 둘의 머리는 서버 그리기에서 스켈레톤이라 브라우저 확인(계획 §11)이 본다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchors, newTabNoOpener } from './live/live.test.html.mjs';

register('./board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';
globalThis.__SCANNER_ORIGIN__ = 'https://scanner.test';
globalThis.__CONSOLE_BUILD__ = 'mf';
globalThis.__CONSOLE_GRAFANA_URL__ = 'https://grafana.ops.test/d/onsale-f033';
globalThis.__CONSOLE_SENTRY_URL__ = 'https://sentry.ops.test/organizations/peaket/issues/';
globalThis.__CONSOLE_LINK_HOSTS__ = 'grafana.ops.test,sentry.ops.test,runbook.ops.test';

const { createElement } = await import('react');
const { renderToString } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { MainD, valsD } = await import('./board-d.tsx');

const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const render = (state) =>
  renderToString(
    createElement(
      MemoryRouter,
      { initialEntries: [`/dashboard?event=${E}`] },
      createElement(MainD, { v: valsD(state), ctx: { live: true, slot: 'normal', recentReleased: false, tabHref: (t) => `/dashboard?tab=${t}` } }),
    ),
  );

test('F-03-3 T9 C-T30 ③-2 실제 값 화면의 T-30분·T=0·판매 중 탭에서 자세히 보기는 모두 정한 Grafana·Sentry 호스트의 새 탭 noopener 링크이고 iframe·frame이 없다', () => {
  let seen = 0;
  for (const state of ['T-30분 점검', 'T=0', '판매 중']) {
    const html = render(state);
    assert.doesNotMatch(html, /<i?frame[\s>]/i, `${state} 화면에 프레임이 있다`);
    for (const a of anchors(html).filter((x) => x.text.includes('자세히 보기'))) {
      seen += 1;
      assert.ok(newTabNoOpener(a), `${state}: 새 탭·noopener가 아니다 ${JSON.stringify({ href: a.href, rel: a.rel, target: a.target })}`);
      assert.ok(['grafana.ops.test', 'sentry.ops.test'].includes(new URL(a.href).host), `${state}: 정한 Grafana·Sentry가 아니다 ${a.href}`);
    }
  }
  assert.ok(seen >= 3, `자세히 보기 링크가 ${seen}개다(시험이 빈 화면을 보고 있다)`);
});
