// 만료 저장소(SeatExpiries)·만료 임대(SweepLeases) 계약 사례(docs/features/seat-hold.md §5 '운영 만료 Lua와 1초 반복'·'방금 놓은 좌석',
// docs/data.md §3 좌석 키 표(expiry·hold·quota·rel·stream의 EXPIRED 칸·secver·sweep), src/modules/inventory/adapters/expire-lua.ts, BUILD_ORDER PRF-135).
// 메모리 저장소(test/hold-seats.test.ts)와 실제 Valkey 8.1 Lua(test-int/seat-store.int.test.ts)에 똑같이 돈다.
// Lua 안의 시각은 Redis TIME이라 시험이 바꿀 수 없다. 그래서 '시간이 지난 홀드'는 홀드 Hash의 exp와 만료 인덱스 점수를 지난 시각으로 미리 써 넣어 만든다
// (고정 sleep 없음). 1단계(dueExpiries)의 '지금'은 앱이 넘기는 값이라 경계를 그대로 본다.
// 홀드 쪽 덧붙임 지킴(secver 칸 값, 토큰 넘침 오류 글)도 같은 도구가 필요해 여기 둔다(BUILD_ORDER PRF-135 'PRF-130 리뷰 낮음 3·4').
import { randomUUID } from 'node:crypto';
import { systemClock, uuidv7 } from '@peaket/platform';
import { expect, test } from 'vitest';
import {
  type DueExpiry,
  EXPIRY_BATCH_SIZE,
  type ExpireResult,
  type ExpireSeat,
  type HoldInput,
  KEY_PART,
  REHOLD_WAIT_MS,
  SEAT_STATE_AVAILABLE,
  type SeatExpiries,
  type SeatRef,
  type SeatStore,
  SeatStoreUnavailable,
  SWEEP_LEASE_TTL_MS,
  type SweepLeases,
  seatKeys,
} from '../src/modules/inventory/index.js';
import { ACCOUNT_A, ACCOUNT_B, ACCOUNT_C, ACCOUNT_D, account, DAY, fingerprintOf, held, holdInput, idx, newEvent, ref, SEAT_COUNT, SEAT_DEFS, type SeatHarness } from './hold-cases.js';

/** 저장소 하나(SeatStore·SeatExpiries)와 만료 임대, 그 키를 직접 채우고 읽는 도구. 키 이름은 docs/data.md §3(seatKeys)이다 */
export interface ExpiryHarness extends SeatHarness {
  store: SeatStore & SeatExpiries;
  /** 같은 저장소(메모리는 같은 MemorySeatDb)의 만료 임대 */
  leases: SweepLeases;
  /** rel 키의 만료 시각(PEXPIRE 30000)과 '푼 시각 + 30초'의 허용 차이(ms). 메모리 0, Valkey는 스크립트 안 시각 캐시 차이로 몇 ms */
  relSlackMs: number;
  /** 홀드 Hash를 통째로 쓴다(있던 칸은 지운다, 값은 글. 메모리는 heldAt·exp를 Number로). null이면 키를 지운다 */
  setHoldRaw(eventId: string, index: number, fields: Record<string, string> | null): Promise<void>;
  /** 홀드 Hash 칸 하나를 바꾼다(HSET. 메모리는 heldAt·exp를 Number로) */
  setHoldField(eventId: string, index: number, field: string, value: string): Promise<void>;
  /** 만료 인덱스에 멤버(글)와 점수를 쓴다(ZADD. 메모리는 Number(member)를 색인으로) */
  setExpiry(eventId: string, member: string, score: number): Promise<void>;
  /** 만료 인덱스에서 그 색인을 뺀다(ZREM) */
  removeExpiry(eventId: string, index: number): Promise<void>;
  /** secver 칸 값을 쓴다(메모리는 값 그대로, Valkey는 String(value)). 글은 '007'처럼 수로는 못 쓰는 값을 넣으려고 받는다 */
  setSecverRaw(eventId: string, sectionIndex: number, value: number | string): Promise<void>;
  /** 보유 수 키 s:{event:E}:quota:{account}의 값을 글 그대로 쓴다('007'·'' 같은 수로는 못 쓰는 값. 메모리는 글을 그대로 둔다) */
  setQuotaRaw(eventId: string, accountId: string, text: string): Promise<void>;
  /** rel:{account}: 색인(글) → 점수. 키가 없으면 {} */
  rel(eventId: string, accountId: string): Promise<Record<string, number>>;
  /** 만료 임대 s:{event:E}:sweep의 값(파드 ID). 없거나 수명이 다했으면 null */
  lease(eventId: string): Promise<string | null>;
  /** 만료 임대의 남은 수명(ms). 없으면 null */
  leaseTtlMs(eventId: string): Promise<number | null>;
  /** 만료 임대의 남은 수명을 ms로 줄인다(메모리: expiresAtMs = 지금 + ms, Valkey: PEXPIRE) */
  shortenLease(eventId: string, ms: number): Promise<void>;
  /** 만료 임대의 수명이 다한 것으로 만든다(메모리: expiresAtMs = 지금, Valkey: 키 만료를 흉내 내 지운다) */
  passLeaseTtl(eventId: string): Promise<void>;
  /** s:ctl:events에 값을 그대로 넣는다(모양을 보지 않는다. 메모리는 MemorySeatDb.ctlEvents, Valkey는 SADD) */
  addCtlEvent(raw: string): Promise<void>;
}

/** '시간이 지난 홀드'를 만들 때 쓰는 과거(앱 시계보다 1분 전. Docker VM 시계 차이 5초보다 넉넉하다) */
const PAST_MS = 60_000;
/** 시험 판에 없는 색인(SEAT_COUNT 40 안, 판에는 0 ~ 30만 있다) */
const OFF_MAP = [35, 36] as const;
const ACCOUNTS = [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C, ACCOUNT_D];

/**
 * INCRBY·HINCRBY가 건드릴 값(보유 수 키·바뀔 구역의 secver 칸)이 표준 10진 정수가 아닌 값(추천 적용 2026-11-04 A1).
 * 표준 10진 정수는 '0'이거나 첫 자리가 1~9인 18자리 이하다(Redis는 앞 0·소수·빈 글·int64 밖을 받지 않는다. '-1'은 받지만 개수로는 뜻이 없다)
 */
const NOT_STANDARD_INT = ['007', '12345678901234567890', '1.5', ' 5', '-1', ''] as const;
/** 표준 10진 정수의 끝(18자리). 지킴을 지나야 한다 */
const MAX_STANDARD_INT = '999999999999999999';
/**
 * 홀드 Hash의 fence 칸이 만료 Lua가 받지 못하는 값(추천 적용 2026-11-04 A2): 표준 10진 정수('^[1-9]%d*$')가 아니거나 2^53 − 1(9007199254740991)을 넘는다.
 * 앱의 fencingTokenOf가 안전한 정수만 받아, 모양만 보면 풀고 나서 앱이 던지기 때문이다
 */
const BAD_FENCES = ['abc', '007', '0', '', '9007199254740992', '10000000000000000', '99999999999999999999'] as const;
/** 받아야 하는 fence 끝값: 2^53 − 1 그대로, 그 바로 아래, 15자리 끝 */
const OK_FENCES = ['9007199254740991', '9007199254740990', '999999999999999'] as const;

/** 저장소 호출의 결과를 끝까지 받는다(던지면 그 오류) */
const settled = (p: Promise<unknown>) =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (x: unknown) => ({ ok: false as const, x }),
  );
type Settled = Awaited<ReturnType<typeof settled>>;
/** 던진 오류의 글(던지지 않고 풀렸거나 일시 장애면 그 사실). soft 단언의 실패 문구에 그대로 보인다 */
const errorText = (o: Settled): string => (o.ok ? `던지지 않고 풀렸다: ${JSON.stringify(o.v)}` : o.x instanceof SeatStoreUnavailable ? '일시 장애로 던졌다' : o.x instanceof Error ? o.x.message : String(o.x));
/** 만료 결과의 요약(던졌거나 OK가 아니면 그 사실) */
function expireSummary(o: Settled) {
  if (!o.ok) return `던졌다: ${errorText(o)}`;
  const r = o.v as ExpireResult;
  if (r.kind !== 'OK') return r.kind;
  return { released: r.released, corrupt: r.corrupt, skipped: r.skipped, orphans: r.orphans, expired: r.expired };
}

/** 판의 좌석(색인으로). 판에 없으면 undefined */
export function seatAt(index: number): SeatRef | undefined {
  const d = SEAT_DEFS.find((s) => s.index === index);
  if (!d) return undefined;
  const { saleExcluded: _x, ...r } = d;
  return r;
}

/** 1단계 결과를 만료 Lua 입력으로(판에 있는 좌석은 seat를 붙이고, 판에 없는 색인·고아는 seat 없이) */
export function expireSeatsOf(list: readonly DueExpiry[]): ExpireSeat[] {
  return list.map((d) => {
    const seat = d.hold ? seatAt(d.index) : undefined;
    return seat ? { index: d.index, expected: d.hold, seat } : { index: d.index, expected: d.hold };
  });
}

/** 결과가 OK인지 보고 꺼낸다 */
export function okOf(r: ExpireResult): Extract<ExpireResult, { kind: 'OK' }> {
  expect(r.kind).toBe('OK');
  if (r.kind !== 'OK') throw new Error(`OK가 아니다: ${JSON.stringify(r)}`);
  return r;
}

/** 저장소 호출이 일시 장애가 아닌 Error로 끝났는지 보고 그 오류를 돌려준다(풀리면 그 결과가 실패 문구에 보인다) */
export async function bugOf(p: Promise<unknown>, what?: unknown): Promise<Error> {
  const out = await p.then(
    (v: unknown) => ({ ok: true as const, v }),
    (x: unknown) => ({ ok: false as const, x }),
  );
  if (out.ok) throw new Error(`${JSON.stringify(what) ?? ''} 던지지 않고 풀렸다: ${JSON.stringify(out.v)}`);
  expect(out.x, `${JSON.stringify(what) ?? ''} 던진 것: ${String(out.x)}`).toBeInstanceOf(Error);
  expect(out.x, `${JSON.stringify(what) ?? ''} 일시 장애로 던졌다`).not.toBeInstanceOf(SeatStoreUnavailable);
  return out.x as Error;
}

/** 회차 키 전체의 모습('아무것도 바뀌지 않았다'를 보려고 앞뒤로 견준다) */
async function look(h: ExpiryHarness, e: string, extra: readonly number[] = []) {
  const all = [...SEAT_DEFS.map((d) => d.index), ...OFF_MAP, ...extra];
  return {
    bits: await Promise.all(all.map((i) => h.bit(e, i))),
    holds: await Promise.all(all.map((i) => h.holdHash(e, i))),
    expiry: await Promise.all(all.map((i) => h.expiryScore(e, i))),
    quota: await Promise.all(ACCOUNTS.map((a) => h.quota(e, a))),
    quotaExpire: await Promise.all(ACCOUNTS.map((a) => h.expireAt(e, seatKeys.quota(e, a)))),
    rel: await Promise.all(ACCOUNTS.map((a) => h.rel(e, a))),
    relExpire: await Promise.all(ACCOUNTS.map((a) => h.expireAt(e, seatKeys.rel(e, a)))),
    fence: await h.fence(e),
    epoch: await h.epoch(e),
    secver: await h.secver(e),
    stream: await h.stream(e),
    published: (await h.published(e)).length,
    expire: await Promise.all([seatKeys.bitmap(e), seatKeys.expiry(e), seatKeys.fence(e), seatKeys.stream(e), seatKeys.secver(e), seatKeys.epoch(e)].map((k) => h.expireAt(e, k))),
  };
}

/** 시험 판 밖의 좌석(100석 묶음용): 색인 i, 구역 색인 i % 3, 구역 안 거리 ⌊i / 3⌋ */
const bigSeat = (i: number): SeatRef => ({ seatId: `S${String(i).padStart(3, '0')}`, index: i, sectionId: `SEC-${i % 3}`, sectionIndex: i % 3, seatOffset: Math.floor(i / 3), tierId: 'R' });

/** 좌석 ID 오름차순 정렬·지문을 맞춘 HoldInput(판 밖 좌석용) */
function rawHoldInput(eventId: string, seats: SeatRef[], c: { accountId: string; keepUntilMs: number; purchaseSessionId?: string }): HoldInput {
  const sorted = [...seats].sort((a, b) => (a.seatId < b.seatId ? -1 : a.seatId > b.seatId ? 1 : 0));
  return {
    eventId,
    accountId: c.accountId,
    purchaseSessionId: c.purchaseSessionId ?? `ps-${c.accountId.slice(-4)}`,
    holdId: uuidv7(systemClock),
    idempotencyKey: randomUUID(),
    fingerprint: fingerprintOf(sorted.map((s) => s.seatId)),
    seats: sorted,
    limit: 4,
    keepUntilMs: c.keepUntilMs,
  };
}

export function expiryCases(name: string, setup: () => Promise<ExpiryHarness>): void {
  async function world(o: { open?: boolean } = {}) {
    const h = await setup();
    const e = newEvent();
    await h.prepare?.(e);
    const keepUntilMs = h.clock.now() + 2 * DAY;
    const opened = o.open === false ? undefined : await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    const hold = (seatIds: readonly string[], c: Partial<Omit<HoldInput, 'eventId' | 'seats'>> = {}) => h.store.hold(holdInput(e, seatIds, { keepUntilMs, ...c }));
    /** 색인들의 홀드 Hash exp와 만료 인덱스 점수를 at(기본 1분 전)으로 바꾼다: 시간이 지난 홀드 */
    const backdateIdx = async (indexes: readonly number[], at = h.clock.now() - PAST_MS) => {
      for (const i of indexes) {
        await h.setHoldField(e, i, 'exp', String(at));
        await h.setExpiry(e, String(i), at);
      }
      return at;
    };
    const backdate = (seatIds: readonly string[], at?: number) => backdateIdx(seatIds.map(idx), at);
    const due = (limit = EXPIRY_BATCH_SIZE, nowMs = h.clock.now()) => h.store.dueExpiries({ eventId: e, nowMs, limit });
    const expire = (seats: readonly ExpireSeat[], keep = keepUntilMs) => h.store.expire({ eventId: e, keepUntilMs: keep, seats });
    return { h, e, keepUntilMs, seatEpoch: opened?.seatEpoch, hold, backdate, backdateIdx, due, expire };
  }

  /** EXPIRED 사건 한 줄(data.md §3 stream의 EXPIRED 칸) */
  const expiredRow = (o: { seatId: string; holdId: string; psid: string; owner: string; token: number; sectionVersion: number; seatEpoch: number | undefined; nowMs: number; expMs: number }) => ({
    type: 'EXPIRED',
    seatIdx: String(idx(o.seatId)),
    seatId: o.seatId,
    tierId: ref(o.seatId).tierId,
    sectionId: ref(o.seatId).sectionId,
    holdId: o.holdId,
    holdKind: 'FAN',
    purchaseSessionId: o.psid,
    accountId: o.owner,
    fencingToken: String(o.token),
    sectionVersion: String(o.sectionVersion),
    seatEpoch: String(o.seatEpoch),
    occurredAtMs: String(o.nowMs),
    expiresAtMs: String(o.expMs),
  });

  /**
   * 계정 셋의 홀드: A는 A01·A02(한 홀드, 보유 2), B는 B01·B02(두 홀드, 보유 2), C는 A05(보유 1). A01·A02·B01만 시간이 지났다.
   * A의 rel에는 지난 멤버(A10)와 아직 안 지난 멤버(A11)를 미리 둔다
   */
  async function threeAccounts() {
    const w = await world();
    const { h, e, hold } = w;
    const ra = held(await hold(['A01', 'A02'], { accountId: ACCOUNT_A, purchaseSessionId: 'ps-a' }));
    const rb1 = held(await hold(['B01'], { accountId: ACCOUNT_B, purchaseSessionId: 'ps-b' }));
    const rb2 = held(await hold(['B02'], { accountId: ACCOUNT_B, purchaseSessionId: 'ps-b' }));
    const rc = held(await hold(['A05'], { accountId: ACCOUNT_C, purchaseSessionId: 'ps-c' }));
    const relFuture = h.clock.now() + 3_600_000;
    await h.setRel(e, ACCOUNT_A, idx('A10'), h.clock.now() - PAST_MS);
    await h.setRel(e, ACCOUNT_A, idx('A11'), relFuture);
    const at = await w.backdate(['A01', 'A02', 'B01']);
    return { ...w, ra, rb1, rb2, rc, at, relFuture };
  }

  // ---- 1단계: dueExpiries ----

  test(`[${name}] ST6_FR042_ dueExpiries는 점수가 지금 이하인 좌석만(같으면 넣고 1ms 뒤는 뺀다) 점수 오름차순·같은 점수는 멤버 글 차례로 읽고, 홀드 Hash의 holdId·fence·owner를 싣는다. 아무것도 쓰지 않는다`, async () => {
    const { h, e } = await world();
    const T = h.clock.now();
    const hash = (i: number, owner: string) => ({ holdId: `h${i}`, owner, psid: 'ps-x', fence: `170000000000000${i}`, heldAt: '1', exp: String(T - 10), kind: 'FAN', ext: '0' });
    await h.setHoldRaw(e, 3, hash(3, ACCOUNT_A));
    await h.setHoldRaw(e, 9, hash(9, ACCOUNT_B));
    await h.setExpiry(e, '9', T - 10);
    await h.setExpiry(e, '10', T - 10);
    await h.setExpiry(e, '2', T - 10);
    await h.setExpiry(e, '3', T - 20);
    await h.setExpiry(e, '4', T);
    await h.setExpiry(e, '5', T + 1);
    const before = await look(h, e);
    expect(await h.store.dueExpiries({ eventId: e, nowMs: T, limit: EXPIRY_BATCH_SIZE })).toEqual([
      { index: 3, expiresAtMs: T - 20, hold: { holdId: 'h3', fencingToken: '1700000000000003', owner: ACCOUNT_A } },
      // 같은 점수는 멤버 글의 바이트 순: '10' < '2' < '9'
      { index: 10, expiresAtMs: T - 10, hold: null },
      { index: 2, expiresAtMs: T - 10, hold: null },
      { index: 9, expiresAtMs: T - 10, hold: { holdId: 'h9', fencingToken: '1700000000000009', owner: ACCOUNT_B } },
      { index: 4, expiresAtMs: T, hold: null },
    ]);
    expect(await look(h, e)).toEqual(before);
  });

  test(`[${name}] ST6_NFR003_ dueExpiries는 limit개까지만 읽고(한 묶음 100석 상한), limit이 1 ~ 100의 정수가 아니거나 회차 ID 모양이 틀리면 RangeError다 [ASVS v5.0.0-15.4.4]`, async () => {
    const { h, e } = await world();
    const T = h.clock.now();
    expect(EXPIRY_BATCH_SIZE).toBe(100);
    for (let i = 0; i < 105; i++) await h.setExpiry(e, String(i), T - 1000 + i);
    const all = await h.store.dueExpiries({ eventId: e, nowMs: T, limit: 100 });
    expect(all.map((d) => d.index)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect((await h.store.dueExpiries({ eventId: e, nowMs: T, limit: 3 })).map((d) => d.index)).toEqual([0, 1, 2]);
    for (const limit of [0, 101, 1.5, -1, Number.NaN]) {
      await expect(h.store.dueExpiries({ eventId: e, nowMs: T, limit }), `limit ${limit}`).rejects.toBeInstanceOf(RangeError);
    }
    for (const eventId of ['a{b}', 'a:b', '', 'x'.repeat(65)]) {
      await expect(h.store.dueExpiries({ eventId, nowMs: T, limit: 100 }), `eventId ${eventId}`).rejects.toBeInstanceOf(RangeError);
    }
  });

  test(`[${name}] ST6_ dueExpiries: 만료 인덱스에만 남은 멤버(고아)는 hold null이고, 지난 좌석이 없거나 만료 인덱스가 없으면(판매 열기 전 포함) []다`, async () => {
    const a = await world();
    const T = a.h.clock.now();
    expect(await a.due()).toEqual([]);
    await a.h.setExpiry(a.e, '7', T + 1000);
    expect(await a.due()).toEqual([]);
    await a.h.setExpiry(a.e, '36', T - 5);
    expect(await a.due(EXPIRY_BATCH_SIZE, T)).toEqual([{ index: 36, expiresAtMs: T - 5, hold: null }]);
    const b = await world({ open: false });
    expect(await b.due()).toEqual([]);
  });

  test(`[${name}] ST4_ dueExpiries: 홀드 Hash의 세 칸 가운데 일부만 있으면 던지지 않고 그 좌석을 corrupt: true로 돌려주며 같은 읽기의 다른 좌석은 그대로 싣는다(망가진 키 격리, 추천 적용 2026-11-04 M2). 아무것도 쓰지 않는다 [ASVS v5.0.0-16.5.3]`, async () => {
    const partial: Record<string, string>[] = [
      { holdId: 'h', kind: 'FAN' },
      { holdId: 'h', fence: '1' },
      { owner: ACCOUNT_A },
      { fence: '1', owner: ACCOUNT_A },
    ];
    for (const fields of partial) {
      const { h, e } = await world();
      const T = h.clock.now();
      await h.setExpiry(e, '7', T - 20);
      await h.setHoldRaw(e, 7, fields);
      await h.setExpiry(e, '8', T - 10);
      await h.setHoldRaw(e, 8, { holdId: 'h8', owner: ACCOUNT_B, psid: 'ps-b', fence: '1700000000000008', heldAt: '1', exp: String(T - 10), kind: 'FAN', ext: '0' });
      const before = await look(h, e);
      const got = await h.store.dueExpiries({ eventId: e, nowMs: T, limit: 100 }).then(
        (d) => d.map((x) => ((x as { corrupt?: boolean }).corrupt === true ? { index: x.index, expiresAtMs: x.expiresAtMs, corrupt: true } : { index: x.index, expiresAtMs: x.expiresAtMs, hold: x.hold })),
        (err: unknown) => `던졌다: ${String(err)}`,
      );
      expect.soft({ fields, got }).toEqual({
        fields,
        got: [
          { index: 7, expiresAtMs: T - 20, corrupt: true },
          { index: 8, expiresAtMs: T - 10, hold: { holdId: 'h8', fencingToken: '1700000000000008', owner: ACCOUNT_B } },
        ],
      });
      expect.soft({ fields, s: await look(h, e) }).toEqual({ fields, s: before });
    }
  });

  test(`[${name}] ST4_ dueExpiries: 만료 인덱스 멤버가 0 이상의 10진 정수 글이 아니면 일시 장애가 아닌 Error(PEAKET_CORRUPT_KEY expiry 키)다 [ASVS v5.0.0-16.5.3]`, async () => {
    for (const member of ['-1', '1.5', 'abc']) {
      const { h, e } = await world();
      const T = h.clock.now();
      await h.setExpiry(e, member, T - 10);
      const err = await bugOf(h.store.dueExpiries({ eventId: e, nowMs: T, limit: 100 }), { member });
      expect.soft({ member, msg: err.message }).toMatchObject({ member, msg: expect.stringContaining('PEAKET_CORRUPT_KEY') });
      expect.soft({ member, msg: err.message }).toMatchObject({ member, msg: expect.stringContaining(seatKeys.expiry(e)) });
    }
  });

  // ---- 2단계: 만료 Lua 성공 쓰기 ----

  test(`[${name}] ST6_FR042_ST33_③ 만료 Lua는 푼 좌석마다 비트 0·홀드 Hash 지움·만료 인덱스에서 빼고, 보유 수를 −k(남으면 수명 그대로, 0이면 키 지움), rel에 지금 + 30초를 넣고 지난 점수를 지우며 rel 수명을 30초로 건다. 결과는 nowUs·푼 수·좌석 차례의 토큰이다`, async () => {
    const { h, e, keepUntilMs, due, expire, ra, rb1, rc, relFuture } = await threeAccounts();
    const d = await due();
    expect(d.map((x) => x.index)).toEqual([idx('A01'), idx('A02'), idx('B01')]);
    const r = okOf(await expire(expireSeatsOf(d)));
    const now = Math.floor(r.nowUs / 1000);
    expect(Number.isSafeInteger(r.nowUs)).toBe(true);
    expect(Math.abs(now - h.clock.now())).toBeLessThanOrEqual(h.skewMs);
    expect({ released: r.released, skipped: r.skipped, orphans: r.orphans }).toEqual({ released: 3, skipped: 0, orphans: 0 });
    expect(r.expired).toEqual([
      { index: idx('A01'), fencingToken: ra.fencingToken },
      { index: idx('A02'), fencingToken: ra.fencingToken },
      { index: idx('B01'), fencingToken: rb1.fencingToken },
    ]);
    for (const id of ['A01', 'A02', 'B01']) {
      expect({ id, bit: await h.bit(e, idx(id)), hold: await h.holdHash(e, idx(id)), score: await h.expiryScore(e, idx(id)) }).toEqual({ id, bit: 0, hold: null, score: null });
    }
    // 시간이 안 지난 홀드는 그대로
    expect(await h.bit(e, idx('B02'))).toBe(1);
    expect(await h.bit(e, idx('A05'))).toBe(1);
    expect(await h.expiryScore(e, idx('A05'))).toBe(rc.expiresAtMs);
    // 보유 수: A 2 − 2 = 0 → 키 지움, B 2 − 1 = 1 → SET … KEEPTTL(홀드 Lua가 건 수명 그대로), C 그대로
    expect(await h.quota(e, ACCOUNT_A)).toBeNull();
    expect(await h.expireAt(e, seatKeys.quota(e, ACCOUNT_A))).toBeNull();
    expect(await h.quota(e, ACCOUNT_B)).toBe(1);
    expect(await h.expireAt(e, seatKeys.quota(e, ACCOUNT_B))).toBe(keepUntilMs);
    expect(await h.quota(e, ACCOUNT_C)).toBe(1);
    // rel: ZREMRANGEBYSCORE -inf 지금(A10 지움) → ZADD 지금 + 30초 → PEXPIRE 30000
    expect(REHOLD_WAIT_MS).toBe(30_000);
    expect(await h.rel(e, ACCOUNT_A)).toEqual({ [String(idx('A01'))]: now + REHOLD_WAIT_MS, [String(idx('A02'))]: now + REHOLD_WAIT_MS, [String(idx('A11'))]: relFuture });
    expect(await h.rel(e, ACCOUNT_B)).toEqual({ [String(idx('B01'))]: now + REHOLD_WAIT_MS });
    expect(await h.rel(e, ACCOUNT_C)).toEqual({});
    for (const a of [ACCOUNT_A, ACCOUNT_B]) {
      const at = await h.expireAt(e, seatKeys.rel(e, a));
      expect(at).not.toBeNull();
      expect(Math.abs(at! - (now + REHOLD_WAIT_MS))).toBeLessThanOrEqual(h.relSlackMs);
    }
    expect(await h.expireAt(e, seatKeys.rel(e, ACCOUNT_C))).toBeNull();
  });

  test(`[${name}] FR042_ 보유 수가 푼 수보다 작아 0 아래가 되면(어긋난 값) 음수로 쓰지 않고 키를 지운다(0 이하면 DEL)`, async () => {
    const { h, e, hold, backdate, due, expire } = await world();
    held(await hold(['A01', 'A02'], { accountId: ACCOUNT_A }));
    held(await hold(['A03'], { accountId: ACCOUNT_B }));
    await backdate(['A01', 'A02', 'A03']);
    // A는 1(푼 수 2), B는 0(푼 수 1)으로 어긋나 있다
    await h.setQuota(e, ACCOUNT_A, 1);
    await h.setQuota(e, ACCOUNT_B, 0);
    const r = okOf(await expire(expireSeatsOf(await due())));
    expect(r.released).toBe(3);
    for (const a of [ACCOUNT_A, ACCOUNT_B]) {
      expect({ a, quota: await h.quota(e, a), at: await h.expireAt(e, seatKeys.quota(e, a)) }).toEqual({ a, quota: null, at: null });
    }
  });

  test(`[${name}] ST5_NFR025_ EXPIRED 사건은 푼 좌석마다 한 건이고 그 홀드의 토큰·구매 세션·소유 계정·만료 시각을 싣는다(새 토큰을 내지 않아 fence 그대로). 바뀐 구역마다 secver +1이고 샤드 Pub/Sub로 상태 0을 보낸다`, async () => {
    const { h, e, seatEpoch, due, expire, ra, rb1, rc, at } = await threeAccounts();
    expect(await h.secver(e)).toEqual({ '0': 2, '1': 2 });
    const streamBefore = (await h.stream(e)).length;
    const pubBefore = (await h.published(e)).length;
    const fenceBefore = await h.fence(e);
    expect(fenceBefore).toBe(String(rc.fencingToken));
    const r = okOf(await expire(expireSeatsOf(await due())));
    const now = Math.floor(r.nowUs / 1000);
    // 구역 0(A01·A02)과 구역 1(B01)이 한 번씩 오른다
    expect(await h.secver(e)).toEqual({ '0': 3, '1': 3 });
    const base = { seatEpoch, nowMs: now, expMs: at };
    expect((await h.stream(e)).slice(streamBefore)).toEqual([
      expiredRow({ ...base, seatId: 'A01', holdId: ra.holdId, psid: 'ps-a', owner: ACCOUNT_A, token: ra.fencingToken, sectionVersion: 3 }),
      expiredRow({ ...base, seatId: 'A02', holdId: ra.holdId, psid: 'ps-a', owner: ACCOUNT_A, token: ra.fencingToken, sectionVersion: 3 }),
      expiredRow({ ...base, seatId: 'B01', holdId: rb1.holdId, psid: 'ps-b', owner: ACCOUNT_B, token: rb1.fencingToken, sectionVersion: 3 }),
    ]);
    expect(SEAT_STATE_AVAILABLE).toBe(0);
    expect((await h.published(e)).slice(pubBefore)).toEqual([
      { channel: seatKeys.section(e, '0'), message: `1 ${seatEpoch} 0 3 ${now} ${ref('A01').seatOffset}:0 ${ref('A02').seatOffset}:0` },
      { channel: seatKeys.section(e, '1'), message: `1 ${seatEpoch} 1 3 ${now} ${ref('B01').seatOffset}:0` },
    ]);
    expect(await h.fence(e)).toBe(fenceBefore);
  });

  test(`[${name}] FR042_ 만료 Lua는 푼 좌석이 있으면 stream·secver 수명을 keepUntil까지 늘리고(더 이르면 둔다) 다른 키의 수명은 바꾸지 않는다`, async () => {
    const { h, e, keepUntilMs: K, hold, backdate, due, expire } = await world();
    held(await hold(['A01'], { accountId: ACCOUNT_A }));
    held(await hold(['A02'], { accountId: ACCOUNT_B }));
    held(await hold(['A03'], { accountId: ACCOUNT_C }));
    const others = [seatKeys.bitmap(e), seatKeys.expiry(e), seatKeys.fence(e), seatKeys.epoch(e), seatKeys.quota(e, ACCOUNT_C)];
    for (const key of [...others, seatKeys.stream(e), seatKeys.secver(e)]) expect({ key, at: await h.expireAt(e, key) }).toEqual({ key, at: K });
    await backdate(['A01']);
    okOf(await expire(expireSeatsOf(await due()), K + DAY));
    expect(await h.expireAt(e, seatKeys.stream(e))).toBe(K + DAY);
    expect(await h.expireAt(e, seatKeys.secver(e))).toBe(K + DAY);
    for (const key of others) expect({ key, at: await h.expireAt(e, key) }).toEqual({ key, at: K });
    // 더 이른 keepUntil이면 두다
    await backdate(['A02']);
    okOf(await expire(expireSeatsOf(await due()), K - 3_600_000));
    expect(await h.expireAt(e, seatKeys.stream(e))).toBe(K + DAY);
    expect(await h.expireAt(e, seatKeys.secver(e))).toBe(K + DAY);
    // 푼 좌석이 없으면(건너뜀만) 늘리지 않는다
    await h.setExpiry(e, String(idx('A03')), h.clock.now() - PAST_MS);
    const r = okOf(await expire(expireSeatsOf(await due()), K + 2 * DAY));
    expect({ released: r.released, skipped: r.skipped }).toEqual({ released: 0, skipped: 1 });
    expect(await h.expireAt(e, seatKeys.stream(e))).toBe(K + DAY);
  });

  test(`[${name}] POL009_ 만료는 fence·세대 키·멱등 기록·이웃 좌석을 건드리지 않는다(구매 세션의 홀드 목록도 만료 Lua 밖이다)`, async () => {
    const { h, e, hold, backdate, due, expire } = await world();
    const key = randomUUID();
    held(await hold(['A01'], { accountId: ACCOUNT_A, idempotencyKey: key }));
    held(await hold(['A02'], { accountId: ACCOUNT_B }));
    await backdate(['A01']);
    const fence = await h.fence(e);
    const epoch = await h.epoch(e);
    const idem = await h.idem(e, ACCOUNT_A, key);
    const idemTtl = await h.idemTtlMs(e, ACCOUNT_A, key);
    const neighbour = { bit: await h.bit(e, idx('A02')), hold: await h.holdHash(e, idx('A02')), score: await h.expiryScore(e, idx('A02')) };
    okOf(await expire(expireSeatsOf(await due())));
    expect(await h.fence(e)).toBe(fence);
    expect(await h.epoch(e)).toEqual(epoch);
    expect(await h.idem(e, ACCOUNT_A, key)).toEqual(idem);
    const ttl = await h.idemTtlMs(e, ACCOUNT_A, key);
    expect(ttl).not.toBeNull();
    expect(ttl!).toBeLessThanOrEqual(idemTtl!);
    expect({ bit: await h.bit(e, idx('A02')), hold: await h.holdHash(e, idx('A02')), score: await h.expiryScore(e, idx('A02')) }).toEqual(neighbour);
  });

  test(`[${name}] ST6_NFR003_ 만료 Lua 한 번에 100석을 푼다(계정 25개, 구역 셋. 1단계도 100석을 한 번에 읽는다) [ASVS v5.0.0-15.4.4]`, async () => {
    const h = await setup();
    const e = newEvent();
    await h.prepare?.(e);
    const keepUntilMs = h.clock.now() + 2 * DAY;
    const { seatEpoch } = await h.store.openSale({ eventId: e, seatCount: 100, keepUntilMs });
    const tokens = new Map<number, number>();
    for (let k = 0; k < 25; k++) {
      const seats = [0, 1, 2, 3].map((j) => bigSeat(k * 4 + j));
      const r = held(await h.store.hold(rawHoldInput(e, seats, { accountId: account(50 + k), keepUntilMs })));
      for (const s of seats) tokens.set(s.index, r.fencingToken);
    }
    const at = h.clock.now() - PAST_MS;
    for (let i = 0; i < 100; i++) {
      await h.setHoldField(e, i, 'exp', String(at));
      await h.setExpiry(e, String(i), at);
    }
    const secBefore = await h.secver(e);
    const pubBefore = (await h.published(e)).length;
    const d = await h.store.dueExpiries({ eventId: e, nowMs: h.clock.now(), limit: EXPIRY_BATCH_SIZE });
    // 같은 점수라 멤버 글 차례('0' < '1' < '10' < …)
    const order = Array.from({ length: 100 }, (_, i) => i).sort((a, b) => (String(a) < String(b) ? -1 : 1));
    expect(d.map((x) => x.index)).toEqual(order);
    const r = okOf(await h.store.expire({ eventId: e, keepUntilMs, seats: d.map((x) => ({ index: x.index, expected: x.hold, seat: bigSeat(x.index) })) }));
    expect({ released: r.released, skipped: r.skipped, orphans: r.orphans }).toEqual({ released: 100, skipped: 0, orphans: 0 });
    expect(r.expired).toEqual(order.map((i) => ({ index: i, fencingToken: tokens.get(i) })));
    expect((await Promise.all(order.map((i) => h.bit(e, i)))).every((b) => b === 0)).toBe(true);
    expect((await Promise.all(Array.from({ length: 25 }, (_, k) => h.quota(e, account(50 + k))))).every((q) => q === null)).toBe(true);
    expect((await h.stream(e)).filter((x) => x.type === 'EXPIRED')).toHaveLength(100);
    expect(await h.secver(e)).toEqual(Object.fromEntries(Object.entries(secBefore).map(([k, v]) => [k, v + 1])));
    // 바뀐 구역마다 한 건(푼 좌석 차례로 처음 나온 차례), 그 구역의 푼 좌석을 좌석 차례로 상태 0
    const sections = [...new Set(order.map((i) => i % 3))];
    const now = Math.floor(r.nowUs / 1000);
    expect((await h.published(e)).slice(pubBefore)).toEqual(
      sections.map((s) => ({
        channel: seatKeys.section(e, String(s)),
        message: `1 ${seatEpoch} ${s} ${secBefore[String(s)]! + 1} ${now} ${order
          .filter((i) => i % 3 === s)
          .map((i) => `${bigSeat(i).seatOffset}:0`)
          .join(' ')}`,
      })),
    );
  });

  test(`[${name}] NFR003_ 만료 입력이 0석이거나 101석, 색인 겹침, expected.owner가 키 조각이 아님, 회차 ID 모양이 틀림이면 RangeError이고 아무것도 바꾸지 않는다 [ASVS v5.0.0-15.4.4]`, async () => {
    const { h, e, keepUntilMs, hold, backdate, due } = await world();
    held(await hold(['A01'], { accountId: ACCOUNT_A }));
    await backdate(['A01']);
    const [d] = await due();
    const ok = expireSeatsOf([d!])[0]!;
    const before = await look(h, e);
    const tooMany: ExpireSeat[] = Array.from({ length: 101 }, (_, i) => ({ index: i, expected: null }));
    const bad: [string, string, ExpireSeat[]][] = [
      ['0석', e, []],
      ['101석', e, tooMany],
      ['색인 겹침', e, [ok, ok]],
      ['owner 모양', e, [{ ...ok, expected: { ...ok.expected!, owner: 's:{x}' } }]],
      ['회차 ID 모양', 'a{b}', [ok]],
      ['회차 ID 콜론', 'a:b', [ok]],
    ];
    for (const [what, eventId, seats] of bad) {
      await expect(h.store.expire({ eventId, keepUntilMs, seats }), what).rejects.toBeInstanceOf(RangeError);
    }
    expect(await look(h, e)).toEqual(before);
  });

  // ---- 펜싱 확인(읽은 뒤 풀리고 다시 잡힌 홀드를 지킨다) ----

  test(`[${name}] ST5_ 읽은 뒤 풀리고 다른 계정이 다시 잡은 홀드는 시간이 지났어도 기대값이 달라 건드리지 않는다(건너뜀). 새 홀드는 자기 토큰으로 나중에 풀린다 [ASVS v5.0.0-15.4.2]`, async () => {
    const { h, e, hold, backdate, due, expire } = await world();
    held(await hold(['A01'], { accountId: ACCOUNT_A }));
    const at = await backdate(['A01']);
    const stale = await due();
    expect(stale[0]!.hold?.owner).toBe(ACCOUNT_A);
    // 1단계 읽기 뒤: A의 홀드가 풀리고(해제를 흉내) B가 같은 좌석을 잡았는데 그 홀드도 시간이 지났다
    await h.setHoldRaw(e, idx('A01'), null);
    await h.clearBit(e, idx('A01'));
    await h.removeExpiry(e, idx('A01'));
    const rb = held(await hold(['A01'], { accountId: ACCOUNT_B }));
    await backdate(['A01'], at);
    const before = await look(h, e);
    const r = okOf(await expire(expireSeatsOf(stale)));
    expect({ released: r.released, skipped: r.skipped, orphans: r.orphans, expired: r.expired }).toEqual({ released: 0, skipped: 1, orphans: 0, expired: [] });
    expect(await look(h, e)).toEqual(before);
    expect(await h.holdHash(e, idx('A01'))).toMatchObject({ owner: ACCOUNT_B, holdId: rb.holdId, fence: String(rb.fencingToken) });
    // 새로 읽으면 B의 기대값이고 B의 토큰으로 푼다
    const fresh = okOf(await expire(expireSeatsOf(await due())));
    expect(fresh.expired).toEqual([{ index: idx('A01'), fencingToken: rb.fencingToken }]);
    expect((await h.stream(e)).filter((x) => x.type === 'EXPIRED').map((x) => [x.accountId, x.fencingToken])).toEqual([[ACCOUNT_B, String(rb.fencingToken)]]);
  });

  test(`[${name}] ST5_ holdId·fence·owner 가운데 하나라도 기대값과 다르면 건너뛰고 아무것도 바꾸지 않는다 [ASVS v5.0.0-15.4.2]`, async () => {
    for (const field of ['holdId', 'fencingToken', 'owner'] as const) {
      const { h, e, hold, backdate, due, expire } = await world();
      held(await hold(['A01'], { accountId: ACCOUNT_A }));
      await backdate(['A01']);
      const [d] = await due();
      const changed = { holdId: randomUUID(), fencingToken: String(BigInt(d!.hold!.fencingToken) + 1n), owner: ACCOUNT_B }[field];
      const before = await look(h, e);
      const r = okOf(await expire([{ index: d!.index, expected: { ...d!.hold!, [field]: changed }, seat: ref('A01') }]));
      expect({ field, released: r.released, skipped: r.skipped, orphans: r.orphans }).toEqual({ field, released: 0, skipped: 1, orphans: 0 });
      expect({ field, s: await look(h, e) }).toEqual({ field, s: before });
    }
  });

  test(`[${name}] ST5_ 건너뜀: Hash exp가 지금보다 크면(연장됨), 만료 인덱스에 멤버가 없으면(이미 뺌), Hash도 멤버도 없으면(이미 풀림), 기대가 null(고아)이었는데 Hash가 생겼으면 아무것도 바꾸지 않는다 [ASVS v5.0.0-15.4.2]`, async () => {
    const { h, e, hold, backdate, due, expire } = await world();
    const past = h.clock.now() - PAST_MS;
    // 연장됨: 만료 인덱스 점수는 지났는데 Hash exp는 지금 + 7분
    held(await hold(['A01'], { accountId: ACCOUNT_A }));
    await h.setExpiry(e, String(idx('A01')), past);
    // 이미 뺌: 읽은 뒤 ZREM
    held(await hold(['A02'], { accountId: ACCOUNT_B }));
    await backdate(['A02'], past);
    // 이미 풀림: 읽은 뒤 Hash·멤버 모두 없음
    held(await hold(['A03'], { accountId: ACCOUNT_C }));
    await backdate(['A03'], past);
    // 고아였는데 읽은 뒤 Hash가 생김
    await h.setExpiry(e, '36', past);
    const d = await due();
    expect(d.map((x) => x.index)).toEqual([idx('A01'), idx('A02'), idx('A03'), 36]);
    expect(d[3]!.hold).toBeNull();
    await h.removeExpiry(e, idx('A02'));
    await h.setHoldRaw(e, idx('A03'), null);
    await h.removeExpiry(e, idx('A03'));
    await h.setHoldRaw(e, 36, { holdId: 'h36', owner: ACCOUNT_D, psid: 'ps-d', fence: '1', heldAt: '1', exp: String(past), kind: 'FAN', ext: '0' });
    const before = await look(h, e);
    const r = okOf(await expire(expireSeatsOf(d)));
    expect({ released: r.released, skipped: r.skipped, orphans: r.orphans, expired: r.expired }).toEqual({ released: 0, skipped: 4, orphans: 0, expired: [] });
    expect(await look(h, e)).toEqual(before);
  });

  test(`[${name}] FR042_ 같은 묶음으로 두 번 부르면 두 번째는 건너뜀이다(두 파드가 함께 돌아도 한 홀드를 한 번만 푼다: 보유 수·rel·Stream 한 번) [ASVS v5.0.0-15.4.2]`, async () => {
    const { h, e, hold, backdate, due, expire } = await world();
    held(await hold(['A01', 'A02'], { accountId: ACCOUNT_A }));
    held(await hold(['A03'], { accountId: ACCOUNT_A }));
    await backdate(['A01', 'A02']);
    const seats = expireSeatsOf(await due());
    const [r1, r2] = await Promise.all([expire(seats), expire(seats)]);
    const rs = [okOf(r1!), okOf(r2!)];
    expect(rs.map((r) => r.released).sort()).toEqual([0, 2]);
    expect(rs.map((r) => r.skipped).sort()).toEqual([0, 2]);
    expect(await h.quota(e, ACCOUNT_A)).toBe(1);
    expect((await h.stream(e)).filter((x) => x.type === 'EXPIRED')).toHaveLength(2);
    expect(Object.keys(await h.rel(e, ACCOUNT_A)).sort()).toEqual([String(idx('A01')), String(idx('A02'))].sort());
  });

  // ---- 고아 ----

  test(`[${name}] ST6_ 고아(홀드 Hash 없이 만료 인덱스에만 남은 좌석)는 기대값과 관계없이 ZREM만 한다. 비트·보유 수·rel·Stream·Pub/Sub·키 수명은 그대로이고 결과는 OK다`, async () => {
    const { h, e, keepUntilMs: K, hold, backdate, due, expire } = await world();
    held(await hold(['A01'], { accountId: ACCOUNT_A }));
    // 시간이 안 지난 홀드 하나를 남긴다(Valkey는 빈 정렬 집합을 지워 만료 인덱스 키의 수명까지 사라지므로, '키 수명 그대로'를 보려면 멤버가 남아야 한다)
    held(await hold(['A03'], { accountId: ACCOUNT_C }));
    await backdate(['A01']);
    const [withHold] = await due();
    // 1단계 뒤 Hash만 사라진 좌석(기대값 있음)과 처음부터 고아(기대값 null)
    await h.setHoldRaw(e, idx('A01'), null);
    await h.setExpiry(e, '36', h.clock.now() - PAST_MS);
    const before = await look(h, e);
    const r = okOf(await expire([expireSeatsOf([withHold!])[0]!, { index: 36, expected: null }], K + DAY));
    expect({ released: r.released, skipped: r.skipped, orphans: r.orphans, expired: r.expired }).toEqual({ released: 0, skipped: 0, orphans: 2, expired: [] });
    const after = await look(h, e);
    expect(await h.expiryScore(e, idx('A01'))).toBeNull();
    expect(await h.expiryScore(e, 36)).toBeNull();
    // 만료 인덱스 점수 말고는 그대로(비트 A01은 1인 채)
    expect({ ...after, expiry: null }).toEqual({ ...before, expiry: null });
    expect(await h.bit(e, idx('A01'))).toBe(1);
    expect(await h.quota(e, ACCOUNT_A)).toBe(1);
  });

  // ---- 세대 키(S-T26 ③) ----

  test(`[${name}] ST26_③ 세대 키가 없으면 만료도 NOT_READY이고 아무것도 쓰지 않는다. 쓰기 전 지킴(지난 keepUntil·망가진 보유 수)보다 먼저다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.5.3]`, async () => {
    const { h, e, hold, backdate, due, expire } = await world();
    held(await hold(['A01'], { accountId: ACCOUNT_A }));
    await backdate(['A01']);
    const seats = expireSeatsOf(await due());
    await h.dropEpoch(e);
    const before = await look(h, e);
    expect(await expire(seats)).toEqual({ kind: 'NOT_READY' });
    expect(await look(h, e)).toEqual(before);
    expect(await expire(seats, h.clock.now() - PAST_MS)).toEqual({ kind: 'NOT_READY' });
    await h.setQuota(e, ACCOUNT_A, 1.5);
    const before2 = await look(h, e);
    expect(await expire(seats)).toEqual({ kind: 'NOT_READY' });
    expect(await look(h, e)).toEqual(before2);
    // 판매를 열지 않은 회차도 같다
    const n = await world({ open: false });
    expect(await n.expire([{ index: 36, expected: null }])).toEqual({ kind: 'NOT_READY' });
  });

  // ---- 쓰기 전 지킴(입력 전체로 본다) ----

  // ---- 망가진 키 격리(추천 적용 2026-11-04 M2): 좌석·계정 하나에 걸린 망가짐은 그 좌석만 건너뛰고(corrupt) 나머지는 같은 묶음에서 푼다 ----

  /** 좌석들의 비트·홀드 Hash·만료 인덱스 점수(건드리지 않았는지 보려고) */
  const seatState = async (h: ExpiryHarness, e: string, seatIds: readonly string[]) =>
    Promise.all(seatIds.map(async (id) => ({ id, bit: await h.bit(e, idx(id)), hold: await h.holdHash(e, idx(id)), score: await h.expiryScore(e, idx(id)) })));
  const corruptOf = (r: Extract<ExpireResult, { kind: 'OK' }>) => (r as { corrupt?: number }).corrupt;

  test(`[${name}] ST4_ 만료 망가진 키 격리: 한 계정의 보유 수 값이 10진 정수 글이 아니면 그 계정 좌석만 건너뛰고(corrupt) 같은 묶음의 다른 계정 좌석은 푼다. 망가진 계정의 좌석·보유 수·rel은 그대로다 [ASVS v5.0.0-16.5.3]`, async () => {
    for (const bad of [1.5, -1]) {
      const { h, e, hold, backdate, due, expire } = await world();
      held(await hold(['A01', 'A02'], { accountId: ACCOUNT_A }));
      const rb = held(await hold(['B01'], { accountId: ACCOUNT_B }));
      await backdate(['A01', 'A02', 'B01']);
      const seats = expireSeatsOf(await due());
      await h.setQuota(e, ACCOUNT_A, bad);
      const aBefore = await seatState(h, e, ['A01', 'A02']);
      const out = await expire(seats).then(
        (r) => okOf(r),
        (err: unknown) => `던졌다: ${String(err)}`,
      );
      if (typeof out === 'string') {
        expect.soft({ bad, out }).toEqual({ bad, out: 'OK' });
        continue;
      }
      const now = Math.floor(out.nowUs / 1000);
      expect.soft({ bad, released: out.released, corrupt: corruptOf(out), skipped: out.skipped, orphans: out.orphans, expired: out.expired }).toEqual({
        bad,
        released: 1,
        corrupt: 2,
        skipped: 0,
        orphans: 0,
        expired: [{ index: idx('B01'), fencingToken: rb.fencingToken }],
      });
      expect.soft({ bad, a: await seatState(h, e, ['A01', 'A02']) }).toEqual({ bad, a: aBefore });
      expect.soft({ bad, quotaA: await h.quota(e, ACCOUNT_A), relA: await h.rel(e, ACCOUNT_A) }).toEqual({ bad, quotaA: bad, relA: {} });
      expect.soft({ bad, bitB: await h.bit(e, idx('B01')), quotaB: await h.quota(e, ACCOUNT_B), relB: await h.rel(e, ACCOUNT_B) }).toEqual({
        bad,
        bitB: 0,
        quotaB: null,
        relB: { [String(idx('B01'))]: now + REHOLD_WAIT_MS },
      });
      expect.soft({ bad, expired: (await h.stream(e)).filter((x) => x.type === 'EXPIRED').map((x) => x.seatId) }).toEqual({ bad, expired: ['B01'] });
    }
  });

  test(`[${name}] ST4_ 만료 망가진 키 격리: secver에서 한 구역 칸 값이 정수 글이 아니면 그 구역 좌석만 건너뛰고(corrupt) 다른 구역 좌석은 푼다. 망가진 구역 칸·좌석은 그대로이고 그 구역 델타는 없다. 입력에 없는 구역 칸은 보지 않는다 [ASVS v5.0.0-16.5.3]`, async () => {
    for (const bad of [1.5, -1]) {
      const { h, e, hold, backdate, due, expire } = await world();
      const ra = held(await hold(['A01'], { accountId: ACCOUNT_A }));
      held(await hold(['B01'], { accountId: ACCOUNT_B }));
      held(await hold(['B02'], { accountId: ACCOUNT_C }));
      await backdate(['A01', 'B01', 'B02']);
      const seats = expireSeatsOf(await due());
      await h.setSecverRaw(e, 1, bad);
      const bBefore = await seatState(h, e, ['B01', 'B02']);
      const pubBefore = (await h.published(e)).length;
      const out = await expire(seats).then(
        (r) => okOf(r),
        (err: unknown) => `던졌다: ${String(err)}`,
      );
      if (typeof out === 'string') {
        expect.soft({ bad, out }).toEqual({ bad, out: 'OK' });
        continue;
      }
      expect.soft({ bad, released: out.released, corrupt: corruptOf(out), expired: out.expired }).toEqual({ bad, released: 1, corrupt: 2, expired: [{ index: idx('A01'), fencingToken: ra.fencingToken }] });
      expect.soft({ bad, b: await seatState(h, e, ['B01', 'B02']) }).toEqual({ bad, b: bBefore });
      expect.soft({ bad, secver: await h.secver(e) }).toEqual({ bad, secver: { '0': 2, '1': bad } });
      expect.soft({ bad, channels: (await h.published(e)).slice(pubBefore).map((p) => p.channel) }).toEqual({ bad, channels: [seatKeys.section(e, '0')] });
      expect.soft({ bad, quota: [await h.quota(e, ACCOUNT_B), await h.quota(e, ACCOUNT_C)] }).toEqual({ bad, quota: [1, 1] });
    }
    // 입력에 없는 구역(2) 칸이 망가져도 푼다
    const { h, e, hold, backdate, due, expire } = await world();
    held(await hold(['A01'], { accountId: ACCOUNT_A }));
    await backdate(['A01']);
    await h.setSecverRaw(e, 2, 1.5);
    const r = okOf(await expire(expireSeatsOf(await due())));
    expect(r.released).toBe(1);
    expect(await h.secver(e)).toEqual({ '0': 2, '2': 1.5 });
  });

  test(`[${name}] ST4_ 만료 쓰기 전 지킴: keepUntil이 지금 이하면 PEAKET_KEEP_UNTIL_PAST이고 아무것도 쓰지 않는다 [ASVS v5.0.0-16.5.3]`, async () => {
    const { h, e, hold, backdate, due, expire } = await world();
    held(await hold(['A01'], { accountId: ACCOUNT_A }));
    await backdate(['A01']);
    const seats = expireSeatsOf(await due());
    const before = await look(h, e);
    const err = await bugOf(expire(seats, h.clock.now() - PAST_MS), { keepUntil: '1분 전' });
    expect(err.message).toContain('PEAKET_KEEP_UNTIL_PAST');
    expect(await look(h, e)).toEqual(before);
  });

  test(`[${name}] ST4_ 만료 망가진 키 격리: 홀드 Hash의 exp가 10진 정수 글이 아니거나 없으면 그 좌석만 건너뛰고(corrupt) 같은 홀드의 다른 좌석과 다른 계정 좌석은 푼다(보유 수는 푼 수만큼만 내린다) [ASVS v5.0.0-16.5.3]`, async () => {
    for (const how of ['exp 1.5', 'exp 없음'] as const) {
      const { h, e, hold, backdate, due, expire, keepUntilMs } = await world();
      const ra = held(await hold(['A01', 'A02'], { accountId: ACCOUNT_A }));
      const rb = held(await hold(['B01'], { accountId: ACCOUNT_B }));
      await backdate(['A01', 'A02', 'B01']);
      if (how === 'exp 1.5') await h.setHoldField(e, idx('A02'), 'exp', '1.5');
      else {
        const { exp: _gone, ...rest } = (await h.holdHash(e, idx('A02')))!;
        await h.setHoldRaw(e, idx('A02'), rest);
      }
      const seats = expireSeatsOf(await due());
      const a02 = await seatState(h, e, ['A02']);
      const out = await expire(seats).then(
        (r) => okOf(r),
        (err: unknown) => `던졌다: ${String(err)}`,
      );
      if (typeof out === 'string') {
        expect.soft({ how, out }).toEqual({ how, out: 'OK' });
        continue;
      }
      const now = Math.floor(out.nowUs / 1000);
      expect.soft({ how, released: out.released, corrupt: corruptOf(out), expired: out.expired }).toEqual({
        how,
        released: 2,
        corrupt: 1,
        expired: [
          { index: idx('A01'), fencingToken: ra.fencingToken },
          { index: idx('B01'), fencingToken: rb.fencingToken },
        ],
      });
      expect.soft({ how, a02: await seatState(h, e, ['A02']) }).toEqual({ how, a02 });
      // A는 2석 가운데 1석만 풀렸다: 보유 수 2 → 1(수명 그대로), rel에는 A01만
      expect.soft({ how, quotaA: await h.quota(e, ACCOUNT_A), at: await h.expireAt(e, seatKeys.quota(e, ACCOUNT_A)), relA: await h.rel(e, ACCOUNT_A) }).toEqual({
        how,
        quotaA: 1,
        at: keepUntilMs,
        relA: { [String(idx('A01'))]: now + REHOLD_WAIT_MS },
      });
      expect.soft({ how, bits: [await h.bit(e, idx('A01')), await h.bit(e, idx('B01'))] }).toEqual({ how, bits: [0, 0] });
    }
  });

  test(`[${name}] ST4_ 만료 망가진 키 격리: 묶음의 좌석이 모두 망가졌으면 OK(푼 수 0, corrupt = 좌석 수)이고 아무것도 쓰지 않는다 [ASVS v5.0.0-16.5.3]`, async () => {
    const { h, e, hold, backdate, due, expire } = await world();
    held(await hold(['A01', 'A02'], { accountId: ACCOUNT_A }));
    await backdate(['A01', 'A02']);
    const seats = expireSeatsOf(await due());
    await h.setQuota(e, ACCOUNT_A, 1.5);
    const before = await look(h, e);
    const out = await expire(seats).then(
      (r) => r,
      (err: unknown) => ({ kind: `던졌다: ${String(err)}` }),
    );
    expect({ kind: out.kind, released: (out as { released?: number }).released, corrupt: (out as { corrupt?: number }).corrupt }).toEqual({ kind: 'OK', released: 0, corrupt: 2 });
    expect(await look(h, e)).toEqual(before);
  });

  // ---- 최종 검토 결함의 재현(추천 적용 2026-11-04): A1 값 모양 지킴이 INCRBY·HINCRBY의 조건과 같아야 한다, A2 만료 Lua가 홀드 Hash의 fence 모양도 본다 ----

  test(`[${name}] ST4_ 홀드는 보유 수 값이 표준 10진 정수가 아니면('007'·20자리·'1.5'·' 5'·'-1'·'') INCRBY가 쓰기 도중 실패하지 않게 쓰기 전에 PEAKET_CORRUPT_KEY(quota 키)로 거절하고 아무것도 쓰지 않는다. 비트·홀드 Hash만 써지고 사건·멱등이 빠지는 일이 없다(A1) [ASVS v5.0.0-16.5.3]`, async () => {
    for (const bad of NOT_STANDARD_INT) {
      const { h, e, hold } = await world();
      await h.setQuotaRaw(e, ACCOUNT_A, bad);
      const before = await look(h, e);
      const key = randomUUID();
      // 한도를 넉넉히 줘 한도 검사에서 걸리지 않게 한다(걸리면 쓰기까지 가지 못해 '쓰다가 멈춤'을 볼 수 없다)
      const out = await settled(hold(['A01', 'B01'], { accountId: ACCOUNT_A, idempotencyKey: key, limit: 1000 }));
      expect.soft({ bad, text: errorText(out) }).toMatchObject({ bad, text: expect.stringContaining('PEAKET_CORRUPT_KEY') });
      expect.soft({ bad, text: errorText(out) }).toMatchObject({ bad, text: expect.stringContaining(seatKeys.quota(e, ACCOUNT_A)) });
      expect.soft({ bad, s: await look(h, e) }).toEqual({ bad, s: before });
      expect.soft({ bad, idem: await h.idem(e, ACCOUNT_A, key) }).toEqual({ bad, idem: null });
    }
  });

  test(`[${name}] ST4_ 홀드는 바뀔 구역의 secver 칸 값이 표준 10진 정수가 아니면('007'·20자리·'1.5'·' 5'·'-1'·'') HINCRBY가 쓰기 도중 실패하지 않게 쓰기 전에 PEAKET_CORRUPT_KEY(secver 키)로 거절하고 아무것도 쓰지 않는다(A1) [ASVS v5.0.0-16.5.3]`, async () => {
    for (const bad of NOT_STANDARD_INT) {
      const { h, e, hold } = await world();
      // 구역 1은 B01의 구역이라 바뀔 구역이다. 구역 0(A01)은 정상이라 먼저 올려진다: 쓰다가 멈추면 구역 0이 올라가 있다
      await h.setSecverRaw(e, 1, bad);
      const before = await look(h, e);
      const key = randomUUID();
      const out = await settled(hold(['A01', 'B01'], { accountId: ACCOUNT_A, idempotencyKey: key, limit: 1000 }));
      expect.soft({ bad, text: errorText(out) }).toMatchObject({ bad, text: expect.stringContaining('PEAKET_CORRUPT_KEY') });
      expect.soft({ bad, text: errorText(out) }).toMatchObject({ bad, text: expect.stringContaining(seatKeys.secver(e)) });
      expect.soft({ bad, s: await look(h, e) }).toEqual({ bad, s: before });
      expect.soft({ bad, idem: await h.idem(e, ACCOUNT_A, key) }).toEqual({ bad, idem: null });
    }
  });

  test(`[${name}] ST4_ 보유 수·secver 칸이 18자리 끝값('999999999999999999')이면 표준 10진 정수라 쓰기 전 지킴을 지난다: 보유 수는 한도 검사까지 가서 QUOTA_EXCEEDED이고(아무것도 쓰지 않음), secver 칸은 홀드가 된다(A1)`, async () => {
    const a = await world();
    await a.h.setQuotaRaw(a.e, ACCOUNT_A, MAX_STANDARD_INT);
    const before = await look(a.h, a.e);
    const r = await settled(a.hold(['A01'], { accountId: ACCOUNT_A }));
    expect.soft({ r: r.ok ? r.v : errorText(r) }).toEqual({ r: { kind: 'QUOTA_EXCEEDED' } });
    expect.soft(await look(a.h, a.e)).toEqual(before);
    const b = await world();
    await b.h.setSecverRaw(b.e, 0, MAX_STANDARD_INT);
    const r2 = await settled(b.hold(['A01'], { accountId: ACCOUNT_A }));
    expect.soft({ r2: r2.ok ? (r2.v as { kind: string }).kind : errorText(r2) }).toEqual({ r2: 'OK' });
  });

  test(`[${name}] ST5_ fence 값은 SET만 하는 값이라 A1 규칙의 대상이 아니다: 앞 0이 있는 '007'도 지금처럼 받아 토큰은 그때의 µs다(A1이 fence까지 번지지 않게 고정)`, async () => {
    const { h, e, hold } = await world();
    await h.setFence(e, '007');
    const r = held(await hold(['A01']));
    expect(Math.floor(r.fencingToken / 1000)).toBe(r.heldAtMs);
    expect(await h.fence(e)).toBe(String(r.fencingToken));
  });

  test(`[${name}] ST4_ 만료는 보유 수 값이 표준 10진 정수가 아니면('007'·20자리·'1.5'·' 5'·'-1'·'') 그 계정 좌석만 건너뛰고(corrupt) 같은 묶음의 다른 계정 좌석은 푼다. 망가진 계정의 좌석·보유 수·rel은 그대로다. 18자리 끝값이면 푼다(A1) [ASVS v5.0.0-16.5.3]`, async () => {
    for (const bad of NOT_STANDARD_INT) {
      const { h, e, hold, backdate, due, expire } = await world();
      held(await hold(['A01', 'A02'], { accountId: ACCOUNT_A }));
      const rb = held(await hold(['B01'], { accountId: ACCOUNT_B }));
      await backdate(['A01', 'A02', 'B01']);
      const seats = expireSeatsOf(await due());
      await h.setQuotaRaw(e, ACCOUNT_A, bad);
      const aBefore = await seatState(h, e, ['A01', 'A02']);
      const quotaBefore = await h.quota(e, ACCOUNT_A);
      const out = await settled(expire(seats));
      expect.soft({ bad, r: expireSummary(out) }).toEqual({ bad, r: { released: 1, corrupt: 2, skipped: 0, orphans: 0, expired: [{ index: idx('B01'), fencingToken: rb.fencingToken }] } });
      expect.soft({ bad, a: await seatState(h, e, ['A01', 'A02']), quota: await h.quota(e, ACCOUNT_A), rel: await h.rel(e, ACCOUNT_A) }).toEqual({ bad, a: aBefore, quota: quotaBefore, rel: {} });
      expect.soft({ bad, bitB: await h.bit(e, idx('B01')), quotaB: await h.quota(e, ACCOUNT_B) }).toEqual({ bad, bitB: 0, quotaB: null });
    }
    // 18자리 끝값은 표준 10진 정수다: 그 계정 좌석도 푼다(풀고 난 보유 수 값은 어긋난 큰 값이라 보지 않는다)
    const { h, e, hold, backdate, due, expire } = await world();
    held(await hold(['A01'], { accountId: ACCOUNT_A }));
    await backdate(['A01']);
    const seats = expireSeatsOf(await due());
    await h.setQuotaRaw(e, ACCOUNT_A, MAX_STANDARD_INT);
    const out = await settled(expire(seats));
    expect.soft({ r: expireSummary(out) }).toMatchObject({ r: { released: 1, corrupt: 0 } });
    expect.soft(await h.bit(e, idx('A01'))).toBe(0);
  });

  test(`[${name}] ST4_ 만료는 바뀔 구역의 secver 칸 값이 표준 10진 정수가 아니면('007'·20자리·'1.5'·' 5'·'-1'·'') 그 구역 좌석만 건너뛰고(corrupt) 다른 구역 좌석은 푼다(HINCRBY가 쓰기 도중 실패하지 않는다). 망가진 구역 칸·좌석은 그대로이고 그 구역 델타는 없다. 18자리 끝값이면 푼다(A1) [ASVS v5.0.0-16.5.3]`, async () => {
    for (const bad of NOT_STANDARD_INT) {
      const { h, e, hold, backdate, due, expire } = await world();
      const ra = held(await hold(['A01'], { accountId: ACCOUNT_A }));
      held(await hold(['B01'], { accountId: ACCOUNT_B }));
      held(await hold(['B02'], { accountId: ACCOUNT_C }));
      await backdate(['A01', 'B01', 'B02']);
      const seats = expireSeatsOf(await due());
      await h.setSecverRaw(e, 1, bad);
      const bBefore = await seatState(h, e, ['B01', 'B02']);
      const secBefore = await h.secver(e);
      const pubBefore = (await h.published(e)).length;
      const out = await settled(expire(seats));
      expect.soft({ bad, r: expireSummary(out) }).toEqual({ bad, r: { released: 1, corrupt: 2, skipped: 0, orphans: 0, expired: [{ index: idx('A01'), fencingToken: ra.fencingToken }] } });
      expect.soft({ bad, b: await seatState(h, e, ['B01', 'B02']) }).toEqual({ bad, b: bBefore });
      expect.soft({ bad, secver: await h.secver(e) }).toEqual({ bad, secver: { ...secBefore, '0': (secBefore['0'] ?? 0) + 1 } });
      expect.soft({ bad, channels: (await h.published(e)).slice(pubBefore).map((p) => p.channel) }).toEqual({ bad, channels: [seatKeys.section(e, '0')] });
      expect.soft({ bad, quota: [await h.quota(e, ACCOUNT_B), await h.quota(e, ACCOUNT_C)] }).toEqual({ bad, quota: [1, 1] });
    }
    const { h, e, hold, backdate, due, expire } = await world();
    held(await hold(['A01'], { accountId: ACCOUNT_A }));
    await backdate(['A01']);
    const seats = expireSeatsOf(await due());
    await h.setSecverRaw(e, 0, MAX_STANDARD_INT);
    const out = await settled(expire(seats));
    expect.soft({ r: expireSummary(out) }).toMatchObject({ r: { released: 1, corrupt: 0 } });
    expect.soft(await h.bit(e, idx('A01'))).toBe(0);
  });

  test(`[${name}] ST4_ST5_ 만료는 홀드 Hash의 fence가 표준 10진 정수('^[1-9]%d*$')가 아니거나('abc'·'007'·'0'·'') 2^53 − 1(9007199254740991)을 넘으면('9007199254740992'·17자리·20자리) 그 좌석만 건너뛴다(corrupt). 1단계가 읽은 기대값이 같은 값이어도 풀지 않고, 앱이 던지거나 회차가 오류가 되지 않는다. 나머지 좌석은 푼다(A2) [ASVS v5.0.0-16.5.3]`, async () => {
    for (const bad of BAD_FENCES) {
      const { h, e, hold, backdate, expire } = await world();
      const ra = held(await hold(['A01'], { accountId: ACCOUNT_A }));
      const rb = held(await hold(['B01'], { accountId: ACCOUNT_B }));
      await backdate(['A01', 'B01']);
      await h.setHoldField(e, idx('A01'), 'fence', bad);
      const a01 = await seatState(h, e, ['A01']);
      // 기대값이 Hash의 값과 같다(1단계가 그 값을 읽은 것처럼): 모양을 보지 않으면 푼다
      const seats: ExpireSeat[] = [
        { index: idx('A01'), expected: { holdId: ra.holdId, fencingToken: bad, owner: ACCOUNT_A }, seat: ref('A01') },
        { index: idx('B01'), expected: { holdId: rb.holdId, fencingToken: String(rb.fencingToken), owner: ACCOUNT_B }, seat: ref('B01') },
      ];
      const out = await settled(expire(seats));
      expect.soft({ bad, r: expireSummary(out) }).toEqual({ bad, r: { released: 1, corrupt: 1, skipped: 0, orphans: 0, expired: [{ index: idx('B01'), fencingToken: rb.fencingToken }] } });
      expect.soft({ bad, a01: await seatState(h, e, ['A01']), quotaA: await h.quota(e, ACCOUNT_A), relA: await h.rel(e, ACCOUNT_A) }).toEqual({ bad, a01, quotaA: 1, relA: {} });
      expect.soft({ bad, expired: (await h.stream(e)).filter((x) => x.type === 'EXPIRED').map((x) => x.seatId) }).toEqual({ bad, expired: ['B01'] });
    }
  });

  test(`[${name}] ST4_ST5_ dueExpiries는 홀드 Hash의 fence가 표준 10진 정수가 아니거나('abc'·'007'·'0'·'') 2^53 − 1을 넘으면('9007199254740992'·17자리·20자리) 던지지 않고 그 좌석을 { hold: null, corrupt: true }로 돌려준다. 같은 읽기의 정상 좌석은 그대로이고 아무것도 쓰지 않는다(A2) [ASVS v5.0.0-16.5.3]`, async () => {
    for (const bad of BAD_FENCES) {
      const { h, e, hold, backdate } = await world();
      held(await hold(['A01'], { accountId: ACCOUNT_A }));
      const rb = held(await hold(['B01'], { accountId: ACCOUNT_B }));
      const at = await backdate(['A01', 'B01']);
      await h.setHoldField(e, idx('A01'), 'fence', bad);
      const before = await look(h, e);
      const out = await settled(h.store.dueExpiries({ eventId: e, nowMs: h.clock.now(), limit: 100 }));
      expect.soft({ bad, got: out.ok ? out.v : errorText(out) }).toEqual({
        bad,
        got: [
          { index: idx('A01'), expiresAtMs: at, hold: null, corrupt: true },
          { index: idx('B01'), expiresAtMs: at, hold: { holdId: rb.holdId, fencingToken: String(rb.fencingToken), owner: ACCOUNT_B } },
        ],
      });
      expect.soft({ bad, s: await look(h, e) }).toEqual({ bad, s: before });
    }
  });

  test(`[${name}] ST5_ 만료는 홀드 Hash의 fence가 2^53 − 1 이하의 표준 10진 정수면('9007199254740991'·'9007199254740990'·15자리 끝 '999999999999999') 푼다: 1단계도 정상 홀드로 읽고 푼 토큰은 안전한 정수 그대로다(A2 경계 고정)`, async () => {
    for (const ok of OK_FENCES) {
      const { h, e, hold, backdate, due, expire } = await world();
      const ra = held(await hold(['A01'], { accountId: ACCOUNT_A }));
      const at = await backdate(['A01']);
      await h.setHoldField(e, idx('A01'), 'fence', ok);
      const d = await due();
      expect.soft({ ok, d }).toEqual({ ok, d: [{ index: idx('A01'), expiresAtMs: at, hold: { holdId: ra.holdId, fencingToken: ok, owner: ACCOUNT_A } }] });
      const out = await settled(expire(expireSeatsOf(d)));
      expect.soft({ ok, r: expireSummary(out) }).toEqual({ ok, r: { released: 1, corrupt: 0, skipped: 0, orphans: 0, expired: [{ index: idx('A01'), fencingToken: Number(ok) }] } });
      expect.soft({ ok, bit: await h.bit(e, idx('A01')) }).toEqual({ ok, bit: 0 });
    }
  });

  // ---- 좌석맵 판에 없는 색인(결정 목록 '뒤에 정한 것' 2026-11-04) ----

  test(`[${name}] FR042_ 좌석맵 판에 없는 색인(seat 없이 기대값만)도 풀고, EXPIRED의 seatId·tierId·sectionId는 빈 글이며 그 좌석 몫의 secver·샤드 Pub/Sub는 없다`, async () => {
    const { h, e, keepUntilMs, seatEpoch, backdateIdx, due, expire } = await world();
    const ghost: SeatRef = { seatId: 'Z35', index: 35, sectionId: 'SEC-Z', sectionIndex: 2, seatOffset: 5, tierId: 'R' };
    const rz = held(await h.store.hold(rawHoldInput(e, [ghost], { accountId: ACCOUNT_A, keepUntilMs, purchaseSessionId: 'ps-z' })));
    const at = await backdateIdx([35]);
    const d = await due();
    expect(d).toEqual([{ index: 35, expiresAtMs: at, hold: { holdId: rz.holdId, fencingToken: String(rz.fencingToken), owner: ACCOUNT_A } }]);
    const secBefore = await h.secver(e);
    const pubBefore = (await h.published(e)).length;
    const r = okOf(await expire([{ index: 35, expected: d[0]!.hold }]));
    const now = Math.floor(r.nowUs / 1000);
    expect({ released: r.released, expired: r.expired }).toEqual({ released: 1, expired: [{ index: 35, fencingToken: rz.fencingToken }] });
    expect({ bit: await h.bit(e, 35), hold: await h.holdHash(e, 35), score: await h.expiryScore(e, 35), quota: await h.quota(e, ACCOUNT_A) }).toEqual({ bit: 0, hold: null, score: null, quota: null });
    expect(await h.rel(e, ACCOUNT_A)).toEqual({ '35': now + REHOLD_WAIT_MS });
    expect((await h.stream(e)).at(-1)).toMatchObject({
      type: 'EXPIRED',
      seatIdx: '35',
      seatId: '',
      tierId: '',
      sectionId: '',
      holdId: rz.holdId,
      holdKind: 'FAN',
      purchaseSessionId: 'ps-z',
      accountId: ACCOUNT_A,
      fencingToken: String(rz.fencingToken),
      seatEpoch: String(seatEpoch),
      occurredAtMs: String(now),
      expiresAtMs: String(at),
    });
    expect(await h.secver(e)).toEqual(secBefore);
    expect((await h.published(e)).length).toBe(pubBefore);
  });

  // ---- 만료 뒤 다시 잡기(FR-042, POL-012, S-T33 ③) ----

  test(`[${name}] FR042_POL012_ST33_③ 만료 뒤 같은 좌석을 다른 계정은 바로 잡고, 같은 계정은 30초 안이면 REHOLD_WAIT(availableAtMs = 푼 시각 + 30초)다`, async () => {
    const { hold, backdate, due, expire } = await world();
    held(await hold(['A01', 'A02'], { accountId: ACCOUNT_A }));
    await backdate(['A01', 'A02']);
    const r = okOf(await expire(expireSeatsOf(await due())));
    const now = Math.floor(r.nowUs / 1000);
    held(await hold(['A01'], { accountId: ACCOUNT_B }));
    expect(await hold(['A02'], { accountId: ACCOUNT_A })).toEqual({ kind: 'REHOLD_WAIT', seatIds: ['A02'], availableAtMs: now + REHOLD_WAIT_MS });
    // 다른 사람이 잡은 좌석이 섞이면 경합이 먼저다
    expect(await hold(['A01', 'A02'], { accountId: ACCOUNT_A })).toEqual({ kind: 'CONFLICT', seatId: 'A01' });
    held(await hold(['A02'], { accountId: ACCOUNT_C }));
  });

  // ---- 홀드 쪽 덧붙임 지킴(PRF-130 리뷰 낮음 3·4) ----

  test(`[${name}] ST4_ 홀드도 secver의 바뀔 구역 칸 값이 정수 글이 아니면(1.5·−1) 쓰기 전에 거절한다(PEAKET_CORRUPT_KEY secver 키, 아무것도 쓰지 않음). 바뀌지 않을 구역 칸은 보지 않는다 [ASVS v5.0.0-16.5.3]`, async () => {
    for (const bad of [1.5, -1]) {
      const { h, e, hold } = await world();
      await h.setSecverRaw(e, 1, bad);
      const before = await look(h, e);
      const key = randomUUID();
      const err = await bugOf(hold(['A01', 'B01'], { accountId: ACCOUNT_A, idempotencyKey: key }), { secver: bad });
      expect.soft({ bad, msg: err.message }).toMatchObject({ bad, msg: expect.stringContaining('PEAKET_CORRUPT_KEY') });
      expect.soft({ bad, msg: err.message }).toMatchObject({ bad, msg: expect.stringContaining(seatKeys.secver(e)) });
      expect.soft({ bad, s: await look(h, e) }).toEqual({ bad, s: before });
      expect.soft({ bad, idem: await h.idem(e, ACCOUNT_A, key) }).toEqual({ bad, idem: null });
    }
    const { h, e, hold } = await world();
    await h.setSecverRaw(e, 2, 1.5);
    held(await hold(['A01'], { accountId: ACCOUNT_A }));
    expect(await h.secver(e)).toEqual({ '0': 1, '2': 1.5 });
  });

  test(`[${name}] ST5_ 토큰이 안전한 정수를 넘는 홀드의 오류 글에는 PEAKET_FENCE_OVERFLOW가 있다(지표 code FENCE_OVERFLOW가 메모리·Lua에서 같게) [ASVS v5.0.0-16.5.3]`, async () => {
    const { h, e, hold } = await world();
    await h.setFence(e, '9007199254740991');
    const err = await bugOf(hold(['A01']));
    expect(err.message).toContain('PEAKET_FENCE_OVERFLOW');
  });

  // ---- 회차 목록 ----

  test(`[${name}] NFR025_ saleEvents는 판매를 연 회차를 겹침 없이 돌려주고, 열지 않은 회차는 싣지 않는다`, async () => {
    const { h, e, keepUntilMs } = await world();
    const e2 = newEvent();
    await h.store.openSale({ eventId: e2, seatCount: SEAT_COUNT, keepUntilMs });
    await h.store.openSale({ eventId: e2, seatCount: SEAT_COUNT, keepUntilMs });
    const list = await h.store.saleEvents();
    expect(list).toContain(e);
    expect(list).toContain(e2);
    expect(list).not.toContain(newEvent());
    expect(new Set(list).size).toBe(list.length);
  });

  test(`[${name}] NFR025_ saleEvents는 s:ctl:events의 값 가운데 회차 ID 모양(KEY_PART)이 아닌 것을 거른다(해시 태그를 깨는 값이 임대·만료 키에 들어가지 않게, 추천 적용 2026-11-04 L8)`, async () => {
    const { h, e } = await world();
    const junk = ['bad{x}', 'a:b', '', 'x'.repeat(65), 's:{event:e}', 'a b'];
    for (const raw of junk) await h.addCtlEvent(raw);
    const list = await h.store.saleEvents();
    expect(list).toContain(e);
    expect(list.filter((x) => !KEY_PART.test(x))).toEqual([]);
    for (const raw of junk) expect({ raw, listed: list.includes(raw) }).toEqual({ raw, listed: false });
  });

  // ---- 만료 임대(s:{event:E}:sweep) ----

  test(`[${name}] NFR025_ 만료 임대: 처음 잡으면 true·값 = 파드 ID·수명 3초, 다른 파드는 살아 있는 동안 false, 내 것이면 수명을 다시 3초로 늘리고, 수명이 다하면 다른 파드가 잡는다`, async () => {
    const { h, e } = await world();
    expect(SWEEP_LEASE_TTL_MS).toBe(3000);
    expect(await h.leases.acquire(e, 'pod-a', SWEEP_LEASE_TTL_MS)).toBe(true);
    expect(await h.lease(e)).toBe('pod-a');
    const ttl = await h.leaseTtlMs(e);
    expect(ttl).not.toBeNull();
    expect(ttl!).toBeLessThanOrEqual(SWEEP_LEASE_TTL_MS);
    expect(ttl!).toBeGreaterThan(SWEEP_LEASE_TTL_MS - 1000);
    expect(await h.leases.acquire(e, 'pod-b', SWEEP_LEASE_TTL_MS)).toBe(false);
    expect(await h.lease(e)).toBe('pod-a');
    await h.shortenLease(e, 500);
    // 남의 임대는 잡지 못한 파드가 늘리지 않는다(수명이 500ms 그대로라 늦어도 그때 넘겨받을 수 있다)
    expect(await h.leases.acquire(e, 'pod-b', SWEEP_LEASE_TTL_MS)).toBe(false);
    const left = await h.leaseTtlMs(e);
    expect(left).not.toBeNull();
    expect(left!).toBeLessThanOrEqual(500);
    expect(await h.lease(e)).toBe('pod-a');
    expect(await h.leases.acquire(e, 'pod-a', SWEEP_LEASE_TTL_MS)).toBe(true);
    expect(await h.leaseTtlMs(e)).toBeGreaterThan(SWEEP_LEASE_TTL_MS - 1000);
    await h.passLeaseTtl(e);
    expect(await h.leases.acquire(e, 'pod-b', SWEEP_LEASE_TTL_MS)).toBe(true);
    expect(await h.lease(e)).toBe('pod-b');
    expect(await h.leases.acquire(e, 'pod-a', SWEEP_LEASE_TTL_MS)).toBe(false);
    // 회차마다 따로다
    const other = newEvent();
    expect(await h.leases.acquire(other, 'pod-a', SWEEP_LEASE_TTL_MS)).toBe(true);
  });

  test(`[${name}] NFR025_ 만료 임대의 회차 ID·파드 ID가 키 조각 모양이 아니거나 수명이 1 이상의 안전한 정수가 아니면 RangeError이고 아무것도 쓰지 않는다`, async () => {
    const { h, e } = await world();
    const bad: [string, string, number][] = [
      ['a{b}', 'pod-a', 3000],
      ['a:b', 'pod-a', 3000],
      [e, 'pod:a', 3000],
      [e, '', 3000],
      [e, 'pod-a', 0],
      [e, 'pod-a', -1],
      [e, 'pod-a', 1.5],
      [e, 'pod-a', Number.MAX_SAFE_INTEGER + 1],
    ];
    for (const [eventId, owner, ttl] of bad) {
      await expect(h.leases.acquire(eventId, owner, ttl), JSON.stringify([eventId, owner, ttl])).rejects.toBeInstanceOf(RangeError);
    }
    expect(await h.lease(e)).toBeNull();
  });
}
