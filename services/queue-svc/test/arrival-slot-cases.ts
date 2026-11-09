// 도착 시각 칸(q:{event:E}:arr_slots, docs/features/queue-admission.md §9, §4 HOT-020 절, ADR-0223 결정 6, Q-T16)의 공통 사례. 메모리 저장소와 실제 Valkey가 같은 사례를 돈다.
// Valkey는 서버 시각(TIME)을 쓰므로 시각은 Date.now() 기준이고, 메모리는 주입한 시계다(둘 다 world.now()로 얻는다).
import { describe, expect, test } from 'vitest';
import type { EntryStore, NumberResult } from '../src/modules/entry/domain/ports.js';
import { ARRIVAL_SLOT_MS } from '../src/modules/entry/domain/queue.js';
import { newEvent } from './support.js';

export interface ArrivalWorld {
  store: EntryStore;
  now: () => number;
  counter: (eventId: string) => Promise<number>;
  failover: (eventId: string) => Promise<void>;
  /** 시험 도구: 칸의 쓴 번호 수를 바로 넣는다(큰 수를 요청으로 채우지 않으려고) */
  setUsed: (eventId: string, slot: number, used: number) => Promise<void>;
  /** 칸 떼기 시간 창(ADR-0243)의 앞머리로 간다. 뒤따르는 호출들이 한 창 안에서 끝나게 한다 */
  alignCarveWindow: () => Promise<void>;
  /** 다음 칸 떼기 시간 창으로 넘어간다 */
  nextCarveWindow: () => Promise<void>;
}

const expireFar = () => Date.now() + 3600_000 * 24 * 365 * 20;

export function arrivalSlotCases(label: string, make: () => Promise<ArrivalWorld>): void {
  describe(`도착 시각 칸(${label})`, () => {
    /** 칸 k에 번호를 하나씩 받는다(칸마다 1건의 요청) */
    const numbers = async (w: ArrivalWorld, eventId: string, slots: (number | undefined)[], initial = 10): Promise<NumberResult[]> =>
      w.store.numberBatch({
        eventId,
        expireAtMs: expireFar(),
        arrivalInitial: initial,
        items: slots.map((arrivalSlot) => ({ ...(arrivalSlot === undefined ? {} : { arrivalSlot }) })),
      });
    const seqOf = (r: NumberResult) => (r.kind === 'NUMBERED' ? r.seq : Number.NaN);
    const nowSlot = (w: ArrivalWorld) => Math.floor(w.now() / ARRIVAL_SLOT_MS);

    test('[Q-T16] 뒤칸의요청이먼저와도_앞칸구간이먼저떼여_칸순서가뒤바뀌지않는다', async () => {
      const w = await make();
      const eventId = newEvent();
      const k = nowSlot(w) - 5;
      // 칸 k+2가 먼저 왔다. 그 앞 칸 k, k+1의 구간을 먼저 뗀다(칸마다 크기 10)
      expect(seqOf((await numbers(w, eventId, [k]))[0]!)).toBe(1);
      expect(seqOf((await numbers(w, eventId, [k + 2]))[0]!)).toBe(21);
      expect(seqOf((await numbers(w, eventId, [k + 1]))[0]!)).toBe(11);
      expect(seqOf((await numbers(w, eventId, [k]))[0]!)).toBe(2);
      expect(await w.counter(eventId)).toBe(30);
    });

    test('[Q-T16] 칸안의요청은처리한순서로_구간안의번호를받는다', async () => {
      const w = await make();
      const eventId = newEvent();
      const k = nowSlot(w) - 1;
      const r = await numbers(w, eventId, [k, k, k, undefined]);
      expect(r.map(seqOf)).toEqual([1, 2, 3, 11]);
      expect(r.map((x) => (x.kind === 'NUMBERED' ? x.arrival : undefined))).toEqual(['slot', 'slot', 'slot', undefined]);
    });

    test('[Q-T16] 구간이찬요청은_카운터끝의번호를받는다(넘침)', async () => {
      const w = await make();
      const eventId = newEvent();
      const k = nowSlot(w) - 1;
      const r = await numbers(w, eventId, [k, k, k], 2);
      expect(r.map(seqOf)).toEqual([1, 2, 3]);
      expect(r.map((x) => (x.kind === 'NUMBERED' ? x.arrival : undefined))).toEqual(['slot', 'slot', 'overflow']);
    });

    test('[Q-T16] 칸끝+20초가지난칸·미래칸·칸표시가없는앞칸은_카운터끝의번호를받는다(늦음)', async () => {
      const w = await make();
      const eventId = newEvent();
      const k = nowSlot(w);
      const r = await numbers(w, eventId, [k - 300, k + 200]);
      expect(r.map((x) => (x.kind === 'NUMBERED' ? x.arrival : undefined))).toEqual(['late', 'late']);
      expect(await w.counter(eventId)).toBe(2);
      // 첫 칸 k - 10을 뗀 뒤 그보다 앞 칸의 쿠키는 구간이 없다
      await numbers(w, eventId, [k - 10]);
      const r2 = await numbers(w, eventId, [k - 20]);
      expect(r2[0]).toMatchObject({ kind: 'NUMBERED', arrival: 'late' });
    });

    test('[Q-T16] 처음100칸이지나면_크기가_직전100칸의쓴번호최댓값×1.5로줄고_직전칸이모두비면더떼지않는다', async () => {
      const w = await make();
      const eventId = newEvent();
      // 닫히지 않은 칸의 범위(지금 − 100칸 ~ 지금 + 50칸) 안에 둔다
      const k = nowSlot(w) - 90;
      await numbers(w, eventId, [k, k, k], 10);
      await numbers(w, eventId, [k + 99], 10);
      expect(await w.counter(eventId)).toBe(1000);
      // 칸 k+100의 크기: 직전 100칸(k~k+99)의 쓴 번호 최댓값 3 × 1.5 = 4.5 → 5
      await numbers(w, eventId, [k + 100], 10);
      expect(await w.counter(eventId)).toBe(1005);
      // 칸 k+102: 직전 100칸의 최댓값은 k+2..k+101이라 k+100의 1뿐(× 1.5 = 2). k+101도 2를 뗀다
      await numbers(w, eventId, [k + 102], 10);
      expect(await w.counter(eventId)).toBe(1005 + 2 + 2);
    });

    test('[Q-T16] 직전칸이모두비었으면_빈칸은건너뛰고_그칸을새첫칸으로삼아첫크기로다시뗀다', async () => {
      const w = await make();
      const eventId = newEvent();
      const k = nowSlot(w) - 95;
      await numbers(w, eventId, [k], 1);
      const r = await numbers(w, eventId, [k + 140], 1);
      expect(r[0]).toMatchObject({ kind: 'NUMBERED', arrival: 'slot' });
      // k..k+99는 첫 크기 1씩(100), k+100은 직전 칸 최댓값으로 2를 뗀 뒤, k+101부터 창이 비어 k+140을 새 첫 칸으로 첫 크기 1을 뗀다
      expect(await w.counter(eventId)).toBe(103);
      // 다시 시작한 뒤의 칸도 첫 크기를 쓴다(직전 칸의 최댓값으로 줄지 않는다)
      expect((await numbers(w, eventId, [k + 141], 1))[0]).toMatchObject({ kind: 'NUMBERED', arrival: 'slot' });
      expect(await w.counter(eventId)).toBe(104);
    });

    test('[Q-T16] 한Lua에서떼는양은_RB-05건너뛰기양아래로묶어_남은칸은다음호출이뗀다', async () => {
      const w = await make();
      const eventId = newEvent();
      const k = nowSlot(w) - 5;
      await numbers(w, eventId, [k], 60_000);
      expect(await w.counter(eventId)).toBe(60_000);
      // 칸 k+1(6만)까지만 떼고 k+2는 상한을 넘어 떼지 않는다. 칸 k+3의 쿠키는 구간이 없어 카운터 끝이다
      const r = await numbers(w, eventId, [k + 3], 60_000);
      expect(r[0]).toMatchObject({ kind: 'NUMBERED', arrival: 'late' });
      expect(await w.counter(eventId)).toBe(120_001);
      // 다음 호출이 이어서 뗀다(이 시험은 Lua 한 번의 상한만 본다. 시간 창 상한은 아래 시험이 본다)
      await w.nextCarveWindow();
      await numbers(w, eventId, [k + 3], 60_000);
      expect(await w.counter(eventId)).toBe(180_002);
      // 첫 크기가 상한보다 커도 칸 하나가 상한을 넘지 않는다
      const big = newEvent();
      await numbers(w, big, [k], 500_000);
      expect(await w.counter(big)).toBe(100_000);
    });

    test('[Q-T16] 처음100칸뒤의정상상태에서상한에걸려도_칸을자르지않고_다음호출이온전한크기로뗀다', async () => {
      const w = await make();
      const eventId = newEvent();
      const k = nowSlot(w) - 110;
      await numbers(w, eventId, [k], 1);
      await numbers(w, eventId, [k + 99], 1);
      expect(await w.counter(eventId)).toBe(100);
      // 직전 100칸의 최댓값이 4만이면 원하는 칸 크기는 6만이다
      await w.setUsed(eventId, k + 99, 40_000);
      // k+100은 6만을 떼고, k+101은 남은 4만보다 커 자르지 않고 멈춘다. 쿠키는 구간이 없어 카운터 끝이다
      const r = await numbers(w, eventId, [k + 102], 1);
      expect(r[0]).toMatchObject({ kind: 'NUMBERED', arrival: 'late' });
      expect(await w.counter(eventId)).toBe(100 + 60_000 + 1);
      // 다음 호출이 k+101을 온전한 6만으로 뗀다
      await numbers(w, eventId, [k + 102], 1);
      expect(await w.counter(eventId)).toBe(100 + 60_000 + 1 + 60_000 + 1);
      // 그다음 호출이 k+102를 떼어 쿠키가 칸 번호를 받는다(시간 창 상한에 걸리지 않게 다음 창에서)
      await w.nextCarveWindow();
      const r3 = await numbers(w, eventId, [k + 102], 1);
      expect(r3[0]).toMatchObject({ kind: 'NUMBERED', arrival: 'slot' });
      expect(await w.counter(eventId)).toBe(100 + 60_000 + 1 + 60_000 + 1 + 60_000);
    });

    // Valkey 쪽은 실제 시계라 창 안에서 끝나지 못하면(몰린 러너) 기대가 깨진다. 결함이면 세 번 다 실패한다
    test('[Q-T16] 시간창의몫을넘긴떼기는_멈추고_못뗀칸의쿠키는카운터끝이고_다음창에서이어뗀다(ADR-0243)', { retry: 2 }, async () => {
      const w = await make();
      const eventId = newEvent();
      const k = nowSlot(w) - 5;
      await w.alignCarveWindow();
      // 한 창의 몫은 15만이다. 칸 k가 10만을 쓴다
      expect(seqOf((await numbers(w, eventId, [k], 100_000))[0]!)).toBe(1);
      expect(await w.counter(eventId)).toBe(100_000);
      // 이미 뗀 창에서 남은 몫(5만)보다 큰 칸은 줄여 떼지 않는다. 작은 칸을 만들면 그 칸의 도착자가 곧바로 넘친다. 그 쿠키는 카운터 끝의 번호를 받는다
      const r = await numbers(w, eventId, [k + 1], 100_000);
      expect(r[0]).toMatchObject({ kind: 'NUMBERED', arrival: 'late', seq: 100_001 });
      expect(await w.counter(eventId)).toBe(100_001);
      // 남은 몫에 맞는 칸은 뗀다
      const fit = await numbers(w, eventId, [k + 1], 50_000);
      expect(fit[0]).toMatchObject({ kind: 'NUMBERED', arrival: 'slot', seq: 100_002 });
      expect(await w.counter(eventId)).toBe(150_001);
      // 몫을 다 썼다. 칸 k+2는 떼지 않고 그 쿠키는 카운터 끝의 번호를 받는다(늦음)
      const r2 = await numbers(w, eventId, [k + 2], 100_000);
      expect(r2[0]).toMatchObject({ kind: 'NUMBERED', arrival: 'late', seq: 150_002 });
      expect(await w.counter(eventId)).toBe(150_002);
      // 다음 창에서 이어 뗀다
      await w.nextCarveWindow();
      const r3 = await numbers(w, eventId, [k + 2], 100_000);
      expect(r3[0]).toMatchObject({ kind: 'NUMBERED', arrival: 'slot', seq: 150_003 });
      expect(await w.counter(eventId)).toBe(250_002);
    });

    test('[Q-T16] 장애전환으로세대가바뀌면_옛칸은닫힌칸이고_그칸의쿠키는카운터끝의번호를받는다', async () => {
      const w = await make();
      const eventId = newEvent();
      const k = nowSlot(w) - 1;
      await numbers(w, eventId, [k, k], 10);
      await w.failover(eventId);
      await w.store.rb05({ eventId, expireAtMs: expireFar(), skippedExpireAtMs: expireFar(), skipBase: 100, opensAtMs: 0, lobbyShuffle: false, openBatch: false });
      await w.store.confirmRb05({ eventId });
      const r = await numbers(w, eventId, [k]);
      expect(r[0]).toMatchObject({ kind: 'NUMBERED', arrival: 'late', gen: 2 });
      // 옛 칸만 닫혔다. 그 뒤 칸은 새 세대로 떼어 칸 번호를 받는다
      expect((await numbers(w, eventId, [k + 1]))[0]).toMatchObject({ kind: 'NUMBERED', arrival: 'slot', gen: 2 });
    });

    test('[Q-T16] 쿠키가없는요청만있으면_칸을떼지않고_일반번호를낸다', async () => {
      const w = await make();
      const eventId = newEvent();
      const r = await numbers(w, eventId, [undefined, undefined]);
      expect(r.map(seqOf)).toEqual([1, 2]);
      expect(r.every((x) => x.kind === 'NUMBERED' && x.arrival === undefined)).toBe(true);
    });

    test('[Q-T29] 쿠키요청ID는_같은진입요청이면다시받고_다른진입요청이면거절한다', async () => {
      const w = await make();
      const eventId = newEvent();
      expect(await w.store.claimArrival({ eventId, reqId: 'r1', requestId: 'a', ttlMs: 60_000 })).toBe(true);
      expect(await w.store.claimArrival({ eventId, reqId: 'r1', requestId: 'a', ttlMs: 60_000 })).toBe(true);
      expect(await w.store.claimArrival({ eventId, reqId: 'r1', requestId: 'b', ttlMs: 60_000 })).toBe(false);
      expect(await w.store.claimArrival({ eventId, reqId: 'r2', requestId: 'b', ttlMs: 60_000 })).toBe(true);
    });
  });
}
