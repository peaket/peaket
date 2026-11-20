// 대기열 Redis의 회차 판매 설정 사본(docs/data.md `q:{event:E}:cfg`, `q:{event:E}:epoch`, `q:{admission}:events`, BUILD_ORDER LCH-080, BAT-616 ADR-0327).
// queue-svc는 이 사본이 없으면 그 회차의 대기열을 404로 답한다. 판매 승인·정비 일이 같은 값을 다시 써도 결과가 같다.
// 한 Lua에서 ① `rev`가 지금보다 클 때만 값·수명을 쓰고 ② `q:epoch`의 `node`가 없을 때만 지금 노드 표지를 쓴다.
// 노드 표지는 queue-svc의 진입 Lua와 같은 모양(`{CLUSTER MYID}:{cluster_my_epoch}`, 단일 노드는 `standalone`)이다(ADR-0181).
import { redisScript } from '@peaket/platform';
import type { HotRedis } from '@peaket/platform';
import type { EventSaleConfig } from '../domain/event-sale-config.js';
import type { DueEventConfig, SaleConfigStore } from '../domain/sale-config-ports.js';

/** 판매 종료 + 1일(진입·입장 확정이 판매 종료 뒤에도 410을 줄 수 있게 남긴다, docs/data.md) */
const CONFIG_KEEP_AFTER_SALE_END_MS = 24 * 60 * 60_000;

export const saleConfigKey = (eventId: string) => `q:{event:${eventId}}:cfg`;
export const saleEpochKey = (eventId: string) => `q:{event:${eventId}}:epoch`;
export const ADMISSION_EVENTS_KEY = 'q:{admission}:events';

// KEYS: 1 q:cfg, 2 q:epoch. ARGV: 1 rev, 2 키 만료 시각(ms), 3.. 칸 이름·값 쌍.
// rev가 없거나 새 rev가 더 클 때만 HSET·PEXPIREAT을 한다(같은 rev·낮은 rev는 아무것도 바꾸지 않는다). q:epoch의 node는 없을 때만 쓰고 수명은 더 늦은 쪽으로만 늘린다.
export const SALE_CONFIG_LUA = `#!lua
local function extend(key, at)
  if redis.call('PEXPIRETIME', key) < tonumber(at) then redis.call('PEXPIREAT', key, at) end
end
local function myId()
  local id = redis.pcall('CLUSTER', 'MYID')
  if type(id) == 'table' and id.err then
    if string.find(id.err, 'cluster support disabled', 1, true) then return 'standalone' end
    error('PEAKET_NODE_ID ' .. id.err)
  end
  return id
end
local function nodeId()
  local id = myId()
  if id == 'standalone' then return id end
  return id .. ':' .. (string.match(redis.call('CLUSTER', 'INFO'), 'cluster_my_epoch:(%d+)') or '0')
end
local held = tonumber(redis.call('HGET', KEYS[1], 'rev'))
local rev = tonumber(ARGV[1])
local wrote = 0
if held == nil or rev > held then
  local fields = {}
  for i = 3, #ARGV do fields[#fields + 1] = ARGV[i] end
  redis.call('HSET', KEYS[1], unpack(fields))
  redis.call('PEXPIREAT', KEYS[1], ARGV[2])
  wrote = 1
end
if not redis.call('HGET', KEYS[2], 'node') then redis.call('HSET', KEYS[2], 'node', nodeId()) end
extend(KEYS[2], ARGV[2])
return {wrote}
`;

export class QueueSaleConfigStore implements SaleConfigStore {
  readonly #script = redisScript(SALE_CONFIG_LUA);

  constructor(private readonly redis: HotRedis) {}

  async put(configs: readonly EventSaleConfig[], admission: readonly { eventId: string; startsAtMs: number }[]): Promise<void> {
    for (const c of configs) {
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
      const key = saleConfigKey(c.eventId);
      const keepUntilMs = c.saleEndsAtMs + CONFIG_KEEP_AFTER_SALE_END_MS;
      if (typeof this.redis.evalScript === 'function') {
        await this.redis.evalScript(this.#script, [saleConfigKey(c.eventId), saleEpochKey(c.eventId)], [String(c.rev), String(keepUntilMs), ...Object.entries(fields).flat()]);
        continue;
      }
      // 시험 대역(HotRedis가 아닌 sendCommand만 있는 저장소)은 같은 규칙을 명령 여러 번으로 흉내 낸다. 운영은 위의 Lua 하나다
      const held = (await this.redis.sendCommand(['HGET', key, 'rev'])) as string | null;
      if (held === null || held === undefined || Number(c.rev) > Number(held)) {
        await this.redis.sendCommand(['HSET', key, ...Object.entries(fields).flat()]);
        await this.redis.sendCommand(['PEXPIREAT', key, String(keepUntilMs)]);
      }
      const epochKey = saleEpochKey(c.eventId);
      const node = (await this.redis.sendCommand(['HGET', epochKey, 'node'])) as string | null;
      if (node === null || node === undefined) await this.redis.sendCommand(['HSET', epochKey, 'node', 'standalone']);
      const epochKeep = (await this.redis.sendCommand(['PEXPIRETIME', epochKey])) as number | string;
      if (Number(epochKeep) < keepUntilMs) await this.redis.sendCommand(['PEXPIREAT', epochKey, String(keepUntilMs)]);
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

  /** 대기열 사본은 회차 정산 원천이 아니다. 정산 스케줄러는 core DB 사본을 읽는다. */
  async listEndedBefore(): Promise<DueEventConfig[]> {
    return [];
  }

  async commissionRateBp(eventId: string): Promise<number | undefined> {
    const config = await this.get(eventId);
    return config?.commissionRateBp;
  }
}
