// SCR-010 좌석 화면을 실제 좌석맵에 잇는 규칙(BUILD_ORDER HOT-350 ①, ADR-0224, docs/frontend.md §4.2.2·§5.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canPick, clearAdmission, createGesture, createHoverTracker, errorPhase, readAdmission, seatmapLayoutUrl, snapshotUrl, tierNames, tierRank, wheelFactor } from './live.ts';

const store = (o) => ({ getItem: (k) => (k in o ? o[k] : null) });

test('SCR-010 입장 저장값은 회차별 키에서 읽고 토큰이 없거나 틀린 모양이면 없는 것으로 본다', () => {
  const v = { admissionToken: 'a.b.c', serverEcdhPublicKey: { kty: 'EC' }, seatmapLayoutPath: '/v1/events/e1/seatmap-layouts/2.json', purchaseSessionExpiresAt: '2026-11-09T00:00:00Z', receivedAt: 1 };
  assert.deepEqual(readAdmission('e1', store({ 'peaket.admission.e1': JSON.stringify(v) })), v);
  assert.equal(readAdmission('e2', store({ 'peaket.admission.e1': JSON.stringify(v) })), null);
  for (const bad of ['nope', 'null', '[]', '{}', '{"admissionToken":""}', '{"admissionToken":1}']) assert.equal(readAdmission('e1', store({ 'peaket.admission.e1': bad })), null, bad);
  assert.equal(readAdmission('e1', { getItem: () => { throw new Error('막힘'); } }), null);
});

test('SCR-010 예매 시간이 끝나면 입장 저장값을 지운다(남겨 두면 대기실이 좌석 화면으로 되돌려 보내 왔다 갔다 한다)', () => {
  const removed = [];
  clearAdmission('e1', { removeItem: (k) => removed.push(k) });
  assert.deepEqual(removed, ['peaket.admission.e1']);
  assert.doesNotThrow(() => clearAdmission('e1', { removeItem: () => { throw new Error('막힘'); } }));
});

test('SCR-010 좌석맵 파일은 이 회차의 같은 출처 경로·판 번호만 받는다', () => {
  assert.equal(seatmapLayoutUrl('e1', '/v1/events/e1/seatmap-layouts/2.json'), '/v1/events/e1/seatmap-layouts/2.json');
  assert.equal(seatmapLayoutUrl('e1', '/v1/events/e1/seatmap-layouts/4294967295.json'), '/v1/events/e1/seatmap-layouts/4294967295.json');
  for (const bad of [undefined, '', 'https://evil.example/v1/events/e1/seatmap-layouts/2.json', '//evil.example/v1/events/e1/seatmap-layouts/2.json', '/v1/events/e2/seatmap-layouts/2.json', '/v1/events/e1/seatmap-layouts/0.json', '/v1/events/e1/seatmap-layouts/4294967296.json', '/v1/events/e1/seatmap-layouts/02.json', '/v1/events/e1/seatmap-layouts/2.json?x=1', '/v1/events/e1/seatmap-layouts/../2.json'])
    assert.equal(seatmapLayoutUrl('e1', bad), null, String(bad));
});

test('SCR-010 스냅샷 주소는 설정한 API 출처로 만들고 회차 ID를 부호화한다', () => {
  assert.equal(snapshotUrl('https://api.peaket.example', 'e 1'), 'https://api.peaket.example/v1/events/e%201/seatmap-snapshot');
});

test('SCR-010 등급 차례는 가격이 높은 순서다(같으면 준 차례)', () => {
  assert.deepEqual(tierRank([{ tierId: 'a', price: 1 }, { tierId: 'r', price: 3 }, { tierId: 's', price: 2 }, { tierId: 's2', price: 2 }]), ['r', 's', 's2', 'a']);
  assert.equal(tierRank([]), undefined);
  // 좌석맵 메시지 검사 범위(등급 16개)를 넘겨 지도를 잃지 않게 자른다
  assert.equal(tierRank(Array.from({ length: 20 }, (_, i) => ({ tierId: `t${i}`, price: i }))).length, 16);
});

test('SCR-010 등급 이름은 회차 가격표의 ID → 이름이다', () => {
  assert.deepEqual(tierNames([{ tierId: 'tier-r', name: 'R석' }, { tierId: 'tier-s', name: 'S석' }]), { 'tier-r': 'R석', 'tier-s': 'S석' });
  assert.equal(tierNames([]), undefined);
  assert.equal(Object.keys(tierNames(Array.from({ length: 20 }, (_, i) => ({ tierId: `t${i}`, name: 'n' })))).length, 16);
  assert.equal(tierNames([{ tierId: 'a', name: '가'.repeat(40) }]).a.length, 32);
});

test('SCR-010 스냅샷 오류: 이름 없는 401은 갱신 뒤 한 번 더, 이름 있는 401·403은 예매 시간 끝, Retry-After가 있는 503·429는 자동으로 다시', () => {
  assert.equal(errorPhase({ source: 'snapshot', status: 401 }), 'refresh');
  assert.equal(errorPhase({ source: 'snapshot', status: 401, problem: 'about:blank' }), 'refresh');
  for (const problem of ['admission-token-invalid', 'purchase-session-ended']) assert.equal(errorPhase({ source: 'snapshot', status: 401, problem }), 'ended');
  assert.equal(errorPhase({ source: 'snapshot', status: 403 }), 'ended');
  assert.equal(errorPhase({ source: 'snapshot', status: 503, retryAfter: 1 }), 'retry');
  assert.equal(errorPhase({ source: 'snapshot', status: 429, retryAfter: 1 }), 'retry');
  assert.equal(errorPhase({ source: 'snapshot', status: 503 }), 'failed');
  assert.equal(errorPhase({ source: 'layout', status: 401 }), 'failed');
  assert.equal(errorPhase({}), 'failed');
});

test('SCR-010 한 손가락: 8px 안에서 떼면 누르기, 넘으면 끌기이고 누르기가 나가지 않는다', () => {
  const g = createGesture();
  g.down(1, 100, 100);
  assert.deepEqual(g.move(1, 104, 100), []);
  assert.deepEqual(g.up(1, 104, 100), [{ type: 'tap', x: 104, y: 100 }]);

  g.down(1, 100, 100);
  assert.deepEqual(g.move(1, 112, 100), [{ type: 'pan', dx: 12, dy: 0 }]);
  assert.deepEqual(g.move(1, 112, 90), [{ type: 'pan', dx: 0, dy: -10 }]);
  assert.deepEqual(g.up(1, 112, 90), []);
});

test('SCR-010 두 손가락: 벌린 비율로 두 손가락 가운데를 잡고 확대하고, 다 뗄 때까지 누르기가 나가지 않는다', () => {
  const g = createGesture();
  g.down(1, 100, 100);
  g.down(2, 200, 100);
  const out = g.move(2, 300, 100);
  assert.deepEqual(out.map((c) => c.type), ['pan', 'zoomBy']);
  assert.equal(out[1].factor, 2);
  assert.deepEqual([out[1].x, out[1].y], [200, 100]);
  assert.deepEqual(out[0], { type: 'pan', dx: 50, dy: 0 });
  assert.deepEqual(g.up(2, 300, 100), []);
  // 한 손가락이 남아도 그 몸짓에서는 누르기가 아니다
  assert.deepEqual(g.up(1, 100, 100), []);
  g.down(1, 10, 10);
  assert.deepEqual(g.up(1, 10, 10), [{ type: 'tap', x: 10, y: 10 }]);
});

test('SCR-010 몸짓 취소는 그 포인터를 잊는다', () => {
  const g = createGesture();
  g.down(1, 0, 0);
  g.cancel(1);
  assert.deepEqual(g.up(1, 0, 0), []);
});

test('SCR-010 휠 배율은 아래로 축소·위로 확대이고 한 번에 2배를 넘지 않는다', () => {
  assert.ok(wheelFactor(100, 0) < 1);
  assert.ok(wheelFactor(-100, 0) > 1);
  assert.equal(wheelFactor(-100000, 0), 2);
  assert.equal(wheelFactor(100000, 0), 0.5);
  // 줄 단위(Firefox deltaMode 1)는 픽셀로 환산한다
  assert.ok(Math.abs(wheelFactor(3, 1) - wheelFactor(48, 0)) < 1e-9);
});

test('SCR-010 지도를 눌러 표시가 바뀌는 상태(ADR-0236): 홀드 중·홀드 뒤·세션 끝에는 마우스 올림 표시를 하지 않는다', () => {
  for (const v of ['selecting', 'paused']) assert.equal(canPick(v), true, v);
  for (const v of ['holding', 'held', 'saleEnded', 'ended', undefined]) assert.equal(canPick(v), false, String(v));
});

test('SCR-010 마우스 올림 위치 보내기(ADR-0236): 누르지 않은 마우스·펜만 보내고, 끌거나 고를 수 없게 되면 한 번만 지운다', () => {
  const sent = [];
  let pickable = true;
  const t = createHoverTracker((m) => sent.push(m), () => pickable);
  const mouse = { pointerType: 'mouse', buttons: 0 };
  t.move(1, 2, { pointerType: 'touch', buttons: 0 });
  assert.deepEqual(sent, [], '터치는 올림이 없다');
  t.stop();
  assert.deepEqual(sent, [], '보낸 적이 없으면 지우지 않는다');
  t.move(1, 2, mouse);
  t.move(3, 4, { pointerType: 'pen', buttons: 0 });
  assert.deepEqual(sent.map((m) => m.kind), ['move', 'move']);
  t.move(5, 6, { pointerType: 'mouse', buttons: 1 });
  t.move(7, 8, { pointerType: 'mouse', buttons: 1 });
  assert.deepEqual(sent.map((m) => m.kind), ['move', 'move', 'leave'], '끌면 한 번만 지운다');
  t.move(1, 2, mouse);
  pickable = false;
  t.move(3, 4, mouse);
  assert.equal(sent.at(-1).kind, 'leave');
  assert.equal(sent.filter((m) => m.kind === 'leave').length, 2);
  t.stop();
  assert.equal(sent.filter((m) => m.kind === 'leave').length, 2);
});
