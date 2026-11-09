// 좌석을 쓰는 Lua가 그 자리에서 회차 세대를 올린다(BUILD_ORDER PRF-168 리뷰 고침 H1, ADR-0210 결정 1·2, docs/features/seat-hold.md §6 '쓰는 Lua가 그 자리에서 올린다',
// docs/data.md §3 s:{event:E}:epoch의 node·chk·bumps, src/modules/inventory/adapters/hold-lua.ts ENSURE_EPOCH). 메모리 저장소(test/seat-epoch-bump.test.ts)와
// 실제 Valkey 8.1(test-int/seat-store.int.test.ts: 단일 노드와 노드 하나짜리 클러스터 모드)에 똑같이 돈다.
// 승격(장애 조치)은 세대 키 node를 옛 주 노드의 표지로 바꿔 흉내 낸다(실제 클러스터 승격은 S-T26 측정의 몫). '같은 초 안에 이미 견줌'은 chk를 저장소의 지금 초로
// 써 넣고 부른 뒤 저장소 초가 그대로인지 본다(Lua 안의 시각은 Redis TIME이라 바꿀 수 없다. 초가 바뀌었으면 새 회차로 다시 한다, 고정 sleep 없음).
// '시간이 지난 홀드'는 expiry-cases.ts처럼 exp·만료 인덱스 점수를 1분 전으로 쓴다.
// 붙이는 Lua: 홀드(HOLD_LUA), 만료(EXPIRE_LUA), 묶기(PIN_LUA), 실패 해제(RELEASE_FAILED_LUA). 해제·연장 Lua는 아직 없다(뒤 단계가 만들 때 같은 도우미를 붙인다).
// 도우미의 자리(리뷰 고침 결함 1, 2026-11-05): 오류로 끝나는 검사(키 모양·지난 keepUntil·멱등 응답 모양·토큰 넘침) 뒤, 업무 판정(거절 결과) 앞이다.
// 그래서 오류로 끝나는 호출은 세대 키를 하나도 바꾸지 않고, 정상 거절은 올린다.
import { type Clock, systemClock, uuidv7 } from '@peaket/platform';
import { expect, test } from 'vitest';
import type { HoldInput, PinInput, ReleaseFailedInput, SeatExpiries, SeatPins, SeatRebuildTarget, SeatStore } from '../src/modules/inventory/index.js';
import { expireSeatsOf, okOf } from './expiry-cases.js';
import { ACCOUNT_A, ACCOUNT_B, DAY, fingerprintOf, held, holdInput, idx, newEvent, ref, SEAT_COUNT } from './hold-cases.js';

/** 쓰는 Lua 넷과 세대 올리기를 가진 저장소(MemorySeatStore·RedisSeatStore) */
export type EpochBumpStore = SeatStore & SeatExpiries & SeatPins & Pick<SeatRebuildTarget, 'bumpEpoch'>;

/** 저장소 하나와 세대 키를 직접 쓰고 읽는 도구. 키 이름은 docs/data.md §3(seatKeys)이다 */
export interface EpochBumpHarness {
  store: EpochBumpStore;
  /** 시험 쪽 지금. 메모리는 저장소에 넣은 가짜 시계, Valkey는 시스템 시계(Lua는 Redis TIME) */
  clock: Clock;
  /** 이 저장소의 Lua가 도는 노드의 표지(nodeId()): 메모리는 생성자 nodeId, 단일 노드 Valkey는 'standalone', 클러스터는 '{CLUSTER MYID}:{cluster_my_epoch}' */
  me(): string;
  /** 저장소 시각의 초(Lua의 TIME 초. 메모리는 주입 시계, Valkey는 TIME 명령) */
  serverSec(): Promise<number>;
  /** 세대 키의 칸을 바꾼다(Valkey HSET. 메모리는 MemorySeatEvent.epoch의 칸, epoch·chk는 수로) */
  setEpoch(eventId: string, fields: { node?: string; chk?: string; epoch?: string }): Promise<void>;
  /** 세대 키(없으면 null). chk 칸이 없으면 chk는 null */
  epoch(eventId: string): Promise<{ epoch: number; node: string; chk: number | null } | null>;
  /** 세대 키의 칸 전부(글, 없으면 null). '세대 키가 하나도 바뀌지 않았다'와 bumps 칸을 본다(리뷰 고침 결함 1·중간 1) */
  epochRaw(eventId: string): Promise<Record<string, string> | null>;
  /** Stream 항목의 칸(XADD 차례, 항목 ID 없이) */
  stream(eventId: string): Promise<Record<string, string>[]>;
  /** 회차 키를 쓰기 전에 한 번 부른다(Valkey: 그 회차 구역 채널을 샤드 Pub/Sub로 구독한다) */
  prepare?(eventId: string): Promise<void>;
  /** 그 회차 구역 채널로 보낸 샤드 Pub/Sub(보낸 차례) */
  published(eventId: string): Promise<{ channel: string; message: string }[]>;
  /** 좌석 색인의 홀드 Hash exp와 만료 인덱스 점수를 at으로 쓴다(시간이 지난 홀드) */
  backdate(eventId: string, index: number, at: number): Promise<void>;
  /** 판매 정지 사본 ctl의 paused 칸을 '1'로(회차 범위 판매 일시정지) */
  pause(eventId: string): Promise<void>;
  /** 회차 키 하나를 망가뜨린다: fence = 10진 글이 아님, quota(그 계정) = 표준 10진 정수가 아님 */
  corrupt(eventId: string, what: 'fence' | 'quota', accountId: string): Promise<void>;
  /**
   * 지금까지 표지의 설정 세대까지 구한 수(클러스터 Valkey: INFO commandstats의 cmdstat_cluster|info calls). 셀 수 없으면 없다(메모리·단일 노드).
   * 견주기 비용(ADR-0210 결정 2: CLUSTER INFO는 회차마다 1초에 한 번)을 본다
   */
  fullChecks?(): Promise<number>;
}

/** 승격 전 주 노드의 표지 흉내(다른 노드 ID, 클러스터 모양 '{CLUSTER MYID}:{cluster_my_epoch}') */
export const OLD_PRIMARY = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d:3';
/** 시계가 뒤로 가 남은 미래의 chk(먼 앞 초. Lua TIME 초보다 늘 크다, 리뷰 고침 낮음 d) */
const FAR_CHK = '9999999999';
/** '시간이 지난 홀드'의 과거(앱 시계보다 1분 전, Docker VM 시계 차이 5초보다 넉넉하다) */
const PAST_MS = 60_000;
/** '같은 초 안'을 다시 하는 한도(한 번에 몇 ms라 초가 다섯 번 모두 바뀔 일은 없다) */
const SAME_SECOND_TRIES = 5;

/** 델타 글 '1 {seatEpoch} {구역 색인} {구역 번호} {바꾼 시각} …'의 세대 */
const deltaEpoch = (message: string) => Number(message.split(' ')[1]);
/** 표지의 노드 ID 부분(':' 앞) */
const idPart = (node: string) => node.split(':')[0]!;

/**
 * @param o.configPart 표지에 설정 세대 부분(':' 뒤)이 있는 저장소인가(클러스터 모드 Valkey, 클러스터 모양 nodeId의 메모리). 있을 때만 '같은 노드 ID, 다른 설정 세대' 사례를 돈다
 */
export function epochBumpCases(name: string, setup: () => Promise<EpochBumpHarness>, o: { configPart: boolean }): void {
  async function world(w: { open?: boolean } = {}) {
    const h = await setup();
    const e = newEvent();
    await h.prepare?.(e);
    const keepUntilMs = h.clock.now() + 2 * DAY;
    if (w.open !== false) await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    const hold = (seatIds: readonly string[], c: Partial<Omit<HoldInput, 'eventId' | 'seats'>> = {}) => h.store.hold(holdInput(e, seatIds, { keepUntilMs, ...c }));
    const pinOf = (seatIds: readonly string[], c: { accountId?: string; holdId: string; purchaseSessionId?: string; orderGen?: number }): PinInput => ({
      eventId: e,
      accountId: c.accountId ?? ACCOUNT_A,
      purchaseSessionId: c.purchaseSessionId ?? 'ps-a',
      holdId: c.holdId,
      seats: [...seatIds].sort().map(ref),
      limit: 4,
      orderGen: c.orderGen ?? 1,
      keepUntilMs,
    });
    const releaseOf = (seatIds: readonly string[], c: { accountId?: string; holdId: string }): ReleaseFailedInput => ({
      eventId: e,
      accountId: c.accountId ?? ACCOUNT_A,
      holdId: c.holdId,
      seats: [...seatIds].sort().map(ref),
      keepUntilMs,
    });
    /** 승격 흉내 뒤 한 번 부르고, 세대가 한 번 올라 node = 지금 표지·chk = 그때 초인지 본다. 올린 새 세대를 돌려준다 */
    async function bumpsOnce<T>(call: () => Promise<T>, node = OLD_PRIMARY): Promise<{ r: T; epoch: number }> {
      const before = (await h.epoch(e))!;
      await h.setEpoch(e, { node });
      const sec0 = await h.serverSec();
      const r = await call();
      const after = (await h.epoch(e))!;
      expect(after.node, '올린 뒤 node = 지금 노드 표지').toBe(h.me());
      expect(after.epoch, 'epoch = max(epoch + 1, TIME 초)').toBeGreaterThanOrEqual(Math.max(before.epoch + 1, sec0));
      expect(after.chk, '견준 초 chk').toBeGreaterThanOrEqual(sec0);
      return { r, epoch: after.epoch };
    }
    /** 오류로 끝나는 호출: 던지고(그 글), 세대 키(칸 전부)·Stream·샤드 Pub/Sub가 그대로다 */
    async function rejectsUntouched(what: string, call: () => Promise<unknown>, message: RegExp): Promise<void> {
      const before = { epoch: await h.epochRaw(e), stream: (await h.stream(e)).length, published: (await h.published(e)).length };
      const out = await call().then(
        (v) => `풀렸다: ${JSON.stringify(v)}`,
        (x: unknown) => (x instanceof Error ? x.message : String(x)),
      );
      expect.soft({ what, out }).toEqual({ what, out: expect.stringMatching(message) });
      const after = { epoch: await h.epochRaw(e), stream: (await h.stream(e)).length, published: (await h.published(e)).length };
      expect.soft({ what, s: after }, `${what}: 세대 키(epoch·node·chk·bumps)·Stream·Pub/Sub가 그대로다`).toEqual({ what, s: before });
    }
    return { h, e, keepUntilMs, hold, pinOf, releaseOf, bumpsOnce, rejectsUntouched };
  }

  /**
   * '같은 초 안'을 만든다(ADR-0210 결정 2, 리뷰 고침 낮음 d: chk가 지금 초와 같을 때만 설정 세대 견주기를 건너뛴다). attempt(새 회차, 저장소의 지금 초)는
   * chk를 그 초로 쓰고 부른다. 그 뒤 저장소 초가 그대로면(그 Lua가 그 초에 돌았다) 결과로 check를 부르고 끝, 초가 바뀌었으면 새 회차로 다시 한다
   * (메모리는 시계가 멈춰 있어 한 번에 끝난다)
   */
  async function inOneSecond<T>(attempt: (w: Awaited<ReturnType<typeof world>>, sec: number) => Promise<T>, check: (w: Awaited<ReturnType<typeof world>>, r: T, sec: number) => Promise<void>): Promise<void> {
    for (let k = 0; k < SAME_SECOND_TRIES; k++) {
      const w = await world();
      const sec = await w.h.serverSec();
      const r = await attempt(w, sec);
      if ((await w.h.serverSec()) !== sec) continue;
      await check(w, r, sec);
      return;
    }
    throw new Error(`저장소 초가 ${SAME_SECOND_TRIES}번 모두 바뀌어 '같은 초 안'을 만들지 못했다`);
  }

  test(`[${name}] ST26_리뷰 고침 H1_ 승격 뒤 첫 홀드가 그 자리에서 세대를 한 번 올리고(node = 지금 표지, chk = 그 초), 그 홀드의 Stream HELD·델타가 새 세대를 싣는다. 이어지는 홀드·세대 올리기는 다시 올리지 않는다 [ASVS v5.0.0-15.4.2] [S-T26]`, async () => {
    const w = await world();
    const { h, e } = w;
    const { r, epoch } = await w.bumpsOnce(() => w.hold(['A01']));
    held(r);
    const s1 = await h.stream(e);
    expect(s1.at(-1)).toMatchObject({ type: 'HELD', seatIdx: String(idx('A01')), seatEpoch: String(epoch) });
    const p1 = await h.published(e);
    expect(p1).toHaveLength(1);
    expect(deltaEpoch(p1[0]!.message)).toBe(epoch);

    // 이어서 홀드: 세대 그대로, 그 홀드의 HELD·델타도 같은 세대
    held(await w.hold(['A02'], { accountId: ACCOUNT_B }));
    expect(await h.epoch(e)).toMatchObject({ epoch, node: h.me() });
    expect((await h.stream(e)).at(-1)).toMatchObject({ type: 'HELD', seatIdx: String(idx('A02')), seatEpoch: String(epoch) });
    const p2 = await h.published(e);
    expect(p2).toHaveLength(2);
    expect(deltaEpoch(p2[1]!.message)).toBe(epoch);
    // 감시의 세대 올리기도 다시 올리지 않는다(쓰는 Lua가 이미 올렸다. 올린 수 bumps = 1)
    expect(await h.store.bumpEpoch(e)).toEqual({ result: 'SAME', epoch, bumps: 1 });
  });

  test(`[${name}] ST26_리뷰 고침 H1_ 거절로 끝나 아무것도 쓰지 않는 홀드(이미 잡힌 좌석 CONFLICT·한도 QUOTA_EXCEEDED)도 세대는 올린다. 거절 결과·좌석은 그대로다 [ASVS v5.0.0-15.4.2] [S-T26]`, async () => {
    const w = await world();
    const { h, e } = w;
    held(await w.hold(['A01'], { accountId: ACCOUNT_B }));
    const streamBefore = (await h.stream(e)).length;
    const c = await w.bumpsOnce(() => w.hold(['A01']));
    expect(c.r).toEqual({ kind: 'CONFLICT', seatId: 'A01' });
    const q = await w.bumpsOnce(() => w.hold(['A03', 'A04'], { limit: 1 }));
    expect(q.r).toEqual({ kind: 'QUOTA_EXCEEDED' });
    expect(q.epoch).toBeGreaterThan(c.epoch);
    expect(await h.stream(e)).toHaveLength(streamBefore);
  });

  test(`[${name}] ST26_리뷰 고침 결함 1_ 정상 거절(멱등 재생 IDEM_REPLAY·다른 지문 IDEM_REUSED·방금 놓은 좌석 REHOLD_WAIT·판매 정지 PAUSED, 묶기의 실패 표시 FAILED_HOLD·낡은 판 번호 STALE_GEN)도 그 자리에서 세대를 올린다 [ASVS v5.0.0-15.4.2] [S-T26]`, async () => {
    const w = await world();
    const { h, e } = w;
    // 멱등 재생·다른 지문
    const first = holdInput(e, ['A05'], { keepUntilMs: w.keepUntilMs });
    held(await h.store.hold(first));
    const replay = await w.bumpsOnce(() => h.store.hold(first));
    expect(replay.r).toMatchObject({ kind: 'IDEM_REPLAY', holdId: first.holdId });
    const reused = await w.bumpsOnce(() => h.store.hold({ ...first, fingerprint: fingerprintOf(['A06']) }));
    expect(reused.r).toEqual({ kind: 'IDEM_REUSED' });
    expect(reused.epoch).toBeGreaterThan(replay.epoch);

    // 방금 놓은 좌석(만료가 놓은 A01을 같은 계정이 30초 안에 다시 잡음)
    held(await w.hold(['A01']));
    await h.backdate(e, idx('A01'), h.clock.now() - PAST_MS);
    const due = await h.store.dueExpiries({ eventId: e, nowMs: h.clock.now(), limit: 100 });
    expect(okOf(await h.store.expire({ eventId: e, keepUntilMs: w.keepUntilMs, seats: expireSeatsOf(due) })).released).toBe(1);
    const wait = await w.bumpsOnce(() => w.hold(['A01']));
    expect(wait.r).toMatchObject({ kind: 'REHOLD_WAIT', seatIds: ['A01'] });

    // 실패 표시(실패 해제 뒤 늦은 묶기)·낡은 판 번호(빈 좌석, orderGen 2)
    const failedHold = uuidv7(systemClock);
    held(await w.hold(['A02'], { holdId: failedHold, purchaseSessionId: 'ps-a' }));
    expect(await h.store.releaseFailed(w.releaseOf(['A02'], { holdId: failedHold }))).toEqual({ kind: 'OK', released: 1 });
    const late = await w.bumpsOnce(() => h.store.pin(w.pinOf(['A02'], { holdId: failedHold })));
    expect(late.r).toEqual({ kind: 'FAILED_HOLD' });
    const stale = await w.bumpsOnce(() => h.store.pin(w.pinOf(['A07'], { holdId: uuidv7(systemClock), orderGen: 2 })));
    expect(stale.r).toEqual({ kind: 'STALE_GEN', gen: 1 });

    // 판매 정지(마지막: 뒤의 홀드가 모두 PAUSED가 된다)
    await h.pause(e);
    const paused = await w.bumpsOnce(() => w.hold(['A08']));
    expect(paused.r).toEqual({ kind: 'PAUSED' });
    expect(paused.epoch).toBeGreaterThan(stale.epoch);
  });

  test(`[${name}] ST26_리뷰 고침 결함 1_ 세대 키 node가 옛 표지여도 오류로 끝나는 홀드·만료·묶기·실패 해제(지난 keepUntil, 망가진 fence·보유 수)는 세대 키를 하나도 바꾸지 않는다(epoch·node·chk·bumps 모두). Stream·델타도 없다 [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-15.4.2] [S-T26]`, async () => {
    const w = await world();
    const { h, e } = w;
    const holdId = uuidv7(systemClock);
    held(await w.hold(['A01'], { holdId, purchaseSessionId: 'ps-a' }));
    held(await w.hold(['B01'], { accountId: ACCOUNT_B }));
    await h.backdate(e, idx('B01'), h.clock.now() - PAST_MS);
    const due = await h.store.dueExpiries({ eventId: e, nowMs: h.clock.now(), limit: 100 });
    expect(due.map((d) => d.index)).toEqual([idx('B01')]);
    // 승격 흉내(옛 표지)와 지난 chk: 지금 코드가 오류 검사 앞에서 올리면 epoch·node·chk·bumps가 모두 바뀐다
    await h.setEpoch(e, { node: OLD_PRIMARY, chk: '1' });
    const PAST = 1;

    await w.rejectsUntouched('홀드 지난 keepUntil', () => w.hold(['A02'], { keepUntilMs: PAST }), /PEAKET_KEEP_UNTIL_PAST/);
    await w.rejectsUntouched('만료 지난 keepUntil', () => h.store.expire({ eventId: e, keepUntilMs: PAST, seats: expireSeatsOf(due) }), /PEAKET_KEEP_UNTIL_PAST/);
    await w.rejectsUntouched('묶기 지난 keepUntil', () => h.store.pin({ ...w.pinOf(['A01', 'A03'], { holdId }), keepUntilMs: PAST }), /PEAKET_KEEP_UNTIL_PAST/);
    await w.rejectsUntouched('실패 해제 지난 keepUntil', () => h.store.releaseFailed({ ...w.releaseOf(['A01'], { holdId }), keepUntilMs: PAST }), /PEAKET_KEEP_UNTIL_PAST/);

    await h.corrupt(e, 'fence', ACCOUNT_A);
    await w.rejectsUntouched('홀드 망가진 fence', () => w.hold(['A02']), /PEAKET_CORRUPT_KEY \S*:fence/);
    await w.rejectsUntouched('묶기 망가진 fence', () => h.store.pin(w.pinOf(['A01', 'A03'], { holdId })), /PEAKET_CORRUPT_KEY \S*:fence/);
    await h.corrupt(e, 'quota', ACCOUNT_A);
    await w.rejectsUntouched('실패 해제 망가진 보유 수', () => h.store.releaseFailed(w.releaseOf(['A01'], { holdId })), /PEAKET_CORRUPT_KEY \S*:quota/);
    expect(await h.epoch(e)).toMatchObject({ node: OLD_PRIMARY, chk: 1 });
  });

  test(`[${name}] ST26_리뷰 고침 낮음 a_ 세대 칸이 u32(앞 0 없는 0 ~ 4294967295)가 아니면 표지가 같아도 홀드·만료·묶기·실패 해제·세대 올리기가 쓰기 전에 PEAKET_CORRUPT_KEY(세대 키)로 끝나고 아무것도 쓰지 않는다(스냅샷 Lua와 같은 규칙) [ASVS v5.0.0-16.5.3] [S-T26]`, async () => {
    const w = await world();
    const { h, e } = w;
    const holdId = uuidv7(systemClock);
    held(await w.hold(['A01'], { holdId, purchaseSessionId: 'ps-a' }));
    held(await w.hold(['B01'], { accountId: ACCOUNT_B }));
    await h.backdate(e, idx('B01'), h.clock.now() - PAST_MS);
    const due = await h.store.dueExpiries({ eventId: e, nowMs: h.clock.now(), limit: 100 });
    // 표지는 그대로, chk는 지난 초(지금 코드는 설정 세대까지 견준 뒤 같다고 chk만 쓰고 망가진 세대를 Stream에 싣는다)
    await h.setEpoch(e, { epoch: '4294967296', chk: '1' });
    const bad = /PEAKET_CORRUPT_KEY \S*:epoch/;
    await w.rejectsUntouched('홀드', () => w.hold(['A02']), bad);
    await w.rejectsUntouched('만료', () => h.store.expire({ eventId: e, keepUntilMs: w.keepUntilMs, seats: expireSeatsOf(due) }), bad);
    await w.rejectsUntouched('묶기', () => h.store.pin(w.pinOf(['A01', 'A03'], { holdId })), bad);
    await w.rejectsUntouched('실패 해제', () => h.store.releaseFailed(w.releaseOf(['A01'], { holdId })), bad);
    await w.rejectsUntouched('세대 올리기', () => h.store.bumpEpoch(e), bad);
  });

  test(`[${name}] ST26_리뷰 고침 H1_ 세대 키가 없으면 홀드·만료·묶기·실패 해제는 지금처럼 NOT_READY이고 세대 키를 만들지 않는다 [ASVS v5.0.0-2.3.4] [S-T26]`, async () => {
    const w = await world({ open: false });
    const { h, e } = w;
    const holdId = uuidv7(systemClock);
    expect(await w.hold(['A01'])).toEqual({ kind: 'NOT_READY' });
    expect(await h.store.expire({ eventId: e, keepUntilMs: w.keepUntilMs, seats: [{ index: idx('A01'), expected: null }] })).toEqual({ kind: 'NOT_READY' });
    expect(await h.store.pin(w.pinOf(['A01'], { holdId }))).toEqual({ kind: 'NOT_READY' });
    expect(await h.store.releaseFailed(w.releaseOf(['A01'], { holdId }))).toEqual({ kind: 'NOT_READY' });
    expect(await h.epoch(e)).toBeNull();
  });

  test(`[${name}] ST26_리뷰 고침 H1_ 노드 ID가 다르면 chk가 이번 초를 가리켜도 그 자리에서 올린다(노드 ID는 매번 견준다) [ASVS v5.0.0-15.4.2] [S-T26]`, async () => {
    const w = await world();
    const { h, e } = w;
    await h.setEpoch(e, { chk: String(await h.serverSec()) });
    const { r, epoch } = await w.bumpsOnce(() => w.hold(['A01']));
    held(r);
    expect((await h.stream(e)).at(-1)).toMatchObject({ type: 'HELD', seatEpoch: String(epoch) });
  });

  if (o.configPart) {
    test(`[${name}] ST26_리뷰 고침 H1_ 노드 ID가 같고 설정 세대만 다르면 chk가 이번 초인 동안은 설정 세대를 견주지 않고(CLUSTER INFO 0번), chk가 지난 초면 견줘 한 번 올린다(CLUSTER INFO 1번) [ASVS v5.0.0-15.4.2] [S-T26]`, async () => {
      // 같은 초 안(chk = 지금 초): 설정 세대까지 견주지 않아 오르지 않는다
      await inOneSecond(
        async ({ h, e, hold }, sec) => {
          const stale = `${idPart(h.me())}:0`;
          expect(stale).not.toBe(h.me());
          const e0 = (await h.epoch(e))!.epoch;
          await h.setEpoch(e, { node: stale, chk: String(sec) });
          const c0 = await h.fullChecks?.();
          held(await hold(['A01']));
          return { stale, e0, c0, c1: await h.fullChecks?.() };
        },
        async ({ h, e, hold, bumpsOnce }, x, sec) => {
          if (x.c0 !== undefined) expect(x.c1! - x.c0, '같은 초 안의 CLUSTER INFO').toBe(0);
          expect(await h.epoch(e)).toEqual({ epoch: x.e0, node: x.stale, chk: sec });

          // chk가 지난 초: 설정 세대까지 견줘 한 번 올린다
          await h.setEpoch(e, { chk: '1' });
          const c1 = await h.fullChecks?.();
          const { r, epoch } = await bumpsOnce(() => hold(['A02']), x.stale);
          held(r);
          if (c1 !== undefined) expect((await h.fullChecks!()) - c1, '지난 초의 CLUSTER INFO').toBe(1);
          expect((await h.stream(e)).at(-1)).toMatchObject({ type: 'HELD', seatEpoch: String(epoch) });
        },
      );
    });
  }

  test(`[${name}] ST26_리뷰 고침 H1_ 같은 초 안의 두 번째 쓰기는 설정 세대를 다시 견주지 않는다: 지난 chk의 첫 홀드가 chk = 그 초로 두고(표지가 같아 오르지 않음), chk가 그 초인 다음 홀드는 CLUSTER INFO를 부르지 않는다 [ASVS v5.0.0-15.4.2] [S-T26]`, async () => {
    const w = await world();
    const { h, e } = w;
    const e0 = (await h.epoch(e))!.epoch;
    await h.setEpoch(e, { chk: '1' });
    const sec0 = await h.serverSec();
    const c0 = await h.fullChecks?.();
    held(await w.hold(['A01']));
    const first = (await h.epoch(e))!;
    expect(first).toMatchObject({ epoch: e0, node: h.me() });
    expect(first.chk).toBeGreaterThanOrEqual(sec0);
    if (c0 !== undefined && h.me().includes(':')) expect((await h.fullChecks!()) - c0, '지난 chk의 CLUSTER INFO').toBe(1);

    // 같은 초 안(chk = 지금 초): 다시 견주지 않는다
    await inOneSecond(
      async (x, sec) => {
        const ex = (await x.h.epoch(x.e))!.epoch;
        await x.h.setEpoch(x.e, { chk: String(sec) });
        const c1 = await x.h.fullChecks?.();
        held(await x.hold(['A02']));
        return { ex, c1, c2: await x.h.fullChecks?.() };
      },
      async (x, r, sec) => {
        if (r.c1 !== undefined) expect(r.c2! - r.c1, '같은 초 안의 CLUSTER INFO').toBe(0);
        expect(await x.h.epoch(x.e)).toEqual({ epoch: r.ex, node: x.h.me(), chk: sec });
      },
    );
  });

  test(`[${name}] ST26_리뷰 고침 낮음 d_ chk가 지금 초보다 앞(시계가 뒤로 가 남은 미래의 chk)이어도 같은 초로 보지 않고 설정 세대까지 견준다: 표지가 같으면 chk만 지금 초로 고치고, 설정 세대만 다르면 한 번 올린다 [ASVS v5.0.0-15.4.2] [S-T26]`, async () => {
    const w = await world();
    const { h, e } = w;
    const e0 = (await h.epoch(e))!.epoch;
    await h.setEpoch(e, { chk: FAR_CHK });
    const sec0 = await h.serverSec();
    held(await w.hold(['A01']));
    const ep = (await h.epoch(e))!;
    expect(ep).toMatchObject({ epoch: e0, node: h.me() });
    expect(ep.chk, '미래의 chk를 지금 초로 고친다').toBeGreaterThanOrEqual(sec0);
    expect(ep.chk).toBeLessThanOrEqual(await h.serverSec());

    if (o.configPart) {
      const stale = `${idPart(h.me())}:0`;
      await h.setEpoch(e, { node: stale, chk: FAR_CHK });
      const c0 = await h.fullChecks?.();
      const { r, epoch } = await w.bumpsOnce(() => w.hold(['A02']), stale);
      held(r);
      if (c0 !== undefined) expect((await h.fullChecks!()) - c0, '미래 chk의 CLUSTER INFO').toBe(1);
      expect((await h.stream(e)).at(-1)).toMatchObject({ type: 'HELD', seatEpoch: String(epoch) });
    }
  });

  test(`[${name}] ST26_리뷰 고침 중간 1_ 올릴 때마다 세대 키 bumps가 1씩 오르고(쓰는 Lua·세대 올리기 모두), 올리지 않으면 그대로다. 세대 올리기는 BUMPED·SAME 모두 bumps(없으면 0)를 돌려준다 [S-T26]`, async () => {
    const w = await world();
    const { h, e } = w;
    const bumps = async () => (await h.epochRaw(e))!.bumps;
    expect(await bumps(), '판매 열기는 bumps를 쓰지 않는다').toBeUndefined();
    const e0 = (await h.epoch(e))!.epoch;
    expect(await h.store.bumpEpoch(e)).toEqual({ result: 'SAME', epoch: e0, bumps: 0 });

    const a = await w.bumpsOnce(() => w.hold(['A01']));
    expect(await bumps()).toBe('1');
    expect(await h.store.bumpEpoch(e)).toEqual({ result: 'SAME', epoch: a.epoch, bumps: 1 });
    // 올리지 않는 쓰기는 그대로
    held(await w.hold(['A02'], { accountId: ACCOUNT_B }));
    expect(await bumps()).toBe('1');

    const b = await w.bumpsOnce(() => h.store.bumpEpoch(e));
    expect(b.r).toEqual({ result: 'BUMPED', epoch: b.epoch, bumps: 2 });
    const c = await w.bumpsOnce(() => h.store.releaseFailed(w.releaseOf(['A03'], { holdId: uuidv7(systemClock) })));
    expect(c.r).toEqual({ kind: 'OK', released: 0 });
    expect(await bumps()).toBe('3');
    expect(await h.store.bumpEpoch(e)).toEqual({ result: 'SAME', epoch: c.epoch, bumps: 3 });
  });

  test(`[${name}] ST26_리뷰 고침 H1_ 승격 뒤 만료가 그 자리에서 세대를 올리고 EXPIRED·델타가 새 세대를 싣는다. 풀 좌석이 없는 만료(건너뜀)도 올린다 [ASVS v5.0.0-15.4.2] [S-T26]`, async () => {
    const w = await world();
    const { h, e } = w;
    held(await w.hold(['A01']));
    await h.backdate(e, idx('A01'), h.clock.now() - PAST_MS);
    const due = await h.store.dueExpiries({ eventId: e, nowMs: h.clock.now(), limit: 100 });
    expect(due).toHaveLength(1);
    const pubBefore = (await h.published(e)).length;
    const { r, epoch } = await w.bumpsOnce(() => h.store.expire({ eventId: e, keepUntilMs: w.keepUntilMs, seats: expireSeatsOf(due) }));
    expect(okOf(r).released).toBe(1);
    expect((await h.stream(e)).at(-1)).toMatchObject({ type: 'EXPIRED', seatIdx: String(idx('A01')), seatEpoch: String(epoch) });
    const pub = await h.published(e);
    expect(pub).toHaveLength(pubBefore + 1);
    expect(deltaEpoch(pub.at(-1)!.message)).toBe(epoch);

    // 이미 푼 좌석을 다시 만료(건너뜀, 쓰지 않음)해도 승격 흉내 뒤면 올린다
    const again = await w.bumpsOnce(() => h.store.expire({ eventId: e, keepUntilMs: w.keepUntilMs, seats: expireSeatsOf(due) }));
    expect(okOf(again.r).released).toBe(0);
    expect(again.epoch).toBeGreaterThan(epoch);
  });

  test(`[${name}] ST26_리뷰 고침 H1_ 승격 뒤 묶기가 그 자리에서 세대를 올리고 다시 잡은 좌석의 HELD·델타가 새 세대를 싣는다. 모두 내 홀드인 묶기·남의 좌석 TAKEN도 올린다 [ASVS v5.0.0-15.4.2] [S-T26]`, async () => {
    const w = await world();
    const { h, e } = w;
    const holdId = uuidv7(systemClock);
    held(await w.hold(['A01'], { holdId, purchaseSessionId: 'ps-a' }));
    // 내 홀드 A01 + 빈 좌석 A02: A02를 다시 잡는다
    const pubBefore = (await h.published(e)).length;
    const { r, epoch } = await w.bumpsOnce(() => h.store.pin(w.pinOf(['A01', 'A02'], { holdId })));
    expect(r).toMatchObject({ kind: 'OK', gen: 1, regrabbed: 1 });
    expect((await h.stream(e)).at(-1)).toMatchObject({ type: 'HELD', seatIdx: String(idx('A02')), holdId, seatEpoch: String(epoch) });
    const pub = await h.published(e);
    expect(pub).toHaveLength(pubBefore + 1);
    expect(deltaEpoch(pub.at(-1)!.message)).toBe(epoch);

    // 모두 내 홀드(쓰는 것은 pin 칸뿐)
    const mine = await w.bumpsOnce(() => h.store.pin(w.pinOf(['A01', 'A02'], { holdId })));
    expect(mine.r).toEqual({ kind: 'OK', gen: 1, regrabbed: 0 });
    // 남의 좌석(거절)
    const taken = await w.bumpsOnce(() => h.store.pin(w.pinOf(['A01'], { accountId: ACCOUNT_B, holdId: uuidv7(systemClock), purchaseSessionId: 'ps-b' })));
    expect(taken.r).toEqual({ kind: 'TAKEN', seatIndex: idx('A01') });
    expect(taken.epoch).toBeGreaterThan(mine.epoch);
  });

  test(`[${name}] ST26_리뷰 고침 H1_ 승격 뒤 실패 해제가 그 자리에서 세대를 올리고 RELEASED·델타가 새 세대를 싣는다. 푼 좌석이 0인 실패 해제도 올린다 [ASVS v5.0.0-15.4.2] [S-T26]`, async () => {
    const w = await world();
    const { h, e } = w;
    const holdId = uuidv7(systemClock);
    held(await w.hold(['A01', 'A02'], { holdId, purchaseSessionId: 'ps-a' }));
    const pubBefore = (await h.published(e)).length;
    const { r, epoch } = await w.bumpsOnce(() => h.store.releaseFailed(w.releaseOf(['A01', 'A02'], { holdId })));
    expect(r).toEqual({ kind: 'OK', released: 2 });
    const released = (await h.stream(e)).filter((x) => x.type === 'RELEASED');
    expect(released.map((x) => x.seatEpoch)).toEqual([String(epoch), String(epoch)]);
    const pub = await h.published(e);
    expect(pub).toHaveLength(pubBefore + 1);
    expect(deltaEpoch(pub.at(-1)!.message)).toBe(epoch);

    const none = await w.bumpsOnce(() => h.store.releaseFailed(w.releaseOf(['A03'], { holdId: uuidv7(systemClock) })));
    expect(none.r).toEqual({ kind: 'OK', released: 0 });
    expect(none.epoch).toBeGreaterThan(epoch);
  });

  test(`[${name}] ST26_리뷰 고침 H1_ 판매 열기는 세대 키에 chk = 그 초를 함께 쓴다 [S-T26]`, async () => {
    const h = await setup();
    const e = newEvent();
    const sec0 = await h.serverSec();
    const o2 = await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs: h.clock.now() + 2 * DAY });
    const ep = (await h.epoch(e))!;
    expect(ep).toMatchObject({ epoch: o2.seatEpoch, node: h.me() });
    expect(ep.chk).toBeGreaterThanOrEqual(sec0);
    expect(ep.chk).toBe(ep.epoch);
    // 이미 연 회차를 다시 열어도 바꾸지 않는다
    await h.setEpoch(e, { chk: '1' });
    await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs: h.clock.now() + 2 * DAY });
    expect((await h.epoch(e))!.chk).toBe(1);
  });
}
