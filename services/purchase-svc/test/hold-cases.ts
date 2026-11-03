// 좌석 저장소(SeatStore) 계약 사례(docs/features/seat-hold.md §3 '운영 홀드 Lua의 키·입력·검사 차례'·§4·§5, docs/data.md §3 좌석 키 표,
// src/modules/inventory/adapters/hold-lua.ts). 메모리 저장소(test/hold-seats.test.ts)와 실제 Valkey 8.1 Lua(test-int/seat-store.int.test.ts)에 똑같이 돈다.
// Lua 안의 시각은 Redis TIME이라 시험이 바꿀 수 없다. 그래서 '방금 놓은 좌석'은 rel 점수를, 장애 전환 뒤의 토큰은 fence 값을 미리 써 넣어 만든다(고정 sleep 없음).
import { createHash, randomUUID } from 'node:crypto';
import { type Clock, systemClock, uuidv7 } from '@peaket/platform';
import { expect, test } from 'vitest';
import {
  HOLD_TTL_MS,
  type HeldHold,
  type HoldInput,
  type HoldResult,
  IDEM_TTL_MS,
  type MemorySeatDef,
  type SeatRef,
  type SeatStore,
  SeatStoreUnavailable,
  seatKeys,
} from '../src/modules/inventory/index.js';

export const DAY = 24 * 3600_000;
export const ACCOUNT_A = '0190f3a1-7c2e-7a00-8000-0000000000a1';
export const ACCOUNT_B = '0190f3a1-7c2e-7a00-8000-0000000000b1';
export const ACCOUNT_C = '0190f3a1-7c2e-7a00-8000-0000000000c1';
export const ACCOUNT_D = '0190f3a1-7c2e-7a00-8000-0000000000d1';
/** 여러 계정이 필요할 때(0 ~ 99는 위 넷과 겹치지 않는다) */
export const account = (n: number) => `0190f3a1-7c2e-7a00-8000-${n.toString(16).padStart(12, '0')}`;

let n = 0;
/** 시험마다 다른 회차 ID(실제 Valkey를 시험끼리 나눠 쓴다). KEY_PART 모양이다 */
export const newEvent = () => `ev-${process.pid}-${Date.now().toString(36)}-${n++}`;

const seatRow = (prefix: string, count: number, from: number, sectionIndex: number, tierId: string): MemorySeatDef[] =>
  Array.from({ length: count }, (_, i) => ({
    seatId: `${prefix}${String(i + 1).padStart(2, '0')}`,
    index: from + i,
    sectionId: `SEC-${prefix}`,
    sectionIndex,
    seatOffset: i,
    tierId,
  }));

/** 회차 좌석 수(비트맵 크기). 색인 31 ~ 39는 판에 없는 자리다 */
export const SEAT_COUNT = 40;
/**
 * 시험 좌석맵 판: 구역 A(구역 색인 0, 등급 R) A01 ~ A20 = 색인 0 ~ 19, 구역 B(구역 색인 1, 등급 S) B01 ~ B10 = 색인 20 ~ 29,
 * 판매 제외석 X01 = 색인 30. 좌석 ID는 0을 채워 문자 코드 순과 색인 순이 같다
 */
export const SEAT_DEFS: MemorySeatDef[] = [
  ...seatRow('A', 20, 0, 0, 'R'),
  ...seatRow('B', 10, 20, 1, 'S'),
  { seatId: 'X01', index: 30, sectionId: 'SEC-X', sectionIndex: 2, seatOffset: 0, tierId: 'R', saleExcluded: true },
];

/** 판의 좌석(판매 제외 표시 없이). 없는 좌석이면 던진다 */
export function ref(seatId: string): SeatRef {
  const d = SEAT_DEFS.find((s) => s.seatId === seatId);
  if (!d) throw new Error(`시험 판에 없는 좌석: ${seatId}`);
  const { saleExcluded: _x, ...r } = d;
  return r;
}
export const idx = (seatId: string) => ref(seatId).index;

/** 홀드 지문의 시험 쪽 계산(seat-hold.md §3 '멱등키'의 '지문'): 문자 코드 순 정렬 → LF로 이음 → UTF-8 SHA-256 소문자 hex */
export function fingerprintOf(seatIds: readonly string[]): string {
  return createHash('sha256').update([...seatIds].sort().join('\n'), 'utf8').digest('hex');
}

/** HoldInput 만들기(부르는 쪽 HoldSeats가 맞추는 규칙대로: 좌석 ID 오름차순, 지문, 새 holdId) */
export function holdInput(eventId: string, seatIds: readonly string[], c: Partial<Omit<HoldInput, 'eventId' | 'seats'>> & { keepUntilMs: number }): HoldInput {
  const sorted = [...seatIds].sort();
  const accountId = c.accountId ?? ACCOUNT_A;
  return {
    eventId,
    accountId,
    purchaseSessionId: c.purchaseSessionId ?? `ps-${accountId.slice(-4)}`,
    holdId: c.holdId ?? uuidv7(systemClock),
    idempotencyKey: c.idempotencyKey ?? randomUUID(),
    fingerprint: c.fingerprint ?? fingerprintOf(sorted),
    seats: sorted.map(ref),
    limit: c.limit ?? 4,
    keepUntilMs: c.keepUntilMs,
  };
}

/** 저장소 하나와 그 키를 직접 채우고 읽는 도구. 키 이름은 docs/data.md §3(seatKeys)이다 */
export interface SeatHarness {
  store: SeatStore;
  /** 시험 쪽 지금. 메모리는 저장소에 넣은 가짜 시계, Valkey는 시스템 시계(Lua는 Redis TIME) */
  clock: Clock;
  /** 저장소가 정한 시각(heldAt·세대)과 clock.now()의 허용 차이(ms). 메모리는 0 */
  skewMs: number;
  /** 저장소 시각을 1ms 앞으로(메모리: 시계를 민다. Valkey: TIME이 흐르므로 아무것도 하지 않는다) */
  tick(): Promise<void>;
  /** 멱등 기록 수명(7분)이 지난 것으로 만든다(메모리: 시계를 7분 넘게 민다. Valkey: 키 만료를 흉내 내 지운다) */
  passIdemTtl(eventId: string, accountId: string, key: string): Promise<void>;
  /** fence 글을 쓴다(null이면 지운다: 장애 전환으로 잃은 것) */
  setFence(eventId: string, value: string | null): Promise<void>;
  setCtl(eventId: string, fields: Record<string, string>): Promise<void>;
  /** 그 계정이 방금 놓은 좌석(점수 = 다시 잡을 수 있는 시각 ms). 해제·만료 Lua가 쓰는 것을 흉내 낸다 */
  setRel(eventId: string, accountId: string, index: number, atMs: number): Promise<void>;
  setQuota(eventId: string, accountId: string, n: number): Promise<void>;
  /** 비트를 0으로(잡은 사람의 홀드가 풀린 것을 흉내 낸다) */
  clearBit(eventId: string, index: number): Promise<void>;
  /** 세대 키를 지운다(S-T26 ③) */
  dropEpoch(eventId: string): Promise<void>;
  /** 비트는 0인 채 옛 홀드 Hash를 칸 extra와 함께 남겨 둔다 */
  setStaleHold(eventId: string, index: number, extra: Record<string, string>): Promise<void>;
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
  idem(eventId: string, accountId: string, key: string): Promise<{ fp: string; resp: string } | null>;
  /** 멱등 기록의 남은 수명(ms). 없으면 null */
  idemTtlMs(eventId: string, accountId: string, key: string): Promise<number | null>;
  /** 키의 PEXPIREAT 시각(epoch ms). 키가 없거나 만료가 없으면 null */
  expireAt(eventId: string, key: string): Promise<number | null>;
  epoch(eventId: string): Promise<{ epoch: number; node: string } | null>;
  inCtlEvents(eventId: string): Promise<boolean>;
  /** 비트맵 크기(비트). 비트맵이 없으면 null(Valkey는 바이트 수 × 8) */
  bitmapBits(eventId: string): Promise<number | null>;
  /** 회차 키를 쓰기 전에 한 번 부른다(Valkey: 그 회차 구역 채널을 샤드 Pub/Sub로 구독한다) */
  prepare?(eventId: string): Promise<void>;
  /** 그 회차 구역 채널로 보낸 샤드 Pub/Sub(보낸 차례). 메모리는 저장소가 적은 것, Valkey는 prepare에서 구독한 연결이 받은 것 */
  published(eventId: string): Promise<{ channel: string; message: string }[]>;
}

/** 결과가 OK(또는 IDEM_REPLAY)인지 보고 HeldHold 칸만 꺼낸다 */
export function held(r: HoldResult, kind: 'OK' | 'IDEM_REPLAY' = 'OK'): HeldHold {
  expect(r.kind).toBe(kind);
  if (r.kind !== 'OK' && r.kind !== 'IDEM_REPLAY') throw new Error(`${kind}가 아니다: ${JSON.stringify(r)}`);
  return { holdId: r.holdId, fencingToken: r.fencingToken, heldAtMs: r.heldAtMs, expiresAtMs: r.expiresAtMs };
}

/**
 * 멱등 재생 읽기(SeatStore.replay, 추천 적용 2026-11-04, 새 맥락 리뷰): 앱이 판매 종료 410·없는 좌석 422·회차 설정 없음 503으로 거절하기 전에
 * 한 번 부른다. 같은 계정·같은 키의 기록이 같은 지문이면 처음 응답(IDEM_REPLAY), 다른 지문이면 IDEM_REUSED, 없거나 수명이 지났으면 null이다.
 * 아무것도 쓰지 않는다. 구현이 SeatStore에 더하기 전까지 시험은 이 형으로 부른다
 */
export interface ReplayInput {
  eventId: string;
  accountId: string;
  idempotencyKey: string;
  fingerprint: string;
}
export type ReplayResult = ({ kind: 'IDEM_REPLAY' } & HeldHold) | { kind: 'IDEM_REUSED' } | null;
export interface ReplayPort {
  replay(i: ReplayInput): Promise<ReplayResult>;
}
/** 저장소의 replay(없으면 그 까닭을 밝혀 던진다) */
export function replayOf(store: SeatStore): (i: ReplayInput) => Promise<ReplayResult> {
  const f = (store as Partial<ReplayPort>).replay;
  if (typeof f !== 'function') throw new Error('SeatStore.replay가 없다(앱 쪽 거절 전 멱등 재생 읽기, 추천 적용 2026-11-04)');
  return (i) => f.call(store, i);
}

/** 저장소 호출이 일시 장애가 아닌 Error로 끝나는지 본다(풀리면 그 결과가 실패 문구에 보인다). 표의 줄마다 부를 수 있게 expect.soft로 본다 */
export async function expectBug(p: Promise<unknown>, what?: unknown): Promise<void> {
  const out = await p.then(
    (v: unknown) => ({ ok: true as const, v }),
    (x: unknown) => ({ ok: false as const, x }),
  );
  expect.soft(out.ok, `${JSON.stringify(what) ?? ''} 던지지 않고 풀렸다: ${out.ok ? JSON.stringify(out.v) : ''}`).toBe(false);
  if (out.ok) return;
  expect.soft(out.x, `${JSON.stringify(what) ?? ''} 던진 것: ${String(out.x)}`).toBeInstanceOf(Error);
  expect.soft(out.x, `${JSON.stringify(what) ?? ''} 일시 장애로 던졌다`).not.toBeInstanceOf(SeatStoreUnavailable);
}

const ACCOUNTS = [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C, ACCOUNT_D];

/** 회차 키 전체의 모습('아무것도 바뀌지 않았다'를 보려고 앞뒤로 견준다) */
async function snapshot(h: SeatHarness, e: string) {
  const all = SEAT_DEFS.map((d) => d.index);
  return {
    bits: await Promise.all(all.map((i) => h.bit(e, i))),
    holds: await Promise.all(all.map((i) => h.holdHash(e, i))),
    expiry: await Promise.all(all.map((i) => h.expiryScore(e, i))),
    quota: await Promise.all(ACCOUNTS.map((a) => h.quota(e, a))),
    quotaExpire: await Promise.all(ACCOUNTS.map((a) => h.expireAt(e, seatKeys.quota(e, a)))),
    fence: await h.fence(e),
    secver: await h.secver(e),
    stream: await h.stream(e),
    published: (await h.published(e)).length,
    expire: await Promise.all([seatKeys.bitmap(e), seatKeys.expiry(e), seatKeys.fence(e), seatKeys.stream(e), seatKeys.secver(e)].map((k) => h.expireAt(e, k))),
    holdExpire: await Promise.all(all.map((i) => h.expireAt(e, seatKeys.hold(e, i)))),
  };
}

export function holdCases(name: string, setup: () => Promise<SeatHarness>): void {
  async function world(o: { open?: boolean; keepUntilMs?: number } = {}) {
    const h = await setup();
    const eventId = newEvent();
    await h.prepare?.(eventId);
    const keepUntilMs = o.keepUntilMs ?? h.clock.now() + 2 * DAY;
    const opened = o.open === false ? undefined : await h.store.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs });
    const input = (seatIds: readonly string[], c: Partial<Omit<HoldInput, 'eventId' | 'seats'>> = {}) => holdInput(eventId, seatIds, { keepUntilMs, ...c });
    const hold = (seatIds: readonly string[], c: Partial<Omit<HoldInput, 'eventId' | 'seats'>> = {}) => h.store.hold(input(seatIds, c));
    return { h, eventId, e: eventId, keepUntilMs, opened, seatEpoch: opened?.seatEpoch, input, hold };
  }

  // ---- 성공과 그 칸 ----

  test(`[${name}] FR010_POL012_ 잡으면 OK와 holdId·펜싱 토큰·잡은 시각을 주고 만료 시각은 잡은 시각 + 7분이다`, async () => {
    const { h, input } = await world();
    const i = input(['A01', 'A02']);
    const before = h.clock.now();
    const r = held(await h.store.hold(i));
    expect(r.holdId).toBe(i.holdId);
    expect(Math.abs(r.heldAtMs - before)).toBeLessThanOrEqual(h.skewMs);
    expect(HOLD_TTL_MS).toBe(7 * 60_000);
    expect(r.expiresAtMs).toBe(r.heldAtMs + HOLD_TTL_MS);
    expect(Number.isSafeInteger(r.fencingToken)).toBe(true);
    // fence가 없으면 토큰 = 그때의 µs라, ms로 내리면 잡은 시각이다
    expect(Math.floor(r.fencingToken / 1000)).toBe(r.heldAtMs);
  });

  test(`[${name}] FR010_ 쓰기 뒤 상태: 좌석마다 비트 1·홀드 Hash 여덟 칸·만료 인덱스 점수 exp, 보유 수 += 좌석 수, fence = 토큰 글, 멱등 기록 fp·resp(수명 7분)`, async () => {
    const { h, e, input } = await world();
    const i = input(['B01', 'A02', 'A01'], { accountId: ACCOUNT_A, purchaseSessionId: 'ps-a' });
    const r = held(await h.store.hold(i));
    const tok = String(r.fencingToken);
    for (const id of ['A01', 'A02', 'B01']) {
      expect(await h.bit(e, idx(id))).toBe(1);
      expect(await h.holdHash(e, idx(id))).toEqual({ holdId: i.holdId, owner: ACCOUNT_A, psid: 'ps-a', fence: tok, heldAt: String(r.heldAtMs), exp: String(r.expiresAtMs), kind: 'FAN', ext: '0' });
      expect(await h.expiryScore(e, idx(id))).toBe(r.expiresAtMs);
    }
    // 이웃 좌석은 그대로
    expect(await h.bit(e, idx('A03'))).toBe(0);
    expect(await h.holdHash(e, idx('A03'))).toBeNull();
    expect(await h.expiryScore(e, idx('A03'))).toBeNull();
    expect(await h.quota(e, ACCOUNT_A)).toBe(3);
    expect(await h.fence(e)).toBe(tok);
    expect(await h.idem(e, ACCOUNT_A, i.idempotencyKey)).toEqual({ fp: i.fingerprint, resp: `${i.holdId}:${r.heldAtMs}:${r.expiresAtMs}:${tok}` });
    expect(IDEM_TTL_MS).toBe(HOLD_TTL_MS);
    const ttl = await h.idemTtlMs(e, ACCOUNT_A, i.idempotencyKey);
    expect(ttl).not.toBeNull();
    expect(ttl!).toBeLessThanOrEqual(IDEM_TTL_MS);
    expect(ttl!).toBeGreaterThan(IDEM_TTL_MS - 10_000 - h.skewMs);
  });

  test(`[${name}] FR010_ST35_① 바뀐 구역마다 secver +1(구역마다 한 번)이고, Stream HELD는 좌석마다 한 건이며 칸은 data.md §3대로다(occurredAtMs = 잡은 시각)`, async () => {
    const { h, e, input, seatEpoch } = await world();
    const i1 = input(['A01', 'A02', 'B01'], { accountId: ACCOUNT_A });
    const r1 = held(await h.store.hold(i1));
    expect(await h.secver(e)).toEqual({ '0': 1, '1': 1 });
    const i2 = input(['A03'], { accountId: ACCOUNT_B });
    const r2 = held(await h.store.hold(i2));
    expect(await h.secver(e)).toEqual({ '0': 2, '1': 1 });
    const row = (id: string, i: HoldInput, r: HeldHold, sectionVersion: number) => ({
      type: 'HELD',
      seatIdx: String(idx(id)),
      seatId: id,
      tierId: ref(id).tierId,
      sectionId: ref(id).sectionId,
      holdId: i.holdId,
      holdKind: 'FAN',
      purchaseSessionId: i.purchaseSessionId,
      accountId: i.accountId,
      fencingToken: String(r.fencingToken),
      sectionVersion: String(sectionVersion),
      seatEpoch: String(seatEpoch),
      occurredAtMs: String(r.heldAtMs),
      expiresAtMs: String(r.expiresAtMs),
    });
    expect(await h.stream(e)).toEqual([row('A01', i1, r1, 1), row('A02', i1, r1, 1), row('B01', i1, r1, 1), row('A03', i2, r2, 2)]);
    // 샤드 Pub/Sub: 바뀐 구역마다 한 건, '1 {seatEpoch} {구역 색인} {구역 번호} {heldAt} {seatOffset}:1 …'(Valkey는 실제 SSUBSCRIBE로 받은 것)
    expect(await h.published(e)).toEqual([
      { channel: seatKeys.section(e, '0'), message: `1 ${seatEpoch} 0 1 ${r1.heldAtMs} 0:1 1:1` },
      { channel: seatKeys.section(e, '1'), message: `1 ${seatEpoch} 1 1 ${r1.heldAtMs} 0:1` },
      { channel: seatKeys.section(e, '0'), message: `1 ${seatEpoch} 0 2 ${r2.heldAtMs} 2:1` },
    ]);
  });

  test(`[${name}] FR010_ 홀드 Hash에 있던 칸은 지우고 새로 쓴다`, async () => {
    const { h, e, input } = await world();
    await h.setStaleHold(e, idx('A04'), { orderedAt: '123', remainMs: '5' });
    const i = input(['A04']);
    const r = held(await h.store.hold(i));
    expect(await h.holdHash(e, idx('A04'))).toEqual({
      holdId: i.holdId,
      owner: i.accountId,
      psid: i.purchaseSessionId,
      fence: String(r.fencingToken),
      heldAt: String(r.heldAtMs),
      exp: String(r.expiresAtMs),
      kind: 'FAN',
      ext: '0',
    });
  });

  test(`[${name}] FR010_ 키 수명: 판매 열기와 홀드는 PEXPIREAT keepUntil을 걸고, 더 늦은 keepUntil이면 올리고 더 이르면 두며(새 키에는 건다), 거절한 홀드는 걸지 않는다. 세대 키도 홀드가 같은 규칙으로 늘린다`, async () => {
    const { h, e, keepUntilMs: K, hold } = await world();
    const at = (key: string) => h.expireAt(e, key);
    expect(await at(seatKeys.bitmap(e))).toBe(K);
    expect(await at(seatKeys.epoch(e))).toBe(K);
    // 세대 키(epoch)도 홀드 Lua가 늘린다(추천 적용 2026-11-04): 비트맵보다 먼저 지워져 산 회차가 NOT_READY가 되지 않게
    const shared = [seatKeys.bitmap(e), seatKeys.fence(e), seatKeys.expiry(e), seatKeys.stream(e), seatKeys.secver(e), seatKeys.epoch(e)];
    held(await hold(['A01'], { accountId: ACCOUNT_A }));
    for (const key of [...shared, seatKeys.hold(e, idx('A01')), seatKeys.quota(e, ACCOUNT_A)]) expect({ key, at: await at(key) }).toEqual({ key, at: K });
    // 더 늦은 keepUntil이면 올린다
    const later = K + 3600_000;
    held(await hold(['A02'], { accountId: ACCOUNT_B, keepUntilMs: later }));
    for (const key of [...shared, seatKeys.hold(e, idx('A02')), seatKeys.quota(e, ACCOUNT_B)]) expect({ key, at: await at(key) }).toEqual({ key, at: later });
    expect(await at(seatKeys.hold(e, idx('A01')))).toBe(K);
    expect(await at(seatKeys.quota(e, ACCOUNT_A))).toBe(K);
    // 더 이른 keepUntil이면 이미 걸린 키는 두고, 새로 생긴 키에는 건다
    const earlier = K - 3600_000;
    held(await hold(['A03'], { accountId: ACCOUNT_C, keepUntilMs: earlier }));
    for (const key of shared) expect({ key, at: await at(key) }).toEqual({ key, at: later });
    expect(await at(seatKeys.hold(e, idx('A03')))).toBe(earlier);
    expect(await at(seatKeys.quota(e, ACCOUNT_C))).toBe(earlier);
    // 거절한 홀드: 보유 수 키를 만들지 않고 어느 키 수명도 바꾸지 않는다
    expect(await hold(['A01'], { accountId: ACCOUNT_D, keepUntilMs: later + 3600_000 })).toEqual({ kind: 'CONFLICT', seatId: 'A01' });
    expect(await at(seatKeys.quota(e, ACCOUNT_D))).toBeNull();
    for (const key of shared) expect({ key, at: await at(key) }).toEqual({ key, at: later });
  });

  // ---- 전부 되거나 전부 안 되기(S-T4) ----

  test(`[${name}] ST4_ 좌석 2~4개 가운데 하나만 남이 잡았으면 CONFLICT이고 아무 좌석도·보유 수·Stream·fence·secver·키 수명도 바뀌지 않는다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-2.3.3]`, async () => {
    const cases: [string[], string][] = [
      [['A01', 'A02'], 'A02'],
      [['A01', 'A02', 'A03'], 'A02'],
      [['A01', 'A02', 'A03', 'A04'], 'A01'],
      [['A01', 'A02', 'A03', 'B04'], 'B04'],
    ];
    for (const [mine, taken] of cases) {
      const { h, e, hold, keepUntilMs } = await world();
      held(await hold([taken], { accountId: ACCOUNT_B }));
      const before = await snapshot(h, e);
      const key = randomUUID();
      // 더 늦은 keepUntil을 넘겨, 거절한 홀드가 키 수명을 건드리면 드러나게 한다
      expect({ mine, r: await hold(mine, { accountId: ACCOUNT_A, idempotencyKey: key, keepUntilMs: keepUntilMs + DAY }) }).toEqual({ mine, r: { kind: 'CONFLICT', seatId: taken } });
      expect(await snapshot(h, e)).toEqual(before);
      expect(await h.idem(e, ACCOUNT_A, key)).toBeNull();
    }
  });

  test(`[${name}] ST3_ST4_ 한도 초과·방금 놓은 좌석·판매 정지·멱등 키 재사용·세대 키 없음으로 거절해도 아무것도 쓰지 않는다(키 수명·멱등 기록 포함) [ASVS v5.0.0-2.2.3]`, async () => {
    const { h, e, hold, keepUntilMs } = await world();
    // 거절할 시도에는 더 늦은 keepUntil을 넘긴다(키 수명을 건드리면 snapshot의 expire가 바뀐다)
    const later = keepUntilMs + DAY;
    const k0 = randomUUID();
    held(await hold(['A10'], { accountId: ACCOUNT_A, idempotencyKey: k0 }));
    const idem0 = await h.idem(e, ACCOUNT_A, k0);
    expect(idem0).not.toBeNull();
    await h.setQuota(e, ACCOUNT_B, 2);
    await h.setRel(e, ACCOUNT_C, idx('A02'), h.clock.now() + 60_000);
    const before = await snapshot(h, e);
    const tries: { what: string; seat: string; accountId: string; limit: number; kind: HoldResult['kind']; key: string }[] = [
      { what: '한도', seat: 'A01', accountId: ACCOUNT_B, limit: 2, kind: 'QUOTA_EXCEEDED', key: randomUUID() },
      { what: '방금 놓은 좌석', seat: 'A02', accountId: ACCOUNT_C, limit: 4, kind: 'REHOLD_WAIT', key: randomUUID() },
      { what: '멱등 키 재사용', seat: 'A03', accountId: ACCOUNT_A, limit: 4, kind: 'IDEM_REUSED', key: k0 },
    ];
    for (const t of tries) {
      const r = await hold([t.seat], { accountId: t.accountId, limit: t.limit, idempotencyKey: t.key, keepUntilMs: later });
      expect({ what: t.what, kind: r.kind }).toEqual({ what: t.what, kind: t.kind });
      expect({ what: t.what, s: await snapshot(h, e) }).toEqual({ what: t.what, s: before });
      if (t.kind !== 'IDEM_REUSED') expect(await h.idem(e, t.accountId, t.key)).toBeNull();
    }
    // 멱등 키 재사용은 처음 기록을 바꾸지 않는다
    expect(await h.idem(e, ACCOUNT_A, k0)).toEqual(idem0);
    await h.setCtl(e, { paused: '1' });
    const kp = randomUUID();
    expect((await hold(['A04'], { accountId: ACCOUNT_D, idempotencyKey: kp, keepUntilMs: later })).kind).toBe('PAUSED');
    expect(await snapshot(h, e)).toEqual(before);
    expect(await h.idem(e, ACCOUNT_D, kp)).toBeNull();
    await h.setCtl(e, { paused: '0' });
    await h.dropEpoch(e);
    const kn = randomUUID();
    expect((await hold(['A05'], { accountId: ACCOUNT_D, idempotencyKey: kn, keepUntilMs: later })).kind).toBe('NOT_READY');
    expect(await snapshot(h, e)).toEqual(before);
    expect(await h.idem(e, ACCOUNT_D, kn)).toBeNull();
  });

  // ---- 경합(S-T1, S-T3) ----

  test(`[${name}] ST1_ 같은 좌석 하나를 30개 계정이 동시에 잡으면 OK는 하나이고 나머지는 그 좌석의 CONFLICT다(초과 홀드 0) [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.2]`, async () => {
    const { h, e, hold } = await world();
    const who = Array.from({ length: 30 }, (_, i) => account(i));
    const rs = await Promise.all(who.map((a) => hold(['A05'], { accountId: a })));
    const winners = who.filter((_, i) => rs[i]!.kind === 'OK');
    expect(winners).toHaveLength(1);
    expect(rs.filter((r) => r.kind !== 'OK')).toEqual(Array.from({ length: 29 }, () => ({ kind: 'CONFLICT', seatId: 'A05' })));
    expect(await h.bit(e, idx('A05'))).toBe(1);
    expect((await h.holdHash(e, idx('A05')))?.owner).toBe(winners[0]);
    expect((await Promise.all(who.map((a) => h.quota(e, a)))).filter((q) => q !== null)).toEqual([1]);
    expect(await h.stream(e)).toHaveLength(1);
  });

  test(`[${name}] ST3_POL011_ 같은 계정이 좌석 하나씩 10번 동시에 잡으면 한도 2만큼만 OK이고 나머지 8번은 QUOTA_EXCEEDED다 [ASVS v5.0.0-2.3.2]`, async () => {
    const { h, e, hold } = await world();
    const seats = Array.from({ length: 10 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`);
    const rs = await Promise.all(seats.map((s) => hold([s], { accountId: ACCOUNT_A, limit: 2 })));
    expect(rs.filter((r) => r.kind === 'OK')).toHaveLength(2);
    expect(rs.filter((r) => r.kind === 'QUOTA_EXCEEDED')).toHaveLength(8);
    expect(await h.quota(e, ACCOUNT_A)).toBe(2);
    const bits = await Promise.all(seats.map((s) => h.bit(e, idx(s))));
    expect(bits.reduce((a, b) => a + b, 0)).toBe(2);
    expect(await h.stream(e)).toHaveLength(2);
  });

  test(`[${name}] POL011_ 보유 수 + 좌석 수가 한도와 같으면 잡고, 넘으면 QUOTA_EXCEEDED다(보유 수 키가 없으면 0)`, async () => {
    const { h, e, hold } = await world();
    expect((await hold(['A01', 'A02', 'A03'], { accountId: ACCOUNT_A, limit: 2 })).kind).toBe('QUOTA_EXCEEDED');
    held(await hold(['A01', 'A02'], { accountId: ACCOUNT_A, limit: 2 }));
    expect((await hold(['A03'], { accountId: ACCOUNT_A, limit: 2 })).kind).toBe('QUOTA_EXCEEDED');
    expect(await h.quota(e, ACCOUNT_A)).toBe(2);
    // 한도 4(최대): 보유 1 + 4석 = 5는 안 되고, 보유 1 + 3석 = 4는 된다
    await h.setQuota(e, ACCOUNT_B, 1);
    expect((await hold(['B01', 'B02', 'B03', 'B04'], { accountId: ACCOUNT_B, limit: 4 })).kind).toBe('QUOTA_EXCEEDED');
    held(await hold(['B01', 'B02', 'B03'], { accountId: ACCOUNT_B, limit: 4 }));
    expect(await h.quota(e, ACCOUNT_B)).toBe(4);
  });

  // ---- 검사 차례의 모든 쌍(seat-hold.md §3 '검사 차례' 1~6) ----

  test(`[${name}] FR010_ST24_ST33_POL011_ 두 검사에 함께 걸리면 앞 차례의 결과이고(세대 키 → 멱등 키 재사용 → 정지 → 경합 → 방금 놓은 좌석 → 한도, 모든 쌍) 아무것도 쓰지 않는다`, async () => {
    const checks = ['NOT_READY', 'IDEM_REUSED', 'PAUSED', 'CONFLICT', 'REHOLD_WAIT', 'QUOTA_EXCEEDED'] as const;
    for (let a = 0; a < checks.length; a++) {
      for (let b = a + 1; b < checks.length; b++) {
        const pair = [checks[a]!, checks[b]!];
        const on = (c: (typeof checks)[number]) => pair.includes(c);
        const { h, e, hold, keepUntilMs } = await world();
        const k = randomUUID();
        // 멱등: A가 키 k로 A09를 잡아 둔다(보유 1). 같은 키로 A05를 보내면 지문이 다르다
        if (on('IDEM_REUSED')) held(await hold(['A09'], { accountId: ACCOUNT_A, idempotencyKey: k }));
        if (on('CONFLICT')) held(await hold(['A05'], { accountId: ACCOUNT_B }));
        if (on('REHOLD_WAIT')) await h.setRel(e, ACCOUNT_A, idx('A05'), h.clock.now() + 60_000);
        // 보유 2 + 1석 > 한도 2. 이 조건이 없으면 보유 0~1이라 한도 안이다
        if (on('QUOTA_EXCEEDED')) await h.setQuota(e, ACCOUNT_A, 2);
        if (on('PAUSED')) await h.setCtl(e, { paused: '1' });
        if (on('NOT_READY')) await h.dropEpoch(e);
        const before = await snapshot(h, e);
        const r = await hold(['A05'], { accountId: ACCOUNT_A, limit: 2, idempotencyKey: on('IDEM_REUSED') ? k : randomUUID(), keepUntilMs: keepUntilMs + DAY });
        expect({ pair, kind: r.kind }).toEqual({ pair, kind: pair[0] });
        expect({ pair, s: await snapshot(h, e) }).toEqual({ pair, s: before });
      }
    }
  });

  test(`[${name}] ST24_① 같은 키·같은 좌석의 재생은 정지·경합·방금 놓은 좌석·한도보다 먼저다(처음 응답 그대로, 아무것도 쓰지 않음)`, async () => {
    for (const other of ['경합·한도', '정지', '방금 놓은 좌석'] as const) {
      const { h, e, hold, keepUntilMs } = await world();
      const k = randomUUID();
      // 처음 홀드 뒤 그 좌석 비트는 1이고 보유 2 + 2석 > 한도 2라, 재생 요청은 늘 경합·한도 조건과 함께다
      const first = held(await hold(['A09', 'A10'], { accountId: ACCOUNT_A, idempotencyKey: k, limit: 2 }));
      if (other === '정지') await h.setCtl(e, { suspended: '1' });
      if (other === '방금 놓은 좌석') await h.setRel(e, ACCOUNT_A, idx('A10'), h.clock.now() + 60_000);
      await h.tick();
      const before = await snapshot(h, e);
      const r = await hold(['A10', 'A09'], { accountId: ACCOUNT_A, idempotencyKey: k, limit: 2, keepUntilMs: keepUntilMs + DAY });
      expect({ other, kind: r.kind }).toEqual({ other, kind: 'IDEM_REPLAY' });
      expect({ other, r: held(r, 'IDEM_REPLAY') }).toEqual({ other, r: first });
      expect({ other, s: await snapshot(h, e) }).toEqual({ other, s: before });
    }
  });

  // ---- 검사 차례 1: 세대 키 ----

  test(`[${name}] ST26_③ 세대 키가 없으면(판매 열기 전·세대 키를 지운 뒤) NOT_READY이고 좌석을 잡지 않으며, 멱등 재생보다 먼저다`, async () => {
    const a = await world({ open: false });
    const before = await snapshot(a.h, a.e);
    expect(await a.hold(['A01'])).toEqual({ kind: 'NOT_READY' });
    expect(await snapshot(a.h, a.e)).toEqual(before);
    const b = await world();
    const k = randomUUID();
    held(await b.hold(['A01'], { idempotencyKey: k }));
    await b.h.dropEpoch(b.e);
    const before2 = await snapshot(b.h, b.e);
    expect(await b.hold(['A01'], { idempotencyKey: k })).toEqual({ kind: 'NOT_READY' });
    expect(await b.hold(['A02'])).toEqual({ kind: 'NOT_READY' });
    expect(await snapshot(b.h, b.e)).toEqual(before2);
  });

  // ---- 검사 차례 2: 멱등 키(S-T24) ----

  test(`[${name}] ST24_① 같은 키·같은 좌석 요청 20개가 동시에 와도 좌석은 한 번만 잡히고(보유 수 증가 1번) 모두 같은 holdId·토큰·시각을 받는다`, async () => {
    const { h, e, input } = await world();
    const k = randomUUID();
    // 요청마다 HoldSeats가 holdId를 새로 만든다: 이긴 요청의 holdId 하나로 모인다
    const inputs = Array.from({ length: 20 }, () => input(['A01', 'A02'], { idempotencyKey: k }));
    const rs = await Promise.all(inputs.map((i) => h.store.hold(i)));
    expect(rs.filter((r) => r.kind === 'OK')).toHaveLength(1);
    expect(rs.filter((r) => r.kind === 'IDEM_REPLAY')).toHaveLength(19);
    const first = held(rs.find((r) => r.kind === 'OK')!);
    for (const r of rs) expect(held(r, r.kind === 'OK' ? 'OK' : 'IDEM_REPLAY')).toEqual(first);
    expect(inputs.map((i) => i.holdId)).toContain(first.holdId);
    expect(await h.quota(e, ACCOUNT_A)).toBe(2);
    expect(await h.stream(e)).toHaveLength(2);
  });

  test(`[${name}] ST24_① 멱등 재생은 처음 응답(같은 holdId·토큰·heldAt·exp)을 그대로 주고 아무것도 쓰지 않는다(보유 수·Stream·fence 그대로)`, async () => {
    const { h, e, input } = await world();
    const k = randomUUID();
    const r1 = held(await h.store.hold(input(['A01', 'B01'], { idempotencyKey: k })));
    await h.tick();
    const before = await snapshot(h, e);
    // 다른 holdId·보낸 차례가 달라도 같은 좌석 집합이면 같은 지문이다
    const r2 = held(await h.store.hold(input(['B01', 'A01'], { idempotencyKey: k })), 'IDEM_REPLAY');
    expect(r2).toEqual(r1);
    expect(await snapshot(h, e)).toEqual(before);
  });

  test(`[${name}] ST24_② 같은 키로 다른 좌석을 보내면 IDEM_REUSED이고 좌석을 보지 않는다(판매 정지·경합보다 먼저). 같은 지문이면 정지 중에도 처음 응답이다`, async () => {
    const { h, e, hold } = await world();
    const k = randomUUID();
    held(await hold(['A01'], { idempotencyKey: k }));
    const before = await snapshot(h, e);
    expect(await hold(['A02'], { idempotencyKey: k })).toEqual({ kind: 'IDEM_REUSED' });
    expect(await snapshot(h, e)).toEqual(before);
    expect(await h.bit(e, idx('A02'))).toBe(0);
    held(await hold(['A03'], { accountId: ACCOUNT_B }));
    await h.setCtl(e, { paused: '1' });
    expect(await hold(['A03'], { idempotencyKey: k })).toEqual({ kind: 'IDEM_REUSED' });
    expect((await hold(['A01'], { idempotencyKey: k })).kind).toBe('IDEM_REPLAY');
  });

  test(`[${name}] ST24_③ 경합·한도 초과·방금 놓은 좌석으로 잡지 못하면 멱등 기록을 남기지 않아, 같은 키로 다시 보내면 새로 시도한다`, async () => {
    const { h, e, hold } = await world();
    held(await hold(['A01'], { accountId: ACCOUNT_B }));
    const k1 = randomUUID();
    expect(await hold(['A01'], { accountId: ACCOUNT_A, idempotencyKey: k1 })).toEqual({ kind: 'CONFLICT', seatId: 'A01' });
    expect(await h.idem(e, ACCOUNT_A, k1)).toBeNull();
    await h.clearBit(e, idx('A01'));
    held(await hold(['A01'], { accountId: ACCOUNT_A, idempotencyKey: k1 }));
    expect((await h.holdHash(e, idx('A01')))?.owner).toBe(ACCOUNT_A);

    const k2 = randomUUID();
    await h.setQuota(e, ACCOUNT_C, 2);
    expect((await hold(['A02'], { accountId: ACCOUNT_C, limit: 2, idempotencyKey: k2 })).kind).toBe('QUOTA_EXCEEDED');
    expect(await h.idem(e, ACCOUNT_C, k2)).toBeNull();
    await h.setQuota(e, ACCOUNT_C, 1);
    held(await hold(['A02'], { accountId: ACCOUNT_C, limit: 2, idempotencyKey: k2 }));

    const k3 = randomUUID();
    await h.setRel(e, ACCOUNT_D, idx('A03'), h.clock.now() + 60_000);
    expect((await hold(['A03'], { accountId: ACCOUNT_D, idempotencyKey: k3 })).kind).toBe('REHOLD_WAIT');
    expect(await h.idem(e, ACCOUNT_D, k3)).toBeNull();
    await h.setRel(e, ACCOUNT_D, idx('A03'), h.clock.now() - 60_000);
    held(await hold(['A03'], { accountId: ACCOUNT_D, idempotencyKey: k3 }));
  });

  test(`[${name}] ST24_④ 다른 계정이 같은 키를 쓰면 남의 응답을 받지 않고 따로 처리된다`, async () => {
    const { h, e, hold } = await world();
    const k = randomUUID();
    const ra = held(await hold(['A01'], { accountId: ACCOUNT_A, idempotencyKey: k }));
    expect(await hold(['A01'], { accountId: ACCOUNT_B, idempotencyKey: k })).toEqual({ kind: 'CONFLICT', seatId: 'A01' });
    const rb = held(await hold(['A02'], { accountId: ACCOUNT_B, idempotencyKey: k }));
    expect(rb.holdId).not.toBe(ra.holdId);
    expect((await h.idem(e, ACCOUNT_A, k))?.resp.startsWith(`${ra.holdId}:`)).toBe(true);
    expect((await h.idem(e, ACCOUNT_B, k))?.resp.startsWith(`${rb.holdId}:`)).toBe(true);
  });

  test(`[${name}] ST24_⑤ 멱등 기록의 수명은 7분이고, 지난 뒤 같은 키는 새 요청으로 처리된다`, async () => {
    const { h, e, hold } = await world();
    const k = randomUUID();
    const r1 = held(await hold(['A01'], { idempotencyKey: k }));
    expect(await hold(['A02'], { idempotencyKey: k })).toEqual({ kind: 'IDEM_REUSED' });
    await h.passIdemTtl(e, ACCOUNT_A, k);
    const r2 = held(await hold(['A02'], { idempotencyKey: k }));
    expect(r2.holdId).not.toBe(r1.holdId);
    expect(await h.quota(e, ACCOUNT_A)).toBe(2);
  });

  // ---- 검사 차례 3: 판매 정지 ----

  test(`[${name}] FR010_ ctl의 paused·allPaused·suspended 가운데 하나라도 '1'이면 PAUSED이고 아무것도 쓰지 않는다`, async () => {
    for (const field of ['paused', 'allPaused', 'suspended']) {
      const { h, e, hold } = await world();
      await h.setCtl(e, { paused: '0', allPaused: '0', suspended: '0', rev: '3', cmd: 'cmd-1', [field]: '1' });
      const before = await snapshot(h, e);
      expect({ field, r: await hold(['A01']) }).toEqual({ field, r: { kind: 'PAUSED' } });
      expect(await snapshot(h, e)).toEqual(before);
    }
  });

  test(`[${name}] FR010_ ctl 키가 없거나 칸이 '0'·판 번호 칸뿐이면 정지가 아니고, 정지는 경합보다 먼저다`, async () => {
    const { h, e, hold } = await world();
    held(await hold(['A01']));
    await h.setCtl(e, { paused: '0', allPaused: '0', suspended: '0', rev: '9', cmd: 'c', suspRef: 'r', allRev: '2', allCmd: 'a' });
    held(await hold(['A02']));
    await h.setCtl(e, { allPaused: '1' });
    expect(await hold(['A01'], { accountId: ACCOUNT_B })).toEqual({ kind: 'PAUSED' });
  });

  // ---- 검사 차례 4: 경합 ----

  test(`[${name}] FR010_ CONFLICT의 seatId는 seats 차례의 첫 충돌 좌석이고, 경합은 한도 검사보다 먼저다`, async () => {
    const { h, e, hold } = await world();
    held(await hold(['A02', 'A04'], { accountId: ACCOUNT_B }));
    expect(await hold(['A01', 'A02', 'A03', 'A04'])).toEqual({ kind: 'CONFLICT', seatId: 'A02' });
    expect(await hold(['A03', 'A04', 'A05'])).toEqual({ kind: 'CONFLICT', seatId: 'A04' });
    await h.setQuota(e, ACCOUNT_A, 4);
    expect(await hold(['A04'], { limit: 4 })).toEqual({ kind: 'CONFLICT', seatId: 'A04' });
  });

  // ---- 검사 차례 5: 방금 놓은 좌석(S-T33) ----

  test(`[${name}] FR010_ST33_ REHOLD_WAIT의 seatIds는 점수가 지금보다 큰 좌석 모두(seats 차례)이고 availableAtMs는 그 가운데 가장 늦은 점수다. 지난 점수·다른 계정의 기록은 막지 않고, 한도 검사보다 먼저다`, async () => {
    const { h, e, hold } = await world();
    const now = h.clock.now();
    await h.setRel(e, ACCOUNT_A, idx('A01'), now + 40_000);
    await h.setRel(e, ACCOUNT_A, idx('A02'), now - 60_000);
    await h.setRel(e, ACCOUNT_A, idx('A03'), now + 60_000);
    const before = await snapshot(h, e);
    expect(await hold(['A03', 'A02', 'A01'])).toEqual({ kind: 'REHOLD_WAIT', seatIds: ['A01', 'A03'], availableAtMs: now + 60_000 });
    expect(await snapshot(h, e)).toEqual(before);
    held(await hold(['A02']));
    held(await hold(['A01', 'A03'], { accountId: ACCOUNT_B }));
    await h.setRel(e, ACCOUNT_C, idx('A05'), now + 60_000);
    await h.setQuota(e, ACCOUNT_C, 4);
    expect((await hold(['A05'], { accountId: ACCOUNT_C, limit: 4 })).kind).toBe('REHOLD_WAIT');
  });

  test(`[${name}] ST33_④ 방금 놓은 좌석 하나와 새 좌석 하나를 함께 요청하면 REHOLD_WAIT이고 부분 홀드가 0이다`, async () => {
    const { h, e, hold } = await world();
    const at = h.clock.now() + 30_000;
    await h.setRel(e, ACCOUNT_A, idx('A01'), at);
    const before = await snapshot(h, e);
    expect(await hold(['A01', 'A02'])).toEqual({ kind: 'REHOLD_WAIT', seatIds: ['A01'], availableAtMs: at });
    expect(await snapshot(h, e)).toEqual(before);
    expect(await h.bit(e, idx('A02'))).toBe(0);
  });

  test(`[${name}] ST33_⑦ 놓은 좌석에 다른 계정의 홀드가 걸려 있으면 경합(CONFLICT)이 먼저다`, async () => {
    const { h, e, hold } = await world();
    await h.setRel(e, ACCOUNT_A, idx('A01'), h.clock.now() + 30_000);
    held(await hold(['A01'], { accountId: ACCOUNT_B }));
    expect(await hold(['A01'])).toEqual({ kind: 'CONFLICT', seatId: 'A01' });
    expect(await hold(['A01', 'A02'])).toEqual({ kind: 'CONFLICT', seatId: 'A01' });
  });

  // ---- 펜싱 토큰(S-T5 토큰을 내는 쪽, OPEN[16] 추천 적용) ----

  test(`[${name}] ST5_ 연속 홀드의 펜싱 토큰은 회차 안에서 엄격히 늘고 fence에 마지막 토큰 글을 쓴다 [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.2]`, async () => {
    const { h, e, hold } = await world();
    const tokens: number[] = [];
    for (let i = 0; i < 5; i++) tokens.push(held(await hold([`A0${i + 1}`], { accountId: account(i) })).fencingToken);
    for (let i = 1; i < tokens.length; i++) expect(tokens[i]!).toBeGreaterThan(tokens[i - 1]!);
    expect(await h.fence(e)).toBe(String(tokens.at(-1)));
  });

  test(`[${name}] ST5_ fence에 지금 µs보다 큰 값이 있으면 토큰은 그 값 + 1이고(장애 전환 뒤 되돌아가지 않음) 키·Hash·Stream·멱등 응답에 같은 16자리 글로 쓴다 [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.2]`, async () => {
    const { h, e, input, hold } = await world();
    // 14자리 tostring이면 '1.9876543210988e+15'가 되는 값
    await h.setFence(e, '1987654321098765');
    const i = input(['A01']);
    const r = held(await h.store.hold(i));
    expect(r.fencingToken).toBe(1_987_654_321_098_766);
    expect(await h.fence(e)).toBe('1987654321098766');
    expect((await h.holdHash(e, idx('A01')))?.fence).toBe('1987654321098766');
    expect((await h.stream(e)).at(-1)?.fencingToken).toBe('1987654321098766');
    expect((await h.idem(e, i.accountId, i.idempotencyKey))?.resp.endsWith(':1987654321098766')).toBe(true);
    expect(held(await hold(['A02'], { accountId: ACCOUNT_B })).fencingToken).toBe(1_987_654_321_098_767);
  });

  test(`[${name}] ST5_ fence를 잃어도(키 없음·작은 값) 토큰은 그때의 µs라 앞서 낸 토큰보다 크다 [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.2]`, async () => {
    const { h, e, hold } = await world();
    const t1 = held(await hold(['A01'])).fencingToken;
    await h.setFence(e, null);
    await h.tick();
    const r2 = held(await hold(['A02'], { accountId: ACCOUNT_B }));
    expect(r2.fencingToken).toBeGreaterThan(t1);
    expect(Math.floor(r2.fencingToken / 1000)).toBe(r2.heldAtMs);
    await h.setFence(e, '5');
    await h.tick();
    const r3 = held(await hold(['A03'], { accountId: ACCOUNT_C }));
    expect(r3.fencingToken).toBeGreaterThan(r2.fencingToken);
    expect(await h.fence(e)).toBe(String(r3.fencingToken));
  });

  test(`[${name}] ST5_ 토큰은 16자리 10진 정수 글로 정확하다(2^53 − 1까지, string.format('%.0f')) [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.2]`, async () => {
    const a = await world();
    const r = held(await a.hold(['A01']));
    const text = await a.h.fence(a.e);
    expect(text).toMatch(/^[1-9][0-9]{15}$/);
    expect(String(r.fencingToken)).toBe(text);
    const b = await world();
    await b.h.setFence(b.e, '9007199254740990');
    expect(held(await b.hold(['A01'])).fencingToken).toBe(Number.MAX_SAFE_INTEGER);
    expect(await b.h.fence(b.e)).toBe('9007199254740991');
    expect((await b.h.holdHash(b.e, idx('A01')))?.fence).toBe('9007199254740991');
    expect((await b.h.stream(b.e)).at(-1)?.fencingToken).toBe('9007199254740991');
  });

  test(`[${name}] ST5_ST4_ 토큰이 안전한 정수(2^53 − 1)를 넘으면 일시 장애가 아닌 Error이고 아무것도 쓰지 않는다 [ASVS v5.0.0-2.2.3]`, async () => {
    const { h, e, hold } = await world();
    await h.setFence(e, '9007199254740991');
    const before = await snapshot(h, e);
    const key = randomUUID();
    await expectBug(hold(['A01'], { idempotencyKey: key }));
    expect(await snapshot(h, e)).toEqual(before);
    expect(await h.idem(e, ACCOUNT_A, key)).toBeNull();
  });

  // ---- 망가진 값·지난 keepUntil은 쓰기 전에 거절한다(전부 안 됨, 추천 적용 2026-11-04) ----

  test(`[${name}] ST5_ST4_ fence가 10진 정수 글(^%d+$)이 아니면('1.5'·'abc'·'1e3'·'-1'·' 5'·'0x10') 일시 장애가 아닌 Error이고 아무것도 쓰지 않는다 [ASVS v5.0.0-2.2.3]`, async () => {
    for (const bad of ['1.5', 'abc', '1e3', '-1', ' 5', '0x10']) {
      const { h, e, hold } = await world();
      await h.setFence(e, bad);
      const before = await snapshot(h, e);
      const key = randomUUID();
      await expectBug(hold(['A01', 'B01'], { idempotencyKey: key }), { fence: bad });
      expect.soft({ fence: bad, s: await snapshot(h, e) }).toEqual({ fence: bad, s: before });
      expect.soft({ fence: bad, idem: await h.idem(e, ACCOUNT_A, key) }).toEqual({ fence: bad, idem: null });
    }
  });

  test(`[${name}] POL011_ST4_ 보유 수가 정수가 아니면(1.5) 일시 장애가 아닌 Error이고 아무것도 쓰지 않는다 [ASVS v5.0.0-2.2.3]`, async () => {
    const { h, e, hold } = await world();
    await h.setQuota(e, ACCOUNT_A, 1.5);
    const before = await snapshot(h, e);
    const key = randomUUID();
    await expectBug(hold(['A01'], { idempotencyKey: key, limit: 4 }), { quota: 1.5 });
    expect(await snapshot(h, e)).toEqual(before);
    expect(await h.idem(e, ACCOUNT_A, key)).toBeNull();
  });

  test(`[${name}] FR010_ST4_ keepUntilMs가 지금(저장소 시각) 이하면 일시 장애가 아닌 Error이고 아무것도 쓰지 않는다`, async () => {
    const { h, e, hold } = await world();
    const before = await snapshot(h, e);
    const key = randomUUID();
    await expectBug(hold(['A01', 'A02'], { idempotencyKey: key, keepUntilMs: h.clock.now() - 60_000 }), { keepUntil: '1분 전' });
    expect(await snapshot(h, e)).toEqual(before);
    expect(await h.idem(e, ACCOUNT_A, key)).toBeNull();
    expect(await h.bitmapBits(e)).not.toBeNull();
  });

  // ---- 앱 쪽 거절 전 멱등 재생 읽기(replay, 추천 적용 2026-11-04) ----

  test(`[${name}] ST24_ 재생 읽기: 기록이 없으면 null, 같은 지문이면 처음 응답(IDEM_REPLAY), 다른 지문이면 IDEM_REUSED이고 아무것도 쓰지 않는다. 경합으로 잡지 못한 키는 기록이 없어 null이다`, async () => {
    const { h, e, input, hold } = await world();
    const replay = replayOf(h.store);
    const key = randomUUID();
    const ask = (seatIds: string[], c: Partial<ReplayInput> = {}) => replay({ eventId: e, accountId: ACCOUNT_A, idempotencyKey: key, fingerprint: fingerprintOf(seatIds), ...c });
    expect(await ask(['A01', 'A02'])).toBeNull();
    const first = held(await h.store.hold(input(['A01', 'A02'], { idempotencyKey: key })));
    await h.tick();
    const before = await snapshot(h, e);
    expect(await ask(['A02', 'A01'])).toEqual({ kind: 'IDEM_REPLAY', ...first });
    expect(await ask(['A03'])).toEqual({ kind: 'IDEM_REUSED' });
    expect(await snapshot(h, e)).toEqual(before);
    // 경합(409)은 기록을 남기지 않는다
    const k2 = randomUUID();
    expect(await hold(['A01'], { accountId: ACCOUNT_B, idempotencyKey: k2 })).toEqual({ kind: 'CONFLICT', seatId: 'A01' });
    expect(await ask(['A01'], { accountId: ACCOUNT_B, idempotencyKey: k2 })).toBeNull();
  });

  test(`[${name}] ST24_④ 재생 읽기는 계정마다 따로다: 다른 계정이 같은 키를 물으면 null이다`, async () => {
    const { h, e, hold } = await world();
    const key = randomUUID();
    held(await hold(['A01'], { accountId: ACCOUNT_A, idempotencyKey: key }));
    expect(await replayOf(h.store)({ eventId: e, accountId: ACCOUNT_B, idempotencyKey: key, fingerprint: fingerprintOf(['A01']) })).toBeNull();
  });

  test(`[${name}] ST24_⑤ 재생 읽기도 7분이 지난 기록은 없는 것으로 본다(null)`, async () => {
    const { h, e, hold } = await world();
    const key = randomUUID();
    held(await hold(['A01'], { idempotencyKey: key }));
    await h.passIdemTtl(e, ACCOUNT_A, key);
    expect(await replayOf(h.store)({ eventId: e, accountId: ACCOUNT_A, idempotencyKey: key, fingerprint: fingerprintOf(['A01']) })).toBeNull();
  });

  // ---- 판매 열기 ----

  test(`[${name}] FR010_ 판매 열기는 회차 목록·비트맵(좌석 수만큼, 모두 0)·세대 키(epoch = 지금 초, node standalone)를 만들고 keepUntil을 걸며, 다시 불러도 잡은 홀드·세대·키 수명을 바꾸지 않는다`, async () => {
    const { h, e, opened, keepUntilMs: K, hold } = await world();
    expect(opened?.created).toBe(true);
    const seatEpoch = opened!.seatEpoch;
    expect(Number.isInteger(seatEpoch)).toBe(true);
    expect(Math.abs(seatEpoch * 1000 - h.clock.now())).toBeLessThanOrEqual(h.skewMs + 1000);
    expect(await h.epoch(e)).toEqual({ epoch: seatEpoch, node: 'standalone' });
    expect(await h.inCtlEvents(e)).toBe(true);
    const bits = await h.bitmapBits(e);
    expect(bits).not.toBeNull();
    expect(bits!).toBeGreaterThanOrEqual(SEAT_COUNT);
    expect(bits!).toBeLessThan(SEAT_COUNT + 8);
    expect((await Promise.all(SEAT_DEFS.map((d) => h.bit(e, d.index)))).every((b) => b === 0)).toBe(true);
    expect(await h.expireAt(e, seatKeys.bitmap(e))).toBe(K);
    expect(await h.expireAt(e, seatKeys.epoch(e))).toBe(K);
    held(await hold(['A01']));
    expect(await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs: K + DAY })).toEqual({ created: false, seatEpoch });
    expect(await h.bit(e, idx('A01'))).toBe(1);
    expect(await h.epoch(e)).toEqual({ epoch: seatEpoch, node: 'standalone' });
    expect(await h.expireAt(e, seatKeys.bitmap(e))).toBe(K);
    expect(await h.expireAt(e, seatKeys.epoch(e))).toBe(K);
  });
}
