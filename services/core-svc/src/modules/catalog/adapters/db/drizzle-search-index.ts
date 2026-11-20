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
import { GRADE, normalize, queryKeys, qwertyToHangul, type Grade, type QueryKeys } from '@peaket/search-normalize';
import { sql, type SQL } from 'drizzle-orm';
import {
  card,
  didYouMeanOf,
  finishSearch,
  indexDocuments,
  matchGrades,
  matchStagesOf,
  nameGradeOf,
  rankMatched,
  relatedOf,
  RELATED_MAX,
  SEARCH_PAGE_SIZE,
  SEARCH_TOTAL_CAP,
  SearchUnavailable,
  type DocumentIndex,
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

/** 후보 줄을 이만큼씩 끊어 바꾸고 사이에 I/O를 돌린다 [가정](공연 1만의 한 글자 입력이 수천~1만7천 줄, BAT-166 측정 §5 5) */
const SEARCH_YIELD_ROWS = 2_000;
/** 지금까지 쌓인 I/O 콜백(DB 답·새 요청)을 먼저 돌린 뒤 잇는다 */
const yieldToIo = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** 한 글자 입력의 이름 줄 한 줄(search_term). 등급은 display_name으로 매기고, 대상은 kind마다 다르다 */
interface NameRow {
  kind: 'PRODUCTION' | 'ARTIST' | 'PLACE';
  target_id: string;
  display_name: string;
}

/** 등급이 붙은 이름 줄의 대상(공연명 줄은 공연 ID, 아티스트·공연장 줄은 그 ID) */
interface GradedTargets {
  productions: string[];
  places: string[];
  artists: string[];
}

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
   * o.ready: 사전이 첫 통째로 읽기를 마쳤는가(ADR-0271 결정 25). 없으면 준비된 것으로 본다. false면 한 글자 단계별 읽기를 쓰지 않고 지금 질의로 답한다
   */
  constructor(
    private readonly db: Database,
    private readonly origin: string,
    private readonly o: { statementTimeoutMs?: number; correct?: (q: string) => string | null | undefined; keysOf?: NameKeysLookup; ready?: () => boolean } = {},
  ) {}

  /**
   * 한 번의 검색. 검색 전용 연결은 질의 동안만 쥔다(리뷰 R166-1, ADR-0271 결정 23 '주 스레드가 다 차지 않게'):
   * 1) 짧은 읽기 트랜잭션에서 후보(또는 목록 한 쪽)만 읽고 연결을 돌려준다 → 2) 연결 없이 줄 바꾸기·이름 비교·등급·순위를 한다 →
   * 3) 관련 공연·필터 이름(·사전이 없을 때의 오타 제안 원천)이 필요할 때만 둘째 짧은 트랜잭션으로 읽는다 → 4) 오타 제안 계산은 연결을 돌려준 뒤에 한다.
   * 두 트랜잭션은 서로 다른 스냅숏일 수 있다(그 사이 판이 바뀌면 관련 공연이 새 판에서 나온다. 읽기 모델은 원래 몇 초 늦을 수 있다)
   */
  async search(q: SearchQuery): Promise<SearchOutcome> {
    const ranked = q.q.trim() === '' ? await this.#list(q) : await this.#query(q);
    return this.#finish(ranked, q);
  }

  /** 검색 전용 연결로 짧은 읽기 트랜잭션 하나. 연결 묶음 포화·질의 시간 초과는 SearchUnavailable(503) */
  async #read<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(fn, {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
        statementTimeoutMs: this.o.statementTimeoutMs ?? SEARCH_STATEMENT_TIMEOUT_MS,
      });
    } catch (e) {
      throw unavailableOf(e);
    }
  }

  /** 검색어가 있을 때: 후보 공연만 읽고(연결은 그동안만), 등급·순위는 연결을 돌려준 뒤에 */
  async #query(q: SearchQuery): Promise<RankedSearch> {
    const query = q.q.trim();
    const keys = keySets(query, q.noConvert);
    // 한 글자 입력은 중간 일치를 보지 않으므로 변환 단계마다 이름 줄을 따로 읽고 등급이 붙은 이름 줄만 공연으로 펼친다(ADR-0271 결정 25).
    // 사전 비교 값을 쓰지 못하면(준비 전) 지금 질의로 답한다 — 결과는 같다
    if (keys.length > 0 && [...keys[0]!.nospace].length === 1 && this.o.keysOf !== undefined && (this.o.ready === undefined || this.o.ready())) return this.#staged(q, query);
    const rows = keys.length === 0 ? [] : await this.#read((tx) => this.#candidates(tx, keys));
    // 후보가 많으면(한두 글자 입력은 수천~수만) 줄 바꾸기·이름 색인을 끊어 하며 사이사이 다른 요청의 I/O(연결 반환·자동완성)를 먼저 돌린다.
    // 한 요청의 긴 계산이 주 스레드를 한 덩이로 막아 다른 검색이 연결 대기 100ms를 넘기지 않게 한다(BAT-166 측정 §5 4). 답은 같다
    const candidates: SearchDocument[] = [];
    const index: Array<DocumentIndex[number]> = [];
    for (let i = 0; i < rows.length; i += SEARCH_YIELD_ROWS) {
      if (i > 0) await yieldToIo();
      const part = rows.slice(i, i + SEARCH_YIELD_ROWS).map((r) => documentOfRow(r, this.origin));
      candidates.push(...part);
      index.push(...indexDocuments(part, this.o.keysOf));
    }
    if (rows.length > SEARCH_YIELD_ROWS) await yieldToIo();
    const graded = matchGrades(index, query, q.noConvert);
    if (rows.length > SEARCH_YIELD_ROWS) await yieldToIo();
    return rankMatched(candidates, q, graded);
  }

  /**
   * 한 글자 입력: 변환 단계(친 그대로 → 한/영 → 소문자)를 차례로 본다(ADR-0271 결정 25).
   * 단계마다 ① 짧은 읽기로 이름 줄만 읽고 연결을 돌려준 뒤 ② 이름 줄에 matchGrade를 매겨 등급이 붙은 줄의 대상만
   * ③ 둘째 짧은 읽기로 공연 줄을 펼쳐 읽고 ④ 그 단계의 질의로 최종 등급을 다시 매긴다.
   * 최종 등급이 하나라도 붙으면 그 단계에서 멈춘다. 이름 줄에 등급이 붙어도 공연 줄에서 0이면 다음 단계로 간다
   * (아티스트·공연장의 다른 이름 줄처럼 공연 줄 이름에 없는 줄). 두 읽기는 서로 다른 스냅숏일 수 있다(결정 23, 리뷰 R166-1)
   */
  async #staged(q: SearchQuery, query: string): Promise<RankedSearch> {
    for (const stage of matchStagesOf(query, q.noConvert)) {
      const names = await this.#read((tx) => this.#nameRows(tx, stage.keys));
      if (names.length === 0) continue;
      const targets = await this.#gradedTargets(names, stage.keys);
      if (targets.productions.length + targets.places.length + targets.artists.length === 0) continue;
      const rows = await this.#read((tx) => this.#documentsFor(tx, targets));
      const candidates: SearchDocument[] = [];
      const index: Array<DocumentIndex[number]> = [];
      for (let i = 0; i < rows.length; i += SEARCH_YIELD_ROWS) {
        if (i > 0) await yieldToIo();
        const part = rows.slice(i, i + SEARCH_YIELD_ROWS).map((r) => documentOfRow(r, this.origin));
        candidates.push(...part);
        index.push(...indexDocuments(part, this.o.keysOf));
      }
      if (rows.length > SEARCH_YIELD_ROWS) await yieldToIo();
      // 최종 등급은 그 단계의 질의로만 매긴다(noConvert=false로 매기면 다음 단계로 넘어가 그 단계의 결과가 빠진다)
      const { grades } = matchGrades(index, stage.value, true);
      if (rows.length > SEARCH_YIELD_ROWS) await yieldToIo();
      if (grades.size > 0) return rankMatched(candidates, q, { grades, converted: stage.converted });
    }
    // 어느 단계도 공연 줄에서 등급을 내지 못했다: 지금 질의와 같은 0건(0건 제안·관련 공연은 #finish가 채운다)
    return rankMatched([], q, { grades: new Map(), converted: null });
  }

  /** 한 단계의 이름 줄(search_term)만 읽는다(kind·target_id·display_name). 등급은 연결을 돌려준 뒤에 매긴다 */
  async #nameRows(tx: DbTransaction, key: QueryKeys): Promise<NameRow[]> {
    const conds: SQL[] = [sql`t.jamo like ${`%${escapeLike(key.jamo)}%`} escape '\\'`];
    if (key.chosung !== null) conds.push(sql`t.chosung like ${`%${escapeLike(key.chosung)}%`} escape '\\'`);
    return rowsOf<NameRow>(await tx.execute(sql`select distinct t.kind, t.target_id, t.display_name from search_term t where ${sql.join(conds, sql` or `)}`));
  }

  /** 이름 줄 가운데 그 단계에서 등급이 붙은 줄의 대상. 이름 줄이 많으면 2,000줄마다 I/O를 돌린다 */
  async #gradedTargets(rows: readonly NameRow[], key: QueryKeys): Promise<GradedTargets> {
    const byName = new Map<string, Grade>();
    const productions = new Set<string>();
    const places = new Set<string>();
    const artists = new Set<string>();
    for (let i = 0; i < rows.length; i += SEARCH_YIELD_ROWS) {
      if (i > 0) await yieldToIo();
      for (const r of rows.slice(i, i + SEARCH_YIELD_ROWS)) {
        let grade = byName.get(r.display_name);
        if (grade === undefined) {
          grade = nameGradeOf(key, r.display_name, this.o.keysOf);
          byName.set(r.display_name, grade);
        }
        if (grade === GRADE.NONE) continue;
        if (r.kind === 'PRODUCTION') productions.add(r.target_id);
        else if (r.kind === 'PLACE') places.add(r.target_id);
        else artists.add(r.target_id);
      }
    }
    return { productions: [...productions], places: [...places], artists: [...artists] };
  }

  /**
   * 등급이 붙은 이름 줄의 대상만 공연 줄로 펼쳐 읽는다(공연명·다른 이름 줄은 그 공연, 공연장 줄은 place_id,
   * 아티스트 줄은 artist_ids). 갈래마다 따로 찾아 union으로 합치고 공연 줄마다 도는 하위 계획을 두지 않는다(ADR-0271 결정 22).
   * 빈 갈래는 질의에 넣지 않는다
   */
  async #documentsFor(tx: DbTransaction, t: GradedTargets): Promise<DocumentRow[]> {
    const branches: SQL[] = [];
    if (t.productions.length > 0) branches.push(sql`select unnest(${sql.param(t.productions)}::uuid[]) as id`);
    if (t.places.length > 0) branches.push(sql`select p.production_id from search_document p where p.place_id = any(${sql.param(t.places)}::uuid[])`);
    if (t.artists.length > 0)
      branches.push(sql`select a.production_id from search_document a cross join lateral jsonb_array_elements_text(a.artist_ids) x(artist_id) where x.artist_id = any(${sql.param(t.artists)}::text[])`);
    if (branches.length === 0) return [];
    return rowsOf<DocumentRow>(await tx.execute(sql`with ids as (${sql.join(branches, sql` union `)}) select ${DOCUMENT_COLUMNS} from search_document d join ids on d.production_id = ids.id`));
  }

  /** 검색어가 없을 때: 필터를 건 정렬 질의의 한 쪽과 1,001줄까지 센 전체 수 */
  async #list(q: SearchQuery): Promise<RankedSearch> {
    const where = filters(q);
    const sort = q.sort ?? 'OPEN_SOON';
    const order = sort === 'POPULAR' ? sql`interest desc, ${SALE_RANK}, ${BY_TITLE}` : sort === 'RELEVANCE' ? sql`${SALE_RANK}, interest desc, ${BY_TITLE}` : sql`${OPEN_KEY}, ${BY_TITLE}`;
    const { n, rows, relaxed } = await this.#read(async (tx) => {
      const [counted] = rowsOf<{ n: number | string }>(await tx.execute(sql`select count(*) as n from (select 1 from search_document where ${where} limit ${SEARCH_TOTAL_CAP + 1}) x`));
      const n = Number(counted?.n ?? 0);
      const rows = n === 0 ? [] : rowsOf<DocumentRow>(await tx.execute(sql`select * from search_document where ${where} order by ${order} limit ${SEARCH_PAGE_SIZE} offset ${(q.page - 1) * SEARCH_PAGE_SIZE}`));
      let relaxed: number | null = null;
      if (n === 0 && hasFilters(q)) {
        const [r] = rowsOf<{ n: number | string }>(await tx.execute(sql`select count(*) as n from search_document where ${filters({ includePast: q.includePast })}`));
        relaxed = Number(r?.n ?? 0);
      }
      return { n, rows, relaxed };
    });
    const total = Math.min(n, SEARCH_TOTAL_CAP);
    const docs = rows.map((r) => documentOfRow(r, this.origin));
    return {
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
  }

  /** 관련 공연·필터 이름(그리고 사전이 없을 때 오타 제안의 공연명 줄)을 필요할 때만 둘째 짧은 트랜잭션으로 읽고, 오타 제안 계산은 그 뒤에 한다 */
  async #finish(ranked: RankedSearch, q: SearchQuery): Promise<SearchOutcome> {
    const top = ranked.top;
    const needsRelated = !top || (ranked.hasQuery && (top.artists.length > 0 || (top.placeId !== undefined && top.placeName !== undefined)));
    const needsNames = q.placeId !== undefined || q.artistId !== undefined;
    const needsTitles = ranked.needsDidYouMean && !this.o.correct;
    const none = { placeName: null, artistName: null };
    const read =
      needsRelated || needsNames || needsTitles
        ? await this.#read(async (tx) => ({
            related: needsRelated ? await relatedOf(this.#related(tx), ranked) : null,
            filterNames: needsNames ? await this.#filterNames(tx, q) : none,
            titles: needsTitles ? await this.#titles(tx) : [],
          }))
        : { related: null, filterNames: none, titles: [] };
    const query = q.q.trim();
    const didYouMean = !ranked.needsDidYouMean ? null : this.o.correct ? (this.o.correct(query) ?? null) : didYouMeanOf(read.titles, query);
    return finishSearch(ranked, q, { didYouMean, related: read.related, filterNames: read.filterNames });
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

  /** 사전을 넘겨받지 않은 어댑터만: 오타 제안에 쓰는 공연명 줄(search_term). 계산은 연결을 돌려준 뒤에 한다 */
  async #titles(tx: DbTransaction): Promise<Array<{ title: string; productionId: string }>> {
    const titles = rowsOf<{ title: string; production_id: string }>(
      await tx.execute(sql`select display_name as title, target_id::text as production_id from search_term where kind = 'PRODUCTION' and alias_of is null`),
    );
    return titles.map((t) => ({ title: t.title, productionId: t.production_id }));
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
  async #candidates(tx: DbTransaction, keys: readonly QueryKeys[]): Promise<DocumentRow[]> {
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
    return rows;
  }
}
