// FE-T37 찜 오프라인 동기화(docs/frontend.md §6, §3.12 `peaket.wishQueue`, §4.2.4, openapi put/deleteProductionWish).
// 화면 없이 순수 규칙만 본다: 마지막 동작이 이기고, 204만 지우며, 401·5xx·끊김은 남긴다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WISH_QUEUE_KEY, flushWishQueue, parseWishQueue, queueWish, serializeWishQueue } from './queue.ts';

const T = 1_761_000_000_000;

test('FE-T37 오프라인에서 찜 셋을 하고 하나를 풀면 온라인이 된 뒤 서버 저장이 화면과 같고 같은 공연 중복 저장이 0건이다', async () => {
  assert.equal(WISH_QUEUE_KEY, 'peaket.wishQueue');
  let stored = [];
  const write = (items) => {
    stored = [...items];
  };

  let queue = queueWish(stored, '공연-A', 'PUT', T);
  queue = queueWish(queue, '공연-B', 'PUT', T + 1);
  queue = queueWish(queue, '공연-C', 'PUT', T + 2);
  queue = queueWish(queue, '공연-B', 'DELETE', T + 3);
  write(queue);

  // 저장된 값은 JSON 한 줄이고 다시 읽어도 같다
  stored = parseWishQueue(serializeWishQueue(stored));
  assert.deepEqual(stored.map((x) => [x.productionId, x.action]), [
    ['공연-A', 'PUT'],
    ['공연-C', 'PUT'],
    ['공연-B', 'DELETE'],
  ]);

  const sent = [];
  const r = await flushWishQueue({
    read: () => stored,
    write,
    send: async (item) => {
      sent.push(item);
      return 204;
    },
  });
  assert.deepEqual(r, { sent: 3, remaining: 0, needsLogin: false });
  // 공연-B는 마지막 동작(DELETE)만 한 번, 공연-A·C는 PUT 한 번씩. 같은 공연 저장 0건 중복
  assert.deepEqual(sent.map((x) => [x.productionId, x.action]), [
    ['공연-A', 'PUT'],
    ['공연-C', 'PUT'],
    ['공연-B', 'DELETE'],
  ]);
  assert.equal(new Set(sent.map((x) => x.productionId)).size, sent.length);
  assert.deepEqual(stored, []);
});

test('FE-T37 같은 공연을 다시 찜하면 마지막 PUT 하나만 남고 앞의 DELETE는 사라진다', () => {
  let q = queueWish([], '공연-A', 'DELETE', T);
  q = queueWish(q, '공연-A', 'PUT', T + 1);
  q = queueWish(q, '공연-A', 'PUT', T + 2);
  assert.equal(q.length, 1);
  assert.deepEqual(q[0], { productionId: '공연-A', action: 'PUT', at: T + 2 });
  assert.deepEqual(parseWishQueue(serializeWishQueue(q)), q);
});

test('FE-T37 깨진 저장값은 버리고 쓸 수 있는 줄만 읽는다', () => {
  assert.deepEqual(parseWishQueue(null), []);
  assert.deepEqual(parseWishQueue('{'), []);
  assert.deepEqual(parseWishQueue('{"a":1}'), []);
  assert.deepEqual(
    parseWishQueue(JSON.stringify([{ productionId: 'A', action: 'PUT', at: 1 }, { productionId: '', action: 'PUT', at: 2 }, { productionId: 'B', action: 'NOPE', at: 3 }, { productionId: 'C', action: 'DELETE' }])),
    [{ productionId: 'A', action: 'PUT', at: 1 }],
  );
});

test('FE-T37 401이면 큐를 지우지 않고 멈춰 다시 로그인한 뒤 이어 보낸다', async () => {
  let stored = queueWish([], '공연-A', 'PUT', T);
  const r = await flushWishQueue({ read: () => stored, write: (x) => (stored = [...x]), send: async () => 401 });
  assert.deepEqual(r, { sent: 0, remaining: 1, needsLogin: true });
  assert.deepEqual(stored.map((x) => x.productionId), ['공연-A']);
});

test('FE-T37 5xx·끊김이면 그 동작부터 남겨 두고 다음 기회에 다시 보낸다', async () => {
  let stored = queueWish(queueWish([], '공연-A', 'PUT', T), '공연-B', 'PUT', T + 1);
  const r = await flushWishQueue({ read: () => stored, write: (x) => (stored = [...x]), send: async () => 503 });
  assert.deepEqual(r, { sent: 0, remaining: 2, needsLogin: false, failedStatus: 503 });
  assert.equal(stored.length, 2);

  let n = 0;
  const retry = await flushWishQueue({
    read: () => stored,
    write: (x) => (stored = [...x]),
    send: async () => {
      n += 1;
      return n === 1 ? 204 : 204;
    },
  });
  assert.deepEqual(retry, { sent: 2, remaining: 0, needsLogin: false });
  assert.deepEqual(stored, []);

  let left = queueWish([], '공연-C', 'DELETE', T);
  const cut = await flushWishQueue({
    read: () => left,
    write: (x) => (left = [...x]),
    send: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.deepEqual(cut, { sent: 0, remaining: 1, needsLogin: false });
  assert.equal(left.length, 1);
});

test('FE-T37 401이 아닌 4xx는 다시 보내도 같으므로 그 동작만 버리고 나머지를 이어 보낸다', async () => {
  let stored = queueWish(queueWish([], '공연-A', 'PUT', T), '공연-B', 'DELETE', T + 1);
  const calls = [];
  const r = await flushWishQueue({
    read: () => stored,
    write: (x) => (stored = [...x]),
    send: async (item) => {
      calls.push(item.productionId);
      return item.productionId === '공연-A' ? 422 : 204;
    },
  });
  assert.deepEqual(r, { sent: 2, remaining: 0, needsLogin: false });
  assert.deepEqual(calls, ['공연-A', '공연-B']);
  assert.deepEqual(stored, []);
});
