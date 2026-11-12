// 메모리 검색 어댑터(시험·로컬): MemoryCatalogRepository의 공연·회차·이미지·찜에서 검색 문서를 만든다.
// 운영은 DrizzleSearchIndex가 search_document 뷰를 읽는다. 두 어댑터는 같은 SearchDocument 모양을 낸다.
import { Injectable } from '@nestjs/common';
import type { Clock } from '@peaket/platform';
import { imageBaseUrl } from '../domain/production-image.js';
import { isPublic, saleEndsAt, type EventSaleState } from '../domain/production.js';
import { documentOf, type SearchDocument, type SearchIndex } from '../domain/search.js';
import type { MemoryCatalogRepository } from './memory-catalog-repository.js';

@Injectable()
export class MemorySearchIndex implements SearchIndex {
  constructor(
    private readonly repo: MemoryCatalogRepository,
    private readonly imageOrigin: string,
    private readonly clock: Clock,
  ) {}

  async documents(): Promise<SearchDocument[]> {
    const now = new Date(this.clock.now());
    const out: SearchDocument[] = [];
    for (const p of this.repo.productions.values()) {
      if (!isPublic(p)) continue;
      const events = [...this.repo.events.values()].filter((e) => e.productionId === p.id);
      if (events.length === 0) continue;
      const first = events.find((e) => this.repo.details.has(e.id)) ?? events[0]!;
      const d = this.repo.details.get(first.id);
      const aliases = (this.repo.registrations.get(p.id)?.aliases ?? []).map((a) => a.alias);
      const poster = [...this.repo.images.values()].filter((i) => i.productionId === p.id && i.kind === 'POSTER').sort((a, b) => a.order - b.order)[0];
      const venueId = events.find((e) => e.venueId !== null)?.venueId;
      const layout = venueId ? [...this.repo.layouts.values()].find((l) => l.venueId === venueId) : undefined;
      const minPrice = layout?.rows?.doc.priceTiers.length ? Math.min(...layout.rows.doc.priceTiers.map((t) => t.price)) : undefined;
      const popularity = [...this.repo.wishes.values()].filter((m) => m.has(p.id)).length;
      const doc = documentOf({
        productionId: p.id,
        title: p.title,
        aliases,
        genre: p.genre,
        placeId: p.placeId,
        placeName: d?.place?.name ?? this.repo.placeNames.find((x) => x.id === p.placeId)?.name ?? null,
        artists: d?.artists ?? [],
        ...(poster ? { posterUrl: imageBaseUrl(this.imageOrigin, poster.id), posterAlt: poster.alt } : {}),
        events: events.map((e) => ({ ...e, endsAt: this.repo.details.get(e.id)?.event?.endsAt ?? new Date(e.startsAt.getTime() + 2 * 3_600_000), sale: this.saleOf(e.id, e.openAt, e.startsAt) })),
        now,
        ...(minPrice !== undefined ? { minPrice } : {}),
        popularity,
      });
      if (doc) out.push(doc);
    }
    return out;
  }

  async version(): Promise<number> {
    return this.repo.productions.size + this.repo.events.size + this.repo.images.size + this.repo.wishes.size;
  }

  private saleOf(eventId: string, openAt: Date, startsAt: Date): EventSaleState {
    const fixed = this.repo.saleStates.get(eventId);
    if (fixed) return fixed;
    const now = this.clock.now();
    if (now < openAt.getTime()) return 'UPCOMING';
    if (now >= saleEndsAt({ startsAt }).getTime()) return 'ENDED';
    return 'ON_SALE';
  }
}
