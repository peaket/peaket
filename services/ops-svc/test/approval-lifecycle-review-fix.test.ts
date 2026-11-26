// F-06-3 구현 리뷰 IR-07·08·14·18·20 재현 시험(구현 담당, 2026-11-26).
// 수명주기 유스케이스를 직접 조립해 실행 결과 처리·동시 승인 CAS·반려 감사·고착 복구를 본다.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { ApprovalLifecycle } from '../src/modules/approvals/application/approval-lifecycle.js';
import { MemoryApprovalLifecycleStore } from '../src/modules/approvals/adapters/memory-lifecycle-store.js';
import { lifecycleView, type ApprovalLifecycleRecord } from '../src/modules/approvals/domain/approval-lifecycle.js';
import type { AuditRecord } from '../src/modules/audit/audit.js';
import type { OpsActor, ApprovalReauthVerifier } from '../src/modules/payouts/index.js';

const NOW = Date.parse('2026-11-26T10:00:00+09:00');
let wall = NOW;
const PAYER = randomUUID();
const HOLDER = randomUUID();
const REQUESTER = randomUUID();
const LEAD = randomUUID();

class Audit {
  entries: AuditRecord[] = [];
  async append(r: AuditRecord) {
    this.entries.push(r);
  }
}
class Reauth implements ApprovalReauthVerifier {
  async verify(_t: string | undefined, o: { sessionId: string }) {
    return { accountId: o.sessionId, factors: ['totp'] };
  }
}
const actor = (accountId: string, role: string): OpsActor => ({ accountId, sessionId: accountId, role });
const lead = actor(LEAD, 'cs_lead');
const commander = actor(randomUUID(), 'commander');

const targets = {
  async basis() {
    return { targetAccountId: PAYER, expectedHolderAccountId: HOLDER, entryStartsAtMs: NOW + 3 * 86_400_000 };
  },
  async changed() {
    return 'OK' as const;
  },
};

let refundThrows = false;
let refundOutcome: { status: 'REFUNDED' | 'REFUND_PENDING' | 'REQUESTED'; cancellationId: string; refundAmount: number } = { status: 'REFUNDED', cancellationId: randomUUID(), refundAmount: 100_000 };
let reclaimOutcome: { result: 'RECLAIMED' | 'SKIPPED_ENTRY_STARTED' | 'SKIPPED_ENTRY_RECORDED' | 'SKIPPED_NOT_TRANSFERRED' | 'SKIPPED_HOLDER_CHANGED'; previousHolderAccountId?: string } = { result: 'RECLAIMED' };
const refundCalls: Record<string, unknown>[] = [];
const reclaimCalls: Record<string, unknown>[] = [];
const failedCases: Record<string, unknown>[] = [];
const succeededCases: string[] = [];
const audit = new Audit();
const store = new MemoryApprovalLifecycleStore(audit as never);
const lifecycle = new ApprovalLifecycle({
  store,
  reauth: new Reauth(),
  clock: { now: () => wall, monotonicMs: () => wall },
  audit: audit as never,
  targets,
  executors: {
    async refund(i) {
      refundCalls.push(i);
      if (refundThrows) throw new Error('refund down');
      return refundOutcome;
    },
    async reclaim(i) {
      reclaimCalls.push(i);
      return reclaimOutcome;
    },
  },
  failureCases: {
    async failed(i) {
      failedCases.push(i);
    },
    async succeeded(id) {
      succeededCases.push(id);
    },
  },
});

const waiver = (amount = 310_000) =>
  lifecycle.request({ kind: 'DISCRETIONARY_WAIVER', targetRef: randomUUID(), amount, reasonCode: 'BEREAVEMENT', reasonText: '사망' }, actor(REQUESTER, 'cs_agent'));
const refund = () => lifecycle.request({ kind: 'SYSTEM_FAULT_REFUND', targetRef: randomUUID(), amount: 100_000, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복' }, actor(REQUESTER, 'cs_agent'));
const reclaim = () => lifecycle.request({ kind: 'TRANSFER_RECLAIM', targetRef: randomUUID(), amount: 0, reasonCode: 'ACCOUNT_TAKEOVER', reasonText: '소명 지남' }, lead);

beforeEach(() => {
  store.rows.clear();
  audit.entries.length = 0;
  refundCalls.length = 0;
  reclaimCalls.length = 0;
  failedCases.length = 0;
  succeededCases.length = 0;
  wall = NOW;
  refundThrows = false;
  refundOutcome = { status: 'REFUNDED', cancellationId: randomUUID(), refundAmount: 100_000 };
  reclaimOutcome = { result: 'RECLAIMED' };
});

describe('IR-08 실행 결과 처리', () => {
  test('IR-08 양도 회수가 SKIPPED면 DONE이 아니라 FAILED이고 실행기에 기대 보유자·마감을 넘긴다', async () => {
    const created = await reclaim();
    wall = NOW + 86_400_001;
    reclaimOutcome = { result: 'SKIPPED_HOLDER_CHANGED' };
    const out = await lifecycle.approve(created.approvalId, commander, 't', undefined, '"1"');
    expect(out.status).toBe('FAILED');
    expect(out.closeReason).toContain('SKIPPED_HOLDER_CHANGED');
    expect(reclaimCalls[0]).toMatchObject({ approvalId: created.approvalId, targetRef: created.targetRef, expectedHolderAccountId: HOLDER, deadlineMs: expect.any(Number) });
    expect(failedCases).toHaveLength(1);
  });

  test('IR-08 환급이 REFUND_PENDING·REQUESTED면 실행 실패가 아니라 DONE이고 CS 건을 열지 않는다', async () => {
    const a = await refund();
    refundOutcome = { status: 'REFUND_PENDING', cancellationId: randomUUID(), refundAmount: 100_000 };
    expect((await lifecycle.approve(a.approvalId, lead, 't', undefined, '"1"')).status).toBe('DONE');
    const b = await refund();
    refundOutcome = { status: 'REQUESTED', cancellationId: randomUUID(), refundAmount: 100_000 };
    expect((await lifecycle.approve(b.approvalId, lead, 't', undefined, '"1"')).status).toBe('DONE');
    expect(failedCases).toHaveLength(0);
  });
});

describe('IR-14 반려 감사', () => {
  test('IR-14 반려 감사에 반려자 계정이 남는다', async () => {
    const created = await refund();
    await lifecycle.reject(created.approvalId, lead, '증빙 부족', '"1"');
    expect(audit.entries).toContainEqual(expect.objectContaining({ recordType: 'APPROVAL_REJECTED', payload: expect.objectContaining({ approverId: LEAD }) }));
  });
});

describe('IR-07 동시 승인', () => {
  test('IR-07 같은 판으로 동시에 승인하면 한 요청만 통과하고 정족수가 찬 PENDING으로 남지 않는다', async () => {
    const created = await waiver();
    const results = await Promise.allSettled([lifecycle.approve(created.approvalId, lead, 't', undefined, '"1"'), lifecycle.approve(created.approvalId, commander, 't', undefined, '"1"')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    const after = await store.find(created.approvalId);
    expect(after?.approvals).toHaveLength(1);
    const retry = await lifecycle.approve(created.approvalId, commander, 't', undefined, `"${after!.version}"`);
    expect(retry.status).toBe('DONE');
  });
});

describe('IR-20 고착 복구', () => {
  test('IR-20 EXECUTING에 멈춘 승인은 tick이 다시 실행해 DONE으로 끝낸다', async () => {
    const created = await waiver();
    await lifecycle.approve(created.approvalId, lead, 't', undefined, '"1"');
    const current = (await store.find(created.approvalId))!;
    const stuck: ApprovalLifecycleRecord = { ...current, status: 'EXECUTING', version: current.version + 1, approvals: [...current.approvals, { approverId: commander.accountId, role: 'commander', votedAt: new Date(NOW), reason: null }] };
    store.rows.set(created.approvalId, stuck);
    const out = await lifecycle.tick();
    expect(out.escalated + out.expired + out.failed).toBeGreaterThanOrEqual(0);
    expect((await store.find(created.approvalId))?.status).toBe('DONE');
  });
});

describe('IR-18 FAILED 재승인', () => {
  test('IR-18 실행 실패 뒤 canApprove는 다시 승인할 수 있고 view가 FAILED를 연다', async () => {
    const created = await refund();
    refundThrows = true;
    await expect(lifecycle.approve(created.approvalId, lead, 't', undefined, '"1"')).rejects.toMatchObject({ status: 500 });
    const view = await lifecycle.get(created.approvalId, lead);
    expect(view.status).toBe('FAILED');
    expect(lifecycleView((await store.find(created.approvalId))!, lead).canApprove).toBe(true);
  });
});
