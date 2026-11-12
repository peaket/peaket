// PostgreSQL 검색 어댑터: search_document 뷰에서 공개 공연 문서를 읽는다(마이그레이션 0009, docs/data.md search_document, HOT-270).
// 뷰는 production·event·place·artist·production_artist·search_alias·production_image·wish를 모아 항상 지금 값을 보여 준다.
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { IMAGE_ORIGIN } from '../../domain/media-ports.js';
import { imageBaseUrl } from '../../domain/production-image.js';
import type { Genre } from '../../domain/production.js';
import type { SearchDocument, SearchIndex } from '../../domain/search.js';

interface Row {
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
  poster_image_id: string | null;
  poster_alt: string | null;
  interest: number | string | null;
}

const dateOf = (v: string | Date | null): string | undefined => {
  if (v === null) return undefined;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
};
const isoOf = (v: string | Date | null): string | undefined => {
  if (v === null) return undefined;
  if (v instanceof Date) return v.toISOString();
  // drizzle execute는 timestamptz를 PostgreSQL 글자(`2026-11-19 10:00:00+00`)로 줄 수 있다. 계약은 ISO 8601만 받는다.
  const parsed = Date.parse(String(v));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(v);
};

@Injectable()
export class DrizzleSearchIndex implements SearchIndex {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IMAGE_ORIGIN) private readonly origin: string,
  ) {}

  async documents(): Promise<SearchDocument[]> {
    const result = await this.db.db.execute(sql`select * from search_document`);
    const rows = ((result as unknown as { rows?: Row[] }).rows ?? (result as unknown as Row[])) as Row[];
    return rows.map((r) => {
      return {
        productionId: r.production_id,
        ...(r.representative_event_id ? { eventId: r.representative_event_id } : {}),
        title: r.title,
        aliases: r.aliases ?? [],
        genre: r.genre as Genre,
        ...(r.place_id ? { placeId: r.place_id } : {}),
        ...(r.place_name ? { placeName: r.place_name } : {}),
        artists: (r.artists ?? []).filter((a) => a.name !== ''),
        ...(r.poster_image_id ? { posterUrl: imageBaseUrl(this.origin, r.poster_image_id), ...(r.poster_alt ? { posterAlt: r.poster_alt } : {}) } : {}),
        ...(dateOf(r.period_start) ? { periodStart: dateOf(r.period_start) } : {}),
        ...(dateOf(r.period_end) ? { periodEnd: dateOf(r.period_end) } : {}),
        ...(r.next_open_at ? { nextOpenAt: isoOf(r.next_open_at), nextOpenEventId: r.next_open_event_id } : {}),
        saleStatus: r.sale_status as SearchDocument['saleStatus'],
        ...(isoOf(r.sale_ends_at) ? { saleEndsAt: isoOf(r.sale_ends_at) } : {}),
        popularity: Number(r.interest ?? 0),
      };
    });
  }

  async version(): Promise<number> {
    const result = await this.db.db.execute(sql`select coalesce(max(version), 0)::text as version from search_version`);
    const rows = ((result as unknown as { rows?: { version: string }[] }).rows ?? (result as unknown as { version: string }[])) as { version: string }[];
    return Number(rows[0]?.version ?? 0);
  }
}
