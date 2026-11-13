// 대기열 Redis의 회차 판매 설정 사본(docs/data.md `q:{event:E}:cfg`, `q:{admission}:events`, BUILD_ORDER LCH-080).
// queue-svc는 이 사본이 없으면 그 회차의 대기열을 404로 답한다. 판매 승인·정비 일이 같은 값을 다시 써도 결과가 같다.
import type { HotRedis } from '@peaket/platform';
import type { EventSaleConfig } from '../domain/event-sale-config.js';
import type { SaleConfigStore } from '../domain/sale-config-ports.js';

/** 판매 종료 + 1일(진입·입장 확정이 판매 종료 뒤에도 410을 줄 수 있게 남긴다, docs/data.md) */
const CONFIG_KEEP_AFTER_SALE_END_MS = 24 * 60 * 60_000;

export const saleConfigKey = (eventId: string) => `q:{event:${eventId}}:cfg`;
export const ADMISSION_EVENTS_KEY = 'q:{admission}:events';

export class QueueSaleConfigStore implements SaleConfigStore {
  constructor(private readonly redis: HotRedis) {}

  async put(configs: readonly EventSaleConfig[], admission: readonly { eventId: string; startsAtMs: number }[]): Promise<void> {
    for (const c of configs) {
      const key = saleConfigKey(c.eventId);
      const fields: Record<string, string> = {
        opensAtMs: String(c.opensAtMs),
        startsAtMs: String(c.startsAtMs),
        lobbyShuffle: c.lobbyShuffle ? '1' : '0',
        openBatch: c.openBatch ? '1' : '0',
        lobbyMinutes: String(c.lobbyMinutes),
        rev: String(c.rev),
        /** core DB 사본을 읽는 쪽(BAT-051)이 같은 모양을 쓸 수 있게 전체 값을 함께 둔다 */
        config: JSON.stringify(c),
        salePolicy: JSON.stringify(c.salePolicy),
        eligGates: JSON.stringify(c.eligGates),
        eligLists: JSON.stringify(c.eligLists),
        ...(c.layoutVersion !== undefined ? { layoutVersion: String(c.layoutVersion) } : {}),
        ...(c.pgKey !== undefined ? { pgKey: c.pgKey } : {}),
        ...(c.pgTps !== undefined ? { pgTps: String(c.pgTps) } : {}),
      };
      await this.redis.sendCommand(['HSET', key, ...Object.entries(fields).flat()]);
      await this.redis.sendCommand(['PEXPIREAT', key, String(c.saleEndsAtMs + CONFIG_KEEP_AFTER_SALE_END_MS)]);
    }
    if (admission.length > 0) {
      await this.redis.sendCommand(['ZADD', ADMISSION_EVENTS_KEY, ...admission.flatMap((a) => [String(a.startsAtMs), a.eventId])]);
    }
  }

  async get(eventId: string): Promise<EventSaleConfig | undefined> {
    const raw = (await this.redis.sendCommand(['HGETALL', saleConfigKey(eventId)])) as string[] | null;
    if (!raw || raw.length === 0) return undefined;
    const h = new Map<string, string>();
    for (let i = 0; i + 1 < raw.length; i += 2) h.set(raw[i]!, raw[i + 1]!);
    const config = h.get('config');
    return config === undefined ? undefined : (JSON.parse(config) as EventSaleConfig);
  }
}
