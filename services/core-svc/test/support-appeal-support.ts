// F-06-4 core-svc support(소명·화면 사본) 시험 공용 도우미(시험 담당 lane2-freeze-F-06-4-opencode).
// 실제 core-svc 조립(AppModule.register({ memory:true }))을 띄우고, 팬 HTTP·내부 HTTP를 실제 Fastify 경로로 부른다.
// ops의 부정 예매 소명 입구(F-04-13 가지)는 문서화된 계약을 구현한 **로컬 HTTP 서버**로 둔다(업무 포트 가짜가 아니라 바깥 서비스 경계의 대역).
// 새 부품은 앱 키트(Symbol.for('peaket.core.support-kit'))로만 꺼낸다. 구현 전에는 키트가 없어 그 자리에서 실패한다.
import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock, type FakeClock } from '@peaket/platform';
import { Writable } from 'node:stream';
import { expect } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { FakeIdentity, fan } from './support.js';

export const SUPPORT_KIT = Symbol.for('peaket.core.support-kit');
export const INTERNAL = 'support-internal-token-000000';
export const NOW_MS = Date.parse('2026-11-26T01:00:00.000Z');
export const NOW_ISO = new Date(NOW_MS).toISOString();

export interface OpsCall {
  readonly method: string;
  readonly path: string;
  readonly md: Record<string, string>;
  readonly body: Record<string, unknown>;
}
export interface OpsAnswer {
  status: number;
  body?: Record<string, unknown>;
}

export interface ViewStore {
  apply(i: Record<string, unknown>): Promise<{ changed: boolean }>;
  get(accountId: string, id: string): Promise<Record<string, unknown> | undefined>;
  clear?(): Promise<void> | void;
}

export interface CoreSupportKit {
  readonly outbox: { rows(): Array<Record<string, unknown>> };
  readonly views: { restriction: ViewStore; fraud: ViewStore };
  readonly appeals: { find(id: string): Promise<Record<string, unknown> | undefined> };
  dispatchOnce(nowMs: number): Promise<void>;
  readonly grpcHandlers: { bookingRestrictionView: Record<string, unknown>; fraudAppealView: Record<string, unknown> };
}

export interface SupportHarness {
  readonly svc: Awaited<ReturnType<typeof createService>>;
  readonly clock: FakeClock;
  readonly logs: { text(): string; lines(): Array<Record<string, unknown>> };
  readonly calls: OpsCall[];
  readonly notices: Array<{ appealId: string; accountId: string; event: string; result?: string }>;
  answer(a: OpsAnswer | ((call: OpsCall) => OpsAnswer | Promise<OpsAnswer>)): void;
  fanHeaders(accountId?: string): Record<string, string>;
  post(h: Record<string, string>, body: unknown): Promise<{ status: number; body: Record<string, unknown>; location?: string; headers: Record<string, unknown> }>;
  myAppeals(h: Record<string, string>): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }>;
  restriction(h: Record<string, string>): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }>;
  fraudAppeals(h: Record<string, string>): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }>;
  internalGet(appealId: string, token?: string | null): Promise<{ status: number; body: Record<string, unknown> }>;
  internalResult(appealId: string, body: unknown, token?: string | null): Promise<{ status: number; body: Record<string, unknown> }>;
  dispatch(nowMs?: number): Promise<void>;
  kit(): CoreSupportKit;
  close(): Promise<void>;
}

const logSink = () => {
  let text = '';
  const stream = new Writable({ write(c, _e, cb) { text += String(c); cb(); } });
  return { stream, text: () => text, lines: () => text.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>) };
};

export async function supportHarness(): Promise<SupportHarness> {
  const clock = fakeClock({ now: NOW_MS });
  const logs = logSink();
  const calls: OpsCall[] = [];
  const notices: Array<{ appealId: string; accountId: string; event: string; result?: string }> = [];
  let responder: (call: OpsCall) => OpsAnswer | Promise<OpsAnswer> = () => ({ status: 200, body: { result: 'OBJECTED' } });
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += String(c); });
    req.on('end', () => {
      const md: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) md[k] = Array.isArray(v) ? v.join(',') : String(v ?? '');
      const call: OpsCall = { method: req.method ?? '', path: req.url ?? '', md, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
      calls.push(call);
      Promise.resolve(responder(call)).then(
        (a) => { res.writeHead(a.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(a.body ?? {})); },
        () => { res.writeHead(500); res.end('{}'); },
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const support = { fraudAppeals: { url: `http://127.0.0.1:${port}`, token: INTERNAL, caller: 'core-svc' }, notifier: { async send(i: (typeof notices)[number]) { notices.push(i); } } };
  const svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, support: support as never } as never),
    env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: INTERNAL },
    clock,
    logDestination: logs.stream,
    adminAuthz: new FakeIdentity(),
  });
  let kitValue: CoreSupportKit | undefined;
  const kit = () => {
    if (kitValue) return kitValue;
    let raw: unknown;
    try {
      raw = svc.app.get(SUPPORT_KIT);
    } catch {
      raw = undefined;
    }
    if (!raw) throw new Error('core-svc support 키트가 없다(계획 §4, 구현 전)');
    kitValue = raw as CoreSupportKit;
    return kitValue;
  };
  const parse = (payload: string): Record<string, unknown> => (payload ? (JSON.parse(payload) as Record<string, unknown>) : {});
  const hdr = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });
  return {
    svc,
    clock,
    logs,
    calls,
    notices,
    answer(a) { responder = typeof a === 'function' ? a : () => a; },
    fanHeaders: (accountId) => fan(accountId ?? randomUUID()),
    async post(h, body) {
      const r = await svc.http.inject({ method: 'POST', url: '/v1/appeals', headers: hdr(h), payload: JSON.stringify(body) });
      return { status: r.statusCode, body: parse(r.payload), ...(typeof r.headers.location === 'string' ? { location: r.headers.location } : {}), headers: r.headers as Record<string, unknown> };
    },
    async myAppeals(h) {
      const r = await svc.http.inject({ method: 'GET', url: '/v1/appeals', headers: h });
      return { status: r.statusCode, body: parse(r.payload), headers: r.headers as Record<string, unknown> };
    },
    async restriction(h) {
      const r = await svc.http.inject({ method: 'GET', url: '/v1/booking-restrictions/me', headers: h });
      return { status: r.statusCode, body: parse(r.payload), headers: r.headers as Record<string, unknown> };
    },
    async fraudAppeals(h) {
      const r = await svc.http.inject({ method: 'GET', url: '/v1/fraud-appeal-requests', headers: h });
      return { status: r.statusCode, body: parse(r.payload), headers: r.headers as Record<string, unknown> };
    },
    async internalGet(appealId, token = INTERNAL) {
      const r = await svc.http.inject({ method: 'GET', url: `/internal/v1/appeals/${appealId}`, ...(token ? { headers: { 'x-peaket-internal-token': token } } : {}) });
      return { status: r.statusCode, body: parse(r.payload) };
    },
    async internalResult(appealId, body, token = INTERNAL) {
      const r = await svc.http.inject({ method: 'POST', url: `/internal/v1/appeals/${appealId}/result`, headers: { 'content-type': 'application/json', ...(token ? { 'x-peaket-internal-token': token } : {}) }, payload: JSON.stringify(body) });
      return { status: r.statusCode, body: parse(r.payload) };
    },
    async dispatch(nowMs) {
      await kit().dispatchOnce(nowMs ?? clock.now());
    },
    kit,
    close: async () => {
      await svc.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export const ACTIVE_VIEW = (o: { accountId: string; restrictionId?: string; reasonCode?: string; appealDueAtMs?: number; status?: 'ACTIVE' | 'LIFTED' }) => ({
  accountId: o.accountId,
  restrictionId: o.restrictionId ?? randomUUID(),
  state: o.status ?? 'ACTIVE',
  reasonCode: o.reasonCode ?? 'ABUSE_CANCEL',
  startsAtMs: NOW_MS - 3_600_000,
  endsAtMs: NOW_MS + 30 * 86_400_000,
  appealDueAtMs: o.appealDueAtMs ?? NOW_MS + 86_400_000,
  version: 1,
});

export const FRAUD_VIEW = (o: { accountId: string; caseId?: string; party?: 'PAYER' | 'HOLDER'; dueAtMs?: number; heldTicketIds?: string[]; reasonCategories?: string[] }) => ({
  accountId: o.accountId,
  caseId: o.caseId ?? randomUUID(),
  eventId: randomUUID(),
  party: o.party ?? 'PAYER',
  dueAtMs: o.dueAtMs ?? NOW_MS + 2 * 86_400_000,
  reasonCategories: o.reasonCategories ?? ['MACRO_BOT'],
  heldTicketIds: o.heldTicketIds ?? [],
  excludedTicketIds: [],
  lockedTicketIds: [],
  state: 'OPEN',
  version: 1,
});

export const problemType = (b: Record<string, unknown>): string => String(b.type ?? '').split('/').pop() ?? '';

/** 소명 하나를 접수하고 그 응답을 돌려준다(201 기대) */
export async function submit(h: SupportHarness, o: { accountId: string; kind: 'RESTRICTION' | 'FRAUD_CASE'; targetId: string; body?: string }) {
  const r = await h.post(h.fanHeaders(o.accountId), { kind: o.kind, targetId: o.targetId, body: o.body ?? '사정을 설명합니다. 표를 사려고 했습니다-시험7732' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r;
}
