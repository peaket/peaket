// v0 입구의 IP 기반 레이트 리밋 시험(K6의 v0, docs/infra.md §3 'v0 배포' 5, docs/security/asvs/v0-baseline.md 2.4.1).
// IP마다 토큰 버킷 하나: 초당 ratePerSecond개를 채우고 최대 burst개까지 모은다. 버킷 표는 최근에 쓴 IP maxKeys개까지 둔다(LRU).
import { fakeClock, type Clock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { IpRateLimiter, RATE_LIMIT_DEFAULTS, type RateLimitOptions } from '../src/gateway/rate-limit.js';

function limiter(over: Partial<RateLimitOptions> = {}): { rl: IpRateLimiter; clock: ReturnType<typeof fakeClock> } {
  const clock = fakeClock({ monotonic: 5_000 });
  return { rl: new IpRateLimiter({ ratePerSecond: 10, burst: 20, maxKeys: 100, clock, ...over }), clock };
}

/** n번 쓰고 결과의 allowed만 모은다 */
function takeMany(rl: IpRateLimiter, ip: string, n: number): boolean[] {
  return Array.from({ length: n }, () => rl.take(ip).allowed);
}

describe('IpRateLimiter', () => {
  test('K6_기본값(초당10개·최대20개·IP10만개)으로_만든_리미터는_20개_뒤_거절하고_100ms에_하나_찬다', () => {
    expect(RATE_LIMIT_DEFAULTS).toEqual({ ratePerSecond: 10, burst: 20, maxKeys: 100_000 });
    const clock = fakeClock({ monotonic: 1_000 });
    const rl = new IpRateLimiter({ ...RATE_LIMIT_DEFAULTS, clock });
    expect(takeMany(rl, '203.0.113.99', 21)).toEqual([...Array<boolean>(20).fill(true), false]);
    clock.advance(100);
    expect(takeMany(rl, '203.0.113.99', 2)).toEqual([true, false]);
  });

  test('K6_IP마다_초당10개_최대20개_넘으면_거절과_Retry-After [ASVS v5.0.0-2.4.1]', () => {
    const { rl } = limiter();
    for (let i = 0; i < 20; i++) {
      expect(rl.take('203.0.113.1'), `${i + 1}번째`).toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
    // 21번째: 다음 토큰은 0.1초 뒤라 올림해 1초
    expect(rl.take('203.0.113.1')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(rl.take('203.0.113.1')).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  test('K6_거절한_요청은_토큰을_쓰지_않고_100ms마다_하나씩_찬다 [ASVS v5.0.0-2.4.1]', () => {
    const { rl, clock } = limiter();
    takeMany(rl, '203.0.113.2', 20);
    // 시계가 멈춘 채 거절을 여러 번 받아도 빚이 쌓이지 않는다
    expect(takeMany(rl, '203.0.113.2', 5)).toEqual([false, false, false, false, false]);
    clock.advance(100);
    expect(takeMany(rl, '203.0.113.2', 2)).toEqual([true, false]);
    clock.advance(1_000);
    expect(takeMany(rl, '203.0.113.2', 11)).toEqual([...Array<boolean>(10).fill(true), false]);
  });

  test('K6_새_IP는_시계가_어디에_있든_정확히_burst개로_시작한다 [ASVS v5.0.0-2.4.1]', () => {
    // 단조시계 0: '마지막으로 채운 때'를 0으로 두고 흐른 시간만큼 채우는 구현은 빈 버킷으로 시작한다
    const atZero = new IpRateLimiter({ ratePerSecond: 10, burst: 5, maxKeys: 10, clock: fakeClock({ monotonic: 0 }) });
    expect(takeMany(atZero, '192.0.2.10', 6)).toEqual([true, true, true, true, true, false]);
    // 단조시계가 아주 클 때: 흐른 시간을 burst 위에 더하는 구현은 더 준다
    const late = new IpRateLimiter({ ratePerSecond: 10, burst: 5, maxKeys: 10, clock: fakeClock({ monotonic: 1e9 }) });
    expect(takeMany(late, '192.0.2.11', 6)).toEqual([true, true, true, true, true, false]);
  });

  test('K6_거절한_요청_사이에도_채우던_몫을_잃지_않는다 [ASVS v5.0.0-2.4.1]', () => {
    const { rl, clock } = limiter();
    takeMany(rl, '203.0.113.20', 20);
    // 50ms 뒤 반 개: 거절하면서 '마지막으로 채운 때'만 옮기고 반 개를 버리는 구현은 다음 50ms 뒤에도 거절한다
    clock.advance(50);
    expect(rl.take('203.0.113.20')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    clock.advance(50);
    expect(takeMany(rl, '203.0.113.20', 2)).toEqual([true, false]);
    // 1ms씩 쪼개 거절을 받아도 몫이 쌓인다(채운 몫을 정수로 내려 버리는 구현은 끝까지 거절한다).
    // 끝은 2ms를 더해 101ms로 둔다: 0.01씩 더한 부동소수 합이 1에 조금 못 미치는 구현도 맞게 보려고
    for (let i = 0; i < 99; i++) {
      clock.advance(1);
      expect(rl.take('203.0.113.20').allowed, `${i + 1}ms`).toBe(false);
    }
    clock.advance(2);
    expect(rl.take('203.0.113.20').allowed).toBe(true);
  });

  test('K6_100ms가_안_되면_아직_차지_않는다', () => {
    const { rl, clock } = limiter();
    takeMany(rl, '203.0.113.3', 20);
    clock.advance(99);
    expect(rl.take('203.0.113.3')).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  test('K6_오래_쉬어도_burst개까지만_모은다 [ASVS v5.0.0-2.4.1]', () => {
    const { rl, clock } = limiter();
    takeMany(rl, '203.0.113.4', 20);
    clock.advance(3_600_000);
    expect(takeMany(rl, '203.0.113.4', 21)).toEqual([...Array<boolean>(20).fill(true), false]);
  });

  test('K6_Retry-After는_다음_토큰까지의_초를_올림한다(1_이상)', () => {
    const { rl, clock } = limiter({ ratePerSecond: 0.3, burst: 1 });
    expect(rl.take('198.51.100.1')).toEqual({ allowed: true, retryAfterSeconds: 0 });
    // 1/0.3 = 3.33초 → 4
    expect(rl.take('198.51.100.1')).toEqual({ allowed: false, retryAfterSeconds: 4 });
    clock.advance(2_000); // 남은 1.33초 → 2
    expect(rl.take('198.51.100.1')).toEqual({ allowed: false, retryAfterSeconds: 2 });
    clock.advance(1_000); // 남은 0.33초 → 1
    expect(rl.take('198.51.100.1')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    clock.advance(400);
    expect(rl.take('198.51.100.1')).toEqual({ allowed: true, retryAfterSeconds: 0 });

    const half = limiter({ ratePerSecond: 0.5, burst: 1 }).rl;
    half.take('198.51.100.2');
    // 정확히 2초면 2(더 올리지 않는다)
    expect(half.take('198.51.100.2')).toEqual({ allowed: false, retryAfterSeconds: 2 });
  });

  test('K6_IP마다_따로_센다 [ASVS v5.0.0-2.4.1]', () => {
    const { rl } = limiter();
    takeMany(rl, '203.0.113.5', 20);
    expect(rl.take('203.0.113.5').allowed).toBe(false);
    expect(takeMany(rl, '203.0.113.6', 20)).toEqual(Array<boolean>(20).fill(true));
    expect(rl.take('2001:db8::1').allowed).toBe(true);
    expect(rl.size).toBe(3);
  });

  test('K6_벽시계가_아니라_단조시계로_센다', () => {
    let wall = Date.parse('2026-11-03T09:00:00.000Z');
    let mono = 0;
    const clock: Clock = { now: () => wall, monotonicMs: () => mono };
    const rl = new IpRateLimiter({ ratePerSecond: 10, burst: 2, maxKeys: 10, clock });
    takeMany(rl, '192.0.2.1', 2);
    // 벽시계가 한 시간 앞으로 뛰어도(시각 고침) 단조시계가 그대로면 차지 않는다
    wall += 3_600_000;
    expect(rl.take('192.0.2.1').allowed).toBe(false);
    // 벽시계가 뒤로 가도 단조시계가 100ms 가면 하나 찬다
    wall -= 7_200_000;
    mono += 100;
    expect(takeMany(rl, '192.0.2.1', 2)).toEqual([true, false]);
  });

  test('K6_버킷표가_maxKeys를_넘으면_가장_오래_쓰지_않은_IP부터_지운다', () => {
    const { rl } = limiter({ ratePerSecond: 1, burst: 3, maxKeys: 3 });
    // 셋 모두 토큰 하나씩 남긴다(시계는 멈춰 있다)
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) expect(takeMany(rl, ip, 2)).toEqual([true, true]);
    expect(rl.size).toBe(3);
    // 10.0.0.1을 다시 써서 가장 최근으로 만든다(마지막 토큰)
    expect(rl.take('10.0.0.1').allowed).toBe(true);
    // 새 IP가 들어오면 가장 오래 쓰지 않은 10.0.0.2가 지워진다
    expect(rl.take('10.0.0.4').allowed).toBe(true);
    expect(rl.size).toBe(3);
    // 10.0.0.1은 남아 있어 빈 버킷 그대로다
    expect(rl.take('10.0.0.1').allowed).toBe(false);
    expect(rl.size).toBe(3);
    // 10.0.0.2는 지워졌으므로 가득 찬 버킷(3개)으로 다시 시작한다(남아 있었다면 1개뿐)
    expect(takeMany(rl, '10.0.0.2', 4)).toEqual([true, true, true, false]);
    expect(rl.size).toBe(3);
    // 그때 지워진 것은 그다음으로 오래된 10.0.0.3이다
    expect(takeMany(rl, '10.0.0.3', 4)).toEqual([true, true, true, false]);
    expect(rl.size).toBe(3);
  });

  test('K6_거절한_요청도_그_IP를_최근에_쓴_것으로_친다(막힌_IP가_밀려나_새_버킷을_받지_않게) [ASVS v5.0.0-2.4.1]', () => {
    const { rl } = limiter({ ratePerSecond: 1, burst: 2, maxKeys: 2 });
    // 10.9.0.1이 버킷을 다 쓰고, 10.9.0.2가 그 뒤에 쓴다
    expect(takeMany(rl, '10.9.0.1', 3)).toEqual([true, true, false]);
    expect(rl.take('10.9.0.2').allowed).toBe(true);
    // 10.9.0.1이 계속 보낸다(거절). 이것도 '쓴' 것이라 10.9.0.1이 가장 최근이다
    expect(rl.take('10.9.0.1').allowed).toBe(false);
    // 새 IP가 들어오면 가장 오래 쓰지 않은 10.9.0.2가 지워진다
    expect(rl.take('10.9.0.3').allowed).toBe(true);
    expect(rl.size).toBe(2);
    // 10.9.0.1은 남아 여전히 막힌다(거절을 '쓰지 않음'으로 치면 10.9.0.1이 지워져 가득 찬 버킷을 다시 받는다)
    expect(rl.take('10.9.0.1').allowed).toBe(false);
  });

  test('K6_버킷표는_어떤_경우에도_maxKeys를_넘지_않는다', () => {
    const { rl } = limiter({ maxKeys: 50 });
    for (let i = 0; i < 1_000; i++) {
      rl.take(`10.1.${Math.floor(i / 250)}.${i % 250}`);
      expect(rl.size).toBeLessThanOrEqual(50);
    }
    expect(rl.size).toBe(50);
  });

  test('K6_틀린_설정은_만들_때_던지고_경계값은_받는다', () => {
    const clock = fakeClock();
    const ok = { ratePerSecond: 0.5, burst: 1, maxKeys: 1, clock };
    expect(() => new IpRateLimiter(ok)).not.toThrow();
    const bad: Array<[string, Partial<RateLimitOptions>]> = [
      ['rate 0', { ratePerSecond: 0 }],
      ['rate 음수', { ratePerSecond: -1 }],
      ['rate NaN', { ratePerSecond: Number.NaN }],
      ['burst 0', { burst: 0 }],
      ['burst 소수', { burst: 1.5 }],
      ['burst NaN', { burst: Number.NaN }],
      ['maxKeys 0', { maxKeys: 0 }],
      ['maxKeys 소수', { maxKeys: 2.5 }],
      ['maxKeys 음수', { maxKeys: -1 }],
    ];
    for (const [name, over] of bad) {
      expect(() => new IpRateLimiter({ ...ok, ...over }), name).toThrow();
    }
  });
});
