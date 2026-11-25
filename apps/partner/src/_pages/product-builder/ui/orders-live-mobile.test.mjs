// F-07-9 SCR-023 굿즈 주문 현황의 휴대폰 배치(I-03, AC-04). d5 §3.9: 표는 카드 목록으로 바꾸고
// 카드마다 주문·수량·택배·현장 수령·취소·반품 값을 둔다. 낱말이 파일 어딘가에 있는지가 아니라
// 모바일 카드 블록 안에서 값이 그려지는지, 데스크톱 표와 구분되는지를 본다. 기준 트리에서 실패한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./live/OrdersLive.tsx', import.meta.url), 'utf8');

/** aria-label이 붙은 모바일 카드 목록 블록만 잘라 낸다(데스크톱 표와 섞지 않는다) */
function mobileBlock() {
  const start = source.indexOf('aria-label="상품별 주문');
  assert.ok(start > -1, '모바일 카드 목록(aria-label="상품별 주문")이 없다');
  const open = source.lastIndexOf('<ul', start);
  const close = source.indexOf('</ul>', start);
  assert.ok(open > -1 && close > open, '모바일 카드 목록의 <ul>~</ul>을 찾지 못했다');
  return source.slice(open, close);
}

test('AC-04 모바일 카드 목록 안에서 상품 이름과 주문·수량·택배·현장 수령·취소·반품 값을 그린다', () => {
  const block = mobileBlock();
  for (const prop of ['productName', 'orderCount', 'quantity', 'deliveryQuantity', 'pickupQuantity', 'cancelCount', 'returnCount']) {
    assert.match(block, new RegExp(`\\b${prop}\\b`), `모바일 카드에 ${prop} 값이 없다`);
  }
  for (const label of ['주문', '수량', '택배', '현장 수령', '취소', '반품']) assert.ok(block.includes(label), `모바일 카드에 '${label}' 이름표가 없다`);
  assert.doesNotMatch(block, /<table/, '모바일 카드 블록 안에 표가 있다');
});

test('AC-04 데스크톱 표는 휴대폰에서 숨기고, 모바일 카드와 다른 블록이다', () => {
  const table = source.indexOf('table-wrap');
  const tableTag = source.indexOf('<table', table);
  assert.ok(table > -1 && tableTag > table, '데스크톱 표를 찾지 못했다');
  assert.match(source.slice(table, tableTag), /max-md:hidden/);
  assert.ok(tableTag < source.indexOf('aria-label="상품별 주문'), '표와 모바일 카드의 차례가 뒤집혔다');
});

test('AC-04 주문 0건 안내는 그대로 남는다', () => {
  assert.match(source, /totals\.orderCount === 0/);
  assert.match(source, /아직 주문이 없습니다/);
});
