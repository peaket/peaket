// F-06-4 예매 제한·소명 시험 공용 도우미(시험 담당 lane2-freeze-F-06-4-opencode).
// 실제 ops-svc 조립(AppModule.register({ memory:true }))을 띄우고, 관제 HTTP·내부 HTTP를 실제 Fastify 경로로 부른다.
// 사본(queue·purchase·core view)과 소명 출처·조사관·알림·계정 보류는 바깥 서비스 경계의 대역이다(업무 저장소는 앱의 메모리 저장소).
// 새 부품은 앱 키트(Symbol.for('peaket.ops.restriction-kit'))로만 꺼낸다. 구현 전에는 키트가 없어 그 자리에서 실패한다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock, type FakeClock } from '@peaket/platform';
import { Writable } from 'node:stream';
import { expect } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { PromCsCaseSignals, type CsCaseKind, type CsCaseKit } from '../src/modules/cases/index.js';
import { FakeAdminIdentity } from './admin-support.js';
import { FakeIdentity } from './support.js';
import { BASE_ISO, HOLIDAYS } from './cs-support.js';

export const RESTRICTION_KIT = Symbol.for('peaket.ops.restriction-kit');

/** 금 2026-11-20 23:30 KST. 이 시각에서 1년·1영업일·3영업일을 손으로 센 값과 다르게 시험 값을 고른다. */
export const NOW_ISO = BASE_ISO;
export const NOW_MS = Date.parse(NOW_ISO);
export { HOLIDAYS };

export type OpsRole = 'viewer' | 'operator' | 'commander' | 'cs_agent' | 'cs_lead';
export interface CopyCall {
  readonly target: 'queue' | 'purchase' | 'view';
  readonly input: Record<string, unknown>;
}

export interface AppealSourceRecord {
  readonly appealId: string;
  readonly accountId: string;
  readonly kind: 'RESTRICTION' | 'FRAUD_CASE';
  readonly targetId: string;
  readonly body: string;
  readonly submittedAtMs: number;
}

export interface RestrictionHarness {
  readonly svc: Awaited<ReturnType<typeof createService>>;
  readonly clock: FakeClock;
  readonly audit: MemoryAuditChain;
  readonly cs: CsCaseKit;
  readonly copies: CopyCall[];
  readonly holds: Array<{ accountId: string; caseId: string; state: 'OPEN' | 'CLOSED'; version: number }>;
  readonly notices: Array<{ appealId: string; accountId: string; event: string; result?: string }>;
  readonly appeals: Map<string, AppealSourceRecord>;
  readonly investigators: Map<string, string>;
  failNext(target: 'queue' | 'purchase' | 'view', times?: number): void;
  recover(): void;
  as(role: OpsRole): Record<string, string>;
  create(h: Record<string, string>, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  approve(h: Record<string, string>, approvalId: string, version: number, reason?: string): Promise<{ status: number; body: Record<string, unknown> }>;
  get(h: Record<string, string>, approvalId: string): Promise<{ status: number; etag: string | undefined; body: Record<string, unknown> }>;
  intake(body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  caseGet(h: Record<string, string>, caseId: string): Promise<{ status: number; etag: string | undefined; body: Record<string, unknown> }>;
  decide(h: Record<string, string>, caseId: string, body: Record<string, unknown>, version: number): Promise<{ status: number; body: Record<string, unknown> }>;
  /** 키트의 배경 작업 한 바퀴(다시 보내기·정비) */
  tick(nowMs?: number): Promise<void>;
  kit(): {
    rows(): Array<Record<string, unknown>>;
    seed(row: Record<string, unknown>): void;
    applyFraud(i: { accountId: string; fraudCaseId: string; endsAtMs: number; confirmedBy?: string }): Promise<{ restrictionId: string; version: number }>;
  };
  close(): Promise<void>;
}

const logSink = () => {
  const chunks: string[] = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
  return { stream, lines: () => chunks.join('').split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>) };
};

class TestReauth {
  readonly tokenFor = new Map<string, string>();
  async verify(token: string | undefined, o: { sessionId: string; act: 'APPROVAL' }) {
    if (token !== 'approval-token') throw Object.assign(new Error('reauth-required'), { type: 'reauth-required', status: 403 });
    return { accountId: this.tokenFor.get(o.sessionId) ?? '', factors: ['password', 'totp', 'passkey'] };
  }
}

export interface RestrictionCopiesPort {
  queue(input: Record<string, unknown>): Promise<{ changed: boolean }>;
  purchase(input: Record<string, unknown>): Promise<{ changed: boolean }>;
  view(input: Record<string, unknown>): Promise<{ changed: boolean }>;
}

export async function restrictionHarness(o: { nowIso?: string; copies?: RestrictionCopiesPort } = {}): Promise<RestrictionHarness> {
  const clock = fakeClock({ now: Date.parse(o.nowIso ?? NOW_ISO) });
  const identity = new FakeIdentity();
  const admins = new FakeAdminIdentity();
  const audit = new MemoryAuditChain();
  const logs = logSink();
  const signals = new PromCsCaseSignals();
  const copies: CopyCall[] = [];
  const holds: RestrictionHarness['holds'] = [];
  const notices: RestrictionHarness['notices'] = [];
  const appeals = new Map<string, AppealSourceRecord>();
  const investigators = new Map<string, string>();
  const fail = { queue: 0, purchase: 0, view: 0 };
  const reauth = new TestReauth();
  const calendar = (await import('./cs-support.js')).testCalendar();
  const copiesPort = {
    async queue(input: Record<string, unknown>) {
      copies.push({ target: 'queue', input });
      if (fail.queue > 0) { fail.queue -= 1; throw new Error('queue unavailable'); }
      return { changed: true };
    },
    async purchase(input: Record<string, unknown>) {
      copies.push({ target: 'purchase', input });
      if (fail.purchase > 0) { fail.purchase -= 1; throw new Error('purchase unavailable'); }
      return { changed: true };
    },
    async view(input: Record<string, unknown>) {
      copies.push({ target: 'view', input });
      if (fail.view > 0) { fail.view -= 1; throw new Error('view unavailable'); }
      return { changed: true };
    },
  };
  const restrictions = {
    copies: o.copies ?? copiesPort,
    holds: { async set(i: (typeof holds)[number]) { holds.push({ ...i }); return { changed: true }; } },
    appeals: {
      async read(appealId: string) { return appeals.get(appealId); },
      async result(appealId: string, r: Record<string, unknown>) { notices.push({ appealId, accountId: '', event: 'RESULT', result: String(r.result ?? r.status) }); },
    },
    fraudCases: { async investigatorOf(caseId: string) { const id = investigators.get(caseId); return id ? { assigneeId: id } : undefined; } },
    notifier: { async send(i: { appealId: string; accountId: string; event: string; result?: string }) { notices.push(i); } },
  };
  const svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({
      memory: true,
      auditChain: audit,
      calendar,
      caseSignals: signals,
      adminAccounts: { identity: admins },
      approvals: { reauth } as never,
      restrictions: restrictions as never,
    } as never),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: logs.stream,
    adminAuthz: identity,
  });
  signals.register(svc.metrics.registry);
  const cs = svc.app.get<CsCaseKit>(Symbol.for('peaket.ops.cs-case-kit'));
  let kitValue: ReturnType<RestrictionHarness['kit']> | undefined;
  const kitOf = () => {
    if (kitValue) return kitValue;
    let raw: unknown;
    try {
      raw = svc.app.get(RESTRICTION_KIT);
    } catch {
      raw = undefined;
    }
    if (!raw) throw new Error('예매 제한 키트가 없다(계획 §4, 구현 전)');
    const k = raw as {
      rows(): Array<Record<string, unknown>>;
      seed(row: Record<string, unknown>): void;
      applyFraud(i: { accountId: string; fraudCaseId: string; endsAtMs: number; confirmedBy?: string }): Promise<{ restrictionId: string; version: number }>;
      tick(nowMs: number): Promise<void>;
    };
    kitValue = { rows: () => k.rows(), seed: (row) => k.seed(row), applyFraud: (i) => k.applyFraud(i) };
    return kitValue;
  };
  const parse = (payload: string): Record<string, unknown> => (payload ? (JSON.parse(payload) as Record<string, unknown>) : {});
  const etag = (h: Record<string, unknown>): string | undefined => (typeof h.etag === 'string' ? h.etag : undefined);
  const session = (accountId: string, role: OpsRole): Record<string, string> => {
    const sessionId = randomUUID();
    const h = { 'x-user-id': accountId, 'x-session-id': sessionId, 'x-user-aud': 'ops', 'x-user-scope': '' };
    identity.answers.set(`${accountId}/${sessionId}`, { valid: true, role });
    reauth.tokenFor.set(sessionId, accountId);
    return h;
  };
  const request = (h: Record<string, string>, method: 'GET' | 'POST', url: string, body?: unknown, extra: Record<string, string> = {}) =>
    svc.http.inject({ method, url, headers: { ...h, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  return {
    svc,
    clock,
    audit,
    cs,
    copies,
    holds,
    notices,
    appeals,
    investigators,
    failNext(target, times = 1) { fail[target] = times; },
    recover() { fail.queue = 0; fail.purchase = 0; fail.view = 0; },
    as: (role) => session(randomUUID(), role),
    async create(h, body) {
      const r = await request(h, 'POST', '/v1/ops/approval-requests', body);
      return { status: r.statusCode, body: parse(r.payload) };
    },
    async approve(h, approvalId, version, reason) {
      const r = await request(h, 'POST', `/v1/ops/approval-requests/${approvalId}/approvals`, reason === undefined ? {} : { reason }, { 'x-reauth-token': 'approval-token', 'if-match': `"${version}"` });
      return { status: r.statusCode, body: parse(r.payload) };
    },
    async get(h, approvalId) {
      const r = await request(h, 'GET', `/v1/ops/approval-requests/${approvalId}`);
      return { status: r.statusCode, etag: etag(r.headers as Record<string, unknown>), body: parse(r.payload) };
    },
    async intake(body) {
      const r = await svc.http.inject({ method: 'POST', url: '/internal/v1/cs-cases', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
      return { status: r.statusCode, body: parse(r.payload) };
    },
    async caseGet(h, caseId) {
      const r = await request(h, 'GET', `/v1/ops/cases/${caseId}`);
      return { status: r.statusCode, etag: etag(r.headers as Record<string, unknown>), body: parse(r.payload) };
    },
    async decide(h, caseId, body, version) {
      const r = await request(h, 'POST', `/v1/ops/cases/${caseId}/restriction-appeal-decision`, body, { 'if-match': `"${version}"` });
      return { status: r.statusCode, body: parse(r.payload) };
    },
    async tick(nowMs) {
      const k = svc.app.get<{ tick(nowMs: number): Promise<void> }>(RESTRICTION_KIT);
      await k.tick(nowMs ?? clock.now());
    },
    kit: kitOf,
    close: () => svc.close(),
  };
}

/** 승인 요청 본문(BOOKING_RESTRICTION). 값은 시험이 고른다 */
export const restrictionBody = (o: { accountId: string; reasonCode?: string; endsAtMs?: number; amount?: number } = { accountId: randomUUID() }) => ({
  kind: 'BOOKING_RESTRICTION',
  targetRef: o.accountId,
  amount: o.amount ?? 0,
  reasonCode: o.reasonCode ?? 'ABUSE_CANCEL',
  reasonText: '같은 공연 표를 반복해 사고 취소했다-시험7731',
  restrictionEndsAt: new Date(o.endsAtMs ?? nextYear()).toISOString(),
});

/** 요청 시각 + 1년(정확히) */
export const nextYear = (fromMs = NOW_MS): number => {
  const d = new Date(fromMs);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.getTime();
};

/** 2026-11-20(금) 23:30 KST에서 1·3영업일을 손으로 센 값. 공휴일은 cs-support의 시험 달력이다 */
export const BD1 = Date.parse('2026-11-23T14:30:00.000Z');
export const BD3 = Date.parse('2026-11-26T14:30:00.000Z');

/** CS 건 요청 본문(asyncapi CaseRequested) */
export const caseRequest = (kind: CsCaseKind, o: { sourceId?: string; eventKey?: string; category?: string; createdAt?: string; dueBaseAt?: string } = {}) => ({
  eventKey: o.eventKey ?? randomUUID(),
  kind,
  sourceId: o.sourceId ?? randomUUID(),
  category: o.category ?? '',
  createdAt: o.createdAt ?? NOW_ISO,
  ...(o.dueBaseAt !== undefined ? { dueBaseAt: o.dueBaseAt } : {}),
});

export const problemType = (b: Record<string, unknown>): string => String(b.type ?? '').split('/').pop() ?? '';

/** 승인 하나를 만들고 승인까지 마친다(집행 성공을 기대하는 시험의 준비) */
export async function approvedRestriction(h: RestrictionHarness, o: { reasonCode?: string; endsAtMs?: number; accountId?: string } = {}): Promise<{ approvalId: string; accountId: string; restrictionId: string; version: number }> {
  const agent = h.as('cs_agent');
  const lead = h.as('cs_lead');
  const body = restrictionBody({ accountId: o.accountId ?? randomUUID(), ...(o.reasonCode ? { reasonCode: o.reasonCode } : {}), ...(o.endsAtMs !== undefined ? { endsAtMs: o.endsAtMs } : {}) });
  const created = await h.create(agent, body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const row = h.kit().rows().find((r) => r.approvalId === created.body.approvalId);
  expect(row, '요청 직후에는 제한 행이 없다').toBeUndefined();
  const approved = await h.approve(lead, String(created.body.approvalId), Number(created.body.version));
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const restriction = h.kit().rows().find((r) => r.approvalId === created.body.approvalId);
  expect(restriction, '승인 뒤 제한 행').toBeTruthy();
  return { approvalId: String(created.body.approvalId), accountId: body.targetRef, restrictionId: String(restriction!.restrictionId), version: Number(restriction!.version) };
}
