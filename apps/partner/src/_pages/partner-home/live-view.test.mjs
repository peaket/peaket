// F-07-12 SCR-062 라이브 화면의 실제 렌더·상태(TR-03). 정본: d5 §6.2, frontend §4.2.5,
// ASVS catalog-review 1.2.1·3.2.2. `?state=` 목업이 아니라 API 결과를 그리는 화면 조각을 본다.
// 기준 트리에는 ui/live-view.ts가 없어 각 시험이 실패한다.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register('../../shared/lib/test-ts-resolve.mjs', import.meta.url);
const load = () => import('./ui/live-view.ts');

const row = (over = {}) => ({
  productionId: 'prod-1',
  name: 'LUMEN 콘서트 2026 서울',
  eventCount: 2,
  reviewLabel: '승인',
  reviewBadge: 'badge badge-success',
  reviewNote: null,
  firstOpenText: '10/14(수) 20:00 KST',
  saleStatusText: '판매 중',
  saleStatusBadge: 'badge badge-success',
  nextActions: [
    { href: '/events/prod-1/live', label: '판매 현황' },
    { href: '/events/prod-1/staff', label: '현장' },
  ],
  xl: { provider: '—', settlement: '—', staff: '—' },
  ...over,
});

const card = (label, value, meta = '', href) => ({ label, value, meta, ...(href ? { href } : {}) });

test('F-07-12 AC-05 UH-08 0건이면 빈 화면과 새 공연 등록을 그린다', async () => {
  const { HomeLiveView } = await load();
  const html = renderToStaticMarkup(createElement(HomeLiveView, { mode: 'empty' }));
  assert.match(html, /등록한 공연이 없습니다/);
  assert.match(html, /새 공연 등록/);
  assert.match(html, /href="\/events\/new"/);
});

test('F-07-12 AC-05 UH-09 목록 실패·필터 400이면 오류 카드와 다시 시도를 그린다', async () => {
  const { HomeLiveView } = await load();
  const loadError = renderToStaticMarkup(createElement(HomeLiveView, { mode: 'error', message: null }));
  assert.match(loadError, /<h1/);
  assert.match(loadError, /공연 목록을 불러오지 못했습니다/);
  assert.match(loadError, /다시 시도/);

  const filterError = renderToStaticMarkup(createElement(HomeLiveView, { mode: 'error', message: '조건을 다시 확인해 주세요' }));
  assert.match(filterError, /조건을 다시 확인해 주세요/);
  assert.match(filterError, /다시 시도/);
});

test('F-07-12 AC-05 UH-10 할 일만 실패해도 목록 행은 그린다(Promise.allSettled 부분 실패)', async () => {
  const { HomeLiveView } = await load();
  const html = renderToStaticMarkup(createElement(HomeLiveView, { mode: 'ready', rows: [row()], todo: null }));
  assert.match(html, /LUMEN 콘서트 2026 서울/);
  assert.match(html, /할 일을 불러오지 못했습니다/);
  assert.match(html, /판매 현황/);
});

test('F-07-12 AC-05 UH-11 성공 화면은 공연명·판매 승인·첫 오픈·판매 상태·다음 할 일을 글자로 그린다 [ASVS v5.0.0-1.2.1] [ASVS v5.0.0-3.2.2]', async () => {
  const { HomeLiveView } = await load();
  const evil = '<img src=x onerror=alert(1)>';
  const html = renderToStaticMarkup(
    createElement(HomeLiveView, {
      mode: 'ready',
      rows: [row({ name: `공연 ${evil}`, reviewLabel: '변경 반려', reviewNote: `사유 ${evil}`, firstOpenText: '12/10(목) 20:00 KST', saleStatusText: '매진' })],
      todo: [card('반려된 판매 승인', '1건', '가을 뮤지컬', '/events')],
    }),
  );
  assert.match(html, /공연 &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /변경 반려/);
  assert.match(html, /사유 &lt;img/);
  assert.match(html, /12\/10\(목\) 20:00 KST/);
  assert.match(html, /매진/);
  assert.match(html, /판매 현황/);
  assert.match(html, /반려된 판매 승인/);
  assert.match(html, /1건/);
});

test('F-07-12 AC-05 UH-12 로딩이면 목록을 불러오는 중임을 그린다', async () => {
  const { HomeLiveView } = await load();
  const html = renderToStaticMarkup(createElement(HomeLiveView, { mode: 'loading' }));
  assert.match(html, /공연 목록을 불러오고 있습니다/);
});
