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
  | 'BAD_SECTION_ID';

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
 * 판 파일(JSON을 읽은 값)을 해석한다. 규칙은 docs/features/seat-hold.md §2 '운영 좌석맵 판'이다:
 * { perAccountLimit(1~4 정수), saleEndsAt(ISO 8601 날짜), layout(SeatMapLayout: layoutVersion u32 정수, sections[] 각 {sectionId, tierId?, seatIndexRange{from,to}, seats[] {seatId, index, tierId?, unavailable?}}) }.
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
      if (!isObject(seat) || !isId(seat.seatId) || !isNonNegInt(seat.index) || (seat.unavailable !== undefined && typeof seat.unavailable !== 'boolean')) throw new SeatMapFileError('BAD_SEAT');
      if (seat.index < from || seat.index > to) throw new SeatMapFileError('SEAT_OUT_OF_RANGE');
      const tier = seat.tierId ?? sectionTier;
      if (typeof tier !== 'string' || tier.length === 0) throw new SeatMapFileError('NO_TIER');
      if (byIndex.has(seat.index)) throw new SeatMapFileError('SEAT_INDEX_DUPLICATE');
      const ref: SeatRef = { seatId: seat.seatId, index: seat.index, sectionId: sec.sectionId, sectionIndex, seatOffset: seat.index - from, tierId: tier };
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
    config: { eventId, layoutVersion: String(version), seatCount, perAccountLimit: limit, saleEndsAtMs },
    sections,
    byId,
    byIndex,
  };
}
