// 결제 확정 뒤 발권 호출 어댑터 시험(BUILD_ORDER HOT-160, BAT-050). 실제 Saga 연결 전 계약·재시도 분류만 본다.
import * as grpc from '@grpc/grpc-js';
import { describe, expect, test } from 'vitest';
import { TicketGrpcIssuer } from '../src/modules/payment/adapters/ticket-grpc-issuer.js';
import { ticketIssueFailureOf } from '../src/modules/payment/domain/ticket-issuer.js';

const ORDER = '0190f3a1-7c2e-7a00-8000-000000000001';
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';
const SEAT = '0190f3a1-7c2e-7a00-8000-000000000004';
const TICKET = '0190f3a1-7c2e-7a00-8000-000000000005';
const input = { orderId: ORDER, eventId: EVENT, payerAccountId: ACCOUNT, seatIds: [SEAT], issueGeneration: 0, eventStartsAtMs: 1_700_000_000_123 };

interface Call {
  req: Record<string, unknown>;
  options: grpc.CallOptions;
}

function fake(handler: (cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void) => void) {
  const calls: Call[] = [];
  return {
    calls,
    issueTickets(req: Record<string, unknown>, options: grpc.CallOptions, cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void) {
      calls.push({ req, options });
      handler(cb);
    },
  };
}

describe('TicketGrpcIssuer [HOT-160]', () => {
  test('IssueTickets 요청을 proto 이름으로 옮기고 발권 결과를 돌려준다', async () => {
    const client = fake((cb) => cb(null, { tickets: [{ ticket_id: TICKET, seat_id: SEAT, status: 'TICKET_STATUS_ISSUED' }] }));
    const issuer = new TicketGrpcIssuer({ address: 'unused', client });
    const r = await issuer.issue(input, { remainingMs: 500 });
    expect(r).toEqual({ kind: 'issued', tickets: [{ ticketId: TICKET, seatId: SEAT, status: 'ISSUED' }] });
    expect(client.calls[0]!.req).toMatchObject({ order_id: ORDER, event_id: EVENT, payer_account_id: ACCOUNT, seat_ids: [SEAT], issue_generation: 0 });
    expect(client.calls[0]!.req.event_starts_at).toEqual({ seconds: 1_700_000_000, nanos: 123_000_000 });
    expect(client.calls[0]!.options.deadline).toBeGreaterThan(Date.now());
  });

  test('UNAVAILABLE·DEADLINE_EXCEEDED·RESOURCE_EXHAUSTED만 다시 보내고, 거절은 rejected다', async () => {
    const unavailable = fake((cb) => cb(Object.assign(new Error('down'), { code: grpc.status.UNAVAILABLE, details: 'down', metadata: new grpc.Metadata() }), {}));
    expect(await new TicketGrpcIssuer({ address: 'unused', client: unavailable }).issue(input)).toMatchObject({ kind: 'failed', failure: 'unavailable' });
    const rejected = fake((cb) => cb(Object.assign(new Error('blocked'), { code: grpc.status.FAILED_PRECONDITION, details: 'blocked', metadata: new grpc.Metadata() }), {}));
    expect(await new TicketGrpcIssuer({ address: 'unused', client: rejected }).issue(input)).toMatchObject({ kind: 'failed', failure: 'rejected' });
    expect(ticketIssueFailureOf(grpc.status.DEADLINE_EXCEEDED)).toBe('deadline');
    expect(ticketIssueFailureOf(grpc.status.RESOURCE_EXHAUSTED)).toBe('resource_exhausted');
    expect(ticketIssueFailureOf(grpc.status.INTERNAL)).toBe('unknown');
  });

  test('남은 시간이 없으면 호출하지 않고 deadline으로 끝내며, 빈 응답·좌석 불일치는 unknown이다', async () => {
    const client = fake((cb) => cb(null, { tickets: [] }));
    expect(await new TicketGrpcIssuer({ address: 'unused', client }).issue(input, { remainingMs: 0 })).toMatchObject({ kind: 'failed', failure: 'deadline' });
    expect(client.calls).toHaveLength(0);
    expect(await new TicketGrpcIssuer({ address: 'unused', client }).issue(input)).toMatchObject({ kind: 'failed', failure: 'unknown' });
    const wrong = fake((cb) => cb(null, { tickets: [{ ticket_id: TICKET, seat_id: '0190f3a1-7c2e-7a00-8000-000000000099', status: 'TICKET_STATUS_ISSUED' }] }));
    expect(await new TicketGrpcIssuer({ address: 'unused', client: wrong }).issue(input)).toMatchObject({ kind: 'failed', failure: 'unknown' });
  });
});
