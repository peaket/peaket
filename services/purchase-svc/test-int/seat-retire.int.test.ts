// 좌석 묶기 단계(BUILD_ORDER PRF-142)의 회차 쪽 규칙을 실제 Valkey 8.1로 돈다: 세대 키의 판 번호 칸 gen, 회차 목록 s:ctl:events에서 빼기(retireEvent),
// 묶기(pin)와 같은 좌석의 만료·다른 사람 홀드의 경주.
// 정본: docs/features/seat-hold.md §6 '좌석 묶기와 실패 해제의 첫 구현'('판 번호'·'회차 목록에서 빼기'·'pin 판정'·'pin 쓰기'),
// docs/data.md §4 '좌석 묶기·실패 해제·판 번호'와 §5 '결제 접수 뒤 좌석 묶기' 경합 행, 명세 specs/seat.qnt의 pin·expire,
// 계약: src/modules/inventory/adapters/pin-lua.ts(PIN_LUA), domain/ports.ts(SeatPins·SeatEventRetire), domain/pin.ts.
//
// 약속:
// - 상태(세대 키·회차 목록·비트·홀드 Hash·만료 인덱스·보유 수·fence·Stream·XPENDING)는 저장소를 거치지 않고 Valkey 명령으로 직접 읽는다.
// - 시험마다(경주는 라운드마다) 새 회차 ID를 쓴다. 시험은 차례대로 돈다(같은 s:ctl:events를 나눠 쓴다).
// - 묶기·홀드·만료 Lua 안의 시각은 Redis TIME이라 시험이 바꿀 수 없다. 그래서 '만료 시각이 지난 홀드'는 홀드 Lua로 잡은 뒤
//   홀드 Hash의 exp와 만료 인덱스 점수를 1분 전으로 고쳐 만든다(고정 sleep 없음).
// - retireEvent의 시각은 주입 Clock이다(ports.ts SeatEventRetire '시각은 저장소 시각(주입 Clock)'). 그래서 Valkey 시계보다 사흘 늦은
//   fakeClock을 RedisSeatStore 셋째 인자로 넣어 부른다(Redis TIME으로 가르면 TOO_EARLY 시험이 걸러 낸다).
// - 경주는 연결 둘(묶기 쪽 redis, 만료·상대 홀드 쪽 redis2)에서 Promise.all로 부른다. 라운드마다 한쪽 시작을 0~25ms 늦춰
//   두 차례가 모두 나오게 하고(양 끝 ±25ms는 한쪽이 먼저 끝난다), 가운데 값은 두 걸음짜리 만료(읽기 → 만료 Lua) 사이에 묶기가 끼게 한다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createHotRedis, type FakeClock, fakeClock, type HotRedis, systemClock, uuidv7 } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  type ExpireResult,
  HOLD_TTL_MS,
  type HoldInput,
  type HoldResult,
  INITIAL_SEAT_GEN,
  type PinInput,
  type PinResult,
  RedisSeatStore,
  RedisSeatStreamSource,
  RETIRE_AFTER_SALE_END_MS,
  type SeatRef,
  STREAM_RELAY_GROUP,
  seatKeys,
} from '../src/modules/inventory/index.js';
import { fingerprintOf } from '../test/hold-cases.js';
import { cmd, exists, hash, streamItems, xlen } from './seat-stream.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer | undefined;
/** 묶기·상태 읽기 쪽 연결 */
let redis: HotRedis;
/** 경주의 다른 쪽(만료 두 단계·상대 홀드) 연결 */
let redis2: HotRedis;
/** 묶기·홀드·판매 열기 저장소(연결 redis) */
let store: RedisSeatStore;
/** 경주의 다른 쪽 저장소(연결 redis2) */
let other: RedisSeatStore;

beforeAll(async () => {
  valkey = await startValkey();
  [redis, redis2] = await Promise.all([createHotRedis({ url: valkey.url }), createHotRedis({ url: valkey.url })]);
  store = new RedisSeatStore(redis);
  other = new RedisSeatStore(redis2);
});

afterAll(async () => {
  await Promise.all([redis?.close(), redis2?.close()]);
  valkey?.stop();
});

// ───────────────────────────── 도우미 ─────────────────────────────

const DAY = 24 * 3600_000;
/** 시험 회차 좌석 수(비트맵 크기). 불변식 검사가 모든 좌석을 훑는다 */
const SEATS = 16;
/** 경주 라운드 수 */
const ROUNDS = 30;
/** 라운드마다 늦출 시작(ms, 차례로 돈다). 양수면 경주의 다른 쪽(만료·상대 홀드)을, 음수면 묶기를 늦게 시작한다 */
const LAGS = [0, 1, -1, 2, -2, 5, -5, 25, -25, 0];

const newEventId = () => uuidv7(systemClock);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 회차 키 만료 시각(판매 종료 + 1일 자리). Lua가 Redis TIME과 견주므로 이 PC 시계로 넉넉히 앞에 둔다 */
const keepUntil = () => Date.now() + DAY;

/** 구역 A(구역 색인 0, 등급 R)의 좌석 하나. 좌석 ID는 무작위 소문자 UUID(판매 예약의 좌석 ID 검사도 지난다) */
const seatAt = (index: number): SeatRef => ({ seatId: randomUUID(), index, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: index, tierId: 'R' });

/** 판매를 연다(s:ctl:events에 넣고 비트맵·세대 키를 만든다) */
const open = (eventId: string, s: RedisSeatStore = store) => s.openSale({ eventId, seatCount: SEATS, keepUntilMs: keepUntil() });

/** 세대 키 Hash 전체(없으면 {}) */
async function epochHash(eventId: string): Promise<Record<string, string>> {
  const k = seatKeys.epoch(eventId);
  return hash(await cmd(redis, k, ['HGETALL', k]));
}

/** gen 칸이 없는 옛 세대 키의 회차(비트맵과 epoch·node만 손으로 쓴다. 판매 열기를 거치지 않는다) */
async function legacyEvent(): Promise<{ eventId: string; seatEpoch: string }> {
  const eventId = newEventId();
  const seatEpoch = String(Math.floor(Date.now() / 1000));
  await cmd(redis, seatKeys.bitmap(eventId), ['SETBIT', seatKeys.bitmap(eventId), String(SEATS - 1), '0']);
  await cmd(redis, seatKeys.epoch(eventId), ['HSET', seatKeys.epoch(eventId), 'epoch', seatEpoch, 'node', 'standalone']);
  return { eventId, seatEpoch };
}

async function listed(eventId: string): Promise<boolean> {
  const k = seatKeys.ctlEvents();
  return Number(await cmd(redis, k, ['SISMEMBER', k, eventId])) === 1;
}

/** 소비자 그룹 stream-relay의 확인받지 못한 항목 수(XPENDING 요약의 첫 값). 그룹이나 Stream이 없으면(NOGROUP) null */
async function pendingOrNull(eventId: string): Promise<number | null> {
  const k = seatKeys.stream(eventId);
  try {
    const r = await cmd(redis, k, ['XPENDING', k, STREAM_RELAY_GROUP]);
    return Number(Array.isArray(r) ? (r[0] ?? 0) : 0);
  } catch (err) {
    if (err instanceof Error && /^NOGROUP\b/.test(err.message)) return null;
    throw err;
  }
}

/** 좌석 하나 홀드 입력(새 holdId·구매 세션·멱등 키, 한도 4) */
function holdInputOf(eventId: string, seat: SeatRef, accountId: string): HoldInput {
  return {
    eventId,
    accountId,
    purchaseSessionId: randomUUID(),
    holdId: uuidv7(systemClock),
    idempotencyKey: randomUUID(),
    fingerprint: fingerprintOf([seat.seatId]),
    seats: [seat],
    limit: 4,
    keepUntilMs: keepUntil(),
  };
}

/** 그 홀드 주문의 묶기 입력(같은 계정·holdId·구매 세션·좌석, 한도 4) */
function pinInputOf(h: HoldInput, orderGen: number = INITIAL_SEAT_GEN): PinInput {
  return { eventId: h.eventId, accountId: h.accountId, purchaseSessionId: h.purchaseSessionId, holdId: h.holdId, seats: h.seats, limit: h.limit, orderGen, keepUntilMs: keepUntil() };
}

type HeldOk = Extract<HoldResult, { kind: 'OK' }>;
type PinOk = Extract<PinResult, { kind: 'OK' }>;

function heldOk(r: HoldResult, what: string): HeldOk {
  if (r.kind !== 'OK') throw new Error(`${what}: 홀드가 OK가 아니다: ${JSON.stringify(r)}`);
  return r;
}

/** 홀드를 잡고 그 홀드의 만료 시각을 1분 전으로 고친다(홀드 Hash exp와 만료 인덱스 점수. 만료 반복이 다음 틱에 풀 좌석) */
async function placeDueHold(eventId: string, seat: SeatRef, accountId: string): Promise<{ input: HoldInput; held: HeldOk }> {
  const input = holdInputOf(eventId, seat, accountId);
  const held = heldOk(await store.hold(input), '처음 홀드');
  const past = String(Date.now() - 60_000);
  const hk = seatKeys.hold(eventId, seat.index);
  const ek = seatKeys.expiry(eventId);
  await cmd(redis, hk, ['HSET', hk, 'exp', past]);
  // XX CH: 있는 멤버의 점수만 바꾸고 바꾼 수를 센다(1이 아니면 홀드 Lua가 만료 인덱스에 넣지 않은 것이다)
  expect(Number(await cmd(redis, ek, ['ZADD', ek, 'XX', 'CH', past, String(seat.index)]))).toBe(1);
  return { input, held };
}

/**
 * 만료 반복 한 틱의 그 회차 몫과 같은 두 단계(ExpirySweeper와 같은 차례): ① dueExpiries로 지난 좌석과 홀드 Hash 세 칸을 읽고
 * ② 그 좌석만 기대값과 좌석 정보를 붙여 expire. ①에서 그 좌석이 나오지 않으면(묶기가 먼저 만료 인덱스에서 뺐다) 'NOT_DUE'
 */
async function sweepSeat(s: RedisSeatStore, eventId: string, seat: SeatRef): Promise<ExpireResult | 'NOT_DUE'> {
  const due = (await s.dueExpiries({ eventId, nowMs: Date.now(), limit: 10 })).filter((d) => d.index === seat.index);
  const seats = due.flatMap((d) => (d.hold ? [{ index: d.index, expected: d.hold, seat }] : []));
  if (seats.length === 0) return 'NOT_DUE';
  return s.expire({ eventId, keepUntilMs: keepUntil(), seats });
}

interface SeatState {
  bit: number;
  /** 홀드 Hash 칸(없으면 null) */
  hold: Record<string, string> | null;
  /** 만료 인덱스 점수(없으면 null) */
  expiry: number | null;
}

async function seatState(eventId: string, index: number): Promise<SeatState> {
  const bk = seatKeys.bitmap(eventId);
  const hk = seatKeys.hold(eventId, index);
  const ek = seatKeys.expiry(eventId);
  const [bit, h, score] = await Promise.all([cmd(redis, bk, ['GETBIT', bk, String(index)]), cmd(redis, hk, ['HGETALL', hk]), cmd(redis, ek, ['ZSCORE', ek, String(index)])]);
  const fields = hash(h);
  return { bit: Number(bit), hold: Object.keys(fields).length ? fields : null, expiry: score === null || score === undefined ? null : Number(score) };
}

/** 보유 수(키가 없으면 0) */
async function quotaOf(eventId: string, accountId: string): Promise<number> {
  const k = seatKeys.quota(eventId, accountId);
  const v = await cmd(redis, k, ['GET', k]);
  return v === null || v === undefined ? 0 : Number(v);
}

/** 그 좌석의 Stream 항목을 '종류:토큰' 글로(Stream 차례) */
async function seatTrail(eventId: string, index: number): Promise<string[]> {
  return (await streamItems(redis, eventId)).filter((it) => it.fields.seatIdx === String(index)).map((it) => `${it.fields.type}:${it.fields.fencingToken}`);
}

/**
 * 회차 전체의 불변식(라운드마다 본다):
 * ① 모든 좌석에서 비트 1 ⇔ 홀드 Hash 있음(비트 1인데 Hash 없음, 비트 0인데 Hash 남음이 없다)
 * ② 계정마다 보유 수 = 그 계정이 owner인 홀드 Hash 수
 * ③ 같은 좌석의 HELD는 Stream 차례대로 펜싱 토큰이 엄격히 커진다
 */
async function expectConsistent(eventId: string, accounts: readonly string[], what: string): Promise<void> {
  const states = await Promise.all(Array.from({ length: SEATS }, (_, i) => seatState(eventId, i)));
  states.forEach((st, i) => expect(st.hold !== null, `${what}: 좌석 ${i}의 비트가 ${st.bit}인데 홀드 Hash가 ${st.hold ? '있다' : '없다'}`).toBe(st.bit === 1));
  for (const a of accounts) {
    const owned = states.filter((st) => st.hold?.owner === a).length;
    expect(await quotaOf(eventId, a), `${what}: 계정 ${a}의 보유 수가 홀드 Hash 수(${owned})와 다르다`).toBe(owned);
  }
  const held = new Map<string, number[]>();
  for (const it of await streamItems(redis, eventId)) {
    if (it.fields.type !== 'HELD') continue;
    const seat = String(it.fields.seatIdx);
    held.set(seat, [...(held.get(seat) ?? []), Number(it.fields.fencingToken)]);
  }
  for (const [seat, tokens] of held) {
    for (let k = 1; k < tokens.length; k++) expect(tokens[k]! > tokens[k - 1]!, `${what}: 좌석 ${seat}의 HELD 토큰이 차례를 거슬렀다: ${tokens.join(' → ')}`).toBe(true);
  }
}

/** 한쪽 시작을 lag(ms)만큼 늦춰 부른다 */
const after = async <T>(ms: number, f: () => Promise<T>): Promise<T> => {
  if (ms > 0) await sleep(ms);
  return f();
};

// ───────────────────────────── 판 번호 gen ─────────────────────────────

describe('판 번호 gen(세대 키 s:{event:E}:epoch의 칸, 판매 열기가 처음 쓸 때 1)', () => {
  test('판매를 새로 열면 세대 키에 epoch·node와 함께 gen = 1(INITIAL_SEAT_GEN)을 쓴다. 다른 칸은 없다', async () => {
    const eventId = newEventId();
    const r = await open(eventId);
    expect(r.created).toBe(true);
    expect(INITIAL_SEAT_GEN).toBe(1);
    expect(await epochHash(eventId)).toEqual({ epoch: String(r.seatEpoch), node: 'standalone', gen: '1' });
  });

  test('이미 열린 회차를 다시 열면 gen을 바꾸지 않는다: 다시 만들기가 올린 gen 3은 3 그대로이고, gen 칸이 없는 옛 세대 키에는 칸을 더하지 않는다', async () => {
    const eventId = newEventId();
    const first = await open(eventId);
    expect(await epochHash(eventId)).toMatchObject({ gen: '1' });
    // 다시 만들기(RB-06, PRF-143)가 판 번호를 올린 것을 흉내 낸다
    await cmd(redis, seatKeys.epoch(eventId), ['HSET', seatKeys.epoch(eventId), 'gen', '3']);
    const again = await open(eventId);
    expect(again).toEqual({ created: false, seatEpoch: first.seatEpoch });
    expect(await epochHash(eventId)).toEqual({ epoch: String(first.seatEpoch), node: 'standalone', gen: '3' });

    // 옛 세대 키(gen 칸 없음): 다시 열어도 아무것도 바꾸지 않는다(칸이 없으면 1로 본다는 규칙이라 쓸 까닭이 없다)
    const legacy = await legacyEvent();
    const reopened = await open(legacy.eventId);
    expect(reopened).toEqual({ created: false, seatEpoch: Number(legacy.seatEpoch) });
    expect(await epochHash(legacy.eventId)).toEqual({ epoch: legacy.seatEpoch, node: 'standalone' });
  });

  test('gen 칸이 없는 옛 세대 키는 판 번호 1로 본다: 빈 좌석 묶기가 orderGen 1이면 새 토큰으로 다시 잡아 묶고(OK, gen 1), orderGen 2면 STALE_GEN(gen 1)이고 아무것도 쓰지 않는다', async () => {
    // orderGen 1 → 다시 잡는다
    const a = await legacyEvent();
    const seatA = seatAt(3);
    const me = randomUUID();
    const inputA: PinInput = { eventId: a.eventId, accountId: me, purchaseSessionId: randomUUID(), holdId: uuidv7(systemClock), seats: [seatA], limit: 4, orderGen: 1, keepUntilMs: keepUntil() };
    const ok = await store.pin(inputA);
    expect(ok).toEqual({ kind: 'OK', gen: 1, regrabbed: 1, fencingToken: expect.any(Number) });
    const token = (ok as PinOk).fencingToken!;
    const st = await seatState(a.eventId, seatA.index);
    expect(st.bit).toBe(1);
    expect(st.expiry).toBeNull();
    expect(st.hold).toEqual({
      holdId: inputA.holdId,
      owner: me,
      psid: inputA.purchaseSessionId,
      fence: String(token),
      heldAt: expect.stringMatching(/^[1-9][0-9]*$/),
      exp: expect.stringMatching(/^[1-9][0-9]*$/),
      kind: 'FAN',
      ext: '0',
      pin: '1',
    });
    expect(Number(st.hold!.exp) - Number(st.hold!.heldAt)).toBe(HOLD_TTL_MS);
    expect(await quotaOf(a.eventId, me)).toBe(1);
    expect(String(await cmd(redis, seatKeys.fence(a.eventId), ['GET', seatKeys.fence(a.eventId)]))).toBe(String(token));
    const items = await streamItems(redis, a.eventId);
    expect(items.map((it) => it.fields)).toEqual([
      expect.objectContaining({ type: 'HELD', seatIdx: String(seatA.index), seatId: seatA.seatId, holdId: inputA.holdId, holdKind: 'FAN', accountId: me, fencingToken: String(token), seatEpoch: a.seatEpoch }),
    ]);
    // 묶기는 gen 칸을 쓰지 않는다(판 번호를 올리는 것은 다시 만들기뿐이다)
    expect(await epochHash(a.eventId)).toEqual({ epoch: a.seatEpoch, node: 'standalone' });

    // orderGen 2 → STALE_GEN, 아무것도 쓰지 않는다
    const b = await legacyEvent();
    const seatB = seatAt(3);
    const inputB: PinInput = { ...inputA, eventId: b.eventId, holdId: uuidv7(systemClock), seats: [seatB], orderGen: 2 };
    expect(await store.pin(inputB)).toEqual({ kind: 'STALE_GEN', gen: 1 });
    expect(await seatState(b.eventId, seatB.index)).toEqual({ bit: 0, hold: null, expiry: null });
    for (const k of [seatKeys.quota(b.eventId, me), seatKeys.fence(b.eventId), seatKeys.stream(b.eventId), seatKeys.secver(b.eventId), seatKeys.expiry(b.eventId)]) {
      expect(await exists(redis, k), `${k}가 생겼다`).toBe(0);
    }
    expect(await epochHash(b.eventId)).toEqual({ epoch: b.seatEpoch, node: 'standalone' });
    // 수명도 걸지 않는다(옛 키는 수명이 없었다)
    expect(Number(await cmd(redis, seatKeys.bitmap(b.eventId), ['PEXPIRETIME', seatKeys.bitmap(b.eventId)]))).toBe(-1);
  });
});

// ───────────────────────────── 회차 목록에서 빼기 ─────────────────────────────

describe('회차 목록에서 빼기 retireEvent(판매 종료 + 1시간 뒤, 그 회차 Stream 길이와 확인받지 못한 항목이 모두 0일 때만 s:ctl:events에서 SREM)', () => {
  /** Valkey 시계(이 PC 시계와 같다)보다 사흘 늦은 주입 시계와 그 시계를 쓰는 저장소 */
  function retirerAt(): { clock: FakeClock; retirer: RedisSeatStore } {
    const clock = fakeClock({ now: Date.now() - 3 * DAY });
    return { clock, retirer: new RedisSeatStore(redis, undefined, clock) };
  }
  /** 주입 시계로 판매 종료 + 1시간이 1분 지난 판매 종료 시각 */
  const endedLongAgo = (clock: FakeClock) => clock.now() - RETIRE_AFTER_SALE_END_MS - 60_000;

  test('TOO_EARLY: 주입 Clock의 지금이 판매 종료 + 1시간보다 이르면(판매 종료 바로 그때·30분 뒤) 빼지 않고 s:ctl:events에 그대로 둔다. Valkey 시계가 사흘 앞서 있어도 주입 Clock으로 가른다', async () => {
    const { clock, retirer } = retirerAt();
    const eventId = newEventId();
    await open(eventId);
    expect(await retirer.retireEvent({ eventId, saleEndMs: clock.now() })).toBe('TOO_EARLY');
    expect(await retirer.retireEvent({ eventId, saleEndMs: clock.now() - RETIRE_AFTER_SALE_END_MS / 2 })).toBe('TOO_EARLY');
    expect(await listed(eventId)).toBe(true);
    expect(await exists(redis, seatKeys.stream(eventId))).toBe(0);
  });

  test('경계: 지금이 정확히 판매 종료 + 1시간이면 뺀다(정본 "판매 종료 + 1시간 뒤"를 "같거나 지남"으로 읽는다). 1ms 앞이면 TOO_EARLY, 주입 시계를 1ms 밀면 RETIRED', async () => {
    const { clock, retirer } = retirerAt();
    expect(RETIRE_AFTER_SALE_END_MS).toBe(60 * 60_000);
    const eventId = newEventId();
    await open(eventId);
    const saleEndMs = clock.now() - RETIRE_AFTER_SALE_END_MS + 1;
    expect(await retirer.retireEvent({ eventId, saleEndMs })).toBe('TOO_EARLY');
    expect(await listed(eventId)).toBe(true);
    clock.advance(1);
    expect(clock.now()).toBe(saleEndMs + RETIRE_AFTER_SALE_END_MS);
    expect(await retirer.retireEvent({ eventId, saleEndMs })).toBe('RETIRED');
    expect(await listed(eventId)).toBe(false);
  });

  test('Stream이 없으면(XLEN 0, 소비자 그룹 없음 NOGROUP → 확인받지 못한 항목 0) RETIRED이고 그 회차만 목록에서 빠진다: 같이 있던 다른 회차(지난 회차·이른 회차)는 그대로다. Stream 키를 만들지 않고, 다시 부르면 NOT_LISTED다', async () => {
    const { clock, retirer } = retirerAt();
    const [gone, pastToo, early] = [newEventId(), newEventId(), newEventId()];
    for (const e of [gone, pastToo, early]) await open(e);
    expect(await pendingOrNull(gone)).toBeNull();
    expect(await retirer.retireEvent({ eventId: gone, saleEndMs: endedLongAgo(clock) })).toBe('RETIRED');
    expect(await listed(gone)).toBe(false);
    expect(await listed(pastToo)).toBe(true);
    expect(await listed(early)).toBe(true);
    expect(await exists(redis, seatKeys.stream(gone))).toBe(0);
    // 이른 회차는 TOO_EARLY로 남는다(앞의 RETIRED와 섞이지 않는다)
    expect(await retirer.retireEvent({ eventId: early, saleEndMs: clock.now() })).toBe('TOO_EARLY');
    expect(await listed(early)).toBe(true);
    expect(await retirer.retireEvent({ eventId: gone, saleEndMs: endedLongAgo(clock) })).toBe('NOT_LISTED');
    expect(await listed(pastToo)).toBe(true);
  });

  test('코드 리뷰_만료 인덱스에 홀드가 남아 있으면(만료가 멈췄던 회차) EXPIRY_PENDING이고 목록에 그대로다(빼면 그 홀드가 끝내 만료되지 않는다)', async () => {
    const { clock, retirer } = retirerAt();
    const eventId = newEventId();
    await open(eventId);
    const ek = seatKeys.expiry(eventId);
    await cmd(redis, ek, ['ZADD', ek, '1', '7']);

    expect(await retirer.retireEvent({ eventId, saleEndMs: endedLongAgo(clock) })).toBe('EXPIRY_PENDING');
    expect(await listed(eventId)).toBe(true);

    await cmd(redis, ek, ['DEL', ek]);
    expect(await retirer.retireEvent({ eventId, saleEndMs: endedLongAgo(clock) })).toBe('RETIRED');
  });

  test('Stream에 항목이 남아 있으면(XLEN > 0) STREAM_PENDING이고 목록과 Stream이 그대로다: 소비자 그룹이 없을 때(NOGROUP)도, 릴레이가 모두 읽고 확인했지만 아직 지우지 않았을 때(XPENDING 0)도', async () => {
    const { clock, retirer } = retirerAt();
    const eventId = newEventId();
    await open(eventId);
    await store.hold(holdInputOf(eventId, seatAt(0), randomUUID()));
    expect(await xlen(redis, eventId)).toBe(1);
    expect(await pendingOrNull(eventId)).toBeNull();
    expect(await retirer.retireEvent({ eventId, saleEndMs: endedLongAgo(clock) })).toBe('STREAM_PENDING');
    expect(await listed(eventId)).toBe(true);

    // 릴레이가 읽고(XGROUP CREATE + XREADGROUP) 확인만 하고(XACK) 지우기(XTRIM) 전에 멈췄다
    const read = await new RedisSeatStreamSource(redis).read(eventId, 10);
    expect(read).toHaveLength(1);
    const k = seatKeys.stream(eventId);
    expect(Number(await cmd(redis, k, ['XACK', k, STREAM_RELAY_GROUP, ...read.map((x) => x.id)]))).toBe(1);
    expect(await pendingOrNull(eventId)).toBe(0);
    expect(await retirer.retireEvent({ eventId, saleEndMs: endedLongAgo(clock) })).toBe('STREAM_PENDING');
    expect(await listed(eventId)).toBe(true);
    expect((await streamItems(redis, eventId)).map((x) => x.id)).toEqual(read.map((x) => x.id));
  });

  test('항목은 모두 지웠어도 소비자 그룹 stream-relay에 확인받지 못한 항목이 남아 있으면 STREAM_PENDING이다(XREADGROUP으로 읽고 XACK하지 않은 채 XTRIM으로 지워 PEL에만 남음). 릴레이가 확인하고 지우면(XACK + XTRIM MINID) RETIRED다', async () => {
    const { clock, retirer } = retirerAt();
    const eventId = newEventId();
    await open(eventId);
    await store.hold(holdInputOf(eventId, seatAt(0), randomUUID()));
    await store.hold(holdInputOf(eventId, seatAt(1), randomUUID()));
    // 홀드는 만료로 끝난 것으로 둔다(만료 인덱스가 비어야 뺄 수 있다, PRF-142 코드 리뷰). 이 시험은 Stream 쪽 조건만 본다
    await cmd(redis, seatKeys.expiry(eventId), ['DEL', seatKeys.expiry(eventId)]);
    const source = new RedisSeatStreamSource(redis);
    const read = await source.read(eventId, 10);
    expect(read).toHaveLength(2);
    const k = seatKeys.stream(eventId);
    await cmd(redis, k, ['XTRIM', k, 'MAXLEN', '0']);
    expect(await xlen(redis, eventId)).toBe(0);
    expect(await pendingOrNull(eventId)).toBe(2);
    expect(await retirer.retireEvent({ eventId, saleEndMs: endedLongAgo(clock) })).toBe('STREAM_PENDING');
    expect(await listed(eventId)).toBe(true);
    expect(await pendingOrNull(eventId)).toBe(2);

    await source.ack(eventId, read.map((x) => x.id));
    expect(await pendingOrNull(eventId)).toBe(0);
    expect(await xlen(redis, eventId)).toBe(0);
    expect(await retirer.retireEvent({ eventId, saleEndMs: endedLongAgo(clock) })).toBe('RETIRED');
    expect(await listed(eventId)).toBe(false);
  });

  test('항목을 모두 지운 빈 Stream에 소비자 그룹이 없으면(XPENDING이 NOGROUP) 확인받지 못한 항목 0으로 보고 RETIRED다', async () => {
    const { clock, retirer } = retirerAt();
    const eventId = newEventId();
    await open(eventId);
    await store.hold(holdInputOf(eventId, seatAt(0), randomUUID()));
    // 홀드는 만료로 끝난 것으로 둔다(만료 인덱스가 비어야 뺄 수 있다, PRF-142 코드 리뷰). 이 시험은 Stream 쪽 조건만 본다
    await cmd(redis, seatKeys.expiry(eventId), ['DEL', seatKeys.expiry(eventId)]);
    const k = seatKeys.stream(eventId);
    await cmd(redis, k, ['XTRIM', k, 'MAXLEN', '0']);
    expect(await exists(redis, k)).toBe(1);
    expect(await xlen(redis, eventId)).toBe(0);
    expect(await pendingOrNull(eventId)).toBeNull();
    expect(await retirer.retireEvent({ eventId, saleEndMs: endedLongAgo(clock) })).toBe('RETIRED');
    expect(await listed(eventId)).toBe(false);
  });

  test('NOT_LISTED: 목록에 없는 회차(판매 종료 + 1시간이 지났고 Stream 없음)는 NOT_LISTED이고 목록의 다른 회차는 그대로다', async () => {
    const { clock, retirer } = retirerAt();
    const kept = newEventId();
    await open(kept);
    const before = Number(await cmd(redis, seatKeys.ctlEvents(), ['SCARD', seatKeys.ctlEvents()]));
    const stranger = newEventId();
    expect(await retirer.retireEvent({ eventId: stranger, saleEndMs: endedLongAgo(clock) })).toBe('NOT_LISTED');
    expect(await listed(stranger)).toBe(false);
    expect(await listed(kept)).toBe(true);
    expect(Number(await cmd(redis, seatKeys.ctlEvents(), ['SCARD', seatKeys.ctlEvents()]))).toBe(before);
    expect(await exists(redis, seatKeys.stream(stranger))).toBe(0);
  });
});

// ───────────────────────────── 묶기 경주 ─────────────────────────────

describe('묶기(pin)와 같은 좌석의 만료·다른 사람 홀드의 경주(실제 Valkey, 연결 둘, docs/data.md §5 결제 접수 뒤 좌석 묶기)', () => {
  test(`ASVS15.4.2_묶기와 만료가 같은 좌석에서 겹쳐도(${ROUNDS}라운드, 라운드마다 새 좌석) 끝은 (가) 묶기가 먼저: 내 홀드가 그대로 묶임(만료 안 됨) 또는 (나) 만료가 먼저: 빈 좌석을 묶기가 새 토큰으로 다시 잡아 묶음 둘 중 하나다. 어느 라운드도 비트 1인데 홀드 Hash 없음·보유 수 ≠ 홀드 수·같은 좌석 HELD 토큰 역순이 없다 [ASVS v5.0.0-15.4.2]`, async () => {
    const seen = { pinFirst: 0, expireFirst: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const eventId = newEventId();
      await open(eventId);
      const seat = seatAt(round % SEATS);
      const me = randomUUID();
      const { input, held } = await placeDueHold(eventId, seat, me);
      const lag = LAGS[round % LAGS.length]!;
      const what = `라운드 ${round}(늦춤 ${lag}ms)`;
      const [pinned, swept] = await Promise.all([after(-lag, () => store.pin(pinInputOf(input))), after(lag, () => sweepSeat(other, eventId, seat))]);

      expect(pinned, what).toMatchObject({ kind: 'OK', gen: INITIAL_SEAT_GEN });
      const p = pinned as PinOk;
      const st = await seatState(eventId, seat.index);
      // 어느 차례든: 비트 1, 내 홀드(holdId·owner·구매 세션), 묶임, 만료 인덱스에 없음, 보유 수 1
      expect(st.bit, what).toBe(1);
      expect(st.hold, what).toMatchObject({ holdId: input.holdId, owner: me, psid: input.purchaseSessionId, kind: 'FAN', pin: '1' });
      expect(st.expiry, what).toBeNull();
      expect(await quotaOf(eventId, me), what).toBe(1);
      if (p.regrabbed === 0) {
        // (가) 묶기가 먼저: 처음 토큰 그대로, 만료는 그 좌석을 읽지 못했거나(NOT_DUE) 읽었어도 풀지 않았다(건너뜀)
        seen.pinFirst++;
        expect(p.fencingToken, what).toBeUndefined();
        expect(st.hold!.fence, what).toBe(String(held.fencingToken));
        if (swept !== 'NOT_DUE') expect(swept, what).toMatchObject({ kind: 'OK', released: 0, skipped: 1, expired: [] });
        expect(await seatTrail(eventId, seat.index), what).toEqual([`HELD:${held.fencingToken}`]);
      } else {
        // (나) 만료가 먼저: 처음 토큰으로 풀고(EXPIRED), 묶기가 빈 좌석을 새 토큰으로 다시 잡았다(HELD)
        seen.expireFirst++;
        expect(p.regrabbed, what).toBe(1);
        expect(swept, what).toMatchObject({ kind: 'OK', released: 1, expired: [{ index: seat.index, fencingToken: held.fencingToken }] });
        expect(p.fencingToken, what).toBeGreaterThan(held.fencingToken);
        expect(st.hold!.fence, what).toBe(String(p.fencingToken));
        expect(await seatTrail(eventId, seat.index), what).toEqual([`HELD:${held.fencingToken}`, `EXPIRED:${held.fencingToken}`, `HELD:${p.fencingToken}`]);
      }
      await expectConsistent(eventId, [me], what);
    }
    // 늦춤 표의 양 끝(±25ms)에서는 한쪽이 먼저 끝난다: 두 끝 상태가 모두 나와야 두 차례를 모두 거친 것이다
    expect(seen.pinFirst, JSON.stringify(seen)).toBeGreaterThan(0);
    expect(seen.expireFirst, JSON.stringify(seen)).toBeGreaterThan(0);
  }, 120_000);

  test(`ST8_만료돼 빈 내 좌석을 두고 묶기(내 주문)와 다른 계정의 홀드가 겹쳐도(${ROUNDS}라운드) 끝은 (가) 묶기가 이김: 비트 1·내 holdId·상대 CONFLICT 또는 (나) 상대가 이김: 상대 holdId·묶기 TAKEN 둘 중 하나다. 두 사람 모두 잡았다고 답한 라운드는 0이다 [ASVS v5.0.0-2.3.4] [S-T8]`, async () => {
    const seen = { pinWon: 0, otherWon: 0, bothWon: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const eventId = newEventId();
      await open(eventId);
      const seat = seatAt(round % SEATS);
      const me = randomUUID();
      const rival = randomUUID();
      const { input, held } = await placeDueHold(eventId, seat, me);
      // 내 홀드가 만료돼 풀렸다(비트 0, 홀드 Hash 없음, 보유 수 0)
      expect(await sweepSeat(store, eventId, seat)).toMatchObject({ kind: 'OK', released: 1 });
      expect(await seatState(eventId, seat.index)).toEqual({ bit: 0, hold: null, expiry: null });
      const rivalInput = holdInputOf(eventId, seat, rival);
      const lag = LAGS[round % LAGS.length]!;
      const what = `라운드 ${round}(늦춤 ${lag}ms)`;
      const [pinned, theirs] = await Promise.all([after(-lag, () => store.pin(pinInputOf(input))), after(lag, () => other.hold(rivalInput))]);

      if (pinned.kind === 'OK' && theirs.kind === 'OK') seen.bothWon++;
      const st = await seatState(eventId, seat.index);
      expect(st.bit, what).toBe(1);
      if (pinned.kind === 'OK') {
        // (가) 묶기가 이김: 빈 좌석을 새 토큰으로 다시 잡아 묶었고, 상대는 그 좌석에서 CONFLICT
        seen.pinWon++;
        expect(theirs, what).toEqual({ kind: 'CONFLICT', seatId: seat.seatId });
        expect(pinned, what).toEqual({ kind: 'OK', gen: INITIAL_SEAT_GEN, regrabbed: 1, fencingToken: expect.any(Number) });
        expect(pinned.fencingToken, what).toBeGreaterThan(held.fencingToken);
        expect(st.hold, what).toMatchObject({ holdId: input.holdId, owner: me, fence: String(pinned.fencingToken), pin: '1' });
        expect(st.expiry, what).toBeNull();
        expect(await quotaOf(eventId, me), what).toBe(1);
        expect(await quotaOf(eventId, rival), what).toBe(0);
        expect(await seatTrail(eventId, seat.index), what).toEqual([`HELD:${held.fencingToken}`, `EXPIRED:${held.fencingToken}`, `HELD:${pinned.fencingToken}`]);
      } else {
        // (나) 상대가 이김: 묶기는 남이 잡은 첫 좌석의 색인으로 TAKEN이고 아무것도 쓰지 않았다
        seen.otherWon++;
        expect(pinned, what).toEqual({ kind: 'TAKEN', seatIndex: seat.index });
        const t = heldOk(theirs, what);
        expect(st.hold, what).toMatchObject({ holdId: rivalInput.holdId, owner: rival, fence: String(t.fencingToken) });
        expect(st.hold!.pin, what).toBeUndefined();
        expect(st.expiry, what).toBe(t.expiresAtMs);
        expect(await quotaOf(eventId, me), what).toBe(0);
        expect(await quotaOf(eventId, rival), what).toBe(1);
        expect(await seatTrail(eventId, seat.index), what).toEqual([`HELD:${held.fencingToken}`, `EXPIRED:${held.fencingToken}`, `HELD:${t.fencingToken}`]);
      }
      await expectConsistent(eventId, [me, rival], what);
    }
    expect(seen.bothWon, JSON.stringify(seen)).toBe(0);
    expect(seen.pinWon, JSON.stringify(seen)).toBeGreaterThan(0);
    expect(seen.otherWon, JSON.stringify(seen)).toBeGreaterThan(0);
  }, 120_000);
});
