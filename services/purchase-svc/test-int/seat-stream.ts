// 좌석 Redis Stream 릴레이 시험의 공용 도구(BUILD_ORDER PRF-141): 실제 Valkey에서 판매를 열고 홀드 Lua로 Stream 항목을 만들며,
// Stream 상태(항목·XLEN·XPENDING·소비자 그룹)를 저장소를 거치지 않고 명령으로 직접 읽는다. 기대 SeatEvent는 정본 규칙대로 시험이 따로 만든다
// (docs/features/seat-hold.md §6 '홀드 원장 적재의 첫 구현', docs/data.md §3 s:{event:E}:stream의 HELD 칸).
import { createHash, randomUUID } from 'node:crypto';
import { type HotRedis, systemClock, uuidv7 } from '@peaket/platform';
import { type HeldHold, RedisSeatStore, type SeatRef, STREAM_RELAY_GROUP, seatKeys } from '../src/modules/inventory/index.js';
import { fingerprintOf, held } from '../test/hold-cases.js';

export const DAY = 24 * 3600_000;

/** HGETALL·XINFO 응답(RESP2 평평한 배열, RESP3 객체·Map)을 글 사전으로 */
export function hash(v: unknown): Record<string, string> {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), String(x)]));
  if (Array.isArray(v)) {
    const o: Record<string, string> = {};
    for (let i = 0; i + 1 < v.length; i += 2) o[String(v[i])] = String(v[i + 1]);
    return o;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]));
  return {};
}

export const cmd = (redis: HotRedis, key: string, args: string[]) => redis.command(args, { key });

/** Stream 항목 하나(ID와 칸) */
export interface StreamItem {
  id: string;
  fields: Record<string, string>;
}

/** XRANGE - + (Stream ID 순) */
export async function streamItems(redis: HotRedis, eventId: string): Promise<StreamItem[]> {
  const key = seatKeys.stream(eventId);
  const r = (await cmd(redis, key, ['XRANGE', key, '-', '+'])) as unknown[];
  return (r ?? []).map((e) => {
    if (Array.isArray(e)) return { id: String(e[0]), fields: hash(e[1]) };
    const o = e as { id?: unknown; message?: unknown };
    return { id: String(o.id), fields: hash(o.message) };
  });
}

export async function xlen(redis: HotRedis, eventId: string): Promise<number> {
  const key = seatKeys.stream(eventId);
  return Number(await cmd(redis, key, ['XLEN', key]));
}

/** 소비자 그룹 stream-relay의 확인받지 못한 항목 수(XPENDING 요약의 첫 값) */
export async function xpending(redis: HotRedis, eventId: string): Promise<number> {
  const key = seatKeys.stream(eventId);
  const r = (await cmd(redis, key, ['XPENDING', key, STREAM_RELAY_GROUP])) as unknown[];
  return Number(Array.isArray(r) ? (r[0] ?? 0) : 0);
}

export async function exists(redis: HotRedis, key: string): Promise<number> {
  return Number(await cmd(redis, key, ['EXISTS', key]));
}

/** XINFO GROUPS·CONSUMERS 응답(항목 배열)을 사전 배열로 */
export async function xinfo(redis: HotRedis, eventId: string, what: 'GROUPS' | 'CONSUMERS'): Promise<Record<string, string>[]> {
  const key = seatKeys.stream(eventId);
  const args = what === 'GROUPS' ? ['XINFO', 'GROUPS', key] : ['XINFO', 'CONSUMERS', key, STREAM_RELAY_GROUP];
  const r = (await cmd(redis, key, args)) as unknown[];
  return (r ?? []).map(hash);
}

let nextIndex = 0;
/**
 * 시험 좌석 n개(좌석 ID는 무작위 소문자 UUID라 원장 적재의 UUID 검사를 지난다). 구역 A(색인 0, 등급 R).
 * 좌석 색인은 회차마다 새로 쓰지 않아도 되게 0부터 이어 센다(회차 좌석 수 SEAT_COUNT 안에서 돈다). 좌석 ID 오름차순으로 돌려준다
 */
export const SEAT_COUNT = 200;
export function seatRefs(n: number): SeatRef[] {
  return Array.from({ length: n }, () => {
    const index = nextIndex++ % SEAT_COUNT;
    return { seatId: randomUUID(), index, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: index, tierId: 'R' };
  }).sort((a, b) => (a.seatId < b.seatId ? -1 : 1));
}

/** 판매를 연다(s:ctl:events에 넣고 비트맵·세대 키를 만든다) */
export async function openSale(store: RedisSeatStore, eventId: string): Promise<void> {
  await store.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: Date.now() + DAY });
}

export interface PlacedHold extends HeldHold {
  accountId: string;
  purchaseSessionId: string;
  seats: SeatRef[];
}

/** 홀드 Lua 한 번으로 좌석들을 잡는다(새 계정·새 구매 세션). 좌석마다 HELD 항목이 Stream에 하나씩 생긴다 */
export async function holdSeats(store: RedisSeatStore, eventId: string, seats: readonly SeatRef[], accountId: string = randomUUID()): Promise<PlacedHold> {
  const sorted = [...seats].sort((a, b) => (a.seatId < b.seatId ? -1 : 1));
  const purchaseSessionId = randomUUID();
  const r = await store.hold({
    eventId,
    accountId,
    purchaseSessionId,
    holdId: uuidv7(systemClock),
    idempotencyKey: randomUUID(),
    fingerprint: fingerprintOf(sorted.map((s) => s.seatId)),
    seats: sorted,
    limit: 4,
    keepUntilMs: Date.now() + DAY,
  });
  return { ...held(r), accountId, purchaseSessionId, seats: sorted };
}

/** SHA-256(입력)의 앞 16바이트에 UUID 버전 8·변형 비트를 맞춘 UUID 글(RFC 9562) */
export function uuid8(input: string): string {
  const b = Buffer.from(createHash('sha256').update(input, 'utf8').digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 홀드 사건의 eventKey(정본: SHA-256('SeatEvent:' + type + ':' + 회차 ID + ':' + holdId + ':' + 좌석 ID)의 앞 16바이트, UUID 버전 8) */
export const seatEventKeyOf = (type: string, eventId: string, holdId: string, seatId: string) => uuid8(`SeatEvent:${type}:${eventId}:${holdId}:${seatId}`);

export const iso = (ms: number | string) => new Date(Number(ms)).toISOString();

/** Stream 항목 칸 → 기대 SeatEvent(asyncapi SeatEvent의 홀드 사건). eventId는 Stream 키의 회차, 시각은 ISO 8601 */
export function expectedSeatEvent(eventId: string, f: Readonly<Record<string, string>>): Record<string, unknown> {
  return {
    eventId,
    seatId: f.seatId,
    tierId: f.tierId,
    sectionId: f.sectionId,
    type: f.type,
    fencingToken: Number(f.fencingToken),
    sectionVersion: Number(f.sectionVersion),
    seatEpoch: Number(f.seatEpoch),
    holdId: f.holdId,
    holdKind: f.holdKind,
    purchaseSessionId: f.purchaseSessionId,
    accountId: f.accountId,
    expiresAt: iso(f.expiresAtMs!),
    occurredAt: iso(f.occurredAtMs!),
    eventKey: seatEventKeyOf(f.type!, eventId, f.holdId!, f.seatId!),
  };
}
