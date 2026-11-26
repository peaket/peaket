// 추가 검증 이의 처리(F-06-7 GAT-280, B-T28·B-T10 ③④⑥·Q-T48 ②) 시험 공용 도우미. 시험 담당 lane3-f067-test.
// - 받는 쪽 셋(queue-svc VerificationAppealService, trust-svc TrustLabelService·TrustEvidenceService, identity-svc AccountHoldService)을
//   정본 설명자(@peaket/contracts/proto)로 띄운 **실제 gRPC 서버**로 둔다. 서버는 받은 요청·메타데이터를 적고, 시험이 정한 답이나 gRPC 상태를 준다
//   (업무 로직 가짜가 아니라 바깥 서비스 경계의 대역이다. 실제 queue·trust·identity 처리기와의 짝은 test-int/verification-appeal.int.test.ts가 본다).
// - ops-svc 쪽은 시작 조립과 같은 csAppealPortsFromEnv(env)로 만든 **실제 gRPC 클라이언트**를 AppModule.register({ memory: true, csAppeals })에 넣는다.
// - 아직 없는 구현 파일(cs-appeal-wiring.ts)·내보냄(CsCaseDispatchJob·PromCsDispatchSignals)은 늦게 가져온다. 구현 전 트리에서는 조립이 csAppeals 없이 서고
//   시험이 행동(경로 404·호출 0번·칸 없음)으로 실패한다(계획 §8 '세는 실패는 행동 실패다').
// 정본: docs/features/bot-defense.md §12 'CS 처리 첫 구현', docs/api/proto/peaket/{queue,trust,identity}/v1/*.proto, openapi CsCaseDetail.verificationAppeal.
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity, queueV1Queue, trustV1Trust } from '@peaket/contracts/proto';
import { startGrpcServer, type StartedGrpcServer } from '@peaket/platform';
import { expect } from 'vitest';
import { OPS_ALERT_STORE, type MemoryOpsAlertStore } from '../src/modules/alerts/index.js';
import * as casesModule from '../src/modules/cases/index.js';
import { caseRequest, csHarness, type CsHarness, type OpsRole } from './cs-support.js';

const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Def = Parameters<typeof protoLoader.fromJSON>[0];
type Ctor = grpc.ServiceClientConstructor;
// type-escape: loadPackageDefinition의 반환은 이름을 모르는 중첩 객체라 쓰는 서비스 생성자만 이 모양으로 묶는다 F-06-7
const queuePkg = (grpc.loadPackageDefinition(protoLoader.fromJSON(queueV1Queue as Def, LOAD)) as unknown as { peaket: { queue: { v1: { VerificationAppealService: Ctor } } } }).peaket.queue.v1;
// type-escape: 위와 같은 까닭 F-06-7
const trustPkg = (grpc.loadPackageDefinition(protoLoader.fromJSON(trustV1Trust as Def, LOAD)) as unknown as { peaket: { trust: { v1: { TrustLabelService: Ctor; TrustEvidenceService: Ctor } } } }).peaket.trust.v1;
// type-escape: 위와 같은 까닭 F-06-7
const identityPkg = (grpc.loadPackageDefinition(protoLoader.fromJSON(identityV1Identity as Def, LOAD)) as unknown as { peaket: { identity: { v1: { AccountHoldService: Ctor } } } }).peaket.identity.v1;

/** gRPC 답: 값 또는 상태 코드 */
export type GrpcAnswer = { readonly value: Record<string, unknown> } | { readonly code: grpc.status };
export type Responder = (req: Record<string, unknown>) => GrpcAnswer | Promise<GrpcAnswer>;

export interface StubCall {
  readonly method: string;
  readonly req: Record<string, unknown>;
  /** 메타데이터(소문자 이름 → 값) */
  readonly md: Record<string, string>;
}

/** 시험이 정한 답이나 상태를 주고 받은 요청을 적는 gRPC 서비스 대역 하나(같은 서버의 서비스 여럿을 묶는다) */
export class StubService {
  readonly calls: StubCall[] = [];
  readonly #defaults: Record<string, Responder>;
  readonly #once = new Map<string, Responder[]>();
  readonly #set = new Map<string, Responder>();
  readonly #guard?: (md: Record<string, string>) => grpc.status | null;

  constructor(defaults: Record<string, Responder>, guard?: (md: Record<string, string>) => grpc.status | null) {
    this.#defaults = defaults;
    this.#guard = guard;
  }

  /** 받은 그 메서드의 요청 본문(차례대로) */
  of(method: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.req);
  }

  count(method: string): number {
    return this.of(method).length;
  }

  /** 다음 몇 번의 답(차례대로 한 번씩 쓴다) */
  next(method: string, ...answers: Array<GrpcAnswer | Responder>): void {
    const q = this.#once.get(method) ?? [];
    for (const a of answers) q.push(typeof a === 'function' ? a : () => a);
    this.#once.set(method, q);
  }

  /** 되돌릴 때까지 늘 이 답 */
  set(method: string, answer: GrpcAnswer | Responder): void {
    this.#set.set(method, typeof answer === 'function' ? answer : () => answer);
  }

  /** 그 메서드(없으면 모두)를 이 상태로 답하게 한다(서비스가 멈춘 것과 같은 답) */
  fail(code: grpc.status, method?: string): void {
    for (const m of method ? [method] : Object.keys(this.#defaults)) this.set(m, { code });
  }

  /** 기본 답으로 되돌린다 */
  restore(method?: string): void {
    for (const m of method ? [method] : Object.keys(this.#defaults)) {
      this.#set.delete(m);
      this.#once.delete(m);
    }
  }

  handlers(methods: readonly string[]): grpc.UntypedServiceImplementation {
    const out: grpc.UntypedServiceImplementation = {};
    for (const m of methods) {
      const h: grpc.handleUnaryCall<Record<string, unknown>, Record<string, unknown>> = (call, cb) => {
        const md: Record<string, string> = {};
        for (const [k, v] of Object.entries(call.metadata.getMap())) md[k] = String(v);
        this.calls.push({ method: m, req: call.request, md });
        const denied = this.#guard?.(md);
        if (denied !== null && denied !== undefined) return cb({ code: denied, details: '시험 대역이 정한 신원 거절' });
        const once = this.#once.get(m);
        const r = once?.length ? once.shift()! : (this.#set.get(m) ?? this.#defaults[m]!);
        Promise.resolve()
          .then(() => r(call.request))
          .then(
            (a) => ('code' in a ? cb({ code: a.code, details: '시험 대역이 정한 상태' }) : cb(null, a.value)),
            () => cb({ code: grpc.status.INTERNAL, details: '시험 대역 오류' }),
          );
      };
      out[m] = h;
    }
    return out;
  }
}

/** queue.proto GetVerificationAppealResponse에 싣는 이의 내용(시험 값) */
export interface AppealFixture {
  appealId: string;
  eventId: string;
  accountId: string;
  pid: string;
  text: string;
  /** trust.proto ReasonCategory 이름(REASON_CATEGORY_…) */
  reasonCategory: string;
  receivedAtIso: string;
  /** queue.proto AppealEntryState 이름 */
  entryState: string;
}

let fixtureSeq = 0;
/** 이의 하나. 글에는 태그 꼴 글자를 섞어 둔다(화면이 글자로만 그리는지 보려고) */
export function appealFixture(o: Partial<AppealFixture> = {}): AppealFixture {
  fixtureSeq += 1;
  return {
    appealId: randomUUID(),
    eventId: randomUUID(),
    accountId: randomUUID(),
    pid: `pid-f067-${fixtureSeq}-${randomUUID().slice(0, 8)}`,
    text: '사람입니다. <b>재검토</b> 부탁드립니다 😀',
    reasonCategory: 'REASON_CATEGORY_DEVICE_HISTORY',
    receivedAtIso: '2026-11-20T14:10:00.000Z',
    entryState: 'APPEAL_ENTRY_STATE_VERIFYING',
    ...o,
  };
}

const ts = (iso: string) => {
  const ms = Date.parse(iso);
  return { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 };
};

/** 판정 근거(trust.proto GetVerdictEvidenceResponse) 시험 값. 프로필 판은 응답에 새면 바로 보이게 드문 수로 둔다 */
export const EVIDENCE = {
  reason: 'REASON_CATEGORY_DEVICE_HISTORY',
  hardSignal: 'HARD_SIGNAL_BLOCK_LIST',
  source: 'EVIDENCE_SOURCE_REALTIME',
  decidedAtIso: '2026-11-20T13:58:07.250Z',
  profileVersion: 918_273,
  sent: 11,
  passed: 3,
  failed: 7,
} as const;

export const evidenceAnswer = (o: Partial<Record<keyof typeof EVIDENCE, string | number>> = {}): Record<string, unknown> => {
  const e = { ...EVIDENCE, ...o };
  return {
    found: true,
    reason: e.reason,
    hard_signal: e.hardSignal,
    source: e.source,
    decided_at: ts(String(e.decidedAtIso)),
    profile_version: e.profileVersion,
    device_challenges_sent: e.sent,
    device_challenges_passed: e.passed,
    device_challenges_failed: e.failed,
  };
};

export interface AppealStubs {
  readonly queue: StubService;
  readonly trust: StubService;
  readonly identity: StubService;
  /** queue-svc 대역이 가진 이의 내용(이의 ID → 내용). 없으면 GetVerificationAppeal이 NOT_FOUND다 */
  readonly appeals: Map<string, AppealFixture>;
  /** trust-svc 대역의 판정 근거(pid → 답). 없으면 evidenceAnswer() */
  readonly evidence: Map<string, Record<string, unknown>>;
  /** trust-svc 대역의 ApplyLabel block_list(pid → BlockListChange 이름). 없으면 BLOCK_LIST_CHANGE_REMOVED */
  readonly blockList: Map<string, string>;
  readonly addresses: { readonly queue: string; readonly trust: string; readonly identity: string };
  close(): Promise<void>;
}

export async function startAppealStubs(): Promise<AppealStubs> {
  const appeals = new Map<string, AppealFixture>();
  const evidence = new Map<string, Record<string, unknown>>();
  const blockList = new Map<string, string>();
  const queue = new StubService({
    GetVerificationAppeal: (req) => {
      const a = appeals.get(String(req.appeal_id));
      if (!a) return { code: grpc.status.NOT_FOUND };
      return {
        value: {
          appeal_id: a.appealId,
          event_id: a.eventId,
          account_id: a.accountId,
          pid: a.pid,
          text: a.text,
          reason_category: a.reasonCategory,
          received_at: ts(a.receivedAtIso),
          entry_state: a.entryState,
        },
      };
    },
    ResolveVerificationAppeal: () => ({ value: { result: 'RESOLVE_APPEAL_RESULT_APPLIED' } }),
  });
  // 받는 쪽 검사와 같은 답(시험 리뷰 1 TR-02): trust ApplyLabel·GetVerdictEvidence는 회차·pid가 비면 INVALID_ARGUMENT
  // (trust-svc apply-label.ts·evidence.ts의 '영문·숫자·_·- 1~64자'), identity SetAccountHold는 계정·건이 UUID가 아니면 INVALID_ARGUMENT(set-account-hold.ts)
  const filled = (v: unknown) => typeof v === 'string' && v.length > 0;
  const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  const trust = new StubService({
    ApplyLabel: (req) =>
      !filled(req.pid) || !filled(req.event_id) ? { code: grpc.status.INVALID_ARGUMENT } : { value: { changed: true, block_list: blockList.get(String(req.pid)) ?? 'BLOCK_LIST_CHANGE_REMOVED' } },
    GetVerdictEvidence: (req) => (!filled(req.pid) || !filled(req.event_id) ? { code: grpc.status.INVALID_ARGUMENT } : { value: evidence.get(String(req.pid)) ?? evidenceAnswer() }),
  });
  const identity = new StubService({ SetAccountHold: (req) => (!uuid(req.account_id) || !uuid(req.source_ref) ? { code: grpc.status.INVALID_ARGUMENT } : { value: { changed: true } }) });
  const servers: StartedGrpcServer[] = [];
  const start = async (services: Array<{ definition: grpc.ServiceDefinition; handlers: grpc.UntypedServiceImplementation }>) => {
    const s = await startGrpcServer({ host: '127.0.0.1', port: 0, profile: 'service', drainMs: 0, services });
    servers.push(s);
    return `127.0.0.1:${s.port}`;
  };
  const addresses = {
    queue: await start([{ definition: queuePkg.VerificationAppealService.service, handlers: queue.handlers(['GetVerificationAppeal', 'ResolveVerificationAppeal']) }]),
    trust: await start([
      { definition: trustPkg.TrustLabelService.service, handlers: trust.handlers(['ApplyLabel']) },
      { definition: trustPkg.TrustEvidenceService.service, handlers: trust.handlers(['GetVerdictEvidence']) },
    ]),
    identity: await start([{ definition: identityPkg.AccountHoldService.service, handlers: identity.handlers(['SetAccountHold']) }]),
  };
  return {
    queue,
    trust,
    identity,
    appeals,
    evidence,
    blockList,
    addresses,
    close: async () => {
      await Promise.all(servers.map((s) => s.close()));
    },
  };
}

/** 쓰지 않는 포트(연결 실패를 만들 때) */
export async function closedAddress(): Promise<string> {
  const s = await startGrpcServer({ host: '127.0.0.1', port: 0, profile: 'service', drainMs: 0, services: [] });
  await s.close();
  return `127.0.0.1:${s.port}`;
}

export interface AppealEnvOptions {
  readonly env?: string;
  /** false면 그 주소를 넣지 않는다. 글이면 그 주소를 넣는다 */
  readonly queue?: boolean | string;
  readonly trust?: boolean | string;
  readonly identity?: boolean | string;
  readonly token?: string;
}

export function appealEnv(stubs: Pick<AppealStubs, 'addresses'>, o: AppealEnvOptions = {}): Record<string, string> {
  const pick = (v: boolean | string | undefined, fallback: string) => (v === false ? undefined : typeof v === 'string' ? v : fallback);
  const env: Record<string, string> = { PEAKET_ENV: o.env ?? 'ci' };
  const q = pick(o.queue, stubs.addresses.queue);
  const t = pick(o.trust, stubs.addresses.trust);
  const i = pick(o.identity, stubs.addresses.identity);
  if (q) env.PEAKET_QUEUE_GRPC_URL = q;
  if (t) env.PEAKET_TRUST_GRPC_URL = t;
  if (i) env.PEAKET_IDENTITY_GRPC_URL = i;
  if (o.token) env.PEAKET_INTERNAL_GRPC_TOKEN = o.token;
  return env;
}

type Wiring = typeof import('../src/cs-appeal-wiring.js');
/** 시작 조립 파일(계획 §4 src/cs-appeal-wiring.ts). 구현 전에는 없다 */
export async function loadWiring(): Promise<Wiring | undefined> {
  try {
    return await import('../src/cs-appeal-wiring.js');
  } catch (err) {
    // 파일이 없을 때만 넘어간다(그 밖의 오류는 시험을 깨뜨린다)
    if (err instanceof Error && /Cannot find module|Failed to load url|ERR_MODULE_NOT_FOUND|Does the file exist/i.test(err.message)) return undefined;
    throw err;
  }
}

export interface AppealHarness extends CsHarness {
  readonly stubs: AppealStubs;
  readonly env: Record<string, string>;
  /** 배경 작업(CsCaseDispatchJob) 한 바퀴 */
  runDispatch(): Promise<void>;
  /** 시계를 ms만큼 옮기고 한 바퀴 */
  advanceAndRun(ms: number): Promise<void>;
  /** 이의 건을 내부 HTTP로 연다(내용은 queue 대역에 둔다. content false면 두지 않는다) */
  openAppeal(fx?: AppealFixture, o?: { content?: boolean; category?: string; eventKey?: string }): Promise<{ caseId: string; fx: AppealFixture }>;
  /** POST /v1/ops/cases/{caseId}/verification-appeal-decision. ifMatch·key가 null이면 그 머리를 싣지 않는다 */
  decide(h: Record<string, string>, caseId: string, body: unknown, o?: { ifMatch?: string | null; key?: string | null }): Promise<{ status: number; etag: string | undefined; body: Record<string, unknown> }>;
  /** 상세의 verificationAppeal */
  appealOf(caseId: string, role?: OpsRole): Promise<Record<string, unknown>>;
  /** 상세의 dispatch 줄 하나 */
  dispatchOf(caseId: string, call: string): Promise<Record<string, unknown> | undefined>;
  /** 그 건의 반영 실패 경보 */
  dispatchAlerts(caseId: string): Array<{ kind: string; severity: string; detail: Record<string, unknown>; open: boolean }>;
  /** ops_cs_case_dispatch_total{call,result} 값 */
  dispatchMetric(call: string, result: string): Promise<number>;
}

export async function appealHarness(o: { nowIso?: string; env?: AppealEnvOptions; background?: { csCaseDispatchMs?: number } } = {}): Promise<AppealHarness> {
  const stubs = await startAppealStubs();
  const env = appealEnv(stubs, o.env);
  const wiring = await loadWiring();
  const ports = wiring?.csAppealPortsFromEnv(env);
  const Signals = casesModule.PromCsDispatchSignals;
  const signals = Signals ? new Signals() : undefined;
  const csAppeals = ports
    ? {
        ...(ports.appeals ? { appeals: ports.appeals } : {}),
        ...(ports.labels ? { labels: ports.labels } : {}),
        ...(ports.evidence ? { evidence: ports.evidence } : {}),
        ...(ports.holds ? { holds: ports.holds } : {}),
        ...(signals ? { signals } : {}),
      }
    : undefined;
  const h = await csHarness({
    ...(o.nowIso ? { nowIso: o.nowIso } : {}),
    ...(csAppeals ? { csAppeals } : {}),
    ...(signals ? { registerSignals: (r) => signals.register(r) } : {}),
    ...(o.background ? { background: o.background } : {}),
  });
  const alerts = h.svc.app.get<MemoryOpsAlertStore>(OPS_ALERT_STORE);
  const parse = (payload: string): Record<string, unknown> => (payload ? (JSON.parse(payload) as Record<string, unknown>) : {});
  const runDispatch = async () => {
    const Job = casesModule.CsCaseDispatchJob;
    if (!Job) throw new Error('CsCaseDispatchJob이 cases 모듈에서 나오지 않는다(계획 §4 배경 작업)');
    await h.svc.app.get(Job).runOnce();
  };
  const appealOf = async (caseId: string, role: OpsRole = 'cs_agent') => {
    const r = await h.get(h.as(role), caseId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body.verificationAppeal ?? {}) as Record<string, unknown>;
  };
  return {
    ...h,
    stubs,
    env,
    runDispatch,
    async advanceAndRun(ms) {
      h.clock.advance(ms);
      await runDispatch();
    },
    async openAppeal(fx = appealFixture(), oo = {}) {
      if (oo.content !== false) stubs.appeals.set(fx.appealId, fx);
      const r = await h.intake(caseRequest('VERIFICATION_APPEAL', { sourceId: fx.appealId, category: oo.category ?? fx.reasonCategory, ...(oo.eventKey ? { eventKey: oo.eventKey } : {}) }));
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      return { caseId: r.body.caseId!, fx };
    },
    async decide(hdr, caseId, body, oo = {}) {
      const headers: Record<string, string> = { ...hdr, 'content-type': 'application/json' };
      if (oo.ifMatch !== null) headers['if-match'] = oo.ifMatch ?? '"1"';
      if (oo.key !== null) headers['idempotency-key'] = oo.key ?? randomUUID();
      const r = await h.svc.http.inject({ method: 'POST', url: `/v1/ops/cases/${caseId}/verification-appeal-decision`, headers, payload: JSON.stringify(body) });
      return { status: r.statusCode, etag: typeof r.headers.etag === 'string' ? r.headers.etag : undefined, body: parse(r.payload) };
    },
    appealOf,
    async dispatchOf(caseId, call) {
      const va = await appealOf(caseId);
      return ((va.dispatch ?? []) as Array<Record<string, unknown>>).find((d) => d.call === call);
    },
    dispatchAlerts(caseId) {
      return alerts.alerts
        .filter((a) => a.kind === 'CS_CASE_DISPATCH_FAILED' && a.detail.caseId === caseId)
        .map((a) => ({ kind: a.kind, severity: a.severity, detail: a.detail, open: a.resolvedAtMs === undefined }));
    },
    async dispatchMetric(call, result) {
      const text = await h.svc.metrics.registry.metrics();
      const line = text.split('\n').find((l) => l.startsWith('ops_cs_case_dispatch_total{') && l.includes(`call="${call}"`) && l.includes(`result="${result}"`));
      return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : 0;
    },
    async close() {
      await h.close();
      ports?.close();
      await stubs.close();
    },
  };
}

/** 정본 시험 값: 다시 보내기 간격(bot-defense §12 '다시 보내기': 10초에서 두 배씩 10분까지, 8번 뒤 반영 실패, 그 뒤 10분마다) */
export const RETRY = { firstMs: 10_000, capMs: 600_000, failAfter: 8 } as const;
/** n번째 실패(1부터) 뒤 다음 보내기까지 기다리는 시간(정본 규칙을 시험이 따로 센다: 10, 20, 40, 80, 160, 320, 600, 600 …초) */
export const waitAfterFailure = (n: number): number => Math.min(RETRY.firstMs * 2 ** (n - 1), RETRY.capMs);

/** 결정 뒤 곧바로 보내 보기가 그 호출에 한 번 닿을 때까지 기다린다(상세의 dispatch 시도 수로 본다) */
export async function untilAttempted(h: AppealHarness, caseId: string, calls: readonly string[], attempts = 1): Promise<void> {
  await expect
    .poll(async () => {
      const va = await h.appealOf(caseId);
      const rows = (va.dispatch ?? []) as Array<{ call: string; attempts: number }>;
      return calls.every((c) => (rows.find((r) => r.call === c)?.attempts ?? 0) >= attempts);
    }, { timeout: 10_000, interval: 50 })
    .toBe(true);
}

export const typeOf = (b: Record<string, unknown>): string => String(b.type ?? '').split('/').pop() ?? '';
export const NOTE = '근거가 차단 기기 목록이고 본인확인 재통과 기록이 있어 오탐으로 본다-메모7731';
