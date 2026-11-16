// 검색 읽기 모델 표·동기화·증분 사전 통합 시험(실제 PostgreSQL 18 컨테이너, BAT-165 웨이브 7 T-01·T-02·T-03·T-05·T-07(D)·T-14·T-19(D)·T-25, ADR-0271).
// 정본: docs/features/search.md §2.2(52줄 DB 설정 SR-T7), §2.3(56~59줄), §7.2(242줄 검색 전용 연결 묶음), §12 SR-T7(298)·SR-T8 ①②(299)·SR-T15 ②(306),
// docs/data.md search_document·search_term·search_removal·search_version(536~577줄), '공연 검색' 줄(2813).
// 이 시험은 운영과 같은 DB 역할(core_app·core_partner·core_ops)로 서비스를 띄우고, 동기화는 DrizzleSearchReadModel(슈퍼유저 연결)로 부른다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nameKeys } from '@peaket/search-normalize';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import pgLib from 'pg';
import { type Clock, createDatabase, createService, type Database, ensureOutboxPartitions, fakeClock, systemClock } from '@peaket/platform';
import type { SalePolicyRule } from '@peaket/validation/sale-policy';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleSearchIndex, DrizzleSearchReadModel, MemoryCatalogRepository, MemorySearchIndex, SEARCH_DICTIONARY_SOURCE, SearchCatalog, SearchUnavailable, SuggestionDictionary, type DictionarySnapshot, type SearchDictionarySource, type SearchReadModelSync } from '../src/modules/catalog/index.js';
import { SearchReadModelTimers } from '../src/modules/catalog/application/search-maintenance.js';
import { fillDatabase, fillMemory, type Golden } from '../test/search-golden-fixture.js';
import { artist, event, place, production, productionArtist, promoter, searchAlias, wish } from '../src/modules/catalog/adapters/db/schema.js';
import { PARTNER_PRODUCTION_MEDIA, type PartnerProductionMedia } from '../src/modules/catalog/domain/media-ports.js';
import type { SearchQuery } from '../src/modules/catalog/domain/search.js';
import { FakeIdentity, quiet, testMedia } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

type Svc = Awaited<ReturnType<typeof createService>>;

let pg: PostgresContainer;
let admin: Database;
let other: Database;
let appDb: Database;
let partnerDb: Database;
let opsDb: Database;
let svc: Svc;
let sync: DrizzleSearchReadModel;
const identity = new FakeIdentity();
let now = Date.parse('2026-11-16T00:00:00.000Z');
const clock: Clock = { now: () => now, monotonicMs: () => performance.now() };
const A = randomUUID();
const PLACE = randomUUID();
const ACTOR = randomUUID();
const H = 3_600_000;
const D = 24 * H;
const general: SalePolicyRule = { version: 1, name: '일반', rounds: 'ALL', rule: { then: { limitPerPerson: 4 } } };
// 원천과 표를 견줄 칸(updated_version 제외)
const COLS = 'production_id, title, genre, place_id, place_name, artists, aliases, representative_event_id, next_open_at, next_open_event_id, sale_status, period_start, period_end, sale_ends_at, interest, poster_image_id, poster_alt';

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-search-read-model', max: 4 });
  other = createDatabase({ url: pg.url, applicationName: 'core-svc-search-other', max: 2 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 4);
  opsDb = await loginFor(admin, pg, 'core_ops_login', 'core_ops', 4);
  await admin.db.insert(promoter).values({ id: A, legalName: '(주)에이' });
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: ACTOR });
  sync = new DrizzleSearchReadModel(admin);
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, opsDatabase: opsDb, media: testMedia() }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
}, 180_000);

afterAll(async () => {
  await svc?.close();
  for (const d of [appDb, partnerDb, opsDb, other, admin]) await d?.close();
  pg?.stop();
});

const rows = async (d: Database, text: string, values: unknown[] = []) => (await d.pool.query(text, values)).rows as Record<string, unknown>[];
const version = async () => Number((await rows(admin, 'select version from search_version where id = 1'))[0]!.version);
const docIds = async (d: Database = admin) => (await rows(d, 'select production_id from search_document')).map((r) => r.production_id as string);
const termCount = async (targetId: string) => Number((await rows(admin, 'select count(*)::int as n from search_term where target_id = $1', [targetId]))[0]!.n);
// 어긋난 줄 수(ADR-0271 결정 2 '어긋난 줄 0'): 원천과 표의 값이 다른 공연 수. 두 방향 차이를 공연 ID로 묶어 센다
// (값이 하나 다른 공연은 두 방향에 한 줄씩 나오지만 어긋난 줄은 하나다. 시험 이의 1, 2026-11-16)
const drift = async (at: number) =>
  Number(
    (
      await rows(
        admin,
        `select count(distinct production_id)::int as n from ((select ${COLS} from search_document_source_at($1) except select ${COLS} from search_document)
         union all (select ${COLS} from search_document except select ${COLS} from search_document_source_at($1))) d`,
        [new Date(at)],
      )
    )[0]!.n,
  );

async function seed(o: { title: string; saleReview?: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED'; events?: { cancelled?: boolean }[]; artistName?: string; alias?: string }) {
  const productionId = randomUUID();
  const review = o.saleReview ?? 'APPROVED';
  await admin.db.insert(production).values({
    id: productionId,
    promoterId: A,
    placeId: PLACE,
    title: o.title,
    genre: '콘서트',
    saleReview: review,
    saleApprovedAt: review === 'APPROVED' || review === 'SUSPENDED' ? new Date(now - 10 * D) : null,
    salePolicy: [general],
    salePolicyVersion: 1,
  });
  const eventIds: string[] = [];
  for (const e of o.events ?? [{}]) {
    const id = randomUUID();
    eventIds.push(id);
    await admin.db.insert(event).values({ id, productionId, promoterId: A, venueId: null, openAt: new Date(now - D), startsAt: new Date(now + 20 * D), endsAt: new Date(now + 20 * D + 2 * H), ...(e.cancelled ? { status: 'CANCELLED' } : {}) });
  }
  if (o.artistName) {
    const artistId = randomUUID();
    await admin.db.insert(artist).values({ id: artistId, name: o.artistName, createdBy: ACTOR });
    await admin.db.insert(productionArtist).values({ productionId, artistId, sortOrder: 0 });
  }
  if (o.alias) await admin.db.insert(searchAlias).values({ id: randomUUID(), targetKind: 'PRODUCTION', targetId: productionId, alias: o.alias, source: 'PARTNER', createdBy: ACTOR });
  return { productionId, eventIds };
}

const apiIds = async (q: string) => {
  const r = await svc.http.inject({ method: 'GET', url: `/v1/search?q=${encodeURIComponent(q)}&includePast=true` });
  expect(r.statusCode).toBe(200);
  return (JSON.parse(r.payload) as { items: { productionId: string }[] }).items.map((x) => x.productionId);
};

const query = (q: string): SearchQuery => ({ q, includePast: false, noConvert: false, page: 1, now: new Date(now) });

describe('SR-T7 DB 문자 분류', () => {
  test("SR-T7 마이그레이션 뒤 DB 문자 분류가 C·POSIX가 아니고 pg_trgm의 show_trgm('루멘')이 비지 않는다", async () => {
    // 새 마이그레이션까지 돌았다(읽기 모델이 표다)
    expect((await rows(admin, "select relkind from pg_class where relname = 'search_document'"))[0]?.relkind).toBe('r');
    // PostgreSQL 16부터 lc_ctype 설정 값은 없고 데이터베이스의 datctype을 본다
    const [s] = await rows(admin, 'select datctype from pg_database where datname = current_database()');
    expect(typeof s!.datctype).toBe('string');
    expect(['C', 'POSIX']).not.toContain(s!.datctype);
    await admin.pool.query('create extension if not exists pg_trgm');
    const [t] = await rows(admin, "select show_trgm('루멘') as g");
    const grams = t!.g as string[];
    // 빈 배열이면 실패(한글을 단어 글자로 보지 않는 설정). 여러 바이트 글자의 조각은 해시 값(0x…)으로 보인다
    expect(grams.length).toBeGreaterThanOrEqual(1);
  });

  test('SR-T7 lc_ctype이 C인 DB에서는 새 마이그레이션이 멈추고 검색 표가 생기지 않는다', async () => {
    const c = await startPostgres({ env: { POSTGRES_INITDB_ARGS: '--locale=C --encoding=UTF8' } });
    const d = createDatabase({ url: c.url, applicationName: 'core-svc-c-locale', max: 1 });
    try {
      // 대조: 정말 C 로케일로 떴다
      expect((await rows(d, 'select datctype from pg_database where datname = current_database()'))[0]!.datctype).toBe('C');
      await expect(migrateCore(c.url)).rejects.toThrow(/lc_ctype/);
      const kinds = await rows(d, "select relname, relkind from pg_class where relname in ('search_document', 'search_document_source')");
      expect(kinds.filter((k) => k.relkind === 'r' || k.relname === 'search_document_source')).toEqual([]);
      expect(await rows(d, "select 1 from pg_proc where proname = 'search_document_source_at'")).toEqual([]);
    } finally {
      await d.close();
      c.stop();
    }
  });
});

describe('SR-T8 읽기 모델에 들어가는 공연', () => {
  test('SR-T8 ① 승인 전·반려·판매 중지·회차 전부 취소 공연은 읽기 모델과 검색 API 어디에도 없다 [ASVS v5.0.0-8.1.1]', async () => {
    const control = await seed({ title: '검증공개 대조 공연' });
    const hidden = {
      draft: await seed({ title: '검증공개 초안 공연', saleReview: 'DRAFT' }),
      submitted: await seed({ title: '검증공개 심사중 공연', saleReview: 'SUBMITTED' }),
      rejected: await seed({ title: '검증공개 반려 공연', saleReview: 'REJECTED' }),
      suspended: await seed({ title: '검증공개 중지 공연', saleReview: 'SUSPENDED' }),
      cancelled: await seed({ title: '검증공개 취소 공연', events: [{ cancelled: true }, { cancelled: true }] }),
    };
    const all = [control, ...Object.values(hidden)].map((x) => x.productionId);
    await admin.transaction((tx) => sync.sync(tx, all, new Date(now)));
    // 대조군이 먼저 보인다(읽기 모델이 비어 있어 통과하지 않게)
    expect(await docIds()).toContain(control.productionId);
    expect(await termCount(control.productionId)).toBeGreaterThanOrEqual(1);
    expect(await apiIds('검증공개 대조 공연')).toEqual([control.productionId]);
    const docs = await docIds();
    const api = await apiIds('검증공개');
    expect(api).toEqual([control.productionId]);
    for (const [name, h] of Object.entries(hidden)) {
      expect({ name, inDocs: docs.includes(h.productionId), terms: await termCount(h.productionId), inApi: api.includes(h.productionId) }).toEqual({ name, inDocs: false, terms: 0, inApi: false });
    }
  });

  test('SR-T8 ② 판매 중지를 적는 트랜잭션이 동기화를 부르면 커밋과 함께 빠지고 되돌리면 남으며 재개하면 다시 나온다', async () => {
    const p = await seed({ title: '중지시험 공연', artistName: '중지시험 배우', alias: 'STOP TEST' });
    const q = await seed({ title: '되돌림시험 공연', alias: 'ROLLBACK TEST' });
    await admin.transaction((tx) => sync.sync(tx, [p.productionId, q.productionId], new Date(now)));
    const terms = await rows(admin, "select id from search_term where target_id = $1 and kind = 'PRODUCTION' order by id", [p.productionId]);
    expect(terms.length).toBe(2);
    const v0 = await version();

    // 판매 중지: 커밋 전에는 다른 연결에 그대로 보이고, 커밋과 함께 빠진다
    const out = await admin.transaction(async (tx) => {
      await tx.update(production).set({ saleReview: 'SUSPENDED' }).where(eq(production.id, p.productionId));
      const r = await sync.sync(tx, [p.productionId], new Date(now));
      expect(await docIds(other)).toContain(p.productionId);
      return r;
    });
    expect(out).toEqual({ version: v0 + 1, removed: [p.productionId] });
    expect(await version()).toBe(v0 + 1);
    expect(await docIds()).not.toContain(p.productionId);
    expect(await rows(admin, "select 1 from search_term where target_id = $1 and kind = 'PRODUCTION'", [p.productionId])).toEqual([]);
    const marks = await rows(admin, 'select kind, target_id from search_removal where version = $1 order by kind, target_id', [v0 + 1]);
    expect(marks).toEqual([{ kind: 'DOCUMENT', target_id: p.productionId }, ...terms.map((t) => ({ kind: 'TERM', target_id: t.id }))].sort((a, b) => (a.kind + a.target_id < b.kind + b.target_id ? -1 : 1)));

    // 되돌리면 표·판·지운 표시가 그대로다
    const marksBefore = Number((await rows(admin, 'select count(*)::int as n from search_removal'))[0]!.n);
    await expect(
      admin.transaction(async (tx) => {
        await tx.update(production).set({ saleReview: 'SUSPENDED' }).where(eq(production.id, q.productionId));
        await sync.sync(tx, [q.productionId], new Date(now));
        throw new Error('되돌린다');
      }),
    ).rejects.toThrow('되돌린다');
    expect(await version()).toBe(v0 + 1);
    expect(await docIds()).toContain(q.productionId);
    expect(await termCount(q.productionId)).toBe(2);
    expect(Number((await rows(admin, 'select count(*)::int as n from search_removal'))[0]!.n)).toBe(marksBefore);

    // 판매 재개: 다시 나온다(공연 줄과 이름 줄 둘)
    const back = await admin.transaction(async (tx) => {
      await tx.update(production).set({ saleReview: 'APPROVED' }).where(eq(production.id, p.productionId));
      return sync.sync(tx, [p.productionId], new Date(now));
    });
    expect(back).toEqual({ version: v0 + 2, removed: [] });
    expect(await docIds()).toContain(p.productionId);
    expect((await rows(admin, "select count(*)::int as n from search_term where target_id = $1 and kind = 'PRODUCTION'", [p.productionId]))[0]!.n).toBe(2);
    expect(await drift(now)).toBe(0);
  });
});

describe('검색 질의(PostgreSQL)', () => {
  test('SR-T13 ① 검색 전용 연결 묶음(크기 2·대기 250ms로 주입)이 다 차면 SearchUnavailable(pool-timeout)을 던지고 대기 시간을 지킨다 [ASVS v5.0.0-2.4.1]', async () => {
    const searchDb = createDatabase({ url: pg.url, applicationName: 'core-svc-search-pool', max: 2, connectionTimeoutMillis: 250 });
    const index = new DrizzleSearchIndex(searchDb, 'https://img.test');
    const held = [await searchDb.pool.connect(), await searchDb.pool.connect()];
    try {
      const started = performance.now();
      const err = await index.search(query('루멘')).then(
        () => undefined,
        (e: unknown) => e,
      );
      const waited = performance.now() - started;
      expect(err).toBeInstanceOf(SearchUnavailable);
      expect((err as SearchUnavailable).reason).toBe('pool-timeout');
      // 주입한 대기(250ms)를 썼다(정본 기본값 100ms를 굳혀 쓰면 걸린다)
      expect(waited).toBeGreaterThanOrEqual(200);
    } finally {
      for (const c of held) c.release();
    }
    // 묶음이 풀리면 다시 답한다
    await expect(index.search(query('루멘'))).resolves.toMatchObject({ page: 1 });
    await searchDb.close();
  });

  test('HOT-280 검색 한 번은 후보 공연만 읽고 이름 색인을 요청마다 다시 만들지 않는다(COV2-07)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 300; i++) ids.push((await seed({ title: `후보시험 일반 ${i}` })).productionId);
    const aurora = [await seed({ title: '오로라후보 콘서트' }), await seed({ title: '오로라후보 뮤지컬' }), await seed({ title: '오로라후보 투어' })].map((x) => x.productionId);
    await admin.transaction((tx) => sync.sync(tx, [...ids, ...aurora], new Date(now)));
    const searchDb = createDatabase({ url: pg.url, applicationName: 'core-svc-search-count', max: 2 });
    // 이 연결 묶음이 돌려준 search_document 줄 수를 센다(질의 글에 search_document가 든 것)
    let docRows = 0;
    const count = (text: unknown, res: { rows?: unknown[] }) => {
      const t = typeof text === 'string' ? text : String((text as { text?: string })?.text ?? '');
      if (/search_document\b/.test(t)) docRows += res.rows?.length ?? 0;
    };
    const poolQuery = searchDb.pool.query.bind(searchDb.pool) as (...a: unknown[]) => Promise<{ rows?: unknown[] }>;
    (searchDb.pool as unknown as { query: unknown }).query = async (...a: unknown[]) => {
      const r = await poolQuery(...a);
      count(a[0], r);
      return r;
    };
    searchDb.pool.on('connect', (client) => {
      const q = client.query.bind(client) as (...a: unknown[]) => Promise<{ rows?: unknown[] }>;
      (client as unknown as { query: unknown }).query = async (...a: unknown[]) => {
        const r = await q(...a);
        count(a[0], r);
        return r;
      };
    });
    try {
      const index = new DrizzleSearchIndex(searchDb, 'https://img.test');
      // 첫 검색부터 센다(데우는 요청을 빼지 않는다, R165-2)
      const out = await index.search(query('오로라후보'));
      expect(out.items.map((x) => x.productionId).sort()).toEqual([...aurora].sort());
      // 공연 303개 가운데 후보 3개: 읽은 공연 줄은 3개 이하(전체를 읽지 않는다). 0이면 세는 자리가 틀렸다
      expect(docRows).toBeGreaterThanOrEqual(1);
      expect(docRows).toBeLessThanOrEqual(3);
    } finally {
      await searchDb.close();
    }
  });
});

/** 판은 새 연결에서, 줄·지운 표시는 미리 열어 둔 옛 스냅숏에서 읽는 틀린 원천(복제본 지연 흉내, 대조군) */
function splitSource(old: { query: (t: string, v?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }): SearchDictionarySource {
  const doc = (r: Record<string, unknown>) => ({ productionId: r.production_id as string, title: r.title as string, aliases: [], genre: '콘서트' as const, artists: [], saleStatus: r.sale_status as 'ON_SALE', popularity: 0 });
  const term = (r: Record<string, unknown>) => ({
    id: r.id as string,
    kind: r.kind as 'PRODUCTION',
    targetId: r.target_id as string,
    displayName: r.display_name as string,
    aliasOf: (r.alias_of as string | null) ?? null,
    norm: r.norm as string,
    normNospace: r.norm_nospace as string,
    jamo: r.jamo as string,
    chosung: r.chosung as string,
    updatedVersion: Number(r.updated_version),
  });
  return {
    version: async () => version(),
    async read(since): Promise<DictionarySnapshot> {
      const v = await version();
      const s = since ?? -1;
      const docs = (await old.query('select production_id, title, sale_status from search_document where updated_version > $1', [s])).rows.map(doc);
      const terms = (await old.query('select * from search_term where updated_version > $1', [s])).rows.map(term);
      const removals = (await old.query('select version, kind, target_id from search_removal where version > $1', [s])).rows.map((r) => ({ version: Number(r.version), kind: r.kind as 'DOCUMENT', targetId: r.target_id as string }));
      return { version: v, full: since === null, documents: docs, terms, removals };
    },
  };
}

describe('SR-T15 ② 판과 줄을 한 스냅숏에서', () => {
  test('SR-T15 ② 판과 줄을 다른 연결로 읽는 틀린 갱신은 빠짐이 생기고 한 트랜잭션 갱신은 빠짐이 없다', async () => {
    const base = await seed({ title: '스냅숏시험 처음' });
    await admin.transaction((tx) => sync.sync(tx, [base.productionId], new Date(now)));
    const c = { now: Date.parse('2026-11-16T00:00:00.000Z'), advance(ms: number) { this.now += ms; } };
    const fake: Clock = { now: () => c.now, monotonicMs: () => c.now };

    // 두 사전이 같은 지금 판에서 출발한다
    const right = new SuggestionDictionary(new DrizzleSearchReadModel(admin), fake);
    await right.refresh();
    const oldClient = await other.pool.connect();
    try {
      await oldClient.query('begin isolation level repeatable read read only');
      // 이 스냅숏이 '늦은 복제본'이다: 아래 쓰기를 보지 못한다
      await oldClient.query('select 1 from search_version');
      const wrong = new SuggestionDictionary(splitSource(oldClient), fake);
      await wrong.refresh();

      // 새 공연이 판을 올린다
      const late = await seed({ title: '스냅숏시험 늦은공연' });
      await admin.transaction((tx) => sync.sync(tx, [late.productionId], new Date(now)));
      c.advance(10_000);
      await wrong.refresh();
      await right.refresh();
      c.advance(10_000);
      await wrong.refresh();
      await right.refresh();

      const inDb = await termCount(late.productionId);
      expect(inDb).toBeGreaterThanOrEqual(1);
      const has = (d: SuggestionDictionary) => d.suggest('스냅숏시험 늦은').items.some((x) => x.productionId === late.productionId);
      // 대조군: 판은 새것인데 줄은 옛것이라 빠진 줄이 실제로 생겼다(다음 갱신도 그 판 뒤만 읽어 영영 못 채운다)
      expect(wrong.version).toBe(await version());
      expect(has(wrong)).toBe(false);
      // 한 트랜잭션에서 판을 먼저 읽는 원천은 빠짐이 없다: 같은 판, 공연이 보이고, 이름 항목 수가 search_term 줄 수와 같다
      expect(right.version).toBe(await version());
      expect(has(right)).toBe(true);
      expect(right.entries).toBe(Number((await rows(admin, 'select count(*)::int as n from search_term'))[0]!.n));
    } finally {
      await oldClient.query('rollback').catch(() => {});
      oldClient.release();
    }
  });
});

describe('HOT-270 동기화 부르는 자리', () => {
  test('HOT-270 지금 있는 카탈로그 쓰기를 차례로 한 뒤 search_document가 원천과 어긋난 줄이 0이다', async () => {
    const productionId = randomUUID();
    const eventId = randomUUID();
    const addedEventId = randomUUID();
    const v0 = await version();
    // 등록(승인 대기)
    await admin.db.insert(production).values({ id: productionId, promoterId: A, placeId: PLACE, title: '부르는자리 콘서트', genre: '콘서트', saleReview: 'SUBMITTED', salePolicy: [general], salePolicyVersion: 1 });
    await admin.db.insert(event).values({ id: eventId, productionId, promoterId: A, openAt: new Date('2026-11-20T11:00:00.000Z'), startsAt: new Date('2026-12-24T10:00:00.000Z'), endsAt: new Date('2026-12-24T12:30:00.000Z'), version: 1 });
    expect(await docIds()).not.toContain(productionId);
    expect(await drift(now)).toBe(0);

    const approve = (scales: { eventId: string; scale: string }[]) =>
      svc.http.inject({ method: 'POST', url: `/v1/ops/sale-reviews/${productionId}/approvals`, headers: { ...identity.ops('operator'), 'content-type': 'application/json' }, payload: JSON.stringify({ scales, placeId: PLACE, accessibleSeatingCheck: true }) });

    // 승인: 같은 트랜잭션에서 읽기 모델에 들어간다
    expect((await approve([{ eventId, scale: 'SMALL' }])).statusCode).toBe(200);
    expect(await docIds()).toContain(productionId);
    expect(await version()).toBe(v0 + 1);
    expect(await drift(now)).toBe(0);

    // 회차 추가 → 재승인
    await admin.db
      .update(production)
      .set({
        saleReview: 'SUBMITTED',
        pendingRevision: {
          addedEvents: [
            { eventId: addedEventId, openAt: '2026-11-18T11:00:00.000Z', startsAt: '2026-12-20T10:00:00.000Z', endsAt: '2026-12-20T12:30:00.000Z', entryOpensAt: null, lobbyMinutes: 10, lobbyShuffle: true, openBatch: true, seatAssignment: 'PICK', perPersonLimit: 4, reentryAllowed: false, addedAt: '2026-11-15T00:00:00.000Z', venueId: null },
          ],
        },
      })
      .where(eq(production.id, productionId));
    expect((await approve([{ eventId, scale: 'SMALL' }, { eventId: addedEventId, scale: 'SMALL' }])).statusCode).toBe(200);
    expect((await rows(admin, 'select next_open_event_id from search_document where production_id = $1', [productionId]))[0]!.next_open_event_id).toBe(addedEventId);
    expect(await drift(now)).toBe(0);

    // 포스터 게시·지우기(파트너 트랜잭션)
    const media = svc.app.get<PartnerProductionMedia>(PARTNER_PRODUCTION_MEDIA);
    const imageId = randomUUID();
    const t = new Date(now);
    await media.withLockedProduction(productionId, A, (tx) => tx.insert({ id: imageId, productionId, promoterId: A, kind: 'POSTER', alt: '포스터', order: 0, width: 1000, height: 1400, version: 1, createdAt: t, updatedAt: t }));
    expect((await rows(admin, 'select poster_image_id from search_document where production_id = $1', [productionId]))[0]!.poster_image_id).toBe(imageId);
    expect(await drift(now)).toBe(0);
    await media.withLockedProduction(productionId, A, (tx) => tx.remove(imageId));
    expect((await rows(admin, 'select poster_image_id from search_document where production_id = $1', [productionId]))[0]!.poster_image_id).toBeNull();
    expect(await drift(now)).toBe(0);

    // 찜: 판을 올리지 않는다(관심도는 1시간 정리가 센다)
    const vBeforeWish = await version();
    await admin.db.insert(wish).values({ accountId: randomUUID(), productionId, createdAt: new Date(now) });
    expect(await version()).toBe(vBeforeWish);
    expect(await drift(now)).toBe(1);

    // 1분 정리: 추가 회차의 오픈 시각이 지나면 판매 상태가 바뀐다(대조: 정리 전에는 어긋남이 있다)
    const since = new Date(now);
    now = Date.parse('2026-11-18T11:01:00.000Z');
    expect(await drift(now)).toBeGreaterThanOrEqual(1);
    const timed = await sync.syncTimed(new Date(now), since);
    expect(timed.productions).toBeGreaterThanOrEqual(1);
    expect((await rows(admin, 'select sale_status from search_document where production_id = $1', [productionId]))[0]!.sale_status).toBe('ON_SALE');

    // 1시간 관심도
    expect(await sync.recountInterest(new Date(now))).toBeGreaterThanOrEqual(1);
    expect(Number((await rows(admin, 'select interest from search_document where production_id = $1', [productionId]))[0]!.interest)).toBe(1);
    expect(await drift(now)).toBe(0);

    // 원천에 이 공연이 실제로 있다(원천이 비어 어긋남 0으로 새지 않게)
    expect(await rows(admin, 'select 1 from search_document_source_at($1) where production_id = $2', [new Date(now), productionId])).toHaveLength(1);
  });
});

// ---- 리뷰 지적 재현(계획 docs/review/plans/BAT-165.md '### 13', ADR-0271 결정 12~14). T-25가 바꾼 시계 뒤에 돌도록 파일 끝에 둔다 ----

/** 이 연결 묶음이 돌려준 search_document 줄 수를 센다(질의 글에 search_document가 든 것, T-19와 같은 장치) */
function countingDatabase(url: string, name: string, o: { max?: number } = {}) {
  const d = createDatabase({ url, applicationName: name, max: o.max ?? 4 });
  const seen = { rows: 0 };
  const count = (text: unknown, res: { rows?: unknown[] }) => {
    const t = typeof text === 'string' ? text : String((text as { text?: string })?.text ?? '');
    if (/search_document\b/.test(t) && !/search_document_source/.test(t)) seen.rows += res.rows?.length ?? 0;
  };
  const poolQuery = d.pool.query.bind(d.pool) as (...a: unknown[]) => Promise<{ rows?: unknown[] }>;
  (d.pool as unknown as { query: unknown }).query = async (...a: unknown[]) => {
    const r = await poolQuery(...a);
    count(a[0], r);
    return r;
  };
  d.pool.on('connect', (client) => {
    const q = client.query.bind(client) as (...a: unknown[]) => Promise<{ rows?: unknown[] }>;
    (client as unknown as { query: unknown }).query = async (...a: unknown[]) => {
      const r = await q(...a);
      count(a[0], r);
      return r;
    };
  });
  return { db: d, seen };
}

/** 어느 DB든 원천과 표의 어긋난 공연 수 */
const driftOn = async (d: Database, at: number) =>
  Number(
    (
      await rows(
        d,
        `select count(distinct production_id)::int as n from ((select ${COLS} from search_document_source_at($1) except select ${COLS} from search_document)
         union all (select ${COLS} from search_document except select ${COLS} from search_document_source_at($1))) d`,
        [new Date(at)],
      )
    )[0]!.n,
  );

/** 시계 하나(앞으로만 간다) */
const movingClock = (start: number) => {
  const c = { t: start };
  const clock: Clock & { set(t: number): void } = { now: () => c.t, monotonicMs: () => c.t, set: (t: number) => void (c.t = t) };
  return clock;
};

describe('R165-1 서버가 뜰 때 따라잡기', () => {
  test('HOT-270 표 마이그레이션 전부터 승인돼 있던 공연은 서버가 뜰 때의 따라잡기 한 번으로 검색·자동완성에 나오고 어긋난 줄이 0이다(R165-1)', async () => {
    const c = await startPostgres();
    const d = createDatabase({ url: c.url, applicationName: 'core-svc-search-backfill', max: 4 });
    const tmp = mkdtempSync(join(tmpdir(), 'bat165-migrations-'));
    try {
      // 검색 표 마이그레이션 바로 앞까지만 올린다(저널을 그 앞에서 자른 사본)
      const src = fileURLToPath(new URL('../migrations/', import.meta.url));
      cpSync(src, tmp, { recursive: true });
      const journal = JSON.parse(readFileSync(join(tmp, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
      const cut = journal.entries.findIndex((e) => e.tag.endsWith('_search_read_model_tables'));
      expect(cut).toBeGreaterThan(0);
      journal.entries = journal.entries.slice(0, cut);
      writeFileSync(join(tmp, 'meta/_journal.json'), JSON.stringify(journal));
      const client = new pgLib.Client({ connectionString: c.url });
      await client.connect();
      try {
        await drizzleMigrate(drizzleNodePg({ client }), { migrationsFolder: tmp });
      } finally {
        await client.end();
      }
      const at = Date.parse('2026-11-16T00:00:00.000Z');
      const promoterId = randomUUID();
      const placeId = randomUUID();
      await d.db.insert(promoter).values({ id: promoterId, legalName: '(주)옛공연' });
      await d.db.insert(place).values({ id: placeId, name: '옛날홀', address: '서울', region: '서울', createdBy: ACTOR });
      const made: string[] = [];
      for (const [title, review, artistName, alias] of [
        ['옛승인 첫공연', 'APPROVED', '옛승인 배우', 'OLD FIRST'],
        ['옛승인 둘째공연', 'APPROVED', '옛승인 가수', 'OLD SECOND'],
        ['옛승인 초안공연', 'DRAFT', null, null],
      ] as const) {
        const id = randomUUID();
        made.push(id);
        await d.db.insert(production).values({ id, promoterId, placeId, title, genre: '콘서트', saleReview: review, saleApprovedAt: review === 'APPROVED' ? new Date(at - 10 * D) : null });
        await d.db.insert(event).values({ id: randomUUID(), productionId: id, promoterId, venueId: null, openAt: new Date(at - D), startsAt: new Date(at + 20 * D), endsAt: new Date(at + 20 * D + 2 * H) });
        if (artistName) {
          const artistId = randomUUID();
          await d.db.insert(artist).values({ id: artistId, name: artistName, createdBy: ACTOR });
          await d.db.insert(productionArtist).values({ productionId: id, artistId, sortOrder: 0 });
        }
        if (alias) await d.db.insert(searchAlias).values({ id: randomUUID(), targetKind: 'PRODUCTION', targetId: id, alias, source: 'PARTNER', createdBy: ACTOR });
      }
      // 이제 검색 표 마이그레이션을 올린다(빈 표만 만든다)
      await migrateCore(c.url);
      const index = new DrizzleSearchIndex(d, 'https://img.test');
      const q = (text: string): SearchQuery => ({ q: text, includePast: false, noConvert: false, page: 1, now: new Date(at) });
      // 대조군: 띄우기 전에는 검색에 없다
      expect((await index.search(q('옛승인'))).items).toEqual([]);

      const clock2 = movingClock(at);
      const model = new DrizzleSearchReadModel(d, 'https://img.test');
      const dictionary = new SuggestionDictionary(model, clock2);
      const t = new SearchReadModelTimers({ sync: model, dictionary, clock: clock2 });
      try {
        await t.start();
      } finally {
        t.stop();
      }
      await dictionary.refresh();
      const [first, second, draft] = made as [string, string, string];
      expect((await index.search(q('옛승인'))).items.map((x) => x.productionId).sort()).toEqual([first, second].sort());
      expect(dictionary.suggest('옛승인').items.filter((x) => x.kind === 'PRODUCTION').map((x) => x.productionId).sort()).toEqual([first, second].sort());
      expect(await rows(d, 'select 1 from search_term where target_id = $1', [draft])).toEqual([]);
      const terms = await rows(d, 'select display_name, norm, norm_nospace, jamo, chosung from search_term where target_id = any($1::uuid[])', [[first, second]]);
      expect(terms.map((x) => x.display_name).sort()).toEqual(['OLD FIRST', 'OLD SECOND', '옛승인 둘째공연', '옛승인 첫공연'].sort());
      for (const x of terms) {
        const k = nameKeys(x.display_name as string);
        expect([x.norm, x.norm_nospace, x.jamo, x.chosung]).toEqual([k.norm, k.nospace, k.jamo, k.chosung]);
      }
      expect(await driftOn(d, at)).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      await d.close();
      c.stop();
    }
  });
});

describe('R165-2 검색이 쪽 크기만큼만 읽는다', () => {
  test('HOT-280 판이 바뀐 뒤의 검색도 후보 공연만 읽는다(COV2-07, R165-2)', async () => {
    const ids = [await seed({ title: '은하후보 콘서트' }), await seed({ title: '은하후보 뮤지컬' }), await seed({ title: '은하후보 투어' })].map((x) => x.productionId);
    await admin.transaction((tx) => sync.sync(tx, ids, new Date(now)));
    const counted = countingDatabase(pg.url, 'core-svc-search-count-2');
    try {
      const index = new DrizzleSearchIndex(counted.db, 'https://img.test');
      await index.search(query('은하후보'));
      // 다른 공연 하나를 동기화해 판을 올린다
      const other = await seed({ title: '판올림 공연' });
      await admin.transaction((tx) => sync.sync(tx, [other.productionId], new Date(now)));
      counted.seen.rows = 0;
      const out = await index.search(query('은하후보'));
      expect(out.items.map((x) => x.productionId).sort()).toEqual([...ids].sort());
      expect(counted.seen.rows).toBeGreaterThanOrEqual(1);
      expect(counted.seen.rows).toBeLessThanOrEqual(3);
      // 같은 검색 5개를 함께 보내도 읽은 줄 합은 15 이하
      counted.seen.rows = 0;
      const many = await Promise.all(Array.from({ length: 5 }, () => index.search(query('은하후보'))));
      expect(many.every((m) => m.items.length === 3)).toBe(true);
      expect(counted.seen.rows).toBeGreaterThanOrEqual(5);
      expect(counted.seen.rows).toBeLessThanOrEqual(15);
    } finally {
      await counted.db.close();
    }
  });

  test('HOT-280 검색어 없는 목록·관련 공연·0건 제안은 쪽 크기만큼만 읽는다(R165-2)', async () => {
    // 따로 띄운 DB에 같은 고정 카탈로그(공연 300개)를 메모리 저장소와 함께 채운다
    const g = catalog300();
    const c = await startPostgres();
    await migrateCore(c.url);
    const fill = createDatabase({ url: c.url, applicationName: 'core-svc-search-300', max: 4 });
    const counted = countingDatabase(c.url, 'core-svc-search-300-count');
    try {
      const all = await fillDatabase(fill, g);
      const model = new DrizzleSearchReadModel(fill, 'https://img.test');
      await fill.transaction((tx) => model.sync(tx, all, new Date(Date.parse(g.now))));
      const repo = new MemoryCatalogRepository();
      fillMemory(repo, g);
      const memory = new MemorySearchIndex(repo, 'https://img.test', fakeClock({ now: Date.parse(g.now) }));
      const pgIndex = new DrizzleSearchIndex(counted.db, 'https://img.test');
      const q = (text: string, o: Partial<SearchQuery> = {}): SearchQuery => ({ q: text, includePast: false, noConvert: false, page: 1, now: new Date(Date.parse(g.now)), ...o });
      const same = async (name: string, sq: SearchQuery, maxRows: number) => {
        counted.seen.rows = 0;
        const a = await pgIndex.search(sq);
        const read = counted.seen.rows;
        const b = await memory.search(sq);
        expect({ name, ids: a.items.map((x) => x.productionId), related: a.related?.items.map((x) => x.productionId) ?? null, total: a.total }).toEqual({
          name,
          ids: b.items.map((x) => x.productionId),
          related: b.related?.items.map((x) => x.productionId) ?? null,
          total: b.total,
        });
        expect({ name, readOk: read <= maxRows, read }).toEqual({ name, readOk: true, read });
        return a;
      };
      // 검색어 없는 오픈 임박 1쪽: 20개 + 다음 쪽이 있는지 1줄
      const list = await same('오픈 임박 1쪽', q(''), 21);
      expect(list.items).toHaveLength(20);
      await same('인기 1쪽', q('', { sort: 'POPULAR' }), 21);
      // 이름이 같은 공연 둘과 한글·영문 이름이 섞인 후보: 이름 차례가 메모리와 같다. 후보 7 + 공연장 근거 관련 6
      const mixed = await same('이름 섞임', q('혼합'), 7 + 6);
      expect(mixed.items).toHaveLength(7);
      // 아티스트가 맞은 검색: 후보 3 + 아티스트 근거 관련 6
      await same('아티스트 근거', q('오로라 밴드'), 3 + 6);
      // 0건: 제안은 사전에서 오고 읽은 줄은 관련 공연 몫(6)뿐
      const zero = await same('0건', q('없는검색어하나'), 6);
      expect(zero.items).toEqual([]);
    } finally {
      await counted.db.close();
      await fill.close();
      c.stop();
    }
  });
});

describe('R165-3 자동완성은 원천을 부르지 않는다', () => {
  test('자동완성은 검색 전용 연결 묶음이 다 찬 동안에도 원천을 부르지 않고 답한다(R165-3)', async () => {
    const catalog = svc.app.get(SearchCatalog);
    await catalog.dictionary.refresh();
    const source = svc.app.get<SearchDictionarySource>(SEARCH_DICTIONARY_SOURCE);
    const read = source.read.bind(source);
    const version = source.version.bind(source);
    let calls = 0;
    source.read = async (since) => {
      calls += 1;
      return read(since);
    };
    source.version = async () => {
      calls += 1;
      return version();
    };
    // 서비스의 검색 연결(core_app 로그인, 4개)을 모두 잡는다(T-07의 묶음 포화와 같은 장치)
    const held = await Promise.all(Array.from({ length: 4 }, () => appDb.pool.connect()));
    try {
      now += 10_001;
      const r = await svc.http.inject({ method: 'GET', url: '/v1/search/suggestions?q=' + encodeURIComponent('부르는자리') });
      expect(r.statusCode).toBe(200);
      expect(calls).toBe(0);
    } finally {
      for (const h of held) h.release();
      source.read = read;
      source.version = version;
    }
  });
});

describe('R165-1 내려가 있던 동안의 시각 경계와 동시 시작', () => {
  test('HOT-270 모든 파드가 내려가 있던 동안 오픈 시각이 지난 공연은 다시 뜰 때 판매 중으로 바뀐다(R165-1)', async () => {
    const B = Date.parse('2026-11-25T00:00:00.000Z');
    const opens = randomUUID();
    const ends = randomUUID();
    for (const [id, title, open, start] of [
      [opens, '내려간동안 오픈공연', B + H, B + 10 * D],
      [ends, '내려간동안 종료공연', B - 5 * D, B + D + H],
    ] as const) {
      await admin.db.insert(production).values({ id, promoterId: A, placeId: PLACE, title, genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date(B - 10 * D) });
      await admin.db.insert(event).values({ id: randomUUID(), productionId: id, promoterId: A, venueId: null, openAt: new Date(open), startsAt: new Date(start), endsAt: new Date(start + 2 * H) });
    }
    await admin.transaction((tx) => sync.sync(tx, [opens, ends], new Date(B)));
    const status = async (id: string) => (await rows(admin, 'select sale_status from search_document where production_id = $1', [id]))[0]!.sale_status;
    expect([await status(opens), await status(ends)]).toEqual(['UPCOMING', 'ON_SALE']);

    const clock2 = movingClock(B);
    const first = new SearchReadModelTimers({ sync, clock: clock2 });
    await first.start();
    first.stop();
    // 모든 파드가 2시간 내려가 있다가 다시 뜬다(그동안 정리가 한 번도 돌지 않았다)
    const v0 = await version();
    clock2.set(B + 2 * H);
    const second = new SearchReadModelTimers({ sync, clock: clock2 });
    try {
      await second.start();
    } finally {
      second.stop();
    }
    // 첫 정리 전에 이미 바뀌었다
    expect([await status(opens), await status(ends)]).toEqual(['ON_SALE', 'ENDED']);
    expect(await version()).toBeGreaterThanOrEqual(v0 + 1);
  });

  test('HOT-270 두 파드가 함께 떠도 시작 따라잡기는 한 번만 돈다(R165-1)', async () => {
    const d1 = createDatabase({ url: pg.url, applicationName: 'core-svc-reconcile-1', max: 2 });
    const d2 = createDatabase({ url: pg.url, applicationName: 'core-svc-reconcile-2', max: 2 });
    // 장벽: 두 쪽이 권고 잠금을 잡으려는 질의 앞에서 서로를 기다린다(3초 뒤에는 그냥 간다)
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const timer = setTimeout(() => open(), 3_000);
    for (const d of [d1, d2]) {
      d.pool.on('connect', (client) => {
        const q = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = async (...a: unknown[]) => {
          const t = typeof a[0] === 'string' ? a[0] : String((a[0] as { text?: string })?.text ?? '');
          if (/advisory/i.test(t)) {
            arrived += 1;
            if (arrived >= 2) open();
            await gate;
          }
          return q(...a);
        };
      });
    }
    try {
      const v0 = await version();
      const at = new Date(Date.parse('2026-11-25T03:00:00.000Z'));
      // 바뀐 끊음 수(R165-14: 원천과 표가 같은 끊음은 판을 올리지 않는다): 공연 ID 차례로 500개씩 끊었을 때 어긋난 공연이 든 끊음 수
      const changedChunks = await changedChunkCount(admin, at.getTime(), 500);
      const out = await Promise.all([new DrizzleSearchReadModel(d1, 'https://img.test').reconcileAll(at), new DrizzleSearchReadModel(d2, 'https://img.test').reconcileAll(at)]);
      expect(arrived).toBeGreaterThanOrEqual(2);
      expect(out.map((o) => o.ran).sort()).toEqual([false, true]);
      const ran = out.find((o) => o.ran)!;
      expect(ran.productions).toBeGreaterThanOrEqual(300);
      // 판은 바뀐 끊음 수만큼만 올랐다(500개 [가정]씩, ADR-0271 결정 12. 첫 채우기면 끊음 수와 같다)
      expect((await version()) - v0).toBe(changedChunks);
      expect(ran.chunks).toBe(Math.ceil(ran.productions / 500));
      expect(out.find((o) => !o.ran)).toMatchObject({ ran: false, productions: 0, version: null });
    } finally {
      clearTimeout(timer);
      await d1.close();
      await d2.close();
    }
  });
});

/** 공연 300개 고정 카탈로그(R165-2): 이름 섞인 후보 7(같은 이름 둘, 한글·영문), 아티스트 근거 3, 나머지 290 */
function catalog300(): Golden {
  const uid = (p: string, n: number) => `${p}-0000-4000-8000-a${String(n).padStart(11, '0')}`;
  const places = [1, 2, 3].map((n) => ({ id: uid('21000000', n), name: `시험홀 ${n}` }));
  const artists = [{ id: uid('11000000', 1), name: '오로라 밴드' }];
  const ev = (n: number, state: 'ON_SALE' | 'UPCOMING') =>
    state === 'ON_SALE' ? [{ id: uid('31000000', n), openMin: -10 * 1440 - n, startMin: 20 * 1440 + n, endMin: 20 * 1440 + n + 120 }] : [{ id: uid('31000000', n), openMin: 2 * 1440 + (n % 37) * 30, startMin: 40 * 1440 + n, endMin: 40 * 1440 + n + 120 }];
  const productions: Golden['productions'] = [];
  const mixed = ['혼합 Alpha', '혼합 beta', '혼합 가나', '혼합 Zeta', '혼합 하늘', '혼합 같은이름', '혼합 같은이름'];
  mixed.forEach((title, i) => productions.push({ id: uid('01000000', i + 1), title, genre: '콘서트', placeId: places[0]!.id, artistIds: [], aliases: [], state: 'ON_SALE', wishes: 0, events: ev(i + 1, 'ON_SALE') }));
  for (let i = 0; i < 3; i++) productions.push({ id: uid('01000000', 100 + i), title: `오로라 밴드 투어 ${i + 1}`, genre: '콘서트', placeId: places[1]!.id, artistIds: [artists[0]!.id], aliases: [], state: 'UPCOMING', wishes: i, events: ev(100 + i, 'UPCOMING') });
  for (let i = 0; i < 290; i++) {
    const state = i % 3 === 0 ? 'ON_SALE' : 'UPCOMING';
    productions.push({ id: uid('01000000', 1000 + i), title: `일반 공연 ${i}`, genre: '콘서트', placeId: places[(i % 2) + 1]!.id, artistIds: [], aliases: [], state, wishes: i % 17, events: ev(1000 + i, state) });
  }
  return { now: '2026-11-16T00:00:00.000Z', places, artists, productions, cases: [] };
}

// ---- 다시 보기 지적 R165-14(계획 docs/review/plans/BAT-165.md '### 14', ADR-0271 결정 12 보탬, docs/data.md search_version.reconciled_at) ----

/** 공연 ID 차례로 size개씩 끊었을 때, 원천(at)과 표가 어긋난 공연이 든 끊음 수 */
async function changedChunkCount(d: Database, at: number, size: number): Promise<number> {
  const r = await rows(
    d,
    `with ids as (select production_id from search_document_source_at($1) union select production_id from search_document),
          ranked as (select production_id, (row_number() over (order by production_id) - 1) / $2 as chunk from ids),
          diff as ((select ${COLS} from search_document_source_at($1) except select ${COLS} from search_document)
                   union all (select ${COLS} from search_document except select ${COLS} from search_document_source_at($1)))
     select count(distinct r.chunk)::int as n from ranked r join diff on diff.production_id = r.production_id`,
    [new Date(at), size],
  );
  return Number(r[0]!.n);
}

/**
 * 따라잡기 연결 묶음: n번째 커밋이 끝난 뒤의 다음 질의를 장벽에서 세운다. release()로 푼다(10초 뒤에는 저절로 풀린다).
 * 커밋 수와 이 묶음의 서버 세션 pid를 알 수 있다
 */
function pausingDatabase(url: string, name: string, pauseAfterCommit: number, autoMs = 10_000) {
  const d = createDatabase({ url, applicationName: name, max: 2 });
  const state = { commits: 0, paused: false, released: false };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const atGate = new Promise<void>((r) => (reached = r));
  const auto = setTimeout(() => release(), autoMs);
  d.pool.on('connect', (client) => {
    const q = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
    (client as unknown as { query: unknown }).query = async (...a: unknown[]) => {
      if (state.commits >= pauseAfterCommit && !state.released) {
        state.paused = true;
        reached();
        await gate;
      }
      const r = await q(...a);
      const t = typeof a[0] === 'string' ? a[0] : String((a[0] as { text?: string })?.text ?? '');
      if (/^\s*commit\b/i.test(t)) state.commits += 1;
      return r;
    };
  });
  return {
    db: d,
    state,
    atGate,
    release() {
      state.released = true;
      clearTimeout(auto);
      release();
    },
  };
}

describe('R165-14 따라잡기는 끊음마다 커밋하고 바뀐 것만 판을 올린다', () => {
  let c: PostgresContainer;
  let d: Database;
  let model: DrizzleSearchReadModel;
  const B = Date.parse('2026-12-01T00:00:00.000Z');
  const ids: string[] = [];
  const P = randomUUID();
  const L = randomUUID();
  const reconciledAt = async () => (await rows(d, 'select reconciled_at from search_version where id = 1'))[0]!.reconciled_at as Date | null;
  const v = async () => Number((await rows(d, 'select version from search_version where id = 1'))[0]!.version);
  const removalCount = async () => Number((await rows(d, 'select count(*)::int as n from search_removal'))[0]!.n);

  beforeAll(async () => {
    c = await startPostgres();
    await migrateCore(c.url);
    d = createDatabase({ url: c.url, applicationName: 'core-svc-reconcile-chunks', max: 4 });
    model = new DrizzleSearchReadModel(d, 'https://img.test');
    await d.db.insert(promoter).values({ id: P, legalName: '(주)끊음' });
    await d.db.insert(place).values({ id: L, name: '끊음홀', address: '서울', region: '서울', createdBy: ACTOR });
    for (let i = 0; i < 50; i++) {
      const id = randomUUID();
      ids.push(id);
      await d.db.insert(production).values({ id, promoterId: P, placeId: L, title: `끊음 공연 ${i}`, genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date(B - 10 * D) });
      await d.db.insert(event).values({ id: randomUUID(), productionId: id, promoterId: P, venueId: null, openAt: new Date(B - D), startsAt: new Date(B + 20 * D), endsAt: new Date(B + 20 * D + 2 * H) });
    }
  }, 180_000);
  afterAll(async () => {
    await d?.close();
    c?.stop();
  });

  test('HOT-270 따라잡기는 끊음마다 커밋해 그동안의 판매 승인 동기화가 따라잡기 끝을 기다리지 않는다(R165-14)', async () => {
    const at = new Date(B);
    // 따라잡기 동안 승인될 공연(시작 때는 승인 전이라 따라잡기 목록에 없다)
    const late = randomUUID();
    await d.db.insert(production).values({ id: late, promoterId: P, placeId: L, title: '끊음 늦은승인 공연', genre: '콘서트', saleReview: 'SUBMITTED' });
    await d.db.insert(event).values({ id: randomUUID(), productionId: late, promoterId: P, venueId: null, openAt: new Date(B - D), startsAt: new Date(B + 20 * D), endsAt: new Date(B + 20 * D + 2 * H) });
    // 1분 정리에 할 일이 있게: 창 (B − 1분, B] 안에 오픈하는 공연
    const tidyTarget = randomUUID();
    await d.db.insert(production).values({ id: tidyTarget, promoterId: P, placeId: L, title: '끊음 정리대상 공연', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date(B - 10 * D) });
    await d.db.insert(event).values({ id: randomUUID(), productionId: tidyTarget, promoterId: P, venueId: null, openAt: new Date(B - 30_000), startsAt: new Date(B + 20 * D), endsAt: new Date(B + 20 * D + 2 * H) });

    const v0 = await v();
    const p = pausingDatabase(c.url, 'core-svc-reconcile-pausing', 2);
    try {
      const running = new DrizzleSearchReadModel(p.db, 'https://img.test').reconcileAll(at, { chunkSize: 10 });
      const endedAt = running.then(() => Date.now());
      // 둘째 끊음이 커밋된 뒤 장벽에서 섰다(서지 않으면 5초 뒤 실패)
      await Promise.race([p.atGate, new Promise((_, rej) => setTimeout(() => rej(new Error('둘째 끊음 커밋 뒤 장벽에 닿지 않았다(끊음마다 커밋하지 않는다)')), 5_000))]);
      expect(p.state.commits).toBe(2);
      // 이미 커밋된 끊음은 따라잡기가 끝나기 전에 다른 연결에서 보인다(판이 올랐다)
      expect(await v()).toBeGreaterThanOrEqual(v0 + 1);
      // 그동안 다른 연결의 판매 승인 동기화는 따라잡기를 기다리지 않고 커밋한다
      const approval = d.transaction(async (tx) => {
        await tx.update(production).set({ saleReview: 'APPROVED', saleApprovedAt: at }).where(eq(production.id, late));
        return model.sync(tx, [late], at);
      });
      const approved = await Promise.race([approval.then(() => Date.now()), new Promise<number>((_, rej) => setTimeout(() => rej(new Error('판매 승인 동기화가 따라잡기를 기다렸다')), 5_000))]);
      // 끊음 사이(커밋 뒤 다음 끊음 전)에는 1분 정리가 돈다(트랜잭션 잠금이라 끊음 사이에는 아무도 쥐지 않는다, R165-19).
      // 끊음 안에서 건너뛰는 경우는 '### 15' R165-19 시험이 본다. 창은 (B − 1분, B]로 따라잡기와 같은 시각이라 둘이 서로 되돌리지 않는다
      const between = await model.syncTimed(at, new Date(B - 60_000));
      expect(between.productions).toBeGreaterThanOrEqual(1);
      const releasedAt = Date.now();
      p.release();
      const out = await running;
      const ended = await endedAt;
      expect(approved).toBeLessThan(releasedAt);
      expect(approved).toBeLessThan(ended);
      // 끊음 6개(시작 때 원천의 공연 51개 ÷ 10, 늦은 승인 공연은 목록에 없다) 모두 바뀌어 끊음마다 판 1, 승인 동기화 1
      expect(out).toMatchObject({ ran: true, chunks: Math.ceil(out.productions / 10) });
      expect(out.productions).toBeGreaterThanOrEqual(51);
      // 끊음마다 판 1, 승인 동기화 1, 끊음 사이 1분 정리가 바꿨으면 1
      expect((await v()) - v0).toBe(out.chunks + 1 + (between.version === null ? 0 : 1));
      expect(await driftOn(d, at.getTime())).toBe(0);
    } finally {
      p.release();
      await p.db.close();
    }
  });

  test('HOT-270 바뀐 것이 없는 따라잡기와 동기화는 판과 지운 표시를 올리지 않는다(R165-14)', async () => {
    const at = new Date(B + 60_000);
    await model.reconcileAll(at, { chunkSize: 10 });
    const v1 = await v();
    const r1 = await removalCount();
    // 두 번째 따라잡기: 돌기는 돌지만 판·지운 표시가 그대로다
    const again = await model.reconcileAll(at, { chunkSize: 10 });
    expect(again.ran).toBe(true);
    expect([await v(), await removalCount()]).toEqual([v1, r1]);
    // 바뀐 것 없는 공연의 sync도 판이 그대로다
    await d.transaction((tx) => model.sync(tx, [ids[0]!], at));
    expect(await v()).toBe(v1);
    // 대조군: 공연 하나 이름을 바꾸고 따라잡기 → 판 +1(정확히 1)
    await d.db.update(production).set({ title: '끊음 공연 이름바꿈' }).where(eq(production.id, ids[1]!));
    await model.reconcileAll(at, { chunkSize: 10 });
    expect(await v()).toBe(v1 + 1);
    expect(await driftOn(d, at.getTime())).toBe(0);
  });

  // 트랜잭션 풀링에서는 연결이 파드에 묶이지 않아 pg_terminate_backend로 '파드가 죽음'을 흉내 내지 못한다. A가 임대를 쥔 채 멈추는 장치로 바꿨다(R165-19)
  test('HOT-270 따라잡기를 맡은 파드가 도중에 죽으면 다른 파드가 다음 정리 주기에 이어 마치고 reconciled_at을 적는다(R165-14)', async () => {
    const at = B + 2 * 60_000;
    // 모든 공연 이름을 바꿔 끊음마다 할 일이 있게 한다
    for (const [i, id] of ids.entries()) await d.db.update(production).set({ title: `끊음 공연 다시 ${i}` }).where(eq(production.id, id));
    const a = pausingDatabase(c.url, 'core-svc-reconcile-pod-a', 1, 60_000);
    const clockB = movingClock(at);
    const recorded: { ran: boolean }[] = [];
    const bModel = new DrizzleSearchReadModel(d, 'https://img.test');
    const bSync: SearchReadModelSync = {
      sync: (tx, x, t) => bModel.sync(tx as Parameters<DrizzleSearchReadModel["sync"]>[0], x, t),
      syncTimed: (t, s) => bModel.syncTimed(t, s),
      recountInterest: (t) => bModel.recountInterest(t),
      purgeRemovals: (t) => bModel.purgeRemovals(t),
      lastReconciledAt: () => bModel.lastReconciledAt(),
      reconcileAll: async (t, o) => {
        const r = await bModel.reconcileAll(t, { ...o, chunkSize: 10, owner: 'b' });
        recorded.push({ ran: r.ran });
        return r;
      },
    };
    const podB = new SearchReadModelTimers({ sync: bSync, clock: clockB });
    let runningA: Promise<unknown> = Promise.resolve();
    try {
      // 파드 A가 따라잡기를 시작해 첫 끊음을 커밋하고 섰다
      runningA = new DrizzleSearchReadModel(a.db, 'https://img.test').reconcileAll(new Date(at), { chunkSize: 10, owner: 'a', leaseMs: 1_500 }).catch((e: unknown) => e);
      await Promise.race([a.atGate, new Promise((_, rej) => setTimeout(() => rej(new Error('첫 끊음 커밋 뒤 장벽에 닿지 않았다')), 5_000))]);
      // 파드 B가 뜬다: A가 임대를 쥐고 있어 B의 시작 따라잡기는 건너뛴다. A는 멈춘 채 돌아오지 않는다(죽은 파드)
      await podB.start();
      expect(recorded).toEqual([{ ran: false }]);
      expect(await reconciledAt()).toBeNull();
      expect(await driftOn(d, at)).toBeGreaterThanOrEqual(1);
      // 만료 전 정리 주기: 다시 해 보지만 임대가 살아 있어 건너뛴다
      clockB.set(at + 60_000);
      await podB.tidy();
      expect(recorded).toEqual([{ ran: false }, { ran: false }]);
      // 임대가 만료된 뒤(DB now() 기준) 다음 정리 주기의 다시 하기가 넘겨받아 마친다
      await rows(d, "update search_version set reconcile_lease_until = now() - interval '1 second' where id = 1");
      clockB.set(at + 2 * 60_000);
      await podB.tidy();
      expect(recorded).toEqual([{ ran: false }, { ran: false }, { ran: true }]);
      const done = await reconciledAt();
      expect(done).not.toBeNull();
      expect((await bModel.lastReconciledAt())?.getTime()).toBe(new Date(done!).getTime());
      expect(await driftOn(d, at)).toBe(0);
    } finally {
      podB.stop();
      a.release();
      await within(runningA, 10_000, 'A가 끝나지 않았다').catch(() => undefined);
      await a.db.close().catch(() => {});
    }
  });
});

// ---- 리뷰 R165-19(계획 docs/review/plans/BAT-165.md '### 15', ADR-0271 결정 12 '잠금과 임대', docs/data.md search_version 임대 칸 넷) ----

/**
 * 트랜잭션 풀링(PgBouncer) 대역: 연결 하나씩만 가진 Database 둘을 번갈아 내준다. 트랜잭션마다 다른 서버 세션이 될 수 있다.
 * 트랜잭션마다 그 세션의 pg_backend_pid()를 모은다
 */
function alternatingDatabase(url: string, name: string) {
  const inner = [createDatabase({ url, applicationName: `${name}-1`, max: 1 }), createDatabase({ url, applicationName: `${name}-2`, max: 1 })];
  let i = 0;
  const pids = new Set<number>();
  const stat = { transactions: 0 };
  const next = () => inner[i++ % inner.length]!;
  const db = {
    get db() {
      return next().db;
    },
    get pool() {
      return next().pool;
    },
    async transaction<T>(fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>, o?: Parameters<Database['transaction']>[1]): Promise<T> {
      return next().transaction(async (tx) => {
        const r = (await tx.execute(sql`select pg_backend_pid() as pid`)) as unknown as { rows: { pid: number }[] };
        pids.add(Number(r.rows[0]!.pid));
        stat.transactions += 1;
        return fn(tx);
      }, o);
    },
    async close() {
      for (const x of inner) await x.close();
    },
  } as unknown as Database;
  return { db, pids, stat };
}

/** 따라잡기 연결 묶음의 두 단계 장벽: 권고 잠금 질의 뒤(끊음 트랜잭션 안)에서 한 번, 그다음 커밋 뒤(끊음 사이)에서 한 번 선다 */
function stagedDatabase(url: string, name: string) {
  const d = createDatabase({ url, applicationName: name, max: 2 });
  const s = { stage: 'afterLock' as 'afterLock' | 'afterCommit' | 'done', armed: false };
  const mk = () => {
    let open!: () => void;
    let hit!: () => void;
    return { gate: new Promise<void>((r) => (open = r)), reached: new Promise<void>((r) => (hit = r)), open: () => open(), hit: () => hit() };
  };
  const g1 = mk();
  const g2 = mk();
  const auto = setTimeout(() => {
    g1.open();
    g2.open();
  }, 20_000);
  d.pool.on('connect', (client) => {
    const q = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
    (client as unknown as { query: unknown }).query = async (...a: unknown[]) => {
      if (s.armed) {
        s.armed = false;
        const g = s.stage === 'afterLock' ? g1 : g2;
        g.hit();
        await g.gate;
      }
      const r = await q(...a);
      const t = typeof a[0] === 'string' ? a[0] : String((a[0] as { text?: string })?.text ?? '');
      if (s.stage === 'afterLock' && /advisory/i.test(t)) s.armed = true;
      else if (s.stage === 'afterCommit' && /^\s*commit\b/i.test(t)) s.armed = true;
      return r;
    };
  });
  return {
    db: d,
    inChunk: g1.reached,
    betweenChunks: g2.reached,
    releaseInChunk() {
      s.stage = 'afterCommit';
      g1.open();
    },
    releaseBetween() {
      s.stage = 'done';
      g2.open();
    },
    close: async () => {
      clearTimeout(auto);
      g1.open();
      g2.open();
      await d.close();
    },
  };
}

const within = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(what)), ms))]);

describe('R165-19 트랜잭션 잠금과 따라잡기 임대', () => {
  let c: PostgresContainer;
  let d: Database;
  let model: DrizzleSearchReadModel;
  const B = Date.parse('2026-12-05T00:00:00.000Z');
  const ids: string[] = [];
  const P = randomUUID();
  const L = randomUUID();
  const lease = async () => (await rows(d, 'select reconcile_owner, reconcile_lease_until, reconcile_started_at, reconcile_cursor, reconciled_at from search_version where id = 1'))[0]!;
  const allIds = async (at: number) => (await rows(d, 'select production_id from search_document_source_at($1) union select production_id from search_document order by production_id', [new Date(at)])).map((r) => r.production_id as string);
  /** 창 (at, at + 1분] 안에 오픈하는 공연(1분 정리에 할 일이 있게) */
  const tidyWork = async (at: number) => {
    const id = randomUUID();
    await d.db.insert(production).values({ id, promoterId: P, placeId: L, title: `임대 정리대상 ${id.slice(0, 6)}`, genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date(B - 10 * D) });
    await d.db.insert(event).values({ id: randomUUID(), productionId: id, promoterId: P, venueId: null, openAt: new Date(at + 30_000), startsAt: new Date(B + 20 * D), endsAt: new Date(B + 20 * D + 2 * H) });
    return id;
  };
  const renameAll = async (tag: string) => {
    for (const [i, id] of ids.entries()) await d.db.update(production).set({ title: `임대 공연 ${tag} ${i}` }).where(eq(production.id, id));
  };

  beforeAll(async () => {
    c = await startPostgres();
    await migrateCore(c.url);
    d = createDatabase({ url: c.url, applicationName: 'core-svc-r165-19', max: 4 });
    model = new DrizzleSearchReadModel(d, 'https://img.test');
    await d.db.insert(promoter).values({ id: P, legalName: '(주)임대' });
    await d.db.insert(place).values({ id: L, name: '임대홀', address: '서울', region: '서울', createdBy: ACTOR });
    for (let i = 0; i < 30; i++) {
      const id = randomUUID();
      ids.push(id);
      await d.db.insert(production).values({ id, promoterId: P, placeId: L, title: `임대 공연 ${i}`, genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date(B - 10 * D) });
      await d.db.insert(event).values({ id: randomUUID(), productionId: id, promoterId: P, venueId: null, openAt: new Date(B - D), startsAt: new Date(B + 20 * D), endsAt: new Date(B + 20 * D + 2 * H) });
    }
  }, 180_000);
  afterAll(async () => {
    await d?.close();
    c?.stop();
  });

  test('HOT-270 트랜잭션마다 DB 연결이 바뀌어도 따라잡기는 끝까지 마치고 권고 잠금을 남기지 않는다(R165-19)', async () => {
    const at = B;
    const pooled = alternatingDatabase(c.url, 'core-svc-r165-19-pooled');
    try {
      const out = await new DrizzleSearchReadModel(pooled.db, 'https://img.test').reconcileAll(new Date(at), { chunkSize: 10, owner: 'pooled' });
      // 끊음 트랜잭션들이 실제로 서로 다른 서버 세션에서 돌았다(먼저 본다)
      expect(pooled.stat.transactions).toBeGreaterThanOrEqual(3);
      expect(pooled.pids.size).toBeGreaterThanOrEqual(2);
      expect(out).toMatchObject({ ran: true, chunks: 3 });
      expect(Number((await rows(d, "select count(*)::int as n from pg_locks where locktype = 'advisory'"))[0]!.n)).toBe(0);
      const l = await lease();
      expect([l.reconcile_owner, l.reconcile_lease_until, l.reconcile_started_at, l.reconcile_cursor]).toEqual([null, null, null, null]);
      expect(l.reconciled_at).not.toBeNull();
      expect(await driftOn(d, at)).toBe(0);
      // 바로 뒤 1분 정리가 돈다(잠금이 남지 않았다)
      await tidyWork(at);
      expect((await model.syncTimed(new Date(at + 60_000), new Date(at))).productions).toBeGreaterThanOrEqual(1);
    } finally {
      await pooled.db.close();
    }
  });

  test('HOT-270 임대가 살아 있으면 다른 파드는 따라잡기를 하지 않고, 만료되면 넘겨받아 커서 뒤부터 잇는다(R165-19)', async () => {
    for (const [scenario, at] of [
      ['SQL로 만료', B + 2 * 60_000],
      ['실제로 기다려 만료', B + 3 * 60_000],
    ] as const) {
      await renameAll(scenario);
      const order = await allIds(at);
      expect(order.length).toBeGreaterThanOrEqual(30);
      // 파드 A가 첫 끊음을 커밋한 뒤 멈춘 채 돌아오지 않는다(죽은 파드)
      const a = pausingDatabase(c.url, `core-svc-r165-19-a-${scenario.length}`, 1, 60_000);
      const runningA = new DrizzleSearchReadModel(a.db, 'https://img.test').reconcileAll(new Date(at), { chunkSize: 10, owner: 'a', leaseMs: 1_500 }).catch((e: unknown) => e);
      try {
        await within(a.atGate, 5_000, '첫 끊음 커밋 뒤 장벽에 닿지 않았다');
        const held = await lease();
        expect({ scenario, owner: held.reconcile_owner, cursor: held.reconcile_cursor }).toEqual({ scenario, owner: 'a', cursor: order[9] });
        expect(held.reconcile_started_at).not.toBeNull();
        // 만료 전(1,499ms 안): B는 따라잡기를 하지 않고 임대·커서가 그대로다
        const early = await model.reconcileAll(new Date(at), { chunkSize: 10, owner: 'b' });
        expect({ scenario, ran: early.ran }).toEqual({ scenario, ran: false });
        const still = await lease();
        expect([still.reconcile_owner, still.reconcile_cursor, String(still.reconcile_lease_until)]).toEqual([held.reconcile_owner, held.reconcile_cursor, String(held.reconcile_lease_until)]);
        // 만료(DB now() 기준)
        if (scenario === 'SQL로 만료') await rows(d, "update search_version set reconcile_lease_until = now() - interval '1 second' where id = 1");
        else
          await within(
            (async () => {
              for (;;) {
                if ((await rows(d, 'select now() > reconcile_lease_until as gone from search_version where id = 1'))[0]!.gone === true) return;
                await new Promise((r) => setTimeout(r, 100));
              }
            })(),
            5_000,
            '임대가 만료되지 않았다',
          );
        const late = await model.reconcileAll(new Date(at), { chunkSize: 10, owner: 'b' });
        expect({ scenario, ran: late.ran, resumedFrom: late.resumedFrom, productions: late.productions }).toEqual({ scenario, ran: true, resumedFrom: held.reconcile_cursor, productions: order.length - 10 });
        const after = await lease();
        expect([after.reconcile_owner, after.reconcile_lease_until, after.reconcile_started_at, after.reconcile_cursor]).toEqual([null, null, null, null]);
        expect(new Date(after.reconciled_at as string | Date).getTime()).toBe(new Date(held.reconcile_started_at as string | Date).getTime());
        expect(await driftOn(d, at)).toBe(0);
      } finally {
        a.release();
        await within(runningA, 10_000, 'A가 끝나지 않았다').catch(() => undefined);
        await a.db.close().catch(() => {});
      }
    }
  });

  test('HOT-270 따라잡기 끊음 트랜잭션이 도는 동안 1분 정리·관심도·지운 표시 정리는 그 차례를 건너뛰고, 끊음 사이에는 돈다(R165-19)', async () => {
    const at = B + 4 * 60_000;
    await renameAll('정리');
    // 셋 다 할 일이 있게: 창 안에 오픈하는 공연, 관심도가 바뀐 공연(찜 하나), 하루 지난 지운 표시
    await tidyWork(at);
    await d.db.insert(wish).values({ accountId: randomUUID(), productionId: ids[0]!, createdAt: new Date(at) });
    const oldMark = randomUUID();
    await rows(d, "insert into search_removal (version, kind, target_id, removed_at) values (1, 'DOCUMENT', $1, $2)", [oldMark, new Date(at - 2 * D)]);
    const staged = stagedDatabase(c.url, 'core-svc-r165-19-staged');
    const running = new DrizzleSearchReadModel(staged.db, 'https://img.test').reconcileAll(new Date(at), { chunkSize: 10, owner: 'staged' });
    try {
      await within(staged.inChunk, 5_000, '끊음 트랜잭션 안(잠금 뒤)에서 서지 않았다');
      const interestBefore = (await rows(d, 'select interest from search_document where production_id = $1', [ids[0]]))[0]?.interest;
      const timed = await model.syncTimed(new Date(at + 60_000), new Date(at));
      const recounted = await model.recountInterest(new Date(at));
      const purged = await model.purgeRemovals(new Date(at));
      expect({ timed: timed.productions, recounted, purged }).toEqual({ timed: 0, recounted: 0, purged: 0 });
      // 표가 그대로다
      expect((await rows(d, 'select interest from search_document where production_id = $1', [ids[0]]))[0]?.interest).toEqual(interestBefore);
      expect(await rows(d, 'select 1 from search_removal where target_id = $1', [oldMark])).toHaveLength(1);
      // 끊음 사이(커밋 뒤 다음 끊음 전)에는 1분 정리가 돈다
      staged.releaseInChunk();
      await within(staged.betweenChunks, 5_000, '끊음 사이에서 서지 않았다');
      expect((await model.syncTimed(new Date(at + 60_000), new Date(at))).productions).toBeGreaterThanOrEqual(1);
      staged.releaseBetween();
      await within(running, 10_000, '따라잡기가 끝나지 않았다');
    } finally {
      await staged.close();
    }

    // 연결 둘로 관심도 다시 세기를 함께 부르면 하나만 일한다(같은 열쇠의 트랜잭션 잠금, R165-9 ①)
    await d.db.insert(wish).values({ accountId: randomUUID(), productionId: ids[1]!, createdAt: new Date(at) });
    const d1 = createDatabase({ url: c.url, applicationName: 'core-svc-r165-19-recount-1', max: 1 });
    const d2 = createDatabase({ url: c.url, applicationName: 'core-svc-r165-19-recount-2', max: 1 });
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const timer = setTimeout(() => open(), 3_000);
    for (const x of [d1, d2]) {
      x.pool.on('connect', (client) => {
        const q = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = async (...a: unknown[]) => {
          const t = typeof a[0] === 'string' ? a[0] : String((a[0] as { text?: string })?.text ?? '');
          if (/advisory/i.test(t)) {
            arrived += 1;
            if (arrived >= 2) open();
            await gate;
          }
          return q(...a);
        };
      });
    }
    try {
      const both = await Promise.all([new DrizzleSearchReadModel(d1, 'https://img.test').recountInterest(new Date(at)), new DrizzleSearchReadModel(d2, 'https://img.test').recountInterest(new Date(at))]);
      expect(arrived).toBeGreaterThanOrEqual(2);
      expect(both.filter((n) => n > 0)).toHaveLength(1);
      expect(both.filter((n) => n === 0)).toHaveLength(1);
    } finally {
      clearTimeout(timer);
      await d1.close();
      await d2.close();
    }
  });
});

// ---- 리뷰 R165-23(계획 '#### R165-19·22 다시 보기', ADR-0271 결정 12 '못 잡으면 건너뛰어 다음 주기에 한다'·'성공했을 때만 옮긴다') ----
describe('R165-23 건너뛴 1분 정리는 시각 창을 잃지 않는다', () => {
  test('HOT-270 관심도 다시 세기가 잠금을 쥔 동안 건너뛴 1분 정리는 창을 옮기지 않아, 그 사이 오픈 시각이 지난 공연이 다음 정리에서 판매 중이 된다(R165-23)', async () => {
    const c = await startPostgres();
    await migrateCore(c.url);
    const d = createDatabase({ url: c.url, applicationName: 'core-svc-r165-23', max: 4 });
    const staged = stagedDatabase(c.url, 'core-svc-r165-23-recount');
    try {
      const T = Date.parse('2026-12-10T00:00:00.000Z');
      const p = randomUUID();
      const l = randomUUID();
      const id = randomUUID();
      await d.db.insert(promoter).values({ id: p, legalName: '(주)창' });
      await d.db.insert(place).values({ id: l, name: '창홀', address: '서울', region: '서울', createdBy: ACTOR });
      await d.db.insert(production).values({ id, promoterId: p, placeId: l, title: '창 오픈공연', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date(T - 10 * D) });
      // 첫 정리 창 (T, T + 1분] 안에 오픈한다
      await d.db.insert(event).values({ id: randomUUID(), productionId: id, promoterId: p, venueId: null, openAt: new Date(T + 30_000), startsAt: new Date(T + 20 * D), endsAt: new Date(T + 20 * D + 2 * H) });
      const model = new DrizzleSearchReadModel(d, 'https://img.test');
      const clock2 = movingClock(T);
      const timers = new SearchReadModelTimers({ sync: model, clock: clock2 });
      const status = async () => (await rows(d, 'select sale_status from search_document where production_id = $1', [id]))[0]?.sale_status;
      try {
        // 서버가 뜬다(따라잡기로 표가 찬다). 아직 오픈 전이다
        await timers.start();
        expect(await status()).toBe('UPCOMING');
        // 같은 파드의 관심도 다시 세기가 같은 열쇠의 잠금을 쥔 채 멈춘다
        const recount = new DrizzleSearchReadModel(staged.db, 'https://img.test').recountInterest(new Date(T + 60_000));
        await within(staged.inChunk, 5_000, '관심도 다시 세기가 잠금 뒤에서 서지 않았다');
        // 그동안 1분 정리: 잠금을 못 잡아 건너뛴다(바깥에서 보면 아직 오픈 전 그대로)
        clock2.set(T + 60_000);
        await timers.tidy();
        expect(await status()).toBe('UPCOMING');
        // 건너뜀을 돌려주는 모양(시험이 정함): 같은 순간 직접 부르면 skipped: true(단언은 끝에서 한다)
        const direct = await model.syncTimed(new Date(T + 60_000), new Date(T));
        staged.releaseInChunk();
        await within(recount, 5_000, '관심도 다시 세기가 끝나지 않았다');
        // 다음 정리: 건너뛴 창부터 다시 보므로 T + 30초의 오픈 경계를 잃지 않는다
        clock2.set(T + 2 * 60_000);
        await timers.tidy();
        expect(await status()).toBe('ON_SALE');
        expect(await driftOn(d, T + 2 * 60_000)).toBe(0);
        expect(direct).toMatchObject({ version: null, productions: 0, skipped: true });
      } finally {
        timers.stop();
      }
    } finally {
      await staged.close();
      await d.close();
      c.stop();
    }
  });
});
