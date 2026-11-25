// F-04-13 ops DB 통합 시험(동결 로컬, LCH-270·LCH-280, FX-T12).
// 실제 PostgreSQL 18 컨테이너에 0037을 적용하고 제품 저장소의 승인 요약·예매 제한·조치 트랜잭션을 본다.
// [ASVS v5.0.0-2.3.3] 업무 트랜잭션, [ASVS v5.0.0-2.1.2] 상태·판 일관성, [ASVS v5.0.0-2.1.3] 판 번호 한도.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { DrizzleInvestigationStore } from '../src/modules/investigations/index.js';
import * as investigations from '../src/modules/investigations/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-25T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const id = (n: number) => `0194b230-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const uuid = () => randomUUID();
const mod = investigations as unknown as Record<string, any>;

let container: PostgresContainer | undefined;
let database: Database;
let raw: pg.Client;
let store: DrizzleInvestigationStore;

const member = (accountId: string, o: Record<string, any> = {}) => ({
  accountId,
  ticketCount: 1,
  signals: ['LINK_GRAPH'],
  addedBy: 'SYSTEM',
  removedAtMs: null,
  appealResult: 'REJECTED',
  appealDueAtMs: NOW - HOUR,
  lockExpiresAtMs: NOW + DAY,
  objectionResult: 'NONE',
  ...o,
});

const caseOf = (o: Record<string, any> = {}) => ({
  caseId: uuid(),
  eventId: uuid(),
  clusterId: uuid(),
  status: 'APPEAL_PENDING',
  reasonCategory: 'MACRO_BOT',
  assigneeId: uuid(),
  cancelDeadlineAtMs: NOW + DAY,
  appealDueAtMs: NOW - HOUR,
  approvalId: null,
  investigatorOpinion: null,
  outcomeLabel: null,
  version: 1,
  createdAtMs: NOW - DAY,
  closedAtMs: null,
  members: [member(id(1))],
  events: [{ seq: 1, kind: 'CREATED', actorId: null, note: null, detail: null, occurredAtMs: NOW - DAY }],
  ...o,
});

const target = (ticketId: string, payer: string) => ({ ticketId, payerAccountId: payer, holderAccountId: payer, status: 'ISSUED', entryRecorded: false });

beforeAll(async () => {
  container = await startPostgres({ name: `peaket-f0413-${process.pid}` });
  await migrateOps(container.url);
  database = createDatabase({ url: container.url, applicationName: 'ops-svc-fraud-action-int', max: 8 });
  raw = new pg.Client({ connectionString: container.url });
  await raw.connect();
  store = new DrizzleInvestigationStore(database);
});

afterAll(async () => {
  await raw?.end().catch(() => undefined);
  await database?.close();
  container?.stop();
});

describe('F-04-13 ops DB 통합', () => {
  test('FX-T12 68 [ASVS v5.0.0-2.3.3] 제품 승인 저장소는 조치 요청·사건 기록을 한 트랜잭션에 쓴다', async () => {
    const Store = mod.DrizzleFraudApprovalStore;
    expect(Store).toBeTypeOf('function');
    const approvals = new Store(database);
    const c = caseOf({ status: 'INVESTIGATING', members: [member(id(2))] });
    await store.putCase(c as any);
    const approvalId = uuid();
    // 사건 기록 기본 키 (case_id, seq)를 일부러 겹쳐, 승인·사건·기록 쓰기 도중 실패를 만든다
    const events = [{ seq: 1, kind: 'ACTION_REQUESTED', actorId: c.assigneeId, note: null, detail: { approvalId, action: 'CANCEL_TICKETS', accountIds: [id(2)] }, occurredAtMs: NOW }];
    await expect(
      approvals.request(
        { approvalId, caseId: c.caseId, eventId: c.eventId, action: 'CANCEL_TICKETS', accountIds: [id(2)], targets: [target(uuid(), id(2))], restrictionEndsAtMs: null, reason: '봇', requestedBy: c.assigneeId, dueAtMs: NOW + DAY, nowMs: NOW },
        { idem: { accountRef: c.assigneeId, operation: 'CREATE_FRAUD_ACTION_REQUEST', key: uuid(), requestHash: new Uint8Array(32) }, result: { approvalId }, audit: { recordType: 'ADMIN_DATA_ACCESS', recordId: approvalId, payload: { action: 'REQUEST' }, nowMs: NOW }, events },
      ),
    ).rejects.toThrow();
    const approvalRows = await raw.query('select count(*)::int as n from approval_request where id = $1', [approvalId]);
    const eventRows = await raw.query("select count(*)::int as n from fraud_case_event where case_id = $1 and kind = 'ACTION_REQUESTED'", [c.caseId]);
    const caseRow = await raw.query('select version, status from fraud_case where id = $1', [c.caseId]);
    expect(approvalRows.rows[0].n).toBe(0);
    expect(eventRows.rows[0].n).toBe(0);
    expect(caseRow.rows[0]).toEqual({ version: '1', status: 'INVESTIGATING' });
  });

  test('FX-T12 69 [ASVS v5.0.0-2.1.2] 제품 승인 저장소는 승인 요약 첫 열람을 승인자마다 한 번만 남긴다', async () => {
    const Store = mod.DrizzleFraudApprovalStore;
    expect(Store).toBeTypeOf('function');
    const approvals = new Store(database);
    const c = caseOf();
    await store.putCase(c as any);
    const approvalId = uuid();
    await approvals.request(
      { approvalId, caseId: c.caseId, eventId: c.eventId, action: 'RESTRICT', accountIds: [id(1)], targets: [], restrictionEndsAtMs: NOW + 30 * DAY, reason: '제한', requestedBy: c.assigneeId, dueAtMs: NOW + DAY, nowMs: NOW },
      { idem: { accountRef: c.assigneeId, operation: 'CREATE_FRAUD_ACTION_REQUEST', key: uuid(), requestHash: new Uint8Array(32) }, result: { approvalId }, audit: { recordType: 'ADMIN_DATA_ACCESS', recordId: approvalId, payload: { action: 'REQUEST' }, nowMs: NOW }, events: [] },
    );
    const adminId = uuid();
    const first = await approvals.recordSummaryView({ approvalId, adminAccountId: adminId, nowMs: NOW });
    const second = await approvals.recordSummaryView({ approvalId, adminAccountId: adminId, nowMs: NOW + DAY });
    expect(first).toBe(NOW);
    expect(second).toBe(NOW);
    expect(await approvals.summaryViewedAt({ approvalId, adminAccountId: adminId })).toBe(NOW);
    expect(await approvals.summaryViewedAt({ approvalId, adminAccountId: uuid() })).toBeNull();
  });

  test('FX-T12 70 [ASVS v5.0.0-2.1.3] 제품 예매 제한 저장소는 계정마다 판 번호를 올리고 FRAUD 사유를 남긴다', async () => {
    const Restrictions = mod.DrizzleFraudRestrictions;
    expect(Restrictions).toBeTypeOf('function');
    const restrictions = new Restrictions(database);
    const accountId = uuid();
    const caseId = uuid();
    await restrictions.restrict({ accountId, caseId, restrictionId: uuid(), version: 1, untilMs: NOW + 30 * DAY, actedBy: uuid() });
    const activeId = uuid();
    await restrictions.restrict({ accountId, caseId, restrictionId: activeId, version: 2, untilMs: NOW + 31 * DAY, actedBy: uuid() });
    const active = await restrictions.activeForCase(caseId);
    expect(active.length).toBeGreaterThanOrEqual(1);
    expect(active.some((r: any) => r.accountId === accountId && r.caseId === caseId && r.version === 2 && r.restrictionId === activeId)).toBe(true);
    expect(active.every((r: any) => r.accountId === accountId && r.caseId === caseId)).toBe(true);
    const rows = await raw.query('select reason_code, status, version from booking_restriction where account_id = $1 order by version', [accountId]);
    expect(rows.rows.at(-1)).toEqual({ reason_code: 'FRAUD', status: 'ACTIVE', version: '2' });
    expect(rows.rows.every((r: any) => r.reason_code === 'FRAUD')).toBe(true);
    await restrictions.lift({ accountId, caseId, restrictionId: activeId, version: 3, actedBy: uuid() });
    expect(await restrictions.activeForCase(caseId)).toEqual([]);
    const lifted = await raw.query('select status, version from booking_restriction where id = $1', [activeId]);
    expect(lifted.rows[0]).toEqual({ status: 'LIFTED', version: '3' });
  });
});
