// 대기실 fetch 층·묶음 결과 지연·저장소·시계(ADR-0207 결정 2·3·8, docs/frontend.md §3.3·§3.12·§4.2.1)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createNet, parseRetryAfter, resultRetryDelayMs, spreadDelayMs, tokenHash } from '../src/live/net.ts';
import { createStore } from '../src/live/store.ts';
import { createClock } from '../src/live/clock.ts';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};

test('T=0 두 호출은 text/plain이고 사용자 헤더가 없으며 쿠키를 싣는다. 파일은 쿠키 없이, 상태 파일은 no-store', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ type: 'https://peaket.example/problems/sold-out' }), { status: 410, headers: { 'content-type': 'application/problem+json', 'retry-after': '3' } });
  };
  const net = createNet(fetchImpl, () => 0);
  const r = await net.postText('https://queue/x', { a: 1 });
  assert.deepEqual([r.status, r.problem, r.retryAfterMs], [410, 'sold-out', 3000]);
  assert.equal(calls[0].init.credentials, 'include');
  assert.deepEqual(Object.keys(calls[0].init.headers), ['content-type']);
  assert.match(calls[0].init.headers['content-type'], /^text\/plain/);
  assert.equal(calls[0].init.body, '{"a":1}');
  assert.ok(calls[0].init.signal instanceof AbortSignal, '시간 초과');
  await net.getFile('https://files/s.json', true);
  assert.deepEqual([calls[1].init.credentials, calls[1].init.cache, calls[1].init.headers], ['omit', 'no-store', undefined]);
  await net.getFile('https://files/b.json', false);
  assert.equal(calls[2].init.cache, undefined);
  // 팬 API GET(예매 제한·알림 신청 상태): 쿠키를 싣고 브라우저 캐시를 건너뛴다(ADR-0213 결정 4·5)
  await net.getFan('https://api/v1/booking-restrictions/me');
  assert.deepEqual([calls[3].init.credentials, calls[3].init.cache, calls[3].init.method, calls[3].init.headers], ['include', 'no-store', undefined, undefined]);
});

test('FE-T15 AbortSignal.any가 없는 엔진: 요청이 끝나면 화면 신호에 단 듣기를 지운다(끝난 뒤 남은 사건 듣기 0)', async () => {
  const any = AbortSignal.any;
  try {
    // @ts-expect-error 옛 엔진 흉내
    delete AbortSignal.any;
    const c = new AbortController();
    let live = 0;
    const add = c.signal.addEventListener.bind(c.signal);
    const remove = c.signal.removeEventListener.bind(c.signal);
    c.signal.addEventListener = (t, f, o) => (live++, add(t, f, o));
    c.signal.removeEventListener = (t, f, o) => (live--, remove(t, f, o));
    const net = createNet(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), () => 0);
    await net.postText('https://queue/x', {}, c.signal);
    await net.getFan('https://api/x', c.signal);
    assert.equal(live, 0, '요청마다 단 abort 듣기를 지웠다');
    // 화면을 떠나면(화면 신호 끊김) 진행 중 요청이 AbortError로 끝난다
    const hang = createNet((_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), () => 0);
    const p = hang.getFan('https://api/y', c.signal);
    c.abort(new DOMException('left', 'AbortError'));
    await assert.rejects(p, (e) => e.name === 'AbortError');
    assert.equal(live, 0, '끊긴 뒤에도 남은 듣기 없음');
    // 시간 초과(리뷰 낮음): 타이머 신호가 끊기면 TimeoutError로 끝나고 화면 신호·타이머 신호의 듣기가 모두 남지 않는다
    const timeout = AbortSignal.timeout;
    const timer = new AbortController();
    let timerLive = 0;
    const tAdd = timer.signal.addEventListener.bind(timer.signal);
    const tRemove = timer.signal.removeEventListener.bind(timer.signal);
    timer.signal.addEventListener = (t, f, o) => (timerLive++, tAdd(t, f, o));
    timer.signal.removeEventListener = (t, f, o) => (timerLive--, tRemove(t, f, o));
    AbortSignal.timeout = () => timer.signal;
    try {
      const screen = new AbortController();
      const q = hang.getFan('https://api/z', screen.signal);
      timer.abort(new DOMException('slow', 'TimeoutError'));
      await assert.rejects(q, (e) => e.name === 'TimeoutError');
      assert.equal(timerLive, 0, '타이머 신호의 듣기도 지웠다');
    } finally {
      AbortSignal.timeout = timeout;
    }
  } finally {
    AbortSignal.any = any;
  }
});

test('Retry-After는 0 이상 정수 초나 HTTP 날짜만', () => {
  assert.equal(parseRetryAfter('2', 0), 2000);
  assert.equal(parseRetryAfter('0', 0), 0);
  assert.equal(parseRetryAfter('-1', 0), null);
  assert.equal(parseRetryAfter('1.5', 0), null);
  assert.equal(parseRetryAfter(null, 0), null);
  const now = Date.parse('2026-11-05T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 05 Nov 2026 00:00:05 GMT', now), 5000);
});

test('묶음 결과: 키는 SHA-256 16진, 지연은 바이트 2~5의 u32 mod 분산 창, 404 간격은 2초부터 두 배(최대 20초) 안의 무작위', async () => {
  const h = await tokenHash('pv-batch');
  assert.equal(h, createHash('sha256').update('pv-batch').digest('hex'));
  const u32 = Buffer.from(h, 'hex').readUInt32BE(2);
  assert.equal(spreadDelayMs(h, 8), u32 % 8000);
  assert.equal(spreadDelayMs(h, 0), 0);
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((a) => resultRetryDelayMs(a, () => 0.999)), [1998, 3996, 7992, 15984, 19980, 19980]);
});

test('저장소: 대기표·진입 값 읽고 쓰기, 꼴이 틀리거나 2일 지난 값은 버린다, 진입 값만 지우기, 처음 앞 인원, 입장', () => {
  let now = 1_000_000;
  const local = memory();
  const session = memory();
  const s = createStore('e1', local, session, () => now, (n) => new Uint8Array(n).fill(7));
  assert.equal(s.read(), null);
  s.write({ preverifyToken: 'pv', preverifyIssuedAt: now, entry: { entryRequestId: 'r1', token: 'pv' } });
  s.write({ entry: { entryRequestId: 'r1', token: 'pv', batching: { entryRequestId: 'r1', resultPath: '/v1/queues/e1/batch-results/abc.json', resultAtMs: now + 5000, spreadSec: 8 } } });
  assert.equal(s.read().entry.batching.spreadSec, 8);
  s.write({ ticket: { queueTicket: 'qt', seq: 1050, generation: 1, segment: 1 }, firstEta: { sec: 30, atMs: now } });
  assert.deepEqual(s.read().ticket, { queueTicket: 'qt', seq: 1050, generation: 1, segment: 1 });
  s.setFirstAhead(40);
  assert.equal(s.firstAhead(), 40);
  s.clearEntry();
  const r = s.read();
  assert.deepEqual([r.ticket, r.entry, r.firstEta, r.preverifyToken], [undefined, undefined, undefined, 'pv']);
  assert.equal(s.firstAhead(), null);
  local.setItem('peaket.queue.e1', JSON.stringify({ savedAt: now, ticket: { queueTicket: 'qt', seq: 'x' }, entry: { entryRequestId: 'r', token: 't', batching: { resultPath: 'https://evil/x' } } }));
  const bad = s.read();
  assert.deepEqual([bad.ticket, bad.entry.batching], [undefined, undefined], '꼴이 틀린 칸은 버린다(다른 출처 주소 포함)');
  now += 2 * 24 * 3600_000 + 1;
  assert.equal(s.read(), null, '2일 지난 값');
  assert.equal(local.getItem('peaket.queue.e1'), null);
  local.setItem('peaket.queue.e1', '{not json');
  assert.equal(s.read(), null);
  s.saveAdmission({ admissionToken: 'adm', serverEcdhPublicKey: { kty: 'EC' }, receivedAt: now });
  assert.equal(JSON.parse(session.getItem('peaket.admission.e1')).admissionToken, 'adm');
  s.write({ ticket: { queueTicket: 'qt', seq: 1, generation: 1, segment: 0 } });
  s.clearAll();
  assert.equal(local.getItem('peaket.queue.e1'), null);
  const id = s.deviceId();
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(s.deviceId(), id, '한 번 만들면 그대로');
  const noStorage = createStore('e1', null, null, () => now, (n) => new Uint8Array(n));
  assert.equal(noStorage.deviceId(), undefined, '저장소를 못 쓰면 기기 ID 없음');
});

test('시계: serverTimeMs 표본 가운데 왕복이 가장 짧은 것으로 보정하고 30분 둔다', () => {
  let dev = 10_000;
  const local = memory();
  const c = createClock(local, () => dev);
  c.sample(20_000, 9_000, 10_000); // 왕복 1000, offset = 20000 + 500 − 10000 = 10500
  assert.equal(c.now(), 20_500);
  c.sample(30_000, 9_900, 10_000); // 왕복 100, offset = 30050 − 10000 = 20050
  assert.equal(c.now(), 30_050);
  c.sample('x', 0, 1);
  assert.equal(c.now(), 30_050);
  const again = createClock(local, () => dev);
  assert.equal(again.now(), 30_050, '저장한 보정값');
  dev += 31 * 60_000;
  assert.equal(createClock(local, () => dev).now(), dev, '30분 지나면 버린다');
});
