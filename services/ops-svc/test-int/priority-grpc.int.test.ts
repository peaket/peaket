// ops-svc 우선 구매 gRPC 클라이언트·소명 인정 내부 경로를 실제 gRPC 서버로 본다(GAT-135, R-587).
// 서버는 정본 설명자(purchase/v1/account.proto)로 띄우고, 클라이언트는 GrpcPurchasePriorityGrants를 쓴다.
// purchase-svc의 같은 정본 처리기는 purchase-svc 단위 시험(priority-grant-grpc.test.ts)이 본다.
import 'reflect-metadata';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createService, fakeClock } from '@peaket/platform';
import { purchaseV1Account } from '@peaket/contracts/proto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { GrpcPurchasePriorityGrants, type QueuePriorityGrantCopies } from '../src/modules/priority/index.js';
import { FakeIdentity, quiet } from '../test/support.js';

const NOW = Date.parse('2026-11-15T08:00:00.000Z');
const EVENT = '01900000-0000-7000-8000-000000000001';
const ACCOUNT = '01900000-0000-7000-8000-000000000002';
const CASE = '01900000-0000-7000-8000-000000000003';
const TICKET = '01900000-0000-7000-8000-000000000004';
const GRANT = '01900000-0000-7000-8000-000000000005';
const SEAT = '01900000-0000-7000-8000-000000000006';
const MISSING = '01900000-0000-7000-8000-000000000099';
const EXPIRES = new Date(NOW + 48 * 3_600_000).toISOString();
const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

const timestampOf = (iso: string) => ({ seconds: Math.floor(Date.parse(iso) / 1000), nanos: 0 });
const calls: { method: string; req: Record<string, unknown> }[] = [];
let server: grpc.Server;
let purchase: GrpcPurchasePriorityGrants;
let svc: Awaited<ReturnType<typeof createService>>;
const copies: Parameters<QueuePriorityGrantCopies['set']>[0][] = [];
const identity = new FakeIdentity();

beforeAll(async () => {
  const pkg = (grpc.loadPackageDefinition(protoLoader.fromJSON(purchaseV1Account as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS)) as unknown as {
    peaket: { purchase: { v1: { PriorityPurchaseService: grpc.ServiceClientConstructor } } };
  }).peaket.purchase.v1;
  server = new grpc.Server();
  server.addService(pkg.PriorityPurchaseService.service, {
    GrantPriorityPurchase: (call: grpc.ServerUnaryCall<Record<string, unknown>, object>, cb: grpc.sendUnaryData<object>) => {
      calls.push({ method: 'GrantPriorityPurchase', req: call.request });
      if (call.request.cancelled_ticket_id === MISSING) return cb({ code: grpc.status.NOT_FOUND, details: '없다' } as grpc.ServiceError);
      cb(null, {
        result: 'PRIORITY_GRANT_RESULT_SAME_SEAT',
        grant_id: GRANT,
        seat_id: SEAT,
        price: 110_000,
        expires_at: timestampOf(EXPIRES),
        version: 1,
      });
    },
    WithdrawPriorityPurchase: (call: grpc.ServerUnaryCall<Record<string, unknown>, object>, cb: grpc.sendUnaryData<object>) => {
      calls.push({ method: 'WithdrawPriorityPurchase', req: call.request });
      cb(null, {
        grant_id: GRANT,
        event_id: EVENT,
        account_id: ACCOUNT,
        status: 'PRIORITY_GRANT_STATE_WITHDRAWN',
        expires_at: timestampOf(EXPIRES),
        version: 2,
      });
    },
  });
  const port = await new Promise<number>((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  purchase = new GrpcPurchasePriorityGrants(`127.0.0.1:${port}`);
  svc = await createService({
    name: 'ops-svc-priority-grpc',
    module: AppModule.register({ memory: true, priority: { purchase, copies: { set: async (i) => void copies.push(i) } } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
  purchase?.close();
  await new Promise<void>((res) => server.tryShutdown(() => res()));
});

const post = (url: string, body: unknown) => svc.http.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });

describe('PriorityPurchaseService gRPC·소명 경로 [GAT-135]', () => {
  test('인정 결정은 실제 gRPC Grant를 불러 권리를 발급하고 queue 사본을 남긴다', async () => {
    calls.length = 0;
    copies.length = 0;
    const r = await post(`/internal/v1/fraud-objections/${CASE}/decisions`, {
      accountId: ACCOUNT,
      eventId: EVENT,
      cancelledTicketIds: [TICKET],
      decision: 'ACCEPTED',
      actedBy: 'operator-1',
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ decision: 'ACCEPTED', grants: [{ result: 'SAME_SEAT', grantId: GRANT, version: 1 }] });
    expect(calls).toMatchObject([{ method: 'GrantPriorityPurchase', req: { fraud_case_id: CASE, cancelled_ticket_id: TICKET, acted_by: 'operator-1' } }]);
    expect(copies).toEqual([{ accountId: ACCOUNT, eventId: EVENT, grantId: GRANT, state: 'OFFERED', expiresAt: EXPIRES, version: 1 }]);
  });

  test('기각 결정은 실제 gRPC Withdraw를 불러 회수하고 WITHDRAWN 사본을 남긴다', async () => {
    calls.length = 0;
    copies.length = 0;
    const r = await post(`/internal/v1/fraud-objections/${CASE}/decisions`, {
      accountId: ACCOUNT,
      eventId: EVENT,
      cancelledTicketIds: [],
      decision: 'REJECTED',
      grantId: GRANT,
      actedBy: 'operator-1',
    });
    expect(r.statusCode).toBe(200);
    expect(calls).toMatchObject([{ method: 'WithdrawPriorityPurchase', req: { grant_id: GRANT } }]);
    expect(copies).toEqual([{ accountId: ACCOUNT, eventId: EVENT, grantId: GRANT, state: 'WITHDRAWN', expiresAt: EXPIRES, version: 2 }]);
  });

  test('gRPC NOT_FOUND는 404 priority-grant-not-found로 옮긴다', async () => {
    const r = await post(`/internal/v1/fraud-objections/${CASE}/decisions`, {
      accountId: ACCOUNT,
      eventId: EVENT,
      cancelledTicketIds: [MISSING],
      decision: 'ACCEPTED',
      actedBy: 'operator-1',
    });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.payload)).toMatchObject({ type: expect.stringMatching(/priority-grant-not-found$/) });
  });
});
