// 유스케이스: 검색 결과와 자동완성(openapi listSearchResults·getSearchSuggestions, ADR-0094, ADR-0271, docs/features/search.md §4~§7·§10·§11, BUILD_ORDER HOT-270·HOT-280).
// - 결과는 SearchIndex가 후보만 읽어 순위·필터·쪽을 맞춘다. 검색 전용 연결 묶음이 넘치면 503(no-store)과 보안 사건 줄 search_pool_saturated다.
// - 자동완성은 메모리 사전(SuggestionDictionary)이 답한다. 요청은 사전을 갱신하지 않는다(판 확인도 하지 않는다). 갱신은 10초 [가정] 주기 일만 한다(ADR-0271 결정 14).
//   첫 통째로 읽기 전에는 자동완성이 빈 후보(받는 층이 no-store를 단다)이고 0건 검색의 didYouMean은 null이다. 사전은 준비 확인에 넣지 않는다
//   (준비 확인은 공유 의존성을 보지 않는다, docs/architecture.md §8 '프로브 규칙', ADR-0271 결정 14 바로잡음).
// - 정규 로그 줄: search_query(가린 정규화 검색어 50자 이하·결과 수·필터 이름·쪽·소요 ms), search_suggest(입력 길이·후보 수·사전 판 dictionaryVersion). 계정·IP·쿠키는 싣지 않는다.
//   바탕 칸 이름(version 등)을 줄 칸으로 쓰지 않는다(ADR-0271 결정 15).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger, ProblemError, RequestValidationError } from '@peaket/platform';
import { normalize } from '@peaket/search-normalize';
import {
  maskSearchQuery,
  SEARCH_DICTIONARY,
  SEARCH_INDEX,
  SEARCH_MAX_PAGE,
  type SearchIndex,
  type SearchOutcome,
  type SearchQuery,
  type SearchSuggestions,
  SearchUnavailable,
  type SuggestionDictionary,
} from '../domain/search.js';

/** 로그 줄의 검색어 상한(catalog-review.md:172, 정규화한 값 50자) */
export const SEARCH_LOG_QUERY_MAX = 50;
/** 503의 Retry-After(초) [가정]. CDN은 stale-if-error로 직전 응답을 낸다 */
export const SEARCH_RETRY_AFTER_SECONDS = 1;

export interface SearchInput extends Omit<SearchQuery, 'now'> {}

const FILTERS = ['genre', 'placeId', 'artistId', 'dateFrom', 'dateTo', 'status'] as const;

/** 검색 전용 연결 묶음이 넘쳤거나 질의 시간 상한을 넘었다(openapi ServiceUnavailable, 목록의 dependency-unavailable: 읽기 전용 복제본을 잠시 쓸 수 없다) */
export const searchUnavailable = (): ProblemError =>
  new ProblemError({ type: 'dependency-unavailable', status: 503, title: '의존 서비스를 잠시 쓸 수 없습니다', retryAfterSeconds: SEARCH_RETRY_AFTER_SECONDS });

/** 로그에 남기는 검색어: 정규화 → 가리기 → 50자 */
export const loggedQuery = (q: string): string => [...maskSearchQuery(normalize(q))].slice(0, SEARCH_LOG_QUERY_MAX).join('');

@Injectable()
export class SearchCatalog {
  constructor(
    @Inject(SEARCH_INDEX) private readonly index: SearchIndex,
    @Inject(SEARCH_DICTIONARY) readonly dictionary: SuggestionDictionary,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info' | 'warn'>,
  ) {}

  async search(q: SearchInput): Promise<SearchOutcome> {
    if (q.page > SEARCH_MAX_PAGE) throw new RequestValidationError('page');
    const started = this.clock.monotonicMs();
    let out: SearchOutcome;
    try {
      out = await this.index.search({ ...q, now: new Date(this.clock.now()) });
    } catch (e) {
      if (!(e instanceof SearchUnavailable)) throw e;
      this.#log('warn', { kind: 'security', event: 'search_pool_saturated', reason: e.reason }, '검색 전용 연결 묶음이 넘쳐 503으로 답했다');
      throw searchUnavailable();
    }
    // 0건 제안은 메모리 사전이 답한다. 사전을 처음 읽기 전에는 제안이 없다(이름 줄을 통째로 읽어 대신하지 않는다, ADR-0271 결정 14)
    if (!this.dictionary.ready && out.didYouMean !== null) out = { ...out, didYouMean: null };
    const filters: string[] = FILTERS.filter((k) => q[k] !== undefined);
    if (q.includePast) filters.push('includePast');
    const durationMs = Math.max(0, Math.round(this.clock.monotonicMs() - started));
    this.#log('info', { event: 'search_query', query: loggedQuery(q.q), results: out.total, filters, page: q.page, durationMs }, '검색');
    return out;
  }

  /** 사전이 처음 읽기 전이면 빈 후보(ready: false, 받는 층이 캐시하지 않게 no-store를 단다). DB를 부르지 않는다 */
  async suggestions(q: string): Promise<SearchSuggestions & { ready: boolean }> {
    const ready = this.dictionary.ready;
    const out = ready ? this.dictionary.suggest(q) : { query: normalize(q.trim()), items: [] };
    this.#log('info', { event: 'search_suggest', inputLength: [...normalize(q)].length, candidates: out.items.length, dictionaryVersion: this.dictionary.version }, '자동완성');
    return { ...out, ready };
  }

  #log(level: 'info' | 'warn', o: Record<string, unknown>, msg: string): void {
    try {
      this.logger?.[level](o, msg);
    } catch {
      // 기록 실패는 응답을 바꾸지 않는다
    }
  }
}
