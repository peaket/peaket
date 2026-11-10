// 낮춘 결제사 채널 상한의 유지·전파·회복(domain/pg-channel-limit.ts, domain/pg-call-guard.ts의 표 값 걸기, BUILD_ORDER PRF-203).
// 정본: docs/features/payment.md §2 '낮춘 상한의 유지·전파·회복'·P-T34, docs/data.md §5 '두 파드가 같은 결제사 채널의 상한을 같은 때 낮춤'.
// 실제 PostgreSQL에서 두 파드가 표로 맞추는 것은 test-int/payment-channel-limit.int.test.ts가 본다. 여기서는 보호기 하나의 규칙을 공개 함수로 본다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import type { PgName } from '../src/modules/payment/domain/payment-gateway.js';
import { PgCallGuard, type PgCallGuardOptions, type PgLimitKind } from '../src/modules/payment/domain/pg-call-guard.js';
import {
  halvedRatio,
  loweringCovered,
  PG_LIMIT_FLOOR_PERCENT,
  PG_LIMIT_HOLD_MS,
  PG_LIMIT_SYNC_MS,
  PG_LOWER_COOLDOWN_MS,
  type PgChannelLimitRow,
  type PgLimitLowering,
} from '../src/modules/payment/domain/pg-channel-limit.js';

const NOW = Date.parse('2026-11-10T01:00:00.000Z');

function make(over: Partial<PgCallGuardOptions> = {}) {
  const clock = fakeClock({ now: NOW });
  const limits: [PgName, PgLimitKind, number][] = [];
  const ratios: [PgName, number][] = [];
  const throttledFirst: { pg: PgName; rps: number; concurrency: number }[] = [];
  const restored: { pg: PgName; rps: number; concurrency: number }[] = [];
  const lowered: PgLimitLowering[] = [];
  const g = new PgCallGuard({
    pg: 'TOSS',
    callsPerSecond: 300,
    channelBulkhead: 600,
    podCount: 1,
    clock,
    signals: { throttled: () => undefined, limit: (pg, kind, v) => limits.push([pg, kind, v]), inflight: () => undefined, saturated: () => undefined, ratio: (pg, v) => ratios.push([pg, v]) },
    log: { throttledFirst: (e) => throttledFirst.push(e), limitRestored: (e) => restored.push(e) },
    onLowered: (e) => lowered.push(e),
    ...over,
  });
  return { clock, g, limits, ratios, throttledFirst, restored, lowered };
}

const row = (o: Partial<PgChannelLimitRow> = {}): PgChannelLimitRow => ({ pg: 'TOSS', ratioPercent: 50, loweredAtMs: NOW, expiresAtMs: NOW + PG_LIMIT_HOLD_MS, version: 1, ...o });

describe('정해 둔 값', () => {
  test('P-T34 유지 70분 [추측], 표 읽기 1초 [가정], 쿨다운 5초 [가정], 하한 25% [가정]', () => {
    expect(PG_LIMIT_HOLD_MS).toBe(70 * 60_000);
    expect(PG_LIMIT_SYNC_MS).toBe(1_000);
    expect(PG_LOWER_COOLDOWN_MS).toBe(5_000);
    expect(PG_LIMIT_FLOOR_PERCENT).toBe(25);
  });

  test('P-T34 새 비율은 유효 비율의 절반 내림이고 25 아래로 가지 않는다', () => {
    expect([100, 99, 50, 49, 26, 25].map(halvedRatio)).toEqual([50, 49, 25, 25, 25, 25]);
  });
});

describe('표 값 걸기', () => {
  test('P-T34 표에서 읽은 비율을 처음 상한에 곱해 걸고 상한·비율 지표를 낸다 [ASVS v5.0.0-13.2.6]', () => {
    const { g, limits, ratios } = make();
    expect(g.ratioPercent()).toBe(100);
    g.applyShared(row());
    expect(g.limits()).toEqual({ rps: 150, concurrency: 300 });
    expect(g.ratioPercent()).toBe(50);
    expect(limits.slice(-2)).toEqual([
      ['TOSS', 'rps', 150],
      ['TOSS', 'concurrency', 300],
    ]);
    expect(ratios.at(-1)).toEqual(['TOSS', 50]);
  });

  test('P-T34 파드 안에서 낮춘 값과 표 값 가운데 낮은 쪽을 쓴다', () => {
    const { g, clock } = make();
    g.applyShared(row({ ratioPercent: 50 }));
    clock.advance(PG_LOWER_COOLDOWN_MS);
    expect(g.noteThrottled({ first: true })).toBe(true);
    expect(g.ratioPercent()).toBe(25);
    // 표가 더 높은 값(옛 판이 아닌 새 판)으로 와도 파드 안 값이 낮으면 그 값이다
    g.applyShared(row({ ratioPercent: 50, version: 2 }));
    expect(g.limits()).toEqual({ rps: 75, concurrency: 150 });
  });

  test('P-T34 판 번호가 지금보다 작은 행은 걸지 않는다(늦게 끝난 읽기가 옛 판을 가져와도 상한이 돌아가지 않는다)', () => {
    const { g } = make();
    g.applyShared(row({ ratioPercent: 25, version: 2 }));
    g.applyShared(row({ ratioPercent: 50, version: 1 }));
    expect(g.ratioPercent()).toBe(25);
    expect(g.sharedRow()).toMatchObject({ version: 2, ratioPercent: 25 });
  });

  test('P-T34 다른 결제사의 행은 걸지 않는다', () => {
    const { g } = make();
    g.applyShared(row({ pg: 'PORTONE' }));
    expect(g.ratioPercent()).toBe(100);
    expect(g.sharedRow()).toBeUndefined();
  });
});

describe('만료와 회복', () => {
  test('P-T34 표 값은 만료 1ms 전까지 낮춘 값이고 만료 시각에 처음 상한으로 돌아가며 회복 로그는 한 줄이다', () => {
    const { g, clock, restored, ratios } = make();
    g.applyShared(row());
    clock.advance(PG_LIMIT_HOLD_MS - 1);
    expect(g.limits()).toEqual({ rps: 150, concurrency: 300 });
    expect(restored).toEqual([]);
    clock.advance(1);
    expect(g.limits()).toEqual({ rps: 300, concurrency: 600 });
    expect(g.ratioPercent()).toBe(100);
    expect(restored).toEqual([{ pg: 'TOSS', rps: 300, concurrency: 600 }]);
    expect(ratios.at(-1)).toEqual(['TOSS', 100]);
    g.limits();
    g.available();
    expect(restored).toHaveLength(1);
  });

  test('P-T34 파드 안에서 낮춘 값도 낮춘 뒤 70분에 같은 경계로 돌아간다', () => {
    const { g, clock, restored } = make();
    expect(g.noteThrottled({ first: true })).toBe(true);
    clock.advance(PG_LIMIT_HOLD_MS - 1);
    expect(g.limits()).toEqual({ rps: 150, concurrency: 300 });
    clock.advance(1);
    expect(g.limits()).toEqual({ rps: 300, concurrency: 600 });
    expect(restored).toEqual([{ pg: 'TOSS', rps: 300, concurrency: 600 }]);
  });

  test('P-T34 다시 낮추면 만료를 다시 센다', () => {
    const { g, clock } = make();
    g.noteThrottled({ first: true });
    clock.advance(60_000);
    expect(g.noteThrottled({ first: true })).toBe(true);
    clock.advance(PG_LIMIT_HOLD_MS - 1);
    expect(g.ratioPercent()).toBe(25);
    clock.advance(1);
    expect(g.ratioPercent()).toBe(100);
  });

  test('P-T34 돌아간 뒤의 첫 429는 처음 상한에서 다시 절반으로 낮춘다', () => {
    const { g, clock } = make();
    g.applyShared(row({ ratioPercent: 25 }));
    clock.advance(PG_LIMIT_HOLD_MS);
    expect(g.noteThrottled({ first: true })).toBe(true);
    expect(g.limits()).toEqual({ rps: 150, concurrency: 300 });
  });
});

describe('낮추기와 표에 알리기', () => {
  test('P-T34 첫 429로 낮추면 표에 쓸 값(비율·낮춘 시각·만료·호출 시작 시각·알던 행)을 정확히 알린다', () => {
    const { g, clock, lowered, throttledFirst } = make();
    const startedAtMs = clock.monotonicMs();
    clock.advance(800);
    expect(g.noteThrottled({ first: true, startedAtMs })).toBe(true);
    expect(lowered).toEqual([{ pg: 'TOSS', ratioPercent: 50, loweredAtMs: NOW + 800, expiresAtMs: NOW + 800 + PG_LIMIT_HOLD_MS, callStartedAtMs: NOW }]);
    expect(throttledFirst).toEqual([{ pg: 'TOSS', rps: 150, concurrency: 300 }]);
  });

  test('P-T34 표에서 읽은 행을 알던 판으로 함께 알린다', () => {
    const { g, clock, lowered } = make();
    const known = row({ ratioPercent: 50, version: 3 });
    g.applyShared(known);
    clock.advance(PG_LOWER_COOLDOWN_MS);
    g.noteThrottled({ first: true });
    expect(lowered).toEqual([{ pg: 'TOSS', ratioPercent: 25, loweredAtMs: NOW + PG_LOWER_COOLDOWN_MS, expiresAtMs: NOW + PG_LOWER_COOLDOWN_MS + PG_LIMIT_HOLD_MS, basis: known }]);
  });

  test('P-T34 다른 파드가 낮춘 지 5초 안의 첫 429는 다시 낮추지 않고, 5초가 되면 낮춘다(파드 사이 쿨다운)', () => {
    const { g, clock, lowered, throttledFirst } = make();
    g.applyShared(row());
    clock.advance(PG_LOWER_COOLDOWN_MS - 1);
    expect(g.noteThrottled({ first: true })).toBe(false);
    expect(g.ratioPercent()).toBe(50);
    expect(lowered).toEqual([]);
    expect(throttledFirst).toEqual([]);
    clock.advance(1);
    expect(g.noteThrottled({ first: true })).toBe(true);
    expect(g.ratioPercent()).toBe(25);
  });

  test('P-T34 다른 파드가 낮추기 전에 나간 호출의 429는 쿨다운 뒤에 와도 낮추지 않고, 낮춘 시각에 나간 호출부터 낮춘다', () => {
    const { g, clock, lowered } = make();
    const before = clock.monotonicMs();
    clock.advance(1);
    g.applyShared(row({ loweredAtMs: NOW + 1, expiresAtMs: NOW + 1 + PG_LIMIT_HOLD_MS }));
    const at = clock.monotonicMs();
    clock.advance(PG_LOWER_COOLDOWN_MS + 1_000);
    expect(g.noteThrottled({ first: true, startedAtMs: before })).toBe(false);
    expect(lowered).toEqual([]);
    expect(g.noteThrottled({ first: true, startedAtMs: at })).toBe(true);
    expect(g.ratioPercent()).toBe(25);
  });

  test('P-T34 이미 하한이면 표 값이어도 바꾸지 않고 알리지 않으며 만료를 늘리지 않는다', () => {
    const { g, clock, lowered, throttledFirst } = make();
    g.applyShared(row({ ratioPercent: 25 }));
    clock.advance(PG_LOWER_COOLDOWN_MS);
    expect(g.noteThrottled({ first: true })).toBe(false);
    expect(lowered).toEqual([]);
    expect(throttledFirst).toEqual([]);
    clock.advance(PG_LIMIT_HOLD_MS - PG_LOWER_COOLDOWN_MS);
    expect(g.ratioPercent()).toBe(100);
  });

  test('P-T40 ④ 다시 보낸 호출의 429는 표 값을 건 보호기에서도 낮추지 않고 표에 알리지 않는다', () => {
    const { g, clock, lowered } = make();
    g.applyShared(row());
    clock.advance(PG_LOWER_COOLDOWN_MS);
    expect(g.noteThrottled({ first: false })).toBe(false);
    expect(g.ratioPercent()).toBe(50);
    expect(lowered).toEqual([]);
  });

  test('P-T34 파드 수로 나눈 작은 상한은 비율을 곱해도 하한(처음의 25%, 벌크헤드 최소 1) 아래로 가지 않는다', () => {
    const { g } = make({ callsPerSecond: 50, channelBulkhead: 100, podCount: 12 });
    // 파드당 초당 50/12, 벌크헤드 ceil(100/12) = 9
    g.applyShared(row({ ratioPercent: 25 }));
    expect(g.limits()).toEqual({ rps: 50 / 12 / 4, concurrency: 3 });
    const tiny = make({ callsPerSecond: 2, channelBulkhead: 1, podCount: 8 });
    tiny.g.applyShared(row({ ratioPercent: 25 }));
    expect(tiny.g.limits()).toEqual({ rps: 0.25, concurrency: 1 });
  });
});

describe('표 행이 이미 담은 낮춤(쓰기 겨룸에서 진 쪽)', () => {
  const lowering = (o: Partial<PgLimitLowering> = {}): PgLimitLowering => ({ pg: 'TOSS', ratioPercent: 50, loweredAtMs: NOW + 10_000, expiresAtMs: NOW + 10_000 + PG_LIMIT_HOLD_MS, ...o });

  test('P-T34 행이 없거나 만료됐으면 쓴다', () => {
    expect(loweringCovered(undefined, lowering())).toBe(false);
    expect(loweringCovered(row({ expiresAtMs: NOW + 10_000 }), lowering())).toBe(false);
    expect(loweringCovered(row({ ratioPercent: 25, expiresAtMs: NOW + 10_001 }), lowering())).toBe(true);
  });

  test('P-T34 살아 있는 행의 비율이 이번 값 이하이면 쓰지 않는다', () => {
    expect(loweringCovered(row({ ratioPercent: 50 }), lowering({ ratioPercent: 50 }))).toBe(true);
    expect(loweringCovered(row({ ratioPercent: 50, loweredAtMs: NOW - 60_000 }), lowering({ ratioPercent: 25 }))).toBe(false);
  });

  test('P-T34 이번 낮춤 앞 5초 안에 낮춘 행이면 쓰지 않고 5초 앞이면 쓴다', () => {
    expect(loweringCovered(row({ loweredAtMs: NOW + 10_000 - 4_999 }), lowering({ ratioPercent: 25 }))).toBe(true);
    expect(loweringCovered(row({ loweredAtMs: NOW + 10_000 - 5_000 }), lowering({ ratioPercent: 25 }))).toBe(false);
  });

  test('P-T34 429를 받은 호출이 행을 낮춘 뒤에 시작됐으면 쓰고, 앞에 시작됐으면 쓰지 않는다', () => {
    const r = row({ loweredAtMs: NOW });
    expect(loweringCovered(r, lowering({ ratioPercent: 25, callStartedAtMs: NOW - 1 }))).toBe(true);
    expect(loweringCovered(r, lowering({ ratioPercent: 25, callStartedAtMs: NOW }))).toBe(false);
  });
});
