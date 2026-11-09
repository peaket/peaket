// 좌석 Redis 어댑터(RedisSeatStore의 만료·호출 마감·메모리 부족, RedisSweepLeases)를 가짜 연결로 본다(docs/features/seat-hold.md §3·§5·§9,
// adapters/expire-lua.ts의 KEYS·ARGV, docs/data.md §3 s:{event:E}:sweep, BUILD_ORDER PRF-135). 실제 Valkey에서 같은 사례는 test-int에서 돈다.
import { type HotRedis, RedisDeadlineError, type RedisScript } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  EXPIRE_LUA,
  type ExpireInput,
  type ExpireSeat,
  RedisSeatStore,
  RedisSweepLeases,
  REHOLD_WAIT_MS,
  SeatStoreUnavailable,
  SWEEP_LEASE_TTL_MS,
  seatKeys,
} from '../src/modules/inventory/index.js';
import { ACCOUNT_A, ACCOUNT_B, DAY, holdInput, ref } from './hold-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const OOM_TEXT = "OOM command not allowed when used memory > 'maxmemory'.";

interface Call {
  kind: 'command' | 'eval';
  args: string[];
  keys?: string[];
  script?: RedisScript;
  o?: { key?: string; deadlineMs?: number; binary?: boolean };
}

/** 부를 때마다 적고 respond가 돌려준 값으로 답하는(던지면 거부하는) 가짜 연결 */
function fake(respond: (c: Call) => unknown): { redis: HotRedis; calls: Call[] } {
  const calls: Call[] = [];
  const answer = async (c: Call) => {
    calls.push(c);
    return respond(c);
  };
  return {
    calls,
    redis: {
      command: (args, o) => answer({ kind: 'command', args: [...args], ...(o ? { o: { ...o } } : {}) }),
      evalScript: (script, keys, args, o) => answer({ kind: 'eval', script, keys: [...keys], args: [...args], ...(o ? { o: { ...o } } : {}) }),
      sendCommand: (args) => answer({ kind: 'command', args: [...args] }),
      close: async () => {},
    },
  };
}
const failing = (err: unknown) =>
  fake(() => {
    throw err;
  });

/** 잡은 결과 하나를 끝까지 받는다(던지면 그 오류) */
const settle = (p: Promise<unknown>) =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (x: unknown) => ({ ok: false as const, x }),
  );

const E = 'ev-x';
const KEEP = NOW + 2 * DAY;
const HA = { holdId: 'h3', fencingToken: '1700000000000003', owner: ACCOUNT_A };
const HB = { holdId: 'h20', fencingToken: '1700000000000020', owner: ACCOUNT_B };
/** A의 두 좌석(A04·A05), B의 좌석 B01과 판에 없는 색인 35, 고아 36 */
const SEATS: ExpireSeat[] = [
  { index: ref('A04').index, expected: HA, seat: ref('A04') },
  { index: ref('B01').index, expected: HB, seat: ref('B01') },
  { index: 36, expected: null },
  { index: ref('A05').index, expected: HA, seat: ref('A05') },
  { index: 35, expected: { holdId: 'h35', fencingToken: '1700000000000035', owner: ACCOUNT_B } },
];
const EXPIRE_INPUT: ExpireInput = { eventId: E, keepUntilMs: KEEP, seats: SEATS };

describe('RedisSeatStore.expire(만료 Lua 한 번, expire-lua.ts 계약)', () => {
  test('ST6_ 만료 Lua의 KEYS는 bitmap·expiry·stream·epoch·secver, 좌석 차례의 hold, 처음 나온 계정 차례의 quota·rel(5 + n + 2m)이고 ARGV는 30000·구역 채널 앞머리·keepUntil·m·계정·좌석마다 9칸(4 + m + 9n)이다. 고아는 빈 기대값·계정 번호 0, 판에 없는 색인은 좌석 칸이 빈 글이다 [ASVS v5.0.0-15.4.4]', async () => {
    const f = fake(() => ['OK', '1793761200000123', 3, 1, 1, '3', '1700000000000003', '20', '1700000000000020', '4', '1700000000000003']);
    await new RedisSeatStore(f.redis).expire(EXPIRE_INPUT);
    expect(f.calls).toHaveLength(1);
    const c = f.calls[0]!;
    expect(c.kind).toBe('eval');
    expect(c.script!.source).toBe(EXPIRE_LUA);
    expect(c.keys).toEqual([
      seatKeys.bitmap(E),
      seatKeys.expiry(E),
      seatKeys.stream(E),
      seatKeys.epoch(E),
      seatKeys.secver(E),
      ...[3, 20, 36, 4, 35].map((i) => seatKeys.hold(E, i)),
      seatKeys.quota(E, ACCOUNT_A),
      seatKeys.quota(E, ACCOUNT_B),
      seatKeys.rel(E, ACCOUNT_A),
      seatKeys.rel(E, ACCOUNT_B),
    ]);
    expect(c.args).toEqual([
      String(REHOLD_WAIT_MS),
      seatKeys.section(E, ''),
      String(KEEP),
      '2',
      ACCOUNT_A,
      ACCOUNT_B,
      ...['3', 'h3', '1700000000000003', '1', '0', '3', 'A04', 'R', 'SEC-A'],
      ...['20', 'h20', '1700000000000020', '2', '1', '0', 'B01', 'S', 'SEC-B'],
      ...['36', '', '', '0', '', '', '', '', ''],
      ...['4', 'h3', '1700000000000003', '1', '0', '4', 'A05', 'R', 'SEC-A'],
      ...['35', 'h35', '1700000000000035', '2', '', '', '', '', ''],
    ]);
    expect(c.keys!.length).toBe(5 + 5 + 2 * 2);
    expect(c.args.length).toBe(4 + 2 + 9 * 5);
  });

  test('ST6_ 결과 해석: OK는 µs·푼 수·건너뛴 수·고아 수와 좌석 차례의 (색인, 토큰)을 수로 바꾸고, NOT_READY는 그대로다', async () => {
    const ok = fake(() => ['OK', '1793761200000123', 3, '1', 1, '3', '1700000000000003', 20, '1700000000000020', '4', '1700000000000003']);
    const got = await new RedisSeatStore(ok.redis).expire(EXPIRE_INPUT);
    // 망가진 좌석 수(corrupt, 추천 적용 2026-11-04 M2)는 결과에 더해지는 칸이다. 이 답은 5석이 모두 푼·건너뛴·고아라 0이다(칸이 없어도 0으로 본다)
    expect((got as { corrupt?: number }).corrupt ?? 0).toBe(0);
    expect(got).toMatchObject({
      kind: 'OK',
      nowUs: 1_793_761_200_000_123,
      released: 3,
      skipped: 1,
      orphans: 1,
      expired: [
        { index: 3, fencingToken: 1_700_000_000_000_003 },
        { index: 20, fencingToken: 1_700_000_000_000_020 },
        { index: 4, fencingToken: 1_700_000_000_000_003 },
      ],
    });
    const nr = fake(() => ['NOT_READY']);
    expect(await new RedisSeatStore(nr.redis).expire(EXPIRE_INPUT)).toEqual({ kind: 'NOT_READY' });
  });

  test('ST5_ 결과의 토큰이 안전한 정수가 아니거나, 입력에 없는 색인이거나, 모르는 값이면 일시 장애가 아닌 Error다 [ASVS v5.0.0-15.4.2]', async () => {
    // 같은 입력의 맞는 답은 풀린다(아래 거절이 다른 까닭으로 나지 않게)
    expect((await new RedisSeatStore(fake(() => ['OK', '1793761200000123', 1, 3, 1, '3', '1700000000000003']).redis).expire(EXPIRE_INPUT)).kind).toBe('OK');
    const replies: unknown[] = [
      ['OK', '1793761200000123', 1, 3, 1, '3', '9007199254740993'],
      ['OK', '1793761200000123', 1, 3, 1, '3', '1.5'],
      ['OK', '1793761200000123', 1, 3, 1, '99', '1700000000000003'],
      ['OK', 'soon', 1, 3, 1, '3', '1700000000000003'],
      ['WHAT'],
      'OK',
    ];
    for (const reply of replies) {
      const r = await settle(new RedisSeatStore(fake(() => reply).redis).expire(EXPIRE_INPUT));
      expect({ reply, ok: r.ok, isError: !r.ok && r.x instanceof Error, unavailable: !r.ok && r.x instanceof SeatStoreUnavailable }).toEqual({ reply, ok: false, isError: true, unavailable: false });
    }
  });

  test('NFR003_ 만료 입력이 0석·101석·색인 겹침·owner 모양 틀림·회차 ID 모양 틀림이면 RangeError이고 Redis를 부르지 않는다. dueExpiries도 limit·회차 ID가 틀리면 부르지 않는다 [ASVS v5.0.0-15.4.4]', async () => {
    const f = fake(() => ['OK', '1', 0, 0, 0]);
    const store = new RedisSeatStore(f.redis);
    const one = SEATS[0]!;
    const bad: ExpireInput[] = [
      { eventId: E, keepUntilMs: KEEP, seats: [] },
      { eventId: E, keepUntilMs: KEEP, seats: Array.from({ length: 101 }, (_, i) => ({ index: i, expected: null })) },
      { eventId: E, keepUntilMs: KEEP, seats: [one, one] },
      { eventId: E, keepUntilMs: KEEP, seats: [{ ...one, expected: { ...HA, owner: 'a{b}' } }] },
      { eventId: 'e{1}', keepUntilMs: KEEP, seats: [one] },
    ];
    for (const i of bad) await expect(store.expire(i), JSON.stringify(i).slice(0, 80)).rejects.toBeInstanceOf(RangeError);
    for (const limit of [0, 101, 2.5]) await expect(store.dueExpiries({ eventId: E, nowMs: NOW, limit })).rejects.toBeInstanceOf(RangeError);
    await expect(store.dueExpiries({ eventId: 'e:1', nowMs: NOW, limit: 10 })).rejects.toBeInstanceOf(RangeError);
    expect(f.calls).toEqual([]);
  });
});

describe('RedisSeatStore.dueExpiries·saleEvents(1단계 읽기)', () => {
  test('ST6_ dueExpiries는 ZRANGE expiry -inf {지금} BYSCORE LIMIT 0 {limit} WITHSCORES 뒤 좌석마다 HMGET hold holdId fence owner이고 쓰지 않는다', async () => {
    const f = fake((c) => {
      if (c.args[0] === 'ZRANGE') return ['3', '1793761199000', '36', '1793761199500'];
      if (c.args[0] === 'HMGET' && c.args[1] === seatKeys.hold(E, 3)) return ['h3', '1700000000000003', ACCOUNT_A];
      if (c.args[0] === 'HMGET') return [null, null, null];
      throw new Error(`모르는 명령: ${c.args.join(' ')}`);
    });
    expect(await new RedisSeatStore(f.redis).dueExpiries({ eventId: E, nowMs: NOW, limit: 100 })).toEqual([
      { index: 3, expiresAtMs: 1_793_761_199_000, hold: { holdId: 'h3', fencingToken: '1700000000000003', owner: ACCOUNT_A } },
      { index: 36, expiresAtMs: 1_793_761_199_500, hold: null },
    ]);
    const z = f.calls.filter((c) => c.args[0] === 'ZRANGE');
    expect(z).toHaveLength(1);
    const a = z[0]!.args;
    expect(a.slice(0, 4)).toEqual(['ZRANGE', seatKeys.expiry(E), '-inf', String(NOW)]);
    expect(a).toContain('BYSCORE');
    expect(a).toContain('WITHSCORES');
    expect(a.slice(a.indexOf('LIMIT'), a.indexOf('LIMIT') + 3)).toEqual(['LIMIT', '0', '100']);
    expect(f.calls.filter((c) => c.args[0] === 'HMGET').map((c) => c.args)).toEqual([
      ['HMGET', seatKeys.hold(E, 3), 'holdId', 'fence', 'owner'],
      ['HMGET', seatKeys.hold(E, 36), 'holdId', 'fence', 'owner'],
    ]);
    expect(f.calls.every((c) => c.kind === 'command' && ['ZRANGE', 'HMGET'].includes(c.args[0]!))).toBe(true);
  });

  test('NFR025_ saleEvents는 SMEMBERS s:ctl:events 한 번이고 글(바이트 응답 포함)로 돌려준다', async () => {
    const f = fake(() => ['ev-1', Buffer.from('ev-2')]);
    expect((await new RedisSeatStore(f.redis).saleEvents()).sort()).toEqual(['ev-1', 'ev-2']);
    expect(f.calls.map((c) => c.args)).toEqual([['SMEMBERS', seatKeys.ctlEvents()]]);
  });
});

describe('RedisSeatStore.dueExpiries: 홀드 키의 형이 틀리면(WRONGTYPE) 그 좌석만 corrupt이고 나머지는 정상이다(추천 적용 2026-11-04 B1)', () => {
  const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';
  const due = { eventId: E, nowMs: NOW, limit: 100 } as const;
  /** 만료 인덱스에 3·4·36이 있고, 홀드 키 3의 HMGET만 onHold3가 정한다(4는 정상 홀드, 36은 홀드 키 없음) */
  const scripted = (onHold3: () => never) =>
    fake((c) => {
      if (c.args[0] === 'ZRANGE') return ['3', '1793761199000', '4', '1793761199200', '36', '1793761199500'];
      if (c.args[0] === 'HMGET' && c.args[1] === seatKeys.hold(E, 3)) return onHold3();
      if (c.args[0] === 'HMGET' && c.args[1] === seatKeys.hold(E, 4)) return ['h4', '1700000000000004', ACCOUNT_B];
      if (c.args[0] === 'HMGET') return [null, null, null];
      throw new Error(`모르는 명령: ${c.args.join(' ')}`);
    });
  const wrongType = (): never => {
    throw new Error(WRONGTYPE);
  };

  test('ST4_ HMGET이 WRONGTYPE 오류를 내는 홀드 키는 던지지 않고 그 좌석만 { hold: null, corrupt: true }이며, 같은 읽기의 정상 홀드·홀드 키 없는 좌석(고아)은 그대로다(B1) [ASVS v5.0.0-16.5.3]', async () => {
    const f = scripted(wrongType);
    const got = await settle(new RedisSeatStore(f.redis).dueExpiries(due));
    expect(got.ok ? got.v : String((got as { x: unknown }).x)).toEqual([
      { index: 3, expiresAtMs: 1_793_761_199_000, hold: null, corrupt: true },
      { index: 4, expiresAtMs: 1_793_761_199_200, hold: { holdId: 'h4', fencingToken: '1700000000000004', owner: ACCOUNT_B } },
      { index: 36, expiresAtMs: 1_793_761_199_500, hold: null },
    ]);
    // 나머지 좌석의 홀드 키도 모두 읽었다(한 좌석의 오류가 다른 좌석의 읽기를 막지 않는다)
    expect(f.calls.filter((c) => c.args[0] === 'HMGET').map((c) => c.args[1])).toEqual([seatKeys.hold(E, 3), seatKeys.hold(E, 4), seatKeys.hold(E, 36)]);
  });

  test('ST4_ 다른 종류의 오류는 지금처럼 던진다: 스크립트 오류 같은 버그는 그대로, 마감 초과는 SeatStoreUnavailable(unavailable), 메모리 부족은 SeatStoreUnavailable(oom)이다(B1)', async () => {
    const bug = new Error('ERR Error running script');
    await expect(new RedisSeatStore(scripted(() => { throw bug; }).redis).dueExpiries(due)).rejects.toBe(bug);
    const late = await settle(new RedisSeatStore(scripted(() => { throw new RedisDeadlineError(100); }).redis).dueExpiries(due));
    expect({ unavailable: !late.ok && late.x instanceof SeatStoreUnavailable, reason: !late.ok && late.x instanceof SeatStoreUnavailable ? late.x.reason : undefined }).toEqual({ unavailable: true, reason: 'unavailable' });
    const oom = await settle(new RedisSeatStore(scripted(() => { throw new Error(OOM_TEXT); }).redis).dueExpiries(due));
    expect({ unavailable: !oom.ok && oom.x instanceof SeatStoreUnavailable, reason: !oom.ok && oom.x instanceof SeatStoreUnavailable ? oom.x.reason : undefined }).toEqual({ unavailable: true, reason: 'oom' });
  });

  test('ST4_ 만료 인덱스 키 자체의 형이 틀려 ZRANGE가 WRONGTYPE이면 좌석 하나의 망가짐이 아니라 읽기 전체 오류라 그대로 던진다(B1은 홀드 키 HMGET만 격리한다)', async () => {
    const f = fake((c) => {
      if (c.args[0] === 'ZRANGE') throw new Error(WRONGTYPE);
      throw new Error(`모르는 명령: ${c.args.join(' ')}`);
    });
    await expect(new RedisSeatStore(f.redis).dueExpiries(due)).rejects.toThrow(WRONGTYPE);
    expect(f.calls.map((c) => c.args[0])).toEqual(['ZRANGE']);
  });

  test('ST4_ 만료 인덱스 멤버가 앞 0이 붙은 글(\'007\'·\'00\'·\'01\')이면 색인 7·0·1처럼 받지 않고 PEAKET_CORRUPT_KEY(expiry 키)로 던지며 홀드 키는 읽지 않는다. 만료 Lua는 String(색인)으로 조회해 \'007\'을 지우지 못하고, 정상 \'7\'과 겹쳐 색인 겹침 RangeError가 되기 때문이다(최종 검토 낮음 1) [ASVS v5.0.0-16.5.3]', async () => {
    for (const member of ['007', '00', '01']) {
      const f = fake((c) => {
        if (c.args[0] === 'ZRANGE') return [member, '1793761199000', String(Number(member)), '1793761199500'];
        throw new Error(`모르는 명령: ${c.args.join(' ')}`);
      });
      const got = await settle(new RedisSeatStore(f.redis).dueExpiries(due));
      const err = got.ok ? undefined : got.x;
      expect({ member, isError: err instanceof Error, isRange: err instanceof RangeError, text: err instanceof Error ? err.message : String(got.ok ? got.v : '') }).toEqual({
        member,
        isError: true,
        isRange: false,
        text: `PEAKET_CORRUPT_KEY ${seatKeys.expiry(E)}`,
      });
      expect({ member, calls: f.calls.map((c) => c.args[0]) }).toEqual({ member, calls: ['ZRANGE'] });
    }
  });

  test('ST4_ 색인 0(\'0\')과 앞 0 없는 큰 수는 정상 멤버다: 앞 0 검사가 첫 좌석 색인 0을 망가진 것으로 잘못 보지 않는다', async () => {
    const f = fake((c) => {
      if (c.args[0] === 'ZRANGE') return ['0', '1793761199000', '30', '1793761199500', '49999', '1793761199600'];
      if (c.args[0] === 'HMGET') return [null, null, null];
      throw new Error(`모르는 명령: ${c.args.join(' ')}`);
    });
    expect(await new RedisSeatStore(f.redis).dueExpiries(due)).toEqual([
      { index: 0, expiresAtMs: 1_793_761_199_000, hold: null },
      { index: 30, expiresAtMs: 1_793_761_199_500, hold: null },
      { index: 49_999, expiresAtMs: 1_793_761_199_600, hold: null },
    ]);
  });
});

describe('RedisSeatStore: 메모리 부족과 호출 마감', () => {
  test('NFR015_ 메모리 부족 답(OOM …)은 모든 메서드에서 SeatStoreUnavailable(reason oom, cause 그대로)이고, 일시 장애는 reason unavailable이다 [ASVS v5.0.0-16.3.4]', async () => {
    const calls: [string, (s: RedisSeatStore) => Promise<unknown>][] = [
      ['hold', (s) => s.hold(holdInput(E, ['A01'], { keepUntilMs: KEEP }))],
      ['replay', (s) => s.replay({ eventId: E, accountId: ACCOUNT_A, idempotencyKey: '9a1f0c3e-4b2d-4c8e-9f00-000000000001', fingerprint: 'f'.repeat(64) })],
      ['openSale', (s) => s.openSale({ eventId: E, seatCount: 10, keepUntilMs: KEEP })],
      ['saleEvents', (s) => s.saleEvents()],
      ['dueExpiries', (s) => s.dueExpiries({ eventId: E, nowMs: NOW, limit: 10 })],
      ['expire', (s) => s.expire(EXPIRE_INPUT)],
    ];
    for (const [what, call] of calls) {
      const oom = new Error(OOM_TEXT);
      const r = await settle(call(new RedisSeatStore(failing(oom).redis)));
      const x = r.ok ? undefined : r.x;
      expect({ what, unavailable: x instanceof SeatStoreUnavailable, reason: (x as SeatStoreUnavailable | undefined)?.reason, cause: (x as Error | undefined)?.cause === oom }).toEqual({
        what,
        unavailable: true,
        reason: 'oom',
        cause: true,
      });
      const down = new RedisDeadlineError(100);
      const d = await settle(call(new RedisSeatStore(failing(down).redis)));
      const y = d.ok ? undefined : d.x;
      expect({ what, unavailable: y instanceof SeatStoreUnavailable, reason: (y as SeatStoreUnavailable | undefined)?.reason }).toEqual({ what, unavailable: true, reason: 'unavailable' });
    }
  });

  test('NFR015_ 글 가운데 OOM이 든 스크립트 오류(ERR … OOM …)는 메모리 부족이 아니라 버그로 그대로 던진다', async () => {
    const bug = new Error('ERR Error running script: OOM inside');
    await expect(new RedisSeatStore(failing(bug).redis).hold(holdInput(E, ['A01'], { keepUntilMs: KEEP }))).rejects.toBe(bug);
  });

  test('NFR003_ hold·replay는 SeatCallOptions.deadlineMs를 HotRedis 호출의 deadlineMs로 넘기고, 없으면 넘기지 않는다(플랫폼 기본 100ms)', async () => {
    const f = fake((c) => (c.kind === 'eval' ? ['QUOTA_EXCEEDED'] : [null, null]));
    const store = new RedisSeatStore(f.redis);
    const replayInput = { eventId: E, accountId: ACCOUNT_A, idempotencyKey: '9a1f0c3e-4b2d-4c8e-9f00-000000000001', fingerprint: 'f'.repeat(64) };
    await store.hold(holdInput(E, ['A01'], { keepUntilMs: KEEP }), { deadlineMs: 37 });
    await store.hold(holdInput(E, ['A01'], { keepUntilMs: KEEP }));
    await store.replay(replayInput, { deadlineMs: 12 });
    await store.replay(replayInput);
    expect(f.calls.map((c) => [c.kind, c.o?.deadlineMs])).toEqual([
      ['eval', 37],
      ['eval', undefined],
      ['command', 12],
      ['command', undefined],
    ]);
    // replay의 key 선택값(클러스터 노드 고르기)은 그대로다
    expect(f.calls[2]!.o?.key).toBe(seatKeys.idem(E, ACCOUNT_A, replayInput.idempotencyKey));
  });
});

describe('RedisSweepLeases(만료 임대 s:{event:E}:sweep, 한 번에 끝나는 작은 Lua, 추천 적용 2026-11-04 L2)', () => {
  const key = seatKeys.sweep(E);

  test('NFR025_ 임대 잡기는 그 키 하나만 KEYS로 받는 #!lua 스크립트 한 번이고(ARGV에 파드 ID·수명), 답이 1이면 true·0이면 false다. 일반 명령(SET·GET·PEXPIRE)을 따로 보내지 않는다', async () => {
    for (const [reply, want] of [
      [1, true],
      ['1', true],
      [0, false],
      ['0', false],
    ] as const) {
      const f = fake(() => reply);
      expect({ reply, got: await new RedisSweepLeases(f.redis).acquire(E, 'pod-a', SWEEP_LEASE_TTL_MS) }).toEqual({ reply, got: want });
      expect(f.calls.map((c) => c.kind)).toEqual(['eval']);
      const c = f.calls[0]!;
      expect(c.keys).toEqual([key]);
      expect(c.args).toContain('pod-a');
      expect(c.args).toContain(String(SWEEP_LEASE_TTL_MS));
      expect(c.script!.source.split('\n')[0]).toMatch(/^#!lua(\s|$)/);
    }
  });

  test('NFR025_ 회차 ID·파드 ID 모양이 틀리거나 수명이 1 이상의 안전한 정수가 아니면 RangeError이고 부르지 않는다. 메모리 부족은 SeatStoreUnavailable(oom), 일시 장애는 SeatStoreUnavailable(unavailable), 그 밖은 그대로 던진다 [ASVS v5.0.0-16.3.4]', async () => {
    const f = fake(() => 1);
    const l = new RedisSweepLeases(f.redis);
    for (const [e, owner, ttl] of [
      ['a{b}', 'pod-a', 3000],
      [E, 'pod a', 3000],
      [E, 'pod-a', 0],
      [E, 'pod-a', 1.5],
    ] as const) {
      await expect(l.acquire(e, owner, ttl)).rejects.toBeInstanceOf(RangeError);
    }
    expect(f.calls).toEqual([]);
    const oom = await settle(new RedisSweepLeases(failing(new Error(OOM_TEXT)).redis).acquire(E, 'pod-a', 3000));
    expect(!oom.ok && oom.x instanceof SeatStoreUnavailable && oom.x.reason).toBe('oom');
    const down = await settle(new RedisSweepLeases(failing(new RedisDeadlineError(100)).redis).acquire(E, 'pod-a', 3000));
    expect(!down.ok && down.x instanceof SeatStoreUnavailable && down.x.reason).toBe('unavailable');
    const bug = new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    await expect(new RedisSweepLeases(failing(bug).redis).acquire(E, 'pod-a', 3000)).rejects.toBe(bug);
  });
});
