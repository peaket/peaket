// 소셜 로그인 공급자 호출 보호(docs/architecture.md §5 '소셜 로그인 공급자 HTTP', docs/features/identity.md §10 ①~③, ADR-0180, BUILD_ORDER HOT-320).
// 웹 앱 서버의 얇은 OIDC 클라이언트가 공급자에게 보내는 모든 HTTP(발견 문서·토큰 교환·사용자 정보)를 이 fetch로 감싼다(openid-client customFetch).
// ① 파드마다 공급자별 동시 호출 상한(벌크헤드). 넘으면 기다리지 않고 ProviderBusyError → 처리기가 429 server-busy와 Retry-After로 답한다.
// ② 공급자가 429·403(한도·차단)을 몰아 주면 그 공급자만 서킷 브레이커로 잠시 끊는다(그 공급자의 새 로그인만 막힌다). 창 30초 [가정]에
//    호출이 20건 [가정] 이상이고 그 가운데 절반 [가정] 이상이 429·403이면 30초 [가정] 끊고, 그 뒤 한 번만 시험 삼아 부른다(성공하면 다시 잇는다).
//    5xx·시간 초과는 서킷을 열지 않는다(장애 비율 경보는 관측이 맡는다, identity §10.1). 세는 호출은 `counts`가 고른다. 소셜 로그인은
//    토큰 교환(POST)만 센다(`tokenExchangeOnly`). 없어도 로그인을 잇는 카카오 사용자 정보의 쿼터 거절이 로그인 전체를 끊지 않게 한다.
//    세지 않는 호출도 끊긴 동안은 보내지 않는다.
// ③ 시간 상한: 연결 2초 + 읽기 5초 [가정]를 한 번의 7초로 끊는다(Node fetch는 연결 단계만 따로 끊을 수 없다). 본문까지 다 읽어야 끝난다.
//    끊긴 호출은 다시 보내지 않는다(인가 코드는 한 번만 쓸 수 있다, RFC 6749 §4.1.2). 처리기는 로그인을 처음부터 다시 하게 한다.

export class ProviderBusyError extends Error {
  readonly code = 'provider-busy';
  constructor(provider: string) {
    super(`${provider} 공급자 동시 호출 상한을 넘었다`);
    this.name = 'ProviderBusyError';
  }
}

export class ProviderOpenError extends Error {
  readonly code = 'provider-open';
  /** 다시 해 볼 때까지(초, Retry-After) */
  readonly retryAfterSec: number;
  constructor(provider: string, retryAfterSec: number) {
    super(`${provider} 공급자를 잠시 끊었다(429·403이 몰렸다)`);
    this.name = 'ProviderOpenError';
    this.retryAfterSec = retryAfterSec;
  }
}

type BreakerState = 'closed' | 'open' | 'half-open';

interface Breaker {
  state: BreakerState;
  openUntil: number;
  /** half-open에서 시험 호출이 나가 있는가 */
  probing: boolean;
  /** 창 안의 결과(시각, 한도·차단이었는가) */
  results: { at: number; rejected: boolean }[];
}

export interface ProviderGuardOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** 공급자별 동시 호출 상한(파드마다) */
  maxConcurrent: number;
  /** 호출 한 번의 시간 상한(연결 + 읽기) */
  timeoutMs: number;
  windowMs: number;
  minCalls: number;
  rejectRatio: number;
  openMs: number;
  /** 서킷 브레이커가 세는 호출인가(기본: 모두) */
  counts?: (input: RequestInfo | URL, init?: RequestInit) => boolean;
}

/** 운영 기본값 [가정](docs/architecture.md §5: 연결 2초·읽기 5초, 동시 상한 예 233건은 wbs 2.12.1에서 확정) */
export const DEFAULT_GUARD: Omit<ProviderGuardOptions, 'fetch' | 'now' | 'counts'> = {
  maxConcurrent: 233,
  timeoutMs: 7_000,
  windowMs: 30_000,
  minCalls: 20,
  rejectRatio: 0.5,
  openMs: 30_000,
};

/** 동시 상한을 넘었을 때 다시 해 볼 때까지 [가정](Retry-After 초) */
export const BUSY_RETRY_AFTER_SEC = 2;

/** 소셜 로그인의 서킷이 세는 호출: 토큰 교환(POST)만. 발견 문서·공개키·사용자 정보는 GET이다(openid-client) */
export const tokenExchangeOnly = (_input: RequestInfo | URL, init?: RequestInit): boolean => (init?.method ?? 'GET').toUpperCase() === 'POST';

/** 본문이 없어야 하는 상태(new Response에 본문을 주면 TypeError) */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

export interface ProviderGuard {
  fetchFor(provider: string): typeof fetch;
  inflight(provider: string): number;
  state(provider: string): BreakerState;
  /** 끊긴 채 남은 시간(밀리초, 끊기지 않았거나 시험 호출을 보낼 때가 되었으면 0). 시험 호출 자리를 쓰지 않는다 */
  openFor(provider: string): number;
}

export function createProviderGuard(options: Partial<ProviderGuardOptions> = {}): ProviderGuard {
  const o = { ...DEFAULT_GUARD, ...options };
  const fetchImpl = o.fetch ?? fetch;
  const counts = o.counts ?? (() => true);
  const now = o.now ?? (() => Date.now());
  const inflight = new Map<string, number>();
  const breakers = new Map<string, Breaker>();

  const breaker = (p: string): Breaker => {
    let b = breakers.get(p);
    if (!b) {
      b = { state: 'closed', openUntil: 0, probing: false, results: [] };
      breakers.set(p, b);
    }
    return b;
  };

  const openFor = (p: string): number => {
    const b = breaker(p);
    return b.state === 'open' ? Math.max(0, b.openUntil - now()) : 0;
  };
  const openError = (p: string) => new ProviderOpenError(p, Math.max(1, Math.ceil(openFor(p) / 1000)));

  /** 부르기 전: 끊겼으면 거절, 끊긴 시간이 지났으면 한 번만 시험 삼아 보낸다. 시험 호출이면 true. 세지 않는 호출은 끊긴 동안만 막는다 */
  function admit(p: string, counted: boolean): boolean {
    const b = breaker(p);
    if (b.state === 'open' && now() < b.openUntil) throw openError(p);
    if (!counted) return false;
    if (b.state === 'open') b.state = 'half-open';
    if (b.state === 'half-open') {
      if (b.probing) throw openError(p);
      b.probing = true;
      return true;
    }
    return false;
  }

  function record(p: string, rejected: boolean, probe: boolean) {
    const b = breaker(p);
    const t = now();
    if (probe) {
      b.probing = false;
      if (rejected) {
        b.state = 'open';
        b.openUntil = t + o.openMs;
      } else {
        b.state = 'closed';
        b.results = [];
      }
      return;
    }
    b.results.push({ at: t, rejected });
    b.results = b.results.filter((r) => t - r.at <= o.windowMs);
    const bad = b.results.filter((r) => r.rejected).length;
    if (b.state === 'closed' && b.results.length >= o.minCalls && bad / b.results.length >= o.rejectRatio) {
      b.state = 'open';
      b.openUntil = t + o.openMs;
      b.results = [];
    }
  }

  return {
    inflight: (p) => inflight.get(p) ?? 0,
    openFor,
    state: (p) => {
      const b = breaker(p);
      return b.state === 'open' && now() >= b.openUntil ? 'half-open' : b.state;
    },
    fetchFor(p) {
      return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const counted = counts(input, init);
        const probe = admit(p, counted);
        const used = inflight.get(p) ?? 0;
        if (used >= o.maxConcurrent) {
          if (probe) breaker(p).probing = false;
          throw new ProviderBusyError(p);
        }
        inflight.set(p, used + 1);
        // 부르는 쪽의 취소 신호와 시간 상한을 함께(본문을 다 읽을 때까지)
        const ctrl = new AbortController();
        const outer = init?.signal;
        const onAbort = () => ctrl.abort(outer?.reason);
        if (outer) {
          if (outer.aborted) ctrl.abort(outer.reason);
          else outer.addEventListener('abort', onAbort);
        }
        const timer = setTimeout(() => ctrl.abort(new DOMException('공급자 호출 시간 상한을 넘었다', 'TimeoutError')), o.timeoutMs);
        let settled = false;
        try {
          const res = await fetchImpl(input, { ...init, signal: ctrl.signal });
          const body = await res.arrayBuffer();
          if (counted) record(p, res.status === 429 || res.status === 403, probe);
          settled = true;
          // fetch가 이미 압축을 풀었으므로 압축·길이 머리는 다시 만든 본문과 맞지 않는다
          const headers = new Headers(res.headers);
          headers.delete('content-encoding');
          headers.delete('content-length');
          return new Response(NULL_BODY.has(res.status) ? null : body, { status: res.status, statusText: res.statusText, headers });
        } catch (e) {
          if (ctrl.signal.aborted && ctrl.signal.reason instanceof DOMException && ctrl.signal.reason.name === 'TimeoutError') throw ctrl.signal.reason;
          throw e;
        } finally {
          clearTimeout(timer);
          outer?.removeEventListener('abort', onAbort);
          inflight.set(p, (inflight.get(p) ?? 1) - 1);
          // 시험 호출이 시간 초과·연결 오류로 끝나면 다음 시험을 막지 않게 풀어 둔다(서킷은 한도·차단 응답으로만 연다)
          if (probe && !settled) breaker(p).probing = false;
        }
      }) as typeof fetch;
    },
  };
}
