// 탈퇴 계정의 사람 키 만료 당기기(docs/features/queue-admission.md §3 '탈퇴 계정의 사람 키', BUILD_ORDER BOT-037, I-T27).
// identity의 탈퇴 사건(asyncapi identity.accounts-withdrawn `AccountWithdrawn`)을 읽는 처리기와 만료를 거는 일을 가짜 포트로 본다. 실제 Valkey는 test-int/withdrawn-keys.int.test.ts.
import { randomUUID } from 'node:crypto';
import { type ConsumedMessage, fakeClock, isTransientError } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { PURGE_EVENTS_PER_CALL, PurgeWithdrawnKeys } from '../src/modules/entry/application/purge-withdrawn-keys.js';
import type { WithdrawnKeys } from '../src/modules/entry/domain/ports.js';
import { QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';
import { MemoryWithdrawnDue } from '../src/modules/entry/adapters/memory-withdrawn-due.js';
import { WithdrawnDueWorker } from '../src/modules/entry/application/withdrawn-due-worker.js';
import { AccountWithdrawnHandler, jsonAccountWithdrawnCodec, WITHDRAWN_DELAY_MS } from '../src/modules/entry/inbound/account-withdrawn.handler.js';
import { withdrawnDueCases } from './withdrawn-due-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const DAY = 86_400_000;
const PID = Buffer.alloc(32, 7).toString('base64url');
const PID_PREV = Buffer.alloc(32, 8).toString('base64url');
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000037';

const msg = (value: unknown): ConsumedMessage => ({
  topic: 'identity.accounts-withdrawn',
  partition: 0,
  offset: 1n,
  key: ACCOUNT,
  value: value === null ? null : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'),
  headers: {},
  timestamp: NOW,
});

const withdrawn = (over: Record<string, unknown> = {}) => ({
  eventKey: randomUUID(),
  accountId: ACCOUNT,
  pids: [PID],
  withdrawnAt: new Date(NOW).toISOString(),
  purgeBy: new Date(NOW + 5 * DAY).toISOString(),
  ...over,
});

/** 진행 중인 회차 목록과 거는 만료를 기록하는 가짜 포트 */
function fakeKeys(events: string[], o: { fail?: boolean } = {}) {
  const calls: { pid: string; events: string[]; at: number }[] = [];
  const port: WithdrawnKeys = {
    activeEvents: async (now) => {
      if (o.fail) throw new QueueStoreUnavailable(new Error('주입한 장애'));
      expect(now).toBe(NOW);
      return events;
    },
    expireBy: async (pid, eventIds, at) => {
      calls.push({ pid, events: [...eventIds], at });
      return eventIds.length * 2;
    },
  };
  return { port, calls };
}

function setup(events: string[], o: { fail?: boolean } = {}) {
  const k = fakeKeys(events, o);
  const purge = new PurgeWithdrawnKeys(k.port, fakeClock({ now: NOW }));
  return { ...k, purge, handler: new AccountWithdrawnHandler(purge, jsonAccountWithdrawnCodec) };
}

describe('탈퇴 사건 처리기(BOT-037)', () => {
  test('I-T27_탈퇴사건을받으면_진행중인회차마다그pid의q:dup·q:adm만료를purgeBy로당기고_전환기간의옛pid도같다', async () => {
    const t = setup(['ev-1', 'ev-2']);
    const e = t.handler.decode(msg(withdrawn({ pids: [PID, PID_PREV] })));
    expect(t.handler.keyOf(e)).toBe(ACCOUNT);
    expect(t.handler.eventKeyOf(e)).toBe(e.eventKey);
    await t.handler.handle(e);
    expect(t.calls).toEqual([
      { pid: PID, events: ['ev-1', 'ev-2'], at: NOW + 5 * DAY },
      { pid: PID_PREV, events: ['ev-1', 'ev-2'], at: NOW + 5 * DAY },
    ]);
  });

  test('I-T27_진행중인회차가많으면_한번에200개씩나눠건다(한pid의키는한슬롯이라Lua하나)', async () => {
    const events = Array.from({ length: PURGE_EVENTS_PER_CALL * 2 + 5 }, (_, i) => `ev-${i}`);
    const t = setup(events);
    expect(await t.purge.run({ pids: [PID], purgeBy: NOW + DAY })).toEqual({ events: events.length, keys: events.length * 2 });
    expect(t.calls.map((c) => c.events.length)).toEqual([PURGE_EVENTS_PER_CALL, PURGE_EVENTS_PER_CALL, 5]);
    expect(t.calls.flatMap((c) => c.events)).toEqual(events);
  });

  test('I-T27_진행중인회차가없으면_아무것도걸지않는다', async () => {
    const t = setup([]);
    expect(await t.purge.run({ pids: [PID], purgeBy: NOW + DAY })).toEqual({ events: 0, keys: 0 });
    expect(t.calls).toEqual([]);
  });

  test('I-T27_때가안된탈퇴사건은_처리할때집합에넣고바로돌려준다(파티션을막지않는다)_그뒤작업이때가되면처리한다(ADR-0214결정7)', async () => {
    const k = fakeKeys(['ev-1']);
    const clock = fakeClock({ now: NOW + 60_000 });
    const due = new MemoryWithdrawnDue(clock);
    const purge = new PurgeWithdrawnKeys(k.port, fakeClock({ now: NOW }));
    const handler = new AccountWithdrawnHandler(purge, jsonAccountWithdrawnCodec, { clock, due });
    const e = handler.decode(msg(withdrawn()));
    await handler.handle(e);
    expect(k.calls).toEqual([]);
    expect(due.itemsForTest()).toEqual([{ eventKey: e.eventKey, pids: [PID], purgeBy: NOW + 5 * DAY, dueAt: NOW + WITHDRAWN_DELAY_MS }]);
    const worker = new WithdrawnDueWorker(due, purge, clock);
    await worker.tick();
    expect(k.calls).toEqual([]);
    clock.advance(NOW + WITHDRAWN_DELAY_MS - clock.now());
    await worker.tick();
    expect(k.calls).toEqual([{ pid: PID, events: ['ev-1'], at: NOW + 5 * DAY }]);
    expect(due.itemsForTest()).toEqual([]);
    expect(WITHDRAWN_DELAY_MS).toBe(15 * 60_000);
  });

  test('I-T27_때가지난사건과_purgeBy가때보다이른사건은_받자마자처리한다', async () => {
    const k = fakeKeys(['ev-1']);
    const due = new MemoryWithdrawnDue(fakeClock({ now: NOW }));
    const handler = new AccountWithdrawnHandler(new PurgeWithdrawnKeys(k.port, fakeClock({ now: NOW })), jsonAccountWithdrawnCodec, { clock: fakeClock({ now: NOW }), due });
    await handler.handle(handler.decode(msg(withdrawn({ withdrawnAt: new Date(NOW - WITHDRAWN_DELAY_MS).toISOString(), purgeBy: new Date(NOW + 4 * DAY).toISOString() }))));
    await handler.handle(handler.decode(msg(withdrawn({ purgeBy: new Date(NOW + 60_000).toISOString() }))));
    expect(k.calls.map((c) => c.at)).toEqual([NOW + 4 * DAY, NOW + 60_000]);
    expect(due.itemsForTest()).toEqual([]);
  });

  test('I-T27_withdrawnAt이미래면_파티션을막지않고처리할때를지금+15분으로당기며_경고를남긴다(값은싣지않는다)', async () => {
    const k = fakeKeys(['ev-1']);
    const clock = fakeClock({ now: NOW });
    const due = new MemoryWithdrawnDue(clock);
    const warned: object[] = [];
    const handler = new AccountWithdrawnHandler(new PurgeWithdrawnKeys(k.port, clock), jsonAccountWithdrawnCodec, { clock, due, logger: { warn: (o) => void warned.push(o) } });
    const e = handler.decode(msg(withdrawn({ withdrawnAt: new Date(NOW + DAY).toISOString(), purgeBy: new Date(NOW + 2 * DAY).toISOString() })));
    await handler.handle(e);
    expect(due.itemsForTest()[0]!.dueAt).toBe(NOW + WITHDRAWN_DELAY_MS);
    expect(warned).toEqual([{ eventKey: e.eventKey, aheadMs: DAY }]);
    // 시계 허용 차이(1분 [가정]) 안이면 당기지 않는다
    const e2 = handler.decode(msg(withdrawn({ withdrawnAt: new Date(NOW + 30_000).toISOString() })));
    await handler.handle(e2);
    expect(due.itemsForTest().find((x) => x.eventKey === e2.eventKey)!.dueAt).toBe(NOW + 30_000 + WITHDRAWN_DELAY_MS);
  });

  test('I-T27_withdrawnAt이아주먼미래라purgeBy가그+5일이어도_기다리는값과만료당기기의기한은지금+5일을넘지않는다', async () => {
    const k = fakeKeys(['ev-1']);
    const clock = fakeClock({ now: NOW });
    const due = new MemoryWithdrawnDue(clock);
    const handler = new AccountWithdrawnHandler(new PurgeWithdrawnKeys(k.port, clock), jsonAccountWithdrawnCodec, { clock, due });
    await handler.handle(handler.decode(msg(withdrawn({ withdrawnAt: new Date(NOW + 400 * DAY).toISOString(), purgeBy: new Date(NOW + 405 * DAY).toISOString() }))));
    expect(due.itemsForTest()[0]).toMatchObject({ dueAt: NOW + WITHDRAWN_DELAY_MS, purgeBy: NOW + 5 * DAY });
  });

  test('I-T27_꺼낸값의purgeBy가이미지났어도_버리지않고만료를당긴다(키를바로지운다)', async () => {
    const k = fakeKeys(['ev-1']);
    const clock = fakeClock({ now: NOW });
    const due = new MemoryWithdrawnDue(clock);
    await due.schedule({ eventKey: randomUUID(), pids: [PID], purgeBy: NOW + 1_000, dueAt: NOW });
    clock.advance(2_000);
    await new WithdrawnDueWorker(due, new PurgeWithdrawnKeys(k.port, fakeClock({ now: NOW })), clock).tick();
    expect(k.calls).toEqual([{ pid: PID, events: ['ev-1'], at: NOW + 1_000 }]);
    expect(due.itemsForTest()).toEqual([]);
  });

  test('I-T27_꺼내기가실패하면실패지표를올리고_값이사라져버린항목도지표로센다', async () => {
    const k = fakeKeys(['ev-1']);
    const clock = fakeClock({ now: NOW });
    const due = new MemoryWithdrawnDue(clock);
    const seen: string[] = [];
    const signals = { lag: (s: number) => void seen.push(`lag:${s}`), failed: (stage: string) => void seen.push(`failed:${stage}`), expired: (n: number) => void seen.push(`expired:${n}`) };
    const worker = new WithdrawnDueWorker(due, new PurgeWithdrawnKeys(k.port, fakeClock({ now: NOW })), clock, { signals });
    due.failClaimNext = new QueueStoreUnavailable(new Error('잠시 안 됨'));
    await worker.tick();
    expect(seen).toEqual(['failed:claim']);
    const e = randomUUID();
    await due.schedule({ eventKey: e, pids: [PID], purgeBy: NOW + DAY, dueAt: NOW });
    due.dropValueForTest(e);
    seen.length = 0;
    await worker.tick();
    expect(seen).toEqual(['expired:1', 'lag:0']);
  });

  test('I-T27_미루기를0으로두면(종료세션목록이붙은뒤)_받자마자처리한다', async () => {
    const k = fakeKeys(['ev-1']);
    const handler = new AccountWithdrawnHandler(new PurgeWithdrawnKeys(k.port, fakeClock({ now: NOW })), jsonAccountWithdrawnCodec, { clock: fakeClock({ now: NOW }), delayMs: 0 });
    await handler.handle(handler.decode(msg(withdrawn())));
    expect(k.calls).toHaveLength(1);
  });

  test('대기열Redis일시장애는_TransientError로바꿔다시하게한다', async () => {
    const t = setup(['ev-1'], { fail: true });
    const err = await t.handler.handle(t.handler.decode(msg(withdrawn()))).catch((x: unknown) => x);
    expect(isTransientError(err)).toBe(true);
  });

  test('만료걸기는처리기밖에서불러도_키조각모양이아닌pid를키로만들지않는다', async () => {
    const t = setup(['ev-1']);
    await expect(t.purge.run({ pids: ['a}b'], purgeBy: NOW })).rejects.toThrow(/키 조각/);
    await expect(t.purge.run({ pids: [PID], purgeBy: Number.NaN })).rejects.toThrow(/purgeBy/);
    expect(t.calls).toEqual([]);
  });

  test('값이없거나·JSON이아니거나·계약모양이아니거나·pid가0개·3개·키조각모양이아니면_읽지못한값으로보류한다', () => {
    const t = setup([]);
    for (const bad of [
      null,
      'not-json',
      [],
      withdrawn({ eventKey: 'not-uuid' }),
      withdrawn({ purgeBy: 'tomorrow' }),
      withdrawn({ pids: [] }),
      withdrawn({ pids: [PID, PID_PREV, PID] }),
      withdrawn({ pids: ['bad}pid'] }),
      withdrawn({ pids: ['x'.repeat(65)] }),
      withdrawn({ pids: [PID, PID] }),
      // 기한이 탈퇴 + 5일보다 늦거나 탈퇴 전이면 보류한다(보내는 쪽 버그가 5일 규칙을 조용히 깨지 않게)
      withdrawn({ purgeBy: new Date(NOW + 5 * DAY + 1).toISOString() }),
      withdrawn({ purgeBy: new Date(NOW - 1).toISOString() }),
      withdrawn({ accountId: 'acc-1' }),
    ]) {
      expect(() => t.handler.decode(msg(bad)), JSON.stringify(bad)).toThrow();
    }
  });
});

withdrawnDueCases('메모리', async () => {
  const clock = fakeClock({ now: NOW });
  const due = new MemoryWithdrawnDue(clock);
  return { due, clock, dropValue: async (k) => due.dropValueForTest(k) };
});
