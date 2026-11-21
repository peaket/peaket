// 탈퇴 계정의 사람 키 만료 당기기(docs/features/queue-admission.md §3 '탈퇴 계정의 사람 키', BUILD_ORDER BOT-037, I-T27).
// identity의 탈퇴 사건(asyncapi identity.accounts-withdrawn `AccountWithdrawn`)을 읽는 처리기와 만료를 거는 일을 가짜 포트로 본다. 실제 Valkey는 test-int/withdrawn-keys.int.test.ts.
// 탈퇴 전 토큰은 종료 세션 목록이 막으므로 처리기는 withdrawnAt과 상관없이 받자마자 만료를 당긴다(I-T3 ④, ADR-0333 결정 5, BUILD_ORDER HOT-401 묶음 BAT-059).
import { randomUUID } from 'node:crypto';
import { type ConsumedMessage, fakeClock, isTransientError } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { PURGE_EVENTS_PER_CALL, PurgeWithdrawnKeys } from '../src/modules/entry/application/purge-withdrawn-keys.js';
import type { WithdrawnKeys } from '../src/modules/entry/domain/ports.js';
import { QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';
import { AccountWithdrawnHandler, jsonAccountWithdrawnCodec } from '../src/modules/entry/inbound/account-withdrawn.handler.js';

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

  test('I-T3 ④-1 탈퇴 사건은 withdrawnAt이 지금·1분 전·2분 뒤 어느 것이든 미루지 않고 받자마자 두 키 만료를 purgeBy(지금 + 5일을 넘지 않게 자른 값)로 당긴다', async () => {
    const k = fakeKeys(['ev-1']);
    const clock = fakeClock({ now: NOW });
    const handler = new AccountWithdrawnHandler(new PurgeWithdrawnKeys(k.port, clock), jsonAccountWithdrawnCodec, { clock });
    const MIN = 60_000;
    // purgeBy는 탈퇴 ~ 탈퇴 + 5일 안이어야 받는다(보류 규칙). 2분 뒤 탈퇴의 탈퇴 + 5일은 지금 + 5일을 2분 넘으므로 지금 + 5일로 자른다
    await handler.handle(handler.decode(msg(withdrawn({ withdrawnAt: new Date(NOW).toISOString(), purgeBy: new Date(NOW + 3 * DAY).toISOString() }))));
    await handler.handle(handler.decode(msg(withdrawn({ withdrawnAt: new Date(NOW - MIN).toISOString(), purgeBy: new Date(NOW - MIN + 5 * DAY).toISOString() }))));
    await handler.handle(handler.decode(msg(withdrawn({ withdrawnAt: new Date(NOW + 2 * MIN).toISOString(), purgeBy: new Date(NOW + 2 * MIN + 5 * DAY).toISOString() }))));
    expect(k.calls).toEqual([
      { pid: PID, events: ['ev-1'], at: NOW + 3 * DAY },
      { pid: PID, events: ['ev-1'], at: NOW - MIN + 5 * DAY },
      { pid: PID, events: ['ev-1'], at: NOW + 5 * DAY },
    ]);
  });

  test('I-T3 ④-2 withdrawnAt이 아주 먼 미래라 purgeBy가 그 + 5일이어도 받자마자 걸고 기한은 지금 + 5일을 넘지 않는다', async () => {
    const k = fakeKeys(['ev-1']);
    const clock = fakeClock({ now: NOW });
    const handler = new AccountWithdrawnHandler(new PurgeWithdrawnKeys(k.port, clock), jsonAccountWithdrawnCodec, { clock });
    await handler.handle(handler.decode(msg(withdrawn({ withdrawnAt: new Date(NOW + 400 * DAY).toISOString(), purgeBy: new Date(NOW + 405 * DAY).toISOString() }))));
    expect(k.calls).toEqual([{ pid: PID, events: ['ev-1'], at: NOW + 5 * DAY }]);
  });

  test('I-T3 ④-3 같은 탈퇴 사건을 두 번 받아도 두 번 모두 같은 기한으로 건다(다시 해도 결과가 같다)', async () => {
    const k = fakeKeys(['ev-1', 'ev-2']);
    const clock = fakeClock({ now: NOW });
    const handler = new AccountWithdrawnHandler(new PurgeWithdrawnKeys(k.port, clock), jsonAccountWithdrawnCodec, { clock });
    const raw = withdrawn({ purgeBy: new Date(NOW + 2 * DAY).toISOString() });
    await handler.handle(handler.decode(msg(raw)));
    await handler.handle(handler.decode(msg(raw)));
    expect(k.calls).toEqual([
      { pid: PID, events: ['ev-1', 'ev-2'], at: NOW + 2 * DAY },
      { pid: PID, events: ['ev-1', 'ev-2'], at: NOW + 2 * DAY },
    ]);
  });

  test('I-T3 ④-4 대기열 Redis 일시 장애로 TransientError가 난 뒤 다시 하면 두 번째에 만료가 걸린다', async () => {
    let fail = true;
    const calls: { pid: string; at: number }[] = [];
    const port: WithdrawnKeys = {
      activeEvents: async () => {
        if (fail) throw new QueueStoreUnavailable(new Error('주입한 장애'));
        return ['ev-1'];
      },
      expireBy: async (pid, eventIds, at) => {
        calls.push({ pid, at });
        return eventIds.length * 2;
      },
    };
    const clock = fakeClock({ now: NOW });
    const handler = new AccountWithdrawnHandler(new PurgeWithdrawnKeys(port, clock), jsonAccountWithdrawnCodec, { clock });
    const e = handler.decode(msg(withdrawn({ purgeBy: new Date(NOW + DAY).toISOString() })));
    const err = await handler.handle(e).catch((x: unknown) => x);
    expect(isTransientError(err)).toBe(true);
    expect(calls).toEqual([]);
    fail = false;
    await handler.handle(e);
    expect(calls).toEqual([{ pid: PID, at: NOW + DAY }]);
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

