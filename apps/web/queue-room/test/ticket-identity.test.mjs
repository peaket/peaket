// 여러 탭의 대기표 구분·취소 알림·리더 잠금·입장 확정 하한(FE-T6, SCR-008, ADR-0208 결정 5·6).
// 2026-11-05 새 맥락 리뷰가 찾은 결함의 재현 시험이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, harness, openTab, reply, START, stateFile } from './harness.mjs';

const T1 = { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0 };
const T2 = { queueTicket: 'qt2', seq: 9000, generation: 1, segment: 8 };
const GRACE_MS = 15 * 60_000;
const ticketIn = (w) => JSON.parse(w.local.getItem('peaket.queue.e1') ?? 'null')?.ticket?.queueTicket;
const near = ({ m, now }) => (m === 'GET' ? reply(200, stateFile({ serving: 900, servingRate: 20, generatedAtMs: Math.floor(now / 1000) * 1000 })) : reply(500));

test('FE-T6 다른 대기표의 탭: 취소된 옛 대기표 탭의 410·파일 방송이 새 대기표 탭을 끝내거나 저장소를 지우지 않는다', async () => {
  const w = createWorld();
  w.local.setItem('peaket.queue.e1', JSON.stringify({ ticket: T1, savedAt: START }));
  let serving = 900;
  const handler = ({ m, url, now, body }) => {
    if (m === 'GET') {
      const seg = Number(url.match(/segment-states\/(\d+)\.json/)[1]);
      return reply(200, stateFile({ serving: seg === 8 ? 8000 : serving, servingRate: 2, generatedAtMs: Math.floor(now / 1000) * 1000 }));
    }
    if (m === 'POST' && url.endsWith('/admission')) return body.queueTicket === 'qt' ? reply(410, {}, { problem: 'queue-ticket-removed' }) : reply(200, { status: 'NOT_YET', retryAfterMs: 60_000 });
    return reply(500);
  };
  const b = openTab(w, { multi: true, handler });
  await b.start();
  await w.run(1000);
  // 다른 곳에서 qt를 취소하고(방송 없음) 새로 줄을 서 qt2를 받았다
  w.local.setItem('peaket.queue.e1', JSON.stringify({ ticket: T2, savedAt: w.now }));
  const c = openTab(w, { multi: true, hidden: true, handler });
  await c.start();
  await w.run(6000);
  assert.equal(c.last().ahead, 999, '자기 구간(8)의 파일로 센다(다른 대기표의 방송을 쓰지 않는다)');
  serving = 1000;
  await w.run(6000);
  assert.notEqual(c.last().state, 'cancelled-elsewhere');
  assert.equal(ticketIn(w), 'qt2', '새 대기표는 그대로');
});

test('FE-T6 끝 상태(만료) 탭도 다른 탭이 새 대기표를 저장하면 그 대기표로 다시 시작하고, [다시 줄 서기]가 그 대기표를 지우지 않는다', async () => {
  const w = createWorld();
  w.local.setItem('peaket.queue.e1', JSON.stringify({ ticket: T1, preverifyToken: 'pv', savedAt: START }));
  let expired = true;
  const deletes = [];
  const handler = ({ m, url, now }) => {
    if (m === 'GET') return reply(200, stateFile({ serving: 1000, servingRate: 2, generatedAtMs: Math.floor(now / 1000) * 1000 }));
    if (m === 'POST' && url.endsWith('/admission')) return expired ? reply(410, { rejoinAllowed: true }, { problem: 'queue-ticket-expired' }) : reply(200, { status: 'NOT_YET', retryAfterMs: 60_000 });
    if (m === 'POST' && url.endsWith('/entries')) return reply(201, { queueTicket: 'qt2', seq: 9000, generation: 1, segment: 8, serverTimeMs: now });
    if (m === 'DELETE') deletes.push(url);
    return reply(204);
  };
  const a = openTab(w, { multi: true, handler });
  await a.start();
  await w.run(1000);
  assert.equal(a.last().state, 'expired');
  expired = false;
  const b = openTab(w, { multi: true, hidden: true, handler });
  await b.start(); // 저장소에 사전 검증 토큰만 남아 진입 → qt2를 저장하고 알린다
  await w.run(1000);
  assert.equal(ticketIn(w), 'qt2');
  assert.notEqual(a.last().state, 'expired', '만료 화면의 탭도 새 대기표로 다시 시작한다');
  a.ctl.rejoin();
  await w.run(1000);
  assert.equal(ticketIn(w), 'qt2', '다시 줄 서기가 다른 탭의 대기표를 지우지 않는다');
  assert.deepEqual(deletes, []);
});

test('FE-T6 한 탭에서 대기를 취소하면 같은 대기표의 다른 탭도 멈춘다(취소를 알린다)', async () => {
  const w = createWorld();
  w.local.setItem('peaket.queue.e1', JSON.stringify({ ticket: T1, savedAt: START }));
  const handler = (c) => (c.m === 'DELETE' ? reply(204) : near(c));
  const a = openTab(w, { multi: true, handler });
  const b = openTab(w, { multi: true, hidden: true, handler });
  await a.start();
  await b.start();
  await w.run(2000);
  assert.equal(await a.ctl.cancel(), true);
  await w.run(0);
  assert.equal(b.last().state, 'cancelled-elsewhere');
  const n = b.gets();
  await w.run(30_000);
  assert.equal(b.gets(), n, '멈춘 탭은 더 묻지 않는다');
});

test('FE-T6 대기 상태가 아닌 탭(멈춘 탭)은 리더 잠금을 놓아, 대기 중인 보이는 탭이 리더가 된다', async () => {
  const w = createWorld();
  w.local.setItem('peaket.queue.e1', JSON.stringify({ ticket: T1, savedAt: START }));
  const x = openTab(w, { multi: true, handler: near });
  await x.start();
  await w.run(1000);
  assert.ok(x.env.tabs.leader());
  x.ctl.stop();
  await w.run(0);
  const y = openTab(w, { multi: true, handler: near });
  await y.start();
  await w.run(1000);
  assert.ok(y.env.tabs.leader(), '멈춘 탭은 잠금을 쥐지 않는다');
  assert.ok(!x.env.tabs.leader());
  // 끝 상태(대기표 무효 403)의 보이는 탭도 놓는다
  const w2 = createWorld();
  w2.local.setItem('peaket.queue.e1', JSON.stringify({ ticket: T1, savedAt: START }));
  const dead = openTab(w2, { multi: true, handler: ({ m, now }) => (m === 'GET' ? reply(200, stateFile({ serving: 1000, generatedAtMs: Math.floor(now / 1000) * 1000 })) : reply(403, {}, { problem: 'queue-ticket-invalid' })) });
  await dead.start();
  await w2.run(1000);
  assert.equal(dead.last().state, 'duplicate');
  assert.ok(!dead.env.tabs.leader());
});

test('SCR-008 NOT_YET 뒤에는 대기 화면이고, 그 하한 전에는 [지금 입장]도 보내지 않는다', async () => {
  const admits = [];
  const h = harness({
    rec: { ticket: T1 },
    handler: ({ m, url, now }) => {
      if (m === 'GET') return reply(200, stateFile({ serving: 1000, servingRate: 2, generatedAtMs: Math.floor(now / 1000) * 1000 }));
      if (m === 'POST' && url.endsWith('/admission')) {
        admits.push(now);
        return reply(200, { status: 'NOT_YET', retryAfterMs: 30_000, serverTimeMs: now });
      }
      return reply(500);
    },
  });
  await h.start();
  await h.run(100);
  assert.equal(admits.length, 1);
  assert.equal(h.last().state, 'waiting', 'NOT_YET → waiting(§3.4)');
  h.ctl.admitNow();
  await h.run(1000);
  assert.equal(admits.length, 1, '서버 하한 전에는 보내지 않는다');
  await h.run(30_000);
  assert.equal(admits.length, 2);
  assert.ok(admits[1] - admits[0] >= 30_000);
});

test('SCR-008 입장 확정이 계속 실패하면 다시 보내는 간격이 늘어난다(분당 60회 예산 안)', async () => {
  const admits = [];
  const h = harness({
    rec: { ticket: T1 },
    handler: ({ m, url, now }) => {
      if (m === 'GET') return reply(200, stateFile({ serving: 1000, servingRate: 2, generatedAtMs: Math.floor(now / 1000) * 1000 }));
      if (m === 'POST' && url.endsWith('/admission')) admits.push(now);
      return reply(500);
    },
  });
  h.env.random = () => 1;
  await h.start();
  await h.run(60_000);
  assert.ok(admits.length <= 20, `1분에 ${admits.length}번`);
  const gaps = admits.slice(1).map((t, i) => t - admits[i]);
  assert.ok(gaps.at(-1) >= 4000, `마지막 간격 ${gaps.at(-1)}ms`);
});

test('SCR-008 차례가 온 시각은 다른 탭이 먼저 저장한 값을 덮어쓰지 않는다', async () => {
  const w = createWorld();
  w.local.setItem('peaket.queue.e1', JSON.stringify({ ticket: T1, savedAt: START }));
  let serving = 990;
  const h = openTab(w, { hidden: true, handler: ({ m, now }) => (m === 'GET' ? reply(200, stateFile({ serving, servingRate: 2, generatedAtMs: Math.floor(now / 1000) * 1000 })) : reply(500)) });
  await h.start();
  const rec = JSON.parse(w.local.getItem('peaket.queue.e1'));
  w.local.setItem('peaket.queue.e1', JSON.stringify({ ...rec, turnAtMs: START - 100_000 }));
  serving = 1001;
  await w.run(6000);
  assert.equal(h.last().state, 'grace');
  assert.equal(h.last().graceUntil, START - 100_000 + GRACE_MS);
});
