// 우선 구매 보류·해제·만료·복귀와 s:rst 판 가드의 **운영 Lua 계약**을 Redis 없이 고정한다(M2-01·02·03·04·10, GAT-135, ADR-0171, docs/data.md §3).
// cheap gate(vitest run)에는 Valkey가 없다. 어댑터가 넘기는 KEYS·ARGV와 답 해석은 가짜 연결로 보고,
// Lua가 지켜야 하는 경계(소유자·비트·만료 경계·grantId·판 번호)는 원문 계약으로 못 박는다. 실제 Valkey 사례는 test-int가 맡는다.
import { type HotRedis, type RedisScript } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { SET_BOOKING_RESTRICTION_LUA } from '../src/modules/booking/adapters/booking-restriction-lua.js';
import { bookingRestrictionKey, RedisBookingRestrictions } from '../src/modules/booking/adapters/redis-booking-restrictions.js';
import { RESTORE_PRIORITY_LUA } from '../src/modules/inventory/adapters/pin-lua.js';
import { PRIORITY_EXPIRE_LUA } from '../src/modules/inventory/adapters/priority-expire-lua.js';
import { PRIORITY_HOLD_LUA, PRIORITY_RELEASE_LUA } from '../src/modules/inventory/adapters/priority-hold-lua.js';
import { RedisSeatStore, seatKeys } from '../src/modules/inventory/adapters/redis-seat-store.js';

const NOW = Date.parse('2026-11-14T08:00:00.000Z');
const DAY = 86_400_000;
const E = 'ev-x';
const ACCOUNT = '01900000-0000-7000-8000-000000000002';
const GRANT = '01900000-0000-7000-8000-0000000000c1';
const KEEP = NOW + 10 * DAY;
const EXP = NOW + DAY;
const SEAT = { seatId: 'A01', index: 3, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 3, tierId: 'R' } as const;

interface Call {
  kind: 'command' | 'eval';
  args: string[];
  keys?: string[];
  script?: RedisScript;
}

/** 부를 때마다 적고 respond의 답을 그대로 돌려주는 가짜 연결 */
function fake(respond: (c: Call) => unknown): { redis: HotRedis; calls: Call[] } {
  const calls: Call[] = [];
  const answer = async (c: Call) => {
    calls.push(c);
    return respond(c);
  };
  return {
    calls,
    redis: {
      command: (args) => answer({ kind: 'command', args: [...args] }),
      evalScript: (script, keys, args) => answer({ kind: 'eval', script, keys: [...keys], args: [...args] }),
      sendCommand: (args) => answer({ kind: 'command', args: [...args] }),
      close: async () => {},
    },
  };
}

const isEval = (c: Call): c is Call & { kind: 'eval'; keys: string[]; script: RedisScript } => c.kind === 'eval';

describe('PRIORITY_HOLD_LUA · RedisSeatStore.holdPriority(GAT-135 S-T37, M2-02)', () => {
  test('보류 한 번의 KEYS·ARGV 차례는 bitmap·prio·stream·epoch·secver·fence·hold:{색인}이고 좌석 6칸을 싣는다', async () => {
    const f = fake(() => ['OK', '1700000000000003', String(NOW), String(EXP)]);
    const r = await new RedisSeatStore(f.redis).holdPriority({ eventId: E, accountId: ACCOUNT, grantId: GRANT, seat: SEAT, expiresAtMs: EXP, keepUntilMs: KEEP });
    expect(r).toEqual({ kind: 'OK', seatId: 'A01', fencingToken: 1_700_000_000_000_003, heldAtMs: NOW, expiresAtMs: EXP });
    expect(f.calls).toHaveLength(1);
    const c = f.calls[0]!;
    expect(isEval(c)).toBe(true);
    if (!isEval(c)) return;
    expect(c.script.source).toBe(PRIORITY_HOLD_LUA);
    expect(c.keys).toEqual([seatKeys.bitmap(E), seatKeys.prio(E), seatKeys.stream(E), seatKeys.epoch(E), seatKeys.secver(E), seatKeys.fence(E), seatKeys.hold(E, 3)]);
    expect(c.args).toEqual([ACCOUNT, GRANT, String(KEEP), String(EXP), '3', '0', '3', 'A01', 'R', 'SEC-A', seatKeys.section(E, '')]);
  });

  test.each([
    [['CONFLICT', '3'], { kind: 'CONFLICT', seatId: 'A01' }],
    [['EXPIRED'], { kind: 'EXPIRED' }],
    [['NOT_READY'], { kind: 'NOT_READY' }],
  ])('답 %o를 그대로 해석한다', async (reply, expected) => {
    const f = fake(() => reply);
    await expect(new RedisSeatStore(f.redis).holdPriority({ eventId: E, accountId: ACCOUNT, grantId: GRANT, seat: SEAT, expiresAtMs: EXP, keepUntilMs: KEEP })).resolves.toEqual(expected);
  });

  test('이미 잡힌 비트는 덮어쓰지 않고 CONFLICT다: Lua는 비트가 1이면 쓰기 전에 멈춘다', () => {
    // M2-02는 이 검사를 뒤집어 빈 좌석을 CONFLICT로, 잡힌 좌석을 덮어쓰게 했다.
    expect(PRIORITY_HOLD_LUA).toMatch(/if bit\[1\] == 1 then return decided\(\{'CONFLICT', idx\}\) end/);
    // 비트 검사가 첫 쓰기(BITFIELD SET)보다 앞이다
    expect(PRIORITY_HOLD_LUA.indexOf("'CONFLICT', idx")).toBeLessThan(PRIORITY_HOLD_LUA.indexOf("redis.call('BITFIELD', KEYS[1], 'SET'"));
  });
});

describe('PRIORITY_RELEASE_LUA · RedisSeatStore.releasePriority(GAT-135 회수·만료, M2-01)', () => {
  test('해제 KEYS·ARGV 차례는 bitmap·prio·stream·epoch·secver·hold:{색인}이고 grantId가 ARGV 1이다', async () => {
    const f = fake(() => ['OK']);
    await expect(new RedisSeatStore(f.redis).releasePriority({ eventId: E, accountId: ACCOUNT, grantId: GRANT, seat: SEAT, keepUntilMs: KEEP })).resolves.toEqual({ kind: 'OK' });
    const c = f.calls[0]!;
    expect(isEval(c)).toBe(true);
    if (!isEval(c)) return;
    expect(c.script.source).toBe(PRIORITY_RELEASE_LUA);
    expect(c.keys).toEqual([seatKeys.bitmap(E), seatKeys.prio(E), seatKeys.stream(E), seatKeys.epoch(E), seatKeys.secver(E), seatKeys.hold(E, 3)]);
    expect(c.args).toEqual([GRANT, ACCOUNT, String(KEEP), '3', '0', '3', 'A01', 'R', 'SEC-A', seatKeys.section(E, '')]);
  });

  test('남의 계정·다른 권리·일반 홀드는 풀지 않는다: 소유자·grantId·kind를 모두 본다', () => {
    // M2-01은 h[2] ~= ARGV[2](소유 계정) 검사를 뺐다. 넷 중 하나라도 다르면 NOT_FOUND여야 한다.
    expect(PRIORITY_RELEASE_LUA).toMatch(/h\[1\] ~= ARGV\[1\] or h\[2\] ~= ARGV\[2\] or h\[3\] ~= 'PRIORITY' or h\[4\] ~= ARGV\[1\]/);
    expect(PRIORITY_RELEASE_LUA).toMatch(/return decided\(\{'NOT_FOUND'\}\)/);
    // NOT_FOUND면 BITFIELD SET·DEL·ZREM을 하지 않는다(검사가 첫 쓰기보다 앞)
    expect(PRIORITY_RELEASE_LUA.indexOf("return decided({'NOT_FOUND'})")).toBeLessThan(PRIORITY_RELEASE_LUA.indexOf("redis.call('BITFIELD', KEYS[1], 'SET'"));
  });
});

describe('PRIORITY_EXPIRE_LUA · RedisSeatStore.expirePriority(EXPIRE 경합, M2-03)', () => {
  test('만료 Lua의 KEYS·ARGV는 bitmap·prio·stream·epoch·secver와 좌석 차례의 hold, 좌석마다 9칸이다', async () => {
    const f = fake(() => ['OK', '1793761200000123', 1, 0, 0, '3', GRANT]);
    const r = await new RedisSeatStore(f.redis).expirePriority({
      eventId: E,
      keepUntilMs: KEEP,
      seats: [{ index: 3, expected: { grantId: GRANT, fencingToken: '1700000000000003', owner: ACCOUNT }, seat: SEAT }],
    });
    expect(r).toEqual({ kind: 'OK', nowUs: 1_793_761_200_000_123, released: 1, skipped: 0, orphans: 0, corrupt: 0, expired: [{ index: 3, grantId: GRANT }] });
    const c = f.calls[0]!;
    expect(isEval(c)).toBe(true);
    if (!isEval(c)) return;
    expect(c.script.source).toBe(PRIORITY_EXPIRE_LUA);
    expect(c.keys).toEqual([seatKeys.bitmap(E), seatKeys.prio(E), seatKeys.stream(E), seatKeys.epoch(E), seatKeys.secver(E), seatKeys.hold(E, 3)]);
    expect(c.args).toEqual([seatKeys.section(E, ''), String(KEEP), '1', '3', GRANT, '1700000000000003', ACCOUNT, '0', '3', 'A01', 'R', 'SEC-A']);
  });

  test('만료 경계는 exp == now까지 풀고(<=), 기대한 권리·fence·소유자가 그대로일 때만 푼다', () => {
    // M2-03은 <=를 <로 바꿔 정확히 만료 시각인 좌석을 다음 스위퍼까지 묶어 두었다.
    expect(PRIORITY_EXPIRE_LUA).toMatch(/tonumber\(h\[4\]\) <= now/);
    // EXPIRE 경합: 읽은 뒤 그 사이 다른 권리가 잡았으면(기대 불일치) 건너뛴다
    expect(PRIORITY_EXPIRE_LUA).toMatch(/h\[1\] == at\(i, 2\) and h\[3\] == at\(i, 3\) and h\[2\] == at\(i, 4\) and h\[6\] == h\[1\]/);
    expect(PRIORITY_EXPIRE_LUA).toMatch(/h\[5\] ~= 'PRIORITY'/);
  });

  test('답의 푼 수·건너뜀·고아 밖의 좌석은 corrupt로 세고, 입력에 없는 색인은 거절한다', async () => {
    const ok = fake(() => ['OK', '1', 1, 0, 0, '3', GRANT]);
    await expect(
      new RedisSeatStore(ok.redis).expirePriority({
        eventId: E,
        keepUntilMs: KEEP,
        seats: [
          { index: 3, expected: { grantId: GRANT, fencingToken: '1700000000000003', owner: ACCOUNT }, seat: SEAT },
          { index: 4, expected: null },
        ],
      }),
    ).resolves.toMatchObject({ released: 1, skipped: 0, orphans: 0, corrupt: 1 });
    const bad = fake(() => ['OK', '1', 1, 0, 0, '9', GRANT]);
    await expect(
      new RedisSeatStore(bad.redis).expirePriority({
        eventId: E,
        keepUntilMs: KEEP,
        seats: [{ index: 3, expected: { grantId: GRANT, fencingToken: '1700000000000003', owner: ACCOUNT }, seat: SEAT }],
      }),
    ).rejects.toThrow(/입력에 없는 좌석 색인/);
  });
});

describe('RESTORE_PRIORITY_LUA · RedisSeatStore.restorePriority(결제 실패 복귀, M2-04)', () => {
  test('복귀 KEYS·ARGV는 ordered·paused·epoch와 좌석 차례의 hold, 계정·grantId·keepUntil·색인이다', async () => {
    const f = fake(() => ['OK', 1]);
    await expect(new RedisSeatStore(f.redis).restorePriority({ eventId: E, accountId: ACCOUNT, grantId: GRANT, seats: [SEAT], keepUntilMs: KEEP })).resolves.toEqual({ kind: 'OK', restored: 1 });
    const c = f.calls[0]!;
    expect(isEval(c)).toBe(true);
    if (!isEval(c)) return;
    expect(c.script.source).toBe(RESTORE_PRIORITY_LUA);
    expect(c.keys).toEqual([seatKeys.ordered(E), seatKeys.paused(E), seatKeys.epoch(E), seatKeys.hold(E, 3)]);
    expect(c.args).toEqual([ACCOUNT, GRANT, String(KEEP), '3']);
  });

  test('그 권리의 PRIORITY 보류만 되돌린다: holdId·owner·kind·priorityGrantId가 모두 같아야 한다', () => {
    // M2-04는 priorityGrantId 일치(h[4] == ARGV[2])를 빼 다른 권리의 보류까지 주문 표시를 지웠다.
    expect(RESTORE_PRIORITY_LUA).toMatch(/h\[1\] == ARGV\[2\] and h\[2\] == ARGV\[1\] and h\[3\] == 'PRIORITY' and h\[4\] == ARGV\[2\]/);
    // 지우는 것은 주문 표시뿐이고 비트·hold Hash·prio는 남긴다
    expect(RESTORE_PRIORITY_LUA).toMatch(/HDEL', KEYS\[3 \+ i\], 'pin', 'ordAt', 'maxStay', 'rem', 'thawAt'/);
    expect(RESTORE_PRIORITY_LUA).not.toContain("redis.call('DEL'");
    expect(RESTORE_PRIORITY_LUA).not.toMatch(/BITFIELD/);
  });
});

describe('SET_BOOKING_RESTRICTION_LUA · s:rst 판 가드(M2-10, GAT-310)', () => {
  test('판 번호가 같거나 작으면 아무것도 쓰지 않는다(>=)', () => {
    // M2-10은 >=를 >로 바꿔 같은 판의 늦은 재시도가 최신 값을 덮어쓰게 했다.
    expect(SET_BOOKING_RESTRICTION_LUA).toMatch(/if current and tonumber\(current\) >= tonumber\(ARGV\[4\]\) then return 0 end/);
    // 판 번호를 먼저 보고, 그 뒤에 st·rid·ver를 한 번에 쓴다
    expect(SET_BOOKING_RESTRICTION_LUA.indexOf('return 0')).toBeLessThan(SET_BOOKING_RESTRICTION_LUA.indexOf("HSET', KEYS[1], 'st'"));
  });

  test('apply는 s:rst:{account}에 state·restrictionId·until·version 차례로 넘기고 1/0을 changed로 바꾼다', async () => {
    for (const [reply, changed] of [
      [1, true],
      [0, false],
    ] as const) {
      const f = fake(() => reply);
      await expect(new RedisBookingRestrictions(f.redis).apply({ accountId: ACCOUNT, restrictionId: 'r1', state: 'ACTIVE', untilMs: 1_000, version: 7 })).resolves.toEqual({ changed });
      const c = f.calls[0]!;
      expect(isEval(c)).toBe(true);
      if (!isEval(c)) return;
      expect(c.script.source).toBe(SET_BOOKING_RESTRICTION_LUA);
      expect(c.keys).toEqual([`s:rst:${ACCOUNT}`]);
      expect(c.args).toEqual(['ACTIVE', 'r1', '1000', '7']);
    }
  });
});

describe('RedisBookingRestrictions.read의 until 형 검사(M2-11)', () => {
  const readReply = (reply: unknown) => {
    const f = fake(() => reply);
    return { r: new RedisBookingRestrictions(f.redis).read(ACCOUNT), calls: f.calls };
  };

  test('until이 앞 0 없는 0 이상 안전한 정수 글이 아니면(1e3·0123·-1·1.5·abc·0x10) 망가진 사본이라 Error다', async () => {
    // M2-11은 MS_TEXT 검사를 지워 Number('1e3')=1000을 정상으로 받아들였다.
    for (const until of ['1e3', '0123', '-1', '1.5', 'abc', '0x10', ' 5', '9007199254740993']) {
      const { r } = readReply(['ACTIVE', until, 'r1', '1']);
      await expect(r, until).rejects.toThrow(/until/);
    }
  });

  test('네 칸이 모두 없으면 제한 없음(undefined), st가 없거나 ACTIVE·LIFTED가 아니면 Error다', async () => {
    await expect(readReply([null, null, null, null]).r).resolves.toBeUndefined();
    await expect(readReply(['ACTIVE', null, 'r1', '1']).r).resolves.toEqual({ st: 'ACTIVE' });
    await expect(readReply(['ACTIVE', '1000', 'r1', '1']).r).resolves.toEqual({ st: 'ACTIVE', untilMs: 1000 });
    await expect(readReply([null, '1000', 'r1', '1']).r).rejects.toThrow(/st 칸/);
    await expect(readReply(['BANNED', null, 'r1', '1']).r).rejects.toThrow(/ACTIVE·LIFTED/);
    expect(bookingRestrictionKey(ACCOUNT)).toBe(`s:rst:${ACCOUNT}`);
  });
});
