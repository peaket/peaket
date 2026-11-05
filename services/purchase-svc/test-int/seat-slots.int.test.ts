// 결제 접수의 회차 슬롯 읽기(inventory RedisSeatSlots·SEAT_SLOT_READ_LUA)를 실제 Valkey 8.1로 돈다(BUILD_ORDER PRF-162).
// 정본: docs/features/payment.md §2 '결제 접수의 첫 구현' 검사 차례(회차 슬롯 읽기: 세대 키가 없으면 503, 판매 정지 사본이면 423),
// docs/data.md §3 좌석 키 표(s:{event:E}:epoch의 epoch·gen 칸, s:{event:E}:ctl의 paused·allPaused·suspended 칸, gen이 없으면 1로 본다),
// inventory adapters/seat-slot-lua.ts의 Lua 계약과 domain/ports.ts SeatSlotReader의 설명.
//
// 약속:
// - 세대 키·판매 정지 사본은 시험이 HSET으로 직접 쓴다(판매 열기 Lua를 거치지 않는다. 칸 하나씩 바꿔 보려고).
// - 회차마다 새 회차 ID를 쓰고 Valkey를 비우지 않는다.
//
// 정본 모호: data.md §3은 gen 칸 값의 형식과 망가졌을 때의 처리, 검사 앞뒤(세대 키 → 판 번호 → 정지)를 적지 않았다.
// seat-slot-lua.ts '정한 것'대로 본다: gen은 앞 0 없는 양의 10진 정수 2147483647(int4) 이하(리뷰 고침 L5), 아니면 'PEAKET_CORRUPT_KEY {세대 키}' 오류(어댑터가 키 이름을 지우지 않는다고 가정),
// 정지 칸은 정확히 '1'일 때만 정지, epoch 칸 값의 형식은 보지 않는다.
import 'reflect-metadata';
import { createHotRedis, type HotRedis, type RedisScript } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RedisSeatSlots, SEAT_SLOT_READ_LUA, type SeatSlotRead, seatKeys, slotOf } from '../src/modules/inventory/index.js';
import { newEvent } from '../test/hold-cases.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer | undefined;
let redis: HotRedis;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
});

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

// ───────────────────────────── 도우미 ─────────────────────────────

/** 스크립트 호출과 다른 명령을 적는 겉(order-holds.int.test.ts의 recording과 같은 꼴) */
function recording(inner: HotRedis) {
  const scripts: { script: RedisScript; keys: string[]; args: string[] }[] = [];
  const commands: string[][] = [];
  const r: HotRedis = {
    command: (a, o) => {
      commands.push([...a]);
      return inner.command(a, o);
    },
    sendCommand: (a) => {
      commands.push([...a].map(String));
      return inner.sendCommand(a);
    },
    evalScript: (s, k, a, o) => {
      scripts.push({ script: s, keys: [...k], args: [...a] });
      return inner.evalScript(s, k, a, o);
    },
    close: () => inner.close(),
  };
  return { redis: r, scripts, commands };
}

const cmd = (key: string, args: string[]) => redis.command(args, { key });

/** 세대 키를 쓴다(epoch 칸은 세대 초, node는 단일 노드 표지). gen을 주면 gen 칸도 쓴다 */
async function ready(eventId: string, o: { gen?: string; epoch?: string | null } = {}): Promise<void> {
  const key = seatKeys.epoch(eventId);
  const fields: string[] = ['node', 'standalone'];
  if (o.epoch !== null) fields.push('epoch', o.epoch ?? '1762311600');
  if (o.gen !== undefined) fields.push('gen', o.gen);
  await cmd(key, ['HSET', key, ...fields]);
}
/** 판매 정지 사본 칸을 쓴다 */
const control = (eventId: string, fields: Record<string, string>) => cmd(seatKeys.ctl(eventId), ['HSET', seatKeys.ctl(eventId), ...Object.entries(fields).flat()]);

/** 그 회차의 세대 키와 판매 정지 사본의 DUMP(hex)와 만료 시각. 읽기 전용인지 견줄 때 쓴다 */
async function dumpSlot(eventId: string): Promise<Record<string, { dump: string | null; at: number }>> {
  const out: Record<string, { dump: string | null; at: number }> = {};
  for (const k of [seatKeys.epoch(eventId), seatKeys.ctl(eventId)]) {
    const d = await redis.command(['DUMP', k], { key: k, binary: true });
    out[k] = { dump: d === null || d === undefined ? null : Buffer.from(d as Uint8Array).toString('hex'), at: Number(await cmd(k, ['PEXPIRETIME', k])) };
  }
  return out;
}

const slots = () => new RedisSeatSlots(redis);
const OK = (gen: number): SeatSlotRead => ({ status: 'OK', gen });
const NOT_READY: SeatSlotRead = { status: 'NOT_READY' };
const PAUSED: SeatSlotRead = { status: 'PAUSED' };

/** 던진 오류(던지지 않으면 시험이 실패한다) */
async function thrown(p: Promise<unknown>): Promise<Error> {
  const r = await p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  if (r.ok) throw new Error(`던지지 않았다: ${JSON.stringify(r.v)}`);
  expect(r.e).toBeInstanceOf(Error);
  return r.e as Error;
}

// ───────────────────────────── Lua 계약 ─────────────────────────────

describe('RedisSeatSlots.read: Lua 계약', () => {
  test('첫 줄이 #!lua flags=no-writes이고, 스크립트 한 번에 KEYS = [세대 키, 판매 정지 사본], ARGV 없음이며 두 키가 회차 슬롯 하나다', async () => {
    expect(SEAT_SLOT_READ_LUA.split('\n')[0]).toBe('#!lua flags=no-writes');
    const e = newEvent();
    await ready(e, { gen: '2' });
    const rec = recording(redis);

    expect(await new RedisSeatSlots(rec.redis).read(e)).toEqual(OK(2));

    expect(rec.scripts).toHaveLength(1);
    const call = rec.scripts[0]!;
    expect(call.script.source).toBe(SEAT_SLOT_READ_LUA);
    expect(call.keys).toEqual([seatKeys.epoch(e), seatKeys.ctl(e)]);
    expect(call.args).toEqual([]);
    expect(new Set(call.keys.map(slotOf)).size).toBe(1);
    // 스크립트 밖 명령은 없다
    expect(rec.commands).toEqual([]);
  });

  test('마감(deadlineMs)을 주어도 결과가 같다', async () => {
    const e = newEvent();
    await ready(e, { gen: '4' });
    expect(await slots().read(e, { deadlineMs: 500 })).toEqual(OK(4));
  });
});

// ───────────────────────────── 세대 키 ─────────────────────────────

describe('RedisSeatSlots.read: 세대 키(s:{event:E}:epoch)', () => {
  test('세대 키가 없으면 NOT_READY다(503 seat-store-unavailable 자리)', async () => {
    expect(await slots().read(newEvent())).toEqual(NOT_READY);
  });

  test('세대 키가 있어도 epoch 칸이 없으면(node·gen만) NOT_READY다', async () => {
    const e = newEvent();
    await ready(e, { epoch: null, gen: '3' });
    expect(await slots().read(e)).toEqual(NOT_READY);
  });

  test('gen 칸이 없으면 OK에 gen 1이다(판매 열기 전 키, data.md §3 "칸이 없으면 1로 본다")', async () => {
    const e = newEvent();
    await ready(e);
    expect(await slots().read(e)).toEqual(OK(1));
  });

  test.each<[string, number]>([
    ['1', 1],
    ['7', 7],
    ['123456', 123456],
    ['2147483647', 2_147_483_647],
  ])("gen 칸이 '%s'면 OK에 gen %d다(다시 만들기 판 번호, int4 위 끝까지, 리뷰 고침 L5)", async (raw, gen) => {
    const e = newEvent();
    await ready(e, { gen: raw });
    expect(await slots().read(e)).toEqual(OK(gen));
  });

  test.each(['abc', '0', '01', '-1', '1.5', '', ' 1', '1e3', '0x10', '2147483648', '9999999999', '10000000000', '999999999999999', '1000000000000000'])(
    "gen 칸이 앞 0 없는 양의 10진 정수(2147483647 이하, 리뷰 고침 L5)가 아니면('%s') PEAKET_CORRUPT_KEY {세대 키} 오류다(NOT_READY·OK로 숨기지 않는다)",
    async (bad) => {
      const e = newEvent();
      await ready(e, { gen: '5' });
      // 망가뜨리기 전에는 OK다(아무 오류나 통과하지 않게)
      expect(await slots().read(e)).toEqual(OK(5));
      await cmd(seatKeys.epoch(e), ['HSET', seatKeys.epoch(e), 'gen', bad]);
      const err = await thrown(slots().read(e));
      expect(err.message).toMatch(/CORRUPT_KEY/);
      expect(err.message).toContain(seatKeys.epoch(e));
      expect(err.name).not.toBe('SeatStoreUnavailable');
    },
  );

  test('gen이 망가졌고 판매 정지 사본도 정지면 PAUSED가 아니라 CORRUPT_KEY다(판 번호 검사가 정지 검사보다 먼저, seat-slot-lua.ts 정한 것)', async () => {
    const e = newEvent();
    await ready(e, { gen: '2' });
    await control(e, { paused: '1' });
    expect(await slots().read(e)).toEqual(PAUSED);
    await cmd(seatKeys.epoch(e), ['HSET', seatKeys.epoch(e), 'gen', 'x']);
    expect((await thrown(slots().read(e))).message).toMatch(/CORRUPT_KEY/);
  });

  test('세대 키가 없으면 판매 정지 사본이 정지여도 NOT_READY다(세대 키 검사가 먼저)', async () => {
    const e = newEvent();
    await control(e, { paused: '1', allPaused: '1', suspended: '1' });
    expect(await slots().read(e)).toEqual(NOT_READY);
  });
});

// ───────────────────────────── 판매 정지 사본 ─────────────────────────────

describe('RedisSeatSlots.read: 판매 정지 사본(s:{event:E}:ctl)', () => {
  test.each(['paused', 'allPaused', 'suspended'])("%s 칸이 '1'이면 PAUSED다(423 sale-paused 자리)", async (field) => {
    const e = newEvent();
    await ready(e, { gen: '3' });
    expect(await slots().read(e)).toEqual(OK(3));
    await control(e, { [field]: '1' });
    expect(await slots().read(e)).toEqual(PAUSED);
  });

  test("세 칸이 모두 '0'이고 판 번호·명령 ID 칸(rev·cmd·allRev·allCmd·suspRef)이 있어도 OK다", async () => {
    const e = newEvent();
    await ready(e, { gen: '6' });
    await control(e, { paused: '0', allPaused: '0', suspended: '0', rev: '4', cmd: 'cmd-1', allRev: '2', allCmd: 'cmd-2', suspRef: 'susp-1' });
    expect(await slots().read(e)).toEqual(OK(6));
  });

  test("정지 칸이 '1'이 아닌 값('true'·'2'·'')이면 정지가 아니다(OK)", async () => {
    const e = newEvent();
    await ready(e);
    await control(e, { paused: 'true', allPaused: '2', suspended: '' });
    expect(await slots().read(e)).toEqual(OK(1));
  });

  test('판매 정지 사본 키가 없으면 정지가 아니다(OK)', async () => {
    const e = newEvent();
    await ready(e, { gen: '2' });
    expect(await redis.command(['EXISTS', seatKeys.ctl(e)], { key: seatKeys.ctl(e) })).toBe(0);
    expect(await slots().read(e)).toEqual(OK(2));
  });
});

// ───────────────────────────── 읽기 전용·입력·형 ─────────────────────────────

describe('RedisSeatSlots.read: 읽기만 한다', () => {
  test('읽기 전후로 세대 키·판매 정지 사본의 DUMP와 만료 시각이 같다(OK·PAUSED·NOT_READY 모두) [ASVS v5.0.0-2.3.3]', async () => {
    const e = newEvent();
    await ready(e, { gen: '9' });
    await cmd(seatKeys.epoch(e), ['PEXPIRE', seatKeys.epoch(e), '86400000']);
    const before = await dumpSlot(e);
    expect(await slots().read(e)).toEqual(OK(9));
    expect(await dumpSlot(e)).toEqual(before);

    await control(e, { suspended: '1' });
    const paused = await dumpSlot(e);
    expect(await slots().read(e)).toEqual(PAUSED);
    expect(await dumpSlot(e)).toEqual(paused);

    // 키가 없는 회차는 읽은 뒤에도 키가 생기지 않는다
    const empty = newEvent();
    expect(await slots().read(empty)).toEqual(NOT_READY);
    expect(await dumpSlot(empty)).toEqual({ [seatKeys.epoch(empty)]: { dump: null, at: -2 }, [seatKeys.ctl(empty)]: { dump: null, at: -2 } });
  });
});

describe('RedisSeatSlots.read: 입력과 키 형', () => {
  test.each([
    ['빈 글', ''],
    ['해시 태그를 깨는 }', 'a}b'],
    ['해시 태그를 여는 {', '{x'],
    ['칸 구분자 :', 'e:1'],
    ['점', 'e.1'],
    ['65자', 'a'.repeat(65)],
    ['빈칸', 'a b'],
  ])('회차 ID가 키 조각 모양이 아니면(%s) 좌석 Redis를 부르지 않고 RangeError다 [ASVS v5.0.0-1.2.4]', async (_label, eventId) => {
    // 맞는 회차 ID는 읽힌다(아무 입력이나 RangeError로 막는 구현이 통과하지 않게)
    const good = newEvent();
    await ready(good, { gen: '2' });
    expect(await slots().read(good)).toEqual(OK(2));

    const rec = recording(redis);
    await expect(new RedisSeatSlots(rec.redis).read(eventId)).rejects.toThrow(RangeError);
    expect(rec.scripts).toEqual([]);
    expect(rec.commands).toEqual([]);
  });

  test('64자 회차 ID(키 조각 상한)는 읽는다', async () => {
    const e = `e${'0'.repeat(63)}`.slice(0, 64);
    await cmd(seatKeys.epoch(e), ['DEL', seatKeys.epoch(e)]);
    await ready(e, { gen: '3' });
    expect(await slots().read(e)).toEqual(OK(3));
  });

  test('세대 키의 형이 틀리면(문자열) WRONGTYPE 오류가 그대로 나간다(일시 장애·NOT_READY로 숨기지 않는다)', async () => {
    const e = newEvent();
    await ready(e);
    expect(await slots().read(e)).toEqual(OK(1));
    await cmd(seatKeys.epoch(e), ['DEL', seatKeys.epoch(e)]);
    await cmd(seatKeys.epoch(e), ['SET', seatKeys.epoch(e), 'x']);
    const err = await thrown(slots().read(e));
    expect(err.message).toMatch(/WRONGTYPE/);
    expect(err.name).not.toBe('SeatStoreUnavailable');
  });

  test('판매 정지 사본의 형이 틀리면(문자열) WRONGTYPE 오류가 그대로 나간다', async () => {
    const e = newEvent();
    await ready(e);
    expect(await slots().read(e)).toEqual(OK(1));
    await cmd(seatKeys.ctl(e), ['SET', seatKeys.ctl(e), '1']);
    expect((await thrown(slots().read(e))).message).toMatch(/WRONGTYPE/);
  });
});

describe('RedisSeatSlots.read: 좌석 Redis를 쓸 수 없음', () => {
  test('좌석 Redis가 마감 안에 답하지 않으면(CLIENT PAUSE로 멈춤, deadlineMs 50) SeatStoreUnavailable을 던지고, 풀리면 다시 OK다', async () => {
    const e = newEvent();
    await ready(e, { gen: '2' });
    expect(await slots().read(e)).toEqual(OK(2));
    const pauser = await createHotRedis({ url: valkey!.url });
    try {
      await pauser.command(['CLIENT', 'PAUSE', '1000', 'ALL'], {});
      const err = await thrown(slots().read(e, { deadlineMs: 50 }));
      expect(err.name).toBe('SeatStoreUnavailable');
    } finally {
      await pauser.command(['CLIENT', 'UNPAUSE'], {}).catch(() => undefined);
      for (let i = 0; i < 40; i += 1) {
        if (await redis.command(['PING'], {}).then(() => true, () => false)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await pauser.close();
    }
    // 풀린 뒤 읽기는 마감을 넉넉히(1초) 준다(기본 100ms 마감은 부하에서 흔들렸다, 리뷰 기타 2026-11-05)
    expect(await slots().read(e, { deadlineMs: 1_000 })).toEqual(OK(2));
  });
});
