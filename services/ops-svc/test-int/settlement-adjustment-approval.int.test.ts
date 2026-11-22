// J-T36 ①·④ 정산서 수기 조정 승인 업무의 실제 PostgreSQL 시험(F-07-5 LCH-100, ADR-0368 결정 7·8, POL-038 ⑦).
// 공통 승인 표(approval_request·approval_vote)에 SETTLEMENT_ADJUSTMENT가 쓰이고, 2인(요청자≠승인자)이 표 CHECK로도 막히며,
// payment-svc가 적용 중에 읽는 내부 사실(EXECUTING·승인자·승인 시각)이 DB 투표에서 나온다. 두 commander가 겹쳐 승인해도 적용은 한 번이다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createService, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { UnavailablePayoutPaymentClient } from '../src/modules/payouts/index.js';
import { FakeSettlementPayments, TestReauth } from '../test/settlement-flow-support.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-19T06:00:00.000Z');
const identity = new FakeIdentity();
const payments = new FakeSettlementPayments();
const reauth = new TestReauth();
let container: PostgresContainer | undefined;
let db: Database;
let admin: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-settlement-adjustment-it', max: 6 });
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  svc = await createService({
    name: 'ops-settlement-adjustment-it',
    module: AppModule.register({ database: db, nowMs: NOW, payouts: { payments: new UnavailablePayoutPaymentClient(), settlementPayments: payments, reauth }, approvals: { reauth } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
}, 180_000);

afterAll(async () => {
  await svc?.close().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  container?.stop();
});

const headers = (role: 'commander' | 'cs_lead', o: { reauth?: boolean; key?: string } = {}): Record<string, string> => {
  const h = identity.ops(role);
  if (o.reauth) reauth.accountOf.set(h['x-session-id']!, h['x-user-id']!);
  return { ...h, ...(o.key ? { 'content-type': 'application/json', 'idempotency-key': o.key } : {}), ...(o.reauth ? { 'x-reauth-token': 'approval-token' } : {}) };
};
const request = async (statementId: string) => {
  const lead = headers('cs_lead', { key: randomUUID() });
  const res = await svc.http.inject({ method: 'POST', url: `/v1/ops/settlements/${statementId}/adjustments`, headers: lead, payload: JSON.stringify({ amount: -300_000, reasonCode: 'LEDGER_ERROR', evidenceNote: '원장 오류 정정' }) });
  expect(res.statusCode, res.payload).toBe(202);
  return { lead, approvalId: (JSON.parse(res.payload) as { approvalId: string }).approvalId, res };
};
const approve = (id: string, h: Record<string, string>) => svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${id}/approvals`, headers: h });

describe('J-T36 조정 승인 업무(실제 DB)', () => {
  test('[ASVS v5.0.0-2.3.3] J-T36 ① 요청은 approval_request SETTLEMENT_ADJUSTMENT 한 행(대상·금액·사유 코드·정족수 2)이고 같은 멱등 키는 같은 행이다', async () => {
    const statementId = randomUUID();
    const key = randomUUID();
    const lead = headers('cs_lead', { key });
    const body = JSON.stringify({ amount: -300_000, reasonCode: 'LEDGER_ERROR', evidenceNote: '원장 오류 정정' });
    const a = await svc.http.inject({ method: 'POST', url: `/v1/ops/settlements/${statementId}/adjustments`, headers: lead, payload: body });
    const b = await svc.http.inject({ method: 'POST', url: `/v1/ops/settlements/${statementId}/adjustments`, headers: lead, payload: body });
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    const rows = await admin.query('select id, kind, target_ref, amount, reason_code, requested_by, required_approvals, status from approval_request where target_ref = $1', [statementId]);
    expect(rows.rows).toEqual([{ id: JSON.parse(a.payload).approvalId, kind: 'SETTLEMENT_ADJUSTMENT', target_ref: statementId, amount: '-300000', reason_code: 'LEDGER_ERROR', requested_by: lead['x-user-id'], required_approvals: 2, status: 'PENDING_APPROVAL' }]);
    expect(JSON.parse(b.payload).approvalId).toBe(JSON.parse(a.payload).approvalId);
  });

  test('[ASVS v5.0.0-2.3.3] J-T36 ④ 다른 commander의 승인은 투표 한 행과 DONE을 남기고, payment가 적용 중에 읽는 사실은 DB 투표의 승인자·승인 시각이다', async () => {
    const statementId = randomUUID();
    const { lead, approvalId } = await request(statementId);
    const commander = headers('commander', { reauth: true });
    let seen: Record<string, unknown> | undefined;
    payments.onApply = async (id) => {
      seen = JSON.parse((await svc.http.inject({ method: 'GET', url: `/internal/v1/approval-requests/${id}` })).payload) as Record<string, unknown>;
    };
    const res = await approve(approvalId, commander);
    payments.onApply = undefined;
    expect(res.statusCode, res.payload).toBe(200);
    expect(seen).toMatchObject({ approvalId, status: 'EXECUTING', requiredApprovals: 2, requestedBy: lead['x-user-id'], approvals: [commander['x-user-id']], approvedAt: new Date(NOW).toISOString(), targetRef: statementId, amount: -300_000 });
    const votes = await admin.query('select approver_id, requester_id from approval_vote where request_id = $1', [approvalId]);
    expect(votes.rows).toEqual([{ approver_id: commander['x-user-id'], requester_id: lead['x-user-id'] }]);
    expect((await admin.query('select status from approval_request where id = $1', [approvalId])).rows).toEqual([{ status: 'DONE' }]);
    expect(payments.applied.filter((id) => id === approvalId)).toHaveLength(1);
  });

  test('J-T36 ④ 요청자가 승인자인 투표는 표 CHECK가 막는다(2인의 DB 쪽 가드)', async () => {
    const { lead, approvalId } = await request(randomUUID());
    await expect(admin.query('insert into approval_vote (request_id, approver_id, requester_id, approved_at) values ($1, $2, $2, now())', [approvalId, lead['x-user-id']])).rejects.toThrow(/approval_vote_not_requester_check/);
  });

  test('J-T36 ④ 두 commander가 같은 조정을 겹쳐 승인해도 payment 적용은 한 번이다', async () => {
    const { approvalId } = await request(randomUUID());
    const before = payments.applied.length;
    const results = await Promise.all([approve(approvalId, headers('commander', { reauth: true })), approve(approvalId, headers('commander', { reauth: true }))]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(payments.applied.slice(before)).toEqual([approvalId]);
  });
});
