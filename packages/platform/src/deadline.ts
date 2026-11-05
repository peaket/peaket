// 남은 시간(deadline) 전파(docs/api/guidelines.md §5, ADR-0009 결정 4, openspec 변경 add-service-template 결정 4).
// 게이트웨이가 경로마다 정한 최대 허용 시간(밀리초)을 x-peaket-deadline-ms에 덮어써 넣는다.
// 서비스는 받은 때부터 min(헤더 값, 서비스 상한)을 남은 시간으로 두고, 이 시간은 줄어들기만 한다.
// 경로 하나만 서비스 상한을 따로 두려면 처리기에 @RouteDeadline(ms)를 단다(그 경로는 min(헤더 값, 경로 상한), BUILD_ORDER PRF-166).
import 'reflect-metadata';
import { FASTIFY_ROUTE_CONFIG_METADATA } from '@nestjs/platform-fastify/constants.js';
import type { Clock } from './clock.js';
import { deadlineExceeded } from './problem.js';

export const DEADLINE_HEADER = 'x-peaket-deadline-ms';
/** 서비스 상한 기본값: Envoy 경로 시간 초과 기본값 15초(docs/infra.md §4.1) */
export const DEFAULT_MAX_DEADLINE_MS = 15_000;

const POSITIVE_INT = /^[1-9][0-9]{0,8}$/;

function positiveInt(ms: number, what: string): number {
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error(`${what}은(는) 양의 정수(밀리초)여야 한다: ${ms}`);
  return ms;
}

/** Fastify 경로 설정(config)에서 이 경로만의 서비스 상한(ms)을 담는 칸(purchase-svc 결제 결과 long polling, BUILD_ORDER PRF-166) */
export const ROUTE_DEADLINE_KEY = 'peaketDeadline';

/**
 * 처리기에 단다: @RouteDeadline(27_000). 이 경로만 서비스 상한(PEAKET_MAX_DEADLINE_MS, 기본 15초) 대신 maxMs로 남은 시간을 연다
 * (서비스 상한보다 길어도 된다. 머리 값이 더 짧으면 그 값이다). 다른 경로는 그대로다.
 * LogPolicy(request-log.ts)처럼 Fastify 경로 설정(FASTIFY_ROUTE_CONFIG_METADATA)의 ROUTE_DEADLINE_KEY 칸에 maxMs를 넣는다(다른 칸은 그대로 둔다).
 * installHttpHooks가 routeDeadlineMaxOf로 그 값을 꺼내 쓴다.
 * @throws RangeError maxMs가 양의 정수(밀리초)가 아님(장식자를 만들 때)
 */
export function RouteDeadline(maxMs: number): MethodDecorator {
  if (!Number.isSafeInteger(maxMs) || maxMs <= 0) throw new RangeError(`경로 남은 시간 상한은 양의 정수(밀리초)여야 한다: ${maxMs}`);
  return (_target, _key, descriptor) => {
    const fn = descriptor.value as object;
    const prev = (Reflect.getMetadata(FASTIFY_ROUTE_CONFIG_METADATA, fn) as Record<string, unknown> | undefined) ?? {};
    Reflect.defineMetadata(FASTIFY_ROUTE_CONFIG_METADATA, { ...prev, [ROUTE_DEADLINE_KEY]: maxMs }, fn);
    return descriptor;
  };
}

/** 경로 설정에서 이 경로의 서비스 상한(ms)을 꺼낸다. 칸이 없거나 양의 정수가 아니면 fallbackMs(서비스 상한) */
export function routeDeadlineMaxOf(config: unknown, fallbackMs: number): number {
  if (config === null || typeof config !== 'object') return fallbackMs;
  const v = (config as Record<string, unknown>)[ROUTE_DEADLINE_KEY];
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fallbackMs;
}

export class Deadline {
  private constructor(private readonly clock: Clock, private readonly endMonotonic: number) {}

  /** 지금부터 ms 뒤에 끝나는 남은 시간 */
  static after(ms: number, clock: Clock): Deadline {
    return new Deadline(clock, clock.monotonicMs() + positiveInt(ms, '남은 시간'));
  }

  /** 받은 머리 값과 서비스 상한으로 남은 시간을 연다. 머리가 없거나 양의 정수가 아니면 상한이다 */
  static fromHeader(value: string | string[] | undefined, { clock, maxMs }: { clock: Clock; maxMs: number }): Deadline {
    const cap = positiveInt(maxMs, '서비스 상한');
    const asked = typeof value === 'string' && POSITIVE_INT.test(value) ? Number(value) : cap;
    return Deadline.after(Math.min(asked, cap), clock);
  }

  /** 남은 밀리초(0 아래로 가지 않는다) */
  remainingMs(): number {
    return Math.max(0, this.endMonotonic - this.clock.monotonicMs());
  }

  /** 다음 호출에 줄 시간: min(남은 시간, 그 호출의 상한) */
  budgetFor(capMs: number): number {
    return Math.min(this.remainingMs(), positiveInt(capMs, '호출 상한'));
  }

  /** 다음 단계에 neededMs가 필요한데 남은 시간이 모자라면 시작하지 않고 504 deadline-exceeded를 던진다 */
  ensure(neededMs: number): void {
    if (this.remainingMs() < neededMs) throw deadlineExceeded();
  }

  /** gRPC용 절대 시각(벽시계) */
  toDate(): Date {
    return new Date(this.clock.now() + this.remainingMs());
  }
}
