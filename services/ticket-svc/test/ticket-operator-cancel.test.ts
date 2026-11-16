// 부정 예매 운영자 취소(ticket.proto OperatorCancelTickets, docs/features/transfer-refund.md §7.4 'purchase-svc·ticket-svc 쪽 세부', BUILD_ORDER GAT-080, BAT-415 몫 F).
// 메모리 저장소 + TicketService + 실제 grpc-js 서버로 돈다(Docker 없음). 입장 기록의 방향·결과 경계, 행 잠금 경합, 스캐너 변경분은 test-int/ticket.int.test.ts가 본다.
// 정본 값: 대상 1~500장, 이미 끝난 상태 REFUNDED·VOIDED·CANCEL_REQUESTED·FLAGGED, 가르는 차례 = 이미 끝남 → 입장 기록 → 보유자.
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { type OperatorCancelInput, type OperatorCancelTarget, TicketInputError, type TicketRecord, type TicketStatus } from '../src/modules/ticket/domain/ticket.js';
import { ticketPackage, ticketServiceHandlers } from '../src/modules/ticket/inbound/ticket.grpc.js';

const NOW = Date.parse('2026-11-16T03:00:00.000Z');
const EVENT = randomUUID();
const OTHER_EVENT = randomUUID();
const PAYER = randomUUID();
const RECIPIENT = randomUUID();
const FRAUD_CASE = randomUUID();

let store: MemoryTicketStore;
let service: TicketService;

beforeEach(() => {
  store = new MemoryTicketStore();
  service = new TicketService({ store, clock: fakeClock({ now: NOW - 86_400_000 }) });
});

/** 결제자 PAYER의 주문 하나에 표 n장(한 번에 10장까지라 나눠 낸다) */
async function issued(n = 1, eventId = EVENT): Promise<TicketRecord[]> {
  const orderId = randomUUID();
  const out: TicketRecord[] = [];
  for (let g = 0; out.length < n; g++) {
    const seatIds = Array.from({ length: Math.min(10, n - out.length) }, () => randomUUID());
    const r = await service.issue({ orderId, eventId, payerAccountId: PAYER, seatIds, issueGeneration: g });
    out.push(...r.tickets);
  }
  return out;
}
const patch = (ticketId: string, p: Partial<TicketRecord>): void => {
  store.tickets.set(ticketId, { ...store.tickets.get(ticketId)!, ...p });
};
const now = (ticketId: string): TicketRecord => store.tickets.get(ticketId)!;
const input = (targets: readonly OperatorCancelTarget[], over: Partial<OperatorCancelInput> = {}): OperatorCancelInput => ({
  approvalId: randomUUID(),
  fraudCaseId: FRAUD_CASE,
  eventId: EVENT,
  targets,
  nowMs: NOW,
  ...over,
});
const target = (t: TicketRecord, expectedHolderAccountId = PAYER): OperatorCancelTarget => ({ ticketId: t.ticketId, expectedHolderAccountId });

describe('GAT-080 몫 F ticket-svc 운영자 취소(메모리)', () => {
  test('GAT-080 F1 운영자 취소는 보유자와 무관하게 키를 폐기하고 진행 중 양도를 거둔다(결제자 보유·받은 사람 보유·양도 진행 중)', async () => {
    const [payerHeld] = await issued();
    const [recipientHeld] = await issued();
    const [transferring] = await issued();
    patch(recipientHeld!.ticketId, { accountId: RECIPIENT });
    patch(transferring!.ticketId, { transferPending: true });
    const before = [payerHeld!, recipientHeld!, transferring!].map((t) => now(t.ticketId).version);

    const out = await service.operatorCancel(input([target(payerHeld!), target(recipientHeld!, RECIPIENT), target(transferring!)]));

    expect(out).toEqual([
      { ticketId: payerHeld!.ticketId, result: 'CANCELED', orderId: payerHeld!.orderId },
      { ticketId: recipientHeld!.ticketId, result: 'CANCELED', orderId: recipientHeld!.orderId },
      { ticketId: transferring!.ticketId, result: 'CANCELED', orderId: transferring!.orderId },
    ]);
    [payerHeld!, recipientHeld!, transferring!].forEach((t, i) => {
      expect(now(t.ticketId)).toMatchObject({ status: 'REFUNDED', transferPending: false, keyRevokedAtMs: NOW, version: before[i]! + 1 });
    });
    expect(out.every((o) => o.withdrawnTransferOfferId === undefined)).toBe(true);
  });

  test.each<TicketStatus>(['REFUNDED', 'VOIDED', 'CANCEL_REQUESTED', 'FLAGGED'])('GAT-080 F2 이미 끝난 상태 %s인 표는 SKIPPED_ALREADY_ENDED이고 상태·키·버전이 그대로다', async (status) => {
    const [t] = await issued();
    patch(t!.ticketId, { status, version: 3 });
    const before = now(t!.ticketId);
    expect(await service.operatorCancel(input([target(t!)]))).toEqual([{ ticketId: t!.ticketId, result: 'SKIPPED_ALREADY_ENDED', orderId: t!.orderId }]);
    expect(now(t!.ticketId)).toEqual(before);
  });

  test('GAT-080 F2 지금 보유자가 기대 보유자와 다르면 SKIPPED_HOLDER_CHANGED이고 그대로 둔다(받은 사람이 가진 표를 결제자로 기대·결제자가 가진 표를 받은 사람으로 기대)', async () => {
    const [movedOn] = await issued();
    const [stillPayer] = await issued();
    patch(movedOn!.ticketId, { accountId: RECIPIENT });
    const before = [now(movedOn!.ticketId), now(stillPayer!.ticketId)];
    const out = await service.operatorCancel(input([target(movedOn!, PAYER), target(stillPayer!, RECIPIENT)]));
    expect(out).toEqual([
      { ticketId: movedOn!.ticketId, result: 'SKIPPED_HOLDER_CHANGED', orderId: movedOn!.orderId },
      { ticketId: stillPayer!.ticketId, result: 'SKIPPED_HOLDER_CHANGED', orderId: stillPayer!.orderId },
    ]);
    expect([now(movedOn!.ticketId), now(stillPayer!.ticketId)]).toEqual(before);
  });

  test('GAT-080 F2 가르는 차례는 이미 끝남 → 입장 기록 → 보유자다(끝난 표의 보유자가 달라도 SKIPPED_ALREADY_ENDED, 입장한 표의 보유자가 달라도 SKIPPED_ENTRY_RECORDED)', async () => {
    const [endedMoved] = await issued();
    const [enteredMoved] = await issued();
    patch(endedMoved!.ticketId, { status: 'REFUNDED', accountId: RECIPIENT });
    patch(enteredMoved!.ticketId, { accountId: RECIPIENT });
    store.recordEntry(enteredMoved!.ticketId);
    const out = await service.operatorCancel(input([target(endedMoved!), target(enteredMoved!)]));
    expect(out.map((o) => o.result)).toEqual(['SKIPPED_ALREADY_ENDED', 'SKIPPED_ENTRY_RECORDED']);
  });

  test('GAT-080 F3 들어감·통과 기록이 있는 표는 SKIPPED_ENTRY_RECORDED이고 키·상태가 그대로다(메모리 씨앗)', async () => {
    const [t] = await issued();
    store.recordEntry(t!.ticketId);
    const before = now(t!.ticketId);
    expect(await service.operatorCancel(input([target(t!)]))).toEqual([{ ticketId: t!.ticketId, result: 'SKIPPED_ENTRY_RECORDED', orderId: t!.orderId }]);
    expect(now(t!.ticketId)).toEqual(before);
  });

  test('GAT-080 F4 같은 승인으로 다시 부르면 처음 결과를 주고 아무것도 다시 바꾸지 않으며, 다른 승인으로 같은 표는 SKIPPED_ALREADY_ENDED다', async () => {
    const [cancelMe] = await issued();
    const [moved] = await issued();
    patch(moved!.ticketId, { accountId: RECIPIENT });
    const first = input([target(cancelMe!), target(moved!)]);
    const a = await service.operatorCancel(first);
    const afterFirst = [now(cancelMe!.ticketId), now(moved!.ticketId)];
    // 그사이 보유자가 기대대로 돌아와도 같은 승인은 처음 결과(SKIPPED_HOLDER_CHANGED)를 준다
    patch(moved!.ticketId, { accountId: PAYER });
    const b = await service.operatorCancel({ ...first, nowMs: NOW + 60_000 });
    expect(b).toEqual(a);
    expect(a.map((o) => o.result)).toEqual(['CANCELED', 'SKIPPED_HOLDER_CHANGED']);
    expect(now(cancelMe!.ticketId)).toEqual(afterFirst[0]);
    expect(now(moved!.ticketId).status).toBe(afterFirst[1]!.status);

    expect(await service.operatorCancel(input([target(cancelMe!)]))).toEqual([{ ticketId: cancelMe!.ticketId, result: 'SKIPPED_ALREADY_ENDED', orderId: cancelMe!.orderId }]);
  });

  test('GAT-080 F6 대상 500장은 받고 모두 취소한다(상한 경계)', async () => {
    const many = await issued(500);
    const out = await service.operatorCancel(input(many.map((t) => target(t))));
    expect(out).toHaveLength(500);
    expect(out.every((o) => o.result === 'CANCELED')).toBe(true);
    expect(out.map((o) => o.ticketId)).toEqual(many.map((t) => t.ticketId));
  });

  test('GAT-080 F6 입력이 틀리면 TicketInputError이고 아무것도 바꾸지 않는다(UUID 아님·대문자·0장·501장·같은 표 두 번·다른 회차·없는 표)', async () => {
    const [ok] = await issued();
    const [other] = await issued(1, OTHER_EVENT);
    const many = await issued(501);
    const snapshot = (): TicketRecord[] => [...store.tickets.values()].map((t) => ({ ...t }));
    const before = snapshot();
    const cases: [string, OperatorCancelInput][] = [
      ['승인 ID가 UUID 아님', input([target(ok!)], { approvalId: 'nope' })],
      ['사건 ID가 대문자 UUID', input([target(ok!)], { fraudCaseId: FRAUD_CASE.toUpperCase() })],
      ['회차 ID가 UUID 아님', input([target(ok!)], { eventId: 'event-1' })],
      ['기대 보유자가 UUID 아님', input([{ ticketId: ok!.ticketId, expectedHolderAccountId: 'holder' }])],
      ['대상 0장', input([])],
      ['대상 501장', input(many.map((t) => target(t)))],
      ['같은 표 두 번', input([target(ok!), target(ok!)])],
      ['다른 회차 표(앞 표는 처리될 수 있는 차례)', input([target(ok!), target(other!)])],
      ['없는 표(앞 표는 처리될 수 있는 차례)', input([target(ok!), { ticketId: randomUUID(), expectedHolderAccountId: PAYER }])],
    ];
    for (const [name, i] of cases) {
      await expect(service.operatorCancel(i), name).rejects.toBeInstanceOf(TicketInputError);
    }
    expect(snapshot()).toEqual(before);
  });
});

describe('GAT-080 몫 F OperatorCancelTickets gRPC', () => {
  interface Client {
    OperatorCancelTickets(req: Record<string, unknown>, cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void): void;
  }
  let server: Awaited<ReturnType<typeof startGrpcServer>>;
  let client: Client;
  const grpcStore = new MemoryTicketStore();
  const grpcService = new TicketService({ store: grpcStore, clock: fakeClock({ now: NOW - 86_400_000 }) });
  const call = (req: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((res, rej) => client.OperatorCancelTickets(req, (err, r) => (err ? rej(err) : res(r))));

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

  test('GAT-080 F1 gRPC 답은 요청 차례의 outcomes(ticket_id·OPERATOR_CANCEL_RESULT_*·order_id·빈 withdrawn_transfer_offer_id)다', async () => {
    const orderId = randomUUID();
    const r = await grpcService.issue({ orderId, eventId: EVENT, payerAccountId: PAYER, seatIds: [randomUUID(), randomUUID()], issueGeneration: 0 });
    const [a, b] = r.tickets;
    grpcStore.tickets.set(b!.ticketId, { ...grpcStore.tickets.get(b!.ticketId)!, accountId: RECIPIENT });
    const out = await call({
      approval_id: randomUUID(),
      fraud_case_id: FRAUD_CASE,
      event_id: EVENT,
      targets: [
        { ticket_id: b!.ticketId, expected_holder_account_id: PAYER },
        { ticket_id: a!.ticketId, expected_holder_account_id: PAYER },
      ],
    });
    expect(out.outcomes).toEqual([
      { ticket_id: b!.ticketId, result: 'OPERATOR_CANCEL_RESULT_SKIPPED_HOLDER_CHANGED', order_id: orderId, withdrawn_transfer_offer_id: '' },
      { ticket_id: a!.ticketId, result: 'OPERATOR_CANCEL_RESULT_CANCELED', order_id: orderId, withdrawn_transfer_offer_id: '' },
    ]);
    expect(grpcStore.tickets.get(a!.ticketId)).toMatchObject({ status: 'REFUNDED', keyRevokedAtMs: NOW });
  });

  test('GAT-080 F6 gRPC 입력이 틀리면(UUID 아님·없는 표) INVALID_ARGUMENT다', async () => {
    await expect(call({ approval_id: 'nope', fraud_case_id: FRAUD_CASE, event_id: EVENT, targets: [{ ticket_id: randomUUID(), expected_holder_account_id: PAYER }] })).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
    });
    await expect(call({ approval_id: randomUUID(), fraud_case_id: FRAUD_CASE, event_id: EVENT, targets: [{ ticket_id: randomUUID(), expected_holder_account_id: PAYER }] })).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
    });
    await expect(call({ approval_id: randomUUID(), fraud_case_id: FRAUD_CASE, event_id: EVENT, targets: [] })).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
  });
});
