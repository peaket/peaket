// PostgreSQL 검색 읽기 모델 동기화·자동완성 사전 원천(ADR-0271 결정 1·2·3·6, docs/data.md search_document·search_term·search_removal·search_version).
// - sync(tx, ids, at): 부르는 쪽 트랜잭션에서 원천 함수 search_document_source_at(at, ids)로 그 공연들을 다시 계산해 search_document·search_term을 고친다.
//   빠진 공연과 없어진 이름 줄은 지우고 search_removal에 적는다. 바뀐 것이 있을 때만 search_version을 한 번 1 올리고(UPDATE … RETURNING) 바뀐 줄에 그 판을 적는다.
//   관심도(interest)는 새로 넣을 때만 원천 값이고, 그 뒤에는 1시간 정리(recountInterest)가 센다(찜 쓰기마다 판을 올리지 않는다).
//   이름 줄의 정규화·낱자·초성은 앱이 @peaket/search-normalize로 계산한다(termRowsOf, SQL로 다시 짜지 않는다).
// - syncTimed·recountInterest·purgeRemovals: 정리 주기(쓰기 연결, 운영은 core_ops). 저마다 자기 트랜잭션 첫 문장에서 같은 열쇠의 트랜잭션 권고 잠금을 잡고(pg_try_advisory_xact_lock),
//   못 잡으면 그 차례를 건너뛴다. reconcileAll(시작 따라잡기)은 끊음 트랜잭션마다 같은 잠금과 search_version의 임대로 한 파드만 돌게 한다.
//   세션 잠금은 쓰지 않는다(PgBouncer 트랜잭션 풀링에서는 트랜잭션마다 연결이 바뀐다, ADR-0083 결정 4·ADR-0271 결정 12 '잠금과 임대').
// - read·version: 사전 원천(운영은 읽기 전용 복제본 연결). 한 읽기 전용 REPEATABLE READ 트랜잭션에서 판을 먼저 읽는다.
import type { Database, DbTransaction } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { sql } from 'drizzle-orm';
import { termRowsOf, type DictionarySnapshot, type SearchDictionarySource, type SearchReadModelSync, type SearchTermRow } from '../../domain/search.js';
import { documentOfRow, rowsOf, termOfRow, type DocumentRow, type TermRow } from './search-rows.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 지운 표시를 두는 시간(docs/features/search.md:47, 하루 [가정]) */
export const SEARCH_REMOVAL_KEEP_MS = 86_400_000;
/** 시작 따라잡기의 끊음 크기(ADR-0271 결정 12, 500개 [가정]) */
export const RECONCILE_CHUNK = 500;
/** 이름 줄을 한 문장에 넣는 줄 수(줄마다 매개변수 10개, PostgreSQL 매개변수 상한 65,535 안) */
const TERM_BATCH = 500;
/** 정리 작업·따라잡기 끊음의 트랜잭션 권고 잠금 열쇠(여러 파드 중 하나만 돈다, ADR-0271 결정 12 '잠금과 임대') */
const TIDY_LOCK = 2_710_165;
/** 따라잡기 임대 길이(ADR-0271 결정 12, 60초 [가정]). 끊음마다 연장한다 */
export const RECONCILE_LEASE_MS = 60_000;
/** 따라잡기 끊음이 잠금을 기다리는 상한(SET LOCAL lock_timeout, 2초 [가정]) */
export const RECONCILE_LOCK_TIMEOUT_MS = 2_000;
/** 따라잡기 임대 주인 이름의 기본값: 호스트 이름 + 새 UUID(어댑터를 만들 때마다 새로 짓는다. 파드마다 겹치지 않는다) */
export const reconcileOwnerName = (): string => `${hostname()}-${randomUUID()}`;

interface LeaseRow {
  reconcile_owner: string | null;
  reconcile_cursor: string | null;
  reconcile_started_at: string | Date | null;
  expired: boolean;
}

/** 같은 열쇠의 트랜잭션 권고 잠금을 기다리지 않고 잡는다(못 잡으면 false). 트랜잭션이 끝나면 저절로 풀린다(PgBouncer 트랜잭션 풀링과 맞는다) */
async function tryTidyLock(tx: Pick<DbTransaction, 'execute'>): Promise<boolean> {
  const [lock] = rowsOf<{ ok: boolean }>(await tx.execute(sql`select pg_try_advisory_xact_lock(${TIDY_LOCK}) as ok`));
  return lock?.ok === true;
}

/** 드라이버 오류의 SQLSTATE(Drizzle은 cause에 싸서 줄 수 있다) */
function codeOf(e: unknown): string | undefined {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; cur = (cur as { cause?: unknown }).cause, depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}
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
  /** 따라잡기 임대의 주인 이름(이 어댑터가 쥐는 임대를 다음 부름에서 이어 간다) */
  readonly #owner = reconcileOwnerName();

  /** origin: 사전 문서의 포스터 주소 출처(IMAGE_ORIGIN). 없으면 포스터 주소를 싣지 않는다 */
  constructor(
    readonly db: Database,
    private readonly origin?: string,
  ) {}

  async sync(tx: DbTransaction, productionIds: readonly string[], at: Date): Promise<{ version: number; removed: string[] }> {
    const r = await this.#apply(tx, productionIds, at);
    return { version: r.version, removed: r.removed };
  }

  /** 원천과 표가 같으면 판·지운 표시를 건드리지 않는다(판은 실제로 바꾼 트랜잭션마다 1, ADR-0271 결정 12 보탬) */
  async #apply(tx: DbTransaction, productionIds: readonly string[], at: Date): Promise<{ version: number; changed: boolean; removed: string[] }> {
    const ids = [...new Set(productionIds)];
    if (ids.length === 0) return { version: await currentVersion(tx), changed: false, removed: [] };
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

    if (changedDocs.length === 0 && removedDocs.length === 0 && removedTerms.length === 0 && changedTerms.length === 0) {
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
    // 이름 줄은 여러 줄을 한 문장으로 넣는다(줄마다 왕복하지 않게). 매개변수 상한을 넘지 않게 500줄씩
    for (let i = 0; i < changedTerms.length; i += TERM_BATCH) {
      const values = changedTerms
        .slice(i, i + TERM_BATCH)
        .map((t) => sql`(${t.id}::uuid, ${t.kind}, ${t.targetId}::uuid, ${t.displayName}, ${t.aliasOf}, ${t.norm}, ${t.normNospace}, ${t.jamo}, ${t.chosung}, ${version})`);
      await tx.execute(sql`
        insert into search_term (id, kind, target_id, display_name, alias_of, norm, norm_nospace, jamo, chosung, updated_version)
        values ${sql.join(values, sql`, `)}
        on conflict (id) do update set kind = excluded.kind, target_id = excluded.target_id, display_name = excluded.display_name, alias_of = excluded.alias_of,
          norm = excluded.norm, norm_nospace = excluded.norm_nospace, jamo = excluded.jamo, chosung = excluded.chosung, updated_version = excluded.updated_version`);
    }
    return { version, changed: true, removed: removedDocs };
  }

  /** 같은 열쇠의 잠금을 못 잡으면 이 차례를 건너뛰고 skipped: true(부르는 쪽은 시각 창을 옮기지 않는다, 리뷰 R165-23) */
  async syncTimed(at: Date, since: Date): Promise<{ version: number | null; productions: number; skipped?: boolean }> {
    if (!(at.getTime() > since.getTime())) return { version: null, productions: 0 };
    return this.db.transaction(async (tx) => {
      if (!(await tryTidyLock(tx))) return { version: null, productions: 0, skipped: true };
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
      // 같은 열쇠의 트랜잭션 권고 잠금. 따라잡기 끊음·1분 정리·다른 파드의 다시 세기가 쥐고 있으면 이 차례는 건너뛴다(R165-19, R165-9 ①)
      if (!(await tryTidyLock(tx))) return 0;
      const r = (await tx.execute(sql`
        update search_document d set interest = s.interest
        from search_document_source_at(${at.toISOString()}::timestamptz) s
        where s.production_id = d.production_id and d.interest is distinct from s.interest`)) as unknown as { rowCount?: number | null };
      return r.rowCount ?? 0;
    });
  }

  /**
   * 시작 따라잡기(ADR-0271 결정 12 '잠금과 임대', 리뷰 R165-1·R165-14·R165-19). PgBouncer 트랜잭션 풀링에서도 맞게, 끊음 하나가 트랜잭션 하나이고
   * 그 트랜잭션 첫 문장들에서 같은 열쇠의 트랜잭션 권고 잠금을 잡는다(세션 잠금은 쓰지 않는다). 이어 가는 끊음은 lock_timeout(2초 [가정]) 안에서 기다리고,
   * 이번 부름의 첫 끊음은 기다리지 않고 시도만 한다(지금 다른 파드가 끊음·정리를 하고 있으면 건너뛴다. 함께 뜬 두 파드가 차례로 둘 다 시작하지 않게).
   * 잠금 뒤 search_version의 임대를 본다: 주인이 없거나 내가 주인이거나 만료(DB now() 기준)됐을 때만 주인을 나로·만료를 now() + leaseMs로 적고 그 끊음을 한다.
   * 아니면 멈추고 ran: false. 끊음은 원천과 표를 합친 공연 ID 차례이고 커서(끊음의 마지막 공연 ID)를 같은 트랜잭션에 적는다. 만료된 임대를 넘겨받으면 커서 뒤부터 잇는다.
   * 새로 시작할 때 reconciled_at을 비우고 시작 시각(reconcile_started_at)을 적는다. 마지막 끊음이 reconciled_at에 그 시작 시각을 적고 임대 칸 넷을 비운다.
   * 원천과 표가 같은 끊음은 판·지운 표시를 건드리지 않는다
   */
  async reconcileAll(
    at: Date,
    o: { chunkSize?: number; owner?: string; leaseMs?: number } = {},
  ): Promise<{ ran: boolean; productions: number; version: number | null; chunks: number; resumedFrom: string | null }> {
    const size = o.chunkSize ?? RECONCILE_CHUNK;
    if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunkSize는 1 이상의 정수다: ${size}`);
    const leaseMs = o.leaseMs ?? RECONCILE_LEASE_MS;
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new RangeError(`leaseMs는 1 이상의 정수(ms)다: ${leaseMs}`);
    const owner = o.owner ?? this.#owner;
    const atIso = at.toISOString();
    let productions = 0;
    let chunks = 0;
    let version: number | null = null;
    let resumedFrom: string | null = null;
    for (let first = true; ; first = false) {
      let step: 'stop' | 'more' | 'done';
      try {
        step = await this.db.transaction(async (tx) => {
          if (first) {
            // 이번 부름의 첫 끊음: 다른 파드의 끊음·정리가 지금 쥐고 있으면 기다리지 않고 이번 차례를 건너뛴다(함께 뜬 파드 가운데 하나만 시작한다)
            if (!(await tryTidyLock(tx))) return 'stop';
          } else {
            // 이어 가는 끊음: 끊음 사이에 끼어든 1분 정리 등이 끝나기를 잠깐(2초 [가정]) 기다린다
            await tx.execute(sql`select set_config('lock_timeout', ${String(RECONCILE_LOCK_TIMEOUT_MS)}, true)`);
            await tx.execute(sql`select pg_advisory_xact_lock(${TIDY_LOCK})`);
          }
          const [l] = rowsOf<LeaseRow>(
            await tx.execute(sql`
              select reconcile_owner, reconcile_cursor::text as reconcile_cursor, reconcile_started_at,
                (reconcile_lease_until is null or reconcile_lease_until <= now()) as expired
              from search_version where id = 1 for update`),
          );
          if (!l) throw new Error('search_version 줄이 없다');
          const mine = l.reconcile_owner === owner;
          if (l.reconcile_owner !== null && !mine && !l.expired) return 'stop';
          let cursor: string | null;
          if (l.reconcile_owner === null || l.reconcile_started_at === null) {
            // 새로 시작한다
            cursor = null;
            await tx.execute(sql`update search_version set reconciled_at = null, reconcile_started_at = ${atIso}::timestamptz, reconcile_cursor = null where id = 1`);
          } else {
            cursor = l.reconcile_cursor;
            // 다른 파드의 만료된 임대를 넘겨받았다(이번 호출에서 처음 잡을 때만 적는다)
            if (!mine && first) resumedFrom = cursor;
          }
          const next = rowsOf<{ production_id: string }>(
            await tx.execute(sql`
              select production_id from (
                select production_id from search_document_source_at(${atIso}::timestamptz)
                union select production_id from search_document) u
              where ${cursor === null ? sql`true` : sql`production_id > ${cursor}::uuid`}
              order by production_id limit ${size + 1}`),
          ).map((r) => r.production_id);
          const part = next.slice(0, size);
          const last = next.length <= size;
          if (part.length > 0) {
            version = (await this.#apply(tx, part, at)).version;
            productions += part.length;
            chunks += 1;
          }
          if (last) {
            await tx.execute(sql`
              update search_version set reconciled_at = reconcile_started_at,
                reconcile_owner = null, reconcile_lease_until = null, reconcile_started_at = null, reconcile_cursor = null
              where id = 1`);
            return 'done';
          }
          await tx.execute(sql`
            update search_version set reconcile_owner = ${owner}, reconcile_lease_until = now() + ${`${leaseMs} milliseconds`}::interval,
              reconcile_cursor = ${part[part.length - 1]!}::uuid
            where id = 1`);
          return 'more';
        });
      } catch (e) {
        // 잠금을 2초 안에 못 잡았다(다른 끊음·정리가 길다). 이번 차례는 멈춘다. 임대가 내 것이면 다음 부름이나 만료 뒤 다른 파드가 잇는다
        if (codeOf(e) === '55P03') step = 'stop';
        else throw e;
      }
      if (step === 'stop') return { ran: false, productions, version, chunks, resumedFrom };
      if (step === 'done') return { ran: true, productions, version, chunks, resumedFrom };
    }
  }

  /** 마지막으로 끝까지 마친 따라잡기의 시작 시각(search_version.reconciled_at). 없으면 null */
  /** 리뷰 W7L2-S3. BAT-165 시험 담당이 둔 빈 뼈대 */
  async syncPoster(_tx: unknown, _productionId: string): Promise<{ version: number | null }> {
    throw new Error('아직 없음');
  }

  async lastReconciledAt(): Promise<Date | null> {
    const [r] = rowsOf<{ reconciled_at: string | Date | null }>(await this.db.db.execute(sql`select reconciled_at from search_version where id = 1`));
    const v = r?.reconciled_at ?? null;
    return v === null ? null : new Date(v);
  }

  async purgeRemovals(at: Date): Promise<number> {
    const before = new Date(at.getTime() - SEARCH_REMOVAL_KEEP_MS).toISOString();
    return this.db.transaction(async (tx) => {
      if (!(await tryTidyLock(tx))) return 0;
      const r = (await tx.execute(sql`delete from search_removal where removed_at < ${before}::timestamptz`)) as unknown as { rowCount?: number | null };
      return r.rowCount ?? 0;
    });
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
