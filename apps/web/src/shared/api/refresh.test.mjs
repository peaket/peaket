// 팬 요청 401 → 갱신 한 번 → 다시 한 번(docs/frontend.md §4.1 '401', ADR-0199 결정 3, BUILD_ORDER HOT-300)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryOnceAfterRefresh } from './refresh.ts';

const unauthorized = Object.assign(new Error('401'), { status: 401 });
const is401 = (e) => e?.status === 401;

test('401이면 갱신 뒤 한 번 더 보내 성공한다', async () => {
  let calls = 0;
  let refreshed = 0;
  const r = await retryOnceAfterRefresh(
    async () => {
      calls += 1;
      if (calls === 1) throw unauthorized;
      return 'ok';
    },
    is401,
    async () => {
      refreshed += 1;
      return true;
    },
  );
  assert.equal(r, 'ok');
  assert.deepEqual([calls, refreshed], [2, 1]);
});

test('갱신이 안 되면 다시 보내지 않고 401을 던진다(비로그인)', async () => {
  let calls = 0;
  await assert.rejects(
    retryOnceAfterRefresh(
      async () => {
        calls += 1;
        throw unauthorized;
      },
      is401,
      async () => false,
    ),
    (e) => e === unauthorized,
  );
  assert.equal(calls, 1);
});

test('다시 보내도 401이면 그 401을 던지고 더 갱신하지 않는다. 401이 아닌 실패는 갱신하지 않는다', async () => {
  let refreshed = 0;
  await assert.rejects(
    retryOnceAfterRefresh(
      async () => {
        throw unauthorized;
      },
      is401,
      async () => {
        refreshed += 1;
        return true;
      },
    ),
  );
  assert.equal(refreshed, 1);
  const boom = new Error('500');
  await assert.rejects(
    retryOnceAfterRefresh(
      async () => {
        throw boom;
      },
      is401,
      async () => {
        refreshed += 1;
        return true;
      },
    ),
    (e) => e === boom,
  );
  assert.equal(refreshed, 1);
});
