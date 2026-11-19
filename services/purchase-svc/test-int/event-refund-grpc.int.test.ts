// purchase-svc 회차 취소 일괄 환불 gRPC(refund.proto, BAT-425 GAT-130) 통합 시험.
// 실제 gRPC 서버·클라이언트로 Start·Get·Pause·Apply·CloseWindow의 칸 매핑과 상태 코드를 본다(DB 없이 메모리 저장소).
import * as grpc from '@grpc/grpc-js';
import { INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MemoryEventRefundStore } from '../src/modules/refund/adapters/memory-event-refund-store.js';
import { EventRefundService } from '../src/modules/refund/application/event-refund-service.js';
import { EventRefundGrpcController, eventRefundPackage } from '../src/modules/refund/inbound/event-refund.grpc.js';
import type { EventRefundCanceller, EventRefundTargets } from '../src/modules/refund/domain/event-refund-ports.js';
import { EventRefundHoldError, type EventRefundHoldInput } from '../src/modules/refund/domain/event-refund-hold.js';
import { startPurchaseGrpcServer } from '../src/grpc-server.js';

const NOW = Date.parse('2026-11-15T01:00:00.000Z');
const DAY = 86_400_000;
const REQUEST = '0193a000-0000-7000-8000-000000000001';
const EVENT = '0193a000-0000-7000-8000-000000000002';
const T1 = '0193a000-0000-7000-8000-000000000011';
const T2 = '0193a000-0000-7000-8000-000000000012';

type Unary = (req: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type Client = grpc.Client & Record<'StartEventRefund' | 'GetEventRefundJob' | 'PauseEventRefundJob' | 'ResumeEventRefundJob' | 'ApplyEventRefund' | 'CloseEventRefundWindow', Unary>;

const target = (ticketId: string, pg: 'TOSS' | 'PORTONE' = 'TOSS') => ({
  orderId: `order-${ticketId}`,
  ticketId,
  seatId: `seat-${ticketId}`,
  payerAccountId: '0193a000-0000-7000-8000-000000000007',
  ticketPrice: 10_000,
  bookedAtMs: NOW - DAY,
  saleEndsAtMs: NOW + 7 * DAY,
  pg,
});

const service = (outcome: 'REFUNDED' | 'REFUND_PENDING' = 'REFUNDED') => {
  const calls: Parameters<EventRefundCanceller['cancel']>[] = [];
  const targets: EventRefundTargets = { list: async () => [target(T1), target(T2, 'PORTONE')] };
  const canceller: EventRefundCanceller = {
    cancel: async (t, q) => {
      calls.push([t, q]);
      return { status: outcome };
    },
  };
  const store = new MemoryEventRefundStore();
  return { calls, store, service: new EventRefundService({ store, targets, canceller, nowMs: () => NOW, deadlineMs: () => NOW + 5_000, concurrency: 2 }) };
};

let server: Awaited<ReturnType<typeof startPurchaseGrpcServer>>;
let client: Client;
let main: ReturnType<typeof service>;
const call = (method: keyof Client, req: object): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => (client[method] as Unary)(req, new grpc.Metadata(), {}, (e, v) => (e ? reject(e) : resolve(v ?? {}))));
const ts = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: 0 });

beforeAll(async () => {
  main = service();
  server = await startPurchaseGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: eventRefundPackage().EventRefundService.service, handlers: new EventRefundGrpcController(main.service).handlers() }],
  });
  client = new (eventRefundPackage().EventRefundService as unknown as new (address: string, credentials: grpc.ChannelCredentials) => Client)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure());
});

afterAll(async () => {
  client?.close();
  await server?.close();
});

describe('BAT425 refund.proto gRPC', () => {
  test('R-T9_StartEventRefund는_명령_ID를_job_ID로_돌려주고_Get은_진행률을_준다', async () => {
    const started = await call('StartEventRefund', {
      event_id: EVENT,
      cancellation_request_id: REQUEST,
      ruling: 'CANCELLATION_RULING_ORGANIZER',
      ruled_by: 'commander-1',
      confirmed_by: 'operator-2',
      kind: 'EVENT_REFUND_KIND_CANCEL',
    });
    expect(started).toMatchObject({ job_id: REQUEST, state: 'REFUND_JOB_STATE_COMPLETED' });
    const job = await call('GetEventRefundJob', { job_id: REQUEST });
    expect(job).toMatchObject({ total_orders: 2, done_orders: 2, failed_orders: 0, kind: 'EVENT_REFUND_KIND_CANCEL' });
    expect((job.per_pg as Array<{ pg: string }>).map((p) => p.pg).sort()).toEqual(['PG_PROVIDER_PORTONE', 'PG_PROVIDER_TOSS']);
  });

  test('R-T22_끝난_작업의_Pause는_FAILED_PRECONDITION이다', async () => {
    await expect(call('PauseEventRefundJob', { job_id: REQUEST, reason: '장애' })).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
  });

  test('R-T9_연기_Start는_신청_창을_열고_Apply는_신청한_티켓만_환급한다', async () => {
    const requestId = '0193a000-0000-7000-8000-000000000021';
    const started = await call('StartEventRefund', {
      event_id: EVENT,
      cancellation_request_id: requestId,
      ruling: 'CANCELLATION_RULING_CONTENT_CHANGE',
      ruled_by: 'commander-1',
      confirmed_by: 'operator-2',
      kind: 'EVENT_REFUND_KIND_POSTPONE',
      postponed_to: ts(NOW + 7 * DAY),
      refund_window_closes_at: ts(NOW + 3 * DAY),
    });
    expect(started).toMatchObject({ job_id: requestId, state: 'REFUND_JOB_STATE_REFUND_WINDOW' });
    const applied = await call('ApplyEventRefund', { request_id: requestId, ticket_id: T1, application_id: '0193a000-0000-7000-8000-000000000031', applied_at: ts(NOW) });
    expect(applied).toMatchObject({ accepted: true, total_orders: 2, done_orders: 1, not_applied_orders: 0 });
    const closed = await call('CloseEventRefundWindow', { request_id: requestId, closed_by: 'commander-1', reason: '기한 종료' });
    expect(closed).toMatchObject({ state: 'REFUND_JOB_STATE_COMPLETED', not_applied_orders: 1 });
  });

  test('GAT130_잘못된_요청은_INVALID_ARGUMENT다', async () => {
    await expect(call('StartEventRefund', { event_id: EVENT, cancellation_request_id: 'not-a-uuid', ruling: 'CANCELLATION_RULING_ORGANIZER', ruled_by: 'a', confirmed_by: 'b' })).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
    });
  });

  // RV-25(중간): ops-svc가 판정 미리보기에서 저장한 주문별 배상 목록을 StartEventRefund.compensation_orders로 되보낸다.
  // purchase-svc는 그 금액을 다시 계산하지 않고 저장해야 팬이 본 금액과 실제 지급액이 같다(계획 B13, ADR-0317 결정 2).
  test('R-T46 ②_RV25_StartEventRefund가_받은_compensation_orders_금액을_다시_계산하지_않고_저장한다', async () => {
    const requestId = '0193a000-0000-7000-8000-000000000051';
    const orderA = `order-${T1}`;
    // 대상 표 권면은 10,000원이라 다시 계산하면 1,000원이다. 보낸 2,001원이 그대로 저장돼야 한다
    await call('StartEventRefund', {
      event_id: EVENT,
      cancellation_request_id: requestId,
      ruling: 'CANCELLATION_RULING_ORGANIZER',
      ruled_by: 'commander-1',
      confirmed_by: 'operator-2',
      kind: 'EVENT_REFUND_KIND_CANCEL',
      compensation_orders: [{ order_id: orderA, base_amount: { krw: 20_002 }, amount: { krw: 2_001 } }],
    });
    const saved = main.store.requests.get(requestId)!;
    expect(saved.compensationTargets).toBe(1);
    expect(saved.compensationTotal).toBe(2_001);
    expect(main.store.compensations.filter((c) => c.eventCancellationRequestId === requestId).map((c) => ({ orderId: c.orderId, baseAmount: c.baseAmount, amount: c.amount }))).toEqual([
      { orderId: orderA, baseAmount: 20_002, amount: 2_001 },
    ]);
  });
});

// ---- BAT-420 몫 D(시험 담당, 구현 전에 씀): SetEventRefundHold 끝에서 끝까지(gRPC → 검사 → 미룸 저장소, OPEN[45], GAT-110 D3) ----
describe('SetEventRefundHold gRPC 끝에서 끝까지 [BAT-420 몫 D]', () => {
  const TOKEN = 'it-internal-grpc-token';
  const SEVEN_DAYS = 604_800_000;
  const OTHER = '0193a000-0000-7000-8000-000000000099';
  /** 회차마다 한 줄인 미룸 대역(같은 회차에 다른 요청의 열린 미룸이 있으면 ALREADY_EXISTS) — 실제 SQL은 event-refund.int가 본다 */
  const rows = new Map<string, { requestId: string; expiresAtMs: number; released: boolean }>();
  const holds = {
    set: async (i: EventRefundHoldInput) => {
      const cur = rows.get(i.eventId);
      if (i.held) {
        if (cur && !cur.released && cur.expiresAtMs > i.nowMs && cur.requestId !== i.cancellationRequestId) throw new EventRefundHoldError('ALREADY_EXISTS', '다른 요청의 미룸이 있다');
        rows.set(i.eventId, { requestId: i.cancellationRequestId, expiresAtMs: i.expiresAtMs!, released: false });
        return { held: true, expiresAtMs: i.expiresAtMs! };
      }
      if (cur && cur.requestId === i.cancellationRequestId) cur.released = true;
      const now = rows.get(i.eventId);
      return now && !now.released ? { held: true, expiresAtMs: now.expiresAtMs } : { held: false };
    },
    releaseExpired: async () => [],
  };
  let holdServer: Awaited<ReturnType<typeof startPurchaseGrpcServer>>;
  let holdClient: grpc.Client & { SetEventRefundHold: Unary };
  const md = (caller = 'ops-svc') => {
    const m = new grpc.Metadata();
    m.set(INTERNAL_GRPC_TOKEN_HEADER, TOKEN);
    m.set(INTERNAL_GRPC_CALLER_HEADER, caller);
    return m;
  };
  const setHold = (req: object, m = md()): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => holdClient.SetEventRefundHold(req, m, {}, (e, v) => (e ? reject(e) : resolve(v ?? {}))));

  beforeAll(async () => {
    const svc = new EventRefundService({
      store: new MemoryEventRefundStore(),
      targets: { list: async () => [] },
      canceller: { cancel: async () => ({ status: 'REFUNDED' }) },
      holds,
      nowMs: () => NOW,
      deadlineMs: () => NOW + 5_000,
    });
    holdServer = await startPurchaseGrpcServer({
      host: '127.0.0.1',
      port: 0,
      services: [{ definition: eventRefundPackage().EventRefundService.service, handlers: new EventRefundGrpcController(svc, { internalToken: TOKEN, nowMs: () => NOW }).handlers() }],
    });
    holdClient = new (eventRefundPackage().EventRefundService as unknown as new (address: string, credentials: grpc.ChannelCredentials) => grpc.Client & { SetEventRefundHold: Unary })(
      `127.0.0.1:${holdServer.port}`,
      grpc.credentials.createInsecure(),
    );
  });
  afterAll(async () => {
    holdClient?.close();
    await holdServer?.close();
  });

  test('GAT-110 D3 기한 = 지금은 INVALID_ARGUMENT, 지금 + 604,800,000ms는 받고, + 604,800,001ms는 INVALID_ARGUMENT다(경계)', async () => {
    const eventId = '0193a000-0000-7000-8000-000000000041';
    await expect(setHold({ event_id: eventId, cancellation_request_id: REQUEST, held: true, expires_at: ts(NOW) })).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    await expect(setHold({ event_id: eventId, cancellation_request_id: REQUEST, held: true, expires_at: { seconds: Math.floor((NOW + SEVEN_DAYS) / 1000), nanos: 1_000_000 } })).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
    });
    expect(rows.has(eventId)).toBe(false);
    await expect(setHold({ event_id: eventId, cancellation_request_id: REQUEST, held: true, expires_at: ts(NOW + SEVEN_DAYS) })).resolves.toMatchObject({ held: true });
    expect(rows.get(eventId)).toEqual({ requestId: REQUEST, expiresAtMs: NOW + SEVEN_DAYS, released: false });
  });

  test('GAT-110 D3 같은 회차에 다른 요청의 열린 미룸이면 ALREADY_EXISTS, 다른 요청 ID로 풀기는 그대로 걸림, 같은 요청 다시 걸기는 기한만 바뀌고, 다른 호출자는 PERMISSION_DENIED다', async () => {
    const eventId = '0193a000-0000-7000-8000-000000000042';
    await setHold({ event_id: eventId, cancellation_request_id: REQUEST, held: true, expires_at: ts(NOW + 259_200_000) });
    await expect(setHold({ event_id: eventId, cancellation_request_id: OTHER, held: true, expires_at: ts(NOW + 259_200_000) })).rejects.toMatchObject({ code: grpc.status.ALREADY_EXISTS });
    await expect(setHold({ event_id: eventId, cancellation_request_id: OTHER, held: false })).resolves.toMatchObject({ held: true });
    const extended = await setHold({ event_id: eventId, cancellation_request_id: REQUEST, held: true, expires_at: ts(NOW + 2 * 259_200_000) });
    expect(extended).toMatchObject({ held: true, expires_at: { seconds: Math.floor((NOW + 2 * 259_200_000) / 1000) } });
    await expect(setHold({ event_id: eventId, cancellation_request_id: REQUEST, held: false }, md('trust-svc'))).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    expect(rows.get(eventId)).toMatchObject({ released: false });
    await expect(setHold({ event_id: eventId, cancellation_request_id: REQUEST, held: false })).resolves.toMatchObject({ held: false });
    expect(rows.get(eventId)).toMatchObject({ requestId: REQUEST, released: true });
  });
});
