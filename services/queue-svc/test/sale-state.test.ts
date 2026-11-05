// 회차 판매 상태 받기: 메모리 저장소로 사례를 돌리고(test/sale-state-cases.ts), 사건 처리기와 진입 받는 층(HTTP)을 본다
// (docs/features/queue-admission.md §4 '판매 상태와 Kafka 구독의 첫 구현', ADR-0214).
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { type ConsumedMessage, createService, fakeClock, isTransientError } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { type MemoryEntryStore, MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { ENTRY_STORE } from '../src/modules/entry/domain/ports.js';
import { QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';
import { ApplySaleChange, EventSaleChangedHandler, MemorySaleStates, SEATS_TOPIC } from '../src/modules/sale/index.js';
import { saleEvent, saleStateCases } from './sale-state-cases.js';
import { DEVICE, ACCOUNT, newEvent, newRequest, openSchedule, PID, preverifyToken, recordingRisk, tokens } from './support.js';

saleStateCases('메모리', async () => {
  const clock = fakeClock({ now: Date.UTC(2026, 10, 5, 1, 0, 0) });
  const states = new MemorySaleStates();
  const schedules = new MemoryEventSchedules();
  return {
    states,
    schedules,
    clock,
    setSeq: async (e, n) => states.setSeqForTest(e, n),
    notice: async (e) => states.noticeOf(e),
    expireAt: async (e) => states.expireAtOf(e),
    setNoticeFields: async (e, f) => states.setNoticeForTest(e, f),
  };
});

const msg = (value: unknown, key = 'ev-1'): ConsumedMessage => ({
  topic: SEATS_TOPIC,
  partition: 0,
  offset: 1n,
  key,
  value: value === null ? null : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
  headers: {},
  timestamp: 0,
});

describe('EventSaleChanged 처리기', () => {
  const make = () => {
    const states = new MemorySaleStates();
    const clock = fakeClock({ now: Date.UTC(2026, 10, 5, 1, 0, 0) });
    const handler = new EventSaleChangedHandler(new ApplySaleChange(states, new MemoryEventSchedules(), clock));
    return { states, handler };
  };

  test('Q-T51_계약모양의EventSaleChanged는_업무키가회차ID이고_중복제거키가eventKey이며_notice에쓴다', async () => {
    const { states, handler } = make();
    const e = saleEvent('ev-1', { status: 'ALL_HELD', version: 2 });
    const r = handler.decode(msg(e));
    expect(handler.keyOf(r)).toBe('ev-1');
    expect(handler.eventKeyOf(r)).toBe(e.eventKey);
    await handler.handle(r);
    expect(states.noticeOf('ev-1')).toMatchObject({ saleState: 'ALL_HELD', saleVersion: '2' });
  });

  test('같은토픽의좌석사건(SeatEvent)은_건너뛴다(키skip:메시지키)', async () => {
    const { states, handler } = make();
    const r = handler.decode(msg({ type: 'HELD', eventId: 'ev-1', seatId: 's-1', fencingToken: 3 }));
    expect(handler.keyOf(r)).toBe('skip:ev-1');
    expect(handler.eventKeyOf(r)).toBeUndefined();
    await handler.handle(r);
    expect(states.noticeOf('ev-1')).toEqual({});
  });

  test('ST-T19_값이없거나JSON이아니거나계약모양이아니면_던지지않고읽어둔뒤handle이RangeError로던져_회차키와다른bad:키로보류된다(뒤의정상판을막지않게)', async () => {
    const { handler } = make();
    for (const [value, key] of [
      [null, 'bad:ev-1'],
      ['{', 'bad:ev-1'],
      [{ eventId: 'ev-1', status: 'SOLD_OUT', version: 'x', available: 0 }, 'bad:ev-1'],
      // type 칸 없는 새 메시지 종류도 같다
      [{ eventId: 'ev-1', kind: 'TierPriceChanged' }, 'bad:ev-1'],
      [{ eventId: 'ev 1', status: 'SOLD_OUT', version: 1, available: 0, held: 0, paying: 0, soldOutTiers: [], changedAt: new Date().toISOString(), eventKey: crypto.randomUUID() }, 'bad:ev-1'],
    ] as const) {
      const r = handler.decode(msg(value));
      expect(handler.keyOf(r), JSON.stringify(value)).toBe(key);
      await expect(handler.handle(r)).rejects.toBeInstanceOf(RangeError);
    }
  });

  test('대기열Redis일시장애는_일시실패(TransientError)로다시한다', async () => {
    const states = new MemorySaleStates();
    states.failNext = new QueueStoreUnavailable(new Error('잠시 안 됨'));
    const handler = new EventSaleChangedHandler(new ApplySaleChange(states, new MemoryEventSchedules(), fakeClock({ now: 1 })));
    const err = await handler.handle(handler.decode(msg(saleEvent('ev-1')))).catch((e: unknown) => e);
    expect(isTransientError(err)).toBe(true);
  });
});

describe('진입 받는 층의 매진 410', () => {
  let svc: Awaited<ReturnType<typeof createService>>;
  const quiet = new Writable({ write: (_c, _e, cb) => cb() });
  const schedules = new MemoryEventSchedules();
  const NOW = Date.parse('2026-11-05T03:00:00Z');

  beforeAll(async () => {
    svc = await createService({
      name: 'queue-svc',
      module: AppModule.register({ memory: true, schedules, tokens, risk: recordingRisk() }),
      env: { PEAKET_ENV: 'ci' },
      clock: fakeClock({ now: NOW }),
      logDestination: quiet,
    });
  });
  afterAll(async () => {
    await svc?.close();
  });

  test('[ASVS v5.0.0-3.2.1] Q-T51②_매진이면원본진입은_410sold-out문제상세(JSON)이고_캐시하지않으며_번호를내지않는다', async () => {
    const id = newEvent();
    await schedules.set(id, openSchedule(NOW, { openBatch: false }));
    const store = svc.app.get<MemoryEntryStore>(ENTRY_STORE);
    store.setSaleStateForTest(id, 'SOLD_OUT');
    const r = await svc.http.inject({
      method: 'POST',
      url: `/v1/queues/${id}/entries`,
      headers: { 'x-user-id': ACCOUNT, 'x-session-id': 's-1', 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy', 'x-user-pid': PID, 'content-type': 'text/plain;charset=UTF-8' },
      payload: JSON.stringify({ preverifyToken: preverifyToken(svc.clock, id), deviceId: DEVICE, entryRequestId: newRequest() }),
    });
    expect(r.statusCode).toBe(410);
    expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.payload)).toMatchObject({ status: 410, title: '매진되었습니다' });
    expect(JSON.parse(r.payload).type).toMatch(/sold-out$/);
    expect(store.counterOf(id)).toBe(0);
  });
});
