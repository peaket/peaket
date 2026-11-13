// core-svc의 회차 판매 설정 사본을 읽는 어댑터(BAT-051, HOT-252). purchase-svc는 core DB에 직접 접속하지 않는다.
// 경로: GET {PEAKET_CORE_HTTP_URL}/internal/v1/events/{eventId}/sale-config (core-svc InternalSaleConfigController).
// 짧게 캐시한다(기본 5초 [가정]): 홀드마다 core-svc를 부르지 않으면서 판매 승인·설정 고치기의 새 판을 곧 받는다.
// 404는 '그 회차 사본 없음'으로 캐시하고(로컬·CI처럼 승인 전 회차는 좌석맵 판 파일 설정을 쓴다), 그 밖의 실패는 던져 홀드를 503으로 닫는다.
import type { Clock, ExternalHttpClient } from '@peaket/platform';
import { KEY_PART } from '../domain/hold.js';
import type { EventSaleConfigOverlay } from '../domain/sale-config.js';
import { SaleConfigUnavailable } from '../domain/sale-config.js';

const DEFAULT_TTL_MS = 5_000;
const MISSING_TTL_MS = 1_000;
const MAX_ENTRIES = 4096;
const LIST_KEY = /^[a-z0-9-]{3,32}$/;
const U32_MAX = 0xffff_ffff;

interface Entry {
  until: number;
  value: EventSaleConfigOverlay | null;
}

const isSafeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** core-svc가 답한 JSON을 EventSaleConfigOverlay로 읽는다. 모양이 틀리면 SaleConfigUnavailable(닫힌 쪽) */
export function overlayOf(raw: unknown): EventSaleConfigOverlay {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new SaleConfigUnavailable('payload');
  const o = raw as Record<string, unknown>;
  if (!isSafeInt(o.rev) || o.rev < 1) throw new SaleConfigUnavailable('rev');
  if (!isSafeInt(o.perPersonLimit) || o.perPersonLimit < 1 || o.perPersonLimit > 4) throw new SaleConfigUnavailable('perPersonLimit');
  if (!isSafeInt(o.saleEndsAtMs) || o.saleEndsAtMs < 0) throw new SaleConfigUnavailable('saleEndsAtMs');
  if (!Array.isArray(o.salePolicy)) throw new SaleConfigUnavailable('salePolicy');
  if (!Array.isArray(o.eligLists) || o.eligLists.length > 10 || !o.eligLists.every((k) => typeof k === 'string' && LIST_KEY.test(k))) throw new SaleConfigUnavailable('eligLists');
  if (new Set(o.eligLists).size !== o.eligLists.length) throw new SaleConfigUnavailable('eligLists');
  if (o.layoutVersion !== undefined && (!isSafeInt(o.layoutVersion) || o.layoutVersion < 1 || o.layoutVersion > U32_MAX)) throw new SaleConfigUnavailable('layoutVersion');
  return {
    rev: o.rev,
    perPersonLimit: o.perPersonLimit,
    saleEndsAtMs: o.saleEndsAtMs,
    salePolicy: o.salePolicy as EventSaleConfigOverlay['salePolicy'],
    eligLists: o.eligLists as string[],
    ...(o.layoutVersion !== undefined ? { layoutVersion: o.layoutVersion } : {}),
  };
}

export interface CoreSaleConfigsOptions {
  client: Pick<ExternalHttpClient, 'request'>;
  clock: Clock;
  /** 새 사본을 다시 읽기까지(ms, 기본 5초 [가정]) */
  ttlMs?: number;
}

/**
 * 판매 설정 사본 읽기. get은 사본이 없으면 undefined, 읽지 못하면 SaleConfigUnavailable을 던진다(던지지 않는 계약이 아니다).
 * 같은 회차의 동시 요청은 한 번만 부른다(진행 중인 약속을 공유한다).
 */
export class CoreSaleConfigs {
  readonly #cache = new Map<string, Entry>();
  readonly #loading = new Map<string, Promise<EventSaleConfigOverlay | undefined>>();
  readonly #ttlMs: number;

  constructor(private readonly o: CoreSaleConfigsOptions) {
    this.#ttlMs = o.ttlMs ?? DEFAULT_TTL_MS;
  }

  async get(eventId: string): Promise<EventSaleConfigOverlay | undefined> {
    if (typeof eventId !== 'string' || !KEY_PART.test(eventId)) return undefined;
    const now = this.o.clock.now();
    const hit = this.#cache.get(eventId);
    if (hit && now < hit.until) return hit.value ?? undefined;
    let p = this.#loading.get(eventId);
    if (!p) {
      p = this.#fetch(eventId, now).finally(() => this.#loading.delete(eventId));
      this.#loading.set(eventId, p);
    }
    return p;
  }

  async #fetch(eventId: string, now: number): Promise<EventSaleConfigOverlay | undefined> {
    let res: Response;
    try {
      res = await this.o.client.request({ method: 'GET', path: '/internal/v1/events/{eventId}/sale-config', params: { eventId }, timeoutCapMs: 200 });
    } catch (err) {
      throw new SaleConfigUnavailable('request', { cause: err });
    }
    if (res.status === 404) {
      this.#remember(eventId, now, null, MISSING_TTL_MS);
      return undefined;
    }
    if (!res.ok) throw new SaleConfigUnavailable(`status ${res.status}`);
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (err) {
      throw new SaleConfigUnavailable('json', { cause: err });
    }
    const value = overlayOf(raw);
    this.#remember(eventId, now, value, this.#ttlMs);
    return value;
  }

  #remember(eventId: string, now: number, value: EventSaleConfigOverlay | null, ttlMs: number): void {
    this.#cache.delete(eventId);
    this.#cache.set(eventId, { until: now + ttlMs, value });
    while (this.#cache.size > MAX_ENTRIES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}
