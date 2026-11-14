// ops-svc 회차 취소 환불 gRPC 명령(BAT-425 GAT-130) 단위 시험.
// EVENT_CANCEL은 StartEventRefund, EVENT_REFUND_PAUSE·RESUME은 같은 작업의 멈춤·재개로 간다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { HttpCommandExecutor } from '../src/adapters/http-command-executor.js';
import type { EventRefundJobView, EventRefundStarter } from '../src/adapters/grpc-event-refunds.js';
import type { Command, CommandExecutionActor } from '../src/modules/commands/domain/command.js';

const NOW = Date.parse('2026-11-15T01:00:00.000Z');
const REQUESTER = '0193a000-0000-7000-8000-000000000001';
const APPROVER = '0193a000-0000-7000-8000-000000000002';
const SESSION = '0193a000-0000-7000-8000-000000000003';
const EVENT = '0193a000-0000-7000-8000-000000000004';
const actor: CommandExecutionActor = { accountId: APPROVER, sessionId: SESSION, role: 'commander' };

const command = (type: Command['type'], params: Record<string, unknown>): Command => ({
  commandId: randomUUID(),
  type,
  state: 'APPROVED',
  reason: '회차 취소',
  params,
  requestedBy: REQUESTER,
  requestedRole: 'operator',
  eventId: EVENT,
  createdAtMs: NOW,
  updatedAtMs: NOW,
  approvals: [APPROVER],
  attempts: 0,
});

const fake = () => {
  const calls: Array<{ method: string; q: unknown }> = [];
  const view = (jobId: string): EventRefundJobView => ({ jobId, state: 'RUNNING' });
  const refunds: EventRefundStarter = {
    start: async (q) => {
      calls.push({ method: 'start', q });
      return { ...view(q.requestId), state: q.kind === 'POSTPONE' ? 'REFUND_WINDOW' : 'RUNNING', ...(q.postponedToMs !== undefined ? { refundWindowClosesAtMs: q.postponedToMs } : {}) };
    },
    pause: async (q) => {
      calls.push({ method: 'pause', q });
      return view(q.requestId);
    },
    resume: async (q) => {
      calls.push({ method: 'resume', q });
      return view(q.requestId);
    },
    get: async (q) => {
      calls.push({ method: 'get', q });
      return view(q.requestId);
    },
  };
  return { calls, refunds, executor: new HttpCommandExecutor({ refunds }) };
};

describe('GAT-130 ops 회차 취소 환불 명령', () => {
  test('GAT130_EVENT_CANCEL은_명령_ID를_멱등_키로_gRPC_StartEventRefund를_부른다', async () => {
    const f = fake();
    const c = command('EVENT_CANCEL', { eventId: EVENT, fault: 'ORGANIZER', fanNoticeReason: '공연 취소' });
    const r = await f.executor.execute(c, actor);
    expect(r).toMatchObject({ status: 'SUCCEEDED', detail: { target: 'purchase-svc', transport: 'grpc', jobId: c.commandId } });
    expect(f.calls[0]).toMatchObject({
      method: 'start',
      q: { eventId: EVENT, requestId: c.commandId, fault: 'ORGANIZER', ruledBy: REQUESTER, confirmedBy: APPROVER, kind: 'CANCEL', fanNoticeReason: '공연 취소' },
    });
  });

  test('GAT130_연기_EVENT_CANCEL은_바뀐_시작과_신청_창을_싣는다', async () => {
    const f = fake();
    const c = command('EVENT_CANCEL', { eventId: EVENT, fault: 'CONTENT_CHANGE', kind: 'POSTPONE', postponedToMs: NOW + 86_400_000 });
    const r = await f.executor.execute(c, actor);
    expect(r).toMatchObject({ status: 'SUCCEEDED', detail: { state: 'REFUND_WINDOW' } });
    expect(f.calls[0]).toMatchObject({ method: 'start', q: { kind: 'POSTPONE', postponedToMs: NOW + 86_400_000 } });
  });

  test('GAT130_수동_재개는_EVENT_REFUND_RESUME이_같은_작업_ID로_부른다', async () => {
    const f = fake();
    const requestId = randomUUID();
    const r = await f.executor.execute(command('EVENT_REFUND_RESUME', { requestId, pg: 'TOSS' }), actor);
    expect(r).toMatchObject({ status: 'SUCCEEDED', detail: { transport: 'grpc', jobId: requestId } });
    expect(f.calls[0]).toMatchObject({ method: 'resume', q: { requestId, pg: 'TOSS' } });
  });

  test('GAT130_수동_일시정지는_EVENT_REFUND_PAUSE가_사유와_함께_부른다', async () => {
    const f = fake();
    const requestId = randomUUID();
    const r = await f.executor.execute(command('EVENT_REFUND_PAUSE', { requestId }), actor);
    expect(r.status).toBe('SUCCEEDED');
    expect(f.calls[0]).toMatchObject({ method: 'pause', q: { requestId, reason: '회차 취소' } });
  });

  test('GAT130_작업_ID가_없으면_재개는_실패하고_아무것도_부르지_않는다', async () => {
    const f = fake();
    const r = await f.executor.execute(command('EVENT_REFUND_RESUME', {}), actor);
    expect(r).toEqual({ status: 'FAILED', error: 'invalid-event-refund-params' });
    expect(f.calls).toHaveLength(0);
  });

  test('GAT130_gRPC_클라이언트가_없으면_재개는_target_not_wired다', async () => {
    const executor = new HttpCommandExecutor({});
    const r = await executor.execute(command('EVENT_REFUND_RESUME', { requestId: randomUUID() }), actor);
    expect(r).toEqual({ status: 'FAILED', error: 'target-not-wired' });
  });
});
