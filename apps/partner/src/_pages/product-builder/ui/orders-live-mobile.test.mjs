// F-07-9 SCR-023 굿즈 주문 현황의 휴대폰 배치(I-03, AC-04). d5 §3.9: 표는 카드 목록으로 바꾸고
// 핵심 열만 둔다. 지금은 표만 숨겨 휴대폰에 빈 자리가 남는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./live/OrdersLive.tsx', import.meta.url), 'utf8');

test('AC-04 휴대폰에는 상품별 카드가 주문·수량·택배·현장 수령·취소·반품을 보인다', () => {
  assert.match(source, /className="[^"]*\bmd:hidden\b[^"]*"[\s\S]{0,600}page\.data\.items\.map/);
  for (const label of ['주문', '수량', '택배', '현장 수령', '취소', '반품']) assert.ok(source.includes(label), label);
  assert.match(source, /aria-label="[^"]*상품별 주문/);
});

test('AC-04 표는 휴대폰에서 숨기고, 주문 0건 안내는 남긴다', () => {
  assert.match(source, /className="table-wrap max-md:hidden"/);
  assert.match(source, /EmptyCard/);
  assert.match(source, /아직 주문이 없습니다/);
});
