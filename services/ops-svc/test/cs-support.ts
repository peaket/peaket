// CS 처리함 시험 공용 도우미(F-06-2 GAT-280, 시험 담당 lane3-f062-test).
// 실제 ops-svc 조립(AppModule.register)을 메모리 저장소로 띄우고, 내부 HTTP·관제 HTTP를 실제 Fastify 경로로 부른다(가짜 경로 없음).
// 공휴일은 시험이 만든 날(2026-11-25 수, 2026-12-03·04 목·금)이다. 실제 공휴일에 기대지 않는다.
import 'reflect-metadata';
import { createService, fakeClock, type FakeClock } from '@peaket/platform';
import { Writable } from 'node:stream';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { PromCsCaseSignals, parseHolidayCalendar, type CsCaseKit, type CsCaseKind } from '../src/modules/cases/index.js';
import { FakeAdminIdentity } from './admin-support.js';
import { FakeIdentity } from './support.js';

export const HOLIDAYS = ['2026-11-25', '2026-12-03', '2026-12-04'] as const;
export const testCalendar = () => parseHolidayCalendar(JSON.stringify(HOLIDAYS));

/** 금 2026-11-20 23:30 KST(14:30Z). 이 시각에서 위 달력으로 손으로 센 1·3·10영업일(같은 KST 시각) */
export const BASE_ISO = '2026-11-20T14:30:00.000Z';
export const BD1 = '2026-11-23T14:30:00.000Z';
export const BD3 = '2026-11-26T14:30:00.000Z';
export const BD10 = '2026-12-09T14:30:00.000Z';

export type OpsRole = 'viewer' | 'operator' | 'commander' | 'cs_agent' | 'cs_lead';

/** 요청 로그 줄을 모은다(403·404가 요청 로그에 남는지, ASVS 16.3.2) */
export function logSink(): { stream: Writable; lines: () => Array<Record<string, unknown>> } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(c, _e, cb) {
      chunks.push(String(c));
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

export interface CsHarness {
  readonly svc: Awaited<ReturnType<typeof createService>>;
  readonly clock: FakeClock;
  readonly identity: FakeIdentity;
  readonly admins: FakeAdminIdentity;
  readonly audit: MemoryAuditChain;
  readonly logs: ReturnType<typeof logSink>;
  /** 실제 조립이 만든 CS 부품(지급·대사·KYC 건처럼 이 기능이 받지 않는 종류를 저장소로 직접 연다) */
  readonly kit: CsCaseKit;
  /** 관제 세션 머리(역할) */
  as(role: OpsRole): Record<string, string>;
  intake(body: unknown): Promise<{ status: number; body: { accepted: boolean; caseId?: string } }>;
  list(h: Record<string, string>, query?: string): Promise<{ status: number; body: Record<string, unknown> }>;
  get(h: Record<string, string>, caseId: string): Promise<{ status: number; etag: string | undefined; body: Record<string, unknown> }>;
  patch(h: Record<string, string>, caseId: string, body: unknown, ifMatch?: string): Promise<{ status: number; etag: string | undefined; body: Record<string, unknown> }>;
  /** ops_cs_case_requests_total{kind,result} 값 */
  requests(kind: string, result: string): Promise<number>;
  /** 지급 건처럼 받는 종류 밖의 건을 실제 저장소로 연다 */
  seed(kind: CsCaseKind, targetRef: string, due?: { progressDueAtMs?: number | null; resultDueAtMs?: number | null }): Promise<string>;
  close(): Promise<void>;
}

/** 추가 검증 이의 포트(F-06-7 계획 §4 AppModule.register의 csAppeals). 이 시험 묶음은 cs-appeal-support.ts가 실제 gRPC 클라이언트로 채운다 */
type CsAppealsWiring = NonNullable<Parameters<typeof AppModule.register>[0]['csAppeals']>;

export async function csHarness(o: { nowIso?: string; csAppeals?: CsAppealsWiring; registerSignals?: (registry: Awaited<ReturnType<typeof createService>>['metrics']['registry']) => void } = {}): Promise<CsHarness> {
  const clock = fakeClock({ now: Date.parse(o.nowIso ?? BASE_ISO) });
  const identity = new FakeIdentity();
  const admins = new FakeAdminIdentity();
  const audit = new MemoryAuditChain();
  const logs = logSink();
  const signals = new PromCsCaseSignals();
  const svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, auditChain: audit, calendar: testCalendar(), caseSignals: signals, adminAccounts: { identity: admins }, ...(o.csAppeals ? { csAppeals: o.csAppeals } : {}) }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: logs.stream,
    adminAuthz: identity,
  });
  signals.register(svc.metrics.registry);
  o.registerSignals?.(svc.metrics.registry);
  const kit = svc.app.get<CsCaseKit>(Symbol.for('peaket.ops.cs-case-kit'));
  const parse = (payload: string): Record<string, unknown> => (payload ? (JSON.parse(payload) as Record<string, unknown>) : {});
  const etagOf = (h: Record<string, unknown>): string | undefined => (typeof h.etag === 'string' ? h.etag : undefined);
  let seq = 0;
  return {
    svc,
    clock,
    identity,
    admins,
    audit,
    logs,
    kit,
    as: (role) => identity.ops(role),
    async intake(body) {
      const r = await svc.http.inject({ method: 'POST', url: '/internal/v1/cs-cases', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
      return { status: r.statusCode, body: parse(r.payload) as { accepted: boolean; caseId?: string } };
    },
    async list(h, query = '') {
      const r = await svc.http.inject({ method: 'GET', url: `/v1/ops/cases${query ? `?${query}` : ''}`, headers: h });
      return { status: r.statusCode, body: parse(r.payload) };
    },
    async get(h, caseId) {
      const r = await svc.http.inject({ method: 'GET', url: `/v1/ops/cases/${caseId}`, headers: h });
      return { status: r.statusCode, etag: etagOf(r.headers), body: parse(r.payload) };
    },
    async patch(h, caseId, body, ifMatch) {
      const r = await svc.http.inject({
        method: 'PATCH',
        url: `/v1/ops/cases/${caseId}`,
        headers: { ...h, 'content-type': 'application/json', ...(ifMatch !== undefined ? { 'if-match': ifMatch } : {}) },
        payload: JSON.stringify(body),
      });
      return { status: r.statusCode, etag: etagOf(r.headers), body: parse(r.payload) };
    },
    async requests(kind, result) {
      const text = await svc.metrics.registry.metrics();
      const line = text.split('\n').find((l) => l.startsWith('ops_cs_case_requests_total{') && l.includes(`kind="${kind}"`) && l.includes(`result="${result}"`));
      return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : 0;
    },
    async seed(kind, targetRef, due = {}) {
      const c = await kit.store.open({
        caseId: `0194f062-0000-7000-8000-${String(++seq).padStart(12, '0')}`,
        kind,
        targetRef,
        nowMs: clock.now(),
        ...(due.progressDueAtMs !== undefined ? { progressDueAtMs: due.progressDueAtMs } : {}),
        ...(due.resultDueAtMs !== undefined ? { resultDueAtMs: due.resultDueAtMs } : {}),
      });
      return c.caseId;
    },
    close: () => svc.close(),
  };
}

/** 받는 종류(ADR-0364 결정 4의 아홉과 ADR-0368 결정 5의 정산 이의)의 요청 본문(asyncapi CaseRequested 모양). 대상·eventKey는 부를 때마다 새로 만든다 */
export function caseRequest(kind: CsCaseKind, o: { sourceId?: string; eventKey?: string; category?: string; createdAt?: string; dueBaseAt?: string } = {}) {
  return {
    eventKey: o.eventKey ?? crypto.randomUUID(),
    kind,
    sourceId: o.sourceId ?? crypto.randomUUID(),
    category: o.category ?? '',
    createdAt: o.createdAt ?? BASE_ISO,
    ...(o.dueBaseAt !== undefined ? { dueBaseAt: o.dueBaseAt } : {}),
  };
}
