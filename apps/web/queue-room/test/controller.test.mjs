// 대기실 상태 기계(오픈 뒤 경로, docs/frontend.md §3.4, ADR-0207)를 가짜 시계·가짜 응답으로 끝까지 돌린다(틀은 test/harness.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, reply, sha, stateFile } from './harness.mjs';

test('SCR-008 사전 검증 토큰이 없으면 공연 상세로 간다', async () => {
  const h = harness({ handler: () => reply(500) });
  await h.start();
  assert.deepEqual(h.navs, ['/events/e1']);
  assert.equal(h.calls.length, 0);
});

test('SCR-008 진입 201 → 대기(앞 인원·진행률·예상 대기) → serving이 닿으면 입장 확정 → ADMITTED면 저장하고 좌석 화면', async () => {
  let serving = 960;
  const h = harness({
    rec: { preverifyToken: 'pv' },
    handler: ({ m, url, body, now }) => {
      if (m === 'POST' && url.endsWith('/entries')) return reply(201, { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0, serverTimeMs: now });
      if (m === 'GET') return reply(200, stateFile({ serving, generatedAtMs: Math.floor(now / 1000) * 1000 }));
      if (m === 'POST' && url.endsWith('/admission')) {
        assert.equal(body.queueTicket, 'qt');
        assert.equal(body.firstEtaSec, 20);
        return reply(200, { status: 'ADMITTED', admissionToken: 'adm', serverEcdhPublicKey: { kty: 'EC' }, seatmapLayoutPath: '/s.json', purchaseSessionExpiresAt: '2026-11-05T12:00:00Z', serverTimeMs: now });
      }
      return reply(500);
    },
  });
  await h.start();
  const entry = h.calls[0];
  assert.equal(entry.body.preverifyToken, 'pv');
  assert.match(entry.body.entryRequestId, /^[0-9a-f-]{36}$/);
  assert.equal(typeof entry.body.deviceId, 'string');
  const w = h.views.find((v) => v.state === 'waiting');
  assert.deepEqual([w.ahead, w.progress, w.etaSec], [39, 0, 19.5]);
  assert.equal(h.session.getItem('peaket.queue.e1.firstAhead'), '39');
  assert.deepEqual(h.store.read().firstEta.sec, 20);
  assert.equal(h.calls[1].noStore, true, '상태 파일은 no-store');
  assert.match(h.calls[1].url, /\/v1\/queues\/e1\/segment-states\/0\.json$/);
  serving = 980;
  await h.run(1100); // 같은 초에 만든 파일은 단조 읽기가 버린다
  assert.equal(h.last().ahead, 19);
  assert.equal(Math.round(h.last().progress), 51);
  serving = 1000;
  await h.run(1100);
  assert.ok(h.states().includes('turn'));
  assert.equal(h.last().state, 'admitted');
  assert.deepEqual(h.navs, ['/booking/e1/seats']);
  const adm = JSON.parse(h.session.getItem('peaket.admission.e1'));
  assert.deepEqual([adm.admissionToken, adm.seatmapLayoutPath, adm.purchaseSessionExpiresAt], ['adm', '/s.json', '2026-11-05T12:00:00Z']);
  assert.equal(h.store.read(), null, '입장 뒤 이 회차의 대기 값(토큰 포함)을 모두 지운다');
});

test('SCR-008 묶음 진입: 202를 저장하고, 결과 공개 + 분산 지연 뒤 결과 파일(404면 다시)에서 순번을 찾으면 같은 요청 ID로 다시 진입한다', async () => {
  let published = false;
  let firstId;
  const h = harness({
    rec: { preverifyToken: 'pv-b' },
    handler: ({ m, url, body, now }) => {
      if (m === 'POST' && url.endsWith('/entries')) {
        firstId ??= body.entryRequestId;
        assert.equal(body.entryRequestId, firstId, '같은 요청 ID');
        if (!published) return reply(202, { entryRequestId: firstId, resultPath: '/v1/queues/e1/batch-results/abc.json', resultAt: new Date(now + 3000).toISOString(), spreadSec: 2, serverTimeMs: now });
        return reply(201, { queueTicket: 'qt-b', seq: 1001, generation: 1, segment: 1, serverTimeMs: now });
      }
      if (m === 'GET' && url.includes('batch-results')) {
        assert.equal(url, 'https://f/v1/queues/e1/batch-results/abc.json');
        return published ? reply(200, { [sha('pv-b')]: 1001 }) : reply(404);
      }
      if (m === 'GET') return reply(200, stateFile({ serving: 900, generatedAtMs: Math.floor(now / 1000) * 1000 }));
      return reply(500);
    },
  });
  await h.start();
  assert.equal(h.last().state, 'batching');
  const saved = h.store.read().entry;
  assert.deepEqual([saved.entryRequestId, saved.token, saved.batching.spreadSec], [firstId, 'pv-b', 2]);
  const fileCalls = () => h.calls.filter((c) => c.url.includes('batch-results')).length;
  await h.run(2900);
  assert.equal(fileCalls(), 0, '공개 시각 전에는 받지 않는다');
  await h.run(2200);
  assert.equal(fileCalls(), 1, '공개 + 분산 지연(2초 창 안)');
  published = true;
  await h.run(2100);
  assert.equal(h.last().state, 'waiting');
  assert.deepEqual(h.store.read().ticket, { queueTicket: 'qt-b', seq: 1001, generation: 1, segment: 1 });
  assert.equal(h.store.read().entry, undefined);
});

test('SCR-008 다시 열었을 때 진행 중인 묶음 진입이 있으면 batching부터, 대기표가 있으면 waiting부터', async () => {
  const h1 = harness({ rec: { entry: { entryRequestId: 'r1', token: 'pv', batching: { entryRequestId: 'r1', resultPath: '/v1/queues/e1/batch-results/abc.json', resultAtMs: 1_000_000 + 60_000, spreadSec: 1 } } }, handler: () => reply(404) });
  await h1.start();
  assert.deepEqual([h1.last().state, h1.calls.length], ['batching', 0]);
  const h2 = harness({ rec: { ticket: { queueTicket: 'qt', seq: 1200, generation: 1, segment: 1 } }, handler: ({ now }) => reply(200, stateFile({ serving: 1100, generatedAtMs: now })) });
  await h2.start();
  assert.equal(h2.calls[0].m, 'GET');
  assert.equal(h2.last().ahead, 99);
});

test('SCR-008 진입 429·503은 Retry-After(위로만 지터) 뒤 같은 요청 ID로, 409·410·403은 각 끝 상태나 공연 상세', async () => {
  const seq = [reply(429, { type: 'x/server-busy' }, { retryAfterMs: 2000, problem: 'server-busy' }), reply(503, {}, { retryAfterMs: 1000 })];
  const h = harness({
    rec: { preverifyToken: 'pv' },
    handler: ({ m, now }) => (m === 'POST' ? seq.shift() ?? reply(201, { queueTicket: 'qt', seq: 5, generation: 1, segment: 0, serverTimeMs: now }) : reply(200, stateFile({ serving: 1, generatedAtMs: now }))),
  });
  await h.start();
  assert.ok(h.last().busyUntil > h.now);
  await h.run(2199);
  assert.equal(h.calls.length, 1, '2초 × 1.1 전에는 다시 보내지 않는다');
  await h.run(2);
  assert.equal(h.calls.length, 2);
  await h.run(1200);
  assert.equal(h.calls[2].body.entryRequestId, h.calls[0].body.entryRequestId);
  assert.equal(h.last().state, 'waiting');

  for (const [status, problem, expect] of [[409, 'already-waiting', 'other-device'], [409, 'already-admitted', 'already-admitted'], [410, 'sold-out', 'sold-out'], [410, 'sale-ended', 'ended']]) {
    const x = harness({ rec: { preverifyToken: 'pv' }, handler: () => reply(status, {}, { problem }) });
    await x.start();
    assert.equal(x.last().state, expect, problem);
  }
  for (const [status, problem] of [[403, 'preverify-invalid'], [404, 'queue-not-found'], [409, 'queue-not-open']]) {
    const x = harness({ rec: { preverifyToken: 'pv' }, handler: () => reply(status, {}, { problem }) });
    await x.start();
    assert.deepEqual(x.navs, ['/events/e1'], problem);
  }
});

test('SCR-008 대기: 판매 상태(일시정지·일시 매진·매진·판매 종료), 연속 실패 3회면 연결 확인 중, 숨긴 탭은 입장 확정을 보내지 않는다', async () => {
  let file = stateFile({ serving: 900 });
  let fail = false;
  let hide = false;
  const h = harness({
    rec: { ticket: { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0 } },
    hidden: () => hide,
    handler: ({ m, now }) => {
      if (m === 'GET') return fail ? reply(500) : reply(200, { ...file, generatedAtMs: now });
      return reply(200, { status: 'ADMITTED', admissionToken: 'a', serverEcdhPublicKey: { kty: 'EC' }, serverTimeMs: now });
    },
  });
  await h.start();
  file = stateFile({ serving: 900, saleStatus: 'PAUSED', servingRate: 0 });
  await h.run(21_000);
  assert.deepEqual([h.last().state, h.last().etaSec], ['paused', null]);
  file = stateFile({ serving: 900, saleStatus: 'ALL_HELD' });
  await h.run(21_000);
  assert.equal(h.last().state, 'all-held');
  file = stateFile({ serving: 900, banner: '점검 안내', remainingSeats: 10, avgTicketsPerOrder: 2 });
  await h.run(21_000);
  assert.deepEqual([h.last().state, h.last().banner, h.last().purchaseUnlikely], ['waiting', '점검 안내', true]);
  fail = true;
  await h.run(200_000);
  assert.equal(h.last().state, 'stale');
  assert.equal(h.last().ahead, 99, '마지막 값을 그대로 둔다');
  fail = false;
  hide = true;
  file = stateFile({ serving: 1000 });
  await h.run(70_000);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/admission')).length, 0, '숨긴 탭');
  hide = false;
  await h.wake();
  await h.run(1000);
  assert.equal(h.last().state, 'admitted', '보이게 되면 곧바로');

  const s = harness({ rec: { ticket: { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0 } }, handler: ({ now }) => reply(200, stateFile({ saleStatus: 'SOLD_OUT', generatedAtMs: now })) });
  await s.start();
  assert.equal(s.last().state, 'sold-out');
  const n = s.calls.length;
  await s.run(60_000);
  assert.equal(s.calls.length, n, '매진이면 폴링을 멈춘다');
  const e = harness({ rec: { ticket: { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0 } }, handler: ({ now }) => reply(200, stateFile({ saleStatus: 'ENDED', generatedAtMs: now })) });
  await e.start();
  assert.deepEqual([e.last().state, e.store.read()], ['ended', null], '판매 종료면 저장소를 지운다');
});

test('SCR-008 입장 확정: SOON(다시 시도 시각) 뒤 ADMITTED, NOT_YET이면 retryAfterMs 전에 다시 보내지 않음, VERIFYING·오류 응답', async () => {
  const answers = [reply(200, { status: 'NOT_YET', retryAfterMs: 4000 }), reply(200, { status: 'SOON', retryAfterSeconds: 2 }), reply(200, { status: 'ADMITTED', admissionToken: 'a', serverEcdhPublicKey: { kty: 'EC' } })];
  const h = harness({ rec: { ticket: { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0 } }, handler: ({ m, now }) => (m === 'GET' ? reply(200, stateFile({ serving: 1000, generatedAtMs: now })) : answers.shift()) });
  await h.start();
  const admits = () => h.calls.filter((c) => c.url.endsWith('/admission')).length;
  assert.equal(admits(), 1);
  await h.run(3900);
  assert.equal(admits(), 1, 'NOT_YET 4초 전에는 보내지 않는다(폴링은 이어짐)');
  assert.ok(h.calls.filter((c) => c.m === 'GET').length > 2);
  await h.run(200);
  assert.equal(admits(), 2);
  assert.equal(h.last().state, 'soon');
  assert.ok(h.last().retryAt > h.now);
  await h.run(2300);
  assert.equal(h.last().state, 'admitted');

  const cases = [
    [reply(200, { status: 'VERIFYING' }), (x) => assert.deepEqual(x.navs, ['/queue/e1/verify'])],
    [reply(403, {}, { problem: 'booking-restricted' }), (x) => assert.equal(x.last().state, 'restricted')],
    [reply(403, {}, { problem: 'queue-ticket-invalid' }), (x) => assert.equal(x.last().state, 'duplicate')],
    [reply(403, {}, { problem: 'identity-verification-required' }), (x) => assert.deepEqual(x.navs, ['/events/e1'])],
    [reply(409, {}, { problem: 'duplicate-admission' }), (x) => assert.equal(x.last().state, 'duplicate')],
    [reply(410, { rejoinAllowed: true }, { problem: 'queue-ticket-expired' }), (x) => assert.deepEqual([x.last().state, x.last().rejoinAllowed, x.store.read().ticket], ['expired', true, undefined])],
    [reply(410, { rejoinAllowed: false }, { problem: 'queue-ticket-expired' }), (x) => assert.equal(x.last().rejoinAllowed, false)],
    [reply(410, {}, { problem: 'queue-ticket-removed' }), (x) => assert.equal(x.last().state, 'cancelled-elsewhere')],
    [reply(410, {}, { problem: 'sold-out' }), (x) => assert.equal(x.last().state, 'sold-out')],
    [reply(410, {}, { problem: 'sale-ended' }), (x) => assert.equal(x.last().state, 'ended')],
  ];
  for (const [answer, check] of cases) {
    const x = harness({ rec: { preverifyToken: 'pv', ticket: { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0 } }, handler: ({ m, now }) => (m === 'GET' ? reply(200, stateFile({ serving: 1000, generatedAtMs: now })) : answer) });
    await x.start();
    check(x);
  }
});

test('SCR-008 입장 확정 401: 토큰을 한 번 갱신하고 다시 보내며, 갱신이 거절되거나 또 401이면 로그인 만료', async () => {
  let n = 0;
  const h = harness({ rec: { ticket: { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0 } }, handler: ({ m, now }) => (m === 'GET' ? reply(200, stateFile({ serving: 1000, generatedAtMs: now })) : ++n === 1 ? reply(401) : reply(200, { status: 'ADMITTED', admissionToken: 'a', serverEcdhPublicKey: { kty: 'EC' } })) });
  await h.start();
  assert.deepEqual([h.refreshes, h.last().state], [2, 'admitted'], '차례 1분 전 미리 갱신 한 번 + 401 뒤 한 번');
  const x = harness({ rec: { ticket: { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0 } }, handler: ({ m, now }) => (m === 'GET' ? reply(200, stateFile({ serving: 1000, generatedAtMs: now })) : reply(401)) });
  x.refreshResult = 'rejected';
  await x.start();
  assert.equal(x.last().state, 'login-expired');
});

test('SCR-008 대기 취소는 DELETE entries/me 204 뒤 저장소를 지우고 공연 상세로, 만료 뒤 다시 줄 서기는 새 요청 ID로 진입', async () => {
  const h = harness({ rec: { preverifyToken: 'pv', ticket: { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0 } }, handler: ({ m, now }) => (m === 'DELETE' ? reply(204) : m === 'GET' ? reply(200, stateFile({ serving: 900, generatedAtMs: now })) : reply(500)) });
  await h.start();
  assert.equal(await h.ctl.cancel(), true);
  assert.deepEqual([h.navs, h.store.read()], [['/events/e1'], null]);
  const x = harness({
    rec: { preverifyToken: 'pv', ticket: { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0 } },
    handler: ({ m, url, now }) => (m === 'GET' ? reply(200, stateFile({ serving: 1000, generatedAtMs: now })) : url.endsWith('/admission') ? reply(410, { rejoinAllowed: true }, { problem: 'queue-ticket-expired' }) : reply(201, { queueTicket: 'qt2', seq: 2000, generation: 1, segment: 1, serverTimeMs: now })),
  });
  await x.start();
  assert.equal(x.last().state, 'expired');
  x.ctl.rejoin();
  await x.run(10);
  const entry = x.calls.find((c) => c.url.endsWith('/entries'));
  assert.equal(entry.body.preverifyToken, 'pv');
  assert.equal(x.store.read().ticket.queueTicket, 'qt2');
});

const admitFile = ({ now }) => reply(200, stateFile({ serving: 1000, generatedAtMs: Math.floor(now / 1000) * 1000 }));
const TICKET = { ticket: { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0 } };

test('SCR-008 ADMITTED에 공개키가 없어도(계약에서 선택) 토큰을 저장하고 좌석 화면으로 간다(입장 확정을 되풀이하지 않는다)', async () => {
  const h = harness({ rec: TICKET, handler: (q) => (q.m === 'GET' ? admitFile(q) : reply(200, { status: 'ADMITTED', admissionToken: 'a' })) });
  await h.start();
  assert.deepEqual(h.navs, ['/booking/e1/seats']);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/admission')).length, 1);
  assert.equal(JSON.parse(h.session.getItem('peaket.admission.e1')).admissionToken, 'a');
});

test('SCR-008 401 뒤 갱신이 일시 장애면 기다렸다가 다시 보낸다(쉼 없이 되풀이하지 않는다)', async () => {
  const h = harness({ rec: TICKET, handler: (q) => (q.m === 'GET' ? admitFile(q) : reply(401)) });
  h.refreshResult = 'unavailable';
  await h.start();
  const n = h.calls.filter((c) => c.url.endsWith('/admission')).length;
  assert.ok(n <= 2, `시간이 흐르지 않았는데 입장 확정 ${n}번`);
  await h.run(10_000);
  assert.ok(h.calls.filter((c) => c.url.endsWith('/admission')).length < 30, '10초에 30번 넘게 보내지 않는다');
});

test('SCR-008 실패 뒤 다시 보내기는 전체 지터(0 ~ min(0.5초 × 2^n, 8초))다', async () => {
  let failed = 0;
  const h = harness({ rec: { preverifyToken: 'pv' }, handler: () => (failed++ < 3 ? Promise.reject(new Error('net')) : reply(410, {}, { problem: 'sale-ended' })) });
  h.env.random = () => 0.5;
  h.env.net.postText = async (url, body) => {
    h.calls.push({ m: 'POST', url, body, at: h.now });
    if (failed++ < 3) throw new Error('net');
    return reply(410, {}, { problem: 'sale-ended' });
  };
  await h.start();
  await h.run(20_000);
  const at = h.calls.map((c) => c.at - h.calls[0].at);
  assert.deepEqual(at, [0, 500, 1500, 3500], '0.5 × min(500·2^n, 8000)');
  assert.equal(h.last().state, 'ended');
});

test('SCR-008 서버 하한(진입 Retry-After·곧 입장 retryAfterSeconds)은 탭 전환·연결 사건으로 깨지 않는다', async () => {
  const seq = [reply(503, {}, { retryAfterMs: 10_000 })];
  const h = harness({ rec: { preverifyToken: 'pv' }, handler: ({ m, now }) => (m === 'POST' ? seq.shift() ?? reply(201, { queueTicket: 'qt', seq: 5000, generation: 1, segment: 4, serverTimeMs: now }) : reply(200, stateFile({ serving: 1, generatedAtMs: now }))) });
  await h.start();
  await h.wake();
  await h.run(100);
  await h.wake();
  assert.equal(h.calls.filter((c) => c.m === 'POST').length, 1, 'Retry-After 10초 안에는 다시 보내지 않는다');
  const s = harness({ rec: TICKET, handler: (q) => (q.m === 'GET' ? admitFile(q) : reply(200, { status: 'SOON', retryAfterSeconds: 5 })) });
  await s.start();
  await s.wake();
  await s.run(10);
  assert.equal(s.calls.filter((c) => c.url.endsWith('/admission')).length, 1, 'SOON 5초 안에는 다시 보내지 않는다');
  await s.run(6000);
  assert.equal(s.calls.filter((c) => c.url.endsWith('/admission')).length, 2);
  assert.deepEqual(s.states().filter((x) => x === 'turn').length, 1, "SOON 뒤 다시 보낼 때 '입장 중'으로 깜박이지 않는다");
});

test('SCR-008 진입 401(팬 토큰 만료)은 한 번 갱신하고 다시 보내며, 또 401이면 로그인 만료. 400·415는 공연 상세', async () => {
  let n = 0;
  const h = harness({ rec: { preverifyToken: 'pv' }, handler: ({ m, now }) => (m === 'POST' ? (++n === 1 ? reply(401) : reply(201, { queueTicket: 'qt', seq: 5000, generation: 1, segment: 4, serverTimeMs: now })) : reply(200, stateFile({ serving: 1, generatedAtMs: now }))) });
  await h.start();
  assert.deepEqual([h.refreshes >= 1, h.store.read().ticket.queueTicket], [true, 'qt']);
  const x = harness({ rec: { preverifyToken: 'pv' }, handler: () => reply(401) });
  await x.start();
  assert.equal(x.last().state, 'login-expired');
  for (const status of [400, 415]) {
    const y = harness({ rec: { preverifyToken: 'pv' }, handler: () => reply(status) });
    await y.start();
    assert.deepEqual(y.navs, ['/events/e1'], String(status));
  }
});

test('SCR-008 대기 취소는 204만 성공이고, 실패하면 대기를 이어 간다. 취소하는 동안 폴링을 멈춘다', async () => {
  const h = harness({ rec: { preverifyToken: 'pv', ...TICKET }, handler: ({ m, now }) => (m === 'DELETE' ? reply(404) : reply(200, stateFile({ serving: 900, generatedAtMs: now }))) });
  await h.start();
  assert.equal(await h.ctl.cancel(), false);
  assert.deepEqual(h.navs, []);
  assert.equal(h.store.read().ticket.queueTicket, 'qt');
  const polls = h.calls.filter((c) => c.m === 'GET').length;
  await h.run(25_000);
  assert.ok(h.calls.filter((c) => c.m === 'GET').length > polls, '대기를 이어 간다');
});

test('SCR-008 입장 뒤 [뒤로]로 돌아와 구매 세션이 남았으면 좌석 화면으로, 410이면 저장소를 지운다', async () => {
  const h = harness({ rec: TICKET, handler: () => reply(500) });
  h.session.setItem('peaket.admission.e1', JSON.stringify({ admissionToken: 'a', purchaseSessionExpiresAt: new Date(h.now + 60_000).toISOString(), receivedAt: h.now }));
  await h.start();
  assert.deepEqual([h.navs, h.calls.length], [['/booking/e1/seats'], 0]);
  for (const problem of ['sold-out', 'sale-ended']) {
    const x = harness({ rec: { preverifyToken: 'pv' }, handler: () => reply(410, {}, { problem }) });
    await x.start();
    assert.equal(x.store.read(), null, problem);
  }
  const y = harness({ rec: { preverifyToken: 'pv', ...TICKET }, handler: (q) => (q.m === 'GET' ? admitFile(q) : reply(410, { rejoinAllowed: true }, { problem: 'queue-ticket-expired' })) });
  await y.start();
  assert.deepEqual([y.store.read().ticket, y.store.read().preverifyToken], [undefined, 'pv'], '다시 줄 서기에 쓸 토큰만 남긴다');
});

test('SCR-008 진입 403 preverify-invalid면 사전 검증 토큰을 지우고 공연 상세로 간다(공연 상세가 그 토큰으로 다시 보내 오가지 않게, 새 맥락 리뷰 2026-11-05)', async () => {
  const h = harness({
    rec: { preverifyToken: 'pv-bad', preverifyIssuedAt: 1, preverifyExpiresAt: 9_999_999_999_999 },
    handler: ({ m }) => (m === 'POST' ? reply(403, {}, { problem: 'preverify-invalid' }) : reply(500)),
  });
  await h.start();
  assert.deepEqual(h.navs, ['/events/e1']);
  const rec = h.store.read();
  assert.equal(rec?.preverifyToken, undefined);
  assert.equal(rec?.preverifyExpiresAt, undefined);
});
