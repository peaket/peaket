// 서비스 시작 코드(docs/architecture.md §10 packages/platform, openspec 변경 add-service-template·add-service-logging).
// 앱 포트는 NestJS + Fastify, 관리 포트는 지표(/metrics)만 내는 작은 Fastify 서버다(ASVS v5.0.0-13.4.5).
// OTel SDK는 여기서 시작하지 않는다. 실행 명령의 --import @peaket/platform/telemetry/register가 먼저 시작한다(telemetry.ts).
import 'reflect-metadata';
import type { Writable } from 'node:stream';
import { type DynamicModule, Global, type LogLevel, Module, type Type } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { AUTH_STATE, AuthGuard, AuthState, RolesCheck, type AdminAuthzPort } from './auth.js';
import { type PurchaseSessionPort, purchaseRejections } from './purchase-auth.js';
import { CLOCK, type Clock, systemClock } from './clock.js';
import { type PlatformConfig, loadPlatformConfig } from './config.js';
import { activeTrace } from './context.js';
import { installHttpHooks, markServerSpan, requestSideFields } from './http-hooks.js';
import { NestPinoLogger, PLATFORM_LOGGER, type PlatformLogger, createPlatformLogger } from './log.js';
import { PlatformMetrics, statusClass } from './metrics.js';
import { PROBLEM_CONTENT_TYPE } from './problem.js';
import { ProblemFilter, frameworkErrorProblem } from './problem-filter.js';
import { loadLogPseudonymizer } from './pseudonym.js';
import { CanonicalLog, errorInfoOf } from './request-log.js';
import { installRequestChecks } from './request-checks.js';
import { Readiness } from './readiness.js';
import { sampleKeep } from './sampling.js';

/**
 * 사용자 모듈 위에 공용 제공자(시계·서비스 로거·인증 상태)를 전역으로 얹은 뿌리 모듈.
 * 모든 요청에 인증 가드를 걸고, 시작 때 모든 처리기의 허용 역할을 확인한다(add-service-structure-and-request-checks 결정 8, AZ-T1)
 */
export function platformRoot(module: Type<unknown> | DynamicModule, clock: Clock, logger: PlatformLogger, auth: AuthState): Type<unknown> {
  const values = [
    { provide: CLOCK, useValue: clock },
    { provide: PLATFORM_LOGGER, useValue: logger },
    { provide: AUTH_STATE, useValue: auth },
  ];
  @Global()
  @Module({
    imports: [DiscoveryModule],
    providers: [...values, { provide: APP_GUARD, useClass: AuthGuard }, RolesCheck],
    exports: values.map((p) => p.provide),
  })
  class PlatformCoreModule {}

  @Module({ imports: [PlatformCoreModule, module] })
  class PlatformRootModule {}
  return PlatformRootModule;
}

export interface CreateServiceOptions {
  /** 지표의 service 라벨과 로그의 service(예: purchase-svc) */
  name: string;
  module: Type<unknown> | DynamicModule;
  /** 기본 process.env */
  env?: Record<string, string | undefined>;
  /** 기본 시스템 시계 */
  clock?: Clock;
  /** 로그 목적지. 기본 표준 출력(시험에서 바꿔 끼운다) */
  logDestination?: Writable;
  /** NestJS 자체 기록 수준. 기본 error·warn(서비스 로거로 간다) */
  nestLogLevels?: LogLevel[] | false;
  /** identity-svc GetAdminAuthz 포트. 관리 역할(partner_*·관제 다섯)을 단 처리기가 있으면 꼭 있어야 한다(ADR-0172) */
  adminAuthz?: AdminAuthzPort;
  /** 구매 세션 포트(purchase-svc). @PurchaseSigned()를 단 처리기가 있으면 꼭 있어야 한다(ADR-0050 결정 8) */
  purchaseSessions?: PurchaseSessionPort;
  /** 앱 포트가 요청 하나(머리·본문)를 다 받는 시한(ms). 기본은 Fastify 기본(시한 없음)이다. 서버 전체에 걸리므로 그 포트의 경로를 모두 보고 정한다 */
  requestTimeoutMs?: number;
}

export interface PlatformService {
  /** 서비스 이름(지표의 service 라벨) */
  name: string;
  clock: Clock;
  config: PlatformConfig;
  metrics: PlatformMetrics;
  /** 서비스 로거(Pino). 처리기는 @Inject(PLATFORM_LOGGER)로도 받는다 */
  logger: PlatformLogger;
  /** 정규 로그 줄 표본 비율 바꾸기(온세일 구간 등, FND-090의 제어 상태 소비가 부른다) */
  logs: { setSampleOneIn(oneIn: number): void; readonly sampleOneIn: number };
  app: NestFastifyApplication;
  /** 앱 포트의 Fastify(시험에서는 inject로 부른다) */
  http: FastifyInstance;
  /** 관리 포트의 Fastify(/metrics, /ready) */
  management: FastifyInstance;
  /**
   * 준비 표시. 시작 작업(제어 상태·설정·종료 세션, startControlSync)은 listen 전에 등록하고, 모두 끝나야 /ready가 200이다.
   * /ready는 이 표시만 읽는다(공유 의존성을 부르지 않는다, D-T19·D-T29)
   */
  readiness: Readiness;
  /** 인증 상태. 세션 종료 사건(control.sessions-terminated)의 소비(FND-090)가 terminateSession을 부른다 */
  auth: { terminateSession(e: { sessionId: string; terminatedAt?: string }): void; isTerminated(sessionId: string): boolean };
  listen(host?: string): Promise<{ port: number; managementPort: number }>;
  close(): Promise<void>;
}

const portOf = (f: FastifyInstance): number => {
  const a = f.server.address();
  return typeof a === 'object' && a ? a.port : 0;
};

export async function createService(o: CreateServiceOptions): Promise<PlatformService> {
  const env = o.env ?? process.env;
  const config = loadPlatformConfig(env);
  const { pseudonymizer, warning } = loadLogPseudonymizer(env);
  const clock = o.clock ?? systemClock;
  const metrics = new PlatformMetrics(o.name);
  const rejections = purchaseRejections(metrics.registry);
  const auth = new AuthState(clock, o.adminAuthz, true, {
    sessions: o.purchaseSessions,
    onRejected: (reason) => rejections.inc({ service: o.name, reason }),
  });
  const logger = createPlatformLogger({
    service: o.name,
    env: config.env,
    version: config.version,
    az: env.PEAKET_AZ,
    pod: env.PEAKET_POD,
    clock,
    level: config.logLevel,
    destination: o.logDestination,
  });
  if (warning) logger.warn(warning);
  // 정규 로그 줄은 서비스 로거 수준과 관계없이 info부터 낸다(수준을 올려도 표본 집계가 깨지지 않게)
  const canonical = new CanonicalLog(logger.child({}, { level: 'info' }), {
    sampleOneIn: config.sampleOneIn,
    defaultSloLatencyMs: config.defaultSloLatencyMs,
    pseudonymizer,
  });

  const adapter = new FastifyAdapter({
    ...(o.requestTimeoutMs === undefined ? {} : { requestTimeout: o.requestTimeoutMs }),
    frameworkErrors: (error: Error, request: FastifyRequest, reply: FastifyReply) => {
      const { status, body } = frameworkErrorProblem(error, config.debugErrors);
      const labels = { service: o.name, route: 'unmatched', method: request.method, status_class: statusClass(status) };
      metrics.requestDuration.observe(labels, 0);
      if (status >= 500) metrics.errors.inc(labels);
      // 라우터 앞에서 끝난 요청(잘못된 URL 등)도 정규 로그 줄 하나를 같은 traceId로 남긴다(ASVS v5.0.0-16.3.4).
      // 서버 span은 경로 틀 대신 unmatched로 두고 표본 속성을 단다. 라우팅 전에 끝나 지연은 0으로 본다(지표와 같다, 코드 리뷰 2026-11-01)
      const traceId = String(body.traceId);
      const at = activeTrace();
      const sample = { oneIn: canonical.sampleOneIn, thresholdKeep: sampleKeep(traceId, canonical.sampleOneIn), headSampled: false };
      markServerSpan(request.method, 'unmatched', sample);
      canonical.write({
        traceId,
        spanId: at.traceId === traceId ? at.spanId : undefined,
        route: 'unmatched',
        method: request.method,
        status,
        durationMs: 0,
        ...requestSideFields(request),
        error: errorInfoOf(error, status),
        policy: {},
        sample,
      });
      void reply.status(status).header('content-type', PROBLEM_CONTENT_TYPE).send(JSON.stringify(body));
    },
  });
  const nestLevels = o.nestLogLevels ?? ['error', 'warn'];
  const app = await NestFactory.create<NestFastifyApplication>(platformRoot(o.module, clock, logger, auth), adapter, {
    abortOnError: false,
    // NestJS 기본 본문 해석기(JSON·폼)를 끈다. 폼 본문을 받지 않고(415, asvs/delivery.md 3.5.2) JSON은 Fastify 기본 해석기(원형 오염 키 거부)로 읽는다
    bodyParser: false,
    logger: nestLevels === false ? false : new NestPinoLogger(logger, nestLevels),
  });
  const http = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  installHttpHooks(http, { metrics, clock, maxDeadlineMs: config.maxDeadlineMs, canonical });
  // 경로 스키마 검사기와 본문 해석기는 경로를 붙이기(app.init) 전에 건다(결정 4·6)
  installRequestChecks(http);
  app.useGlobalFilters(new ProblemFilter({ debugErrors: config.debugErrors }));
  await app.init();

  const readiness = new Readiness();
  const management = Fastify({ logger: false });
  management.get('/metrics', async (_request, reply) => {
    void reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });
  // 생존 프로브: 이벤트 루프가 답하는지만 본다. 준비 상태·의존성과 상관없다(architecture §5 '프로브 규칙', ADR-0070)
  management.get('/livez', async () => ({ status: 'live' }));
  // 준비 프로브: 메모리의 표시만 본다(ADR-0070·0103, D-T29)
  management.get('/ready', async (_request, reply) => {
    const pending = readiness.pending();
    if (pending.length === 0) return { status: 'ready' };
    return reply.status(503).send({ status: 'starting', pending });
  });
  await management.ready();

  return {
    name: o.name,
    clock,
    config,
    metrics,
    logger,
    logs: {
      setSampleOneIn: (n: number) => canonical.setSampleOneIn(n),
      get sampleOneIn() {
        return canonical.sampleOneIn;
      },
    },
    app,
    http,
    management,
    readiness,
    auth: {
      terminateSession: (e) => auth.terminateSession(e),
      isTerminated: (sessionId) => auth.terminated.has(sessionId),
    },
    async listen(host = '0.0.0.0') {
      await app.listen({ port: config.port, host });
      await management.listen({ port: config.managementPort, host });
      return { port: portOf(http), managementPort: portOf(management) };
    },
    async close() {
      await app.close();
      await management.close();
    },
  };
}
