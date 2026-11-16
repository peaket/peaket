// 메모리 검색 어댑터(시험·로컬): MemoryCatalogRepository의 공연·회차·이미지·찜에서 검색 문서를 만든다.
// 운영은 DrizzleSearchIndex가 search_document 표를 읽는다. 두 어댑터는 같은 순위 함수(assembleSearch)를 쓴다(ADR-0271 결정 4).
// 문서와 이름 색인은 저장소 내용과 시각 경계가 바뀔 때만 다시 만든다(요청마다 만들지 않는다, COV2-07).
// 자동완성 사전의 원천(MemorySearchDictionarySource)도 같은 문서에서 이름 줄을 만든다.
import { Injectable } from '@nestjs/common';
import type { Clock } from '@peaket/platform';
import { imageBaseUrl } from '../domain/production-image.js';
import { isPublic, saleEndsAt, type EventSaleState } from '../domain/production.js';
import {
  documentOf,
  indexDocuments,
  searchDocuments,
  termRowsOf,
  type DictionarySnapshot,
  type DocumentIndex,
  type SearchDictionarySource,
  type SearchDocument,
  type SearchIndex,
  type SearchOutcome,
  type SearchQuery,
  type SearchTermRow,
} from '../domain/search.js';
import type { MemoryCatalogRepository } from './memory-catalog-repository.js';

interface Snapshot {
  key: string;
  builtAt: number;
  /** 이 시각부터는 판매 상태·대표 회차가 바뀔 수 있다(다음 오픈·판매 종료·공연 시작) */
  validUntil: number;
  docs: SearchDocument[];
  index: DocumentIndex;
  terms: SearchTermRow[];
  version: number;
}

@Injectable()
export class MemorySearchIndex implements SearchIndex {
  #snapshot: Snapshot | undefined;
  #version = 0;

  constructor(
    private readonly repo: MemoryCatalogRepository,
    private readonly imageOrigin: string,
    private readonly clock: Clock,
  ) {}

  async search(q: SearchQuery): Promise<SearchOutcome> {
    const s = this.snapshot();
    return searchDocuments(s.docs, q, s.index);
  }

  async documents(): Promise<SearchDocument[]> {
    return this.snapshot().docs;
  }

  /** 문서가 바뀔 때마다 1씩 오르는 판(자동완성 사전 원천) */
  async version(): Promise<number> {
    return this.snapshot().version;
  }

  /** 지금 문서·색인·이름 줄. 저장소 내용(지문)이 같고 시각 경계를 넘지 않았으면 다시 만들지 않는다 */
  snapshot(): Snapshot {
    const now = this.clock.now();
    const key = this.#fingerprint();
    const s = this.#snapshot;
    if (s && s.key === key && now >= s.builtAt && now < s.validUntil) return s;
    const built = this.#build(now);
    if (!s || s.key !== key || JSON.stringify(s.docs) !== JSON.stringify(built.docs)) this.#version += 1;
    this.#snapshot = { key, builtAt: now, ...built, index: indexDocuments(built.docs), version: this.#version };
    return this.#snapshot;
  }

  /** 검색 문서를 바꾸는 저장소 내용의 지문(이름 비교 값은 계산하지 않는다) */
  #fingerprint(): string {
    const r = this.repo;
    const wishes = new Map<string, number>();
    for (const m of r.wishes.values()) for (const id of m.keys()) wishes.set(id, (wishes.get(id) ?? 0) + 1);
    const layouts = [...r.layouts.entries()].map(([id, l]) => [id, l.venueId, l.rows?.doc.priceTiers.map((t) => t.price) ?? null]);
    return JSON.stringify([
      [...r.productions.values()],
      [...r.events.values()],
      [...r.saleStates.entries()],
      [...r.details.entries()].map(([id, d]) => [id, d.event?.endsAt ?? null, d.place ?? null, d.artists ?? null]),
      [...r.registrations.entries()].map(([id, g]) => [id, g.aliases]),
      [...r.images.values()].filter((i) => i.kind === 'POSTER').map((i) => [i.id, i.productionId, i.order, i.alt]),
      [...wishes.entries()],
      r.placeNames,
      layouts,
    ]);
  }

  #build(nowMs: number): { docs: SearchDocument[]; terms: SearchTermRow[]; validUntil: number } {
    const now = new Date(nowMs);
    const docs: SearchDocument[] = [];
    const terms = new Map<string, SearchTermRow>();
    let validUntil = Number.POSITIVE_INFINITY;
    const edge = (t: number) => {
      if (t > nowMs && t < validUntil) validUntil = t;
    };
    for (const p of this.repo.productions.values()) {
      if (!isPublic(p)) continue;
      const events = [...this.repo.events.values()].filter((e) => e.productionId === p.id);
      if (events.length === 0) continue;
      for (const e of events) {
        edge(e.openAt.getTime());
        edge(saleEndsAt(e).getTime());
        edge(e.startsAt.getTime());
      }
      const first = events.find((e) => this.repo.details.has(e.id)) ?? events[0]!;
      const d = this.repo.details.get(first.id);
      const aliasRows = (this.repo.registrations.get(p.id)?.aliases ?? []).map((a) => ({ id: a.id, alias: a.alias }));
      const poster = [...this.repo.images.values()].filter((i) => i.productionId === p.id && i.kind === 'POSTER').sort((a, b) => a.order - b.order)[0];
      const venueId = events.find((e) => e.venueId !== null)?.venueId;
      const layout = venueId ? [...this.repo.layouts.values()].find((l) => l.venueId === venueId) : undefined;
      const minPrice = layout?.rows?.doc.priceTiers.length ? Math.min(...layout.rows.doc.priceTiers.map((t) => t.price)) : undefined;
      const popularity = [...this.repo.wishes.values()].filter((m) => m.has(p.id)).length;
      const doc = documentOf({
        productionId: p.id,
        title: p.title,
        aliases: aliasRows.map((a) => a.alias),
        genre: p.genre,
        placeId: p.placeId,
        placeName: d?.place?.name ?? this.repo.placeNames.find((x) => x.id === p.placeId)?.name ?? null,
        artists: d?.artists ?? [],
        ...(poster ? { posterUrl: imageBaseUrl(this.imageOrigin, poster.id), posterAlt: poster.alt } : {}),
        events: events.map((e) => ({ ...e, endsAt: this.repo.details.get(e.id)?.event?.endsAt ?? new Date(e.startsAt.getTime() + 2 * 3_600_000), sale: this.saleOf(e.id, e.openAt, e.startsAt, nowMs) })),
        now,
        ...(minPrice !== undefined ? { minPrice } : {}),
        popularity,
      });
      if (!doc) continue;
      docs.push(doc);
      // 아티스트·공연장 줄은 여러 공연이 함께 쓴다(뒤에 나온 것이 이긴다, suggestDocuments와 같다)
      for (const t of termRowsOf({ productionId: doc.productionId, title: doc.title, aliases: aliasRows, artists: doc.artists, placeId: doc.placeId ?? null, placeName: doc.placeName ?? null }, 0)) terms.set(t.id, t);
    }
    return { docs, terms: [...terms.values()], validUntil };
  }

  private saleOf(eventId: string, openAt: Date, startsAt: Date, now: number): EventSaleState {
    const fixed = this.repo.saleStates.get(eventId);
    if (fixed) return fixed;
    if (now < openAt.getTime()) return 'UPCOMING';
    if (now >= saleEndsAt({ startsAt }).getTime()) return 'ENDED';
    return 'ON_SALE';
  }
}

/** 메모리 자동완성 원천: 판이 바뀌면 늘 통째로 준다(메모리 어댑터에는 지운 표시가 없다) */
export class MemorySearchDictionarySource implements SearchDictionarySource {
  constructor(private readonly index: MemorySearchIndex) {}

  async version(): Promise<number> {
    return this.index.snapshot().version;
  }

  async read(): Promise<DictionarySnapshot> {
    const s = this.index.snapshot();
    return { version: s.version, full: true, documents: s.docs, terms: s.terms.map((t) => ({ ...t, updatedVersion: s.version })), removals: [] };
  }
}
