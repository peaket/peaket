// ops.command-events Kafka 소비자(BAT-465 R-584) 단위 시험: 계약 모양 해독, 업무 키, HTTP와 같은 멱등 처리.
import { randomUUID } from 'node:crypto';
import { fakeClock, type ConsumedMessage } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { OpsCommandEventsHandler } from '../src/consumers/index.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { CreateCommand, HandleCommandEvent, MemoryCommandStore, commandIdOfEventKey } from '../src/modules/commands/index.js';

const NOW = Date.parse('2026-11-14T09:00:00.000Z');
const clock = fakeClock({ now: NOW });

const fixture = () => {
  const store = new MemoryCommandStore(new MemoryAuditChain());
  const create = new CreateCommand(store);
  const handler = new OpsCommandEventsHandler(new HandleCommandEvent({ createCommand: create, store }), clock);
  return { store, handler };
};

const message = (value: unknown, key: string | null = null): ConsumedMessage => ({
  topic: 'ops.command-events',
  partition: 0,
  offset: 1n,
  key,
  value: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'),
  headers: {},
  timestamp: NOW,
});

const requested = (eventKey: string, over: Record<string, unknown> = {}) => ({
  eventKey,
  kind: 'COMMAND_REQUESTED',
  type: 'SALE_STOP',
  reason: '판매자 신원 확인',
  params: { eventId: randomUUID(), reasonCode: 'SELLER_IDENTITY' },
  requestedBy: randomUUID(),
  requestedRole: 'operator',
  ...over,
});

describe('BAT-465 ops.command-events 소비자', () => {
  test('R584_요청_사건은_eventKey로_정한_명령_ID로_한_번만_만든다', async () => {
    const f = fixture();
    const eventKey = `evt-${randomUUID()}`;
    const m = message(requested(eventKey), eventKey);
    const decoded = f.handler.decode(m);
    expect(decoded.kind).toBe('event');
    expect(f.handler.keyOf(decoded)).toBe(commandIdOfEventKey(eventKey));
    expect(f.handler.eventKeyOf(decoded)).toBe(eventKey);
    await f.handler.handle(decoded);
    await f.handler.handle(decoded);
    const command = await f.store.find(commandIdOfEventKey(eventKey));
    expect(command?.type).toBe('SALE_STOP');
    expect(command?.state).toBe('PENDING_APPROVAL');
  });

  test('R584_결과_사건은_DISPATCHED_명령만_끝낸다', async () => {
    const f = fixture();
    const eventKey = `evt-${randomUUID()}`;
    const requestedRecord = f.handler.decode(message(requested(eventKey), eventKey));
    await f.handler.handle(requestedRecord);
    const commandId = commandIdOfEventKey(eventKey);
    const result = message({ eventKey: `res-${randomUUID()}`, kind: 'COMMAND_RESULT', commandId, status: 'SUCCEEDED', detail: { applied: true } });
    const record = f.handler.decode(result);
    expect(f.handler.keyOf(record)).toBe(commandId);
    await expect(f.handler.handle(record)).rejects.toThrow('command-event-not-applicable');
    expect((await f.store.find(commandId))?.state).toBe('PENDING_APPROVAL');
    await f.store.markDispatched(commandId, NOW + 1);
    await f.handler.handle(record);
    expect((await f.store.find(commandId))?.state).toBe('SUCCEEDED');
  });

  test('R584_모양이_틀린_메시지는_bad로_읽고_보류한다', async () => {
    const f = fixture();
    expect(f.handler.decode(message('{not json')).kind).toBe('bad');
    expect(f.handler.decode(message({ kind: 'COMMAND_REQUESTED' })).kind).toBe('bad');
    expect(f.handler.decode(message(requested(`evt-${randomUUID()}`, { type: 'NOT_A_COMMAND' }))).kind).toBe('bad');
    expect(f.handler.decode(message(requested(`evt-${randomUUID()}`, { extra: true }))).kind).toBe('bad');
    const badResult = f.handler.decode(message({ kind: 'COMMAND_RESULT', commandId: 'x', status: 'SUCCEEDED', eventKey: 'e' }));
    expect(badResult.kind).toBe('bad');
    await expect(f.handler.handle(badResult)).rejects.toThrow();
  });
});
