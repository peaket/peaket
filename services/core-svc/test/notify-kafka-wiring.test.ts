// F-06-1 N-T19 ⑩·N-T23 ④: notify Kafka 처리기의 동작과 asyncapi 계약.
// 파일이 없으면 단언으로 실패하고, 있으면 실제 처리기를 동적 import해 decode·keyOf·handle을 돌린다.
// 정본: docs/streaming.md §2.6, docs/features/notify.md §2.1 E2·§4.1, asyncapi `OrderEvent`·`AccountMerged`·`LoginMethodChanged`.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CORE_TOPICS } from '../src/consumers/index.js';

const handlerUrl = new URL('../src/modules/notify/inbound/notify-events.handler.ts', import.meta.url).href;
const handlerPath = fileURLToPath(handlerUrl);
const readRepo = (p: string): string => readFileSync(fileURLToPath(new URL(`../../../${p}`, import.meta.url)), 'utf8');

type Handler = {
  decode(m: { topic: string; value: Buffer | null }): unknown;
  keyOf(e: unknown): string;
  handle(e: unknown): Promise<void>;
};

/** 실제 인테이크 대신 부른 자리와 인자만 기록한다(경계 가짜) */
class FakeIntake {
  readonly trade: Record<string, unknown>[] = [];
  readonly logins: Record<string, unknown>[] = [];
  readonly merges: Record<string, unknown>[] = [];
  async tradeEvent(e: Record<string, unknown>) {
    this.trade.push(e);
    return 'created';
  }
  async loginMethodChanged(e: Record<string, unknown>) {
    this.logins.push(e);
    return { created: 1, duplicate: 0 };
  }
  async accountMerged(e: Record<string, unknown>) {
    this.merges.push(e);
    return { created: 1, duplicate: 0, subscriptionsMoved: 0, pushMoved: 0 };
  }
}

const orderEvent = (type: string) => ({
  eventId: '01900000-0000-7000-8000-0000000000e1',
  orderId: '01900000-0000-7000-8000-0000000000d1',
  accountId: '01900000-0000-7000-8000-0000000000a1',
  type,
  amount: 110_000,
  seatIds: [],
  items: [],
  seatAssignment: 'PICK',
  occurredAt: '2026-11-28T00:00:00.000Z',
  eventKey: '01900000-0000-7000-8000-0000000000f1',
  ...(type === 'REFUND_FAILED' ? { fanNoticeReason: 'failed' } : {}),
  ...(type === 'REFUNDED' ? { refundAmount: 110_000 } : {}),
  ...(type === 'EVENT_POSTPONED' ? { fanNoticeReason: '연기', postponedTo: '2026-12-01T10:00:00.000Z', refundWindowClosesAt: '2026-12-08T10:00:00.000Z' } : {}),
});

const importHandler = async (): Promise<{ handler: Handler; intake: FakeIntake } | undefined> => {
  const mod = (await import(/* @vite-ignore */ handlerUrl)) as { NotifyEventHandler?: new (deps: { intake: FakeIntake }) => Handler };
  if (typeof mod.NotifyEventHandler !== 'function') return undefined;
  const intake = new FakeIntake();
  return { handler: new mod.NotifyEventHandler({ intake }), intake };
};

describe('N-T19 Kafka trade.orders 처리기', () => {
  test('N-T19 ⑩ orderId를 업무 키로 쓰고 알림 네 종류만 인테이크로 넘기며 나머지는 no-op이다', async () => {
    expect([...CORE_TOPICS]).toEqual(['identity.accounts-withdrawn', 'identity.accounts-merged', 'identity.login-methods-changed', 'trade.orders']);
    expect(existsSync(handlerPath)).toBe(true);
    if (!existsSync(handlerPath)) return;

    const imported = await importHandler();
    expect(imported).toBeDefined();
    if (!imported) return;
    const { handler, intake } = imported;

    const decodedOrder = (type: string) => {
      const order = orderEvent(type);
      const event = handler.decode({ topic: 'trade.orders', value: Buffer.from(JSON.stringify(order)) }) as { topic: string; order: Record<string, unknown> };
      expect(event).toMatchObject({ topic: 'trade.orders', order: { type, orderId: order.orderId } });
      return { order, event };
    };

    for (const type of ['EVENT_CANCELLATION_CONFIRMED', 'EVENT_POSTPONED', 'REFUNDED', 'REFUND_FAILED']) {
      const { order, event } = decodedOrder(type);
      expect(handler.keyOf(event)).toBe(order.orderId);
      await handler.handle(event);
    }
    expect(intake.trade.map((e) => e.type)).toEqual(['EVENT_CANCELLATION_CONFIRMED', 'EVENT_POSTPONED', 'REFUNDED', 'REFUND_FAILED']);
    expect(intake.trade[0]).toMatchObject({
      orderId: '01900000-0000-7000-8000-0000000000d1',
      eventId: '01900000-0000-7000-8000-0000000000e1',
      accountId: '01900000-0000-7000-8000-0000000000a1',
    });
    expect(intake.trade[2]).toMatchObject({ refundAmount: 110_000 });
    expect(intake.trade[3]).toMatchObject({ fanNoticeReason: 'failed' });

    // 알림 대상이 아닌 주문 사건도 decode를 지나 인테이크를 부르지 않는다
    const before = intake.trade.length;
    for (const type of ['CONFIRMED', 'APPROVED']) {
      const { event } = decodedOrder(type);
      await handler.handle(event);
    }
    expect(intake.trade).toHaveLength(before);

    // 계약에 맞지 않는 값은 던져 플랫폼이 보류하게 한다
    expect(() => handler.decode({ topic: 'trade.orders', value: Buffer.from('{"type":"CREATED"}') })).toThrow();
    expect(() => handler.decode({ topic: 'trade.orders', value: null })).toThrow();
  });
});

describe('N-T23 identity 사건 처리기와 계약', () => {
  test('N-T23 ④ mergeId·accountId 업무 키로 인테이크를 부르고, AccountMerged 메시지 전체에 주소가 없다', async () => {
    expect(existsSync(handlerPath)).toBe(true);
    if (!existsSync(handlerPath)) return;
    const imported = await importHandler();
    expect(imported).toBeDefined();
    if (!imported) return;
    const { handler, intake } = imported;

    const mergedPayload = {
      mergeId: '01900000-0000-7000-8000-0000000000b1',
      primaryAccountId: '01900000-0000-7000-8000-0000000000a1',
      mergedAccountId: '01900000-0000-7000-8000-0000000000a2',
      confirmedAt: '2026-11-28T00:00:00.000Z',
    };
    const merged = handler.decode({ topic: 'identity.accounts-merged', value: Buffer.from(JSON.stringify(mergedPayload)) }) as { topic: string; merged: Record<string, unknown> };
    expect(merged).toMatchObject({ topic: 'identity.accounts-merged', merged: mergedPayload });
    expect(handler.keyOf(merged)).toBe('01900000-0000-7000-8000-0000000000b1');
    await handler.handle(merged);
    expect(intake.merges).toEqual([
      expect.objectContaining({
        eventKey: '01900000-0000-7000-8000-0000000000b1',
        primaryAccountId: '01900000-0000-7000-8000-0000000000a1',
        mergedAccountId: '01900000-0000-7000-8000-0000000000a2',
      }),
    ]);

    const loginPayload = {
      eventKey: '01900000-0000-7000-8000-0000000000c1',
      accountId: '01900000-0000-7000-8000-0000000000a1',
      change: 'LINKED',
      provider: 'google',
      occurredAt: '2026-11-28T00:00:00.000Z',
    };
    const login = handler.decode({ topic: 'identity.login-methods-changed', value: Buffer.from(JSON.stringify(loginPayload)) }) as { topic: string; login: Record<string, unknown> };
    expect(login).toMatchObject({ topic: 'identity.login-methods-changed', login: loginPayload });
    expect(handler.keyOf(login)).toBe('01900000-0000-7000-8000-0000000000a1');
    await handler.handle(login);
    expect(intake.logins).toEqual([
      expect.objectContaining({ eventKey: '01900000-0000-7000-8000-0000000000c1', accountId: '01900000-0000-7000-8000-0000000000a1', change: 'LINKED', provider: 'google' }),
    ]);

    // components.messages.AccountMerged 전체(채널의 한 줄 참조가 아니다)
    const asyncapi = readRepo('docs/api/asyncapi.yaml');
    const start = asyncapi.indexOf('\n    AccountMerged:\n');
    const end = asyncapi.indexOf('\n    AccountWithdrawn:\n', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = asyncapi.slice(start, end);
    expect(block).toContain('required: [mergeId, primaryAccountId, mergedAccountId, confirmedAt]');
    expect(block).not.toContain('email');
    expect(block).not.toContain('phone');
  });
});
