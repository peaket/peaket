// 에디터 저장소 시험(docs/frontend.md §3.9, ADR-0264 결정 4·8·13, FR-023 10단계 정확 복원).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyDoc } from './doc.ts';
import { patchSeats, removeSeats } from './refine.ts';
import { rectPoints } from './shapes.ts';
import { addShapeCmd, createEditorStore, fillCmd, removeShapeCmd, replaceCmd, seatsCmd, tiersCmd, UNDO_LIMIT, updateSectionCmd } from './store.ts';

const clone = (v) => structuredClone(v);
const rect = (x) => ({ kind: 'RECT', points: rectPoints({ x, y: 1000, w: 500, h: 400, rotation: 0 }) });

test('FE-T46 ⑥ 편집 10번 뒤 되돌리기 10번은 10단계 전 문서와 같고 201번째에 가장 오래된 단계가 버려진다', () => {
  const st = createEditorStore(emptyDoc(), 9, false, { idPrefix: 'u' });
  const s = st.getState;
  s().exec(addShapeCmd(s().doc, 'section', rect(1000), 's1'));
  const start = clone(s().doc);
  const states = [];
  for (let i = 0; i < 10; i++) {
    states.push(clone(s().doc));
    if (i % 3 === 0) s().exec(updateSectionCmd(s().doc, 's1', { name: `구역 ${i}` }));
    else if (i % 3 === 1) s().exec(addShapeCmd(s().doc, 'section', rect(2000 + i * 600), `s${i + 2}`));
    else s().exec(fillCmd(s().doc, 's1', [{ seatId: `n${i}`, row: '1', number: 1, x: 1100, y: 1100 }], { method: 'COUNT', targetCount: 1 }));
  }
  assert.equal(s().changes, 11);
  for (let i = 9; i >= 0; i--) {
    assert.equal(s().undo(), true);
    assert.deepEqual(s().doc, states[i]);
  }
  assert.deepEqual(s().doc, start);
  assert.equal(s().changes, 1);
  // 다시 하기 10번은 10단계 뒤 문서
  for (let i = 0; i < 10; i++) s().redo();
  assert.equal(s().future.length, 0);
  assert.equal(s().doc.order.length, 4);

  // 상한 200: 201번째 명령에서 가장 오래된 단계 하나만 버린다
  const big = createEditorStore(emptyDoc(), 0, false, { idPrefix: 'b' });
  const b = big.getState;
  b().exec(addShapeCmd(b().doc, 'section', rect(1000), 's1'));
  const afterFirst = clone(b().doc);
  for (let i = 0; i < 199; i++) b().exec(updateSectionCmd(b().doc, 's1', { name: `이름 ${i}` }));
  assert.equal(b().past.length, UNDO_LIMIT);
  assert.equal(UNDO_LIMIT, 200);
  b().exec(updateSectionCmd(b().doc, 's1', { name: '201번째' }));
  assert.equal(b().past.length, 200);
  assert.equal(b().changes, 201);
  for (let i = 0; i < 200; i++) assert.equal(b().undo(), true);
  // 남은 것은 첫 명령(구역 더하기) 뒤의 문서다. 그보다 앞으로는 못 간다
  assert.deepEqual(b().doc, afterFirst);
  assert.equal(b().undo(), false);
  assert.equal(b().changes, 1);
});

test('FE-T46 ⑦ 저장에 성공하면 응답 문서로 갈아끼우고 되돌리기 기록·변경 수가 0이며, 실패 때는 문서·변경 수·기록이 그대로다', () => {
  const st = createEditorStore(emptyDoc(), 0, false, { idPrefix: 's' });
  const s = st.getState;
  s().exec(addShapeCmd(s().doc, 'section', rect(1000), 's1'));
  s().exec(tiersCmd(s().doc, [{ tierId: 't1', name: 'R석', price: 1000 }]));
  const before = clone(s().doc);
  // 실패(412 등): 저장소를 건드리지 않는다
  assert.deepEqual([s().doc, s().changes, s().past.length, s().version], [before, 2, 2, 0]);
  // 성공: 서버 문서(좌석 ID가 바뀐 것)와 판 1
  const server = { ...before, sections: { s1: { ...before.sections.s1, seats: [{ seatId: '0193a3c4-0000-7000-8000-000000000001', row: '1', number: 1, x: 1100, y: 1100 }] } } };
  s().selectSeats(['old-id']);
  s().reset(server, 1, false);
  assert.deepEqual([s().changes, s().past.length, s().future.length, s().version, s().seatSel.size], [0, 0, 0, 1, 0]);
  assert.equal(s().undo(), false);
  assert.deepEqual(s().doc, server);
});

test('FE-T46 ⑫ geometryLocked 공연은 도형·좌석 편집과 가격 등급이 꺼지고 속성만 바뀐다', () => {
  const base = emptyDoc();
  const doc = {
    ...base,
    order: ['s1'],
    sections: { s1: { sectionId: 's1', name: 'A', shape: rect(1000), tierId: 'R', seats: [{ seatId: 'a', row: '1', number: 1, x: 1100, y: 1100 }] } },
    priceTiers: [{ tierId: 'R', name: 'R석', price: 1000 }],
  };
  const st = createEditorStore(doc, 3, true, { idPrefix: 'l' });
  const s = st.getState;
  const ids = new Set(['a']);
  assert.equal(s().exec(addShapeCmd(s().doc, 'section', rect(3000), 's2')), false);
  assert.equal(s().exec(removeShapeCmd(s().doc, { kind: 'section', id: 's1' })), false);
  assert.equal(s().exec(seatsCmd(s().doc, '지우기', removeSeats(s().doc, ids))), false);
  assert.equal(s().exec(tiersCmd(s().doc, [{ tierId: 'R', name: 'R석', price: 2000 }])), false);
  assert.equal(s().exec(updateSectionCmd(s().doc, 's1', { name: '바꾼 이름' })), false);
  assert.equal(s().exec(replaceCmd(s().doc, base)), false);
  assert.equal(s().changes, 0);
  // 판매 제외·휠체어석·게이트와 구역 게이트만 받는다
  assert.equal(s().exec(seatsCmd(s().doc, '판매 제외', patchSeats(s().doc, ids, { unavailable: true, wheelchair: true, gateZone: 'G1' }), false)), true);
  assert.equal(s().exec(updateSectionCmd(s().doc, 's1', { gateZone: 'G9' })), true);
  assert.deepEqual(s().doc.sections.s1.seats[0], { seatId: 'a', row: '1', number: 1, x: 1100, y: 1100, wheelchair: true, unavailable: true, gateZone: 'G1' });
  assert.equal(s().doc.sections.s1.gateZone, 'G9');
  assert.equal(s().changes, 2);
});
