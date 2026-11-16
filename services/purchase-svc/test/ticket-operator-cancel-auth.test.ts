// BAT-415 리뷰 반영 B6(계획 §11 F22, docs/features/transfer-refund.md §7.4 '호출자'): purchase-svc가 ticket-svc OperatorCancelTickets를 부를 때
// 내부 토큰과 호출자 머리(purchase-svc)를 싣는지 본다. 받는 쪽은 계약 설명자(@peaket/contracts/proto)로 만든 시험 gRPC 서버이고, 받은 메타데이터를 기록한다.
// 시작 파일(start.ts)이 어댑터에 토큰을 넘기는지는 글로 본다(F18 방식).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startPurchaseGrpcServer } from '../src/grpc-server.js';
import { GrpcTicketCancellations } from '../src/modules/refund/index.js';

const TOKEN = 'internal-grpc-token-purchase-to-ticket';
const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const pkg = (grpc.loadPackageDefinition(protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], LOAD)) as unknown as {
  peaket: { ticket: { v1: { TicketService: grpc.ServiceClientConstructor } } };
}).peaket.ticket.v1;

const seen: { token: unknown; caller: unknown }[] = [];
const cancelRequests: Record<string, unknown>[] = [];
/** CancelTickets 답의 결과·첫 칸(시험마다 바꾼다) */
let cancelAnswer: Record<string, unknown> = { result: 'CANCEL_TICKET_RESULT_REFUND_NOW' };
let server: { port: number; close(): Promise<void> };
const ORDER = randomUUID();

beforeAll(async () => {
  server = await startPurchaseGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [
      {
        definition: pkg.TicketService.service,
        handlers: {
          CancelTickets: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
            cancelRequests.push(call.request);
            seen.push({ token: call.metadata.get(INTERNAL_GRPC_TOKEN_HEADER)[0], caller: call.metadata.get(INTERNAL_GRPC_CALLER_HEADER)[0] });
            const ids = (call.request.ticket_ids ?? []) as string[];
            cb(null, { outcomes: ids.map((id) => ({ ticket_id: id, ...cancelAnswer })) });
          },
          OperatorCancelTickets: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
            seen.push({ token: call.metadata.get(INTERNAL_GRPC_TOKEN_HEADER)[0], caller: call.metadata.get(INTERNAL_GRPC_CALLER_HEADER)[0] });
            const targets = (call.request.targets ?? []) as { ticket_id: string }[];
            cb(null, { outcomes: targets.map((x) => ({ ticket_id: x.ticket_id, result: 'OPERATOR_CANCEL_RESULT_CANCELED', order_id: ORDER, withdrawn_transfer_offer_id: '' })) });
          },
        },
      },
    ],
  });
});
afterAll(async () => {
  await server?.close();
});
beforeEach(() => {
  seen.length = 0;
  cancelRequests.length = 0;
  cancelAnswer = { result: 'CANCEL_TICKET_RESULT_REFUND_NOW' };
});

const request = () => ({ approvalId: randomUUID(), fraudCaseId: randomUUID(), eventId: randomUUID(), targets: [{ ticketId: randomUUID(), expectedHolderAccountId: randomUUID() }], deadlineMs: 5_000 });

describe('GAT-080 F22 purchase-svc → ticket-svc 운영자 취소의 호출자 머리(리뷰 B6)', () => {
  test('GAT-080 F22 [ASVS v5.0.0-8.2.1] 어댑터는 내부 토큰을 받으면 OperatorCancelTickets에 그 토큰과 호출자 purchase-svc를 싣는다', async () => {
    const adapter = new GrpcTicketCancellations({ address: `127.0.0.1:${server.port}`, internalToken: TOKEN });
    try {
      const out = await adapter.operatorCancel(request());
      expect(out.map((o) => o.result)).toEqual(['CANCELED']);
      expect(seen).toEqual([{ token: TOKEN, caller: 'purchase-svc' }]);
    } finally {
      adapter.close();
    }
  });

  test('GAT-080 F22 purchase 어댑터는 토큰이 없어도 호출자 머리 purchase-svc를 싣고 토큰 머리는 싣지 않는다(local·ci)', async () => {
    const adapter = new GrpcTicketCancellations({ address: `127.0.0.1:${server.port}` });
    try {
      await adapter.operatorCancel(request());
      expect(seen).toHaveLength(1);
      expect(seen[0]!.token).toBeUndefined();
      expect(seen[0]!.caller).toBe('purchase-svc');
    } finally {
      adapter.close();
    }
  });

  test('GAT-080 F22 purchase-svc start.ts는 ticket-svc 취소 어댑터에 내부 토큰을 넘긴다', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/start.ts', import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const at = source.indexOf('new GrpcTicketCancellations(');
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 300)).toMatch(/internalToken\s*:\s*internalGrpcToken/);
  });
});

describe('GAT-080 S2·S4 purchase 어댑터의 CancelTickets(리뷰 B2 보충)', () => {
  const K1 = randomUUID();
  const AT = Date.parse('2026-11-16T01:00:00.123Z');
  const ts = { seconds: Math.floor(AT / 1000), nanos: 123_000_000 };
  const q = (over: Record<string, unknown> = {}) => ({ orderId: ORDER, ticketIds: [randomUUID()], requestedByAccountId: randomUUID(), cancellationId: randomUUID(), deadlineMs: 2_000, ...over });

  test('GAT-080 S2 첫 칸 셋이 다 맞으면 잇기 답(첫 취소 ID·결과·시각)이다', async () => {
    cancelAnswer = { result: 'CANCEL_TICKET_RESULT_ALREADY_CANCELLED', first_cancellation_id: K1, first_result: 'CANCEL_TICKET_RESULT_REFUND_NOW', first_cancelled_at: ts };
    const adapter = new GrpcTicketCancellations({ address: `127.0.0.1:${server.port}` });
    try {
      expect(await adapter.cancel(q())).toEqual({ result: 'ALREADY_CANCELLED', firstCancellationId: K1, firstResult: 'REFUND_NOW', firstCancelledAtMs: AT });
    } finally {
      adapter.close();
    }
  });

  test.each<[string, Record<string, unknown>]>([
    ['첫 취소 ID 빔', { first_cancellation_id: '', first_result: 'CANCEL_TICKET_RESULT_REFUND_NOW', first_cancelled_at: ts }],
    ['첫 결과 UNSPECIFIED', { first_cancellation_id: K1, first_result: 'CANCEL_TICKET_RESULT_UNSPECIFIED', first_cancelled_at: ts }],
    ['첫 결과 ALREADY_CANCELLED', { first_cancellation_id: K1, first_result: 'CANCEL_TICKET_RESULT_ALREADY_CANCELLED', first_cancelled_at: ts }],
    ['첫 시각 빔', { first_cancellation_id: K1, first_result: 'CANCEL_TICKET_RESULT_REFUND_NOW' }],
  ])('GAT-080 S2 첫 칸 셋 가운데 하나라도 비거나 틀리면(%s) 잇지 않고 문자열 ALREADY_CANCELLED다', async (_name, first) => {
    cancelAnswer = { result: 'CANCEL_TICKET_RESULT_ALREADY_CANCELLED', ...first };
    const adapter = new GrpcTicketCancellations({ address: `127.0.0.1:${server.port}` });
    try {
      expect(await adapter.cancel(q())).toBe('ALREADY_CANCELLED');
    } finally {
      adapter.close();
    }
  });

  test('GAT-080 S4 어댑터는 replayOnly를 CancelTickets의 replay_only로 싣고, 아니면 싣지 않는다', async () => {
    const adapter = new GrpcTicketCancellations({ address: `127.0.0.1:${server.port}` });
    try {
      await adapter.cancel(q({ replayOnly: true }));
      await adapter.cancel(q());
      expect(cancelRequests.map((r) => r.replay_only)).toEqual([true, false]);
    } finally {
      adapter.close();
    }
  });

  test('GAT-080 F22 CancelTickets에도 토큰이 없으면 호출자 머리 purchase-svc만, 토큰이 있으면 둘 다 싣는다', async () => {
    const plain = new GrpcTicketCancellations({ address: `127.0.0.1:${server.port}` });
    const withToken = new GrpcTicketCancellations({ address: `127.0.0.1:${server.port}`, internalToken: TOKEN });
    try {
      await plain.cancel(q());
      await withToken.cancel(q());
      expect(seen).toEqual([
        { token: undefined, caller: 'purchase-svc' },
        { token: TOKEN, caller: 'purchase-svc' },
      ]);
    } finally {
      plain.close();
      withToken.close();
    }
  });
});
