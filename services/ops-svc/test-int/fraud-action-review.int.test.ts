// F-04-13 구현 리뷰 IR-04·05·07·11·13: 제품 승인 저장소의 트랜잭션·판 경합·이용 제한 경계를 실제 PostgreSQL에서 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { DrizzleFraudApprovalStore, DrizzleFraudRestrictions, DrizzleInvestigationStore, FraudActions } from '../src/modules/investigations/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-25T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const uuid = () => randomUUID();

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
  members: [member(uuid())],
  events: [{ seq: 1, kind: 'CREATED', actorId: null, note: null, detail: null, occurredAtMs: NOW - DAY }],
  ...o,
}) as any;

const record = (c: any, o: Record<string, any> = {}) => ({
  approvalId: uuid(),
  caseId: c.caseId,
  eventId: c.eventId,
  action: 'RESTRICT' as const,
  accountIds: [c.members[0].accountId],
  targets: [],
  restrictionEndsAtMs: NOW + 30 * DAY,
  reason: '제한',
  requestedBy: uuid(),
  requesterRole: 'cs_lead',
  dueAtMs: NOW + DAY,
  status: 'PENDING_APPROVAL' as const,
  requestedAtMs: NOW,
  approverId: null,
  approvedAtMs: null,
  closeReason: null,
  approvals: [],
  ...o,
});

beforeAll(async () => {
  container = await startPostgres({ name: `peaket-f0413-review-${process.pid}` });
  await migrateOps(container.url);
  database = createDatabase({ url: container.url, applicationName: 'ops-svc-fraud-review-int', max: 8 });
  raw = new pg.Client({ connectionString: container.url });
  await raw.connect();
  store = new DrizzleInvestigationStore(database);
});

afterAll(async () => {
  await raw?.end().catch(() => undefined);
  await database?.close();
  container?.stop();
});

describe('F-04-13 구현 리뷰 PostgreSQL', () => {
  test('IR-04 승인 저장소는 C5 회원 변경까지 같은 트랜잭션에 저장한다', async () => {
    const approvals = new DrizzleFraudApprovalStore(database);
    const c = caseOf({ status: 'INVESTIGATING', members: [member('0194b240-0000-7000-8000-000000000001', { appealResult: 'PENDING' })] });
    await store.putCase(c as any);
    const next = { ...c, status: 'DECISION_PENDING', approvalId: uuid(), version: 2, members: c.members.map((m: any) => ({ ...m, appealResult: 'EXPIRED' })) };
    const r = record(c, { approvalId: next.approvalId });
    const out = await approvals.request(r, {
      events: [{ seq: 2, kind: 'ACTION_REQUESTED', actorId: r.requestedBy, note: null, detail: { approvalId: r.approvalId, accountIds: r.accountIds, targets: r.targets }, occurredAtMs: NOW }],
      caseNext: next,
      expectedVersion: c.version,
      idem: { accountRef: r.requestedBy, operation: 'CREATE_FRAUD_ACTION_REQUEST', key: uuid(), requestHash: new Uint8Array(32) },
      result: { approvalId: r.approvalId },
    } as any);
    expect(out).toMatchObject({ replayed: false });
    const row = await raw.query('select appeal_result from fraud_cluster_member where cluster_id = $1 and account_id = $2', [c.clusterId, c.members[0].accountId]);
    expect(row.rows[0].appeal_result).toBe('EXPIRED');
    const caseRow = await raw.query('select status, version from fraud_case where id = $1', [c.caseId]);
    expect(caseRow.rows[0]).toEqual({ status: 'DECISION_PENDING', version: '2' });
  });

  test('IR-05 이의 인정이 만드는 LIFT 승인은 대상 계정과 ACTION_REQUESTED를 남긴다', async () => {
    const approvals = new DrizzleFraudApprovalStore(database);
    const restrictions = new DrizzleFraudRestrictions(database);
    const accountId = '0194b240-0000-7000-8000-000000000002';
    const c = caseOf({ status: 'OBJECTED', members: [member(accountId, { objectionResult: 'SUBMITTED', objectionReceivedAtMs: NOW - DAY, actionNotifiedAtMs: NOW - 10 * DAY })] });
    await store.putCase(c as any);
    const actions = new FraudActions({
      store,
      approvals,
      schedule: { get: async () => undefined },
      restrictions: {
        identity: { restrict: async () => undefined, lift: async () => undefined },
        queue: { set: async () => undefined },
        purchase: { set: async () => undefined },
        activeForCase: async () => [{ accountId, caseId: c.caseId, restrictionId: uuid(), untilMs: NOW + 30 * DAY, version: 1 }],
      },
      restrictionRows: restrictions,
      locks: { set: async () => ({ lockedTicketCount: 0, withdrawnOfferCount: 0, holders: [] }), release: async () => undefined },
      labels: { apply: async () => undefined },
      notifier: {
        holderNotice: async () => undefined,
        actionNotice: async () => undefined,
        holderResult: async () => undefined,
        objectionDecided: async () => undefined,
        restrictionLifted: async () => undefined,
        transferLockReleased: async () => undefined,
        deadlineNotice: async () => undefined,
      },
      now: () => NOW,
    } as any);
    const next = await actions.decideObjections({ accountId: uuid(), role: 'cs_lead' }, c, [{ accountId, decision: 'ACCEPTED', reason: '정상' }]);
    expect(next.status).toBe('OBJECTED');
    const row = await raw.query('select status, version, approval_id from fraud_case where id = $1', [c.caseId]);
    expect(row.rows[0]).toMatchObject({ status: 'OBJECTED', version: '2' });
    const approval = await approvals.get(next.approvalId!);
    expect(approval?.accountIds).toEqual([accountId]);
    const event = await raw.query("select count(*)::int as n from fraud_case_event where case_id = $1 and kind = 'ACTION_REQUESTED'", [c.caseId]);
    expect(event.rows[0].n).toBe(1);
    const decided = await raw.query("select count(*)::int as n from fraud_case_event where case_id = $1 and kind = 'OBJECTION_DECIDED'", [c.caseId]);
    expect(decided.rows[0].n).toBe(1);
  });

  test('IR-07 승인 상태와 사건·기록은 한 트랜잭션이고 판이 틀리면 승인도 남지 않는다', async () => {
    const approvals = new DrizzleFraudApprovalStore(database);
    const c = caseOf();
    await store.putCase(c as any);
    const r = record(c);
    await approvals.request(r, { events: [] });
    const wrong = { ...c, status: 'ACTIONED', version: 2 };
    const out = await approvals.setStatus({
      approvalId: r.approvalId,
      status: 'DONE',
      from: ['PENDING_APPROVAL'],
      approverId: uuid(),
      reason: '근거',
      nowMs: NOW,
      case: { next: wrong, expectedVersion: 99, events: [{ seq: 2, kind: 'ACTIONED', actorId: null, note: null, detail: null, occurredAtMs: NOW }] },
    } as any);
    expect(out).toMatchObject({ ok: false });
    const row = await raw.query('select status from approval_request where id = $1', [r.approvalId]);
    expect(row.rows[0].status).toBe('PENDING_APPROVAL');
    const caseRow = await raw.query('select status, version from fraud_case where id = $1', [c.caseId]);
    expect(caseRow.rows[0]).toEqual({ status: 'APPEAL_PENDING', version: '1' });
  });

  test('IR-07 승인은 ACTION_APPROVED와 admin_data_access 감사를 같은 트랜잭션에 남긴다', async () => {
    const approvals = new DrizzleFraudApprovalStore(database);
    const payer = '0194b240-0000-7000-8000-000000000003';
    const t1 = uuid();
    const t2 = uuid();
    const c = caseOf({ status: 'APPEAL_PENDING', members: [member(payer)] });
    await store.putCase(c as any);
    const r = record(c, {
      action: 'CANCEL_TICKETS',
      targets: [
        { ticketId: t1, payerAccountId: payer, holderAccountId: payer, status: 'ISSUED', entryRecorded: false },
        { ticketId: t2, payerAccountId: payer, holderAccountId: payer, status: 'ISSUED', entryRecorded: false },
      ],
    });
    const decisionPending = { ...c, status: 'DECISION_PENDING', approvalId: r.approvalId, version: 2 } as any;
    await approvals.request(r, {
      events: [{ seq: 2, kind: 'ACTION_REQUESTED', actorId: r.requestedBy, note: null, detail: { approvalId: r.approvalId, accountIds: r.accountIds, targets: r.targets }, occurredAtMs: NOW }],
      caseNext: decisionPending,
      expectedVersion: 1,
    } as any);
    const approver = uuid();
    const loaded = await approvals.get(r.approvalId);
    expect(loaded?.targets.map((t) => t.ticketId)).toEqual([t1, t2]);
    await approvals.recordSummaryView({ approvalId: r.approvalId, adminAccountId: approver, nowMs: NOW });
    const actions = new FraudActions({
      store,
      approvals,
      schedule: { get: async () => undefined },
      cancellations: { cancel: async (i: any) => i.targets.map((t: any) => ({ ticketId: t.ticketId, outcome: 'ACCEPTED', cancellationId: uuid(), refundAmount: 100_000 })) },
      locks: { set: async () => ({ lockedTicketCount: 0, withdrawnOfferCount: 0, holders: [] }), release: async () => undefined },
      labels: { apply: async () => undefined },
      notifier: {
        holderNotice: async () => undefined,
        actionNotice: async () => undefined,
        holderResult: async () => undefined,
        objectionDecided: async () => undefined,
        restrictionLifted: async () => undefined,
        transferLockReleased: async () => undefined,
        deadlineNotice: async () => undefined,
      },
      approverIdentity: { designations: async () => [], recentlyRevoked: async () => [] },
      reauth: { verify: async () => ({ accountId: approver }) },
      now: () => NOW,
    } as any);
    await actions.approve(r.approvalId, { accountId: approver, role: 'commander', sessionId: uuid() }, 'reauth-token', { reason: '근거', excludeTicketIds: [t2] });
    const event = await raw.query("select detail from fraud_case_event where case_id = $1 and kind = 'ACTION_APPROVED'", [c.caseId]);
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0].detail.excludedTickets).toEqual([t2]);
    expect(event.rows[0].detail.summaryViewedAt).toBeTruthy();
    const audit = await raw.query("select count(*)::int as n from audit_chain where record_type = 'ADMIN_DATA_ACCESS' and record_json->'payload'->>'approvalId' = $1", [r.approvalId]);
    expect(audit.rows[0].n).toBe(1);
  });

  test('IR-11 한 사건의 열린 FRAUD_ACTION은 하나이고 상태 전이는 조건부다', async () => {
    const approvals = new DrizzleFraudApprovalStore(database);
    const c = caseOf();
    await store.putCase(c as any);
    const first = record(c);
    await approvals.request(first, { events: [] });
    const second = record(c);
    await expect(approvals.request(second, { events: [] })).rejects.toThrow();
    const claim = (status: string) => approvals.setStatus({ approvalId: first.approvalId, status, from: ['PENDING_APPROVAL'], nowMs: NOW } as any);
    expect(await claim('EXECUTING')).toMatchObject({ ok: true });
    expect(await claim('EXECUTING')).toMatchObject({ ok: false });
  });

  test('IR-13 이용 제한은 같은 사건만 갱신하고 계정별 판·재시도·appeal_due_at을 지킨다', async () => {
    const restrictions = new DrizzleFraudRestrictions(database);
    const accountId = uuid();
    const otherCase = uuid();
    const caseId = uuid();
    await raw.query(
      "insert into booking_restriction (id, account_id, reason_code, fraud_case_id, confirmed_by, starts_at, ends_at, appeal_due_at, status, version) values ($1,$2,'FRAUD',$3,$4,now(),$5,now() + interval '1 day','ACTIVE',1)",
      [uuid(), accountId, otherCase, uuid(), new Date(NOW + 30 * DAY)],
    );
    const restrictionId = uuid();
    const first = await restrictions.restrict({ accountId, caseId, restrictionId, version: 1, untilMs: NOW + 30 * DAY, actedBy: uuid() });
    expect(first).toMatchObject({ version: 2 });
    const other = await raw.query('select status from booking_restriction where fraud_case_id = $1', [otherCase]);
    expect(other.rows[0].status).toBe('ACTIVE');
    await expect(restrictions.restrict({ accountId, caseId, restrictionId, version: 1, untilMs: NOW + 31 * DAY, actedBy: uuid() })).resolves.toBeTruthy();
    const active = await restrictions.activeForCase(caseId);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ accountId, restrictionId, version: 2 });
    const diff = await raw.query("select extract(epoch from (appeal_due_at - starts_at)) as seconds from booking_restriction where id = $1", [restrictionId]);
    expect(Number(diff.rows[0].seconds)).toBeGreaterThanOrEqual(86_400);
  });
});
