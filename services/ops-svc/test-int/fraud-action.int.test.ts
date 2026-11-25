// F-04-13 ops DB 통합 시험(동결 로컬, LCH-270·LCH-280, FX-T12).
// 실제 PostgreSQL 18 컨테이너에 0037을 적용하고 승인 요약·예매 제한·조치 기록의 트랜잭션과 제약을 본다.
// [ASVS v5.0.0-2.3.3] 업무 트랜잭션, [ASVS v5.0.0-2.1.2] 상태·판 일관성, [ASVS v5.0.0-2.1.3] 판 번호 한도.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = '2026-11-25T00:00:00.000Z';
let container: PostgresContainer | undefined;
let raw: pg.Client;

const uuid = () => randomUUID();

beforeAll(async () => {
  container = await startPostgres({ name: `peaket-f0413-${process.pid}` });
  await migrateOps(container.url);
  raw = new pg.Client({ connectionString: container.url });
  await raw.connect();
});

afterAll(async () => {
  await raw?.end().catch(() => undefined);
  container?.stop();
});

const insertApproval = async (id = uuid(), caseId = uuid()) => {
  await raw.query(
    `insert into approval_request (id, kind, target_ref, fraud_action, reason_code, reason_text, requested_by, requester_role, required_approvals, status, created_at, updated_at)
     values ($1, 'FRAUD_ACTION', $2, 'CANCEL_TICKETS', 'FRAUD_ACTION', '봇', $3, 'cs_lead', 2, 'PENDING_APPROVAL', $4, $4)`,
    [id, caseId, uuid(), NOW],
  );
  return { id, caseId };
};

describe('F-04-13 ops DB 통합', () => {
  test('FX-T12 68 [ASVS v5.0.0-2.3.3] PostgreSQL은 조치 요청·사건 기록을 한 트랜잭션에 쓴다', async () => {
    const eventId = uuid();
    const clusterId = uuid();
    const caseId = uuid();
    const approvalId = uuid();
    await raw.query('begin');
    await raw.query(
      `insert into fraud_case (id, event_id, cluster_id, status, reason_category, assignee_id, appeal_due_at, cancel_deadline_at, approval_id, version, created_at)
       values ($1, $2, $3, 'DECISION_PENDING', 'MACRO_BOT', $4, $5, $5, $6, 2, $5)`,
      [caseId, eventId, clusterId, uuid(), NOW, approvalId],
    );
    await raw.query(
      `insert into fraud_case_event (case_id, seq, kind, actor_id, note, detail, occurred_at) values ($1, 1, 'ACTION_REQUESTED', $2, null, $3::jsonb, $4)`,
      [caseId, uuid(), JSON.stringify({ approvalId, action: 'CANCEL_TICKETS', accountIds: [uuid()] }), NOW],
    );
    await insertApproval(approvalId, caseId);
    await raw.query('rollback');
    const cases = await raw.query('select count(*)::int as n from fraud_case where id = $1', [caseId]);
    const approvals = await raw.query('select count(*)::int as n from approval_request where id = $1', [approvalId]);
    expect(cases.rows[0].n).toBe(0);
    expect(approvals.rows[0].n).toBe(0);
  });

  test('FX-T12 69 [ASVS v5.0.0-2.1.2] PostgreSQL은 승인 요약 첫 열람을 승인자마다 한 번만 남긴다', async () => {
    const { id } = await insertApproval();
    const adminId = uuid();
    await raw.query('insert into approval_summary_view (approval_id, admin_account_id, first_viewed_at) values ($1, $2, $3) on conflict do nothing', [id, adminId, NOW]);
    await raw.query('insert into approval_summary_view (approval_id, admin_account_id, first_viewed_at) values ($1, $2, $3) on conflict do nothing', [id, adminId, '2026-11-26T00:00:00.000Z']);
    const rows = await raw.query('select first_viewed_at from approval_summary_view where approval_id = $1 and admin_account_id = $2', [id, adminId]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].first_viewed_at.toISOString()).toBe(NOW);
  });

  test('FX-T12 70 [ASVS v5.0.0-2.1.3] PostgreSQL은 예매 제한 판 번호를 계정마다 올리고 FRAUD 사유를 남긴다', async () => {
    const accountId = uuid();
    const caseId = uuid();
    const first = uuid();
    const second = uuid();
    await raw.query(
      `insert into booking_restriction (id, account_id, reason_code, fraud_case_id, confirmed_by, starts_at, ends_at, appeal_due_at, status, version)
       values ($1, $2, 'FRAUD', $3, $4, $5, $6, $5, 'ACTIVE', 1)`,
      [first, accountId, caseId, uuid(), NOW, '2026-12-25T00:00:00.000Z'],
    );
    await raw.query(
      `insert into booking_restriction (id, account_id, reason_code, fraud_case_id, confirmed_by, starts_at, ends_at, appeal_due_at, status, version)
       values ($1, $2, 'FRAUD', $3, $4, $5, $6, $5, 'ACTIVE', 2)`,
      [second, accountId, caseId, uuid(), NOW, '2026-12-26T00:00:00.000Z'],
    );
    const rows = await raw.query('select version, status, reason_code from booking_restriction where account_id = $1 order by version', [accountId]);
    expect(rows.rows).toEqual([
      { version: '1', status: 'ACTIVE', reason_code: 'FRAUD' },
      { version: '2', status: 'ACTIVE', reason_code: 'FRAUD' },
    ]);
    await expect(
      raw.query(
        `insert into booking_restriction (id, account_id, reason_code, fraud_case_id, confirmed_by, starts_at, ends_at, appeal_due_at, status, version)
         values ($1, $2, 'FRAUD', $3, $4, $5, $6, $5, 'BROKEN', 3)`,
        [uuid(), accountId, caseId, uuid(), NOW, '2026-12-27T00:00:00.000Z'],
      ),
    ).rejects.toThrow();
  });
});
