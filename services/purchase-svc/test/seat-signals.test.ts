// 좌석 Lua 오류 갈래(seatLuaErrorOf)와 지표 seat_lua_errors_total{script,code}(PromSeatSignals), docs/observability.md §5 '좌석 Lua 오류 신호',
// seat-hold.md §3 '쓰기 전 지킴'·§9, BUILD_ORDER PRF-135 'PRF-130 리뷰 낮음 4'. 로그·지표에는 키 종류만 남긴다([ASVS v5.0.0-16.2.5]).
// 홀드 미룸 지표 seat_hold_deferred_total{reason}(BUILD_ORDER PRF-143, seat-hold.md §6 '다시 만들기(RB-06)의 첫 구현' 미룸 지표, observability 행)도 여기서 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { fakeClock, PlatformMetrics } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  type HoldInput,
  type HoldResult,
  HoldSeats,
  KEEP_AFTER_SALE_END_MS,
  MemoryPurchaseSessions,
  MemorySeatMap,
  MemorySeatStore,
  PromSeatSignals,
  RecordingHoldAttempts,
  type SeatKeyKind,
  type SeatLuaErrorCode,
  type SeatLuaScript,
  type SeatSignals,
  type SeatStore,
  SeatStoreUnavailable,
  seatKeys,
  seatLuaErrorOf,
} from '../src/modules/inventory/index.js';
import { ACCOUNT_A, DAY, newEvent, replayOf, type ReplayInput, type ReplayPort, type ReplayResult, SEAT_COUNT, SEAT_DEFS } from './hold-cases.js';

const ACC = '0190f3a1-7c2e-7a00-8000-0000000000a1';

/** 노출 글에서 seat_lua_errors_total 표본을 '{이름표 이름들} {script}/{code} {값}'으로(이름표 차례와 관계없이) */
function samples(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('seat_lua_errors_total{'))
    .map((l) => {
      const labels = Object.fromEntries([...l.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
      return `${Object.keys(labels).sort().join(',')} ${labels.script}/${labels.code} ${l.slice(l.lastIndexOf(' ') + 1)}`;
    })
    .sort();
}
const E = 'ev-1';

describe('seatLuaErrorOf(저장소 오류 → 지표·로그 갈래)', () => {
  test('NFR015_ 메모리 부족 SeatStoreUnavailable은 OOM이고, 일시 장애는 Lua 오류로 세지 않는다(undefined) [ASVS v5.0.0-16.3.4]', () => {
    expect(seatLuaErrorOf(new SeatStoreUnavailable(new Error('OOM command not allowed'), 'oom'))).toEqual({ code: 'OOM' });
    expect(seatLuaErrorOf(new SeatStoreUnavailable(new Error('down')))).toBeUndefined();
    expect(seatLuaErrorOf(new SeatStoreUnavailable(new Error('down'), 'unavailable'))).toBeUndefined();
  });

  test('ST4_ PEAKET_CORRUPT_KEY는 CORRUPT_KEY와 그 뒤 첫 키 이름의 종류이고, 계정 ID·회차 ID·오류 글은 결과에 없다 [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-16.5.3]', () => {
    const cases: [string, SeatKeyKind][] = [
      [seatKeys.quota(E, ACC), 'quota'],
      [seatKeys.hold(E, 12), 'hold'],
      [seatKeys.bitmap(E), 'bitmap'],
      [seatKeys.expiry(E), 'expiry'],
      [seatKeys.stream(E), 'stream'],
      [seatKeys.secver(E), 'secver'],
      [seatKeys.fence(E), 'fence'],
      [seatKeys.epoch(E), 'epoch'],
      [seatKeys.ctl(E), 'ctl'],
      [seatKeys.rel(E, ACC), 'rel'],
      [seatKeys.idem(E, ACC, '9a1f0c3e-4b2d-4c8e-9f00-000000000001'), 'idem'],
      [seatKeys.sweep(E), 'sweep'],
      [seatKeys.ctlEvents(), 'ctl:events'],
      [`s:{event:${E}}:zzz`, 'unknown'],
      ['s:nothing', 'unknown'],
      ['', 'unknown'],
    ];
    for (const [key, keyKind] of cases) {
      for (const msg of [`ERR PEAKET_CORRUPT_KEY ${key}`, `PEAKET_CORRUPT_KEY ${key}`, `ERR Error running script: @user_script:9: PEAKET_CORRUPT_KEY ${key}`]) {
        const r = seatLuaErrorOf(new Error(msg));
        expect({ msg, r }).toEqual({ msg, r: { code: 'CORRUPT_KEY', keyKind } });
        expect(JSON.stringify(r)).not.toContain(ACC);
        expect(JSON.stringify(r)).not.toContain(E);
      }
    }
  });

  test('ST4_ PEAKET_KEEP_UNTIL_PAST·PEAKET_FENCE_OVERFLOW는 그 code이고 키 종류가 없다. 그 밖의 Error와 Error가 아닌 값은 OTHER이며 던지지 않는다 [ASVS v5.0.0-16.5.3]', () => {
    expect(seatLuaErrorOf(new Error('ERR PEAKET_KEEP_UNTIL_PAST keepUntil 1 now 2'))).toStrictEqual({ code: 'KEEP_UNTIL_PAST' });
    expect(seatLuaErrorOf(new Error('PEAKET_FENCE_OVERFLOW 9007199254740992'))).toStrictEqual({ code: 'FENCE_OVERFLOW' });
    for (const x of [new Error('ERR Error running script'), new Error('WRONGTYPE Operation against a key'), new RangeError('x'), 'PEAKET_CORRUPT_KEY s:{event:e}:quota:a', null, undefined, 42, {}]) {
      expect({ x: String(x), r: seatLuaErrorOf(x) }).toEqual({ x: String(x), r: { code: 'OTHER' } });
    }
  });

  test('ST26_리뷰 고침 중간 2_ PEAKET_NODE_ID(Lua가 노드 표지를 구하지 못함: CLUSTER MYID·CLUSTER INFO가 권한 등으로 막힘)는 NODE_ID이고 키 종류가 없다. 오류 글(사용자 이름 등)은 결과에 없다 [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-16.2.5] [S-T26]', () => {
    for (const msg of [
      "ERR user_script:12: PEAKET_NODE_ID ERR ACL failure in script: User nocluster has no permissions to run the 'cluster|myid' command script: 3f2a…, on @user_script:12.",
      'PEAKET_NODE_ID NOPERM',
    ]) {
      const r = seatLuaErrorOf(new Error(msg));
      expect({ msg, r }).toStrictEqual({ msg, r: { code: 'NODE_ID' } });
      expect(JSON.stringify(r)).not.toContain('nocluster');
    }
  });
});

describe('PromSeatSignals(seat_lua_errors_total)', () => {
  test('NFR015_ register는 서비스 레지스트리에 붙이고 자신을 돌려주며, luaError는 {script, code} 이름표만으로 1씩 올린다(회차·계정·키 이름표 없음) [ASVS v5.0.0-16.2.5]', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const s = new PromSeatSignals();
    expect(s.register(metrics.registry)).toBe(s);
    s.luaError('expire', 'OOM');
    s.luaError('expire', 'OOM');
    s.luaError('hold', 'CORRUPT_KEY');
    s.luaError('expire', 'NOT_READY');
    s.luaError('hold', 'NODE_ID');
    const text = await metrics.registry.metrics();
    expect(samples(text)).toEqual(['code,script expire/NOT_READY 1', 'code,script expire/OOM 2', 'code,script hold/CORRUPT_KEY 1', 'code,script hold/NODE_ID 1']);
    expect(text).toContain('# TYPE seat_lua_errors_total counter');
  });

  test('NFR015_ 붙이기 전에도 luaError는 던지지 않고, 두 번 만든 신호가 서로의 레지스트리를 더럽히지 않는다', async () => {
    const a = new PromSeatSignals();
    expect(() => a.luaError('hold', 'OTHER')).not.toThrow();
    const m = new PlatformMetrics('purchase-svc');
    const b = new PromSeatSignals().register(m.registry);
    b.luaError('hold', 'KEEP_UNTIL_PAST');
    expect(samples(await m.registry.metrics())).toEqual(['code,script hold/KEEP_UNTIL_PAST 1']);
  });
});

/** 노출 글에서 seat_hold_deferred_total 표본을 '{이름표 이름들} {reason} {값}'으로 */
function deferredSamples(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('seat_hold_deferred_total{'))
    .map((l) => {
      const labels = Object.fromEntries([...l.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
      return `${Object.keys(labels).sort().join(',')} ${labels.reason} ${l.slice(l.lastIndexOf(' ') + 1)}`;
    })
    .sort();
}

describe('PromSeatSignals(seat_hold_deferred_total, PRF-143)', () => {
  test('ST26_ holdDeferred는 seat_hold_deferred_total{reason}(카운터)을 reason 이름표 하나로 1씩 올린다(회차·계정 이름표 없음). 붙이기 전에도 던지지 않는다 [ASVS v5.0.0-16.2.5]', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    // SeatSignals의 선택 메서드라 형으로는 없을 수 있다. 운영 구현은 꼭 가져야 한다(없으면 여기서 TypeError)
    const s: SeatSignals = new PromSeatSignals().register(metrics.registry);
    expect(typeof s.holdDeferred).toBe('function');
    s.holdDeferred!('not_ready');
    s.holdDeferred!('not_ready');
    s.holdDeferred!('store_unavailable');
    const text = await metrics.registry.metrics();
    expect(deferredSamples(text)).toEqual(['reason not_ready 2', 'reason store_unavailable 1']);
    expect(text).toContain('# TYPE seat_hold_deferred_total counter');
    const loose: SeatSignals = new PromSeatSignals();
    expect(() => loose.holdDeferred!('store_unavailable')).not.toThrow();
  });
});

/** 노출 글에서 이름이 name인 카운터 표본을 '{이름표 이름들} {이름표 값들} {값}'으로(이름표 차례와 관계없이) */
function namedSamples(text: string, name: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith(`${name}{`))
    .map((l) => {
      const labels = Object.fromEntries([...l.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
      const keys = Object.keys(labels).sort();
      return `${keys.join(',')} ${keys.map((k) => labels[k]).join('/')} ${l.slice(l.lastIndexOf(' ') + 1)}`;
    })
    .sort();
}

describe('PromSeatSignals(좌석 Stream 릴레이 지표 seat_stream_relay_*, PRF-164)', () => {
  test('ST5_ register가 릴레이 지표 셋도 붙인다: sent는 seat_stream_relay_sent_total{topic}을 n만큼, dropped는 seat_stream_relay_dropped_total{reason}을, failed는 seat_stream_relay_failures_total{stage}을 1씩 올린다(이름표는 그 하나뿐, 회차 이름표 없음) [ASVS v5.0.0-16.2.5]', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const s = new PromSeatSignals().register(metrics.registry);
    s.sent('trade.seats', 3);
    s.sent('trade.seats', 2);
    s.sent('trade.purchase-sessions', 1);
    s.dropped('unmapped_seat');
    s.dropped('unmapped_seat');
    s.dropped('malformed');
    s.dropped('unknown_type');
    s.failed('read');
    s.failed('publish');
    s.failed('publish');
    s.failed('ack');
    const text = await metrics.registry.metrics();
    expect(namedSamples(text, 'seat_stream_relay_sent_total')).toEqual(['topic trade.purchase-sessions 1', 'topic trade.seats 5']);
    expect(namedSamples(text, 'seat_stream_relay_dropped_total')).toEqual(['reason malformed 1', 'reason unknown_type 1', 'reason unmapped_seat 2']);
    expect(namedSamples(text, 'seat_stream_relay_failures_total')).toEqual(['stage ack 1', 'stage publish 2', 'stage read 1']);
    for (const name of ['seat_stream_relay_sent_total', 'seat_stream_relay_dropped_total', 'seat_stream_relay_failures_total']) {
      expect(text, name).toContain(`# TYPE ${name} counter`);
    }
  });

  test('ST5_ 붙이기 전에도 sent·dropped·failed는 던지지 않고, 두 번 만든 신호가 서로의 레지스트리를 더럽히지 않는다', async () => {
    const loose = new PromSeatSignals();
    expect(() => loose.sent('trade.seats', 1)).not.toThrow();
    expect(() => loose.dropped('malformed')).not.toThrow();
    expect(() => loose.failed('read')).not.toThrow();
    const m = new PlatformMetrics('purchase-svc');
    const b = new PromSeatSignals().register(m.registry);
    b.sent('trade.seats', 4);
    const text = await m.registry.metrics();
    expect(namedSamples(text, 'seat_stream_relay_sent_total')).toEqual(['topic trade.seats 4']);
    expect(namedSamples(text, 'seat_stream_relay_failures_total')).toEqual([]);
  });
});

/** 노출 글에서 이름표 없는 지표 name의 표본 줄(HELP·TYPE 줄 빼고) */
const plainSamples = (text: string, name: string) => text.split('\n').filter((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));

describe('PromSeatSignals(세대 올리기 감시 지표 seat_epoch_bumps_total, PRF-168)', () => {
  test('ST26_ register가 seat_epoch_bumps_total(카운터, 이름표 없음)도 붙이고 epochBumped(n)이 n씩 올린다(회차 이름표 없음, 리뷰 고침 중간 1: 쓰는 Lua가 올린 수의 차이) [S-T26] [ASVS v5.0.0-16.2.5]', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const s = new PromSeatSignals().register(metrics.registry);
    s.epochBumped(1);
    s.epochBumped(1);
    s.epochBumped(3);
    const text = await metrics.registry.metrics();
    expect(text).toContain('# TYPE seat_epoch_bumps_total counter');
    expect(plainSamples(text, 'seat_epoch_bumps_total')).toEqual(['seat_epoch_bumps_total 5']);
  });

  test('ST26_ 붙이기 전에도 epochBumped는 던지지 않고, 두 번 만든 신호가 서로의 레지스트리를 더럽히지 않는다 [S-T26]', async () => {
    const loose = new PromSeatSignals();
    expect(() => loose.epochBumped(1)).not.toThrow();
    const m = new PlatformMetrics('purchase-svc');
    const b = new PromSeatSignals().register(m.registry);
    b.epochBumped(1);
    expect(plainSamples(await m.registry.metrics(), 'seat_epoch_bumps_total')).toEqual(['seat_epoch_bumps_total 1']);
  });
});

// ---- HoldSeats가 503으로 미룰 때(hold-seats.test.ts의 조립을 줄여 옮김) ----

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const KEY = Buffer.alloc(32, 7);

/** 좌석 Lua 지표와 미룸 지표를 적는 신호 */
function recordingSignals(): SeatSignals & { lua: [SeatLuaScript, SeatLuaErrorCode][]; deferred: string[] } {
  const lua: [SeatLuaScript, SeatLuaErrorCode][] = [];
  const deferred: string[] = [];
  return { lua, deferred, luaError: (script, code) => void lua.push([script, code]), holdDeferred: (reason) => void deferred.push(reason) };
}

interface DeferWorld {
  /** 판매 열기를 하지 않는다(세대 키 없음 → 홀드 Lua NOT_READY) */
  noEpoch?: boolean;
  hold?: (i: HoldInput) => Promise<HoldResult>;
  replay?: (i: ReplayInput) => Promise<ReplayResult>;
  /** 구매 세션 읽기가 던진다 */
  sessionsFail?: Error;
  saleEndsAtMs?: number;
}

async function deferWorld(o: DeferWorld = {}) {
  const clock = fakeClock({ now: NOW, monotonic: 50 });
  const inner = new MemorySeatStore(clock);
  const store: SeatStore & ReplayPort = {
    hold: async (i) => (o.hold ? o.hold(i) : inner.hold(i)),
    holdAuto: (i, opt) => inner.holdAuto(i, opt),
    autoCursor: (eventId, field) => inner.autoCursor(eventId, field),
    openSale: (i) => inner.openSale(i),
    replay: async (i) => (o.replay ? o.replay(i) : replayOf(inner)(i)),
  };
  const eventId = newEvent();
  const saleEndsAtMs = o.saleEndsAtMs ?? NOW + DAY;
  const seatMap = new MemorySeatMap();
  seatMap.put({ eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs }, SEAT_DEFS);
  if (!o.noEpoch) await inner.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: saleEndsAtMs + KEEP_AFTER_SALE_END_MS });
  const memorySessions = new MemoryPurchaseSessions();
  memorySessions.open({ sessionId: 'ps-a', accountId: ACCOUNT_A, eventId, journeyId: '0190f3a1-7c2e-7a00-8000-0000000000aa', loginSessionId: 'ls-a', key: KEY });
  const sessions = o.sessionsFail ? { get: async () => Promise.reject(o.sessionsFail) } : memorySessions;
  const signals = recordingSignals();
  const uc = new HoldSeats(store, seatMap, sessions, new RecordingHoldAttempts(), clock, signals);
  const run = (seatIds: string[]) => uc.execute({ eventId, accountId: ACCOUNT_A, purchaseSessionId: 'ps-a', idempotencyKey: randomUUID(), body: { seatIds } });
  return { signals, run };
}

/** 던진 오류의 code(HoldError) */
const codeOf = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e as { code?: string }).code,
  );

describe('HoldSeats.execute: 미룸 지표(seat_hold_deferred_total, PRF-143)', () => {
  test('ST26_③ 세대 키가 없어 홀드 Lua가 NOT_READY면 503이고 holdDeferred(not_ready)를 한 번 부른다(좌석 Lua 지표 {hold, NOT_READY}도 그대로) [S-T26] [ASVS v5.0.0-16.3.4]', async () => {
    const w = await deferWorld({ noEpoch: true });
    expect(await codeOf(w.run(['A01']))).toBe('NOT_READY');
    expect(w.signals.deferred).toEqual(['not_ready']);
    expect(w.signals.lua).toEqual([['hold', 'NOT_READY']]);
  });

  test.each(['unavailable', 'oom'] as const)('NFR015_ 홀드 Lua 호출이 SeatStoreUnavailable(%s)이면 503이고 holdDeferred(store_unavailable)를 한 번 부른다 [ASVS v5.0.0-16.3.4]', async (reason) => {
    const down = new SeatStoreUnavailable(new Error('down'), reason);
    const w = await deferWorld({ hold: async () => Promise.reject(down) });
    expect(await codeOf(w.run(['A01']))).toBe('STORE_UNAVAILABLE');
    expect(w.signals.deferred).toEqual(['store_unavailable']);
  });

  test('NFR015_ 정본의 "503으로 미룰 때마다": 구매 세션 읽기·재생 읽기가 좌석 Redis 일시 장애(SeatStoreUnavailable)라 503이어도 holdDeferred(store_unavailable)를 한 번 부른다 [ASVS v5.0.0-16.3.4]', async () => {
    const s = await deferWorld({ sessionsFail: new SeatStoreUnavailable(new Error('down')) });
    expect(await codeOf(s.run(['A01']))).toBe('STORE_UNAVAILABLE');
    expect(s.signals.deferred).toEqual(['store_unavailable']);
    // 판매 종료라 410으로 거절하기 전의 재생 읽기가 일시 장애
    const r = await deferWorld({ saleEndsAtMs: NOW, replay: async () => Promise.reject(new SeatStoreUnavailable(new Error('down'))) });
    expect(await codeOf(r.run(['A01']))).toBe('STORE_UNAVAILABLE');
    expect(r.signals.deferred).toEqual(['store_unavailable']);
  });

  test('ST26_ 미루지 않은 결과(성공·경합·한도·정지·멱등 키 재사용·판매 종료 410·스크립트 오류)는 holdDeferred를 부르지 않는다', async () => {
    const ok = await deferWorld();
    await ok.run(['A01']);
    expect(ok.signals.deferred).toEqual([]);
    const results: HoldResult[] = [{ kind: 'CONFLICT', seatId: 'A01' }, { kind: 'QUOTA_EXCEEDED' }, { kind: 'PAUSED' }, { kind: 'IDEM_REUSED' }];
    for (const r of results) {
      const w = await deferWorld({ hold: async () => r });
      await w.run(['A01']).catch(() => undefined);
      expect({ kind: r.kind, deferred: w.signals.deferred }).toEqual({ kind: r.kind, deferred: [] });
    }
    const ended = await deferWorld({ saleEndsAtMs: NOW });
    expect(await codeOf(ended.run(['A01']))).toBe('SALE_ENDED');
    expect(ended.signals.deferred).toEqual([]);
    const bug = await deferWorld({ hold: async () => Promise.reject(new Error('ERR Error running script')) });
    await bug.run(['A01']).catch(() => undefined);
    expect(bug.signals.deferred).toEqual([]);
  });
});
