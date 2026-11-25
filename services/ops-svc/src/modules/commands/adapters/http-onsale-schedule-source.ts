// core-svc 온세일 오픈 일정 읽기 어댑터(F-02-5 OPS-300, TR-03, ADR-0334 결정 3, C-T75 ①).
// GET <baseUrl>/internal/v1/events/onsale-opens?from=<ISO>&to=<ISO>에 서비스 사이 토큰을 싣고,
// { items: [{ eventId, opensAt(ISO), scale }] }를 읽는다. 200이 아니거나 꼴이 틀리면 던진다.
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import type { OnsaleOpen, OnsaleScheduleSource } from '../domain/log-sampling.js';

const SCALES = ['LARGE', 'MEDIUM', 'SMALL'] as const;

/** 시험이 바꿔 끼우는 fetch 꼴(직접 호출은 공용 클라이언트 대신 이 자리에만 둔다) */
type FetchLike = (input: URL, init?: { method?: string; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export class HttpOnsaleScheduleSource implements OnsaleScheduleSource {
  readonly #baseUrl: string;
  readonly #token: string | undefined;
  readonly #fetch: FetchLike | undefined;
  readonly #client: ExternalHttpClient | undefined;
  readonly #timeoutMs: number;
  constructor(o: { readonly baseUrl: string; readonly token?: string; readonly fetch?: FetchLike; readonly timeoutMs?: number }) {
    this.#baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.#token = o.token;
    this.#timeoutMs = o.timeoutMs ?? 2_000;
    if (o.fetch) {
      this.#fetch = o.fetch;
      this.#client = undefined;
    } else {
      this.#fetch = undefined;
      this.#client = createExternalHttpClient({ provider: 'core-svc', baseUrl: this.#baseUrl, timeoutCapMs: this.#timeoutMs });
    }
  }

  /** 응답 꼴을 확인한다. 틀리면 던진다 */
  #parse(body: unknown): readonly OnsaleOpen[] {
    if (typeof body !== 'object' || body === null) throw new Error('onsale-schedule-response');
    const items = (body as { items?: unknown }).items;
    if (!Array.isArray(items)) throw new Error('onsale-schedule-response');
    return items.map((item) => {
      const r = item as { eventId?: unknown; opensAt?: unknown; scale?: unknown };
      if (typeof r.eventId !== 'string' || r.eventId === '') throw new Error('onsale-schedule-response');
      if (typeof r.opensAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(r.opensAt)) throw new Error('onsale-schedule-response');
      const opensAtMs = Date.parse(r.opensAt);
      if (!Number.isFinite(opensAtMs)) throw new Error('onsale-schedule-response');
      if (r.scale !== null && !(SCALES as readonly unknown[]).includes(r.scale)) throw new Error('onsale-schedule-response');
      return { eventId: r.eventId, opensAtMs, scale: r.scale as OnsaleOpen['scale'] };
    });
  }

  async opensBetween(fromMs: number, untilMs: number): Promise<readonly OnsaleOpen[]> {
    const from = new Date(fromMs).toISOString();
    const to = new Date(untilMs).toISOString();
    const headers = this.#token !== undefined ? { 'x-peaket-internal-token': this.#token } : undefined;
    if (this.#client) {
      try {
        const res = await this.#client.request({ method: 'GET', path: '/internal/v1/events/onsale-opens', query: { from, to }, ...(headers ? { headers } : {}), timeoutCapMs: this.#timeoutMs });
        if (!res.ok) throw new Error(`onsale-schedule-http-${res.status}`);
        return this.#parse(await res.json());
      } catch (err) {
        if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError' || (err as { type?: unknown }).type === 'deadline-exceeded')) throw new Error('onsale-schedule-timeout');
        throw err;
      }
    }
    const url = new URL(`${this.#baseUrl}/internal/v1/events/onsale-opens`);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('onsale-schedule-timeout'), { name: 'AbortError' })), this.#timeoutMs);
    try {
      const res = await this.#fetch!(url, { method: 'GET', signal: controller.signal, ...(headers ? { headers } : {}) });
      if (!res.ok) throw new Error(`onsale-schedule-http-${res.status}`);
      return this.#parse(await res.json());
    } finally {
      clearTimeout(timer);
    }
  }
}
