// 추가 검증(SCR-009)으로 보낸 뒤와 돌아온 뒤의 대기실(d5 §5.8·§5.9, docs/frontend.md §4.2.1 6·8번, ADR-0259 결정 4).
// 같은 세계(공유 localStorage) 위에 탭을 두 번 열어 '추가 검증으로 떠남 → 통과 → 대기실로 돌아옴'을 흉내 낸다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, openTab, reply, stateFile, START } from './harness.mjs';

const TICKET = { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0 };
const GRACE_MS = 15 * 60_000;

test("추가 검증을 통과하고 돌아온 대기실은 같은 대기표로 이어 가고(새 진입 없음) ADMITTED면 좌석으로 간다: 옛 '추가 검증으로 이동'에 묶이지 않는다", async () => {
  const world = createWorld();
  let verifying = true;
  const handler = ({ m, url, now }) =>
    m === 'GET' ? reply(200, stateFile({ serving: 1000, generatedAtMs: now })) : url.endsWith('/admission') ? (verifying ? reply(200, { status: 'VERIFYING', verificationReason: 'RAPID_REQUESTS' }) : reply(200, { status: 'ADMITTED', admissionToken: 'adm', serverEcdhPublicKey: { kty: 'EC' } })) : reply(500);
  const before = openTab(world, { rec: { preverifyToken: 'pv', ticket: TICKET }, handler });
  await before.start();
  assert.deepEqual(before.navs, ['/queue/e1/verify']);
  assert.equal(before.last().state, 'leaving');
  before.ctl.stop();
  const kept = before.store.read();
  assert.deepEqual(kept.ticket, TICKET, '추가 검증으로 떠나도 대기표는 남는다');
  // 추가 검증 화면이 통과(차례 지남)를 받고 차례 시각을 통과 시각으로 옮긴 뒤 대기실로 보낸다(SCR-009 verify-flow)
  verifying = false;
  const passAt = START + 20 * 60_000;
  world.local.setItem('peaket.queue.e1', JSON.stringify({ ...kept, turnAtMs: passAt }));
  const after = openTab(world, { handler });
  await after.start();
  assert.equal(after.calls.filter((c) => c.url.endsWith('/entries')).length, 0, '새로 진입하지 않는다(새 번호를 받지 않는다)');
  const admits = after.calls.filter((c) => c.url.endsWith('/admission'));
  assert.equal(admits[0].body.queueTicket, 'qt');
  assert.deepEqual(after.navs, ['/booking/e1/seats']);
  assert.equal(after.last().state, 'admitted');
});

test('돌아온 대기실이 숨겨져 있으면 차례 도래 유예를 옮긴 차례 시각(통과 시각)부터 15분으로 보인다', async () => {
  const world = createWorld();
  const passAt = START + 20 * 60_000;
  const handler = ({ m, now }) => (m === 'GET' ? reply(200, stateFile({ serving: 1000, generatedAtMs: now })) : reply(500));
  const tab = openTab(world, { rec: { ticket: TICKET, turnAtMs: passAt }, handler, hidden: true });
  await tab.start();
  const grace = tab.views.find((v) => v.state === 'grace');
  assert.ok(grace, tab.states().join(','));
  assert.equal(grace.graceUntil, passAt + GRACE_MS);
});

test("[ASVS v5.0.0-3.7.2] 입장 확정 410 queue-ticket-removed에 removeReason BLOCKED면 추가 검증 화면('기각' 문구)의 고정 경로로 보내고, 확장 칸이 없으면 다른 기기 취소 그대로다", async () => {
  const world = createWorld();
  const blocked = openTab(world, {
    rec: { preverifyToken: 'pv', ticket: TICKET },
    handler: ({ m, now }) => (m === 'GET' ? reply(200, stateFile({ serving: 1000, generatedAtMs: now })) : reply(410, { removeReason: 'BLOCKED' }, { problem: 'queue-ticket-removed' })),
  });
  await blocked.start();
  assert.deepEqual(blocked.navs, ['/queue/e1/verify']);
  assert.notEqual(blocked.last().state, 'cancelled-elsewhere');
  assert.equal(blocked.store.read()?.ticket, undefined, '끝난 대기표는 지운다(다시 열어도 같은 대기표로 묻지 않는다)');
  for (const body of [{}, { removeReason: 'OTHER' }]) {
    const x = openTab(createWorld(), { rec: { preverifyToken: 'pv', ticket: TICKET }, handler: ({ m, now }) => (m === 'GET' ? reply(200, stateFile({ serving: 1000, generatedAtMs: now })) : reply(410, body, { problem: 'queue-ticket-removed' })) });
    await x.start();
    assert.equal(x.last().state, 'cancelled-elsewhere', JSON.stringify(body));
    assert.deepEqual(x.navs, []);
  }
});
