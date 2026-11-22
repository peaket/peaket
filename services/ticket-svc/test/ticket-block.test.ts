// 주문 단위 발권 막기 계약 시험(BUILD_ORDER BAT-011, HOT-161, P-T15·P-T39 ③).
// 정본: docs/api/proto/peaket/ticket/v1/ticket.proto `BlockTicketIssuance`(이 묶음이 더한다), docs/features/payment.md §3 '승인 뒤 발권',
// specs/payment.qnt `compFence`(막은 뒤 발권은 거절, 이미 만든 티켓은 폐기), ADR-0354 결정 2, ASVS v5.0.0-8.2.1(부르는 쪽은 purchase-svc만).
// 실제 grpc-js 서버에 올려 계약 그대로(이름·상태 코드·칸) 본다. Docker 없이 localhost만 쓴다.
import * as grpc from '@grpc/grpc-js';
import { fakeClock, INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MemoryTicketStore, TicketService } from '../src/modules/ticket/index.js';
import { startGrpcServer } from '../src/grpc-server.js';
import { ticketPackage, ticketServiceHandlers } from '../src/modules/ticket/inbound/ticket.grpc.js';

const NOW = Date.parse('2026-11-22T09:00:00.000Z');
const ORDER = '0190f3a1-7c2e-7a00-8000-000000000101';
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000102';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000103';
const SEAT_A = '0190f3a1-7c2e-7a00-8000-000000000104';
const SEAT_B = '0190f3a1-7c2e-7a00-8000-000000000105';
const TOKEN = 'ticket-block-test-token';

interface Client {
  IssueTickets(req: Record<string, unknown>, md: grpc.Metadata, opts: grpc.CallOptions, cb: (err: grpc.ServiceError | null, res: any) => void): void;
  BlockTicketIssuance(req: Record<string, unknown>, md: grpc.Metadata, opts: grpc.CallOptions, cb: (err: grpc.ServiceError | null, res: any) => void): void;
}

let server: Awaited<ReturnType<typeof startGrpcServer>>;
let client: Client;
let store: MemoryTicketStore;
const errors: string[] = [];

beforeAll(async () => {
  store = new MemoryTicketStore();
  const ticket = new TicketService({ store, clock: fakeClock({ now: NOW }) });
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [
      {
        definition: ticketPackage().TicketService.service,
        // 계약의 호출자 제한(ASVS 8.2.1)을 함께 본다: 내부 토큰이 설정된 환경에서는 purchase-svc만 부른다
        handlers: ticketServiceHandlers({ ticket, nowMs: () => NOW }, (method, err) => errors.push(`${method}:${String(err)}`), { internalToken: TOKEN }),
      },
    ],
  });
  client = new (ticketPackage().TicketService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as Client;
});

afterAll(async () => {
  await server?.close();
});

/** purchase-svc 내부 호출자 메타데이터 */
function purchaseMetadata(): grpc.Metadata {
  const md = new grpc.Metadata();
  md.set(INTERNAL_GRPC_TOKEN_HEADER, TOKEN);
  md.set(INTERNAL_GRPC_CALLER_HEADER, 'purchase-svc');
  return md;
}

const call = <T>(fn: (cb: (err: grpc.ServiceError | null, res: any) => void) => void): Promise<T> => new Promise((res, rej) => fn((err, r) => (err ? rej(err) : res(r as T))));

const issue = (orderId: string, over: Record<string, unknown> = {}) =>
  call<{ tickets: Array<{ ticket_id: string; status: string }> }>((cb) =>
    client.IssueTickets({ order_id: orderId, event_id: EVENT, payer_account_id: ACCOUNT, seat_ids: [SEAT_A, SEAT_B], issue_generation: 0, ...over }, purchaseMetadata(), {}, cb),
  );

const block = (orderId: string, reason = 'EVENT_CANCELLED') =>
  call<{ already_entered: number }>((cb) => client.BlockTicketIssuance({ order_id: orderId, reason }, purchaseMetadata(), {}, cb));

describe('BlockTicketIssuance 단위 계약 [HOT-161] [P-T15] [P-T39 ③]', () => {
  test('P-T15_같은_주문의_BlockTicketIssuance를_두_번_보내도_한_번만_막고_두_번째도_같은_답이다', async () => {
    const orderId = '0190f3a1-7c2e-7a00-8000-000000000111';
    const first = await block(orderId);
    expect(first.already_entered).toBe(0);
    // 주문 ID로 멱등하다: 다시 막아도 새 티켓·새 입장 수가 생기지 않고, 같은 답(이미 만든 티켓이 없으므로 0)이다
    expect(await block(orderId)).toEqual(first);
    await expect(issue(orderId)).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
  });

  test('P-T39 ③_막은_뒤의_IssueTickets는_FAILED_PRECONDITION이고_티켓이_만들어지지_않는다', async () => {
    const orderId = '0190f3a1-7c2e-7a00-8000-000000000112';
    await block(orderId);
    await expect(issue(orderId)).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
    expect([...store.tickets.values()].filter((t) => t.orderId === orderId)).toEqual([]);
    expect(errors.some((e) => e.startsWith('IssueTickets:'))).toBe(true);
  });

  test('P-T39 ③_발권이_끝난_주문을_막으면_모든_티켓이_VOIDED가_되고_입장_기록_수를_센다', async () => {
    const orderId = '0190f3a1-7c2e-7a00-8000-000000000113';
    const issued = await issue(orderId);
    expect(issued.tickets.map((t) => t.status)).toEqual(['TICKET_STATUS_ISSUED', 'TICKET_STATUS_ISSUED']);
    // 입장 기록은 들어감(IN)·통과(PASS) 스캔만 센다. 두 장 가운데 한 장만 들어갔다
    store.recordEntry(issued.tickets[0]!.ticket_id);

    const out = await block(orderId);
    expect(out.already_entered).toBe(1);

    const saved = [...store.tickets.values()].filter((t) => t.orderId === orderId);
    expect(saved.map((t) => t.status)).toEqual(['VOIDED', 'VOIDED']);
    expect(saved.every((t) => t.keyRevokedAtMs === NOW)).toBe(true);
    // 이미 만든 티켓을 폐기한 뒤에도 같은 주문의 발권은 계속 막혀 있다
    await expect(issue(orderId)).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
  });

  test('P-T39 ③_발권과_막기가_동시에_와도_하나만_이기고_막은_뒤_유효한_티켓이_남지_않는다', async () => {
    const orderId = '0190f3a1-7c2e-7a00-8000-000000000114';
    const [issued, blocked] = await Promise.allSettled([issue(orderId), block(orderId)]);
    expect(blocked.status).toBe('fulfilled');
    // 발권이 먼저 끝났으면 막기가 그 티켓을 폐기했고, 막기가 먼저 끝났으면 발권은 FAILED_PRECONDITION이다(하나만 이긴다)
    if (issued.status === 'rejected') expect(issued.reason).toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
    const saved = [...store.tickets.values()].filter((t) => t.orderId === orderId);
    expect(saved.filter((t) => t.status === 'ISSUED' || t.status === 'ACTIVE')).toEqual([]);
    expect(saved.every((t) => t.status === 'VOIDED')).toBe(true);
    await expect(issue(orderId)).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
  });

  test('P-T39 ③_내부_토큰이_설정되면_BlockTicketIssuance는_purchase_svc_호출자만_받는다 [ASVS v5.0.0-8.2.1]', async () => {
    const orderId = '0190f3a1-7c2e-7a00-8000-000000000115';
    // 토큰이 없으면 거절하고 아무것도 막지 않는다
    await expect(
      call((cb) => client.BlockTicketIssuance({ order_id: orderId, reason: 'EVENT_CANCELLED' }, new grpc.Metadata(), {}, cb)),
    ).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    // 다른 서비스 이름도 거절한다
    const other = new grpc.Metadata();
    other.set(INTERNAL_GRPC_TOKEN_HEADER, TOKEN);
    other.set(INTERNAL_GRPC_CALLER_HEADER, 'core-svc');
    await expect(call((cb) => client.BlockTicketIssuance({ order_id: orderId, reason: 'EVENT_CANCELLED' }, other, {}, cb))).rejects.toMatchObject({
      code: grpc.status.PERMISSION_DENIED,
    });
    // purchase-svc는 받는다
    expect((await block(orderId)).already_entered).toBe(0);
  });
});
