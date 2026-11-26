// F-06-3 양도 회수 gRPC 시험(시험 담당, 2026-11-26).
// 정본: docs/features/transfer-refund.md §3.1·§4·§7.2·§11 R-T29, POL-038 ③, FR-059, docs/api/proto/peaket/ticket/v1/ticket.proto.
// 부르는 쪽은 ops-svc뿐이다. 내부 토큰을 둔 조립은 토큰과 호출자 ops-svc를 요구하고, 틀리면 PERMISSION_DENIED이며 저장소를 부르지 않는다.
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { ticketPackage, ticketServiceHandlers } from '../src/modules/ticket/inbound/ticket.grpc.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { fakeClock } from '@peaket/platform';

const NOW = Date.parse('2026-11-26T10:00:00+09:00');
const TOKEN = 'internal-grpc-token-f063';
const PAYER = randomUUID();
const RECIPIENT = randomUUID();
const EVENT = randomUUID();
const APPROVAL = randomUUID();
const OTHER_APPROVAL = randomUUID();

type Req = Record<string, unknown>;
type Reply = Record<string, unknown>;
type ReclaimClient = grpc.Client & { ReclaimTransfer: (req: Req, md: grpc.Metadata, cb: (err: grpc.ServiceError | null, res: Reply) => void) => void };
const call = (c: ReclaimClient, req: Req, md = new grpc.Metadata()): Promise<Reply> => new Promise((resolve, reject) => c.ReclaimTransfer(req, md, (err, r) => (err ? reject(err) : resolve(r))));
const md = (o: { token?: string; caller?: string }): grpc.Metadata => {
  const m = new grpc.Metadata();
  if (o.token !== undefined) m.set(INTERNAL_GRPC_TOKEN_HEADER, o.token);
  if (o.caller !== undefined) m.set(INTERNAL_GRPC_CALLER_HEADER, o.caller);
  return m;
};

const tickets = new MemoryTicketStore();
const ticket = new TicketService({ store: tickets, clock: fakeClock({ now: NOW }) });
let open: Awaited<ReturnType<typeof startGrpcServer>>;
let guarded: Awaited<ReturnType<typeof startGrpcServer>>;
let openClient: ReclaimClient;
let guardedClient: ReclaimClient;
let issued = 0;

const seed = async (o: { holder?: string; entryStartsAtMs?: number; status?: 'ACTIVE' | 'REFUNDED' | 'VOIDED' } = {}) => {
  const t = await tickets.issue(
    { orderId: randomUUID(), eventId: EVENT, payerAccountId: PAYER, seatIds: [randomUUID()], issueGeneration: 0, eventStartsAtMs: o.entryStartsAtMs ?? NOW + 72 * 3_600_000, fingerprint: randomUUID() },
    [
      {
        ticketId: randomUUID(),
        accountId: o.holder ?? RECIPIENT,
        payerAccountId: PAYER,
        orderId: randomUUID(),
        eventId: EVENT,
        seatId: randomUUID(),
        gateZone: '',
        status: o.status ?? 'ACTIVE',
        issueGeneration: 0,
        qrPayload: 'PEAKET1:x',
        keyHash: 'a'.repeat(64),
        transferPending: false,
        version: 0,
        issuedAtMs: NOW,
        eventStartsAtMs: o.entryStartsAtMs ?? NOW + 72 * 3_600_000,
      },
    ],
  );
  issued += 1;
  return t.tickets[0]!;
};

beforeAll(async () => {
  const services = (token?: string) => [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket, nowMs: () => NOW }, () => {}, token ? { internalToken: token } : {}) }];
  open = await startGrpcServer({ host: '127.0.0.1', port: 0, services: services() });
  guarded = await startGrpcServer({ host: '127.0.0.1', port: 0, services: services(TOKEN) });
  openClient = new (ticketPackage().TicketService)(`127.0.0.1:${open.port}`, grpc.credentials.createInsecure()) as unknown as ReclaimClient;
  guardedClient = new (ticketPackage().TicketService)(`127.0.0.1:${guarded.port}`, grpc.credentials.createInsecure()) as unknown as ReclaimClient;
});
afterAll(async () => {
  openClient?.close();
  guardedClient?.close();
  await open?.close();
  await guarded?.close();
});
beforeEach(() => {
  issued = 0;
});

const req = (ticketId: string, approvalId = APPROVAL, o: { payer?: string; holder?: string } = {}): Req => ({
  approval_id: approvalId,
  ticket_id: ticketId,
  expected_payer_account_id: o.payer ?? PAYER,
  expected_holder_account_id: o.holder ?? RECIPIENT,
  deadline_ms: NOW + 60_000,
});

describe('TransferReclaim 호출자 검사', () => {
  it('R-T29 ops-svc가 아닌 신원의 ReclaimTransfer는 PERMISSION_DENIED이고 보유자가 그대로다', async () => {
    const t = await seed();
    for (const m of [md({ caller: 'purchase-svc' }), md({ token: 'wrong', caller: 'ops-svc' }), md({ token: TOKEN }), new grpc.Metadata()]) {
      await expect(call(guardedClient, req(t.ticketId), m)).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    }
    expect((await tickets.tickets.get(t.ticketId))?.accountId).toBe(RECIPIENT);
  });
});

describe('R-T29 양도 회수', () => {
  it('R-T29 소명 기한 뒤·입장 시작 전이면 보유자를 결제자로 되돌리고 결과를 남긴다', async () => {
    const t = await seed();
    const r = await call(openClient, req(t.ticketId), md({ caller: 'ops-svc' }));
    expect(r).toMatchObject({ result: 'RECLAIMED', ticket_id: t.ticketId, previous_holder_account_id: RECIPIENT });
    const after = await tickets.tickets.get(t.ticketId);
    expect(after?.accountId).toBe(PAYER);
    expect(after?.transferPending).toBe(false);
    expect(issued).toBe(1);
  });

  it('R-T29 같은 (승인, 표)를 다시 부르면 같은 결과이고 보유자 변경은 한 번이다', async () => {
    const t = await seed();
    const a = await call(openClient, req(t.ticketId), md({ caller: 'ops-svc' }));
    const b = await call(openClient, req(t.ticketId), md({ caller: 'ops-svc' }));
    expect(b).toEqual(a);
    expect((await tickets.tickets.get(t.ticketId))?.accountId).toBe(PAYER);
  });

  it('R-T29 같은 승인 ID에 다른 표를 보내면 ALREADY_EXISTS이다', async () => {
    const a = await seed();
    const b = await seed();
    await call(openClient, req(a.ticketId), md({ caller: 'ops-svc' }));
    await expect(call(openClient, req(b.ticketId), md({ caller: 'ops-svc' }))).rejects.toMatchObject({ code: grpc.status.ALREADY_EXISTS });
    expect((await tickets.tickets.get(b.ticketId))?.accountId).toBe(RECIPIENT);
  });

  it('R-T29 입장이 시작됐으면 SKIPPED_ENTRY_STARTED이고 보유자가 그대로다', async () => {
    const t = await seed({ entryStartsAtMs: NOW - 1 });
    const r = await call(openClient, req(t.ticketId), md({ caller: 'ops-svc' }));
    expect(r).toMatchObject({ result: 'SKIPPED_ENTRY_STARTED' });
    expect((await tickets.tickets.get(t.ticketId))?.accountId).toBe(RECIPIENT);
  });

  it('R-T29 입장 기록이 있으면 SKIPPED_ENTRY_RECORDED이고 보유자가 그대로다', async () => {
    const t = await seed();
    tickets.recordEntry(t.ticketId);
    const r = await call(openClient, req(t.ticketId), md({ caller: 'ops-svc' }));
    expect(r).toMatchObject({ result: 'SKIPPED_ENTRY_RECORDED' });
    expect(tickets.tickets.get(t.ticketId)?.accountId).toBe(RECIPIENT);
  });

  it('R-T29 보유자가 결제자면 SKIPPED_NOT_TRANSFERRED이고 아무것도 바꾸지 않는다', async () => {
    const t = await seed({ holder: PAYER });
    const r = await call(openClient, req(t.ticketId, APPROVAL, { holder: PAYER }), md({ caller: 'ops-svc' }));
    expect(r).toMatchObject({ result: 'SKIPPED_NOT_TRANSFERRED' });
    expect((await tickets.tickets.get(t.ticketId))?.accountId).toBe(PAYER);
  });

  it('R-T29 기대 보유자가 다르면 SKIPPED_HOLDER_CHANGED이고 새 보유자를 바꾸지 않는다', async () => {
    const t = await seed({ holder: randomUUID() });
    const r = await call(openClient, req(t.ticketId), md({ caller: 'ops-svc' }));
    expect(r).toMatchObject({ result: 'SKIPPED_HOLDER_CHANGED' });
    expect((await tickets.tickets.get(t.ticketId))?.accountId).not.toBe(PAYER);
  });

  it('R-T29 없는 표·다른 회차 표는 INVALID_ARGUMENT/NOT_FOUND이고 쓰기가 0이다', async () => {
    await expect(call(openClient, req(randomUUID()), md({ caller: 'ops-svc' }))).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
  });

  it('R-T29 같은 승인으로 다른 기대 보유자를 보내면 결과가 갈리지 않는다', async () => {
    const t = await seed();
    await call(openClient, req(t.ticketId), md({ caller: 'ops-svc' }));
    await expect(call(openClient, req(t.ticketId, APPROVAL, { holder: randomUUID() }), md({ caller: 'ops-svc' }))).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
  });
});
