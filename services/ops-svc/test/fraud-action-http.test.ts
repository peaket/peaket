// F-04-13 부정 예매 조치 HTTP 시험(동결 로컬, LCH-270·LCH-280, FX-T12·FX-T15·FX-T18·R-T33).
// 정본: docs/features/forensic-replay.md §6.7.4~§6.7.8, docs/features/transfer-refund.md §7.4,
// docs/features/notify.md §4.5, docs/api/openapi.yaml 태그 investigations·ops.
// [ASVS v5.0.0-2.1.2] 상태·기한·창·승인 조합, [ASVS v5.0.0-2.1.3] 업무 한도,
// [ASVS v5.0.0-14.2.2] 응답 캐시 금지, [ASVS v5.0.0-16.5.3] 실패 시 Done 아님.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AdminAccountProblem } from '../src/modules/admin-accounts/index.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import * as investigationsModule from '../src/modules/investigations/index.js';
import {
  Investigations,
  MemoryInvestigationStore,
  type FraudCaseRecord,
  type FraudCaseStatus,
  type FraudClusterMemberRecord,
  type FraudClusterRecord,
  type FraudLabels,
  type FraudSnapshotRecord,
  type InvestigationAccessLog,
  type TransferLocks,
} from '../src/modules/investigations/index.js';
import type { SaleScheduleSource } from '../src/modules/readiness/index.js';
import { WeekendHolidayCalendar, addBusinessDays } from '../src/modules/cases/index.js';
import { reauthKit, FakeAdminIdentity } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-25T00:00:00.000Z');
const SHOW = Date.parse('2026-12-02T10:00:00.000Z');
const SALE_ENDS = SHOW - 24 * HOUR;
const CANCEL = SHOW - 26 * HOUR;
const ENTRY = SHOW;

const id = (n: number) => `0194b220-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const iso = (ms: number) => new Date(ms).toISOString();
const A = (n: number) => id(0x1000 + n);
const H = (n: number) => id(0x1800 + n);
const T = (n: number) => id(0x2000 + n);

const EVENT = id(0x200);
const CLUSTER = id(0x300);

const schedule: SaleScheduleSource = {
  get: async (eventId: string) =>
    eventId === EVENT ? { opensAtMs: SHOW - 7 * DAY, saleEndsAtMs: SALE_ENDS, entryOpensAtMs: ENTRY, entryClosedAtMs: ENTRY + 3 * HOUR } : undefined,
};

type Req = { statusCode: number; payload: string; headers: Record<string, string | string[] | undefined> };
const json = (r: Req) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, any>));
const typeOf = (r: Req) => String(json(r).type ?? '');

/** F-04-12 시험의 FakeLocks와 같은 판 규칙을 쓴다. 더 큰 판만 반영한다 */
class FakeLocks implements TransferLocks {
  readonly sets: any[] = [];
  readonly releases: any[] = [];
  failNextRelease = false;
  async set(i: any) {
    this.sets.push(i);
    return { lockedTicketCount: 2, withdrawnOfferCount: 0, holders: [] };
  }
  async release(i: any) {
    if (this.failNextRelease) {
      this.failNextRelease = false;
      throw new Error('ticket-svc SetTransferLock 해제 실패');
    }
    this.releases.push(i);
  }
}

class FakeLabels implements FraudLabels {
  readonly calls: any[] = [];
  async apply(i: any) {
    this.calls.push(i);
  }
}

class FakeAccess implements InvestigationAccessLog {
  readonly records: any[] = [];
  async record(i: any) {
    this.records.push(i);
  }
}

class FakeAdmin extends FakeAdminIdentity {
  readonly revoked = new Map<string, Array<{ kind: string; revokedAtMs: number }>>();
  readonly counts = new Map<string, number>();
  failOnCall: { method: 'designations' | 'recentlyRevoked'; at: number } | undefined;
  async recentlyRevoked(adminAccountId: string) {
    this.#count('recentlyRevoked');
    return this.revoked.get(adminAccountId) ?? [];
  }
  async designations(adminAccountId: string) {
    this.#count('designations');
    return super.designations(adminAccountId);
  }
  #count(method: 'designations' | 'recentlyRevoked'): void {
    const n = (this.counts.get(method) ?? 0) + 1;
    this.counts.set(method, n);
    if (this.failOnCall?.method === method && n === this.failOnCall.at) {
      throw new AdminAccountProblem('admin-account-unavailable', 503, 'identity down');
    }
  }
}

const audit = new MemoryAuditChain();
const store = new MemoryInvestigationStore((r) => audit.append(r));
const locks = new FakeLocks();
const labels = new FakeLabels();
const access = new FakeAccess();
const admin = new FakeAdmin();
const identity = new FakeIdentity();
const clock = fakeClock({ now: NOW });
const kit = reauthKit(() => clock.now());

const tickets = new Map<string, any>();
const ticketCalls: any[] = [];
const ticketDirectory = {
  async listForAction(i: { eventId: string; payerAccountIds: readonly string[] }) {
    ticketCalls.push(i);
    return [...tickets.values()].filter((t) => t.eventId === i.eventId && i.payerAccountIds.includes(t.payerAccountId));
  },
};

const cancelCalls: any[] = [];
const cancels = new Map<string, any[]>();
const cancellationClient = {
  nextEmptyResults: false,
  nextThrow: false,
  nextOmitLast: false,
  async cancel(i: any) {
    cancelCalls.push(i);
    if (this.nextThrow) {
      this.nextThrow = false;
      throw new Error('purchase-svc CancelFraudTickets 실패');
    }
    const key = i.approvalId;
    // 시험이 cancels에 심은 첫 결과는 그대로 돌려준다. 같은 승인 ID의 재시도에서만 FAILED를 ACCEPTED로 바꾼다.
    const attempt = cancelCalls.filter((c) => c.approvalId === key).length;
    if (cancels.has(key)) {
      const previous = cancels.get(key)!;
      if (attempt === 1) {
        if (this.nextEmptyResults) {
          this.nextEmptyResults = false;
          return [];
        }
        if (this.nextOmitLast) {
          this.nextOmitLast = false;
          return previous.slice(0, -1);
        }
        return previous;
      }
      const out = previous.map((p: any) =>
        p.outcome === 'FAILED' ? { ...p, outcome: 'ACCEPTED', cancellationId: randomUUID(), refundAmount: 100_000 } : p,
      );
      cancels.set(key, out);
      return out;
    }
    const out = i.targets.map((t: any) => ({
      ticketId: t.ticketId,
      outcome: t.ticketId === T(0x99) ? 'SKIPPED_HOLDER_CHANGED' : 'ACCEPTED',
      cancellationId: randomUUID(),
      refundAmount: 100_000,
    }));
    cancels.set(key, out);
    if (this.nextEmptyResults) {
      this.nextEmptyResults = false;
      return [];
    }
    if (this.nextOmitLast) {
      this.nextOmitLast = false;
      return out.slice(0, -1);
    }
    return out;
  },
};

const restrictionCalls: any[] = [];
const restrictionState = new Map<string, any>();
const restrictionClient = {
  failNextQueue: false,
  failNextPurchase: false,
  failNextIdentity: false,
  identity: {
    async restrict(i: any) {
      restrictionCalls.push({ op: 'identity.RESTRICTED', accountId: i.accountId, version: i.version });
      if (restrictionClient.failNextIdentity) {
        restrictionClient.failNextIdentity = false;
        throw new Error('identity SetRestrictedCiHold 실패');
      }
      restrictionState.set(i.accountId, { ...i, state: 'ACTIVE' });
    },
    async lift(i: any) {
      restrictionCalls.push({ op: 'identity.RELEASED', accountId: i.accountId, version: i.version });
      restrictionState.delete(i.accountId);
    },
  },
  queue: {
    async set(i: any) {
      restrictionCalls.push({ op: 'queue', accountId: i.accountId, state: i.state, version: i.version, restrictionId: i.restrictionId });
      if (restrictionClient.failNextQueue) {
        restrictionClient.failNextQueue = false;
        throw new Error('queue-svc SetBookingRestriction 실패');
      }
    },
  },
  purchase: {
    async set(i: any) {
      restrictionCalls.push({ op: 'purchase', accountId: i.accountId, state: i.state, version: i.version, restrictionId: i.restrictionId });
      if (restrictionClient.failNextPurchase) {
        restrictionClient.failNextPurchase = false;
        throw new Error('purchase-svc SetBookingRestriction 실패');
      }
    },
  },
  async activeForCase(caseId: string) {
    return [...restrictionState.values()].filter((r) => r.caseId === caseId);
  },
};

const noticeCalls: any[] = [];
const caseNotifier = {
  async actionNotice(i: any) {
    noticeCalls.push({ kind: 'actionNotice', ...i });
  },
  async holderResult(i: any) {
    noticeCalls.push({ kind: 'holderResult', ...i });
  },
  async objectionDecided(i: any) {
    noticeCalls.push({ kind: 'objectionDecided', ...i });
  },
  async restrictionLifted(i: any) {
    noticeCalls.push({ kind: 'restrictionLifted', ...i });
  },
  async transferLockReleased(i: any) {
    noticeCalls.push({ kind: 'transferLockReleased', ...i });
  },
  async deadlineNotice(i: any) {
    noticeCalls.push({ kind: 'deadlineNotice', ...i });
  },
};

const appealCopies: any[] = [];
const copies = {
  async set(i: any) {
    appealCopies.push(i);
  },
};

const priorityCalls: any[] = [];
let objectionResultNext: 'SAME_SEAT' | 'SAME_TIER' | 'NO_SEAT' | 'ENTRY_STARTED' = 'SAME_SEAT';
const objections = {
  async run(i: any) {
    priorityCalls.push(i);
    if (i.decision !== 'ACCEPTED') return { decision: i.decision, grants: [] };
    const result = objectionResultNext;
    return {
      decision: i.decision,
      grants: result === 'NO_SEAT' || result === 'ENTRY_STARTED'
        ? [{ result }]
        : [{ result, grantId: randomUUID(), seatId: randomUUID(), price: 100_000, expiresAt: iso(clock.now() + 48 * HOUR), version: 1 }],
    };
  },
};

let eligibleApproverIds: string[] = [];
const investigationDeps: any = {
  store,
  schedule,
  locks,
  notifier: caseNotifier,
  fraudApproverDirectory: { listEligible: async () => eligibleApproverIds },
  labels,
  alerts: { raise: async () => undefined },
  access,
  events: { emit: () => undefined },
  verifier: { verify: async () => ({ ok: true, mismatchedTables: [] }) },
  now: () => clock.now(),
  fraudTickets: ticketDirectory,
  fraudCancellations: cancellationClient,
  fraudRestrictions: restrictionClient,
  fraudNotifier: caseNotifier,
  fraudCopies: copies,
  fraudPriority: objections,
  fraudApproverIdentity: admin,
  reauth: kit.verifier,
  calendar: new WeekendHolidayCalendar(),
};

let svc: Awaited<ReturnType<typeof createService>>;
let seq = 0;
const newId = () => `0194b220-1000-7000-8000-${String(++seq).padStart(12, '0')}`;

const memberOf = (accountId: string, o: Record<string, any> = {}): FraudClusterMemberRecord =>
  ({
    accountId,
    ticketCount: 1,
    signals: ['LINK_GRAPH'],
    addedBy: 'SYSTEM',
    removedAtMs: null,
    appealResult: 'NOT_REQUESTED',
    appealDueAtMs: null,
    lockExpiresAtMs: null,
    objectionResult: 'NONE',
    ...o,
  }) as any;

const caseOf = (o: Record<string, any> = {}): FraudCaseRecord =>
  ({
    caseId: newId(),
    eventId: EVENT,
    clusterId: newId(),
    status: 'INVESTIGATING' as FraudCaseStatus,
    reasonCategory: 'MACRO_BOT',
    assigneeId: id(0x900),
    cancelDeadlineAtMs: CANCEL,
    appealDueAtMs: null,
    approvalId: null,
    investigatorOpinion: null,
    outcomeLabel: null,
    version: 1,
    createdAtMs: NOW - DAY,
    closedAtMs: null,
    members: [memberOf(A(1))],
    events: [{ seq: 1, kind: 'CREATED', actorId: id(0x900), note: null, detail: null, occurredAtMs: NOW - DAY }],
    ...o,
  }) as any;

const snapshotOf = (eventId: string): FraudSnapshotRecord => ({
  eventId,
  version: 1,
  frozenAtMs: NOW - DAY,
  invHash: 'a'.repeat(64),
  prevHash: null,
  tableHashes: { inv_request: '1'.repeat(64), inv_step: '2'.repeat(64), inv_behavior: '3'.repeat(64), inv_link: '4'.repeat(64) },
  rowCounts: { inv_request: 1, inv_step: 1, inv_behavior: 1, inv_link: 1 },
  rangeFromMs: null,
  late: false,
  verifyStatus: null,
  verifiedAtMs: null,
});

const seedCase = async (o: Record<string, any> = {}) => {
  const c = caseOf(o);
  await store.putCase(c);
  return c;
};

const seedTicket = (o: { ticketId: string; payerAccountId: string; holderAccountId?: string; status?: string; entryRecorded?: boolean }) => {
  tickets.set(o.ticketId, {
    eventId: EVENT,
    ticketId: o.ticketId,
    payerAccountId: o.payerAccountId,
    holderAccountId: o.holderAccountId ?? o.payerAccountId,
    status: o.status ?? 'ISSUED',
    entryRecorded: o.entryRecorded ?? false,
  });
};

beforeAll(async () => {
  await store.putClusters(EVENT, 1, [{ clusterId: CLUSTER, eventId: EVENT, generation: 1, scoreBand: 'HIGH', accountCount: 1, purchaseCount: 9, limitPerPerson: 4, sharedAttributes: ['PAYMENT_METHOD'], signals: ['LINK_GRAPH'], snapshotVersion: 1, createdAtMs: NOW - DAY, members: [memberOf(A(1))] } as FraudClusterRecord], 'v1');
  await store.putSnapshot(snapshotOf(EVENT));
  svc = await createService({
    name: 'ops-svc-fraud-action',
    module: AppModule.register({
      memory: true,
      auditChain: audit,
      adminAccounts: { identity: admin, reauth: kit.verifier },
      approvals: { reauth: kit.verifier, admin: { identity: admin, reauth: kit.verifier } } as any,
      investigations: investigationDeps,
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
  o: { body?: unknown; idem?: string | null; ifMatch?: string; reauth?: string } = {},
): Promise<Req> =>
  svc.http.inject({
    method,
    url,
    headers: {
      ...headers,
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...(o.idem === undefined ? {} : o.idem === null ? {} : { 'idempotency-key': o.idem }),
      ...(o.ifMatch ? { 'if-match': o.ifMatch } : {}),
      ...(o.reauth ? { 'x-reauth-token': o.reauth } : {}),
    },
    ...(o.body === undefined ? {} : { payload: JSON.stringify(o.body) }),
  }) as unknown as Promise<Req>;

const investigator = (role: 'commander' | 'cs_lead' = 'cs_lead', designations: string[] = ['FRAUD_INVESTIGATOR']) => {
  const who = identity.ops(role);
  admin.seed({ adminAccountId: who['x-user-id']!, role, designations: designations as any });
  return who;
};

const commander = (designations: string[] = []) => {
  const who = identity.ops('commander');
  admin.seed({ adminAccountId: who['x-user-id']!, role: 'commander', designations: designations as any });
  return who;
};

const actionRequest = (caseId: string, who: Record<string, string>, body: Record<string, any>, idem = randomUUID()) =>
  send('POST', `/v1/ops/fraud-cases/${caseId}/action-requests`, who, { idem, body });

const clearance = (caseId: string, who: Record<string, string>, body: Record<string, any>, ifMatch = '"1"', idem = randomUUID()) =>
  send('POST', `/v1/ops/fraud-cases/${caseId}/clearance`, who, { idem, ifMatch, body });

const getCase = (caseId: string, who: Record<string, string>) => send('GET', `/v1/ops/fraud-cases/${caseId}`, who);

const getApproval = (approvalId: string, who: Record<string, string>) => send('GET', `/v1/ops/approval-requests/${approvalId}`, who);

const approve = (approvalId: string, who: Record<string, string>, body: Record<string, any> | undefined, token = kit.token({ accountId: who['x-user-id']!, sessionId: who['x-session-id']!, act: 'APPROVAL' })) =>
  send('POST', `/v1/ops/approval-requests/${approvalId}/approvals`, who, { body, reauth: token });

const reject = (approvalId: string, who: Record<string, string>, reason = '근거 부족') =>
  send('POST', `/v1/ops/approval-requests/${approvalId}/rejections`, who, { body: { reason } });

const withdraw = (approvalId: string, who: Record<string, string>, reason = '다시 요청') =>
  send('POST', `/v1/ops/approval-requests/${approvalId}/withdrawals`, who, { body: { reason } });

const FraudActionsClass = (investigationsModule as unknown as { FraudActions?: new (...args: any[]) => any }).FraudActions;
const tick = (method: 'expireDue' | 'notifyDeadlines' | 'closeDueCases') =>
  (svc.app.get(FraudActionsClass as any) as unknown as Record<string, (nowMs: number) => Promise<number>>)[method](clock.now());

const money = (n: number) => n * 100_000;

describe('F-04-13 FRAUD_ACTION 조치·승인', () => {
  test('FX-T12 ㊷ C2 정상 종료는 INVESTIGATING에서만 되고 사유·HUMAN·NONE을 받는다', async () => {
    const who = investigator();
    const c = await seedCase({ members: [memberOf(A(1), { lockExpiresAtMs: NOW + DAY, appealResult: 'REJECTED' })] });
    const missing = await send('POST', `/v1/ops/fraud-cases/${c.caseId}/clearance`, who, { idem: randomUUID(), body: { reason: '근거 없음', outcomeLabel: 'HUMAN' } });
    expect(missing.statusCode).toBe(428);
    const noIdem = await send('POST', `/v1/ops/fraud-cases/${c.caseId}/clearance`, who, { ifMatch: '"1"', body: { reason: '근거 없음', outcomeLabel: 'HUMAN' } });
    expect(noIdem.statusCode).toBe(400);
    const badLabel = await clearance(c.caseId, who, { reason: '근거 없음', outcomeLabel: 'BOT' });
    expect(badLabel.statusCode).toBe(400);
    const emptyReason = await clearance(c.caseId, who, { reason: '', outcomeLabel: 'NONE' });
    expect(emptyReason.statusCode).toBe(400);
    const stale = await clearance(c.caseId, who, { reason: '근거 없음', outcomeLabel: 'HUMAN' }, '"9"');
    expect(stale.statusCode).toBe(412);
    const ok = await clearance(c.caseId, who, { reason: '근거 없음', outcomeLabel: 'HUMAN' });
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.headers.etag).toBe(`"${json(ok).version}"`);
    expect(json(ok).status).toBe('CLEARED');
    expect(json(ok).outcomeLabel).toBe('HUMAN');
    expect(json(ok).closedAt).toBeTruthy();
    expect(locks.releases.some((r) => r.accountIds.includes(A(1)))).toBe(true);
    expect(labels.calls.some((l) => l.label === 'HUMAN' && l.accountIds.includes(A(1)))).toBe(true);
    const again = await clearance(c.caseId, who, { reason: '또', outcomeLabel: 'NONE' }, `"${json(ok).version}"`);
    expect(again.statusCode).toBe(409);
    expect(typeOf(again)).toBe('fraud-case-state');
  });

  test('FX-T12 ㊸ C2 정상 종료는 잠금을 모두 풀고 HUMAN 라벨과 closed_at을 남긴다', async () => {
    const who = investigator();
    const c = await seedCase({ members: [memberOf(A(2), { lockExpiresAtMs: NOW + DAY }), memberOf(A(3), { lockExpiresAtMs: NOW + DAY, removedAtMs: NOW })] });
    const r = await clearance(c.caseId, who, { reason: '근거 없음', outcomeLabel: 'NONE' });
    expect(r.statusCode, r.payload).toBe(200);
    expect(json(r).status).toBe('CLEARED');
    expect(locks.releases.at(-1).accountIds).toEqual([A(2)]);
    expect(labels.calls.filter((l) => l.accountIds.includes(A(2)) && l.label === 'HUMAN')).toHaveLength(0);
    const replayCase = await seedCase({ members: [memberOf(A(4), { lockExpiresAtMs: NOW + DAY })] });
    const key = randomUUID();
    const first = await clearance(replayCase.caseId, who, { reason: '근거 없음', outcomeLabel: 'NONE' }, '"1"', key);
    expect(first.statusCode, first.payload).toBe(200);
    const replay = await clearance(replayCase.caseId, who, { reason: '근거 없음', outcomeLabel: 'NONE' }, '"1"', key);
    expect(replay.statusCode, replay.payload).toBe(200);
    expect(json(replay).version).toBe(json(first).version);
    expect(json(replay).events.filter((e: any) => e.kind === 'CLEARED')).toHaveLength(1);
  });

  test('FX-T12 ㊹ C5 조치 요청은 소명 기한이 지나고 불인정·기한 경과 계정만 받는다', async () => {
    const who = investigator();
    const c = await seedCase({
      status: 'APPEAL_PENDING',
      appealDueAtMs: NOW - HOUR,
      members: [
        memberOf(A(10), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR, lockExpiresAtMs: NOW + DAY }),
        memberOf(A(11), { appealResult: 'EXPIRED', appealDueAtMs: NOW - HOUR, lockExpiresAtMs: NOW + DAY }),
        memberOf(A(12), { appealResult: 'PENDING', appealDueAtMs: NOW - HOUR, lockExpiresAtMs: NOW + DAY }),
        memberOf(A(13), { appealResult: 'SUBMITTED', appealDueAtMs: NOW - HOUR, lockExpiresAtMs: NOW + DAY }),
      ],
    });
    seedTicket({ ticketId: T(10), payerAccountId: A(10) });
    seedTicket({ ticketId: T(11), payerAccountId: A(11) });
    seedTicket({ ticketId: T(12), payerAccountId: A(12) });
    seedTicket({ ticketId: T(13), payerAccountId: A(13) });
    const ok = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(10), A(11), A(12)], reason: '봇' });
    expect(ok.statusCode, ok.payload).toBe(201);
    expect(json(ok).kind).toBe('FRAUD_ACTION');
    expect(json(ok).status).toBe('PENDING_APPROVAL');
    const after = await getCase(c.caseId, who);
    expect(json(after).status).toBe('DECISION_PENDING');
    expect(json(after).members.find((m: any) => m.accountId === A(12)).appealResult).toBe('EXPIRED');
    const submitted = await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(13)], reason: '봇' });
    expect(submitted.statusCode).toBe(409);
    const notRequested = await seedCase({
      status: 'APPEAL_PENDING',
      appealDueAtMs: NOW - HOUR,
      members: [memberOf(A(14), { appealResult: 'NOT_REQUESTED', appealDueAtMs: NOW - HOUR })],
    });
    const bad = await actionRequest(notRequested.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(14)], reason: '봇' });
    expect(bad.statusCode).toBe(409);
  });

  test('FX-T12 ㊺ C5 조치 요청은 열린 승인 업무가 있으면 409이고 취소 마감 뒤 CANCEL_TICKETS는 409다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(15), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    seedTicket({ ticketId: T(15), payerAccountId: A(15) });
    const first = await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(15)], reason: '봇' });
    expect(first.statusCode).toBe(201);
    const second = await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(15)], reason: '봇' });
    expect(second.statusCode).toBe(409);
    expect(typeOf(second)).toBe('approval-already-open');
    const late = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: CANCEL - HOUR, members: [memberOf(A(16), { appealResult: 'REJECTED', appealDueAtMs: CANCEL - HOUR })] });
    clock.advance(CANCEL - clock.now());
    const past = await actionRequest(late.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(16)], reason: '봇' });
    expect(past.statusCode).toBe(409);
    expect(typeOf(past)).toBe('cancel-deadline-passed');
    clock.advance(NOW - clock.now());
  });

  test('FX-T12 ㊻ C6 다시 조치 요청은 INVESTIGATING에서 소명 요청 이력이 있는 계정만 받는다', async () => {
    const who = investigator();
    const prior = randomUUID();
    const c = await seedCase({
      status: 'INVESTIGATING',
      approvalId: prior,
      members: [memberOf(A(20), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })],
      events: [
        { seq: 1, kind: 'CREATED', actorId: id(0x900), note: null, detail: null, occurredAtMs: NOW - DAY },
        { seq: 2, kind: 'ACTION_CLOSED', actorId: id(0x900), note: null, detail: { approvalId: prior, reason: 'REJECTED' }, occurredAtMs: NOW - HOUR },
      ],
    });
    const ok = await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(20)], reason: '다시' });
    expect(ok.statusCode, ok.payload).toBe(201);
    const fresh = await seedCase({ status: 'INVESTIGATING', members: [memberOf(A(21), { appealResult: 'REJECTED' })] });
    const bad = await actionRequest(fresh.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(21)], reason: '다시' });
    expect(bad.statusCode).toBe(409);
  });

  test('FX-T12 ㊼ C9·C16 조치 요청은 ACTIONED에서 RESTRICT, OBJECTED에서 LIFT_RESTRICTION만 받는다', async () => {
    const who = investigator();
    const actioned = await seedCase({
      status: 'ACTIONED',
      members: [memberOf(A(30), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY })],
    });
    const restrict = await actionRequest(actioned.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(30)], reason: '추가 제한', restrictionEndsAt: iso(NOW + 90 * DAY) });
    expect(restrict.statusCode, restrict.payload).toBe(201);
    const liftInActioned = await actionRequest(actioned.caseId, who, { fraudAction: 'LIFT_RESTRICTION', accountIds: [A(30)], reason: '풀기' });
    expect(liftInActioned.statusCode).toBe(409);

    const objected = await seedCase({
      status: 'OBJECTED',
      members: [memberOf(A(31), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY, objectionResult: 'ACCEPTED', objectionReceivedAtMs: NOW - 2 * DAY, objectionDecidedAtMs: NOW - DAY })],
    });
    restrictionState.set(A(31), { caseId: objected.caseId, accountId: A(31), restrictionId: randomUUID(), untilMs: NOW + 30 * DAY, version: 1, state: 'ACTIVE' });
    const lift = await actionRequest(objected.caseId, who, { fraudAction: 'LIFT_RESTRICTION', accountIds: [A(31)], reason: '이의 인정' });
    expect(lift.statusCode, lift.payload).toBe(201);
    const after = await getCase(objected.caseId, who);
    expect(json(after).status).toBe('OBJECTED');
    const restrictInObjected = await actionRequest(objected.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(31)], reason: '제한' });
    expect(restrictInObjected.statusCode).toBe(409);
  });

  test('FX-T12 ㊽ C7 승인 Done은 ACTIONED·BOT 라벨·조치 알림·잔여 잠금 해제를 남긴다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({
      status: 'APPEAL_PENDING',
      appealDueAtMs: NOW - HOUR,
      members: [
        memberOf(A(40), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR, lockExpiresAtMs: NOW + 10 * DAY }),
        memberOf(A(41), { appealResult: 'EXPIRED', appealDueAtMs: NOW - HOUR, lockExpiresAtMs: NOW + 10 * DAY }),
      ],
    });
    seedTicket({ ticketId: T(40), payerAccountId: A(40) });
    seedTicket({ ticketId: T(41), payerAccountId: A(41) });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(40), A(41)], reason: '봇' });
    expect(created.statusCode, created.payload).toBe(201);
    const approvalId = String(json(created).approvalId);
    const viewed = await getApproval(approvalId, approver);
    expect(viewed.statusCode, viewed.payload).toBe(200);
    const done = await approve(approvalId, approver, { reason: '근거를 확인했다' });
    expect(done.statusCode, done.payload).toBe(200);
    expect(json(done).status).toBe('DONE');
    const after = await getCase(c.caseId, who);
    expect(json(after).status).toBe('ACTIONED');
    const bot = labels.calls.find((l) => l.label === 'BOT' && l.accountIds.includes(A(40)) && l.accountIds.includes(A(41)));
    expect(bot).toMatchObject({ eventId: EVENT, caseId: c.caseId, source: 'FRAUD_ACTIONED' });
    expect(bot.version).toBeGreaterThanOrEqual(2);
    expect(noticeCalls.some((n) => n.kind === 'actionNotice' && n.accountId === A(40) && Array.isArray(n.ticketIds))).toBe(true);
    expect(noticeCalls.some((n) => n.kind === 'actionNotice' && n.accountId === A(41) && n.action === 'CANCEL_TICKETS')).toBe(true);
    expect(locks.releases.some((r) => r.accountIds.includes(A(40)) && r.accountIds.includes(A(41)) && r.releaseReason === 'ACTION_DONE')).toBe(true);
  });

  test('FX-T15 ⑬ 조치 실행이 끝나면 취소된 표 말고 남은 표의 잠금을 ACTION_DONE으로 푼다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(42), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR, lockExpiresAtMs: NOW + 10 * DAY })] });
    seedTicket({ ticketId: T(42), payerAccountId: A(42) });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(42)], reason: '봇' });
    const approvalId = String(json(created).approvalId);
    await getApproval(approvalId, approver);
    await approve(approvalId, approver, { reason: '근거' });
    expect(locks.releases.some((r) => r.accountIds.includes(A(42)) && r.releaseReason === 'ACTION_DONE')).toBe(true);
  });

  test('FX-T12 ㊾ C8 반려·철회·만료는 Done 유무로 INVESTIGATING·ACTIONED를 가르고 대상 잠금을 푼다', async () => {
    const who = investigator();
    const approver = commander();
    const base = {
      status: 'APPEAL_PENDING',
      appealDueAtMs: NOW - HOUR,
      members: [memberOf(A(50), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR, lockExpiresAtMs: NOW + 10 * DAY })],
    };
    const rejectedCase = await seedCase(base);
    const r1 = await actionRequest(rejectedCase.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(50)], reason: '제한' });
    const rejected = await reject(String(json(r1).approvalId), approver);
    expect(rejected.statusCode, rejected.payload).toBe(200);
    expect(json(await getCase(rejectedCase.caseId, who)).status).toBe('INVESTIGATING');
    expect(locks.releases.some((r) => r.accountIds.includes(A(50)) && r.releaseReason === 'ACTION_CLOSED')).toBe(true);

    const withdrawnCase = await seedCase(base);
    const r2 = await actionRequest(withdrawnCase.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(50)], reason: '제한' });
    const before = locks.releases.length;
    const withdrawn = await withdraw(String(json(r2).approvalId), who);
    expect(withdrawn.statusCode, withdrawn.payload).toBe(200);
    expect(json(await getCase(withdrawnCase.caseId, who)).status).toBe('INVESTIGATING');
    expect(locks.releases.length).toBe(before);

    const expiredCase = await seedCase(base);
    const r3 = await actionRequest(expiredCase.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(50)], reason: '제한', restrictionEndsAt: iso(NOW + 30 * DAY) });
    clock.advance(6 * DAY);
    await tick('expireDue');
    expect(json(await getCase(expiredCase.caseId, who)).status).toBe('INVESTIGATING');
    expect(locks.releases.some((r) => r.accountIds.includes(A(50)) && r.releaseReason === 'ACTION_CLOSED')).toBe(true);
    clock.advance(NOW - clock.now());

    const doneCase = await seedCase(base);
    const r4 = await actionRequest(doneCase.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(50)], reason: '제한' });
    const a1 = String(json(r4).approvalId);
    await getApproval(a1, approver);
    await approve(a1, approver, { reason: '승인' });
    const r5 = await actionRequest(doneCase.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(50)], reason: '추가' });
    const rejectedAfterDone = await reject(String(json(r5).approvalId), approver);
    expect(rejectedAfterDone.statusCode).toBe(200);
    expect(json(await getCase(doneCase.caseId, who)).status).toBe('ACTIONED');
  });

  test('FX-T12 ㊿ C10 이의 접수는 ACTIONED를 OBJECTED로 바꾸고 기한 경과·중복을 거절한다', async () => {
    const c = await seedCase({
      status: 'ACTIONED',
      members: [memberOf(A(60), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY })],
    });
    const ok = await send('POST', `/internal/v1/fraud-cases/${c.caseId}/appeals`, {}, { body: { appealId: randomUUID(), accountId: A(60), party: 'PAYER', submittedAt: iso(NOW) } });
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(json(await getCase(c.caseId, investigator())).status).toBe('OBJECTED');
    const duplicate = await send('POST', `/internal/v1/fraud-cases/${c.caseId}/appeals`, {}, { body: { appealId: randomUUID(), accountId: A(60), party: 'PAYER', submittedAt: iso(NOW) } });
    expect(duplicate.statusCode).toBe(409);

    const old = await seedCase({ status: 'ACTIONED', members: [memberOf(A(61), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 31 * DAY })] });
    const late = await send('POST', `/internal/v1/fraud-cases/${old.caseId}/appeals`, {}, { body: { appealId: randomUUID(), accountId: A(61), party: 'PAYER', submittedAt: iso(NOW) } });
    expect(late.statusCode).toBe(200);
    expect(json(late).result).toBe('EXPIRED');
    expect(json(await getCase(old.caseId, investigator())).status).toBe('ACTIONED');
    expect(noticeCalls.some((n) => n.kind === 'objectionDecided' && n.accountId === A(61) && n.decision === 'REJECTED')).toBe(true);
  });

  test('FX-T12 51 C11 이의 인정은 LIFT_RESTRICTION을 만들고 되돌림 끝에 REVERSED·HUMAN이 된다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({
      status: 'OBJECTED',
      members: [memberOf(A(70), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY, objectionResult: 'SUBMITTED', objectionReceivedAtMs: NOW - DAY })],
    });
    restrictionState.set(A(70), { caseId: c.caseId, accountId: A(70), restrictionId: randomUUID(), untilMs: NOW + 30 * DAY, version: 1, state: 'ACTIVE' });
    const patch = await send('PATCH', `/v1/ops/fraud-cases/${c.caseId}`, who, { ifMatch: '"1"', body: { objectionDecisions: [{ accountId: A(70), decision: 'ACCEPTED', reason: '정상 구매' }] } });
    expect(patch.statusCode, patch.payload).toBe(200);
    expect(json(patch).status).toBe('OBJECTED');
    const approvalId = String(json(patch).approvalId);
    expect(approvalId).not.toBe('null');
    await getApproval(approvalId, approver);
    const lifted = await approve(approvalId, approver, { reason: '이의 인정' });
    expect(lifted.statusCode, lifted.payload).toBe(200);
    const after = await getCase(c.caseId, who);
    expect(json(after).status).toBe('REVERSED');
    expect(json(after).outcomeLabel).toBe('HUMAN');
    expect(json(after).closedAt).toBeTruthy();
    const human = labels.calls.find((l) => l.source === 'FRAUD_APPEAL_ACCEPTED' && l.accountIds.includes(A(70)));
    expect(human).toBeTruthy();
    expect(human.version).toBeGreaterThanOrEqual(2);
    expect(noticeCalls.some((n) => n.kind === 'restrictionLifted' && n.accountId === A(70))).toBe(true);
  });

  test('FX-T12 52 C12 이의 기각이 남으면 ACTIONED로 돌아가고 이의 창이 지나면 닫힌다', async () => {
    const who = investigator();
    const c = await seedCase({
      status: 'OBJECTED',
      members: [
        memberOf(A(80), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY, objectionResult: 'SUBMITTED', objectionReceivedAtMs: NOW - DAY }),
        memberOf(A(81), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY, objectionResult: 'SUBMITTED', objectionReceivedAtMs: NOW - DAY }),
      ],
    });
    const patch = await send('PATCH', `/v1/ops/fraud-cases/${c.caseId}`, who, {
      ifMatch: '"1"',
      body: { objectionDecisions: [{ accountId: A(80), decision: 'ACCEPTED', reason: '정상' }, { accountId: A(81), decision: 'REJECTED', reason: '근거 있음' }] },
    });
    expect(patch.statusCode, patch.payload).toBe(200);
    expect(json(patch).status).toBe('ACTIONED');
    await tick('closeDueCases');
    expect(json(await getCase(c.caseId, who)).closedAt).toBeNull();
    clock.advance(20 * DAY);
    await tick('closeDueCases');
    expect(json(await getCase(c.caseId, who)).closedAt).toBeTruthy();
    clock.advance(NOW - clock.now());
  });

  test('FX-T12 53 C13·C17 입장 시작·최대 기한에 ops 사본 잠금이 풀리고 ticket-svc가 스스로 푼다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', members: [memberOf(A(90), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY, lockExpiresAtMs: NOW - 1 })] });
    const view = await getCase(c.caseId, who);
    expect(json(view).members[0].transferLocked).toBe(false);
    expect(json(view).members[0].objectionDueAt).toBe(iso(NOW - 10 * DAY + 30 * DAY));
    await tick('expireDue');
    expect(appealCopies.some((x) => x.caseId === c.caseId && x.accountId === A(90) && x.lockActive === false && x.objectionDueAtMs === NOW - 10 * DAY + 30 * DAY)).toBe(true);
    const beforeEntry = await seedCase({ status: 'APPEAL_PENDING', members: [memberOf(A(91), { lockExpiresAtMs: ENTRY + DAY })] });
    clock.advance(ENTRY - clock.now() + 1);
    const afterEntry = await getCase(beforeEntry.caseId, who);
    expect(json(afterEntry).members[0].transferLocked).toBe(false);
    await tick('expireDue');
    expect(appealCopies.some((x) => x.caseId === beforeEntry.caseId && x.accountId === A(91) && x.lockActive === false)).toBe(true);
    expect(noticeCalls.some((x) => x.kind === 'transferLockReleased' && x.caseId === beforeEntry.caseId && x.accountId === A(91))).toBe(false);
    clock.advance(NOW - clock.now());
  });

  test('FX-T12 54 [ASVS v5.0.0-2.1.3] 이용 제한 끝은 요청 + 1년을 넘지 못하고 표 취소는 마감 전에만 된다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(100), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    const exact = await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(100)], reason: '제한', restrictionEndsAt: iso(NOW + 365 * DAY) });
    expect(exact.statusCode, exact.payload).toBe(201);
    const tooLong = await actionRequest((await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(101), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] })).caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(101)], reason: '제한', restrictionEndsAt: iso(NOW + 365 * DAY + 1) });
    expect(tooLong.statusCode).toBe(422);
    expect(typeOf(tooLong)).toBe('restriction-too-long');
  });

  test('FX-T12 55 [ASVS v5.0.0-2.1.2][ASVS v5.0.0-14.2.2] FRAUD_ACTION 승인 상세는 사건 요약만 싣고 가명·IP를 싣지 않는다', async () => {
    const who = investigator();
    const approver = commander();
    const other = identity.ops('cs_lead');
    admin.seed({ adminAccountId: other['x-user-id']!, role: 'cs_lead', designations: ['FRAUD_INVESTIGATOR'] });
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(110), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    seedTicket({ ticketId: T(110), payerAccountId: A(110) });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(110)], reason: '봇' });
    const approvalId = String(json(created).approvalId);
    const viewed = await getApproval(approvalId, approver);
    expect(viewed.statusCode, viewed.payload).toBe(200);
    expect(viewed.headers['cache-control']).toBe('no-store');
    expect(json(viewed).fraudCaseSummary.targets[0].accountId).toBe(A(110));
    expect(JSON.stringify(json(viewed))).not.toMatch(/deviceRef|contactRef|125\.|ip"/);
    expect((await getApproval(approvalId, other)).statusCode).toBe(404);
  });

  test('FX-T12 71 [ASVS v5.0.0-2.1.3] 조치 요청은 기한 경계·계정 100·표 500·빈 목록·C9/C16 상태를 지킨다', async () => {
    const who = investigator();
    const boundary = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW, members: [memberOf(A(170), { appealResult: 'REJECTED', appealDueAtMs: NOW })] });
    expect((await actionRequest(boundary.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(170)], reason: '경계' })).statusCode).toBe(201);
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(171), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    const tooManyAccounts = Array.from({ length: 101 }, (_, i) => A(1_000 + i));
    expect((await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: tooManyAccounts, reason: '한도' })).statusCode).toBe(400);
    expect((await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [], reason: '빈' })).statusCode).toBe(400);
    const tooManyTickets = Array.from({ length: 501 }, (_, i) => T(1_000 + i));
    expect((await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(171)], ticketIds: tooManyTickets, reason: '한도' })).statusCode).toBe(400);
    const actioned = await seedCase({ status: 'ACTIONED', members: [memberOf(A(172), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY, objectionResult: 'SUBMITTED', objectionReceivedAtMs: NOW - DAY })] });
    expect((await actionRequest(actioned.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(172)], reason: '이의 미결' })).statusCode).toBe(409);
    const objected = await seedCase({ status: 'OBJECTED', members: [memberOf(A(173), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY, objectionResult: 'ACCEPTED', objectionDecidedAtMs: NOW - DAY })] });
    expect((await actionRequest(objected.caseId, who, { fraudAction: 'LIFT_RESTRICTION', accountIds: [A(173)], reason: '제한 없음' })).statusCode).toBe(409);
    const past = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(174), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    expect((await actionRequest(past.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(174)], reason: '과거', restrictionEndsAt: iso(NOW - HOUR) })).statusCode).toBe(422);
  });

  test('FX-T12 56 [ASVS v5.0.0-2.1.2] FRAUD_ACTION 승인은 이유·요약 열람·범위 줄이기를 정본대로 검사한다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(120), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR }), memberOf(A(121), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    seedTicket({ ticketId: T(120), payerAccountId: A(120) });
    seedTicket({ ticketId: T(121), payerAccountId: A(121) });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(120), A(121)], reason: '봇' });
    const approvalId = String(json(created).approvalId);
    expect((await approve(approvalId, approver, { reason: '근거' })).statusCode).toBe(409);
    await getApproval(approvalId, approver);
    expect((await approve(approvalId, approver, {})).statusCode).toBe(422);
    expect((await approve(approvalId, approver, { reason: '근거', excludeAccountIds: [A(999)] })).statusCode).toBe(422);
    expect((await approve(approvalId, approver, { reason: '근거', excludeAccountIds: [A(120), A(121)] })).statusCode).toBe(422);
    const ok = await approve(approvalId, approver, { reason: '근거', excludeAccountIds: [A(121)] });
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(cancelCalls.at(-1).targets.map((t: any) => t.ticketId)).toEqual([T(120)]);
    expect(locks.releases.some((r) => r.accountIds.includes(A(121)) && r.releaseReason === 'ACTION_CLOSED')).toBe(true);
  });

  test('FX-T12 57 [ASVS v5.0.0-16.5.3] FRAUD_ACTION 승인은 요청자·가명정보 취급자·지정 거둔 commander를 403으로 막는다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(130), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(130)], reason: '봇' });
    const approvalId = String(json(created).approvalId);
    expect((await approve(approvalId, who, { reason: '내가' })).statusCode).toBe(403);
    const pseudo = commander(['PSEUDONYM_HANDLER']);
    await getApproval(approvalId, pseudo);
    expect((await approve(approvalId, pseudo, { reason: '근거' })).statusCode).toBe(403);
    const revoked = commander();
    admin.revoked.set(revoked['x-user-id']!, [{ kind: 'PSEUDONYM_HANDLER', revokedAtMs: NOW - 10 * DAY }]);
    await getApproval(approvalId, revoked);
    expect((await approve(approvalId, revoked, { reason: '근거' })).statusCode).toBe(403);
    const old = commander();
    admin.revoked.set(old['x-user-id']!, [{ kind: 'PSEUDONYM_HANDLER', revokedAtMs: NOW - 91 * DAY }]);
    await getApproval(approvalId, old);
    expect((await approve(approvalId, old, { reason: '90일 지난 거둠' })).statusCode).toBe(200);
    const downCase = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(131), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    const downCreated = await actionRequest(downCase.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(131)], reason: '제한' });
    const down = commander();
    const downApprovalId = String(json(downCreated).approvalId);
    expect((await getApproval(downApprovalId, down)).statusCode).toBe(200);
    admin.fail = { method: 'designations', problem: new AdminAccountProblem('admin-account-unavailable', 503, 'identity down') };
    expect((await approve(downApprovalId, down, { reason: '답 없음' })).statusCode).toBe(403);
  });

  test('FX-T12 58 FRAUD_ACTION 승인은 같은 승인 ID로 두 번 실행해도 한 번만 취소한다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(140), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    seedTicket({ ticketId: T(140), payerAccountId: A(140) });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(140)], reason: '봇' });
    const approvalId = String(json(created).approvalId);
    await getApproval(approvalId, approver);
    const before = cancelCalls.length;
    expect((await approve(approvalId, approver, { reason: '근거' })).statusCode).toBe(200);
    expect([200, 409]).toContain((await approve(approvalId, approver, { reason: '근거' })).statusCode);
    expect(cancelCalls.length).toBe(before + 1);
  });

  test('FX-T12 59 [ASVS v5.0.0-16.5.3] RESTRICT는 identity 보관이 먼저이고 queue·purchase가 모두 반영돼야 Done이다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(150), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(150)], reason: '제한', restrictionEndsAt: iso(NOW + 30 * DAY) });
    const approvalId = String(json(created).approvalId);
    await getApproval(approvalId, approver);
    restrictionCalls.length = 0;
    restrictionClient.failNextQueue = true;
    const failed = await approve(approvalId, approver, { reason: '근거' });
    expect(failed.statusCode, failed.payload).toBe(200);
    expect(json(failed).status).toBe('FAILED');
    expect(restrictionCalls.map((x) => x.op)).toEqual(['identity.RESTRICTED', 'queue']);
    expect(restrictionCalls.some((x) => x.op === 'purchase')).toBe(false);
    expect(json(await getCase(c.caseId, who)).status).toBe('DECISION_PENDING');
    restrictionClient.failNextIdentity = true;
    const retried = await approve(approvalId, approver, { reason: '근거' });
    expect(json(retried).status).toBe('FAILED');
    expect(restrictionCalls.at(-1).op).toBe('identity.RESTRICTED');
    expect(json(await getApproval(approvalId, approver)).status).toBe('FAILED');
    restrictionClient.failNextPurchase = true;
    restrictionCalls.length = 0;
    const purchaseFailed = await approve(approvalId, approver, { reason: '근거' });
    expect(json(purchaseFailed).status).toBe('FAILED');
    expect(restrictionCalls.map((x) => x.op)).toEqual(['identity.RESTRICTED', 'queue', 'purchase']);
    const failedPurchase = restrictionCalls.find((x) => x.op === 'purchase')!;
    restrictionCalls.length = 0;
    const ok = await approve(approvalId, approver, { reason: '근거' });
    expect(json(ok).status).toBe('DONE');
    expect(restrictionCalls.map((x) => x.op)).toEqual(['identity.RESTRICTED', 'queue', 'purchase']);
    const okPurchase = restrictionCalls.find((x) => x.op === 'purchase')!;
    expect(okPurchase.restrictionId).toBe(failedPurchase.restrictionId);
    expect(okPurchase.version).toBe(failedPurchase.version);
  });

  test('FX-T12 60 LIFT_RESTRICTION은 진행 중 OBJECTED이고 identity 해제와 두 사본 해제 뒤 Done이다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({ status: 'OBJECTED', members: [memberOf(A(160), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY, objectionResult: 'ACCEPTED', objectionDecidedAtMs: NOW - DAY })] });
    restrictionState.set(A(160), { caseId: c.caseId, accountId: A(160), restrictionId: randomUUID(), untilMs: NOW + 30 * DAY, version: 1, state: 'ACTIVE' });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'LIFT_RESTRICTION', accountIds: [A(160)], reason: '이의 인정' });
    expect(json(await getCase(c.caseId, who)).status).toBe('OBJECTED');
    const approvalId = String(json(created).approvalId);
    await getApproval(approvalId, approver);
    restrictionCalls.length = 0;
    const ok = await approve(approvalId, approver, { reason: '근거' });
    expect(json(ok).status).toBe('DONE');
    expect(restrictionCalls.map((r) => r.op)).toEqual(['identity.RELEASED', 'queue', 'purchase']);
    expect(restrictionCalls.filter((r) => r.op === 'queue' || r.op === 'purchase').every((r) => r.state === 'LIFTED' && r.accountId === A(160))).toBe(true);
    expect(['OBJECTED', 'REVERSED']).toContain(json(await getCase(c.caseId, who)).status);
  });

  test('FX-T12 61 C-T63 새 조치·정상 종료 경로도 지정 없는 운영자에게 403이고 접속기록에 남는다', async () => {
    const outsider = identity.ops('cs_lead');
    admin.seed({ adminAccountId: outsider['x-user-id']!, role: 'cs_lead', designations: [] });
    const c = await seedCase();
    const before = access.records.length;
    const auditBefore = audit.entries.length;
    for (const r of await Promise.all([
      actionRequest(c.caseId, outsider, { fraudAction: 'RESTRICT', accountIds: [A(1)], reason: 'x' }),
      clearance(c.caseId, outsider, { reason: 'x', outcomeLabel: 'NONE' }),
    ])) {
      expect(r.statusCode, r.payload).toBe(403);
      expect(typeOf(r)).toBe('investigator-required');
    }
    const denied = access.records.slice(before);
    expect(denied).toHaveLength(2);
    expect(denied.every((r) => r.outcome === 'DENIED')).toBe(true);
    expect(audit.entries.slice(auditBefore).filter((e) => e.recordType === 'ADMIN_DATA_ACCESS' && e.record.payload.outcome === 'DENIED')).toHaveLength(2);
  });

});

describe('F-04-13 표 취소·환급·마감', () => {
  test('FX-T12 62 [ASVS v5.0.0-16.5.3] 내부 이의 접수는 토큰 없음·틀림을 거부하고 맞는 토큰만 받는다', async () => {
    vi.stubEnv('PEAKET_INTERNAL_TOKEN', 'f0413-internal-token');
    const tokenSvc = await createService({
      name: 'ops-svc-fraud-token',
      module: AppModule.register({
        memory: true,
        auditChain: audit,
        adminAccounts: { identity: admin, reauth: kit.verifier },
        approvals: { reauth: kit.verifier, admin: { identity: admin, reauth: kit.verifier } } as any,
        investigations: investigationDeps,
      }),
      env: { PEAKET_ENV: 'ci' },
      clock,
      logDestination: quiet(),
      adminAuthz: identity,
    });
    try {
      const c = await seedCase({ status: 'ACTIONED', members: [memberOf(A(62), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY })] });
      const body = { appealId: randomUUID(), accountId: A(62), party: 'PAYER', submittedAt: iso(NOW) };
      const call = (headers: Record<string, string>) =>
        tokenSvc.http.inject({ method: 'POST', url: `/internal/v1/fraud-cases/${c.caseId}/appeals`, headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(body) }) as unknown as Promise<Req>;
      expect((await call({})).statusCode).toBe(403);
      expect((await call({ 'x-peaket-internal-token': 'wrong' })).statusCode).toBe(403);
      expect((await call({ 'x-peaket-internal-token': 'f0413-internal-token' })).statusCode).toBe(200);
    } finally {
      await tokenSvc.close();
      vi.unstubAllEnvs();
    }
  });

  test('R-T33 ① 표 취소 승인은 표마다 결과를 남기고 공제 0원·FRAUD 사유로 환급을 시작한다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(200), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    seedTicket({ ticketId: T(200), payerAccountId: A(200) });
    seedTicket({ ticketId: T(2_001), payerAccountId: A(200), holderAccountId: H(2) });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(200)], reason: '봇' });
    const approvalId = String(json(created).approvalId);
    await getApproval(approvalId, approver);
    const done = await approve(approvalId, approver, { reason: '근거' });
    expect(done.statusCode, done.payload).toBe(200);
    expect(cancelCalls.at(-1)).toMatchObject({ approvalId, caseId: c.caseId, eventId: EVENT });
    expect(cancelCalls.at(-1).targets).toEqual([{ ticketId: T(200), expectedHolderAccountId: A(200) }]);
    const detail = (await getCase(c.caseId, who)).payload;
    expect(detail).toContain('ACTION_EXECUTED');
    expect(detail).toContain('ACCEPTED');
    expect(noticeCalls.some((n) => n.kind === 'actionNotice' && n.accountId === A(200))).toBe(true);
  });

  test('R-T33 ② 표 취소 실행에서 실패한 표만 다시 실행하고 끝까지 실패하면 승인 업무가 FAILED다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(201), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    seedTicket({ ticketId: T(201), payerAccountId: A(201) });
    seedTicket({ ticketId: T(202), payerAccountId: A(201) });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(201)], reason: '봇' });
    const approvalId = String(json(created).approvalId);
    await getApproval(approvalId, approver);
    cancels.set(approvalId, [{ ticketId: T(201), outcome: 'FAILED', failureCode: 'TICKET_UNAVAILABLE' }, { ticketId: T(202), outcome: 'ACCEPTED', cancellationId: randomUUID(), refundAmount: 100_000 }]);
    const failed = await approve(approvalId, approver, { reason: '근거' });
    expect(json(failed).status).toBe('FAILED');
    expect(cancelCalls.at(-1).targets.map((t: any) => t.ticketId)).toEqual([T(201), T(202)]);
    const retried = await approve(approvalId, approver, { reason: '근거' });
    expect(json(retried).status).toBe('DONE');
    expect(cancelCalls.at(-1).targets).toEqual([{ ticketId: T(201), expectedHolderAccountId: A(201) }]);
  });

  test('R-T33 ③ 승인 대기 중 취소 마감이 지나면 EXPIRED이고 표가 바뀌지 않는다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(202), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    seedTicket({ ticketId: T(202), payerAccountId: A(202) });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(202)], reason: '봇' });
    const approvalId = String(json(created).approvalId);
    clock.advance(CANCEL - clock.now());
    await tick('expireDue');
    expect(cancelCalls.some((x) => x.approvalId === approvalId)).toBe(false);
    expect((await getCase(c.caseId, who)).payload).toContain('ACTION_CLOSED');
    clock.advance(NOW - clock.now());
  });

  test('R-T33 ④ 이의 인정은 취소한 표마다 우선 구매를 열고 좌석이 없으면 보상 결과를 남긴다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({
      status: 'OBJECTED',
      members: [memberOf(A(203), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY, objectionResult: 'SUBMITTED', objectionReceivedAtMs: NOW - DAY })],
      events: [
        { seq: 1, kind: 'CREATED', actorId: id(0x900), note: null, detail: null, occurredAtMs: NOW - DAY },
        { seq: 2, kind: 'ACTION_EXECUTED', actorId: id(0x900), note: null, detail: { action: 'CANCEL_TICKETS', results: [{ ticketId: T(203), outcome: 'ACCEPTED' }] }, occurredAtMs: NOW - DAY },
      ],
    });
    restrictionState.set(A(203), { caseId: c.caseId, accountId: A(203), restrictionId: randomUUID(), untilMs: NOW + 30 * DAY, version: 1, state: 'ACTIVE' });
    objectionResultNext = 'NO_SEAT';
    const patch = await send('PATCH', `/v1/ops/fraud-cases/${c.caseId}`, who, { ifMatch: '"1"', body: { objectionDecisions: [{ accountId: A(203), decision: 'ACCEPTED', reason: '정상' }] } });
    expect(patch.statusCode, patch.payload).toBe(200);
    const approvalId = String(json(patch).approvalId);
    await getApproval(approvalId, approver);
    const lifted = await approve(approvalId, approver, { reason: '이의 인정' });
    expect(json(lifted).status).toBe('DONE');
    expect(priorityCalls.some((p) => p.decision === 'ACCEPTED' && p.cancelledTicketId === T(203))).toBe(true);
    expect((await getCase(c.caseId, who)).payload).toContain('NO_SEAT');
    objectionResultNext = 'SAME_SEAT';
  });

  test('R-T33 ⑤ 일반 승인 요청 경로로 FRAUD_ACTION을 만들면 422다', async () => {
    const who = commander();
    const fraud = await send('POST', '/v1/ops/approval-requests', who, { idem: randomUUID(), body: { kind: 'FRAUD_ACTION', targetRef: randomUUID(), reasonText: 'x' } });
    expect(fraud.statusCode).toBe(422);
    expect(typeOf(fraud)).toBe('fraud-action-requires-case-request');
    const other = await send('POST', '/v1/ops/approval-requests', who, { idem: randomUUID(), body: { kind: 'SYSTEM_FAULT_REFUND', targetRef: randomUUID(), reasonText: 'x' } });
    expect(other.statusCode).toBe(422);
    expect(typeOf(other)).toBe('approval-kind-not-supported');
  });

  test('R-T33 ⑥ 요청자 본인·가명정보 취급자 commander의 승인은 403이다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(204), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(204)], reason: '제한' });
    const approvalId = String(json(created).approvalId);
    expect((await approve(approvalId, who, { reason: '내가' })).statusCode).toBe(403);
    const pseudo = commander(['PSEUDONYM_HANDLER']);
    await getApproval(approvalId, pseudo);
    expect((await approve(approvalId, pseudo, { reason: '근거' })).statusCode).toBe(403);
  });

  test('R-T33 ⑦ 승인 업무 상세를 열지 않은 승인자와 다른 사람만 연 승인자는 409다', async () => {
    const who = investigator();
    const a = commander();
    const b = commander();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(205), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(205)], reason: '제한' });
    const approvalId = String(json(created).approvalId);
    expect((await approve(approvalId, a, { reason: '근거' })).statusCode).toBe(409);
    await getApproval(approvalId, a);
    expect((await approve(approvalId, b, { reason: '근거' })).statusCode).toBe(409);
    expect((await approve(approvalId, a, { reason: '근거' })).statusCode).toBe(200);
  });

  test('R-T33 ⑧ FRAUD_ACTION 승인에 이유가 없으면 422다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(206), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(206)], reason: '제한' });
    const approvalId = String(json(created).approvalId);
    await getApproval(approvalId, approver);
    const r = await approve(approvalId, approver, {});
    expect(r.statusCode).toBe(422);
    expect(typeOf(r)).toBe('approval-reason-required');
  });

  test('R-T33 ⑨ 승인자가 계정 하나를 빼면 남은 계정 표만 취소되고 뺀 계정 잠금이 풀린다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(207), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR }), memberOf(A(208), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    seedTicket({ ticketId: T(207), payerAccountId: A(207) });
    seedTicket({ ticketId: T(208), payerAccountId: A(208) });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(207), A(208)], reason: '봇' });
    const approvalId = String(json(created).approvalId);
    await getApproval(approvalId, approver);
    expect((await approve(approvalId, approver, { reason: '근거', excludeAccountIds: [A(208)] })).statusCode).toBe(200);
    expect(cancelCalls.at(-1).targets.map((t: any) => t.ticketId)).toEqual([T(207)]);
    expect(locks.releases.some((r) => r.accountIds.includes(A(208)) && r.releaseReason === 'ACTION_CLOSED')).toBe(true);
  });

  test('R-T33 ⑩ 잠금이 풀린 뒤 넘어간 받은 사람의 표는 건너뛰고 다시 넣으면 409다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(209), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    seedTicket({ ticketId: T(209), payerAccountId: A(209) });
    seedTicket({ ticketId: T(0x99), payerAccountId: A(209), holderAccountId: H(1) });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(209)], ticketIds: [T(209), T(0x99)], reason: '봇' });
    const approvalId = String(json(created).approvalId);
    await getApproval(approvalId, approver);
    const done = await approve(approvalId, approver, { reason: '근거' });
    expect(done.statusCode, done.payload).toBe(200);
    expect(noticeCalls.some((n) => n.kind === 'holderResult' && n.accountId === H(1) && n.result === 'EXCLUDED')).toBe(true);
    expect(locks.releases.some((r) => r.accountIds.includes(A(209)) && r.releaseReason === 'ACTION_DONE')).toBe(true);
    const retry = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(209)], ticketIds: [T(0x99)], reason: '다시' });
    expect(retry.statusCode).toBe(409);
    expect(typeOf(retry)).toBe('fraud-case-state');
  });

  test('FX-T18 ⑤ 표 취소는 취소 마감 전에 실행되고 좌석을 정가 재판매로 돌린다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(210), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    seedTicket({ ticketId: T(210), payerAccountId: A(210) });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(210)], reason: '봇' });
    const approvalId = String(json(created).approvalId);
    await getApproval(approvalId, approver);
    expect((await approve(approvalId, approver, { reason: '근거' })).statusCode).toBe(200);
    expect(cancelCalls.at(-1).targets).toEqual([{ ticketId: T(210), expectedHolderAccountId: A(210) }]);
    expect(noticeCalls.some((n) => n.kind === 'actionNotice' && n.accountId === A(210))).toBe(true);
  });

  test('FX-T18 ⑥ 승인 대기 중 취소 마감이 지나면 요청은 EXPIRED이고 표는 바뀌지 않는다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(211), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(211)], reason: '봇' });
    const approvalId = String(json(created).approvalId);
    clock.advance(CANCEL - clock.now());
    await tick('expireDue');
    expect(json(await getApproval(approvalId, who)).status).toBe('EXPIRED');
    clock.advance(NOW - clock.now());
  });

  test('FX-T18 ⑦ 실행 실패로 남은 표 취소는 마감이 지나면 다시 실행하지 않고 사건은 이용 제한만 남는다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(212), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    seedTicket({ ticketId: T(212), payerAccountId: A(212) });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(212)], reason: '봇' });
    const approvalId = String(json(created).approvalId);
    await getApproval(approvalId, approver);
    cancels.set(approvalId, [{ ticketId: T(212), outcome: 'FAILED', failureCode: 'TICKET_UNAVAILABLE' }]);
    expect(json(await approve(approvalId, approver, { reason: '근거' })).status).toBe('FAILED');
    const before = cancelCalls.length;
    clock.advance(CANCEL - clock.now());
    await tick('expireDue');
    expect(cancelCalls.length).toBe(before);
    expect(json(await getApproval(approvalId, who)).status).toBe('EXPIRED');
    const again = await approve(approvalId, approver, { reason: '마감 뒤 재시도' });
    expect(again.statusCode).toBe(409);
    expect(typeOf(again)).toBe('cancel-deadline-passed');
    expect(cancelCalls.length).toBe(before);
    expect(json(await getCase(c.caseId, who)).status).toBe('INVESTIGATING');
    const cancelAgain = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(212)], reason: '다시' });
    expect(cancelAgain.statusCode).toBe(409);
    expect(typeOf(cancelAgain)).toBe('cancel-deadline-passed');
    const onlyRestriction = await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(212)], reason: '제한만', restrictionEndsAt: iso(clock.now() + 30 * DAY) });
    expect(onlyRestriction.statusCode, onlyRestriction.payload).toBe(201);
    clock.advance(NOW - clock.now());
  });

  test('FX-T18 ⑧ 표 취소 마감 12시간 전에 담당 조사관과 승인 대기 commander에게 알린다', async () => {
    const who = investigator();
    const boss = commander();
    const bossId = boss['x-user-id']!;
    eligibleApproverIds = [bossId];
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(213), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(213)], reason: '봇' });
    expect(created.statusCode).toBe(201);
    const approvalId = String(json(created).approvalId);
    clock.advance(CANCEL - 12 * HOUR - clock.now());
    await tick('notifyDeadlines');
    const first = noticeCalls.filter((n) => n.kind === 'deadlineNotice' && n.approvalId === approvalId && n.leadMs === 12 * HOUR);
    expect(first).toHaveLength(1);
    expect(new Set(first[0]!.recipients)).toEqual(new Set([c.assigneeId, bossId]));
    await tick('notifyDeadlines');
    expect(noticeCalls.filter((n) => n.kind === 'deadlineNotice' && n.approvalId === approvalId && n.leadMs === 12 * HOUR)).toHaveLength(1);
    clock.advance(NOW - clock.now());
    eligibleApproverIds = [];
  });

  test('FX-T18 ⑨ 표 취소 마감 2시간 전에 담당 조사관과 승인 대기 commander에게 알린다', async () => {
    const who = investigator();
    const boss = commander();
    const bossId = boss['x-user-id']!;
    eligibleApproverIds = [bossId];
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(214), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(214)], reason: '봇' });
    expect(created.statusCode).toBe(201);
    const approvalId = String(json(created).approvalId);
    clock.advance(CANCEL - 12 * HOUR - clock.now());
    await tick('notifyDeadlines');
    const twelve = noticeCalls.find((n) => n.kind === 'deadlineNotice' && n.approvalId === approvalId && n.leadMs === 12 * HOUR);
    expect(twelve).toBeTruthy();
    expect(new Set(twelve.recipients)).toEqual(new Set([c.assigneeId, bossId]));
    clock.advance(10 * HOUR);
    await tick('notifyDeadlines');
    const two = noticeCalls.find((n) => n.kind === 'deadlineNotice' && n.approvalId === approvalId && n.leadMs === 2 * HOUR);
    expect(two).toBeTruthy();
    expect(new Set(two.recipients)).toEqual(new Set([c.assigneeId, bossId]));
    const before = noticeCalls.filter((n) => n.kind === 'deadlineNotice' && n.approvalId === approvalId).length;
    clock.advance(3 * HOUR);
    await tick('notifyDeadlines');
    expect(noticeCalls.filter((n) => n.kind === 'deadlineNotice' && n.approvalId === approvalId).length).toBe(before);
    clock.advance(NOW - clock.now());
    eligibleApproverIds = [];
  });

  test('FX-T18 ⑩ 취소 마감 뒤 표 취소 요청은 409 cancel-deadline-passed이고 이용 제한은 된다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: CANCEL - HOUR, members: [memberOf(A(215), { appealResult: 'REJECTED', appealDueAtMs: CANCEL - HOUR })] });
    clock.advance(CANCEL - clock.now());
    const cancel = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(215)], reason: '봇' });
    expect(cancel.statusCode).toBe(409);
    expect(typeOf(cancel)).toBe('cancel-deadline-passed');
    const restrict = await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(215)], reason: '제한', restrictionEndsAt: iso(clock.now() + 30 * DAY) });
    expect(restrict.statusCode).toBe(201);
    clock.advance(NOW - clock.now());
  });
});

describe('F-04-13 구현 리뷰 반영', () => {
  beforeEach(() => {
    clock.advance(NOW - clock.now());
    cancellationClient.nextEmptyResults = false;
    cancellationClient.nextThrow = false;
    cancellationClient.nextOmitLast = false;
    admin.failOnCall = undefined;
  });

  test('IR-06 반려·철회는 상태·승인 자격·요청자를 확인한다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(301), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(301)], reason: '제한' });
    const approvalId = String(json(created).approvalId);
    const otherInvestigator = investigator();
    expect((await reject(approvalId, otherInvestigator)).statusCode).toBe(403);
    expect((await reject(approvalId, who)).statusCode).toBe(403);
    const operator = identity.ops('operator');
    admin.seed({ adminAccountId: operator['x-user-id']!, role: 'operator' });
    expect((await withdraw(approvalId, operator)).statusCode).toBe(403);
    expect((await withdraw(approvalId, commander())).statusCode).toBe(403);
    expect((await withdraw(approvalId, who)).statusCode).toBe(200);
    const expired = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(302), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    const lateCreated = await actionRequest(expired.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(302)], reason: '제한' });
    clock.advance(10 * DAY);
    await tick('expireDue');
    expect((await reject(String(json(lateCreated).approvalId), commander())).statusCode).toBe(409);
    clock.advance(NOW - clock.now());
  });

  test('IR-08 이용 제한 승인 기한은 5영업일이고 지난 뒤 승인·반려·철회는 409다', async () => {
    clock.advance(NOW - clock.now());
    const who = investigator();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(303), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(303)], reason: '제한', restrictionEndsAt: iso(NOW + 30 * DAY) });
    expect(created.statusCode, created.payload).toBe(201);
    expect(json(created).dueAt).toBe(iso(addBusinessDays(new WeekendHolidayCalendar(), NOW, 5)));
    const approvalId = String(json(created).approvalId);
    await getApproval(approvalId, commander());
    clock.advance(7 * DAY);
    expect((await approve(approvalId, commander(), { reason: '늦은 승인' })).statusCode).toBe(409);
    expect((await reject(approvalId, commander())).statusCode).toBe(409);
    expect((await withdraw(approvalId, who)).statusCode).toBe(409);
    clock.advance(NOW - clock.now());
  });

  test('IR-09 반려는 Done이 있어도 요청 대상 계정만 잠금을 푼다', async () => {
    const prior = randomUUID();
    const c = await seedCase({
      status: 'INVESTIGATING',
      approvalId: prior,
      members: [memberOf(A(310), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR }), memberOf(A(311), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })],
      events: [
        { seq: 1, kind: 'CREATED', actorId: id(0x900), note: null, detail: null, occurredAtMs: NOW - DAY },
        { seq: 2, kind: 'ACTION_EXECUTED', actorId: id(0x900), note: null, detail: { action: 'CANCEL_TICKETS', results: [{ ticketId: T(310), outcome: 'ACCEPTED' }] }, occurredAtMs: NOW - 2 * HOUR },
      ],
    });
    const created = await actionRequest(c.caseId, investigator(), { fraudAction: 'RESTRICT', accountIds: [A(310)], reason: '추가 제한', restrictionEndsAt: iso(NOW + 30 * DAY) });
    expect(created.statusCode, created.payload).toBe(201);
    const before = locks.releases.length;
    expect((await reject(String(json(created).approvalId), commander())).statusCode).toBe(200);
    const released = locks.releases.slice(before);
    expect(released.some((r) => r.accountIds.includes(A(310)))).toBe(true);
    expect(released.some((r) => r.accountIds.includes(A(311)))).toBe(false);
  });

  test('IR-10 표 취소 대상 경계와 취소 결과 누락·호출 오류는 422·FAILED다', async () => {
    const who = investigator();
    const emptyListCase = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(312), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    expect((await actionRequest(emptyListCase.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(312)], ticketIds: [], reason: '봇' })).statusCode).toBe(422);
    expect((await actionRequest(emptyListCase.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(312)], reason: '봇' })).statusCode).toBe(422);

    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(313), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    seedTicket({ ticketId: T(313), payerAccountId: A(313) });
    seedTicket({ ticketId: T(314), payerAccountId: A(314) });
    expect((await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(313)], ticketIds: [T(313), T(314)], reason: '봇' })).statusCode).toBe(422);

    const make = async (account: number, ticket: number, n: number) => {
      const cs = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(account), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
      if (n > 0) seedTicket({ ticketId: T(ticket), payerAccountId: A(account) });
      if (n > 1) seedTicket({ ticketId: T(ticket + 1), payerAccountId: A(account) });
      const created = await actionRequest(cs.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(account)], reason: '봇' });
      expect(created.statusCode, created.payload).toBe(201);
      await getApproval(String(json(created).approvalId), commander());
      return { caseId: cs.caseId, approvalId: String(json(created).approvalId) };
    };
    const empty = await make(315, 315, 1);
    cancellationClient.nextEmptyResults = true;
    expect(json(await approve(empty.approvalId, commander(), { reason: '근거' })).status).toBe('FAILED');
    const thrown = await make(316, 316, 1);
    cancellationClient.nextThrow = true;
    expect(json(await approve(thrown.approvalId, commander(), { reason: '근거' })).status).toBe('FAILED');
    const partial = await make(317, 317, 2);
    cancellationClient.nextOmitLast = true;
    expect(json(await approve(partial.approvalId, commander(), { reason: '근거' })).status).toBe('FAILED');
  });

  test('IR-12 인정 계정의 취소 표만 우선 구매로 열고 혼합 판정은 ACTIONED로 닫는다', async () => {
    const c = await seedCase({
      status: 'OBJECTED',
      members: [
        memberOf(A(320), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY, objectionResult: 'SUBMITTED', objectionReceivedAtMs: NOW - DAY }),
        memberOf(A(321), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY, objectionResult: 'SUBMITTED', objectionReceivedAtMs: NOW - DAY }),
        memberOf(A(322), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY, objectionResult: 'NONE' }),
      ],
      events: [
        { seq: 1, kind: 'CREATED', actorId: id(0x900), note: null, detail: null, occurredAtMs: NOW - DAY },
        { seq: 2, kind: 'ACTION_EXECUTED', actorId: id(0x900), note: null, detail: { action: 'CANCEL_TICKETS', results: [{ ticketId: T(320), outcome: 'ACCEPTED' }, { ticketId: T(321), outcome: 'ACCEPTED' }] }, occurredAtMs: NOW - 2 * DAY },
      ],
    });
    priorityCalls.length = 0;
    const patch = await send('PATCH', `/v1/ops/fraud-cases/${c.caseId}`, investigator(), {
      ifMatch: '"1"',
      body: { objectionDecisions: [{ accountId: A(320), decision: 'ACCEPTED', reason: '정상' }, { accountId: A(321), decision: 'REJECTED', reason: '근거' }] },
    });
    expect(patch.statusCode, patch.payload).toBe(200);
    expect(json(patch).status).toBe('ACTIONED');
    expect(priorityCalls.filter((p) => p.decision === 'ACCEPTED').every((p) => p.accountId === A(320))).toBe(true);
    expect(priorityCalls.flatMap((p) => p.cancelledTicketIds)).toEqual([T(320)]);

    const restricted = await seedCase({
      status: 'OBJECTED',
      members: [
        memberOf(A(323), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY, objectionResult: 'SUBMITTED', objectionReceivedAtMs: NOW - DAY }),
        memberOf(A(324), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY, objectionResult: 'NONE' }),
      ],
      events: [{ seq: 1, kind: 'CREATED', actorId: id(0x900), note: null, detail: null, occurredAtMs: NOW - DAY }],
    });
    restrictionState.set(A(323), { caseId: restricted.caseId, accountId: A(323), restrictionId: randomUUID(), untilMs: NOW + 30 * DAY, version: 1, state: 'ACTIVE' });
    const patch2 = await send('PATCH', `/v1/ops/fraud-cases/${restricted.caseId}`, investigator(), {
      ifMatch: '"1"',
      body: { objectionDecisions: [{ accountId: A(323), decision: 'ACCEPTED', reason: '정상' }] },
    });
    expect(patch2.statusCode, patch2.payload).toBe(200);
    const liftApproval = String(json(patch2).approvalId);
    await getApproval(liftApproval, commander());
    expect((await approve(liftApproval, commander(), { reason: '이의 인정' })).statusCode).toBe(200);
    expect(json(await getCase(restricted.caseId, investigator())).status).toBe('ACTIONED');
  });

  test('IR-14 받은 사람에게 취소 결과 CANCELED를 알린다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(330), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    seedTicket({ ticketId: T(330), payerAccountId: A(330), holderAccountId: H(4) });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(330)], ticketIds: [T(330)], reason: '봇' });
    const approvalId = String(json(created).approvalId);
    cancels.set(approvalId, [{ ticketId: T(330), outcome: 'ACCEPTED', cancellationId: randomUUID(), refundAmount: 100_000 }]);
    await getApproval(approvalId, commander());
    expect((await approve(approvalId, commander(), { reason: '근거' })).statusCode).toBe(200);
    const notice = noticeCalls.find((n) => n.kind === 'holderResult' && n.accountId === H(4));
    expect(notice).toMatchObject({ result: 'CANCELED' });
  });

  test('IR-17 사건 요약은 묶음의 실제 값과 소명 결과를 싣는다', async () => {
    const clusterId = newId();
    await store.putClusters(EVENT, 9, [{
      clusterId,
      eventId: EVENT,
      generation: 9,
      scoreBand: 'LOW',
      accountCount: 1,
      purchaseCount: 3,
      limitPerPerson: 2,
      sharedAttributes: ['PAYMENT_METHOD'],
      signals: ['LINK_GRAPH'],
      snapshotVersion: 1,
      createdAtMs: NOW - DAY,
      members: [memberOf(A(340))],
    } as any], 'v9');
    const who = investigator();
    const c = await seedCase({
      clusterId,
      status: 'APPEAL_PENDING',
      appealDueAtMs: NOW - HOUR,
      members: [memberOf(A(340), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })],
    });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(340)], reason: '제한' });
    const view = await getApproval(String(json(created).approvalId), commander());
    expect(json(view).fraudCaseSummary).toMatchObject({ limitPerPerson: 2, scoreBand: 'LOW', sharedAttributes: ['PAYMENT_METHOD'], appealOutcome: 'REJECTED' });
    const detail = await getCase(c.caseId, who);
    expect(json(detail).appealOutcome).toBe('REJECTED');
  });

  test('IR-18 HOLDER 진술은 사건의 보유 표·계정·시각을 확인한다', async () => {
    const c = await seedCase({ status: 'ACTIONED', members: [memberOf(A(350), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY })] });
    seedTicket({ ticketId: T(350), payerAccountId: A(350), holderAccountId: H(5) });
    const body = (accountId: string, submittedAt = iso(NOW)) => ({ appealId: randomUUID(), accountId, party: 'HOLDER', submittedAt });
    expect((await send('POST', `/internal/v1/fraud-cases/${c.caseId}/appeals`, {}, { body: body(H(5)) })).statusCode).toBe(200);
    expect((await send('POST', `/internal/v1/fraud-cases/${c.caseId}/appeals`, {}, { body: body(H(6)) })).statusCode).toBe(409);
    expect((await send('POST', `/internal/v1/fraud-cases/${c.caseId}/appeals`, {}, { body: body(H(5), 'not-a-date') })).statusCode).toBe(400);
  });

  test('IR-19 승인 직전 identity 조회 실패는 fail-open이 아니라 403이다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(351), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(351)], reason: '제한' });
    const approvalId = String(json(created).approvalId);
    await getApproval(approvalId, approver);
    admin.failOnCall = { method: 'designations', at: (admin.counts.get('designations') ?? 0) + 2 };
    try {
      expect((await approve(approvalId, approver, { reason: '근거' })).statusCode).toBe(403);
    } finally {
      admin.failOnCall = undefined;
    }
  });

  test('IR-20 조치 본문의 날짜·경로 UUID를 계약으로 검증한다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(352), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    expect((await actionRequest(c.caseId, who, { fraudAction: 'RESTRICT', accountIds: [A(352)], reason: '제한', restrictionEndsAt: 'not-a-date' })).statusCode).toBe(400);
    expect((await send('POST', '/v1/ops/fraud-cases/not-a-uuid/action-requests', who, { idem: randomUUID(), body: { fraudAction: 'RESTRICT', accountIds: [A(352)], reason: '제한' } })).statusCode).toBe(400);
  });

  test('IR-23 최대 기한에 잠금을 풀면 사건 기록과 알림을 남긴다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', members: [memberOf(A(360), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - 10 * DAY, lockExpiresAtMs: NOW + DAY })] });
    clock.advance(NOW + DAY - clock.now());
    await tick('expireDue');
    expect(appealCopies.some((x) => x.caseId === c.caseId && x.accountId === A(360) && x.lockActive === false)).toBe(true);
    expect(json(await getCase(c.caseId, who)).events.some((e: any) => e.kind === 'LOCK_RELEASED' && e.detail?.releaseReason === 'MAX_DEADLINE')).toBe(true);
    expect(noticeCalls.some((n) => n.kind === 'transferLockReleased' && n.caseId === c.caseId && n.accountId === A(360))).toBe(true);
    clock.advance(NOW - clock.now());
  });

  test('IR-27 잠금이 없어도 HUMAN 정상 종료는 활성 계정에 라벨을 남긴다', async () => {
    const c = await seedCase({ status: 'INVESTIGATING', members: [memberOf(A(370), { appealResult: 'REJECTED', lockExpiresAtMs: null })] });
    const r = await clearance(c.caseId, investigator(), { reason: '정상', outcomeLabel: 'HUMAN' });
    expect(r.statusCode, r.payload).toBe(200);
    expect(labels.calls.some((l) => l.label === 'HUMAN' && l.accountIds.includes(A(370)))).toBe(true);
  });

  test('IR-28 모두 건너뛴 표 취소는 ACTIONED·BOT 라벨·조치 알림을 만들지 않는다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(380), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    seedTicket({ ticketId: T(380), payerAccountId: A(380) });
    const created = await actionRequest(c.caseId, who, { fraudAction: 'CANCEL_TICKETS', accountIds: [A(380)], reason: '봇' });
    const approvalId = String(json(created).approvalId);
    cancels.set(approvalId, [{ ticketId: T(380), outcome: 'SKIPPED_ALREADY_ENDED' }]);
    await getApproval(approvalId, commander());
    expect((await approve(approvalId, commander(), { reason: '근거' })).statusCode).toBe(200);
    const after = json(await getCase(c.caseId, who));
    expect(after.status).not.toBe('ACTIONED');
    expect(labels.calls.some((l) => l.label === 'BOT' && l.accountIds.includes(A(380)))).toBe(false);
    expect(noticeCalls.some((n) => n.kind === 'actionNotice' && n.accountId === A(380))).toBe(false);
  });
});

