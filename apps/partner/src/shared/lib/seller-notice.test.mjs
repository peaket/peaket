// F-07-9 중개자 고지·정산 주체 문구(I-04, AC-05·AC-06·AC-08). 정본은 transfer-refund §2.2·§4,
// settlement §3·§6, POL-037·POL-039다. 화면 조각을 읽지 않고 순수 함수의 반환 글자와 React 렌더 결과를 본다.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register('./test-ts-resolve.mjs', import.meta.url);
const { performanceSellerNotice, productSellerNotice, settlementDisclosure } = await import('./seller-notice.ts');

const PERFORMANCE = 'PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다. 공연의 개최·변경·취소에 따른 책임은 판매자에게 있고, 예매 취소와 환불은 PEAKET이 처리합니다';
const PRODUCT = 'PEAKET은 통신판매중개자로서 이 상품 거래의 당사자가 아닙니다. 상품의 제공(배송·이용)과 품질에 따른 책임은 판매자에게 있고, 주문 취소·반품과 환불은 PEAKET이 처리합니다';

test('AC-05·AC-06 공연용 중개자 고지는 POL-037 원문과 글자까지 같다', () => {
  assert.equal(performanceSellerNotice('(주)피켓공연'), `판매자: (주)피켓공연. ${PERFORMANCE}`);
  assert.equal(performanceSellerNotice('  (주)피켓공연  '), `판매자: (주)피켓공연. ${PERFORMANCE}`);
});

test('AC-05 상호가 비면 "판매자: ."를 만들지 않고 고지 문장만 보인다', () => {
  assert.equal(performanceSellerNotice(''), PERFORMANCE);
  assert.equal(performanceSellerNotice('   '), PERFORMANCE);
});

test('AC-05 상품용 중개자 고지는 POL-037 상품용 원문과 글자까지 같다', () => {
  assert.equal(productSellerNotice('(주)피켓공연'), `판매자: (주)피켓공연. ${PRODUCT}`);
  assert.equal(productSellerNotice(''), PRODUCT);
});

test('AC-05 정산 주체 표는 판매자·예금주·중개수수료율·환불·양도 책임 다섯 행이다', () => {
  assert.deepEqual(settlementDisclosure({ sellerName: '(주)피켓공연', payoutHolder: '(주)피켓공연', commissionRate: '10.00%' }), [
    { label: '판매자(정산 받는 곳)', value: '(주)피켓공연' },
    { label: '정산 계좌 예금주', value: '(주)피켓공연 · 판매자 상호나 대표자와 같아야 합니다' },
    { label: '중개수수료율', value: '10.00%' },
    { label: '예매 취소·환불', value: 'PEAKET이 처리하고, 환불은 결제자에게 갑니다' },
    { label: '양도·재판매', value: '양도는 PEAKET이 처리하고, 티켓값 정산은 당사자끼리 합니다. 부정판매는 처벌·과징금 대상입니다' },
  ]);
});

test('AC-05 빈 판매자·예금주·수수료율은 빈칸이 아니라 "확인 필요"다', () => {
  const rows = settlementDisclosure({ sellerName: '', payoutHolder: '  ', commissionRate: '' });
  assert.deepEqual(rows.map((r) => r.value), [
    '확인 필요',
    '확인 필요 · 판매자 상호나 대표자와 같아야 합니다',
    '확인 필요',
    'PEAKET이 처리하고, 환불은 결제자에게 갑니다',
    '양도는 PEAKET이 처리하고, 티켓값 정산은 당사자끼리 합니다. 부정판매는 처벌·과징금 대상입니다',
  ]);
});

test('AC-05 경계: 1자·100자·줄바꿈·<·&가 든 상호도 고지 안에서 글자로 남는다', () => {
  for (const name of ['가', '가'.repeat(100), '가\n나', '가<나', '가&나']) {
    const text = performanceSellerNotice(name);
    assert.ok(text.includes(name), `${JSON.stringify(name)}가 고지에 없다`);
    assert.ok(text.endsWith(PERFORMANCE), '고지 문장이 끝까지 이어지지 않는다');
  }
});

test('AC-08 F-13 상호에 HTML을 넣어도 React가 글자로 그리고 요소를 만들지 않는다 [ASVS v5.0.0-1.2.1] [ASVS v5.0.0-3.2.2]', () => {
  const html = renderToStaticMarkup(createElement('p', null, performanceSellerNotice('<img src=x onerror=alert(1)>')));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img\b/);
});

test('AC-06 상호가 바뀌면 렌더한 고지의 상호도 바뀐다', () => {
  const one = renderToStaticMarkup(createElement('p', null, performanceSellerNotice('(주)피켓공연')));
  const two = renderToStaticMarkup(createElement('p', null, performanceSellerNotice('(주)다른공연')));
  assert.match(one, /판매자: \(주\)피켓공연\./);
  assert.match(two, /판매자: \(주\)다른공연\./);
  assert.notEqual(one, two);
});
