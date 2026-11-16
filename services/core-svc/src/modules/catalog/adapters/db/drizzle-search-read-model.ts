// PostgreSQL 검색 읽기 모델 동기화·자동완성 사전 원천(ADR-0271 결정 1·2·3·6, docs/data.md search_document·search_term·search_removal·search_version).
// - sync(tx, ids, at): 부르는 쪽 트랜잭션에서 원천 함수 search_document_source_at(at, ids)로 그 공연들을 다시 계산해 search_document·search_term을 고친다.
//   빠진 공연과 없어진 이름 줄은 지우고 search_removal에 적는다. 바뀐 것이 있을 때만 search_version을 한 번 1 올리고(UPDATE … RETURNING) 바뀐 줄에 그 판을 적는다.
//   관심도(interest)는 새로 넣을 때만 원천 값이고, 그 뒤에는 1시간 정리(recountInterest)가 센다(찜 쓰기마다 판을 올리지 않는다).
//   이름 줄의 정규화·낱자·초성은 앱이 @peaket/search-normalize로 계산한다(termRowsOf, SQL로 다시 짜지 않는다).
// - syncTimed·recountInterest·purgeRemovals: 정리 주기(쓰기 연결, 운영은 core_ops). 여러 파드가 함께 돌면 권고 잠금으로 하나만 한다.
// - read·version: 사전 원천(운영은 읽기 전용 복제본 연결). 한 읽기 전용 REPEATABLE READ 트랜잭션에서 판을 먼저 읽는다.
import type { Database, DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { termRowsOf, type DictionarySnapshot, type SearchDictionarySource, type SearchReadModelSync, type SearchTermRow } from '../../domain/search.js';
import { documentOfRow, rowsOf, termOfRow, type DocumentRow, type TermRow } from './search-rows.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 지운 표시를 두는 시간(docs/features/search.md:47, 하루 [가정]) */
export const SEARCH_REMOVAL_KEEP_MS = 86_400_000;
/** 시작 따라잡기의 끊음 크기(ADR-0271 결정 12, 500개 [가정]) */
export const RECONCILE_CHUNK = 500;
/** 정리 작업 권고 잠금 키(여러 파드 중 하나만 돈다) */
const TIDY_LOCK = 2_710_165;
/** 표와 원천을 견주는 칸(관심도·판 제외). 고정 글이다(sql.raw에는 값을 넣지 않는다) */
const COLS = sql.raw('representative_event_id, title, genre, place_id, place_name, artist_ids, artists, aliases, period_start, period_end, next_open_at, next_open_event_id, sale_status, sale_ends_at, min_price, poster_image_id, poster_alt');
const S_COLS = sql.raw('s.representative_event_id, s.title, s.genre, s.place_id, s.place_name, s.artist_ids, s.artists, s.aliases, s.period_start, s.period_end, s.next_open_at, s.next_open_event_id, s.sale_status, s.sale_ends_at, s.min_price, s.poster_image_id, s.poster_alt');
const D_COLS = sql.raw('d.representative_event_id, d.title, d.genre, d.place_id, d.place_name, d.artist_ids, d.artists, d.aliases, d.period_start, d.period_end, d.next_open_at, d.next_open_event_id, d.sale_status, d.sale_ends_at, d.min_price, d.poster_image_id, d.poster_alt');
const SET_COLS = sql.raw('representative_event_id = excluded.representative_event_id, title = excluded.title, genre = excluded.genre, place_id = excluded.place_id, place_name = excluded.place_name, artist_ids = excluded.artist_ids, artists = excluded.artists, aliases = excluded.aliases, period_start = excluded.period_start, period_end = excluded.period_end, next_open_at = excluded.next_open_at, next_open_event_id = excluded.next_open_event_id, sale_status = excluded.sale_status, sale_ends_at = excluded.sale_ends_at, min_price = excluded.min_price, poster_image_id = excluded.poster_image_id, poster_alt = excluded.poster_alt');

interface SourceRow {
  production_id: string;
  title: string;
  place_id: string | null;
  place_name: string | null;
  artists: { artistId: string; name: string }[] | null;
  alias_terms: { id: string; alias: string }[] | null;
}

const uuidArray = (ids: readonly string[]) => {
  for (const id of ids) if (!UUID.test(id)) throw new RangeError(`공연 ID가 UUID가 아니다: ${id}`);
  return `{${ids.join(',')}}`;
};

export class DrizzleSearchReadModel implements SearchReadModelSync, SearchDictionarySource {
  /** origin: 사전 문서의 포스터 주소 출처(IMAGE_ORIGIN). 없으면 포스터 주소를 싣지 않는다 */
  constructor(
    readonly db: Database,
    private readonly origin?: string,
  ) {}

  async sync(tx: DbTransaction, productionIds: readonly string[], at: Date): Promise<{ version: number; removed: string[] }> {
    const r = await this.#apply(tx, productionIds, at);
    return { version: r.version, removed: r.removed };
  }

  /** bump: 바뀐 것이 없어도 판을 올린다(시작 따라잡기의 끊음마다 판 1, ADR-0271 결정 12) */
  async #apply(tx: DbTransaction, productionIds: readonly string[], at: Date, bump = false): Promise<{ version: number; changed: boolean; removed: string[] }> {
    const ids = [...new Set(productionIds)];
    if (ids.length === 0 && !bump) return { version: await currentVersion(tx), changed: false, removed: [] };
    const arr = uuidArray(ids);
    const atIso = at.toISOString();
    const source = rowsOf<SourceRow>(
      await tx.execute(sql`select production_id, title, place_id, place_name, artists, alias_terms from search_document_source_at(${atIso}::timestamptz, ${arr}::uuid[])`),
    );
    const live = new Set(source.map((s) => s.production_id));
    // 원천과 다른(또는 없는) 공연 줄
    const changedDocs = rowsOf<{ production_id: string }>(
      await tx.execute(sql`
        select s.production_id from search_document_source_at(${atIso}::timestamptz, ${arr}::uuid[]) s
        left join search_document d on d.production_id = s.production_id
        where d.production_id is null or (${S_COLS}) is distinct from (${D_COLS})`),
    ).map((r) => r.production_id);
    const existing = rowsOf<{ production_id: string }>(await tx.execute(sql`select production_id from search_document where production_id = any(${arr}::uuid[])`)).map((r) => r.production_id);
    const removedDocs = existing.filter((id) => !live.has(id));

    // 이름 줄: 공연의 공연명·다른 이름, 그 공연의 아티스트·공연장
    const desired = new Map<string, SearchTermRow>();
    for (const s of source) {
      for (const t of termRowsOf({ productionId: s.production_id, title: s.title, aliases: s.alias_terms ?? [], artists: s.artists ?? [], placeId: s.place_id, placeName: s.place_name }, 0)) desired.set(t.id, t);
    }
    const sharedIds = [...desired.values()].filter((t) => t.kind !== 'PRODUCTION').map((t) => t.id);
    const current = rowsOf<TermRow>(
      await tx.execute(sql`
        select id, kind, target_id, display_name, alias_of from search_term
        where (kind = 'PRODUCTION' and target_id = any(${arr}::uuid[])) or id = any(${uuidArray(sharedIds)}::uuid[])`),
    );
    const currentById = new Map(current.map((t) => [t.id, t]));
    const removedTerms = current.filter((t) => t.kind === 'PRODUCTION' && !desired.has(t.id)).map((t) => t.id);
    const changedTerms = [...desired.values()].filter((t) => {
      const c = currentById.get(t.id);
      return !c || c.kind !== t.kind || c.target_id !== t.targetId || c.display_name !== t.displayName || (c.alias_of ?? null) !== t.aliasOf;
    });

    if (!bump && changedDocs.length === 0 && removedDocs.length === 0 && removedTerms.length === 0 && changedTerms.length === 0) {
      return { version: await currentVersion(tx), changed: false, removed: [] };
    }
    // 판은 트랜잭션마다 한 번(이 트랜잭션이 끝날 때까지 이 줄을 잠근다, data.md search_version)
    const [bumped] = rowsOf<{ version: string | number }>(await tx.execute(sql`update search_version set version = version + 1, updated_at = ${atIso}::timestamptz where id = 1 returning version`));
    const version = Number(bumped!.version);

    if (changedDocs.length > 0) {
      await tx.execute(sql`
        insert into search_document (production_id, ${COLS}, interest, updated_version)
        select production_id, ${COLS}, interest, ${version} from search_document_source_at(${atIso}::timestamptz, ${uuidArray(changedDocs)}::uuid[])
        on conflict (production_id) do update set ${SET_COLS}, updated_version = excluded.updated_version`);
    }
    if (removedDocs.length > 0) {
      const rm = uuidArray(removedDocs);
      await tx.execute(sql`delete from search_document where production_id = any(${rm}::uuid[])`);
      await tx.execute(sql`insert into search_removal (version, kind, target_id, removed_at) select ${version}, 'DOCUMENT', unnest(${rm}::uuid[]), ${atIso}::timestamptz`);
    }
    if (removedTerms.length > 0) {
      const rm = uuidArray(removedTerms);
      await tx.execute(sql`delete from search_term where id = any(${rm}::uuid[])`);
      await tx.execute(sql`insert into search_removal (version, kind, target_id, removed_at) select ${version}, 'TERM', unnest(${rm}::uuid[]), ${atIso}::timestamptz`);
    }
    for (const t of changedTerms) {
      await tx.execute(sql`
        insert into search_term (id, kind, target_id, display_name, alias_of, norm, norm_nospace, jamo, chosung, updated_version)
        values (${t.id}::uuid, ${t.kind}, ${t.targetId}::uuid, ${t.displayName}, ${t.aliasOf}, ${t.norm}, ${t.normNospace}, ${t.jamo}, ${t.chosung}, ${version})
        on conflict (id) do update set kind = excluded.kind, target_id = excluded.target_id, display_name = excluded.display_name, alias_of = excluded.alias_of,
          norm = excluded.norm, norm_nospace = excluded.norm_nospace, jamo = excluded.jamo, chosung = excluded.chosung, updated_version = excluded.updated_version`);
    }
    return { version, changed: true, removed: removedDocs };
  }

  async syncTimed(at: Date, since: Date): Promise<{ version: number | null; productions: number }> {
    if (!(at.getTime() > since.getTime())) return { version: null, productions: 0 };
    return this.db.transaction(async (tx) => {
      const [lock] = rowsOf<{ ok: boolean }>(await tx.execute(sql`select pg_try_advisory_xact_lock(${TIDY_LOCK}) as ok`));
      if (!lock?.ok) return { version: null, productions: 0 };
      const s = since.toISOString();
      const a = at.toISOString();
      // 오픈 시각·판매 종료(공연 시작 − 24시간)·공연 시작(대표 회차의 '가장 최근 공연') 시각이 (since, at]에 든 회차의 공연
      const ids = rowsOf<{ production_id: string }>(
        await tx.execute(sql`
          select distinct production_id from event
          where (open_at > ${s}::timestamptz and open_at <= ${a}::timestamptz)
             or (starts_at > ${s}::timestamptz + interval '24 hours' and starts_at <= ${a}::timestamptz + interval '24 hours')
             or (starts_at > ${s}::timestamptz and starts_at <= ${a}::timestamptz)`),
      ).map((r) => r.production_id);
      if (ids.length === 0) return { version: null, productions: 0 };
      const r = await this.#apply(tx, ids, at);
      return { version: r.changed ? r.version : null, productions: ids.length };
    });
  }

  async recountInterest(at: Date): Promise<number> {
    return this.db.transaction(async (tx) => {
      const r = (await tx.execute(sql`
        update search_document d set interest = s.interest
        from search_document_source_at(${at.toISOString()}::timestamptz) s
        where s.production_id = d.production_id and d.interest is distinct from s.interest`)) as unknown as { rowCount?: number | null };
      return r.rowCount ?? 0;
    });
  }

  /**
   * 시작 따라잡기(ADR-0271 결정 12, 리뷰 R165-1): 1분 정리와 같은 권고 잠금 안에서 원천에 있는 공연과 표에 있는 공연을 합친 모든 공연을
   * 500개 [가정]씩 끊어 다시 동기화한다(끊음마다 판 1). 원천에 없는 표 줄은 지우고 지운 표시를 적는다. 잠금을 못 잡으면 건너뛴다
   */
  async reconcileAll(at: Date): Promise<{ ran: boolean; productions: number; version: number | null }> {
    return this.db.transaction(async (tx) => {
      const [lock] = rowsOf<{ ok: boolean }>(await tx.execute(sql`select pg_try_advisory_xact_lock(${TIDY_LOCK}) as ok`));
      if (!lock?.ok) return { ran: false, productions: 0, version: null };
      const ids = rowsOf<{ production_id: string }>(
        await tx.execute(sql`
          select production_id from search_document_source_at(${at.toISOString()}::timestamptz)
          union select production_id from search_document
          order by production_id`),
      ).map((r) => r.production_id);
      let version: number | null = null;
      for (let i = 0; i < ids.length; i += RECONCILE_CHUNK) version = (await this.#apply(tx, ids.slice(i, i + RECONCILE_CHUNK), at, true)).version;
      return { ran: true, productions: ids.length, version };
    });
  }

  async purgeRemovals(at: Date): Promise<number> {
    const before = new Date(at.getTime() - SEARCH_REMOVAL_KEEP_MS).toISOString();
    const r = (await this.db.db.execute(sql`delete from search_removal where removed_at < ${before}::timestamptz`)) as unknown as { rowCount?: number | null };
    return r.rowCount ?? 0;
  }

  async read(since: number | null): Promise<DictionarySnapshot> {
    return this.db.transaction(
      async (tx) => {
        // 판을 먼저 읽는다(복제본 지연이 있어도 같은 스냅숏의 줄은 이 판까지를 담는다)
        const version = await currentVersion(tx);
        if (since === null) {
          const documents = rowsOf<DocumentRow>(await tx.execute(sql`select * from search_document`)).map((r) => documentOfRow(r, this.origin));
          const terms = rowsOf<TermRow>(await tx.execute(sql`select * from search_term`)).map(termOfRow);
          return { version, full: true, documents, terms, removals: [] };
        }
        const documents = rowsOf<DocumentRow>(await tx.execute(sql`select * from search_document where updated_version > ${since}`)).map((r) => documentOfRow(r, this.origin));
        const terms = rowsOf<TermRow>(await tx.execute(sql`select * from search_term where updated_version > ${since}`)).map(termOfRow);
        const removals = rowsOf<{ version: string | number; kind: string; target_id: string }>(
          await tx.execute(sql`select version, kind, target_id from search_removal where version > ${since} order by version, kind, target_id`),
        ).map((r) => ({ version: Number(r.version), kind: r.kind as 'DOCUMENT' | 'TERM', targetId: r.target_id }));
        return { version, full: false, documents, terms, removals };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async version(): Promise<number> {
    const [r] = rowsOf<{ version: string | number }>(await this.db.db.execute(sql`select version from search_version where id = 1`));
    return Number(r?.version ?? 0);
  }

  /** search_term 줄 수(사전 어긋남 게이지) */
  async termCount(): Promise<number> {
    const [r] = rowsOf<{ n: string | number }>(await this.db.db.execute(sql`select count(*) as n from search_term`));
    return Number(r?.n ?? 0);
  }
}

async function currentVersion(tx: Pick<DbTransaction, 'execute'>): Promise<number> {
  const [r] = rowsOf<{ version: string | number }>(await tx.execute(sql`select version from search_version where id = 1`));
  return Number(r?.version ?? 0);
}
