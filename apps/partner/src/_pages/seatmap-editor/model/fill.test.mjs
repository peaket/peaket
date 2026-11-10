// ② 좌석 채우기 시험(ADR-0264 결정 6·21, d5 §6.5 '채우기 결과 부족'·'지우고 채우기 확인'). 수·첫 행 좌표·번호 차례를 정확한 값으로 본다.
// 목표·간격은 기본값(600·50cm)과 다르게도 넣는다(상수를 잘못 쓴 결함이 숨지 않게).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillResultText, fillRuleErrors, fillSection, rowName } from './fill.ts';
import { distanceToEdges, pointInPolygon, rectPoints } from './shapes.ts';

const CANVAS = { width: 8_000, height: 6_000 };
/** 무대(가운데 위)와 그 바로 아래 구역(축에 맞춰 무대를 본다) */
const STAGE = [{ kind: 'RECT', points: rectPoints({ x: 3000, y: 200, w: 2000, h: 600, rotation: 0 }) }];
const below = (w, h) => rectPoints({ x: 4000 - w / 2, y: 1500, w, h, rotation: 0 });

function checkPlaced(shape, seats, spacing) {
  for (const s of seats) {
    assert.ok(pointInPolygon(shape, s.x, s.y), `도형 밖 ${s.x},${s.y}`);
    assert.ok(distanceToEdges(shape, s.x, s.y) >= spacing / 2, `변에서 ${spacing / 2}cm 안 ${s.x},${s.y}`);
    assert.ok(Number.isInteger(s.x) && Number.isInteger(s.y));
  }
  for (let i = 0; i < seats.length; i++) for (let j = i + 1; j < seats.length; j++) assert.ok(Math.hypot(seats[i].x - seats[j].x, seats[i].y - seats[j].y) >= spacing, `간격 ${i}·${j}`);
}

test('FE-T46 ④ 좌석 수 600 채우기는 모두 도형 안·간격 이상이고 놓은 수는 목표와 받는 수 가운데 작은 쪽이며, 모자라면 결과 줄, 좌석 있는 구역은 먼저 묻는다', () => {
  // 넉넉한 구역(가로 30m·세로 15m): 600석을 다 놓는다
  const big = below(3000, 1500);
  const r = fillSection(big, { method: 'COUNT', targetCount: 600 }, STAGE, CANVAS);
  assert.equal(r.target, 600);
  assert.equal(r.seats.length, 600);
  assert.ok(r.capacity >= 600);
  checkPlaced(big, r.seats, 50);
  // 첫 행: 무대에 가장 가까운 변(y = 1500)에서 행 간격의 절반(45cm) 안쪽. 왼쪽(무대를 보고, x가 작은 쪽)부터 1번
  const first = r.seats.filter((s) => s.row === '1');
  assert.ok(first.every((s) => s.y === 1545));
  assert.deepEqual(first.slice(0, 3).map((s) => [s.number, s.x]), [[1, 2535], [2, 2585], [3, 2635]]);
  // 통로 2개(폭 120cm)로 3묶음: 행이 덮는 길이 3000 − 240 = 2760 → 묶음 920cm에 18석(900cm), 가장자리 10cm 여유
  assert.equal(first.length, 54);
  assert.deepEqual([first[17].x, first[18].x], [3385, 3575]);
  assert.deepEqual(first.map((s) => s.number), Array.from({ length: 54 }, (_, i) => i + 1));
  // 행 이름은 무대에서 가까운 차례, 행 간격 90cm
  const rows = [...new Set(r.seats.map((s) => s.row))];
  assert.deepEqual(rows.slice(0, 3), ['1', '2', '3']);
  assert.equal(r.seats.find((s) => s.row === '2').y, 1635);
  // 마지막 행은 그 행 가운데에 가까운 자리부터(600 = 54 × 11 + 6)
  const last = r.seats.filter((s) => s.row === '12');
  assert.equal(last.length, 6);
  assert.deepEqual(last.map((s) => s.number), [1, 2, 3, 4, 5, 6]);
  assert.ok(Math.abs(last.reduce((n, s) => n + s.x, 0) / 6 - 4000) < 120);

  // 작은 구역(가로 10m·세로 5m): 받는 수가 목표보다 적다
  const small = below(1000, 500);
  const s = fillSection(small, { method: 'COUNT', targetCount: 600 }, STAGE, CANVAS);
  assert.equal(s.seats.length, s.capacity);
  assert.equal(s.capacity, 75);
  checkPlaced(small, s.seats, 50);
  assert.equal(fillResultText(s), '75석이 들어갑니다(목표보다 525석 적습니다). 도형을 넓히거나 좌석 간격을 줄이세요.');
  assert.equal(fillResultText(r), '600석이 들어갑니다.');

  // 간격·통로·방향을 기본값과 다르게: 좌석 60cm·행 100cm·통로 없음·오른쪽부터·알파벳 행·첫 번호 101
  const g = fillSection(big, { method: 'COUNT', targetCount: 37, seatSpacingCm: 60, rowSpacingCm: 100, aisles: 0, numberFrom: 'RIGHT', rowLabel: 'ALPHA', firstNumber: 101 }, STAGE, CANVAS);
  assert.equal(g.seats.length, 37);
  checkPlaced(big, g.seats, 60);
  const a = g.seats.filter((x) => x.row === 'A');
  assert.equal(a.length, 37);
  assert.equal(a[0].y, 1550);
  // 오른쪽(무대를 보고 x가 큰 쪽)에서 101번
  assert.deepEqual([a[0].number, a.at(-1).number], [101, 137]);
  assert.ok(a[0].x > a.at(-1).x);

  // 행 × 좌석(GRID): 앞 행부터 행 수만큼, 행 가운데 기준, 도형 밖은 뺀다
  const grid = fillSection(small, { method: 'GRID', rows: 3, seatsPerRow: 30, aisles: 1 }, STAGE, CANVAS);
  assert.equal(grid.target, 90);
  assert.deepEqual([...new Set(grid.seats.map((x) => x.row))], ['1', '2', '3']);
  checkPlaced(small, grid.seats, 50);
  assert.ok(grid.seats.length < 90);
  assert.equal(grid.capacity, grid.seats.length);
});

test('FE-T46 ④ 곡선 행은 무대 무게중심을 중심으로 한 호 위에 있고 행 이름·채우기 규칙 검사가 경계 양쪽에서 맞다', () => {
  const band = rectPoints({ x: 2000, y: 1500, w: 4000, h: 1200, rotation: 0 });
  const r = fillSection(band, { method: 'COUNT', targetCount: 120, rowShape: 'CURVED', aisles: 1 }, STAGE, CANVAS);
  assert.equal(r.seats.length, 120);
  checkPlaced(band, r.seats, 50);
  // 같은 행 좌석은 무대 무게중심(4000, 500)에서 같은 거리(반올림 1cm 안)
  const row1 = r.seats.filter((x) => x.row === '1');
  const d = row1.map((x) => Math.hypot(x.x - 4000, x.y - 500));
  assert.ok(Math.max(...d) - Math.min(...d) <= 1.5);
  assert.ok(Math.abs(d[0] - (1000 + 45)) <= 1);
  assert.deepEqual([rowName(0, 'ALPHA'), rowName(25, 'ALPHA'), rowName(26, 'ALPHA'), rowName(27, 'ALPHA'), rowName(9, 'NUMBER')], ['A', 'Z', 'AA', 'AB', '10']);
  // 규칙 검사: 행 간격 = 좌석 간격은 되고 1cm 작으면 안 된다. 목표 50,000은 되고 50,001은 안 된다. 첫 번호 1은 되고 0은 안 된다
  assert.deepEqual(fillRuleErrors({ method: 'COUNT', targetCount: 50_000, seatSpacingCm: 90, rowSpacingCm: 90, firstNumber: 1 }), {});
  assert.deepEqual(Object.keys(fillRuleErrors({ method: 'COUNT', targetCount: 50_001, seatSpacingCm: 90, rowSpacingCm: 89, firstNumber: 0 })).sort(), ['firstNumber', 'rowSpacingCm', 'targetCount']);
  assert.deepEqual(fillSection(band, { method: 'COUNT', targetCount: 0 }, STAGE, CANVAS), { seats: [], target: 0, capacity: 0 });
});
