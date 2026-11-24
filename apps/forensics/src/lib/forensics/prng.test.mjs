// F-04-9 시드 재현의 바탕인 xoshiro128** 시험. 정본: docs/features/forensic-replay.md §5.3·§8 FX-T1.
// 32비트 정수 연산만 쓰고, 같은 시드·매개변수·생성기 판이면 같은 열을 낸다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Xoshiro128, hashSeed } from './prng.ts';

test('FX-T1 ① xoshiro128** 상태 [1,2,3,4]의 첫 여덟 수가 알려진 값과 같다', () => {
  const rng = new Xoshiro128([1, 2, 3, 4]);
  const got = Array.from({ length: 8 }, () => rng.nextUint32());
  assert.deepEqual(got, [11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849]);
});

test('FX-T1 ② 같은 시드는 같은 열을, 다른 시드는 다른 열을 낸다', () => {
  const a = new Xoshiro128('peaket-seed');
  const b = new Xoshiro128('peaket-seed');
  const c = new Xoshiro128('peaket-seed-2');
  const seqA = Array.from({ length: 32 }, () => a.nextUint32());
  const seqB = Array.from({ length: 32 }, () => b.nextUint32());
  const seqC = Array.from({ length: 32 }, () => c.nextUint32());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  assert.ok(seqA.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff));
});

test('FX-T1 ③ 시드 해시는 네 낱말이고 같은 문자열이면 같다', () => {
  const a = hashSeed('peaket');
  const b = hashSeed('peaket');
  const c = hashSeed('peaket2');
  assert.equal(a.length, 4);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(a.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff));
});

test('FX-T1 ④ nextInt·nextUnit·nextFloat32가 정한 범위 안에 있다', () => {
  const rng = new Xoshiro128('range');
  assert.equal(rng.nextInt(1), 0);
  for (let i = 0; i < 100; i += 1) {
    const n = rng.nextInt(10);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 10);
    const u = rng.nextUnit();
    assert.ok(u >= 0 && u < 1);
    const f = rng.nextFloat32();
    assert.equal(Math.fround(f), f, 'nextFloat32는 float32로 정확히 표현된다');
  }
});
