// 외부 제공자 호출 클라이언트(docs/observability.md §6·§7, V-T31 ③, ASVS v5.0.0-14.2.3·15.3.2, openspec 변경 add-service-logging 결정 6).
// - span(CLIENT)은 경로 틀로 직접 만들고, traceparent·tracestate·baggage는 싣지 않는다(호출하는 쪽이 넣은 것도 지운다).
// - 리디렉트를 따르지 않는다. 시간 초과는 min(상한, 남은 시간)이고 남은 시간이 없으면 504 deadline-exceeded.
// - 소요 시간은 그 요청의 정규 로그 줄 dep[provider]에 더한다.
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { type Clock, systemClock } from './clock.js';
import { requestContext } from './context.js';
import { deadlineExceeded } from './problem.js';
import { withoutTracePropagation } from './trace-boundary.js';

export const TRACE_PROPAGATION_HEADERS = ['traceparent', 'tracestate', 'baggage'] as const;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const PARAM = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ExternalHttpClientOptions {
  /** 제공자 이름(소문자·숫자·-). span의 peaket.provider와 정규 로그 줄 dep의 이름 */
  provider: string;
  /** https://api.example.com(경로 앞부분은 둘 수 있고, 쿼리·조각은 안 된다) */
  baseUrl: string;
  /** 한 번 부를 때의 시간 초과 상한(ms). 요청 안이면 남은 시간과 작은 쪽 */
  timeoutCapMs: number;
  /** 제공자가 요구할 때만 'w3c'(traceparent·tracestate. baggage는 어떤 경우에도 싣지 않는다). 허용 목록은 지금 비어 있다 */
  traceContext?: 'none' | 'w3c';
  clock?: Clock;
  /** 시험용 바꿔 끼우기 */
  fetch?: typeof fetch;
}

export interface ExternalRequest {
  method: Method;
  /** 경로 틀(/v1/payments/{paymentKey}). 값은 params로 따로 준다 */
  path: string;
  params?: Readonly<Record<string, string | number>>;
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array;
  /** 이 호출만의 상한(ms) */
  timeoutCapMs?: number;
}

export interface ExternalHttpClient {
  request(r: ExternalRequest): Promise<Response>;
}

const traceContextPropagator = new W3CTraceContextPropagator();

export function createExternalHttpClient(o: ExternalHttpClientOptions): ExternalHttpClient {
  if (!PROVIDER.test(o.provider)) throw new TypeError(`provider는 소문자·숫자·-로 된 32자 이하여야 한다: ${o.provider}`);
  let base: URL;
  try {
    base = new URL(o.baseUrl);
  } catch {
    throw new TypeError(`baseUrl이 URL이 아니다: ${o.baseUrl}`);
  }
  if ((base.protocol !== 'https:' && base.protocol !== 'http:') || base.search || base.hash || base.username || base.password) {
    throw new TypeError(`baseUrl은 쿼리·조각·사용자 정보가 없는 http(s) 주소여야 한다: ${o.baseUrl}`);
  }
  if (!(Number.isInteger(o.timeoutCapMs) && o.timeoutCapMs > 0)) throw new RangeError(`timeoutCapMs는 양의 정수여야 한다: ${o.timeoutCapMs}`);
  const prefix = base.pathname.replace(/\/+$/, '');
  const port = Number(base.port || (base.protocol === 'https:' ? 443 : 80));
  const clock = o.clock ?? systemClock;
  const doFetch = o.fetch ?? fetch;
  const tracer = trace.getTracer('@peaket/platform');

  return {
    async request(r) {
      if (!r.path.startsWith('/')) throw new TypeError(`경로 틀은 /로 시작해야 한다: ${r.path}`);
      const path = r.path.replace(PARAM, (_m, name: string) => {
        const v = r.params?.[name];
        if (v === undefined || v === '') throw new TypeError(`경로 값이 없다: ${name}`);
        // encodeURIComponent는 .과 ..을 그대로 둬 URL이 상위 경로로 줄어든다(코드 리뷰, 2026-11-01)
        if (v === '.' || v === '..') throw new TypeError(`경로 값이 . 또는 ..이다: ${name}`);
        return encodeURIComponent(String(v));
      });
      if (/[{}?#]/.test(path)) throw new TypeError(`경로 틀이 틀렸다(쿼리는 query로 준다): ${r.path}`);
      const url = new URL(`${base.origin}${prefix}${path}`);
      // 틀 자체의 ./.. 같은 것으로 경로가 바뀌었으면 보내지 않는다
      if (url.pathname !== `${prefix}${path}`) throw new TypeError(`경로 값이 경로를 바꾼다: ${r.path}`);
      for (const [k, v] of Object.entries(r.query ?? {})) if (v !== undefined) url.searchParams.append(k, String(v));

      const ctx = requestContext();
      const cap = r.timeoutCapMs ?? o.timeoutCapMs;
      // 실제 단조 시계는 소수 밀리초라 남은 시간도 소수다. AbortSignal.timeout은 정수만 받으므로 내림한다(남은 시간을 넘지 않게).
      // 1ms가 안 남았으면 보내지 않는다(2026-11-03 kind e2e에서 드러난 결함, BUILD_ORDER BSL-050)
      const timeoutMs = Math.floor(ctx ? ctx.deadline.budgetFor(cap) : cap);
      if (timeoutMs <= 0) throw deadlineExceeded();

      const headers = new Headers(r.headers);
      for (const h of TRACE_PROPAGATION_HEADERS) headers.delete(h);
      const template = `${prefix}${r.path}`;
      return tracer.startActiveSpan(
        `${r.method} ${template}`,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            'http.request.method': r.method,
            'url.template': template,
            'server.address': base.hostname,
            'server.port': port,
            'peaket.provider': o.provider,
            'peaket.timeout_ms': timeoutMs,
          },
        },
        async (span) => {
          if (o.traceContext === 'w3c') traceContextPropagator.inject(context.active(), headers, { set: (c, k, v) => (c as Headers).set(k, v) });
          const started = clock.monotonicMs();
          try {
            const res = await withoutTracePropagation(() =>
              doFetch(url, { method: r.method, headers, body: r.body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }),
            );
            span.setAttribute('http.response.status_code', res.status);
            if (res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
            return res;
          } catch (e) {
            // 오류 메시지에는 쿼리가 든 URL이 들 수 있어 종류만 남긴다
            span.setAttribute('error.type', e instanceof Error ? e.name : typeof e);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw e;
          } finally {
            span.end();
            ctx?.log.dependency(o.provider, Math.max(0, clock.monotonicMs() - started));
          }
        },
      );
    },
  };
}
