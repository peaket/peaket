// 회차 판매 상태 받기 사례(docs/features/queue-admission.md §4 '판매 상태와 Kafka 구독의 첫 구현', ADR-0214, Q-T51·Q-T54).
// 메모리 저장소(test/sale-state.test.ts)와 실제 Valkey의 Lua(test-int/sale-state.int.test.ts)에 같은 사례를 돌린다.
import { randomUUID } from 'node:crypto';
import type { Clock, FakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import type { EventSchedule } from '../src/modules/entry/domain/queue.js';
import { ApplySaleChange, type SaleChangedEvent, type SaleStates, SALE_STATE_FALLBACK_TTL_MS } from '../src/modules/sale/index.js';
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
  });
}
