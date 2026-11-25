// F-04-12 조사 HTTP 시험(동결 로컬, LCH-260, FX-T12·FX-T15·FX-T16·FX-T18·C-T63 ①).
// AppModule 메모리 조립에 조사 모듈을 붙여 권한·상태·소명 요청·다시 돌리기·접속기록을 바깥 경계에서 본다.
// 정본: docs/features/forensic-replay.md §6.2·§6.7.4·§6.7.5·§6.7.8, docs/api/openapi.yaml 태그 investigations.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import {
  MemoryInvestigationStore,
  VerifyDailySnapshots,
  type FraudAlerts,
  type FraudCaseRecord,
  type FraudClusterMemberRecord,
  type FraudClusterRecord,
  type FraudLabels,
  type FraudNotifier,
  type FraudOpsEventSink,
  type FraudRunRecord,
  type FraudSnapshotRecord,
  type InvestigationAccessLog,
  type InvestigationStore,
  type SnapshotVerifier,
  type TransferLocks,
} from '../src/modules/investigations/index.js';
import type { SaleScheduleSource } from '../src/modules/readiness/index.js';
import { FakeAdminIdentity } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-25T00:00:00.000Z');
const SHOW = Date.parse('2026-12-02T10:00:00.000Z');
const SALE_ENDS = SHOW - 24 * HOUR;
const CANCEL = SHOW - 26 * HOUR;
const SOURCE_EXPIRES = SHOW + 30 * DAY;

const id = (n: number) => `0194b200-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const hex = (c: string) => c.repeat(64);
const iso = (ms: number) => new Date(ms).toISOString();

const EVENT = id(0x200);
const EVENT_OLD = id(0x201);
const EVENT_RETRY = id(0x202);
const EVENT_MANUAL = id(0x203);
const EVENT_RUNNING = id(0x204);
const EVENT_VERIFY = id(0x205);
const EVENT_EMPTY = id(0x206);

const CL_MAIN = id(0x301);
const CL_PATCH = id(0x302);
const CL_CLEAR = id(0x303);
const CL_APPEAL = id(0x304);
const CL_C14 = id(0x305);
const CL_FAIL = id(0x306);
const CL_INVALID = id(0x307);
const CL_SEEDED = id(0x308);
const CL_MEMBERS = id(0x309);
const CL_APPEAL2 = id(0x30a);
const CL_IDEM = id(0x30b);

const A = (n: number) => id(0x1000 + n);
const HOLDER = id(0x1500);
const T1 = id(0x1601);
const T2 = id(0x1602);

const CASE_SEEDED = id(0x400);
const CASE_CLEAR = id(0x401);

type Req = { statusCode: number; payload: string; headers: Record<string, string | string[] | undefined> };
const json = (r: Req) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, unknown>));
const typeOf = (r: Req) => String(json(r).type ?? '');

const scheduleMap = new Map<string, { opensAtMs: number; saleEndsAtMs: number; entryOpensAtMs: number | null; entryClosedAtMs: number | null }>([
  [EVENT, { opensAtMs: SHOW - 7 * DAY, saleEndsAtMs: SALE_ENDS, entryOpensAtMs: SHOW, entryClosedAtMs: SHOW + 3 * HOUR }],
  [EVENT_RETRY, { opensAtMs: SHOW - 7 * DAY, saleEndsAtMs: SALE_ENDS, entryOpensAtMs: SHOW, entryClosedAtMs: SHOW + 3 * HOUR }],
  [EVENT_MANUAL, { opensAtMs: SHOW - 7 * DAY, saleEndsAtMs: SALE_ENDS, entryOpensAtMs: SHOW, entryClosedAtMs: SHOW + 3 * HOUR }],
  [EVENT_RUNNING, { opensAtMs: SHOW - 7 * DAY, saleEndsAtMs: SALE_ENDS, entryOpensAtMs: SHOW, entryClosedAtMs: SHOW + 3 * HOUR }],
  [EVENT_VERIFY, { opensAtMs: SHOW - 7 * DAY, saleEndsAtMs: SALE_ENDS, entryOpensAtMs: SHOW, entryClosedAtMs: SHOW + 3 * HOUR }],
  [EVENT_EMPTY, { opensAtMs: SHOW - 7 * DAY, saleEndsAtMs: SALE_ENDS, entryOpensAtMs: SHOW, entryClosedAtMs: SHOW + 3 * HOUR }],
  // 40일 전 공연: 원천 보존(공연일 + 30일)이 지났다
  [EVENT_OLD, { opensAtMs: NOW - 41 * DAY, saleEndsAtMs: NOW - 40 * DAY - 24 * HOUR, entryOpensAtMs: NOW - 40 * DAY, entryClosedAtMs: NOW - 40 * DAY + 3 * HOUR }],
]);
const schedule: SaleScheduleSource = { get: async (eventId: string) => scheduleMap.get(eventId) };

class FakeLocks implements TransferLocks {
  readonly sets: Array<{ caseId: string; eventId: string; accountIds: readonly string[]; version: number; expiresAtMs: number }> = [];
  readonly releases: Array<{ caseId: string; eventId: string; accountIds: readonly string[] }> = [];
  failNextSet = false;
  async set(i: { caseId: string; eventId: string; accountIds: readonly string[]; version: number; expiresAtMs: number }) {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error('ticket-svc SetTransferLock 시간 초과');
    }
    this.sets.push(i);
    return {
      lockedTicketCount: 18,
      withdrawnOfferCount: 2,
      holders: [
        { accountId: HOLDER, ticketIds: [T1] },
        { accountId: HOLDER, ticketIds: [T2] },
      ],
    };
  }
  async release(i: { caseId: string; eventId: string; accountIds: readonly string[] }) {
    this.releases.push(i);
  }
}

class FakeNotifier implements FraudNotifier {
  readonly holders: Array<{ eventId: string; caseId: string; accountId: string; ticketIds: readonly string[]; dueAtMs: number }> = [];
  async holderNotice(i: { eventId: string; caseId: string; accountId: string; ticketIds: readonly string[]; dueAtMs: number }) {
    this.holders.push(i);
  }
}

class FakeLabels implements FraudLabels {
  readonly calls: Array<{ eventId: string; caseId: string; accountIds: readonly string[]; label: 'HUMAN' | 'BOT' }> = [];
  async apply(i: { eventId: string; caseId: string; accountIds: readonly string[]; label: 'HUMAN' | 'BOT' }) {
    this.calls.push(i);
  }
}

class FakeAlerts implements FraudAlerts {
  readonly calls: Array<{ eventId: string; version: number; severity: 'SEV2' | 'SEV3'; kind: string }> = [];
  async raise(i: { eventId: string; version: number; severity: 'SEV2' | 'SEV3'; kind: string }) {
    this.calls.push(i);
  }
}

class FakeAccess implements InvestigationAccessLog {
  readonly records: Array<Record<string, unknown>> = [];
  async record(i: Record<string, unknown>) {
    this.records.push(i);
  }
}

class FakeEvents implements FraudOpsEventSink {
  readonly lines: any[] = [];
  emit(i: any) {
    this.lines.push(i);
  }
}

class FakeVerifier implements SnapshotVerifier {
  mismatchFor: string | undefined;
  async verify(s: FraudSnapshotRecord) {
    return s.eventId === this.mismatchFor ? { ok: false, mismatchedTables: ['inv_step'] } : { ok: true, mismatchedTables: [] };
  }
}

const store = new MemoryInvestigationStore();
const locks = new FakeLocks();
const notifier = new FakeNotifier();
const labels = new FakeLabels();
const alerts = new FakeAlerts();
const access = new FakeAccess();
const events = new FakeEvents();
const verifier = new FakeVerifier();
const admin = new FakeAdminIdentity();
const identity = new FakeIdentity();
const clock = fakeClock({ now: NOW });
const audit = new MemoryAuditChain();
let svc: Awaited<ReturnType<typeof createService>>;
let seq = 0;
const newId = () => `0194b201-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

const memberOf = (accountId: string, o: Partial<FraudClusterMemberRecord> = {}): FraudClusterMemberRecord => ({
  accountId,
  ticketCount: 9,
  signals: ['LINK_GRAPH'],
  addedBy: 'SYSTEM',
  removedAtMs: null,
  appealResult: 'NOT_REQUESTED',
  appealDueAtMs: null,
  lockExpiresAtMs: null,
  ...o,
});

const clusterOf = (clusterId: string, accounts: readonly string[], o: Partial<FraudClusterRecord> = {}): FraudClusterRecord => ({
  clusterId,
  eventId: EVENT,
  generation: 1,
  scoreBand: 'HIGH',
  accountCount: accounts.length,
  purchaseCount: accounts.length * 9,
  limitPerPerson: 4,
  sharedAttributes: ['PAYMENT_METHOD'],
  signals: ['LINK_GRAPH'],
  snapshotVersion: 1,
  createdAtMs: NOW - HOUR,
  members: accounts.map((a) => memberOf(a)),
  ...o,
});

const runOf = (eventId: string, o: Partial<FraudRunRecord> = {}): FraudRunRecord => ({
  eventId,
  generation: 1,
  attempt: 1,
  trigger: 'SCHEDULED',
  snapshotVersion: 1,
  ruleVersion: 'fraud-rules-v1',
  status: 'DONE',
  failureReason: null,
  resultFingerprint: hex('c'),
  clusterCount: 5,
  startedAtMs: NOW - 2 * HOUR,
  finishedAtMs: NOW - HOUR,
  ...o,
});

const snapshotOf = (eventId: string, o: Partial<FraudSnapshotRecord> = {}): FraudSnapshotRecord => ({
  eventId,
  version: 1,
  frozenAtMs: NOW - HOUR,
  invHash: hex('b'),
  prevHash: null,
  tableHashes: { inv_request: hex('1'), inv_step: hex('2'), inv_behavior: hex('3'), inv_link: hex('4') },
  rowCounts: { inv_request: 10, inv_step: 20, inv_behavior: 30, inv_link: 40 },
  rangeFromMs: null,
  late: false,
  verifyStatus: null,
  verifiedAtMs: null,
  ...o,
});

const caseOf = (o: Partial<FraudCaseRecord> = {}): FraudCaseRecord => ({
  caseId: newId(),
  eventId: EVENT,
  clusterId: CL_SEEDED,
  status: 'INVESTIGATING',
  reasonCategory: 'MACRO_BOT',
  assigneeId: id(0x900),
  cancelDeadlineAtMs: CANCEL,
  appealDueAtMs: null,
  approvalId: null,
  investigatorOpinion: null,
  outcomeLabel: null,
  version: 1,
  createdAtMs: NOW - HOUR,
  closedAtMs: null,
  members: [memberOf(A(20)), memberOf(A(21)), memberOf(A(22))],
  events: [{ seq: 1, kind: 'CREATED', actorId: id(0x900), note: null, detail: null, occurredAtMs: NOW - HOUR }],
  ...o,
});

beforeAll(async () => {
  await store.putSnapshot(snapshotOf(EVENT));
  await store.putRun(runOf(EVENT));
  await store.putClusters(EVENT, 1, [
    clusterOf(CL_MAIN, [A(1), A(2), A(3)], { purchaseCount: 27 }),
    clusterOf(CL_PATCH, [A(4), A(5), A(6)], { purchaseCount: 18 }),
    clusterOf(CL_CLEAR, [A(7), A(8), A(9)], { purchaseCount: 12 }),
    clusterOf(CL_APPEAL, [A(10), A(11), A(12)], { purchaseCount: 9 }),
    clusterOf(CL_C14, [A(13), A(14), A(15)], { purchaseCount: 9 }),
    clusterOf(CL_FAIL, [A(16), A(17), A(18)], { purchaseCount: 9 }),
    clusterOf(CL_INVALID, [A(19)], { purchaseCount: 1, scoreBand: 'LOW' }),
    clusterOf(CL_SEEDED, [A(20), A(21), A(22)], { purchaseCount: 27 }),
    clusterOf(CL_MEMBERS, [A(23), A(24), A(25)], { purchaseCount: 18 }),
    clusterOf(CL_APPEAL2, [A(26), A(27), A(28)], { purchaseCount: 9 }),
    clusterOf(CL_IDEM, [A(30), A(31)], { purchaseCount: 9 }),
  ]);
  await store.putCase(caseOf({ caseId: CASE_SEEDED, clusterId: CL_SEEDED }));
  await store.putCase(
    caseOf({
      caseId: CASE_CLEAR,
      clusterId: CL_CLEAR,
      status: 'APPEAL_PENDING',
      version: 2,
      appealDueAtMs: NOW + 2 * DAY,
      members: [A(7), A(8), A(9)].map((a) => memberOf(a, { appealResult: 'SUBMITTED', appealDueAtMs: NOW + 2 * DAY, lockExpiresAtMs: NOW + 14 * DAY })),
      events: [
        { seq: 1, kind: 'CREATED', actorId: id(0x900), note: null, detail: null, occurredAtMs: NOW - HOUR },
        { seq: 2, kind: 'APPEAL_REQUESTED', actorId: id(0x900), note: null, detail: null, occurredAtMs: NOW - HOUR },
      ],
    }),
  );
  for (const run of [
    runOf(EVENT_RETRY, { status: 'FAILED', failureReason: 'TIMEOUT', resultFingerprint: null, clusterCount: null, attempt: 1 }),
    runOf(EVENT_MANUAL, { status: 'FAILED', failureReason: 'OTHER', resultFingerprint: null, clusterCount: null, attempt: 4 }),
    runOf(EVENT_RUNNING, { status: 'RUNNING', finishedAtMs: null, resultFingerprint: null, clusterCount: null }),
    runOf(EVENT_OLD, { status: 'FAILED', failureReason: 'TIMEOUT', resultFingerprint: null, clusterCount: null, attempt: 4 }),
    runOf(EVENT_VERIFY),
  ]) {
    await store.putRun(run);
  }
  await store.putSnapshot(snapshotOf(EVENT_VERIFY));

  svc = await createService({
    name: 'ops-svc-investigations',
    module: AppModule.register({
      memory: true,
      auditChain: audit,
      adminAccounts: { identity: admin },
      investigations: {
        store,
        schedule,
        locks,
        notifier,
        labels,
        alerts,
        access,
        events,
        verifier,
        now: () => clock.now(),
      },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});

afterAll(async () => {
  await svc?.close();
});

const send = (
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  headers: Record<string, string>,
  o: { body?: unknown; idem?: string | null; ifMatch?: string } = {},
): Promise<Req> =>
  svc.http.inject({
    method,
    url,
    headers: {
      ...headers,
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...(o.idem === undefined ? {} : o.idem === null ? {} : { 'idempotency-key': o.idem }),
      ...(o.ifMatch ? { 'if-match': o.ifMatch } : {}),
    },
    ...(o.body === undefined ? {} : { payload: JSON.stringify(o.body) }),
  }) as unknown as Promise<Req>;

/** 조사관 지정을 붙인 계정 하나. 매번 새 계정이라 시험끼리 섞이지 않는다 */
const investigator = (designations: Array<'FRAUD_INVESTIGATOR' | 'PSEUDONYM_HANDLER'> = ['FRAUD_INVESTIGATOR'], role: 'commander' | 'cs_lead' = 'cs_lead') => {
  const who = identity.ops(role);
  admin.seed({ adminAccountId: who['x-user-id']!, role, designations });
  return who;
};

const createCase = (who: Record<string, string>, clusterId: string, reasonCategory = 'MACRO_BOT') =>
  send('POST', '/v1/ops/fraud-cases', who, { idem: randomUUID(), body: { clusterId, reasonCategory } });

describe('F-04-12 조사 HTTP', () => {
  test('FX-T16 ② 지정 없는 commander·cs_lead는 조사 경로 전부가 403 investigator-required이고 접속기록에 남는다', async () => {
    const commander = identity.ops('commander');
    admin.seed({ adminAccountId: commander['x-user-id']!, role: 'commander', designations: [] });
    const csLead = identity.ops('cs_lead');
    admin.seed({ adminAccountId: csLead['x-user-id']!, role: 'cs_lead', designations: [] });
    for (const who of [commander, csLead]) {
      const attempts: Array<Promise<Req>> = [
        send('GET', `/v1/ops/events/${EVENT}/fraud-overview`, who),
        send('POST', `/v1/ops/events/${EVENT}/fraud-cluster-runs`, who, { idem: randomUUID() }),
        send('GET', `/v1/ops/fraud-clusters?eventId=${EVENT}`, who),
        send('GET', `/v1/ops/fraud-clusters/${CL_MAIN}`, who),
        send('POST', '/v1/ops/fraud-cases', who, { idem: randomUUID(), body: { clusterId: CL_MAIN, reasonCategory: 'MACRO_BOT' } }),
        send('GET', `/v1/ops/fraud-cases?eventId=${EVENT}`, who),
        send('GET', `/v1/ops/fraud-cases/${CASE_SEEDED}`, who),
        send('PATCH', `/v1/ops/fraud-cases/${CASE_SEEDED}`, who, { body: { note: 'x' }, ifMatch: '"1"' }),
        send('POST', `/v1/ops/fraud-cases/${CASE_SEEDED}/appeal-requests`, who, {
          idem: randomUUID(),
          body: { accountIds: [A(20)], reasonCategories: ['MACRO_BOT'], dueAt: iso(NOW + 2 * DAY) },
        }),
      ];
      const before = access.records.length;
      for (const r of await Promise.all(attempts)) {
        expect(r.statusCode, r.payload).toBe(403);
        expect(typeOf(r), r.payload).toMatch(/investigator-required$/);
        expect(r.headers['cache-control']).toBe('no-store');
      }
      expect(access.records.length, '거절도 접속기록에 남는다').toBeGreaterThanOrEqual(before + 9);
      expect(access.records.slice(before).every((x) => x.outcome === 'DENIED')).toBe(true);
    }
  });

  test('FX-T16 ③ operator·viewer·cs_agent는 조사 경로가 403이다', async () => {
    for (const role of ['operator', 'viewer', 'cs_agent'] as const) {
      const who = identity.ops(role);
      admin.seed({ adminAccountId: who['x-user-id']!, role, designations: [] });
      expect((await send('GET', `/v1/ops/events/${EVENT}/fraud-overview`, who)).statusCode, role).toBe(403);
    }
  });

  test('FX-T16 ④ 지정된 cs_lead는 조사 경로를 쓰고 지정을 거두면 다음 요청부터 403이다', async () => {
    const who = investigator(['FRAUD_INVESTIGATOR'], 'cs_lead');
    const before = admin.calls.filter((c) => c.startsWith(`designations:${who['x-user-id']}`)).length;
    const ok = await send('GET', `/v1/ops/events/${EVENT}/fraud-overview`, who);
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(json(ok).eventId).toBe(EVENT);
    expect(admin.calls.filter((c) => c.startsWith(`designations:${who['x-user-id']}`)).length).toBe(before + 1);
    admin.seed({ adminAccountId: who['x-user-id']!, role: 'cs_lead', designations: [] });
    const denied = await send('GET', `/v1/ops/events/${EVENT}/fraud-overview`, who);
    expect(denied.statusCode).toBe(403);
    expect(typeOf(denied)).toMatch(/investigator-required$/);
    expect(admin.calls.filter((c) => c.startsWith(`designations:${who['x-user-id']}`)).length).toBe(before + 2);
  });

  test('FX-T16 ⑤ 조사관과 가명정보 취급자 지정을 함께 가진 계정은 403이다', async () => {
    const who = investigator(['FRAUD_INVESTIGATOR', 'PSEUDONYM_HANDLER'], 'commander');
    const r = await send('GET', `/v1/ops/events/${EVENT}/fraud-overview`, who);
    expect(r.statusCode).toBe(403);
    expect(typeOf(r)).toMatch(/investigator-required$/);
  });

  test('FX-T16 ⑥ 두 조사관이 같은 사건을 같은 판으로 고치면 늦은 쪽이 412이고 If-Match가 없으면 428이다', async () => {
    const one = investigator();
    const created = await createCase(one, CL_PATCH);
    expect(created.statusCode, created.payload).toBe(201);
    const caseId = json(created).caseId as string;
    const missing = await send('PATCH', `/v1/ops/fraud-cases/${caseId}`, one, { body: { note: '판 없이' } });
    expect(missing.statusCode).toBe(428);
    expect(typeOf(missing)).toMatch(/precondition-required$/);
    const first = await send('PATCH', `/v1/ops/fraud-cases/${caseId}`, one, { body: { note: '첫 수정' }, ifMatch: '"1"' });
    expect(first.statusCode, first.payload).toBe(200);
    expect(first.headers.etag).toBe('"2"');
    const other = investigator();
    const late = await send('PATCH', `/v1/ops/fraud-cases/${caseId}`, other, { body: { note: '늦은 수정' }, ifMatch: '"1"' });
    expect(late.statusCode).toBe(412);
    expect(typeOf(late)).toMatch(/precondition-failed$/);
  });

  test('FX-T12 ⑪ 묶음에서 사건을 만들면 201과 Location을 주고 담당자가 되며 같은 묶음은 409다', async () => {
    const who = investigator();
    const r = await createCase(who, CL_MAIN);
    expect(r.statusCode, r.payload).toBe(201);
    expect(r.headers.location).toMatch(/^\/v1\/ops\/fraud-cases\//);
    const body = json(r);
    expect(body).toMatchObject({
      eventId: EVENT,
      clusterId: CL_MAIN,
      status: 'INVESTIGATING',
      assigneeId: who['x-user-id'],
      accountCount: 3,
      ticketCount: 27,
      version: 1,
      cancelDeadlineAt: iso(CANCEL),
    });
    expect((body.events as Array<Record<string, unknown>>)[0]).toMatchObject({ seq: 1, kind: 'CREATED', actorId: who['x-user-id'] });
    expect((body.members as Array<Record<string, unknown>>).map((m) => m.accountId)).toEqual([A(1), A(2), A(3)]);
    const dup = await createCase(investigator(), CL_MAIN);
    expect(dup.statusCode).toBe(409);
    expect(typeOf(dup)).toMatch(/fraud-case-exists$/);
  });

  test('FX-T12 ⑫ 사건 목록과 상세는 상태·회차로 거르고 ETag는 사건 판이다', async () => {
    const who = investigator();
    const created = await createCase(who, CL_INVALID);
    expect(created.statusCode, created.payload).toBe(201);
    const caseId = json(created).caseId as string;
    const list = await send('GET', `/v1/ops/fraud-cases?eventId=${EVENT}&status=INVESTIGATING`, who);
    expect(list.statusCode, list.payload).toBe(200);
    expect((json(list).items as Array<Record<string, unknown>>).some((c) => c.caseId === caseId)).toBe(true);
    const detail = await send('GET', `/v1/ops/fraud-cases/${caseId}`, who);
    expect(detail.statusCode, detail.payload).toBe(200);
    expect(detail.headers.etag).toBe('"1"');
    expect(json(detail)).toMatchObject({ caseId, eventId: EVENT, status: 'INVESTIGATING', cancelDeadlineAt: iso(CANCEL) });
    expect(json(detail).snapshot).toMatchObject({ version: 1, invHash: hex('b') });
  });

  test('FX-T12 ⑬ 계정 빼기·더하기와 메모를 PATCH로 남기고 사건 기록에 누가·왜가 쌓인다', async () => {
    const who = investigator();
    const created = await createCase(who, CL_MEMBERS);
    expect(created.statusCode, created.payload).toBe(201);
    const caseId = json(created).caseId as string;
    const removed = await send('PATCH', `/v1/ops/fraud-cases/${caseId}`, who, {
      ifMatch: '"1"',
      body: { removeMembers: [{ accountId: A(23), reason: '가족 대리 예매' }], note: '확인함' },
    });
    expect(removed.statusCode, removed.payload).toBe(200);
    expect((json(removed).members as Array<Record<string, unknown>>).find((m) => m.accountId === A(23))).toMatchObject({ removed: true });
    const eventsAfterRemove = json(removed).events as Array<Record<string, unknown>>;
    expect(eventsAfterRemove.some((e) => e.kind === 'MEMBER_REMOVED' && e.actorId === who['x-user-id'])).toBe(true);
    expect(JSON.stringify(eventsAfterRemove)).toContain('가족 대리 예매');
    const added = await send('PATCH', `/v1/ops/fraud-cases/${caseId}`, who, {
      ifMatch: '"2"',
      body: { addMembers: [{ accountId: A(23), reason: '새 증거' }] },
    });
    expect(added.statusCode, added.payload).toBe(200);
    expect((json(added).members as Array<Record<string, unknown>>).find((m) => m.accountId === A(23))).toMatchObject({
      removed: false,
      addedBy: 'INVESTIGATOR',
      appealResult: 'NOT_REQUESTED',
    });
    expect(JSON.stringify(json(added).events)).toContain('새 증거');
    expect(json(added).version).toBe(3);
  });

  test('FX-T12 ⑭ 소명 요청은 기한·사유 범주·잠금 결과·받은 사람 수를 주고 사건은 소명 대기가 된다', async () => {
    const who = investigator();
    const created = await createCase(who, CL_APPEAL);
    expect(created.statusCode, created.payload).toBe(201);
    const caseId = json(created).caseId as string;
    const idem = randomUUID();
    const body = { accountIds: [A(10), A(11)], reasonCategories: ['MACRO_BOT', 'QUEUE_BYPASS'], dueAt: iso(NOW + 2 * DAY) };
    const r = await send('POST', `/v1/ops/fraud-cases/${caseId}/appeal-requests`, who, { idem, body });
    expect(r.statusCode, r.payload).toBe(201);
    const out = json(r);
    expect(out).toMatchObject({
      caseId,
      accountIds: [A(10), A(11)],
      dueAt: iso(NOW + 2 * DAY),
      lockedTicketCount: 18,
      withdrawnOfferCount: 2,
      lockExpiresAt: iso(NOW + 14 * DAY),
      notifiedHolderCount: 1,
    });
    expect(String(out.appealRequestId)).toMatch(/^[0-9a-f]{8}-/);
    const lock = locks.sets.at(-1)!;
    expect(lock).toMatchObject({ caseId, eventId: EVENT, accountIds: [A(10), A(11)], expiresAtMs: NOW + 14 * DAY });
    const detail = await send('GET', `/v1/ops/fraud-cases/${caseId}`, who);
    expect(detail.statusCode, detail.payload).toBe(200);
    expect(json(detail)).toMatchObject({ status: 'APPEAL_PENDING', appealDueAt: iso(NOW + 2 * DAY) });
    const members = json(detail).members as Array<Record<string, unknown>>;
    expect(members.find((m) => m.accountId === A(10))).toMatchObject({ appealResult: 'PENDING', lockExpiresAt: iso(NOW + 14 * DAY) });
    expect(members.find((m) => m.accountId === A(12))).toMatchObject({ appealResult: 'NOT_REQUESTED', lockExpiresAt: null });
    // 같은 키 재요청은 같은 결과다
    const replay = await send('POST', `/v1/ops/fraud-cases/${caseId}/appeal-requests`, who, { idem, body });
    expect(replay.statusCode, replay.payload).toBe(201);
    expect(json(replay)).toEqual(out);
  });

  test('FX-T15 ② 받은 사람 알림에는 결제자의 사유 범주가 없고 잠금 기한은 계정의 첫 요청 + 14일이다', async () => {
    const who = investigator();
    const created = await createCase(who, CL_APPEAL2);
    expect(created.statusCode, created.payload).toBe(201);
    const caseId = json(created).caseId as string;
    const r = await send('POST', `/v1/ops/fraud-cases/${caseId}/appeal-requests`, who, {
      idem: randomUUID(),
      body: { accountIds: [A(26)], reasonCategories: ['ACCOUNT_LENDING'], dueAt: iso(NOW + 2 * DAY) },
    });
    expect(r.statusCode, r.payload).toBe(201);
    // 같은 보유자가 표 둘을 가져도 한 번만 알린다
    expect(notifier.holders.filter((h) => h.caseId === caseId)).toHaveLength(1);
    const notice = notifier.holders.find((h) => h.caseId === caseId)!;
    expect(notice).toMatchObject({ accountId: HOLDER, ticketIds: [T1, T2], dueAtMs: NOW + 2 * DAY });
    expect(JSON.stringify(notice)).not.toContain('ACCOUNT_LENDING');
    expect(JSON.stringify(notice)).not.toContain(A(26));
    // 잠금 기한은 계정의 첫 요청 + 14일이다
    expect(locks.sets.filter((s) => s.caseId === caseId).at(-1)!.expiresAtMs).toBe(NOW + 14 * DAY);
  });

  test('FX-T15 ③ 잠금 요청이 실패하면 사건 상태와 계정 소명 상태가 바뀌지 않는다', async () => {
    const who = investigator();
    const created = await createCase(who, CL_FAIL);
    expect(created.statusCode, created.payload).toBe(201);
    const caseId = json(created).caseId as string;
    locks.failNextSet = true;
    const r = await send('POST', `/v1/ops/fraud-cases/${caseId}/appeal-requests`, who, {
      idem: randomUUID(),
      body: { accountIds: [A(16)], reasonCategories: ['MACRO_BOT'], dueAt: iso(NOW + 2 * DAY) },
    });
    expect(r.statusCode).toBe(503);
    expect(typeOf(r)).toMatch(/dependency-unavailable$/);
    const detail = await send('GET', `/v1/ops/fraud-cases/${caseId}`, who);
    expect(detail.statusCode, detail.payload).toBe(200);
    expect(json(detail)).toMatchObject({ status: 'INVESTIGATING', version: 1 });
    expect((json(detail).members as Array<Record<string, unknown>>).every((m) => m.appealResult === 'NOT_REQUESTED')).toBe(true);
    expect(locks.releases.filter((x) => x.caseId === caseId)).toHaveLength(0);
  });

  test('FX-T12 ⑮ 소명 요청 뒤 새로 더한 계정만 다시 요청할 수 있고 그 계정은 자기 잠금 기한을 받는다', async () => {
    const who = investigator();
    const created = await createCase(who, CL_C14);
    expect(created.statusCode, created.payload).toBe(201);
    const caseId = json(created).caseId as string;
    const first = await send('POST', `/v1/ops/fraud-cases/${caseId}/appeal-requests`, who, {
      idem: randomUUID(),
      body: { accountIds: [A(13)], reasonCategories: ['MACRO_BOT'], dueAt: iso(NOW + 2 * DAY) },
    });
    expect(first.statusCode, first.payload).toBe(201);
    // 이미 요청한 계정을 다시 요청하면 409다
    const again = await send('POST', `/v1/ops/fraud-cases/${caseId}/appeal-requests`, who, {
      idem: randomUUID(),
      body: { accountIds: [A(13)], reasonCategories: ['MACRO_BOT'], dueAt: iso(NOW + 2 * DAY) },
    });
    expect(again.statusCode).toBe(409);
    expect(typeOf(again)).toMatch(/fraud-case-state$/);
    // 소명 대기에서 계정을 빼고 새로 더한 뒤에는 그 계정만 요청할 수 있다
    clock.advance(DAY);
    const removed = await send('PATCH', `/v1/ops/fraud-cases/${caseId}`, who, { ifMatch: '"2"', body: { removeMembers: [{ accountId: A(15), reason: '잠시 뺌' }] } });
    expect(removed.statusCode, removed.payload).toBe(200);
    const added = await send('PATCH', `/v1/ops/fraud-cases/${caseId}`, who, { ifMatch: '"3"', body: { addMembers: [{ accountId: A(15), reason: '새 증거' }] } });
    expect(added.statusCode, added.payload).toBe(200);
    const second = await send('POST', `/v1/ops/fraud-cases/${caseId}/appeal-requests`, who, {
      idem: randomUUID(),
      body: { accountIds: [A(15)], reasonCategories: ['QUEUE_BYPASS'], dueAt: iso(clock.now() + 2 * DAY) },
    });
    expect(second.statusCode, second.payload).toBe(201);
    expect(json(second).lockExpiresAt).toBe(iso(clock.now() + 14 * DAY));
    const detail = await send('GET', `/v1/ops/fraud-cases/${caseId}`, who);
    const members = json(detail).members as Array<Record<string, unknown>>;
    // A(13)의 기한은 첫 요청 + 14일 그대로다
    expect(members.find((m) => m.accountId === A(13))!.lockExpiresAt).toBe(iso(NOW + 14 * DAY));
    expect(members.find((m) => m.accountId === A(15))).toMatchObject({ appealResult: 'PENDING', lockExpiresAt: iso(clock.now() + 14 * DAY) });
    clock.advance(-DAY);
  });

  test('FX-T12 ⑯ 모든 계정이 인정되면 사건은 정상 종료하고 잠금 해제·정답 라벨 HUMAN이 남는다', async () => {
    const who = investigator();
    const r = await send('PATCH', `/v1/ops/fraud-cases/${CASE_CLEAR}`, who, {
      ifMatch: '"2"',
      body: {
        appealDecisions: [A(7), A(8), A(9)].map((accountId) => ({ accountId, decision: 'ACCEPTED', reason: '정상 구매' })),
      },
    });
    expect(r.statusCode, r.payload).toBe(200);
    expect(json(r)).toMatchObject({ status: 'CLEARED' });
    expect(json(r).closedAt).toBe(iso(clock.now()));
    const stored = await store.getCase(CASE_CLEAR);
    expect(stored).toMatchObject({ status: 'CLEARED', outcomeLabel: 'HUMAN' });
    expect(labels.calls.filter((c) => c.caseId === CASE_CLEAR).at(-1)).toMatchObject({ label: 'HUMAN', accountIds: [A(7), A(8), A(9)] });
    expect(locks.releases.filter((x) => x.caseId === CASE_CLEAR).at(-1)).toMatchObject({ accountIds: [A(7), A(8), A(9)] });
    // 정상 종료한 사건은 계정을 더하거나 뺄 수 없다
    const after = await send('PATCH', `/v1/ops/fraud-cases/${CASE_CLEAR}`, who, { ifMatch: '"3"', body: { removeMembers: [{ accountId: A(7), reason: 'x' }] } });
    expect(after.statusCode).toBe(409);
    expect(typeOf(after)).toMatch(/fraud-case-state$/);
  });

  test('FX-T12 ⑰ 후보 목록·상세·머리는 점수 원값·가중치 없이 판·상태·재시도 수를 준다', async () => {
    const who = investigator();
    const list = await send('GET', `/v1/ops/fraud-clusters?eventId=${EVENT}`, who);
    expect(list.statusCode, list.payload).toBe(200);
    const items = json(list).items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(8);
    expect(items[0]).toMatchObject({ scoreBand: 'HIGH', accountCount: 3, limitPerPerson: 4 });
    expect(JSON.stringify(items)).not.toMatch(/score(?!Band)|weight/i);
    const detail = await send('GET', `/v1/ops/fraud-clusters/${CL_MAIN}`, who);
    expect(detail.statusCode, detail.payload).toBe(200);
    expect((json(detail).members as Array<Record<string, unknown>>).map((m) => m.accountId)).toEqual([A(1), A(2), A(3)]);
    const overview = await send('GET', `/v1/ops/events/${EVENT}/fraud-overview`, who);
    expect(overview.statusCode, overview.payload).toBe(200);
    expect(json(overview)).toMatchObject({
      snapshot: { version: 1, frozenAt: iso(NOW - HOUR), invHash: hex('b'), late: false },
      latestRun: { generation: 1, attempt: 1, status: 'DONE', clusterCount: 5, autoRetriesLeft: 0 },
      rerunAllowed: false,
      cancelDeadlineAt: iso(CANCEL),
      sourceExpiresAt: iso(SOURCE_EXPIRES),
    });
    expect((json(overview).summary as Record<string, unknown>).caseCount).toBeGreaterThanOrEqual(1);
  });

  test('FX-T12 ⑱ 실패한 후보 계산만 다시 돌릴 수 있고 받으면 202와 MANUAL 사건 줄이 남는다', async () => {
    const who = investigator();
    const r = await send('POST', `/v1/ops/events/${EVENT_MANUAL}/fraud-cluster-runs`, who, { idem: randomUUID() });
    expect(r.statusCode, r.payload).toBe(202);
    expect(json(r)).toMatchObject({ generation: 1, attempt: 5, trigger: 'MANUAL', status: 'RUNNING' });
    expect(events.lines.filter((e: { opsEvent: string; eventId: string }) => e.opsEvent === 'FRAUD_CLUSTER_RUN' && e.eventId === EVENT_MANUAL).at(-1)).toMatchObject({
      stage: 'STARTED',
      generation: 1,
      attempt: 5,
      trigger: 'MANUAL',
    });
    const overview = await send('GET', `/v1/ops/events/${EVENT_MANUAL}/fraud-overview`, who);
    expect(json(overview).latestRun).toMatchObject({ attempt: 5, trigger: 'MANUAL', status: 'RUNNING' });
    expect(json(overview).rerunAllowed).toBe(false);
  });

  test('FX-T12 ⑲ 후보 계산이 실행 중·자동 재시도 남음·성공이면 다시 돌리기는 409, 원천 만료면 410이다', async () => {
    const who = investigator();
    const inProgress = await send('POST', `/v1/ops/events/${EVENT_RUNNING}/fraud-cluster-runs`, who, { idem: randomUUID() });
    expect(inProgress.statusCode).toBe(409);
    expect(typeOf(inProgress)).toMatch(/fraud-run-in-progress$/);
    const retrying = await send('POST', `/v1/ops/events/${EVENT_RETRY}/fraud-cluster-runs`, who, { idem: randomUUID() });
    expect(retrying.statusCode).toBe(409);
    expect(typeOf(retrying)).toMatch(/fraud-run-retrying$/);
    const done = await send('POST', `/v1/ops/events/${EVENT}/fraud-cluster-runs`, who, { idem: randomUUID() });
    expect(done.statusCode).toBe(409);
    expect(typeOf(done)).toMatch(/fraud-run-not-failed$/);
    const expired = await send('POST', `/v1/ops/events/${EVENT_OLD}/fraud-cluster-runs`, who, { idem: randomUUID() });
    expect(expired.statusCode).toBe(410);
    expect(typeOf(expired)).toMatch(/investigation-source-expired$/);
  });

  test('FX-T18 ③ 사건 상세·목록·머리의 취소 마감은 공연 시작 26시간 전이다', async () => {
    const who = investigator();
    const overview = await send('GET', `/v1/ops/events/${EVENT}/fraud-overview`, who);
    expect(json(overview).cancelDeadlineAt).toBe(iso(CANCEL));
    const list = await send('GET', `/v1/ops/fraud-cases?eventId=${EVENT}`, who);
    const first = (json(list).items as Array<Record<string, unknown>>)[0]!;
    expect(first.cancelDeadlineAt).toBe(iso(CANCEL));
    const detail = await send('GET', `/v1/ops/fraud-cases/${CASE_SEEDED}`, who);
    expect(json(detail).cancelDeadlineAt).toBe(iso(CANCEL));
    expect(CANCEL).toBe(SALE_ENDS - 2 * HOUR);
  });

  test('FX-T16 ⑦ 조사 경로 조회는 접속기록에 계정·경로·행 수를 남기고 IP 원문을 남기지 않는다', async () => {
    const who = investigator();
    const before = access.records.length;
    const r = await send('GET', `/v1/ops/fraud-cases/${CASE_SEEDED}`, who);
    expect(r.statusCode, r.payload).toBe(200);
    const record = access.records.slice(before).find((x) => x.outcome === 'ALLOWED')!;
    expect(record).toMatchObject({ accountId: who['x-user-id'], outcome: 'ALLOWED' });
    expect(Number(record.rows)).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(record)).not.toMatch(/"ip"|"remoteIp"|"contact"|"deviceRef"/);
    // 운영 감사 체인에도 남는다(C-T63 ①)
    expect(audit.entries.filter((e) => e.recordType === 'ADMIN_DATA_ACCESS').length).toBeGreaterThanOrEqual(1);
  });

  test('FX-T12 ⑳ 사건 만들기와 소명 요청은 Idempotency-Key가 없으면 400이고 같은 키 재요청은 같은 결과다', async () => {
    const who = investigator();
    const noKey = await send('POST', '/v1/ops/fraud-cases', who, { body: { clusterId: CL_IDEM, reasonCategory: 'MACRO_BOT' } });
    expect(noKey.statusCode).toBe(400);
    expect(typeOf(noKey)).toMatch(/idempotency-key-invalid$/);
    const key = randomUUID();
    const first = await send('POST', '/v1/ops/fraud-cases', who, { idem: key, body: { clusterId: CL_IDEM, reasonCategory: 'MACRO_BOT' } });
    expect(first.statusCode, first.payload).toBe(201);
    const replay = await send('POST', '/v1/ops/fraud-cases', who, { idem: key, body: { clusterId: CL_IDEM, reasonCategory: 'MACRO_BOT' } });
    expect(replay.statusCode, replay.payload).toBe(201);
    expect(json(replay)).toEqual(json(first));
    // 소명 요청도 같은 규칙이다
    const caseId = json(first).caseId as string;
    const noAppealKey = await send('POST', `/v1/ops/fraud-cases/${caseId}/appeal-requests`, who, {
      body: { accountIds: [A(30)], reasonCategories: ['MACRO_BOT'], dueAt: iso(NOW + 2 * DAY) },
    });
    expect(noAppealKey.statusCode).toBe(400);
    expect(typeOf(noAppealKey)).toMatch(/idempotency-key-invalid$/);
    const appealKey = randomUUID();
    const appeal = { accountIds: [A(30)], reasonCategories: ['MACRO_BOT'], dueAt: iso(NOW + 2 * DAY) };
    const firstAppeal = await send('POST', `/v1/ops/fraud-cases/${caseId}/appeal-requests`, who, { idem: appealKey, body: appeal });
    expect(firstAppeal.statusCode, firstAppeal.payload).toBe(201);
    const replayAppeal = await send('POST', `/v1/ops/fraud-cases/${caseId}/appeal-requests`, who, { idem: appealKey, body: appeal });
    expect(replayAppeal.statusCode, replayAppeal.payload).toBe(201);
    expect(json(replayAppeal)).toEqual(json(firstAppeal));
  });

  test('FX-T12 ㉑ 하루 검증이 불일치를 내면 SEV2 경보와 내보내기 차단을 남긴다', async () => {
    verifier.mismatchFor = EVENT_VERIFY;
    const job = new VerifyDailySnapshots({ store: store as InvestigationStore, verifier, alerts, events, now: () => clock.now() });
    const out = await job.runOnce();
    expect(out.checked).toBeGreaterThanOrEqual(1);
    expect(out.mismatched).toBe(1);
    expect(alerts.calls.filter((a) => a.eventId === EVENT_VERIFY).at(-1)).toMatchObject({ severity: 'SEV2', version: 1 });
    expect(await store.isSnapshotExportBlocked(EVENT_VERIFY, 1)).toBe(true);
    expect((await store.latestSnapshot(EVENT_VERIFY))!.verifyStatus).toBe('MISMATCH');
    expect(events.lines.filter((e: { opsEvent: string; eventId: string }) => e.opsEvent === 'FRAUD_SNAPSHOT' && e.eventId === EVENT_VERIFY).at(-1)).toMatchObject({ stage: 'VERIFY_FAILED' });
  });

  test('FX-T18 ④ 원천 보존이 지난 회차는 머리를 볼 수 있지만 다시 돌리기는 410이다', async () => {
    const who = investigator();
    const overview = await send('GET', `/v1/ops/events/${EVENT_OLD}/fraud-overview`, who);
    expect(overview.statusCode, overview.payload).toBe(200);
    expect(json(overview).sourceExpiresAt).toBeDefined();
    expect(Date.parse(String(json(overview).sourceExpiresAt))).toBeLessThanOrEqual(clock.now());
    expect((await send('POST', `/v1/ops/events/${EVENT_OLD}/fraud-cluster-runs`, who, { idem: randomUUID() })).statusCode).toBe(410);
  });

  test('FX-T12 ㉚ 빈 회차는 기록 고정·후보 계산이 null인 200이다', async () => {
    const who = investigator();
    const r = await send('GET', `/v1/ops/events/${EVENT_EMPTY}/fraud-overview`, who);
    expect(r.statusCode, r.payload).toBe(200);
    expect(json(r)).toMatchObject({ eventId: EVENT_EMPTY, snapshot: null, latestRun: null, rerunAllowed: false });
    expect(json(r).summary).toMatchObject({ clusterCount: 0, caseCount: 0 });
  });
});
