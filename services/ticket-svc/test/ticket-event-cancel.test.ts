// 회차 취소 표 끝내기(ticket.proto EventCancelTickets, BAT-420 GAT-110 E2·E3, R-T24, docs/features/transfer-refund.md §5 '대상 선택과 보류 취소 전환').
// 메모리 저장소 + TicketService + 실제 grpc-js 서버로 돈다(Docker 없음). 행 잠금 경합(E4)·스캐너 변경분·되돌림은 test-int/ticket.int.test.ts가 본다.
// 정본 값: 끝낼 상태 다섯(ISSUED·ACTIVE·TRANSFER_PENDING·CANCEL_REQUESTED·FLAGGED), 그대로 둘 상태 둘(REFUNDED·VOIDED),
// 결제자·보유자·양도·입장·공연 시작은 보지 않는다, 1~200장 [가정], (취소 ID, 표) 멱등. 시험 담당이 구현 전에 썼다(ADR-0270).
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { type EventCancelInput, type EventCancelTarget, normalizeEventCancelInput, TicketInputError, type TicketRecord, type TicketStatus } from '../src/modules/ticket/domain/ticket.js';
import { ticketPackage, ticketServiceHandlers } from '../src/modules/ticket/inbound/ticket.grpc.js';

const NOW = Date.parse('2026-11-16T19:40:00+09:00');
const EVENT = randomUUID();
const OTHER_EVENT = randomUUID();
const PAYER = randomUUID();
const RECIPIENT = randomUUID();
const REQUEST = randomUUID();

let store: MemoryTicketStore;
let service: TicketService;

beforeEach(() => {
  store = new MemoryTicketStore();
  service = new TicketService({ store, clock: fakeClock({ now: NOW - 3 * 86_400_000 }) });
});

async function issued(n = 1, eventId = EVENT, o: { eventStartsAtMs?: number } = {}): Promise<TicketRecord[]> {
  const orderId = randomUUID();
  const out: TicketRecord[] = [];
  for (let g = 0; out.length < n; g++) {
    const seatIds = Array.from({ length: Math.min(10, n - out.length) }, () => randomUUID());
    out.push(...(await service.issue({ orderId, eventId, payerAccountId: PAYER, seatIds, issueGeneration: g, ...(o.eventStartsAtMs !== undefined ? { eventStartsAtMs: o.eventStartsAtMs } : {}) })).tickets);
  }
  return out;
}
const patch = (ticketId: string, p: Partial<TicketRecord>): void => {
  store.tickets.set(ticketId, { ...store.tickets.get(ticketId)!, ...p });
};
const now = (ticketId: string): TicketRecord => store.tickets.get(ticketId)!;
const target = (t: TicketRecord, cancellationId: string = randomUUID()): EventCancelTarget => ({ ticketId: t.ticketId, cancellationId });
const input = (targets: readonly EventCancelTarget[], over: Partial<EventCancelInput> = {}): EventCancelInput => ({ cancellationRequestId: REQUEST, eventId: EVENT, targets, nowMs: NOW, ...over });

describe('GAT-110 E ticket-svc 회차 취소 표 끝내기(메모리)', () => {
  test.each<TicketStatus>(['ISSUED', 'ACTIVE', 'TRANSFER_PENDING', 'CANCEL_REQUESTED', 'FLAGGED'])(
    'GAT-110 E2 상태 %s인 표는 CANCELED이고 키를 폐기하고 환급 상태·판 번호 + 1로 둔다',
    async (status) => {
      const [t] = await issued();
      patch(t!.ticketId, { status, version: 9 });
      const out = await service.eventCancel(input([target(t!)]));
      expect(out).toEqual([{ ticketId: t!.ticketId, result: 'CANCELED', orderId: t!.orderId, holderAccountId: PAYER, transferWithdrawn: status === 'TRANSFER_PENDING' }]);
      expect(now(t!.ticketId)).toMatchObject({ status: 'REFUNDED', keyRevokedAtMs: NOW, version: 10, transferPending: false });
    },
  );

  test.each<TicketStatus>(['REFUNDED', 'VOIDED'])('GAT-110 E2 상태 %s인 표는 ALREADY_ENDED이고 상태·키·판 번호가 그대로다', async (status) => {
    const [t] = await issued();
    patch(t!.ticketId, { status, version: 4, keyRevokedAtMs: NOW - 60_000 });
    const before = { ...now(t!.ticketId) };
    expect(await service.eventCancel(input([target(t!)]))).toEqual([{ ticketId: t!.ticketId, result: 'ALREADY_ENDED', orderId: t!.orderId, holderAccountId: PAYER, transferWithdrawn: false }]);
    expect(now(t!.ticketId)).toEqual(before);
  });

  test('GAT-110 E2 R-T24 결제자·보유자·양도·입장·공연 시작과 무관하게 끝내고 보유자와 양도 철회 표시를 그대로 알린다', async () => {
    const [heldByRecipient] = await issued();
    const [transferFlagged] = await issued();
    const [entered] = await issued();
    const [started] = await issued(1, EVENT, { eventStartsAtMs: NOW - 30 * 60_000 });
    patch(heldByRecipient!.ticketId, { accountId: RECIPIENT });
    patch(transferFlagged!.ticketId, { transferPending: true });
    store.recordScan(entered!.ticketId, 'IN', 'PASS', NOW - 20 * 60_000);
    const out = await service.eventCancel(input([target(heldByRecipient!), target(transferFlagged!), target(entered!), target(started!)]));
    expect(out).toEqual([
      { ticketId: heldByRecipient!.ticketId, result: 'CANCELED', orderId: heldByRecipient!.orderId, holderAccountId: RECIPIENT, transferWithdrawn: false },
      { ticketId: transferFlagged!.ticketId, result: 'CANCELED', orderId: transferFlagged!.orderId, holderAccountId: PAYER, transferWithdrawn: true },
      { ticketId: entered!.ticketId, result: 'CANCELED', orderId: entered!.orderId, holderAccountId: PAYER, transferWithdrawn: false },
      { ticketId: started!.ticketId, result: 'CANCELED', orderId: started!.orderId, holderAccountId: PAYER, transferWithdrawn: false },
    ]);
    for (const t of [heldByRecipient!, transferFlagged!, entered!, started!]) expect(now(t.ticketId)).toMatchObject({ status: 'REFUNDED', transferPending: false, keyRevokedAtMs: NOW });
    // 보유자는 바꾸지 않는다(환급은 결제자에게 간다)
    expect(now(heldByRecipient!.ticketId).accountId).toBe(RECIPIENT);
  });

  test('GAT-110 E3 같은 취소 ID로 다시 부르면 처음 결과(CANCELED)를 주고 판 번호가 그대로이며 다른 취소 ID로는 ALREADY_ENDED다', async () => {
    const [t] = await issued();
    const cancellationId = randomUUID();
    const first = await service.eventCancel(input([target(t!, cancellationId)]));
    const afterFirst = { ...now(t!.ticketId) };
    const again = await service.eventCancel(input([target(t!, cancellationId)], { nowMs: NOW + 60_000 }));
    expect(again).toEqual(first);
    expect(again[0]!.result).toBe('CANCELED');
    expect(now(t!.ticketId)).toEqual(afterFirst);
    expect((await service.eventCancel(input([target(t!)])))[0]).toMatchObject({ ticketId: t!.ticketId, result: 'ALREADY_ENDED' });
  });

  test('GAT-110 E3 결과는 요청 차례이고 200장은 받는다(상한 경계)', async () => {
    const many = await issued(200);
    const reversed = [...many].reverse();
    const out = await service.eventCancel(input(reversed.map((t) => target(t))));
    expect(out.map((o) => o.ticketId)).toEqual(reversed.map((t) => t.ticketId));
    expect(out.every((o) => o.result === 'CANCELED')).toBe(true);
  });

  test('GAT-110 E3 입력이 틀리면 TicketInputError이고 앞 표도 바꾸지 않는다(0장·201장·같은 표 두 번·대문자·UUID 아님·다른 회차 표·없는 표)', async () => {
    const [ok] = await issued();
    const [other] = await issued(1, OTHER_EVENT);
    const many = await issued(201);
    const snapshot = (): TicketRecord[] => [...store.tickets.values()].map((t) => ({ ...t }));
    const before = snapshot();
    const cases: [string, EventCancelInput][] = [
      ['대상 0장', input([])],
      ['대상 201장', input(many.map((t) => target(t)))],
      ['같은 표 두 번', input([target(ok!), target(ok!)])],
      ['회차 ID 대문자', input([target(ok!)], { eventId: EVENT.toUpperCase() })],
      ['요청 ID가 UUID 아님', input([target(ok!)], { cancellationRequestId: 'req-1' })],
      ['취소 ID가 UUID 아님', input([{ ticketId: ok!.ticketId, cancellationId: 'cancel-1' }])],
      ['다른 회차 표(앞 표는 처리될 수 있는 차례)', input([target(ok!), target(other!)])],
      ['없는 표(앞 표는 처리될 수 있는 차례)', input([target(ok!), { ticketId: randomUUID(), cancellationId: randomUUID() }])],
    ];
    for (const [name, i] of cases) {
      await expect(service.eventCancel(i), name).rejects.toBeInstanceOf(TicketInputError);
    }
    expect(snapshot()).toEqual(before);
    expect(() => normalizeEventCancelInput(input([]))).toThrow(TicketInputError);
  });
});

describe('GAT-110 E2 EventCancelTickets gRPC', () => {
  interface Client {
    EventCancelTickets(req: Record<string, unknown>, cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void): void;
  }
  let server: Awaited<ReturnType<typeof startGrpcServer>>;
  let client: Client;
  const grpcStore = new MemoryTicketStore();
  const grpcService = new TicketService({ store: grpcStore, clock: fakeClock({ now: NOW - 86_400_000 }) });
  const call = (req: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((res, rej) => client.EventCancelTickets(req, (err, r) => (err ? rej(err) : res(r))));

  beforeAll(async () => {
    server = await startGrpcServer({
      host: '127.0.0.1',
      port: 0,
      services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket: grpcService, nowMs: () => NOW }, () => {}) }],
    });
    client = new (ticketPackage().TicketService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as Client;
  });
  afterAll(async () => {
    (client as unknown as grpc.Client | undefined)?.close();
    await server?.close();
  });

  test('GAT-110 E2 gRPC 답은 요청 차례의 outcomes(ticket_id·EVENT_CANCEL_RESULT_*·order_id·holder_account_id·transfer_withdrawn)이고 틀린 입력은 INVALID_ARGUMENT다', async () => {
    const orderId = randomUUID();
    const r = await grpcService.issue({ orderId, eventId: EVENT, payerAccountId: PAYER, seatIds: [randomUUID(), randomUUID()], issueGeneration: 0 });
    const [a, b] = r.tickets;
    grpcStore.tickets.set(b!.ticketId, { ...grpcStore.tickets.get(b!.ticketId)!, accountId: RECIPIENT, status: 'TRANSFER_PENDING' });
    grpcStore.tickets.set(a!.ticketId, { ...grpcStore.tickets.get(a!.ticketId)!, status: 'VOIDED' });
    const out = await call({
      cancellation_request_id: REQUEST,
      event_id: EVENT,
      targets: [
        { ticket_id: b!.ticketId, cancellation_id: randomUUID() },
        { ticket_id: a!.ticketId, cancellation_id: randomUUID() },
      ],
    });
    expect(out.outcomes).toEqual([
      { ticket_id: b!.ticketId, result: 'EVENT_CANCEL_RESULT_CANCELED', order_id: orderId, holder_account_id: RECIPIENT, transfer_withdrawn: true },
      { ticket_id: a!.ticketId, result: 'EVENT_CANCEL_RESULT_ALREADY_ENDED', order_id: orderId, holder_account_id: PAYER, transfer_withdrawn: false },
    ]);
    expect(grpcStore.tickets.get(b!.ticketId)).toMatchObject({ status: 'REFUNDED', keyRevokedAtMs: NOW, transferPending: false });
    await expect(call({ cancellation_request_id: REQUEST, event_id: EVENT, targets: [] })).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    await expect(call({ cancellation_request_id: REQUEST, event_id: EVENT, targets: [{ ticket_id: randomUUID(), cancellation_id: randomUUID() }] })).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
    });
  });
});
