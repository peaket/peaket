// 승인 업무 목록·상세의 노출 범위(BAT-615 LCH-070, J-T29 ⑦·⑧, ADR-0320, ASVS 8.2.2).
// 계약 조건 변경은 요청자와 commander만 보고(다른 operator·CS는 404), 지급 묶음 승인의 가시성은 그대로다.
// viewer는 승인 업무 경로에 들어올 수 없고, CS 두 역할은 읽기만 한다.
import 'reflect-metadata';
import { createService, fakeClock, ProblemError } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { MemoryContractApprovalStore, MemoryCoreContract } from '../src/modules/approvals/index.js';
import { MemoryPayoutApprovalStore, type PayoutBatchView, type PayoutPaymentClient } from '../src/modules/payouts/index.js';
import type { ApprovalReauthVerifier } from '../src/modules/payouts/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-20T00:00:00.000Z');
const VALID_FROM = '2026-11-01T00:00:00.000Z';

class FakePayments implements PayoutPaymentClient {
  readonly batches: PayoutBatchView[] = [];
  readonly calls: string[] = [];
  async createBatch(input: { pg: 'TOSS' | 'PORTONE'; pgStore: 'STANDARD' | 'ESCROW'; payoutDate: string }) {
    this.calls.push('create');
    const batch: PayoutBatchView = { batchId: randomUUID(), pg: input.pg, pgStore: input.pgStore, payoutDate: input.payoutDate, totalAmount: 24_920_000, statementCount: 3, status: 'PENDING_APPROVAL' };
    this.batches.push(batch);
    return batch;
  }
  async listBatches() {
    return this.batches;
  }
  async getBatchDetail(batchId: string) {
    return { batch: this.batches.find((b) => b.batchId === batchId)!, statements: [], payouts: [], holds: [], kycNotices: [] };
  }
  async collectGuarantee() {
    return { collection: { amount: 0 }, receivable: { promoterId: 'promoter-1' } };
  }
  async listCircuits() {
    return { items: [{ pg: 'TOSS' as const, state: 'closed' as const }] };
  }
  async approveBatch(batchId: string) {
    this.calls.push('approve');
    return { ...this.batches.find((b) => b.batchId === batchId)!, status: 'APPROVED' as const };
  }
  async executeBatch(batchId: string) {
    this.calls.push('execute');
    return { ...this.batches.find((b) => b.batchId === batchId)!, status: 'SUBMITTED' as const };
  }
  async releaseBatch() {
    this.calls.push('release');
  }
  async recordPortoneExecution(batchId: string) {
    return { ...this.batches.find((b) => b.batchId === batchId)!, portoneBulkPayoutId: 'bulk-1' };
  }
  async listStatements() {
    return [];
  }
  async listReceivables() {
    return [];
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
const audit = new MemoryAuditChain();
const payoutStore = new MemoryPayoutApprovalStore(audit);
const contractStore = new MemoryContractApprovalStore(audit);
const core = new MemoryCoreContract();
const reauth = new TestReauth();
const payments = new FakePayments();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc-approval-visibility',
    module: AppModule.register({ memory: true, auditChain: audit, payouts: { store: payoutStore, payments, reauth }, approvals: { store: contractStore, core, reauth } }),
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
  payoutStore.rows.clear();
  contractStore.rows.clear();
  contractStore.votes.length = 0;
  audit.entries.length = 0;
  core.applied.length = 0;
  core.cancelled.length = 0;
  payments.batches.length = 0;
  payments.calls.length = 0;
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

interface World {
  operator: Record<string, string>;
  payoutApprovalId: string;
  contractApprovalId: string;
}

const createPayout = (h: Record<string, string>) =>
  svc.http.inject({ method: 'POST', url: '/v1/ops/payout-batches', headers: h, payload: JSON.stringify({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-11-30' }) });

async function world(): Promise<World> {
  const operator = headers('operator');
  const created = await createPayout(operator);
  expect(created.statusCode).toBe(202);
  const payoutApprovalId = (JSON.parse(created.payload) as { approvalId: string }).approvalId;

  const contractApprovalId = randomUUID();
  const internal = await svc.http.inject({
    method: 'PUT',
    url: `/internal/v1/approval-requests/${contractApprovalId}`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      kind: 'CONTRACT_TERMS_CHANGE',
      targetRef: 'p-1',
      requestedBy: { accountId: operator['x-user-id'], role: 'operator' },
      reasonText: '계약 갱신',
      current: { commissionRateBp: 875, guaranteeRateBp: 700, guaranteeKind: 'PERFORMANCE_BOND', validFrom: VALID_FROM },
      requested: { commissionRateBp: 900, guaranteeRateBp: 650, guaranteeKind: 'PERFORMANCE_BOND' },
    }),
  });
  expect(internal.statusCode).toBe(200);
  return { operator, payoutApprovalId, contractApprovalId };
}

const list = (role: Parameters<typeof headers>[0], qs = '') => svc.http.inject({ method: 'GET', url: `/v1/ops/approval-requests${qs}`, headers: noBody(headers(role)) });
const listAs = (h: Record<string, string>, qs = '') => svc.http.inject({ method: 'GET', url: `/v1/ops/approval-requests${qs}`, headers: noBody(h) });
const get = (id: string, h: Record<string, string>) => svc.http.inject({ method: 'GET', url: `/v1/ops/approval-requests/${id}`, headers: noBody(h) });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

describe('J-T29 ⑦ 계약 승인 상세·목록의 가시성', () => {
  test('[ASVS v5.0.0-8.2.2] J-T29 ⑦_계약_상세는_요청자와_commander만_200이고_CS·다른_operator는_404다', async () => {
    const w = await world();
    expect((await get(w.contractApprovalId, w.operator)).statusCode).toBe(200);
    const commander = headers('commander');
    const seen = await get(w.contractApprovalId, commander);
    expect(seen.statusCode).toBe(200);
    expect(json(seen)).toMatchObject({ kind: 'CONTRACT_TERMS_CHANGE', canApprove: true, contractTerms: { requestedCommissionRateBp: 900 } });

    for (const role of ['cs_lead', 'cs_agent', 'operator'] as const) {
      const r = await get(w.contractApprovalId, headers(role));
      expect(r.statusCode, `${role}는 계약 승인 상세를 보면 안 된다`).toBe(404);
      expect(json(r).type).toContain('not-found');
    }
    expect((await get(w.contractApprovalId, headers('viewer'))).statusCode).toBe(403);
  });

  test('J-T29 ⑦_목록에서_계약_줄은_요청자·commander에게만_싣고_지급_줄은_CS에게도_그대로다', async () => {
    const w = await world();
    const asRequester = json(await listAs(w.operator));
    expect((asRequester.items as { approvalId: string }[]).map((i) => i.approvalId)).toEqual(expect.arrayContaining([w.contractApprovalId, w.payoutApprovalId]));

    const asCommander = json(await list('commander'));
    expect((asCommander.items as { approvalId: string }[]).map((i) => i.approvalId)).toEqual(expect.arrayContaining([w.contractApprovalId, w.payoutApprovalId]));

    for (const role of ['cs_lead', 'cs_agent', 'operator'] as const) {
      const page = json(await list(role));
      const ids = (page.items as { approvalId: string }[]).map((i) => i.approvalId);
      expect(ids, `${role} 목록에 계약 줄이 있으면 안 된다`).not.toContain(w.contractApprovalId);
      expect(ids, `${role} 목록에서 지급 줄이 사라지면 안 된다`).toContain(w.payoutApprovalId);
    }
  });

  test('J-T29 ⑦_승인_대기_필터도_계약_줄을_요청자_밖의_commander에게만_준다', async () => {
    const w = await world();
    const commander = await listAs(headers('commander'), '?awaitingMyApproval=true');
    expect(commander.statusCode).toBe(200);
    expect((json(commander).items as { approvalId: string }[]).map((i) => i.approvalId)).toContain(w.contractApprovalId);
    const requester = await listAs(w.operator, '?awaitingMyApproval=true');
    expect((json(requester).items as { approvalId: string }[]).map((i) => i.approvalId)).not.toContain(w.contractApprovalId);
    const cs = await list('cs_lead', '?awaitingMyApproval=true');
    expect((json(cs).items as { approvalId: string }[]).map((i) => i.approvalId)).not.toContain(w.contractApprovalId);
  });

  test('J-T29 ⑦_지급_승인_가시성은_그대로다(요청자·commander·cs_lead)', async () => {
    const w = await world();
    expect((await get(w.payoutApprovalId, w.operator)).statusCode).toBe(200);
    expect((await get(w.payoutApprovalId, headers('commander'))).statusCode).toBe(200);
    expect((await get(w.payoutApprovalId, headers('cs_lead'))).statusCode).toBe(200);
    expect((await get(w.payoutApprovalId, headers('cs_agent'))).statusCode).toBe(404);
    expect((await get(w.payoutApprovalId, headers('operator'))).statusCode).toBe(404);
  });
});

describe('J-T29 ⑧ viewer와 CS의 읽기 전용', () => {
  test('[ASVS v5.0.0-8.2.2] J-T29 ⑧_viewer는_승인_목록·상세에서_403이다', async () => {
    const w = await world();
    expect((await list('viewer')).statusCode).toBe(403);
    expect((await get(w.payoutApprovalId, headers('viewer'))).statusCode).toBe(403);
    expect((await get(w.contractApprovalId, headers('viewer'))).statusCode).toBe(403);
  });

  test('J-T29 ⑧_CS는_계약_승인을_판정할_수_없다', async () => {
    const w = await world();
    const lead = headers('cs_lead', 'approval-token');
    const approve = await svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${w.contractApprovalId}/approvals`, headers: noBody(lead) });
    expect(approve.statusCode).toBe(403);
    expect(json(approve).type).toContain('approval-role-required');
    expect(core.applied).toHaveLength(0);

    const reject = await svc.http.inject({
      method: 'POST',
      url: `/v1/ops/approval-requests/${w.contractApprovalId}/rejections`,
      headers: headers('cs_lead'),
      payload: JSON.stringify({ reason: 'CS는 판정하지 않는다' }),
    });
    expect(reject.statusCode).toBe(403);
    expect(contractStore.rows.get(w.contractApprovalId)).toMatchObject({ status: 'PENDING_APPROVAL' });

    const agent = await svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${w.contractApprovalId}/approvals`, headers: noBody(headers('cs_agent', 'approval-token')) });
    expect(agent.statusCode).toBe(403);
  });

  test('[ASVS v5.0.0-8.2.3] J-T29 ⑧_CS가_보는_계약_줄에는_계약_금액·계좌_원문이_없다', async () => {
    const w = await world();
    const page = await list('cs_lead');
    expect(page.statusCode).toBe(200);
    const text = page.payload;
    for (const needle of ['accountNumber', 'bankAccount', 'tossSellerId', 'portonePartnerId']) expect(text).not.toContain(needle);
    // 목록에 계약 줄이 없으므로 계약 값도 실리지 않는다.
    expect(text).not.toContain(w.contractApprovalId);
    expect(text).toContain(w.payoutApprovalId);
  });
});
