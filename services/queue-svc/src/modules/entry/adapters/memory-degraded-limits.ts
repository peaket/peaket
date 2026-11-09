// 축소 운영의 파드 메모리 한도(docs/features/bot-defense.md §11.2, ADR-0248): trust-svc 판정을 받지 못할 때 기기·계정마다 10초에 5회 [가정]를 파드 메모리에서 센다.
// 저장소에 기기 식별값을 쓰지 않으려는 것이다. 그래서 실제 상한은 파드 수만큼 커진다(게이트웨이 로컬 한도와 같은 한계).
// IP는 ASN 분류표로 호스팅·프록시 대역일 때만 같은 한도를 건다. 통신사 대역과 분류표에 없는 ASN은 많은 사람이 나눠 쓰므로 IP로 막지 않는다(기술 검토 낮음-066).
import { isIP } from 'node:net';
import type { Clock } from '@peaket/platform';
import type { DegradedLimits, RiskClient } from '../domain/ports.js';

const LIMIT = 5;
const WINDOW_MS = 10_000;
/** 파드 메모리 키 수 상한 [가정]: 넘으면 오래된 창부터 잊는다(무작위 값으로 메모리를 키우지 못하게) */
const MAX_KEYS = 200_000;

interface Window {
  startedAt: number;
  count: number;
}

export class MemoryDegradedLimits implements DegradedLimits {
  readonly #windows = new Map<string, Window>();
  readonly #maxKeys: number;

  constructor(
    private readonly clock: Clock,
    private readonly asn: { classify(asn: number): 'HOSTING' | 'PROXY' | 'OTHER' },
    o: { maxKeys?: number } = {},
  ) {
    this.#maxKeys = o.maxKeys ?? MAX_KEYS;
  }

  allow(i: { deviceId: string; pid: string; client?: RiskClient }): boolean {
    const now = this.clock.now();
    const keys: string[] = [];
    if (i.deviceId) keys.push(`d|${i.deviceId}`);
    if (i.pid) keys.push(`p|${i.pid}`);
    const ip = i.client?.ip;
    if (ip && isIP(ip) !== 0 && i.client && this.asn.classify(i.client.asn) !== 'OTHER') keys.push(`i|${ip}`);
    // 이미 넘은 요청은 다른 키를 새로 넣지 않는다(무작위 값을 바꿔 메모리를 키우지 못하게). 그 밖에는 모든 키를 함께 센다
    for (const key of keys) {
      const w = this.#windows.get(key);
      if (w && now - w.startedAt < WINDOW_MS && w.count >= LIMIT) return false;
    }
    for (const key of keys) this.#count(key, now);
    return true;
  }

  /** 창이 지났으면 새 창을 뒤에 넣어 Map 차례가 시작 시각 차례와 맞게 둔다(앞에서부터 지우면 오래된 창이 먼저 빠진다) */
  #count(key: string, now: number): void {
    const w = this.#windows.get(key);
    if (!w || now - w.startedAt >= WINDOW_MS) {
      this.#windows.delete(key);
      while (this.#windows.size >= this.#maxKeys) this.#windows.delete(this.#windows.keys().next().value as string);
      this.#windows.set(key, { startedAt: now, count: 1 });
      return;
    }
    w.count += 1;
  }

  /** 시험·지표용 */
  size(): number {
    return this.#windows.size;
  }
}
