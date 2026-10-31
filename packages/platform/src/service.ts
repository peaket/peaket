// 서비스 시작 코드(docs/architecture.md §10 packages/platform, openspec 변경 add-service-template).
// 앱 포트는 NestJS + Fastify, 관리 포트는 지표(/metrics)만 내는 작은 Fastify 서버다(ASVS v5.0.0-13.4.5).
import 'reflect-metadata';
import { type DynamicModule, Global, type LogLevel, Module, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { CLOCK, type Clock, systemClock } from './clock.js';
import { type PlatformConfig, loadPlatformConfig } from './config.js';
import { installHttpHooks } from './http-hooks.js';
import { PlatformMetrics, statusClass } from './metrics.js';
import { PROBLEM_CONTENT_TYPE } from './problem.js';
import { ProblemFilter, type UnexpectedError, frameworkErrorProblem, reportToStderr } from './problem-filter.js';

/** 사용자 모듈 위에 공용 제공자(시계)를 전역으로 얹은 뿌리 모듈 */
export function platformRoot(module: Type<unknown> | DynamicModule, clock: Clock): Type<unknown> {
  @Global()
  @Module({ providers: [{ provide: CLOCK, useValue: clock }], exports: [CLOCK] })
  class PlatformCoreModule {}

  @Module({ imports: [PlatformCoreModule, module] })
  class PlatformRootModule {}
  return PlatformRootModule;
}

export interface CreateServiceOptions {
  /** 지표의 service 라벨(예: purchase-svc) */
  name: string;
  module: Type<unknown> | DynamicModule;
  /** 기본 process.env */
  env?: Record<string, string | undefined>;
  /** 기본 시스템 시계 */
  clock?: Clock;
  /** 예상하지 못한 오류의 기록. 기본은 표준 오류 출력의 JSON 한 줄 */
  reportError?: (entry: UnexpectedError) => void;
  /** NestJS 자체 기록 수준. 기본 error·warn */
  nestLogLevels?: LogLevel[] | false;
}

export interface PlatformService {
  config: PlatformConfig;
  metrics: PlatformMetrics;
  app: NestFastifyApplication;
  /** 앱 포트의 Fastify(시험에서는 inject로 부른다) */
  http: FastifyInstance;
  /** 관리 포트의 Fastify(/metrics) */
  management: FastifyInstance;
  listen(host?: string): Promise<{ port: number; managementPort: number }>;
  close(): Promise<void>;
}

const portOf = (f: FastifyInstance): number => {
  const a = f.server.address();
  return typeof a === 'object' && a ? a.port : 0;
};

export async function createService(o: CreateServiceOptions): Promise<PlatformService> {
  const config = loadPlatformConfig(o.env ?? process.env);
  const clock = o.clock ?? systemClock;
  const metrics = new PlatformMetrics(o.name);
  const report = o.reportError ?? reportToStderr;

  const adapter = new FastifyAdapter({
    frameworkErrors: (error: Error, request: FastifyRequest, reply: FastifyReply) => {
      const { status, body } = frameworkErrorProblem(error, config.debugErrors);
      metrics.requestDuration.observe({ service: o.name, route: 'unmatched', method: request.method, status_class: statusClass(status) }, 0);
      if (status >= 500) {
        metrics.errors.inc({ service: o.name, route: 'unmatched', method: request.method, status_class: statusClass(status) });
        // 라우터 앞의 5xx(비동기 경로 조건 실패 등)도 같은 traceId로 서버 기록에 남긴다(ASVS v5.0.0-16.3.4, 다시 본 리뷰)
        report({ traceId: String(body.traceId), route: 'unmatched', method: request.method, status, error });
      }
      void reply.status(status).header('content-type', PROBLEM_CONTENT_TYPE).send(JSON.stringify(body));
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(platformRoot(o.module, clock), adapter, {
    abortOnError: false,
    logger: o.nestLogLevels ?? ['error', 'warn'],
  });
  const http = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  installHttpHooks(http, { metrics, clock, maxDeadlineMs: config.maxDeadlineMs });
  app.useGlobalFilters(new ProblemFilter({ debugErrors: config.debugErrors, report }));
  await app.init();

  const management = Fastify({ logger: false });
  management.get('/metrics', async (_request, reply) => {
    void reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });
  await management.ready();

  return {
    config,
    metrics,
    app,
    http,
    management,
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
