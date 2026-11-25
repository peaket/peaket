// 적용 확인의 Prometheus 즉시 질의 어댑터(F-02-5 OPS-300, ADR-0365 결정 15, ASVS 1.3.6, C-T54).
// 주소는 PEAKET_PROMETHEUS_URL에서만 읽고, 라벨 값은 질의 직전에 다시 검사한다. 한 질의는 2초 [가정] 안에 끝나야 한다.
import { createExternalHttpClient, isProductionLikeEnv, PlatformConfigError, type ExternalHttpClient } from '@peaket/platform';
import type { ProbeResult } from '../domain/apply-check.js';
import type { SettingsApplyProbe } from '../domain/ports.js';

/** 시험이 바꿔 끼우는 fetch 꼴(직접 호출은 공용 클라이언트 대신 이 자리에만 둔다) */
type FetchLike = (input: URL, init?: { method?: string; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export const PROMETHEUS_URL_ENV = 'PEAKET_PROMETHEUS_URL';
export const PROM_LABEL_VALUE = /^[A-Za-z0-9:_-]{1,200}$/;
/** 질의할 수 있는 서비스(설정을 읽는 일곱 + core-svc 후기 플래그 + trust-svc 강도) */
const PROBE_SERVICES = ['core-svc', 'identity-svc', 'ops-svc', 'payment-svc', 'purchase-svc', 'queue-svc', 'ticket-svc', 'trust-svc'] as const;

interface VectorEntry {
  readonly metric?: Record<string, string>;
  readonly value?: readonly [number | string, string];
}

/** Prometheus HTTP API v1 즉시 질의 응답 하나를 읽는다. 꼴이 틀리면 던진다 */
function vectorOf(body: unknown): readonly VectorEntry[] {
  if (typeof body !== 'object' || body === null) throw new Error('prometheus-response');
  const b = body as { status?: unknown; data?: { resultType?: unknown; result?: unknown } };
  if (b.status !== 'success' || b.data?.resultType !== 'vector' || !Array.isArray(b.data.result)) throw new Error('prometheus-response');
  return b.data.result as VectorEntry[];
}

export class PrometheusSettingsProbe implements SettingsApplyProbe {
  readonly #url: string;
  readonly #fetch: FetchLike | undefined;
  readonly #client: ExternalHttpClient | undefined;
  readonly #timeoutMs: number;
  constructor(o: { readonly url: string; readonly fetch?: FetchLike; readonly timeoutMs?: number }) {
    this.#url = o.url;
    this.#timeoutMs = o.timeoutMs ?? 2_000;
    // 시험이 fetch를 바꿔 끼우면 그대로 쓰고, 운영은 공용 바깥 호출 클라이언트를 쓴다(ASVS 15.3.2)
    if (o.fetch) {
      this.#fetch = o.fetch;
      this.#client = undefined;
    } else {
      this.#fetch = undefined;
      this.#client = createExternalHttpClient({ provider: 'prometheus', baseUrl: o.url, timeoutCapMs: this.#timeoutMs });
    }
  }

  /** 라벨 두 개를 검사한다(서비스 목록·문자 집합·길이). 어긋나면 질의하지 않는다 */
  #labelError(service: string, messageKey: string): string | undefined {
    if (!(PROBE_SERVICES as readonly string[]).includes(service)) return 'invalid-label';
    if (!PROM_LABEL_VALUE.test(service) || !PROM_LABEL_VALUE.test(messageKey)) return 'invalid-label';
    return undefined;
  }

  async #query(query: string): Promise<readonly VectorEntry[]> {
    if (this.#client) {
      try {
        const res = await this.#client.request({ method: 'GET', path: '/api/v1/query', query: { query }, timeoutCapMs: this.#timeoutMs });
        if (!res.ok) throw new Error(`prometheus-http-${res.status}`);
        return vectorOf(await res.json());
      } catch (err) {
        if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError' || (err as { type?: unknown }).type === 'deadline-exceeded')) throw new Error('prometheus-timeout');
        throw err;
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('prometheus-timeout'), { name: 'AbortError' })), this.#timeoutMs);
    try {
      const url = new URL('/api/v1/query', this.#url);
      url.searchParams.set('query', query);
      const res = await this.#fetch!(url, { method: 'GET', signal: controller.signal });
      if (!res.ok) throw new Error(`prometheus-http-${res.status}`);
      return vectorOf(await res.json());
    } catch (err) {
      if (controller.signal.aborted) throw new Error('prometheus-timeout');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async probe(q: { readonly service: string; readonly messageKey: string; readonly version: number }): Promise<ProbeResult> {
    const bad = this.#labelError(q.service, q.messageKey);
    if (bad !== undefined) return { ok: false, reason: bad };
    try {
      // 두 질의를 함께 보낸다(한 시간 한도 안에 둘 다 끝나야 한다)
      const [up, versions] = await Promise.all([
        this.#query(`up{service="${q.service}"} == 1`),
        this.#query(`control_settings_applied_version{service="${q.service}",key="${q.messageKey}"}`),
      ]);
      const pods = up
        .map((e) => e.metric?.pod)
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .map((pod) => ({ pod }) as { pod: string; version?: number });
      if (pods.length === 0) return { ok: true, pods: [] };
      const byPod = new Map<string, number>();
      for (const e of versions) {
        const pod = e.metric?.pod;
        if (typeof pod !== 'string') continue;
        const raw = Array.isArray(e.value) ? e.value[1] : undefined;
        if (raw === undefined) throw new Error('prometheus-response');
        const version = Number(raw);
        if (!Number.isFinite(version)) throw new Error('prometheus-response');
        byPod.set(pod, version);
      }
      return { ok: true, pods: pods.map((p) => (byPod.has(p.pod) ? { pod: p.pod, version: byPod.get(p.pod)! } : p)) };
    } catch (err) {
      return { ok: false, reason: err instanceof Error && err.message.length > 0 ? err.message : 'prometheus-unavailable' };
    }
  }
}

/** 늘 prometheus-not-wired인 어댑터(local·ci에서 주소가 없을 때) */
class NotWiredProbe implements SettingsApplyProbe {
  async probe(): Promise<ProbeResult> {
    return { ok: false, reason: 'prometheus-not-wired' };
  }
}

/**
 * 환경 값에서 적용 확인 질의를 조립한다(ADR-0365 결정 15). 운영과 같은 환경에서 주소가 없으면 시작 실패,
 * 그 밖(local·ci·demo)에서는 늘 UNKNOWN(prometheus-not-wired)이다.
 * @throws PlatformConfigError 운영과 같은 환경에서 PEAKET_PROMETHEUS_URL이 없음
 */
export function settingsProbeFromEnv(env: Record<string, string | undefined>): SettingsApplyProbe {
  const url = env[PROMETHEUS_URL_ENV]?.trim();
  if (!url) {
    if (isProductionLikeEnv(env)) throw new PlatformConfigError(`${PROMETHEUS_URL_ENV}가 없다(운영과 같은 환경에서는 적용 확인 질의 주소가 있어야 한다)`);
    return new NotWiredProbe();
  }
  return new PrometheusSettingsProbe({ url });
}
