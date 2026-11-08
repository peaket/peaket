// orval이 만든 호출 함수·훅이 부르는 사용자 함수(docs/frontend.md §2.2 '생성물'·§4.1, BUILD_ORDER BAS-041).
// orval은 경로 변수를 채운 주소와 RequestInit(본문은 JSON 글자)을 넘긴다. 메서드와 주소로 계약의 작업을 찾아(src/gen/operations.ts)
// api-client 실행 정책(호스트·자격 증명·T=0·멱등 키·If-Match·시간 초과·자동 재시도·오류 모양)으로 보내고 { data, status, headers }를 돌려준다.
import type { ApiClient, Operation } from './client';
import type { ApiError } from './error';
import { OPERATIONS } from './gen/operations';

/** 생성 훅의 오류 형. orval이 이 이름을 찾아 쓴다(던지는 값은 언제나 ApiError다, 확장 칸은 extensions) */
export type ErrorType<_E = unknown> = ApiError;
/** 생성 함수의 본문 형(orval이 이 이름을 찾아 쓴다) */
export type BodyType<B> = B;

type Described = Operation & { operationId: string };
let client: ApiClient | undefined;

/** 화면 앱이 시작할 때 한 번 부른다(호스트별 기본 주소가 든 클라이언트). undefined는 시험에서 끊을 때 */
export function setOrvalClient(c: ApiClient | undefined): void {
  client = c;
}

// 고정 글자가 많은(변수가 적은) 틀을 먼저 본다(/entries/me와 /entries/{id}). 같은 주소에 맞는 틀이 겹치면 생성기가 막는다
function compile(operations: Record<string, Described>) {
  return Object.values(operations).map((op) => {
    const names: string[] = [];
    // 정규식 특수 글자를 막고({ }는 경로 변수 자리라 남긴다) 경로 변수를 한 단계 글자로 바꾼다
    const src = op.path.replace(/[.*+?^$()|[\]\\]/g, (ch) => `\\${ch}`).replace(/\{([A-Za-z0-9_]+)\}/g, (_, n: string) => {
      names.push(n);
      return '([^/]+)';
    });
    return { method: op.method, re: new RegExp(`^${src}$`), names, op };
  }).sort((a, b) => a.names.length - b.names.length);
}

const TABLE = compile(OPERATIONS as Record<string, Described>);

/** 메서드와 경로(쿼리 없음)로 작업과 경로 변수를 찾는다. 경로 변수는 퍼센트 부호를 풀어 넘긴다(api-client가 다시 부호화한다) */
export function matchOperation(method: string, pathname: string, operations?: Record<string, Described>): { op: Described; params: Record<string, string> } | undefined {
  const rows = operations ? compile(operations) : TABLE;
  for (const r of rows) {
    if (r.method !== method.toUpperCase()) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    let params: Record<string, string>;
    try {
      params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)]));
    } catch {
      return undefined;
    }
    // 풀어서 . 이나 .. 이 되는 경로 변수는 받지 않는다(api-client도 막는다, ASVS 1.2.2)
    if (Object.values(params).some((v) => v === '' || v === '.' || v === '..')) return undefined;
    return { op: r.op, params };
  }
  return undefined;
}

function headerRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h ?? {}).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export async function orvalFetch<T>(url: string, init: RequestInit): Promise<T> {
  if (!client) throw new TypeError('api-client가 없다: 앱 시작 때 setOrvalClient(createApiClient(…))를 부른다');
  const method = (init.method ?? 'GET').toUpperCase();
  // 주소 해석이 경로를 바꾸면(.. · . 구간 정리, 역슬래시, 조각 #) 다른 작업·호스트로 새지 않게 보내지 않는다(새 맥락 리뷰, BAS-041).
  // orval은 경로 변수를 부호화해 넣으므로(urlEncodeParameters) 생성 함수의 주소에서는 바뀌지 않는다
  const raw = url.split('?')[0]!;
  const u = new URL(url, 'http://orval.invalid');
  if (url.includes('#') || raw.includes('\\') || u.pathname !== raw) throw new TypeError(`경로가 해석 중에 바뀌는 주소는 보내지 않는다: ${method} ${raw}`);
  const hit = matchOperation(method, u.pathname);
  if (!hit) throw new TypeError(`계약에 없는 작업이다: ${method} ${u.pathname}`);
  if (hit.op.sse) throw new TypeError(`SSE 흐름은 생성 함수로 부르지 않고 EventSource로 연다: ${method} ${u.pathname}`);
  // 구매 세션 쓰기는 시도마다 일련번호·MAC을 새로 만들어야 해서 생성 함수(머리를 한 번 만든다)로 보내지 않는다(ADR-0221 결정 5)
  if (hit.op.purchaseSigned) throw new TypeError(`구매 세션 쓰기는 생성 함수로 부르지 않고 client.send(OPERATIONS.…, { purchase })로 보낸다: ${method} ${u.pathname}`);
  const headers = headerRecord(init.headers);
  const idempotencyKey = headers['idempotency-key'];
  const ifMatch = headers['if-match'];
  delete headers['idempotency-key'];
  delete headers['if-match'];
  delete headers['content-type'];
  const query: Record<string, string[]> = {};
  u.searchParams.forEach((v, k) => {
    (query[k] ??= []).push(v);
  });
  // 계약이 정한 쿼리만 보낸다(경로 변수에 풀린 ? 가 쿼리를 끼워 넣는 것도 여기서 걸린다)
  const allowed = new Set(hit.op.query ?? []);
  const extra = Object.keys(query).filter((k) => !allowed.has(k));
  if (extra.length) throw new TypeError(`계약에 없는 쿼리다(${extra.join(', ')}): ${method} ${u.pathname}`);
  let body: unknown;
  if (typeof FormData !== 'undefined' && init.body instanceof FormData) body = init.body;
  else if (init.body instanceof URLSearchParams) body = init.body;
  else if (typeof init.body === 'string') body = JSON.parse(init.body);
  else if (init.body !== undefined && init.body !== null) throw new TypeError(`본문은 JSON 글자·FormData·URLSearchParams만 받는다: ${method} ${u.pathname}`);
  // T=0 본문은 객체다. 이미 JSON으로 만든 글자를 넘기면 두 번 감싸져 400이 된다
  if (hit.op.t0 && (body === null || typeof body !== 'object')) throw new TypeError(`T=0 본문은 객체여야 한다(JSON 글자를 다시 감싸지 않는다): ${method} ${u.pathname}`);
  const r = await client.send(hit.op, {
    params: hit.params,
    query: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, v.length === 1 ? v[0]! : v])),
    body,
    headers,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(ifMatch ? { ifMatch } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  return r as T;
}
