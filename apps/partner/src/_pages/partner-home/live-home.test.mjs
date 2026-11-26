// F-07-12 SCR-062 배선(AC-05, TR-03). ?state=가 없을 때만 라이브 경로를 고르고,
// 라이브 화면이 실제 뷰 함수·API·부분 실패 처리를 쓰는지 본다. 값·상태 렌더는 live-view.test.mjs가 본다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';

register('../../shared/lib/test-ts-resolve.mjs', import.meta.url);

const pageUrl = new URL('./ui/PartnerHomePage.tsx', import.meta.url);
const liveUrl = new URL('./ui/LivePartnerHome.tsx', import.meta.url);
const viewUrl = new URL('./ui/live-view.ts', import.meta.url);
const page = () => readFileSync(pageUrl, 'utf8');
const live = () => readFileSync(liveUrl, 'utf8');

test('F-07-12 AC-05 UH-13 ?state=가 없으면 라이브, 있으면 목업 미리보기를 고른다', async () => {
  assert.equal(existsSync(liveUrl), true, 'LivePartnerHome.tsx가 없다');
  assert.equal(existsSync(viewUrl), true, 'ui/live-view.ts가 없다');
  const { homeModeOf } = await import('./model/live.ts');
  assert.equal(homeModeOf({}), 'live');
  assert.equal(homeModeOf({ state: undefined }), 'live');
  assert.equal(homeModeOf({ state: '목록' }), 'preview');
  const src = page();
  assert.match(src, /homeModeOf/);
  assert.match(src, /LivePartnerHome/);
  assert.match(src, /PreviewStateSwitcher/, '?state= 목업 미리보기를 지우면 안 된다');
});

test('F-07-12 AC-05 UH-14 라이브 화면·뷰가 두 API·allSettled를 쓰고 HTML을 주입하지 않는다 [ASVS v5.0.0-1.2.1]', () => {
  const src = live();
  const view = readFileSync(viewUrl, 'utf8');
  assert.match(src, /HomeLiveView/);
  assert.match(src, /listPartnerProductions/);
  assert.match(src, /getPartnerTodoSummary/);
  assert.match(src, /homeRowsOf/);
  assert.match(src, /todoCardsOf/);
  assert.match(src, /Promise\.allSettled/, '할 일이 실패해도 목록은 그려야 한다');
  for (const file of [src, view, page()]) assert.equal(/dangerouslySetInnerHTML|innerHTML/.test(file), false);
});
