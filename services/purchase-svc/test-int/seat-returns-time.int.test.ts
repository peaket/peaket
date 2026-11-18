// 취소표 좌석 델타의 변경 시각 단위(WIR-01, BAT-416)를 실제 Valkey 8.1로 본다.
// 정본: docs/data.md `s:{event:E}:sec:{section}` 행(메시지 `1 {seatEpoch} {sectionIndex} {sectionVersion} {changedAtMs} {seatOffset}:{state} …`,
// changedAtMs는 바꾼 Lua의 Redis TIME, epoch 밀리초), ADR-0110 결정 4(홀드 Lua가 변경 시각을 밀리초로 싣는다), docs/features/seat-hold.md 399·430줄.
//
// 약속:
// - 기대 값은 정본 식(초 × 1000 + floor(마이크로초 ÷ 1000), 정수 글)으로 손으로 적는다. 코드에서 가져오지 않는다.
// - ①~④는 RETURN_SOLD_LUA의 redis.call('TIME')을 괄호 친 고정 표 `({'<초>', '<마이크로초>'})`로 바꾼 사본을 부른다.
//   괄호가 없으면 고치기 전 꼴 `redis.call('TIME')[1]`이 Lua 문법 오류가 되어 값 단언까지 가지 못한다.
// - ⑤는 고정하지 않은 실제 어댑터(RedisSeatReturnNotices)를 부르고, 앞뒤를 Valkey TIME으로 잰다. Docker 엔진 VM과 이 PC 시계 차이를
//   보지 않으려고 앱 시계(Date.now)는 쓰지 않는다(pin-failed-mark.int.test.ts와 같은 까닭).
// - 고정 사본이 다른 경로로 새지 않게 응답 OK, 비트맵 비트 0, secver 증가도 함께 본다.
// - 회차 ID는 시험마다 새 UUID라 서로 닿지 않는다. 컨테이너 하나를 파일 전체가 나눠 쓴다.
import { randomUUID } from 'node:crypto';
import { createHotRedis, type HotRedis, redisScript } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RETURN_SOLD_LUA } from '../src/modules/refund/adapters/redis-seat-returns.js';
import { RedisSeatReturnNotices } from '../src/modules/refund/index.js';
import { type ShardSubscriber, shardSubscriber, startValkey, type ValkeyContainer } from './valkey.js';

const DAY = 86_400_000;
const TIME_CALL = "redis.call('TIME')";

let valkey: ValkeyContainer | undefined;
let redis: HotRedis;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
}, 120_000);

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

/** Valkey 서버 시각(epoch 밀리초, 정본 식) */
async function serverMs(): Promise<number> {
  const t = (await redis.command(['TIME'], {})) as unknown[];
  return Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000);
}

const keysOf = (eventId: string) => {
  const base = `s:{event:${eventId}}`;
  return { base, bitmap: `${base}:bitmap`, epoch: `${base}:epoch`, secver: `${base}:secver`, prio: `${base}:prio`, hold: (i: number) => `${base}:hold:${i}`, sec: `${base}:sec:` };
};

interface Seat {
  index: number;
  sectionIndex: number;
  seatOffset: number;
}

/** 세대 키와 판매 비트를 직접 쓴다(cancellation.int.test.ts 'Redis 취소표'처럼). 세대 값은 시각과 닿지 않는 값이다 */
async function seed(eventId: string, seats: readonly Seat[], seatEpoch = '1731234567'): Promise<void> {
  const k = keysOf(eventId);
  await redis.command(['HSET', k.epoch, 'epoch', seatEpoch], { key: k.epoch });
  for (const s of seats) await redis.command(['SETBIT', k.bitmap, String(s.index), '1'], { key: k.bitmap });
}

/** TIME을 고정한 사본. TIME 읽기가 정확히 한 번인지 먼저 본다(구역마다 다시 읽는 꼴을 막는다) */
function fixedTimeLua(sec: string, micro: string): string {
  expect(RETURN_SOLD_LUA.split(TIME_CALL)).toHaveLength(2);
  return RETURN_SOLD_LUA.replace(TIME_CALL, `({'${sec}', '${micro}'})`);
}

/** 고정 사본을 어댑터와 같은 KEYS·ARGV 모양으로 부르고, 받은 델타를 채널 차례로 돌려준다 */
async function returnWithFixedTime(eventId: string, seats: readonly Seat[], sec: string, micro: string): Promise<{ reply: unknown; messages: { channel: string; message: string }[] }> {
  const k = keysOf(eventId);
  const sections = [...new Set(seats.map((s) => s.sectionIndex))];
  const sub: ShardSubscriber = await shardSubscriber(valkey!.url);
  try {
    await sub.subscribe(sections.map((s) => `${k.sec}${s}`));
    const keepUntilMs = (await serverMs()) + DAY;
    const keys = [k.bitmap, k.epoch, k.secver, k.prio, ...seats.map((s) => k.hold(s.index))];
    const args = [String(keepUntilMs), k.sec, ...seats.flatMap((s) => [String(s.index), String(s.sectionIndex), String(s.seatOffset)])];
    const reply = await redis.evalScript(redisScript(fixedTimeLua(sec, micro)), keys, args, { deadlineMs: 5_000 });
    await sub.sync();
    const messages = [...sub.messages].sort((a, b) => a.channel.localeCompare(b.channel));
    return { reply, messages };
  } finally {
    sub.close();
  }
}

/** 고정 사본이 실제 되돌리기를 했는지(비트 0, 구역 번호 증가) */
async function expectReturned(eventId: string, seats: readonly Seat[]): Promise<void> {
  const k = keysOf(eventId);
  for (const s of seats) expect(Number(await redis.command(['GETBIT', k.bitmap, String(s.index)], { key: k.bitmap }))).toBe(0);
  for (const sec of new Set(seats.map((s) => s.sectionIndex))) {
    expect(String(await redis.command(['HGET', k.secver, String(sec)], { key: k.secver }))).toBe(String(seats.filter((s) => s.sectionIndex === sec).length));
  }
}

const ONE: readonly Seat[] = [{ index: 3, sectionIndex: 0, seatOffset: 3 }];

describe('취소표 델타의 변경 시각(WIR-01)', () => {
  test('WIR-01 ① TIME을 {1700000000, 999999}로 고정하면 델타의 변경 시각은 1700000000999다(마이크로초 몫을 버린다)', async () => {
    const eventId = randomUUID();
    await seed(eventId, ONE);
    const { reply, messages } = await returnWithFixedTime(eventId, ONE, '1700000000', '999999');
    expect(reply).toEqual(['OK', 1]);
    expect(messages).toEqual([{ channel: `s:{event:${eventId}}:sec:0`, message: '1 1731234567 0 1 1700000000999 3:0' }]);
    await expectReturned(eventId, ONE);
  });

  test.each([
    ['0', '1700000000000'],
    ['999', '1700000000000'],
    ['1000', '1700000000001'],
    ['500000', '1700000000500'],
  ])('WIR-01 ② 마이크로초 경계: TIME {1700000000, %s} → 변경 시각 %s', async (micro, expected) => {
    const eventId = randomUUID();
    await seed(eventId, ONE);
    const { reply, messages } = await returnWithFixedTime(eventId, ONE, '1700000000', micro);
    expect(reply).toEqual(['OK', 1]);
    expect(messages).toEqual([{ channel: `s:{event:${eventId}}:sec:0`, message: `1 1731234567 0 1 ${expected} 3:0` }]);
    await expectReturned(eventId, ONE);
  });

  // RV-01·M11: Valkey의 Lua 5.1은 숫자를 `..`로 이을 때 %.14g로 글을 만든다. 13자리(지금의 epoch 밀리초)는 그대로 나와
  // 정수 글 함수(int)를 빼도 가려지지 않으므로, 10^14 이상(15자리)을 골라 int가 없으면 `1e+14`로 새는 것을 잡는다
  test('WIR-01 ③ 변경 시각이 10^14 이상이어도(TIME {100000000000, 0}) 지수·소수 표기 없이 100000000000000이다', async () => {
    const eventId = randomUUID();
    await seed(eventId, ONE);
    const { reply, messages } = await returnWithFixedTime(eventId, ONE, '100000000000', '0');
    expect(reply).toEqual(['OK', 1]);
    expect(messages).toHaveLength(1);
    const changedAt = messages[0]!.message.split(' ')[4];
    expect(changedAt).toMatch(/^\d{15}$/);
    expect(changedAt).toBe('100000000000000');
    expect(messages[0]!.message).toBe('1 1731234567 0 1 100000000000000 3:0');
    await expectReturned(eventId, ONE);
  });

  test('WIR-01 ④ 한 번에 두 구역을 되돌리면 두 메시지의 변경 시각이 같은 1700000000999다', async () => {
    const eventId = randomUUID();
    const seats: Seat[] = [
      { index: 3, sectionIndex: 0, seatOffset: 3 },
      { index: 12, sectionIndex: 1, seatOffset: 2 },
    ];
    await seed(eventId, seats);
    const { reply, messages } = await returnWithFixedTime(eventId, seats, '1700000000', '999999');
    expect(reply).toEqual(['OK', 2]);
    expect(messages).toEqual([
      { channel: `s:{event:${eventId}}:sec:0`, message: '1 1731234567 0 1 1700000000999 3:0' },
      { channel: `s:{event:${eventId}}:sec:1`, message: '1 1731234567 1 1 1700000000999 2:0' },
    ]);
    await expectReturned(eventId, seats);
  });

  test('WIR-01 ⑤ 실제 TIME: 변경 시각은 호출 앞뒤 Valkey TIME(ms)의 사이이고 10^12 이상 10^13 미만이다', async () => {
    const eventId = randomUUID();
    await seed(eventId, ONE);
    const k = keysOf(eventId);
    const sub: ShardSubscriber = await shardSubscriber(valkey!.url);
    try {
      await sub.subscribe([`${k.sec}0`]);
      const before = await serverMs();
      await expect(new RedisSeatReturnNotices(redis).returnSold({ eventId, seats: ONE.map((s) => ({ ...s })), keepUntilMs: before + DAY })).resolves.toBe('OK');
      const after = await serverMs();
      await sub.sync();
      expect(sub.messages).toHaveLength(1);
      expect(sub.messages[0]!.channel).toBe(`${k.sec}0`);
      const m = /^1 1731234567 0 1 (\d+) 3:0$/.exec(sub.messages[0]!.message);
      expect(m, sub.messages[0]!.message).not.toBeNull();
      const changedAtMs = Number(m![1]);
      expect(changedAtMs).toBeGreaterThanOrEqual(1e12);
      expect(changedAtMs).toBeLessThan(1e13);
      expect(changedAtMs).toBeGreaterThanOrEqual(before);
      expect(changedAtMs).toBeLessThanOrEqual(after);
    } finally {
      sub.close();
    }
    await expectReturned(eventId, ONE);
  });
});
