// F-07-12 SCR-062 배선(AC-05). ?state=가 없을 때만 라이브 경로를 고르고, 라이브 화면이 실제 API·순수 변환 함수를 쓰는지 본다.
// 값·문구는 model/live.test.mjs가 보고, 이 시험은 페이지가 목업으로 되돌아가지 않는지와 HTML 주입이 없는지만 본다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const pageUrl = new URL('./ui/PartnerHomePage.tsx', import.meta.url);
const liveUrl = new URL('./ui/LivePartnerHome.tsx', import.meta.url);
const page = () => readFileSync(pageUrl, 'utf8');
const live = () => readFileSync(liveUrl, 'utf8');

test('F-07-12 AC-05 UH-08 SCR-062는 ?state=가 없으면 라이브를, 있으면 목업 미리보기를 고른다', () => {
  assert.equal(existsSync(liveUrl), true, 'LivePartnerHome.tsx가 없다');
  const src = page();
  assert.match(src, /LivePartnerHome/);
  assert.match(src, /readParam\([^)]*'state'\)|sp\.state/);
  assert.match(src, /PreviewStateSwitcher/, '?state= 목업 미리보기를 지우면 안 된다');
});

test('F-07-12 AC-05 UH-09 라이브 화면은 목록·할 일 API와 변환 함수를 쓰고 HTML을 주입하지 않는다 [ASVS v5.0.0-1.2.1]', () => {
  const src = live();
  assert.match(src, /listPartnerProductions/);
  assert.match(src, /getPartnerTodoSummary/);
  assert.match(src, /homeRowsOf/);
  assert.match(src, /todoCardsOf/);
  assert.match(src, /Promise\.allSettled/, '할 일이 실패해도 목록은 그려야 한다');
  assert.equal(/dangerouslySetInnerHTML|innerHTML/.test(src), false);
  assert.equal(/dangerouslySetInnerHTML|innerHTML/.test(page()), false);
});
