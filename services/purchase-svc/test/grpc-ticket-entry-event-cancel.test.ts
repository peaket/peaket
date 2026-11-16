// purchase-svc → ticket-svc 입장 기록 대조(GetEntryRecords, BAT-420 GAT-090 A)·회차 취소 표 끝내기(EventCancelTickets, GAT-110 E) gRPC 어댑터와
// ops CS 처리함 이상 표시 어댑터(HttpEntryFlagNotice). 받는 쪽은 계약 설명자(@peaket/contracts/proto)로 만든 시험 gRPC 서버이고 받은 요청을 기록한다(Docker 없음).
// 정본 값: GetEntryRecords 데드라인 2초 [가정], 답의 Timestamp를 ms로, 요청 차례, 빠진 표·모르는 결과는 던짐(모름은 환급하지 않는다).
// 시험 담당이 구현 전에 썼다(ADR-0270).
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import type { ExternalRequest } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startPurchaseGrpcServer } from '../src/grpc-server.js';
import { GrpcTicketCancellations, HttpEntryFlagNotice } from '../src/modules/refund/index.js';

const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const pkg = (grpc.loadPackageDefinition(protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], LOAD)) as unknown as {
  peaket: { ticket: { v1: { TicketService: grpc.ServiceClientConstructor } } };
}).peaket.ticket.v1;

const received: { method: string; req: Record<string, unknown>; deadlineMs: number }[] = [];
let entryAnswer: (req: Record<string, unknown>) => Record<string, unknown> = () => ({ records: [] });
let cancelAnswer: (req: Record<string, unknown>) => Record<string, unknown> = () => ({ outcomes: [] });
let server: { port: number; close(): Promise<void> };
let adapter: GrpcTicketCancellations;
const deadlineOf = (call: grpc.ServerUnaryCall<unknown, unknown>): number => {
  const d = call.getDeadline();
  return d instanceof Date ? d.getTime() - Date.now() : Number(d) - Date.now();
};

beforeAll(async () => {
  server = await startPurchaseGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [
      {
        definition: pkg.TicketService.service,
        handlers: {
          GetEntryRecords: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
            received.push({ method: 'GetEntryRecords', req: call.request, deadlineMs: deadlineOf(call) });
            cb(null, entryAnswer(call.request));
          },
          EventCancelTickets: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
            received.push({ method: 'EventCancelTickets', req: call.request, deadlineMs: deadlineOf(call) });
            cb(null, cancelAnswer(call.request));
          },
        },
      },
    ],
  });
  adapter = new GrpcTicketCancellations({ address: `127.0.0.1:${server.port}` });
});
afterAll(async () => {
  adapter?.close();
  await server?.close();
});
beforeEach(() => {
  received.length = 0;
});

describe('GetEntryRecords 어댑터 [BAT-420 GAT-090 A]', () => {
  test('GAT-090 A5 입장 조회는 표 ID를 요청 차례로 보내고 데드라인 2,000ms 안이며 답을 표마다 found·entered·가장 이른 시각(ms)으로 읽는다', async () => {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    const atMs = Date.parse('2026-11-20T18:01:00.250+09:00');
    entryAnswer = () => ({
      records: [
        { ticket_id: a, found: true, entered: true, first_entered_at: { seconds: Math.floor(atMs / 1000), nanos: (atMs % 1000) * 1_000_000 } },
        { ticket_id: b, found: true, entered: false },
        { ticket_id: c, found: false, entered: false },
      ],
    });
    const got = await adapter.lookup([a, b, c], 2_000);
    expect(received).toHaveLength(1);
    expect(received[0]!.req).toMatchObject({ ticket_ids: [a, b, c] });
    expect(received[0]!.deadlineMs).toBeGreaterThan(0);
    expect(received[0]!.deadlineMs).toBeLessThanOrEqual(2_000);
    expect(got.get(a)).toEqual({ found: true, entered: true, firstEnteredAtMs: atMs });
    expect(got.get(b)).toEqual({ found: true, entered: false });
    expect(got.get(c)).toEqual({ found: false, entered: false });
  });

  test('GAT-090 A5 부른 쪽이 더 긴 데드라인을 줘도 2,000ms를 넘지 않는다', async () => {
    const a = randomUUID();
    entryAnswer = () => ({ records: [{ ticket_id: a, found: true, entered: false }] });
    await adapter.lookup([a], 30_000);
    expect(received[0]!.deadlineMs).toBeLessThanOrEqual(2_000);
  });

  test('GAT-090 A1 답에 빠진 표가 있으면 던진다(모르는 것을 입장 없음으로 보지 않는다)', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    entryAnswer = () => ({ records: [{ ticket_id: a, found: true, entered: false }] });
    // 대조: 답이 다 있으면 읽는다
    expect((await adapter.lookup([a], 2_000)).get(a)).toEqual({ found: true, entered: false });
    await expect(adapter.lookup([a, b], 2_000)).rejects.toThrow();
  });
});

describe('EventCancelTickets 어댑터 [BAT-420 GAT-110 E]', () => {
  test('GAT-110 E2 회차 취소 표 끝내기는 요청 ID·회차·(표, 취소 ID)를 보내고 답을 요청 차례의 결과·주문·보유자·양도 철회로 읽는다', async () => {
    const requestId = randomUUID();
    const eventId = randomUUID();
    const [t1, t2] = [randomUUID(), randomUUID()];
    const [c1, c2] = [randomUUID(), randomUUID()];
    const orderId = randomUUID();
    const holder = randomUUID();
    cancelAnswer = () => ({
      outcomes: [
        { ticket_id: t2, result: 'EVENT_CANCEL_RESULT_ALREADY_ENDED', order_id: orderId, holder_account_id: holder, transfer_withdrawn: false },
        { ticket_id: t1, result: 'EVENT_CANCEL_RESULT_CANCELED', order_id: orderId, holder_account_id: holder, transfer_withdrawn: true },
      ],
    });
    const got = await adapter.eventCancel({ cancellationRequestId: requestId, eventId, targets: [{ ticketId: t1, cancellationId: c1 }, { ticketId: t2, cancellationId: c2 }], deadlineMs: 5_000 });
    expect(received[0]!.req).toMatchObject({
      cancellation_request_id: requestId,
      event_id: eventId,
      targets: [
        { ticket_id: t1, cancellation_id: c1 },
        { ticket_id: t2, cancellation_id: c2 },
      ],
    });
    expect(got).toEqual([
      { ticketId: t1, result: 'CANCELED', orderId, holderAccountId: holder, transferWithdrawn: true },
      { ticketId: t2, result: 'ALREADY_ENDED', orderId, holderAccountId: holder, transferWithdrawn: false },
    ]);
  });

  test('GAT-110 E2 모르는 결과·빠진 표는 던진다', async () => {
    const t1 = randomUUID();
    // 대조: 아는 결과면 읽는다
    cancelAnswer = () => ({ outcomes: [{ ticket_id: t1, result: 'EVENT_CANCEL_RESULT_CANCELED', order_id: randomUUID(), holder_account_id: randomUUID(), transfer_withdrawn: false }] });
    expect((await adapter.eventCancel({ cancellationRequestId: randomUUID(), eventId: randomUUID(), targets: [{ ticketId: t1, cancellationId: randomUUID() }], deadlineMs: 5_000 }))[0]).toMatchObject({ ticketId: t1, result: 'CANCELED' });
    cancelAnswer = () => ({ outcomes: [{ ticket_id: t1, result: 'EVENT_CANCEL_RESULT_UNSPECIFIED', order_id: randomUUID(), holder_account_id: randomUUID(), transfer_withdrawn: false }] });
    await expect(adapter.eventCancel({ cancellationRequestId: randomUUID(), eventId: randomUUID(), targets: [{ ticketId: t1, cancellationId: randomUUID() }], deadlineMs: 5_000 })).rejects.toThrow();
    cancelAnswer = () => ({ outcomes: [] });
    await expect(adapter.eventCancel({ cancellationRequestId: randomUUID(), eventId: randomUUID(), targets: [{ ticketId: t1, cancellationId: randomUUID() }], deadlineMs: 5_000 })).rejects.toThrow();
  });
});

describe('이상 표시 CS 건 어댑터 [BAT-420 GAT-090 A]', () => {
  test('GAT-090 A4 이상 표시는 ops CS 처리함에 FLAGGED·ENTRY_AFTER_CANCEL 본문과 내부 토큰으로 5,000ms 안에 보내고 실패는 삼킨다', async () => {
    const sent: ExternalRequest[] = [];
    const ok = new HttpEntryFlagNotice({ request: async (r: ExternalRequest) => (sent.push(r), new Response('{"accepted":true}', { status: 202 })) }, 'it-token');
    const cancellationId = randomUUID();
    const nowMs = Date.parse('2026-11-23T01:00:00.000Z');
    await ok.open({ cancellationId, orderId: randomUUID(), ticketId: randomUUID(), enteredAtMs: nowMs - 86_400_000, nowMs });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'POST', path: '/internal/v1/cs-cases', timeoutCapMs: 5_000, headers: expect.objectContaining({ 'x-peaket-internal-token': 'it-token' }) });
    expect(JSON.parse(String(sent[0]!.body))).toEqual({ eventKey: `entry-after-cancel:${cancellationId}`, kind: 'FLAGGED', sourceId: cancellationId, category: 'ENTRY_AFTER_CANCEL', createdAt: new Date(nowMs).toISOString() });

    const down = new HttpEntryFlagNotice({ request: async () => Promise.reject(new Error('ops down')) }, 'it-token');
    await expect(down.open({ cancellationId, orderId: randomUUID(), ticketId: randomUUID(), enteredAtMs: nowMs, nowMs })).resolves.toBeUndefined();
  });
});
