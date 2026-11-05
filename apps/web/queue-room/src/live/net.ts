// 대기실의 작은 fetch 층(ADR-0207 결정 2). React api-client와 같은 규칙만 따른다(docs/frontend.md §4.2.1·§4.4·§5.1).
// - 진입·입장 확정(T=0 두 호출)은 text/plain JSON 글자이고 사용자 헤더가 없다(사전 요청이 생기지 않는다). 쿠키는 싣는다
// - 대기열 파일은 쿠키 없이(credentials omit), 상태 파일은 브라우저 캐시를 건너뛴다(cache no-store)
// - 시간 초과 5초 [가정]. Retry-After는 0 이상 정수 초나 HTTP 날짜만 읽는다

export const TIMEOUT_MS = 5000;

export interface Reply {
  status: number;
  /** JSON 본문(아니면 undefined) */
  body: unknown;
  /** Retry-After(밀리초). 없거나 꼴이 틀리면 null */
  retryAfterMs: number | null;
  /** problem+json의 type 끝 이름(예: sold-out) */
  problem: string | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function parseRetryAfter(v: string | null, nowMs: number): number | null {
  if (v === null) return null;
  const t = v.trim();
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  if (!/[a-z]/i.test(t)) return null;
  const at = Date.parse(t);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

const problemName = (b: unknown): string | null => {
  const type = (b as { type?: unknown } | null)?.type;
  if (typeof type !== 'string') return null;
  const i = type.lastIndexOf('/');
  return i < 0 ? type : type.slice(i + 1);
};

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const t = AbortSignal.timeout(TIMEOUT_MS);
  if (!signal) return t;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, t]);
  const c = new AbortController();
  const stop = (s: AbortSignal) => c.abort(s.reason);
  if (signal.aborted) stop(signal);
  else if (t.aborted) stop(t);
  else {
    signal.addEventListener('abort', () => stop(signal), { once: true });
    t.addEventListener('abort', () => stop(t), { once: true });
  }
  return c.signal;
}

async function read(res: Response, nowMs: number): Promise<Reply> {
  let body: unknown;
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
  }
  return { status: res.status, body, retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), nowMs), problem: problemName(body) };
}

export interface Net {
  /** T=0 쓰기(진입·입장 확정). 연결이 끊기거나 시간이 넘으면 던진다 */
  postText(url: string, body: unknown, signal?: AbortSignal): Promise<Reply>;
  /** 쿠키를 싣는 JSON 쓰기(로비 참가, T=0 전이라 사전 요청이 있어도 된다, §4.2.1 1번) */
  postJson(url: string, body: unknown, signal?: AbortSignal): Promise<Reply>;
  /** 쿠키를 싣는 쓰기·지우기(대기 취소, 토큰 갱신) */
  send(url: string, method: 'POST' | 'DELETE', signal?: AbortSignal): Promise<Reply>;
  /** 대기열 파일(쿠키 없음). noStore면 브라우저 캐시를 건너뛴다 */
  getFile(url: string, noStore: boolean, signal?: AbortSignal): Promise<Reply>;
  /** 공개 GET(쿠키 없음, 공연 공개 요약) */
  getPublic(url: string, signal?: AbortSignal): Promise<Reply>;
  /** 팬 API GET(쿠키를 싣고 브라우저 캐시를 건너뛴다, 예매 제한 조회 ADR-0213 결정 4) */
  getFan(url: string, signal?: AbortSignal): Promise<Reply>;
}

export function createNet(fetchImpl: FetchLike, now: () => number): Net {
  return {
    async postText(url, body, signal) {
      const res = await fetchImpl(url, { method: 'POST', credentials: 'include', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body), signal: withTimeout(signal) });
      return read(res, now());
    },
    async postJson(url, body, signal) {
      const res = await fetchImpl(url, { method: 'POST', credentials: 'include', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: withTimeout(signal) });
      return read(res, now());
    },
    async send(url, method, signal) {
      const res = await fetchImpl(url, { method, credentials: 'include', cache: 'no-store', signal: withTimeout(signal) });
      return read(res, now());
    },
    async getFile(url, noStore, signal) {
      const res = await fetchImpl(url, { credentials: 'omit', ...(noStore ? { cache: 'no-store' as const } : {}), signal: withTimeout(signal) });
      return read(res, now());
    },
    async getPublic(url, signal) {
      const res = await fetchImpl(url, { credentials: 'omit', signal: withTimeout(signal) });
      return read(res, now());
    },
    async getFan(url, signal) {
      const res = await fetchImpl(url, { credentials: 'include', cache: 'no-store', signal: withTimeout(signal) });
      return read(res, now());
    },
  };
}

/** 묶음·셔플 결과 파일의 키 h = SHA-256(UTF-8(토큰))의 소문자 16진 64자(docs/frontend.md §4.2.1) */
export async function tokenHash(token: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 받는 시각의 지연 = u32be(h의 바이트 2~5) mod (분산 창 × 1000) 밀리초(ADR-0207 결정 3) */
export function spreadDelayMs(hashHex: string, spreadSec: number): number {
  if (spreadSec <= 0) return 0;
  const u32 = Number.parseInt(hashHex.slice(4, 12), 16);
  return u32 % (spreadSec * 1000);
}

/** 결과 파일 404 뒤 다시 묻는 시각: 간격을 2초부터 두 배씩(최대 20초) 늘리고 그 간격 안의 무작위 시각(queue-admission §2, ADR-0058) */
export function resultRetryDelayMs(attempt: number, random: () => number): number {
  const interval = Math.min(2000 * 2 ** attempt, 20_000);
  return Math.floor(interval * random());
}
