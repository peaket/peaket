// 승인 업무 표·라우터·기존 지급 승인 회귀(실제 PostgreSQL 18, BAT-615 LCH-070, J-T29 ④⑥⑨).
// ops 0018의 approval_request·approval_vote·promoter_contract_change와 부분 유일 인덱스를 확인하고,
// 계약 승인의 동시 요청·동시 승인·감사 롤백·core 실패 재시도를 실제 트랜잭션으로 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createService, fakeClock, ProblemError, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import type { CoreContractClient } from '../src/modules/approvals/index.js';
import type { ApprovalReauthVerifier, PayoutBatchView, PayoutPaymentClient } from '../src/modules/payouts/index.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-20T00:00:00.000Z');
const VALID_FROM = '2026-11-01T00:00:00.000Z';
const identity = new FakeIdentity();
const tokenAccount = new Map<string, string>();

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

class IdempotentCore implements CoreContractClient {
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
  async verify(token: string | undefined, o: { sessionId: string; act: 'APPROVAL' }) {
    if (o.act !== 'APPROVAL' || token !== 'approval-token') throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
    return { accountId: tokenAccount.get(o.sessionId) ?? '', factors: ['password', 'totp', 'passkey'] };
  }
}

const payments = new FakePayments();
const core = new IdempotentCore();
const reauth = new TestReauth();
let container: PostgresContainer | undefined;
let db: Database;
let admin: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-contract-approval-it', max: 6 });
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  svc = await createService({
    name: 'ops-svc-contract-approval-it',
    module: AppModule.register({ database: db, nowMs: NOW, payouts: { payments, reauth }, approvals: { core, reauth } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
}, 180_000);

afterAll(async () => {
  await admin?.query('drop trigger if exists r615_contract_fail_audit_trg on audit_chain').catch(() => undefined);
  await admin?.query('drop function if exists r615_contract_fail_audit()').catch(() => undefined);
  await svc?.close().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  container?.stop();
});

const headers = (role: 'viewer' | 'operator' | 'commander' | 'cs_agent' | 'cs_lead', token?: string): Record<string, string> => {
  const h = identity.ops(role);
  if (token) tokenAccount.set(h['x-session-id']!, h['x-user-id']!);
  return { ...h, 'content-type': 'application/json', ...(token ? { 'x-reauth-token': token } : {}) };
};
const noBody = (h: Record<string, string>): Record<string, string> => {
  const copy = { ...h };
  delete copy['content-type'];
  return copy;
};

const contractBody = (o: { promoter?: string; requester?: Record<string, string>; requestedCommissionRateBp?: number } = {}) => {
  const requester = o.requester ?? headers('operator');
  return {
    requester,
    body: {
      kind: 'CONTRACT_TERMS_CHANGE',
      targetRef: o.promoter ?? randomUUID(),
      requestedBy: { accountId: requester['x-user-id'], role: 'operator' },
      reasonText: '연간 계약 갱신',
      current: { commissionRateBp: 875, guaranteeRateBp: 700, guaranteeKind: 'PERFORMANCE_BOND', validFrom: VALID_FROM },
      requested: { commissionRateBp: o.requestedCommissionRateBp ?? 900, guaranteeRateBp: 650, guaranteeKind: 'PERFORMANCE_BOND' },
    },
  };
};

const putContract = (id: string, body: unknown) =>
  svc.http.inject({ method: 'PUT', url: `/internal/v1/approval-requests/${id}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const approve = (id: string, h = headers('commander', 'approval-token')) => svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${id}/approvals`, headers: noBody(h) });
const reject = (id: string, h = headers('commander'), reason = '보증 조건 재협의') => svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${id}/rejections`, headers: h, payload: JSON.stringify({ reason }) });
const get = (id: string, h = headers('commander')) => svc.http.inject({ method: 'GET', url: `/v1/ops/approval-requests/${id}`, headers: noBody(h) });
const list = (h = headers('commander'), qs = '') => svc.http.inject({ method: 'GET', url: `/v1/ops/approval-requests${qs}`, headers: noBody(h) });
const createPayout = (h = headers('operator')) => svc.http.inject({ method: 'POST', url: '/v1/ops/payout-batches', headers: h, payload: JSON.stringify({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-11-30' }) });

const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const count = async (text: string, params: unknown[] = []): Promise<number> => Number((await admin.query<{ n: string }>(text, params)).rows[0]!.n);

async function newContract(): Promise<{ approvalId: string; promoterId: string }> {
  const { body } = contractBody();
  const approvalId = randomUUID();
  const r = await putContract(approvalId, body);
  expect(r.statusCode, r.payload).toBe(200);
  return { approvalId, promoterId: body.targetRef };
}

const failAudit = async (recordType: string): Promise<void> => {
  await admin.query(`create or replace function r615_contract_fail_audit() returns trigger as $$
    begin
      if new.record_type = tg_argv[0] then raise exception 'injected contract approval audit failure'; end if;
      return new;
    end $$ language plpgsql`);
  await admin.query('drop trigger if exists r615_contract_fail_audit_trg on audit_chain');
  await admin.query(`create trigger r615_contract_fail_audit_trg before insert on audit_chain for each row execute function r615_contract_fail_audit('${recordType}')`);
};
const clearAuditFailure = async (): Promise<void> => {
  await admin.query('drop trigger if exists r615_contract_fail_audit_trg on audit_chain');
};

describe('ops 0018 승인 업무 표(실제 PostgreSQL)', () => {
  test('J-T29 ④_승인_표_셋과_한_파트너_열린_변경_하나의_부분_유일_인덱스가_있다', async () => {
    for (const table of ['approval_request', 'approval_vote', 'promoter_contract_change']) {
      expect((await admin.query('select to_regclass($1) as oid', [`public.${table}`])).rows[0]!.oid).not.toBeNull();
    }
    const cols = await admin.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'approval_request'");
    const names = cols.rows.map((r) => r.column_name);
    for (const name of ['requester_role', 'approver_id', 'version', 'kind', 'target_ref', 'requested_by']) expect(names).toContain(name);
    const changeCols = await admin.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'promoter_contract_change'");
    for (const name of ['current_commission_rate_bp', 'current_guarantee_rate_bp', 'current_guarantee_kind', 'requested_commission_rate_bp', 'requested_guarantee_kind']) expect(changeCols.rows.map((r) => r.column_name)).toContain(name);

    const index = await admin.query<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'approval_request_contract_open_uq'");
    expect(index.rows[0]!.indexdef).toContain('CONTRACT_TERMS_CHANGE');
    expect(index.rows[0]!.indexdef).toContain('PENDING_APPROVAL');
    expect(index.rows[0]!.indexdef).toContain('FAILED');
  });

  test('J-T29 ⑨_승인_투표는_요청자와_같은_승인자를_받지_않고_계약_값은_bp_범위를_지킨다', async () => {
    const { approvalId, promoterId } = await newContract();
    await expect(admin.query('insert into approval_vote (request_id, approver_id, requester_id, approved_at) values ($1, $1, $1, now())', [approvalId])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query('update promoter_contract_change set requested_commission_rate_bp = 10001 where approval_id = $1', [approvalId])).rejects.toMatchObject({ code: '23514' });
    expect((await admin.query('select count(*) as n from approval_vote where request_id = $1', [approvalId])).rows[0]!.n).toBe('0');
    expect(promoterId).toBeTruthy();
  });
});

describe('J-T29 ④ 한 파트너 열린 변경 하나와 동시 요청', () => {
  test('[ASVS v5.0.0-2.3.4] J-T29 ④_동시에_두_요청을_넣으면_하나만_200이고_다른_하나는_409다', async () => {
    const body = contractBody().body;
    const [a, b] = await Promise.all([putContract(randomUUID(), body), putContract(randomUUID(), body)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const loser = [a, b].find((r) => r.statusCode === 409)!;
    expect(loser.payload).toContain('contract-change-pending');
    expect(await count(`select count(*) as n from approval_request where kind = 'CONTRACT_TERMS_CHANGE' and target_ref = $1 and status in ('PENDING_APPROVAL','EXECUTING','FAILED')`, [body.targetRef])).toBe(1);
  });

  test('J-T29 ④_반려하면_같은_파트너에_새_요청을_다시_받는다', async () => {
    const { approvalId } = await newContract();
    expect((await reject(approvalId)).statusCode).toBe(200);
    const { body } = contractBody({ requestedCommissionRateBp: 925 });
    const again = await putContract(randomUUID(), body);
    expect(again.statusCode).toBe(200);
    expect((await admin.query('select status from approval_request where id = $1', [approvalId])).rows[0]!.status).toBe('REJECTED');
  });
});

describe('J-T29 ⑨ 승인 상태·투표·감사의 한 트랜잭션(실제 PostgreSQL)', () => {
  test('[ASVS v5.0.0-2.3.3] J-T29 ⑨_감사_append가_실패하면_EXECUTING_상태가_롤백되고_core를_부르지_않는다', async () => {
    const { approvalId } = await newContract();
    core.applied.clear();
    await failAudit('CONTRACT_CHANGE_EXECUTING');
    const failed = await approve(approvalId);
    expect(failed.statusCode).toBe(500);
    await clearAuditFailure();
    const row = await admin.query('select status, version, approver_id from approval_request where id = $1', [approvalId]);
    expect(row.rows[0]).toMatchObject({ status: 'PENDING_APPROVAL', version: 1, approver_id: null });
    expect(core.applied.size).toBe(0);
    expect(await count("select count(*) as n from audit_chain where record_type = 'CONTRACT_CHANGE_EXECUTING' and record_id = $1", [approvalId])).toBe(0);

    const retried = await approve(approvalId);
    expect(retried.statusCode).toBe(200);
    expect(json(retried)).toMatchObject({ status: 'DONE' });
    expect((await admin.query('select status, version from approval_request where id = $1', [approvalId])).rows[0]).toMatchObject({ status: 'DONE', version: 3 });
    expect(await count('select count(*) as n from approval_vote where request_id = $1', [approvalId])).toBe(1);
    expect(await count("select count(*) as n from audit_chain where record_type = 'CONTRACT_CHANGE_APPROVED' and record_id = $1", [approvalId])).toBe(1);
  });

  test('[ASVS v5.0.0-2.3.3] J-T29 ⑥_RV-06_core_적용_뒤_감사가_실패해_EXECUTING에_남아도_같은_승인_ID로_다시_끝낸다', async () => {
    const { approvalId } = await newContract();
    core.applied.clear();
    await failAudit('CONTRACT_CHANGE_APPROVED');
    const failed = await approve(approvalId);
    expect(failed.statusCode).toBe(500);
    expect((await admin.query('select status from approval_request where id = $1', [approvalId])).rows[0]).toMatchObject({ status: 'EXECUTING' });
    expect(core.applied.size).toBe(1);
    expect(await count('select count(*) as n from approval_vote where request_id = $1', [approvalId])).toBe(0);

    // 감사 저장소가 돌아오면 같은 승인 ID로 다시 승인해 DONE까지 간다(core 적용은 멱등).
    await clearAuditFailure();
    const retried = await approve(approvalId);
    expect(retried.statusCode, retried.payload).toBe(200);
    expect(json(retried)).toMatchObject({ status: 'DONE' });
    expect((await admin.query('select status from approval_request where id = $1', [approvalId])).rows[0]).toMatchObject({ status: 'DONE' });
    expect(await count('select count(*) as n from approval_vote where request_id = $1', [approvalId])).toBe(1);
    expect(await count("select count(*) as n from audit_chain where record_type = 'CONTRACT_CHANGE_APPROVED' and record_id = $1", [approvalId])).toBe(1);
  });

  test('J-T29 ⑨_같은_승인_ID를_다시_보내도_한_행이고_요청_감사도_한_번이다', async () => {
    const { body } = contractBody();
    const approvalId = randomUUID();
    expect((await putContract(approvalId, body)).statusCode).toBe(200);
    expect((await putContract(approvalId, body)).statusCode).toBe(200);
    expect(await count('select count(*) as n from approval_request where id = $1', [approvalId])).toBe(1);
    expect(await count('select count(*) as n from promoter_contract_change where approval_id = $1', [approvalId])).toBe(1);
    expect(await count("select count(*) as n from audit_chain where record_type = 'CONTRACT_CHANGE_REQUESTED' and record_id = $1", [approvalId])).toBe(1);
  });
});

describe('J-T29 ⑥ core 실패·동시 승인', () => {
  test('J-T29 ⑥_core가_실패하면_FAILED로_남고_같은_승인_ID로_다시_승인한다', async () => {
    const { approvalId } = await newContract();
    core.failNext = true;
    core.applied.clear();
    const failed = await approve(approvalId);
    expect(failed.statusCode).toBe(503);
    expect(json(failed).type).toContain('contract-apply-failed');
    const row = await admin.query('select status, version, close_reason from approval_request where id = $1', [approvalId]);
    expect(row.rows[0]).toMatchObject({ status: 'FAILED', close_reason: expect.stringContaining('core 계약 적용 503') });
    expect(await count("select count(*) as n from audit_chain where record_type = 'CONTRACT_CHANGE_FAILED' and record_id = $1", [approvalId])).toBe(1);

    const retried = await approve(approvalId);
    expect(retried.statusCode).toBe(200);
    expect(json(retried)).toMatchObject({ status: 'DONE' });
    expect(core.applied.size).toBe(1);
    expect(core.applied.get(approvalId)).toMatchObject({ approvalId, commissionRateBp: 900, guaranteeRateBp: 650, guaranteeKind: 'PERFORMANCE_BOND' });
  });

  test('J-T29 ⑥_동시에_두_commander가_승인하면_한_번만_적용되고_투표도_한_개다', async () => {
    const { approvalId } = await newContract();
    core.applied.clear();
    const [a, b] = await Promise.all([approve(approvalId), approve(approvalId)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect((await admin.query('select status, version from approval_request where id = $1', [approvalId])).rows[0]).toMatchObject({ status: 'DONE', version: 3 });
    expect(await count('select count(*) as n from approval_vote where request_id = $1', [approvalId])).toBe(1);
    expect(core.applied.size).toBe(1);
  });
});

describe('기존 지급 승인 4경로 회귀(목록·상세·승인·반려)', () => {
  test('지급_승인은_계약_라우터를_지나도_목록·상세·승인·반려가_그대로다', async () => {
    payments.calls.length = 0;
    const created = await createPayout();
    expect(created.statusCode).toBe(202);
    const payoutApprovalId = json(created).approvalId as string;

    const page = await list(headers('commander'));
    expect(page.statusCode).toBe(200);
    expect((json(page).items as { approvalId: string }[]).map((i) => i.approvalId)).toContain(payoutApprovalId);

    const one = await get(payoutApprovalId, headers('commander'));
    expect(one.statusCode).toBe(200);
    expect(json(one)).toMatchObject({ kind: 'PAYOUT_BATCH', approvalId: payoutApprovalId, status: 'PENDING_APPROVAL', requiredApprovals: 2 });

    const approved = await approve(payoutApprovalId);
    expect(approved.statusCode).toBe(200);
    expect(json(approved)).toMatchObject({ status: 'DONE' });
    expect(payments.calls).toEqual(['create', 'approve', 'execute']);

    const second = await createPayout();
    expect(second.statusCode).toBe(202);
    const secondId = json(second).approvalId as string;
    const rejected = await reject(secondId);
    expect(rejected.statusCode).toBe(200);
    expect(json(rejected)).toMatchObject({ status: 'REJECTED', closeReason: '보증 조건 재협의' });
    expect(payments.calls).toContain('release');
  });

  test('viewer는_승인_목록·상세에서_403이고_계약_줄은_요청자_밖의_CS에게_보이지_않는다', async () => {
    const { approvalId } = await newContract();
    expect((await list(headers('viewer'))).statusCode).toBe(403);
    expect((await get(approvalId, headers('viewer'))).statusCode).toBe(403);
    const cs = json(await list(headers('cs_lead')));
    expect((cs.items as { approvalId: string }[]).map((i) => i.approvalId)).not.toContain(approvalId);
    expect((await get(approvalId, headers('cs_lead'))).statusCode).toBe(404);
  });
});
