// 홀드 수명 Lua의 경계와 빠지기 쉬운 쓰기를 실제 Valkey 8.1로 돈다(docs/features/seat-hold.md §5 '해제·연장·다시 읽기와 결제 정지 멈춤의 첫 구현', S-T23·S-T29·S-T33, BUILD_ORDER HOT-358 리뷰 V1).
// 일부러 틀린 구현을 넣어 살아남은 결함을 잡으려고 더했다(hold-lifecycle.int.test.ts의 소유 확인·전이 시험을 보탠다).
import 'reflect-metadata';
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ExpirySweeper, HoldPauseView, type HoldTarget, holdLifecycleKeys, MemorySeatMap, type PaymentPauseAnswer, RedisHoldLifecycle, RedisSaleCounts, RedisSeatStore, RedisSweepLeases, type SeatRef, seatKeys } from '../src/modules/inventory/index.js';
import { ACCOUNT_A, ACCOUNT_B, DAY, held, holdInput, idx, newEvent, ref, SEAT_COUNT, SEAT_DEFS } from '../test/hold-cases.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer | undefined;
let redis: HotRedis;
let store: RedisSeatStore;
let life: RedisHoldLifecycle;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  store = new RedisSeatStore(redis);
  life = new RedisHoldLifecycle(redis);
});
afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

const [S1, S2, S3] = SEAT_DEFS.map((d) => d.seatId) as [string, string, string];
const KEEP = () => Date.now() + 2 * DAY;
const cmd = (key: string, args: string[]) => redis.command(args, { key });
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const bit = async (e: string, s: string) => Number(await cmd(seatKeys.bitmap(e), ['GETBIT', seatKeys.bitmap(e), String(idx(s))]));
const field = async (e: string, s: string, f: string) => {
  const v = await cmd(seatKeys.hold(e, idx(s)), ['HGET', seatKeys.hold(e, idx(s)), f]);
  return v === null || v === undefined ? null : String(v);
};
const setField = (e: string, s: string, f: string, v: string) => cmd(seatKeys.hold(e, idx(s)), ['HSET', seatKeys.hold(e, idx(s)), f, v]);
const zscore = async (k: string, s: string) => num(await cmd(k, ['ZSCORE', k, String(idx(s))]));
const ordered = (e: string) => holdLifecycleKeys.ordered(e);
const paused = (e: string) => holdLifecycleKeys.paused(e);

async function holdOf(e: string, seats: string[], accountId = ACCOUNT_A, ps = `ps-${accountId.slice(-4)}`): Promise<HoldTarget & { exp: number }> {
  const i = holdInput(e, seats, { accountId, purchaseSessionId: ps, keepUntilMs: KEEP() });
  const h = held(await store.hold(i));
  return { eventId: e, holdId: h.holdId, accountId, purchaseSessionId: ps, seats: [...i.seats], exp: h.expiresAtMs };
}
async function openEvent(): Promise<string> {
  const e = newEvent();
  await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs: KEEP() });
  return e;
}
async function orderedHold(e: string, seats = [S1], maxStayIn = 45 * 60_000): Promise<HoldTarget & { exp: number }> {
  const a = await holdOf(e, seats);
  expect(await life.markOrdered(a, Date.now() + maxStayIn, KEEP())).toEqual({ kind: 'OK', added: seats.length });
  return a;
}
const setExp = async (e: string, s: string, at: number) => {
  await setField(e, s, 'exp', String(at));
  await cmd(seatKeys.expiry(e), ['ZADD', seatKeys.expiry(e), String(at), String(idx(s))]);
};

describe('해제가 남기지 않는 것 S-T33', () => {
  test('S-T33 ① 해제하면 홀드 Hash도 지워져 시간이 남았어도 다시 읽기가 404다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1, S2]);
    expect(await life.release(a, KEEP())).toEqual({ kind: 'OK', released: 2 });
    expect(await field(e, S1, 'holdId')).toBeNull();
    expect(await field(e, S2, 'holdId')).toBeNull();
    expect(await life.read(a)).toEqual({ kind: 'NOT_FOUND' });
  });
  test('S-T33 주문 뒤 홀드를 해제하면 ordered에서도 빠진다', async () => {
    const e = await openEvent();
    const a = await orderedHold(e);
    expect(await life.release(a, KEEP())).toEqual({ kind: 'OK', released: 1 });
    expect(await zscore(ordered(e), S1)).toBeNull();
  });
});

describe('남은 시간 S-T23', () => {
  test('S-T23 ① 남은 시간은 만료 시각 − 정지 시작이다(옮긴 시각이 아니라 멈춘 때부터 센다)', async () => {
    const e = await openEvent();
    await orderedHold(e);
    const since = Date.now() - 30_000;
    const exp = Date.now() + 120_000;
    await setField(e, S1, 'ordAt', String(since - 60_000));
    await setExp(e, S1, exp);
    expect(await life.freeze(e, since, KEEP(), [idx(S1)])).toMatchObject({ kind: 'OK', moved: 1 });
    expect(Number(await field(e, S1, 'rem'))).toBe(exp - since);
  });
  test('S-T23 ① 정지 중에 만든 주문은 주문 시각부터 멈춘 것으로 센다(ordAt이 정지 시작보다 늦다)', async () => {
    const e = await openEvent();
    await orderedHold(e);
    const since = Date.now() - 60_000;
    const ordAt = since + 20_000;
    const exp = Date.now() + 120_000;
    await setField(e, S1, 'ordAt', String(ordAt));
    await setExp(e, S1, exp);
    await life.freeze(e, since, KEEP(), [idx(S1)]);
    expect(Number(await field(e, S1, 'rem'))).toBe(exp - ordAt);
  });
  test('S-T23 ① 남은 시간이 0인 홀드(만료 시각 = 정지 시작)는 옮기지 않고 ordered에서만 뺀다', async () => {
    const e = await openEvent();
    await orderedHold(e);
    const since = Date.now() - 1_000;
    await setField(e, S1, 'ordAt', String(since - 60_000));
    await setExp(e, S1, since);
    expect(await life.freeze(e, since, KEEP(), [idx(S1)])).toMatchObject({ kind: 'OK', moved: 0, dropped: 1 });
    expect(await zscore(paused(e), S1)).toBeNull();
    expect(await zscore(ordered(e), S1)).toBeNull();
    expect(await field(e, S1, 'rem')).toBeNull();
  });
  test('S-T23 H3 멈춘 홀드의 다시 읽기 만료는 지난 exp가 아니라 지금 + 남은 시간이다', async () => {
    const e = await openEvent();
    const a = await orderedHold(e);
    await life.freeze(e, Date.now(), KEEP(), [idx(S1)]);
    await setField(e, S1, 'exp', String(Date.now() - 60_000));
    await setField(e, S1, 'rem', '100000');
    const r = await life.read(a);
    expect(r).toMatchObject({ kind: 'OK', frozen: true });
    const at = r.kind === 'OK' ? r.expiresAtMs : 0;
    expect(at).toBeGreaterThan(Date.now() + 90_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 101_000);
  });
  test('S-T23 이미 멈춘 좌석이 주문 표시로 ordered에 다시 들어와도 다시 옮기지 않는다(남은 시간이 그대로다)', async () => {
    const e = await openEvent();
    const a = await orderedHold(e);
    await setField(e, S1, 'ordAt', String(Date.now() - 300_000));
    await life.freeze(e, Date.now() - 100_000, KEEP(), [idx(S1)]);
    const rem = await field(e, S1, 'rem');
    expect(await life.markOrdered(a, Date.now() + 2_700_000, KEEP())).toEqual({ kind: 'OK', added: 1 });
    expect(await life.freeze(e, Date.now(), KEEP(), [idx(S1)])).toMatchObject({ kind: 'OK', moved: 0, dropped: 1 });
    expect(await field(e, S1, 'rem')).toBe(rem);
    expect(await zscore(ordered(e), S1)).toBeNull();
    expect(await zscore(paused(e), S1)).not.toBeNull();
  });
  test('S-T23 만료 Lua: 만료 시각 = 정지 시작이면 정지와 무관하게 이미 끝난 홀드라 푼다', async () => {
    const e = await openEvent();
    const a = await orderedHold(e);
    const p = Date.now() - 5_000;
    await setField(e, S1, 'ordAt', String(p - 60_000));
    await setExp(e, S1, p);
    const due = await store.dueExpiries({ eventId: e, nowMs: Date.now() + 5_000, limit: 100 });
    const r = await store.expire({ eventId: e, keepUntilMs: KEEP(), seats: due.map((d) => ({ index: d.index, expected: d.hold, seat: ref(S1) })), pausedSinceMs: p });
    expect(r).toMatchObject({ kind: 'OK', released: 1, skipped: 0 });
    expect(await bit(e, S1)).toBe(0);
    expect(a.holdId).toBeTruthy();
  });
});

describe('주문 표시', () => {
  test('주문 표시를 다시 불러도 ordAt·maxStay는 처음 값 그대로다(재시도가 멈춘 시간 계산을 바꾸지 않는다)', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1]);
    const stay = Date.now() + 2_700_000;
    await life.markOrdered(a, stay, KEEP());
    const ordAt = await field(e, S1, 'ordAt');
    await new Promise((r) => setTimeout(r, 5));
    await life.markOrdered(a, stay + 60_000, KEEP());
    expect(await field(e, S1, 'ordAt')).toBe(ordAt);
    expect(await field(e, S1, 'maxStay')).toBe(String(stay));
  });
});

describe('묶인 좌석', () => {
  test('S-T23 묶인 좌석은 주문 표시로 ordered에 들지 않는다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1]);
    await setField(e, S1, 'pin', '1');
    expect(await life.markOrdered(a, Date.now() + 60_000, KEEP())).toEqual({ kind: 'OK', added: 0 });
    expect(await zscore(ordered(e), S1)).toBeNull();
    expect(await field(e, S1, 'ordAt')).toBeNull();
  });
  test('S-T23 되돌리기는 그사이 묶인 좌석을 expiry로 돌리지 않고 paused에서만 뺀다(두 번 팔리지 않게)', async () => {
    const e = await openEvent();
    await orderedHold(e);
    await life.freeze(e, Date.now(), KEEP(), [idx(S1)]);
    await setField(e, S1, 'pin', '1');
    expect(await life.thaw(e, KEEP(), [idx(S1)])).toMatchObject({ kind: 'OK', moved: 0, dropped: 1 });
    expect(await zscore(seatKeys.expiry(e), S1)).toBeNull();
    expect(await zscore(paused(e), S1)).toBeNull();
    expect(await field(e, S1, 'rem')).toBeNull();
  });
  test('묶기는 옮기기 전의 주문 뒤 홀드도 ordered에서 뺀다', async () => {
    const e = await openEvent();
    const a = await orderedHold(e);
    await store.pin({ eventId: e, holdId: a.holdId, accountId: a.accountId, purchaseSessionId: a.purchaseSessionId, seats: a.seats, limit: 4, orderGen: 1, keepUntilMs: KEEP() });
    expect(await zscore(ordered(e), S1)).toBeNull();
  });
  test('실패 해제는 멈춘 좌석을 paused에서도 뺀다', async () => {
    const e = await openEvent();
    const a = await orderedHold(e);
    await life.freeze(e, Date.now(), KEEP(), [idx(S1)]);
    await store.releaseFailed({ eventId: e, holdId: a.holdId, accountId: a.accountId, seats: a.seats, keepUntilMs: KEEP() });
    expect(await zscore(paused(e), S1)).toBeNull();
  });
});

describe('판매 상태 셈의 멈춘 홀드 S-T25', () => {
  test('S-T25 홀드 수는 만료 인덱스와 멈춘 홀드의 합이다(멈춘 좌석이 빠지면 거짓 매진·거짓 풀림이 난다)', async () => {
    const e = await openEvent();
    await orderedHold(e, [S1]);
    await life.freeze(e, Date.now(), KEEP(), [idx(S1)]);
    await holdOf(e, [S2], ACCOUNT_B);
    expect(await new RedisSaleCounts(redis).read(e)).toMatchObject({ kind: 'OK', held: 2 });
  });
  test('S-T25 등급 셈의 순위 읽기는 만료 인덱스 다음에 멈춘 홀드를 잇고, 멈춘 홀드 안의 시작 위치도 지킨다', async () => {
    const e = await openEvent();
    const counts = new RedisSaleCounts(redis);
    const a = await orderedHold(e, [S1, S2]);
    await life.freeze(e, Date.now(), KEEP(), [idx(S1), idx(S2)]);
    expect(a.seats.length).toBe(2);
    await holdOf(e, [S3], ACCOUNT_B);
    expect((await counts.holdIndexes(e, 0, 10)).indexes).toEqual([idx(S3), idx(S1), idx(S2)]);
    expect((await counts.holdIndexes(e, 1, 1)).indexes).toEqual([idx(S1)]);
    expect((await counts.holdIndexes(e, 2, 10)).indexes).toEqual([idx(S2)]);
  });
});

describe('다른 회차 S-T23 ②', () => {
  const seatMap = new MemorySeatMap();
  const refOf = (i: number): SeatRef => ({ seatId: `S${i}`, index: i, sectionId: 'A', sectionIndex: 0, seatOffset: i, tierId: 'R' });
  async function big(): Promise<string> {
    const e = newEvent();
    await store.openSale({ eventId: e, seatCount: 5, keepUntilMs: KEEP() });
    seatMap.put({ eventId: e, layoutVersion: 'v1', seatCount: 5, perAccountLimit: 4, saleEndsAtMs: Date.now() + DAY }, Array.from({ length: 5 }, (_, i) => refOf(i)));
    return e;
  }
  async function orderedDue(e: string, i: number, account: string): Promise<void> {
    const seats = [refOf(i)];
    const ps = `ps-o-${i}`;
    const holdId = `h-o-${i}`;
    held(await store.hold({ eventId: e, accountId: account, purchaseSessionId: ps, holdId, idempotencyKey: `0190f3a1-7c2e-4a00-8000-${String(i).padStart(12, '2')}`, fingerprint: `fo${i}`, seats, limit: 4, keepUntilMs: KEEP() }));
    await life.markOrdered({ eventId: e, holdId, accountId: account, purchaseSessionId: ps, seats }, Date.now() + 2_700_000, KEEP());
    const past = String(Date.now() - 2_000);
    // 주문은 정지 전에 만들었고 만료 시각은 정지 뒤에 지났다(정지가 시간을 멈춰야 하는 홀드)
    await cmd(seatKeys.hold(e, i), ['HSET', seatKeys.hold(e, i), 'exp', past, 'ordAt', String(Date.now() - 300_000)]);
    await cmd(seatKeys.expiry(e), ['ZADD', seatKeys.expiry(e), past, String(i)]);
  }
  test('S-T23 ② 정지가 아닌 회차의 주문 뒤 홀드는 원래 시각대로 풀리고, 정지 회차의 홀드만 멈춘다', async () => {
    const stopped = await big();
    const open = await big();
    await orderedDue(stopped, 0, ACCOUNT_A);
    await orderedDue(open, 0, ACCOUNT_B);
    const answer: PaymentPauseAnswer = { status: 'OK', pauses: [{ eventId: stopped, pausedSinceMs: Date.now() - 60_000 }] };
    const s = new ExpirySweeper({ expiries: store, seatMap, leases: new RedisSweepLeases(redis), clock: systemClock, podId: 'pod-other', pauseView: new HoldPauseView({ read: async () => answer }, systemClock), lifecycle: life });
    await s.tick();
    // 열린 회차는 '열림'을 연속 두 번·1초 뒤에 확정한다(그 전 틱은 판단을 미룬다)
    await new Promise((r) => setTimeout(r, 1_100));
    await s.tick();
    expect(Number(await cmd(seatKeys.bitmap(open), ['GETBIT', seatKeys.bitmap(open), '0']))).toBe(0);
    expect(Number(await cmd(seatKeys.bitmap(stopped), ['GETBIT', seatKeys.bitmap(stopped), '0']))).toBe(1);
    expect(num(await cmd(paused(stopped), ['ZSCORE', paused(stopped), '0']))).not.toBeNull();
  });
});

describe('소유 확인 S-T29', () => {
  test('S-T29 ① 구매 세션 ID가 같아도 계정이 다르면 연장하지 못하고 ext·만료가 그대로다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1]);
    expect(await life.extend({ ...a, accountId: ACCOUNT_B })).toEqual({ kind: 'NOT_FOUND' });
    expect(await field(e, S1, 'ext')).toBe('0');
    expect(await zscore(seatKeys.expiry(e), S1)).toBe(a.exp);
  });
  test('S-T29 ③ 같은 계정의 다른 구매 세션은 연장하지 못한다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1]);
    expect(await life.extend({ ...a, purchaseSessionId: 'other-tab' })).toEqual({ kind: 'NOT_FOUND' });
    expect(await field(e, S1, 'ext')).toBe('0');
  });
  test('S-T29 ② 없는 holdId를 잘못 넘겨도 원래 홀드의 만료·보유 수가 그대로다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1, S3]);
    await life.release({ ...a, holdId: 'no-such-hold' }, KEEP());
    expect(await zscore(seatKeys.expiry(e), S1)).toBe(a.exp);
    expect(num(await cmd(seatKeys.quota(e, ACCOUNT_A), ['GET', seatKeys.quota(e, ACCOUNT_A)]))).toBe(2);
    expect(await bit(e, S3)).toBe(1);
  });
});
