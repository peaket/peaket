// 큰 회차의 좌석 Redis 배치 규칙(ADR-0176 결정 3, BUILD_ORDER PRF-135). 순수 함수만 둔다(Redis·시계를 부르지 않는다).
// 판매 승인(LCH-080)이 아직 없어 함수와 시험만 있다. 키 이름에 이 태그를 넣는 운영 경로는 판매 열기 운영 경로(LCH-080)와 함께 한다.
// 회차 키는 해시 태그 {태그} 하나의 슬롯에 모인다(docs/data.md §3). 작은 회차의 태그는 지금처럼 event:E이고, 큰 회차만 event:E:k로 골라
// 그 회차 슬롯을 목표 주 노드에 둔다. ':'는 회차 ID 모양(KEY_PART) 밖이라 다른 회차의 태그와 섞이지 않는다.

/** Redis 클러스터 해시 슬롯 수 */
export const HASH_SLOTS = 16384;
/** 대형 회차: 좌석 3만 석 이상 [가정]. 판매 구간이 겹치는 동안 그 주 노드에 혼자 둔다(대형·중형끼리. 소형은 세지 않는다) */
export const LARGE_EVENT_SEATS = 30_000;
/** 중형 회차: 좌석 1만 석 이상(대형 미만) [가정] */
export const MEDIUM_EVENT_SEATS = 10_000;
/** 판매 구간이 겹치는 중형 회차를 한 주 노드에 둘 수 있는 수 2 [가정] */
export const MEDIUM_EVENTS_PER_PRIMARY = 2;
/** placementTag가 k를 찾는 범위의 끝(0 ≤ k < 이 값). 이 안에 목표 범위의 슬롯이 없으면 RangeError */
export const PLACEMENT_TAG_MAX_K = 1 << 20;

/**
 * 키의 해시 슬롯: CRC16(XMODEM: 다항식 0x1021, 초기값 0, 반사 없음, 끝 XOR 없음)을 UTF-8 바이트에 걸고 mod 16384.
 * 해시 태그 규칙(Redis 클러스터 명세): 키에 '{'가 있고 그 뒤에 '}'가 있으며 둘 사이가 한 글자 이상이면, 첫 '{'와 그 뒤 첫 '}' 사이만 해시한다.
 * 그 밖(‘{’ 없음, '}' 없음, '{}'처럼 비었음)은 키 전체를 해시한다. 예: slotOf('123456789') = 0x31C3 = 12739,
 * slotOf('{user1000}.following') = slotOf('user1000'), slotOf('foo{}{bar}')는 키 전체, slotOf('foo{{bar}}zap')은 '{bar'.
 * 빈 글 ''도 받는다(0). 던지지 않는다.
 * @returns 0 ~ 16383의 정수
 */
export function slotOf(key: string): number {
  const open = key.indexOf('{');
  let hashed = key;
  if (open >= 0) {
    const close = key.indexOf('}', open + 1);
    if (close > open + 1) hashed = key.slice(open + 1, close);
  }
  return crc16(new TextEncoder().encode(hashed)) % HASH_SLOTS;
}

/** CRC16 XMODEM(다항식 0x1021, 초기값 0) */
function crc16(bytes: Uint8Array): number {
  let c = 0;
  for (const b of bytes) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++) c = (c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1) & 0xffff;
  }
  return c;
}

const isSlot = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < HASH_SLOTS;
const isPositiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
/** 회차 ID 모양(domain/hold.ts KEY_PART와 같다. 이 파일은 순수 함수만 두어 따로 적는다) */
const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 크기 갈래: 대형(3만 석 이상)·중형(1만 석 이상)·소형 */
const sizeOf = (seats: number): 'large' | 'medium' | 'small' => (seats >= LARGE_EVENT_SEATS ? 'large' : seats >= MEDIUM_EVENT_SEATS ? 'medium' : 'small');

/** 주 노드 하나가 맡은 슬롯 범위(from·to 모두 포함) */
export interface SlotRange {
  /** 0 ~ 16383의 정수 */
  from: number;
  /** from ~ 16383의 정수 */
  to: number;
  /** 주 노드 표지(같은 노드가 범위를 여럿 가질 수 있다) */
  node: string;
}

/**
 * 회차 키의 해시 태그(중괄호 없이)를 고른다.
 * - seats < LARGE_EVENT_SEATS(작은·중형 회차): 'event:{eventId}' 그대로(지금 seatKeys와 같다). targetRange는 보지 않는다.
 * - seats ≥ LARGE_EVENT_SEATS(대형): 'event:{eventId}:{k}'. k는 slotOf('{event:E:k}')(= CRC16('event:E:k') mod 16384)가
 *   targetRange.from ~ targetRange.to 안에 드는 가장 작은 0 이상의 정수(10진, 앞 0 없음)다. 같은 입력이면 늘 같은 값이다.
 * @param eventId 회차 ID(KEY_PART 모양)
 * @param seats 회차 좌석 수(1 이상의 정수)
 * @param targetRange 목표 주 노드의 슬롯 범위(대형일 때만 쓴다. node는 보지 않는다)
 * @throws RangeError eventId가 KEY_PART가 아님, seats가 1 이상의 정수가 아님, 대형인데 targetRange가 0 ≤ from ≤ to ≤ 16383의 정수가 아님,
 *   0 ≤ k < PLACEMENT_TAG_MAX_K에서 찾지 못함
 */
export function placementTag(eventId: string, seats: number, targetRange: Pick<SlotRange, 'from' | 'to'>): string {
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) throw new RangeError(`회차 ID 모양이 키 조각이 아니다: ${String(eventId)}`);
  if (!isPositiveInt(seats)) throw new RangeError(`좌석 수는 1 이상의 정수다: ${seats}`);
  if (seats < LARGE_EVENT_SEATS) return `event:${eventId}`;
  const { from, to } = targetRange;
  if (!isSlot(from) || !isSlot(to) || from > to) throw new RangeError(`목표 슬롯 범위가 0 ≤ from ≤ to ≤ 16383의 정수가 아니다: ${from} ~ ${to}`);
  for (let k = 0; k < PLACEMENT_TAG_MAX_K; k++) {
    const tag = `event:${eventId}:${k}`;
    const slot = slotOf(`{${tag}}`);
    if (slot >= from && slot <= to) return tag;
  }
  throw new RangeError(`목표 슬롯 범위 ${from} ~ ${to}에 드는 태그를 k < ${PLACEMENT_TAG_MAX_K}에서 찾지 못했다`);
}

/** 배치를 견줄 회차 하나 */
export interface PlacementEvent {
  eventId: string;
  /** 해시 태그(중괄호 없이, placementTag의 결과). 회차 슬롯 = slotOf('{' + tag + '}') */
  tag: string;
  /** 좌석 수(1 이상의 정수) */
  seats: number;
  /** 판매 구간 [saleFrom, saleTo)(epoch ms, saleFrom < saleTo). 두 구간은 a.saleFrom < b.saleTo 이고 b.saleFrom < a.saleTo일 때 겹친다(끝이 맞닿으면 겹치지 않음) */
  saleFrom: number;
  saleTo: number;
}

/** 배치 규칙 위반 하나 */
export interface PlacementConflict {
  /** 위반이 난 주 노드 표지 */
  node: string;
  /** 그 위반에 든 회차 ID(target 먼저, 그다음 others의 차례) */
  events: string[];
  /**
   * LARGE_ALONE: 대형 회차가 판매 구간이 겹치는 다른 대형·중형 회차와 같은 주 노드에 있다(소형은 세지 않는다, 추천 적용 2026-11-04).
   * MEDIUM_PER_PRIMARY: target이 중형이고, 같은 주 노드에 target과 판매 구간이 겹치는 중형 회차가 target 포함 MEDIUM_EVENTS_PER_PRIMARY개를 넘는다
   */
  rule: 'LARGE_ALONE' | 'MEDIUM_PER_PRIMARY';
}

/**
 * target 회차를 지금 태그로 둘 때 배치 규칙을 어기는지 본다(순수 함수).
 *
 * 차례:
 * 1. 회차마다 슬롯 = slotOf('{' + tag + '}'), 주 노드 = 그 슬롯이 든 slotRanges의 node.
 * 2. 소형 회차(1만 석 미만)는 세지 않는다(추천 적용 2026-11-04): target이 소형이면 { ok: true, conflicts: [] }이고, others의 소형은 뺀다.
 *    others 가운데 target과 eventId가 같은 것도 뺀다. target과 같은 주 노드에 있고 판매 구간이 target과 겹치는 대형·중형 회차만 본다
 *    (target이 끼지 않는 others끼리의 위반은 내지 않는다). 모양 검사(아래 RangeError)는 빼기 전에 모든 회차에 한다.
 * 3. LARGE_ALONE: target이 대형이고 2의 회차가 하나라도 있으면 { node, events: [target, 2의 회차 모두], rule }.
 *    target이 중형이면 2의 대형 회차마다 { node, events: [target, 그 대형], rule }.
 * 4. MEDIUM_PER_PRIMARY: target이 중형이고 2의 중형 회차 수 + 1 > MEDIUM_EVENTS_PER_PRIMARY이면 { node, events: [target, 2의 중형 모두], rule } 하나.
 * 5. conflicts는 3의 것 다음 4의 것이고, ok = conflicts가 비었는가.
 *
 * @throws RangeError slotRanges가 0 ~ 16383을 빠짐없이 한 번씩 덮지 않음(빈틈·겹침), 범위 끝이 정수가 아니거나 from > to,
 *   회차의 seats가 1 이상의 정수가 아님, saleFrom ≥ saleTo
 */
export function checkPlacement(i: { slotRanges: readonly SlotRange[]; target: PlacementEvent; others: readonly PlacementEvent[] }): {
  ok: boolean;
  conflicts: PlacementConflict[];
} {
  const nodeOf = slotTable(i.slotRanges);
  for (const e of [i.target, ...i.others]) {
    if (!isPositiveInt(e.seats)) throw new RangeError(`회차 ${e.eventId}의 좌석 수는 1 이상의 정수다: ${e.seats}`);
    if (!(e.saleFrom < e.saleTo)) throw new RangeError(`회차 ${e.eventId}의 판매 구간이 비었다: ${e.saleFrom} ~ ${e.saleTo}`);
  }
  const t = i.target;
  const targetSize = sizeOf(t.seats);
  const conflicts: PlacementConflict[] = [];
  // 소형 대상은 세지 않는다(결정 2026-11-04: '대형 혼자'와 중형 수는 대형·중형끼리만)
  if (targetSize === 'small') return { ok: true, conflicts };
  const node = nodeOf(slotOf(`{${t.tag}}`));
  const near = i.others.filter((o) => o.eventId !== t.eventId && sizeOf(o.seats) !== 'small' && nodeOf(slotOf(`{${o.tag}}`)) === node && o.saleFrom < t.saleTo && t.saleFrom < o.saleTo);
  if (targetSize === 'large') {
    if (near.length > 0) conflicts.push({ node, events: [t.eventId, ...near.map((o) => o.eventId)], rule: 'LARGE_ALONE' });
  } else {
    for (const o of near) if (sizeOf(o.seats) === 'large') conflicts.push({ node, events: [t.eventId, o.eventId], rule: 'LARGE_ALONE' });
    const mediums = near.filter((o) => sizeOf(o.seats) === 'medium');
    if (mediums.length + 1 > MEDIUM_EVENTS_PER_PRIMARY) conflicts.push({ node, events: [t.eventId, ...mediums.map((o) => o.eventId)], rule: 'MEDIUM_PER_PRIMARY' });
  }
  return { ok: conflicts.length === 0, conflicts };
}

/** 슬롯 → 주 노드 표. 범위가 0 ~ 16383을 빠짐없이 한 번씩 덮지 않거나 끝이 정수가 아니거나 from > to면 RangeError */
function slotTable(ranges: readonly SlotRange[]): (slot: number) => string {
  for (const r of ranges) {
    if (!isSlot(r.from) || !isSlot(r.to) || r.from > r.to) throw new RangeError(`슬롯 범위가 틀렸다: ${JSON.stringify(r)}`);
  }
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  let next = 0;
  for (const r of sorted) {
    if (r.from !== next) throw new RangeError(`슬롯 범위에 빈틈이나 겹침이 있다: ${next}에서 ${r.from}`);
    next = r.to + 1;
  }
  if (next !== HASH_SLOTS) throw new RangeError(`슬롯 범위가 16383까지 덮지 않는다(끝 ${next - 1})`);
  return (slot) => {
    // 범위 수가 작아 차례로 찾는다
    for (const r of sorted) if (slot >= r.from && slot <= r.to) return r.node;
    throw new RangeError(`슬롯 ${slot}을 덮는 범위가 없다`);
  };
}
