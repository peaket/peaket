// GAT-360 관제 입장 탭 실제 값 부품(EntryLive)의 서버 그리기 시험.
// 첫 그리기는 목업 수(7/7대, 중복 12건 등)가 아니라 '불러오는 중'이어야 한다(실제 값은 브라우저 효과가 읽는다).
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';
globalThis.__SCANNER_ORIGIN__ = 'https://scanner.test';
globalThis.__CONSOLE_BUILD__ = 'mf';
globalThis.__CONSOLE_GRAFANA_URL__ = '';
globalThis.__CONSOLE_SENTRY_URL__ = '';
globalThis.__CONSOLE_LINK_HOSTS__ = '';

const { createElement } = await import('react');
const { renderToString } = await import('react-dom/server');
const { EntryLive } = await import('./EntryLive.tsx');

const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';

test('GAT-360 입장 탭 실제 값 부품은 첫 그리기에 목업 수를 쓰지 않고 불러오는 중이다', () => {
  const html = renderToString(createElement(EntryLive, { eventId: E }));
  assert.match(html, /입장 값을 불러오는 중/);
  assert.doesNotMatch(html, /7 \/ 7대|중복 입장 12|세션 밖 기록/);
});
