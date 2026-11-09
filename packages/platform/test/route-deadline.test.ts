// 경로마다의 남은 시간 상한(@RouteDeadline, routeDeadlineMaxOf, BUILD_ORDER PRF-166). purchase-svc 결제 결과 long polling만 27초 [가정]으로 연다
// (docs/features/payment.md §2 '결제 결과 long polling의 첫 구현' '시간 한도', docs/architecture.md 시간 초과 표 'long polling' 행).
// 정본 모호(deadline.ts 뼈대 주석을 따른다):
// - 장식자는 Fastify 경로 설정(FASTIFY_ROUTE_CONFIG_METADATA)의 ROUTE_DEADLINE_KEY 칸에 maxMs를 넣는다(LogPolicy와 같은 자리, 다른 칸을 지우지 않는다).
// - maxMs가 양의 정수가 아니면 RangeError(장식자를 만들 때든 달 때든). 서비스 상한(PEAKET_MAX_DEADLINE_MS)보다 길어도 된다.
// - routeDeadlineMaxOf는 칸이 없거나 양의 정수가 아니면 서비스 상한(fallback)이다.
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { Controller, Get, Module } from '@nestjs/common';
import { FASTIFY_ROUTE_CONFIG_METADATA } from '@nestjs/platform-fastify/constants.js';
import { afterEach, describe, expect, test } from 'vitest';
import { routeDeadlineMaxOf } from '../src/deadline.js';
import { createService, currentDeadline, DEADLINE_HEADER, DEFAULT_MAX_DEADLINE_MS, fakeClock, LogPolicy, ROUTE_DEADLINE_KEY, RouteDeadline, Roles } from '../src/index.js';

@Controller('v1/rd')
@Roles(['public'])
class RouteDeadlineController {
  @Get('long')
  @RouteDeadline(27_000)
  long() {
    return { remaining: currentDeadline().remainingMs() };
  }

  @Get('long-logged')
  @LogPolicy({ entry: true })
  @RouteDeadline(27_000)
  longLogged() {
    return { remaining: currentDeadline().remainingMs() };
  }

  @Get('short')
  short() {
    return { remaining: currentDeadline().remainingMs() };
  }
}

@Module({ controllers: [RouteDeadlineController] })
class RouteDeadlineModule {}

const quiet = new Writable({ write: (_c, _e, cb) => cb() });
let svc: Awaited<ReturnType<typeof createService>> | undefined;
afterEach(async () => {
  await svc?.close();
  svc = undefined;
});
async function start(env: Record<string, string> = { PEAKET_ENV: 'ci' }) {
  svc = await createService({ name: 'rd-svc', module: RouteDeadlineModule, env, clock: fakeClock(), logDestination: quiet });
  return async (path: string, header?: string) => {
    const r = await svc!.http.inject({ method: 'GET', url: `/v1/rd/${path}`, headers: header === undefined ? {} : { [DEADLINE_HEADER]: header } });
    expect(r.statusCode, r.payload).toBe(200);
    return (JSON.parse(r.payload) as { remaining: number }).remaining;
  };
}

/** 장식자를 메서드 하나에 달아 본다(만들 때 던지든 달 때 던지든 같은 곳에서 잡힌다) */
function decorate(make: () => MethodDecorator): () => void {
  return () => {
    const fn = function handler() {};
    make()({}, 'handler', { value: fn, writable: true, enumerable: false, configurable: true });
  };
}

describe('routeDeadlineMaxOf(경로 설정 → 상한)', () => {
  test('GL5_칸에 양의 정수가 있으면 그 값이다(서비스 상한보다 길어도)', () => {
    expect(routeDeadlineMaxOf({ [ROUTE_DEADLINE_KEY]: 27_000 }, 15_000)).toBe(27_000);
    expect(routeDeadlineMaxOf({ [ROUTE_DEADLINE_KEY]: 500, other: true }, 15_000)).toBe(500);
  });

  test.each([
    ['설정 없음', undefined],
    ['null', null],
    ['빈 설정', {}],
    ['0', { [ROUTE_DEADLINE_KEY]: 0 }],
    ['음수', { [ROUTE_DEADLINE_KEY]: -1 }],
    ['소수', { [ROUTE_DEADLINE_KEY]: 1.5 }],
    ['글', { [ROUTE_DEADLINE_KEY]: '27000' }],
    ['NaN', { [ROUTE_DEADLINE_KEY]: Number.NaN }],
    ['무한', { [ROUTE_DEADLINE_KEY]: Number.POSITIVE_INFINITY }],
    ['설정이 글', 'peaketDeadline'],
  ])('GL5_%s이면 서비스 상한이다', (_n, config) => {
    expect(routeDeadlineMaxOf(config, 15_000)).toBe(15_000);
  });
});

describe('@RouteDeadline(장식자)', () => {
  test('GL5_칸 이름은 peaketDeadline이고, 경로 설정의 그 칸에 maxMs를 넣는다(다른 칸은 그대로)', () => {
    expect(ROUTE_DEADLINE_KEY).toBe('peaketDeadline');
    const fn = function handler() {};
    Reflect.defineMetadata(FASTIFY_ROUTE_CONFIG_METADATA, { keep: 1 }, fn);
    RouteDeadline(27_000)({}, 'handler', { value: fn, writable: true, enumerable: false, configurable: true });
    expect(Reflect.getMetadata(FASTIFY_ROUTE_CONFIG_METADATA, fn)).toEqual({ keep: 1, [ROUTE_DEADLINE_KEY]: 27_000 });
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('GL5_maxMs %s(양의 정수 아님)는 RangeError다', (ms) => {
    expect(decorate(() => RouteDeadline(ms))).toThrow(RangeError);
  });
});

describe('요청의 남은 시간(installHttpHooks)', () => {
  test('GL5_단 경로만 상한이 27초다: 머리 30000 → 27000, 머리 없음 → 27000, 머리 20000 → 20000', async () => {
    const get = await start();
    expect(await get('long', '30000')).toBe(27_000);
    expect(await get('long')).toBe(27_000);
    expect(await get('long', '20000')).toBe(20_000);
    expect(await get('long', 'abc')).toBe(27_000);
  });

  test('GL5_달지 않은 경로는 서비스 기본 상한 15초 그대로다', async () => {
    const get = await start();
    expect(await get('short', '30000')).toBe(DEFAULT_MAX_DEADLINE_MS);
    expect(await get('short')).toBe(15_000);
    expect(await get('short', '20000')).toBe(15_000);
    expect(await get('short', '40')).toBe(40);
  });

  test('GL5_LogPolicy와 함께 달아도 상한이 남는다', async () => {
    const get = await start();
    expect(await get('long-logged', '30000')).toBe(27_000);
  });

  test('GL5_서비스 상한(PEAKET_MAX_DEADLINE_MS)이 짧아도 단 경로는 제 상한이다(달지 않은 경로만 서비스 상한)', async () => {
    const get = await start({ PEAKET_ENV: 'ci', PEAKET_MAX_DEADLINE_MS: '250' });
    expect(await get('short', '30000')).toBe(250);
    expect(await get('long', '30000')).toBe(27_000);
  });
});
