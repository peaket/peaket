// 월렛 목록 받기·저장 맞추기·화면 상태 시험(FIX-wallet-tickets, O-T48 ①~⑤·⑦·⑧·⑩).
// 정본: docs/frontend.md §4.2.4 '월렛 목록 세부'(받기·표시 값·저장·화면 상태), docs/features/offline-gate.md §11 O-T48, docs/design/d5-screen-blueprint.md §5.13,
// openapi listTickets·getEvent(EventPublicSummary). 계획 docs/review/plans/FIX-wallet-tickets.md §8.3 모양 그대로다. 시험 담당(fwal-test-2e9a)이 구현 전에 썼다.
// - 바꿔 끼우는 것은 팬 API 경계(globalThis.fetch)와 IndexedDB(fake-indexeddb)뿐이다. 받기(sync.ts)·저장소(store.ts)·회차 요약 읽기(entities/event-summary)는 진짜다.
// - 가짜 서버의 목록 응답은 계약 Zod(ListTicketsResponse)를 지나는 모양으로만 만든다(모양이 틀린 응답을 일부러 내는 시험만 예외).
// - 시각은 Date만 가짜 시계(mock.timers)로 고정한다. 읽기 시간 한도 타이머는 건드리지 않는다.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { ListTicketsResponse } from '@peaket/contracts/openapi/tickets';
import { ORIGINS } from '../../shared/config/origins.ts';
import { generateDeviceKey } from '../wallet-device-key/device-key.ts';
import { listTicketSnapshots, loadDeviceKey, loadLastSyncedAt, loadTicketSnapshot, saveDeviceKey, walletDatabase } from '../wallet-device-key/store.ts';
import { walletScreenOf } from './model.ts';
import { loadWalletCards, syncWallet } from './sync.ts';

/** 시험용 팬 API 출처(코드 기본값과 다르게 골라 부를 때마다 ORIGINS.api를 읽는지도 본다) */
const API = 'https://api.fwal.test';
const PROBLEM = 'https://peaket.example/problems/';
const NOW = Date.parse('2026-11-23T03:00:00.000Z');
const DAY = 24 * 3_600_000;
const E1 = '0193f2c0-0000-7000-8000-0000000fe001';
const E2 = '0193f2c0-0000-7000-8000-0000000fe002';
const E3 = '0193f2c0-0000-7000-8000-0000000fe003';
const E4 = '0193f2c0-0000-7000-8000-0000000fe004';

let n = 0;
/** 시험마다 새 티켓 ID(UUIDv7 꼴) */
const nextTicket = () => `0190f3a1-7c2e-7a00-8000-${String(480_000 + n++).padStart(12, '0')}`;

/** 목록 항목 하나(정본 offline-gate §2 '무엇을 싣나'의 칸). received면 receivedFromNickname 칸을 뺀다(받은 표) */
function item(ticketId, o = {}) {
  const startsAt = new Date(o.startsAtMs ?? NOW + 7 * DAY).toISOString();
  const out = { ticketId, eventId: o.eventId ?? E1, status: o.status ?? 'ISSUED', transferLocked: false, eventStartsAt: startsAt, cancelDeadline: startsAt };
  if (!o.received) out.receivedFromNickname = null;
  return out;
}

/** 회차 공개 요약 200 본문(openapi EventPublicSummary의 칸) */
function summary(eventId, o = {}) {
  return {
    eventId,
    title: o.title ?? `공연 ${eventId.slice(-3)}`,
    startsAt: new Date(o.startsAtMs ?? NOW + 7 * DAY).toISOString(),
    sellerName: '주식회사 피켓 시험',
    placeName: o.placeName ?? `장소 ${eventId.slice(-3)}`,
    entryOpensAt: new Date((o.startsAtMs ?? NOW + 7 * DAY) - 3_600_000).toISOString(),
    endsAt: new Date(o.endsAtMs ?? NOW + 7 * DAY + 3 * 3_600_000).toISOString(),
  };
}

const json = (status, body, type = 'application/json') => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const problem = (status, name, title = '오류') => json(status, { type: `${PROBLEM}${name}`, title, status }, 'application/problem+json');
/** 계약 Zod를 지난 목록 응답 200 */
const page = (items, nextCursor = null) => () => json(200, ListTicketsResponse.parse({ items, nextCursor }));

const reply = {
  disconnect: () => {
    throw new TypeError('fetch failed');
  },
  timeout: () => {
    throw new DOMException('시간 초과', 'TimeoutError');
  },
  status: (s, name) => () => (name ? problem(s, name) : new Response(null, { status: s })),
  unauthorized: () => json(401, { type: 'about:blank', title: 'Unauthorized', status: 401 }, 'application/problem+json'),
  refreshed: () => new Response(null, { status: 204 }),
};

/**
 * 가짜 팬 API(gw-fan → ticket-svc·core-svc·identity-svc 경계). 목록·토큰 갱신은 준 응답을 차례로 쓰고, 회차 요약은 회차 ID별 응답을 쓴다.
 * 모든 요청을 기록하고, 준비하지 않은 요청은 unexpected에 남긴다(시험이 0개인지 단언한다)
 */
function fakeFanApi({ tickets = [], refresh = [], events = {} } = {}) {
  const calls = { tickets: [], refresh: [], events: [], unexpected: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { url: String(input), path: url.pathname, query: [...url.searchParams.entries()], method: init.method ?? 'GET', credentials: init.credentials, signal: init.signal };
    if (url.origin === API && url.pathname === '/v1/tickets') {
      calls.tickets.push(call);
      const r = tickets[calls.tickets.length - 1];
      if (r) return r(call);
    } else if (url.origin === API && url.pathname === '/v1/identity/access-tokens') {
      calls.refresh.push(call);
      const r = refresh[calls.refresh.length - 1];
      if (r) return r(call);
    } else if (url.origin === API && url.pathname.startsWith('/v1/events/')) {
      calls.events.push(call);
      const id = decodeURIComponent(url.pathname.slice('/v1/events/'.length));
      const r = events[id];
      if (r) return r(call);
    }
    calls.unexpected.push(call);
    return json(599, { title: '시험이 준비하지 않은 요청' });
  };
  return calls;
}

/** 회차 요약 응답들: 주지 않은 회차는 요약 200 */
const okEvents = (...eventIds) => Object.fromEntries(eventIds.map((id) => [id, () => json(200, summary(id))]));

const realFetch = globalThis.fetch;
const realApi = ORIGINS.api;
beforeEach(async () => {
  ORIGINS.api = API;
  mock.timers.enable({ apis: ['Date'], now: NOW });
  const db = walletDatabase();
  await db.tickets.clear();
  await db.deviceKeys.clear();
  await db.meta.clear();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  ORIGINS.api = realApi;
  mock.timers.reset();
  mock.restoreAll();
});

const storedIds = async () => (await listTicketSnapshots()).map((s) => s.ticketId);

/** 한 번 받아 두 장을 저장해 둔다(저장된 표가 있는 상태) */
async function seedStored() {
  const ids = [nextTicket(), nextTicket()];
  fakeFanApi({ tickets: [page(ids.map((id) => item(id)))], events: okEvents(E1) });
  assert.deepEqual(await syncWallet(), { kind: 'ok', count: 2 });
  assert.deepEqual(await storedIds(), ids);
  return ids;
}

test('O-T48 ① 커서를 그대로 실어 limit 100으로 세 쪽을 받고 모두 저장한 뒤 lastSyncAt을 쓴다', async () => {
  const ids = [nextTicket(), nextTicket(), nextTicket(), nextTicket()];
  const c1 = 'WzE3OTU2NTEyMDAwMDAsImEiXQ';
  const c2 = 'WzE3OTU2NTExMDAwMDAsImIiXQ';
  const calls = fakeFanApi({
    tickets: [page([item(ids[0]), item(ids[1])], c1), page([item(ids[2], { eventId: E2 })], c2), page([item(ids[3])], null)],
    events: okEvents(E1, E2),
  });

  const r = await syncWallet();

  assert.deepEqual(r, { kind: 'ok', count: 4 });
  assert.deepEqual(calls.unexpected, []);
  // 세 번: 처음은 limit=100만, 다음부터 앞 응답의 nextCursor를 그대로
  assert.equal(calls.tickets.length, 3);
  assert.deepEqual(
    calls.tickets.map((c) => [c.url.slice(0, `${API}/v1/tickets`.length), c.method, c.credentials, Object.fromEntries(c.query)]),
    [
      [`${API}/v1/tickets`, 'GET', 'include', { limit: '100' }],
      [`${API}/v1/tickets`, 'GET', 'include', { limit: '100', cursor: c1 }],
      [`${API}/v1/tickets`, 'GET', 'include', { limit: '100', cursor: c2 }],
    ],
  );
  // 손 호출마다 시간 한도 신호를 싣는다(docs/frontend.md §4.1 'api-client 밖의 호출', TR-07)
  for (const c of [...calls.tickets, ...calls.events]) assert.ok(c.signal instanceof AbortSignal, `${c.path}에 시간 한도 신호가 없다`);
  for (const c of calls.tickets) assert.equal(c.query.length, Object.keys(Object.fromEntries(c.query)).length, `같은 쿼리 이름이 겹쳤다 ${c.url}`);
  // 받은 표를 서버 차례 그대로 모두 저장했다
  assert.deepEqual(await storedIds(), ids);
  assert.equal(await loadLastSyncedAt(), NOW);
});

test('O-T48 ① 팬 API 주소가 없는 빌드는 부르지 않고 unavailable이며 저장된 표로 그린다', async () => {
  const ids = await seedStored();
  ORIGINS.api = '';
  const calls = fakeFanApi();
  const r = await syncWallet();
  assert.deepEqual(r, { kind: 'unavailable' });
  assert.equal(calls.tickets.length + calls.events.length + calls.refresh.length + calls.unexpected.length, 0);
  assert.deepEqual(await storedIds(), ids);
  assert.equal(walletScreenOf({ stored: 2, sync: r }).screen, 'list');
});

test('O-T48 ② 표가 0장이면 ok·0장이고 화면은 빈 화면이며 지난 동기화의 표도 지운다', async () => {
  await seedStored();
  const calls = fakeFanApi({ tickets: [page([])] });
  const r = await syncWallet();
  assert.deepEqual(r, { kind: 'ok', count: 0 });
  assert.deepEqual(calls.events, [], '표가 없는데 회차 요약을 물었다');
  assert.deepEqual(await storedIds(), []);
  assert.deepEqual(walletScreenOf({ stored: 0, sync: r }), { screen: 'empty', offline: false });
});

test('O-T48 ③ 저장된 표가 없는데 끊김·시간 초과·5xx·정의 밖 상태·모양이 틀린 200이면 실패이고 화면은 불러오지 못함이다(ticket-svc 503 포함)', async () => {
  for (const [label, r, reason] of [
    ['연결 끊김', reply.disconnect, 'network'],
    ['시간 초과', reply.timeout, 'network'],
    ['500', reply.status(500), 'server'],
    ['502', reply.status(502), 'server'],
    ['503 ticket-svc 장애', reply.status(503, 'dependency-unavailable'), 'server'],
    ['504', reply.status(504), 'server'],
    ['404 정의 밖', reply.status(404, 'not-found'), 'server'],
    ['items 칸 없음 {}', () => json(200, {}), 'bad-response'],
    ['items 칸 없음 nextCursor만', () => json(200, { nextCursor: null }), 'bad-response'],
    ['items가 배열 아님', () => json(200, { items: { ticketId: 'x' }, nextCursor: null }), 'bad-response'],
    ['nextCursor가 글·null 아님', () => json(200, { items: [], nextCursor: 7 }), 'bad-response'],
    ['목록 밖 상태 값', () => json(200, { items: [{ ...item(nextTicket()), status: 'LOST' }], nextCursor: null }), 'bad-response'],
    ['JSON 아님', () => new Response('<html>점검 중</html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'bad-response'],
  ]) {
    const calls = fakeFanApi({ tickets: [r] });
    const got = await syncWallet();
    assert.deepEqual(got, { kind: 'failed', reason }, label);
    assert.equal(calls.tickets.length, 1, label);
    assert.deepEqual(calls.unexpected, [], label);
    assert.deepEqual(await storedIds(), [], `${label}: 저장소가 바뀌었다`);
    assert.equal(await loadLastSyncedAt(), undefined, `${label}: 실패인데 lastSyncAt을 썼다`);
    assert.deepEqual(walletScreenOf({ stored: 0, sync: got }), { screen: 'error', offline: false }, label);
  }
});

test('O-T48 ③ [다시 시도]로 다시 부르면 새 요청을 보내고 성공하면 표가 생긴다', async () => {
  const id = nextTicket();
  const calls = fakeFanApi({ tickets: [reply.status(503, 'dependency-unavailable'), page([item(id)])], events: okEvents(E1) });
  assert.deepEqual(await syncWallet(), { kind: 'failed', reason: 'server' });
  const again = await syncWallet();
  assert.deepEqual(again, { kind: 'ok', count: 1 });
  assert.equal(calls.tickets.length, 2);
  assert.deepEqual(await storedIds(), [id]);
  assert.equal(walletScreenOf({ stored: 1, sync: again }).screen, 'list');
});

test('O-T48 ④ 저장된 표가 있는데 목록 요청이 끊기면 저장소를 그대로 두고 저장된 표와 오프라인 배너를 보인다', async () => {
  const ids = await seedStored();
  const before = await loadLastSyncedAt();
  mock.timers.setTime(NOW + 60_000);
  for (const [label, r, reason] of [
    ['끊김', reply.disconnect, 'network'],
    ['503', reply.status(503, 'dependency-unavailable'), 'server'],
    // TR-01: items 칸이 없는 200은 빈 목록이 아니라 모양이 틀린 응답이다(계약 Zod를 지나도)
    ['items 칸 없음 {}', () => json(200, {}), 'bad-response'],
    ['items 칸 없음 nextCursor만', () => json(200, { nextCursor: null }), 'bad-response'],
  ]) {
    fakeFanApi({ tickets: [r] });
    const got = await syncWallet();
    assert.deepEqual(got, { kind: 'failed', reason }, label);
    assert.deepEqual(await storedIds(), ids, `${label}: 실패에 저장소를 비웠다(현장 오프라인에서 QR이 사라진다)`);
    assert.equal(await loadLastSyncedAt(), before, `${label}: 실패인데 lastSyncAt이 바뀌었다`);
    assert.deepEqual(walletScreenOf({ stored: ids.length, sync: got }), { screen: 'list', offline: true }, label);
  }
});

test('O-T48 ④ 저장된 표가 있는데 첫 쪽은 200이고 둘째 쪽이 끊김·503·401이면 받은 만큼 맞추지 않고 저장소·lastSyncAt을 그대로 둔다(TR-03)', async () => {
  const ids = await seedStored();
  const before = await loadLastSyncedAt();
  mock.timers.setTime(NOW + 90_000);
  for (const [label, second, want, refresh] of [
    ['둘째 쪽 끊김', [reply.disconnect], { kind: 'failed', reason: 'network' }, []],
    ['둘째 쪽 503', [reply.status(503, 'dependency-unavailable')], { kind: 'failed', reason: 'server' }, []],
    ['둘째 쪽 401 → 갱신 → 401', [reply.unauthorized, reply.unauthorized], { kind: 'needs-login' }, [reply.refreshed]],
  ]) {
    const fresh = nextTicket();
    const calls = fakeFanApi({ tickets: [page([item(fresh)], 'WzE3OTU2NTEyMDAwMDAsImUiXQ'), ...second], refresh, events: okEvents(E1) });
    const got = await syncWallet();
    assert.deepEqual(got, want, label);
    assert.equal(calls.tickets.length, 1 + second.length, label);
    assert.deepEqual(await storedIds(), ids, `${label}: 다 받지 못했는데 저장소를 맞췄다(옛 표가 지워지면 오프라인 QR이 사라진다)`);
    assert.equal(await loadTicketSnapshot(fresh), undefined, `${label}: 다 받지 못한 목록의 새 표를 저장했다`);
    assert.equal(await loadLastSyncedAt(), before, `${label}: lastSyncAt이 바뀌었다`);
  }
});

test('O-T48 ③ 시간 한도: 목록 응답이 오지 않으면 읽기 한도 10초 뒤 network 실패이고 그 전에는 끝나지 않는다(TR-07)', async () => {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  let asked = 0;
  // 답하지 않는 망: 요청의 시간 한도 신호가 끊을 때만 거절한다
  globalThis.fetch = (input, init = {}) => {
    asked += 1;
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };
  let settled = false;
  const p = syncWallet().then((r) => {
    settled = true;
    return r;
  });
  for (let i = 0; i < 50 && asked === 0; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(asked, 1, '목록을 부르지 않았다');
  mock.timers.tick(9_999);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, '10초 전에 끝났다');
  mock.timers.tick(1);
  assert.deepEqual(await p, { kind: 'failed', reason: 'network' });
  assert.deepEqual(await storedIds(), []);
});

test('O-T48 ⑤ 토큰을 한 번 갱신한 뒤에도 401이면 needs-login이고 화면은 저장된 표 대신 로그인이다', async () => {
  const ids = await seedStored();
  for (const [label, refresh, tickets] of [
    ['갱신 성공 뒤 다시 401', [reply.refreshed], [reply.unauthorized, reply.unauthorized]],
    ['갱신도 401(세션 끝남)', [reply.unauthorized], [reply.unauthorized]],
  ]) {
    const calls = fakeFanApi({ tickets, refresh });
    const got = await syncWallet();
    assert.deepEqual(got, { kind: 'needs-login' }, label);
    assert.equal(calls.refresh.length, 1, `${label}: 갱신은 한 번`);
    assert.equal(calls.refresh[0].url, `${API}/v1/identity/access-tokens`, label);
    assert.equal(calls.refresh[0].method, 'POST', label);
    assert.equal(calls.tickets.length, tickets.length, label);
    assert.equal(walletScreenOf({ stored: ids.length, sync: got }).screen, 'login', `${label}: 저장된 표를 그렸다`);
  }
});

test('O-T48 ⑤ 대조: 401 → 토큰 갱신 성공 → 200이면 끝까지 받는다(첫 401만으로 로그인으로 보내지 않는다)', async () => {
  const id = nextTicket();
  const calls = fakeFanApi({ tickets: [reply.unauthorized, page([item(id)])], refresh: [reply.refreshed], events: okEvents(E1) });
  assert.deepEqual(await syncWallet(), { kind: 'ok', count: 1 });
  assert.equal(calls.refresh.length, 1);
  assert.equal(calls.tickets.length, 2);
  assert.deepEqual(await storedIds(), [id]);
});

test('O-T48 ⑦ 회차 요약은 회차마다 한 번이고 404·410·실패 회차의 표도 남는다', async () => {
  const t = { e1a: nextTicket(), e1b: nextTicket(), e2: nextTicket(), e3: nextTicket(), e4: nextTicket(), e1c: nextTicket() };
  const calls = fakeFanApi({
    tickets: [
      page([item(t.e1a), item(t.e2, { eventId: E2 }), item(t.e1b)], 'WzE3OTU2NTEyMDAwMDAsImMiXQ'),
      page([item(t.e3, { eventId: E3 }), item(t.e4, { eventId: E4 }), item(t.e1c)], null),
    ],
    events: {
      [E1]: () => json(200, summary(E1, { title: 'LUMEN 콘서트 2026 서울', placeName: 'KSPO DOME' })),
      [E2]: reply.status(404, 'not-found'),
      [E3]: reply.status(410, 'gone'),
      [E4]: reply.disconnect,
    },
  });

  assert.deepEqual(await syncWallet(), { kind: 'ok', count: 6 });
  assert.deepEqual(calls.unexpected, []);
  // 같은 회차는 한 번만(쪽이 달라도). 요약은 공개 경로라 쿠키를 싣지 않는다(openapi getEvent)
  const asked = calls.events.map((c) => c.path).sort();
  assert.deepEqual(asked, [E1, E2, E3, E4].map((e) => `/v1/events/${e}`).sort());
  for (const c of calls.events) assert.notEqual(c.credentials, 'include', `${c.path}에 쿠키를 실었다`);
  // 실패 회차의 표도 모두 남는다
  assert.deepEqual(await storedIds(), [t.e1a, t.e2, t.e1b, t.e3, t.e4, t.e1c]);
  const cards = new Map((await loadWalletCards(NOW)).map((c) => [c.ticketId, c]));
  assert.equal(cards.size, 6);
  for (const id of [t.e1a, t.e1b, t.e1c]) {
    assert.equal(cards.get(id).title, 'LUMEN 콘서트 2026 서울', id);
    assert.equal(cards.get(id).placeName, 'KSPO DOME', id);
    assert.equal(cards.get(id).startsAt, summary(E1).startsAt, id);
  }
  for (const id of [t.e2, t.e3, t.e4]) {
    assert.equal(cards.get(id).title, null, `${id}: 실패 회차인데 공연명이 있다(화면은 '공연 정보를 불러오지 못했습니다')`);
    assert.equal(cards.get(id).placeName, null, id);
  }
});

test('O-T48 ⑧ 목록에서 빠진 표의 표시 값은 지우고 그 표의 기기 키는 남긴다', async () => {
  const [kept, gone] = await seedStored();
  const key = await generateDeviceKey();
  await saveDeviceKey({ ticketId: gone, keyId: key.keyIdText, privateKey: key.privateKey, publicKeyJwk: key.publicKeyJwk, createdAt: NOW, reason: 'ISSUE', registration: 'REGISTERED' });
  mock.timers.setTime(NOW + 120_000);
  fakeFanApi({ tickets: [page([item(kept)])], events: okEvents(E1) });

  assert.deepEqual(await syncWallet(), { kind: 'ok', count: 1 });

  assert.deepEqual(await storedIds(), [kept]);
  assert.equal(await loadTicketSnapshot(gone), undefined, '빠진 표의 표시 값이 남았다');
  assert.notEqual(await loadTicketSnapshot(kept), undefined);
  const stillKey = await loadDeviceKey(gone);
  assert.equal(stillKey?.ticketId, gone, '빠진 표의 기기 키까지 지웠다');
  assert.equal(stillKey?.registration, 'REGISTERED');
  assert.deepEqual((await loadWalletCards(NOW + 120_000)).map((c) => c.ticketId), [kept], '빠진 표를 그린다');
  assert.equal(await loadLastSyncedAt(), NOW + 120_000);
});

test('O-T48 ⑩ 서버가 앞 쪽과 같은 커서를 다시 주면 더 부르지 않고 cursor-loop 실패이며 저장소를 바꾸지 않는다', async () => {
  // 저장된 표가 없을 때: 불러오지 못함
  const loop = 'WzE3OTU2NTEyMDAwMDAsImQiXQ';
  let calls = fakeFanApi({ tickets: [page([item(nextTicket())], loop), page([item(nextTicket())], loop), page([item(nextTicket())], null)], events: okEvents(E1) });
  let got = await syncWallet();
  assert.deepEqual(got, { kind: 'failed', reason: 'cursor-loop' });
  assert.equal(calls.tickets.length, 2, '같은 커서에 더 불렀다');
  assert.deepEqual(await storedIds(), []);
  assert.deepEqual(walletScreenOf({ stored: 0, sync: got }), { screen: 'error', offline: false });

  // 저장된 표가 있을 때: 저장된 표와 오프라인 배너
  const ids = await seedStored();
  calls = fakeFanApi({ tickets: [page([item(nextTicket())], loop), page([item(nextTicket())], loop)], events: okEvents(E1) });
  got = await syncWallet();
  assert.deepEqual(got, { kind: 'failed', reason: 'cursor-loop' });
  assert.equal(calls.tickets.length, 2);
  assert.deepEqual(await storedIds(), ids);
  assert.deepEqual(walletScreenOf({ stored: ids.length, sync: got }), { screen: 'list', offline: true });
});

test('O-T48 ②③④⑤ 화면 상태 표: 받는 중·0장·실패·저장 있음·401(walletScreenOf)', () => {
  const cases = [
    [{ stored: 0, sync: 'pending' }, { screen: 'loading', offline: false }],
    [{ stored: 3, sync: 'pending' }, { screen: 'list', offline: false }],
    [{ stored: 0, sync: { kind: 'ok', count: 0 } }, { screen: 'empty', offline: false }],
    [{ stored: 2, sync: { kind: 'ok', count: 2 } }, { screen: 'list', offline: false }],
    [{ stored: 0, sync: { kind: 'failed', reason: 'network' } }, { screen: 'error', offline: false }],
    [{ stored: 0, sync: { kind: 'failed', reason: 'bad-response' } }, { screen: 'error', offline: false }],
    [{ stored: 4, sync: { kind: 'failed', reason: 'server' } }, { screen: 'list', offline: true }],
    [{ stored: 4, sync: { kind: 'failed', reason: 'cursor-loop' } }, { screen: 'list', offline: true }],
    [{ stored: 3, sync: { kind: 'unavailable' } }, { screen: 'list', offline: false }],
  ];
  for (const [input, want] of cases) assert.deepEqual(walletScreenOf(input), want, JSON.stringify(input));
  for (const stored of [0, 5]) assert.equal(walletScreenOf({ stored, sync: { kind: 'needs-login' } }).screen, 'login', `저장 ${stored}장`);
});

test('FWAL-WEB ① 저장소에는 목록 밖 값(PEAKET1 포인터·주문·좌석 ID)이 들지 않고 받는 동안 console에 아무것도 내지 않는다', async () => {
  const id = nextTicket();
  const orderId = '0193f2c0-0000-7000-8000-00000000d0d0';
  const seatId = '0193f2c0-0000-7000-8000-00000000d5d5';
  const logged = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) mock.method(console, m, (...args) => logged.push([m, ...args.map(String)]));
  // 서버가 계약 밖 칸을 잘못 실어 보내도(ListTicketsResponse 밖 칸) 저장하지 않는다
  fakeFanApi({ tickets: [() => json(200, { items: [{ ...item(id), qrPayload: `PEAKET1:${id}`, orderId, seatId }], nextCursor: null })], events: okEvents(E1) });
  assert.deepEqual(await syncWallet(), { kind: 'ok', count: 1 });
  await loadWalletCards(NOW);
  const dump = JSON.stringify(await walletDatabase().tickets.toArray());
  for (const v of ['PEAKET1:', orderId, seatId]) assert.equal(dump.includes(v), false, `저장소에 ${v}`);
  assert.deepEqual(logged, [], '받는 동안 console에 무언가 냈다');
});
