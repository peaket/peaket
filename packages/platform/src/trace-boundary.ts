// 신뢰 경계의 추적 문맥(ADR-0130, docs/observability.md §6 '신뢰 경계의 추적 문맥', V-T31, openspec 변경 add-service-logging 결정 6).
// - 나가는 쪽: withoutTracePropagation 안의 요청에는 traceparent·tracestate·baggage를 넣지 않는다(자동 계측도 이 전파기를 거친다).
// - 들어오는 쪽: mesh(서비스)는 메시 안에서 받은 부모를 잇고, untrusted(앱 서버)는 받은 traceparent를 링크로만 남긴다.
import {
  type Context,
  type SpanContext,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
  ROOT_CONTEXT,
  SpanKind,
  context,
  createContextKey,
  isSpanContextValid,
  trace,
} from '@opentelemetry/api';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace';
import { clientFamily } from './client-family.js';
import { ipPrefix } from './pseudonym.js';

export type InboundTrust = 'mesh' | 'untrusted';

const NO_PROPAGATION = createContextKey('peaket.trace.no-propagation');
const UNTRUSTED_PARENT = createContextKey('peaket.trace.untrusted-parent');

/** fn 안에서 나가는 요청에는 추적 문맥을 싣지 않는다(외부 제공자 호출) */
export function withoutTracePropagation<T>(fn: () => T): T {
  return context.with(context.active().setValue(NO_PROPAGATION, true), fn);
}

export function tracePropagationSuppressed(ctx: Context = context.active()): boolean {
  return ctx.getValue(NO_PROPAGATION) === true;
}

/** W3C Trace Context + Baggage에 경계 규칙을 얹은 전파기 */
export class BoundaryPropagator implements TextMapPropagator {
  private readonly w3c = new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] });
  private readonly traceContext = new W3CTraceContextPropagator();

  constructor(private readonly inbound: InboundTrust = 'mesh') {}

  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    if (tracePropagationSuppressed(ctx)) return;
    this.w3c.inject(ctx, carrier, setter);
  }

  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    if (this.inbound === 'mesh') return this.w3c.extract(ctx, carrier, getter);
    // 앱 서버: 부모로 쓰지 않는다. 형식이 맞는 traceparent만 링크 후보로 맥락에 둔다. tracestate·baggage는 버린다
    const parsed = trace.getSpanContext(this.traceContext.extract(ROOT_CONTEXT, carrier, getter));
    return parsed && isSpanContextValid(parsed) ? ctx.setValue(UNTRUSTED_PARENT, parsed) : ctx;
  }

  fields(): string[] {
    return this.w3c.fields();
  }
}

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

/**
 * span 시작 때 고친다(수집기 2차 처리 앞의 1차):
 * - client.address·network.peer.address는 IP 앞부분(IPv4 /24, IPv6 /48, ADR-0053 결정 1). 형식이 틀리면 지운 값('')
 * - 경로 틀을 모르는 자동 계측 span은 원래 경로를 남기지 않는다: url.path·url.query는 비우고 url.full은 출처(scheme://host:port)만
 *   (observability §7 '경로 템플릿만'. 서비스의 서버 span은 Fastify 훅이 url.path를 경로 틀로 다시 채운다, 코드 리뷰 2026-11-01)
 * - user_agent.original은 계열과 주 판만(정규 로그 줄의 client와 같다)
 * - 앱 서버 모드에서 받은 traceparent는 뿌리 서버 span의 링크로 남긴다
 */
export class BoundarySpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const a = span.attributes;
    for (const k of ['client.address', 'network.peer.address']) {
      const ip = a[k];
      if (typeof ip === 'string') span.setAttribute(k, ipPrefix(ip) ?? '');
    }
    if (a['url.path'] !== undefined) span.setAttribute('url.path', '');
    if (a['url.query'] !== undefined) span.setAttribute('url.query', '');
    const full = a['url.full'];
    if (typeof full === 'string') span.setAttribute('url.full', originOf(full));
    const ua = a['user_agent.original'];
    if (typeof ua === 'string') span.setAttribute('user_agent.original', clientFamily(ua) ?? '');
    const untrusted = parentContext.getValue(UNTRUSTED_PARENT) as SpanContext | undefined;
    if (untrusted && span.kind === SpanKind.SERVER && !span.parentSpanContext) span.addLink({ context: untrusted });
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
