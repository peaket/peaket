// '등급과 가격' 패널 시험(ADR-0264 결정 11). 차례가 저장 본문 차례와 같고, 16개 경계(16은 되고 17은 안 된다), 좌석이 쓰는 등급은 지우지 못한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyDoc, saveBody } from './doc.ts';
import { addTier, canRemoveTier, moveTier, newTierId, PRICE_MAX, removeTier, tierErrors, tierSummary, TIERS_MAX, updateTier } from './price-tiers.ts';

test('FE-T46 ⑨ 가격 등급 차례가 저장 본문 차례와 같고 17번째를 더할 수 없으며 좌석이 쓰는 등급은 지우지 못한다', () => {
  let tiers = [];
  for (let i = 0; i < 3; i++) tiers = addTier(tiers);
  assert.deepEqual(tiers.map((t) => t.tierId), ['t1', 't2', 't3']);
  tiers = updateTier(tiers, 't1', { name: 'R석', price: 150_000 });
  tiers = updateTier(tiers, 't2', { name: 'S석', price: 99_000 });
  tiers = updateTier(tiers, 't3', { name: 'A석', price: 70_000 });
  // [위로]·[아래로]: A를 맨 앞으로 올리고 R을 맨 뒤로 내린다
  tiers = moveTier(tiers, 2, -1);
  tiers = moveTier(tiers, 1, -1);
  tiers = moveTier(tiers, 1, 1);
  assert.deepEqual(tiers.map((t) => t.name), ['A석', 'S석', 'R석']);
  assert.equal(moveTier(tiers, 0, -1), undefined);
  assert.equal(moveTier(tiers, 2, 1), undefined);
  const doc = {
    ...emptyDoc(),
    order: ['s1', 's2'],
    sections: {
      s1: { sectionId: 's1', name: 'A', shape: { kind: 'RECT', points: [[0, 0], [10, 0], [10, 10], [0, 10]] }, tierId: 't3', seats: [{ seatId: 'a', row: '1', number: 1, x: 5, y: 5 }, { seatId: 'b', row: '1', number: 2, x: 6, y: 5, tierId: 't1' }] },
      s2: { sectionId: 's2', name: 'B', shape: { kind: 'RECT', points: [[20, 0], [30, 0], [30, 10], [20, 10]] }, seats: [] },
    },
    priceTiers: tiers,
  };
  // 저장 본문 priceTiers 차례가 화면 차례와 같다
  assert.deepEqual(saveBody(doc, 2).priceTiers, [
    { tierId: 't3', name: 'A석', price: 70_000 },
    { tierId: 't2', name: 'S석', price: 99_000 },
    { tierId: 't1', name: 'R석', price: 150_000 },
  ]);
  // 좌석이 쓰는 등급(구역 기본 t3, 좌석 t1)은 지우지 못하고 쓰지 않는 t2는 지운다
  assert.equal(canRemoveTier(doc, 't3'), false);
  assert.equal(canRemoveTier(doc, 't1'), false);
  assert.equal(removeTier(doc, 't1'), undefined);
  assert.deepEqual(removeTier(doc, 't2').map((t) => t.tierId), ['t3', 't1']);
  assert.deepEqual(tierSummary(doc).map((t) => [t.tierId, t.seats, t.revenue]), [['t3', 1, 70_000], ['t2', 0, 0], ['t1', 1, 150_000]]);
  // 16개 경계
  let full = [...tiers];
  while (full.length < 15) full = addTier(full);
  assert.equal(full.length, 15);
  full = addTier(full);
  assert.equal(full.length, TIERS_MAX);
  assert.equal(TIERS_MAX, 16);
  assert.equal(addTier(full), undefined);
  // 새 ID는 겹치지 않는다(지운 자리를 다시 쓴다)
  assert.equal(newTierId([{ tierId: 't1' }, { tierId: 't3' }]), 't2');
  // 이름 1~30자, 가격 1~10,000,000(양쪽 경계)
  const t = { tierId: 'x', name: 'a'.repeat(30), price: 1 };
  assert.deepEqual(tierErrors(t), {});
  assert.deepEqual(Object.keys(tierErrors({ ...t, name: 'a'.repeat(31), price: 0 })).sort(), ['name', 'price']);
  assert.deepEqual(tierErrors({ ...t, price: PRICE_MAX }), {});
  assert.equal(tierErrors({ ...t, price: PRICE_MAX + 1 }).price, '가격은 1~10,000,000원입니다');
  assert.equal(tierErrors({ ...t, name: '  ' }).name, '이름을 넣어 주세요');
  assert.equal(tierErrors({ ...t, name: 'R\u0007' }).name, '쓸 수 없는 글자가 있습니다');
  assert.equal(tierErrors({ ...t, price: null }).price, '가격을 넣어 주세요');
});
