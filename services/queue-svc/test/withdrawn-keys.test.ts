// 탈퇴 계정의 사람 키 만료 당기기(docs/features/queue-admission.md §3 '탈퇴 계정의 사람 키', BUILD_ORDER BOT-037, I-T27).
// identity의 탈퇴 사건(asyncapi identity.accounts-withdrawn `AccountWithdrawn`)을 읽는 처리기와 만료를 거는 일을 가짜 포트로 본다. 실제 Valkey는 test-int/withdrawn-keys.int.test.ts.
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
