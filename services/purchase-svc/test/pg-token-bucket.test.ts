// R-T52 ① 일괄 환불의 결제사별 토큰 버킷 함수(F-07-8 계획 I-07, transfer-refund §5 '토큰 버킷의 값', ADR-0069 결정 10).
// 결제사 몫마다 초당 300건·최대 300건 [가정]: 시각 t초까지 누적 300 + ⌊300 × t⌋건을 넘지 않는다(0초 300, 3ms 300, 4ms 301, 1초 600).
// 가짜 시계와 `sleep` 대역(기다린 만큼 시계를 민다)을 넘긴다. 결제사마다 따로라 토스를 다 써도 포트원은 기다리지 않는다.
// 기준 트리: domain/pg-token-bucket.ts가 없어 가져오기부터 실패한다(계획 §7).
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { PgTokenBuckets } from '../src/modules/refund/domain/pg-token-bucket.js';

// 버킷 시계는 0에서 시작한다: 큰 기원 값(2026년 ms) 위에서 소수 ms를 더하면 부동소수 오차로 1ms보다 작은 기다림이 시계를 밀지 못한다

function buckets(o: { rate?: number; burst?: number } = {}) {
  const clock = fakeClock({ now: 0, monotonic: 0 });
  const sleeps: number[] = [];
  // 대역: 부른 순간의 시각 + ms까지 시계를 민다(이미 지났으면 그대로). 실제 시간은 기다리지 않는다
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
    const wake = clock.now() + ms;
    if (wake > clock.now()) clock.advance(wake - clock.now());
  };
  const b = new PgTokenBuckets({ ratePerSecond: o.rate ?? 300, burst: o.burst ?? 300, clock, sleep });
  return { b, clock, sleeps, elapsed: () => clock.now() };
}

describe('R-T52 ① 결제사별 토큰 버킷', () => {
  test('R-T52 ① 처음 300건은 기다리지 않고, 301번째는 1/300초(3.34ms 안팎) 기다린 뒤 나간다', async () => {
    const { b, sleeps, elapsed } = buckets();
    expect(Math.floor(b.available('TOSS'))).toBe(300);
    for (let i = 0; i < 300; i += 1) await b.take('TOSS');
    expect(sleeps).toEqual([]);
    expect(elapsed()).toBe(0);
    expect(Math.floor(b.available('TOSS'))).toBe(0);
    await b.take('TOSS');
    expect(sleeps.length).toBeGreaterThan(0);
    // 너무 이르면(누적 상한을 넘음) 안 되고, 너무 늦어도 안 된다(1초를 기다리는 구현을 잡는다)
    // 시각은 큰 기원 값 위의 소수 ms라 부동소수 오차(약 0.0003ms)만큼 허용한다
    expect(elapsed()).toBeGreaterThanOrEqual(1000 / 300 - 0.001);
    expect(elapsed()).toBeLessThanOrEqual(4);
  });

  // F-04: 3ms·4ms·1초 경계와 최대 300
  test('R-T52 ① 다 쓴 뒤 3ms에는 토큰 0(기다림), 4ms에는 1(바로), 1초에는 300이고 1초 넘게 쉬어도 최대 300을 넘지 않는다', async () => {
    const { b, clock, sleeps } = buckets();
    for (let i = 0; i < 300; i += 1) await b.take('TOSS');
    clock.advance(3);
    expect(Math.floor(b.available('TOSS'))).toBe(0);
    clock.advance(1);
    expect(Math.floor(b.available('TOSS'))).toBe(1);
    await b.take('TOSS');
    expect(sleeps).toEqual([]);
    clock.advance(1_000);
    expect(Math.floor(b.available('TOSS'))).toBe(300);
    clock.advance(60_000);
    expect(Math.floor(b.available('TOSS'))).toBe(300);
    for (let i = 0; i < 300; i += 1) await b.take('TOSS');
    expect(sleeps).toEqual([]);
    expect(Math.floor(b.available('TOSS'))).toBe(0);
  });

  test('R-T52 ① 누적 호출은 어느 시각 t에도 300 + ⌊300 × t⌋를 넘지 않고, 900건은 2초에 끝난다', async () => {
    const { b, clock } = buckets();
    const times: number[] = [];
    for (let i = 0; i < 900; i += 1) {
      await b.take('TOSS');
      times.push(clock.now());
    }
    for (let k = 0; k < times.length; k += 1) {
      const t = times[k]! / 1000;
      expect(k + 1, `${k + 1}번째 호출 t=${times[k]}ms`).toBeLessThanOrEqual(300 + Math.floor(300 * t + 1e-6));
    }
    expect(times.filter((t) => t === 0)).toHaveLength(300);
    expect(times.filter((t) => t <= 1000.01)).toHaveLength(600);
    expect(times.at(-1)!).toBeGreaterThanOrEqual(1999.99);
    expect(times.at(-1)!).toBeLessThanOrEqual(2004);
  });

  test('R-T52 ① 결제사마다 따로: 토스를 다 써도 포트원 300건은 기다리지 않는다', async () => {
    const { b, sleeps } = buckets();
    for (let i = 0; i < 300; i += 1) await b.take('TOSS');
    expect(Math.floor(b.available('TOSS'))).toBe(0);
    expect(Math.floor(b.available('PORTONE'))).toBe(300);
    for (let i = 0; i < 300; i += 1) await b.take('PORTONE');
    expect(sleeps).toEqual([]);
    expect(Math.floor(b.available('PORTONE'))).toBe(0);
  });

  test('R-T52 ① 값은 설정을 따른다: 초당 50·최대 10이면 11번째는 20ms를 기다린다(코드 기본값 300과 다른 시험 값)', async () => {
    const { b, elapsed } = buckets({ rate: 50, burst: 10 });
    for (let i = 0; i < 10; i += 1) await b.take('PORTONE');
    expect(elapsed()).toBe(0);
    await b.take('PORTONE');
    expect(elapsed()).toBeGreaterThanOrEqual(19.999);
    expect(elapsed()).toBeLessThanOrEqual(21);
  });
});
