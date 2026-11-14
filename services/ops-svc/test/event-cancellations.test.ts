// 회차 취소 요청·판정·2인 확정(BAT-425 GAT-130 잔여, FR-055, POL-038) 단위 시험.
import { describe, expect, test } from 'vitest';
import { EventCancellations } from '../src/modules/event-cancellations/application/event-cancellations.js';
import { MemoryEventCancellationStore } from '../src/modules/event-cancellations/adapters/memory-store.js';
import type { EventRefundStarter } from '../src/modules/event-cancellations/domain/ports.js';

const EVENT = '01900000-0000-7000-8000-000000000001';
const COMMANDER = { accountId: '01900000-0000-7000-8000-000000000002', role: 'commander' };
const OPERATOR = { accountId: '01900000-0000-7000-8000-000000000003', role: 'operator' };
const NOW = Date.parse('2026-11-15T08:00:00.000Z');

const fixture = (withRefunds = true) => {
  const store = new MemoryEventCancellationStore();
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
  const app = new EventCancellations(store, withRefunds ? refunds : undefined, () => NOW);
  return { store, calls, app };
};

describe('회차 취소 요청 [BAT-425]', () => {
  test('commander가 요청하고 판정한 뒤 판정자가 아닌 operator가 확정하면 일괄 환불을 시작한다', async () => {
    const f = fixture();
    const r = await f.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER);
    expect(r).toMatchObject({ eventId: EVENT, kind: 'CANCEL', status: 'REQUESTED' });
    const j = await f.app.judge(r.requestId, { fault: 'ORGANIZER', reason: '주최 측 사정', fanNoticeReason: '공연이 취소되었습니다' }, COMMANDER);
    expect(j).toMatchObject({ status: 'JUDGED', fault: 'ORGANIZER' });
    await expect(f.app.approve(r.requestId, COMMANDER)).rejects.toMatchObject({ type: 'approver-ineligible', status: 403 });
    const a = await f.app.approve(r.requestId, OPERATOR);
    expect(a).toMatchObject({ status: 'RUNNING', progress: { state: 'RUNNING' } });
    expect(f.calls).toEqual([`start:${r.requestId}:ORGANIZER`]);
    await expect(f.app.judge(r.requestId, { fault: 'ORGANIZER', reason: '뒤', fanNoticeReason: '뒤' }, COMMANDER)).rejects.toMatchObject({ type: 'judgement-not-allowed', status: 409 });
  });

  test('판정 전 확정은 409이고, 같은 회차의 진행 중 요청은 하나만 받는다', async () => {
    const f = fixture();
    const r = await f.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER);
    await expect(f.app.approve(r.requestId, OPERATOR)).rejects.toMatchObject({ type: 'judgement-required', status: 409 });
    await expect(f.app.request({ eventId: EVENT, reason: '또' }, COMMANDER)).rejects.toMatchObject({ type: 'sale-not-suspended', status: 409 });
  });

  test('판정 뒤 반려는 재판정 대기(REQUESTED)로 돌리고, 확정 뒤 반려는 409다', async () => {
    const f = fixture();
    const r = await f.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER);
    await f.app.judge(r.requestId, { fault: 'FORCE_MAJEURE', reason: '불가항력', fanNoticeReason: '공연이 취소되었습니다' }, COMMANDER);
    const rej = await f.app.reject(r.requestId, OPERATOR, '증빙 부족');
    expect(rej).toMatchObject({ status: 'REQUESTED' });
    expect(rej.fault).toBeUndefined();
    await f.app.judge(r.requestId, { fault: 'ORGANIZER', reason: '재판정', fanNoticeReason: '공연이 취소되었습니다' }, COMMANDER);
    await f.app.approve(r.requestId, OPERATOR);
    await expect(f.app.reject(r.requestId, OPERATOR, '늦음')).rejects.toMatchObject({ type: 'already-approved', status: 409 });
  });

  test('멈춤·재개는 purchase-svc 일괄 환불에 그대로 잇고, 실행기가 없으면 503이다', async () => {
    const f = fixture();
    const r = await f.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER);
    await f.app.judge(r.requestId, { fault: 'CONTENT_CHANGE', reason: '내용 변경', fanNoticeReason: '공연 내용이 바뀌었습니다' }, COMMANDER);
    await f.app.approve(r.requestId, OPERATOR);
    expect(await f.app.pause(r.requestId, COMMANDER, { pg: 'TOSS', reason: '수동' })).toMatchObject({ status: 'PAUSED' });
    expect(await f.app.resume(r.requestId, COMMANDER, { pg: 'TOSS', reason: '재개' })).toMatchObject({ status: 'RUNNING' });
    expect(f.calls).toEqual([`start:${r.requestId}:CONTENT_CHANGE`, `pause:${r.requestId}:TOSS`, `resume:${r.requestId}:TOSS`]);

    const g = fixture(false);
    const q = await g.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER);
    await g.app.judge(q.requestId, { fault: 'ORGANIZER', reason: 'x', fanNoticeReason: '공연이 취소되었습니다' }, COMMANDER);
    await expect(g.app.approve(q.requestId, OPERATOR)).rejects.toMatchObject({ type: 'event-refund-unavailable', status: 503 });
  });
});
