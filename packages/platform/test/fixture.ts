// 시험용 모듈: 서비스 템플릿으로 띄운 서비스를 바깥(HTTP)에서 시험한다(docs/architecture.md §8.6의 5).
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { Body, Controller, Get, HttpException, Inject, Module, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { LightMyRequestResponse } from 'fastify';
import { z } from 'zod';
import {
  CLOCK,
  LogPolicy,
  PLATFORM_LOGGER,
  ProblemError,
  Roles,
  contractSchema,
  createExternalHttpClient,
  createService,
  currentDeadline,
  fakeClock,
  requestLog,
  type FakeClock,
  type PlatformLogger,
} from '../src/index.js';

export const Item = z.object({ id: z.string(), count: z.number().int(), note: z.string().nullable() });

/** 처리기 안에서 기다리게 하는 문(처리 중 요청 게이지 시험) */
export function gate() {
  let open!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const reached = new Promise<void>((r) => (entered = r));
  return { open, opened, entered, reached };
}
export const slowGate = { current: gate() };

/** 바깥 호출 시험(telemetry.test.ts)이 정하는 모의 외부 서버 주소 */
export const outbound = { baseUrl: 'http://127.0.0.1:9' };

// 시험 경로는 모두 공개 작업이다(허용 역할이 없으면 서비스가 시작하지 않는다, AZ-T1)
@Controller('v1/demo')
@Roles(['public'])
export class DemoController {
  constructor(
    @Inject(CLOCK) private readonly clock: FakeClock,
    @Inject(PLATFORM_LOGGER) private readonly logger: PlatformLogger,
  ) {}

  @Get('items/:itemId')
  @ApiOkResponse({ schema: contractSchema(Item) })
  item(@Param('itemId') itemId: string) {
    return { id: itemId, count: 1, note: null };
  }

  @Get('slow-120')
  @LogPolicy({ sloLatencyMs: 100 })
  slow120() {
    this.clock.advance(120);
    return { ok: true };
  }

  @Get('boom')
  boom() {
    throw new Error("SELECT * FROM secret_table WHERE pid = 'p-1'");
  }

  @Post('holds')
  hold() {
    throw new ProblemError({
      type: 'seat-already-held',
      status: 409,
      title: '좌석이 이미 선택되었습니다',
      detail: 'A-12는 방금 다른 분이 선택했습니다.',
      normalBranch: true,
      extensions: { suggestedSeats: ['A-13', 'A-14'] },
    });
  }

  @Post('replays')
  inProgress() {
    throw new ProblemError({ type: 'idempotency-request-in-progress', status: 409, title: '같은 요청을 처리하고 있습니다', retryAfterSeconds: 1 });
  }

  @Get('busy')
  busy() {
    throw new ProblemError({ type: 'server-busy', status: 429, title: '잠시 뒤에 다시 시도해 주세요', retryAfterSeconds: 2 });
  }

  @Get('wait')
  async wait() {
    slowGate.current.entered();
    await slowGate.current.opened;
    return { ok: true };
  }

  @Post('wait')
  async waitPost(@Body() _body: unknown) {
    slowGate.current.entered();
    await slowGate.current.opened;
    return { ok: true };
  }

  @Get('upstream')
  upstream() {
    // 다른 서비스를 부르는 HTTP 클라이언트 오류처럼 statusCode를 단 일반 오류
    throw Object.assign(new Error('upstream identity-svc said 401 token=abc'), { statusCode: 401 });
  }

  @Get('redirect')
  redirect() {
    throw new HttpException('moved', 302);
  }

  @Get('deadline')
  deadline() {
    this.clock.advance(10);
    const d = currentDeadline();
    return { remaining: d.remainingMs(), next: d.budgetFor(100) };
  }

  @Post('deadline')
  deadlineAfterBody(@Body() body: { n: number }) {
    return { n: body.n, remaining: currentDeadline().remainingMs() };
  }

  @Get('need-20')
  need() {
    currentDeadline().ensure(20);
    return { ok: true };
  }

  @Get('events/:eventId/rich')
  rich(@Param('eventId') eventId: string) {
    const log = requestLog();
    log.set({ pg: 'toss', queuePhase: 'purchase', flags: ['seat-map-v2', 'degraded-payment'], orderId: '0b7e7c52-1111-4c2a-9e55-1d2a3b4c5d6e' });
    log.identify({ pid: 'p-123', sessionId: 's-456', accountId: 'a-789' });
    log.dependency('redis', 4);
    log.dependency('redis', 3);
    log.dependency('pg', 1.5);
    this.clock.advance(12);
    return { eventId };
  }

  @Get('soon')
  soon() {
    requestLog().keep();
    return { soon: true };
  }

  @Get('newline')
  newline() {
    requestLog().set({ flags: ['a\n{"level":"fatal","msg":"forged"}'] });
    return { ok: true };
  }

  @Get('log-inside')
  logInside() {
    this.logger.info({ email: 'fan@example.com', card: { paymentKey: 'tgen_20261101abcd', authorization: 'Bearer secret' } }, 'inside');
    return { ok: true };
  }

  @Post('wait-boom')
  async waitBoom(@Body() _body: unknown) {
    slowGate.current.entered();
    await slowGate.current.opened;
    throw new Error('db exploded');
  }

  @Get('wait-boom')
  async waitBoomGet() {
    slowGate.current.entered();
    await slowGate.current.opened;
    throw new Error('db exploded on get');
  }

  @Get('hang')
  async hang() {
    slowGate.current.entered();
    // 끝나지 않는 처리기(끊긴 뒤 응답을 보내지 않는 경우)
    await new Promise(() => {});
  }

  @Get('call-out')
  async callOut(@Query('spend') spend?: string) {
    // 남은 시간을 spend ms만큼 쓴 뒤 외부 제공자를 부른다
    this.clock.advance(Number(spend ?? 0));
    const client = createExternalHttpClient({ provider: 'toss-payments', baseUrl: outbound.baseUrl, timeoutCapMs: 3_000, clock: this.clock });
    const res = await client.request({ method: 'POST', path: '/v1/payments/{paymentKey}/confirm', params: { paymentKey: 'tgen_abc' }, body: '{}' });
    return { status: res.status };
  }

  @Post('entry')
  @LogPolicy({ entry: true })
  entry() {
    return { ok: true };
  }

  @Get('entry-busy')
  @LogPolicy({ entry: true })
  entryBusy() {
    throw new ProblemError({ type: 'server-busy', status: 429, title: '잠시 뒤에 다시 시도해 주세요', retryAfterSeconds: 2 });
  }

  @Post('echo')
  echo(@Body() body: unknown) {
    return body;
  }
}

@Module({ controllers: [DemoController] })
export class DemoModule {}

export type LogLine = Record<string, unknown>;

export interface Started {
  svc: Awaited<ReturnType<typeof createService>>;
  clock: FakeClock;
  /** 표준 출력 대신 모은 로그 줄(JSON으로 읽은 것) */
  lines: LogLine[];
  /** 모은 날것의 글(줄바꿈 검사용) */
  raw: string[];
  /** 정규 로그 줄만 */
  requests: () => LogLine[];
  inject: (opts: { method: string; url: string; headers?: Record<string, string>; payload?: string }) => Promise<LightMyRequestResponse>;
  metrics: () => Promise<string>;
}

/** 쓴 글을 모으는 로그 목적지 */
export function collector() {
  const raw: string[] = [];
  const lines: LogLine[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const text = String(chunk);
      raw.push(text);
      for (const l of text.split('\n')) if (l) lines.push(JSON.parse(l) as LogLine);
      cb();
    },
  });
  return { raw, lines, stream };
}

export async function start(env: Record<string, string> = { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1' }, o: { now?: number } = {}): Promise<Started> {
  const clock = fakeClock({ now: o.now });
  const { raw, lines, stream } = collector();
  const svc = await createService({ name: 'demo-svc', module: DemoModule, env, clock, logDestination: stream });
  return {
    svc,
    clock,
    lines,
    raw,
    requests: () => lines.filter((l) => typeof l.msg === 'string' && l.msg.startsWith('request')),
    inject: (opts) => svc.http.inject(opts as never),
    metrics: async () => (await svc.management.inject({ method: 'GET', url: '/metrics' })).payload,
  };
}

/** Prometheus 글 형식에서 이름과 라벨이 맞는 줄의 값(없으면 undefined) */
export function sample(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    const m = /^([^{\s]+)(?:\{(.*)\})?\s+(\S+)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const got = Object.fromEntries([...(m[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((x) => [x[1], x[2]]));
    if (Object.entries(labels).every(([k, v]) => got[k] === v)) return Number(m[3]);
  }
  return undefined;
}
