// 회차 취소 요청·판정·2인 확정(BAT-425 GAT-130 잔여, FR-055, POL-038) 단위 시험.
import { describe, expect, test } from 'vitest';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { EventCancellations, type EventCancellationReauth } from '../src/modules/event-cancellations/application/event-cancellations.js';
import { EventCancellationProblem } from '../src/modules/event-cancellations/domain/event-cancellation.js';
import { MemoryEventCancellationStore } from '../src/modules/event-cancellations/adapters/memory-store.js';
import type { EventRefundStarter } from '../src/modules/event-cancellations/domain/ports.js';

const EVENT = '01900000-0000-7000-8000-000000000001';
const COMMANDER = { accountId: '01900000-0000-7000-8000-000000000002', sessionId: 's-c', role: 'commander' };
const OPERATOR = { accountId: '01900000-0000-7000-8000-000000000003', sessionId: 's-o', role: 'operator' };
const NOW = Date.parse('2026-11-15T08:00:00.000Z');
const tokenFor = (accountId: string, act = 'APPROVAL') => `${act}:${accountId}`;

const reauth: EventCancellationReauth = {
  verify: async (token, o) => {
    if (token === undefined) throw new EventCancellationProblem('reauth-required', 403, '다시 인증해 주세요');
    const [act, accountId] = token.split(':');
    if (act !== o.act) throw new EventCancellationProblem('reauth-required', 403, '다시 인증해 주세요');
    return { accountId: accountId ?? '', factors: ['password'] };
  },
};

const fixture = (withRefunds = true) => {
  const audit = new MemoryAuditChain();
  const store = new MemoryEventCancellationStore(audit);
  const calls: string[] = [];
  const refunds: EventRefundStarter = {
    start: async (i) => {
      calls.push(`start:${i.requestId}:${i.fault}`);
      return { jobId: i.requestId, state: 'RUNNING' };
    },
    pause: async (i) => {
      calls.push(`pause:${i.requestId}:${i.pg ?? 'ALL'}`);
      return { jobId: i.requestId, state: 'PAUSED' };
    },
    resume: async (i) => {
      calls.push(`resume:${i.requestId}:${i.pg ?? 'ALL'}`);
      return { jobId: i.requestId, state: 'RUNNING' };
    },
  };
  const app = new EventCancellations(store, withRefunds ? refunds : undefined, () => NOW, audit, reauth);
  return { store, calls, app, audit };
};

const approve = (f: ReturnType<typeof fixture>, requestId: string, actor = OPERATOR, token = tokenFor(OPERATOR.accountId)) => f.app.approve(requestId, actor, token);

describe('회차 취소 요청 [BAT-425]', () => {
  test('commander가 요청하고 판정한 뒤 판정자가 아닌 operator가 재인증 뒤 확정하면 일괄 환불을 시작한다', async () => {
    const f = fixture();
    const r = await f.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER);
    expect(r).toMatchObject({ eventId: EVENT, kind: 'CANCEL', status: 'REQUESTED' });
    const j = await f.app.judge(r.requestId, { fault: 'ORGANIZER', reason: '주최 측 사정', fanNoticeReason: '공연이 취소되었습니다' }, COMMANDER);
    expect(j).toMatchObject({ status: 'JUDGED', fault: 'ORGANIZER' });
    await expect(approve(f, r.requestId, COMMANDER)).rejects.toMatchObject({ type: 'approver-ineligible', status: 403 });
    const a = await approve(f, r.requestId);
    expect(a).toMatchObject({ status: 'RUNNING', progress: { state: 'RUNNING' } });
    expect(f.calls).toEqual([`start:${r.requestId}:ORGANIZER`]);
    await expect(f.app.judge(r.requestId, { fault: 'ORGANIZER', reason: '뒤', fanNoticeReason: '뒤' }, COMMANDER)).rejects.toMatchObject({ type: 'judgement-not-allowed', status: 409 });
    expect(f.audit.entries.map((e) => e.recordType)).toEqual(['EVENT_CANCELLATION_REQUESTED', 'EVENT_CANCELLATION_JUDGED', 'EVENT_CANCELLATION_APPROVED', 'EVENT_CANCELLATION_STARTED']);
  });

  test('SEC-02 확정은 재인증 토큰이 없거나 다른 계정·다른 동작이면 거절한다', async () => {
    const f = fixture();
    const r = await f.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER);
    await f.app.judge(r.requestId, { fault: 'ORGANIZER', reason: 'x', fanNoticeReason: '공연이 취소되었습니다' }, COMMANDER);
    await expect(f.app.approve(r.requestId, OPERATOR)).rejects.toMatchObject({ type: 'reauth-required', status: 403 });
    await expect(approve(f, r.requestId, OPERATOR, tokenFor(COMMANDER.accountId))).rejects.toMatchObject({ type: 'reauth-required', status: 403 });
    await expect(approve(f, r.requestId, OPERATOR, tokenFor(OPERATOR.accountId, 'WITHDRAW'))).rejects.toMatchObject({ type: 'reauth-required', status: 403 });
    expect(f.calls).toEqual([]);
  });

  test('판정 전 확정은 409이고, 같은 회차의 진행 중 요청은 하나만 받는다', async () => {
    const f = fixture();
    const r = await f.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER);
    await expect(approve(f, r.requestId)).rejects.toMatchObject({ type: 'judgement-required', status: 409 });
    await expect(f.app.request({ eventId: EVENT, reason: '또' }, COMMANDER)).rejects.toMatchObject({ type: 'sale-not-suspended', status: 409 });
  });

  test('판정 뒤 반려는 재판정 대기(REQUESTED)로 돌리고, 판정자 본인은 반려할 수 없다', async () => {
    const f = fixture();
    const r = await f.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER);
    await f.app.judge(r.requestId, { fault: 'FORCE_MAJEURE', reason: '불가항력', fanNoticeReason: '공연이 취소되었습니다' }, COMMANDER);
    await expect(f.app.reject(r.requestId, COMMANDER, '본인')).rejects.toMatchObject({ type: 'approver-ineligible', status: 403 });
    const rej = await f.app.reject(r.requestId, OPERATOR, '증빙 부족');
    expect(rej).toMatchObject({ status: 'REQUESTED' });
    expect(rej.fault).toBeUndefined();
    await f.app.judge(r.requestId, { fault: 'ORGANIZER', reason: '재판정', fanNoticeReason: '공연이 취소되었습니다' }, COMMANDER);
    await approve(f, r.requestId);
    await expect(f.app.reject(r.requestId, OPERATOR, '늦음')).rejects.toMatchObject({ type: 'already-approved', status: 409 });
  });

  test('M4-05 COMPLETED·REFUND_WINDOW를 RUNNING으로 뭉개지 않는다', async () => {
    for (const [jobState, status] of [['COMPLETED', 'COMPLETED'], ['REFUND_WINDOW', 'REFUND_WINDOW']] as const) {
      const audit = new MemoryAuditChain();
      const store = new MemoryEventCancellationStore(audit);
      const app = new EventCancellations(store, { start: async (i) => ({ jobId: i.requestId, state: jobState }), pause: async () => ({ jobId: '', state: 'PAUSED' }), resume: async () => ({ jobId: '', state: 'RUNNING' }) }, () => NOW, audit, reauth);
      const r = await app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER);
      await app.judge(r.requestId, { fault: 'ORGANIZER', reason: 'x', fanNoticeReason: '공연이 취소되었습니다' }, COMMANDER);
      expect(await approve({ app } as never, r.requestId)).toMatchObject({ status });
    }
  });

  test('동시 확정은 하나만 성공하고 다른 하나는 409다', async () => {
    const f = fixture();
    const r = await f.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER);
    await f.app.judge(r.requestId, { fault: 'ORGANIZER', reason: 'x', fanNoticeReason: '공연이 취소되었습니다' }, COMMANDER);
    const results = await Promise.allSettled([approve(f, r.requestId), approve(f, r.requestId)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((x) => x.status === 'rejected')).toMatchObject({ reason: { type: 'event-cancellation-conflict', status: 409 } });
  });

  test('멈춤·재개는 purchase-svc 일괄 환불에 그대로 잇고, 실행기가 없으면 503이다', async () => {
    const f = fixture();
    const r = await f.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER);
    await f.app.judge(r.requestId, { fault: 'CONTENT_CHANGE', reason: '내용 변경', fanNoticeReason: '공연 내용이 바뀌었습니다' }, COMMANDER);
    await approve(f, r.requestId);
    expect(await f.app.pause(r.requestId, COMMANDER, { pg: 'TOSS', reason: '수동' })).toMatchObject({ status: 'PAUSED' });
    expect(await f.app.resume(r.requestId, COMMANDER, { pg: 'TOSS', reason: '재개' })).toMatchObject({ status: 'RUNNING' });
    expect(f.calls).toEqual([`start:${r.requestId}:CONTENT_CHANGE`, `pause:${r.requestId}:TOSS`, `resume:${r.requestId}:TOSS`]);

    const g = fixture(false);
    const q = await g.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER);
    await g.app.judge(q.requestId, { fault: 'ORGANIZER', reason: 'x', fanNoticeReason: '공연이 취소되었습니다' }, COMMANDER);
    await expect(approve(g, q.requestId)).rejects.toMatchObject({ type: 'event-refund-unavailable', status: 503 });
  });
});
