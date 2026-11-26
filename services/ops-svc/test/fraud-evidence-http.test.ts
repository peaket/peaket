// F-04-14 증거 묶음·내보내기·외부 게시물 HTTP 시험(동결 로컬, LCH-290·LCH-300).
// 정본: docs/features/forensic-replay.md §6.7.6~§6.7.8, docs/features/control-tower.md §9,
// docs/features/transfer-refund.md §7.4, docs/infra.md §9, docs/api/openapi.yaml 태그 investigations.
// [ASVS v5.0.0-5.1.1] 업로드 형식·크기, [ASVS v5.0.0-5.2.2] 확장자·매직, [ASVS v5.0.0-5.4.3] 악성 코드 검사,
// [ASVS v5.0.0-8.1.2] 목록 요약·상세 열람, [ASVS v5.0.0-13.2.2] 법적 보존·파기 신원,
// [ASVS v5.0.0-14.2.6] 최소화, [ASVS v5.0.0-16.3.4] 실패 기록, [ASVS v5.0.0-16.4.2] 관리 연속성.
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
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
const EVENT_BULK = id(0x210);
const EVENT_COMPLAINT = id(0x220);
const EVENT_NO_POST = id(0x221);
const EVENT_DISPOSE = id(0x222);
const CLUSTER = id(0x300);
const CASE = id(0x400);
const REQUEST = id(0x700);

const schedule: SaleScheduleSource = {
  get: async (eventId: string) =>
    eventId === EVENT || eventId === EVENT_COMPLAINT || eventId === EVENT_NO_POST || eventId === EVENT_DISPOSE
      ? { opensAtMs: SHOW - 7 * DAY, saleEndsAtMs: SALE_ENDS, entryOpensAtMs: ENTRY, entryClosedAtMs: ENTRY + 3 * HOUR }
      : undefined,
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
  failNextPutBundle = false;
  failNextCustody = false;
  failNextDisposeUpdate = false;

  constructor(private readonly cases: MemoryInvestigationStore) {}

  async putBundle(b: any, c: any, o: any = {}) {
    if (this.failNextPutBundle) {
      this.failNextPutBundle = false;
      throw new Error('evidence store down');
    }
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
  /** 묶음 갱신과 관리 연속성 행 추가를 한 단위로 본다(IR-06). 실패를 주입하면 둘 다 바뀌지 않는다. */
  async updateBundleWithCustody(b: any, c: any, expectedStatus?: readonly string[], o: any = {}) {
    const cur = this.bundles.get(b.bundleId);
    if (!cur) return false;
    if (expectedStatus && !expectedStatus.includes(cur.status)) return false;
    if (o.idem) {
      const key = `${o.idem.accountRef}:${o.idem.operation}:${o.idem.key}`;
      if (this.idem.has(key)) return true;
    }
    if (this.failNextCustody) {
      this.failNextCustody = false;
      throw new Error('custody append failed');
    }
    if (this.failNextDisposeUpdate && b.status === 'DISPOSED') {
      this.failNextDisposeUpdate = false;
      throw new Error('dispose update failed');
    }
    const row = this.#row(b.bundleId, c);
    this.bundles.set(b.bundleId, { ...b, files: [...(b.files ?? [])] });
    (this.custody.get(b.bundleId) ?? this.custody.set(b.bundleId, []).get(b.bundleId)!).push(row);
    if (o.idem) this.idem.set(`${o.idem.accountRef}:${o.idem.operation}:${o.idem.key}`, o.result ?? b);
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
    return [...this.bundles.values()].filter((b) => {
      if (b.status !== 'SEALED') return false;
      try {
        return domain.disposeAfterMs({ createdAtMs: b.createdAtMs, holdReason: b.holdReason, holdEndedAtMs: b.holdEndedAtMs }) <= nowMs;
      } catch {
        return false;
      }
    });
  }
  async putExport(e: any, _c?: any, o: any = {}) {
    if (o.idem) {
      const key = `${o.idem.accountRef}:${o.idem.operation}:${o.idem.key}`;
      if (this.idem.has(key)) return;
      this.idem.set(key, o.result ?? e);
    }
    this.exports.push({ ...e });
  }
  async exportCountSince(actorId: string, sinceMs: number) {
    if (this.forcedExportCount !== null) return this.forcedExportCount;
    return this.exports.filter((e) => e.actorId === actorId && e.createdAtMs >= sinceMs).length;
  }
  async listClosedCases(eventId: string) {
    const all: FraudCaseRecord[] = [];
    let cursor: string | undefined;
    for (;;) {
      const r = await this.cases.listCases({ eventId, status: ['ACTIONED', 'CLEARED', 'REVERSED'] as FraudCaseStatus[], limit: 1000, ...(cursor ? { cursor } : {}) });
      all.push(...r.items);
      if (r.nextCursor === null) return all;
      cursor = r.nextCursor;
    }
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
  restoreCustody(bundleId: string, seq: number, reason: string | null) {
    const row = this.custody.get(bundleId)?.find((r) => r.seq === seq);
    if (row) row.reason = reason;
  }
  custodyOf(bundleId: string) {
    return [...(this.custody.get(bundleId) ?? [])];
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
  nextPutResult: 'DIFFERENT' | null = null;
  async putOnce(key: string, bytes: Uint8Array, contentType: string) {
    if (this.nextPutResult !== null) {
      const result = this.nextPutResult;
      this.nextPutResult = null;
      return result;
    }
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
  readonly statuses = new Map<string, string>();
  async approvedScope(i: { dataRequestId: string; eventId: string }) {
    return this.scopes.get(i.dataRequestId) ?? null;
  }
  async attachSubmission(i: any) {
    this.submitted.push(i);
    this.statuses.set(i.dataRequestId, 'EXTRACTED');
    return { documentId: id(0x800), status: 'EXTRACTED' as const };
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
  readonly disposeCalls: string[] = [];
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
    this.disposeCalls.push(prefix);
    for (const key of [...this.quarantine.keys()]) if (key.startsWith(prefix)) this.quarantine.delete(key);
    for (const key of [...this.evidence.keys()]) if (key.startsWith(prefix)) this.evidence.delete(key);
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
const auditEvents: any[] = [];
const disposer = {
  calls: [] as string[],
  captureCalls: [] as string[],
  async dispose(prefix: string) {
    this.calls.push(prefix);
  },
  async disposeCapture(prefix: string) {
    this.captureCalls.push(prefix);
    for (const key of [...captures.quarantine.keys()]) if (key.startsWith(prefix)) captures.quarantine.delete(key);
    for (const key of [...captures.evidence.keys()]) if (key.startsWith(prefix)) captures.evidence.delete(key);
  },
};
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

const eventInfo = {
  get: async (eventId: string) =>
    eventId === EVENT || eventId === EVENT_COMPLAINT || eventId === EVENT_NO_POST || eventId === EVENT_DISPOSE
      ? { eventName: '겨울 콘서트', showAtMs: SHOW, salesOpenedAtMs: SHOW - 7 * DAY }
      : eventId === EVENT_BULK
        ? { eventName: '대량 콘서트', showAtMs: SHOW, salesOpenedAtMs: SHOW - 7 * DAY }
        : null,
};

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
let priorityOmitTicketId = false;
const priorityCalls: any[] = [];
const priority = {
  async run(i: any) {
    priorityCalls.push(i);
    return {
      decision: 'ACCEPTED',
      grants: i.cancelledTicketIds.map((ticketId: string, n: number) => {
        const result = priorityResults[n] ?? 'SAME_SEAT';
        return result === 'NO_SEAT' || result === 'ENTRY_STARTED'
          ? { ...(priorityOmitTicketId ? {} : { ticketId }), result }
          : { ...(priorityOmitTicketId ? {} : { ticketId }), result, grantId: randomUUID(), seatId: randomUUID(), price: 100_000, fee: 0, expiresAt: iso(clock.now() + 48 * HOUR), version: 1 };
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

const holderNotices: any[] = [];
const investigationDeps: any = {
  store: cases,
  schedule,
  locks,
  notifier: { holderNotice: async (i: any) => void holderNotices.push(i) },
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
    audit: { append: async (i: any) => void auditEvents.push(i) },
    disposer,
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
const seedClosedCases = async (n: number, eventId: string) => {
  let first: FraudCaseRecord | undefined;
  for (let i = 0; i < n; i += 1) {
    const c = caseOf({
      eventId,
      status: 'ACTIONED',
      outcomeLabel: 'BOT',
      members: [
        memberOf(A(1), { actionNotifiedAtMs: NOW - DAY, appealResult: 'ACCEPTED' }),
        memberOf(A(2), { actionNotifiedAtMs: NOW - DAY, appealResult: 'REJECTED' }),
      ],
    } as any);
    await cases.putCase(c);
    first ??= c;
  }
  return first!;
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
const holdChange = (bundleId: string, who: Record<string, string>, body: any, idem = randomUUID()) => send('POST', `/v1/ops/evidence-bundles/${bundleId}/hold-changes`, who, { idem, body });
const holdEndRequest = (bundleId: string, who: Record<string, string>, body: any, idem = randomUUID()) => send('POST', `/v1/ops/evidence-bundles/${bundleId}/hold-end-requests`, who, { idem, body });
const holdEndConfirm = (bundleId: string, who: Record<string, string>, reauth?: string, idem = randomUUID()) =>
  send('POST', `/v1/ops/evidence-bundles/${bundleId}/hold-end-confirmations`, who, { idem, ...(reauth ? { reauth } : {}) });
const getApproval = (id: string, who: Record<string, string>) => send('GET', `/v1/ops/approval-requests/${id}`, who);
const approve = (id: string, who: Record<string, string>) =>
  send('POST', `/v1/ops/approval-requests/${id}/approvals`, who, { reauth: kit.token({ accountId: who['x-user-id']!, sessionId: who['x-session-id']!, act: 'APPROVAL' }), body: { reason: '근거를 확인했다' } });
const getCase = (caseId: string, who: Record<string, string>) => send('GET', `/v1/ops/fraud-cases/${caseId}`, who);

const evidence = () => svc.app.get((investigationsModule as unknown as Record<string, any>).EvidenceBundles) as any;
const external = () => svc.app.get((investigationsModule as unknown as Record<string, any>).ExternalPosts) as any;

beforeAll(async () => {
  await cases.putClusters(EVENT, 1, [{ clusterId: CLUSTER, eventId: EVENT, generation: 1, scoreBand: 'HIGH', accountCount: 3, purchaseCount: 9, limitPerPerson: 4, sharedAttributes: ['PAYMENT_METHOD'], signals: ['LINK_GRAPH'], snapshotVersion: 1, createdAtMs: NOW - DAY, members: [memberOf(A(1)), memberOf(A(2)), memberOf(A(3))] } as FraudClusterRecord], 'v1');
  await cases.putSnapshot(snapshotOf(EVENT));
  await cases.putSnapshot(snapshotOf(EVENT_COMPLAINT));
  await cases.putSnapshot(snapshotOf(EVENT_NO_POST));
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

afterEach(() => {
  // 대량 PROMOTER 시험이 실패해도 10,001건이 뒤 시험의 1,000건 상한을 밀지 않게 한다.
  for (const [id, c] of cases.cases) if (c.eventId === EVENT_BULK) cases.cases.delete(id);
});

beforeEach(() => {
  clock.advance(NOW - clock.now());
  scanner.results = [];
  seats.calls.length = 0;
  scanner.calls.length = 0;
  submission.calls.length = 0;
  submission.nextRows = null;
  dataRequests.submitted.length = 0;
  dataRequests.statuses.clear();
  priorityResults = [];
  priorityCalls.length = 0;
  priorityOmitTicketId = false;
  compensation.calls.length = 0;
  holderNotices.length = 0;
  auditEvents.length = 0;
  disposer.calls.length = 0;
  disposer.captureCalls.length = 0;
  captures.disposeCalls.length = 0;
  evidenceStore.forcedExportCount = null;
  evidenceStore.failNextPutBundle = false;
  evidenceStore.failNextCustody = false;
  evidenceStore.failNextDisposeUpdate = false;
  objects.nextPutResult = null;
  objects.disposeCalls.length = 0;
  alerts.length = 0;
  captures.views.clear();
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

    // 자동 생성이 저장 실패로 막혀도 사건은 ACTIONED에 남고 NOTE를 남긴다. 다음 buildDue가 다시 만든다.
    const failed = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW - HOUR, members: [memberOf(A(41), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR })] });
    seedTicket({ ticketId: T(41), payerAccountId: A(41) });
    const created2 = await send('POST', `/v1/ops/fraud-cases/${failed.caseId}/action-requests`, who, { idem: randomUUID(), body: { fraudAction: 'CANCEL_TICKETS', accountIds: [A(41)], reason: '취소' } });
    const approval2 = String(json(created2).approvalId);
    expect((await getApproval(approval2, approver)).statusCode).toBe(200);
    evidenceStore.failNextPutBundle = true;
    expect((await approve(approval2, approver)).statusCode).toBe(200);
    const afterFail = json(await getCase(failed.caseId, who));
    expect(afterFail.status).toBe('ACTIONED');
    expect(afterFail.events.some((e: any) => e.kind === 'NOTE' && String(e.note ?? '').includes('EVIDENCE_CREATE_FAILED'))).toBe(true);
    await evidence().buildDue(clock.now());
    expect(json(await listBundles(who)).items.some((b: any) => b.caseId === failed.caseId)).toBe(true);

    for (const status of ['INVESTIGATING', 'APPEAL_PENDING', 'DECISION_PENDING'] as const) {
      const seeded = await seedCase({ status, members: [memberOf(A(42), { appealResult: status === 'INVESTIGATING' ? 'NOT_REQUESTED' : 'REJECTED' })] });
      const rejected = await createBundle(seeded.caseId, who);
      expect(rejected.statusCode).toBe(409);
      expect(typeOf(rejected)).toBe('case-not-actioned');
    }
    const cleared = await seedCase({ status: 'CLEARED', closedAtMs: NOW - HOUR, outcomeLabel: 'HUMAN' });
    const rejected = await createBundle(cleared.caseId, who);
    expect(rejected.statusCode).toBe(409);
    expect(typeOf(rejected)).toBe('case-not-actioned');
  });

  test('FX-T13 ⑤ [ASVS v5.0.0-11.1.2] 묶음을 만들고 봉인하면 파일 목록·manifest_sha256이 정해지고 같은 파일을 다시 써도 같다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', investigatorOpinion: '연락처 010-1111-2222 IP 127.0.0.1', members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })] });
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
    // 저장된 실제 바이트로 파일 해시와 목록 해시를 다시 계산한다.
    for (const f of b.files.filter((x: any) => x.name !== 'manifest.json')) {
      const bytes = objects.objects.get(`${b.s3Prefix}${f.name}`)!.bytes;
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.sha256);
      expect(bytes.length).toBe(f.sizeBytes);
    }
    const manifestBytes = objects.objects.get(`${b.s3Prefix}manifest.json`)!.bytes;
    expect(createHash('sha256').update(manifestBytes).digest('hex')).toBe(b.manifestSha256);
    const manifestJson = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
    expect(manifestJson.files).toHaveLength(b.files.length - 1);
    expect(Buffer.from(manifestBytes).toString('utf8')).toBe(canonicalize(manifestJson));
    const caseBytes = Buffer.from(objects.objects.get(`${b.s3Prefix}case.json`)!.bytes).toString('utf8');
    expect(caseBytes).not.toContain('010-1111-2222');
    expect(caseBytes).not.toContain('127.0.0.1');
    expect(caseBytes).not.toContain('investigatorOpinion');

    // 제품 build가 DIFFERENT를 만나면 봉인하지 않고, 다음 시도에서 정상 봉인한다.
    const d = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })] });
    const pending = await createBundle(d.caseId, who);
    const pendingId = String(json(pending).bundleId);
    objects.nextPutResult = 'DIFFERENT';
    await evidence().buildDue(clock.now());
    expect(json(await getBundle(pendingId, who)).status).toBe('BUILDING');
    await evidence().buildDue(clock.now());
    const sealedAgain = json(await getBundle(pendingId, who));
    expect(sealedAgain.status).toBe('SEALED');
    expect(sealedAgain.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(objects.disposeCalls).toHaveLength(0);
    expect([...objects.objects.values()].every((o) => o.legalHold)).toBe(true);
  });

  test('FX-T13 ⑥ [ASVS v5.0.0-16.3.4] 파일 한 바이트나 관리 연속성 한 행을 바꾸면 검증 불일치·SEV2·내보내기 차단이다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })] });
    const created = await createBundle(c.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    const b = json(await getBundle(bundleId, who));
    const key = `${b.s3Prefix}records/inv_step.arrow`;
    const original = Uint8Array.from(objects.objects.get(key)!.bytes);
    alerts.length = 0;
    objects.tamper(key);
    const verified = await evidence().verifyDue(clock.now());
    expect(verified.mismatched).toBe(1);
    expect(alerts.some((a) => a.severity === 'SEV2')).toBe(true);
    const blocked = await exportBundle(bundleId, who, { kind: 'COMPLAINT', reason: '고소' });
    expect(blocked.statusCode).toBe(409);
    expect(typeOf(blocked)).toBe('evidence-integrity-mismatch');

    // 객체를 원래 바이트로 되돌리면 다시 맞고, 관리 연속성만 깨면 그것만 잡는다.
    objects.objects.get(key)!.bytes = original;
    alerts.length = 0;
    expect(await evidence().verifyDue(clock.now())).toMatchObject({ mismatched: 0 });
    evidenceStore.tamperCustody(bundleId, 2);
    const second = await evidence().verifyDue(clock.now());
    expect(second.mismatched).toBe(1);
    expect(alerts.some((a) => a.severity === 'SEV2')).toBe(true);
    evidenceStore.restoreCustody(bundleId, 2, null);
  });

  test('FX-T13 ⑦ [ASVS v5.0.0-13.2.2] 법적 보존 객체는 ops-svc 신원으로 지우지 못하고 보존 끝 뒤 파기 정비가 지우고 DISPOSED를 남긴다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })] });
    const created = await createBundle(c.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    const b = json(await getBundle(bundleId, who));
    expect(objects.disposeCalls).toHaveLength(0);
    const before = await listBundles(who);
    expect(before.statusCode).toBe(200);
    expect((await exportBundle(bundleId, who, { kind: 'COMPLAINT', reason: '정상 내보내기' })).statusCode).toBe(200);
    expect(objects.disposeCalls).toHaveLength(0);
    const stored = evidenceStore.bundles.get(bundleId)!;
    stored.createdAtMs = NOW - 365 * DAY + HOUR;
    clock.advance(0);
    expect(await evidence().disposeDue(clock.now())).toBe(0);
    expect(objects.disposeCalls).toHaveLength(0);
    clock.advance(HOUR - 1);
    expect(await evidence().disposeDue(clock.now())).toBe(0);
    expect(objects.disposeCalls).toHaveLength(0);
    clock.advance(1);
    expect(await evidence().disposeDue(clock.now())).toBe(1);
    expect(disposer.calls).toContain(b.s3Prefix);
    expect(objects.disposeCalls).toHaveLength(0);
    const custody = await evidenceStore.listCustody(bundleId);
    expect(custody.at(-1)).toMatchObject({ action: 'DISPOSED', actorId: null });
    expect(custody.at(-1).reason).toBeTruthy();
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
    const viewedLog = access.records.find((r) => r.action === 'EVIDENCE' && r.caseId === c.caseId);
    expect(viewedLog).toMatchObject({ action: 'EVIDENCE', caseId: c.caseId });
    expect(viewedLog.rows).toBeGreaterThan(0);
  });

  test('FX-T13 ⑮ 보존 이유 변경은 OBJECTION에서만 되고 HOLD_CHANGED를 남긴다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })] });
    const created = await createBundle(c.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    const objection = await holdChange(bundleId, who, { holdReason: 'OBJECTION', basis: '되돌리기' });
    expect(objection.statusCode).toBe(400);
    expect(typeOf(objection)).toBe('invalid-body');
    const short = await holdChange(bundleId, who, { holdReason: 'DISPUTE', basis: '소송' });
    expect(short.statusCode).toBe(400);
    expect(typeOf(short)).toBe('invalid-body');
    const changed = await holdChange(bundleId, who, { holdReason: 'DISPUTE', basis: '민사 소송 접수 2026-1234' });
    expect(changed.statusCode, changed.payload).toBe(200);
    expect(json(changed).holdReason).toBe('DISPUTE');
    const custody = await evidenceStore.listCustody(bundleId);
    expect(custody.filter((r: any) => r.action === 'HOLD_CHANGED')).toHaveLength(1);
    expect(custody.at(-1)).toMatchObject({ action: 'HOLD_CHANGED', reason: '민사 소송 접수 2026-1234' });
    const again = await holdChange(bundleId, who, { holdReason: 'INVESTIGATION', basis: '수사 착수 2026-11-27' });
    expect(again.statusCode).toBe(412);
    expect(typeOf(again)).toBe('precondition-failed');
    expect(evidenceStore.bundles.get(bundleId)!.holdReason).toBe('DISPUTE');
    expect((await evidenceStore.listCustody(bundleId)).filter((r: any) => r.action === 'HOLD_CHANGED')).toHaveLength(1);
  });

  test('FX-T13 ⑯ 보존 끝 요청·확인은 OBJECTION 422·대기 409·요청자 403·재인증 403·commander 확인을 지킨다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })] });
    const created = await createBundle(c.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    expect((await holdEndRequest(bundleId, who, { basis: '분쟁 종료' })).statusCode).toBe(422);
    expect((await holdChange(bundleId, who, { holdReason: 'DISPUTE', basis: '민사 소송 접수 2026-5678' })).statusCode).toBe(200);
    const requested = await holdEndRequest(bundleId, who, { basis: '합의 종료 2026-11-26' });
    expect(requested.statusCode, requested.payload).toBe(201);
    expect(json(requested).holdEndRequest).toMatchObject({ requestedBy: who['x-user-id'], basis: '합의 종료 2026-11-26' });
    const duplicate = await holdEndRequest(bundleId, who, { basis: '같은 요청을 다시 보냄' });
    expect(duplicate.statusCode).toBe(409);
    expect(typeOf(duplicate)).toBe('hold-end-pending');
    const self = await holdEndConfirm(bundleId, who, kit.token({ accountId: who['x-user-id']!, sessionId: who['x-session-id']!, act: 'APPROVAL' }));
    expect(self.statusCode).toBe(403);
    const noReauth = await holdEndConfirm(bundleId, approver);
    expect(noReauth.statusCode).toBe(403);
    expect(typeOf(noReauth)).toBe('reauth-required');
    const confirmed = await holdEndConfirm(bundleId, approver, kit.token({ accountId: approver['x-user-id']!, sessionId: approver['x-session-id']!, act: 'APPROVAL' }));
    expect(confirmed.statusCode, confirmed.payload).toBe(200);
    expect(json(confirmed)).toMatchObject({ bundleId, caseId: c.caseId });
    expect(Date.parse(json(confirmed).holdEndedAt)).toBe(clock.now());
    expect(Date.parse(json(confirmed).disposeAfter)).toBe(clock.now() + 30 * DAY);
    const detail = json(await getBundle(bundleId, who));
    expect(detail.holdEndedAt).toBe(json(confirmed).holdEndedAt);
    expect(detail.holdEndRequest).toBeNull();
    const custody = await evidenceStore.listCustody(bundleId);
    expect(custody.at(-2)).toMatchObject({ action: 'HOLD_ENDED', actorId: approver['x-user-id'] });
    expect(custody.at(-1)).toMatchObject({ action: 'VIEWED', actorId: who['x-user-id'] });
    expect(evidenceStore.bundles.get(bundleId)!.holdEndConfirmedBy).toBe(approver['x-user-id']);
    expect(evidenceStore.bundles.get(bundleId)!.holdEndRequestedBy).toBe(who['x-user-id']);
    expect(evidenceStore.bundles.get(bundleId)!.holdEndConfirmedBy).not.toBe(evidenceStore.bundles.get(bundleId)!.holdEndRequestedBy);
  });

  test('FX-T19 ④ [ASVS v5.0.0-5.1.1] 외부 게시물은 PNG·JPEG·PDF만 받고 10MB 초과 413·매직 바이트 불일치 415·화소 상한 422다', async () => {
    const who = investigator();
    const png = makePng({ width: 4, height: 4 });
    const fields = { eventId: EVENT, url: 'https://example.com/post/1', capturedAt: iso(NOW), source: 'MANUAL' };
    const ok = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: png }] }) });
    expect(ok.statusCode, ok.payload).toBe(201);
    expect(json(ok).scanStatus).toBe('PENDING');
    expect(access.records.at(-1)).toMatchObject({ action: 'EXTERNAL_POST', eventId: EVENT, outcome: 'ALLOWED' });
    expect(access.records.at(-1).detail).toMatchObject({ operation: 'REGISTER' });
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
    expect(captures.views.has(`captures/${postId}/view.png`)).toBe(false);
    alerts.length = 0;
    scanner.results = ['CLEAN'];
    await external().scanDue(clock.now());
    const view = await send('GET', `/v1/ops/external-posts/${postId}/capture`, who);
    expect(view.statusCode, view.payload).toBe(200);
    expect(view.headers['cache-control']).toBe('no-store');
    expect(view.headers['content-type']).toContain('image/png');
    expect(access.records.some((r) => r.action === 'EXTERNAL_POST' && r.detail?.operation === 'VIEW')).toBe(true);
    const img = readPng(view.rawPayload ?? Buffer.from(view.payload, 'binary'));
    expect(img.chunks).not.toContain('tEXt');
    expect(pixelAt(img, 1, 1).slice(0, 3)).toEqual([0, 0, 0]);
    const threat = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { ...fields, url: 'https://example.com/post/threat' }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: png }] }) });
    alerts.length = 0;
    scanner.results = ['THREAT'];
    await external().scanDue(clock.now());
    expect((await send('GET', `/v1/ops/external-posts/${json(threat).postId}/capture`, who)).statusCode).toBe(409);
    expect(captures.views.has(`captures/${json(threat).postId}/view.png`)).toBe(false);
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
    dataRequests.scopes.delete(REQUEST);
    const missing = await exportBundle(bundleId, who, { kind: 'AUTHORITY', dataRequestId: REQUEST, reason: '기관 제출' });
    expect(missing.statusCode).toBe(404);
    expect(typeOf(missing)).toBe('data-request-not-found');
  });

  test('FX-T20 ⑤ C-T71 ② AUTHORITY는 승인 범위의 행만 제출 파일로 넘기고 요청을 EXTRACTED로 옮긴다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })] });
    const created = await createBundle(c.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    inventory.rows.inv_step.push({ table: 'inv_step', accountId: A(1), tsMs: NOW + 2 * HOUR, values: { step: 'SALE', order_id: 'order-outside' } });
    dataRequests.scopes.set(REQUEST, { dataRequestId: REQUEST, eventId: EVENT, status: 'APPROVED', warrant: false, legalBasis: 'PERFORMANCE_ACT', items: ['PURCHASE', 'ACCESS_LOG'], fromMs: NOW - HOUR, toMs: NOW + HOUR, accountIds: [A(1)] });
    const out = await exportBundle(bundleId, who, { kind: 'AUTHORITY', dataRequestId: REQUEST, reason: '공연법 요청' });
    expect(out.statusCode, out.payload).toBe(201);
    expect(json(out)).toMatchObject({ kind: 'AUTHORITY', dataRequestId: REQUEST, documentId: id(0x800), rows: 2 });
    expect(submission.calls).toHaveLength(1);
    expect(submission.calls[0].scope).toMatchObject({ dataRequestId: REQUEST, warrant: false, legalBasis: 'PERFORMANCE_ACT' });
    expect(submission.calls[0].rows.map((r: any) => r.accountId)).toEqual([A(1), A(1)]);
    expect(submission.calls[0].rows.every((r: any) => r.table === 'inv_step' || r.table === 'inv_request')).toBe(true);
    expect(submission.calls[0].rows.some((r: any) => r.table === 'inv_link' || r.table === 'inv_behavior')).toBe(false);
    expect(submission.calls[0].rows.some((r: any) => r.values.order_id === 'order-outside')).toBe(false);
    expect(JSON.stringify(submission.calls[0].rows)).not.toMatch(/ja4|edge_bot_labels|payment_method_ref|card_bin|pid|investigator_opinion/);
    expect(dataRequests.submitted).toHaveLength(1);
    expect(dataRequests.submitted[0].dataRequestId).toBe(REQUEST);
    expect(dataRequests.submitted[0].document.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dataRequests.statuses.get(REQUEST)).toBe('EXTRACTED');
    const exportLog = access.records.find((r) => r.action === 'EVIDENCE_EXPORT' && r.detail?.dataRequestId === REQUEST);
    expect(exportLog).toMatchObject({ action: 'EVIDENCE_EXPORT', rows: 2, detail: { dataRequestId: REQUEST } });
    const custody = await evidenceStore.listCustody(bundleId);
    expect(custody.at(-1)).toMatchObject({ action: 'EXPORTED', exportKind: 'AUTHORITY', dataRequestId: REQUEST, reason: '공연법 요청' });
    inventory.rows.inv_step.pop();
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
    // 앞선 FX-T19 시험이 EVENT에 남긴 게시물과 격리하려고 두 경우에 전용 회차를 쓴다.
    const c = await seedCase({
      eventId: EVENT_COMPLAINT,
      status: 'ACTIONED',
      outcomeLabel: 'BOT',
      investigatorOpinion: `연락처 010-1111-2222 IP 127.0.0.1`,
      members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })],
      events: [
        { seq: 1, kind: 'CREATED', actorId: id(0x900), note: null, detail: null, occurredAtMs: NOW - DAY },
        { seq: 2, kind: 'NOTE', actorId: id(0x900), note: 'contactRef c-1 paymentMethodRef pm-1 deviceRef d-1', detail: { ip: '127.0.0.1' }, occurredAtMs: NOW },
      ],
    });
    const post = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { eventId: EVENT_COMPLAINT, url: 'https://example.com/resale/1', capturedAt: iso(NOW), source: 'MANUAL', postedAt: iso(NOW - HOUR) }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: makePng({ width: 2, height: 2 }) }] }) });
    expect(post.statusCode, post.payload).toBe(201);
    const postNoTime = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { eventId: EVENT_COMPLAINT, url: 'https://example.com/resale/2', capturedAt: iso(NOW), source: 'MANUAL' }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: makePng({ width: 2, height: 2 }) }] }) });
    expect(postNoTime.statusCode, postNoTime.payload).toBe(201);
    scanner.results = ['CLEAN', 'CLEAN'];
    await external().scanDue(clock.now());
    await external().scanDue(clock.now());
    const created = await createBundle(c.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    const sealed = json(await getBundle(bundleId, who));
    expect(objects.objects.has(`${sealed.s3Prefix}posts/${json(post).postId}/original.png`)).toBe(true);
    expect(sealed.files.map((f: any) => f.name)).toEqual(expect.arrayContaining([`posts/${json(post).postId}/original.png`]));
    const out = await exportBundle(bundleId, who, { kind: 'COMPLAINT', reason: '고소장' });
    expect(out.statusCode, out.payload).toBe(200);
    expect(out.headers['cache-control']).toBe('no-store');
    const packet = json(out);
    expect(packet).toMatchObject({
      caseNumber: c.caseId,
      eventName: '겨울 콘서트',
      statement: '기록을 보존하고 있으며 영장이나 공연법 제4조의3 요청을 받으면 정해진 절차로 냅니다',
      bundleManifestSha256: sealed.manifestSha256,
      resaleEvidence: true,
    });
    expect(packet.reasonCategories).toEqual(['MACRO_BOT']);
    expect(packet.bypassedControls.length).toBeGreaterThan(0);
    expect(packet.resalePosts).toEqual([
      { url: 'https://example.com/resale/1', postedAt: iso(NOW - HOUR), captureSha256: json(post).captureSha256 },
      { url: 'https://example.com/resale/2', postedAt: iso(NOW), captureSha256: json(postNoTime).captureSha256 },
    ]);
    for (const secret of [A(1), '010-1111-2222', '127.0.0.1', 'contactRef', 'paymentMethodRef', 'deviceRef', 'c-1', 'pm-1', 'd-1']) {
      expect(out.payload).not.toContain(secret);
    }
    expect(out.payload).not.toMatch(/captureKey|capture_key|base64|원본/);
    const custody = await evidenceStore.listCustody(bundleId);
    expect(custody.at(-1)).toMatchObject({ action: 'EXPORTED', exportKind: 'COMPLAINT', reason: '고소장' });

    const noPostCase = await seedCase({ eventId: EVENT_NO_POST, status: 'ACTIONED', outcomeLabel: 'BOT', reasonCategory: 'QUEUE_BYPASS', members: [memberOf(A(1), { actionNotifiedAtMs: NOW - DAY })] });
    const noPostBundle = String(json(await createBundle(noPostCase.caseId, who)).bundleId);
    await evidence().buildDue(clock.now());
    const noPost = await exportBundle(noPostBundle, who, { kind: 'COMPLAINT', reason: '고소' });
    expect(noPost.statusCode, noPost.payload).toBe(200);
    expect(json(noPost)).toMatchObject({ resaleEvidence: false, resalePosts: [] });
    expect(json(noPost).bypassedControls.length).toBeGreaterThan(0);
  });

  test('FX-T20 ⑧ C-T71 ① 사유 없음 400·봉인 전 409·파기 410이고 하루 20회를 넘으면 429다', async () => {
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
    expect(typeOf(noReason)).toBe('invalid-body');
    evidenceStore.forcedExportCount = 19;
    expect((await exportBundle(bundleId, who, { kind: 'PROMOTER', reason: '열아홉' })).statusCode).toBe(200);
    evidenceStore.forcedExportCount = 20;
    const limited = await exportBundle(bundleId, who, { kind: 'PROMOTER', reason: '스무 번째' });
    expect(limited.statusCode).toBe(429);
    expect(typeOf(limited)).toBe('export-rate-limited');
    expect(access.records.at(-1)).toMatchObject({ action: 'EVIDENCE_EXPORT', outcome: 'DENIED' });
  });

  test('FX-T20 ⑨ 1만 건 넘는 내보내기는 접속기록에 bulk:true, 하루 5건 넘으면 INV_EXPORT_VOLUME 표시다', async () => {
    const who = investigator();
    // PROMOTER의 실제 경로(끝난 사건 전체 집계)로 10,000/10,001건을 만든다. AUTHORITY 전용 빌더를 쓰지 않는다.
    const first = await seedClosedCases(10_000, EVENT_BULK);
    const created = await createBundle(first.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    expect((await exportBundle(bundleId, who, { kind: 'PROMOTER', reason: '만 건' })).statusCode).toBe(200);
    const atTenThousand = access.records.filter((r) => r.action === 'EVIDENCE_EXPORT').at(-1);
    expect(atTenThousand).toMatchObject({ rows: 10_000 });
    expect(atTenThousand).not.toMatchObject({ detail: { bulk: true } });
    await seedClosedCases(1, EVENT_BULK);
    const big = await exportBundle(bundleId, who, { kind: 'PROMOTER', reason: '만 건 넘음' });
    expect(big.statusCode, big.payload).toBe(200);
    const bulk = access.records.filter((r) => r.action === 'EVIDENCE_EXPORT').at(-1);
    expect(bulk).toMatchObject({ rows: 10_001, detail: { bulk: true } });
    evidenceStore.forcedExportCount = 5;
    expect((await exportBundle(bundleId, who, { kind: 'PROMOTER', reason: '다섯 번째' })).statusCode).toBe(200);
    expect(JSON.stringify(access.records.at(-1))).not.toContain('INV_EXPORT_VOLUME');
    evidenceStore.forcedExportCount = 6;
    const six = await exportBundle(bundleId, who, { kind: 'PROMOTER', reason: '여섯 번째' });
    expect(six.statusCode).toBe(200);
    expect(JSON.stringify(access.records.at(-1))).toContain('INV_EXPORT_VOLUME');
    // 뒤 시험의 expireDue가 1,000건 상한에 밀리지 않게 대량 회차 사건을 시험 저장소에서 지운다.
    for (const [id, c] of cases.cases) if (c.eventId === EVENT_BULK) cases.cases.delete(id);
  }, 120_000);

  test('FX-T23 ② [ASVS v5.0.0-2.1.2] 이의는 30일 창 안이면 공연 뒤에도 받고 지나면 기한 경과로 닫힌다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(61), { actionNotifiedAtMs: NOW - 29 * DAY, appealResult: 'REJECTED' })] });
    const inWindow = await send('POST', `/internal/v1/fraud-cases/${c.caseId}/appeals`, {}, { body: { appealId: randomUUID(), accountId: A(61), party: 'PAYER', submittedAt: iso(NOW) } });
    expect(inWindow.statusCode, inWindow.payload).toBe(200);
    expect(json(inWindow).result).toBe('ACCEPTED');
    const at = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(63), { actionNotifiedAtMs: NOW - 30 * DAY, appealResult: 'REJECTED' })] });
    const exact = await send('POST', `/internal/v1/fraud-cases/${at.caseId}/appeals`, {}, { body: { appealId: randomUUID(), accountId: A(63), party: 'PAYER', submittedAt: iso(NOW) } });
    expect(exact.statusCode).toBe(200);
    expect(json(exact).result).toBe('EXPIRED');
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
    const partial = await send('PATCH', `/v1/ops/fraud-cases/${c.caseId}`, who, { ifMatch: `"${current.version}"`, body: { objectionDecisions: [{ accountId: A(64), decision: 'ACCEPTED', reason: '오인' }] } });
    expect(partial.statusCode, partial.payload).toBe(200);
    expect(json(partial).status).toBe('OBJECTED');
    expect(json(partial).outcomeLabel).not.toBe('HUMAN');
    const decided = json(partial).events.find((e: any) => e.kind === 'OBJECTION_DECIDED' && e.detail?.accountId === A(64));
    expect(decided).toMatchObject({ actorId: who['x-user-id'], occurredAtMs: NOW, detail: { decision: 'ACCEPTED' } });
    const afterPartial = json(await getCase(c.caseId, who));
    expect(afterPartial.status).toBe('OBJECTED');
    expect(afterPartial.closedAt).toBeNull();
    const rest = await send('PATCH', `/v1/ops/fraud-cases/${c.caseId}`, who, { ifMatch: `"${afterPartial.version}"`, body: { objectionDecisions: [{ accountId: A(65), decision: 'REJECTED', reason: '근거 유지' }] } });
    expect(rest.statusCode, rest.payload).toBe(200);
    expect(json(rest).status).toBe('ACTIONED');
    const after = await getCase(c.caseId, who);
    expect(json(after).events.some((e: any) => e.kind === 'OBJECTION_DECIDED' && e.detail?.decision === 'REJECTED')).toBe(true);
    // IR-15: 기각도 사본의 이의 상태·이유를 갱신한다.
    const rejectedCopy = copies.find((x) => x.caseId === c.caseId && x.accountId === A(65) && x.objectionState === 'REJECTED');
    expect(rejectedCopy).toMatchObject({ state: 'REJECTED', objectionState: 'REJECTED', objectionNote: '근거 유지' });
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
        { seq: 2, kind: 'ACTION_EXECUTED', actorId: id(0x900), note: null, detail: { results: [{ ticketId: T(1), outcome: 'ACCEPTED' }, { ticketId: T(2), outcome: 'ACCEPTED' }, { ticketId: T(3), outcome: 'ACCEPTED' }, { ticketId: T(4), outcome: 'ACCEPTED' }], targets: [{ ticketId: T(1), payerAccountId: A(66) }, { ticketId: T(2), payerAccountId: A(66) }, { ticketId: T(3), payerAccountId: A(66) }, { ticketId: T(4), payerAccountId: A(66) }] }, occurredAtMs: NOW },
      ],
    });
    activeRestrictions.set(c.caseId, [{ accountId: A(66), caseId: c.caseId, restrictionId: id(0x951), untilMs: NOW + 30 * DAY, version: 1 }]);
    await send('POST', `/internal/v1/fraud-cases/${c.caseId}/appeals`, {}, { body: { appealId: randomUUID(), accountId: A(66), party: 'PAYER', submittedAt: iso(NOW) } });
    priorityResults = ['SAME_SEAT', 'SAME_TIER', 'NO_SEAT', 'ENTRY_STARTED'];
    priorityOmitTicketId = true;
    const current = json(await getCase(c.caseId, who));
    const patch = await send('PATCH', `/v1/ops/fraud-cases/${c.caseId}`, who, { ifMatch: `"${current.version}"`, body: { objectionDecisions: [{ accountId: A(66), decision: 'ACCEPTED', reason: '가족' }] } });
    expect(patch.statusCode, patch.payload).toBe(200);
    expect(priorityCalls).toHaveLength(0);
    const liftId = String(json(patch).approvalId);
    expect((await getApproval(liftId, approver)).statusCode).toBe(200);
    expect((await approve(liftId, approver)).statusCode).toBe(200);
    expect(priorityCalls).toHaveLength(1);
    expect(priorityCalls[0]).toMatchObject({ caseId: c.caseId, accountId: A(66), eventId: EVENT, cancelledTicketIds: [T(1), T(2), T(3), T(4)] });
    const after = await getCase(c.caseId, who);
    expect(json(after).status).toBe('REVERSED');
    expect(compensation.calls).toEqual([
      expect.objectContaining({ caseId: c.caseId, accountId: A(66), ticketId: T(3), reason: 'NO_SEAT' }),
      expect.objectContaining({ caseId: c.caseId, accountId: A(66), ticketId: T(4), reason: 'ENTRY_STARTED' }),
    ]);
    expect(copies.some((x) => x.accountId === A(66) && x.lockActive === false)).toBe(true);
    const reversalCopy = copies.find((x) => x.caseId === c.caseId && x.accountId === A(66) && x.objectionState === 'ACCEPTED' && x.lockActive === false);
    expect(reversalCopy).toMatchObject({ state: 'REJECTED', actionResult: { cancelledTicketIds: [T(1), T(2), T(3), T(4)] } });
    expect(reversalCopy.priorityPurchases?.length).toBeGreaterThan(0);
    expect(reversalCopy.priorityPurchases?.[0]).toMatchObject({ grantId: expect.any(String), price: 100_000 });
    const grant = json(after).events.find((e: any) => e.kind === 'PRIORITY_GRANTED');
    expect(grant.detail.grants[0]).toMatchObject({ result: 'SAME_SEAT', price: 100_000, fee: 0 });
    expect(Date.parse(grant.detail.grants[0].expiresAt)).toBe(NOW + 48 * HOUR);
  });

  test('C-T70 ① C-T70 ② 소명 요청·잠금·받은 사람 알림·돌려주기·인정·해제가 서버에서 이어진다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'INVESTIGATING', members: [memberOf(A(67))] });
    seedTicket({ ticketId: T(67), payerAccountId: A(67) });
    seedTicket({ ticketId: T(68), payerAccountId: A(67), holderAccountId: H(1) });
    locks.sets.length = 0;
    locks.releases.length = 0;
    const requested = await send('POST', `/v1/ops/fraud-cases/${c.caseId}/appeal-requests`, who, { idem: randomUUID(), body: { accountIds: [A(67)], reasonCategories: ['MACRO_BOT'], dueAt: iso(NOW + 2 * DAY) } });
    expect(requested.statusCode, requested.payload).toBe(201);
    expect(json(requested)).toMatchObject({ lockedTicketCount: 2, notifiedHolderCount: 1, lockExpiresAt: iso(NOW + 14 * DAY) });
    expect(locks.sets).toHaveLength(1);
    expect(locks.sets[0]).toMatchObject({ caseId: c.caseId, eventId: EVENT, accountIds: [A(67)], expiresAtMs: NOW + 14 * DAY });
    expect(holderNotices).toHaveLength(1);
    expect(holderNotices[0]).toMatchObject({ eventId: EVENT, caseId: c.caseId, accountId: H(1), ticketIds: [T(9)] });
    expect(holderNotices[0]).not.toHaveProperty('reasonCategories');
    expect(await cases.markAppealSubmitted(c.caseId, A(67), clock.now())).toBe(true);
    const current = json(await getCase(c.caseId, who));
    const patch = await send('PATCH', `/v1/ops/fraud-cases/${c.caseId}`, who, { ifMatch: `"${current.version}"`, body: { appealDecisions: [{ accountId: A(67), decision: 'ACCEPTED', reason: '정상 구매' }] } });
    expect(patch.statusCode, patch.payload).toBe(200);
    expect(json(patch).status).toBe('CLEARED');
    expect(json(patch).outcomeLabel).toBe('HUMAN');
    expect(locks.releases.length).toBeGreaterThanOrEqual(1);
    // IR-04·05·12: 인정 사본은 상태·사건 상태·잠긴 표를 남기고 HOLDER의 가진 표도 유지한다.
    const acceptedCopy = copies.find((x) => x.caseId === c.caseId && x.accountId === A(67) && x.state === 'ACCEPTED');
    expect(acceptedCopy).toMatchObject({ party: 'PAYER', lockActive: false, state: 'ACCEPTED', caseStatus: 'CLEARED', actionResult: null, excludedTicketIds: [] });
    expect(acceptedCopy.lockedTicketIds).toEqual([T(67), T(68)]);
    const holderCopy = copies.find((x) => x.caseId === c.caseId && x.accountId === H(1) && x.party === 'HOLDER' && x.state === 'ACCEPTED');
    expect(holderCopy).toMatchObject({ party: 'HOLDER', lockActive: false, state: 'ACCEPTED', caseStatus: 'CLEARED', heldTicketIds: [T(9)], lockedTicketIds: [], actionResult: null });

    // 14일이 지나면 ops-svc가 멈춰도 ticket-svc가 잠금을 풀고, ops 사본도 풀린다.
    const expiredCase = await seedCase({ status: 'APPEAL_PENDING', appealDueAtMs: NOW + 2 * DAY, members: [memberOf(A(68), { appealResult: 'PENDING', lockExpiresAtMs: NOW + 14 * DAY })] });
    const fraudActions = svc.app.get((investigationsModule as unknown as Record<string, any>).FraudActions) as any;
    clock.advance(14 * DAY);
    await fraudActions.expireDue(clock.now());
    expect(copies.some((x) => x.caseId === expiredCase.caseId && x.accountId === A(68) && x.lockActive === false)).toBe(true);
  });

  test('IR-01 증거·외부 게시물 경로는 FRAUD_INVESTIGATOR 지정을 요구한다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(69), { actionNotifiedAtMs: NOW - DAY })] });
    const created = await createBundle(c.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    for (const role of ['viewer', 'operator', 'cs_agent'] as const) {
      const other = identity.ops(role);
      expect((await getBundle(bundleId, other)).statusCode, role).toBe(403);
      expect((await listBundles(other)).statusCode, role).toBe(403);
      expect((await exportBundle(bundleId, other, { kind: 'COMPLAINT', reason: '고소' })).statusCode, role).toBe(403);
      expect((await send('GET', `/v1/ops/external-posts?eventId=${EVENT}`, other)).statusCode, role).toBe(403);
    }
  });

  test('IR-02 보존 변경·내보내기는 같은 멱등 키를 재생하고 두 번 적용하지 않는다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(70), { actionNotifiedAtMs: NOW - DAY })] });
    const created = await createBundle(c.caseId, who);
    const bundleId = String(json(created).bundleId);
    await evidence().buildDue(clock.now());
    const holdKey = randomUUID();
    const first = await holdChange(bundleId, who, { holdReason: 'DISPUTE', basis: '민사 소송 접수 2026-3001' }, holdKey);
    expect(first.statusCode, first.payload).toBe(200);
    const second = await holdChange(bundleId, who, { holdReason: 'DISPUTE', basis: '민사 소송 접수 2026-3001' }, holdKey);
    expect(second.statusCode, second.payload).toBe(200);
    expect((await evidenceStore.listCustody(bundleId)).filter((r: any) => r.action === 'HOLD_CHANGED')).toHaveLength(1);
    const exportKey = randomUUID();
    const beforeExports = evidenceStore.exports.filter((e: any) => e.kind === 'COMPLAINT').length;
    const e1 = await exportBundle(bundleId, who, { kind: 'COMPLAINT', reason: '고소' }, exportKey);
    expect(e1.statusCode, e1.payload).toBe(200);
    const e2 = await exportBundle(bundleId, who, { kind: 'COMPLAINT', reason: '고소' }, exportKey);
    expect(e2.statusCode, e2.payload).toBe(200);
    expect(evidenceStore.exports.filter((e: any) => e.kind === 'COMPLAINT')).toHaveLength(beforeExports + 1);
  });

  test('IR-03 봉인 묶음은 외부 게시물 원본 캡처와 메타데이터를 함께 담는다', async () => {
    const who = investigator();
    const c = await seedCase({ eventId: EVENT_COMPLAINT, status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(71), { actionNotifiedAtMs: NOW - DAY })] });
    const post = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { eventId: EVENT_COMPLAINT, url: 'https://example.com/post/bundle-original', capturedAt: iso(NOW), source: 'MANUAL' }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: makePng({ width: 2, height: 2 }) }] }) });
    expect(post.statusCode, post.payload).toBe(201);
    scanner.results = ['CLEAN'];
    await external().scanDue(clock.now());
    const bundleId = String(json(await createBundle(c.caseId, who)).bundleId);
    await evidence().buildDue(clock.now());
    const b = json(await getBundle(bundleId, who));
    const prefix = `${b.s3Prefix}posts/${json(post).postId}/`;
    expect(objects.objects.has(`${prefix}original.png`)).toBe(true);
    expect(b.files.map((f: any) => f.name)).toEqual(expect.arrayContaining([`posts/${json(post).postId}/original.png`, `posts/${json(post).postId}.json`]));
  });

  test('IR-04 외부 게시물 파기는 공연일 + 30일이고 매칭된 게시물은 지우지 않는다', async () => {
    const who = investigator();
    for (const [id] of evidenceStore.posts) evidenceStore.posts.delete(id);
    const png = makePng({ width: 2, height: 2 });
    const unmatched = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { eventId: EVENT_DISPOSE, url: 'https://example.com/post/dispose-1', capturedAt: iso(NOW), source: 'MANUAL' }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: png }] }) });
    seats.map.set('B구역 2열 2번', [{ ticketId: T(71), accountId: A(71), seatLabel: 'B구역 2열 2번' }]);
    const matched = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { eventId: EVENT_DISPOSE, url: 'https://example.com/post/dispose-2', capturedAt: iso(NOW), source: 'MANUAL', claimedSeats: 'B구역 2열 2번' }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: png }] }) });
    expect(unmatched.statusCode).toBe(201);
    expect(matched.statusCode).toBe(201);
    scanner.results = ['CLEAN', 'CLEAN'];
    await external().scanDue(clock.now());
    clock.advance(SHOW + 30 * DAY - HOUR - clock.now());
    expect(await external().disposeDue(clock.now())).toBe(0);
    clock.advance(HOUR);
    expect(await external().disposeDue(clock.now())).toBe(1);
    expect(captures.evidence.has(`captures/${json(unmatched).postId}/original.png`)).toBe(false);
    expect(captures.evidence.has(`captures/${json(matched).postId}/original.png`)).toBe(true);
    expect(disposer.captureCalls).toContain(`captures/${json(unmatched).postId}/`);
    expect(captures.disposeCalls).toHaveLength(0);
  });

  test('IR-06 묶음 갱신과 관리 연속성 추가는 한 단위라 실패하면 둘 다 남지 않는다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(72), { actionNotifiedAtMs: NOW - DAY })] });
    const bundleId = String(json(await createBundle(c.caseId, who)).bundleId);
    await evidence().buildDue(clock.now());
    evidenceStore.failNextCustody = true;
    const failed = await holdChange(bundleId, who, { holdReason: 'DISPUTE', basis: '민사 소송 접수 2026-3002' });
    expect(failed.statusCode).toBe(500);
    expect(evidenceStore.bundles.get(bundleId)!.holdReason).toBe('OBJECTION');
    expect((await evidenceStore.listCustody(bundleId)).filter((r: any) => r.action === 'HOLD_CHANGED')).toHaveLength(0);
  });

  test('IR-08 증거 만들기·봉인·열람·내보내기는 관제 감사 기록에 남고 SEALED 행은 목록 해시를 앵커로 남긴다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(73), { actionNotifiedAtMs: NOW - DAY })] });
    const bundleId = String(json(await createBundle(c.caseId, who)).bundleId);
    await evidence().buildDue(clock.now());
    const b = json(await getBundle(bundleId, who));
    await exportBundle(bundleId, who, { kind: 'COMPLAINT', reason: '고소' });
    const sealed = (await evidenceStore.listCustody(bundleId)).find((r: any) => r.action === 'SEALED');
    expect(sealed.reason).toContain(b.manifestSha256);
    expect(auditEvents.some((r) => String(r.payload?.action ?? '').startsWith('EVIDENCE_'))).toBe(true);
  });

  test('IR-30 외부 게시물 캡처 파기는 파기 전용 포트로 보낸다', async () => {
    const who = investigator();
    for (const [id] of evidenceStore.posts) evidenceStore.posts.delete(id);
    const post = await send('POST', '/v1/ops/external-posts', who, { idem: randomUUID(), multipart: multipart({ fields: { eventId: EVENT_DISPOSE, url: 'https://example.com/post/disposer', capturedAt: iso(NOW), source: 'MANUAL' }, files: [{ field: 'capture', name: 'capture.png', type: 'image/png', bytes: makePng({ width: 2, height: 2 }) }] }) });
    expect(post.statusCode).toBe(201);
    scanner.results = ['CLEAN'];
    await external().scanDue(clock.now());
    clock.advance(SHOW + 30 * DAY - clock.now());
    expect(await external().disposeDue(clock.now())).toBe(1);
    expect(disposer.captureCalls).toContain(`captures/${json(post).postId}/`);
    expect(captures.disposeCalls).toHaveLength(0);
  });

  test('IR-31 파기 뒤 DB 갱신 실패는 SEV2로 남기고 묶음을 SEALED에 둔다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(76), { actionNotifiedAtMs: NOW - DAY })] });
    const bundleId = String(json(await createBundle(c.caseId, who)).bundleId);
    await evidence().buildDue(clock.now());
    const bundle = evidenceStore.bundles.get(bundleId)!;
    bundle.createdAtMs = NOW - 365 * DAY + HOUR;
    clock.advance(HOUR);
    alerts.length = 0;
    evidenceStore.failNextDisposeUpdate = true;
    expect(await evidence().disposeDue(clock.now())).toBe(0);
    expect(alerts.some((a) => a.severity === 'SEV2' && a.kind === 'EVIDENCE_DISPOSE_FAILED')).toBe(true);
    expect(evidenceStore.bundles.get(bundleId)!.status).toBe('SEALED');
  });

  test('IR-19 이의 결정자는 그 결정을 내린 사람으로 남고 뒤 결정이 앞 결정자를 덮지 않는다', async () => {
    const firstWho = investigator();
    const secondWho = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(74), { actionNotifiedAtMs: NOW - DAY, appealResult: 'REJECTED' }), memberOf(A(75), { actionNotifiedAtMs: NOW - DAY, appealResult: 'REJECTED' })] });
    await send('POST', `/internal/v1/fraud-cases/${c.caseId}/appeals`, {}, { body: { appealId: randomUUID(), accountId: A(74), party: 'PAYER', submittedAt: iso(NOW) } });
    await send('POST', `/internal/v1/fraud-cases/${c.caseId}/appeals`, {}, { body: { appealId: randomUUID(), accountId: A(75), party: 'PAYER', submittedAt: iso(NOW) } });
    const current = json(await getCase(c.caseId, firstWho));
    expect((await send('PATCH', `/v1/ops/fraud-cases/${c.caseId}`, firstWho, { ifMatch: `"${current.version}"`, body: { objectionDecisions: [{ accountId: A(74), decision: 'ACCEPTED', reason: '오인' }] } })).statusCode).toBe(200);
    const before = json(await getCase(c.caseId, firstWho));
    expect((await send('PATCH', `/v1/ops/fraud-cases/${c.caseId}`, secondWho, { ifMatch: `"${before.version}"`, body: { objectionDecisions: [{ accountId: A(75), decision: 'REJECTED', reason: '근거 유지' }] } })).statusCode).toBe(200);
    const after = json(await getCase(c.caseId, secondWho));
    const decided = after.events.filter((e: any) => e.kind === 'OBJECTION_DECIDED');
    expect(decided.find((e: any) => e.detail?.accountId === A(74)).actorId).toBe(firstWho['x-user-id']);
    expect(decided.find((e: any) => e.detail?.accountId === A(75)).actorId).toBe(secondWho['x-user-id']);
  });
});

describe('F-04-15 화면 보완', () => {
  test('C-T71 ⑥ 사건 상세의 evidenceBundleIds는 실제 묶음 ID를 만든 순서로 싣는다', async () => {
    const who = investigator();
    const c = await seedCase({ status: 'ACTIONED', outcomeLabel: 'BOT', members: [memberOf(A(80), { appealResult: 'REJECTED', actionNotifiedAtMs: NOW - DAY })] });
    const first = json(await createBundle(c.caseId, who));
    // 만든 시각이 다르면 최신순 목록(내림차순)과 만든 순서가 갈린다(IR-07)
    clock.advance(HOUR);
    const second = json(await createBundle(c.caseId, who));
    clock.advance(HOUR);
    const third = json(await createBundle(c.caseId, who));
    const detail = json(await getCase(c.caseId, who));
    expect(detail.evidenceBundleIds).toEqual([first.bundleId, second.bundleId, third.bundleId]);
  });

  test('C-T71 ⑤ 승인 상세의 사건 요약은 계약 칸을 모두 싣고 요청자에게 canApprove 거짓을 준다', async () => {
    const who = investigator();
    const approver = commander();
    const c = await seedCase({
      status: 'APPEAL_PENDING',
      clusterId: CLUSTER,
      appealDueAtMs: NOW - HOUR,
      investigatorOpinion: '같은 결제 수단을 여러 계정이 썼습니다',
      members: [
        memberOf(A(81), { appealResult: 'REJECTED', appealDueAtMs: NOW - HOUR, lockExpiresAtMs: NOW + 10 * DAY }),
        memberOf(A(82), { appealResult: 'EXPIRED', appealDueAtMs: NOW - HOUR, lockExpiresAtMs: NOW + 10 * DAY }),
      ],
    });
    // 대상 표가 하나도 없으면 여러 계정이어도 422다(IR-08, F-04-14 IR-10).
    const empty = await send('POST', `/v1/ops/fraud-cases/${c.caseId}/action-requests`, who, { idem: randomUUID(), body: { fraudAction: 'CANCEL_TICKETS', accountIds: [A(81), A(82)], reason: '취소' } });
    expect(empty.statusCode, empty.payload).toBe(422);
    expect(typeOf(empty)).toBe('action-target-invalid');
    seedTicket({ ticketId: T(81), payerAccountId: A(81) });
    const created = await send('POST', `/v1/ops/fraud-cases/${c.caseId}/action-requests`, who, { idem: randomUUID(), body: { fraudAction: 'CANCEL_TICKETS', accountIds: [A(81), A(82)], reason: '취소' } });
    expect(created.statusCode, created.payload).toBe(201);
    const approvalId = String(json(created).approvalId);
    const requesterView = json(await getApproval(approvalId, who));
    expect(requesterView.canApprove).toBe(false);
    expect(requesterView.fraudCaseSummary).toMatchObject({
      caseId: c.caseId,
      eventId: EVENT,
      reasonCategory: 'MACRO_BOT',
      accountCount: 2,
      ticketCount: 1,
      purchaseCount: 9,
      limitPerPerson: 4,
      scoreBand: 'HIGH',
      sharedAttributes: ['PAYMENT_METHOD'],
      signals: ['LINK_GRAPH'],
      appealOutcome: 'REJECTED',
      investigatorOpinion: '같은 결제 수단을 여러 계정이 썼습니다',
      cancelDeadlineAt: iso(CANCEL),
      snapshotHash: 'a'.repeat(64),
      appealCounts: { accepted: 0, rejected: 1, expired: 1, submitted: 0, pending: 0 },
    });
    expect(requesterView.fraudCaseSummary.targets.map((t: any) => t.accountId)).toEqual([A(81), A(82)]);
    expect(requesterView.fraudCaseSummary.targets[0]).toMatchObject({ accountId: A(81), appealOutcome: 'REJECTED', ticketIds: [T(81)], holderTicketIds: [] });
    expect(requesterView.fraudCaseSummary.targets[1]).toMatchObject({ accountId: A(82), appealOutcome: 'EXPIRED', ticketIds: [], holderTicketIds: [] });
    const approverView = json(await getApproval(approvalId, approver));
    expect(approverView.canApprove).toBe(true);
    expect(approverView.summaryViewedAt).toMatch(/^20/);
  });
});
