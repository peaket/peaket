// Fastify 훅: 요청 맥락 열기, 남은 시간 받기, 네 신호 재기, 정규 로그 줄 쓰기
// (openspec 변경 add-service-template 결정 2·4·5, add-service-logging 결정 2·3).
import { trace } from '@opentelemetry/api';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientFamily } from './client-family.js';
import type { Clock } from './clock.js';
import { type RequestContext, activeTrace, runInRequestContext } from './context.js';
import { DEADLINE_HEADER, Deadline, routeDeadlineMaxOf } from './deadline.js';
import type { HotPathMetrics } from './hot-path.js';
import { type PlatformMetrics, routeLabel, statusClass } from './metrics.js';
import { type CanonicalLog, type ErrorInfo, type LineInput, type RouteLogPolicy, routePolicyOf } from './request-log.js';
import { sampleKeep } from './sampling.js';

export interface RequestState {
  ctx: RequestContext;
  startedMs: number;
  /** Problem 필터가 정상 분기 Problem을 냈다 */
  normalBranch: boolean;
  /** Problem 필터가 정한 정규 로그 줄의 err */
  error?: ErrorInfo;
  /** 처리 중 게이지를 이미 내렸다(끊긴 요청과 응답이 겹쳐도 한 번만) */
  activeDone: boolean;
  /** 정규 로그 줄을 이미 썼다(응답과 끊김이 겹쳐도 한 줄만) */
  logged: boolean;
  /** 응답을 보내기 시작했다(onSend) */
  sent: boolean;
  /** 처리기가 끝나기 전에 연결이 끊겼다(줄은 onSend에서 쓴다) */
  aborted: boolean;
  /** 처리기 앞 훅(preHandler)을 지났다 */
  handlerStarted: boolean;
  /** preHandler에 닿은 단조 시각(계측, BAT-028) */
  preHandlerMs?: number;
  /** onSend에 닿은 단조 시각(계측, BAT-028) */
  onSendMs?: number;
  /** 연결이 끊겼을 때 부른다(close·onRequestAbort) */
  abort: () => void;
  /** 끊긴 뒤 처리기가 응답을 보내지 않을 때의 대비 타이머 */
  abortTimer?: ReturnType<typeof setTimeout>;
  policy: RouteLogPolicy;
  sample: LineInput['sample'];
  app?: string;
  client?: string;
  eventIdParam?: string;
}

const STATE = Symbol.for('peaket.platform.request-state');
type WithState = Record<symbol, RequestState | undefined>;

export function requestState(request: FastifyRequest | undefined): RequestState | undefined {
  return (request as unknown as WithState | undefined)?.[STATE];
}

/** 게이트웨이가 경로마다 넣는 화면 앱 이름(엣지에서 바깥 값을 지운 뒤, HOT-400) */
export const APP_HEADER = 'x-peaket-app';
export const APPS: readonly string[] = ['web', 'partner', 'console', 'scanner'];
const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** 끊긴 뒤 처리기를 기다리는 여유(남은 시간 뒤, 추천 적용 2026-11-01) */
export const ABORT_GRACE_MS = 1_000;

const header = (request: FastifyRequest, name: string): string | undefined => {
  const v = request.headers[name];
  return typeof v === 'string' ? v : undefined;
};

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;

/** 들어온 traceparent가 이 요청의 trace를 시작했고 표본 표시가 켜져 있는가(W3C Trace Context) */
export function incomingSampled(request: FastifyRequest, traceId: string): boolean {
  const m = TRACEPARENT.exec(header(request, 'traceparent')?.trim() ?? '');
  if (!m || m[1] === 'ff' || (m[1] === '00' && m[0].length !== 55)) return false;
  return m[2] === traceId && (Number.parseInt(m[4], 16) & 1) === 1;
}

/** 바깥(라우터 앞 오류 등)에서도 쓰는 요청 쪽 필드 */
export function requestSideFields(request: FastifyRequest): { app?: string; client?: string } {
  const app = header(request, APP_HEADER);
  return { app: app && APPS.includes(app) ? app : undefined, client: clientFamily(header(request, 'user-agent')) };
}

export function installHttpHooks(
  fastify: FastifyInstance,
  o: { metrics: PlatformMetrics; clock: Clock; maxDeadlineMs: number; canonical: CanonicalLog; hotPath?: HotPathMetrics },
): void {
  const { metrics, clock, canonical, hotPath } = o;
  const service = metrics.service;
  const release = (s: RequestState) => {
    if (s.activeDone) return;
    s.activeDone = true;
    metrics.activeRequests.dec({ service, route: s.ctx.route, method: s.ctx.method });
  };
  /** reply가 없으면 응답을 만들기 전에 끊긴 것(상태 없음), aborted면 보내려던 응답이 닿지 못한 것 */
  const writeLine = (s: RequestState, reply: FastifyReply | undefined, aborted: boolean) => {
    if (s.logged) return;
    s.logged = true;
    // 끊긴 요청의 대비 타이머가 요청·응답 객체를 남은 시간 + 1초 동안 붙잡지 않게 지운다(세 번째 리뷰, 2026-11-01)
    if (s.abortTimer) clearTimeout(s.abortTimer);
    s.abortTimer = undefined;
    const doneLog = hotPath?.start('http.log');
    try {
      canonical.write({
        traceId: s.ctx.traceId,
        spanId: s.ctx.spanId,
        route: s.ctx.route,
        method: s.ctx.method,
        status: reply?.statusCode,
        aborted,
        durationMs: Math.max(0, clock.monotonicMs() - s.startedMs),
        app: s.app,
        client: s.client,
        eventIdParam: s.eventIdParam,
        normalBranch: s.normalBranch,
        error: s.error,
        state: s.ctx.log,
        policy: s.policy,
        sample: s.sample,
      });
    } finally {
      doneLog?.();
    }
  };

  fastify.addHook('onRequest', (request, reply, done) => {
    const route = routeLabel(request.routeOptions?.url);
    const method = request.method;
    const at = activeTrace();
    const policy = routePolicyOf(request.routeOptions?.config);
    const oneIn = canonical.sampleOneIn;
    // 머리 표본은 들어온 traceparent의 표본 표시로만 본다. 부모가 없을 때 SDK는 뿌리 span을 늘 '고름'으로 판정하므로
    // 서버 span의 표시를 쓰면 안 된다(코드 리뷰, 2026-11-01). SDK가 그 부모를 이었을 때(같은 trace-id)만 믿는다
    const sample = { oneIn, thresholdKeep: sampleKeep(at.traceId, oneIn), headSampled: policy.entry === true && incomingSampled(request, at.traceId) };
    markServerSpan(method, route, sample);
    const ctx: RequestContext = {
      traceId: at.traceId,
      spanId: at.spanId,
      // @RouteDeadline을 단 경로는 그 상한이, 아니면 서비스 상한(PEAKET_MAX_DEADLINE_MS)이 남은 시간의 상한이다(PRF-166)
      deadline: Deadline.fromHeader(request.headers[DEADLINE_HEADER], { clock, maxMs: routeDeadlineMaxOf(request.routeOptions?.config, o.maxDeadlineMs) }),
      route,
      method,
      log: canonical.newState(),
    };
    const eventId = (request.params as Record<string, unknown> | undefined)?.eventId;
    const state: RequestState = {
      ctx,
      startedMs: clock.monotonicMs(),
      normalBranch: false,
      activeDone: false,
      logged: false,
      sent: false,
      aborted: false,
      handlerStarted: false,
      abort: () => {},
      policy,
      sample,
      ...requestSideFields(request),
      eventIdParam: typeof eventId === 'string' && EVENT_ID.test(eventId) ? eventId : undefined,
    };
    (request as unknown as WithState)[STATE] = state;
    metrics.activeRequests.inc({ service, route, method });
    // 끊긴 요청(응답이 닿지 못함). 게이지는 바로 내린다. 줄은
    // - 응답을 이미 보내기 시작했으면 지금 그 상태로,
    // - 처리기가 시작하기 전이면(본문을 다 받기 전) 지금 상태 없이,
    // - 처리기가 돌고 있으면 응답을 보내려 할 때(onSend) 그 상태와 err로 쓴다. 끊긴 때 바로 쓰면 그 뒤 처리기가 던진 오류가
    //   어디에도 남지 않는다(코드 리뷰, 2026-11-01). 처리기가 남은 시간 + 1초 안에 응답을 보내지 않으면 그때 전수로 쓴다
    state.abort = () => {
      release(state);
      if (state.logged || state.aborted) return;
      if (state.sent) return writeLine(state, reply, true);
      if (!state.handlerStarted) return writeLine(state, undefined, true);
      state.aborted = true;
      state.abortTimer = setTimeout(
        () => {
          state.ctx.log.keep();
          writeLine(state, undefined, true);
        },
        Math.max(0, state.ctx.deadline.remainingMs()) + ABORT_GRACE_MS,
      ).unref();
    };
    // 본문을 다 받은 뒤 끊긴 요청은 Fastify의 onRequestAbort도 onResponse도 오지 않는다(코드 리뷰, 2026-11-01 재현).
    // 응답 객체의 close는 끝났든 끊겼든 온다
    reply.raw.once('close', () => {
      if (reply.raw.writableFinished) release(state);
      else state.abort();
    });
    runInRequestContext(ctx, () => done());
  });

  fastify.addHook('preHandler', (request, _reply, done) => {
    const state = requestState(request);
    if (state) {
      state.handlerStarted = true;
      const now = clock.monotonicMs();
      state.preHandlerMs = now;
      hotPath?.observe('http.entry', Math.max(0, now - state.startedMs) / 1000);
    }
    done();
  });

  // 본문 해석 뒤 처리기 앞에서 맥락을 다시 연다. Node 24에서는 본문을 나눠 받아도 끊기지 않았지만(2026-11-01 시험),
  // 본문 해석 경로(해석기·Node 판)가 바뀌어도 처리기가 같은 맥락을 보게 하는 방어다(@fastify/request-context와 같은 방식)
  fastify.addHook('preValidation', (request, _reply, done) => {
    const state = requestState(request);
    if (!state) return done();
    runInRequestContext(state.ctx, () => done());
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    const state = requestState(request);
    if (state) {
      const now = clock.monotonicMs();
      const labels = { service, route: state.ctx.route, method: state.ctx.method, status_class: statusClass(reply.statusCode) };
      metrics.requestDuration.observe(labels, Math.max(0, now - state.startedMs) / 1000);
      if (reply.statusCode >= 500) metrics.errors.inc(labels);
      else if (state.normalBranch) metrics.businessRejections.inc(labels);
      if (state.onSendMs !== undefined) hotPath?.observe('http.serialize', Math.max(0, now - state.onSendMs) / 1000);
      hotPath?.observe('http.total', Math.max(0, now - state.startedMs) / 1000);
      release(state);
      writeLine(state, reply, false);
    }
    done();
  });

  // 처리기(또는 오류 필터)가 응답을 보내려 한다. 이미 끊긴 요청이면 여기서 보내려던 상태와 err로 줄을 쓴다
  fastify.addHook('onSend', (request, reply, payload, done) => {
    const state = requestState(request);
    if (state) {
      if (state.onSendMs === undefined) {
        const now = clock.monotonicMs();
        state.onSendMs = now;
        if (state.preHandlerMs !== undefined) hotPath?.observe('http.handler', Math.max(0, now - state.preHandlerMs) / 1000);
      }
      state.sent = true;
      if (state.aborted) writeLine(state, reply, true);
    }
    done(null, payload);
  });

  // 요청을 다 읽기 전에 끊긴 요청. 본문이 없는 GET은 처리기가 도는 중에도 이것이 온다(다시 본 리뷰, 2026-11-01)
  fastify.addHook('onRequestAbort', (request, done) => {
    requestState(request)?.abort();
    done();
  });
}

/** 서버 span(OTel SDK가 만든 것): 실제 경로 대신 경로 틀, 정상 표본 결과를 꼬리 표본기에 넘긴다(ADR-0125 결정 3) */
export function markServerSpan(method: string, route: string, sample: LineInput['sample']): void {
  const span = trace.getActiveSpan();
  if (!span?.isRecording()) return;
  span.updateName(`${method} ${route}`);
  span.setAttribute('http.route', route);
  span.setAttribute('url.path', route);
  span.setAttribute('peaket.sample.keep', sample.thresholdKeep);
  if (sample.headSampled) span.setAttribute('peaket.sample.mode', 'head');
}
