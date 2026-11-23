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

  test('[ASVS v5.0.0-2.3.3] J-T36 ⑨ ① 적용 커밋 뒤 응답이 끊긴 FAILED를 반려하면 409이고 DB 승인 업무는 DONE이다(REJECTED가 남지 않는다)', async () => {
    const { approvalId } = await request(randomUUID());
    payments.loseNextApplyResponse = true;
    expect((await approve(approvalId, headers('commander', { reauth: true }))).statusCode).toBe(503);
    expect((await admin.query('select status from approval_request where id = $1', [approvalId])).rows).toEqual([{ status: 'FAILED' }]);
    const reject = await svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${approvalId}/rejections`, headers: { ...headers('commander'), 'content-type': 'application/json' }, payload: JSON.stringify({ reason: '근거가 부족하다' }) });
    expect(reject.statusCode, reject.payload).toBe(409);
    expect((await admin.query('select status from approval_request where id = $1', [approvalId])).rows).toEqual([{ status: 'DONE' }]);
    expect(payments.effects.get(approvalId)).toBe(1);
  });

  test('J-T36 ⑨ ② 응답이 끊긴 FAILED를 다른 commander가 다시 승인하면 DB 투표는 한 행이고 DONE이며 조정 합계는 한 번이다', async () => {
    const { approvalId } = await request(randomUUID());
    payments.loseNextApplyResponse = true;
    expect((await approve(approvalId, headers('commander', { reauth: true }))).statusCode).toBe(503);
    const retry = await approve(approvalId, headers('commander', { reauth: true }));
    expect(retry.statusCode, retry.payload).toBe(200);
    expect((await admin.query('select count(*)::int as n from approval_vote where request_id = $1', [approvalId])).rows).toEqual([{ n: 1 }]);
    expect((await admin.query('select status from approval_request where id = $1', [approvalId])).rows).toEqual([{ status: 'DONE' }]);
    expect(payments.effects.get(approvalId)).toBe(1);
  });

  type Injected = Awaited<ReturnType<typeof approve>>;
  /** 겹친 두 승인 뒤의 돈·DB 불변식과 응답 모양(settlement §4.3 '승인', F-07-5 리뷰 RV-04) */
  const expectSettledOnce = async (o: { approvalId: string; statementId: string; lead: Record<string, string>; commanders: Record<string, string>[]; results: Injected[]; before: number }) => {
    const { approvalId, statementId, lead, commanders, results, before } = o;
    // 돈 불변식: payment가 조정 합계를 바꾼 것은 한 번이고(다시 부른 적용은 처음 결과를 준다), 적용 호출은 이 승인 ID뿐이다
    expect(payments.effects.get(approvalId)).toBe(1);
    expect(payments.rows.get(approvalId)).toBe('APPLIED');
    expect(new Set(payments.applied.slice(before))).toEqual(new Set([approvalId]));
    // DB: 투표는 두 commander 가운데 하나의 한 행이고 승인 업무는 DONE이다
    const votes = await admin.query<{ approver_id: string; requester_id: string }>('select approver_id, requester_id from approval_vote where request_id = $1', [approvalId]);
    expect(votes.rows).toHaveLength(1);
    const voter = votes.rows[0]!.approver_id;
    expect(commanders.map((h) => h['x-user-id'])).toContain(voter);
    expect(votes.rows).toEqual([{ approver_id: voter, requester_id: lead['x-user-id'] }]);
    expect((await admin.query('select status from approval_request where id = $1', [approvalId])).rows).toEqual([{ status: 'DONE' }]);
    // 409는 겹친 판정의 거절뿐이다(버전 충돌 또는 이미 DONE)
    for (const r of results.filter((x) => x.statusCode === 409)) expect(['approval-conflict', 'approval-not-pending']).toContain((JSON.parse(r.payload) as { type: string }).type.split('/').pop());
    // 200 응답은 모두 같은 DONE 결과다(같은 승인 ID·같은 투표, RV-04 '겹쳐 먼저 저장된 쪽이 DONE이면 그 결과를 준다')
    const ok = results.filter((r) => r.statusCode === 200).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
    expect(ok[0]).toMatchObject({ approvalId, kind: 'SETTLEMENT_ADJUSTMENT', targetRef: statementId, status: 'DONE', approvals: [voter], amount: -300_000, canApprove: false });
    for (const body of ok.slice(1)) expect(body).toEqual(ok[0]);
  };

  test('J-T36 ④ 두 commander가 같은 조정을 겹쳐 승인해도 payment 적용은 한 번이다', async () => {
    const statementId = randomUUID();
    const { lead, approvalId } = await request(statementId);
    const before = payments.applied.length;
    const commanders = [headers('commander', { reauth: true }), headers('commander', { reauth: true })];
    const results = await Promise.all(commanders.map((h) => approve(approvalId, h)));
    // 둘째가 닿는 때에 따라 두 결과가 다 정상이다(settlement §4.3 '승인', F-07-5 리뷰 RV-04).
    // 첫째가 EXECUTING을 쓰기 전이나 DONE을 쓴 뒤면 409이고, 적용 중(EXECUTING)이면 새 투표 없이 적용만 다시 불러 같은 DONE 결과로 200이다
    expect([[200, 200], [200, 409]], results.map((r) => r.payload).join(' | ')).toContainEqual(results.map((r) => r.statusCode).sort());
    await expectSettledOnce({ approvalId, statementId, lead, commanders, results, before });
  });

  test('J-T36 ④ 첫 승인이 적용 중(EXECUTING)일 때 닿은 둘째 승인은 투표를 더 쓰지 않고 첫째와 같은 DONE 결과 200이다', async () => {
    const statementId = randomUUID();
    const { lead, approvalId } = await request(statementId);
    const before = payments.applied.length;
    const commanders = [headers('commander', { reauth: true }), headers('commander', { reauth: true })];
    // 첫 승인의 payment 적용 안에서 둘째 승인을 보낸다: 그때 DB 승인 업무는 EXECUTING이다(차례를 고정해 [200, 200] 길을 반드시 지난다)
    let second: Promise<Injected> | undefined;
    payments.onApply = async () => {
      payments.onApply = undefined;
      expect((await admin.query('select status from approval_request where id = $1', [approvalId])).rows).toEqual([{ status: 'EXECUTING' }]);
      second = approve(approvalId, commanders[1]!);
      await second;
    };
    const first = await approve(approvalId, commanders[0]!).finally(() => {
      payments.onApply = undefined;
    });
    const results = [first, await second!];
    expect(results.map((r) => r.statusCode), results.map((r) => r.payload).join(' | ')).toEqual([200, 200]);
    await expectSettledOnce({ approvalId, statementId, lead, commanders, results, before });
    // 투표는 먼저 EXECUTING을 쓴 첫째 commander의 것이다
    expect((await admin.query('select approver_id from approval_vote where request_id = $1', [approvalId])).rows).toEqual([{ approver_id: commanders[0]!['x-user-id'] }]);
  });
});
