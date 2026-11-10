// 배치본 행 읽기(docs/data.md venue·section·seat·price_tier, ADR-0260 결정 2·9). 좌석맵 저장소와 카탈로그 저장소(회차 더하기의 팬 파일)가 함께 쓴다.
// 문서 모양과 칸 차례는 domain/seatmap-layout.ts assignIndexes와 같다(같은 배치는 같은 팬 파일 바이트).
import type { Database, DbTransaction } from '@peaket/platform';
import { and, asc, eq } from 'drizzle-orm';
import type { LayoutShape, Point, ShapeArc } from '../../domain/seatmap-import.js';
import { type DocSeat, type DocSection, docFromJson, type LayoutDoc, type PriceTier } from '../../domain/seatmap-layout.js';
import { priceTier, seat, section, venue } from './schema.js';

export type Tx = DbTransaction | Database['db'];

/** 변경분 JSON의 더한 회차(배치본을 이으면 venueId가 생긴다) */
export interface StoredAdded {
  eventId: string;
  openAt: string;
  venueId?: string | null;
  [k: string]: unknown;
}

export const opt = <K extends string, V>(k: K, v: V | null | undefined): { [P in K]?: V } => (v === null || v === undefined ? {} : ({ [k]: v } as { [P in K]?: V }));

/** 구역 행 + 좌석 행 → 문서의 구역(seatmap-layout.ts assignIndexes와 같은 모양·같은 칸 차례) */
export function sectionDoc(s: typeof section.$inferSelect, seats: DocSeat[]): DocSection {
  const meta = (s.editorMeta ?? {}) as { tool?: LayoutShape['kind']; shapeName?: string; fillRule?: Record<string, unknown>; arc?: ShapeArc };
  const label = s.labelX !== null || s.labelY !== null ? { ...opt('x', s.labelX), ...opt('y', s.labelY) } : undefined;
  return {
    sectionId: s.sectionKey,
    name: s.name,
    ...opt('level', s.level),
    // 부채꼴·곡선 띠의 원래 매개변수(editor_meta.arc, ADR-0264 결정 12)는 에디터가 손잡이를 되살리는 값이다
    shape: { kind: meta.tool ?? 'POLYGON', points: (s.shape as Point[]).map(([x, y]) => [x, y] as Point), ...opt('name', meta.shapeName), ...opt('arc', meta.arc) },
    ...(label ? { label } : {}),
    ...opt('tierId', s.defaultTier),
    ...opt('gateZone', s.gateZone),
    ...opt('fillRule', meta.fillRule),
    ...(s.seatIndexFrom !== null && s.seatIndexTo !== null ? { seatIndexRange: { from: s.seatIndexFrom, to: s.seatIndexTo } } : {}),
    seats,
  };
}

const seatDoc = (r: typeof seat.$inferSelect): DocSeat => ({
  seatId: String(r.seatKey),
  index: r.seatIndex,
  row: r.rowLabel,
  number: r.number,
  x: r.x,
  y: r.y,
  ...opt('tierId', r.tierId),
  ...(r.wheelchair ? { wheelchair: true as const } : {}),
  ...(r.unavailable ? { unavailable: true as const } : {}),
  ...opt('gateZone', r.gateZone),
});

/**
 * 행에 있는 배치(layout_version이 0이면 undefined). tenantId를 주면 그 테넌트의 행만 읽는다(파트너 경로). 회차 더하기도 이 함수로 팬 파일을 다시 만든다
 * (같은 배치는 같은 바이트, domain fanFile)
 */
export async function readRowLayout(tx: Tx, venueId: string, tenantId?: string): Promise<{ version: number; doc: LayoutDoc } | undefined> {
  const mine = (col: typeof venue.promoterId | typeof section.promoterId | typeof seat.promoterId | typeof priceTier.promoterId) => (tenantId === undefined ? undefined : eq(col, tenantId));
  const [v] = await tx
    .select()
    .from(venue)
    .where(and(eq(venue.id, venueId), mine(venue.promoterId)));
  if (!v || v.layoutVersion === 0) return undefined;
  // 한 트랜잭션의 연결은 질의를 하나씩만 보낸다(차례대로 부른다)
  const sections = await tx.select().from(section).where(and(eq(section.venueId, venueId), mine(section.promoterId))).orderBy(asc(section.sortOrder));
  const seats = await tx.select().from(seat).where(and(eq(seat.venueId, venueId), mine(seat.promoterId))).orderBy(asc(seat.seatIndex));
  const tiers = await tx.select().from(priceTier).where(and(eq(priceTier.venueId, venueId), mine(priceTier.promoterId))).orderBy(asc(priceTier.displayOrder));
  // 구역마다 배열에 더한다(좌석마다 배열을 새로 만들면 한 구역 5만 석에서 n²이라 몇 초 이벤트 루프가 멈춘다, 추천 적용 2026-11-10 리뷰 H1)
  const bySection = new Map<string, DocSeat[]>();
  for (const r of seats) {
    const list = bySection.get(r.sectionKey);
    if (list) list.push(seatDoc(r));
    else bySection.set(r.sectionKey, [seatDoc(r)]);
  }
  return {
    version: v.layoutVersion,
    doc: {
      canvas: { width: v.canvasWidth ?? 1, height: v.canvasHeight ?? 1 },
      stage: (v.stageShapes ?? []) as LayoutShape[],
      sections: sections.map((s) => sectionDoc(s, bySection.get(s.sectionKey) ?? [])),
      priceTiers: tiers.map((t): PriceTier => ({ tierId: t.tierId, name: t.name, price: t.price })),
      ...opt('templateVenueId', v.templateVenueId),
    },
  };
}

/** 대기 판(승인 이력이 있는 공연의 재승인 대기 배치). staged는 그 판의 팬 파일을 준비 위치에 썼는지(ADR-0260 결정 6·9) */
export function pendingOf(v: Pick<typeof venue.$inferSelect, 'pendingLayout'> | undefined): { version: number; doc: LayoutDoc; staged: boolean } | null {
  const p = v?.pendingLayout as { version?: unknown; doc?: unknown; staged?: unknown } | null | undefined;
  if (!p) return null;
  if (!Number.isSafeInteger(p.version)) throw new Error('대기 판의 판 번호가 틀렸다');
  return { version: p.version as number, doc: docFromJson(p.doc), staged: p.staged === true };
}

/**
 * 게시한 판의 팬 파일 목록(회차 더하기가 새 회차에 같은 바이트를 쓴다): 행 판을 공개 위치에 게시했으면(published_version) 그 판, 대기 판을 준비 위치에 썼으면 그 판.
 * 게시 여부는 DB 값으로 정하고 다시 계산하지 않는다(ADR-0260 결정 6, 추천 적용 2026-11-10 리뷰 H3)
 */
export async function readLayoutFiles(tx: Tx, venueId: string, tenantId: string): Promise<{ version: number; where: 'public' | 'staging'; doc: LayoutDoc }[]> {
  const [v] = await tx
    .select()
    .from(venue)
    .where(and(eq(venue.id, venueId), eq(venue.promoterId, tenantId)));
  if (!v) return [];
  const out: { version: number; where: 'public' | 'staging'; doc: LayoutDoc }[] = [];
  if (v.publishedVersion !== null) {
    const rows = await readRowLayout(tx, venueId, tenantId);
    if (rows) out.push({ version: rows.version, where: 'public', doc: rows.doc });
  }
  const pending = pendingOf(v);
  if (pending?.staged) out.push({ version: pending.version, where: 'staging', doc: pending.doc });
  return out;
}
