// ops-svc → purchase-svc 회차 취소 환불 gRPC 클라이언트(BAT-425 GAT-130) 실제 gRPC 통합 시험.
// refund.proto 설명자로 작은 서버를 띄워 Start·Pause·Resume·Get의 칸 이름과 enum 매핑을 본다(DB 없음).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Refund } from '@peaket/contracts/proto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { INTERNAL_GRPC_CALLER_HEADER } from '@peaket/platform';
import { GrpcEventRefunds } from '../src/adapters/grpc-event-refunds.js';

const NOW = Date.parse('2026-11-15T01:00:00.000Z');
const EVENT = '0193a000-0000-7000-8000-000000000004';
const REQUEST = '0193a000-0000-7000-8000-000000000001';

const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = grpc.handleUnaryCall<Record<string, unknown>, Record<string, unknown>>;
type Pkg = { EventRefundService: grpc.ServiceClientConstructor };
const received: Array<{ method: string; req: Record<string, unknown> }> = [];
/** GetEventRefundJob의 다음 답(BAT-420 W4가 진행률 칸을 바꿔 넣는다) */
let jobAnswer: Record<string, unknown> = { state: 'REFUND_JOB_STATE_RUNNING', total_orders: 1, done_orders: 0, failed_orders: 0, not_applied_orders: 0, applied_orders: 1 };
/** BAT-420 W4: 미리보기 답(칸마다 값을 다르게 골라 칸이 바뀌면 드러나게 한다) */
const PREVIEW_ANSWER = {
  target_orders: 3,
  refund_total: { krw: 133_332 },
  compensation_targets: 2,
  compensation_total: { krw: 13_335 },
  per_pg: [
    { pg: 'PG_PROVIDER_TOSS', orders: 1, estimated_seconds: 4 },
    { pg: 'PG_PROVIDER_PORTONE', orders: 2, estimated_seconds: 7 },
  ],
};

/** BAT-420 몫 D: SetEventRefundHold 대역의 다음 답·실패와 받은 호출자 머리 */
const holdServer = { fail: false, callers: [] as unknown[] };

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
    GetEventRefundJob: handler('GetEventRefundJob', () => jobAnswer),
    PauseEventRefundJob: handler('PauseEventRefundJob', () => ({ state: 'REFUND_JOB_STATE_PAUSED' })),
    ResumeEventRefundJob: handler('ResumeEventRefundJob', () => ({ state: 'REFUND_JOB_STATE_RUNNING' })),
    PreviewEventRefund: handler('PreviewEventRefund', () => PREVIEW_ANSWER),
    ApplyEventRefund: handler('ApplyEventRefund', () => ({ accepted: true, state: 'REFUND_JOB_STATE_RUNNING' })),
    SetEventRefundHold: (call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>, cb: grpc.sendUnaryData<Record<string, unknown>>) => {
      received.push({ method: 'SetEventRefundHold', req: call.request });
      holdServer.callers.push(call.metadata.get(INTERNAL_GRPC_CALLER_HEADER)[0]);
      if (holdServer.fail) {
        cb({ code: grpc.status.UNAVAILABLE, details: 'purchase-svc down' });
        return;
      }
      const held = call.request.held === true;
      cb(null, held ? { held: true, expires_at: call.request.expires_at } : { held: false });
    },
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

  // BAT-420 GAT-110 W4: 판정 미리보기와 상세 진행률. 시험 담당이 구현 전에 썼다(Docker 없이 도는 gRPC 통합 시험).
  test('GAT-110 W4 Preview는 회차·요청·판정 enum을 보내고 답의 Money를 원으로, 결제사별 주문 수·예상 시간을 읽는다', async () => {
    const r = await client.preview({ eventId: EVENT, requestId: REQUEST, fault: 'ORGANIZER' });
    expect(received.at(-1)).toMatchObject({ method: 'PreviewEventRefund', req: { event_id: EVENT, cancellation_request_id: REQUEST, ruling: 'CANCELLATION_RULING_ORGANIZER' } });
    expect(r).toEqual({
      targetOrders: 3,
      refundTotal: 133_332,
      compensationTargets: 2,
      compensationTotal: 13_335,
      perPg: [
        { pg: 'TOSS', orders: 1, estimatedSeconds: 4 },
        { pg: 'PORTONE', orders: 2, estimatedSeconds: 7 },
      ],
    });
    await client.preview({ eventId: EVENT, requestId: REQUEST, fault: 'FORCE_MAJEURE' });
    expect(received.at(-1)!.req).toMatchObject({ ruling: 'CANCELLATION_RULING_FORCE_MAJEURE' });
  });

  test('GAT-110 W4 진행률 읽기는 결제사 몫마다 상태·멈춘 이유·끝남·실패·결과 모름과 연기 신청 수·신청 창 닫힘을 읽는다', async () => {
    const closesAtMs = NOW + 7 * 86_400_000 + 250;
    jobAnswer = {
      state: 'REFUND_JOB_STATE_PAUSED',
      total_orders: 30,
      done_orders: 8,
      failed_orders: 5,
      per_pg: [
        { pg: 'PG_PROVIDER_TOSS', state: 'REFUND_JOB_STATE_RUNNING', pause_reason: 'REFUND_PAUSE_REASON_UNSPECIFIED', done_orders: 5, failed_orders: 1, unknown_orders: 2, not_applied_orders: 0 },
        { pg: 'PG_PROVIDER_PORTONE', state: 'REFUND_JOB_STATE_PAUSED', pause_reason: 'REFUND_PAUSE_REASON_AUTO_CIRCUIT_OPEN', done_orders: 3, failed_orders: 4, unknown_orders: 6, not_applied_orders: 0 },
      ],
      kind: 'EVENT_REFUND_KIND_POSTPONE',
      refund_window_closes_at: { seconds: Math.floor(closesAtMs / 1000), nanos: (closesAtMs % 1000) * 1_000_000 },
      not_applied_orders: 0,
      applied_orders: 9,
    };
    const r = await client.job({ requestId: REQUEST });
    expect(received.at(-1)).toMatchObject({ method: 'GetEventRefundJob', req: { job_id: REQUEST } });
    expect(r).toMatchObject({ state: 'PAUSED', total: 30, done: 8, failed: 5, appliedOrders: 9, refundWindowClosesAt: new Date(closesAtMs).toISOString() });
    expect(r.perPg).toHaveLength(2);
    expect(r.perPg[0]).toMatchObject({ pg: 'TOSS', state: 'RUNNING', done: 5, failed: 1, unknown: 2 });
    expect(r.perPg[0]!.pauseReason).toBeUndefined();
    expect(r.perPg[1]).toEqual({ pg: 'PORTONE', state: 'PAUSED', pauseReason: 'AUTO_CIRCUIT_OPEN', done: 3, failed: 4, unknown: 6 });
  });

  // BAT-420 몫 D(OPEN[45] 결정): 회차 취소 요청 중 보류 취소의 환급 미룸. 시험 담당이 구현 전에 썼다(Docker 없이 도는 gRPC 시험).
  test('R-T38 ⑥ 미룸 걸기는 SetEventRefundHold에 회차·요청 ID·held 참·기한 Timestamp를 호출자 머리 ops-svc로 보내고 답의 held를 읽는다', async () => {
    const expiresAtMs = NOW + 259_200_000 + 250;
    holdServer.fail = false;
    holdServer.callers.length = 0;
    expect(await client.hold({ eventId: EVENT, requestId: REQUEST, held: true, expiresAtMs })).toEqual({ held: true });
    expect(received.at(-1)).toMatchObject({
      method: 'SetEventRefundHold',
      req: { event_id: EVENT, cancellation_request_id: REQUEST, held: true, expires_at: { seconds: Math.floor(expiresAtMs / 1000), nanos: (expiresAtMs % 1000) * 1_000_000 } },
    });
    expect(holdServer.callers).toEqual(['ops-svc']);
  });

  test('R-T38 ② 미룸 풀기는 held 거짓만 보내고 기한을 싣지 않는다', async () => {
    holdServer.fail = false;
    expect(await client.hold({ eventId: EVENT, requestId: REQUEST, held: false })).toEqual({ held: false });
    const req = received.at(-1)!.req;
    expect(req).toMatchObject({ event_id: EVENT, cancellation_request_id: REQUEST, held: false });
    expect(req.expires_at ?? null).toBeNull();
  });

  test('R-T38 ⑥ purchase-svc가 UNAVAILABLE이면 미룸 호출은 던진다(부른 쪽이 요청을 저장하지 않고 503을 준다)', async () => {
    // 대조: 서버가 받으면 답을 읽는다
    holdServer.fail = false;
    expect(await client.hold({ eventId: EVENT, requestId: REQUEST, held: true, expiresAtMs: NOW + 259_200_000 })).toEqual({ held: true });
    holdServer.fail = true;
    try {
      await expect(client.hold({ eventId: EVENT, requestId: REQUEST, held: true, expiresAtMs: NOW + 259_200_000 })).rejects.toBeDefined();
    } finally {
      holdServer.fail = false;
    }
  });
});
