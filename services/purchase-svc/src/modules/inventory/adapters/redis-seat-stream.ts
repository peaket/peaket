// 좌석 Redis Stream 읽기의 Redis 구현(BUILD_ORDER PRF-141). 소비자 그룹 stream-relay, 소비자 이름 relay(docs/data.md §4 '홀드 원장 적재와 Stream 릴레이').
// - read: 처음 보는 Stream이면 XGROUP CREATE … 0(MKSTREAM 없이. Stream이 없으면 빈 배열), 그다음 XREADGROUP … 0(확인받지 못한 항목), 없으면 XREADGROUP … >
// - ack: platform ackAndTrimStream(XACK 뒤 XTRIM MINID)
import { ackAndTrimStream, type HotRedis } from '@peaket/platform';
import { KEY_PART } from '../domain/hold.js';
import type { SeatStreamSource } from '../domain/ports.js';
import { STREAM_RELAY_CONSUMER, STREAM_RELAY_GROUP, type SeatStreamEntry } from '../domain/seat-event.js';
import { seatKeys } from './redis-seat-store.js';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 칸 목록: RESP2는 [칸, 값, …], RESP3 클라이언트는 객체나 Map으로 줄 수 있다. 지워진 항목은 null이다 */
function fieldsOf(kv: unknown): Record<string, string> {
  const fields: Record<string, string> = {};
  if (Array.isArray(kv)) for (let i = 0; i + 1 < kv.length; i += 2) fields[String(kv[i])] = String(kv[i + 1]);
  else if (kv instanceof Map) for (const [k, v] of kv) fields[String(k)] = String(v);
  else if (kv && typeof kv === 'object') for (const [k, v] of Object.entries(kv)) fields[String(k)] = String(v);
  return fields;
}

/** XREADGROUP 응답(RESP2 [[키, 항목들]], RESP3 {키: 항목들} 또는 Map, 없으면 null)에서 Stream 하나의 항목 */
function entriesOf(reply: unknown): SeatStreamEntry[] {
  let list: unknown;
  if (reply instanceof Map) list = reply.values().next().value;
  else if (Array.isArray(reply)) list = (reply[0] as unknown[] | undefined)?.[1];
  else if (reply && typeof reply === 'object') list = Object.values(reply)[0];
  if (!Array.isArray(list)) return [];
  return list.map((item: unknown) => {
    if (Array.isArray(item)) return { id: String(item[0]), fields: fieldsOf(item[1]) };
    const o = item as { id?: unknown; message?: unknown };
    return { id: String(o.id), fields: fieldsOf(o.message) };
  });
}

export class RedisSeatStreamSource implements SeatStreamSource {
  /** 소비자 그룹을 만든(또는 있음을 확인한) Stream 키 */
  readonly #grouped = new Set<string>();

  constructor(private readonly redis: HotRedis) {}

  async events(): Promise<string[]> {
    const key = seatKeys.ctlEvents();
    const r = await this.redis.command(['SMEMBERS', key], { key });
    // 배열이 아니면 조용히 비우지 않고 던진다(saleEvents와 같다. 릴레이가 실패 지표 없이 멈추지 않게)
    if (!Array.isArray(r)) throw new Error('s:ctl:events 응답이 배열이 아니다');
    const events = r.map(String).filter((e) => KEY_PART.test(e)).sort();
    // 목록에서 빠진 회차의 그룹 기억을 지운다(끝없이 커지지 않게)
    const keys = new Set(events.map((e) => seatKeys.stream(e)));
    for (const k of this.#grouped) if (!keys.has(k)) this.#grouped.delete(k);
    return events;
  }

  async read(eventId: string, count: number): Promise<SeatStreamEntry[]> {
    const key = seatKeys.stream(eventId);
    if (!this.#grouped.has(key)) {
      try {
        // MKSTREAM을 쓰지 않는다: Stream이 없는 회차에 수명 없는 키를 만들지 않는다
        await this.redis.command(['XGROUP', 'CREATE', key, STREAM_RELAY_GROUP, '0'], { key });
      } catch (err) {
        const m = errText(err);
        if (/requires the key to exist|no such key/i.test(m)) return [];
        if (!/BUSYGROUP/.test(m)) throw err;
      }
      this.#grouped.add(key);
    }
    const readFrom = async (id: '0' | '>') =>
      entriesOf(await this.redis.command(['XREADGROUP', 'GROUP', STREAM_RELAY_GROUP, STREAM_RELAY_CONSUMER, 'COUNT', String(count), 'STREAMS', key, id], { key }));
    try {
      // 확인받지 못한 항목(앞 리더가 보내다 멈춘 것 포함)을 먼저, 없으면 새 항목
      const pending = await readFrom('0');
      return pending.length > 0 ? pending : await readFrom('>');
    } catch (err) {
      // 키가 수명으로 지워져 그룹이 사라졌다
      if (/NOGROUP/.test(errText(err))) {
        this.#grouped.delete(key);
        return [];
      }
      throw err;
    }
  }

  async ack(eventId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const key = seatKeys.stream(eventId);
    await ackAndTrimStream({ sendCommand: (args) => this.redis.command(args, { key }) }, { key, group: STREAM_RELAY_GROUP, ids });
  }
}
