// BAT-415 리뷰 반영(계획 §11) ticket-svc 몫: B2 CancelTickets의 첫 팬 취소 칸(S3), B6 OperatorCancelTickets의 호출자 검사(F22).
// 메모리 저장소 + 실제 grpc-js 서버(Docker 없음). 실제 DB 쪽 S3는 test-int/ticket.int.test.ts가 본다.
// 정본: docs/features/payment.md §4.1 '앞 시도가 티켓 단계만 마친 팬 취소 잇기', ticket.proto CancelTicketOutcome 3·4·5,
// docs/features/transfer-refund.md §7.4 '호출자'(ticket-svc OperatorCancelTickets는 purchase-svc만).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import { fakeClock, INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { ticketPackage, ticketServiceHandlers } from '../src/modules/ticket/inbound/ticket.grpc.js';

const NOW = Date.parse('2026-11-16T03:00:00.000Z');
const TOKEN = 'internal-grpc-token-ticket-review';
const PAYER = randomUUID();
const EVENT = randomUUID();

type Reply = Record<string, unknown>;
interface Client extends grpc.Client {
  CancelTickets(req: Reply, md: grpc.Metadata, cb: (err: grpc.ServiceError | null, res: Reply) => void): void;
  OperatorCancelTickets(req: Reply, md: grpc.Metadata, cb: (err: grpc.ServiceError | null, res: Reply) => void): void;
}
const call = (c: Client, method: 'CancelTickets' | 'OperatorCancelTickets', req: Reply, md = new grpc.Metadata()): Promise<Reply> =>
  new Promise((resolve, reject) => c[method](req, md, (err, r) => (err ? reject(err) : resolve(r))));
const ts = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });

let now = NOW;
const store = new MemoryTicketStore();
const ticket = new TicketService({ store, clock: fakeClock({ now: NOW - 86_400_000 }) });
let open: Awaited<ReturnType<typeof startGrpcServer>>;
let guarded: Awaited<ReturnType<typeof startGrpcServer>>;
let openClient: Client;
let guardedClient: Client;

beforeAll(async () => {
  open = await startGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket, nowMs: () => now }, () => {}) }] });
  guarded = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket, nowMs: () => now }, () => {}, { internalToken: TOKEN }) }],
  });
  openClient = new (ticketPackage().TicketService)(`127.0.0.1:${open.port}`, grpc.credentials.createInsecure()) as unknown as Client;
  guardedClient = new (ticketPackage().TicketService)(`127.0.0.1:${guarded.port}`, grpc.credentials.createInsecure()) as unknown as Client;
});
afterAll(async () => {
  openClient?.close();
  guardedClient?.close();
  await open?.close();
  await guarded?.close();
});

const issued = async (eventStartsAtMs?: number) => {
  const orderId = randomUUID();
  const r = await ticket.issue({ orderId, eventId: EVENT, payerAccountId: PAYER, seatIds: [randomUUID()], issueGeneration: 0, ...(eventStartsAtMs === undefined ? {} : { eventStartsAtMs }) });
  return { orderId, ticketId: r.tickets[0]!.ticketId };
};
const fanCancel = (t: { orderId: string; ticketId: string }, cancellationId: string, c: Client = openClient) =>
  call(c, 'CancelTickets', { order_id: t.orderId, ticket_ids: [t.ticketId], requested_by_account_id: PAYER, cancellation_id: cancellationId });

describe('GAT-080 S3 CancelTickets의 첫 팬 취소 칸(리뷰 B2)', () => {
  test('GAT-080 S3 CancelTickets는 ALREADY_CANCELLED에 먼저 취소한 팬 취소의 ID·결과·시각을 싣는다(가장 이른 것, 앞선 ALREADY_CANCELLED는 첫 취소가 아니다)', async () => {
    const t = await issued();
    const k1 = randomUUID();
    const k2 = randomUUID();
    const k3 = randomUUID();
    now = NOW;
    expect((await fanCancel(t, k1)).outcomes).toEqual([expect.objectContaining({ ticket_id: t.ticketId, result: 'CANCEL_TICKET_RESULT_REFUND_NOW' })]);
    now = NOW + 60_000;
    const second = (await fanCancel(t, k2)).outcomes as Reply[];
    expect(second).toEqual([
      { ticket_id: t.ticketId, result: 'CANCEL_TICKET_RESULT_ALREADY_CANCELLED', first_cancellation_id: k1, first_result: 'CANCEL_TICKET_RESULT_REFUND_NOW', first_cancelled_at: ts(NOW) },
    ]);
    now = NOW + 120_000;
    const third = (await fanCancel(t, k3)).outcomes as Reply[];
    expect(third[0]).toMatchObject({ result: 'CANCEL_TICKET_RESULT_ALREADY_CANCELLED', first_cancellation_id: k1, first_cancelled_at: ts(NOW) });
    // 같은 첫 키로 다시 부르면 처음 결과 그대로(첫 칸 없음)
    expect((await fanCancel(t, k1)).outcomes).toEqual([expect.objectContaining({ result: 'CANCEL_TICKET_RESULT_REFUND_NOW', first_cancellation_id: '' })]);
  });

  test('GAT-080 S3 입장 뒤 첫 팬 취소(REFUND_AFTER_CLOSE)는 그 결과를 첫 결과로 싣고, 서비스 답에도 first가 있다', async () => {
    const t = await issued(NOW - 1);
    const k1 = randomUUID();
    const out1 = await ticket.cancel({ orderId: t.orderId, ticketIds: [t.ticketId], requestedByAccountId: PAYER, cancellationId: k1, nowMs: NOW });
    expect(out1.map((o) => o.result)).toEqual(['REFUND_AFTER_CLOSE']);
    const out2 = await ticket.cancel({ orderId: t.orderId, ticketIds: [t.ticketId], requestedByAccountId: PAYER, cancellationId: randomUUID(), nowMs: NOW + 5_000 });
    expect(out2).toEqual([{ ticketId: t.ticketId, result: 'ALREADY_CANCELLED', first: { cancellationId: k1, result: 'REFUND_AFTER_CLOSE', cancelledAtMs: NOW } }]);
  });

  test('GAT-080 S3 운영자 취소로 끝난 표·무효(VOIDED)로 끝난 표는 첫 칸 셋을 비운다', async () => {
    const byOperator = await issued();
    await ticket.operatorCancel({ approvalId: randomUUID(), fraudCaseId: randomUUID(), eventId: EVENT, targets: [{ ticketId: byOperator.ticketId, expectedHolderAccountId: PAYER }], nowMs: NOW });
    const voided = await issued();
    store.tickets.set(voided.ticketId, { ...store.tickets.get(voided.ticketId)!, status: 'VOIDED' });
    for (const t of [byOperator, voided]) {
      const out = (await fanCancel(t, randomUUID())).outcomes as Reply[];
      expect(out[0]).toMatchObject({ ticket_id: t.ticketId, result: 'CANCEL_TICKET_RESULT_ALREADY_CANCELLED', first_cancellation_id: '', first_result: 'CANCEL_TICKET_RESULT_UNSPECIFIED', first_cancelled_at: null });
      const direct = await ticket.cancel({ orderId: t.orderId, ticketIds: [t.ticketId], requestedByAccountId: PAYER, cancellationId: randomUUID(), nowMs: NOW });
      expect(direct[0]!.first).toBeUndefined();
    }
  });
});

describe('GAT-080 F22 OperatorCancelTickets 호출자 검사(리뷰 B6)', () => {
  const md = (o: { token?: string; caller?: string }): grpc.Metadata => {
    const m = new grpc.Metadata();
    if (o.token !== undefined) m.set(INTERNAL_GRPC_TOKEN_HEADER, o.token);
    if (o.caller !== undefined) m.set(INTERNAL_GRPC_CALLER_HEADER, o.caller);
    return m;
  };
  const opReq = (t: { ticketId: string }) => ({ approval_id: randomUUID(), fraud_case_id: randomUUID(), event_id: EVENT, targets: [{ ticket_id: t.ticketId, expected_holder_account_id: PAYER }] });

  test('GAT-080 F22 [ASVS v5.0.0-8.2.1] ticket-svc 운영자 취소는 부르는 쪽이 purchase-svc가 아니면 PERMISSION_DENIED이고 바꾸지 않는다', async () => {
    const t = await issued();
    const before = { ...store.tickets.get(t.ticketId)! };
    const cases: [string, grpc.Metadata][] = [
      ['토큰 없음', md({ caller: 'purchase-svc' })],
      ['틀린 토큰', md({ token: 'wrong-token', caller: 'purchase-svc' })],
      ['호출자 ops-svc', md({ token: TOKEN, caller: 'ops-svc' })],
      ['호출자 머리 없음', md({ token: TOKEN })],
    ];
    for (const [name, meta] of cases) {
      await expect(call(guardedClient, 'OperatorCancelTickets', opReq(t), meta), name).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    }
    expect(store.tickets.get(t.ticketId)).toEqual(before);
    const ok = await call(guardedClient, 'OperatorCancelTickets', opReq(t), md({ token: TOKEN, caller: 'purchase-svc' }));
    expect((ok.outcomes as Reply[])[0]).toMatchObject({ ticket_id: t.ticketId, result: 'OPERATOR_CANCEL_RESULT_CANCELED' });
    expect(store.tickets.get(t.ticketId)!.status).toBe('REFUNDED');
  });

  test('GAT-080 F22 토큰을 두지 않은 조립(local·ci)은 운영자 취소를 받고, 토큰을 둔 조립도 다른 처리(CancelTickets)는 지금처럼 받는다', async () => {
    const t = await issued();
    const ok = await call(openClient, 'OperatorCancelTickets', opReq(t));
    expect((ok.outcomes as Reply[])[0]).toMatchObject({ result: 'OPERATOR_CANCEL_RESULT_CANCELED' });
    const u = await issued();
    const fan = await fanCancel(u, randomUUID(), guardedClient);
    expect((fan.outcomes as Reply[])[0]).toMatchObject({ result: 'CANCEL_TICKET_RESULT_REFUND_NOW' });
  });

  test('GAT-080 F22 ticket-svc start.ts는 TicketService 처리기에 내부 토큰을 넘긴다', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/start.ts', import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const at = source.indexOf('ticketServiceHandlers(');
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 600)).toMatch(/internalToken\s*:\s*internalGrpcToken/);
  });
});
