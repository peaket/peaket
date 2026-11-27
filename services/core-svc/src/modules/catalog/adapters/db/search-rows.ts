// search_document·search_term 줄 → 도메인 모양(ADR-0271). 검색 질의(DrizzleSearchIndex)와 사전 원천(DrizzleSearchReadModel)이 함께 쓴다.
import { imageBaseUrl } from '../../domain/production-image.js';
import type { Genre } from '../../domain/production.js';
import { publicSaleStatusOf } from '../../domain/event-sale-state.js';
import type { SearchDocument, SearchTermRow } from '../../domain/search.js';

export interface DocumentRow {
  production_id: string;
  representative_event_id: string | null;
  title: string;
  genre: string;
  place_id: string | null;
  place_name: string | null;
  artists: { artistId: string; name: string }[] | null;
  aliases: string[] | null;
  period_start: string | Date | null;
  period_end: string | Date | null;
  next_open_at: string | Date | null;
  next_open_event_id: string | null;
  sale_status: string;
  sale_ends_at: string | Date | null;
  min_price: number | string | null;
  poster_image_id: string | null;
  poster_alt: string | null;
  interest: number | string | null;
}

export interface TermRow {
  id: string;
  kind: string;
  target_id: string;
  display_name: string;
  alias_of: string | null;
  norm: string;
  norm_nospace: string;
  jamo: string;
  chosung: string;
  updated_version: number | string;
}

/** drizzle execute 결과의 줄(드라이버마다 rows 칸이 있거나 배열 자체다) */
export const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];

const pad = (n: number) => String(n).padStart(2, '0');
/** date 칸: 드라이버가 Date(그 날 0시, 프로세스 시간대)나 글로 준다. 달력 날짜만 쓴다 */
const dateOf = (v: string | Date | null): string | undefined => {
  if (v === null) return undefined;
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  return String(v).slice(0, 10);
};
// toISOString과 같은 꼴(밀리초, UTC 'Z'). 질의가 이 꼴의 글로 주면 다시 해석하지 않는다(검색 후보 수천 줄, ADR-0271 결정 23)
const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isoOf = (v: string | Date | null): string | undefined => {
  if (v === null) return undefined;
  if (v instanceof Date) return v.toISOString();
  if (ISO_MS_Z.test(v)) return v;
  // drizzle execute는 timestamptz를 PostgreSQL 글자(`2026-11-19 10:00:00+00`)로 줄 수 있다. 계약은 ISO 8601만 받는다.
  const parsed = Date.parse(String(v));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(v);
};

/** 표 한 줄 → 검색 문서. origin이 없으면 포스터 주소를 싣지 않는다 */
export function documentOfRow(r: DocumentRow, origin: string | undefined): SearchDocument {
  const periodStart = dateOf(r.period_start);
  const periodEnd = dateOf(r.period_end);
  const saleEnds = isoOf(r.sale_ends_at);
  return {
    productionId: r.production_id,
    ...(r.representative_event_id ? { eventId: r.representative_event_id } : {}),
    title: r.title,
    aliases: r.aliases ?? [],
    genre: r.genre as Genre,
    ...(r.place_id ? { placeId: r.place_id } : {}),
    ...(r.place_name ? { placeName: r.place_name } : {}),
    artists: (r.artists ?? []).filter((a) => a.name !== ''),
    ...(r.poster_image_id && origin !== undefined ? { posterUrl: imageBaseUrl(origin, r.poster_image_id), ...(r.poster_alt ? { posterAlt: r.poster_alt } : {}) } : {}),
    ...(periodStart ? { periodStart } : {}),
    ...(periodEnd ? { periodEnd } : {}),
    ...(r.next_open_at ? { nextOpenAt: isoOf(r.next_open_at), nextOpenEventId: r.next_open_event_id } : {}),
    saleStatus: publicSaleStatusOf(r.sale_status),
    ...(saleEnds ? { saleEndsAt: saleEnds } : {}),
    ...(r.min_price !== null && r.min_price !== undefined ? { minPrice: Number(r.min_price) } : {}),
    popularity: Number(r.interest ?? 0),
  };
}

export function termOfRow(r: TermRow): SearchTermRow {
  return {
    id: r.id,
    kind: r.kind as SearchTermRow['kind'],
    targetId: r.target_id,
    displayName: r.display_name,
    aliasOf: r.alias_of ?? null,
    norm: r.norm,
    normNospace: r.norm_nospace,
    jamo: r.jamo,
    chosung: r.chosung,
    updatedVersion: Number(r.updated_version),
  };
}
