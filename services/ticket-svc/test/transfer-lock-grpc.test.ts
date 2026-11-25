// 부정 예매 양도 잠금 gRPC 처리기 시험(BUILD_ORDER GAT-055, ticket.proto TransferLockService, docs/features/transfer-refund.md §4.1).
// 부르는 쪽은 ops-svc뿐이다. 내부 토큰을 둔 조립은 토큰과 호출자 머리 ops-svc를 요구하고, 틀리면 PERMISSION_DENIED이며 저장소를 부르지 않는다.
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { MemoryTransferStore } from '../src/modules/ticket/adapters/memory-transfer-store.js';
import { INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { ticketPackage, transferLockHandlers } from '../src/modules/ticket/inbound/ticket.grpc.js';

// 고정 날짜를 쓰면 그 날짜의 +72시간이 지난 뒤 실제 시계가 '입장 시작'을 넘겨 시험이 깨진다.
// 이 시험은 잠금 결과만 보므로 현재 시각을 기준으로 삼아 시한 폭탄을 없앤다.
const NOW = Date.now();
const TOKEN = 'internal-grpc-token-bat410';
const PAYER = randomUUID();
const EVENT = randomUUID();
const CASE = randomUUID();

type Req = Record<string, unknown>;
type Reply = Record<string, unknown>;
type Client = grpc.Client & { SetTransferLock: (req: Req, md: grpc.Metadata, cb: (err: grpc.ServiceError | null, res: Reply) => void) => void };
const call = (c: Client, req: Req, md = new grpc.Metadata()): Promise<Reply> => new Promise((resolve, reject) => c.SetTransferLock(req, md, (err, r) => (err ? reject(err) : resolve(r))));
const md = (o: { token?: string; caller?: string }): grpc.Metadata => {
  const m = new grpc.Metadata();
  if (o.token !== undefined) m.set(INTERNAL_GRPC_TOKEN_HEADER, o.token);
  if (o.caller !== undefined) m.set(INTERNAL_GRPC_CALLER_HEADER, o.caller);
  return m;
};

const tickets = new MemoryTicketStore();
let calls = 0;
const store = new MemoryTransferStore({ tickets });
const real = store.setTransferLock.bind(store);
store.setTransferLock = async (i) => (calls++, real(i));
let open: Awaited<ReturnType<typeof startGrpcServer>>;
let guarded: Awaited<ReturnType<typeof startGrpcServer>>;
let openClient: Client;
let guardedClient: Client;

beforeAll(async () => {
  const services = (token?: string) => [{ definition: ticketPackage().TransferLockService.service, handlers: transferLockHandlers(store, () => {}, token ? { internalToken: token } : {}) }];
  open = await startGrpcServer({ host: '127.0.0.1', port: 0, services: services() });
  guarded = await startGrpcServer({ host: '127.0.0.1', port: 0, services: services(TOKEN) });
  openClient = new (ticketPackage().TransferLockService)(`127.0.0.1:${open.port}`, grpc.credentials.createInsecure()) as unknown as Client;
  guardedClient = new (ticketPackage().TransferLockService)(`127.0.0.1:${guarded.port}`, grpc.credentials.createInsecure()) as unknown as Client;
});
afterAll(async () => {
  openClient?.close();
  guardedClient?.close();
  await open?.close();
  await guarded?.close();
});

const req = (): Req => ({
  case_id: CASE,
  version: 1,
  locked: true,
  acted_by: randomUUID(),
  event_id: EVENT,
  account_ids: [PAYER],
  expires_at: { seconds: Math.floor((NOW + 14 * 86_400_000) / 1000), nanos: 0 },
});

describe('TransferLockService 호출자 검사와 응답', () => {
  it('R-T31 ⑥ ops-svc가 아닌 신원의 SetTransferLock은 PERMISSION_DENIED이고 아무것도 쓰지 않는다', async () => {
    const before = calls;
    for (const m of [md({ caller: 'purchase-svc' }), md({ token: 'wrong', caller: 'ops-svc' }), md({ token: TOKEN }), new grpc.Metadata()]) {
      await expect(call(guardedClient, req(), m)).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    }
    expect(calls).toBe(before);
  });

  it('R-T31 ① ops-svc 호출은 계정의 표에 잠금을 걸고, 다시 부르면 같은 결과다', async () => {
    const t = await tickets.issue(
      { orderId: randomUUID(), eventId: EVENT, payerAccountId: PAYER, seatIds: [randomUUID()], issueGeneration: 0, eventStartsAtMs: NOW + 72 * 3600_000, fingerprint: randomUUID() },
      [
        {
          ticketId: randomUUID(),
          accountId: PAYER,
          payerAccountId: PAYER,
          orderId: randomUUID(),
          eventId: EVENT,
          seatId: randomUUID(),
          gateZone: '',
          status: 'ACTIVE',
          issueGeneration: 0,
          qrPayload: 'PEAKET1:x',
          keyHash: 'a'.repeat(64),
          transferPending: false,
          version: 0,
          issuedAtMs: NOW,
          eventStartsAtMs: NOW + 72 * 3600_000,
        },
      ],
    );
    const ticketId = t.tickets[0]!.ticketId;
    const first = await call(openClient, req(), md({ caller: 'ops-svc' }));
    expect(first.outcomes).toEqual([{ ticket_id: ticketId, result: 'TRANSFER_LOCK_RESULT_LOCKED', withdrawn_offer_id: '', holder_account_id: '' }]);
    const again = await call(openClient, req(), md({ caller: 'ops-svc' }));
    expect(again.outcomes).toEqual(first.outcomes);
  });
});
