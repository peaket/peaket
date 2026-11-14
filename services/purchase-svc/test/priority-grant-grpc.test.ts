// 우선 구매 권리 gRPC 정본(GAT-135, purchase/v1/account.proto PriorityPurchaseService) 단위 시험.
// 실제 gRPC 서버에 정본 설명자로 붙어 Grant·Withdraw 응답과 오류 매핑을 본다.
import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startPurchaseGrpcServer } from '../src/grpc-server.js';
import { PriorityGrantNotFound, priorityPurchaseHandlers, priorityPurchasePackage } from '../src/modules/priority/index.js';
import type { PriorityGrant } from '../src/modules/priority/index.js';

const NOW = Date.parse('2026-11-15T08:00:00.000Z');
const GRANT = '01900000-0000-7000-8000-0000000000c1';
const EVENT = '01900000-0000-7000-8000-000000000001';
const ACCOUNT = '01900000-0000-7000-8000-000000000002';
const SEAT = '01900000-0000-7000-8000-000000000003';
const grant: PriorityGrant = {
  grantId: GRANT,
  eventId: EVENT,
  accountId: ACCOUNT,
  fraudCaseId: '01900000-0000-7000-8000-000000000004',
  cancelledTicketId: '01900000-0000-7000-8000-000000000005',
  grantKind: 'SAME_SEAT',
  seatId: SEAT,
  tierId: 'R',
  price: 110_000,
  status: 'OFFERED',
  expiresAtMs: NOW + 48 * 3_600_000,
  version: 1,
  createdAtMs: NOW,
  updatedAtMs: NOW,
};

type Unary = (req: Record<string, unknown>, cb: (err: grpc.ServiceError | null, res?: Record<string, unknown>) => void) => void;
let server: Awaited<ReturnType<typeof startPurchaseGrpcServer>>;
let client: { GrantPriorityPurchase: Unary; WithdrawPriorityPurchase: Unary; close(): void };
let fail = false;

beforeAll(async () => {
  server = await startPurchaseGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [
      {
        definition: priorityPurchasePackage().PriorityPurchaseService.service,
        handlers: priorityPurchaseHandlers({
          grant: {
            run: async () => {
              if (fail) throw new PriorityGrantNotFound();
              return { result: 'SAME_SEAT', grant };
            },
          },
          withdraw: { run: async () => ({ ...grant, status: 'WITHDRAWN', version: 2 }) },
        }),
      },
    ],
  });
  const pkg = priorityPurchasePackage() as unknown as {
    PriorityPurchaseService: new (address: string, credentials: grpc.ChannelCredentials) => typeof client;
  };
  client = new pkg.PriorityPurchaseService(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure());
});
afterAll(async () => {
  client?.close();
  await server?.close();
});

const call = (method: 'GrantPriorityPurchase' | 'WithdrawPriorityPurchase', req: Record<string, unknown>) =>
  new Promise<Record<string, unknown>>((resolve, reject) => client[method](req, (err, res) => (err ? reject(err) : resolve(res ?? {}))));

describe('PriorityPurchaseService gRPC [GAT-135]', () => {
  test('Grant는 SAME_SEAT·권리 ID·좌석·가격·만료·판 번호를 정본 enum으로 답한다', async () => {
    fail = false;
    const r = await call('GrantPriorityPurchase', {
      fraud_case_id: grant.fraudCaseId,
      event_id: EVENT,
      account_id: ACCOUNT,
      cancelled_ticket_id: grant.cancelledTicketId,
      acted_by: 'operator-1',
    });
    expect(r).toMatchObject({ result: 'PRIORITY_GRANT_RESULT_SAME_SEAT', grant_id: GRANT, seat_id: SEAT, price: 110_000, version: 1 });
    expect(r.expires_at).toMatchObject({ seconds: Math.floor(grant.expiresAtMs / 1000) });
  });

  test('Withdraw는 WITHDRAWN·올린 판 번호를 답한다', async () => {
    const r = await call('WithdrawPriorityPurchase', { grant_id: GRANT, acted_by: 'operator-1' });
    expect(r).toMatchObject({ grant_id: GRANT, event_id: EVENT, account_id: ACCOUNT, status: 'PRIORITY_GRANT_STATE_WITHDRAWN', version: 2 });
  });

  test('없는 권리는 gRPC NOT_FOUND로 답한다', async () => {
    fail = true;
    await expect(call('GrantPriorityPurchase', { fraud_case_id: grant.fraudCaseId, event_id: EVENT, account_id: ACCOUNT, cancelled_ticket_id: grant.cancelledTicketId, acted_by: 'operator-1' })).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
  });
});
