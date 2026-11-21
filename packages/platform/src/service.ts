// 서비스 시작 코드(docs/architecture.md §10 packages/platform, openspec 변경 add-service-template·add-service-logging).
// 앱 포트는 NestJS + Fastify, 관리 포트는 지표(/metrics)만 내는 작은 Fastify 서버다(ASVS v5.0.0-13.4.5).
// OTel SDK는 여기서 시작하지 않는다. 실행 명령의 --import @peaket/platform/telemetry/register가 먼저 시작한다(telemetry.ts).
import 'reflect-metadata';
import { hostname } from 'node:os';
import type { Writable } from 'node:stream';
import { type DynamicModule, Global, type LogLevel, Module, type Type } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { AUTH_STATE, AuthGuard, AuthState, INTERNAL_TOKEN_REQUIRED, RolesCheck, ScannerGuard, type AdminAuthzPort } from './auth.js';
import { ScannerAuthState, type ScannerAuthWiring } from './scanner-auth.js';
import { type PurchaseSessionPort, purchaseRejections } from './purchase-auth.js';
import { CLOCK, type Clock, systemClock } from './clock.js';
import { type PlatformConfig, PlatformConfigError, loadPlatformConfig } from './config.js';
import { activeTrace } from './context.js';
import { diagnoseConfigFromEnv, startDiagnose, type StartDiagnoseOptions } from './diagnose.js';
import { type EvidenceStore, s3EvidenceStore } from './evidence-store.js';
import type { HotPathMetrics } from './hot-path.js';
import { installHttpHooks, markServerSpan, requestSideFields } from './http-hooks.js';
import { NestPinoLogger, PLATFORM_LOGGER, type PlatformLogger, createPlatformLogger } from './log.js';
import { describeMetricViolations, validateMetricRegistry } from './metric-rules.js';
import { PlatformMetrics, statusClass } from './metrics.js';
import { PROBLEM_CONTENT_TYPE } from './problem.js';
import { ProblemFilter, frameworkErrorProblem } from './problem-filter.js';
import { loadLogPseudonymizer, type LogPseudonymizer } from './pseudonym.js';
import { CanonicalLog, errorInfoOf } from './request-log.js';
import { installRequestChecks } from './request-checks.js';
import { READINESS, READINESS_SHUTTING_DOWN, Readiness } from './readiness.js';
import { sampleKeep } from './sampling.js';
import { redisTenantRateLimiter } from './tenant-rate-limit.js';
import type { HotRedis } from './redis.js';

/**
 * 사용자 모듈 위에 공용 제공자(시계·서비스 로거·인증 상태)를 전역으로 얹은 뿌리 모듈.
 * 모든 요청에 인증 가드를 걸고, 시작 때 모든 처리기의 허용 역할을 확인한다(add-service-structure-and-request-checks 결정 8, AZ-T1)
 */
export function platformRoot(module: Type<unknown> | DynamicModule, clock: Clock, logger: PlatformLogger, auth: AuthState, internalTokenRequired: boolean, readiness: Readiness = new Readiness()): Type<unknown> {
  const values = [
    { provide: CLOCK, useValue: clock },
    { provide: READINESS, useValue: readiness },
    { provide: PLATFORM_LOGGER, useValue: logger },
    { provide: AUTH_STATE, useValue: auth },
    { provide: INTERNAL_TOKEN_REQUIRED, useValue: internalTokenRequired },
  ];
  @Global()
  @Module({
    imports: [DiscoveryModule],
    providers: [...values, { provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_GUARD, useClass: ScannerGuard }, RolesCheck],
    exports: values.map((p) => p.provide),
  })
  class PlatformCoreModule {}

  @Module({ imports: [PlatformCoreModule, module] })
  class PlatformRootModule {}
  return PlatformRootModule;
}

/** 진단 수집(RB-31) 옵션. 주지 않은 값은 환경 값(PEAKET_DIAG_*, diagnose.ts DIAGNOSE_ENV)에서 읽는다 */
export type DiagnoseOptions = Partial<Pick<StartDiagnoseOptions, 'annotationsFile' | 'diagDir' | 'memoryLimitBytes' | 'onStopWork' | 'exit' | 'pollMs' | 'unreadyWaitMs' | 'drainMs' | 'heap' | 'report' | 'sleep' | 'pod'>> & {
  /** 증거 저장소. 없으면 PEAKET_DIAG_BUCKET(·PEAKET_DIAG_S3_ENDPOINT)으로 S3 저장소를 만든다 */
  store?: EvidenceStore;
};

/**
 * SIGTERM에 준비 상태를 내릴 표시들. 처리기는 프로세스에 하나만 두고 맨 앞에 건다(서비스의 종료 처리기보다 먼저, docs/devops.md §6.4 ①).
 * 다른 SIGTERM 처리기가 없으면 표시를 내린 뒤 기본 동작(바로 끝내기)을 그대로 한다(처리기를 단 것만으로 끝나지 않게 되지 않도록)
 */
const sigtermTargets = new Set<Readiness>();
let sigtermListener: (() => void) | undefined;

function dropReadinessOnSigterm(readiness: Readiness): () => void {
  sigtermTargets.add(readiness);
  if (!sigtermListener) {
    const listener = () => {
      for (const r of sigtermTargets) r.register(READINESS_SHUTTING_DOWN);
      if (process.listenerCount('SIGTERM') === 1) {
        process.removeListener('SIGTERM', listener);
        sigtermListener = undefined;
        process.kill(process.pid, 'SIGTERM');
      }
    };
    sigtermListener = listener;
    process.prependListener('SIGTERM', listener);
  }
  return () => {
    sigtermTargets.delete(readiness);
    if (sigtermTargets.size === 0 && sigtermListener) {
      process.removeListener('SIGTERM', sigtermListener);
      sigtermListener = undefined;
    }
  };
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
  /** 스캐너 기기 증명·세션 판정 포트(GAT-170). @ScannerAuth()를 단 처리기가 있으면 꼭 있어야 한다 */
  scanner?: ScannerAuthWiring;
  /**
   * 파트너 테넌트 한도(BAT-173, D-T50 ⑦). 세션·캐시 Redis 연결을 넘긴다.
   * local·ci 밖에서 파트너 역할 처리기가 있는데 이 값이 없으면 서비스가 시작하지 않는다(조용히 한도가 꺼지지 않게)
   */
  tenantRateLimit?: { redis: HotRedis; limit?: number; windowMs?: number; timeoutMs?: number };
  /** 앱 포트가 요청 하나(머리·본문)를 다 받는 시한(ms). 기본은 Fastify 기본(시한 없음)이다. 서버 전체에 걸리므로 그 포트의 경로를 모두 보고 정한다 */
  requestTimeoutMs?: number;
  /** 핫패스 구간 진단(BAT-028). 서비스가 만든 것을 넘기면 인증·처리기·문제 변환·로그·응답 구간을 잰다 */
  hotPath?: HotPathMetrics;
  /** SIGTERM을 받으면 서비스의 종료 처리기보다 먼저 준비 상태를 내린다(/ready 503, 남은 작업 shutting-down). 기본 true(BUILD_ORDER BAS-080) */
  sigtermReadiness?: boolean;
  /**
   * 진단 수집(RB-31, D-T18 ①). false면 끈다. 없거나 객체면 PEAKET_DIAG_ANNOTATIONS_FILE이 있을 때 켠다(차트가 넣는다).
   * 그때 증거 저장소가 없으면 local·ci는 경고 한 줄과 함께 끄고, 그 밖의 환경은 시작하지 않는다
   */
  diagnose?: DiagnoseOptions | false;
}

export interface PlatformService {
  /** 서비스 이름(지표의 service 라벨) */
  name: string;
  clock: Clock;
  config: PlatformConfig;
  metrics: PlatformMetrics;
  /** 서비스 로거(Pino). 처리기는 @Inject(PLATFORM_LOGGER)로도 받는다 */
  logger: PlatformLogger;
  /**
   * 로그 가명 함수(정규 로그 줄의 pidRef·sidRef·accountRef와 같은 키, ADR-0053 결정 1). 업무 로그 줄에 사람 식별값을 남길 때 원문 대신 쓴다
   * (예: trust-svc 보안 로그 줄의 처리자 accountRef, docs/observability.md §7 '선택적 비즈니스 필드')
   */
  pseudonymizer: LogPseudonymizer;
  /** 정규 로그 줄 표본 비율 바꾸기(온세일 구간의 control.settings LOG_SAMPLING을 제어 토픽 소비가 적용한다, ADR-0334 결정 2) */
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
  /**
   * 종료 세션 목록 소비를 켰다는 표시. `@peaket/platform/stream-worker`의 startServiceControlSync가 켠다.
   * local·ci 밖에서 신원 역할(public 말고) 처리기가 있는데 켜지 않았으면 listen이 PlatformConfigError로 던지고 듣지 않는다(ADR-0333 결정 3)
   */
  controlSync: { started: boolean };
  /**
   * 앱 포트와 관리 포트를 연다. 듣기 전에 지표 규칙(docs/observability.md §8, ADR-0334 결정 6)을 보고, 등록된 지표가 금지 라벨을 달았거나
   * 이름 규칙을 어겼거나 Counter 이름이 _total로 끝나지 않으면(등록 지표가 하나도 없어도) PlatformConfigError로 던지고 듣지 않는다(환경과 관계없이 같다)
   */
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
  const scanner = o.scanner ? new ScannerAuthState(o.scanner, clock) : undefined;
  const internalTokenRequired = config.env !== 'local' && config.env !== 'ci';
  // 테넌트 한도(BAT-173): 넘긴 Redis 연결을 포트로 바꾸고, 판정 결과를 tenant_rate_limit_total{service,result}에 잇는다
  const tenantRateLimit = o.tenantRateLimit
    ? redisTenantRateLimiter({
        ...o.tenantRateLimit,
        onResult: (result) => metrics.tenantRateLimit.inc({ service: o.name, result }),
      })
    : undefined;
  const auth = new AuthState(
    clock,
    o.adminAuthz,
    true,
    {
      sessions: o.purchaseSessions,
      onRejected: (reason) => rejections.inc({ service: o.name, reason }),
    },
    o.hotPath,
    scanner,
    tenantRateLimit,
    internalTokenRequired,
  );
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
  const diagnose = o.diagnose === false ? undefined : diagnoseSetup(o.name, config.env, env, o.diagnose ?? {}, logger);
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
  // 준비 표시는 모듈이 시작 작업을 걸 수 있게 앱보다 먼저 만든다(@Inject(READINESS))
  const readiness = new Readiness();
  const app = await NestFactory.create<NestFastifyApplication>(platformRoot(o.module, clock, logger, auth, internalTokenRequired, readiness), adapter, {
    abortOnError: false,
    // NestJS 기본 본문 해석기(JSON·폼)를 끈다. 폼 본문을 받지 않고(415, asvs/delivery.md 3.5.2) JSON은 Fastify 기본 해석기(원형 오염 키 거부)로 읽는다
    bodyParser: false,
    logger: nestLevels === false ? false : new NestPinoLogger(logger, nestLevels),
  });
  const http = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  installHttpHooks(http, { metrics, clock, maxDeadlineMs: config.maxDeadlineMs, canonical, ...(o.hotPath ? { hotPath: o.hotPath } : {}) });
  // 경로 스키마 검사기와 본문 해석기는 경로를 붙이기(app.init) 전에 건다(결정 4·6). 칸막이 경로의 본문 전 신원 판정은 가드와 같은 인증 상태를 쓴다(W9-fix3 F5)
  installRequestChecks(http, auth);
  app.useGlobalFilters(new ProblemFilter({ debugErrors: config.debugErrors, ...(o.hotPath ? { hotPath: o.hotPath } : {}) }));
  await app.init();

  const management = Fastify({ logger: false });
  management.get('/metrics', async (_request, reply) => {
    void reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });
  // 생존 프로브: 이벤트 루프가 답하는지만 본다. 준비 상태·의존성과 상관없다(architecture §5 '프로브 규칙', ADR-0070)
  management.get('/livez', async () => ({ status: 'live' }));
  // 준비 프로브: 메모리의 표시만 본다(ADR-0070·0103, D-T29)
  // 종료 중(SIGTERM 뒤)·진단 수집 중(RB-31)도 같은 표시다. status가 shutting-down·diagnosing으로 그 까닭을 가린다
  management.get('/ready', async (_request, reply) => {
    const pending = readiness.pending();
    if (pending.length === 0) return { status: 'ready' };
    return reply.status(503).send({ status: readiness.status(), pending });
  });
  await management.ready();

  const controlSync = { started: false };
  const releaseSigterm = o.sigtermReadiness === false ? undefined : dropReadinessOnSigterm(readiness);
  const diagnosing = diagnose
    ? startDiagnose({
        ...diagnose,
        service: o.name,
        readiness,
        clock,
        logger,
        metrics,
        exit: diagnose.exit ?? (() => process.kill(process.pid, 'SIGTERM')),
      })
    : undefined;

  return {
    name: o.name,
    clock,
    config,
    metrics,
    logger,
    pseudonymizer,
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
    controlSync,
    async listen(host = '0.0.0.0') {
      // 빠뜨림 막기(ADR-0333 결정 3): 새 서비스가 소비를 잊고 배포되면 끝난 세션의 토큰이 조용히 통한다. local·ci(시험·합본)는 보지 않는다
      if (internalTokenRequired && auth.identityHandlers.length > 0 && !controlSync.started) {
        const shown = auth.identityHandlers.slice(0, 3).join(', ');
        const more = auth.identityHandlers.length > 3 ? ` 외 ${auth.identityHandlers.length - 3}개` : '';
        throw new PlatformConfigError(
          `${o.name}: 신원 역할 처리기(${shown}${more})가 있는데 종료 세션 목록 소비(@peaket/platform/stream-worker의 startServiceControlSync)를 켜지 않고 듣기 시작하려 했다(PEAKET_ENV=${config.env}, ADR-0333 결정 3)`,
        );
      }
      // 지표 라벨 규칙(C-T76): 계정·세션·순번·좌석·IP·User-Agent·주문 번호 꼴의 라벨은 시계열을 폭발시키고 개인 식별값을 지표에 남긴다
      if (metrics.registry.getMetricsAsArray().length === 0) throw new PlatformConfigError(`${o.name}: 지표 레지스트리가 비어 지표 규칙을 볼 수 없다(ADR-0334 결정 6)`);
      const violations = validateMetricRegistry(metrics.registry);
      if (violations.length > 0) {
        throw new PlatformConfigError(`${o.name}: 지표 규칙(docs/observability.md §8, ADR-0334 결정 6)을 어긴 지표가 있어 듣기 시작하지 않는다: ${describeMetricViolations(violations)}`);
      }
      await app.listen({ port: config.port, host });
      await management.listen({ port: config.managementPort, host });
      return { port: portOf(http), managementPort: portOf(management) };
    },
    async close() {
      diagnosing?.stop();
      releaseSigterm?.();
      await app.close();
      await management.close();
    },
  };
}

/** 진단 수집 설정을 맞춘다. 켜지 않으면 undefined. 운영 쪽 환경에서 저장소 설정이 없으면 던진다(시작 실패) */
function diagnoseSetup(
  name: string,
  peaketEnv: PlatformConfig['env'],
  env: Record<string, string | undefined>,
  given: DiagnoseOptions,
  logger: PlatformLogger,
): (Omit<StartDiagnoseOptions, 'service' | 'readiness' | 'clock' | 'logger' | 'metrics' | 'exit'> & { exit?: () => void }) | undefined {
  const fromEnv = diagnoseConfigFromEnv(given.annotationsFile ? { ...env, PEAKET_DIAG_ANNOTATIONS_FILE: given.annotationsFile } : env, peaketEnv, { storeGiven: given.store !== undefined });
  if (!fromEnv) return undefined;
  let store = given.store;
  if (!store) {
    if (fromEnv.missing.length > 0) {
      logger.warn({ kind: 'diagnose', missing: fromEnv.missing }, `진단 증거 저장소 설정이 없어 진단 수집(RB-31)을 끈다: ${fromEnv.missing.join('·')}`);
      return undefined;
    }
    store = s3EvidenceStore({ bucket: fromEnv.bucket!, ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}), ...(fromEnv.s3Endpoint ? { endpoint: fromEnv.s3Endpoint } : {}) });
  }
  const memoryLimitBytes = given.memoryLimitBytes ?? fromEnv.memoryLimitBytes;
  return {
    ...given,
    store,
    pod: given.pod ?? env.PEAKET_POD ?? hostname(),
    annotationsFile: fromEnv.annotationsFile,
    diagDir: given.diagDir ?? fromEnv.diagDir,
    ...(memoryLimitBytes === undefined ? {} : { memoryLimitBytes }),
  };
}
