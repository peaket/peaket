// 회차 취소 계약 회귀 시험(R-597·R-614): 외부 환불 전 RUNNING 선저장, 실패 롤백, 동시 확정 1회,
// 전이별 감사, 재인증 강제. 되돌릴 수 없는 전액 환불이라 상태·순서·감사·승인자 결속을 함께 고정한다.
import { describe, expect, test } from 'vitest';
import { MemoryAuditChain, type AuditRecord } from '../src/modules/audit/index.js';
import {
  EventCancellations,
  EventCancellationProblem,
  MemoryEventCancellationStore,
  type EventCancellationReauth,
  type EventCancellationRecord,
  type EventRefundJobView,
  type EventRefundStarter,
} from '../src/modules/event-cancellations/index.js';

const NOW = Date.parse('2026-11-15T08:00:00.000Z');
const EVENT1 = '0193d000-0000-7000-8000-000000000001';
const EVENT2 = '0193d000-0000-7000-8000-000000000002';
const COMMANDER = { accountId: '0193d000-0000-7000-8000-000000000011', sessionId: 's-c', role: 'commander' };
const OPERATOR = { accountId: '0193d000-0000-7000-8000-000000000012', sessionId: 's-o', role: 'operator' };
const OTHER = { accountId: '0193d000-0000-7000-8000-000000000013', sessionId: 's-o2', role: 'commander' };
const tokenFor = (accountId: string, act = 'APPROVAL') => `${act}:${accountId}`;

class SpyStore extends MemoryEventCancellationStore {
  readonly saves: Array<{ record: EventCancellationRecord; audit: AuditRecord | undefined }> = [];
  override async save(record: EventCancellationRecord, audit?: AuditRecord): Promise<boolean> {
    this.saves.push({ record, audit });
    return super.save(record, audit);
  }
}

const reauthOf = (): EventCancellationReauth => ({
  verify: async (token, o) => {
    if (token === undefined) throw new EventCancellationProblem('reauth-required', 403, '다시 인증해 주세요');
    const [act, accountId] = token.split(':');
    if (act !== o.act) throw new EventCancellationProblem('reauth-required', 403, '다시 인증해 주세요');
    return { accountId: accountId ?? '', factors: ['passkey'] };
  },
});

const fixture = (
  o: { start?: EventRefundStarter['start']; pause?: EventRefundStarter['pause']; resume?: EventRefundStarter['resume']; reauth?: EventCancellationReauth | null } = {},
) => {
  const audit = new MemoryAuditChain();
  const store = new SpyStore(audit);
  const calls: string[] = [];
  const refunds: EventRefundStarter = {
    start: async (i) => {
      calls.push(`start:${i.requestId}`);
      return o.start ? o.start(i) : { jobId: i.requestId, state: 'RUNNING' };
    },
    pause: async (i) => {
      calls.push(`pause:${i.requestId}:${i.pg ?? 'ALL'}`);
      return o.pause ? o.pause(i) : { jobId: i.requestId, state: 'PAUSED' };
    },
    resume: async (i) => {
      calls.push(`resume:${i.requestId}:${i.pg ?? 'ALL'}`);
      return o.resume ? o.resume(i) : { jobId: i.requestId, state: 'RUNNING' };
    },
  };
  const reauth = o.reauth === null ? undefined : (o.reauth ?? reauthOf());
  const app = new EventCancellations(store, refunds, () => NOW, audit, reauth);
  return { audit, store, calls, app };
};

const createJudged = async (f: ReturnType<typeof fixture>, eventId = EVENT1) => {
  const r = await f.app.request({ eventId, reason: '공연 취소' }, COMMANDER);
  await f.app.judge(r.requestId, { fault: 'ORGANIZER', reason: '주최 귀책', fanNoticeReason: '공연이 취소되었습니다' }, COMMANDER);
  return r.requestId;
};

const approve = (f: ReturnType<typeof fixture>, requestId: string, actor = OPERATOR, token = tokenFor(OPERATOR.accountId)) => f.app.approve(requestId, actor, token);

describe('OPS-07 회차 취소 확정 순서·동시성', () => {
  test('외부 환불 시작 전에 RUNNING으로 저장되고 시작 시점의 상태가 RUNNING이다', async () => {
    let observed: { status?: string; version?: number; approvedBy?: string | null } | undefined;
    const f = fixture({
      start: async (i) => {
        const row = f.store.rows.get(i.requestId);
        observed = row ? { status: row.status, version: row.version, approvedBy: row.approvedBy } : undefined;
        return { jobId: i.requestId, state: 'RUNNING' };
      },
    });
    const requestId = await createJudged(f);
    const view = await approve(f, requestId);
    expect(view).toMatchObject({ status: 'RUNNING', progress: { state: 'RUNNING' } });
    expect(observed).toEqual({ status: 'RUNNING', version: 3, approvedBy: OPERATOR.accountId });
    expect(f.store.rows.get(requestId)).toMatchObject({ status: 'RUNNING', approvedBy: OPERATOR.accountId, version: 4 });
  });

  test('외부 환불 시작이 실패하면 JUDGED로 되돌려 다시 시도할 수 있고 실패 감사를 남긴다', async () => {
    let fail = true;
    const f = fixture({
      start: async (i) => {
        if (fail) throw new Error('purchase down');
        return { jobId: i.requestId, state: 'RUNNING' };
      },
    });
    const requestId = await createJudged(f);
    await expect(approve(f, requestId)).rejects.toThrow('purchase down');
    expect(f.store.rows.get(requestId)).toMatchObject({ status: 'JUDGED', approvedBy: null, approvedAt: null, version: 4 });
    expect(f.audit.entries.map((e) => e.recordType)).toEqual([
      'EVENT_CANCELLATION_REQUESTED',
      'EVENT_CANCELLATION_JUDGED',
      'EVENT_CANCELLATION_APPROVED',
      'EVENT_CANCELLATION_APPROVAL_FAILED',
    ]);
    // 같은 요청을 다시 확정할 수 있다(멱등 키는 purchase-svc가 받친다).
    fail = false;
    const retried = await approve(f, requestId);
    expect(retried).toMatchObject({ status: 'RUNNING', progress: { state: 'RUNNING' } });
    expect(f.store.rows.get(requestId)).toMatchObject({ status: 'RUNNING', approvedBy: OPERATOR.accountId, version: 6 });
  });

  test('동시 확정은 하나만 성공하고 환불 시작은 한 번만 부른다', async () => {
    const f = fixture();
    const requestId = await createJudged(f);
    const results = await Promise.allSettled([
      approve(f, requestId, OPERATOR, tokenFor(OPERATOR.accountId)),
      approve(f, requestId, OTHER, tokenFor(OTHER.accountId)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { type: 'event-cancellation-conflict', status: 409 } });
    expect(f.calls.filter((c) => c.startsWith('start:'))).toHaveLength(1);
    expect(f.store.rows.get(requestId)).toMatchObject({ status: 'RUNNING', version: 4 });
  });

  test('저장소는 이전 version이 아니면 갱신을 거절한다', async () => {
    const store = new MemoryEventCancellationStore();
    const base: EventCancellationRecord = {
      requestId: '0193d000-0000-7000-8000-000000000021',
      eventId: EVENT1,
      kind: 'CANCEL',
      status: 'REQUESTED',
      reason: '공연 취소',
      requestedBy: COMMANDER.accountId,
      requestedAt: new Date(NOW),
      fault: null,
      judgementReason: null,
      fanNoticeReason: null,
      judgedBy: null,
      judgedAt: null,
      approvedBy: null,
      approvedAt: null,
      refundJobState: null,
      version: 1,
      updatedAt: new Date(NOW),
    };
    await store.insert(base);
    expect(await store.save({ ...base, status: 'JUDGED', version: 3 })).toBe(false);
    expect(store.rows.get(base.requestId)?.status).toBe('REQUESTED');
    expect(await store.save({ ...base, status: 'JUDGED', version: 2 })).toBe(true);
  });
});

describe('OPS-01 회차 취소 감사 체인', () => {
  test('요청·판정·확정·시작·정지·재개가 전이마다 감사에 남는다', async () => {
    const f = fixture();
    const requestId = await createJudged(f);
    await approve(f, requestId);
    await f.app.pause(requestId, COMMANDER, { pg: 'TOSS', reason: '자동 정지' });
    await f.app.resume(requestId, COMMANDER, { pg: 'TOSS', reason: '재개' });

    const entries = f.audit.entries.filter((e) => e.recordId === requestId);
    expect(entries.map((e) => e.recordType)).toEqual([
      'EVENT_CANCELLATION_REQUESTED',
      'EVENT_CANCELLATION_JUDGED',
      'EVENT_CANCELLATION_APPROVED',
      'EVENT_CANCELLATION_STARTED',
      'EVENT_CANCELLATION_PAUSED',
      'EVENT_CANCELLATION_RESUMED',
    ]);
    expect(entries[2]!.record.payload).toMatchObject({ status: 'RUNNING', fault: 'ORGANIZER', eventId: EVENT1, requestReason: '공연 취소', requestedBy: COMMANDER.accountId });
    expect(entries[4]!.record.payload).toMatchObject({ status: 'PAUSED', pg: 'TOSS', reason: '자동 정지', refundJobState: 'PAUSED' });
    expect(entries[5]!.record.payload).toMatchObject({ status: 'RUNNING', pg: 'TOSS', reason: '재개', refundJobState: 'RUNNING' });
  });

  test('판정 뒤 반려도 사유·상태와 함께 감사에 남는다', async () => {
    const f = fixture();
    const requestId = await createJudged(f, EVENT2);
    const rejected = await f.app.reject(requestId, OPERATOR, '증빙 부족');
    expect(rejected).toMatchObject({ status: 'REQUESTED' });
    const entries = f.audit.entries.filter((e) => e.recordId === requestId);
    expect(entries.map((e) => e.recordType)).toEqual(['EVENT_CANCELLATION_REQUESTED', 'EVENT_CANCELLATION_JUDGED', 'EVENT_CANCELLATION_REJECTED']);
    expect(entries.at(-1)!.record.payload).toMatchObject({ status: 'REQUESTED', reason: '증빙 부족' });
  });
});

describe('SEC-02 회차 취소 확정 재인증', () => {
  test('검증기가 없으면 503으로 닫고 환불을 시작하지 않는다', async () => {
    const f = fixture({ reauth: null });
    const requestId = await createJudged(f);
    await expect(approve(f, requestId)).rejects.toMatchObject({ type: 'dependency-unavailable', status: 503 });
    expect(f.calls).toEqual([]);
    expect(f.store.rows.get(requestId)).toMatchObject({ status: 'JUDGED', version: 2 });
  });

  test('다른 계정의 토큰은 403이고 환불을 시작하지 않는다', async () => {
    const f = fixture();
    const requestId = await createJudged(f);
    await expect(approve(f, requestId, OPERATOR, tokenFor(OTHER.accountId))).rejects.toMatchObject({ type: 'reauth-required', status: 403 });
    expect(f.calls).toEqual([]);
    expect(f.store.rows.get(requestId)).toMatchObject({ status: 'JUDGED', version: 2 });
  });

  test('재인증 검증이 환불 시작보다 먼저, 세션과 act APPROVAL로 호출된다', async () => {
    const order: string[] = [];
    const reauth: EventCancellationReauth = {
      verify: async (_token, o) => {
        order.push(`verify:${o.act}:${o.sessionId}`);
        return { accountId: OPERATOR.accountId, factors: ['passkey'] };
      },
    };
    const f = fixture({
      reauth,
      start: async (i) => {
        order.push('start');
        return { jobId: i.requestId, state: 'RUNNING' } satisfies EventRefundJobView;
      },
    });
    const requestId = await createJudged(f);
    await approve(f, requestId);
    expect(order).toEqual([`verify:APPROVAL:${OPERATOR.sessionId}`, 'start']);
  });
});

describe('OPSV-01 확정 상태와 감사 기록의 원자성 포트', () => {
  test('RUNNING 전이와 그 감사 기록이 같은 저장 호출로 간다', async () => {
    const f = fixture();
    const requestId = await createJudged(f);
    await approve(f, requestId);
    const runningSave = f.store.saves.find((s) => s.record.status === 'RUNNING');
    expect(runningSave?.record.version).toBe(3);
    expect(runningSave?.audit).toMatchObject({ recordType: 'EVENT_CANCELLATION_APPROVED', recordId: requestId });
    const startedSave = f.store.saves.find((s) => s.audit?.recordType === 'EVENT_CANCELLATION_STARTED');
    expect(startedSave?.record.status).toBe('RUNNING');
    expect(startedSave?.record.version).toBe(4);
  });
});
