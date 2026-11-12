// 받는 층: 검색 결과·자동완성(openapi listSearchResults·getSearchSuggestions, ADR-0094, docs/features/search.md §4~§6).
// 인증 없음, CDN 캐시. 검색어·필터·쪽은 계약 스키마가 먼저 검사한다(정의 밖 칸 400).
import { Controller, Get, Res } from '@nestjs/common';
import { GetSearchSuggestionsQueryParams, GetSearchSuggestionsResponse, ListSearchResultsQueryParams, ListSearchResultsResponse } from '@peaket/contracts/openapi/catalog';
import { ContractQuery, ContractRouteSchema, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { SearchCatalog } from '../application/search.js';
import type { SearchOutcome, SearchSuggestions } from '../domain/search.js';

/** 검색 결과 캐시(초) [가정]. 키는 정규화한 입력·필터·쪽이다(응답 머리는 게이트웨이가 정규화한다) */
export const SEARCH_CACHE = 'public, max-age=30, stale-while-revalidate=30, stale-if-error=600';
/** 자동완성 캐시(초) [가정] */
export const SUGGESTION_CACHE = 'public, max-age=60, stale-while-revalidate=60, stale-if-error=600';

@Controller('v1/search')
export class SearchController {
  constructor(private readonly search: SearchCatalog) {}

  @Get('suggestions')
  @ContractRouteSchema({ responses: { 200: GetSearchSuggestionsResponse } })
  @Roles(['public'])
  async suggestions(@ContractQuery(GetSearchSuggestionsQueryParams) q: z.output<typeof GetSearchSuggestionsQueryParams>, @Res({ passthrough: true }) reply: FastifyReply): Promise<SearchSuggestions> {
    void reply.header('cache-control', SUGGESTION_CACHE);
    return this.search.suggestions(q.q);
  }

  @Get()
  @ContractRouteSchema({ responses: { 200: ListSearchResultsResponse } })
  @Roles(['public'])
  async results(@ContractQuery(ListSearchResultsQueryParams) q: z.output<typeof ListSearchResultsQueryParams>, @Res({ passthrough: true }) reply: FastifyReply): Promise<SearchOutcome> {
    void reply.header('cache-control', SEARCH_CACHE);
    return this.search.search({
      q: q.q ?? '',
      ...(q.genre !== undefined ? { genre: q.genre } : {}),
      ...(q.placeId !== undefined ? { placeId: q.placeId } : {}),
      ...(q.artistId !== undefined ? { artistId: q.artistId } : {}),
      ...(q.dateFrom !== undefined ? { dateFrom: q.dateFrom } : {}),
      ...(q.dateTo !== undefined ? { dateTo: q.dateTo } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      includePast: q.includePast,
      noConvert: q.noConvert,
      ...(q.sort !== undefined ? { sort: q.sort } : {}),
      page: q.page,
    });
  }
}
