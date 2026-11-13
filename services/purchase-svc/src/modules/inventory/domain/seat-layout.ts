// 회차 좌석맵 판 파일 해석(docs/features/seat-hold.md §2 '운영 좌석맵 판', BUILD_ORDER PRF-137). 순수 함수라 프레임워크·플랫폼 형을 가져오지 않는다.
import { SEAT_ID_PATTERN, type SeatRef } from './hold.js';
import type { EventSeatConfig } from './ports.js';
import { U16_MAX, U32_MAX } from './snapshot.js';

/** 회차 좌석 수(가장 큰 seatIndexRange.to + 1)의 상한 1,000,000 [가정]. 비트맵·스냅샷 버퍼가 요청마다 이 크기에 비례하므로 오타 하나가 파드 메모리를 채우지 않게 한다 */
export const MAX_SEAT_COUNT = 1_000_000;

/** 판 파일을 받지 못하는 까닭(로그에는 이 코드만 싣는다: 좌석 ID·파일 내용은 싣지 않는다) */
export type SeatMapFileErrorCode =
  | 'NOT_OBJECT'
  | 'BAD_LIMIT'
  | 'BAD_SALE_END'
  | 'BAD_LAYOUT_VERSION'
  | 'NO_SECTIONS'
  | 'BAD_SECTION_RANGE'
  | 'SECTION_RANGE_OVERLAP'
  | 'BAD_SEAT'
  | 'SEAT_OUT_OF_RANGE'
  | 'SEAT_ID_DUPLICATE'
  | 'SEAT_INDEX_DUPLICATE'
  | 'NO_TIER'
  | 'BAD_SECTION_ID'
  /** tierPrices가 객체가 아니거나 값이 0 이상 안전한 정수가 아니거나 등급 ID가 비었다(BUILD_ORDER PRF-161) */
  | 'BAD_TIER_PRICES'
  /** 결제 시도의 선택 칸(orderName·entryOpensAt·virtualAccountAllowed)이 규칙에 맞지 않는다(BUILD_ORDER PRF-191) */
  | 'BAD_CHECKOUT_FIELDS';

export class SeatMapFileError extends Error {
  constructor(readonly code: SeatMapFileErrorCode) {
    super(`좌석맵 판 파일을 받지 못했다: ${code}`);
    this.name = 'SeatMapFileError';
  }
}

/** 구역 하나의 비트맵 범위(둘 다 포함) */
export interface SectionRange {
  sectionIndex: number;
  sectionId: string;
  from: number;
  to: number;
}

/** 해석한 판 */
export interface ParsedSeatMap {
  config: EventSeatConfig;
  /** 구역(seatIndexRange가 있는 구역만, 구역 색인 오름차순) */
  sections: readonly SectionRange[];
  /** 좌석 ID → 고를 수 있는 좌석(판매 제외석은 없다) */
  byId: ReadonlyMap<string, SeatRef>;
  /** 색인 → 판의 좌석(판매 제외석 포함, 판매 제외 표시 없이) */
  byIndex: ReadonlyMap<number, SeatRef>;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isId = (v: unknown): v is string => typeof v === 'string' && SEAT_ID_PATTERN.test(v);
/** ISO 8601 날짜와 시각(시간대 포함) */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 판 파일의 선택 칸 tierPrices({등급 ID: 원}, docs/features/payment.md §2 '주문 생성의 첫 구현' 금액, BUILD_ORDER PRF-161)를 해석한다.
 * 칸이 없으면(undefined) undefined(기존 판 파일도 그대로 읽힌다). 있으면 배열이 아닌 객체이고 값마다 0 이상 PostgreSQL int4 이하 정수, 등급 ID는 1~64자여야 한다.
 * 판에 없는 등급의 가격이 있어도 받는다(쓰지 않을 뿐이다). 결과는 얼린 새 객체(자기 속성만, 프로토타입 없음)다.
 * parseEventSeatMapFile이 이 함수로 config.tierPrices를 채운다(칸이 없으면 config에 tierPrices 칸도 없다)
 * @throws SeatMapFileError('BAD_TIER_PRICES') 위 규칙을 어김
 */
export function parseTierPrices(raw: unknown): Readonly<Record<string, number>> | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new SeatMapFileError('BAD_TIER_PRICES');
  // 프로토타입 없는 새 객체에 자기 속성만 옮긴다(JSON의 "__proto__" 칸도 자기 속성으로 검사되고, 결과의 프로토타입을 바꾸지 못한다)
  const out = Object.create(null) as Record<string, number>;
  for (const tierId of Object.keys(raw)) {
    const price = raw[tierId];
    if (tierId.length < 1 || tierId.length > TIER_ID_MAX) throw new SeatMapFileError('BAD_TIER_PRICES');
    if (typeof price !== 'number' || !Number.isInteger(price) || price < 0 || price > INT4_MAX) throw new SeatMapFileError('BAD_TIER_PRICES');
    out[tierId] = price;
  }
  return Object.freeze(out);
}

/** 주문명 길이 상한 100자 [가정](payment-svc ORDER_NAME_MAX_LENGTH와 같은 값) */
const ORDER_NAME_MAX = 100;
/** 주문명에서 받지 않는 글자: 제어(Cc), 양방향 제어·폭 없는 문자를 포함한 서식(Cf), 줄·문단 구분자(Zl·Zp), 글자처럼 보이는 빈칸인 한글 채움 문자(payment-svc와 같은 규칙) */
const ORDER_NAME_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0]/u;
/** 입장 시각 상한(9999년의 끝, payment-svc ENTRY_OPENS_AT_MAX_MS와 같은 값) */
const ENTRY_OPENS_AT_MAX_MS = 253_402_300_799_999;

/**
 * 판 파일의 결제 시도 선택 칸 셋(docs/features/seat-hold.md §2 '운영 좌석맵 판', BUILD_ORDER PRF-191). 없는 칸은 결과에 없다.
 * @throws SeatMapFileError('BAD_CHECKOUT_FIELDS') 주문명이 1~100자의 글이 아니거나 금지 문자가 있거나 공백뿐, 입장 시각이 ISO 8601이 아니거나 범위 밖, 가상계좌가 불리언이 아님
 */
function parseCheckoutFields(raw: Record<string, unknown>): { orderName?: string; entryOpensAtMs?: number; virtualAccountAllowed?: boolean } {
  const { orderName, entryOpensAt, virtualAccountAllowed } = raw;
  if (orderName !== undefined) {
    const valid = typeof orderName === 'string' && [...orderName].length >= 1 && [...orderName].length <= ORDER_NAME_MAX && orderName.trim() !== '' && !ORDER_NAME_FORBIDDEN.test(orderName);
    if (!valid) throw new SeatMapFileError('BAD_CHECKOUT_FIELDS');
  }
  let entryOpensAtMs: number | undefined;
  if (entryOpensAt !== undefined) {
    entryOpensAtMs = typeof entryOpensAt === 'string' && ISO_DATE_TIME.test(entryOpensAt) ? Date.parse(entryOpensAt) : Number.NaN;
    if (!(Number.isFinite(entryOpensAtMs) && entryOpensAtMs > 0 && entryOpensAtMs <= ENTRY_OPENS_AT_MAX_MS)) throw new SeatMapFileError('BAD_CHECKOUT_FIELDS');
  }
  if (virtualAccountAllowed !== undefined && typeof virtualAccountAllowed !== 'boolean') throw new SeatMapFileError('BAD_CHECKOUT_FIELDS');
  return {
    ...(typeof orderName === 'string' ? { orderName } : {}),
    ...(entryOpensAtMs !== undefined ? { entryOpensAtMs } : {}),
    ...(typeof virtualAccountAllowed === 'boolean' ? { virtualAccountAllowed } : {}),
  };
}

/** 가격 상한(PostgreSQL int4, 주문 금액·항목 가격 칸) */
const INT4_MAX = 2_147_483_647;
/** 등급 ID 글 길이 상한(주문 항목 tier 칸과 같은 64자) */
const TIER_ID_MAX = 64;

/**
 * 판 파일(JSON을 읽은 값)을 해석한다. 규칙은 docs/features/seat-hold.md §2 '운영 좌석맵 판'이다:
 * { perAccountLimit(1~4 정수), saleEndsAt(ISO 8601 날짜), 선택 칸 tierPrices·orderName·entryOpensAt·virtualAccountAllowed, layout(SeatMapLayout: layoutVersion u32 정수, sections[] 각 {sectionId, tierId?, seatIndexRange{from,to}, seats[] {seatId, index, tierId?, unavailable?}}) }.
 * 구역 색인 = sections 배열 차례, seatOffset = index − from, 등급 = 좌석 tierId ?? 구역 tierId, 판매 제외 = unavailable === true, seatCount = 가장 큰 to + 1.
 * seatIndexRange가 없는 구역은 건너뛴다(구역 색인은 배열 차례 그대로). 하나라도 어기면 SeatMapFileError.
 * @throws SeatMapFileError 위 규칙을 어김
 */
export function parseEventSeatMapFile(eventId: string, raw: unknown): ParsedSeatMap {
  if (!isObject(raw)) throw new SeatMapFileError('NOT_OBJECT');
  const limit = raw.perAccountLimit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 4) throw new SeatMapFileError('BAD_LIMIT');
  const saleEnd = raw.saleEndsAt;
  const saleEndsAtMs = typeof saleEnd === 'string' && ISO_DATE_TIME.test(saleEnd) ? Date.parse(saleEnd) : Number.NaN;
  if (!Number.isFinite(saleEndsAtMs)) throw new SeatMapFileError('BAD_SALE_END');
  // 선택 칸 등급 가격(주문 생성의 금액, BUILD_ORDER PRF-161). 틀리면 그 파일 전체를 받지 않는다
  const tierPrices = parseTierPrices(raw.tierPrices);
  // 선택 칸 등급 이름(홀드 응답의 tierName, BUILD_ORDER HOT-070). 모양이 틀린 값은 뺀다(표시 값이라 판을 막지 않는다)
  const tierNames = isObject(raw.tierNames) ? Object.fromEntries(Object.entries(raw.tierNames).filter(([k, v]) => k.length > 0 && typeof v === 'string' && v.length > 0 && v.length <= 32)) as Record<string, string> : undefined;
  // 선택 칸 결제 시도의 주문명·입장 시각·가상계좌(BUILD_ORDER PRF-191). 틀리면 그 파일 전체를 받지 않는다
  const checkoutFields = parseCheckoutFields(raw);
  const layout = raw.layout;
  if (!isObject(layout)) throw new SeatMapFileError('NOT_OBJECT');
  const version = layout.layoutVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0 || version > U32_MAX) throw new SeatMapFileError('BAD_LAYOUT_VERSION');
  const rawSections = layout.sections;
  if (!Array.isArray(rawSections) || rawSections.length === 0) throw new SeatMapFileError('NO_SECTIONS');
  // 구역 표 sectionCount가 u16이라 전체 스냅샷에 실을 수 있는 구역은 65,535개까지다(구역 색인 0 ~ 65534)
  if (rawSections.length > U16_MAX) throw new SeatMapFileError('BAD_SECTION_RANGE');

  const sections: SectionRange[] = [];
  const byId = new Map<string, SeatRef>();
  const byIndex = new Map<number, SeatRef>();
  /** 좌석 ID 겹침은 판매 제외석까지 센다(판매 제외석은 byId에 넣지 않는다) */
  const seenIds = new Set<string>();
  rawSections.forEach((sec: unknown, sectionIndex: number) => {
    if (!isObject(sec)) throw new SeatMapFileError('NOT_OBJECT');
    if (!isId(sec.sectionId)) throw new SeatMapFileError('BAD_SECTION_ID');
    const range = sec.seatIndexRange;
    if (range === undefined) return;
    if (!isObject(range) || !isNonNegInt(range.from) || !isNonNegInt(range.to) || range.from > range.to) throw new SeatMapFileError('BAD_SECTION_RANGE');
    const { from, to } = range;
    if (to + 1 > MAX_SEAT_COUNT) throw new SeatMapFileError('BAD_SECTION_RANGE');
    sections.push({ sectionIndex, sectionId: sec.sectionId, from, to });
    const sectionTier = sec.tierId;
    const seats = sec.seats ?? [];
    if (!Array.isArray(seats)) throw new SeatMapFileError('BAD_SEAT');
    for (const seat of seats as unknown[]) {
      if (!isObject(seat) || !isId(seat.seatId) || !isNonNegInt(seat.index) || (seat.unavailable !== undefined && typeof seat.unavailable !== 'boolean') || (seat.wheelchair !== undefined && typeof seat.wheelchair !== 'boolean')) throw new SeatMapFileError('BAD_SEAT');
      if (seat.index < from || seat.index > to) throw new SeatMapFileError('SEAT_OUT_OF_RANGE');
      const tier = seat.tierId ?? sectionTier;
      if (typeof tier !== 'string' || tier.length === 0) throw new SeatMapFileError('NO_TIER');
      if (byIndex.has(seat.index)) throw new SeatMapFileError('SEAT_INDEX_DUPLICATE');
      const label = typeof seat.label === 'string' && seat.label.length > 0 && seat.label.length <= 64 ? seat.label : undefined;
      const ref: SeatRef = { seatId: seat.seatId, index: seat.index, sectionId: sec.sectionId, sectionIndex, seatOffset: seat.index - from, tierId: tier, ...(label !== undefined ? { label } : {}), ...(seat.wheelchair === true ? { wheelchair: true } : {}) };
      if (seenIds.has(ref.seatId)) throw new SeatMapFileError('SEAT_ID_DUPLICATE');
      seenIds.add(ref.seatId);
      byIndex.set(seat.index, ref);
      if (seat.unavailable !== true) byId.set(ref.seatId, ref);
    }
  });
  if (sections.length === 0) throw new SeatMapFileError('NO_SECTIONS');

  // 구역 범위가 서로 겹치면 안 된다(비트맵 색인이 한 구역에만 속해야 한다)
  const sorted = [...sections].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.from <= sorted[i - 1]!.to) throw new SeatMapFileError('SECTION_RANGE_OVERLAP');

  const seatCount = sorted[sorted.length - 1]!.to + 1;
  return {
    config: { eventId, layoutVersion: String(version), seatCount, perAccountLimit: limit, saleEndsAtMs, ...(tierPrices !== undefined ? { tierPrices } : {}), ...(tierNames !== undefined ? { tierNames } : {}), ...checkoutFields },
    sections,
    byId,
    byIndex,
  };
}
