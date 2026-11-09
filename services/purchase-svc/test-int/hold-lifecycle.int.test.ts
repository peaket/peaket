// 홀드 해제·연장·다시 읽기와 결제 정지 멈춤을 실제 Valkey 8.1로 돈다(docs/features/seat-hold.md §5, BUILD_ORDER HOT-070, ADR-0254).
// 시간은 Redis TIME이라, 지난 시각은 홀드 Hash와 만료 인덱스 값을 직접 고쳐 만든다.
import 'reflect-metadata';
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ExpirySweeper, HOLD_EXTENSION_MS, HoldPauseView, type HoldTarget, holdLifecycleKeys, MemorySeatMap, type PaymentPauseAnswer, RedisHoldLifecycle, RedisSeatStore, RedisSweepLeases, type SeatRef, seatKeys } from '../src/modules/inventory/index.js';
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
const quota = async (e: string, a: string) => num(await cmd(seatKeys.quota(e, a), ['GET', seatKeys.quota(e, a)]));

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
/** 홀드를 지난 것으로 만든다(Hash와 만료 인덱스) */
async function makeDue(t: HoldTarget): Promise<void> {
  const past = String(Date.now() - 1_000);
  for (const s of t.seats) {
    await setField(t.eventId, s.seatId, 'exp', past);
    await cmd(seatKeys.expiry(t.eventId), ['ZADD', seatKeys.expiry(t.eventId), past, String(s.index)]);
  }
}
const seatArgs = (t: HoldTarget) => t.seats.map((s) => ({ index: s.index, expected: { holdId: t.holdId, fencingToken: '', owner: t.accountId }, seat: s }));

describe('소유 확인 S-T29', () => {
  test('S-T29 ① 남의 holdId는 읽기·해제·연장 모두 없는 것과 같다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1]);
    const asB: HoldTarget = { ...a, accountId: ACCOUNT_B, purchaseSessionId: 'ps-b' };
    expect(await life.read(asB)).toEqual({ kind: 'NOT_FOUND' });
    expect(await life.release(asB, KEEP())).toEqual({ kind: 'NOT_FOUND' });
    expect(await life.extend(asB)).toEqual({ kind: 'NOT_FOUND' });
    expect(await bit(e, S1)).toBe(1);
    expect(await field(e, S1, 'ext')).toBe('0');
  });
  test('S-T29 ① 구매 세션 ID가 같아도 계정이 다르면 놓거나 늘리지 못한다(소유 계정 대조)', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1]);
    const forged: HoldTarget = { ...a, accountId: ACCOUNT_B };
    expect(await life.read(forged)).toEqual({ kind: 'NOT_FOUND' });
    expect(await life.release(forged, KEEP())).toEqual({ kind: 'NOT_FOUND' });
    expect(await bit(e, S1)).toBe(1);
  });
  test('S-T29 ② 없는 holdId는 NOT_FOUND이고 아무것도 바꾸지 않는다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1]);
    const none = { ...a, holdId: 'no-such-hold' };
    expect(await life.release(none, KEEP())).toEqual({ kind: 'NOT_FOUND' });
    expect(await life.extend(none)).toEqual({ kind: 'NOT_FOUND' });
    expect(await quota(e, ACCOUNT_A)).toBe(1);
  });
  test('S-T29 ③ 같은 계정의 다른 구매 세션은 찾지 못한다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1]);
    const other = { ...a, purchaseSessionId: 'other-tab' };
    expect(await life.read(other)).toEqual({ kind: 'NOT_FOUND' });
    expect(await life.release(other, KEEP())).toEqual({ kind: 'NOT_FOUND' });
    expect(await bit(e, S1)).toBe(1);
  });
  test('S-T29 ④ Hash의 holdId가 바뀌면 해제하지 않는다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1]);
    await setField(e, S1, 'holdId', 'changed');
    expect(await life.release(a, KEEP())).toEqual({ kind: 'NOT_FOUND' });
    expect(await bit(e, S1)).toBe(1);
  });
});

describe('다시 읽기', () => {
  test('살아 있는 홀드의 만료와 연장 여부를 돌려준다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1, S2]);
    expect(await life.read(a)).toMatchObject({ kind: 'OK', expiresAtMs: a.exp, extended: false });
  });
  test('시간이 지난 홀드는 만료 작업이 풀기 전이라도 404다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1]);
    await makeDue(a);
    expect(await life.read(a)).toEqual({ kind: 'NOT_FOUND' });
  });
  test('세대 키가 없으면 NOT_READY다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1]);
    await cmd(seatKeys.epoch(e), ['DEL', seatKeys.epoch(e)]);
    expect(await life.read(a)).toEqual({ kind: 'NOT_READY' });
  });
});

describe('TTL·연장 한도 S-T6', () => {
  test('S-T6 첫 연장은 정확히 3분을 더하고 인덱스도 같이 옮기며, 두 번째는 ALREADY다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1, S2]);
    expect(HOLD_EXTENSION_MS).toBe(180_000);
    const first = await life.extend(a);
    expect(first).toMatchObject({ kind: 'OK', expiresAtMs: a.exp + 180_000 });
    expect(await zscore(seatKeys.expiry(e), S1)).toBe(a.exp + 180_000);
    expect(await zscore(seatKeys.expiry(e), S2)).toBe(a.exp + 180_000);
    expect(await field(e, S2, 'exp')).toBe(String(a.exp + 180_000));
    expect(await life.extend(a)).toEqual({ kind: 'ALREADY' });
    expect(await zscore(seatKeys.expiry(e), S1)).toBe(a.exp + 180_000);
    expect(await life.read(a)).toMatchObject({ kind: 'OK', extended: true });
  });
  test('S-T6 시간이 지난 홀드는 연장되지 않는다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1]);
    await makeDue(a);
    expect(await life.extend(a)).toEqual({ kind: 'NOT_FOUND' });
  });
});

describe('해제와 놓은 좌석 S-T33', () => {
  test('S-T33 ① 해제하면 좌석·보유 수가 돌아오고 같은 계정은 30초 다시 잡지 못한다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1, S2]);
    expect(await life.release(a, KEEP())).toEqual({ kind: 'OK', released: 2 });
    expect([await bit(e, S1), await bit(e, S2)]).toEqual([0, 0]);
    expect(await quota(e, ACCOUNT_A)).toBeNull();
    expect(await zscore(seatKeys.expiry(e), S1)).toBeNull();
    const again = await store.hold(holdInput(e, [S1], { accountId: ACCOUNT_A, keepUntilMs: KEEP() }));
    expect(again.kind).toBe('REHOLD_WAIT');
    const rel = await zscore(seatKeys.rel(e, ACCOUNT_A), S1);
    expect(rel).toBeGreaterThan(Date.now() + 25_000);
    expect(rel).toBeLessThanOrEqual(Date.now() + 31_000);
  });
  test('S-T33 ② 다른 사람은 그 30초 안에 바로 잡는다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1]);
    await life.release(a, KEEP());
    expect((await store.hold(holdInput(e, [S1], { accountId: ACCOUNT_B, keepUntilMs: KEEP() }))).kind).toBe('OK');
  });
  test('해제 사건 RELEASED가 그 홀드의 토큰으로 나간다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S3]);
    await life.release(a, KEEP());
    const rows = (await cmd(seatKeys.stream(e), ['XRANGE', seatKeys.stream(e), '-', '+'])) as unknown[][];
    const last = (rows[rows.length - 1]![1] as unknown[]).map(String);
    expect(last[last.indexOf('type') + 1]).toBe('RELEASED');
    expect(last[last.indexOf('holdId') + 1]).toBe(a.holdId);
    expect(last[last.indexOf('accountId') + 1]).toBe(ACCOUNT_A);
  });
});

describe('좌석이 두 번 팔리지 않음', () => {
  test('풀린 뒤 남이 잡은 좌석을 앞 주인의 늦은 해제·연장이 건드리지 못한다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1]);
    await life.release(a, KEEP());
    const b = await holdOf(e, [S1], ACCOUNT_B);
    expect(await life.release(a, KEEP())).toEqual({ kind: 'NOT_FOUND' });
    expect(await life.extend(a)).toEqual({ kind: 'NOT_FOUND' });
    expect(await field(e, S1, 'holdId')).toBe(b.holdId);
    expect(await bit(e, S1)).toBe(1);
    expect(await quota(e, ACCOUNT_B)).toBe(1);
  });
  test('겹친 해제 둘은 한 번만 푼다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1, S2]);
    const r = await Promise.all([life.release(a, KEEP()), life.release(a, KEEP())]);
    expect(r.map((x) => x.kind).sort()).toEqual(['NOT_FOUND', 'OK']);
    expect(await quota(e, ACCOUNT_A)).toBeNull();
  });
  test('결제 접수 뒤 묶인 홀드는 해제·연장되지 않고 표시는 그대로다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1]);
    await setField(e, S1, 'pin', '1');
    expect(await life.release(a, KEEP())).toEqual({ kind: 'PINNED' });
    expect(await life.extend(a)).toEqual({ kind: 'PINNED' });
    expect(await bit(e, S1)).toBe(1);
  });
  test('다른 좌석이 묶였으면 홀드 전체를 놓지 않는다', async () => {
    const e = await openEvent();
    const a = await holdOf(e, [S1, S2]);
    await setField(e, S2, 'pin', '1');
    expect(await life.release(a, KEEP())).toEqual({ kind: 'PINNED' });
    expect([await bit(e, S1), await bit(e, S2)]).toEqual([1, 1]);
  });
});

describe('정지 집합 전이 S-T23', () => {
  const ordered = (e: string) => holdLifecycleKeys.ordered(e);
  const paused = (e: string) => holdLifecycleKeys.paused(e);
  const orderedHold = async (e: string, seats = [S1], maxStayIn = 45 * 60_000) => {
    const a = await holdOf(e, seats);
    const maxStay = Date.now() + maxStayIn;
    expect(await life.markOrdered(a, maxStay, KEEP())).toEqual({ kind: 'OK', added: seats.length });
    return { a, maxStay };
  };
  test('주문 표시는 소유가 맞을 때만 ordered에 넣고 다시 불러도 점수를 바꾸지 않는다', async () => {
    const e = await openEvent();
    const { a } = await orderedHold(e);
    const first = await zscore(ordered(e), S1);
    expect(first).not.toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    await life.markOrdered(a, Date.now() + 60_000, KEEP());
    expect(await zscore(ordered(e), S1)).toBe(first);
    expect(await life.markOrdered({ ...a, accountId: ACCOUNT_B }, Date.now() + 60_000, KEEP())).toEqual({ kind: 'NOT_FOUND' });
  });
  test('S-T23 ① 옮기면 expiry·ordered에서 빠지고 paused에 남은 시간과 함께 든다', async () => {
    const e = await openEvent();
    const { a, maxStay } = await orderedHold(e);
    const since = Date.now() - 500;
    const r = await life.freeze(e, since, KEEP(), [idx(S1)]);
    expect(r).toMatchObject({ kind: 'OK', moved: 1 });
    expect(await zscore(seatKeys.expiry(e), S1)).toBeNull();
    expect(await zscore(ordered(e), S1)).toBeNull();
    expect(await zscore(paused(e), S1)).toBe(maxStay);
    expect(Number(await field(e, S1, 'rem'))).toBeGreaterThan(a.exp - Date.now());
    expect(await life.read(a)).toMatchObject({ kind: 'OK' });
  });
  test('S-T23 ① 되돌리면 남은 시간에서 이어 세고 ordered에 다시 든다', async () => {
    const e = await openEvent();
    const { a } = await orderedHold(e);
    await life.freeze(e, Date.now(), KEEP(), [idx(S1)]);
    await setField(e, S1, 'rem', '100000');
    const r = await life.thaw(e, KEEP(), [idx(S1)]);
    expect(r).toMatchObject({ kind: 'OK', moved: 1 });
    const score = await zscore(seatKeys.expiry(e), S1);
    expect(score).toBeGreaterThan(Date.now() + 90_000);
    expect(score).toBeLessThanOrEqual(Date.now() + 100_000);
    expect(await zscore(paused(e), S1)).toBeNull();
    expect(await field(e, S1, 'rem')).toBeNull();
    expect(await zscore(ordered(e), S1)).not.toBeNull();
    expect(a.holdId).toBe(await field(e, S1, 'holdId'));
  });
  test('S-T23 ② 주문 전 홀드는 옮겨지지 않는다', async () => {
    const e = await openEvent();
    const b = await holdOf(e, [S2]);
    expect(await life.freeze(e, Date.now(), KEEP(), [idx(S2)])).toMatchObject({ kind: 'OK', moved: 0, corrupt: 1 });
    expect(await zscore(seatKeys.expiry(e), S2)).toBe(b.exp);
  });
  test('S-T23 ③ 최대 체류를 넘기는 되돌리기는 최대 체류로 자르고 ordered에 넣지 않는다', async () => {
    const e = await openEvent();
    await orderedHold(e);
    await life.freeze(e, Date.now(), KEEP(), [idx(S1)]);
    const stay = Date.now() - 10;
    await setField(e, S1, 'maxStay', String(stay));
    await life.thaw(e, KEEP(), [idx(S1)]);
    expect(await zscore(seatKeys.expiry(e), S1)).toBe(stay);
    expect(await zscore(ordered(e), S1)).toBeNull();
  });
  test('옮긴 뒤 해제하면 paused에서도 빠진다', async () => {
    const e = await openEvent();
    const { a } = await orderedHold(e);
    await life.freeze(e, Date.now(), KEEP(), [idx(S1)]);
    expect(await life.release(a, KEEP())).toEqual({ kind: 'OK', released: 1 });
    expect(await zscore(paused(e), S1)).toBeNull();
    expect(await zscore(seatKeys.expiry(e), S1)).toBeNull();
  });
  test('멈춘 동안 연장하면 남은 시간에 3분을 더한다', async () => {
    const e = await openEvent();
    const { a } = await orderedHold(e);
    await life.freeze(e, Date.now(), KEEP(), [idx(S1)]);
    await setField(e, S1, 'rem', '60000');
    expect(await life.extend(a)).toMatchObject({ kind: 'OK' });
    expect(await field(e, S1, 'rem')).toBe('240000');
    expect(await life.extend(a)).toEqual({ kind: 'ALREADY' });
  });
  test('묶인 좌석·지난 최대 체류는 옮기지 않고 ordered에서만 뺀다', async () => {
    const e = await openEvent();
    await orderedHold(e, [S1, S2]);
    await setField(e, S1, 'pin', '1');
    await setField(e, S2, 'maxStay', String(Date.now() - 1));
    expect(await life.freeze(e, Date.now(), KEEP(), [idx(S1), idx(S2)])).toMatchObject({ kind: 'OK', moved: 0, dropped: 2 });
    expect(await zscore(ordered(e), S1)).toBeNull();
    expect(await zscore(paused(e), S1)).toBeNull();
  });
  test('Hash가 없는 멤버는 지워져 앞줄을 막지 않는다', async () => {
    const e = await openEvent();
    await cmd(ordered(e), ['ZADD', ordered(e), '1', String(idx(S3))]);
    expect(await life.freeze(e, Date.now(), KEEP(), [idx(S3)])).toMatchObject({ kind: 'OK', moved: 0, dropped: 1 });
    expect(await zscore(ordered(e), S3)).toBeNull();
  });
  test('만료 Lua는 정지 시작이 주어지면 주문 뒤 홀드를 건너뛰고, 주문 전 홀드는 푼다', async () => {
    const e = await openEvent();
    const { a } = await orderedHold(e, [S1]);
    const b = await holdOf(e, [S2], ACCOUNT_B);
    await makeDue(a);
    await makeDue(b);
    // 정지 시작을 만료 시각보다 앞으로 둔다(지난 것처럼 보여도 남은 시간이 있던 홀드)
    await setField(e, S1, 'ordAt', String(Date.now() - 300_000));
    await setField(e, S1, 'exp', String(Date.now() - 1_000));
    const due = await store.dueExpiries({ eventId: e, nowMs: Date.now() + 5_000, limit: 100 });
    const seats = due.map((d) => ({ index: d.index, expected: d.hold, seat: ref(d.index === idx(S1) ? S1 : S2) }));
    const r = await store.expire({ eventId: e, keepUntilMs: KEEP(), seats, pausedSinceMs: Date.now() - 200_000 });
    expect(r).toMatchObject({ kind: 'OK', released: 1, skipped: 1 });
    expect(await bit(e, S1)).toBe(1);
    expect(await bit(e, S2)).toBe(0);
  });
  test('만료로 풀린 주문 뒤 홀드는 ordered에서도 빠진다', async () => {
    const e = await openEvent();
    const { a } = await orderedHold(e, [S1]);
    await makeDue(a);
    const due = await store.dueExpiries({ eventId: e, nowMs: Date.now() + 5_000, limit: 100 });
    const r = await store.expire({ eventId: e, keepUntilMs: KEEP(), seats: due.map((d) => ({ index: d.index, expected: d.hold, seat: ref(S1) })) });
    expect(r).toMatchObject({ kind: 'OK', released: 1 });
    expect(await zscore(ordered(e), S1)).toBeNull();
  });
  test('묶기는 ordered와 paused에서 그 좌석을 뺀다', async () => {
    const e = await openEvent();
    const { a } = await orderedHold(e, [S1]);
    await life.freeze(e, Date.now(), KEEP(), [idx(S1)]);
    await store.pin({ eventId: e, holdId: a.holdId, accountId: a.accountId, purchaseSessionId: a.purchaseSessionId, seats: a.seats, limit: 4, orderGen: 1, keepUntilMs: KEEP() });
    expect(await zscore(paused(e), S1)).toBeNull();
    expect(await zscore(ordered(e), S1)).toBeNull();
  });
  test('실패 해제도 ordered와 paused에서 뺀다', async () => {
    const e = await openEvent();
    const { a } = await orderedHold(e, [S1]);
    await store.releaseFailed({ eventId: e, holdId: a.holdId, accountId: a.accountId, seats: a.seats, keepUntilMs: KEEP() });
    expect(await zscore(ordered(e), S1)).toBeNull();
  });
});

describe('만료 반복과 결제 정지 S-T23', () => {
  const ordered = (e: string) => holdLifecycleKeys.ordered(e);
  const paused = (e: string) => holdLifecycleKeys.paused(e);
  const seatMap = new MemorySeatMap();
  const put = (e: string, count: number) => seatMap.put({ eventId: e, layoutVersion: 'v1', seatCount: count, perAccountLimit: 4, saleEndsAtMs: Date.now() + DAY }, Array.from({ length: count }, (_, i) => ({ seatId: `S${i}`, index: i, sectionId: 'A', sectionIndex: 0, seatOffset: i, tierId: 'R' })));
  const refOf = (i: number): SeatRef => ({ seatId: `S${i}`, index: i, sectionId: 'A', sectionIndex: 0, seatOffset: i, tierId: 'R' });
  function sweeperOf(source: { read(): Promise<PaymentPauseAnswer> }) {
    const pauseView = new HoldPauseView({ read: () => source.read() }, systemClock);
    return new ExpirySweeper({ expiries: store, seatMap, leases: new RedisSweepLeases(redis), clock: systemClock, podId: 'pod-a', pauseView, lifecycle: life });
  }
  async function bigEvent(count: number): Promise<string> {
    const e = newEvent();
    await store.openSale({ eventId: e, seatCount: count, keepUntilMs: KEEP() });
    put(e, count);
    return e;
  }
  async function holdAt(e: string, i: number, account: string): Promise<HoldTarget> {
    const seats = [refOf(i)];
    const h = held(await store.hold({ eventId: e, accountId: account, purchaseSessionId: `ps-${i}`, holdId: `h-${i}`, idempotencyKey: `0190f3a1-7c2e-4a00-8000-${String(i).padStart(12, '0')}`, fingerprint: `f${i}`, seats, limit: 4, keepUntilMs: KEEP() }));
    return { eventId: e, holdId: h.holdId, accountId: account, purchaseSessionId: `ps-${i}`, seats };
  }
  const due = async (t: HoldTarget) => {
    const past = String(Date.now() - 2_000);
    for (const s of t.seats) {
      await cmd(seatKeys.hold(t.eventId, s.index), ['HSET', seatKeys.hold(t.eventId, s.index), 'exp', past]);
      await cmd(seatKeys.expiry(t.eventId), ['ZADD', seatKeys.expiry(t.eventId), past, String(s.index)]);
    }
  };
  const acct = (i: number) => `acct${String(i).padStart(4, '0')}`;

  test('S-T23 ① 정지면 틱이 주문 뒤 홀드를 옮기고 시간이 지나도 회수하지 않으며, 열림은 연속 두 번째에 되돌린다', async () => {
    const e = await bigEvent(10);
    const a = await holdAt(e, 0, acct(0));
    await life.markOrdered(a, Date.now() + 2_700_000, KEEP());
    const answers: PaymentPauseAnswer[] = [{ status: 'OK', pauses: [{ eventId: e, pausedSinceMs: Date.now() - 1_000 }] }];
    const source = { read: async () => answers[answers.length - 1]! };
    const s = sweeperOf(source);
    await s.tick();
    expect(num(await cmd(paused(e), ['ZSCORE', paused(e), '0']))).not.toBeNull();
    expect(num(await cmd(seatKeys.expiry(e), ['ZSCORE', seatKeys.expiry(e), '0']))).toBeNull();
    expect(Number(await cmd(seatKeys.bitmap(e), ['GETBIT', seatKeys.bitmap(e), '0']))).toBe(1);
    answers.push({ status: 'OK', pauses: [] });
    await s.tick();
    expect(num(await cmd(paused(e), ['ZSCORE', paused(e), '0']))).not.toBeNull();
    await s.tick();
    expect(num(await cmd(paused(e), ['ZSCORE', paused(e), '0']))).toBeNull();
    expect(num(await cmd(seatKeys.expiry(e), ['ZSCORE', seatKeys.expiry(e), '0']))).not.toBeNull();
    expect(num(await cmd(ordered(e), ['ZSCORE', ordered(e), '0']))).not.toBeNull();
  });
  test('S-T23 ⑤ 주문 뒤 홀드 230개를 한 틱에 옮겨 만료 인덱스에 남지 않고, 버린 주문 전 홀드는 그 틱에 회수된다', async () => {
    const e = await bigEvent(240);
    for (let i = 0; i < 230; i += 1) await life.markOrdered(await holdAt(e, i, acct(i)), Date.now() + 2_700_000, KEEP());
    const abandoned = await holdAt(e, 230, acct(230));
    await due(abandoned);
    const s = sweeperOf({ read: async () => ({ status: 'OK', pauses: [{ eventId: e, pausedSinceMs: Date.now() - 500 }] }) });
    const t = await s.tick();
    expect(num(await cmd(paused(e), ['ZCARD', paused(e)]))).toBe(230);
    expect(num(await cmd(ordered(e), ['ZCARD', ordered(e)]))).toBe(0);
    expect(num(await cmd(seatKeys.expiry(e), ['ZCARD', seatKeys.expiry(e)]))).toBe(0);
    expect(t.events.find((x) => x.eventId === e)).toMatchObject({ released: 1 });
    expect(Number(await cmd(seatKeys.bitmap(e), ['GETBIT', seatKeys.bitmap(e), '230']))).toBe(0);
  }, 30_000);
  test('S-T23 ③ 정지 중 최대 체류에 닿으면 expiry로 돌려놓아 같은 틱에 풀린다', async () => {
    const e = await bigEvent(10);
    const a = await holdAt(e, 1, acct(1));
    await life.markOrdered(a, Date.now() + 2_700_000, KEEP());
    await life.freeze(e, Date.now(), KEEP(), [1]);
    const past = Date.now() - 1_000;
    await cmd(seatKeys.hold(e, 1), ['HSET', seatKeys.hold(e, 1), 'maxStay', String(past)]);
    await cmd(paused(e), ['ZADD', paused(e), String(past), '1']);
    const s = sweeperOf({ read: async () => ({ status: 'OK', pauses: [{ eventId: e, pausedSinceMs: Date.now() - 5_000 }] }) });
    await s.tick();
    expect(Number(await cmd(seatKeys.bitmap(e), ['GETBIT', seatKeys.bitmap(e), '1']))).toBe(0);
    expect(num(await cmd(paused(e), ['ZCARD', paused(e)]))).toBe(0);
  });
  test('망가진 좌석 100개가 앞줄에 있어도 뒤의 정상 홀드를 그 틱에 푼다(ADR-0254 결정 6)', async () => {
    const e = await bigEvent(150);
    const past = Date.now() - 60_000;
    for (let i = 0; i < 120; i += 1) {
      await cmd(seatKeys.hold(e, i), ['HSET', seatKeys.hold(e, i), 'holdId', `bad-${i}`]);
      await cmd(seatKeys.expiry(e), ['ZADD', seatKeys.expiry(e), String(past + i), String(i)]);
    }
    const good = await holdAt(e, 140, acct(140));
    await due(good);
    const s = new ExpirySweeper({ expiries: store, seatMap, leases: new RedisSweepLeases(redis), clock: systemClock, podId: 'pod-a' });
    const t = await s.tick();
    expect(Number(await cmd(seatKeys.bitmap(e), ['GETBIT', seatKeys.bitmap(e), '140']))).toBe(0);
    expect(t.events.find((x) => x.eventId === e)).toMatchObject({ released: 1 });
  });
});
