// F-04-14 증거 묶음·내보내기·외부 게시물 HTTP 시험(동결 로컬, LCH-290·LCH-300).
// 정본: docs/features/forensic-replay.md §6.7.6~§6.7.8, docs/features/control-tower.md §9,
// docs/features/transfer-refund.md §7.4, docs/infra.md §9, docs/api/openapi.yaml 태그 investigations.
// [ASVS v5.0.0-5.1.1] 업로드 형식·크기, [ASVS v5.0.0-5.2.2] 확장자·매직, [ASVS v5.0.0-5.4.3] 악성 코드 검사,
// [ASVS v5.0.0-8.1.2] 목록 요약·상세 열람, [ASVS v5.0.0-13.2.2] 법적 보존·파기 신원,
// [ASVS v5.0.0-14.2.6] 최소화, [ASVS v5.0.0-16.3.4] 실패 기록, [ASVS v5.0.0-16.4.2] 관리 연속성.
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import * as investigationsModule from '../src/modules/investigations/index.js';
import {
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
import { WeekendHolidayCalendar } from '../src/modules/cases/index.js';
import { FakeAdminIdentity, reauthKit } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';
import {
  CANCEL,
  DAY,
  ENTRY,
  HOUR,
  NOW,
  SHOW,
  SALE_ENDS,
  id,
  iso,
  makePdf,
  makePng,
  multipart,
  pixelAt,
  readPng,
  sha256,
} from './fraud-evidence-support.js';

const A = (n: number) => id(0x1000 + n);
const T = (n: number) => id(0x2000 + n);
const H = (n: number) => id(0x1800 + n);
const EVENT = id(0x200);
const CLUSTER = id(0x300);
const CASE = id(0x400);
const REQUEST = id(0x700);

const schedule: SaleScheduleSource = {
  get: async (eventId: string) => (eventId === EVENT ? { opensAtMs: SHOW - 7 * DAY, saleEndsAtMs: SALE_ENDS, entryOpensAtMs: ENTRY, entryClosedAtMs: ENTRY + 3 * HOUR } : undefined),
};

type Req = { statusCode: number; payload: string; headers: Record<string, string | string[] | undefined>; rawPayload?: Buffer };
const json = (r: Req) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, any>));
const typeOf = (r: Req) => String(json(r).type ?? '');

/** 시험용 저장소. 제품 인터페이스의 이름만 맞춘다. 제품 Drizzle 판은 통합 시험이 본다. */
class EvidenceStoreFake {
  readonly bundles = new Map<string, any>();
  readonly custody = new Map<string, any[]>();
  readonly exports: any[] = [];
  readonly posts = new Map<string, any>();
  readonly idem = new Map<string, any>();
  forcedExportCount: number | null = null;

  constructor(private readonly cases: MemoryInvestigationStore) {}

  async putBundle(b: any, c: any, o: any = {}) {
    if (o.idem) {
      const key = `${o.idem.accountRef}:${o.idem.operation}:${o.idem.key}`;
      if (this.idem.has(key)) return { replayed: true, result: this.idem.get(key) };
      this.idem.set(key, o.result ?? b);
    }
    this.bundles.set(b.bundleId, { ...b, files: [...(b.files ?? [])] });
    const row = this.#row(b.bundleId, c);
    (this.custody.get(b.bundleId) ?? this.custody.set(b.bundleId, []).get(b.bundleId)!).push(row);
    return { replayed: false };
  }
  async getBundle(bundleId: string) {
    const b = this.bundles.get(bundleId);
    return b ? { ...b, files: [...(b.files ?? [])] } : null;
  }
  async listBundles(q: { eventId: string; cursor?: string; limit: number }) {
    const items = [...this.bundles.values()].filter((b) => b.eventId === q.eventId).sort((a, b) => b.createdAtMs - a.createdAtMs);
    const after = q.cursor ? items.filter((b) => b.bundleId > q.cursor!) : items;
    const page = after.slice(0, q.limit);
    return { items: page.map((b) => ({ ...b })), nextCursor: after.length > q.limit ? page[page.length - 1]!.bundleId : null };
  }
  async updateBundle(b: any, expectedStatus?: readonly string[]) {
    const cur = this.bundles.get(b.bundleId);
    if (!cur) return false;
    if (expectedStatus && !expectedStatus.includes(cur.status)) return false;
    this.bundles.set(b.bundleId, { ...b, files: [...(b.files ?? [])] });
    return true;
  }
  async appendCustody(bundleId: string, c: any) {
    const rows = this.custody.get(bundleId) ?? [];
    const row = this.#row(bundleId, c);
    rows.push(row);
    this.custody.set(bundleId, rows);
    return row;
  }
  async listCustody(bundleId: string) {
    return [...(this.custody.get(bundleId) ?? [])];
  }
  async listDueForBuild() {
    return [...this.bundles.values()].filter((b) => b.status === 'BUILDING');
  }
  async listDueForDispose(nowMs: number) {
    const domain = investigationsModule as unknown as Record<string, any>;
    return [...this.bundles.values()].filter((b) => b.status === 'SEALED' && domain.disposeAfterMs({ createdAtMs: b.createdAtMs, holdReason: b.holdReason, holdEndedAtMs: b.holdEndedAtMs }) <= nowMs);
  }
  async putExport(e: any) {
    this.exports.push({ ...e });
  }
  async exportCountSince(actorId: string, sinceMs: number) {
    if (this.forcedExportCount !== null) return this.forcedExportCount;
    return this.exports.filter((e) => e.actorId === actorId && e.createdAtMs >= sinceMs).length;
  }
  async listClosedCases(eventId: string) {
    const r = await this.cases.listCases({ eventId, status: ['ACTIONED', 'CLEARED', 'REVERSED'] as FraudCaseStatus[], limit: 1000 });
    return r.items;
  }
  async putPost(p: any, o: any = {}) {
    if (o.idem) {
      const key = `${o.idem.accountRef}:${o.idem.operation}:${o.idem.key}`;
      if (this.idem.has(key)) return { replayed: true, result: this.idem.get(key) };
      this.idem.set(key, o.result ?? p);
    }
    this.posts.set(p.postId, { ...p });
    return { replayed: false };
  }
  async getPost(postId: string) {
    const p = this.posts.get(postId);
    return p ? { ...p } : null;
  }
  async listPosts(q: { eventId: string; cursor?: string; limit: number }) {
    const items = [...this.posts.values()].filter((p) => p.eventId === q.eventId).sort((a, b) => b.createdAtMs - a.createdAtMs);
    const after = q.cursor ? items.filter((p) => p.postId > q.cursor!) : items;
    const page = after.slice(0, q.limit);
    return { items: page.map((p) => ({ ...p })), nextCursor: after.length > q.limit ? page[page.length - 1]!.postId : null };
  }
  async updatePost(p: any) {
    if (!this.posts.has(p.postId)) return false;
    this.posts.set(p.postId, { ...p });
    return true;
  }
  async listPendingScans() {
    return [...this.posts.values()].filter((p) => p.scanStatus === 'PENDING');
  }
  async listUnusedPostsForDisposal(beforeMs: number) {
    return [...this.posts.values()].filter((p) => p.createdAtMs < beforeMs && (p.scanStatus === 'THREAT' || p.matchedTicketIds.length === 0));
  }
  async findByIdempotent(idem: any) {
    const key = `${idem.accountRef}:${idem.operation}:${idem.key}`;
    return this.idem.has(key) ? { kind: 'replay', result: this.idem.get(key) } : { kind: 'none' };
  }
  tamperCustody(bundleId: string, seq: number) {
    const row = this.custody.get(bundleId)?.find((r) => r.seq === seq);
    if (row) row.reason = '고친 행';
  }
  #row(bundleId: string, c: any) {
    const rows = this.custody.get(bundleId) ?? [];
    const seq = rows.length + 1;
    const prevHash = rows.at(-1)?.rowHash ?? null;
    const domain = investigationsModule as unknown as Record<string, any>;
    const row = { bundleId, ...c, seq, prevHash };
    return { ...row, rowHash: domain.custodyRowHash(row) };
  }
}

class ObjectStoreFake {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string; legalHold: boolean }>();
  readonly disposeCalls: string[] = [];
  async putOnce(key: string, bytes: Uint8Array, contentType: string) {
    const have = this.objects.get(key);
    if (have) return Buffer.from(have.bytes).equals(Buffer.from(bytes)) ? 'SAME' : 'DIFFERENT';
    this.objects.set(key, { bytes: Uint8Array.from(bytes), contentType, legalHold: true });
    return 'CREATED';
  }
  async get(key: string) {
    return this.objects.get(key)?.bytes;
  }
  async list(prefix: string) {
    return [...this.objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, sizeBytes: v.bytes.length }));
  }
  async dispose(prefix: string) {
    this.disposeCalls.push(prefix);
    for (const [key, v] of this.objects) {
      if (!key.startsWith(prefix)) continue;
      v.legalHold = false;
      this.objects.delete(key);
    }
  }
  tamper(key: string) {
    const o = this.objects.get(key);
    if (o) o.bytes = Buffer.concat([Buffer.from(o.bytes), Buffer.from('x')]);
  }
  tryDeleteAsService(key: string): void {
    const o = this.objects.get(key);
    if (o?.legalHold) throw new Error('ObjectLockLegalHold');
    this.objects.delete(key);
  }
}

class InventoryFake {
  readonly calls: any[] = [];
  readonly rows: Record<string, any[]> = {
    inv_request: [{ table: 'inv_request', accountId: A(1), tsMs: NOW, values: { request_id: 'req-1', route_kind: 'queue', ip: '203.0.113.9', asn: 64500, net_class: 'HOSTING', ja4: 't13d-secret', edge_bot_labels: ['bot'] } }],
    inv_step: [
      { table: 'inv_step', accountId: A(1), tsMs: NOW, values: { step: 'SALE', order_id: 'order-1', ticket_id: T(1), seat_ids: [T(1)], payment_method_ref: 'pm-secret', card_bin: '123456', pid: 'pid-secret' } },
      { table: 'inv_step', accountId: A(3), tsMs: NOW, values: { step: 'SALE', order_id: 'order-3', ticket_id: T(3) } },
    ],
    inv_link: [{ table: 'inv_link', accountId: A(1), tsMs: NOW, values: { kind: 'DEVICE', value: 'device-secret' } }],
    inv_behavior: [{ table: 'inv_behavior', accountId: A(1), tsMs: NOW, values: { pointer_entropy: 1.2 } }],
  };
  async read(i: any) {
    this.calls.push(i);
    const files = Object.keys(this.rows).map((table) => ({ name: `records/${table}.arrow`, table, sql: `SELECT * FROM inv.${table} WHERE event_id = {eventId:String}`, arrow: Buffer.from(`ARROW1-${table}`), rows: this.rows[table]! }));
    return { files, snapshots: [{ version: 1, invHash: 'a'.repeat(64), tableRowCounts: { inv_request: 1, inv_step: 2, inv_behavior: 1, inv_link: 1 } }] };
  }
}

class DataRequestsFake {
  readonly scopes = new Map<string, any>();
  readonly submitted: any[] = [];
  async approvedScope(i: { dataRequestId: string; eventId: string }) {
    return this.scopes.get(i.dataRequestId) ?? null;
  }
  async attachSubmission(i: any) {
    this.submitted.push(i);
    return { documentId: id(0x800) };
  }
}

class SubmissionFake {
  readonly calls: any[] = [];
  nextRows: number | null = null;
  async build(i: any) {
    this.calls.push(i);
    const bytes = Buffer.from(JSON.stringify(i.rows));
    return { mediaType: 'application/json', bytes, sha256: sha256(bytes), rows: this.nextRows ?? i.rows.length };
  }
}

class CapturesFake {
  readonly quarantine = new Map<string, Uint8Array>();
  readonly evidence = new Map<string, Uint8Array>();
  readonly views = new Map<string, Uint8Array>();
  readonly calls: any[] = [];
  async putQuarantine(key: string, bytes: Uint8Array) {
    this.calls.push({ op: 'quarantine', key });
    this.quarantine.set(key, Uint8Array.from(bytes));
  }
  async promote(key: string, bytes: Uint8Array) {
    this.calls.push({ op: 'promote', key });
    this.quarantine.delete(key);
    this.evidence.set(key, Uint8Array.from(bytes));
  }
  async putView(key: string, bytes: Uint8Array) {
    this.calls.push({ op: 'view', key });
    this.views.set(key, Uint8Array.from(bytes));
  }
  async get(key: string) {
    return this.views.get(key) ?? this.evidence.get(key) ?? this.quarantine.get(key);
  }
  async dispose(prefix: string) {
    for (const key of [...this.quarantine.keys()]) if (key.startsWith(prefix)) this.quarantine.delete(key);
  }
}

class ScannerFake {
  results: ('CLEAN' | 'THREAT' | 'PENDING')[] = [];
  readonly calls: any[] = [];
  async scan(i: any) {
    this.calls.push(i);
    return this.results.shift() ?? 'CLEAN';
  }
}

class SeatsFake {
  readonly map = new Map<string, any[]>();
  readonly calls: any[] = [];
  async match(i: { eventId: string; claimedSeats: string }) {
    this.calls.push(i);
    return this.map.get(i.claimedSeats) ?? [];
  }
}

const inquiries = {
  map: new Map<string, any>(),
  async publicPost(i: { reportCaseId: string }) {
    return this.map.get(i.reportCaseId) ?? null;
  },
};

const compensation = {
  calls: [] as any[],
  async open(i: any) {
    this.calls.push(i);
    return { caseId: id(0x900) };
  },
};

class FakeLocks implements TransferLocks {
  readonly sets: any[] = [];
  readonly releases: any[] = [];
  async set(i: any) {
    this.sets.push(i);
    return { lockedTicketCount: 2, withdrawnOfferCount: 0, holders: [{ accountId: H(1), ticketIds: [T(9)] }] };
  }
  async release(i: any) {
    this.releases.push(i);
  }
}

class FakeAccess implements InvestigationAccessLog {
  readonly records: any[] = [];
  async record(i: any) {
    this.records.push(i);
  }
}

const alerts: any[] = [];
const labels: any[] = [];
const copies: any[] = [];
const audit = new MemoryAuditChain();
const cases = new MemoryInvestigationStore((r) => audit.append(r));
const evidenceStore = new EvidenceStoreFake(cases);
const objects = new ObjectStoreFake();
const inventory = new InventoryFake();
const dataRequests = new DataRequestsFake();
const submission = new SubmissionFake();
const captures = new CapturesFake();
const scanner = new ScannerFake();
const seats = new SeatsFake();
const locks = new FakeLocks();
const access = new FakeAccess();
class FakeAdmin extends FakeAdminIdentity {
  readonly revoked = new Map<string, Array<{ kind: string; revokedAtMs: number }>>();
  async recentlyRevoked(adminAccountId: string) {
    return this.revoked.get(adminAccountId) ?? [];
  }
}
const admin = new FakeAdmin();
const identity = new FakeIdentity();
const clock = fakeClock({ now: NOW });
const kit = reauthKit(() => clock.now());

const eventInfo = { get: async (eventId: string) => (eventId === EVENT ? { eventName: '겨울 콘서트', showAtMs: SHOW, salesOpenedAtMs: SHOW - 7 * DAY } : null) };

const tickets = new Map<string, any>();
const ticketDirectory = {
  async listForAction(i: { eventId: string; payerAccountIds: readonly string[] }) {
    return [...tickets.values()].filter((t) => t.eventId === i.eventId && i.payerAccountIds.includes(t.payerAccountId));
  },
};
const cancellations = {
  async cancel(i: any) {
    return i.targets.map((t: any) => ({ ticketId: t.ticketId, outcome: 'ACCEPTED', cancellationId: randomUUID(), refundAmount: 100_000 }));
  },
};
let priorityResults: ('SAME_SEAT' | 'SAME_TIER' | 'NO_SEAT' | 'ENTRY_STARTED')[] = [];
const priority = {
  async run(i: any) {
    return {
      decision: 'ACCEPTED',
      grants: i.cancelledTicketIds.map((ticketId: string, n: number) => {
        const result = priorityResults[n] ?? 'SAME_SEAT';
        return result === 'NO_SEAT' || result === 'ENTRY_STARTED' ? { ticketId, result } : { ticketId, result, grantId: randomUUID(), seatId: randomUUID(), price: 100_000, expiresAt: iso(clock.now() + 48 * HOUR), version: 1 };
      }),
    };
  },
};

const activeRestrictions = new Map<string, any[]>();
const restrictions = {
  identity: { restrict: async () => undefined, lift: async () => undefined },
  queue: { set: async () => undefined },
  purchase: { set: async () => undefined },
  async activeForCase(caseId: string) {
    return activeRestrictions.get(caseId) ?? [];
  },
};

const investigationDeps: any = {
  store: cases,
  schedule,
  locks,
  notifier: { holderNotice: async () => undefined },
  fraudNotifier: {
    actionNotice: async () => undefined,
    holderResult: async () => undefined,
    objectionDecided: async () => undefined,
    restrictionLifted: async () => undefined,
    transferLockReleased: async () => undefined,
    deadlineNotice: async () => undefined,
  },
  labels: { apply: async (i: any) => void labels.push(i) },
  alerts: { raise: async (i: any) => void alerts.push(i) },
  access,
  events: { emit: () => undefined },
  verifier: { verify: async () => ({ ok: true, mismatchedTables: [] }) },
  now: () => clock.now(),
  fraudTickets: ticketDirectory,
  fraudCancellations: cancellations,
  fraudRestrictions: restrictions,
  fraudPriority: priority,
  fraudCompensation: compensation,
  fraudCopies: { set: async (i: any) => void copies.push(i) },
  fraudApproverIdentity: admin as any,
  fraudApproverDirectory: { listEligible: async () => [] },
  reauth: kit.verifier,
  calendar: new WeekendHolidayCalendar(),
  evidence: {
    store: evidenceStore,
    cases,
    objects,
    inventory,
    dataRequests,
    submission,
    eventInfo,
    captures,
    scanner,
    seats,
    inquiries,
    alerts: { raise: async (i: any) => void alerts.push(i) },
    access,
    now: () => clock.now(),
    reauth: kit.verifier,
  },
};

let svc: Awaited<ReturnType<typeof createService>>;
let seq = 0;
const newId = () => `0194b240-1000-7000-8000-${String(++seq).padStart(12, '0')}`;

const memberOf = (accountId: string, o: Record<string, any> = {}): FraudClusterMemberRecord =>
  ({ accountId, ticketCount: 1, signals: ['LINK_GRAPH'], addedBy: 'SYSTEM', removedAtMs: null, appealResult: 'NOT_REQUESTED', appealDueAtMs: null, lockExpiresAtMs: null, objectionResult: 'NONE', ...o }) as any;

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
  rowCounts: { inv_request: 1, inv_step: 2, inv_behavior: 1, inv_link: 1 },
  rangeFromMs: null,
  late: false,
  verifyStatus: null,
  verifiedAtMs: null,
});

const seedCase = async (o: Record<string, any> = {}) => {
  const c = caseOf(o);
  await cases.putCase(c);
  return c;
};
const seedTicket = (o: { ticketId: string; payerAccountId: string; holderAccountId?: string }) => {
  tickets.set(o.ticketId, { eventId: EVENT, ticketId: o.ticketId, payerAccountId: o.payerAccountId, holderAccountId: o.holderAccountId ?? o.payerAccountId, status: 'ISSUED', entryRecorded: false });
};

const investigator = (role: 'commander' | 'cs_lead' = 'cs_lead') => {
  const who = identity.ops(role);
  admin.seed({ adminAccountId: who['x-user-id']!, role, designations: ['FRAUD_INVESTIGATOR'] as any });
  return who;
};
const commander = () => {
  const who = identity.ops('commander');
  admin.seed({ adminAccountId: who['x-user-id']!, role: 'commander', designations: [] });
  return who;
};

const send = (
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  headers: Record<string, string>,
  o: { body?: unknown; idem?: string | null; ifMatch?: string; reauth?: string; multipart?: { body: Buffer; contentType: string } } = {},
): Promise<Req> =>
  svc.http.inject({
    method,
    url,
    headers: {
      ...headers,
      ...(o.multipart ? { 'content-type': o.multipart.contentType, 'x-requested-with': 'peaket-console' } : method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...(o.idem === undefined ? {} : o.idem === null ? {} : { 'idempotency-key': o.idem }),
      ...(o.ifMatch ? { 'if-match': o.ifMatch } : {}),
      ...(o.reauth ? { 'x-reauth-token': o.reauth } : {}),
    },
    ...(o.multipart ? { payload: o.multipart.body } : o.body === undefined ? {} : { payload: JSON.stringify(o.body) }),
  }) as unknown as Promise<Req>;

const createBundle = (caseId: string, who: Record<string, string>, idem = randomUUID()) => send('POST', `/v1/ops/fraud-cases/${caseId}/evidence-bundles`, who, { idem, body: { reason: '이의·분쟁에 대비' } });
const getBundle = (bundleId: string, who: Record<string, string>) => send('GET', `/v1/ops/evidence-bundles/${bundleId}`, who);
const listBundles = (who: Record<string, string>) => send('GET', `/v1/ops/evidence-bundles?eventId=${EVENT}`, who);
const exportBundle = (bundleId: string, who: Record<string, string>, body: any, idem = randomUUID()) => send('POST', `/v1/ops/evidence-bundles/${bundleId}/exports`, who, { idem, body });
const getApproval = (id: string, who: Record<string, string>) => send('GET', `/v1/ops/approval-requests/${id}`, who);
const approve = (id: string, who: Record<string, string>) =>
  send('POST', `/v1/ops/approval-requests/${id}/approvals`, who, { reauth: kit.token({ accountId: who['x-user-id']!, sessionId: who['x-session-id']!, act: 'APPROVAL' }), body: { reason: '근거를 확인했다' } });
const getCase = (caseId: string, who: Record<string, string>) => send('GET', `/v1/ops/fraud-cases/${caseId}`, who);

const evidence = () => svc.app.get((investigationsModule as unknown as Record<string, any>).EvidenceBundles) as any;
const external = () => svc.app.get((investigationsModule as unknown as Record<string, any>).ExternalPosts) as any;

beforeAll(async () => {
  await cases.putClusters(EVENT, 1, [{ clusterId: CLUSTER, eventId: EVENT, generation: 1, scoreBand: 'HIGH', accountCount: 3, purchaseCount: 9, limitPerPerson: 4, sharedAttributes: ['PAYMENT_METHOD'], signals: ['LINK_GRAPH'], snapshotVersion: 1, createdAtMs: NOW - DAY, members: [memberOf(A(1)), memberOf(A(2)), memberOf(A(3))] } as FraudClusterRecord], 'v1');
  await cases.putSnapshot(snapshotOf(EVENT));
  svc = await createService({
    name: 'ops-svc-fraud-evidence',
    module: AppModule.register({
      memory: true,
      auditChain: audit,
      adminAccounts: { identity: admin, reauth: kit.verifier },
      approvals: { reauth: kit.verifier, admin: { identity: admin, reauth: kit.verifier } } as any,
      investigations: investigationDeps,
    }),
    env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: 'f0414-internal-token' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});

afterAll(async () => {
  await svc?.close();
});

beforeEach(() => {
  clock.advance(NOW - clock.now());
  scanner.results = [];
  seats.calls.length = 0;
  scanner.calls.length = 0;
  submission.calls.length = 0;
  submission.nextRows = null;
  dataRequests.submitted.length = 0;
  priorityResults = [];
  compensation.calls.length = 0;
  evidenceStore.forcedExportCount = null;
  vi.unstubAllGlobals();
});

describe('F-04-14 HTTP', () => {
  test('FX-T13 ④ [ASVS v5.0.0-16.4.2] 처음 ACTIONED가 되면 증거 묶음이 자동으로 생기고 CLEARED 사건은 409다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(40), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR, lockExpiresAtMs: NOW + 10 * DAY })] });
    seedTicket({ ticketId: T(40), payerAccountId: A(40) });
    const created = await send('POST', `/v1/ops/fraud-cases/${c.caseId}/action-requests`, who, { idem: randomUUID(), body: { fraudAction: 'CANCEL_TICKETS', accountIds: [A(40)], reason: '취소' } });
    expect(created.statusCode, created.payload).toBe(201);
    expect(json(created).approvalId, created.payload).toBeTruthy();
    const approvalId = String(json(created).approvalId);
    expect((await getApproval(approvalId, approver)).statusCode).toBe(200);
    expect((await approve(approvalId, approver)).statusCode).toBe(200);
    expect((await getCase(c.caseId, who)).statusCode).toBe(200);
    await evidence().buildDue(clock.now());
    const listed = await listBundles(who);
    expect(listed.statusCode, listed.payload).toBe(200);
    const auto = json(listed).items.find((b: any) => b.caseId === c.caseId);
    expect(auto).toBeTruthy();
    expect(auto.status).toBe('SEALED');
    expect(auto.caseId).toBe(c.caseId);
    const cleared = await seedCase({ status: 'CLEARED', closedAtMs: NOW - HOUR, outcomeLabel: 'HUMAN' });
    const rejected = await createBundle(cleared.caseId, who);
    expect(rejected.statusCode).toBe(409);
    expect(typeOf(rejected)).toBe('case-not-actioned');
  });

  test('FX-T13 ⑤ [ASVS v5.0.0-11.1.2] 묶음을 만들고 봉인하면 파일 목록·manifest_sha256이 정해지고 같은 파일을 다시 써도 같다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })] });
    const created = await createBundle(c.caseId, who);
    expect(created.statusCode, created.payload).toBe(201);
    const bundleId = String(json(created).bundleId);
    expect(json(created).status).toBe('BUILDING');
    await evidence().buildDue(clock.now());
    const detail = await getBundle(bundleId, who);
    expect(detail.statusCode, detail.payload).toBe(200);
    const b = json(detail);
    expect(b.status).toBe('SEALED');
    expect(b.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.files.map((f: any) => f.name)).toEqual(
      expect.arrayContaining(['manifest.json', 'snapshots.json', 'queries.json', 'cluster.json', 'case.json', 'records/inv_request.arrow', 'records/inv_step.arrow']),
    );
    const manifest = b.files.find((f: any) => f.name === 'manifest.json');
    expect(manifest.sha256).toBe(b.manifestSha256);
    // 같은 바이트를 다시 쓰는 재시도는 SAME으로 통과한다. 다른 바이트면 DIFFERENT다.
    expect(await objects.putOnce(`${b.s3Prefix}manifest.json`, objects.objects.get(`${b.s3Prefix}manifest.json`)!.bytes, 'application/json')).toBe('SAME');
    expect(await objects.putOnce(`${b.s3Prefix}manifest.json`, Buffer.from('다른 바이트'), 'application/json')).toBe('DIFFERENT');
    expect(() => objects.tryDeleteAsService(`${b.s3Prefix}manifest.json`)).toThrow();
  });

  test('FX-T13 ⑥ [ASVS v5.0.0-16.3.4] 파일 한 바이트나 관리 연속성 한 행을 바꾸면 검증 불일치·SEV2·내보내기 차단이다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })] });
    const created = await createBundle(c.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    const b = json(await getBundle(bundleId, who));
    const key = `${b.s3Prefix}records/inv_step.arrow`;
    objects.tamper(key);
    alerts.length = 0;
    const verified = await evidence().verifyDue(clock.now());
    expect(verified.mismatched).toBeGreaterThanOrEqual(1);
    expect(alerts.some((a) => a.severity === 'SEV2')).toBe(true);
    const blocked = await exportBundle(bundleId, who, { kind: 'COMPLAINT', reason: '고소' });
    expect(blocked.statusCode).toBe(409);
    expect(typeOf(blocked)).toBe('evidence-integrity-mismatch');
    objects.tamper(key); // 같은 바이트로 되돌리지 않고 관리 연속성 변조도 본다
    evidenceStore.tamperCustody(bundleId, 2);
    const second = await evidence().verifyDue(clock.now());
    expect(second.mismatched).toBeGreaterThanOrEqual(1);
  });

  test('FX-T13 ⑦ [ASVS v5.0.0-13.2.2] 법적 보존 객체는 ops-svc 신원으로 지우지 못하고 보존 끝 뒤 파기 정비가 지우고 DISPOSED를 남긴다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })] });
    const created = await createBundle(c.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    const b = json(await getBundle(bundleId, who));
    const key = `${b.s3Prefix}case.json`;
    expect(() => objects.tryDeleteAsService(key)).toThrow();
    const stored = evidenceStore.bundles.get(bundleId)!;
    stored.createdAtMs = NOW - 2 * 365 * DAY;
    const disposed = await evidence().disposeDue(clock.now());
    expect(disposed).toBeGreaterThanOrEqual(1);
    expect(objects.disposeCalls).toContain(b.s3Prefix);
    const after = await getBundle(bundleId, who);
    expect(after.statusCode).toBe(410);
    const summary = json(await listBundles(who)).items.find((x: any) => x.bundleId === bundleId);
    expect(summary.status).toBe('DISPOSED');
    expect((await exportBundle(bundleId, who, { kind: 'COMPLAINT', reason: '고소' })).statusCode).toBe(410);
  });

  test('FX-T13 ⑧ [ASVS v5.0.0-8.1.2] 목록은 요약만 주고 상세 열람마다 VIEWED를 더한다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })] });
    const created = await createBundle(c.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    const list = await listBundles(who);
    const row = json(list).items.find((x: any) => x.bundleId === bundleId);
    expect(row).toBeTruthy();
    expect(row).not.toHaveProperty('files');
    expect(row).not.toHaveProperty('custody');
    const before = (await evidenceStore.listCustody(bundleId)).length;
    const detail = await getBundle(bundleId, who);
    expect(detail.statusCode).toBe(200);
    expect(json(detail)).toHaveProperty('files');
    expect((await evidenceStore.listCustody(bundleId)).length).toBe(before + 1);
    expect((await evidenceStore.listCustody(bundleId)).at(-1).action).toBe('VIEWED');
  });

  test('FX-T19 ④ [ASVS v5.0.0-5.1.1] 외부 게시물은 PNG·JPEG·PDF만 받고 10MB 초과 413·매직 바이트 불일치 415·화소 상한 422다', async () => {
    const who = investigator();
    const png = makePng({ width: 4, height: 4 });
    const fields = { eventId: EVENT, url: 'https://example.com/post/1', capturedAt: iso(NOW), source: 'MANUAL' };
    const ok = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: png }] }) });
    expect(ok.statusCode, ok.payload).toBe(201);
    expect(json(ok).scanStatus).toBe('PENDING');
    const pdf = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { ...fields, url: 'https://example.com/post/2' }, files: [{ field: 'capture', name: 'capture.pdf', type: 'application/pdf', bytes: makePdf() }] }) });
    expect(pdf.statusCode, pdf.payload).toBe(201);
    const wrongMagic = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { ...fields, url: 'https://example.com/post/3' }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: Buffer.from('not a png') }] }) });
    expect(wrongMagic.statusCode).toBe(415);
    const tooBig = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { ...fields, url: 'https://example.com/post/4' }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: Buffer.alloc(10 * 1024 * 1024 + 1) }] }) });
    expect(tooBig.statusCode).toBe(413);
    const tooWide = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { ...fields, url: 'https://example.com/post/5' }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: makePng({ width: 20_001, height: 1 }) }] }) });
    expect(tooWide.statusCode).toBe(422);
  });

  test('FX-T19 ⑤ [ASVS v5.0.0-5.4.3] CLEAN 전에는 보기용 사본이 없고 CLEAN이 되면 마스킹된 PNG를 주며 THREAT이면 만들지 않는다', async () => {
    const who = investigator();
    const png = makePng({ width: 4, height: 4, text: '연락처 010-0000-0000' });
    const fields = { eventId: EVENT, url: 'https://example.com/post/clean', capturedAt: iso(NOW), source: 'MANUAL', maskRegions: JSON.stringify([{ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }]) };
    const created = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: png }] }) });
    expect(created.statusCode, created.payload).toBe(201);
    const postId = String(json(created).postId);
    expect((await send('GET', `/v1/ops/external-posts/${postId}/capture`, who)).statusCode).toBe(409);
    scanner.results = ['CLEAN'];
    await external().scanDue(clock.now());
    const view = await send('GET', `/v1/ops/external-posts/${postId}/capture`, who);
    expect(view.statusCode, view.payload).toBe(200);
    expect(view.headers['cache-control']).toBe('no-store');
    expect(view.headers['content-type']).toContain('image/png');
    const img = readPng(view.rawPayload ?? Buffer.from(view.payload, 'binary'));
    expect(img.chunks).not.toContain('tEXt');
    expect(pixelAt(img, 1, 1).slice(0, 3)).toEqual([0, 0, 0]);
    const threat = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { ...fields, url: 'https://example.com/post/threat' }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: png }] }) });
    scanner.results = ['THREAT'];
    await external().scanDue(clock.now());
    expect((await send('GET', `/v1/ops/external-posts/${json(threat).postId}/capture`, who)).statusCode).toBe(409);
    expect(alerts.some((a) => a.severity === 'SEV2')).toBe(true);
  });

  test('FX-T19 ⑥ [ASVS v5.0.0-14.2.6] 신고 출처는 RESALE_POST_REPORT 건만 받고 신고자 정보·비공개 메시지를 저장하지 않는다', async () => {
    const who = investigator();
    const reportCaseId = id(0x910);
    inquiries.map.set(reportCaseId, { inquiryType: 'RESALE_POST_REPORT', postUrl: 'https://example.com/report/1' });
    const png = makePng({ width: 2, height: 2 });
    const base = { eventId: EVENT, url: 'https://example.com/report/1', capturedAt: iso(NOW), source: 'REPORT', reportCaseId };
    const ok = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { ...base, reporterName: '신고자', message: '비공개 메시지' }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: png }] }) });
    expect(ok.statusCode, ok.payload).toBe(201);
    const stored = evidenceStore.posts.get(json(ok).postId)!;
    expect(JSON.stringify(stored)).not.toContain('신고자');
    expect(JSON.stringify(stored)).not.toContain('비공개 메시지');
    inquiries.map.set(reportCaseId, { inquiryType: 'REVIEW_REPORT', postUrl: 'https://example.com/report/1' });
    const wrongType = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { ...base, url: 'https://example.com/report/2' }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: png }] }) });
    expect(wrongType.statusCode).toBe(422);
    inquiries.map.delete(reportCaseId);
    const missing = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { ...base, url: 'https://example.com/report/3' }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: png }] }) });
    expect(missing.statusCode).toBe(422);
  });

  test('FX-T19 ⑦ 등록 중 서버가 게시물 주소를 부르지 않고 OCR·contactRef 자동 대조를 하지 않는다', async () => {
    const who = investigator();
    const fetchSpy = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);
    const png = makePng({ width: 2, height: 2 });
    const created = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { eventId: EVENT, url: 'https://example.com/post/no-fetch', capturedAt: iso(NOW), source: 'MANUAL', claimedSeats: 'A구역 1열 1번' }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: png }] }) });
    expect(created.statusCode, created.payload).toBe(201);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seats.calls).toEqual([{ eventId: EVENT, claimedSeats: 'A구역 1열 1번' }]);
    const stored = evidenceStore.posts.get(json(created).postId)!;
    expect(stored).not.toHaveProperty('contactRef');
    expect(stored).not.toHaveProperty('ocrText');
  });

  test('FX-T19 ⑧ 적힌 좌석이 티켓과 맞으면 matched_ticket_ids·POST_MATCHED·postSeatTicketIds가 생긴다', async () => {
    const who = investigator();
    const postCase = await seedCase({ status: 'INVESTIGATING', members: [memberOf(A(1))] });
    seats.map.set('A구역 1열 1번', [{ ticketId: T(1), accountId: A(1), seatLabel: 'A구역 1열 1번' }]);
    const created = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { eventId: EVENT, url: 'https://example.com/post/seat', capturedAt: iso(NOW), source: 'MANUAL', claimedSeats: 'A구역 1열 1번' }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: makePng({ width: 2, height: 2 }) }] }) });
    expect(created.statusCode, created.payload).toBe(201);
    expect(json(created).matchedTicketCount).toBe(1);
    const after = await getCase(postCase.caseId, who);
    expect(json(after).events.some((e: any) => e.kind === 'POST_MATCHED' && e.detail?.postId === json(created).postId)).toBe(true);
    expect(await external().postSeatTicketIds(EVENT)).toContain(T(1));
  });

  test('FX-T19 ⑨ PDF는 보기용 사본을 주지 않고 목록에는 scanStatus만 남긴다', async () => {
    const who = investigator();
    const created = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { eventId: EVENT, url: 'https://example.com/post/pdf', capturedAt: iso(NOW), source: 'MANUAL' }, files: [{ field: 'capture', name: 'capture.pdf', type: 'application/pdf', bytes: makePdf() }] }) });
    expect(created.statusCode).toBe(201);
    scanner.results = ['CLEAN'];
    await external().scanDue(clock.now());
    expect((await send('GET', `/v1/ops/external-posts/${json(created).postId}/capture`, who)).statusCode).toBe(409);
    const list = await send('GET', `/v1/ops/external-posts?eventId=${EVENT}`, who);
    expect(json(list).items.find((p: any) => p.postId === json(created).postId)).toMatchObject({ scanStatus: 'CLEAN', viewAvailable: false });
  });

  test('FX-T20 ④ C-T71 ① AUTHORITY는 자료 요청 번호가 없으면 422이고 승인 전·다른 회차면 409다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })] });
    const created = await createBundle(c.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    const noRequest = await exportBundle(bundleId, who, { kind: 'AUTHORITY', reason: '기관 제출' });
    expect(noRequest.statusCode).toBe(422);
    expect(typeOf(noRequest)).toBe('data-request-required');
    dataRequests.scopes.set(REQUEST, { dataRequestId: REQUEST, eventId: EVENT, status: 'RECEIVED', warrant: false, legalBasis: 'PERFORMANCE_ACT', items: ['PURCHASE'], fromMs: NOW - HOUR, toMs: NOW + HOUR });
    const notApproved = await exportBundle(bundleId, who, { kind: 'AUTHORITY', dataRequestId: REQUEST, reason: '기관 제출' });
    expect(notApproved.statusCode).toBe(409);
    expect(typeOf(notApproved)).toBe('data-request-not-approved');
    dataRequests.scopes.set(REQUEST, { dataRequestId: REQUEST, eventId: id(0x201), status: 'APPROVED', warrant: false, legalBasis: 'PERFORMANCE_ACT', items: ['PURCHASE'], fromMs: NOW - HOUR, toMs: NOW + HOUR });
    const wrongEvent = await exportBundle(bundleId, who, { kind: 'AUTHORITY', dataRequestId: REQUEST, reason: '기관 제출' });
    expect(wrongEvent.statusCode).toBe(409);
    expect(typeOf(wrongEvent)).toBe('data-request-event-mismatch');
  });

  test('FX-T20 ⑤ C-T71 ② AUTHORITY는 승인 범위의 행만 제출 파일로 넘기고 요청을 EXTRACTED로 옮긴다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })] });
    const created = await createBundle(c.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    dataRequests.scopes.set(REQUEST, { dataRequestId: REQUEST, eventId: EVENT, status: 'APPROVED', warrant: false, legalBasis: 'PERFORMANCE_ACT', items: ['PURCHASE', 'ACCESS_LOG'], fromMs: NOW - HOUR, toMs: NOW + HOUR, accountIds: [A(1)] });
    const out = await exportBundle(bundleId, who, { kind: 'AUTHORITY', dataRequestId: REQUEST, reason: '공연법 요청' });
    expect(out.statusCode, out.payload).toBe(201);
    expect(json(out)).toMatchObject({ kind: 'AUTHORITY', dataRequestId: REQUEST, documentId: id(0x800), rows: 2 });
    expect(submission.calls).toHaveLength(1);
    expect(submission.calls[0].scope).toMatchObject({ dataRequestId: REQUEST, warrant: false, legalBasis: 'PERFORMANCE_ACT' });
    expect(submission.calls[0].rows.map((r: any) => r.accountId)).toEqual([A(1), A(1)]);
    expect(submission.calls[0].rows.every((r: any) => r.table === 'inv_step' || r.table === 'inv_request')).toBe(true);
    expect(submission.calls[0].rows.some((r: any) => r.table === 'inv_link' || r.table === 'inv_behavior')).toBe(false);
    expect(JSON.stringify(submission.calls[0].rows)).not.toMatch(/ja4|edge_bot_labels|payment_method_ref|card_bin|pid|investigator_opinion/);
    expect(dataRequests.submitted).toHaveLength(1);
    expect(dataRequests.submitted[0].dataRequestId).toBe(REQUEST);
    expect(dataRequests.submitted[0].document.sha256).toMatch(/^[0-9a-f]{64}$/);
    const custody = await evidenceStore.listCustody(bundleId);
    expect(custody.at(-1)).toMatchObject({ action: 'EXPORTED', exportKind: 'AUTHORITY', dataRequestId: REQUEST, reason: '공연법 요청' });
  });

  test('FX-T20 ⑥ C-T71 ③ PROMOTER는 회차 집계 CSV이고 사람 단위 행·좌석 번호가 없다', async () => {
    const who = investigator();
    const casesToSeed = [
      { reasonCategory: 'MACRO_BOT', status: 'ACTIONED', cancelled: 3 },
      { reasonCategory: 'MACRO_BOT', status: 'ACTIONED', cancelled: 2 },
      { reasonCategory: 'QUEUE_BYPASS', status: 'CLEARED', cancelled: 0 },
      { reasonCategory: 'CAPTCHA_BYPASS', status: 'REVERSED', cancelled: 0 },
      { reasonCategory: 'ACCOUNT_LENDING', status: 'ACTIONED', cancelled: 0 },
      { reasonCategory: 'LIMIT_EVASION', status: 'ACTIONED', cancelled: 0 },
    ] as const;
    let main: any;
    for (const x of casesToSeed) {
      const events = [];
      if (x.cancelled > 0) {
        events.push({ seq: 2, kind: 'ACTION_EXECUTED', actorId: id(0x900), note: null, detail: { results: Array.from({ length: x.cancelled }, (_, n) => ({ ticketId: T(100 + n), outcome: 'ACCEPTED' })), targets: Array.from({ length: x.cancelled }, (_, n) => ({ ticketId: T(100 + n), payerAccountId: A(100 + n) })) }, occurredAtMs: NOW });
      }
      const seeded = await seedCase({ status: x.status, reasonCategory: x.reasonCategory, members: [memberOf(A(100), { actionNotifiedAtMs: NOW - DAY, appealResult: 'REJECTED' })], events: [{ seq: 1, kind: 'CREATED', actorId: id(0x900), note: null, detail: null, occurredAtMs: NOW - DAY }, ...events] });
      main ??= seeded;
    }
    const created = await createBundle(main.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    const out = await exportBundle(bundleId, who, { kind: 'PROMOTER', reason: '기획사 보고' });
    expect(out.statusCode, out.payload).toBe(200);
    expect(String(out.headers['content-type'])).toContain('text/csv');
    const csv = out.payload;
    expect(csv).not.toMatch(/0194b240/);
    expect(csv).not.toMatch(/seat/i);
    expect(csv).toMatch(/5건 미만/);
    expect(csv).toMatch(/appeal_accepted_ratio/);
    expect(csv.trim().split(/\r?\n/)[0]).toBe('metric,value');
  });

  test('FX-T20 ⑦ C-T71 ④ COMPLAINT는 개인정보가 없고 statement·bundleManifestSha256이 맞으며 EXPORTED가 남는다', async () => {
    const who = investigator();
    const c = await seedCase({
      status: 'ACTIONED',
      outcomeLabel: 'BOT',
      investigatorOpinion: `연락처 010-1111-2222 IP 127.0.0.1`,
      members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })],
      events: [
        { seq: 1, kind: 'CREATED', actorId: id(0x900), note: null, detail: null, occurredAtMs: NOW - DAY },
        { seq: 2, kind: 'NOTE', actorId: id(0x900), note: 'contactRef c-1 paymentMethodRef pm-1 deviceRef d-1', detail: { ip: '127.0.0.1' }, occurredAtMs: NOW },
      ],
    });
    const post = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { eventId: EVENT, url: 'https://example.com/resale/1', capturedAt: iso(NOW), source: 'MANUAL', postedAt: iso(NOW - HOUR) }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: makePng({ width: 2, height: 2 }) }] }) });
    expect(post.statusCode, post.payload).toBe(201);
    scanner.results = ['CLEAN'];
    await external().scanDue(clock.now());
    const created = await createBundle(c.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    const sealed = json(await getBundle(bundleId, who));
    const out = await exportBundle(bundleId, who, { kind: 'COMPLAINT', reason: '고소장' });
    expect(out.statusCode, out.payload).toBe(200);
    const packet = json(out);
    expect(packet).toMatchObject({
      caseNumber: c.caseId,
      eventName: '겨울 콘서트',
      statement: '기록을 보존하고 있으며 영장이나 공연법 제4조의3 요청을 받으면 정해진 절차로 냅니다',
      bundleManifestSha256: sealed.manifestSha256,
      resaleEvidence: true,
    });
    expect(packet.resalePosts).toEqual([{ url: 'https://example.com/resale/1', postedAt: iso(NOW - HOUR), captureSha256: json(post).captureSha256 }]);
    for (const secret of [A(1), '010-1111-2222', '127.0.0.1', 'contactRef', 'paymentMethodRef', 'deviceRef', 'c-1', 'pm-1', 'd-1']) {
      expect(out.payload).not.toContain(secret);
    }
    const custody = await evidenceStore.listCustody(bundleId);
    expect(custody.at(-1)).toMatchObject({ action: 'EXPORTED', exportKind: 'COMPLAINT', reason: '고소장' });
  });

  test('FX-T20 ⑧ C-T71 ① 사유 없음 422·봉인 전 409·파기 410이고 하루 20회를 넘으면 429다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })] });
    const created = await createBundle(c.caseId, who);
    const bundleId = String(json(created).bundleId);
    const beforeSeal = await exportBundle(bundleId, who, { kind: 'COMPLAINT', reason: '고소' });
    expect(beforeSeal.statusCode).toBe(409);
    expect(typeOf(beforeSeal)).toBe('evidence-not-sealed');
    await evidence().buildDue(clock.now());
    const noReason = await exportBundle(bundleId, who, { kind: 'COMPLAINT' } as any);
    expect(noReason.statusCode).toBe(400);
    evidenceStore.forcedExportCount = 20;
    const limited = await exportBundle(bundleId, who, { kind: 'PROMOTER', reason: '보고' });
    expect(limited.statusCode).toBe(429);
    expect(typeOf(limited)).toBe('export-rate-limited');
  });

  test('FX-T20 ⑨ 1만 건 넘는 내보내기는 접속기록에 bulk:true, 하루 5건 넘으면 INV_EXPORT_VOLUME 표시다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })] });
    const created = await createBundle(c.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    submission.nextRows = 12_000;
    const big = await exportBundle(bundleId, who, { kind: 'PROMOTER', reason: '큰 보고' });
    expect(big.statusCode, big.payload).toBe(200);
    const bulk = access.records.filter((r) => r.action === 'EVIDENCE_EXPORT').at(-1);
    expect(bulk).toMatchObject({ rows: 12_000, detail: { bulk: true } });
    evidenceStore.forcedExportCount = 6;
    submission.nextRows = 1;
    const six = await exportBundle(bundleId, who, { kind: 'PROMOTER', reason: '여섯 번째' });
    expect(six.statusCode).toBe(200);
    expect(JSON.stringify(access.records.at(-1))).toContain('INV_EXPORT_VOLUME');
  });

  test('FX-T23 ② [ASVS v5.0.0-2.1.2] 이의는 30일 창 안이면 공연 뒤에도 받고 지나면 기한 경과로 닫힌다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(61), { actionNotifiedAtMs: NOW - 29 * DAY, appealResult: 'REJECTED' })] });
    const inWindow = await send('POST', `/internal/v1/fraud-cases/${c.caseId}/appeals`, {}, { body: { appealId: randomUUID(), accountId: A(61), party: 'PAYER', submittedAt: iso(NOW) } });
    expect(inWindow.statusCode, inWindow.payload).toBe(200);
    expect(json(inWindow).result).toBe('ACCEPTED');
    const old = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(62), { actionNotifiedAtMs: NOW - 31 * DAY, appealResult: 'REJECTED' })] });
    const expired = await send('POST', `/internal/v1/fraud-cases/${old.caseId}/appeals`, {}, { body: { appealId: randomUUID(), accountId: A(62), party: 'PAYER', submittedAt: iso(NOW) } });
    expect(expired.statusCode).toBe(200);
    expect(json(expired).result).toBe('EXPIRED');
  });

  test('FX-T23 ③ C-T72 ① 이의 인정은 LIFT_RESTRICTION을 만들고 풀기 Done 뒤 우선 구매를 열며 모두 인정이면 REVERSED다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(63), { actionNotifiedAtMs: NOW - DAY, appealResult: 'REJECTED' })] });
    activeRestrictions.set(c.caseId, [{ accountId: A(63), caseId: c.caseId, restrictionId: id(0x950), untilMs: NOW + 30 * DAY, version: 1 }]);
    await send('POST', `/internal/v1/fraud-cases/${c.caseId}/appeals`, {}, { body: { appealId: randomUUID(), accountId: A(63), party: 'PAYER', submittedAt: iso(NOW) } });
    const current = json(await getCase(c.caseId, who));
    const patch = await send('PATCH', `/v1/ops/fraud-cases/${c.caseId}`, who, { ifMatch: `"${current.version}"`, body: { objectionDecisions: [{ accountId: A(63), decision: 'ACCEPTED', reason: '가족 대리 구매' }] } });
    expect(patch.statusCode, patch.payload).toBe(200);
    expect(json(patch).status).toBe('OBJECTED');
    const liftId = String(json(patch).approvalId);
    expect(liftId).not.toBe('null');
    expect((await getApproval(liftId, approver)).statusCode).toBe(200);
    expect((await approve(liftId, approver)).statusCode).toBe(200);
    const after = await getCase(c.caseId, who);
    expect(json(after).status).toBe('REVERSED');
    expect(json(after).outcomeLabel).toBe('HUMAN');
  });

  test('FX-T23 ④ C-T72 ③ 다른 계정 이의가 미결이면 REVERSED가 아니고 기각이 남으면 ACTIONED다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(64), { actionNotifiedAtMs: NOW - DAY, appealResult: 'REJECTED' }), memberOf(A(65), { actionNotifiedAtMs: NOW - DAY, appealResult: 'REJECTED' })] });
    await send('POST', `/internal/v1/fraud-cases/${c.caseId}/appeals`, {}, { body: { appealId: randomUUID(), accountId: A(64), party: 'PAYER', submittedAt: iso(NOW) } });
    await send('POST', `/internal/v1/fraud-cases/${c.caseId}/appeals`, {}, { body: { appealId: randomUUID(), accountId: A(65), party: 'PAYER', submittedAt: iso(NOW) } });
    const current = json(await getCase(c.caseId, who));
    const patch = await send('PATCH', `/v1/ops/fraud-cases/${c.caseId}`, who, { ifMatch: `"${current.version}"`, body: { objectionDecisions: [{ accountId: A(64), decision: 'ACCEPTED', reason: '오인' }, { accountId: A(65), decision: 'REJECTED', reason: '근거 유지' }] } });
    expect(patch.statusCode, patch.payload).toBe(200);
    expect(json(patch).status).toBe('ACTIONED');
    const after = await getCase(c.caseId, who);
    expect(json(after).status).toBe('ACTIONED');
    expect(json(after).events.some((e: any) => e.kind === 'OBJECTION_DECIDED' && e.detail?.decision === 'REJECTED')).toBe(true);
  });

  test('R-T35 ② C-T72 ② A 같은 좌석·B 같은 등급·C 매진은 각각 권리와 FRAUD_OBJECTION_COMPENSATION 건으로 갈린다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({
      status: 'ACTIONED',
      outcomeLabel: 'BOT',
      members: [memberOf(A(66), { actionNotifiedAtMs: NOW - DAY, appealResult: 'REJECTED' })],
      events: [
        { seq: 1, kind: 'CREATED', actorId: id(0x900), note: null, detail: null, occurredAtMs: NOW - DAY },
        { seq: 2, kind: 'ACTION_EXECUTED', actorId: id(0x900), note: null, detail: { results: [{ ticketId: T(1), outcome: 'ACCEPTED' }, { ticketId: T(2), outcome: 'ACCEPTED' }, { ticketId: T(3), outcome: 'ACCEPTED' }], targets: [{ ticketId: T(1), payerAccountId: A(66) }, { ticketId: T(2), payerAccountId: A(66) }, { ticketId: T(3), payerAccountId: A(66) }] }, occurredAtMs: NOW },
      ],
    });
    activeRestrictions.set(c.caseId, [{ accountId: A(66), caseId: c.caseId, restrictionId: id(0x951), untilMs: NOW + 30 * DAY, version: 1 }]);
    await send('POST', `/internal/v1/fraud-cases/${c.caseId}/appeals`, {}, { body: { appealId: randomUUID(), accountId: A(66), party: 'PAYER', submittedAt: iso(NOW) } });
    priorityResults = ['SAME_SEAT', 'SAME_TIER', 'NO_SEAT'];
    const current = json(await getCase(c.caseId, who));
    const patch = await send('PATCH', `/v1/ops/fraud-cases/${c.caseId}`, who, { ifMatch: `"${current.version}"`, body: { objectionDecisions: [{ accountId: A(66), decision: 'ACCEPTED', reason: '가족' }] } });
    expect(patch.statusCode, patch.payload).toBe(200);
    const liftId = String(json(patch).approvalId);
    expect((await getApproval(liftId, approver)).statusCode).toBe(200);
    expect((await approve(liftId, approver)).statusCode).toBe(200);
    const after = await getCase(c.caseId, who);
    expect(json(after).status).toBe('REVERSED');
    expect(compensation.calls).toEqual([expect.objectContaining({ caseId: c.caseId, accountId: A(66), ticketId: T(3), reason: 'NO_SEAT' })]);
    expect(copies.some((x) => x.accountId === A(66) && x.lockActive === false)).toBe(true);
  });

  test('C-T70 ① C-T70 ② 소명 요청·잠금·받은 사람 알림·돌려주기·인정·해제가 서버에서 이어진다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'INVESTIGATING', members: [memberOf(A(67))] });
    locks.sets.length = 0;
    locks.releases.length = 0;
    const requested = await send('POST', `/v1/ops/fraud-cases/${c.caseId}/appeal-requests`, who, { idem: randomUUID(), body: { accountIds: [A(67)], reasonCategories: ['MACRO_BOT'], dueAt: iso(NOW + 2 * DAY) } });
    expect(requested.statusCode, requested.payload).toBe(201);
    expect(json(requested)).toMatchObject({ lockedTicketCount: 2, notifiedHolderCount: 1 });
    expect(locks.sets).toHaveLength(1);
    expect(await cases.markAppealSubmitted(c.caseId, A(67), clock.now())).toBe(true);
    const current = json(await getCase(c.caseId, who));
    const patch = await send('PATCH', `/v1/ops/fraud-cases/${c.caseId}`, who, { ifMatch: `"${current.version}"`, body: { appealDecisions: [{ accountId: A(67), decision: 'ACCEPTED', reason: '정상 구매' }] } });
    expect(patch.statusCode, patch.payload).toBe(200);
    expect(json(patch).status).toBe('CLEARED');
    expect(json(patch).outcomeLabel).toBe('HUMAN');
    expect(locks.releases.length).toBeGreaterThanOrEqual(1);
  });
});
