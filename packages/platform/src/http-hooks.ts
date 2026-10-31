// Fastify 훅: 요청 맥락 열기, 남은 시간 받기, 네 신호 재기(openspec 변경 add-service-template 결정 2·4·5).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Clock } from './clock.js';
import { type RequestContext, newTraceId, runInRequestContext } from './context.js';
import { DEADLINE_HEADER, Deadline } from './deadline.js';
import { type PlatformMetrics, routeLabel, statusClass } from './metrics.js';

export interface RequestState {
  ctx: RequestContext;
  startedMs: number;
  /** Problem 필터가 정상 분기 Problem을 냈다 */
  normalBranch: boolean;
  /** 처리 중 게이지를 이미 내렸다(끊긴 요청과 응답이 겹쳐도 한 번만) */
  activeDone: boolean;
}

const STATE = Symbol.for('peaket.platform.request-state');
type WithState = Record<symbol, RequestState | undefined>;

export function requestState(request: FastifyRequest | undefined): RequestState | undefined {
  return (request as unknown as WithState | undefined)?.[STATE];
}

export function installHttpHooks(fastify: FastifyInstance, o: { metrics: PlatformMetrics; clock: Clock; maxDeadlineMs: number }): void {
  const { metrics, clock } = o;
  const service = metrics.service;
  const release = (s: RequestState) => {
    if (s.activeDone) return;
    s.activeDone = true;
    metrics.activeRequests.dec({ service, route: s.ctx.route, method: s.ctx.method });
  };

  fastify.addHook('onRequest', (request, reply, done) => {
    const route = routeLabel(request.routeOptions?.url);
    const method = request.method;
    const ctx: RequestContext = {
      traceId: newTraceId(),
      deadline: Deadline.fromHeader(request.headers[DEADLINE_HEADER], { clock, maxMs: o.maxDeadlineMs }),
      route,
      method,
    };
    const state: RequestState = { ctx, startedMs: clock.monotonicMs(), normalBranch: false, activeDone: false };
    (request as unknown as WithState)[STATE] = state;
    metrics.activeRequests.inc({ service, route, method });
    // 본문을 다 받은 뒤 끊긴 요청은 Fastify의 onRequestAbort도 onResponse도 오지 않는다(코드 리뷰, 2026-11-01 재현).
    // 응답 객체의 close는 끝났든 끊겼든 오므로 여기서도 게이지를 내린다(한 번만)
    reply.raw.once('close', () => release(state));
    runInRequestContext(ctx, () => done());
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
      const labels = { service, route: state.ctx.route, method: state.ctx.method, status_class: statusClass(reply.statusCode) };
      metrics.requestDuration.observe(labels, Math.max(0, clock.monotonicMs() - state.startedMs) / 1000);
      if (reply.statusCode >= 500) metrics.errors.inc(labels);
      else if (state.normalBranch) metrics.businessRejections.inc(labels);
      release(state);
    }
    done();
  });

  fastify.addHook('onRequestAbort', (request, done) => {
    const state = requestState(request);
    if (state) release(state);
    done();
  });
}
