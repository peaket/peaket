// 도메인 층: 공연용 배치본 저장의 규칙(docs/features/seat-hold.md §2·§10 '배치본 저장과 팬 좌석맵 파일', ADR-0260 결정 2~7·10, BUILD_ORDER HOT-240).
// 색인 매기기(구역 차례대로 0부터 빈틈 없이), 등급·가격 등급 검사, 오픈 뒤 잠금 판정과 바뀐 갈래, 팬 좌석맵 파일(SeatMapColumns) 만들기, 라벨 기본값.
// 순수 함수만 둔다. 계약 스키마 검사(SeatMapLayoutInput Zod)는 받는 층이 먼저 하고, 가져오기와 같은 검사(recheckLayout·countRaw)는 seatmap-import.ts를 쓴다.
import type { SeatMapWarning } from '@peaket/validation/seatmap-checks';
import { createHash } from 'node:crypto';
import { type CheckedLayout, type LayoutShape, SECTION_ID_KEY, SEATMAP_MAX_ISSUES, SEATMAP_TAG_MAX, type SeatmapIssue } from './seatmap-import.js';

/** 저장 본문 상한(바이트, 12MiB [가정], ADR-0260 결정 11). 5만 석 배치 JSON은 약 6.5MB [추정] */
export const LAYOUT_SAVE_MAX_BYTES = 12 * 1024 * 1024;
/** 저장 요청의 남은 시간 [가정](ADR-0260 결정 11) */
export const LAYOUT_ROUTE_DEADLINE_MS = 60_000;
/** 구역 하나의 좌석 상한(팬 파일 델타 seatOffset이 u16, seat-hold §2) */
export const SECTION_SEATS_MAX = 65_536;
/** 가격 등급 상한(팬 파일 tiers 상한, 좌석 등급 열이 4비트, ADR-0260 결정 2) */
export const PRICE_TIERS_MAX = 16;
/** 팬 파일 게시의 동시 쓰기 수와 전체 시한 [가정](ADR-0260 결정 6). 시험은 주입으로 바꾼다 */
export const PUBLISH_CONCURRENCY = 8;
export const PUBLISH_TOTAL_MS = 20_000;
/** 게시 실패의 Retry-After(초) [가정](ADR-0260 결정 5) */
export const PUBLISH_RETRY_AFTER_S = 10;
/** 트랜잭션 ② 앞에 회차가 계속 늘 때의 Retry-After(초)와 ②를 다시 하는 횟수 [가정](리뷰 C2) */
export const ROUNDS_CHANGED_RETRY_AFTER_S = 1;
export const COMMIT_RETRIES = 2;
/** 좌석맵 저장의 칸막이(파드마다 2 [가정]: 요청 하나의 힙이 커서. 파트너 DB 풀 4 가운데 2를 남긴다, 리뷰 C4·D9). 이미지·가져오기 칸막이와 따로다 */
export const LAYOUT_SAVE_BULKHEAD = { name: 'partner-seatmap-save', limit: 2, retryAfterSeconds: 10 } as const;
/** 게시 직전 남은 시간에서 남길 여유(트랜잭션 ②·응답)와 게시에 줄 최소 시간 [가정](리뷰 C3) */
export const PUBLISH_MARGIN_MS = 2_000;
export const PUBLISH_MIN_MS = 1_000;

/** 게시에 줄 시간(남은 시간 − 여유). 최소보다 작으면 undefined(504 deadline-exceeded) */
export function publishBudget(remainingMs: number): number | undefined {
  const b = remainingMs - PUBLISH_MARGIN_MS;
  return b < PUBLISH_MIN_MS ? undefined : b;
}

export const FAN_FILE_FORMAT = 'peaket.seatmap.columns.v1' as const;
/** 팬 파일 객체 메타데이터(ADR-0260 결정 6, seat-hold ASVS 5.3.1) */
export const FAN_FILE_CONTENT_TYPE = 'application/json; charset=utf-8';
export const FAN_FILE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** 팬 파일 flags 비트(openapi SeatMapColumns.seats.flags) */
export const FLAG_WHEELCHAIR = 1;
export const FLAG_UNAVAILABLE = 2;

export interface PriceTier {
  tierId: string;
  name: string;
  price: number;
}

/** 저장한 좌석(서버가 매긴 색인). 불리언은 참일 때만, 글자 칸은 있을 때만 둔다(같은 배치를 늘 같은 모양으로 견주게) */
export interface DocSeat {
  seatId: string;
  index: number;
  row: string;
  number: number;
  x: number;
  y: number;
  tierId?: string;
  wheelchair?: true;
  unavailable?: true;
  gateZone?: string;
}

export interface DocSection {
  sectionId: string;
  name: string;
  level?: string;
  shape: LayoutShape;
  label?: { x?: number; y?: number };
  tierId?: string;
  gateZone?: string;
  /** 에디터 전용 좌석 채우기 규칙(팬 파일에는 싣지 않는다, ADR-0066) */
  fillRule?: Record<string, unknown>;
  /** 좌석이 없는 구역은 없다 */
  seatIndexRange?: { from: number; to: number };
  seats: DocSeat[];
}

/** 서버가 정리한 배치 문서(행·대기 판·팬 파일의 출처) */
export interface LayoutDoc {
  canvas: { width: number; height: number };
  stage: LayoutShape[];
  sections: DocSection[];
  /** 보이는 순서 */
  priceTiers: PriceTier[];
  templateVenueId?: string;
}

/** 저장 본문(계약 SeatMapLayoutInput을 지난 값). 색인은 비어 있을 수 있다 */
export type LayoutInput = CheckedLayout & { priceTiers?: PriceTier[]; templateVenueId?: string; layoutVersion?: number };

const issueList = () => {
  const issues: SeatmapIssue[] = [];
  const add = (field: string, code: string) => {
    if (issues.length < SEATMAP_MAX_ISSUES) issues.push({ line: 0, field, code });
  };
  return { issues, add };
};

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** 도형 하나(꼭짓점·이름과 에디터 값 arc, ADR-0264 결정 12). arc는 저장·불러오기를 지나고 팬 파일(fanFile)에는 싣지 않는다 */
export const shapeOf = (s: LayoutShape): LayoutShape => ({
  kind: s.kind,
  points: s.points.map(([x, y]) => [x, y] as [number, number]),
  ...(s.name !== undefined ? { name: s.name } : {}),
  ...(s.arc !== undefined ? { arc: { cx: s.arc.cx, cy: s.arc.cy, innerRadius: s.arc.innerRadius, outerRadius: s.arc.outerRadius, startAngle: s.arc.startAngle, endAngle: s.arc.endAngle } } : {}),
});

/**
 * 색인을 매긴다(ADR-0260 결정 3): 첫 구역 0부터 구역마다 앞 구역 to + 1부터 좌석 수만큼, 구역 안 좌석 차례대로. 좌석이 없는 구역은 범위가 없다.
 * 보낸 seatIndexRange·index가 있으면 그 값과 같아야 하고 다르면 INDEX_MISMATCH다(조용히 고치지 않는다). 구역 하나가 65,536석을 넘으면 SECTION_TOO_LARGE
 */
export function assignIndexes(layout: CheckedLayout): { sections: DocSection[]; issues: SeatmapIssue[] } {
  const { issues, add } = issueList();
  let next = 0;
  const sections = layout.sections.map((s, si): DocSection => {
    const at = `sections[${si}]`;
    const seats = s.seats ?? [];
    if (seats.length > SECTION_SEATS_MAX) add(`${at}.seats`, 'SECTION_TOO_LARGE');
    const range = seats.length > 0 ? { from: next, to: next + seats.length - 1 } : undefined;
    const sent = s.seatIndexRange;
    if (sent && ((sent.from !== undefined && sent.from !== range?.from) || (sent.to !== undefined && sent.to !== range?.to))) add(`${at}.seatIndexRange`, 'INDEX_MISMATCH');
    const docSeats = seats.map((seat, i): DocSeat => {
      const index = next + i;
      if (seat.index !== undefined && seat.index !== index) add(`${at}.seats[${i}].index`, 'INDEX_MISMATCH');
      return {
        seatId: seat.seatId,
        index,
        row: seat.row,
        number: seat.number,
        x: seat.x,
        y: seat.y,
        ...(seat.tierId !== undefined ? { tierId: seat.tierId } : {}),
        ...(seat.wheelchair === true ? { wheelchair: true as const } : {}),
        ...(seat.unavailable === true ? { unavailable: true as const } : {}),
        ...(seat.gateZone !== undefined ? { gateZone: seat.gateZone } : {}),
      };
    });
    if (range) next = range.to + 1;
    const label = s.label && (s.label.x !== undefined || s.label.y !== undefined) ? { ...(s.label.x !== undefined ? { x: s.label.x } : {}), ...(s.label.y !== undefined ? { y: s.label.y } : {}) } : undefined;
    const fill = s.fillRule;
    return {
      sectionId: s.sectionId,
      name: s.name,
      ...(s.level !== undefined ? { level: s.level } : {}),
      shape: shapeOf(s.shape),
      ...(label ? { label } : {}),
      ...(s.tierId !== undefined ? { tierId: s.tierId } : {}),
      ...(s.gateZone !== undefined ? { gateZone: s.gateZone } : {}),
      ...(typeof fill === 'object' && fill !== null ? { fillRule: fill as Record<string, unknown> } : {}),
      ...(range ? { seatIndexRange: range } : {}),
      seats: docSeats,
    };
  });
  return { sections, issues };
}

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 좌석 ID를 서버가 정한다(seat-hold §5 '좌석 ID 글': 판 파일의 좌석 ID는 좌석 표의 소문자 UUID, 추천 적용 2026-11-10 리뷰 H2·D1).
 * 보낸 seatId가 이 배치본에 이미 있는 소문자 UUID(existing: 행 판과 대기 판의 좌석)면 그대로 두고, 없거나 UUID가 아니거나 이 배치본에 없는 UUID면
 * newId()로 새로 매긴다(새 좌석으로 본다. 잠긴 뒤면 좌석 집합 변경이라 409다). 받은 값은 바꾸지 않고 새 값을 돌려준다
 */
export function assignSeatIds(sections: readonly DocSection[], existing: ReadonlySet<string>, newId: () => string): DocSection[] {
  return sections.map((s) => ({ ...s, seats: s.seats.map((seat) => (LOWER_UUID.test(seat.seatId) && existing.has(seat.seatId) ? seat : { ...seat, seatId: newId() })) }));
}

/** 구역 ID가 판 해석 키 조각 꼴(영문·숫자·_·-, 1~64자)이 아니면 SECTION_ID_INVALID(purchase-svc 판 해석이 받지 않는다, seat-hold §2) */
export function sectionIdIssues(sections: readonly Pick<DocSection, 'sectionId'>[]): SeatmapIssue[] {
  const { issues, add } = issueList();
  sections.forEach((s, i) => {
    if (!SECTION_ID_KEY.test(s.sectionId)) add(`sections[${i}].sectionId`, 'SECTION_ID_INVALID');
  });
  return issues;
}

// 제어 문자(C0·DEL·C1)와 양방향 제어 문자(seatmap-import.ts의 글자 칸 규칙과 같다)
const CONTROL = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;

/** 가격 등급 칸(ADR-0260 결정 4): 등급 ID·이름은 제어 문자 없이 30자, 공백뿐이 아님, 등급 ID 겹침 없음. 길이·개수·가격 범위는 계약 스키마(400)가 본다 */
export function priceTierIssues(tiers: readonly PriceTier[]): SeatmapIssue[] {
  const { issues, add } = issueList();
  const seen = new Set<string>();
  tiers.forEach((t, i) => {
    for (const k of ['tierId', 'name'] as const) {
      const v = t[k];
      if (CONTROL.test(v) || v.trim() === '' || [...v].length > SEATMAP_TAG_MAX) add(`priceTiers[${i}].${k}`, 'TEXT_INVALID');
    }
    if (seen.has(t.tierId)) add(`priceTiers[${i}].tierId`, 'TIER_DUPLICATE');
    seen.add(t.tierId);
  });
  return issues;
}

/** 좌석의 등급(좌석 tierId, 없으면 구역 tierId) */
export const seatTier = (section: Pick<DocSection, 'tierId'>, seat: Pick<DocSeat, 'tierId'>): string | undefined => seat.tierId ?? section.tierId;

/** 모든 좌석의 등급이 있고(TIER_MISSING) 가격 등급에 있는지(TIER_UNKNOWN) 본다(ADR-0260 결정 4). 좌석이 쓰지 않는 가격 등급도 받는다 */
export function tierIssues(sections: readonly DocSection[], tiers: readonly PriceTier[]): SeatmapIssue[] {
  const { issues, add } = issueList();
  const known = new Set(tiers.map((t) => t.tierId));
  sections.forEach((s, si) =>
    s.seats.forEach((seat, i) => {
      const t = seatTier(s, seat);
      if (t === undefined) add(`sections[${si}].seats[${i}].tierId`, 'TIER_MISSING');
      else if (!known.has(t)) add(`sections[${si}].seats[${i}].tierId`, 'TIER_UNKNOWN');
    }),
  );
  return issues;
}

/** 팬 파일을 게시할 수 있는가: 구역이 하나 이상이고 모든 구역에 좌석이 있다(팬 파일의 구역마다 색인 범위가 있어야 한다, ADR-0260 결정 6) */
export const publishable = (doc: Pick<LayoutDoc, 'sections' | 'priceTiers'>): boolean => doc.sections.length > 0 && doc.priceTiers.length > 0 && doc.sections.every((s) => s.seats.length > 0);

/** 라벨이 없는 구역의 라벨 위치: 도형 꼭짓점 평균(반올림, ADR-0260 결정 6). 한 칸만 있으면 없는 칸만 채운다 */
export function labelOf(s: Pick<DocSection, 'label' | 'shape'>): { x: number; y: number } {
  const pts = s.shape.points;
  const avg = (k: 0 | 1) => Math.round(pts.reduce((n, p) => n + p[k], 0) / pts.length);
  return { x: s.label?.x ?? avg(0), y: s.label?.y ?? avg(1) };
}

/** 팬 좌석맵 파일(openapi SeatMapColumns). 판매 상태·계정 값·가격·편집 값(fillRule·gateZone·level)은 싣지 않는다(seat-hold ASVS 14.2.2) */
export interface FanFile {
  format: typeof FAN_FILE_FORMAT;
  layoutVersion: number;
  canvas: { minX: number; minY: number; width: number; height: number };
  stage: { kind: LayoutShape['kind']; points: [number, number][]; name?: string }[];
  tiers: string[];
  seatCount: number;
  sections: {
    sectionId: string;
    name: string;
    shape: { kind: LayoutShape['kind']; points: [number, number][] };
    label: { x: number; y: number };
    seatIndexRange: { from: number; to: number };
    seats: { seatId: string[]; row: string[]; number: string[]; x: number[]; y: number[]; tier: number[]; flags: number[] };
  }[];
}

/**
 * 검사를 마친 배치로 팬 파일을 새로 만든다(받은 본문을 그대로 쓰지 않는다, seat-hold ASVS 5.3.1). 게시할 수 없는 배치면 undefined.
 * 열 위치 = 좌석 색인 − 구역 from이라 좌석은 색인 차례로 둔다. 같은 배치는 늘 같은 바이트다(회차마다 같은 파일, 회차 더하기도 같은 바이트)
 */
export function fanFile(doc: LayoutDoc, version: number): FanFile | undefined {
  if (!publishable(doc)) return undefined;
  const tierIndex = new Map(doc.priceTiers.map((t, i) => [t.tierId, i]));
  let seatCount = 0;
  const sections = doc.sections.map((s) => {
    const seats = [...s.seats].sort((a, b) => a.index - b.index);
    const cols = { seatId: [] as string[], row: [] as string[], number: [] as string[], x: [] as number[], y: [] as number[], tier: [] as number[], flags: [] as number[] };
    for (const seat of seats) {
      cols.seatId.push(seat.seatId);
      cols.row.push(seat.row);
      cols.number.push(String(seat.number));
      cols.x.push(seat.x);
      cols.y.push(seat.y);
      cols.tier.push(tierIndex.get(seatTier(s, seat) ?? '') ?? 0);
      cols.flags.push((seat.wheelchair ? FLAG_WHEELCHAIR : 0) | (seat.unavailable ? FLAG_UNAVAILABLE : 0));
    }
    const range = s.seatIndexRange!;
    seatCount = range.to + 1;
    return { sectionId: s.sectionId, name: s.name, shape: { kind: s.shape.kind, points: s.shape.points.map(([x, y]) => [x, y] as [number, number]) }, label: labelOf(s), seatIndexRange: { from: range.from, to: range.to }, seats: cols };
  });
  return {
    format: FAN_FILE_FORMAT,
    layoutVersion: version,
    canvas: { minX: 0, minY: 0, width: doc.canvas.width, height: doc.canvas.height },
    stage: doc.stage.map((st) => ({ kind: st.kind, points: st.points.map(([x, y]) => [x, y] as [number, number]), ...(st.name !== undefined ? { name: st.name } : {}) })),
    tiers: doc.priceTiers.map((t) => t.tierId),
    seatCount,
    sections,
  };
}

export const fanFileBytes = (f: FanFile): Uint8Array => new TextEncoder().encode(JSON.stringify(f));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^(?:0|[1-9]\d{0,8})$/;

/**
 * 팬 파일 키: 회차 ID(DB의 행)와 서버가 잡은 정수 판으로만 만든다(seat-hold ASVS 5.3.2). 공개 위치(public)는 팬 화면이 받는 경로와 같고,
 * 준비 위치(staging)는 승인 이력이 있는 공연의 재승인 대기 판이라 공개 서빙 밖이다(판매 승인 LCH-080이 공개 위치로 옮긴다, 추천 적용 2026-11-10 리뷰 H3·D3)
 */
export function fanFileKey(eventId: string, version: number, where: 'public' | 'staging' = 'public'): string {
  if (!UUID.test(eventId) || !Number.isSafeInteger(version) || version < 1) throw new Error('정한 꼴이 아닌 팬 파일 키');
  return `${where === 'staging' ? 'staging/' : ''}v1/events/${eventId}/seatmap-layouts/${version}.json`;
}

/** 강한 ETag "N"(0 포함)의 판. 다른 꼴이면 undefined(412) */
export function versionOfEtag(etag: string): number | undefined {
  const t = etag.trim();
  if (!t.startsWith('"') || !t.endsWith('"') || t.length < 3) return undefined;
  const v = t.slice(1, -1);
  return VERSION.test(v) ? Number(v) : undefined;
}
export const layoutEtag = (version: number) => `"${version}"`;

/** 배치본 ID 이름공간(UUIDv5, RFC 9562 §5.5). 공연 하나에 배치본 하나라 공연 ID에서 정한다(ADR-0260 결정 2) */
const LAYOUT_NAMESPACE = 'a7d1c2f0-2b8e-5d4a-9c61-0f3e8b7a6d25';

/**
 * 공연의 배치본 ID(UUIDv5(이름공간, 공연 ID)). 첫 저장의 트랜잭션 ①이 판을 잡아 만든 행을, 회차에 아직 잇지 못한 채 실패해도 다음 저장이 같은 행에서
 * 판 차례를 잇는다(판 번호를 다시 쓰지 않는다, ADR-0260 결정 5)
 */
export function layoutVenueId(productionId: string): string {
  const ns = Buffer.from(LAYOUT_NAMESPACE.replaceAll('-', ''), 'hex');
  const h = createHash('sha1').update(ns).update(productionId.toLowerCase()).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** 배치본을 쓰는 회차 하나(event 행과 변경분의 더한 회차) */
export interface LayoutRound {
  eventId: string;
  openAt: Date;
  cancelled: boolean;
}

/**
 * 오픈 뒤 잠금(ADR-0260 결정 7): 승인 이력이 있고, 그 배치본을 쓰는 취소되지 않은 회차 가운데 open_at ≤ 지금인 회차가 있다
 * (재승인 대기로 오픈 예약이 멈춘 회차와 변경분의 더한 회차도 잠근 쪽으로 본다)
 */
export function geometryLocked(q: { saleApprovedAt: Date | null; rounds: readonly LayoutRound[]; now: Date }): boolean {
  if (q.saleApprovedAt === null) return false;
  return q.rounds.some((r) => !r.cancelled && r.openAt.getTime() <= q.now.getTime());
}

/** 키 차례와 상관없는 JSON(대기 판은 jsonb라 키 차례가 바뀌어 돌아온다) */
const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

/**
 * 잠긴 뒤 승인된 판과 견줘 바뀐 갈래(ADR-0260 결정 7). 빈 목록이면 받는 변경(좌석의 unavailable·wheelchair·gateZone과 구역의 gateZone)뿐이다.
 * 갈래 코드: CANVAS, STAGE, SECTION_SET(구역 집합·차례), SECTION_GEOMETRY(구역 도형·이름·층·라벨), SEAT_SET(좌석 집합·색인), SEAT_GEOMETRY(열·번호·좌표·실제 등급).
 * 등급은 표기가 아니라 실제 등급(좌석 tierId ?? 구역 tierId)으로 견준다(표기만 옮긴 저장을 막지 않는다, 추천 적용 2026-11-10 리뷰 A3).
 * 채우기 규칙(fillRule)은 에디터 값이라 견주지 않는다 [가정]
 */
export function geometryChanges(approved: LayoutDoc, next: LayoutDoc): string[] {
  const out = new Set<string>();
  if (!same(approved.canvas, next.canvas)) out.add('CANVAS');
  if (!same(approved.stage, next.stage)) out.add('STAGE');
  if (!same(approved.sections.map((s) => s.sectionId), next.sections.map((s) => s.sectionId))) out.add('SECTION_SET');
  const before = new Map(approved.sections.map((s) => [s.sectionId, s]));
  const seatsBefore = new Map(approved.sections.flatMap((s) => s.seats.map((seat) => [seat.seatId, { s, seat }] as const)));
  let seatCount = 0;
  for (const s of next.sections) {
    const b = before.get(s.sectionId);
    if (b && !same([b.name, b.level, b.shape, b.label], [s.name, s.level, s.shape, s.label])) out.add('SECTION_GEOMETRY');
    for (const seat of s.seats) {
      seatCount++;
      const p = seatsBefore.get(seat.seatId);
      if (!p || p.s.sectionId !== s.sectionId || p.seat.index !== seat.index) {
        out.add('SEAT_SET');
        continue;
      }
      if (!same([p.seat.row, p.seat.number, p.seat.x, p.seat.y, seatTier(p.s, p.seat)], [seat.row, seat.number, seat.x, seat.y, seatTier(s, seat)])) out.add('SEAT_GEOMETRY');
    }
  }
  if (seatCount !== seatsBefore.size) out.add('SEAT_SET');
  return [...out].sort();
}

/** 가격 등급이 같은가(차례·ID·이름·가격) */
export const sameTiers = (a: readonly PriceTier[], b: readonly PriceTier[]): boolean => same(a.map((t) => [t.tierId, t.name, t.price]), b.map((t) => [t.tierId, t.name, t.price]));

/** 계약 SeatMapLayout(응답)의 모양 */
export interface SeatMapLayoutView {
  layoutVersion: number;
  templateVenueId?: string;
  priceTiers: PriceTier[];
  fanFilePublished?: boolean;
  /** 저장 응답에서만: 업무 경고(W1~W3·겹침·도형 밖, ADR-0264 결정 15) */
  warnings?: SeatMapWarning[];
  /** 오픈 뒤 도형 잠금(불러오기·저장 응답, geometryLocked 판정 함수, ADR-0264 결정 13) */
  geometryLocked: boolean;
  canvas: { width: number; height: number };
  stage: LayoutShape[];
  sections: (Omit<DocSection, 'seats'> & { seats: DocSeat[] })[];
}

export function layoutView(doc: LayoutDoc, version: number, extra: { fanFilePublished?: boolean; geometryLocked: boolean; warnings?: SeatMapWarning[] }): SeatMapLayoutView {
  return {
    layoutVersion: version,
    ...(doc.templateVenueId !== undefined ? { templateVenueId: doc.templateVenueId } : {}),
    priceTiers: doc.priceTiers.map((t) => ({ tierId: t.tierId, name: t.name, price: t.price })),
    ...(extra.fanFilePublished !== undefined ? { fanFilePublished: extra.fanFilePublished } : {}),
    ...(extra.warnings !== undefined ? { warnings: extra.warnings } : {}),
    geometryLocked: extra.geometryLocked,
    canvas: { width: doc.canvas.width, height: doc.canvas.height },
    stage: doc.stage,
    sections: doc.sections,
  };
}

/** 저장 문서를 JSON 칸(대기 판)에서 다시 읽는다. 모양이 틀리면 던진다(DB 값이 바뀐 것) */
export function docFromJson(v: unknown): LayoutDoc {
  const d = v as Partial<LayoutDoc> | null;
  if (!d || typeof d !== 'object' || !d.canvas || !Array.isArray(d.sections) || !Array.isArray(d.priceTiers) || !Array.isArray(d.stage)) throw new Error('대기 판 배치 문서의 모양이 틀렸다');
  const t = str(d.templateVenueId);
  return { canvas: d.canvas, stage: d.stage, sections: d.sections, priceTiers: d.priceTiers, ...(t !== undefined ? { templateVenueId: t } : {}) };
}
