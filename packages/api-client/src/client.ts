// api-client 실행 정책(docs/frontend.md §4.1, ADR-0079 결정 21). 화면 코드는 fetch를 직접 부르지 않고 이 함수만 부른다.
// 작업 서술(Operation)은 지금 손으로 적고, 화면 계약 보강(BUILD_ORDER BAS-040)에서 openapi로 orval이 만든 것으로 바꾼다.
import { parseJsonSafe } from '@peaket/validation/safe-json';
import { ApiError } from './error';
import { anySignal } from './signal';
import { RetryBudget, retryDelayMs, type Random } from './retry';

/** API 호스트(openapi x-peaket-gateways·경로 servers, docs/api/guidelines.md §10) */
export type Host = 'api' | 'queue' | 'partner-api' | 'ops-api' | 'scanner-api' | 'queue-files' | 'www';

/** 작업 종류마다 시간 초과(§4.1 '시간 초과'): 읽기 10초, 쓰기 15초, 결제 결과 롱 폴링 30초, 대기 상태 파일 5초, 올리기 120초 [가정] */
export const TIMEOUT_MS = { read: 10_000, write: 15_000, longpoll: 30_000, 'queue-file': 5_000, upload: 120_000 } as const;
export type OperationKind = keyof typeof TIMEOUT_MS;

export interface Operation {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** openapi 경로 틀(예: /v1/events/{eventId}) */
  path: string;
  host: Host;
  kind: OperationKind;
  /** openapi가 IdempotencyKey를 붙인 쓰기 */
  idempotent?: boolean;
  /**
   * openapi security가 쿠키(팬 로그인·linkCookie 등)인지. 정하지 않으면 호스트로 고른다. 같은 호스트에 쿠키를 쓰는 경로와
   * 쓰지 않는 경로가 함께 있는 곳(www: 정적 JSON과 계정 연결 제안 앱 서버 경로)은 작업마다 정한다
   */
  cookie?: boolean;
}

/**
 * T=0 두 호출(대기열 진입, 입장 확정). 이 둘만 본문을 JSON 문자열로 `text/plain;charset=UTF-8`에 실어 CORS 사전 요청 없이 보내고,
 * safelisted가 아닌 헤더(Idempotency-Key·traceparent 포함)를 붙이지 않는다(ADR-0065 결정 6, FE-T3). 정본 openapi와 같은지는 시험이 본다
 */
export const T0_TEXT_PLAIN_OPERATIONS = ['POST /v1/queues/{eventId}/entries', 'POST /v1/queues/{eventId}/admission'] as const;
const T0 = new Set<string>(T0_TEXT_PLAIN_OPERATIONS);
const opKey = (op: Operation) => `${op.method} ${op.path}`;

/**
 * 쿠키를 쓰는 API는 include, 대기열 파일·정적 JSON·스캐너(DPoP 헤더로 기기 자격)는 omit(§4.1 '자격 증명').
 * 작업이 쿠키 여부(openapi security)를 적었으면 그것을 따른다(예: www의 계정 연결 제안은 linkCookie라 include)
 */
export function credentialsFor(host: Host, op?: Pick<Operation, 'cookie'>): RequestCredentials {
  if (op?.cookie !== undefined) return op.cookie ? 'include' : 'omit';
  return host === 'api' || host === 'queue' || host === 'partner-api' || host === 'ops-api' ? 'include' : 'omit';
}

export interface RequestOptions {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** 기본 application/json. text/plain은 T=0 두 호출만 쓰고, 그 둘은 text/plain만 쓴다(어기면 보내지 않고 거절한다) */
  contentType?: 'application/json' | 'text/plain';
  /**
   * 멱등 키(따옴표 없는 UUID). 사람이 같은 동작을 다시 시도할 때 화면이 처음 키를 넘긴다(§4.1 '멱등 키'). 없으면 새로 만든다.
   * 한 요청 안의 자동 재시도는 늘 같은 키를 쓴다
   */
  idempotencyKey?: string;
  /** 화면을 떠날 때의 취소 신호 */
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface ClientOptions {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** 호스트 → 기본 주소(환경마다 다르다) */
  baseUrls: Partial<Record<Host, string>>;
  random?: Random;
  now?: () => number;
  /** 자동 재시도 최대 횟수(§4.1 '자동 재시도', 기본 2 [가정]) */
  maxRetries?: number;
  /** 버그로 보는 응답(422 idempotency-key-reused)을 오류 수집에 넘긴다 */
  onBug?: (e: ApiError) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildUrl(base: string, op: Operation, o: RequestOptions): string {
  const path = op.path.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
    const v = o.params?.[name];
    if (v === undefined) throw new TypeError(`경로 변수 ${name}이 없다(${op.path})`);
    // encodeURIComponent는 . 과 .. 을 그대로 두어, 주소를 풀 때 위 경로로 올라가 다른 API로 샌다(ASVS 1.2.2)
    if (v === '' || v === '.' || v === '..') throw new TypeError(`경로 변수 ${name}에 쓸 수 없는 값이다: '${v}'(${op.path})`);
    return encodeURIComponent(v);
  });
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  return url.href;
}

/** 기다림. 끝나면 화면 신호에 붙인 듣기를 지운다(오래 사는 신호에 쌓이지 않게, FE-T15) */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export function createApiClient(opts: ClientOptions) {
  const doFetch = opts.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
  const random = opts.random ?? Math.random;
  const now = opts.now ?? (() => Date.now());
  const maxRetries = opts.maxRetries ?? 2;
  const budget = new RetryBudget(now);

  async function request<T = unknown>(op: Operation, o: RequestOptions = {}): Promise<T> {
    const t0 = T0.has(opKey(op));
    const contentType = o.contentType ?? (t0 ? 'text/plain' : 'application/json');
    if ((contentType === 'text/plain') !== t0) {
      throw new TypeError(`text/plain 본문은 T=0 두 호출만, 그 둘은 text/plain만 쓴다(사전 요청 0): ${opKey(op)}(FE-T3)`);
    }
    if (o.idempotencyKey !== undefined && !UUID.test(o.idempotencyKey)) throw new TypeError(`멱등 키는 따옴표 없는 UUID여야 한다: ${opKey(op)}`);
    const base = opts.baseUrls[op.host];
    if (!base) throw new TypeError(`호스트 ${op.host}의 기본 주소가 없다`);
    const url = buildUrl(base, op, o);
    // 본문 문자열은 한 번만 만든다: 다시 시도할 때 같은 키와 처음 만든 본문 문자열을 그대로 쓴다(서버는 본문 지문으로 같은 요청인지 본다)
    const body = o.body === undefined ? undefined : JSON.stringify(o.body);
    const headers = new Headers();
    if (body !== undefined) headers.set('content-type', contentType === 'text/plain' ? 'text/plain;charset=UTF-8' : 'application/json');
    if (!t0) {
      for (const [k, v] of Object.entries(o.headers ?? {})) headers.set(k, v);
      if (op.idempotent) headers.set('idempotency-key', o.idempotencyKey ?? crypto.randomUUID());
    }
    const retryable = op.method === 'GET' || Boolean(op.idempotent);

    for (let attempt = 0; ; attempt++) {
      // 시간 초과 신호: AbortSignal.timeout과 같은 TimeoutError를 내되, 요청이 끝나면 타이머를 지운다(가짜 시계로 시험할 수 있다)
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new DOMException('시간 초과', 'TimeoutError')), TIMEOUT_MS[op.kind]);
      const signals = [timeout.signal];
      if (o.signal) signals.push(o.signal);
      const signal = anySignal(signals);
      // 요청이 끝나면(성공·실패 모두) 시간 초과 신호를 끊어 anySignal 대체가 화면 신호에 붙인 듣기를 지우게 한다(FE-T15)
      const release = () => {
        clearTimeout(timer);
        if (!timeout.signal.aborted) timeout.abort(new DOMException('요청 끝남', 'AbortError'));
      };
      let res: Response;
      try {
        res = await doFetch(url, { method: op.method, headers, body, credentials: credentialsFor(op.host, op), redirect: 'error', signal });
      } catch (err) {
        release();
        // 화면을 떠나 끊긴 것은 다시 보내지 않는다. 네트워크 오류·시간 초과는 다시 보낼 수 있다
        if (o.signal?.aborted || !retryable || attempt >= maxRetries || !budget.take()) throw err;
        await sleep(retryDelayMs({ attempt, random, nowMs: now() }), o.signal);
        continue;
      }
      // 본문을 다 읽을 때까지 시간 초과를 둔다(머리만 오고 본문이 늦는 경우)
      let error: ApiError;
      try {
        if (res.ok) {
          if (res.status === 204) return undefined as T;
          const ct = res.headers.get('content-type') ?? '';
          // JSON은 공용 안전 파서로 읽는다(__proto__·constructor·prototype 키 거절, ASVS 15.3.6)
          const text = await res.text();
          return (ct.includes('json') ? parseJsonSafe(text) : text) as T;
        }
        error = await ApiError.from(res);
      } finally {
        release();
      }
      if (error.status === 422 && error.type === 'idempotency-key-reused') {
        opts.onBug?.(error); // 버그로 보고 다시 보내지 않는다
        throw error;
      }
      const inProgress = error.status === 409 && error.type === 'idempotency-request-in-progress';
      const unavailable = error.status === 503 && error.retryAfter !== null;
      if (!(inProgress || unavailable) || !retryable || attempt >= maxRetries || !budget.take()) throw error;
      const delay = retryDelayMs({ retryAfterHeader: error.retryAfter, body: error.body as never, attempt, random, nowMs: now() });
      await sleep(delay, o.signal);
    }
  }

  return { request };
}
