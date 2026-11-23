// 서버 오류 수집(Sentry 호환 받는 곳, docs/observability.md §11, ADR-0356 결정 4, V-T39 ①).
// - 켜는 곳은 createService 하나다. 받는 곳 주소(DSN)는 PEAKET_SENTRY_DSN이고, 비면 끈다(네트워크 호출 없음).
// - 수집 설정 잠금(사용자 정보·본문·쿠키·머리·쿼리를 모으지 않음, beforeSend 마스킹, 사용자는 accountRef만)은 이 파일 안에 고정한다.
//   인자로 바꾸지 못한다(서비스마다 설정이 달라지지 않게).
// - Sentry 패키지는 @sentry/core 하나다. @sentry/node처럼 자기 OpenTelemetry 설정·자동 계측을 띄우지 않는다(ADR-0356 결정 4).
// - 보내는 요청에는 추적 문맥을 싣지 않고 span도 만들지 않는다(바깥 호출 규칙, docs/api/guidelines.md §8, V-T31 ③).
// - 받는 곳이 멈추면 사건을 버린다. 요청을 기다리게 하지 않는다(observability §11 '가용성의 기준').
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import {
  Scope,
  createStackParser,
  createTransport,
  type ErrorEvent,
  type Transport,
  type TransportMakeRequestResponse,
  type TransportRequest,
  type BaseTransportOptions,
} from '@sentry/core';
import { ServerRuntimeClient, nodeStackLineParser } from '@sentry/core/server';
import { DrizzleQueryError } from 'drizzle-orm';
import { redactDeep } from './log.js';
import { maskPiiText } from './pii-text.js';
import { queryErrorInfo } from './request-log.js';
import { withoutTracePropagation } from './trace-boundary.js';

/** 받는 곳 주소 환경 변수. 조직이 없는 동안은 모든 환경에서 비어 있다(ADR-0139 결정 3) */
export const SENTRY_DSN_ENV = 'PEAKET_SENTRY_DSN';
/** 끝낼 때 남은 사건을 보내는 시간(ms) [가정](ADR-0356 결정 4) */
export const ERROR_REPORTING_FLUSH_MS = 2_000;
/** 사건 하나를 보내는 요청의 시한(ms). 넘으면 버린다 */
const SEND_TIMEOUT_MS = 5_000;
/** 보내지 못하고 쌓아 두는 사건의 상한. 넘으면 버린다(Sentry 기본 64) */
const BUFFER_SIZE = 64;

export interface ErrorReportContext {
  /** 응답의 traceId(사건 태그 traceId) */
  traceId: string;
  /** 경로 틀(예: /v1/orders/:orderId). 값이 든 경로는 넣지 않는다 */
  route?: string;
  /** 로그 가명 accountRef. 원문 계정 ID는 넣지 않는다 */
  accountRef?: string;
}

export interface ErrorReporting {
  readonly enabled: boolean;
  /** 켬·끔의 까닭(시작 로그 줄의 reason): enabled, no-dsn, invalid-dsn */
  readonly reason: 'enabled' | 'no-dsn' | 'invalid-dsn';
  /** 예상하지 못한 오류 하나를 보낸다. 던지지 않는다. 꺼져 있으면 아무것도 하지 않는다 */
  capture(error: unknown, ctx: ErrorReportContext): void;
  /** 남은 사건을 timeoutMs까지 보낸다(넘으면 버린다). 던지지 않는다 */
  flush(timeoutMs: number): Promise<void>;
  /** 남은 사건을 timeoutMs까지 보내고 끈다(createService의 close가 부른다) */
  close(timeoutMs?: number): Promise<void>;
}

const DISABLED_CAPTURE = (): void => {};

/**
 * 수집 설정 잠금(observability §11). Sentry 기본값은 사용자 IP·쿼리 문자열·서버 요청 본문을 보낸다.
 * 이 SDK는 요청 자료 통합을 싣지 않아 자동으로 모으는 값이 없지만, 판이 바뀌어도 약해지지 않게 끄는 값을 모두 적는다
 */
const LOCKED = {
  sendDefaultPii: false,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
  },
  // 성능 추적·프로파일·화면 녹화는 켜지 않는다(ADR-0356 결정 4)
  traceLifecycle: 'static',
  sendClientReports: false,
  maxBreadcrumbs: 0,
  attachStacktrace: false,
} as const;

/** 사건에 남기는 칸. 나머지(request·breadcrumbs·extra·user의 다른 칸 등)는 지운다 */
const KEPT_EVENT_KEYS = new Set([
  'event_id', 'timestamp', 'platform', 'level', 'logger', 'release', 'environment', 'dist', 'server_name',
  'exception', 'tags', 'user', 'contexts', 'sdk', 'fingerprint', 'transaction', 'modules', 'message', 'type',
]);

/**
 * 사건의 글(오류 글 exception value·연결된 원인 오류의 글, message, 지문, transaction, 이동 기록 글) 속 이메일·전화번호·카드 번호 꼴을 가린다
 * (오류 수집 가림 꼴, pii-text.ts, observability §7, 리뷰 RV012-5). redactDeep이 만든 사본을 바꾼다
 */
function maskEventText(e: Record<string, unknown>): void {
  const exception = e.exception as { values?: { value?: unknown }[] } | undefined;
  for (const v of exception?.values ?? []) if (v && typeof v === 'object') v.value = maskPiiText(v.value);
  if (typeof e.message === 'string') e.message = maskPiiText(e.message);
  else if (e.message && typeof e.message === 'object') {
    const m = e.message as Record<string, unknown>;
    for (const k of ['message', 'formatted']) m[k] = maskPiiText(m[k]);
    if (Array.isArray(m.params)) m.params = m.params.map((p) => maskPiiText(p));
  }
  if (Array.isArray(e.fingerprint)) e.fingerprint = e.fingerprint.map((f) => maskPiiText(f));
  e.transaction = maskPiiText(e.transaction);
  // 이동 기록은 위 칸 거름에서 지우지만, 칸 목록이 바뀌어도 글이 그대로 나가지 않게 같이 가린다
  if (Array.isArray(e.breadcrumbs)) for (const b of e.breadcrumbs) if (b && typeof b === 'object') (b as Record<string, unknown>).message = maskPiiText((b as Record<string, unknown>).message);
  if (e.transaction === undefined) delete e.transaction;
}

/** beforeSend: 칸 거름 → 사용자는 id(accountRef)만 → 로그와 같은 가림(redactDeep, observability §7)과 글 속 개인정보 꼴 가림 → 받는 곳이 IP를 짐작하지 않게 */
export function lockEvent(event: ErrorEvent): ErrorEvent {
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) if (KEPT_EVENT_KEYS.has(k)) kept[k] = v;
  const id = (event.user as { id?: unknown } | undefined)?.id;
  if (typeof id === 'string' && id.length > 0) kept.user = { id };
  else delete kept.user;
  // 요청 문맥(contexts.request 등)과 trace 밖 문맥은 싣지 않는다. 실행 환경(runtime·os)과 SDK의 trace 문맥만 남긴다
  const contexts = (event.contexts ?? {}) as Record<string, unknown>;
  kept.contexts = Object.fromEntries(Object.entries(contexts).filter(([k]) => k === 'runtime' || k === 'os' || k === 'trace'));
  const masked = redactDeep(kept) as Record<string, unknown>;
  maskEventText(masked);
  const sdk = (masked.sdk ?? {}) as Record<string, unknown>;
  masked.sdk = { ...sdk, settings: { infer_ip: 'never' } };
  return masked as unknown as ErrorEvent;
}

/**
 * 보낼 오류. 쿼리 오류는 메시지에 매개변수 값이 들어 있어(Drizzle 'params: …') 로그와 같이 값을 뺀 사본으로 바꾼다(request-log의 queryErrorInfo).
 * 원인 사슬(cause)과 Error의 덧붙인 칸은 이 SDK가 싣지 않는다(연결 오류·추가 자료 통합을 켜지 않는다)
 */
export function reportableError(error: unknown): unknown {
  if (!(error instanceof DrizzleQueryError)) return error;
  const info = queryErrorInfo(error);
  const copy = new Error(info.message);
  copy.name = info.type;
  copy.stack = info.stack ?? `${info.type}: ${info.message}`;
  return copy;
}

/** node:http(s)로 보낸다. 추적 문맥을 싣지 않고 span을 만들지 않는다. 시한을 넘기거나 실패하면 버린다 */
function makeRequest(url: string) {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return (req: TransportRequest): PromiseLike<TransportMakeRequestResponse> =>
    withoutTracePropagation(() =>
      context.with(suppressTracing(context.active()), () =>
        new Promise<TransportMakeRequestResponse>((resolve, reject) => {
          const body = typeof req.body === 'string' ? Buffer.from(req.body) : Buffer.from(req.body);
          const r = send(
            target,
            { method: 'POST', timeout: SEND_TIMEOUT_MS, headers: { 'content-type': 'application/x-sentry-envelope', 'content-length': String(body.length) } },
            (res) => {
              res.resume();
              res.on('end', () =>
                resolve({
                  statusCode: res.statusCode,
                  headers: {
                    'retry-after': (res.headers['retry-after'] as string | undefined) ?? null,
                    'x-sentry-rate-limits': (res.headers['x-sentry-rate-limits'] as string | undefined) ?? null,
                  },
                }),
              );
              res.on('error', reject);
            },
          );
          r.on('timeout', () => r.destroy(new Error('오류 수집 요청 시한 초과')));
          r.on('error', reject);
          r.end(body);
        }),
      ),
    );
}

function makeTransport(options: BaseTransportOptions): Transport {
  return createTransport({ ...options, bufferSize: BUFFER_SIZE }, makeRequest(options.url));
}

// --- 프로세스 단위: 켜 둔 수집기와 처리되지 않은 예외 ---

const active = new Set<ErrorReporting & { captureFatal(error: unknown, origin: string): void }>();
let fatalListener: ((error: unknown, origin: string) => void) | undefined;

function installFatalHook(): void {
  if (fatalListener) return;
  const listener = (error: unknown, origin: string): void => {
    for (const r of active) r.captureFatal(error, origin);
    // 다른 처리기가 있으면 그쪽이 정한다. 우리 것뿐이면 Node 기본 동작(스택을 찍고 종료 코드 1)을 따르되, 남은 사건을 2초까지 보낸 뒤 끝낸다
    if (process.listenerCount('uncaughtException') > 1) return;
    const text = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
    process.stderr.write(`${origin === 'unhandledRejection' ? '처리되지 않은 거절' : '처리되지 않은 예외'}: ${text}\n`);
    void flushErrorReporting(ERROR_REPORTING_FLUSH_MS).finally(() => process.exit(1));
  };
  fatalListener = listener;
  // 'unhandledRejection' 처리기가 없으면 Node(기본 --unhandled-rejections=throw)가 거절도 이 사건으로 올린다(origin unhandledRejection)
  process.on('uncaughtException', listener);
}

function uninstallFatalHook(): void {
  if (fatalListener && active.size === 0) {
    process.removeListener('uncaughtException', fatalListener);
    fatalListener = undefined;
  }
}

/** 켜 둔 수집기 모두의 남은 사건을 보낸다(종료 차례 shutdownInOrder의 마지막 단계). 던지지 않는다 */
export async function flushErrorReporting(timeoutMs: number = ERROR_REPORTING_FLUSH_MS): Promise<void> {
  await Promise.all([...active].map((r) => r.flush(timeoutMs)));
}

/** 평문(http://) 받는 곳을 허락하는 환경: 로컬 가짜 수신기만(docs/api/guidelines.md §8 바깥 호출 표의 오류 수집 행은 HTTPS, 리뷰 RV012-1) */
const PLAINTEXT_DSN_ENVS: readonly string[] = ['local', 'ci'];

/**
 * DSN 꼴(<https>://<공개 키>@<호스트>[:포트]/<경로…>/<프로젝트 번호>)인지 본다. http://는 local·ci에서만 받는다.
 * Sentry의 해석기는 틀린 값을 콘솔에 그대로 찍어(키가 로그에 남는다) 쓰지 않는다
 */
function isDsn(value: string, environment: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  const scheme = u.protocol === 'https:' || (u.protocol === 'http:' && PLAINTEXT_DSN_ENVS.includes(environment));
  return scheme && /^\w+$/.test(u.username) && u.hostname.length > 0 && /\/\d+$/.test(u.pathname) && !u.search && !u.hash;
}

const disabled = (reason: 'no-dsn' | 'invalid-dsn'): ErrorReporting => ({
  enabled: false,
  reason,
  capture: DISABLED_CAPTURE,
  flush: async () => {},
  close: async () => {},
});

/**
 * 오류 수집을 켠다. PEAKET_SENTRY_DSN이 비면 끈 수집기(네트워크 호출 없음)를 돌려준다. 형식이 틀린 DSN과 local·ci 밖의 http:// DSN도 끈다(reason invalid-dsn).
 * 잠금 설정은 인자로 받지 않는다
 */
export function startErrorReporting(env: Record<string, string | undefined>, o: { service: string; version: string; environment: string }): ErrorReporting {
  const dsn = env[SENTRY_DSN_ENV]?.trim();
  if (!dsn) return disabled('no-dsn');
  if (!isDsn(dsn, o.environment)) return disabled('invalid-dsn');

  const client = new ServerRuntimeClient({
    ...LOCKED,
    dataCollection: { ...LOCKED.dataCollection, httpBodies: [] },
    dsn,
    release: `${o.service}@${o.version}`,
    environment: o.environment,
    platform: 'node',
    runtime: { name: 'node', version: process.version },
    integrations: [],
    defaultIntegrations: false,
    stackParser: createStackParser(nodeStackLineParser()),
    transport: makeTransport,
    beforeSend: (event) => lockEvent(event),
    beforeBreadcrumb: () => null,
  });
  client.init();
  let open = true;

  const send = (error: unknown, scope: Scope, mechanism: string): void => {
    if (!open) return;
    try {
      const reportable = reportableError(error);
      client.captureException(reportable, { originalException: reportable, mechanism: { type: mechanism, handled: false } }, scope);
    } catch {
      // 수집 실패로 요청 처리가 바뀌지 않게 삼킨다
    }
  };

  const reporting = {
    enabled: true as const,
    reason: 'enabled' as const,
    capture(error: unknown, ctx: ErrorReportContext): void {
      const scope = new Scope();
      scope.setTag('traceId', ctx.traceId);
      scope.setTag('service', o.service);
      if (ctx.route) scope.setTag('route', ctx.route);
      if (ctx.accountRef) scope.setUser({ id: ctx.accountRef });
      send(error, scope, 'peaket.problem-filter');
    },
    captureFatal(error: unknown, origin: string): void {
      const scope = new Scope();
      scope.setTag('service', o.service);
      scope.setTag('origin', origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException');
      send(error, scope, `peaket.${origin === 'unhandledRejection' ? 'unhandled-rejection' : 'uncaught-exception'}`);
    },
    async flush(timeoutMs: number): Promise<void> {
      try {
        await client.flush(timeoutMs);
      } catch {
        // 보내지 못한 사건은 버린다
      }
    },
    async close(timeoutMs: number = ERROR_REPORTING_FLUSH_MS): Promise<void> {
      if (!open) return;
      active.delete(reporting);
      uninstallFatalHook();
      try {
        await client.close(timeoutMs);
      } catch {
        // 보내지 못한 사건은 버린다
      }
      open = false;
    },
  };
  active.add(reporting);
  installFatalHook();
  return reporting;
}
