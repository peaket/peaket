// PostgreSQL 검색 어댑터(ADR-0271 결정 4·5·13, docs/data.md '공연 검색' 줄, HOT-270·HOT-280). 파드에 search_document 전체 사본을 두지 않는다.
// - 검색어가 있으면: search_term에서 후보 이름 줄을 찾고(낱자·초성에 입력이 든 줄, 이스케이프한 LIKE) 그 공연의 search_document 줄만 읽는다.
//   로마자만 친 입력은 한/영 변환 값도 함께 찾는다. 등급·필터·순위·쪽은 메모리 어댑터와 같은 TS 함수(matchGrades·rankMatched)가 한다.
// - 검색어가 없는 목록: 필터를 건 정렬 질의의 LIMIT 20 OFFSET, 전체 수는 1,001줄까지만 센다.
// - 관련 공연: 근거(같은 아티스트 → 같은 공연장의 오픈 예정, 결과 0건이면 다가오는 인기)마다 6개 [가정]만 읽는 정렬 질의.
// - 0건 제안: 메모리 사전의 correct(넘겨받은 때). 사전이 아직 준비되지 않았으면 null이다(이름 줄을 통째로 읽어 대신하지 않는다, ADR-0271 결정 14).
//   correct를 넘겨받지 않은 어댑터(시험이 어댑터만 만든 때)는 search_term의 공연명 줄로 같은 함수를 돌린다.
// - 필터 이름: search_term의 공연장·아티스트 줄(원래 이름). 없으면 null.
// - 이름 차례는 ICU 한국어 정렬(COLLATE "ko-x-icu")로 메모리의 Intl.Collator('ko')와 같게 견준다.
// - 검색 전용 연결 묶음(운영은 읽기 전용 복제본): 연결 대기를 넘기면 SearchUnavailable('pool-timeout'), 질의 시간 상한을 넘기면 'statement-timeout'(503).
import { type Database, type DbTransaction, Gauge, type Registry } from '@peaket/platform';
import { normalize, queryKeys, qwertyToHangul, type QueryKeys } from '@peaket/search-normalize';
import { sql, type SQL } from 'drizzle-orm';
import {
  card,
  didYouMeanOf,
  finishSearch,
  indexDocuments,
  matchGrades,
  rankMatched,
  relatedOf,
  RELATED_MAX,
  SEARCH_PAGE_SIZE,
  SEARCH_TOTAL_CAP,
  SearchUnavailable,
  type NameKeysLookup,
  type RankedSearch,
  type RelatedSource,
  type SearchDocument,
  type SearchIndex,
  type SearchOutcome,
  type SearchQuery,
} from '../../domain/search.js';
import { documentOfRow, rowsOf, type DocumentRow } from './search-rows.js';

/** 검색 질의 시간 상한(docs/features/search.md:242, 300ms [가정]) */
export const SEARCH_STATEMENT_TIMEOUT_MS = 300;

// 연결 대기 초과(pg-pool 3.x 메시지, @peaket/platform PlatformPool이 429 server-busy로 감싼다)
const CONNECT_TIMEOUTS = new Set(['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout']);
// searchIndexed의 한/영 변환과 같은 입력 다듬기
const INVISIBLE = /[​-‍⁠﻿ᅟᅠㅤ]/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 게이지 search_pool_waiting(docs/features/search.md §10·SR-T13 ①): 검색 전용 연결 묶음에서 연결을 기다리는 요청 수(pg Pool.waitingCount). 이름표는 없다.
 * main.ts가 검색 전용 묶음(searchDatabase.pool)을 넘긴다(기본 core_app 묶음이 아니다)
 */
export function registerSearchPoolWaiting(registry: Registry, pool: { readonly waitingCount: number }): Gauge {
  const gauge = new Gauge({
    name: 'search_pool_waiting',
    help: '검색 전용 연결 묶음에서 연결을 기다리는 요청 수',
    registers: [],
    collect() {
      this.set(pool.waitingCount);
    },
  });
  registry.registerMetric(gauge);
  return gauge;
}

/** 연결 묶음 포화·질의 시간 초과면 SearchUnavailable, 아니면 그대로 */
export function unavailableOf(e: unknown): unknown {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; cur = (cur as { cause?: unknown }).cause, depth++) {
    const x = cur as { slug?: unknown; message?: unknown; code?: unknown };
    if (x.slug === 'server-busy' || (typeof x.message === 'string' && CONNECT_TIMEOUTS.has(x.message))) return new SearchUnavailable('pool-timeout');
    if (x.code === '57014') return new SearchUnavailable('statement-timeout');
  }
  return e;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** 입력의 비교 값들(입력 그대로, 로마자면 한/영 변환 둘). matchGrades가 볼 수 있는 모든 꼴이다. 변환 값을 만들 수 없는 꼴은 뺀다(ADR-0271 결정 24) */
function keySets(query: string, noConvert: boolean): QueryKeys[] {
  const qk = queryKeys(query);
  const out = [qk];
  if (!noConvert) {
    const raw = query.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    if (/^[a-zA-Z ]+$/.test(raw)) {
      for (const to of [qwertyToHangul(raw), qwertyToHangul(qk.norm)]) if (to !== null) out.push(queryKeys(to));
    }
  }
  return out.filter((k) => k.nospace !== '');
}

// 정렬 키(ADR-0268 결정 3, 도메인 sortDocs와 같은 차례). 고정 글이다
const BY_TITLE = sql.raw(`title collate "ko-x-icu", production_id`);
const SALE_RANK = sql.raw(`case sale_status when 'ON_SALE' then 0 when 'UPCOMING' then 1 when 'SOLD_OUT' then 2 else 3 end`);
// 도메인은 nextOpenAt(ISO 글) ?? periodStart(날짜 글) ?? '9999-12-31'을 글로 견준다. 같은 글을 만들어 바이트 차례로 견준다
const OPEN_KEY = sql.raw(`coalesce(to_char(next_open_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), period_start::text, '9999-12-31') collate "C"`);

// 후보 줄에서 읽는 칸(DocumentRow). 쓰지 않는 artist_ids(jsonb)·updated_version은 읽지 않고, 시각은 toISOString과 같은 꼴(UTC 밀리초 'Z')의 글로 받아
// 줄마다 다시 해석하지 않는다(후보 수천 줄의 해석 비용, ADR-0271 결정 23). 날짜는 'YYYY-MM-DD' 글이다
const DOCUMENT_COLUMNS = sql.raw(
  `d.production_id, d.representative_event_id, d.title, d.genre, d.place_id, d.place_name, d.artists, d.aliases, d.period_start::text as period_start, d.period_end::text as period_end, to_char(d.next_open_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as next_open_at, d.next_open_event_id, d.sale_status, to_char(d.sale_ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as sale_ends_at, d.min_price, d.interest, d.poster_image_id, d.poster_alt`,
);

const hasFilters = (q: SearchQuery): boolean => q.genre !== undefined || q.placeId !== undefined || q.artistId !== undefined || q.dateFrom !== undefined || q.dateTo !== undefined || q.status !== undefined;

/** 도메인 filterDocs와 같은 필터(검색어 없는 목록). 날짜는 KST 달력 날짜이고 기간이 없는 공연은 날짜 필터에서 빠진다 */
function filters(q: Pick<SearchQuery, 'includePast'> & Partial<SearchQuery>): SQL {
  const parts: SQL[] = [sql`true`];
  if (!q.includePast) parts.push(sql`sale_status <> 'ENDED'`);
  if (q.genre !== undefined) parts.push(sql`genre = ${q.genre}`);
  if (q.placeId !== undefined) parts.push(UUID.test(q.placeId) ? sql`place_id = ${q.placeId}::uuid` : sql`false`);
  if (q.artistId !== undefined) parts.push(sql`artist_ids @> ${JSON.stringify([q.artistId])}::jsonb`);
  if (q.status !== undefined) parts.push(sql`sale_status = ${q.status}`);
  if (q.dateFrom !== undefined || q.dateTo !== undefined) parts.push(sql`period_start is not null and period_end is not null`);
  if (q.dateFrom !== undefined) parts.push(sql`period_end >= ${q.dateFrom}::date`);
  if (q.dateTo !== undefined) parts.push(sql`period_start <= ${q.dateTo}::date`);
  return sql.join(parts, sql` and `);
}

export class DrizzleSearchIndex implements SearchIndex {
  /**
   * o.correct: 메모리 사전의 오타 제안. 사전이 아직 준비되지 않았으면 undefined이고 그때 제안은 null이다.
   * o.keysOf: 메모리 사전이 들고 있는 이름 비교 값(후보 공연마다 다시 만들지 않게, ADR-0271 결정 23). 없는 이름은 새로 만든다
   */
  constructor(
    private readonly db: Database,
    private readonly origin: string,
    private readonly o: { statementTimeoutMs?: number; correct?: (q: string) => string | null | undefined; keysOf?: NameKeysLookup } = {},
  ) {}

  async search(q: SearchQuery): Promise<SearchOutcome> {
    try {
      return await this.db.transaction((tx) => (q.q.trim() === '' ? this.#list(tx, q) : this.#query(tx, q)), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
        statementTimeoutMs: this.o.statementTimeoutMs ?? SEARCH_STATEMENT_TIMEOUT_MS,
      });
    } catch (e) {
      throw unavailableOf(e);
    }
  }

  /** 검색어가 있을 때: 후보 공연만 읽는다 */
  async #query(tx: DbTransaction, q: SearchQuery): Promise<SearchOutcome> {
    const query = q.q.trim();
    const candidates = await this.#candidates(tx, keySets(query, q.noConvert));
    const ranked = rankMatched(candidates, q, matchGrades(indexDocuments(candidates, this.o.keysOf), query, q.noConvert));
    return this.#finish(tx, ranked, q);
  }

  /** 검색어가 없을 때: 필터를 건 정렬 질의의 한 쪽과 1,001줄까지 센 전체 수 */
  async #list(tx: DbTransaction, q: SearchQuery): Promise<SearchOutcome> {
    const where = filters(q);
    const sort = q.sort ?? 'OPEN_SOON';
    const order = sort === 'POPULAR' ? sql`interest desc, ${SALE_RANK}, ${BY_TITLE}` : sort === 'RELEVANCE' ? sql`${SALE_RANK}, interest desc, ${BY_TITLE}` : sql`${OPEN_KEY}, ${BY_TITLE}`;
    const [counted] = rowsOf<{ n: number | string }>(await tx.execute(sql`select count(*) as n from (select 1 from search_document where ${where} limit ${SEARCH_TOTAL_CAP + 1}) x`));
    const n = Number(counted?.n ?? 0);
    const rows = n === 0 ? [] : rowsOf<DocumentRow>(await tx.execute(sql`select * from search_document where ${where} order by ${order} limit ${SEARCH_PAGE_SIZE} offset ${(q.page - 1) * SEARCH_PAGE_SIZE}`));
    const total = Math.min(n, SEARCH_TOTAL_CAP);
    let relaxed: number | null = null;
    if (n === 0 && hasFilters(q)) {
      const [r] = rowsOf<{ n: number | string }>(await tx.execute(sql`select count(*) as n from search_document where ${filters({ includePast: q.includePast })}`));
      relaxed = Number(r?.n ?? 0);
    }
    const docs = rows.map((r) => documentOfRow(r, this.origin));
    const ranked: RankedSearch = {
      outcome: {
        items: docs.map(card),
        page: q.page,
        limit: SEARCH_PAGE_SIZE,
        total,
        totalCapped: n > SEARCH_TOTAL_CAP,
        totalPages: Math.ceil(total / SEARCH_PAGE_SIZE),
        query: { normalized: normalize(''), converted: null },
        relaxedTotal: relaxed,
      },
      // 검색어 없는 목록은 관련 공연을 고르지 않는다(0건이면 인기 공연)
      top: n === 0 ? undefined : docs[0],
      hasQuery: false,
      needsDidYouMean: false,
    };
    return this.#finish(tx, ranked, q);
  }

  async #finish(tx: DbTransaction, ranked: RankedSearch, q: SearchQuery): Promise<SearchOutcome> {
    const related = await relatedOf(this.#related(tx), ranked);
    const didYouMean = ranked.needsDidYouMean ? await this.#didYouMean(tx, q.q.trim()) : null;
    const filterNames = q.placeId !== undefined || q.artistId !== undefined ? await this.#filterNames(tx, q) : { placeName: null, artistName: null };
    return finishSearch(ranked, q, { didYouMean, related, filterNames });
  }

  #related(tx: DbTransaction): RelatedSource {
    const read = async (where: SQL, order: SQL) =>
      rowsOf<DocumentRow>(await tx.execute(sql`select * from search_document where ${where} order by ${order} limit ${RELATED_MAX}`)).map((r) => card(documentOfRow(r, this.origin)));
    return {
      byArtist: (artistId, exclude) => read(sql`artist_ids @> ${JSON.stringify([artistId])}::jsonb and production_id <> ${exclude}::uuid`, BY_TITLE),
      byPlace: (placeId, exclude) => read(sql`place_id = ${placeId}::uuid and sale_status = 'UPCOMING' and production_id <> ${exclude}::uuid`, BY_TITLE),
      popular: (exclude) => read(exclude ? sql`sale_status <> 'ENDED' and production_id <> ${exclude}::uuid` : sql`sale_status <> 'ENDED'`, sql`${SALE_RANK}, interest desc, ${BY_TITLE}`),
    };
  }

  async #didYouMean(tx: DbTransaction, query: string): Promise<string | null> {
    if (this.o.correct) return this.o.correct(query) ?? null;
    // 사전을 넘겨받지 않은 어댑터만 공연명 줄(search_term)로 같은 함수를 돌린다
    const titles = rowsOf<{ title: string; production_id: string }>(
      await tx.execute(sql`select display_name as title, target_id::text as production_id from search_term where kind = 'PRODUCTION' and alias_of is null`),
    );
    return didYouMeanOf(
      titles.map((t) => ({ title: t.title, productionId: t.production_id })),
      query,
    );
  }

  async #filterNames(tx: DbTransaction, q: SearchQuery): Promise<{ placeName: string | null; artistName: string | null }> {
    const name = async (kind: 'PLACE' | 'ARTIST', id: string | undefined) => {
      if (id === undefined || !UUID.test(id)) return null;
      const [r] = rowsOf<{ display_name: string }>(await tx.execute(sql`select display_name from search_term where kind = ${kind} and id = ${id}::uuid`));
      return r?.display_name ?? null;
    };
    return { placeName: await name('PLACE', q.placeId), artistName: await name('ARTIST', q.artistId) };
  }

  /**
   * 입력이 낱자·초성에 든 이름 줄의 공연(공연명·다른 이름이면 그 공연, 아티스트·공연장이면 그 이름을 가진 공연).
   * 이름 줄은 한 번만 모으고(hit, 두 번 넘게 쓰여 한 번만 계산된다) 갈래마다 따로 찾아 공연 ID로 합친다(ADR-0271 결정 22, docs/data.md '공연 검색' 줄):
   * 공연명·다른 이름은 공연 기본 키, 공연장은 search_document_place_idx, 아티스트는 걸린 아티스트 ID를 한 번 모은 해시 집합과 artist_ids 원소의 겹침
   * (search_document 훑기 한 번 + 줄마다 배열 풀기 + Hash Semi Join. ?| 배열 비교보다 공연 1만에서 약 4.5배 빠르다, BAT-166 구현 메모).
   * 공연 줄마다 되풀이되는 하위 계획(SubPlan)을 두지 않는다. union이 겹침을 없애 여러 갈래로 맞은 공연도 한 번이다
   */
  async #candidates(tx: DbTransaction, keys: readonly QueryKeys[]): Promise<SearchDocument[]> {
    if (keys.length === 0) return [];
    const conds: SQL[] = [];
    for (const k of keys) {
      conds.push(sql`t.jamo like ${`%${escapeLike(k.jamo)}%`} escape '\\'`);
      if (k.chosung !== null) conds.push(sql`t.chosung like ${`%${escapeLike(k.chosung)}%`} escape '\\'`);
    }
    const rows = rowsOf<DocumentRow>(
      await tx.execute(sql`
        with hit as (select distinct t.kind, t.target_id from search_term t where ${sql.join(conds, sql` or `)}),
        ids as (
          select target_id as id from hit where kind = 'PRODUCTION'
          union
          select p.production_id from search_document p where p.place_id in (select target_id from hit where kind = 'PLACE')
          union
          select a.production_id from search_document a cross join lateral jsonb_array_elements_text(a.artist_ids) x(artist_id)
          where x.artist_id in (select target_id::text from hit where kind = 'ARTIST')
        )
        select ${DOCUMENT_COLUMNS} from search_document d join ids on d.production_id = ids.id`),
    );
    return rows.map((r) => documentOfRow(r, this.origin));
  }
}
