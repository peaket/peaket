// 유스케이스: 공연 등록 1단계의 아티스트·공연장 찾기(openapi listPartnerArtists·listPartnerPlaces, FR-022, ADR-0093, ADR-0242).
// 목록을 파드 메모리에 두고 비교 값을 미리 만들어 찾는다. 한글 규칙은 packages/search-normalize가 맡는다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, RequestValidationError } from '@peaket/platform';
import { compareMatch, indexName, type IndexedName, searchIndexed, sortIndex } from '@peaket/search-normalize';
import { CATALOG_REPOSITORY, type CatalogRepository, type NameEntry, type PlaceNameEntry } from '../domain/ports.js';

/** 목록을 다시 읽는 간격 [가정] */
export const DIRECTORY_TTL_MS = 30_000;
/** 읽기가 실패했을 때 다시 읽을 때까지 앞 목록을 쓰는 시간 [가정] */
const FAILED_RETRY_MS = 5_000;
const DEFAULT_LIMIT = 20;
/** 비교 값을 만들다가 이만큼마다 다른 요청에 차례를 넘긴다 */
const INDEX_CHUNK = 500;

/** 목록이 커도 한 번에 처리를 오래 막지 않게 나눠 만든다 */
async function buildIndex<T extends NameEntry>(rows: T[]): Promise<Array<IndexedName<T>>> {
  const out: Array<IndexedName<T>> = [];
  for (let i = 0; i < rows.length; i += INDEX_CHUNK) {
    for (const row of rows.slice(i, i + INDEX_CHUNK)) out.push(indexName(row));
    await new Promise((done) => setImmediate(done));
  }
  return sortIndex(out);
}

class NameCache<T extends NameEntry> {
  #index: Array<IndexedName<T>> | undefined;
  #at = 0;
  #loading: Promise<Array<IndexedName<T>>> | undefined;

  constructor(
    private readonly load: () => Promise<T[]>,
    private readonly clock: Clock,
  ) {}

  async get(): Promise<Array<IndexedName<T>>> {
    if (this.#index && this.clock.now() - this.#at < DIRECTORY_TTL_MS) return this.#index;
    this.#loading ??= this.load()
      .then(buildIndex)
      .then((index) => {
        this.#index = index;
        this.#at = this.clock.now();
        return index;
      })
      .finally(() => {
        this.#loading = undefined;
      });
    try {
      return await this.#loading;
    } catch (err) {
      if (!this.#index) throw err;
      // 앞 목록으로 답하고, 요청마다 DB를 두드리지 않게 잠시 뒤에 다시 읽는다
      this.#at = this.clock.now() - DIRECTORY_TTL_MS + FAILED_RETRY_MS;
      return this.#index;
    }
  }
}

/** 커서는 마지막으로 준 항목의 (등급, 이름, ID)다. 파드마다 목록이 조금 달라도 겹치거나 빠지지 않는다(guidelines §3) */
interface CursorKey {
  grade: number;
  name: string;
  id: string;
}

function decodeCursor(cursor: string | undefined): CursorKey | undefined {
  if (cursor === undefined) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new RequestValidationError('커서가 틀렸다');
  }
  if (!Array.isArray(v) || v.length !== 3) throw new RequestValidationError('커서가 틀렸다');
  const [grade, name, id] = v as unknown[];
  if (!Number.isInteger(grade) || (grade as number) < 0 || (grade as number) > 3 || typeof name !== 'string' || name.length > 200 || typeof id !== 'string' || id.length > 64) throw new RequestValidationError('커서가 틀렸다');
  return { grade: grade as number, name, id };
}

const encodeCursor = (k: CursorKey): string => Buffer.from(JSON.stringify([k.grade, k.name, k.id])).toString('base64url');

export interface DirectoryPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface DirectoryQuery {
  q: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}

@Injectable()
export class PartnerDirectory {
  readonly #artists: NameCache<NameEntry>;
  readonly #places: NameCache<PlaceNameEntry>;

  constructor(@Inject(CATALOG_REPOSITORY) repo: CatalogRepository, @Inject(CLOCK) clock: Clock) {
    this.#artists = new NameCache(() => repo.listArtistNames(), clock);
    this.#places = new NameCache(() => repo.listPlaceNames(), clock);
  }

  async artists(query: DirectoryQuery): Promise<DirectoryPage<{ artistId: string; name: string }>> {
    return this.#page(await this.#artists.get(), query, (a) => ({ artistId: a.id, name: a.name }));
  }

  async places(query: DirectoryQuery): Promise<DirectoryPage<{ placeId: string; name: string; address: string }>> {
    return this.#page(await this.#places.get(), query, (p) => ({ placeId: p.id, name: p.name, address: p.address }));
  }

  #page<T extends NameEntry, R>(index: Array<IndexedName<T>>, query: DirectoryQuery, view: (t: T) => R): DirectoryPage<R> {
    const after = decodeCursor(query.cursor);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const found = searchIndexed(index, query.q);
    const key = (m: (typeof found)[number]): CursorKey => ({ grade: m.grade, name: m.item.name, id: m.item.id });
    const start = after ? found.findIndex((m) => compareMatch(key(m), after) > 0) : 0;
    const rest = start < 0 ? [] : found.slice(start);
    const page = rest.slice(0, limit);
    return { items: page.map((m) => view(m.item)), nextCursor: rest.length > limit ? encodeCursor(key(page.at(-1)!)) : null };
  }
}
