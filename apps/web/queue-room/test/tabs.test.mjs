// 여러 탭(FE-T6, docs/frontend.md §5.1 '여러 탭', ADR-0208 결정 5)과 차례 도래 유예(§3.4 grace, ADR-0208 결정 6).
// 한 세계(공유 localStorage·가짜 Web Locks·가짜 BroadcastChannel·가짜 시계) 위에 탭을 여럿 연다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, harness, openTab, reply, START, stateFile } from './harness.mjs';

const TICKET = { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0 };
const GRACE_MS = 15 * 60_000;

/** serving을 바꿀 수 있는 대기 상태 파일 응답과, 입장 확정 응답 */
function server(o = {}) {
  const s = { serving: o.serving ?? 900, rate: o.rate ?? 20, steps: o.steps, admits: [] };
  s.handler = ({ m, url, now, tab }) => {
    if (m === 'GET' && url.includes('/segment-states/')) {
      if (s.hang?.(tab)) return new Promise(() => undefined);
      return reply(200, stateFile({ serving: s.serving, servingRate: s.rate, generatedAtMs: Math.floor(now / 1000) * 1000, ...(s.steps ? { servingSteps: s.steps } : {}) }));
    }
    if (m === 'POST' && url.endsWith('/admission')) {
      s.admits.push(tab);
      return reply(200, { status: 'ADMITTED', admissionToken: 'adm', serverTimeMs: now });
    }
    return reply(500);
  };
  return s;
}

test('FE-T6 보이는 탭 셋: 리더 하나만 폴링하고 나머지는 방송으로 같은 값을 그린다', async () => {
  const w = createWorld();
  w.local.setItem('peaket.queue.e1', JSON.stringify({ ticket: TICKET, savedAt: START }));
  const srv = server();
  const tabs = [0, 1, 2].map(() => openTab(w, { multi: true, handler: srv.handler }));
  for (const t of tabs) await t.start();
  // 처음 열 때는 아직 방송을 받지 못한 탭이 한 번씩 더 물을 수 있다(그 뒤의 정상 상태를 센다)
  await w.run(2000);
  const before = tabs.map((t) => t.gets());
  await w.run(10_000);
  const polled = tabs.map((t, i) => t.gets() - before[i]);
  assert.equal(polled.filter((n) => n > 0).length, 1, `폴링한 탭 수(${polled})`);
  // 예상 대기 5초(앞 99명 ÷ 20) → 0.5초 간격: 10초에 약 20번
  assert.ok(polled.find((n) => n > 0) >= 15, `${polled}`);
  for (const t of tabs) assert.equal(t.last().ahead, 99, '모든 탭이 같은 앞 인원');
});

test('FE-T6 리더를 숨기면 곧 보이는 탭이 리더가 되어 자기 간격으로 묻고, 숨긴 탭은 묻지 않는다', async () => {
  const w = createWorld();
  w.local.setItem('peaket.queue.e1', JSON.stringify({ ticket: TICKET, savedAt: START }));
  const srv = server();
  const a = openTab(w, { multi: true, handler: srv.handler });
  const b = openTab(w, { multi: true, handler: srv.handler });
  await a.start();
  await b.start();
  await w.run(3000);
  assert.ok(a.env.tabs.leader() && !b.env.tabs.leader());
  await a.setHidden(true);
  assert.ok(b.env.tabs.leader(), '보이는 탭이 잠금을 받는다');
  const [ga, gb] = [a.gets(), b.gets()];
  await w.run(1000);
  assert.ok(b.gets() - gb >= 1, '새 리더가 1초 안에 묻는다');
  await w.run(9000);
  assert.ok(b.gets() - gb >= 15);
  assert.equal(a.gets() - ga, 0, '숨긴 탭은 방송이 자기 간격의 2배 안이면 묻지 않는다');
});

test('FE-T6 모든 탭을 숨기면 리더가 없고, 묻기는 숨긴 간격마다 대개 한 번이다', async () => {
  const w = createWorld();
  w.local.setItem('peaket.queue.e1', JSON.stringify({ ticket: TICKET, savedAt: START }));
  const srv = server({ serving: 0, rate: 20 }); // 앞 999명 ÷ 20 ≈ 50초 → 0.5초, 숨기면 5초
  const tabs = [0, 1, 2].map(() => openTab(w, { multi: true, hidden: true, handler: srv.handler }));
  for (const t of tabs) await t.start();
  const before = tabs.reduce((n, t) => n + t.gets(), 0);
  await w.run(60_000);
  const total = tabs.reduce((n, t) => n + t.gets(), 0) - before;
  assert.ok(tabs.every((t) => !t.env.tabs.leader()));
  // 한 탭만 물으면 60 ÷ 5 = 12번. 셋이 따로 물으면 36번
  assert.ok(total >= 10 && total <= 16, `60초에 ${total}번`);
});

test('FE-T6 리더의 방송이 끊기면 보이는 탭이 자기 간격의 2배 뒤에 스스로 묻는다', async () => {
  const w = createWorld();
  w.local.setItem('peaket.queue.e1', JSON.stringify({ ticket: TICKET, savedAt: START }));
  const srv = server();
  const a = openTab(w, { multi: true, handler: srv.handler });
  const b = openTab(w, { multi: true, handler: srv.handler });
  await a.start();
  await b.start();
  await w.run(2000);
  const gb = b.gets();
  // 리더 멈춤: 리더의 파일 요청이 끝나지 않는다(방송도 없다)
  srv.hang = (tab) => tab === a;
  await w.run(1100); // 간격 0.5초 × 2 + 여유
  assert.ok(b.gets() > gb, '방송이 2배 간격 넘게 없으면 직접 묻는다');
  assert.equal(b.last().ahead, 99);
});

test('FE-T6 숨긴 채 차례가 오면 아무 탭도 입장 확정을 보내지 않고 유예 화면이다. 보이면 그 탭이 보내고, 다른 탭은 그 방송으로 duplicate다', async () => {
  const w = createWorld();
  w.local.setItem('peaket.queue.e1', JSON.stringify({ ticket: TICKET, savedAt: START }));
  const srv = server({ serving: 990 });
  const a = openTab(w, { multi: true, hidden: true, handler: srv.handler });
  const b = openTab(w, { multi: true, hidden: true, handler: srv.handler });
  await a.start();
  await b.start();
  await w.run(6000);
  srv.serving = 1000;
  await w.run(12_000);
  assert.equal(srv.admits.length, 0, '숨긴 탭은 보내지 않는다');
  assert.equal(a.last().state, 'grace');
  assert.equal(b.last().state, 'grace');
  await b.setHidden(false);
  await w.run(100);
  assert.deepEqual(srv.admits, [b]);
  assert.deepEqual(b.navs, ['/booking/e1/seats']);
  assert.equal(a.last().state, 'duplicate', '리더의 입장 방송을 받은 탭');
  assert.deepEqual(a.navs, []);
});

test('FE-T6 두 탭이 함께 진입해 409 already-waiting을 받으면 저장소의 다른 탭 대기표를 쓴다(다른 기기로 알리지 않는다)', async () => {
  const h = harness({
    rec: { preverifyToken: 'pv' },
    handler: ({ m, url, tab, now }) => {
      if (m === 'POST' && url.endsWith('/entries')) {
        tab.store.write({ ticket: { queueTicket: 'qt-from-other-tab', seq: 1000, generation: 1, segment: 0 } });
        return reply(409, {}, { problem: 'already-waiting' });
      }
      if (m === 'GET') return reply(200, stateFile({ serving: 900, generatedAtMs: Math.floor(now / 1000) * 1000 }));
      return reply(500);
    },
  });
  await h.start();
  assert.equal(h.last().state, 'waiting');
  assert.ok(h.calls.some((c) => c.m === 'GET'));
});

test('FE-T6 다른 탭이 참가 토큰·대기표를 저장하고 방송하면(stored) 저장소에서 다시 시작한다', async () => {
  const w = createWorld();
  const sched = { openAtMs: START + 10 * 60_000, lobbyOpensAtMs: START - 60_000 };
  const a = openTab(w, { multi: true, schedule: sched, hc: () => null, handler: () => reply(500) });
  await a.start();
  assert.deepEqual([a.last().state, a.last().phase], ['lobby-join', 'failed']);
  // 다른 탭(b)이 참가를 마치고 방송했다
  const b = openTab(w, { multi: true, schedule: sched, handler: ({ m, now }) => (m === 'POSTJSON' ? reply(201, { lobbyToken: 'lt', seedHash: 'aa'.repeat(32), shuffleResultAt: new Date(START + 700_000).toISOString(), shuffleSpreadSec: 8, serverTimeMs: now }) : reply(500)) });
  await b.start();
  assert.equal(b.last().state, 'lobby');
  await w.run(0);
  assert.deepEqual([a.last().state, a.last().seedHash], ['lobby', 'aa'.repeat(32)]);
});

test('SCR-008 차례 도래 유예: 남은 시간은 차례 전이던 마지막 파일 시각 + 15분, [지금 입장]은 바로 보낸다. 시각은 저장소에 남는다', async () => {
  let serving = 990;
  let hid = true;
  const admits = [];
  const h = harness({
    hidden: () => hid,
    rec: { ticket: TICKET },
    handler: ({ m, url, now }) => {
      if (m === 'GET') return reply(200, stateFile({ serving, servingRate: 2, generatedAtMs: Math.floor(now / 1000) * 1000 }));
      if (m === 'POST' && url.endsWith('/admission')) {
        admits.push(now);
        return reply(200, { status: 'ADMITTED', admissionToken: 'adm', serverTimeMs: now });
      }
      return reply(500);
    },
  });
  await h.start();
  await h.run(5000);
  const lastBefore = Math.floor(h.now / 1000) * 1000; // 마지막으로 차례 전 파일을 받은 초
  serving = 1001;
  await h.run(5000);
  const v = h.last();
  assert.equal(v.state, 'grace');
  assert.ok(v.graceUntil >= lastBefore + GRACE_MS - 5000 && v.graceUntil <= lastBefore + GRACE_MS, `${v.graceUntil - START}`);
  assert.equal(h.store.read().turnAtMs, v.graceUntil - GRACE_MS);
  assert.equal(admits.length, 0);
  h.ctl.admitNow();
  await h.run(0);
  assert.equal(admits.length, 1, '[지금 입장]은 사람이 누른 동작이라 바로 보낸다');
  assert.deepEqual(h.navs, ['/booking/e1/seats']);
});

test('SCR-008 차례 도래 유예: servingSteps에 내 번호를 넘은 전진이 있으면 그 시각, 차례 뒤 처음 연 탭은 속도로 거슬러 센다', async () => {
  const at = START - 30_000;
  let h = harness({
    hidden: true,
    rec: { ticket: TICKET },
    handler: ({ m, now }) => (m === 'GET' ? reply(200, stateFile({ serving: 1003, servingRate: 2, generatedAtMs: Math.floor(now / 1000) * 1000, servingSteps: [[at - 1000, 998], [at, 1003]] })) : reply(500)),
  });
  await h.start();
  assert.equal(h.last().state, 'grace');
  assert.equal(h.last().graceUntil, at + GRACE_MS);
  // 전진 기록 없음, 차례 전 파일도 못 봄: 생성 시각 − (serving − 순번 + 1) ÷ 속도
  h = harness({
    hidden: true,
    rec: { ticket: TICKET },
    handler: ({ m }) => (m === 'GET' ? reply(200, stateFile({ serving: 1019, servingRate: 2, generatedAtMs: START })) : reply(500)),
  });
  await h.start();
  assert.equal(h.last().graceUntil, START - 10_000 + GRACE_MS);
  // 다시 연 탭은 저장한 시각을 쓴다
  h = harness({
    hidden: true,
    rec: { ticket: TICKET, turnAtMs: START - 600_000 },
    handler: ({ m }) => (m === 'GET' ? reply(200, stateFile({ serving: 1019, servingRate: 2, generatedAtMs: START })) : reply(500)),
  });
  await h.start();
  assert.equal(h.last().graceUntil, START - 600_000 + GRACE_MS);
});
