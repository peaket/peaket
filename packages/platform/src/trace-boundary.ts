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

/**
 * 게이트웨이(gw-fan·gw-partner)가 브라우저 traceparent를 옮겨 같은 출처 앱 서버 경로에만 넘기는 머리(docs/observability.md §6 '앱 서버가 브라우저 값을 받는 길').
 * 게이트웨이는 바깥 traceparent를 지우므로 앱 서버 모드는 이 머리를 먼저 읽고, 없을 때만(게이트웨이 없이 띄운 로컬) traceparent를 링크 후보로 읽는다
 */
export const BROWSER_TRACEPARENT_HEADER = 'x-peaket-browser-traceparent';

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
    // 앱 서버: 부모로 쓰지 않는다. 형식이 맞는 traceparent만 링크 후보로 맥락에 둔다. tracestate·baggage는 버린다.
    // 게이트웨이가 옮긴 브라우저 값(x-peaket-browser-traceparent)이 오면 그것만 본다(형식이 틀리면 링크 없음, traceparent로 물러나지 않는다)
    const browser = getter.get(carrier, BROWSER_TRACEPARENT_HEADER);
    const source: TextMapGetter = browser === undefined ? getter : { keys: () => ['traceparent'], get: (_c, key) => (key === 'traceparent' ? browser : undefined) };
    const parsed = trace.getSpanContext(this.traceContext.extract(ROOT_CONTEXT, carrier, source));
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

/** 쿼리·조각을 뗀 경로 */
const pathOnly = (target: string): string => target.split(/[?#]/, 1)[0] ?? '';

const ABSOLUTE_URL = /\bhttps?:\/\/[^\s"'<>]+/gi;
const PATH_WITH_QUERY = /(^|[\s"'(])(\/[^\s?#"']*)[?#][^\s"')]*/g;

/**
 * 글자 속에 든 주소의 쿼리를 지운다(리뷰 RV-29, docs/observability.md §7 '서버 span'과 같은 뜻): 절대 주소는 출처(scheme://host:port)만,
 * '/'로 시작하는 경로는 쿼리·조각을 뗀다. Next.js fetch 계측은 span 이름과 next.span_name에 'fetch 메서드 전체 주소'를 싣는다
 */
export function scrubUrls(text: string): string {
  if (!/[?#]|:\/\//.test(text)) return text;
  return text.replace(ABSOLUTE_URL, (u) => originOf(u) || u.split(/[?#]/, 1)[0]!).replace(PATH_WITH_QUERY, (_m, lead: string, path: string) => `${lead}${path}`);
}

/**
 * 옛 이름 속성과 그 밖의 글자 속성: 서버 span의 http.target은 쿼리를 떼고, http.url은 출처만 남긴다(W7-SEC-02).
 * 다른 글자 속성(next.span_name 등)에 든 주소도 쿼리를 지운다(RV-29). 경로 틀 속성(url.path·http.route·next.route)은 쿼리가 없어 그대로다
 */
function cleanLegacyUrl(span: Span): void {
  const a = span.attributes;
  const target = a['http.target'];
  if (typeof target === 'string' && /[?#]/.test(target)) span.setAttribute('http.target', pathOnly(target));
  const url = a['http.url'];
  if (typeof url === 'string') span.setAttribute('http.url', originOf(url));
  for (const [k, v] of Object.entries(a)) {
    if (typeof v !== 'string' || k === 'http.url' || k === 'url.full') continue;
    const clean = scrubUrls(v);
    if (clean !== v) span.setAttribute(k, clean);
  }
}

/**
 * 내보낼 서버 span 이름: 경로 틀 속성(http.route·next.route)이 있으면 '메서드 경로 틀', 없는데 이름에 주소(/·?)가 들어 있으면 '메서드'만.
 * 그 밖(이미 '메서드 경로 틀'이거나 'GET unmatched' 같은 이름)은 그대로 둔다. 메서드를 모르면 바꾸지 않는다
 */
export function serverSpanName(name: string, a: Record<string, unknown>): string {
  const method = [a['http.request.method'], a['http.method']].find((v) => typeof v === 'string' && v !== '') as string | undefined;
  if (!method) return name;
  const route = [a['http.route'], a['next.route']].find((v) => typeof v === 'string' && v !== '') as string | undefined;
  if (route) return `${method} ${route}`;
  return /[/?]/.test(name) ? method : name;
}

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
    cleanLegacyUrl(span);
    const untrusted = parentContext.getValue(UNTRUSTED_PARENT) as SpanContext | undefined;
    if (untrusted && span.kind === SpanKind.SERVER && !span.parentSpanContext) span.addLink({ context: untrusted });
  }

  /**
   * 끝나기 직전(아직 고칠 수 있는 때, 내보내기 앞)에 한 번 더 고친다(웨이브 끝 리뷰 W7-SEC-02, docs/observability.md §7 '서버 span'):
   * 시작 뒤에 실린 옛 이름 속성(http.target·http.url)과 url.full, 그리고 끝날 때 원래 주소로 바뀐 서버 span 이름(Next.js)
   */
  onEnding(span: Span): void {
    cleanLegacyUrl(span);
    const full = span.attributes['url.full'];
    if (typeof full === 'string') span.setAttribute('url.full', originOf(full));
    // 이름에 든 주소도 쿼리를 지운다(fetch 클라이언트 span 'fetch 메서드 전체 주소', RV-29)
    const scrubbed = scrubUrls(span.name);
    if (scrubbed !== span.name) span.updateName(scrubbed);
    if (span.kind === SpanKind.SERVER) {
      const name = serverSpanName(span.name, span.attributes);
      if (name !== span.name) span.updateName(name);
    }
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
