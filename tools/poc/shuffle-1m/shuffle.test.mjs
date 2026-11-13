// BAS-100 셔플 100만 PoC의 값 시험. 실제 100만 실행은 `node tools/poc/shuffle-1m/shuffle.mjs`가 한다.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bucketize, isPermutation, mulberry32, run, shuffle, writeBuckets } from './shuffle.mjs';

test('BAS-100 Fisher–Yates는 같은 씨앗이면 같은 순열이고 0..n-1을 한 번씩 쓴다', () => {
  const a = shuffle(1000, mulberry32(7));
  const b = shuffle(1000, mulberry32(7));
  assert.deepEqual(a, b);
  assert.ok(isPermutation(a));
  assert.ok(!isPermutation([0, 1, 1]));
  assert.ok(!isPermutation([0, 2]));
});

test('BAS-100 결과 파일 묶음은 4,096개이고 해시 앞 세 자리와 파일 번호가 맞는다', () => {
  const order = shuffle(2000, mulberry32(11));
  const buckets = bucketize(order);
  assert.equal(buckets.length, 4096);
  assert.equal(buckets.reduce((n, b) => n + b.length, 0), 2000);
  buckets.forEach((b, i) => {
    for (const [hash] of b) assert.equal(Number.parseInt(hash, 16), i);
  });
});

test('BAS-100 PoC 요약은 순열·파일 수·직렬화 크기를 낸다', () => {
  const r = run({ n: 5000 });
  assert.equal(r.n, 5000);
  assert.equal(r.valid, true);
  assert.equal(r.files, 4096);
  assert.ok(r.bytes > 0);
  assert.ok(r.maxFileBytes >= r.minFileBytes);
  assert.ok(r.totalMs >= 0);
});

test('BAS-100 결과 파일을 실제로 쓰면 4,096개 파일이 된다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peaket-shuffle-'));
  try {
    const n = writeBuckets(shuffle(100, mulberry32(3)), dir);
    assert.equal(n, 4096);
    assert.equal(readdirSync(dir).length, 4096);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
