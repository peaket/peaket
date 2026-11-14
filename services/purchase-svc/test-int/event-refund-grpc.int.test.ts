// purchase-svc 회차 취소 일괄 환불 gRPC(refund.proto, BAT-425 GAT-130) 통합 시험.
// 실제 gRPC 서버·클라이언트로 Start·Get·Pause·Apply·CloseWindow의 칸 매핑과 상태 코드를 본다(DB 없이 메모리 저장소).
import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MemoryEventRefundStore } from '../src/modules/refund/adapters/memory-event-refund-store.js';
import { EventRefundService } from '../src/modules/refund/application/event-refund-service.js';
import { EventRefundGrpcController, eventRefundPackage } from '../src/modules/refund/inbound/event-refund.grpc.js';
import type { EventRefundCanceller, EventRefundTargets } from '../src/modules/refund/domain/event-refund-ports.js';
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
  return { calls, service: new EventRefundService({ store: new MemoryEventRefundStore(), targets, canceller, nowMs: () => NOW, deadlineMs: () => NOW + 5_000, concurrency: 2 }) };
};

let server: Awaited<ReturnType<typeof startPurchaseGrpcServer>>;
let client: Client;
const call = (method: keyof Client, req: object): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => (client[method] as Unary)(req, new grpc.Metadata(), {}, (e, v) => (e ? reject(e) : resolve(v ?? {}))));
const ts = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: 0 });

beforeAll(async () => {
  const s = service();
  server = await startPurchaseGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: eventRefundPackage().EventRefundService.service, handlers: new EventRefundGrpcController(s.service).handlers() }],
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
});
