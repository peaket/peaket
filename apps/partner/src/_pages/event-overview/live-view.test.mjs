// F-07-12 SCR-063 라이브 화면의 실제 렌더·상태(TR-03). 정본: d5 §6.3, frontend §4.2.5,
// ASVS catalog-review 1.2.1·3.2.2. 공연 문맥 머리·진행 단계·회차 표·판매자 고지·404·오류를 본다.
// 기준 트리에는 ui/live-view.ts가 없어 각 시험이 실패한다.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register('../../shared/lib/test-ts-resolve.mjs', import.meta.url);
const load = () => import('./ui/live-view.ts');

const production = (over = {}) => ({
  id: 'prod-1',
  name: 'LUMEN 콘서트 2026 서울',
  reviewLabel: '판매 승인됨',
  reviewBadge: 'badge badge-success',
  firstOpenText: '10/14(수) 20:00 KST',
  meta: '피켓 아레나 · 회차 2개',
  roundCount: 2,
  ...over,
});

const steps = [
  { label: '등록', meta: '완료' },
  { label: '판매 승인', meta: '10/8(목) 승인' },
  { label: '오픈', meta: '10/14(수) 20:00 KST' },
  { label: '판매', meta: '판매 중' },
  { label: '입장', meta: '10/25(일) 16:30 KST' },
  { label: '입장 기록 마감', meta: '회차마다' },
  { label: '정산', meta: '회차 종료 다음 영업일' },
];

const round = (over = {}) => ({
  startsAt: '10/25(일) 18:00 KST',
  doorsAt: '16:30 KST',
  endsAt: '20:00 KST',
  saleStatusText: '판매 중',
  saleRateText: '50%',
  ...over,
});

const seller = {
  notice: '판매자: (주)피켓공연. PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다.',
  fields: [
    { label: '상호', value: '(주)피켓공연' },
    { label: '대표자', value: '대표자' },
    { label: '주소', value: '서울 어딘가 1' },
    { label: '연락처', value: '02-0000-0000' },
    { label: '이메일', value: 'seller@example.test' },
    { label: '사업자등록번호', value: '123-45-67890' },
    { label: '통신판매업 신고번호', value: '2026-서울-0001' },
  ],
};

test('F-07-12 AC-06 UO-06 404면 없는 공연 안내와 공연 관리로 돌아가는 길을 그린다', async () => {
  const { OverviewLiveView } = await load();
  const html = renderToStaticMarkup(createElement(OverviewLiveView, { mode: 'notFound' }));
  assert.match(html, /<h1/);
  assert.match(html, /공연을 찾을 수 없습니다/);
  assert.match(html, /href="\/events"/);
});

test('F-07-12 AC-06 UO-07 실패면 오류 카드와 다시 시도를 그린다', async () => {
  const { OverviewLiveView } = await load();
  const html = renderToStaticMarkup(createElement(OverviewLiveView, { mode: 'error', message: null }));
  assert.match(html, /<h1/);
  assert.match(html, /공연 개요를 불러오지 못했습니다/);
  assert.match(html, /다시 시도/);
});

test('F-07-12 AC-06 UO-08 성공 화면은 진행 단계·회차·바로가기·판매자 고지 7항목을 그린다 [ASVS v5.0.0-1.2.1] [ASVS v5.0.0-3.2.2]', async () => {
  const { OverviewLiveView } = await load();
  const html = renderToStaticMarkup(
    createElement(OverviewLiveView, {
      mode: 'ready',
      production: production(),
      progress: { steps, current: 3 },
      rounds: [round(), round({ startsAt: '10/26(월) 17:00 KST', doorsAt: '15:30 KST', endsAt: '19:00 KST', saleStatusText: '오픈 예정', saleRateText: '—' })],
      seller,
    }),
  );
  assert.match(html, /LUMEN 콘서트 2026 서울/);
  for (const label of steps.map((s) => s.label)) assert.match(html, new RegExp(label));
  assert.match(html, /10\/25\(일\) 18:00 KST/);
  assert.match(html, /16:30 KST/);
  assert.match(html, /20:00 KST/);
  assert.match(html, /판매 중/);
  assert.match(html, /50%/);
  assert.match(html, /10\/26\(월\) 17:00 KST/);
  assert.match(html, /오픈 예정/);
  assert.match(html, /판매 현황/);
  assert.match(html, /정산·명단/);
  assert.match(html, /판매자 고지 미리보기/);
  assert.match(html, /통신판매중개자/);
  assert.match(html, /상호/);
  assert.match(html, /통신판매업 신고번호/);
  assert.equal((html.match(/<dt/g) ?? []).length >= 7, true, '판매자 7항목');
});

test('F-07-12 AC-06 UO-09 판매자 정보가 없으면 고지 대신 실패 안내를 그린다', async () => {
  const { OverviewLiveView } = await load();
  const html = renderToStaticMarkup(
    createElement(OverviewLiveView, { mode: 'ready', production: production(), progress: { steps, current: 3 }, rounds: [round()], seller: null }),
  );
  assert.match(html, /판매자 정보를 불러오지 못했습니다/);
  assert.match(html, /LUMEN 콘서트 2026 서울/);
});

test('F-07-12 AC-06 UO-10 공연명·판매자 상호에 HTML을 넣어도 요소가 생기지 않는다 [ASVS v5.0.0-1.2.1]', async () => {
  const { OverviewLiveView } = await load();
  const evil = '<img src=x onerror=alert(1)>';
  const html = renderToStaticMarkup(
    createElement(OverviewLiveView, {
      mode: 'ready',
      production: production({ name: `공연 ${evil}`, reviewLabel: `배지 ${evil}` }),
      progress: { steps, current: 3 },
      rounds: [round()],
      seller: { ...seller, notice: `판매자: ${evil}`, fields: seller.fields.map((f) => ({ ...f, value: f.value })) },
    }),
  );
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('F-07-12 AC-06 UO-11 로딩이면 개요를 불러오는 중임을 그린다', async () => {
  const { OverviewLiveView } = await load();
  const html = renderToStaticMarkup(createElement(OverviewLiveView, { mode: 'loading' }));
  assert.match(html, /공연 개요를 불러오고 있습니다/);
});

test('F-07-12 AC-06 UO-12 회차가 0개면 빈 회차 안내를 그린다', async () => {
  const { OverviewLiveView } = await load();
  const html = renderToStaticMarkup(
    createElement(OverviewLiveView, { mode: 'ready', production: production({ roundCount: 0 }), progress: { steps, current: 0 }, rounds: [], seller }),
  );
  assert.match(html, /등록된 회차가 없습니다/);
  assert.match(html, /LUMEN 콘서트 2026 서울/);
});
