// 공연 상세 앞 거르기(ADR-0201 결정 3, BUILD_ORDER HOT-311): 없는 회차는 화면을 그리기 전에 404로 거른다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalEventPath, createEventGate, eventCacheTags, eventIdFromPath } from './event-gate.ts';

const ID = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const PROD = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4d01';
const res = (status, body = { productionId: PROD }) => new Response(status === 200 ? JSON.stringify(body) : null, { status });

function gate(responder, o = {}) {
  const calls = [];
  let now = 1_000_000;
  const g = createEventGate({
    apiOrigin: 'http://api.test',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return responder(url, init);
    },
    now: () => now,
    ...o,
  });
  return { g, calls, tick: (ms) => (now += ms) };
}

test('경로에서 회차 ID를 꺼낸다(상세 주소만, 아래 경로·끝 빗금·인코딩은 아님)', () => {
  assert.equal(eventIdFromPath(`/events/${ID}`), ID);
  assert.equal(eventIdFromPath(`/events/${ID}/shuffle-proof`), undefined);
  assert.equal(eventIdFromPath('/events'), undefined);
  assert.equal(eventIdFromPath('/search'), undefined);
  assert.equal(eventIdFromPath('/events/abc'), 'abc');
});

test('모양이 틀린 ID는 서버에 묻지 않고 바로 없음이다', async () => {
  const { g, calls } = gate(() => res(200));
  for (const id of ['abc', 'not-a-uuid', `${ID}x`, ID.replaceAll('-', ''), '%3Cscript%3E']) assert.equal((await g.check(id)).kind, 'missing', id);
  assert.equal(calls.length, 0);
});

test('서버가 404면 없음, 200·410은 통과이고, 결과는 60초 기억한다(같은 회차를 매번 묻지 않는다)', async () => {
  const answers = { [ID]: 404, [ID.replace('e01', 'e02')]: 200, [ID.replace('e01', 'e03')]: 410 };
  const { g, calls, tick } = gate((url) => res(answers[String(url).split('/').pop()]));
  assert.equal((await g.check(ID)).kind, 'missing');
  assert.deepEqual(await g.check(ID.replace('e01', 'e02')), { kind: 'pass', productionId: PROD });
  assert.deepEqual(await g.check(ID.replace('e01', 'e03')), { kind: 'pass' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, `http://api.test/v1/events/${ID}`);
  assert.equal((await g.check(ID)).kind, 'missing');
  assert.deepEqual(await g.check(ID.replace('e01', 'e02')), { kind: 'pass', productionId: PROD }, '공연 ID도 기억한다');
  assert.equal(calls.length, 3, '기억한 동안은 다시 묻지 않는다');
  tick(60_001);
  assert.equal((await g.check(ID)).kind, 'missing');
  assert.equal(calls.length, 4, '60초가 지나면 다시 묻는다');
});

test('대문자 ID도 같은 회차로 기억한다', async () => {
  const { g, calls } = gate(() => res(404));
  await g.check(ID);
  await g.check(ID.toUpperCase());
  assert.equal(calls.length, 1);
});

test('서버가 실패하거나(5xx·연결 오류) 300ms를 넘기면 그대로 통과하고 기억하지 않는다(원본 장애 때 화면의 고정 문구를 막지 않는다)', async () => {
  const { g, calls } = gate(() => res(503));
  assert.equal((await g.check(ID)).kind, 'pass');
  assert.equal((await g.check(ID)).kind, 'pass');
  assert.equal(calls.length, 2);
  const broken = gate(async () => {
    throw new TypeError('fetch failed');
  });
  assert.equal((await broken.g.check(ID)).kind, 'pass');
  const slow = gate((_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), { timeoutMs: 20 });
  const t0 = Date.now();
  assert.equal((await slow.g.check(ID)).kind, 'pass');
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(slow.calls[0].init.signal, '시간 초과 신호를 넘긴다');
});

test('기억은 1만 개까지이고 넘으면 가장 오래된 것부터 버린다', async () => {
  const { g, calls } = gate(() => res(404), { maxEntries: 3 });
  const ids = [1, 2, 3, 4].map((n) => ID.replace('e01', `e0${n}`));
  for (const id of ids) await g.check(id);
  assert.equal(g.size(), 3);
  await g.check(ids[0]);
  assert.equal(calls.length, 5, '가장 오래된 것은 버려 다시 묻는다');
  assert.equal(createEventGate({ apiOrigin: 'http://x', fetch }).maxEntries, 10_000);
});

test('서버 주소가 없으면(개발·CI) 묻지 않고 통과한다(모양이 틀린 ID만 거른다)', async () => {
  const { g, calls } = gate(() => res(404), { apiOrigin: undefined });
  assert.equal((await g.check(ID)).kind, 'pass');
  assert.equal((await g.check('abc')).kind, 'missing');
  assert.equal(calls.length, 0);
});

test('같은 회차를 묻는 중이면 그 답을 같이 기다린다(기억이 끝난 순간 몰린 요청이 한 번만 묻는다)', async () => {
  let release;
  const { g, calls } = gate(() => new Promise((r) => (release = () => r(res(404)))));
  const all = Promise.all([g.check(ID), g.check(ID), g.check(ID.toUpperCase())]);
  await new Promise((r) => setTimeout(r, 5));
  release();
  assert.deepEqual((await all).map((x) => x.kind), ['missing', 'missing', 'missing']);
  assert.equal(calls.length, 1);
});

test('200 본문의 공연 ID가 없거나 모양이 틀리면 공연 ID 없이 통과한다', async () => {
  const { g } = gate(() => res(200, { productionId: 'x' }));
  assert.deepEqual(await g.check(ID), { kind: 'pass' });
});

test('대문자가 섞인 회차 주소는 소문자 주소로 옮기고, 태그 머리는 소문자다', () => {
  assert.equal(canonicalEventPath(`/events/${ID.toUpperCase()}`), `/events/${ID}`);
  assert.equal(canonicalEventPath(`/events/${ID}`), undefined);
  assert.equal(canonicalEventPath('/events/ABC'), undefined, '모양이 틀린 ID는 옮기지 않는다(거르기가 404)');
  assert.equal(canonicalEventPath(`/events/${ID.toUpperCase()}/shuffle-proof`), undefined);
  assert.equal(eventCacheTags(ID.toUpperCase(), PROD), `event:${ID},production:${PROD}`);
  assert.equal(eventCacheTags(ID, undefined), `event:${ID}`);
});
