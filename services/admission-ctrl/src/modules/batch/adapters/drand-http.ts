// drand 중계 호출(ADR-0239 결정 4): 플랫폼 바깥 호출 클라이언트로 짧게 끊는다. 다른 사람의 서버라 응답 크기도 끊는다.
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import type { BeaconHttp } from './drand-beacon.js';

/** 중계마다 마감 2초 [가정] */
export const RELAY_TIMEOUT_MS = 2_000;
/** 응답 본문 상한 4 KiB [가정](drand 응답은 200바이트 안팎이다) */
export const RELAY_BODY_MAX_BYTES = 4_096;
const PATH = /^\/([0-9a-f]{64}|[A-Za-z0-9_-]+)\/public\/(\d{1,16})$/;

export interface ExternalBeaconHttpOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function readLimited(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > RELAY_BODY_MAX_BYTES) throw new Error('drand 응답이 너무 크다');
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(parts).toString('utf8');
}

export function externalBeaconHttp(relays: readonly string[], o: ExternalBeaconHttpOptions = {}): BeaconHttp {
  const clients = new Map<string, ExternalHttpClient>(relays.map((relay) => [relay.replace(/\/+$/, ''), createExternalHttpClient({ provider: 'drand', baseUrl: relay, timeoutCapMs: o.timeoutMs ?? RELAY_TIMEOUT_MS, ...(o.fetchImpl ? { fetch: o.fetchImpl } : {}) })]));
  return {
    async get(url) {
      for (const [relay, client] of clients) {
        if (!url.startsWith(`${relay}/`)) continue;
        const m = PATH.exec(url.slice(relay.length));
        if (!m) throw new Error('drand 경로가 틀렸다');
        const res = await client.request({ method: 'GET', path: '/{chain}/public/{round}', params: { chain: m[1]!, round: m[2]! } });
        if (res.status !== 200) {
          await res.body?.cancel().catch(() => undefined);
          return { status: res.status, body: null };
        }
        return { status: 200, body: JSON.parse(await readLimited(res)) as unknown };
      }
      throw new Error('목록에 없는 drand 중계 주소다');
    },
  };
}
