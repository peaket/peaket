// 회차 판매 상태 받기 사례(docs/features/queue-admission.md §4 '판매 상태와 Kafka 구독의 첫 구현', ADR-0214, Q-T51·Q-T54).
// 메모리 저장소(test/sale-state.test.ts)와 실제 Valkey의 Lua(test-int/sale-state.int.test.ts)에 같은 사례를 돌린다.
import { randomUUID } from 'node:crypto';
import type { Clock, FakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import type { EventSchedule } from '../src/modules/entry/domain/queue.js';
import { ApplySaleChange, MemoryEdgeSaleFlags, type SaleChangedEvent, type SaleStates, SALE_STATE_FALLBACK_TTL_MS } from '../src/modules/sale/index.js';
import { newEvent, openSchedule } from './support.js';

export interface SaleWorld {
  states: SaleStates;
  schedules: { get(eventId: string): Promise<EventSchedule | null>; set(eventId: string, s: EventSchedule): Promise<void> };
  clock: Clock;
  /** 지금까지 낸 번호의 끝(q:{event:E}:seq)을 둔다 */
  setSeq(eventId: string, seq: number): Promise<void>;
  /** q:{event:E}:notice의 칸 */
  notice(eventId: string): Promise<Record<string, string>>;
  /** notice의 만료 시각(없으면 null) */
  expireAt(eventId: string): Promise<number | null>;
  /** 제어 받는 쪽이 쓰는 칸을 미리 넣는다 */
  setNoticeFields(eventId: string, fields: Record<string, string>): Promise<void>;
}

export function saleEvent(eventId: string, o: Partial<SaleChangedEvent> = {}): SaleChangedEvent {
  return {
    eventId,
    status: 'ON_SALE',
    available: 10,
    held: 0,
    paying: 0,
    soldOutTiers: [],
    version: 1,
    changedAt: new Date().toISOString(),
    eventKey: randomUUID(),
    ...o,
  };
}

export function saleStateCases(label: string, make: () => Promise<SaleWorld>) {
  describe(`판매 상태 받기(${label})`, () => {
    const setup = async (withSchedule = true) => {
      const w = await make();
      const eventId = newEvent();
      if (withSchedule) await w.schedules.set(eventId, openSchedule(w.clock.now()));
      const apply = new ApplySaleChange(w.states, w.schedules, w.clock);
      return { w, eventId, apply };
    };

    test('[ASVS v5.0.0-15.4.2] Q-T51_판번호가지금보다클때만쓰고_같거나작은판(늦게온옛판·다시받은사건)은그대로둔다', async () => {
      const { w, eventId, apply } = await setup();
      expect(await apply.run(saleEvent(eventId, { status: 'ALL_HELD', version: 3 }))).toMatchObject({ kind: 'APPLIED' });
      expect(await apply.run(saleEvent(eventId, { status: 'ON_SALE', version: 2 }))).toEqual({ kind: 'STALE' });
      expect(await apply.run(saleEvent(eventId, { status: 'SOLD_OUT', version: 3 }))).toEqual({ kind: 'STALE' });
      expect(await w.notice(eventId)).toMatchObject({ saleState: 'ALL_HELD', saleVersion: '3' });
    });

    test('[ASVS v5.0.0-15.4.2] Q-T51②③_매진판은그때의seq를soldOutLastSeq로두고_풀려도지우지않으며_다시매진되면그때의끝번호로바꾼다', async () => {
      const { w, eventId, apply } = await setup();
      await w.setSeq(eventId, 120);
      expect(await apply.run(saleEvent(eventId, { status: 'SOLD_OUT', version: 1, available: 0 }))).toEqual({ kind: 'APPLIED', soldOutLastSeq: 120 });
      await w.setSeq(eventId, 150);
      await apply.run(saleEvent(eventId, { status: 'ON_SALE', previousStatus: 'SOLD_OUT', version: 2 }));
      expect(await w.notice(eventId)).toMatchObject({ saleState: 'ON_SALE', saleVersion: '2', soldOutLastSeq: '120' });
      await w.setSeq(eventId, 190);
      await apply.run(saleEvent(eventId, { status: 'SOLD_OUT', version: 3 }));
      expect((await w.notice(eventId)).soldOutLastSeq).toBe('190');
      // 매진 판이 아닌 판은 seq를 읽지 않는다(판매 종료 뒤에도 그대로)
      await w.setSeq(eventId, 200);
      await apply.run(saleEvent(eventId, { status: 'ENDED', version: 4 }));
      expect(await w.notice(eventId)).toMatchObject({ saleState: 'ENDED', soldOutLastSeq: '190' });
    });

    test('Q-T51_번호가하나도나가지않은회차가매진되면_soldOutLastSeq는0이다', async () => {
      const { w, eventId, apply } = await setup();
      await apply.run(saleEvent(eventId, { status: 'SOLD_OUT', version: 1 }));
      expect((await w.notice(eventId)).soldOutLastSeq).toBe('0');
    });

    test('UPCOMING은_대기열에서ON_SALE과같아_ON_SALE로쓴다', async () => {
      const { w, eventId, apply } = await setup();
      await apply.run(saleEvent(eventId, { status: 'UPCOMING', version: 1 }));
      expect((await w.notice(eventId)).saleState).toBe('ON_SALE');
    });

    test('Q-T54③_매진등급은판마다통째로바꾸고_비면빈배열이다', async () => {
      const { w, eventId, apply } = await setup();
      await apply.run(saleEvent(eventId, { soldOutTiers: ['R', 'S'], version: 1 }));
      expect(JSON.parse((await w.notice(eventId)).soldOutTiers!)).toEqual(['R', 'S']);
      await apply.run(saleEvent(eventId, { soldOutTiers: ['S'], version: 2 }));
      expect(JSON.parse((await w.notice(eventId)).soldOutTiers!)).toEqual(['S']);
      await apply.run(saleEvent(eventId, { soldOutTiers: [], version: 3 }));
      expect(JSON.parse((await w.notice(eventId)).soldOutTiers!)).toEqual([]);
    });

    test('제어받는쪽의칸(paused·suspended·banner·version·commandId)은건드리지않는다', async () => {
      const { w, eventId, apply } = await setup();
      const control = { paused: '1', suspended: '1', banner: '안내', version: '7', commandId: 'cmd-1' };
      await w.setNoticeFields(eventId, control);
      await apply.run(saleEvent(eventId, { status: 'SOLD_OUT', version: 1 }));
      await apply.run(saleEvent(eventId, { status: 'ON_SALE', version: 2 }));
      expect(await w.notice(eventId)).toEqual({ ...control, saleState: 'ON_SALE', saleVersion: '2', soldOutTiers: '[]', soldOutLastSeq: '0' });
    });

    test('일정사본이없으면_같은판을다시받아도수명을늘리지않는다(지금+2일이끝없이밀리지않게,HOT-010리뷰)', async () => {
      const { w, eventId, apply } = await setup(false);
      await apply.run(saleEvent(eventId, { version: 1 }));
      const first = (await w.expireAt(eventId))!;
      await new Promise((r) => setTimeout(r, 30));
      (w.clock as Partial<FakeClock>).advance?.(60_000);
      expect(await apply.run(saleEvent(eventId, { version: 1 }))).toEqual({ kind: 'STALE' });
      expect(await w.expireAt(eventId)).toBe(first);
    });

    test('같은판을다시받으면STALE이지만_수명은그때의일정사본(연기된판매종료)+1일로늘린다', async () => {
      const { w, eventId, apply } = await setup();
      const s = (await w.schedules.get(eventId))!;
      await apply.run(saleEvent(eventId, { version: 3 }));
      const later = { ...s, startsAtMs: s.startsAtMs + 2 * 86_400_000 };
      await w.schedules.set(eventId, later);
      // 일정 사본 읽기는 파드 안에 1초 둔다(Valkey 어댑터). 지나기를 기다린다
      await new Promise((r) => setTimeout(r, 1_100));
      expect(await apply.run(saleEvent(eventId, { version: 3 }))).toEqual({ kind: 'STALE' });
      expect(Math.abs((await w.expireAt(eventId))! - later.startsAtMs)).toBeLessThan(2);
    });

    test('수명은판매종료+1일이고늘리기만하며_일정사본이없으면지금+2일[가정]이다', async () => {
      const { w, eventId, apply } = await setup();
      const s = (await w.schedules.get(eventId))!;
      await apply.run(saleEvent(eventId, { version: 1 }));
      const keepUntil = s.startsAtMs; // 판매 종료(starts − 24시간) + 1일
      expect(Math.abs((await w.expireAt(eventId))! - keepUntil)).toBeLessThan(2);

      const none = await setup(false);
      const before = none.w.clock.now();
      await none.apply.run(saleEvent(none.eventId, { version: 1 }));
      const at = (await none.w.expireAt(none.eventId))!;
      expect(at).toBeGreaterThanOrEqual(before + SALE_STATE_FALLBACK_TTL_MS - 5);
      expect(at).toBeLessThanOrEqual(none.w.clock.now() + SALE_STATE_FALLBACK_TTL_MS + 5);
    });

    // 남은 좌석 수 칸(HOT-011, ADR-0219 결정 5·6). 셈 시각은 시험 시작 시각에서 조금 앞으로 둔다(시계 허용 1분 안. 실제 Valkey 쪽은 시스템 시계라 시작 시각을 고정해 쓴다)
    const iso = (ms: number) => new Date(ms).toISOString();

    test('[ASVS v5.0.0-15.4.2] Q-T64①_셈은판번호가지금판이상이고셈시각이더늦을때만쓰고_같은판의다시내기(STALE)도더늦은셈이면고친다', async () => {
      const { w, eventId, apply } = await setup();
      const t0 = w.clock.now();
      const at = (d: number) => iso(t0 + d);
      expect(await apply.run(saleEvent(eventId, { version: 2, available: 50, countedAt: at(0), avgTicketsPerOrder: 1.75 }))).toEqual({ kind: 'APPLIED' });
      expect(await w.notice(eventId)).toMatchObject({ remainingSeats: '50', seatsAtMs: String(t0), avgTicketsPerOrder: '1.75' });
      // 같은 판의 다시 내기: 판은 그대로 STALE이지만 더 늦은 셈으로 고친다(평균이 없으면 칸을 지운다)
      expect(await apply.run(saleEvent(eventId, { version: 2, available: 40, countedAt: at(2_000) }))).toEqual({ kind: 'STALE' });
      const n = await w.notice(eventId);
      expect(n).toMatchObject({ remainingSeats: '40', seatsAtMs: String(t0 + 2_000), saleVersion: '2' });
      expect(n.avgTicketsPerOrder).toBeUndefined();
      // 같은 판의 더 이른 셈(늦게 온 다시 내기)은 쓰지 않는다
      await apply.run(saleEvent(eventId, { version: 2, available: 45, countedAt: at(1_000) }));
      expect((await w.notice(eventId)).remainingSeats).toBe('40');
      // 옛 판의 셈은 시각이 늦어도 쓰지 않는다
      await apply.run(saleEvent(eventId, { version: 1, available: 99, countedAt: at(4_000) }));
      expect((await w.notice(eventId)).remainingSeats).toBe('40');
      // 새 판은 판매 상태와 셈을 함께 쓴다
      await apply.run(saleEvent(eventId, { status: 'ALL_HELD', version: 3, available: 0, countedAt: at(3_000), avgTicketsPerOrder: 2.5 }));
      expect(await w.notice(eventId)).toMatchObject({ saleState: 'ALL_HELD', remainingSeats: '0', seatsAtMs: String(t0 + 3_000), avgTicketsPerOrder: '2.5' });
    });

    test('Q-T64①_셈시각이없거나_지금보다5초[가정]넘게앞서면셈을쓰지않고_평균이1~10밖이면평균칸만지운다', async () => {
      const { w, eventId, apply } = await setup();
      const t0 = w.clock.now();
      const at = (d: number) => iso(t0 + d);
      await apply.run(saleEvent(eventId, { version: 1, available: 50 }));
      expect((await w.notice(eventId)).remainingSeats).toBeUndefined();
      await apply.run(saleEvent(eventId, { version: 2, available: 50, countedAt: at(6_000) }));
      expect((await w.notice(eventId)).remainingSeats).toBeUndefined();
      await apply.run(saleEvent(eventId, { version: 3, available: 30, countedAt: at(0), avgTicketsPerOrder: 11 }));
      const n = await w.notice(eventId);
      expect(n.remainingSeats).toBe('30');
      expect(n.avgTicketsPerOrder).toBeUndefined();
      await apply.run(saleEvent(eventId, { version: 4, available: 20, countedAt: at(1_000), avgTicketsPerOrder: 0.5 }));
      expect((await w.notice(eventId)).avgTicketsPerOrder).toBeUndefined();
    });

    test('Q-T63④_엣지다시맞추기가읽는notice의지금판매상태와판번호는_쓴판이고_notice가없으면null이다', async () => {
      const { w, eventId, apply } = await setup();
      expect(await w.states.current(eventId)).toBeNull();
      await apply.run(saleEvent(eventId, { status: 'SOLD_OUT', version: 4 }));
      await apply.run(saleEvent(eventId, { status: 'ON_SALE', version: 3 }));
      expect(await w.states.current(eventId)).toEqual({ state: 'SOLD_OUT', version: 4 });
    });

    test('Q-T63③_판이같거나작아쓰지않을때(STALE)도_notice의지금판매상태와판번호를돌려줘_엣지를그판으로되돌린다', async () => {
      const w = await make();
      const eventId = newEvent();
      await w.schedules.set(eventId, openSchedule(w.clock.now()));
      const edge = new MemoryEdgeSaleFlags();
      const apply = new ApplySaleChange(w.states, w.schedules, w.clock, { edge });
      await apply.run(saleEvent(eventId, { status: 'ON_SALE', previousStatus: 'SOLD_OUT', version: 5 }));
      expect(edge.flagOf(eventId)).toMatchObject({ soldOut: false, version: 5 });
      // 늦게 온 옛 매진 판: 엣지를 먼저 켜려 하지만 저장된 판(5)보다 작아 바뀌지 않고, notice의 지금 판(ON_SALE 5)으로 남는다
      expect(await apply.run(saleEvent(eventId, { status: 'SOLD_OUT', version: 4 }))).toEqual({ kind: 'STALE' });
      expect(edge.flagOf(eventId)).toMatchObject({ soldOut: false, version: 5 });
      // 엣지 저장소를 잃은 뒤(새 저장소) 옛 매진 판을 다시 받아도 notice의 지금 판으로 되돌린다
      const fresh = new MemoryEdgeSaleFlags();
      const again = new ApplySaleChange(w.states, w.schedules, w.clock, { edge: fresh });
      await again.run(saleEvent(eventId, { status: 'SOLD_OUT', version: 4 }));
      expect(fresh.flagOf(eventId)).toMatchObject({ soldOut: false, version: 5 });
      expect(fresh.writes.map((x) => JSON.parse(x.value).soldOut)).toEqual([true, false]);
    });
  });
}
