// 유스케이스: 검색 결과와 자동완성(openapi listSearchResults·getSearchSuggestions, ADR-0094, docs/features/search.md §4~§6, BUILD_ORDER HOT-270·HOT-280).
// 결과는 SearchIndex가 준 공개 문서에서 순위·필터·쪽 나누기를 한다. 자동완성 사전은 10초 [가정] 동안 메모리에 둔다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, RequestValidationError } from '@peaket/platform';
import { SEARCH_INDEX, SEARCH_MAX_PAGE, type SearchDocument, type SearchIndex, type SearchOutcome, type SearchQuery, type SearchSuggestions, searchDocuments, suggestDocuments } from '../domain/search.js';

/** 자동완성 사전을 다시 읽는 간격(ms) [가정] */
export const SUGGESTION_CACHE_MS = 10_000;

export interface SearchInput extends Omit<SearchQuery, 'now'> {}

@Injectable()
export class SearchCatalog {
  #cache: { at: number; version: number; docs: SearchDocument[] } | undefined;

  constructor(
    @Inject(SEARCH_INDEX) private readonly index: SearchIndex,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async search(q: SearchInput): Promise<SearchOutcome> {
    if (q.page > SEARCH_MAX_PAGE) throw new RequestValidationError('page');
    const docs = await this.index.documents();
    return searchDocuments(docs, { ...q, now: new Date(this.clock.now()) });
  }

  async suggestions(q: string): Promise<SearchSuggestions> {
    const docs = await this.#suggestionDocs();
    return suggestDocuments(docs, q);
  }

  async #suggestionDocs(): Promise<SearchDocument[]> {
    const now = this.clock.now();
    const version = await this.index.version();
    if (this.#cache && this.#cache.version === version && now - this.#cache.at < SUGGESTION_CACHE_MS) return this.#cache.docs;
    const docs = await this.index.documents();
    this.#cache = { at: now, version, docs };
    return docs;
  }
}
