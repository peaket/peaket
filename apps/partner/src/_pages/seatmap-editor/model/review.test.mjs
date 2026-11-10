// 리뷰 재현 시험(BAT-150 관점 넷 리뷰, ADR-0264 결정 30~42). 고치기 전에 실패를 보고 고친다.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('../../../shared/lib/test-ts-resolve.mjs', import.meta.url);
const { docFromLayout, emptyDoc, previewColumns, saveBlockers, saveBody } = await import('./doc.ts');
const { arcPoints, arcProblem, mirrorAxis, moveShape, polygonFromClicks, withArc } = await import('./shapes.ts');
const { addShapeCmd, copySectionCmd, createEditorStore, removeShapeCmd, seatsCmd, updateSectionCmd } = await import('./store.ts');
const { removeSeats } = await import('./refine.ts');
const { failedAnswer, TEXT } = await import('./save-answer.ts');
const { issueText } = await import('./issues.ts');
const { fillSection, ROUND_MARGIN_CM } = await import('./fill.ts');
const { distanceToEdges, rectPoints } = await import('./shapes.ts');
const { save } = await import('../ui/live/controller.ts');
const { goldenJson, normalizeIds } = await import('./golden-scenario.mjs');
const { SeatMapLayoutInput } = await import('../../../../../../packages/contracts/src/gen/openapi/model/seatMapLayoutInput.zod.ts');

const CANVAS = { width: 8000, height: 6000 };
const clone = (v) => structuredClone(v);

/** 응답을 시험이 정할 때까지 붙잡는 가짜 클라이언트 */
function heldClient() {
  let release;
  const calls = [];
  const deps = {
    client: {
      send(op, o) {
        calls.push({ op, ...o });
        return new Promise((resolve, reject) => {
          release = { resolve, reject };
        });
      },
    },
    ops: { getPartnerProductionSeatmap: 'GET', putPartnerProductionSeatmap: 'PUT', createPartnerProductionSeatmapImport: 'POST' },
    parseRetryAfter: (h) => Number(h) * 1000,
  };
  return { deps, calls, release: () => release };
}
const headers = (etag) => ({ get: (k) => (k === 'etag' ? etag : null) });

test('FE-T46 ⑦ 저장 요청이 오가는 동안 명령·되돌리기·다시 하기를 받지 않고, 200 뒤 문서는 서버 응답이며 실패 뒤 문서·변경 수·기록이 그대로다', async () => {
  const load = goldenJson('load-response.json');
  const st = createEditorStore(docFromLayout(load), 1, false, { idPrefix: 'r' });
  const s = st.getState;
  s().exec(updateSectionCmd(s().doc, 's1', { name: '바꾼 이름' }));
  const before = clone(s().doc);
  // 실패 넷: 문서·변경 수·되돌리기 기록 그대로
  for (const [status, type] of [[412, 'precondition-failed'], [409, 'seatmap-geometry-locked'], [422, 'seatmap-invalid'], [503, 'seatmap-publish-unavailable']]) {
    const h = heldClient();
    const p = save(st, '0b8f1f2e-4a1d-4c1e-9b5a-000000000150', h.deps);
    // 저장 중: 편집·되돌리기를 받지 않는다
    await new Promise((r) => setImmediate(r));
    assert.equal(s().exec(updateSectionCmd(s().doc, 's1', { name: '저장 중 편집' })), false, `${status} 저장 중 편집`);
    assert.equal(s().undo(), false, `${status} 저장 중 되돌리기`);
    h.release().reject(Object.assign(new Error(String(status)), { status, type, extensions: { result: { errors: [] } }, retryAfter: status === 503 ? '10' : null }));
    await p;
    if (status === 409) st.setState({ locked: false });
    assert.deepEqual([s().doc, s().changes, s().past.length], [before, 1, 1], String(status));
  }
  // 200: 응답 문서로 갈아끼우고 변경 수·기록 0, 저장 중 편집은 남지 않는다
  const h = heldClient();
  const p = save(st, '0b8f1f2e-4a1d-4c1e-9b5a-000000000150', h.deps);
  await new Promise((r) => setImmediate(r));
  s().exec(updateSectionCmd(s().doc, 's2', { name: '저장 중 편집' }));
  const server = { ...goldenJson('save-response.json'), layoutVersion: 2 };
  h.release().resolve({ data: server, status: 200, headers: headers('"2"') });
  await p;
  assert.deepEqual([s().version, s().changes, s().past.length], [2, 0, 0]);
  assert.deepEqual(s().doc, docFromLayout(server));
  assert.equal(s().exec(updateSectionCmd(s().doc, 's1', { name: '저장 뒤 편집' })), true);
});

test('FE-T46 ② 곡선 띠 중심(arc.cx·cy)도 캔버스 안이고 옮기거나 대칭 복제한 저장 본문이 계약 Zod를 지난다', () => {
  const band = { cx: 4000, cy: 500, innerRadius: 2500, outerRadius: 3200, startAngle: 60, endAngle: 120 };
  const shape = withArc({ kind: 'ARC_BAND', points: [] }, band, CANVAS);
  // Shift+↑ 여섯 번(6m): 중심이 0 밑으로 내려가지 않는다
  let moved = shape;
  for (let i = 0; i < 6; i++) moved = moveShape(moved, 0, -100, CANVAS);
  assert.ok(moved.arc.cy >= 0 && moved.arc.cx >= 0, JSON.stringify(moved.arc));
  assert.ok(moved.points.every(([x, y]) => x >= 0 && y >= 0));
  // 숫자 칸: 중심이 캔버스 밖이면 받지 않는다
  assert.notEqual(arcProblem({ ...band, cy: -1 }, CANVAS), null);
  assert.notEqual(arcProblem({ ...band, cx: 8001 }, CANVAS), null);
  assert.equal(arcProblem({ ...band, cy: 0 }, CANVAS), null);
  const doc = { ...emptyDoc(), order: ['s1'], sections: { s1: { sectionId: 's1', name: 'A', shape: moved, tierId: 'R', seats: [] } }, priceTiers: [{ tierId: 'R', name: 'R석', price: 1000 }] };
  const r = SeatMapLayoutInput.safeParse(saveBody(doc, 0));
  assert.equal(r.success, true, JSON.stringify(r.error?.issues?.slice(0, 2)));
  // 골든 저장 본문도 계약을 지난다
  assert.equal(SeatMapLayoutInput.safeParse(goldenJson('save-body.json')).success, true);
});

test('FE-T46 ② 다각형을 찍을 때 캔버스 밖 점은 캔버스 안 정수로 잘라 넣는다', () => {
  assert.deepEqual(polygonFromClicks([[-120.4, 50.6], [500, -30], [8100.2, 6200], [300, 300]], CANVAS), [[0, 51], [500, 0], [8000, 6000], [300, 300]]);
  // 잘라서 같아진 이웃 점은 하나만
  assert.deepEqual(polygonFromClicks([[-5, -5], [-9, -1], [100, 0], [100, 100]], CANVAS), [[0, 0], [100, 0], [100, 100]]);
});

test('FE-T46 ③ 좌우 대칭 복제의 좌석은 도형과 같은 변환(거울 + 캔버스 안으로 옮긴 만큼)으로 따라간다', () => {
  // 무대 무게중심이 가운데가 아니다(x = 1000): 거울 꼴이 캔버스 밖으로 나가 안으로 옮겨진다
  const stage = [{ kind: 'RECT', points: rectPoints({ x: 500, y: 100, w: 1000, h: 400, rotation: 0 }) }];
  const shape = { kind: 'POLYGON', points: [[3000, 2000], [4000, 2000], [4000, 2600], [3000, 2600]] };
  const seats = [
    { seatId: 'a', row: '1', number: 1, x: 3200, y: 2200 },
    { seatId: 'b', row: '1', number: 2, x: 3800, y: 2400 },
  ];
  const doc = { canvas: CANVAS, stage, order: ['s1'], sections: { s1: { sectionId: 's1', name: 'A', shape, seats } }, priceTiers: [] };
  assert.equal(mirrorAxis(stage, CANVAS), 1000);
  let n = 0;
  const cmd = copySectionCmd(doc, 's1', 's2', () => `m${++n}`, 'mirror');
  const copy = cmd.after.sections.s2;
  // 도형 안의 좌석 상대 위치가 거울 꼴 그대로다(도형 왼쪽 위에서 잰 거리)
  const minX = Math.min(...copy.shape.points.map((p) => p[0]));
  const minY = Math.min(...copy.shape.points.map((p) => p[1]));
  assert.deepEqual(copy.seats.map((x) => [x.x - minX, x.y - minY]), [[800, 200], [200, 400]]);
  assert.ok(copy.shape.points.every(([x]) => x >= 0 && x <= 8000));
});

test('FE-T46 ③ 새 구역 이름은 지금 있는 이름과 겹치지 않는 가장 작은 번호다', () => {
  const st = createEditorStore(emptyDoc(), 0, false, { idPrefix: 'n' });
  const s = st.getState;
  const sq = (x) => ({ kind: 'POLYGON', points: [[x, 100], [x + 100, 100], [x + 100, 200]] });
  for (const x of [100, 400, 700]) s().exec(addShapeCmd(s().doc, 'section', sq(x), s().newSectionId()));
  s().exec(removeShapeCmd(s().doc, { kind: 'section', id: s().doc.order[1] }));
  s().exec(addShapeCmd(s().doc, 'section', sq(1000), s().newSectionId()));
  const names = s().doc.order.map((id) => s().doc.sections[id].name);
  assert.equal(new Set(names).size, names.length, names.join(','));
  assert.deepEqual(names, ['구역 1', '구역 3', '구역 2']);
  // 복제·대칭 복제도 겹치지 않는다
  let k = 0;
  s().exec(copySectionCmd(s().doc, s().doc.order[0], s().newSectionId(), () => `c${++k}`, 'duplicate'));
  const all = s().doc.order.map((id) => s().doc.sections[id].name);
  assert.equal(new Set(all).size, all.length, all.join(','));
});

test('FE-T46 ⑦ 400은 저장하지 않았다는 문구이고 가격 등급 칸이 틀리면 화면이 보내기 전에 막는다', () => {
  assert.deepEqual(failedAnswer({ status: 400, type: 'validation-failed' }, 0), { kind: 'message', text: '저장하지 않았습니다. 고칠 곳을 확인해 주세요' });
  const doc = (t) => ({ ...emptyDoc(), priceTiers: [t] });
  for (const t of [{ tierId: 'R', name: '', price: 1000 }, { tierId: 'R', name: 'R', price: 0 }, { tierId: 'R', name: 'R', price: 10_000_001 }, { tierId: 'R', name: 'R\u0001', price: 1000 }]) assert.equal(saveBlockers(doc(t)).length, 1, JSON.stringify(t));
  assert.deepEqual(saveBlockers(doc({ tierId: 'R', name: 'R', price: 10_000_000 })), []);
});

test('파트너 관리자만 저장할 수 있다는 문구는 partner-admin-required일 때만이고 그 밖의 403은 일반 문구다 [ASVS v5.0.0-8.2.1]', () => {
  assert.equal(failedAnswer({ status: 403, type: 'partner-admin-required' }, 0).text, TEXT.adminOnly);
  const other = failedAnswer({ status: 403, type: 'forbidden' }, 0);
  assert.notEqual(other.text, TEXT.adminOnly);
  assert.equal(other.text, '이 공연의 좌석맵을 저장할 권한이 없습니다');
});

test('429·503의 Retry-After는 1시간까지만 따른다', () => {
  const a = failedAnswer({ status: 503, type: 'x', retryFloorMs: 2 ** 31 }, 0);
  assert.equal(a.retryAt, 3_600_000);
});

test('바깥 글자(구역 ID·오류 코드)를 객체 키로 쓰지 않는다: 구역 ID __proto__의 좌석을 지울 수 있다 [ASVS v5.0.0-1.5.2]', () => {
  const doc = docFromLayout({ canvas: { width: 1000, height: 1000 }, sections: [{ sectionId: '__proto__', name: 'P', shape: { kind: 'POLYGON', points: [[0, 0], [100, 0], [100, 100]] }, seats: [{ seatId: 'p1', row: '1', number: 1, x: 10, y: 10 }] }] });
  assert.equal(Reflect.get(doc.sections, '__proto__').seats.length, 1);
  const st = createEditorStore(doc, 1, false, { idPrefix: 'p' });
  assert.equal(st.getState().exec(seatsCmd(st.getState().doc, '지우기', removeSeats(st.getState().doc, new Set(['p1'])))), true);
  assert.equal(Object.hasOwn(st.getState().doc.sections, '__proto__'), true);
  assert.equal(Reflect.get(st.getState().doc.sections, '__proto__').seats.length, 0);
  assert.equal(saveBody(st.getState().doc, 1).sections[0].seats.length, 0);
  for (const code of ['__proto__', 'constructor', 'toString']) assert.equal(issueText(code), `값이 올바르지 않습니다(${code})`);
});

test('FE-T38 ④ 미리보기 파일은 core-svc가 쓴 팬 파일과 같은 규칙이다(골든 fan-file.json)', () => {
  const doc = docFromLayout(goldenJson('load-response.json'));
  assert.deepEqual(normalizeIds(previewColumns(doc, 1)), goldenJson('fan-file.json'));
});

test('FE-T46 ④ 기울어진 직선 행과 곡선 행도 반올림 뒤 좌석이 도형 변에서 좌석 간격의 절반 이상, 서로 좌석 간격 이상 떨어진다', () => {
  assert.equal(ROUND_MARGIN_CM, 1.5);
  const stage = [{ kind: 'RECT', points: rectPoints({ x: 3000, y: 200, w: 2000, h: 600, rotation: 0 }) }];
  const cases = [
    [rectPoints({ x: 800, y: 1500, w: 1700, h: 1300, rotation: 17 }), { method: 'COUNT', targetCount: 400 }],
    [rectPoints({ x: 1000, y: 2000, w: 6000, h: 1500, rotation: 0 }), { method: 'COUNT', targetCount: 500, rowShape: 'CURVED' }],
    [arcPoints({ cx: 4000, cy: 500, innerRadius: 2500, outerRadius: 3600, startAngle: 40, endAngle: 140 }), { method: 'COUNT', targetCount: 700, rowShape: 'CURVED', aisles: 3 }],
  ];
  for (const [pts, rule] of cases) {
    const r = fillSection(pts, rule, stage, CANVAS);
    assert.ok(r.seats.length > 50);
    for (const s of r.seats) assert.ok(distanceToEdges(pts, s.x, s.y) >= 25, `변 ${distanceToEdges(pts, s.x, s.y)}`);
    for (let i = 0; i < r.seats.length; i++) for (let j = i + 1; j < r.seats.length; j++) assert.ok(Math.hypot(r.seats[i].x - r.seats[j].x, r.seats[i].y - r.seats[j].y) >= 50, `간격 ${i}·${j}`);
  }
});

test('FE-T46 ⑦ 좌석맵 저장은 화면 한도 65초, 가져오기는 20초로 부른다(서버 상한 + 5초) [ASVS v5.0.0-15.1.3]', async () => {
  const { importSeatmap, saveSeatmap } = await import('./seatmap-api.ts');
  const calls = [];
  const deps = { client: { send: async (op, o) => (calls.push({ op, ...o }), { data: {}, status: 200, headers: headers('"1"') }) }, ops: { putPartnerProductionSeatmap: 'PUT', createPartnerProductionSeatmapImport: 'POST', getPartnerProductionSeatmap: 'GET' } };
  await saveSeatmap('p', { layoutVersion: 0 }, deps);
  await importSeatmap('p', 'CSV', new Blob(['a']), deps);
  assert.deepEqual(calls.map((c) => [c.op, c.timeoutMs]), [['PUT', 65_000], ['POST', 20_000]]);
});

test('Worker 계산이 실패한 답의 문구는 한국어다', async () => {
  const { JobEnded } = await import('./worker-client.ts');
  assert.equal(new JobEnded('failed').message, '계산하지 못했습니다. 다시 해 주세요');
});
