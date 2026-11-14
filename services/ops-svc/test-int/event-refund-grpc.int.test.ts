// ops-svc → purchase-svc 회차 취소 환불 gRPC 클라이언트(BAT-425 GAT-130) 실제 gRPC 통합 시험.
// refund.proto 설명자로 작은 서버를 띄워 Start·Pause·Resume·Get의 칸 이름과 enum 매핑을 본다(DB 없음).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Refund } from '@peaket/contracts/proto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GrpcEventRefunds } from '../src/adapters/grpc-event-refunds.js';

const NOW = Date.parse('2026-11-15T01:00:00.000Z');
const EVENT = '0193a000-0000-7000-8000-000000000004';
const REQUEST = '0193a000-0000-7000-8000-000000000001';

const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = grpc.handleUnaryCall<Record<string, unknown>, Record<string, unknown>>;
type Pkg = { EventRefundService: grpc.ServiceClientConstructor };
const received: Array<{ method: string; req: Record<string, unknown> }> = [];

let server: grpc.Server;
let client: GrpcEventRefunds;

beforeAll(async () => {
  const def = protoLoader.fromJSON(purchaseV1Refund as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS);
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: Pkg } } }).peaket.purchase.v1;
  const handler =
    (method: string, answer: (r: Record<string, unknown>) => Record<string, unknown>): Unary =>
    (call, cb) => {
      received.push({ method, req: call.request });
      cb(null, answer(call.request));
    };
  server = new grpc.Server();
  server.addService(pkg.EventRefundService.service, {
    StartEventRefund: handler('StartEventRefund', (r) => ({ job_id: r.cancellation_request_id, state: 'REFUND_JOB_STATE_RUNNING' })),
    GetEventRefundJob: handler('GetEventRefundJob', () => ({ state: 'REFUND_JOB_STATE_RUNNING', total_orders: 1, done_orders: 0, failed_orders: 0, not_applied_orders: 0, applied_orders: 1 })),
    PauseEventRefundJob: handler('PauseEventRefundJob', () => ({ state: 'REFUND_JOB_STATE_PAUSED' })),
    ResumeEventRefundJob: handler('ResumeEventRefundJob', () => ({ state: 'REFUND_JOB_STATE_RUNNING' })),
    PreviewEventRefund: handler('PreviewEventRefund', () => ({ target_orders: 1 })),
    ApplyEventRefund: handler('ApplyEventRefund', () => ({ accepted: true, state: 'REFUND_JOB_STATE_RUNNING' })),
    CloseEventRefundWindow: handler('CloseEventRefundWindow', () => ({ state: 'REFUND_JOB_STATE_COMPLETED' })),
  });
  const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
  client = new GrpcEventRefunds({ address: `127.0.0.1:${port}` });
});

afterAll(async () => {
  client?.close();
  await new Promise<void>((resolve) => server?.tryShutdown(() => resolve()));
});

describe('BAT425 ops-svc 환불 gRPC 클라이언트', () => {
  test('GAT130_Start는_명령_ID를_멱등_키로_보내고_연기_칸을_싣는다', async () => {
    const r = await client.start({
      eventId: EVENT,
      requestId: REQUEST,
      fault: 'CONTENT_CHANGE',
      ruledBy: 'operator-1',
      confirmedBy: 'commander-2',
      kind: 'POSTPONE',
      postponedToMs: NOW + 7 * 86_400_000,
      refundWindowClosesAtMs: NOW + 3 * 86_400_000,
      fanNoticeReason: '공연 연기',
    });
    expect(r).toMatchObject({ jobId: REQUEST, state: 'RUNNING' });
    expect(received[0]).toMatchObject({
      method: 'StartEventRefund',
      req: {
        event_id: EVENT,
        cancellation_request_id: REQUEST,
        ruling: 'CANCELLATION_RULING_CONTENT_CHANGE',
        ruled_by: 'operator-1',
        confirmed_by: 'commander-2',
        kind: 'EVENT_REFUND_KIND_POSTPONE',
        fan_notice_reason: '공연 연기',
      },
    });
    expect(received[0]!.req.postponed_to).toMatchObject({ seconds: Math.floor((NOW + 7 * 86_400_000) / 1000) });
    expect(received[0]!.req.refund_window_closes_at).toMatchObject({ seconds: Math.floor((NOW + 3 * 86_400_000) / 1000) });
  });

  test('GAT130_주최_귀책_판정은_ORGANIZER_enum으로_보낸다', async () => {
    await client.start({ eventId: EVENT, requestId: REQUEST, fault: 'ORGANIZER', ruledBy: 'operator-1', confirmedBy: 'commander-2' });
    expect(received.at(-1)).toMatchObject({ method: 'StartEventRefund', req: { ruling: 'CANCELLATION_RULING_ORGANIZER', kind: 'EVENT_REFUND_KIND_CANCEL' } });
  });

  test('GAT130_Pause와_Resume은_결제사_몫과_사유를_보낸다', async () => {
    await client.pause({ requestId: REQUEST, pg: 'TOSS', reason: '결제사 장애' });
    expect(received.at(-1)).toMatchObject({ method: 'PauseEventRefundJob', req: { job_id: REQUEST, pg: 'PG_PROVIDER_TOSS', reason: '결제사 장애' } });
    await client.resume({ requestId: REQUEST, pg: 'PORTONE', reason: '정상 확인' });
    expect(received.at(-1)).toMatchObject({ method: 'ResumeEventRefundJob', req: { job_id: REQUEST, pg: 'PG_PROVIDER_PORTONE', reason: '정상 확인' } });
  });

  test('GAT130_Get은_진행률과_상태를_읽는다', async () => {
    const r = await client.get({ requestId: REQUEST });
    expect(r).toMatchObject({ jobId: REQUEST, state: 'RUNNING' });
    expect(received.at(-1)).toMatchObject({ method: 'GetEventRefundJob', req: { job_id: REQUEST } });
  });
});
