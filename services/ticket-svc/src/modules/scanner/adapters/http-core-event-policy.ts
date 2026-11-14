// core-svc의 회차 판매·입장 창을 읽는 어댑터(GAT-170 잔여, offline-gate §6.2).
// ticket-svc는 core DB에 직접 붙지 않는다. purchase-svc와 같은 내부 경로
// `GET {PEAKET_CORE_HTTP_URL}/internal/v1/events/{eventId}/sale-config`를 읽고 짧게 캐시한다.
// 답하지 못하면 undefined다. 배치의 OUT 판정은 undefined를 '모른다'로 닫고(503), 근무 준비는 창을 비운다.
import type { Clock, ExternalHttpClient } from '@peaket/platform';
import type { ScannerEventPolicy, ScannerEventPolicyProvider } from '../domain/ports.js';

const DEFAULT_TTL_MS = 5_000;
const MISSING_TTL_MS = 1_000;
const MAX_ENTRIES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Entry {
  until: number;
  value: ScannerEventPolicy | undefined;
}

const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

/** core-svc 내부 응답을 ScannerEventPolicy로 읽는다. 모양이 틀리면 undefined(닫힌 쪽) */
export function eventPolicyOf(raw: unknown): ScannerEventPolicy | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.reentryAllowed !== 'boolean') return undefined;
  if (typeof o.promoterId !== 'string' || o.promoterId === '') return undefined;
  const salesOpensAtMs = int(o.opensAtMs);
  const salesEndsAtMs = int(o.saleEndsAtMs);
  const endsAtMs = int(o.endsAtMs);
  const entryOpensAtMs = o.entryOpensAtMs === null ? null : int(o.entryOpensAtMs);
  const entryClosesAtMs = o.entryClosedAtMs === null ? null : int(o.entryClosedAtMs);
  return {
    promoterId: o.promoterId,
    reentryAllowed: o.reentryAllowed,
    ...(salesOpensAtMs !== undefined ? { salesOpensAtMs } : {}),
    ...(salesEndsAtMs !== undefined ? { salesEndsAtMs } : {}),
    ...(endsAtMs !== undefined ? { endsAtMs } : {}),
    ...(entryOpensAtMs !== undefined && entryOpensAtMs !== null ? { entryOpensAtMs } : {}),
    ...(entryClosesAtMs !== undefined && entryClosesAtMs !== null ? { entryClosesAtMs } : {}),
  };
}

export interface HttpCoreEventPolicyOptions {
  client: Pick<ExternalHttpClient, 'request'>;
  clock: Clock;
  ttlMs?: number;
}

export class HttpCoreEventPolicy implements ScannerEventPolicyProvider {
  readonly #cache = new Map<string, Entry>();
  readonly #loading = new Map<string, Promise<ScannerEventPolicy | undefined>>();
  readonly #ttlMs: number;

  constructor(private readonly o: HttpCoreEventPolicyOptions) {
    this.#ttlMs = o.ttlMs ?? DEFAULT_TTL_MS;
  }

  async get(eventId: string): Promise<ScannerEventPolicy | undefined> {
    if (!UUID.test(eventId)) return undefined;
    const now = this.o.clock.now();
    const hit = this.#cache.get(eventId);
    if (hit && now < hit.until) return hit.value;
    let p = this.#loading.get(eventId);
    if (!p) {
      p = this.#fetch(eventId, now).finally(() => this.#loading.delete(eventId));
      this.#loading.set(eventId, p);
    }
    return p;
  }

  async #fetch(eventId: string, now: number): Promise<ScannerEventPolicy | undefined> {
    let res: Response;
    try {
      res = await this.o.client.request({ method: 'GET', path: '/internal/v1/events/{eventId}/sale-config', params: { eventId }, timeoutCapMs: 300 });
    } catch {
      return undefined;
    }
    if (res.status === 404) {
      this.#remember(eventId, now, undefined, MISSING_TTL_MS);
      return undefined;
    }
    if (!res.ok) return undefined;
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      return undefined;
    }
    const value = eventPolicyOf(raw);
    if (value === undefined) return undefined;
    this.#remember(eventId, now, value, this.#ttlMs);
    return value;
  }

  #remember(eventId: string, now: number, value: ScannerEventPolicy | undefined, ttlMs: number): void {
    this.#cache.delete(eventId);
    this.#cache.set(eventId, { until: now + ttlMs, value });
    while (this.#cache.size > MAX_ENTRIES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}
