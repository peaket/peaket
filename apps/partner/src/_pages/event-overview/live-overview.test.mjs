// F-07-12 SCR-063 배선(AC-06, TR-03). UUID 공연이고 ?state=가 없을 때만 라이브 경로를 고르며,
// 목업 `requireProduction`보다 먼저 분기한다. 값·상태 렌더는 live-view.test.mjs가 본다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';

register('../../shared/lib/test-ts-resolve.mjs', import.meta.url);

const pageUrl = new URL('./ui/EventOverviewPage.tsx', import.meta.url);
const liveUrl = new URL('./ui/LiveEventOverview.tsx', import.meta.url);
const viewUrl = new URL('./ui/live-view.ts', import.meta.url);
const page = () => readFileSync(pageUrl, 'utf8');
const live = () => readFileSync(liveUrl, 'utf8');
const UUID = '0190f3a1-7c2e-7a00-8000-000000000301';

test('F-07-12 AC-06 UO-13 UUID+?state= 없음에서만 라이브를 고르고 목업 분기보다 먼저 본다', async () => {
  assert.equal(existsSync(liveUrl), true, 'LiveEventOverview.tsx가 없다');
  assert.equal(existsSync(viewUrl), true, 'ui/live-view.ts가 없다');
  const { overviewModeOf } = await import('./model/live.ts');
  assert.equal(overviewModeOf(UUID, {}), 'live');
  assert.equal(overviewModeOf(UUID, { state: '기본' }), 'preview');
  assert.equal(overviewModeOf('evt-lumen-2026', {}), 'preview');
  const src = page();
  assert.match(src, /overviewModeOf/);
  assert.match(src, /LiveEventOverview/);
  assert.ok(src.indexOf('overviewModeOf') < src.indexOf('requireProduction'), '목업 requireProduction보다 먼저 분기해야 한다');
  assert.match(src, /PreviewStateSwitcher/, '?state= 목업 미리보기를 지우면 안 된다');
});

test('F-07-12 AC-06 UO-14 라이브 화면·뷰가 API·allSettled를 쓰고 HTML을 주입하지 않는다 [ASVS v5.0.0-1.2.1]', () => {
  const src = live();
  const view = readFileSync(viewUrl, 'utf8');
  assert.match(src, /OverviewLiveView/);
  assert.match(src, /getPartnerProduction/);
  assert.match(src, /getPartnerSellerProfile/);
  assert.match(src, /productionOfDetail/);
  assert.match(src, /progressOf/);
  assert.match(src, /eventRowsOf/);
  assert.match(src, /Promise\.allSettled/);
  for (const file of [src, view, page()]) assert.equal(/dangerouslySetInnerHTML|innerHTML/.test(file), false);
});
