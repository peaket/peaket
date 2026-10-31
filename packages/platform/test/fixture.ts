// 시험용 모듈: 서비스 템플릿으로 띄운 서비스를 바깥(HTTP)에서 시험한다(docs/architecture.md §8.6의 5).
import 'reflect-metadata';
import { Body, Controller, Get, HttpException, Inject, Module, Param, Post } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { LightMyRequestResponse } from 'fastify';
import { z } from 'zod';
import { CLOCK, ProblemError, contractSchema, createService, currentDeadline, fakeClock, type FakeClock } from '../src/index.js';

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

@Controller('v1/demo')
export class DemoController {
  constructor(@Inject(CLOCK) private readonly clock: FakeClock) {}

  @Get('items/:itemId')
  @ApiOkResponse({ schema: contractSchema(Item) })
  item(@Param('itemId') itemId: string) {
    return { id: itemId, count: 1, note: null };
  }

  @Get('slow-120')
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

  @Post('echo')
  echo(@Body() body: unknown) {
    return body;
  }
}

@Module({ controllers: [DemoController] })
export class DemoModule {}

export interface Started {
  svc: Awaited<ReturnType<typeof createService>>;
  clock: FakeClock;
  errors: unknown[];
  inject: (opts: { method: string; url: string; headers?: Record<string, string>; payload?: string }) => Promise<LightMyRequestResponse>;
  metrics: () => Promise<string>;
}

export async function start(env: Record<string, string> = { PEAKET_ENV: 'ci' }): Promise<Started> {
  const clock = fakeClock();
  const errors: unknown[] = [];
  const svc = await createService({ name: 'demo-svc', module: DemoModule, env, clock, reportError: (e) => errors.push(e) });
  return {
    svc,
    clock,
    errors,
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
