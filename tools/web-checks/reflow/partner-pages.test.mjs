// F-07-9 LCH-130 파트너 콘솔 전 화면이 reflow(FE-T31) 목록에 있는지 본다. 화면이 늘었는데 목록에
// 빠지면 '전 화면' 약속이 조용히 깨지므로 경로를 고정한다. 브라우저 실행은 partner-mobile.spec.mjs가 한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REFLOW_PAGES } from './rules.mjs';

const PARTNER = [
  '/events',
  '/events/new',
  '/events/evt-lumen-2026',
  '/events/evt-lumen-2026/edit',
  '/events/evt-lumen-2026/sale-review',
  '/events/evt-lumen-2026/seatmap',
  '/events/evt-lumen-2026/policy',
  '/events/evt-lumen-2026/live',
  '/events/evt-lumen-2026/staff',
  '/events/evt-lumen-2026/settlement',
  '/events/evt-lumen-2026/cancellation',
  '/products',
  '/products/new',
  '/products/orders',
  '/products/prd-lightstick',
  '/settings/account',
  '/settings/seller',
  '/settings/payout',
  '/settings/team',
  '/settings/webhooks',
];

test('FE-T31 파트너 콘솔 전 화면 20개가 reflow 목록에 있다', () => {
  const paths = REFLOW_PAGES.filter((p) => p.app === 'partner').map((p) => p.path);
  assert.deepEqual([...paths].sort(), [...PARTNER].sort());
});

test('FE-T31 파트너 목록은 ko이고 ?state= 미리보기를 쓰지 않는다', () => {
  for (const p of REFLOW_PAGES.filter((x) => x.app === 'partner')) {
    assert.equal(p.locale, 'ko', p.path);
    assert.doesNotMatch(p.path, /[?&]state=/, p.path);
  }
});
