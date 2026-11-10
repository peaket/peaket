// ③ 좌석 다듬기 시험(ADR-0264 결정 7, d5 §6.5 ③). 고르기(누름·상자·행·Shift)와 다듬기 일곱의 좌표·번호를 정확한 값으로 본다.
// 고르기는 팬 좌석맵 패키지의 격자 색인(buildGrids·hitTest)을 지난다.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('../../../shared/lib/test-ts-resolve.mjs', import.meta.url);
const { alignRows, distributeRows, insertSeat, moveSeats, patchSeats, removeSeats, renumberRows, rowSeatIds, seatsInBox } = await import('./refine.ts');
const { buildSeatIndex, seatAt, seatsInBoxIndexed } = await import('./seat-index.ts');
const { createEditorStore, seatsCmd } = await import('./store.ts');
const { rectPoints } = await import('./shapes.ts');

const STAGE = [{ kind: 'RECT', points: rectPoints({ x: 3000, y: 200, w: 2000, h: 600, rotation: 0 }) }];

/** 무대 아래 구역 하나: 1열 10석(x = 3000 + 100·i, y = 2000), 2열 10석(y = 2100). 1열 3·5번은 줄에서 벗어나 있다 */
function doc() {
  const seats = [];
  for (const [row, y] of [['1', 2000], ['2', 2100]]) {
    for (let i = 0; i < 10; i++) seats.push({ seatId: `${row}-${i + 1}`, row, number: i + 1, x: 3000 + 100 * i, y: row === '1' && (i === 2 || i === 4) ? y + 30 : y });
  }
  const s = { sectionId: 's1', name: 'A구역', shape: { kind: 'RECT', points: rectPoints({ x: 2800, y: 1800, w: 1400, h: 600, rotation: 0 }) }, seats };
  return { canvas: { width: 8000, height: 6000 }, stage: STAGE, order: ['s1'], sections: { s1: s }, priceTiers: [] };
}
const seatOf = (d, id) => d.sections.s1.seats.find((x) => x.seatId === id);
const apply = (d, changes) => ({ ...d, sections: { ...d.sections, ...changes } });

test('FE-T46 ⑤ 누름·상자·행·Shift 고르기와 다듬기 일곱의 좌표·번호', () => {
  const d = doc();
  // 누름: 격자 색인으로 30cm 안의 가장 가까운 좌석
  const ix = buildSeatIndex(d);
  assert.equal(seatAt(ix, 3205, 2028), '1-3');
  assert.equal(seatAt(ix, 3250, 2000), null);
  // 상자: 격자 칸이 덮는 좌석만(경계 포함)
  assert.deepEqual(seatsInBoxIndexed(ix, { minX: 3100, minY: 1990, maxX: 3400, maxY: 2040 }).sort(), ['1-2', '1-3', '1-4', '1-5'].sort());
  assert.deepEqual(seatsInBoxIndexed(ix, { minX: 3100, minY: 1990, maxX: 3400, maxY: 2040 }).sort(), seatsInBox(d, { minX: 3100, minY: 1990, maxX: 3400, maxY: 2040 }).sort());
  // 행: 그 좌석의 열 전체. Shift는 고른 것에 더한다(저장소)
  assert.equal(rowSeatIds(d, '2-4').length, 10);
  const st = createEditorStore(d, 1, false, { idPrefix: 't' });
  st.getState().selectSeats(['1-1', '1-2']);
  st.getState().selectSeats(['2-1'], true);
  assert.deepEqual([...st.getState().seatSel].sort(), ['1-1', '1-2', '2-1']);
  st.getState().selectSeats(['2-2']);
  assert.deepEqual([...st.getState().seatSel], ['2-2']);

  // 줄 맞추기: 1열 첫(1번 3000,2000)·끝(10번 3900,2000) 좌석을 잇는 직선 위로. 첫·끝 좌석은 그대로
  const row1 = new Set(rowSeatIds(d, '1-1'));
  const aligned = apply(d, alignRows(d, row1));
  assert.deepEqual([seatOf(aligned, '1-3').y, seatOf(aligned, '1-5').y, seatOf(aligned, '1-3').x], [2000, 2000, 3200]);
  assert.equal(seatOf(aligned, '1-1'), seatOf(d, '1-1'));
  assert.equal(seatOf(aligned, '1-10'), seatOf(d, '1-10'));
  // 고르지 않은 행(2열)은 그대로
  assert.equal(aligned.sections.s1.seats.slice(10).every((x, i) => x === d.sections.s1.seats[10 + i]), true);

  // 간격 고르게: 고른 1열 1·2·4번(3000·3100·3300) → 첫·끝 사이 같은 간격(2번 3150)
  const dist = apply(d, distributeRows(d, new Set(['1-1', '1-2', '1-4'])));
  assert.deepEqual([seatOf(dist, '1-1').x, seatOf(dist, '1-2').x, seatOf(dist, '1-4').x], [3000, 3150, 3300]);
  assert.deepEqual(distributeRows(d, new Set(['1-1', '1-4'])), {});

  // 통로 만들기: 고른 좌석을 지우고 양쪽 번호는 그대로
  const aisle = apply(d, removeSeats(d, new Set(['1-5', '1-6'])));
  assert.deepEqual(aisle.sections.s1.seats.filter((x) => x.row === '1').map((x) => x.number), [1, 2, 3, 4, 7, 8, 9, 10]);

  // 좌석 넣기: 누른 자리에 가장 가까운 행(1열)의 가장 큰 번호 + 1, 그 행 끝에 넣는다
  const ins = insertSeat(aisle, 's1', [3450.4, 2010.6], 'n-1');
  assert.deepEqual(ins.seat, { seatId: 'n-1', row: '1', number: 11, x: 3450, y: 2011 });
  const after = apply(aisle, ins.changes).sections.s1.seats;
  assert.deepEqual([after[8].seatId, after[9].row], ['n-1', '2']);

  // 번호 다시 매기기: 고른 좌석이 있는 행만, 무대를 보고 왼쪽(x가 작은 쪽)부터 첫 번호 1로 이어서(통로를 건너)
  const re = apply(aisle, renumberRows(apply(aisle, ins.changes), new Set(['n-1'])));
  const renumbered = renumberRows(apply(aisle, ins.changes), new Set(['n-1'])).s1.seats;
  assert.deepEqual(renumbered.filter((x) => x.row === '1').map((x) => [x.seatId, x.number]), [['1-1', 1], ['1-2', 2], ['1-3', 3], ['1-4', 4], ['1-7', 6], ['1-8', 7], ['1-9', 8], ['1-10', 9], ['n-1', 5]]);
  assert.equal(re.sections.s1.seats.filter((x) => x.row === '2').every((x, i) => x.number === i + 1), true);
  // 오른쪽부터·첫 번호 101(구역 채우기 규칙)
  const ruled = { ...d, sections: { s1: { ...d.sections.s1, fillRule: { method: 'COUNT', numberFrom: 'RIGHT', firstNumber: 101 } } } };
  const r2 = renumberRows(ruled, new Set(['2-1'])).s1.seats.filter((x) => x.row === '2');
  assert.deepEqual([r2[0].number, r2[9].number], [110, 101]);

  // 옮기기: 화살표 10cm, 캔버스 밖으로는 같은 만큼 덜 옮긴다
  const mv = moveSeats(d, new Set(['1-1', '1-2']), 10, 0);
  assert.deepEqual([mv.dx, seatOf(apply(d, mv.changes), '1-1').x, seatOf(apply(d, mv.changes), '1-2').x], [10, 3010, 3110]);
  const edge = moveSeats(d, new Set(['1-1', '1-2']), -5000, 0);
  assert.deepEqual([edge.dx, seatOf(apply(d, edge.changes), '1-1').x], [-3000, 0]);

  // 지우기(명령): 고른 것·격자 색인·트리 줄을 다시 본다(지운 좌석은 고른 것에서 빠진다)
  st.getState().selectSeats(['1-1', '1-2', '2-9']);
  st.getState().exec(seatsCmd(st.getState().doc, '지우기', removeSeats(st.getState().doc, new Set(['1-1', '1-2']))));
  assert.deepEqual([...st.getState().seatSel], ['2-9']);
  assert.equal(seatAt(buildSeatIndex(st.getState().doc), 3000, 2000), null);
  assert.equal(st.getState().doc.sections.s1.seats.length, 18);
  // 속성: 판매 제외·휠체어석·게이트는 켜고 끄며, 등급 null은 구역 등급으로 돌아간다
  const p = apply(d, patchSeats(d, new Set(['1-1']), { unavailable: true, wheelchair: true, gateZone: 'G1', tierId: 'R' }));
  assert.deepEqual(seatOf(p, '1-1'), { seatId: '1-1', row: '1', number: 1, x: 3000, y: 2000, tierId: 'R', wheelchair: true, unavailable: true, gateZone: 'G1' });
  const q = apply(p, patchSeats(p, new Set(['1-1']), { unavailable: false, gateZone: null, tierId: null }));
  assert.deepEqual(seatOf(q, '1-1'), { seatId: '1-1', row: '1', number: 1, x: 3000, y: 2000, wheelchair: true });
});
