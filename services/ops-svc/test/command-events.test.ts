// 내부 명령 사건 수신(BAT-465 GAT-300): Kafka 소비자 조립 전의 요청·결과 사건 멱등 처리.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { CreateCommand, MemoryCommandStore } from '../src/modules/commands/index.js';
import { InternalCommandEventsController, commandIdOfEventKey } from '../src/modules/commands/inbound/internal-command-events.controller.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-14T08:00:00.000Z');
const identity = new FakeIdentity();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, nowMs: NOW }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

const post = (body: unknown) => svc.http.inject({ method: 'POST', url: '/internal/v1/ops/command-events', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });

describe('/internal/v1/ops/command-events', () => {
  test('GAT300_같은_eventKey의_명령_요청은_한_번만_만든다', async () => {
    const eventKey = `event-${randomUUID()}`;
    const body = { eventKey, kind: 'COMMAND_REQUESTED', type: 'SCALE_CHANGE', reason: '규모 올리기', params: { eventId: randomUUID(), scale: 'LARGE' }, requestedBy: randomUUID(), requestedRole: 'operator' };
    const a = await post(body);
    expect(a.statusCode).toBe(202);
    const first = JSON.parse(a.payload) as { accepted: boolean; commandId: string };
    expect(first.accepted).toBe(true);
    expect(first.commandId).toBe(commandIdOfEventKey(eventKey));
    const b = await post(body);
    expect(JSON.parse(b.payload)).toEqual(first);
    // 같은 eventKey에 다른 내용을 실으면 처음 것을 돌려주지 않는다.
    const mismatch = await post({ ...body, reason: '다른 사유' });
    expect(JSON.parse(mismatch.payload)).toEqual({ accepted: false });
  });

  test('GAT300_결과_사건은_승인_대기_명령을_끝내지_못한다', async () => {
    const eventKey = `event-${randomUUID()}`;
    const requested = await post({ eventKey, kind: 'COMMAND_REQUESTED', type: 'EVENT_CANCEL', reason: '회차 취소', params: { eventId: randomUUID(), fault: 'ORGANIZER' }, requestedBy: randomUUID(), requestedRole: 'operator' });
    const { commandId } = JSON.parse(requested.payload) as { commandId: string };
    const result = { eventKey: `result-${randomUUID()}`, kind: 'COMMAND_RESULT', commandId, status: 'SUCCEEDED', detail: { applied: true } };
    const a = await post(result);
    expect(a.statusCode).toBe(202);
    expect(JSON.parse(a.payload)).toEqual({ accepted: false });
    const operator = identity.ops('operator');
    const detail = await svc.http.inject({ method: 'GET', url: `/v1/ops/commands/${commandId}`, headers: operator });
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload)).toMatchObject({ commandId, state: 'PENDING_APPROVAL' });
  });

  test('GAT300_결과_사건은_DISPATCHED_명령만_SUCCEEDED로_끝낸다', async () => {
    const audit = new MemoryAuditChain();
    const store = new MemoryCommandStore(audit);
    const create = new CreateCommand(store);
    const controller = new InternalCommandEventsController(create, store, fakeClock({ now: NOW }));
    const command = await create.execute({
      type: 'EVENT_CANCEL',
      reason: '직접 시험',
      params: { eventId: randomUUID(), fault: 'ORGANIZER' },
      requestedBy: randomUUID(),
      requestedRole: 'operator',
      nowMs: NOW,
    });
    expect((await controller.handle({ eventKey: 'before', kind: 'COMMAND_RESULT', commandId: command.commandId, status: 'SUCCEEDED' })).accepted).toBe(false);
    expect((await store.find(command.commandId))?.state).toBe('PENDING_APPROVAL');
    await store.markDispatched(command.commandId, NOW + 1);
    expect(await controller.handle({ eventKey: 'after', kind: 'COMMAND_RESULT', commandId: command.commandId, status: 'SUCCEEDED', detail: { applied: true } })).toEqual({ accepted: true, commandId: command.commandId });
    expect((await store.find(command.commandId))?.state).toBe('SUCCEEDED');
  });

  test('GAT300_모르는_사건과_잘못된_본문은_받지_않는다', async () => {
    expect(JSON.parse((await post({ eventKey: 'x', kind: 'UNKNOWN' })).payload)).toEqual({ accepted: false });
    expect(JSON.parse((await post({ kind: 'COMMAND_REQUESTED' })).payload)).toEqual({ accepted: false });
  });
});
