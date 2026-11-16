// PostgreSQL 검색 어댑터: search_term에서 후보 이름 줄을 찾고 그 공연의 search_document 줄만 읽는다(ADR-0271 결정 4·5, docs/data.md '공연 검색' 줄, HOT-270·HOT-280).
// - 후보: 이름(공연명·다른 이름·아티스트·공연장)의 낱자·초성에 입력이 든 줄(앞부분·낱말 앞부분·중간 일치를 모두 덮는다. 이스케이프한 LIKE, 중간 일치는 훑기).
//   로마자만 친 입력은 한/영 변환 값도 함께 찾는다. 등급은 메모리 어댑터와 같은 TS 함수(matchGrades·assembleSearch)가 매긴다.
// - 검색어 없는 목록·관련 공연·인기 대체·0건 제안·필터 이름은 판(search_version)마다 들고 있는 전체 문서에서 고른다(판이 같으면 다시 읽지 않는다, 60초 [가정]마다 새로).
// - 검색 전용 연결 묶음(운영은 읽기 전용 복제본): 연결 대기를 넘기면 SearchUnavailable('pool-timeout'), 질의 시간 상한을 넘기면 'statement-timeout'(503).
import type { Database, DbTransaction } from '@peaket/platform';
import { convertQwertyToHangul, queryKeys, type QueryKeys } from '@peaket/search-normalize';
import { sql, type SQL } from 'drizzle-orm';
import { assembleSearch, matchGrades, indexDocuments, SearchUnavailable, type SearchDocument, type SearchIndex, type SearchOutcome, type SearchQuery } from '../../domain/search.js';
import { documentOfRow, rowsOf, type DocumentRow } from './search-rows.js';

/** 검색 질의 시간 상한(docs/features/search.md:242, 300ms [가정]) */
export const SEARCH_STATEMENT_TIMEOUT_MS = 300;
/** 전체 문서 사본을 다시 읽는 간격(관심도는 판을 올리지 않고 바뀐다) [가정] */
export const SEARCH_BROWSE_TTL_MS = 60_000;

// 연결 대기 초과(pg-pool 3.x 메시지, @peaket/platform PlatformPool이 429 server-busy로 감싼다)
const CONNECT_TIMEOUTS = new Set(['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout']);
// searchIndexed의 한/영 변환과 같은 입력 다듬기
const INVISIBLE = /[​-‍⁠﻿ᅟᅠㅤ]/g;

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

/** 입력의 비교 값들(입력 그대로, 로마자면 한/영 변환 둘). matchGrades가 볼 수 있는 모든 꼴이다 */
function keySets(query: string, noConvert: boolean): QueryKeys[] {
  const qk = queryKeys(query);
  const out = [qk];
  if (!noConvert) {
    const raw = query.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    if (/^[a-zA-Z ]+$/.test(raw)) out.push(queryKeys(convertQwertyToHangul(raw)), queryKeys(convertQwertyToHangul(qk.norm)));
  }
  return out.filter((k) => k.nospace !== '');
}

interface Browse {
  version: number;
  at: number;
  docs: SearchDocument[];
}

export class DrizzleSearchIndex implements SearchIndex {
  #browse: Browse | undefined;

  constructor(
    private readonly db: Database,
    private readonly origin: string,
    private readonly o: { statementTimeoutMs?: number; browseTtlMs?: number } = {},
  ) {}

  async search(q: SearchQuery): Promise<SearchOutcome> {
    try {
      return await this.db.transaction(
        async (tx) => {
          const all = await this.#all(tx, q.now.getTime());
          const query = q.q.trim();
          if (query === '') return assembleSearch(all, q, new Map(), all);
          const candidates = await this.#candidates(tx, keySets(query, q.noConvert));
          return assembleSearch(candidates, q, matchGrades(indexDocuments(candidates), query, q.noConvert), all);
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only', statementTimeoutMs: this.o.statementTimeoutMs ?? SEARCH_STATEMENT_TIMEOUT_MS },
      );
    } catch (e) {
      throw unavailableOf(e);
    }
  }

  /** 판이 같고 간격 안이면 들고 있는 전체 문서 */
  async #all(tx: DbTransaction, now: number): Promise<SearchDocument[]> {
    const [v] = rowsOf<{ version: string | number }>(await tx.execute(sql`select version from search_version where id = 1`));
    const version = Number(v?.version ?? 0);
    const b = this.#browse;
    if (b && b.version === version && now >= b.at && now - b.at < (this.o.browseTtlMs ?? SEARCH_BROWSE_TTL_MS)) return b.docs;
    const docs = rowsOf<DocumentRow>(await tx.execute(sql`select * from search_document`)).map((r) => documentOfRow(r, this.origin));
    this.#browse = { version, at: now, docs };
    return docs;
  }

  /** 입력이 낱자·초성에 든 이름 줄의 공연(공연명·다른 이름이면 그 공연, 아티스트·공연장이면 그 이름을 가진 공연) */
  async #candidates(tx: DbTransaction, keys: readonly QueryKeys[]): Promise<SearchDocument[]> {
    if (keys.length === 0) return [];
    const conds: SQL[] = [];
    for (const k of keys) {
      conds.push(sql`t.jamo like ${`%${escapeLike(k.jamo)}%`} escape '\\'`);
      if (k.chosung !== null) conds.push(sql`t.chosung like ${`%${escapeLike(k.chosung)}%`} escape '\\'`);
    }
    const rows = rowsOf<DocumentRow>(
      await tx.execute(sql`
        with hit as (select distinct t.kind, t.target_id from search_term t where ${sql.join(conds, sql` or `)})
        select d.* from search_document d
        where d.production_id in (select target_id from hit where kind = 'PRODUCTION')
           or d.place_id in (select target_id from hit where kind = 'PLACE')
           or exists (select 1 from jsonb_array_elements_text(d.artist_ids) a where a in (select target_id::text from hit where kind = 'ARTIST'))`),
    );
    return rows.map((r) => documentOfRow(r, this.origin));
  }
}
