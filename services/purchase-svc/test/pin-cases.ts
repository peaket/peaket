// 좌석 묶기(SeatPins.pin)·결제 실패 해제(SeatPins.releaseFailed) 계약 사례(BUILD_ORDER PRF-142, docs/features/seat-hold.md §6 '좌석 묶기와 실패 해제의 첫 구현',
// docs/data.md §4 '좌석 묶기·실패 해제·판 번호', src/modules/inventory/adapters/pin-lua.ts, 명세 specs/seat.qnt의 pin·releaseFailed·inv_noOversell).
// 메모리 저장소(test/pin.test.ts)와 실제 Valkey 8.1 Lua(test-int/pin.int.test.ts)에 똑같이 돈다.
// Lua 안의 시각은 Redis TIME이라 바꿀 수 없다. 그래서 '내 홀드가 만료돼 빈 좌석이 됨'은 홀드 Hash exp와 만료 인덱스 점수를 1분 전으로 써 넣은 뒤
// 실제 만료(dueExpiries → expire)를 돌려 만든다(expiry-cases.ts와 같은 방식, 고정 sleep 없음).
// 판정은 지금 상태로만 한다(좌석마다 내 홀드·빈 좌석·남의 좌석). 그래서 '내 홀드가 풀린 뒤 남이 잡은 좌석'은 남이 처음부터 잡은 좌석으로 만든다
// (만료를 돌리면 같은 계정의 방금 놓은 좌석 30초가 걸려 '같은 계정의 다른 홀드'를 만들 수 없다).
import { randomUUID } from 'node:crypto';
import { type Clock, systemClock, uuidv7 } from '@peaket/platform';
import { expect, test } from 'vitest';
import {
  assertPinInput,
  assertReleaseFailedInput,
  EXPIRY_BATCH_SIZE,
  routeStreamEntry,
  type ExpireSeat,
  HOLD_TTL_MS,
  INITIAL_SEAT_GEN,
  type PinInput,
  type PinResult,
  type ReleaseFailedInput,
  SEAT_STATE_AVAILABLE,
  SEAT_STATE_HELD,
  type SeatExpiries,
  type SeatPins,
  type SeatRef,
  type SeatStore,
  seatKeys,
} from '../src/modules/inventory/index.js';
import { expireSeatsOf, okOf } from './expiry-cases.js';
import { ACCOUNT_A, ACCOUNT_B, ACCOUNT_C, ACCOUNT_D, DAY, held, holdInput, idx, newEvent, ref, SEAT_COUNT, SEAT_DEFS } from './hold-cases.js';

/** 저장소 하나와 그 키를 직접 채우고 읽는 도구. 키 이름은 docs/data.md §3(seatKeys)이다. 상태는 저장소 메서드가 아니라 이 도구로 읽는다 */
export interface PinHarness {
  store: SeatStore & SeatExpiries & SeatPins;
  /** 시험 쪽 지금. 메모리는 저장소에 넣은 가짜 시계, Valkey는 시스템 시계(Lua는 Redis TIME) */
  clock: Clock;
  /** 저장소가 정한 시각(heldAt·occurredAt)과 clock.now()의 허용 차이(ms). 메모리는 0 */
  skewMs: number;
  /** 회차 키를 쓰기 전에 한 번 부른다(Valkey: 그 회차 구역 채널을 샤드 Pub/Sub로 구독한다) */
  prepare?(eventId: string): Promise<void>;
  /** 그 회차 구역 채널로 보낸 샤드 Pub/Sub(보낸 차례). 메모리는 저장소가 적은 것, Valkey는 prepare에서 구독한 연결이 받은 것 */
  published(eventId: string): Promise<{ channel: string; message: string }[]>;

  setQuota(eventId: string, accountId: string, n: number): Promise<void>;
  /** 회차의 마지막 펜싱 토큰 fence를 그 글로 둔다(시험 검토 B: 시계보다 앞선 fence) */
  setFence(eventId: string, value: string): Promise<void>;
  setCtl(eventId: string, fields: Record<string, string>): Promise<void>;
  /** 세대 키를 지운다(S-T26 ③) */
  dropEpoch(eventId: string): Promise<void>;
  /**
   * 세대 키의 다시 만들기 판 번호 gen 칸을 쓴다(null이면 칸을 지운다: gen 칸이 없는 옛 세대 키). Valkey는 HSET/HDEL epoch gen.
   * 메모리는 MemorySeatEvent.epoch.gen(수)으로 둔다고 본다(뼈대에 칸이 없어 이 시험이 자리를 정한다)
   */
  setGen(eventId: string, gen: number | null): Promise<void>;
  /** 홀드 Hash를 통째로 쓴다(있던 칸은 지운다). null이면 키를 지운다 */
  setHoldRaw(eventId: string, index: number, fields: Record<string, string> | null): Promise<void>;
  /** 홀드 Hash 칸 하나를 바꾼다 */
  setHoldField(eventId: string, index: number, field: string, value: string): Promise<void>;
  /** 만료 인덱스에 멤버(색인 글)와 점수를 쓴다 */
  setExpiry(eventId: string, member: string, score: number): Promise<void>;

  bit(eventId: string, index: number): Promise<number>;
  /** 홀드 Hash의 칸(값은 모두 글). 없으면 null */
  holdHash(eventId: string, index: number): Promise<Record<string, string> | null>;
  expiryScore(eventId: string, index: number): Promise<number | null>;
  quota(eventId: string, accountId: string): Promise<number | null>;
  fence(eventId: string): Promise<string | null>;
  /** secver: 구역 색인(글) → 번호 */
  secver(eventId: string): Promise<Record<string, number>>;
  /** Stream 항목의 칸(XADD 차례, 항목 ID 없이) */
  stream(eventId: string): Promise<Record<string, string>[]>;
  /** rel:{account}: 색인(글) → 점수. 키가 없으면 {} */
  rel(eventId: string, accountId: string): Promise<Record<string, number>>;
  /** 키의 PEXPIREAT 시각(epoch ms). 키가 없거나 만료가 없으면 null */
  expireAt(eventId: string, key: string): Promise<number | null>;
  epoch(eventId: string): Promise<{ epoch: number; node: string } | null>;
  /** 세대 키의 gen 칸(수). 칸이나 키가 없으면 null */
  gen(eventId: string): Promise<number | null>;
}

/** 주문 하나(결제 접수 때 정해진 계정·holdId·구매 세션·좌석). holdId는 UUID, 구매 세션은 키 조각이다(기본값은 UUID) */
interface Order {
  accountId: string;
  holdId: string;
  purchaseSessionId: string;
  /** 좌석 ID 오름차순 */
  seatIds: string[];
}

/** '시간이 지난 홀드'를 만들 때 쓰는 과거(앱 시계보다 1분 전. Docker VM 시계 차이 5초보다 넉넉하다) */
const PAST_MS = 60_000;
const ACCOUNTS = [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C, ACCOUNT_D];

/** 회차 키 전체의 모습('아무것도 바뀌지 않았다'를 보려고 앞뒤로 견준다) */
async function look(h: PinHarness, e: string) {
  const all = SEAT_DEFS.map((d) => d.index);
  return {
    bits: await Promise.all(all.map((i) => h.bit(e, i))),
    holds: await Promise.all(all.map((i) => h.holdHash(e, i))),
    expiry: await Promise.all(all.map((i) => h.expiryScore(e, i))),
    holdExpire: await Promise.all(all.map((i) => h.expireAt(e, seatKeys.hold(e, i)))),
    quota: await Promise.all(ACCOUNTS.map((a) => h.quota(e, a))),
    quotaExpire: await Promise.all(ACCOUNTS.map((a) => h.expireAt(e, seatKeys.quota(e, a)))),
    rel: await Promise.all(ACCOUNTS.map((a) => h.rel(e, a))),
    fence: await h.fence(e),
    epoch: await h.epoch(e),
    gen: await h.gen(e),
    secver: await h.secver(e),
    stream: await h.stream(e),
    published: (await h.published(e)).length,
    expire: await Promise.all([seatKeys.bitmap(e), seatKeys.expiry(e), seatKeys.fence(e), seatKeys.stream(e), seatKeys.secver(e), seatKeys.epoch(e)].map((k) => h.expireAt(e, k))),
  };
}

/** 결과가 OK인지 보고 꺼낸다 */
function okPin(r: PinResult): Extract<PinResult, { kind: 'OK' }> {
  expect(r.kind).toBe('OK');
  if (r.kind !== 'OK') throw new Error(`OK가 아니다: ${JSON.stringify(r)}`);
  return r;
}

/** 다시 잡은 좌석의 Stream HELD 한 줄(hold-lua.ts·data.md §3의 HELD 칸) */
const heldRow = (id: string, o: Order, token: number, sectionVersion: number, seatEpoch: number | undefined, nowMs: number) => ({
  type: 'HELD',
  seatIdx: String(idx(id)),
  seatId: id,
  tierId: ref(id).tierId,
  sectionId: ref(id).sectionId,
  holdId: o.holdId,
  holdKind: 'FAN',
  purchaseSessionId: o.purchaseSessionId,
  accountId: o.accountId,
  fencingToken: String(token),
  sectionVersion: String(sectionVersion),
  seatEpoch: String(seatEpoch),
  occurredAtMs: String(nowMs),
  expiresAtMs: String(nowMs + HOLD_TTL_MS),
});

/** 푼 좌석의 Stream RELEASED 한 줄(expire-lua.ts EXPIRED와 같은 칸, 값은 풀기 전 홀드 Hash에서) */
const releasedRow = (id: string, hash: Record<string, string>, sectionVersion: number, seatEpoch: number | undefined, nowMs: number) => ({
  type: 'RELEASED',
  seatIdx: String(idx(id)),
  seatId: id,
  tierId: ref(id).tierId,
  sectionId: ref(id).sectionId,
  holdId: hash.holdId,
  holdKind: hash.kind,
  purchaseSessionId: hash.psid,
  accountId: hash.owner,
  fencingToken: hash.fence,
  sectionVersion: String(sectionVersion),
  seatEpoch: String(seatEpoch),
  occurredAtMs: String(nowMs),
  expiresAtMs: hash.exp,
});

/** 좌석 ID 오름차순 A01 ~ A{n}(n ≤ 20) */
const aSeats = (n: number) => Array.from({ length: n }, (_, i) => `A${String(i + 1).padStart(2, '0')}`);

export function pinCases(make: () => Promise<PinHarness>): void {
  async function world(o: { open?: boolean } = {}) {
    const h = await make();
    const e = newEvent();
    await h.prepare?.(e);
    const keepUntilMs = h.clock.now() + 2 * DAY;
    const opened = o.open === false ? undefined : await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    const order = (seatIds: readonly string[], c: Partial<Omit<Order, 'seatIds'>> = {}): Order => ({
      accountId: c.accountId ?? ACCOUNT_A,
      holdId: c.holdId ?? uuidv7(systemClock),
      purchaseSessionId: c.purchaseSessionId ?? randomUUID(),
      seatIds: [...seatIds].sort(),
    });
    /** 주문의 holdId·구매 세션으로 그 좌석을 잡는다(홀드 Lua) */
    const hold = async (x: Order, limit = 4) =>
      held(await h.store.hold(holdInput(e, x.seatIds, { accountId: x.accountId, holdId: x.holdId, purchaseSessionId: x.purchaseSessionId, keepUntilMs, limit })));
    const pinInput = (x: Order, c: Partial<PinInput> = {}): PinInput => ({
      eventId: e,
      accountId: x.accountId,
      purchaseSessionId: x.purchaseSessionId,
      holdId: x.holdId,
      seats: x.seatIds.map(ref),
      limit: 4,
      orderGen: 1,
      keepUntilMs,
      ...c,
    });
    const pin = (x: Order, c: Partial<PinInput> = {}) => h.store.pin(pinInput(x, c));
    const releaseInput = (x: Order, c: Partial<ReleaseFailedInput> = {}): ReleaseFailedInput => ({ eventId: e, accountId: x.accountId, holdId: x.holdId, seats: x.seatIds.map(ref), keepUntilMs, ...c });
    const release = (x: Order, c: Partial<ReleaseFailedInput> = {}) => h.store.releaseFailed(releaseInput(x, c));
    /** 좌석들의 홀드가 시간이 지나 실제 만료로 풀린다(Hash exp·만료 인덱스 점수를 1분 전으로 → dueExpiries → expire). 다 풀렸는지 본다 */
    const expireNow = async (seatIds: readonly string[]) => {
      const at = h.clock.now() - PAST_MS;
      for (const id of seatIds) {
        await h.setHoldField(e, idx(id), 'exp', String(at));
        await h.setExpiry(e, String(idx(id)), at);
      }
      const d = await h.store.dueExpiries({ eventId: e, nowMs: h.clock.now(), limit: EXPIRY_BATCH_SIZE });
      const r = okOf(await h.store.expire({ eventId: e, keepUntilMs, seats: expireSeatsOf(d) }));
      expect(r.released, '준비: 만료로 풀린 좌석 수').toBe(seatIds.length);
      for (const id of seatIds) expect(await h.bit(e, idx(id)), `준비: ${id} 비트`).toBe(0);
    };
    /** 새로 더해진 Stream 항목(앞서 센 길이 뒤) */
    const streamAfter = async (n: number) => (await h.stream(e)).slice(n);
    return { h, e, keepUntilMs, seatEpoch: opened?.seatEpoch, order, hold, pinInput, pin, releaseInput, release, expireNow, streamAfter };
  }

  // ---- 판 번호(세대 키 gen 칸) ----

  test(`pin_ 판매 열기는 세대 키에 gen 칸 1(INITIAL_SEAT_GEN)을 두고, 다시 불러도 바꾸지 않는다(다시 만들기가 올린 판 번호를 되돌리지 않는다)`, async () => {
    const { h, e, keepUntilMs } = await world();
    expect(INITIAL_SEAT_GEN).toBe(1);
    expect(await h.gen(e)).toBe(1);
    await h.setGen(e, 5);
    expect((await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs })).created).toBe(false);
    expect(await h.gen(e)).toBe(5);
  });

  // ---- 묶기: 내 홀드만 ----

  test(`pin_ 내 홀드(같은 holdId·owner)만인 주문을 묶으면 OK(gen 1, 다시 잡은 수 0)이고 홀드 Hash에 pin '1'을 더하고 만료 인덱스에서 뺀다. 비트·다른 칸·보유 수·fence·secver·Stream·델타·키 수명은 그대로다 [ASVS v5.0.0-15.4.2]`, async () => {
    const { h, e, order, hold, pin } = await world();
    const o = order(['A01', 'A02', 'B01']);
    await hold(o);
    // 이웃: 다른 계정의 묶지 않은 홀드는 만료 인덱스에 남는다
    const rb = await hold(order(['A03'], { accountId: ACCOUNT_B }));
    const before = await look(h, e);
    expect(await pin(o)).toEqual({ kind: 'OK', gen: 1, regrabbed: 0 });
    const after = await look(h, e);
    for (const id of o.seatIds) {
      const i = idx(id);
      expect({ id, bit: after.bits[i], hold: after.holds[i], score: after.expiry[i] }).toEqual({ id, bit: 1, hold: { ...before.holds[i], pin: '1' }, score: null });
    }
    expect(await h.expiryScore(e, idx('A03'))).toBe(rb.expiresAtMs);
    expect((await h.holdHash(e, idx('A03')))?.pin).toBeUndefined();
    // 묶은 좌석의 Hash·만료 인덱스 말고는 하나도 바뀌지 않았다
    expect({ ...after, holds: null, expiry: null }).toEqual({ ...before, holds: null, expiry: null });
  });

  test(`pin_inv_noOversell_ 묶은 좌석은 시간이 지나도 만료로 풀리지 않는다: 만료 인덱스에 없어 1단계가 읽지 않고, 그 홀드를 기대값으로 만료 Lua를 불러도 건너뛴다(비트·Hash·보유 수 그대로). 묶지 않은 이웃 홀드는 같은 호출에서 풀린다 [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.2]`, async () => {
    const { h, e, keepUntilMs, order, hold, pin } = await world();
    const o = order(['A01', 'A02']);
    const r = await hold(o);
    await hold(order(['A05'], { accountId: ACCOUNT_B }));
    okPin(await pin(o));
    // 셋 모두 홀드 시간이 지났다(묶은 좌석은 Hash exp만, 이웃은 Hash exp와 만료 인덱스 점수)
    const at = h.clock.now() - PAST_MS;
    for (const id of ['A01', 'A02', 'A05']) await h.setHoldField(e, idx(id), 'exp', String(at));
    await h.setExpiry(e, String(idx('A05')), at);
    const pinnedHashes = await Promise.all(o.seatIds.map((id) => h.holdHash(e, idx(id))));
    // 1단계: 홀드 시간(7분)을 넘긴 지금으로 읽어도 묶은 좌석은 없다
    const d = await h.store.dueExpiries({ eventId: e, nowMs: h.clock.now() + HOLD_TTL_MS + PAST_MS, limit: EXPIRY_BATCH_SIZE });
    expect(d.map((x) => x.index)).toEqual([idx('A05')]);
    // 2단계: 묶은 좌석을 그 홀드의 기대값 그대로 넣어도 만료 인덱스에 없어 건너뛴다
    const expected = { holdId: o.holdId, fencingToken: String(r.fencingToken), owner: ACCOUNT_A };
    const seats: ExpireSeat[] = [...o.seatIds.map((id): ExpireSeat => ({ index: idx(id), expected, seat: ref(id) })), ...expireSeatsOf(d)];
    const x = okOf(await h.store.expire({ eventId: e, keepUntilMs, seats }));
    expect({ released: x.released, skipped: x.skipped, orphans: x.orphans }).toEqual({ released: 1, skipped: 2, orphans: 0 });
    expect(await h.bit(e, idx('A05'))).toBe(0);
    for (const [k, id] of o.seatIds.entries()) {
      expect({ id, bit: await h.bit(e, idx(id)), hold: await h.holdHash(e, idx(id)) }).toEqual({ id, bit: 1, hold: pinnedHashes[k] });
    }
    expect(await h.quota(e, ACCOUNT_A)).toBe(2);
    expect((await h.stream(e)).filter((s) => s.type === 'EXPIRED').map((s) => s.seatId)).toEqual(['A05']);
  });

  // ---- 묶기: 빈 좌석 다시 잡기(S-T7) ----

  test(`pin_ST7_ 내 홀드가 만료돼 빈 좌석이 된 주문을 묶으면(orderGen = gen 1) 새 펜싱 토큰으로 다시 잡는다: 비트 1, 홀드 Hash(입력 holdId·owner·psid·새 토큰·heldAt 지금·exp 지금 + 7분·kind FAN·ext 0·pin 1), 만료 인덱스에 없음, 보유 수 += 빈 좌석 수, fence = 새 토큰, 새 키에 keepUntil [S-T7] [S-T5] [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.2]`, async () => {
    const { h, e, keepUntilMs, order, hold, pin, expireNow, streamAfter } = await world();
    const o = order(['A01', 'A02']);
    const r1 = await hold(o);
    await expireNow(o.seatIds);
    expect(await h.quota(e, ACCOUNT_A)).toBeNull();
    const fenceBefore = await h.fence(e);
    expect(fenceBefore).toBe(String(r1.fencingToken));
    const n = (await h.stream(e)).length;
    const r = okPin(await pin(o));
    expect({ gen: r.gen, regrabbed: r.regrabbed }).toEqual({ gen: 1, regrabbed: 2 });
    const token = r.fencingToken!;
    expect(Number.isSafeInteger(token)).toBe(true);
    expect(token).toBeGreaterThan(Number(fenceBefore));
    expect(await h.fence(e)).toBe(String(token));
    // 지금(저장소 시각) = 새 HELD 항목의 occurredAtMs
    const rows = await streamAfter(n);
    expect(rows).toHaveLength(2);
    const now = Number(rows[0]!.occurredAtMs);
    expect(Math.abs(now - h.clock.now())).toBeLessThanOrEqual(h.skewMs);
    for (const id of o.seatIds) {
      expect({ id, bit: await h.bit(e, idx(id)), score: await h.expiryScore(e, idx(id)) }).toEqual({ id, bit: 1, score: null });
      expect({ id, hold: await h.holdHash(e, idx(id)) }).toEqual({
        id,
        hold: { holdId: o.holdId, owner: ACCOUNT_A, psid: o.purchaseSessionId, fence: String(token), heldAt: String(now), exp: String(now + HOLD_TTL_MS), kind: 'FAN', ext: '0', pin: '1', lim: '4' },
      });
      // DEL 뒤 다시 쓴 홀드 Hash에 수명이 없으면 영원히 남는다(hold-lua.ts와 같은 키 수명 규칙)
      expect({ id, at: await h.expireAt(e, seatKeys.hold(e, idx(id))) }).toEqual({ id, at: keepUntilMs });
    }
    expect(await h.quota(e, ACCOUNT_A)).toBe(2);
    expect(await h.expireAt(e, seatKeys.quota(e, ACCOUNT_A))).toBe(keepUntilMs);
  });

  test(`pin_ST35_ 다시 잡은 좌석마다 Stream HELD 한 건(hold-lua와 같은 칸, fencingToken = 새 토큰, occurredAtMs = 지금, expiresAtMs = 지금 + 7분), 바뀐 구역마다 secver +1(구역마다 한 번), 샤드 Pub/Sub 델타는 상태 1이다 [S-T5]`, async () => {
    const { h, e, seatEpoch, order, hold, pin, expireNow, streamAfter } = await world();
    const o = order(['A01', 'A02', 'B01']);
    await hold(o);
    await expireNow(o.seatIds);
    // 홀드 +1, 만료 +1
    expect(await h.secver(e)).toEqual({ '0': 2, '1': 2 });
    const n = (await h.stream(e)).length;
    const p = (await h.published(e)).length;
    const r = okPin(await pin(o));
    expect(r.regrabbed).toBe(3);
    const rows = await streamAfter(n);
    const now = Number(rows[0]?.occurredAtMs);
    expect(rows).toEqual([heldRow('A01', o, r.fencingToken!, 3, seatEpoch, now), heldRow('A02', o, r.fencingToken!, 3, seatEpoch, now), heldRow('B01', o, r.fencingToken!, 3, seatEpoch, now)]);
    expect(await h.secver(e)).toEqual({ '0': 3, '1': 3 });
    expect(SEAT_STATE_HELD).toBe(1);
    expect((await h.published(e)).slice(p)).toEqual([
      { channel: seatKeys.section(e, '0'), message: `1 ${seatEpoch} 0 3 ${now} ${ref('A01').seatOffset}:1 ${ref('A02').seatOffset}:1` },
      { channel: seatKeys.section(e, '1'), message: `1 ${seatEpoch} 1 3 ${now} ${ref('B01').seatOffset}:1` },
    ]);
  });

  test(`pin_ST7_ 내 홀드와 빈 좌석이 섞인 주문은 빈 좌석만 다시 잡고(그 구역만 secver +1·델타·HELD) 둘 다 묶는다. 내 홀드 좌석의 토큰·exp는 그대로다 [S-T7] [ASVS v5.0.0-15.4.2]`, async () => {
    const { h, e, seatEpoch, order, hold, pin, expireNow, streamAfter } = await world();
    const o = order(['A01', 'B01']);
    const r1 = await hold(o);
    await expireNow(['B01']);
    expect(await h.quota(e, ACCOUNT_A)).toBe(1);
    const a01 = await h.holdHash(e, idx('A01'));
    expect(a01?.fence).toBe(String(r1.fencingToken));
    expect(await h.secver(e)).toEqual({ '0': 1, '1': 2 });
    const n = (await h.stream(e)).length;
    const p = (await h.published(e)).length;
    const r = okPin(await pin(o));
    expect({ gen: r.gen, regrabbed: r.regrabbed }).toEqual({ gen: 1, regrabbed: 1 });
    const rows = await streamAfter(n);
    const now = Number(rows[0]?.occurredAtMs);
    expect(rows).toEqual([heldRow('B01', o, r.fencingToken!, 3, seatEpoch, now)]);
    expect(await h.holdHash(e, idx('A01'))).toEqual({ ...a01, pin: '1' });
    expect(await h.holdHash(e, idx('B01'))).toMatchObject({ holdId: o.holdId, owner: ACCOUNT_A, fence: String(r.fencingToken), exp: String(now + HOLD_TTL_MS), pin: '1' });
    for (const id of o.seatIds) expect({ id, bit: await h.bit(e, idx(id)), score: await h.expiryScore(e, idx(id)) }).toEqual({ id, bit: 1, score: null });
    expect(await h.quota(e, ACCOUNT_A)).toBe(2);
    expect(await h.secver(e)).toEqual({ '0': 1, '1': 3 });
    expect((await h.published(e)).slice(p)).toEqual([{ channel: seatKeys.section(e, '1'), message: `1 ${seatEpoch} 1 3 ${now} ${ref('B01').seatOffset}:1` }]);
  });

  test(`pin_ST7_ 비트가 0인데 옛 홀드 Hash가 남은 좌석도 빈 좌석이다: 있던 칸을 지우고 새로 쓴다`, async () => {
    const { h, e, order, pin } = await world();
    const o = order(['A04']);
    await h.setHoldRaw(e, idx('A04'), { holdId: o.holdId, owner: ACCOUNT_A, psid: 'old', fence: '1', heldAt: '1', exp: '2', kind: 'FAN', ext: '1', orderedAt: '123' });
    const r = okPin(await pin(o));
    expect(r.regrabbed).toBe(1);
    const hash = await h.holdHash(e, idx('A04'));
    expect(Object.keys(hash ?? {}).sort()).toEqual(['exp', 'ext', 'fence', 'heldAt', 'holdId', 'kind', 'lim', 'owner', 'pin', 'psid']);
    expect(hash).toMatchObject({ psid: o.purchaseSessionId, fence: String(r.fencingToken), ext: '0', pin: '1' });
    expect(await h.bit(e, idx('A04'))).toBe(1);
  });

  // ---- 묶기: 거절(아무것도 쓰지 않는다) ----

  test(`pin_ST7_inv_noOversell_ 한 좌석이라도 남의 좌석이면 TAKEN(좌석 차례로 첫 남의 좌석의 좌석 색인)이고 아무것도 쓰지 않는다: 내 좌석에도 pin이 생기지 않고 만료 인덱스 그대로. 남 = 다른 계정·같은 계정의 다른 홀드·같은 holdId의 다른 owner·Hash 없는 켜진 비트 [S-T7] [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.2]`, async () => {
    const variants = ['다른 계정', '같은 계정의 다른 홀드', '같은 holdId의 다른 owner', 'Hash 없는 켜진 비트'] as const;
    for (const v of variants) {
      const { h, e, order, hold, pin } = await world();
      // 주문 좌석 A01·A05·B03 가운데 내 홀드는 A01뿐이다. A05(좌석 차례 둘째, 색인 4)와 B03(셋째)은 남의 좌석이다
      const o = order(['A01', 'A05', 'B03']);
      await hold(order(['A01'], { holdId: o.holdId, purchaseSessionId: o.purchaseSessionId }));
      if (v === '다른 계정') await hold(order(['A05'], { accountId: ACCOUNT_B }));
      if (v === '같은 계정의 다른 홀드') await hold(order(['A05'], { accountId: ACCOUNT_A }));
      if (v === '같은 holdId의 다른 owner') await hold(order(['A05'], { accountId: ACCOUNT_B, holdId: o.holdId }));
      if (v === 'Hash 없는 켜진 비트') {
        await hold(order(['A05'], { accountId: ACCOUNT_B }));
        await h.setHoldRaw(e, idx('A05'), null);
      }
      await hold(order(['B03'], { accountId: ACCOUNT_C }));
      const before = await look(h, e);
      expect.soft({ v, r: await pin(o) }).toEqual({ v, r: { kind: 'TAKEN', seatIndex: idx('A05') } });
      expect.soft({ v, s: await look(h, e) }).toEqual({ v, s: before });
    }
  });

  test(`pin_ST5_ 빈 좌석이 있고 orderGen이 세대 키 gen과 다르면 STALE_GEN(지금 gen)이고 아무것도 쓰지 않는다. 같으면 다시 잡는다. gen 칸이 없으면 1로 본다 [S-T5] [ASVS v5.0.0-2.3.4]`, async () => {
    const a = await world();
    const o = a.order(['A01', 'A02']);
    await a.hold(o);
    await a.expireNow(['A02']);
    await a.h.setGen(a.e, 2);
    const before = await look(a.h, a.e);
    for (const orderGen of [1, 3]) {
      expect({ orderGen, r: await a.pin(o, { orderGen }) }).toEqual({ orderGen, r: { kind: 'STALE_GEN', gen: 2 } });
      expect({ orderGen, s: await look(a.h, a.e) }).toEqual({ orderGen, s: before });
    }
    const r = okPin(await a.pin(o, { orderGen: 2 }));
    expect({ gen: r.gen, regrabbed: r.regrabbed }).toEqual({ gen: 2, regrabbed: 1 });

    // gen 칸이 없는 옛 세대 키는 판 번호 1이다
    const b = await world();
    const o2 = b.order(['A01']);
    await b.hold(o2);
    await b.expireNow(['A01']);
    await b.h.setGen(b.e, null);
    const before2 = await look(b.h, b.e);
    expect(await b.pin(o2, { orderGen: 2 })).toEqual({ kind: 'STALE_GEN', gen: 1 });
    expect(await look(b.h, b.e)).toEqual(before2);
    expect(okPin(await b.pin(o2, { orderGen: 1 }))).toMatchObject({ gen: 1, regrabbed: 1 });
  });

  test(`pin_ 빈 좌석이 없으면(모두 내 홀드) orderGen이 gen과 달라도 OK이고 지금 gen을 돌려준다(다시 잡지 않으므로 판 번호를 보지 않는다)`, async () => {
    const { h, e, order, hold, pin } = await world();
    const o = order(['A01', 'A02']);
    await hold(o);
    await h.setGen(e, 3);
    expect(await pin(o, { orderGen: 1 })).toEqual({ kind: 'OK', gen: 3, regrabbed: 0 });
    expect((await h.holdHash(e, idx('A01')))?.pin).toBe('1');
  });

  test(`pin_POL011_ 보유 수 + 빈 좌석 수가 한도와 같으면 다시 잡고, 넘으면 QUOTA_EXCEEDED이며 아무것도 쓰지 않는다. 내 홀드 좌석은 이미 보유 수에 있어 다시 세지 않는다 [ASVS v5.0.0-2.3.2]`, async () => {
    const { h, e, order, hold, pin, expireNow } = await world();
    const o = order(['A01', 'A02']);
    await hold(o);
    // 같은 계정의 다른 주문 하나(보유 수에 1)
    await hold(order(['A09']));
    await expireNow(['A02']);
    // 보유 2(A01·A09) + 빈 1(A02)
    expect(await h.quota(e, ACCOUNT_A)).toBe(2);
    const before = await look(h, e);
    expect(await pin(o, { limit: 2 })).toEqual({ kind: 'QUOTA_EXCEEDED' });
    expect(await look(h, e)).toEqual(before);
    // 한도 3 = 보유 2 + 빈 1(주문 좌석 2개를 모두 세면 4 > 3이라 거절됐을 것이다)
    const r = okPin(await pin(o, { limit: 3 }));
    expect(r.regrabbed).toBe(1);
    expect(await h.quota(e, ACCOUNT_A)).toBe(3);
  });

  test(`pin_ 판매 일시정지(paused·allPaused·suspended '1')여도 묶기는 된다(접수된 결제는 끝까지 처리한다. 다시 잡기 포함)`, async () => {
    const { h, e, order, hold, pin, expireNow } = await world();
    const o = order(['A01', 'A02']);
    await hold(o);
    await expireNow(['A02']);
    await h.setCtl(e, { paused: '1', allPaused: '1', suspended: '1' });
    expect(okPin(await pin(o))).toMatchObject({ gen: 1, regrabbed: 1 });
    expect(await h.bit(e, idx('A02'))).toBe(1);
  });

  test(`pin_ST26_③ 세대 키가 없으면 NOT_READY이고 아무것도 쓰지 않는다(남의 좌석보다 먼저, 판매 열기 전 회차도 같다) [ASVS v5.0.0-2.3.4]`, async () => {
    const a = await world();
    // 주문 A01·A02 가운데 A01만 내 홀드이고 A02는 남의 좌석이다
    const o = a.order(['A01', 'A02']);
    await a.hold({ ...o, seatIds: ['A01'] });
    await a.hold(a.order(['A02'], { accountId: ACCOUNT_B }));
    await a.h.dropEpoch(a.e);
    const before = await look(a.h, a.e);
    expect(await a.pin(o)).toEqual({ kind: 'NOT_READY' });
    expect(await look(a.h, a.e)).toEqual(before);
    const b = await world({ open: false });
    const before2 = await look(b.h, b.e);
    expect(await b.pin(b.order(['A01']))).toEqual({ kind: 'NOT_READY' });
    expect(await look(b.h, b.e)).toEqual(before2);
  });

  test(`pin_ 검사 차례: 세대 키 → 남의 좌석 → 낡은 판 번호 → 한도(두 조건에 함께 걸리면 앞 차례의 결과, 모든 쌍)이고 아무것도 쓰지 않는다 [ASVS v5.0.0-15.4.2]`, async () => {
    const checks = ['NOT_READY', 'TAKEN', 'STALE_GEN', 'QUOTA_EXCEEDED'] as const;
    for (let a = 0; a < checks.length; a++) {
      for (let b = a + 1; b < checks.length; b++) {
        const pair = [checks[a]!, checks[b]!];
        const on = (c: (typeof checks)[number]) => pair.includes(c);
        const { h, e, order, hold, pin, expireNow } = await world();
        // 주문 A01·A02·A03: A01은 내 홀드, A02·A03은 만료돼 비었다(보유 1). 조건이 없으면 보유 1 + 빈 2 ≤ 한도 4라 OK다
        const o = order(['A01', 'A02', 'A03']);
        await hold(o);
        await expireNow(['A02', 'A03']);
        if (on('TAKEN')) await hold(order(['A03'], { accountId: ACCOUNT_B }));
        if (on('STALE_GEN')) await h.setGen(e, 2);
        // 보유 4 + 빈 1 이상 > 한도 4
        if (on('QUOTA_EXCEEDED')) await h.setQuota(e, ACCOUNT_A, 4);
        if (on('NOT_READY')) await h.dropEpoch(e);
        const before = await look(h, e);
        const r = await pin(o, { orderGen: 1, limit: 4 });
        expect.soft({ pair, kind: r.kind }).toEqual({ pair, kind: pair[0] });
        expect.soft({ pair, s: await look(h, e) }).toEqual({ pair, s: before });
      }
    }
  });

  // ---- 묶기: 다시 부르기·경합 ----

  test(`pin_ 같은 주문을 두 번 묶으면 두 번째는 OK(다시 잡은 수 0)이고 아무것도 더 바뀌지 않는다(Stream·fence·secver·델타·보유 수 그대로) [ASVS v5.0.0-15.4.2]`, async () => {
    const { h, e, order, hold, pin, expireNow } = await world();
    const o = order(['A01', 'A02']);
    await hold(o);
    await expireNow(['A02']);
    expect(okPin(await pin(o)).regrabbed).toBe(1);
    const before = await look(h, e);
    expect(await pin(o)).toEqual({ kind: 'OK', gen: 1, regrabbed: 0 });
    expect(await look(h, e)).toEqual(before);
  });

  test(`pin_inv_noOversell_ 만료로 빈 좌석을 같은 때에 다른 계정이 잡으려 하면 묶기와 홀드 가운데 하나만 된다(비트·Hash 주인·보유 수·Stream HELD가 한 번) [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.2]`, async () => {
    const { h, e, keepUntilMs, order, hold, pin, expireNow } = await world();
    const o = order(['A01']);
    await hold(o);
    await expireNow(['A01']);
    const n = (await h.stream(e)).filter((s) => s.type === 'HELD').length;
    const other = order(['A01'], { accountId: ACCOUNT_B });
    const [rp, rh] = await Promise.all([
      pin(o),
      h.store.hold(holdInput(e, other.seatIds, { accountId: ACCOUNT_B, holdId: other.holdId, purchaseSessionId: other.purchaseSessionId, keepUntilMs })),
    ]);
    const pinWon = rp.kind === 'OK';
    expect({ pin: rp.kind, hold: rh.kind }).toEqual(pinWon ? { pin: 'OK', hold: 'CONFLICT' } : { pin: 'TAKEN', hold: 'OK' });
    if (!pinWon) expect(rp).toEqual({ kind: 'TAKEN', seatIndex: idx('A01') });
    expect(await h.bit(e, idx('A01'))).toBe(1);
    expect((await h.holdHash(e, idx('A01')))?.owner).toBe(pinWon ? ACCOUNT_A : ACCOUNT_B);
    expect([(await h.quota(e, ACCOUNT_A)) ?? 0, (await h.quota(e, ACCOUNT_B)) ?? 0]).toEqual(pinWon ? [1, 0] : [0, 1]);
    expect((await h.stream(e)).filter((s) => s.type === 'HELD')).toHaveLength(n + 1);
  });

  // ---- 결제 실패 해제 ----

  test(`releaseFailed_ 그 주문의 홀드(holdId·owner가 같음)만 푼다: 비트 0, 홀드 Hash 지움, 만료 인덱스에서 뺌, 보유 수 −푼 수, 결과 OK(released). 남의 좌석(다른 계정·같은 계정의 다른 홀드·같은 holdId의 다른 owner)과 빈 좌석은 그대로다 [ASVS v5.0.0-15.4.2]`, async () => {
    const { h, e, order, hold, pin, release } = await world();
    const o = order(['A01', 'A02', 'B01']);
    await hold(o);
    okPin(await pin(o));
    await hold(order(['A03'], { accountId: ACCOUNT_B }));
    await hold(order(['A05'], { accountId: ACCOUNT_A }));
    await hold(order(['A07'], { accountId: ACCOUNT_C, holdId: o.holdId }));
    // 해제 입력에 남의 좌석과 빈 좌석(A04)을 섞는다
    const wide: Order = { ...o, seatIds: ['A01', 'A02', 'A03', 'A04', 'A05', 'A07', 'B01'] };
    const keep = ['A03', 'A04', 'A05', 'A07'];
    const kept = async () => Promise.all(keep.map(async (id) => ({ id, bit: await h.bit(e, idx(id)), hold: await h.holdHash(e, idx(id)), score: await h.expiryScore(e, idx(id)) })));
    const before = await kept();
    expect(await h.quota(e, ACCOUNT_A)).toBe(4);
    expect(await release(wide)).toEqual({ kind: 'OK', released: 3 });
    for (const id of o.seatIds) {
      expect({ id, bit: await h.bit(e, idx(id)), hold: await h.holdHash(e, idx(id)), score: await h.expiryScore(e, idx(id)) }).toEqual({ id, bit: 0, hold: null, score: null });
    }
    expect(await kept()).toEqual(before);
    expect([await h.quota(e, ACCOUNT_A), await h.quota(e, ACCOUNT_B), await h.quota(e, ACCOUNT_C)]).toEqual([1, 1, 1]);
  });

  test(`releaseFailed_ST35_ 푼 좌석마다 Stream RELEASED 한 건(holdId·holdKind·purchaseSessionId·accountId·fencingToken = 그 좌석 홀드 Hash 값, expiresAtMs = Hash exp, occurredAtMs = 지금), 바뀐 구역마다 secver +1, 델타는 상태 0이다. 새 토큰을 내지 않아 fence 그대로다 [S-T5]`, async () => {
    const { h, e, seatEpoch, order, hold, pin, release, expireNow, streamAfter } = await world();
    const o = order(['A01', 'A02', 'B01']);
    await hold(o);
    // B01만 다시 잡아 좌석마다 토큰·exp가 다르게 한다
    await expireNow(['B01']);
    okPin(await pin(o));
    const hashes = Object.fromEntries(await Promise.all(o.seatIds.map(async (id) => [id, (await h.holdHash(e, idx(id)))!] as const)));
    expect(hashes.A01!.fence).not.toBe(hashes.B01!.fence);
    expect(await h.secver(e)).toEqual({ '0': 1, '1': 3 });
    const fence = await h.fence(e);
    const n = (await h.stream(e)).length;
    const p = (await h.published(e)).length;
    expect(await release(o)).toEqual({ kind: 'OK', released: 3 });
    const rows = await streamAfter(n);
    const now = Number(rows[0]?.occurredAtMs);
    expect(Math.abs(now - h.clock.now())).toBeLessThanOrEqual(h.skewMs);
    expect(rows).toEqual([releasedRow('A01', hashes.A01!, 2, seatEpoch, now), releasedRow('A02', hashes.A02!, 2, seatEpoch, now), releasedRow('B01', hashes.B01!, 4, seatEpoch, now)]);
    expect(await h.secver(e)).toEqual({ '0': 2, '1': 4 });
    expect(SEAT_STATE_AVAILABLE).toBe(0);
    expect((await h.published(e)).slice(p)).toEqual([
      { channel: seatKeys.section(e, '0'), message: `1 ${seatEpoch} 0 2 ${now} ${ref('A01').seatOffset}:0 ${ref('A02').seatOffset}:0` },
      { channel: seatKeys.section(e, '1'), message: `1 ${seatEpoch} 1 4 ${now} ${ref('B01').seatOffset}:0` },
    ]);
    expect(await h.fence(e)).toBe(fence);
  });

  test(`releaseFailed_ 묶지 않은 홀드도 푼다(만료 인덱스에서 뺀다). 방금 놓은 좌석(rel)에 넣지 않아 같은 계정이 곧바로 다시 잡을 수 있다`, async () => {
    const { h, e, order, hold, release } = await world();
    const o = order(['A01', 'A02']);
    await hold(o);
    expect(await h.expiryScore(e, idx('A01'))).not.toBeNull();
    expect(await release(o)).toEqual({ kind: 'OK', released: 2 });
    for (const id of o.seatIds) expect({ id, bit: await h.bit(e, idx(id)), score: await h.expiryScore(e, idx(id)) }).toEqual({ id, bit: 0, score: null });
    expect(await h.rel(e, ACCOUNT_A)).toEqual({});
    // 결제 실패는 놓은 것이 아니다: 같은 계정의 새 홀드가 REHOLD_WAIT가 아니다
    await hold(order(['A01']));
    expect((await h.holdHash(e, idx('A01')))?.owner).toBe(ACCOUNT_A);
  });

  test(`releaseFailed_ 같은 호출을 두 번 하면 두 번째는 OK(released 0)이고 아무것도 바뀌지 않는다 [ASVS v5.0.0-15.4.2]`, async () => {
    const { h, e, order, hold, pin, release } = await world();
    const o = order(['A01', 'B01']);
    await hold(o);
    okPin(await pin(o));
    await hold(order(['A02'], { accountId: ACCOUNT_B }));
    expect(await release(o)).toEqual({ kind: 'OK', released: 2 });
    const before = await look(h, e);
    expect(await release(o)).toEqual({ kind: 'OK', released: 0 });
    expect(await look(h, e)).toEqual(before);
  });

  test(`releaseFailed_ST26_③ 세대 키가 없으면 NOT_READY이고 아무것도 쓰지 않는다(판매 열기 전 회차도 같다)`, async () => {
    const a = await world();
    const o = a.order(['A01']);
    await a.hold(o);
    await a.h.dropEpoch(a.e);
    const before = await look(a.h, a.e);
    expect(await a.release(o)).toEqual({ kind: 'NOT_READY' });
    expect(await look(a.h, a.e)).toEqual(before);
    const b = await world({ open: false });
    expect(await b.release(b.order(['A01']))).toEqual({ kind: 'NOT_READY' });
  });

  test(`releaseFailed_POL011_ 마지막 좌석을 풀면 보유 수는 0(또는 키 없음)이고, 어긋나 푼 수보다 작아도 음수로 쓰지 않는다`, async () => {
    const a = await world();
    const o = a.order(['A01', 'A02']);
    await a.hold(o);
    expect(await a.release(o)).toEqual({ kind: 'OK', released: 2 });
    expect((await a.h.quota(a.e, ACCOUNT_A)) ?? 0).toBe(0);
    const b = await world();
    const o2 = b.order(['A01', 'A02']);
    await b.hold(o2);
    await b.h.setQuota(b.e, ACCOUNT_A, 1);
    expect(await b.release(o2)).toEqual({ kind: 'OK', released: 2 });
    expect((await b.h.quota(b.e, ACCOUNT_A)) ?? 0).toBe(0);
  });

  // ---- 입력 검사 ----

  /** 좌석 입력 모양이 틀린 것(pin·releaseFailed 공통) */
  const badSeats = (): [string, SeatRef[]][] => [
    ['좌석 0개', []],
    ['좌석 11개', aSeats(11).map(ref)],
    ['좌석 정렬 안 됨', [ref('A02'), ref('A01')]],
    ['좌석 ID 겹침', [ref('A01'), ref('A01')]],
    ['좌석 색인 겹침', [ref('A01'), { ...ref('A02'), index: ref('A01').index }]],
  ];
  const badKeyParts = ['a{b}', 'a:b', '', 'x'.repeat(65)];
  const badUuids = ['hold-1', 'ps-a1', '', '0190f3a1-7c2e-7a00-8000'];
  const badKeepUntil = (k: number) => [k + 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53];

  // 구매 세션 ID는 UUID가 아니라 키 조각 모양으로 받는다(입장 토큰 jti, payment §2 '좌석 묶기 입력의 구매 세션 ID', PRF-165. 2026-11-05 구현 담당이 정본에 맞춰 고침)
  test(`pin_ assertPinInput은 키 조각이 아닌 회차·계정·구매 세션, UUID가 아닌 holdId, 좌석 0개·11개·정렬 안 됨·겹침, 한도 1 미만, orderGen 1 미만·정수 아님, keepUntil 안전한 정수 아님을 RangeError로 거절하고, pin도 같은 입력에 RangeError이며 아무것도 쓰지 않는다. 경계(한도 1·orderGen 1·좌석 10개·UUID가 아닌 키 조각 구매 세션)는 받는다 [ASVS v5.0.0-2.2.1]`, async () => {
    const { h, e, keepUntilMs, order, hold, pinInput } = await world();
    const o = order(['A01']);
    await hold(o);
    const base = pinInput(o);
    const bad: [string, Partial<PinInput>][] = [
      ...badKeyParts.map((v): [string, Partial<PinInput>] => [`회차 ${JSON.stringify(v)}`, { eventId: v }]),
      ...badKeyParts.map((v): [string, Partial<PinInput>] => [`계정 ${JSON.stringify(v)}`, { accountId: v }]),
      ...badUuids.map((v): [string, Partial<PinInput>] => [`holdId ${JSON.stringify(v)}`, { holdId: v }]),
      ...badKeyParts.map((v): [string, Partial<PinInput>] => [`구매 세션 ${JSON.stringify(v)}`, { purchaseSessionId: v }]),
      ...badSeats().map(([w, seats]): [string, Partial<PinInput>] => [w, { seats }]),
      ...[0, -1].map((v): [string, Partial<PinInput>] => [`한도 ${v}`, { limit: v }]),
      ...[0, -1, 1.5, Number.NaN].map((v): [string, Partial<PinInput>] => [`orderGen ${v}`, { orderGen: v }]),
      ...badKeepUntil(keepUntilMs).map((v): [string, Partial<PinInput>] => [`keepUntil ${v}`, { keepUntilMs: v }]),
    ];
    const before = await look(h, e);
    for (const [what, patch] of bad) {
      const i = { ...base, ...patch };
      expect.soft(() => assertPinInput(i), what).toThrow(RangeError);
      await expect.soft(h.store.pin(i), what).rejects.toBeInstanceOf(RangeError);
    }
    expect(await look(h, e)).toEqual(before);
    for (const [what, patch] of [
      ['한도 1', { limit: 1 }],
      ['orderGen 1', { orderGen: 1 }],
      ['좌석 10개', { seats: aSeats(10).map(ref) }],
      ['구매 세션 jti 모양(UUID 아님)', { purchaseSessionId: 'jti_9f2c-AB' }],
      ['기본 입력', {}],
    ] as [string, Partial<PinInput>][]) {
      expect.soft(() => assertPinInput({ ...base, ...patch }), what).not.toThrow();
    }
  });

  test(`releaseFailed_ assertReleaseFailedInput은 키 조각이 아닌 회차·계정, UUID가 아닌 holdId, 좌석 0개·11개·정렬 안 됨·겹침, keepUntil 안전한 정수 아님을 RangeError로 거절하고, releaseFailed도 같은 입력에 RangeError이며 아무것도 쓰지 않는다. 좌석 10개는 받는다 [ASVS v5.0.0-2.2.1]`, async () => {
    const { h, e, keepUntilMs, order, hold, releaseInput } = await world();
    const o = order(['A01']);
    await hold(o);
    const base = releaseInput(o);
    const bad: [string, Partial<ReleaseFailedInput>][] = [
      ...badKeyParts.map((v): [string, Partial<ReleaseFailedInput>] => [`회차 ${JSON.stringify(v)}`, { eventId: v }]),
      ...badKeyParts.map((v): [string, Partial<ReleaseFailedInput>] => [`계정 ${JSON.stringify(v)}`, { accountId: v }]),
      ...badUuids.map((v): [string, Partial<ReleaseFailedInput>] => [`holdId ${JSON.stringify(v)}`, { holdId: v }]),
      ...badSeats().map(([w, seats]): [string, Partial<ReleaseFailedInput>] => [w, { seats }]),
      ...badKeepUntil(keepUntilMs).map((v): [string, Partial<ReleaseFailedInput>] => [`keepUntil ${v}`, { keepUntilMs: v }]),
    ];
    const before = await look(h, e);
    for (const [what, patch] of bad) {
      const i = { ...base, ...patch };
      expect.soft(() => assertReleaseFailedInput(i), what).toThrow(RangeError);
      await expect.soft(h.store.releaseFailed(i), what).rejects.toBeInstanceOf(RangeError);
    }
    expect(await look(h, e)).toEqual(before);
    expect.soft(() => assertReleaseFailedInput({ ...base, seats: aSeats(10).map(ref) }), '좌석 10개').not.toThrow();
    expect.soft(() => assertReleaseFailedInput(base), '기본 입력').not.toThrow();
  });

  test('pin_inv_fencingTokensIncrease_fence가 지금 µs보다 앞서 있으면(장애 전환 뒤 시계가 뒤로 감) 다시 잡은 토큰은 fence + 1이다(시험 검토 B가 찾음) [S-T5]', async () => {
    const { h, e, order, hold, pin, expireNow } = await world();
    const o = order(['A01']);
    await hold(o);
    await expireNow(o.seatIds);
    await h.setFence(e, '1987654321098765');

    const r = okPin(await pin(o));

    expect(r.regrabbed).toBe(1);
    expect(r.fencingToken).toBe(1_987_654_321_098_766);
    expect(await h.fence(e)).toBe('1987654321098766');
    expect((await h.holdHash(e, idx('A01')))?.fence).toBe('1987654321098766');
  });

  test('releaseFailed_비트가 0인데 그 주문의 holdId·owner로 된 옛 Hash만 남은 좌석은 풀지 않는다(이미 풀린 좌석이라 보유 수를 다시 줄이지 않는다, 시험 검토 B가 찾음) [ASVS v5.0.0-2.3.2]', async () => {
    const { h, e, order, hold, release, streamAfter } = await world();
    const o = order(['A01', 'A04']);
    await hold({ ...o, seatIds: ['A01'] });
    await h.setHoldRaw(e, idx('A04'), { holdId: o.holdId, owner: o.accountId, psid: 'old', fence: '1', heldAt: '1', exp: '2', kind: 'FAN', ext: '0' });
    const n = (await h.stream(e)).length;

    expect(await release(o)).toEqual({ kind: 'OK', released: 1 });

    expect(await h.bit(e, idx('A04'))).toBe(0);
    expect(await h.holdHash(e, idx('A04'))).toMatchObject({ psid: 'old' });
    expect((await h.quota(e, o.accountId)) ?? 0).toBe(0);
    expect((await streamAfter(n)).map((x) => x.seatId)).toEqual(['A01']);
  });

  test('pin_코드 리뷰_다시 잡은 HELD는 처음 HELD와 eventKey가 다르다(같은 holdId여도 펜싱 토큰이 달라 보류 표·집계가 새 사건을 버리지 않는다) [S-T5]', async () => {
    const { h, e, order, hold, pin, expireNow } = await world();
    const o = order(['A01']);
    await hold(o);
    await expireNow(o.seatIds);
    okPin(await pin(o));

    const helds = (await h.stream(e)).filter((x) => x.type === 'HELD');
    expect(helds).toHaveLength(2);
    const keys = helds.map((fields, n) => {
      const r = routeStreamEntry(e, { id: `${n}-0`, fields });
      if (r.kind !== 'send') throw new Error(`보내지 못하는 HELD: ${r.reason}`);
      return (r.message as { eventKey: string }).eventKey;
    });
    expect(new Set(keys).size, '처음 HELD와 다시 잡은 HELD의 eventKey').toBe(2);
  });

  test('pin_코드 리뷰_등급·구역 ID가 빈 글인 좌석은 RangeError다(그대로 두면 릴레이가 그 HELD를 좌석맵 판에 없는 좌석으로 넘겨 원장에서 빠진다) [ASVS v5.0.0-2.2.1]', async () => {
    const { pinInput, order } = await world();
    const o = order(['A01']);
    const base = pinInput(o);
    expect(() => assertPinInput({ ...base, seats: base.seats.map((x) => ({ ...x, tierId: '' })) })).toThrow(RangeError);
    expect(() => assertPinInput({ ...base, seats: base.seats.map((x) => ({ ...x, sectionId: '' })) })).toThrow(RangeError);
  });
}
