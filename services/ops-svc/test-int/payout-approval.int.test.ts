// ops-svc 지급 묶음 2인 승인 실제 PostgreSQL 18 통합 시험(BAT-610 잔여, R-614 OPSV-01·02·03).
// 상태 저장과 감사 append의 같은 트랜잭션(실패 주입 롤백), version 조건부 동시 승인 한 번만 성공, 수기 포트원 실행 감사를 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createService, fakeClock, ProblemError, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import type { ApprovalReauthVerifier } from '../src/modules/payouts/domain/ports.js';
import type { PayoutBatchView, PayoutPaymentClient } from '../src/modules/payouts/index.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-15T10:00:00.000Z');
const identity = new FakeIdentity();
const tokenAccount = new Map<string, string>();
let container: PostgresContainer | undefined;
let db: Database;
let admin: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;

class FakePayments implements PayoutPaymentClient {
  readonly batches: PayoutBatchView[] = [];
  readonly calls: string[] = [];
  async createBatch(input: { pg: 'TOSS' | 'PORTONE'; pgStore: 'STANDARD' | 'ESCROW'; payoutDate: string }) {
    this.calls.push('create');
    const batch: PayoutBatchView = { batchId: randomUUID(), pg: input.pg, pgStore: input.pgStore, payoutDate: input.payoutDate, totalAmount: 24_920_000, statementCount: 3, status: 'PENDING_APPROVAL' };
    this.batches.push(batch);
    return batch;
  }
  async releaseBatch() { this.calls.push('release'); }
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
    return { ...this.batches.find((b) => b.batchId === batchId)!, status: 'APPROVED' };
  }
  async executeBatch(batchId: string) {
    this.calls.push('execute');
    const batch = this.batches.find((b) => b.batchId === batchId)!;
    batch.status = 'SUBMITTED';
    return { ...batch };
  }
  async recordPortoneExecution(batchId: string) {
    this.calls.push('portone');
    const batch = this.batches.find((b) => b.batchId === batchId)!;
    if (batch.status !== 'APPROVED' && batch.status !== 'SUBMITTED') throw new ProblemError({ type: 'payout-batch-not-approved', status: 409, title: '승인된 지급 묶음이 아닙니다' });
    batch.portoneBulkPayoutId = 'bulk-1';
    return { ...batch, portoneBulkPayoutId: 'bulk-1' };
  }
  async listStatements() {
    return [];
  }
  async listReceivables() {
    return [];
  }
}

class TestReauth implements ApprovalReauthVerifier {
  async verify(token: string | undefined, o: { sessionId: string; act: 'APPROVAL' }) {
    if (token !== 'approval-token') throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
    return { accountId: tokenAccount.get(o.sessionId) ?? '', factors: ['password', 'totp', 'passkey'] };
  }
}

const payments = new FakePayments();
const reauth = new TestReauth();

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-payout-approval-it' });
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  svc = await createService({
    name: 'ops-svc-payout-approval',
    module: AppModule.register({ database: db, nowMs: NOW, payouts: { payments, reauth } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});

afterAll(async () => {
  await admin?.query('drop trigger if exists r614_fail_audit_trg on audit_chain').catch(() => undefined);
  await admin?.query('drop function if exists r614_fail_audit()').catch(() => undefined);
  await svc?.close().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  container?.stop();
});

const headers = (role: 'viewer' | 'operator' | 'commander' = 'operator', token?: string) => {
  const h = identity.ops(role);
  tokenAccount.set(h['x-session-id']!, h['x-user-id']!);
  return { ...h, 'content-type': 'application/json', ...(token ? { 'x-reauth-token': token } : {}) };
};
const noBody = (role: 'viewer' | 'operator' | 'commander' = 'operator', token?: string) => {
  const h = headers(role, token);
  delete (h as Record<string, string>)['content-type'];
  return h;
};
const create = (h = headers()) =>
  svc.http.inject({ method: 'POST', url: '/v1/ops/payout-batches', headers: h, payload: JSON.stringify({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-11-20' }) });
const approve = (approvalId: string, h = noBody('commander', 'approval-token')) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${approvalId}/approvals`, headers: h });
const count = async (text: string, params: unknown[] = []): Promise<number> => Number((await admin.query<{ n: string }>(text, params)).rows[0]!.n);

const failAudit = async (recordType: string): Promise<void> => {
  await admin.query(`create or replace function r614_fail_audit() returns trigger as $$
    begin
      if new.record_type = tg_argv[0] then raise exception 'injected audit failure'; end if;
      return new;
    end $$ language plpgsql`);
  await admin.query('drop trigger if exists r614_fail_audit_trg on audit_chain');
  await admin.query(`create trigger r614_fail_audit_trg before insert on audit_chain for each row execute function r614_fail_audit('${recordType}')`);
};
const clearAuditFailure = async (): Promise<void> => {
  await admin.query('drop trigger if exists r614_fail_audit_trg on audit_chain');
};

describe('지급 승인 실제 DB [BAT-610·R-614]', () => {
  test('OPSV01_감사_append가_실패하면_EXECUTING_저장이_롤백되고_지급대행을_부르지_않는다', async () => {
    const created = JSON.parse((await create()).payload) as { approvalId: string };
    payments.calls.length = 0;
    await failAudit('PAYOUT_BATCH_EXECUTING');
    const failed = await approve(created.approvalId);
    expect(failed.statusCode).toBe(500);
    await clearAuditFailure();
    const row = await admin.query('select status, version, approver_id from payout_approval where id = $1', [created.approvalId]);
    expect(row.rows[0]).toMatchObject({ status: 'PENDING_APPROVAL', version: 1, approver_id: null });
    expect(payments.calls).toEqual([]);
    const retried = await approve(created.approvalId);
    expect(retried.statusCode).toBe(200);
    expect(JSON.parse(retried.payload)).toMatchObject({ status: 'DONE' });
  });

  test('OPSV02_동시_승인은_version_조건으로_한_번만_성공하고_지급대행도_한_번만_부른다', async () => {
    const created = JSON.parse((await create()).payload) as { approvalId: string };
    payments.calls.length = 0;
    const [a, b] = await Promise.all([approve(created.approvalId), approve(created.approvalId)]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const row = await admin.query('select status, version from payout_approval where id = $1', [created.approvalId]);
    expect(row.rows[0]).toMatchObject({ status: 'DONE', version: 3 });
    expect(payments.calls).toEqual(['approve', 'execute']);
  });

  test('OPSV03_수기_포트원_실행은_감사_체인에_payload와_함께_남는다', async () => {
    const created = JSON.parse((await create()).payload) as { batchId: string };
    const batch = payments.batches.find((b) => b.batchId === created.batchId)!;
    batch.status = 'APPROVED';
    const r = await svc.http.inject({
      method: 'POST',
      url: `/v1/ops/payout-batches/${created.batchId}/portone-execution`,
      headers: headers('operator'),
      payload: JSON.stringify({ bulkPayoutId: 'bulk-1' }),
    });
    expect(r.statusCode).toBe(200);
    const audit = await admin.query("select record_json from audit_chain where record_type = 'PAYOUT_PORTONE_EXECUTION' and record_id = $1", [created.batchId]);
    expect(audit.rows[0]!.record_json).toMatchObject({ payload: { batchId: created.batchId, bulkPayoutId: 'bulk-1', pg: 'PORTONE' } });
  });

  test('OPSV04_지급_감사는_반려_사유를_payload에_싣고_체크포인트_검증이_통과한다', async () => {
    const created = JSON.parse((await create()).payload) as { approvalId: string };
    const rejected = await svc.http.inject({
      method: 'POST',
      url: `/v1/ops/approval-requests/${created.approvalId}/rejections`,
      headers: headers('commander'),
      payload: JSON.stringify({ reason: '금액 확인 필요' }),
    });
    expect(rejected.statusCode).toBe(200);
    const audit = await admin.query("select record_json from audit_chain where record_type = 'PAYOUT_APPROVAL_REJECTED' and record_id = $1", [created.approvalId]);
    expect(audit.rows[0]!.record_json).toMatchObject({ payload: { status: 'REJECTED', reason: '금액 확인 필요', pg: 'TOSS' } });
    const cp = await svc.http.inject({ method: 'POST', url: '/v1/ops/audit-checkpoints', headers: headers('commander'), payload: JSON.stringify({ reason: '지급 감사 검증' }) });
    expect(cp.statusCode).toBe(201);
    const checkpointId = (JSON.parse(cp.payload) as { checkpointId: string }).checkpointId;
    const verification = await svc.http.inject({ method: 'GET', url: `/v1/ops/audit-checkpoints/${checkpointId}/verification`, headers: headers('viewer') });
    expect(JSON.parse(verification.payload)).toMatchObject({ valid: true });
    expect(await count("select count(*) as n from audit_chain where record_type = 'PAYOUT_APPROVAL_REQUESTED'")).toBeGreaterThan(0);
  });
});
