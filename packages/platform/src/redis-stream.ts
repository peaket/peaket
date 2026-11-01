// Redis Stream 정리(openspec 변경 add-maintenance-control-and-consumers 결정 15, ADR-0070, docs/data.md §3 `s:{event:E}:stream`).
// 좌석 Redis Stream 릴레이가 Kafka 전송 확인을 받은 항목까지 XACK한 뒤 XTRIM … MINID로 지운다. 확인하지 않은 항목은 지우지 않는다.
// 키는 회차 판매 종료 + 1일 [가정]에 만료된다. Redis 클라이언트는 V-T33(wbs 0.5.1)에서 고르므로 명령 보내기 포트 하나만 받는다.

/** node-redis의 client.sendCommand([...])와 같은 꼴. ioredis는 (args) => redis.call(...args)로 감싼다 */
export interface RedisCommander {
  sendCommand(args: string[]): Promise<unknown>;
}

export const STREAM_KEY_TTL_AFTER_SALE_MS = 24 * 60 * 60 * 1000;

const ID = /^(\d+)-(\d+)$/;

function parts(id: string): [bigint, bigint] {
  const m = ID.exec(id);
  if (!m) throw new Error(`Stream ID가 아니다: ${id}`);
  return [BigInt(m[1]!), BigInt(m[2]!)];
}

export function compareStreamIds(a: string, b: string): number {
  const [am, as] = parts(a);
  const [bm, bs] = parts(b);
  if (am !== bm) return am < bm ? -1 : 1;
  return as === bs ? 0 : as < bs ? -1 : 1;
}

export function nextStreamId(id: string): string {
  const [ms, seq] = parts(id);
  return `${ms}-${seq + 1n}`;
}

/**
 * 확인받은 항목들을 XACK하고 XTRIM … MINID로 지운다(MINID보다 작은 항목만 지워진다). 이 Stream은 릴레이 그룹 하나만 읽는다.
 * 경계: 그 그룹에 아직 확인하지 않은 항목이 있으면 그 가운데 가장 작은 ID(그보다 앞 항목은 모두 전달되고 확인됐다),
 * 없으면 이번에 확인한 가장 큰 ID의 다음. 앞서 확인했지만 지우기 전에 멈춘 항목도 다음 번에 함께 지워진다
 */
export async function ackAndTrimStream(redis: RedisCommander, o: { key: string; group: string; ids: string[] }): Promise<{ acked: number; trimmed: number; minId?: string }> {
  if (o.ids.length === 0) return { acked: 0, trimmed: 0 };
  const acked = Number(await redis.sendCommand(['XACK', o.key, o.group, ...o.ids]));
  const maxAcked = o.ids.reduce((a, b) => (compareStreamIds(a, b) >= 0 ? a : b));
  const pending = (await redis.sendCommand(['XPENDING', o.key, o.group])) as [number | string, string | null, string | null, unknown];
  const count = Number(pending?.[0] ?? 0);
  const smallest = pending?.[1];
  const minId = count > 0 && smallest ? smallest : nextStreamId(maxAcked);
  const trimmed = Number(await redis.sendCommand(['XTRIM', o.key, 'MINID', minId]));
  return { acked, trimmed, minId };
}

/** 키 수명: 회차 판매 종료 + 1일 [가정](PEXPIREAT) */
export async function expireStreamAfterSale(redis: RedisCommander, key: string, saleEndMs: number): Promise<void> {
  await redis.sendCommand(['PEXPIREAT', key, String(saleEndMs + STREAM_KEY_TTL_AFTER_SALE_MS)]);
}
