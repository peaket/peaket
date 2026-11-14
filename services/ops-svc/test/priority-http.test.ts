// /v1/ops/priority-grants(GAT-135): purchase-svc 발급·회수 뒤 queue-svc 사본을 같은 판 번호·만료로 잇는다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PriorityDependencyUnavailable, type PurchasePriorityGrants, type QueuePriorityGrantCopies } from '../src/modules/priority/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-14T08:00:00.000Z');
const EVENT = '01900000-0000-7000-8000-000000000001';
const ACCOUNT = '01900000-0000-7000-8000-000000000002';
const CASE = '01900000-0000-7000-8000-000000000003';
const TICKET = '01900000-0000-7000-8000-000000000004';
const GRANT = '01900000-0000-7000-8000-000000000005';
const EXPIRES = new Date(NOW + 48 * 3600_000).toISOString();
const identity = new FakeIdentity();
const copies: Parameters<QueuePriorityGrantCopies['set']>[0][] = [];
let fail: 'purchase' | 'queue' | undefined;
const purchase: PurchasePriorityGrants = {
  grant: async () => {
    if (fail === 'purchase') throw new PriorityDependencyUnavailable('purchase-svc', 503);
    return { result: 'SAME_SEAT', grantId: GRANT, seatId: '01900000-0000-7000-8000-000000000006', price: 110_000, expiresAt: EXPIRES, version: 1 };
  },
  withdraw: async () => {
    if (fail === 'purchase') throw new PriorityDependencyUnavailable('purchase-svc', 503);
    return { grantId: GRANT, eventId: EVENT, accountId: ACCOUNT, status: 'WITHDRAWN', expiresAt: EXPIRES, version: 2 };
  },
};
const queue: QueuePriorityGrantCopies = {
  set: async (i) => {
    if (fail === 'queue') throw new PriorityDependencyUnavailable('queue-svc', 503);
    copies.push(i);
  },
};
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc-priority',
    module: AppModule.register({ memory: true, priority: { purchase, copies: queue } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

const post = (url: string, headers: Record<string, string>, body: unknown = {}) =>
  svc.http.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

describe('/v1/ops/priority-grants [GAT-135]', () => {
  test('operator가 발급하면 purchase-svc 결과와 queue-svc OFFERED 사본(같은 판·만료)을 남긴다', async () => {
    copies.length = 0;
    fail = undefined;
    const op = identity.ops('operator');
    const r = await post('/v1/ops/priority-grants', op, { fraudCaseId: CASE, eventId: EVENT, accountId: ACCOUNT, cancelledTicketId: TICKET });
    expect(r.statusCode).toBe(201);
    expect(JSON.parse(r.payload)).toMatchObject({ result: 'SAME_SEAT', grantId: GRANT, price: 110_000, expiresAt: EXPIRES, version: 1 });
    expect(copies).toEqual([{ accountId: ACCOUNT, eventId: EVENT, grantId: GRANT, state: 'OFFERED', expiresAt: EXPIRES, version: 1 }]);
  });

  test('회수는 purchase-svc WITHDRAWN 판 번호를 queue-svc 사본에 그대로 잇는다', async () => {
    copies.length = 0;
    fail = undefined;
    const r = await post(`/v1/ops/priority-grants/${GRANT}/withdrawals`, identity.ops('commander'));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ grantId: GRANT, status: 'WITHDRAWN', version: 2 });
    expect(copies).toEqual([{ accountId: ACCOUNT, eventId: EVENT, grantId: GRANT, state: 'WITHDRAWN', expiresAt: EXPIRES, version: 2 }]);
  });

  test('소명 인정은 취소표마다 발급을, 기각은 그 권리 회수를 자동 호출한다', async () => {
    copies.length = 0;
    fail = undefined;
    const accepted = await post('/internal/v1/fraud-objections/01900000-0000-7000-8000-0000000000a1/decisions', {}, {
      accountId: ACCOUNT,
      eventId: EVENT,
      cancelledTicketIds: [TICKET],
      decision: 'ACCEPTED',
      actedBy: 'operator-1',
    });
    expect(accepted.statusCode).toBe(200);
    expect(JSON.parse(accepted.payload)).toMatchObject({ decision: 'ACCEPTED', grants: [{ result: 'SAME_SEAT', grantId: GRANT, version: 1 }] });
    expect(copies).toHaveLength(1);

    copies.length = 0;
    const rejected = await post('/internal/v1/fraud-objections/01900000-0000-7000-8000-0000000000a1/decisions', {}, {
      accountId: ACCOUNT,
      eventId: EVENT,
      cancelledTicketIds: [],
      decision: 'REJECTED',
      grantId: GRANT,
      actedBy: 'operator-1',
    });
    expect(rejected.statusCode).toBe(200);
    expect(JSON.parse(rejected.payload)).toMatchObject({ decision: 'REJECTED', withdrawnGrantId: GRANT });
    expect(copies).toEqual([{ accountId: ACCOUNT, eventId: EVENT, grantId: GRANT, state: 'WITHDRAWN', expiresAt: EXPIRES, version: 2 }]);
  });

  test('viewer는 발급·회수하지 못하고, 의존 서비스가 답하지 않으면 503 dependency-unavailable이다', async () => {
    const viewer = identity.ops('viewer');
    expect((await post('/v1/ops/priority-grants', viewer, { fraudCaseId: CASE, eventId: EVENT, accountId: ACCOUNT, cancelledTicketId: TICKET })).statusCode).toBe(403);
    expect((await post(`/v1/ops/priority-grants/${GRANT}/withdrawals`, viewer)).statusCode).toBe(403);

    fail = 'queue';
    const r = await post('/v1/ops/priority-grants', identity.ops('operator'), { fraudCaseId: CASE, eventId: EVENT, accountId: ACCOUNT, cancelledTicketId: TICKET });
    expect(r.statusCode).toBe(503);
    expect((JSON.parse(r.payload) as { type: string }).type).toMatch(/dependency-unavailable$/);
    fail = undefined;
  });
});
