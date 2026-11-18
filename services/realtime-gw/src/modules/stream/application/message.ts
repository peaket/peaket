// 좌석 Redis 샤드 Pub/Sub 메시지 해석(docs/data.md §3 `s:{event:E}:sec:{section}` 행, docs/features/seat-hold.md §7 'realtime-gw의 첫 구현' '메시지 해석').
// 글: 칸을 빈칸 하나로 이은 `1 {seatEpoch} {sectionIndex} {sectionVersion} {changedAtMs} {seatOffset}:{state} …`.
// 판이 1이고, seatEpoch·sectionVersion은 u32, changedAtMs는 안전한 정수, sectionIndex는 채널 이름의 구역과 같고,
// 좌석은 하나 이상이며 seatOffset은 u16·state는 0·1·2여야 한다. 하나라도 틀리면 undefined(부르는 쪽이 그 메시지만 버리고 센다).

/** 좌석 Redis 키 조각 모양(purchase-svc KEY_PART와 같다) */
export const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;
/** 구역 채널 이름: s:{event:E}:sec:{section}(구역 색인은 10진, 앞자리 0 없음) */
const CHANNEL = /^s:\{event:([A-Za-z0-9_-]{1,64})\}:sec:(0|[1-9][0-9]{0,4})$/;
/** 음이 아닌 10진 정수 글(앞자리 0·부호·소수점 없음) */
const UINT = /^(0|[1-9][0-9]*)$/;
const SEAT = /^(0|[1-9][0-9]{0,4}):([012])$/;

const U32_MAX = 0xffff_ffff;
const U16_MAX = 0xffff;

export interface SeatDeltaMessage {
  eventId: string;
  sectionIndex: number;
  seatEpoch: number;
  sectionVersion: number;
  changedAtMs: number;
  seats: Array<{ offset: number; state: 0 | 1 | 2 }>;
}

/** 구역 채널 이름(회차 ID는 KEY_PART 모양, 구역 색인은 0~65535). 부르는 쪽이 모양을 확인한 값만 넘긴다 */
export function sectionChannel(eventId: string, sectionIndex: number): string {
  return `s:{event:${eventId}}:sec:${sectionIndex}`;
}

/** 채널 이름에서 회차 ID와 구역 색인. 모양이 아니면 undefined */
export function parseSectionChannel(channel: string): { eventId: string; sectionIndex: number } | undefined {
  const m = CHANNEL.exec(channel);
  if (!m) return undefined;
  const sectionIndex = Number(m[2]);
  if (sectionIndex > U16_MAX) return undefined;
  return { eventId: m[1]!, sectionIndex };
}

const uint = (s: string | undefined, max: number): number | undefined => {
  if (s === undefined || !UINT.test(s)) return undefined;
  const n = Number(s);
  return Number.isSafeInteger(n) && n <= max ? n : undefined;
};

/** 메시지 하나를 읽는다. 틀리면 undefined */
export function parseSeatDeltaMessage(channel: string, text: string): SeatDeltaMessage | undefined {
  if (typeof channel !== 'string' || typeof text !== 'string') return undefined;
  const ch = parseSectionChannel(channel);
  if (!ch) return undefined;
  const parts = text.split(' ');
  if (parts.length < 6 || parts[0] !== '1') return undefined;
  const seatEpoch = uint(parts[1], U32_MAX);
  const sectionIndex = uint(parts[2], U16_MAX);
  const sectionVersion = uint(parts[3], U32_MAX);
  const changedAtMs = uint(parts[4], Number.MAX_SAFE_INTEGER);
  if (seatEpoch === undefined || sectionIndex === undefined || sectionVersion === undefined || changedAtMs === undefined) return undefined;
  if (sectionIndex !== ch.sectionIndex) return undefined;
  // 묶음의 한 구역 항목은 좌석 수가 u16이다
  if (parts.length - 5 > U16_MAX) return undefined;
  const seats: Array<{ offset: number; state: 0 | 1 | 2 }> = [];
  for (let i = 5; i < parts.length; i++) {
    const m = SEAT.exec(parts[i]!);
    if (!m) return undefined;
    const offset = Number(m[1]);
    if (offset > U16_MAX) return undefined;
    seats.push({ offset, state: Number(m[2]) as 0 | 1 | 2 });
  }
  return { eventId: ch.eventId, sectionIndex, seatEpoch, sectionVersion, changedAtMs, seats };
}
