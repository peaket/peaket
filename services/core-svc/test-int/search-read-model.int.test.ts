// 검색 읽기 모델 표·동기화·증분 사전 통합 시험(실제 PostgreSQL 18 컨테이너, BAT-165 웨이브 7 T-01·T-02·T-03·T-05·T-07(D)·T-14·T-19(D)·T-25, ADR-0271).
// 정본: docs/features/search.md §2.2(52줄 DB 설정 SR-T7), §2.3(56~59줄), §7.2(242줄 검색 전용 연결 묶음), §12 SR-T7(298)·SR-T8 ①②(299)·SR-T15 ②(306),
// docs/data.md search_document·search_term·search_removal·search_version(536~577줄), '공연 검색' 줄(2813).
// 이 시험은 운영과 같은 DB 역할(core_app·core_partner·core_ops)로 서비스를 띄우고, 동기화는 DrizzleSearchReadModel(슈퍼유저 연결)로 부른다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type Clock, createDatabase, createService, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import type { SalePolicyRule } from '@peaket/validation/sale-policy';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleSearchIndex, DrizzleSearchReadModel, SearchUnavailable, SuggestionDictionary, type DictionarySnapshot, type SearchDictionarySource } from '../src/modules/catalog/index.js';
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
      await index.search(query('오로라후보'));
      docRows = 0;
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
