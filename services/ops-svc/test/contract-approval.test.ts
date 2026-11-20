// 계약 조건 변경 승인 업무(BAT-615 LCH-070, J-T29 ②·③·⑥, ADR-0320, POL-038 ⑨).
// core가 내부 경로로 만든 CONTRACT_TERMS_CHANGE를 operator가 요청하고, 요청자가 아닌 commander가
// act=APPROVAL 재인증 뒤 승인한다. 반려·철회는 core의 예약을 풀고, core 적용 실패는 FAILED로 남겨 같은 승인 ID로 다시 승인한다.
import 'reflect-metadata';
import { createService, fakeClock, ProblemError } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain, type AuditRecord } from '../src/modules/audit/index.js';
import { MemoryContractApprovalStore } from '../src/modules/approvals/index.js';
import type { CoreContractClient } from '../src/modules/approvals/index.js';
import type { ApprovalReauthVerifier } from '../src/modules/payouts/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-20T00:00:00.000Z');
const VALID_FROM = '2026-11-01T00:00:00.000Z';

class GuardedAudit extends MemoryAuditChain {
  readonly failOn = new Set<string>();
  override async append(record: AuditRecord): Promise<void> {
    if (this.failOn.has(record.recordType)) throw new Error('감사 저장소 장애');
    return super.append(record);
  }
}

class FlakyCore implements CoreContractClient {
  readonly applied = new Map<string, Parameters<CoreContractClient['apply']>[0]>();
  readonly cancelled: Parameters<CoreContractClient['cancel']>[0][] = [];
  failNext = false;

  async apply(q: Parameters<CoreContractClient['apply']>[0]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('core 계약 적용 503');
    }
    this.applied.set(q.approvalId, q);
  }

  async cancel(q: Parameters<CoreContractClient['cancel']>[0]): Promise<void> {
    this.cancelled.push(q);
  }
}

class TestReauth implements ApprovalReauthVerifier {
  readonly accountOf = new Map<string, string>();
  async verify(token: string | undefined, o: { sessionId: string; act: 'APPROVAL' }) {
    if (o.act !== 'APPROVAL' || token !== 'approval-token') throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
    return { accountId: this.accountOf.get(o.sessionId) ?? '', factors: ['password', 'totp', 'passkey'] };
  }
}

const identity = new FakeIdentity();
const audit = new GuardedAudit();
const store = new MemoryContractApprovalStore(audit);
const core = new FlakyCore();
const reauth = new TestReauth();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc-contract-approval',
    module: AppModule.register({ memory: true, auditChain: audit, approvals: { store, core, reauth } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});
beforeEach(() => {
  store.rows.clear();
  store.votes.length = 0;
  audit.entries.length = 0;
  audit.failOn.clear();
  core.applied.clear();
  core.cancelled.length = 0;
  core.failNext = false;
  reauth.accountOf.clear();
});

const headers = (role: 'viewer' | 'operator' | 'commander' | 'cs_agent' | 'cs_lead', token?: string): Record<string, string> => {
  const h = identity.ops(role);
  if (token) reauth.accountOf.set(h['x-session-id']!, h['x-user-id']!);
  return { ...h, 'content-type': 'application/json', ...(token ? { 'x-reauth-token': token } : {}) };
};
const noBody = (h: Record<string, string>): Record<string, string> => {
  const copy = { ...h };
  delete copy['content-type'];
  return copy;
};

interface Requested {
  approvalId: string;
  promoterId: string;
  requester: Record<string, string>;
}

const changeBody = (o: { current?: Record<string, unknown>; requested?: Record<string, unknown>; requester?: Record<string, string>; reason?: string; promoter?: string } = {}) => {
  const requester = o.requester ?? headers('operator');
  return {
    requester,
    body: {
      kind: 'CONTRACT_TERMS_CHANGE',
      targetRef: o.promoter ?? 'p-1',
      requestedBy: { accountId: requester['x-user-id'], role: 'operator' },
      reasonText: o.reason ?? '연간 계약 갱신',
      current: { commissionRateBp: 875, guaranteeRateBp: 700, guaranteeKind: 'PERFORMANCE_BOND', validFrom: VALID_FROM, ...(o.current ?? {}) },
      requested: { commissionRateBp: 900, guaranteeRateBp: 650, guaranteeKind: 'PERFORMANCE_BOND', ...(o.requested ?? {}) },
    },
  };
};

async function createApproval(o: Parameters<typeof changeBody>[0] = {}, approvalId = randomUUID()): Promise<Requested> {
  const { requester, body } = changeBody(o);
  const r = await svc.http.inject({ method: 'PUT', url: `/internal/v1/approval-requests/${approvalId}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  expect(r.statusCode, r.payload).toBe(200);
  return { approvalId, promoterId: body.targetRef, requester };
}

const get = (id: string, h: Record<string, string>) => svc.http.inject({ method: 'GET', url: `/v1/ops/approval-requests/${id}`, headers: noBody(h) });
const approve = (id: string, h: Record<string, string>) => svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${id}/approvals`, headers: noBody(h) });
const reject = (id: string, h: Record<string, string>, payload: unknown) => svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${id}/rejections`, headers: h, payload: JSON.stringify(payload) });
const withdraw = (id: string, h: Record<string, string>, payload: unknown) => svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${id}/withdrawals`, headers: h, payload: JSON.stringify(payload) });

const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

describe('J-T29 ② 요청과 2인 승인', () => {
  test('[ASVS v5.0.0-2.3.3] J-T29 ②_commander만_재인증_뒤_승인하고_core에_요청_값을_한_번_적용한다', async () => {
    const { approvalId, requester } = await createApproval();

    const seenByRequester = await get(approvalId, requester);
    expect(seenByRequester.statusCode).toBe(200);
    expect(json(seenByRequester)).toMatchObject({
      approvalId,
      kind: 'CONTRACT_TERMS_CHANGE',
      targetRef: 'p-1',
      requiredApprovals: 2,
      status: 'PENDING_APPROVAL',
      canApprove: false,
      closeReason: null,
      contractTerms: {
        current: { commissionRateBp: 875, guaranteeRateBp: 700, guaranteeKind: 'PERFORMANCE_BOND', validFrom: VALID_FROM },
        requestedCommissionRateBp: 900,
        requestedGuaranteeRateBp: 650,
        requestedGuaranteeKind: 'PERFORMANCE_BOND',
      },
    });

    const commander = headers('commander', 'approval-token');
    const seen = await get(approvalId, commander);
    expect(seen.statusCode).toBe(200);
    expect(json(seen)).toMatchObject({ canApprove: true });

    // operator·cs_lead는 승인 경로에서 거절된다(controller 역할과 도메인 판정 모두)
    expect((await approve(approvalId, headers('operator', 'approval-token'))).statusCode).toBe(403);
    const csLead = await approve(approvalId, headers('cs_lead', 'approval-token'));
    expect(csLead.statusCode).toBe(403);
    expect(json(csLead).type).toContain('approval-role-required');
    // 재인증이 없으면 commander도 403이다.
    const noReauth = await approve(approvalId, noBody(headers('commander')));
    expect(noReauth.statusCode).toBe(403);
    expect(noReauth.payload).toContain('reauth-required');

    const ok = await approve(approvalId, commander);
    expect(ok.statusCode).toBe(200);
    expect(json(ok)).toMatchObject({ status: 'DONE', canApprove: false, requiredApprovals: 2, approvals: [commander['x-user-id']] });
    expect(core.applied.size).toBe(1);
    expect(core.applied.get(approvalId)).toMatchObject({
      promoterId: 'p-1',
      approvalId,
      commissionRateBp: 900,
      guaranteeRateBp: 650,
      guaranteeKind: 'PERFORMANCE_BOND',
      approverId: commander['x-user-id'],
    });
    expect(store.rows.get(approvalId)).toMatchObject({ status: 'DONE', approverId: commander['x-user-id'], version: 3 });
    expect(store.votes).toEqual([expect.objectContaining({ approvalId, approverId: commander['x-user-id'], requesterId: requester['x-user-id'] })]);
    expect(audit.entries.filter((e) => e.recordId === approvalId).map((e) => e.recordType)).toEqual(['CONTRACT_CHANGE_REQUESTED', 'CONTRACT_CHANGE_EXECUTING', 'CONTRACT_CHANGE_APPROVED']);
  });

  test('J-T29 ②_요청자는_승인할_수_없고_다른_계정의_재인증_토큰도_거절한다', async () => {
    const commanderRequester = headers('commander', 'approval-token');
    const own = await createApproval({ requester: commanderRequester });
    const self = await approve(own.approvalId, commanderRequester);
    expect(self.statusCode).toBe(403);
    expect(json(self).type).toContain('approval-self-not-allowed');
    expect(core.applied.size).toBe(0);

    const other = await createApproval({ promoter: 'p-2' });
    const commander = headers('commander', 'approval-token');
    reauth.accountOf.set(commander['x-session-id']!, randomUUID());
    const mismatched = await approve(other.approvalId, commander);
    expect(mismatched.statusCode).toBe(403);
    expect(json(mismatched).type).toContain('reauth-required');
    expect(core.applied.size).toBe(0);
  });

  test('J-T29 ②_같은_승인_ID를_다시_만들어도_한_행이고_같은_답이다', async () => {
    const id = randomUUID();
    const first = await createApproval({}, id);
    const second = await createApproval({ reason: '다른 본문' }, id);
    expect(second.promoterId).toBe(first.promoterId);
    expect(store.rows.size).toBe(1);
    expect(store.rows.get(id)).toMatchObject({ reasonText: '연간 계약 갱신', status: 'PENDING_APPROVAL' });
    expect(audit.entries.filter((e) => e.recordType === 'CONTRACT_CHANGE_REQUESTED')).toHaveLength(1);
  });

  test('[ASVS v5.0.0-2.3.4] J-T29 ②_한_파트너에_열린_변경은_하나라_두_번째_요청은_409다', async () => {
    await createApproval();
    const second = await svc.http.inject({
      method: 'PUT',
      url: `/internal/v1/approval-requests/${randomUUID()}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(changeBody().body),
    });
    expect(second.statusCode).toBe(409);
    expect(second.payload).toContain('contract-change-pending');
    expect(store.rows.size).toBe(1);
  });
});

describe('J-T29 ③ 반려와 철회', () => {
  test('J-T29 ③_반려는_사유가_필요하고_core_예약을_풀며_새_요청을_받는다', async () => {
    const { approvalId } = await createApproval();
    expect((await reject(approvalId, headers('commander'), { reason: '' })).statusCode).toBe(400);
    expect(core.cancelled).toEqual([]);

    const rejected = await reject(approvalId, headers('commander'), { reason: '보증 조건 재협의' });
    expect(rejected.statusCode).toBe(200);
    expect(json(rejected)).toMatchObject({ status: 'REJECTED', closeReason: '보증 조건 재협의', canApprove: false });
    expect(core.cancelled).toEqual([expect.objectContaining({ promoterId: 'p-1', approvalId })]);
    expect(core.applied.size).toBe(0);
    expect(await store.find(approvalId)).toMatchObject({ status: 'REJECTED', requesterRole: 'operator' });
    expect(audit.entries.filter((e) => e.recordId === approvalId).map((e) => e.recordType)).toEqual(['CONTRACT_CHANGE_REQUESTED', 'CONTRACT_CHANGE_REJECTED']);

    const again = await createApproval({ requested: { commissionRateBp: 925 } });
    expect(again.approvalId).not.toBe(approvalId);
  });

  test('J-T29 ③_요청자_철회는_WITHDRAWN이고_다른_사람은_철회할_수_없다', async () => {
    const { approvalId, requester } = await createApproval();
    const other = await withdraw(approvalId, headers('operator'), { reason: '남의 요청' });
    expect(other.statusCode).toBe(404);

    expect((await withdraw(approvalId, requester, { reason: '' })).statusCode).toBe(400);
    const done = await withdraw(approvalId, requester, { reason: '조건 다시 협의' });
    expect(done.statusCode).toBe(200);
    expect(json(done)).toMatchObject({ status: 'WITHDRAWN', closeReason: '조건 다시 협의' });
    expect(core.cancelled).toHaveLength(1);
    expect(audit.entries.filter((e) => e.recordId === approvalId).map((e) => e.recordType)).toEqual(['CONTRACT_CHANGE_REQUESTED', 'CONTRACT_CHANGE_WITHDRAWN']);
    expect((await createApproval({ requested: { commissionRateBp: 925 } })).approvalId).not.toBe(approvalId);
  });

  test('J-T29 ⑤_지금과_같은_값만_보내면_422이고_행이_남지_않는다', async () => {
    const id = randomUUID();
    const { body } = changeBody({ requested: { commissionRateBp: 875, guaranteeRateBp: 700, guaranteeKind: 'PERFORMANCE_BOND' } });
    const r = await svc.http.inject({ method: 'PUT', url: `/internal/v1/approval-requests/${id}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    expect(r.statusCode).toBe(422);
    expect(r.payload).toContain('바꿀 칸이 없거나 지금 값과 같습니다');
    expect(store.rows.size).toBe(0);
  });
});

describe('J-T29 ⑥ core 적용 실패와 재시도·감사 원자성', () => {
  test('[ASVS v5.0.0-2.3.3] J-T29 ⑥_core가_503이면_FAILED로_남고_같은_승인_ID로_다시_승인하면_한_번만_적용된다', async () => {
    const { approvalId } = await createApproval();
    const commander = headers('commander', 'approval-token');
    core.failNext = true;
    const failed = await approve(approvalId, commander);
    expect(failed.statusCode).toBe(503);
    expect(json(failed).type).toContain('contract-apply-failed');
    expect(store.rows.get(approvalId)).toMatchObject({ status: 'FAILED', version: 3 });
    expect(store.rows.get(approvalId)?.closeReason).toContain('core 계약 적용 503');
    expect(audit.entries.filter((e) => e.recordId === approvalId).map((e) => e.recordType)).toEqual(['CONTRACT_CHANGE_REQUESTED', 'CONTRACT_CHANGE_EXECUTING', 'CONTRACT_CHANGE_FAILED']);

    const retried = await approve(approvalId, commander);
    expect(retried.statusCode).toBe(200);
    expect(json(retried)).toMatchObject({ status: 'DONE' });
    expect(core.applied.size).toBe(1);
    expect(store.votes).toHaveLength(1);
  });

  test('[ASVS v5.0.0-2.3.3] [ASVS v5.0.0-16.3.3] J-T29 ⑥_core_적용_뒤_감사가_실패하면_EXECUTING으로_남고_FAILED로_보고하지_않는다', async () => {
    const { approvalId } = await createApproval();
    audit.failOn.add('CONTRACT_CHANGE_APPROVED');
    const r = await approve(approvalId, headers('commander', 'approval-token'));
    expect(r.statusCode).toBe(500);
    expect(core.applied.size).toBe(1);
    expect(store.rows.get(approvalId)).toMatchObject({ status: 'EXECUTING', version: 2 });
    expect(store.rows.get(approvalId)?.closeReason).toBeNull();
    expect(audit.entries.filter((e) => e.recordId === approvalId).map((e) => e.recordType)).toEqual(['CONTRACT_CHANGE_REQUESTED', 'CONTRACT_CHANGE_EXECUTING']);
  });

  test('J-T29 ⑥_이미_끝난_승인은_다시_승인할_수_없다', async () => {
    const { approvalId } = await createApproval();
    expect((await approve(approvalId, headers('commander', 'approval-token'))).statusCode).toBe(200);
    const again = await approve(approvalId, headers('commander', 'approval-token'));
    expect(again.statusCode).toBe(409);
    expect(json(again).type).toContain('contract-approval-not-pending');
    expect(core.applied.size).toBe(1);
    expect(store.rows.get(approvalId)).toMatchObject({ status: 'DONE', version: 3 });
    expect(store.votes).toHaveLength(1);
  });
});

describe('J-T29 ⑨ 승인 상태·투표·감사의 한 트랜잭션', () => {
  test('J-T29 ⑨_요청_감사가_실패하면_승인_행도_남지_않는다', async () => {
    const id = randomUUID();
    audit.failOn.add('CONTRACT_CHANGE_REQUESTED');
    const { body } = changeBody();
    const r = await svc.http.inject({ method: 'PUT', url: `/internal/v1/approval-requests/${id}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    expect(r.statusCode).toBe(500);
    expect(store.rows.size).toBe(0);
    expect(store.votes).toHaveLength(0);
  });

  test('[ASVS v5.0.0-16.3.3] J-T29 ⑨_승인_투표와_감사가_같은_성공에_남고_투표는_한_번이다', async () => {
    const { approvalId, requester } = await createApproval();
    const commander = headers('commander', 'approval-token');
    const r = await approve(approvalId, commander);
    expect(r.statusCode).toBe(200);
    expect(store.votes).toHaveLength(1);
    expect(store.votes[0]).toMatchObject({ approvalId, approverId: commander['x-user-id'], requesterId: requester['x-user-id'] });
    const records = audit.entries.filter((e) => e.recordId === approvalId);
    expect(records.map((e) => e.recordType)).toEqual(['CONTRACT_CHANGE_REQUESTED', 'CONTRACT_CHANGE_EXECUTING', 'CONTRACT_CHANGE_APPROVED']);
    expect(records[2]!.record.payload).toMatchObject({ approvalId, promoterId: 'p-1', status: 'DONE', approverId: commander['x-user-id'] });
  });
});
