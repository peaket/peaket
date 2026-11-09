// 회차 목록 빼기 정비 일 retire-seat-events(BUILD_ORDER PRF-164, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현' 정비 일,
// '좌석 묶기와 실패 해제의 첫 구현' 회차 목록에서 빼기). 릴레이 프로세스의 리더 하나가 platform MaintenanceRunner로 하루 한 번 돌린다.
// s:ctl:events의 회차마다 좌석맵 판의 판매 종료로 retireEvent(PRF-142)를 부르고 결과를 센다. 조건(판매 종료 + 1시간, Stream·만료 인덱스 0)은 retireEvent가 본다
// (실제 Valkey 시험은 test-int/seat-retire.int.test.ts). 여기서는 회차 목록·판·빼기·로그가 메모리 대역이다.
import { describe, expect, test } from 'vitest';
import {
  type EventSeatConfig,
  RETIRE_SEAT_EVENTS_TASK,
  type RetireResult,
  type RetireSeatEventsReport,
  retireSeatEventsTask,
} from '../src/modules/inventory/index.js';

const SALE_END = Date.parse('2026-11-04T09:00:00.000Z');
const ev = (n: number) => `0190f3a1-7c2e-7a00-8000-0000000000${String(n).padStart(2, '0')}`;
const config = (eventId: string, saleEndsAtMs: number): EventSeatConfig => ({ eventId, layoutVersion: '7', seatCount: 10, perAccountLimit: 2, saleEndsAtMs });
const named = (name: string, message: string) => Object.assign(new Error(message), { name });
const ZERO: RetireSeatEventsReport = { retired: 0, tooEarly: 0, streamPending: 0, expiryPending: 0, notListed: 0, skipped: 0, failed: 0 };

/** 메모리 조립 하나. events는 s:ctl:events(받은 차례), configs는 회차의 판(undefined = 판 없음, Error = 던짐), results는 retireEvent의 답(Error = 던짐) */
function world(o: { events: string[]; configs?: Record<string, EventSeatConfig | undefined | Error>; results?: Record<string, RetireResult | Error> }) {
  const calls = { saleEvents: 0, config: [] as string[], retire: [] as { eventId: string; saleEndMs: number }[] };
  const fail: { saleEvents?: Error } = {};
  const hooks: { onRetire?: (eventId: string) => void } = {};
  const warns: { obj: Record<string, unknown>; msg: string }[] = [];
  const infos: { obj: Record<string, unknown>; msg: string }[] = [];
  const logger = {
    warn: (obj: object, msg: string) => void warns.push({ obj: obj as Record<string, unknown>, msg }),
    info: (obj: object, msg: string) => void infos.push({ obj: obj as Record<string, unknown>, msg }),
  };
  const store = {
    saleEvents: async () => {
      calls.saleEvents += 1;
      if (fail.saleEvents) throw fail.saleEvents;
      return [...o.events];
    },
    retireEvent: async (input: { eventId: string; saleEndMs: number }): Promise<RetireResult> => {
      calls.retire.push({ ...input });
      hooks.onRetire?.(input.eventId);
      const r = o.results?.[input.eventId] ?? 'RETIRED';
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const seatMap = {
    config: async (eventId: string) => {
      calls.config.push(eventId);
      const c = o.configs && eventId in o.configs ? o.configs[eventId] : config(eventId, SALE_END);
      if (c instanceof Error) throw c;
      return c;
    },
  };
  const task = (over: { logger?: { warn(obj: object, msg: string): void; info?(obj: object, msg: string): void } } = {}) =>
    retireSeatEventsTask({ store, seatMap, logger: over.logger ?? logger });
  const logText = () => [...warns, ...infos].map((l) => `${JSON.stringify(l.obj)} ${l.msg}`).join('\n');
  return { calls, fail, hooks, warns, infos, logger, store, seatMap, task, logText };
}

describe('retireSeatEventsTask: 정비 일 모양', () => {
  test('정비 일 이름은 retire-seat-events(RETIRE_SEAT_EVENTS_TASK)이고 하루 한 번(daily)이다', () => {
    expect(RETIRE_SEAT_EVENTS_TASK).toBe('retire-seat-events');
    const t = world({ events: [] }).task();
    expect(t.name).toBe(RETIRE_SEAT_EVENTS_TASK);
    expect(t.when).toBe('daily');
    expect(typeof t.run).toBe('function');
  });

  test('회차가 없으면 아무것도 부르지 않고 건수가 모두 0이다', async () => {
    const w = world({ events: [] });
    await expect(w.task().run()).resolves.toEqual(ZERO);
    expect(w.calls.saleEvents).toBe(1);
    expect(w.calls.retire).toEqual([]);
  });
});

describe('retireSeatEventsTask.run: 회차마다 판매 종료로 retireEvent', () => {
  test('회차마다 받은 차례대로 좌석맵 판의 판매 종료(config.saleEndsAtMs)로 retireEvent({ eventId, saleEndMs })를 부르고 결과별로 센다', async () => {
    const ids = [ev(1), ev(2), ev(3), ev(4), ev(5), ev(6)];
    const ends = ids.map((_, i) => SALE_END + i * 60_000);
    const results: RetireResult[] = ['RETIRED', 'TOO_EARLY', 'STREAM_PENDING', 'EXPIRY_PENDING', 'NOT_LISTED', 'RETIRED'];
    const w = world({
      events: ids,
      configs: Object.fromEntries(ids.map((id, i) => [id, config(id, ends[i]!)])),
      results: Object.fromEntries(ids.map((id, i) => [id, results[i]!])),
    });
    await expect(w.task().run()).resolves.toEqual({ retired: 2, tooEarly: 1, streamPending: 1, expiryPending: 1, notListed: 1, skipped: 0, failed: 0 });
    expect(w.calls.retire).toEqual(ids.map((eventId, i) => ({ eventId, saleEndMs: ends[i] })));
    expect(w.warns).toEqual([]);
  });

  test('좌석맵 판이 없는 회차(config undefined)는 retireEvent를 부르지 않고 skipped로 세며 경고 한 줄(회차 ID)을 남긴다. 다른 회차는 그대로 한다', async () => {
    const w = world({ events: [ev(1), ev(2), ev(3)], configs: { [ev(2)]: undefined } });
    await expect(w.task().run()).resolves.toEqual({ ...ZERO, retired: 2, skipped: 1 });
    expect(w.calls.retire.map((c) => c.eventId)).toEqual([ev(1), ev(3)]);
    expect(w.warns).toHaveLength(1);
    expect(Object.values(w.warns[0]!.obj)).toContain(ev(2));
  });

  test('끝에 info 한 줄(건수)을 남긴다. logger.info가 없으면 남기지 않고 던지지 않는다', async () => {
    const w = world({ events: [ev(1), ev(2)], results: { [ev(2)]: 'TOO_EARLY' } });
    await w.task().run();
    expect(w.infos).toHaveLength(1);
    expect(w.infos[0]!.obj).toMatchObject({ retired: 1, tooEarly: 1 });
    const q = world({ events: [ev(1)] });
    await expect(q.task({ logger: { warn: q.logger.warn } }).run()).resolves.toEqual({ ...ZERO, retired: 1 });
  });
});

describe('retireSeatEventsTask.run: 실패와 멈춤', () => {
  test('회차 하나의 오류(config나 retireEvent가 던짐)는 경고 한 줄(회차 ID·오류 이름만)을 남기고 failed로 센 뒤 나머지 회차를 계속한다. 끝에 failed가 있으면 던진다(정비 실행기가 실패로 세고 다음 깨어남에 다시 한다) [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.2.5]', async () => {
    const w = world({
      events: [ev(1), ev(2), ev(3), ev(4)],
      configs: { [ev(1)]: named('SeatMapFileError', 'parse failed at /maps/SECRET-1') },
      results: { [ev(3)]: named('SeatStoreUnavailable', 'redis://user:SECRET-3@seat') },
    });
    const err = await w
      .task()
      .run()
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    // 글에는 실패 수만 싣는다(회차 ID·원래 오류 글 없음)
    const message = (err as Error).message;
    expect(message).toMatch(/2/);
    for (const s of [ev(1), ev(3), 'SECRET']) expect(message, s).not.toContain(s);
    expect(w.calls.retire.map((c) => c.eventId)).toEqual([ev(2), ev(3), ev(4)]);
    expect(w.warns).toHaveLength(2);
    expect(Object.values(w.warns[0]!.obj)).toEqual(expect.arrayContaining([ev(1), 'SeatMapFileError']));
    expect(Object.values(w.warns[1]!.obj)).toEqual(expect.arrayContaining([ev(3), 'SeatStoreUnavailable']));
    expect(w.logText()).not.toContain('SECRET');
  });

  test('회차 목록(saleEvents)이 던지면 그대로 던진다(retireEvent 없음) [ASVS v5.0.0-16.5.2]', async () => {
    const w = world({ events: [ev(1)] });
    const boom = named('SeatStoreUnavailable', 'down');
    w.fail.saleEvents = boom;
    await expect(w.task().run()).rejects.toBe(boom);
    expect(w.calls.retire).toEqual([]);
  });

  test('멈춤 신호가 끊기면 남은 회차를 보지 않고 그때까지의 보고를 돌려준다. 처음부터 끊겨 있으면 회차를 하나도 보지 않는다', async () => {
    const ac = new AbortController();
    const w = world({ events: [ev(1), ev(2), ev(3)], results: { [ev(1)]: 'TOO_EARLY' } });
    w.hooks.onRetire = (id) => {
      if (id === ev(1)) ac.abort();
    };
    await expect(w.task().run(ac.signal)).resolves.toEqual({ ...ZERO, tooEarly: 1 });
    expect(w.calls.retire.map((c) => c.eventId)).toEqual([ev(1)]);
    expect(w.calls.config).toEqual([ev(1)]);

    const before = new AbortController();
    before.abort();
    const w2 = world({ events: [ev(1), ev(2)] });
    await expect(w2.task().run(before.signal)).resolves.toEqual(ZERO);
    expect(w2.calls.retire).toEqual([]);
  });

  test('멈춤 신호로 일찍 끝난 run도 그때까지 failed가 있으면 던진다 [ASVS v5.0.0-16.5.2]', async () => {
    const ac = new AbortController();
    const w = world({ events: [ev(1), ev(2), ev(3)], results: { [ev(1)]: new Error('down') } });
    w.hooks.onRetire = (id) => {
      if (id === ev(1)) ac.abort();
    };
    await expect(w.task().run(ac.signal)).rejects.toBeInstanceOf(Error);
    expect(w.calls.retire.map((c) => c.eventId)).toEqual([ev(1)]);
  });
});
