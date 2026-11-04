// V-T41 핫패스 HTTP 어댑터와 검사 방식 비교(docs/verification.md V-T41, docs/architecture.md §6.1, 기술 검토 낮음-001).
// 같은 NestJS 처리기의 좌석 홀드 경로(JSON 본문)와 대기열 진입 경로(text/plain 본문)를 세 구성으로 띄운다.
//   VT41_CONFIG=express-zod     ① Express 어댑터 + Zod 파이프(@ContractBody 등)
//   VT41_CONFIG=fastify-zod     ② Fastify 어댑터 + Zod 파이프
//   VT41_CONFIG=fastify-schema  ③ Fastify 어댑터 + 경로 스키마(@ContractRouteSchema: 계약 Zod를 z.toJSONSchema()로 바꾼 요청·응답 스키마)
// 세 구성 모두 플랫폼 서비스 훅(지표·정규 로그 줄·추적·인증 가드·멱등)은 빼고 같은 문제 응답 필터만 둔다: 어댑터와 검사 방식의 몫만 잰다.
// 처리기는 고정 응답을 돌려준다(Redis·DB 없음). 머리 검사는 세 구성 모두 하지 않는다(멱등 키·구매 요청 서명은 따로 도는 훅이다).
// 관리 포트(9465): GET /stats(CPU·이벤트 루프 지연·처리 수), POST /reset.
import 'reflect-metadata';
import { createServer } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Body, Controller, HttpCode, Module, Post, type CanActivate, type ExecutionContext, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter, type NestExpressApplication } from '@nestjs/platform-express';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { CreateQueueEntryBody, CreateQueueEntryParams, CreateQueueEntryResponse } from '@peaket/contracts/openapi/queue';
import { CreateEventHoldBody, CreateEventHoldParams, CreateEventHoldResponse } from '@peaket/contracts/openapi/seats';
// 플랫폼 원본을 바로 가져온다(본문 해석기·경로 스키마 검사기를 거는 installRequestChecks는 서비스 시작 함수 안에서만 쓰여 내보내지 않는다)
import { ProblemFilter } from '../../../src/problem-filter.js';
import { AcceptTextPlain, ContractBody, ContractParams, ContractRouteSchema, installRequestChecks, throwAttachedValidationError } from '../../../src/request-checks.js';

const CONFIG = process.env.VT41_CONFIG ?? 'fastify-zod';
const PORT = Number(process.env.VT41_PORT ?? 8080);
const ADMIN_PORT = Number(process.env.VT41_ADMIN_PORT ?? 9465);
const ELD_RESOLUTION_MS = 1;
let handled = 0;
const HOLD = { holdId: 'h-0190f3a1-7c2e', seatIds: ['A-1', 'A-2'], expiresAt: '2026-11-01T10:07:00+09:00', extendable: true, fencingToken: 42 };
const ENTRY = { queueTicket: 'qt-1', seq: 1234, generation: 1, segment: 3, serverTimeMs: 1793500000000 };

@Controller('v1')
class ZodController {
  @HttpCode(201)
  @Post('events/:eventId/holds')
  hold(@ContractParams(CreateEventHoldParams) _p: unknown, @ContractBody(CreateEventHoldBody) _b: unknown) {
    handled += 1;
    return HOLD;
  }

  @HttpCode(202)
  @Post('queues/:eventId/entries')
  @AcceptTextPlain()
  entry(@ContractParams(CreateQueueEntryParams) _p: unknown, @ContractBody(CreateQueueEntryBody) _b: unknown) {
    handled += 1;
    return ENTRY;
  }
}

@Controller('v1')
class SchemaController {
  @HttpCode(201)
  @Post('events/:eventId/holds')
  @ContractRouteSchema({ params: CreateEventHoldParams, body: CreateEventHoldBody, responses: { 201: CreateEventHoldResponse } })
  hold(@Body() _b: unknown) {
    handled += 1;
    return HOLD;
  }

  @HttpCode(202)
  @Post('queues/:eventId/entries')
  @AcceptTextPlain()
  @ContractRouteSchema({ params: CreateQueueEntryParams, body: CreateQueueEntryBody, responses: { 202: CreateQueueEntryResponse } })
  entry(@Body() _b: unknown) {
    handled += 1;
    return ENTRY;
  }
}

/**
 * 플랫폼 인증 가드 자리(신원 판정은 하지 않는다). ③의 경로 스키마 검사 결과는 요청에 붙어 있다가 가드가 400으로 던진다(src/auth.ts와 같은 자리).
 * 세 구성 모두 단다(①·②에는 붙은 결과가 없어 아무 일도 하지 않는다)
 */
class CheckGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    throwAttachedValidationError(ctx.switchToHttp().getRequest());
    return true;
  }
}

const moduleFor = (controller: Type) => {
  @Module({ controllers: [controller] })
  class AppModule {}
  return AppModule;
};

async function main(): Promise<void> {
  const filter = new ProblemFilter({ debugErrors: false });
  if (CONFIG === 'express-zod') {
    const app = await NestFactory.create<NestExpressApplication>(moduleFor(ZodController), new ExpressAdapter(), { bodyParser: false, logger: ['error'] });
    // Fastify 구성과 같게: JSON은 application/json만, 대기열 진입은 text/plain 본문도 JSON으로 읽는다. 그 밖의 형식은 415
    app.useBodyParser('json', { type: 'application/json', limit: '16kb' });
    app.useBodyParser('text', { type: 'text/plain', limit: '16kb' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Express 미들웨어 모양(express 형식 패키지를 따로 들이지 않는다)
    const http = app.getHttpAdapter().getInstance() as unknown as { use(fn: (...a: any[]) => void): void; disable(name: string): void };
    // Fastify는 내지 않는 머리(ETag 해시 계산, X-Powered-By)를 끈다(구성 사이 일을 같게, 코드 리뷰 2026-11-01)
    http.disable('etag');
    http.disable('x-powered-by');
    http.use((req: { headers: Record<string, string | undefined>; body: unknown; method: string; url: string }, res: { status(n: number): { set(k: string, v: string): { send(b: string): void } } }, next: (e?: unknown) => void) => {
      const ct = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      const empty = !req.headers['content-length'] || req.headers['content-length'] === '0';
      if (req.method === 'POST' && !empty && ct !== 'application/json' && !(ct === 'text/plain' && req.url.includes('/entries'))) {
        res.status(415).set('content-type', 'application/problem+json').send(JSON.stringify({ type: 'about:blank', title: 'Unsupported Media Type', status: 415, instance: req.url.split('?')[0] }));
        return;
      }
      if (ct === 'text/plain' && typeof req.body === 'string') {
        try {
          req.body = JSON.parse(req.body);
        } catch {
          res.status(400).set('content-type', 'application/problem+json').send(JSON.stringify({ type: 'about:blank', title: 'Bad Request', status: 400, instance: req.url.split('?')[0] }));
          return;
        }
      }
      next();
    });
    app.useGlobalFilters(filter);
    app.useGlobalGuards(new CheckGuard());
    await app.init();
    // 본문 해석기 오류(깨진 JSON·크기 초과)는 Nest 필터 밖에서 난다. Fastify 구성처럼 Problem 본문으로 답한다
    http.use((err: { status?: number; statusCode?: number }, req: { url: string }, res: { status(n: number): { set(k: string, v: string): { send(b: string): void } } }, _next: unknown) => {
      const status = err.status ?? err.statusCode ?? 500;
      const title = status === 400 ? 'Bad Request' : status === 413 ? 'Payload Too Large' : status === 415 ? 'Unsupported Media Type' : 'Internal Server Error';
      res.status(status).set('content-type', 'application/problem+json').send(JSON.stringify({ type: 'about:blank', title, status, instance: req.url.split('?')[0] }));
    });
    await app.listen(PORT, '0.0.0.0');
  } else {
    const app = await NestFactory.create<NestFastifyApplication>(moduleFor(CONFIG === 'fastify-schema' ? SchemaController : ZodController), new FastifyAdapter({ bodyLimit: 16_384 }), {
      bodyParser: false,
      logger: ['error'],
    });
    installRequestChecks(app.getHttpAdapter().getInstance() as unknown as FastifyInstance);
    app.useGlobalFilters(filter);
    app.useGlobalGuards(new CheckGuard());
    await app.listen(PORT, '0.0.0.0');
  }

  const eld = monitorEventLoopDelay({ resolution: ELD_RESOLUTION_MS });
  eld.enable();
  let cpu0 = process.cpuUsage();
  let t0 = process.hrtime.bigint();
  let h0 = 0;
  let snapshot: object | undefined;
  createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/snapshot') {
      // 본구간이 끝난 때의 값을 남긴다(부하가 끝난 뒤 쉬는 시간이 처리량에 섞이지 않게, 코드 리뷰 2026-11-01)
      snapshot = stats();
      res.end('{}');
      return;
    }
    if (req.method === 'GET' && req.url === '/snapshot') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(snapshot ?? stats()));
      return;
    }
    if (req.method === 'POST' && req.url === '/reset') {
      eld.reset();
      cpu0 = process.cpuUsage();
      t0 = process.hrtime.bigint();
      h0 = handled;
      snapshot = undefined;
      res.end('{}');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(stats()));
  }).listen(ADMIN_PORT, '0.0.0.0');
  console.log(`V-T41 ${CONFIG} :${PORT}`);

  function stats() {
    const cpu = process.cpuUsage(cpu0);
    const wallUs = Number(process.hrtime.bigint() - t0) / 1e3;
    const ms = (ns: number) => Math.round((ns / 1e6) * 1000) / 1000;
    const lag = (ns: number) => Math.max(0, Math.round((ns / 1e6 - ELD_RESOLUTION_MS) * 1000) / 1000);
    return {
        config: CONFIG,
        handled: handled - h0,
        cpu_us: cpu.user + cpu.system,
        wall_us: Math.round(wallUs),
        cpu_pct: Math.round(((cpu.user + cpu.system) / wallUs) * 1000) / 10,
        // monitorEventLoopDelay는 표본 간격(1ms)을 포함한 타이머 간격을 기록한다. 간격을 뺀 값이 막힌 시간이다(코드 리뷰 2026-11-01)
        eld_ms: { p50: lag(eld.percentile(50)), p99: lag(eld.percentile(99)), max: lag(eld.max), mean: lag(eld.mean), resolution_ms: ELD_RESOLUTION_MS, raw_p99: ms(eld.percentile(99)) },
        rss_mb: Math.round(process.memoryUsage().rss / 1e6),
        node: process.version,
    };
  }
}

void main();
