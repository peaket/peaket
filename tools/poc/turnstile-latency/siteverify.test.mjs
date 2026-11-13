// BAS-100 Turnstile 지연 PoC의 값 시험. 실제 siteverify 호출은 `node tools/poc/turnstile-latency/siteverify.mjs`가 한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measure, measureConcurrent, percentile, verifyOnce } from './siteverify.mjs';

test('BAS-100 백분위는 작은 표본에서도 배열 안 값을 고른다', () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([1], 50), 1);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
});

test('BAS-100 verifyOnce는 성공 응답만 ok로 센다', async () => {
  const ok = await verifyOnce({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }) });
  assert.equal(ok.ok, true);
  const no = await verifyOnce({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) }) });
  assert.equal(no.ok, false);
  const bad = await verifyOnce({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.equal(bad.ok, false);
});

test('BAS-100 measure는 실패를 지연 분포에서 빼고 errors로 센다', async () => {
  let n = 0;
  const r = await measure({
    rounds: 4,
    fetchImpl: async () => {
      n += 1;
      if (n === 2) throw new Error('network');
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    },
  });
  assert.deepEqual([r.rounds, r.ok, r.errors], [4, 3, 1]);
  assert.ok(r.p50Ms >= 0);
});

test('BAS-100 measureConcurrent는 동시에 돌려도 rounds·ok·errors를 같게 센다', async () => {
  let n = 0;
  const r = await measureConcurrent({
    rounds: 12,
    concurrency: 4,
    fetchImpl: async () => {
      n += 1;
      if (n % 5 === 0) throw new Error('network');
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    },
  });
  assert.deepEqual([r.rounds, r.ok + r.errors], [12, 12]);
  assert.ok(r.errors >= 1);
});
