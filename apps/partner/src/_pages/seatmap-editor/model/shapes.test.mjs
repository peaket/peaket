// 도형 수학 시험(ADR-0264 결정 3·12·20, d5 §6.5 ①). 손잡이로 바꾼 값과 숫자로 넣은 값이 같은 꼭짓점이 되고, 꼭짓점은 캔버스 안 정수다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  arcHandles,
  arcPoints,
  arcProblem,
  dimensionText,
  dragArcHandle,
  fitInside,
  guideLines,
  insertVertex,
  mirrorAxis,
  mirrorShape,
  moveShape,
  moveVertex,
  NUDGE_BIG_CM,
  NUDGE_CM,
  rectParams,
  rectPoints,
  removeVertex,
  snapBox,
  snapGrid,
  withArc,
  withRect,
} from './shapes.ts';

const CANVAS = { width: 8_000, height: 6_000 };
const intsInside = (pts) => pts.every(([x, y]) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x <= CANVAS.width && y <= CANVAS.height);

test('FE-T46 ② 사각형·다각형·부채꼴·곡선 띠를 손잡이로 바꾼 값과 숫자로 넣은 값이 같고 꼭짓점은 캔버스 안 정수다', () => {
  // 사각형: Transformer가 준 값(첫 꼭짓점·가로·세로·회전)과 속성 패널 숫자가 같은 함수를 지난다
  const byHandle = withRect({ kind: 'RECT', points: [] }, { x: 1000.4, y: 2000.6, w: 2400.2, h: 1200.7, rotation: 30.04 }, CANVAS);
  const byNumber = withRect({ kind: 'RECT', points: [] }, { x: 1000, y: 2001, w: 2400, h: 1201, rotation: 30 }, CANVAS);
  assert.deepEqual(byHandle.points, byNumber.points);
  assert.deepEqual(byNumber.points, [[1000, 2001], [3078, 3201], [2478, 4241], [400, 3041]]);
  assert.deepEqual(rectParams(byNumber.points), { x: 1000, y: 2001, w: 2400, h: 1201, rotation: 30 });
  assert.ok(intsInside(byNumber.points));
  // 회전 정리: 소수 첫째 자리, -180 초과 180 이하
  assert.equal(rectParams(rectPoints({ x: 4000, y: 3000, w: 1000, h: 500, rotation: 270 })).rotation, -90);
  // 캔버스 밖으로 나가면 꼴째 안으로 옮긴다
  const pushed = withRect({ kind: 'RECT', points: [] }, { x: 7_500, y: 5_800, w: 1000, h: 500, rotation: 0 }, CANVAS);
  assert.deepEqual(pushed.points, [[7000, 5500], [8000, 5500], [8000, 6000], [7000, 6000]]);

  // 다각형: 꼭짓점 끌기와 '＋ 꼭짓점 더하기'(변 가운데), 지우기(셋 아래로는 안 지운다)
  const tri = { kind: 'POLYGON', points: [[0, 0], [1000, 0], [500, 801]] };
  assert.deepEqual(insertVertex(tri, 0).points, [[0, 0], [500, 0], [1000, 0], [500, 801]]);
  assert.deepEqual(insertVertex(tri, 2).points, [[0, 0], [1000, 0], [500, 801], [250, 401]]);
  assert.deepEqual(moveVertex(tri, 2, 520.6, 9_999, CANVAS).points, [[0, 0], [1000, 0], [521, 6000]]);
  assert.equal(removeVertex(tri, 0), tri);
  assert.deepEqual(removeVertex(insertVertex(tri, 0), 1).points, tri.points);

  // 부채꼴·곡선 띠: 반지름·각도 손잡이를 끈 값과 숫자로 넣은 arc가 같은 꼭짓점이다
  const a = { cx: 4000, cy: 500, innerRadius: 2500, outerRadius: 3200, startAngle: 60, endAngle: 120 };
  const h = arcHandles(a);
  const dragged = dragArcHandle(dragArcHandle(a, 'outer', h.outer[0], h.outer[1] + 300), 'start', 4000 + 3500 * Math.cos((50 * Math.PI) / 180), 500 + 3500 * Math.sin((50 * Math.PI) / 180));
  assert.deepEqual(dragged, { ...a, outerRadius: 3500, startAngle: 50 });
  const band = withArc({ kind: 'ARC_BAND', points: [] }, dragged, CANVAS);
  const typed = withArc({ kind: 'ARC_BAND', points: [] }, { ...a, outerRadius: 3500, startAngle: 50 }, CANVAS);
  assert.deepEqual(band, typed);
  assert.ok(intsInside(band.points));
  // 바깥 호 5도마다(70도 → 14변 + 1점), 안쪽 호도 같은 수
  assert.equal(band.points.length, 30);
  assert.deepEqual(band.points[0], [Math.round(4000 + 3500 * Math.cos((50 * Math.PI) / 180)), Math.round(500 + 3500 * Math.sin((50 * Math.PI) / 180))]);
  // 부채꼴(안쪽 0)은 중심 한 점으로 닫는다
  const sector = arcPoints({ cx: 1500, cy: 4500, innerRadius: 0, outerRadius: 1000, startAngle: 180, endAngle: 270 });
  assert.equal(sector.length, 20);
  assert.deepEqual([sector[0], sector[18], sector[19]], [[500, 4500], [1500, 3500], [1500, 4500]]);
  // 관계가 틀린 arc는 서버 SHAPE_PARAMS_INVALID와 같은 규칙으로 막는다(경계 양쪽)
  assert.equal(arcProblem({ ...a, innerRadius: 3199 }), null);
  assert.notEqual(arcProblem({ ...a, innerRadius: 3200 }), null);
  assert.equal(arcProblem({ ...a, startAngle: 0, endAngle: 360 }), null);
  assert.notEqual(arcProblem({ ...a, startAngle: 0, endAngle: 361 }), null);
  assert.notEqual(arcProblem({ ...a, endAngle: 60 }), null);
  assert.equal(withArc(band, { ...a, innerRadius: 4000 }, CANVAS), band);
  assert.equal(dimensionText(byNumber.points, 'RECT'), '가로 24.0m · 세로 12.0m');
});

test('FE-T46 ③ 격자·안내선 맞춤, 좌우 대칭 복제, 화살표 10cm·Shift 1m', () => {
  // 격자 1m
  assert.deepEqual([snapGrid(149), snapGrid(150), snapGrid(-49)], [100, 200, -0]);
  // 안내선: 다른 도형의 변·가운데선이 화면 6px 안이면 맞춘다(배율 0.5면 세계 12cm). 6px 밖이면 격자로
  const lines = guideLines([[[1000, 1000], [2000, 1000], [2000, 2000], [1000, 2000]]]);
  const near = snapBox({ minX: 2011, minY: 3333, maxX: 2511, maxY: 3833 }, lines, 6 / 0.5, false);
  assert.deepEqual(near, { dx: -11, dy: 0, guideX: 2000 });
  const far = snapBox({ minX: 2013, minY: 3333, maxX: 2513, maxY: 3833 }, lines, 6 / 0.5, true);
  assert.deepEqual(far, { dx: -13, dy: -33 });
  // 좌우 대칭 복제: 무대 무게중심 세로선(x = 4000)의 거울 꼴, 꼭짓점 차례를 거꾸로
  const stage = [{ kind: 'RECT', points: [[3000, 200], [5000, 200], [5000, 800], [3000, 800]] }];
  const axis = mirrorAxis(stage, CANVAS);
  assert.equal(axis, 4000);
  assert.equal(mirrorAxis([], CANVAS), 4000);
  const left = { kind: 'POLYGON', points: [[1000, 1000], [2500, 1000], [2500, 2000]] };
  assert.deepEqual(mirrorShape(left, axis, CANVAS).points, [[5500, 2000], [5500, 1000], [7000, 1000]]);
  // 부채꼴의 arc도 거울(중심 x, 각도 180 − θ)
  const sec = withArc({ kind: 'SECTOR', points: [] }, { cx: 1500, cy: 4500, innerRadius: 0, outerRadius: 1000, startAngle: 180, endAngle: 270 }, CANVAS);
  const m = mirrorShape(sec, axis, CANVAS);
  assert.deepEqual(m.arc, { cx: 6500, cy: 4500, innerRadius: 0, outerRadius: 1000, startAngle: 270, endAngle: 360 });
  assert.deepEqual(m.points.at(-1), [6500, 4500]);
  // 화살표 10cm, Shift 1m. 캔버스 밖으로는 나가지 않는다
  assert.deepEqual([NUDGE_CM, NUDGE_BIG_CM], [10, 100]);
  assert.deepEqual(moveShape(left, NUDGE_CM, 0, CANVAS).points[0], [1010, 1000]);
  assert.deepEqual(moveShape(left, 0, -NUDGE_BIG_CM, CANVAS).points[0], [1000, 900]);
  assert.deepEqual(moveShape(left, -5_000, 0, CANVAS).points[0], [0, 1000]);
  assert.deepEqual(fitInside([[-10, 5], [100, 6_010]], CANVAS), [[0, 0], [110, 6000]]);
});
