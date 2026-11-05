// 공연 상세 앞 거르기(ADR-0201 결정 3, ADR-0200 결정 3, BUILD_ORDER HOT-311). proxy.ts가 `/events/{id}`를 그리기 전에 부른다.
// - 회차 ID 모양(UUID)이 틀리면 서버에 묻지 않고 '없음'이다(서버도 모양 틀린 ID를 같은 404로 답한다).
// - 대문자가 섞인 ID는 소문자 주소로 옮긴다(canonicalEventPath). 대소문자 변형마다 CDN·ISR 항목과 원본 호출이 따로 생기지 않게 한다.
// - 모양이 맞으면 서버 API(`GET /v1/events/{eventId}`)에 묻는다. 404면 '없음'이고, 200·410은 '통과'다(410은 화면이 판매 중지 안내를 그린다).
//   200이면 응답의 공연 ID를 함께 기억해 CDN 태그 머리(`production:{id}`)에 쓴다(ADR-0200 결정 5, docs/infra.md §4.1).
// - 시간 초과 300ms [가정](본문 읽기 포함). 실패하거나 시간을 넘기면 '통과'이고 기억하지 않는다(원본 장애 때 POL-029 고정 문구·stale-if-error를 막지 않는다).
// - 답(200·404·410)은 60초 [가정] 기억하고 1만 개 [가정]까지 둔다(넘으면 가장 오래된 것부터 버린다). 같은 회차를 묻는 중이면 그 답을 같이 기다린다.
//   '없음'은 어느 경로에도 맞지 않는 주소로 재작성해 Next.js의 404 화면을 낸다(proxy.ts). 회차 주소마다 ISR 항목이 생기지 않는다.

const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DETAIL_PATH = /^\/events\/([^/]+)$/;

export interface GateResult {
  kind: 'pass' | 'missing';
  /** 서버가 200으로 답했을 때의 공연 ID(소문자) */
  productionId?: string;
}

/** `/events/{id}`의 id(상세 주소만). 아래 경로(`/events/{id}/shuffle-proof`)는 거르지 않는다 */
export function eventIdFromPath(pathname: string): string | undefined {
  return DETAIL_PATH.exec(pathname)?.[1];
}

/** 대문자가 섞인 회차 ID의 상세 주소면 소문자 주소. 그 밖은 undefined */
export function canonicalEventPath(pathname: string): string | undefined {
  const id = eventIdFromPath(pathname);
  if (!id || !ID_SHAPE.test(id) || id === id.toLowerCase()) return undefined;
  return `/events/${id.toLowerCase()}`;
}

/** CDN 태그 머리 값(ISR 태그와 같은 값, 소문자) */
export function eventCacheTags(eventId: string, productionId: string | undefined): string {
  return productionId ? `event:${eventId.toLowerCase()},production:${productionId}` : `event:${eventId.toLowerCase()}`;
}

export interface EventGate {
  check(eventId: string): Promise<GateResult>;
  size(): number;
  readonly maxEntries: number;
}

const PASS: GateResult = { kind: 'pass' };
const MISSING: GateResult = { kind: 'missing' };

export function createEventGate({
  apiOrigin,
  fetch: fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 300,
  ttlMs = 60_000,
  maxEntries = 10_000,
}: {
  apiOrigin: string | undefined;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
  maxEntries?: number;
}): EventGate {
  const memo = new Map<string, { result: GateResult; until: number }>();
  const inflight = new Map<string, Promise<GateResult>>();

  function remember(id: string, result: GateResult) {
    memo.delete(id);
    memo.set(id, { result, until: now() + ttlMs });
    while (memo.size > maxEntries) memo.delete(memo.keys().next().value!);
  }

  async function ask(id: string): Promise<GateResult> {
    try {
      const res = await fetchImpl(`${apiOrigin!.replace(/\/+$/, '')}/v1/events/${id}`, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
      if (res.status === 404) {
        void res.body?.cancel().catch(() => {});
        remember(id, MISSING);
        return MISSING;
      }
      if (res.status === 200) {
        const body = (await res.json().catch(() => undefined)) as { productionId?: unknown } | undefined;
        const p = typeof body?.productionId === 'string' && ID_SHAPE.test(body.productionId) ? body.productionId.toLowerCase() : undefined;
        const result: GateResult = p ? { kind: 'pass', productionId: p } : PASS;
        remember(id, result);
        return result;
      }
      void res.body?.cancel().catch(() => {});
      if (res.status === 410) remember(id, PASS);
      return PASS;
    } catch {
      return PASS;
    }
  }

  return {
    maxEntries,
    size: () => memo.size,
    async check(eventId) {
      if (!ID_SHAPE.test(eventId)) return MISSING;
      if (!apiOrigin) return PASS;
      const id = eventId.toLowerCase();
      const hit = memo.get(id);
      if (hit && hit.until > now()) return hit.result;
      if (hit) memo.delete(id);
      const pending = inflight.get(id);
      if (pending) return pending;
      const p = ask(id).finally(() => inflight.delete(id));
      inflight.set(id, p);
      return p;
    },
  };
}
