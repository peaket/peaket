// 정규 로그 줄: 요청 1건에 1줄(ADR-0069 결정 11, docs/observability.md §6·§7, openspec 변경 add-service-logging 결정 2·3).
import 'reflect-metadata';
import { STATUS_CODES } from 'node:http';
import { FASTIFY_ROUTE_CONFIG_METADATA } from '@nestjs/platform-fastify/constants.js';
import { requestContext } from './context.js';
import type { PlatformLogger } from './log.js';
import { ProblemError } from './problem.js';
import type { LogPseudonymizer } from './pseudonym.js';
import { sampleThreshold } from './sampling.js';

export type QueuePhase = 'lobby' | 'waiting' | 'purchase';
const QUEUE_PHASES: readonly string[] = ['lobby', 'waiting', 'purchase'];

/** 처리기가 정규 로그 줄에 더하는 값 */
export interface RequestLogFields {
  /** 회차 ID(경로 매개변수 eventId가 있으면 자동으로 든다) */
  eventId?: string;
  /** 결제사(toss·portone) */
  pg?: string;
  queuePhase?: QueuePhase;
  /** 켜진 릴리스 플래그와 Degraded Mode 이름 */
  flags?: readonly string[];
  commandId?: string;
  orderId?: string;
}

export interface RequestLog {
  set(fields: RequestLogFields): void;
  /** 원문 식별값을 로그 가명(pidRef·sidRef·accountRef)으로 바꿔 넣는다. 원문은 남지 않는다 */
  identify(ids: { pid?: string; sessionId?: string; accountId?: string }): void;
  /** 의존성 소요(ms)를 이름마다 더한다(dep) */
  dependency(name: string, ms: number): void;
  /** 이 요청의 줄을 표본과 관계없이 남긴다('곧 입장' 완충 응답 등, sampleRate 1) */
  keep(): void;
}

const SHORT = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const DEP_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_FLAGS = 32;

/** 요청 하나의 더할 값. 잘못된 값은 버린다(로그 때문에 처리기가 실패하지 않게) */
export class RequestLogState implements RequestLog {
  readonly fields: { -readonly [K in keyof RequestLogFields]: RequestLogFields[K] } = {};
  readonly refs: { pidRef?: string; sidRef?: string; accountRef?: string } = {};
  readonly dep = new Map<string, number>();
  forceKeep = false;

  constructor(private readonly pseudonymizer: LogPseudonymizer) {}

  set(f: RequestLogFields): void {
    if (SHORT(f.eventId, 128)) this.fields.eventId = f.eventId;
    if (SHORT(f.pg, 32)) this.fields.pg = f.pg;
    if (typeof f.queuePhase === 'string' && QUEUE_PHASES.includes(f.queuePhase)) this.fields.queuePhase = f.queuePhase;
    if (Array.isArray(f.flags)) this.fields.flags = f.flags.filter((x) => SHORT(x, 64)).slice(0, MAX_FLAGS);
    if (SHORT(f.commandId, 128)) this.fields.commandId = f.commandId;
    if (SHORT(f.orderId, 128)) this.fields.orderId = f.orderId;
  }

  identify(ids: { pid?: string; sessionId?: string; accountId?: string }): void {
    if (SHORT(ids.pid, 1024)) this.refs.pidRef = this.pseudonymizer.ref(ids.pid);
    if (SHORT(ids.sessionId, 1024)) this.refs.sidRef = this.pseudonymizer.ref(ids.sessionId);
    if (SHORT(ids.accountId, 1024)) this.refs.accountRef = this.pseudonymizer.ref(ids.accountId);
  }

  dependency(name: string, ms: number): void {
    if (!DEP_NAME.test(name) || !Number.isFinite(ms) || ms < 0) return;
    this.dep.set(name, (this.dep.get(name) ?? 0) + ms);
  }

  keep(): void {
    this.forceKeep = true;
  }
}

const NOOP: RequestLog = { set() {}, identify() {}, dependency() {}, keep() {} };

/** 지금 요청의 정규 로그 줄. 요청 밖이면 아무것도 하지 않는다 */
export function requestLog(): RequestLog {
  return requestContext()?.log ?? NOOP;
}

/** 경로마다의 로그 정책 */
export interface RouteLogPolicy {
  /** 진입 경로(gw-queue의 머리 표본 경로, ADR-0125 결정 1). 403·429를 정상 줄처럼 줄이고 머리 표본의 정상 줄을 남긴다 */
  entry?: boolean;
  /** 이 경로의 SLO 지연(ms). 넘은 요청은 전수로 남긴다. 없으면 서비스 기본값(NFR-011 500ms) */
  sloLatencyMs?: number;
}

export const ROUTE_POLICY_KEY = 'peaketLog';

/** 처리기에 단다: @LogPolicy({ entry: true }). Fastify 경로 설정(config)에 들어간다 */
export function LogPolicy(policy: RouteLogPolicy): MethodDecorator {
  if (policy.sloLatencyMs !== undefined && !(Number.isInteger(policy.sloLatencyMs) && policy.sloLatencyMs > 0)) {
    throw new RangeError(`sloLatencyMs는 양의 정수(ms)여야 한다: ${policy.sloLatencyMs}`);
  }
  return (_target, _key, descriptor) => {
    const fn = descriptor.value as object;
    const prev = (Reflect.getMetadata(FASTIFY_ROUTE_CONFIG_METADATA, fn) as Record<string, unknown> | undefined) ?? {};
    Reflect.defineMetadata(FASTIFY_ROUTE_CONFIG_METADATA, { ...prev, [ROUTE_POLICY_KEY]: { ...policy } }, fn);
    return descriptor;
  };
}

export function routePolicyOf(config: unknown): RouteLogPolicy {
  const p = (config as Record<string, unknown> | undefined)?.[ROUTE_POLICY_KEY];
  return p && typeof p === 'object' ? (p as RouteLogPolicy) : {};
}

/** 정규 로그 줄의 err */
export interface ErrorInfo {
  type: string;
  message: string;
  stack?: string;
}

/**
 * 오류를 err로 바꾼다. 스택은 5xx에만 남긴다.
 * 이름 없는 4xx는 원래 메시지를 쓰지 않는다(JSON 해석 오류에는 본문 일부, Nest 404에는 쿼리가 들어간다)
 */
export function errorInfoOf(exception: unknown, status: number): ErrorInfo {
  const e = exception instanceof Error ? exception : undefined;
  if (exception instanceof ProblemError) {
    return status >= 500 && e?.stack ? { type: exception.slug, message: exception.title, stack: e.stack } : { type: exception.slug, message: exception.title };
  }
  if (status >= 500) {
    if (!e) return { type: typeof exception, message: String(exception) };
    return e.stack ? { type: e.name, message: e.message, stack: e.stack } : { type: e.name, message: e.message };
  }
  const code = (exception as { code?: unknown } | null)?.code;
  const type = typeof code === 'string' && code.startsWith('FST_') ? code : (e?.name ?? 'Error');
  return { type, message: STATUS_CODES[status] ?? 'Error' };
}

/** 줄 하나를 만들 재료 */
export interface LineInput {
  traceId: string;
  spanId?: string;
  route: string;
  method: string;
  status?: number;
  durationMs?: number;
  app?: string;
  client?: string;
  eventIdParam?: string;
  aborted?: boolean;
  normalBranch?: boolean;
  error?: ErrorInfo;
  state?: RequestLogState;
  policy: RouteLogPolicy;
  /** 요청을 받을 때 정한 표본(서버 span의 peaket.sample.keep과 같다) */
  sample: { oneIn: number; thresholdKeep: boolean; headSampled: boolean };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** 서비스마다 하나. 정규 로그 줄의 표본과 모양을 정하고 쓴다 */
export class CanonicalLog {
  #oneIn: number;

  constructor(
    private readonly logger: PlatformLogger,
    private readonly o: { sampleOneIn: number; defaultSloLatencyMs: number; pseudonymizer: LogPseudonymizer },
  ) {
    sampleThreshold(o.sampleOneIn);
    this.#oneIn = o.sampleOneIn;
  }

  get sampleOneIn(): number {
    return this.#oneIn;
  }

  /** 정상 줄 표본 비율 'N건에 1건'을 바꾼다(온세일 1%면 100) */
  setSampleOneIn(oneIn: number): void {
    sampleThreshold(oneIn);
    this.#oneIn = oneIn;
  }

  newState(): RequestLogState {
    return new RequestLogState(this.o.pseudonymizer);
  }

  /**
   * sampleRate: 4xx·5xx(진입 경로의 403·429 제외), SLO 지연 초과, keep()은 1. 문턱 안의 정상 줄은 N.
   * 진입 경로의 머리 표본만으로 남긴 줄은 0(다시 셀 때 더하지 않는다). 남기지 않으면 undefined
   */
  sampleRateOf(i: LineInput): number | undefined {
    const entryRejection = i.policy.entry === true && (i.status === 403 || i.status === 429);
    const errorStatus = i.status !== undefined && i.status >= 400 && !entryRejection;
    const slo = i.policy.sloLatencyMs ?? this.o.defaultSloLatencyMs;
    const slow = i.durationMs !== undefined && i.durationMs > slo;
    if (errorStatus || slow || i.state?.forceKeep) return 1;
    if (i.sample.thresholdKeep) return i.sample.oneIn;
    if (i.sample.headSampled) return 0;
    return undefined;
  }

  write(i: LineInput): void {
    const sampleRate = this.sampleRateOf(i);
    if (sampleRate === undefined) return;
    const line: Record<string, unknown> = { traceId: i.traceId };
    if (i.spanId) line.spanId = i.spanId;
    const eventId = i.state?.fields.eventId ?? i.eventIdParam;
    if (eventId) line.eventId = eventId;
    line.route = i.route;
    line.method = i.method;
    if (i.status !== undefined) line.status = i.status;
    if (i.aborted) line.aborted = true;
    if (i.durationMs !== undefined) line.durationMs = round3(i.durationMs);
    if (i.app) line.app = i.app;
    if (i.client) line.client = i.client;
    const f = i.state?.fields;
    if (f?.pg) line.pg = f.pg;
    if (f?.queuePhase) line.queuePhase = f.queuePhase;
    if (f?.flags?.length) line.flags = f.flags;
    if (f?.commandId) line.commandId = f.commandId;
    if (f?.orderId) line.orderId = f.orderId;
    if (i.state) Object.assign(line, i.state.refs);
    if (i.state?.dep.size) line.dep = Object.fromEntries([...i.state.dep].map(([k, v]) => [k, round3(v)]));
    line.sampleRate = sampleRate;
    if (i.error) line.err = i.error;

    const status = i.status ?? 0;
    const level = status >= 500 ? 'error' : status >= 400 && !i.normalBranch ? 'warn' : 'info';
    this.logger[level](line, i.aborted ? 'request aborted' : 'request');
  }
}
