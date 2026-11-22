// BAT-167 구현 뒤 통합 시험(실제 PostgreSQL 18, 계획 docs/review/plans/BAT-167.md §10 T3·T5·T7·T8·T9·T10).
// 정본: ADR-0271 결정 25(한 글자 입력은 변환 단계마다 이름 줄을 따로 읽고 등급이 붙은 이름 줄만 공연으로 펼친다,
// 응답·차례·query.converted 불변, 사전 준비 전에는 지금 질의), 결정 22(후보 질의는 갈래마다, SubPlan 없음, 한 공연은 한 번),
// 결정 23(응답 불변·두 읽기는 서로 다른 스냅숏일 수 있음), 결정 24(변환 값을 만들 수 없는 단계는 건너뜀),
// docs/features/search.md §3.2 ④·§5.3~§5.5·§7.2(연결 10개·대기 100ms·질의 상한 300ms, 넘치면 503)·SR-T13 ①(:307).
// 기준 코드는 같은 어댑터의 지금 질의(keysOf 없음, 모든 단계를 한 질의에 합침)다. 두 응답 JSON 전체를 견준다.
import 'reflect-metadata';
import { createDatabase, createService, type Database, ensureOutboxPartitions, systemClock, type Clock } from '@peaket/platform';
import { nameKeys, type NameKeys } from '@peaket/search-normalize';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleSearchIndex, DrizzleSearchReadModel, SearchCatalog, SearchUnavailable } from '../src/modules/catalog/index.js';
import type { SearchQuery } from '../src/modules/catalog/domain/search.js';
import { logSinkUnit, FakeIdentity, testMedia } from '../test/support.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { loginFor } from './roles.js';

type Svc = Awaited<ReturnType<typeof createService>>;
const ORIGIN = 'https://img.test';
const now = Date.parse('2026-11-20T00:00:00.000Z');
const clock: Clock = { now: () => now, monotonicMs: () => performance.now() };
const H = 3_600_000;
const D = 24 * H;
const PROMOTER = randomUUID();
const ACTOR = randomUUID();
const pad = (n: number, w: number) => String(n).padStart(w, '0');
const BULK = 2_000;
const PLACES = Array.from({ length: 20 }, () => randomUUID());
const ARTISTS = Array.from({ length: 200 }, () => randomUUID());
const BULK_IDS = Array.from({ length: BULK }, () => randomUUID());
const SPECIAL = {} as {
  prodOnly: string;
  aliasOnly: string;
  artistOnly: string;
  placeOnly: string;
  multi: string;
  endeds: string[];
  percents: string[];
};
const PERCENT = ['%할인 쇼', '_밑줄 쇼', '\\역빗금 쇼'];

// 한 글자 입력이 여러 단계·여러 갈래에 걸리게 하는 이름 모양(계획 §1.1의 'a'·'루'·'맘'·'캣'·'ㅁ'·'7'·'가'·'각')
const bulkTitle = (n: number): string => {
  switch (n % 10) {
    case 0:
      return `Aurora 공연 ${n}`;
    case 1:
      return `루멘 콘서트 ${n}`;
    case 2:
      return `뮤지컬 밤 ${n}`;
    case 3:
      return `캣츠 공연 ${n}`;
    case 4:
      return `맘마미아 ${n}`;
    case 5:
      return `가나다 공연 ${n}`;
    case 6:
      return `7번 공연 ${n}`;
    case 7:
      return `별빛나는 공연 ${n}`;
    case 8:
      return `웻 쇼 ${n}`;
    default:
      return `각시 공연 ${n}`;
  }
};

const query = (q: string, o: Partial<SearchQuery> = {}): SearchQuery => ({ q, includePast: false, noConvert: false, page: 1, now: new Date(now), ...o });
const ids = (out: { items: { productionId: string }[] }) => out.items.map((x) => x.productionId);
const json = (out: unknown) => JSON.stringify(out);

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let opsDb: Database;
let svc: Svc;
let model: DrizzleSearchReadModel;
let staged: DrizzleSearchIndex;
let baseline: DrizzleSearchIndex;
let keysOf: (name: string) => NameKeys | undefined;
const logs = logSinkUnit();

/** 공연 하나(회차 하나, 판매 중). 아티스트는 차례대로 sort_order 0, 1, 2 … */
async function addProduction(o: { title: string; placeId?: string | null; artists?: string[]; alias?: string; past?: boolean }): Promise<string> {
  const id = randomUUID();
  await admin.pool.query(`insert into production (id, promoter_id, place_id, title, genre, sale_review, sale_approved_at) values ($1, $2, $3, $4, '콘서트', 'APPROVED', $5)`, [
    id,
    PROMOTER,
    o.placeId === undefined ? PLACES[0] : o.placeId,
    o.title,
    new Date(now - 10 * D),
  ]);
  const start = o.past ? now - 30 * D : now + 20 * D;
  await admin.pool.query(`insert into event (id, production_id, promoter_id, venue_id, open_at, starts_at, ends_at) values ($1, $2, $3, null, $4, $5, $6)`, [
    randomUUID(),
    id,
    PROMOTER,
    new Date(start - D),
    new Date(start),
    new Date(start + 2 * H),
  ]);
  for (const [i, a] of (o.artists ?? []).entries()) await admin.pool.query(`insert into production_artist (production_id, artist_id, sort_order) values ($1, $2, $3)`, [id, a, i]);
  if (o.alias) await admin.pool.query(`insert into search_alias (id, target_kind, target_id, alias, source, created_by) values ($1, 'PRODUCTION', $2, $3, 'PARTNER', $4)`, [randomUUID(), id, o.alias, ACTOR]);
  return id;
}

async function addArtist(name: string): Promise<string> {
  const id = randomUUID();
  await admin.pool.query(`insert into artist (id, name, created_by) values ($1, $2, $3)`, [id, name, ACTOR]);
  return id;
}

async function addPlace(name: string): Promise<string> {
  const id = randomUUID();
  await admin.pool.query(`insert into place (id, name, address, region, created_by) values ($1, $2, '서울', '서울', $3)`, [id, name, ACTOR]);
  return id;
}

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-bat167', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 4);
  opsDb = await loginFor(admin, pg, 'core_ops_login', 'core_ops', 4);
  model = new DrizzleSearchReadModel(admin, ORIGIN);
  await admin.pool.query(`insert into promoter (id, legal_name) values ($1, '(주)BAT167')`, [PROMOTER]);
  await admin.pool.query(`insert into place (id, name, address, region, created_by) select unnest($1::uuid[]), unnest($2::text[]), '서울', '서울', $3`, [PLACES, PLACES.map((_, i) => `공연장${pad(i, 2)}`), ACTOR]);
  await admin.pool.query(`insert into artist (id, name, created_by) select unnest($1::uuid[]), unnest($2::text[]), $3`, [ARTISTS, ARTISTS.map((_, i) => `아티스트${pad(i, 3)}`), ACTOR]);
  // 공연 2,000개: 공연 n은 공연장 n % 20, 아티스트 n % 200(아티스트마다 공연 10개, 공연장마다 100개)
  for (let i = 0; i < BULK; i += 500) {
    const ns = Array.from({ length: Math.min(500, BULK - i) }, (_, k) => i + k);
    const idsIn = ns.map((n) => BULK_IDS[n]!);
    await admin.pool.query(
      `insert into production (id, promoter_id, place_id, title, genre, sale_review, sale_approved_at) select unnest($1::uuid[]), $2, unnest($3::uuid[]), unnest($4::text[]), '콘서트', 'APPROVED', $5`,
      [idsIn, PROMOTER, ns.map((n) => PLACES[n % 20]!), ns.map((n) => bulkTitle(n)), new Date(now - 10 * D)],
    );
    await admin.pool.query(
      `insert into event (id, production_id, promoter_id, venue_id, open_at, starts_at, ends_at) select unnest($1::uuid[]), unnest($2::uuid[]), $3, null, $4, $5, $6`,
      [ns.map(() => randomUUID()), idsIn, PROMOTER, new Date(now - D), new Date(now + 20 * D), new Date(now + 20 * D + 2 * H)],
    );
    await admin.pool.query(`insert into production_artist (production_id, artist_id, sort_order) select unnest($1::uuid[]), unnest($2::uuid[]), 0`, [idsIn, ns.map((n) => ARTISTS[n % 200]!)]);
    // 장르 필터의 대조군: 10개 중 2개는 뮤지컬
    await admin.pool.query(`update production set genre = '뮤지컬' where id = any($1::uuid[])`, [ns.filter((n) => n % 10 === 2).map((n) => BULK_IDS[n]!)]);
    // 다른 이름: 10개 중 3개(계획 T3의 '다른 이름' 갈래)
    const aliased = ns.filter((n) => n % 10 === 3);
    if (aliased.length > 0)
      await admin.pool.query(`insert into search_alias (id, target_kind, target_id, alias, source, created_by) select gen_random_uuid(), 'PRODUCTION', unnest($1::uuid[]), unnest($2::text[]), 'PARTNER', $3`, [
        aliased.map((n) => BULK_IDS[n]!),
        aliased.map((n) => `숨은이름 ${n}`),
        ACTOR,
      ]);
  }
  // 지난 공연(includePast·status 필터의 대조군). 이름은 한 글자 시험 입력과 겹치지 않게 둔다
  SPECIAL.endeds = [];
  for (let i = 0; i < 5; i++) SPECIAL.endeds.push(await addProduction({ title: `지난 공연 ${i}`, past: true }));
  // LIKE 메타 문자 이름(SR-T6, M11): 이스케이프하지 않으면 한 글자 '%'·'_'·'\'가 모든 이름을 읽는다
  SPECIAL.percents = [];
  for (const title of PERCENT) SPECIAL.percents.push(await addProduction({ title }));
  // 갈래별 경우(결정 22: 공연명·다른 이름·아티스트·공연장, 여러 갈래로 맞아도 한 번)
  SPECIAL.prodOnly = await addProduction({ title: '큐피드의 화살', artists: [] });
  SPECIAL.aliasOnly = await addProduction({ title: '일반 숨은 공연', alias: '퀴즈쇼', artists: [] });
  const quantum = await addArtist('퀀텀가수');
  const seul = await addPlace('퀠른홀');
  SPECIAL.artistOnly = await addProduction({ title: '일반 아티스트 공연', artists: [quantum] });
  SPECIAL.placeOnly = await addProduction({ title: '일반 공연장 공연', placeId: seul, artists: [] });
  // 공연명·아티스트 두 갈래로 함께 맞는 공연(한 번만 나와야 한다)
  SPECIAL.multi = await addProduction({ title: '퀀텀 투어', placeId: seul, artists: [quantum] });

  // 읽기 모델은 서버와 같은 따라잡기로 채운다
  const r = await model.reconcileAll(new Date(now));
  expect(r.ran).toBe(true);
  await admin.pool.query('analyze');

  // 사전 keysOf와 같은 모양: search_term의 이름 글 → 비교 값(사전이 첫 읽기를 마친 뒤와 같은 값)
  const names = (await admin.pool.query<{ display_name: string }>('select distinct display_name from search_term')).rows;
  const byName = new Map(names.map((x) => [x.display_name, nameKeys(x.display_name)] as const));
  keysOf = (n: string) => byName.get(n);
  staged = new DrizzleSearchIndex(admin, ORIGIN, { keysOf, ready: () => true });
  baseline = new DrizzleSearchIndex(admin, ORIGIN);

  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, notifyDatabase: appDb, partnerDatabase: partnerDb, opsDatabase: opsDb, media: testMedia() }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info' },
    clock,
    logDestination: logs.stream,
    adminAuthz: new FakeIdentity(),
  });
  // 한 글자 단계별 읽기는 사전이 첫 통째로 읽기를 마친 뒤에만 쓴다(결정 25)
  const dict = svc.app.get(SearchCatalog).dictionary;
  await dict.refresh();
  expect(dict.ready).toBe(true);
}, 300_000);

afterAll(async () => {
  await svc?.close();
  for (const d of [appDb, partnerDb, opsDb, admin]) await d?.close();
  pg?.stop();
});

describe('SR-T13 ① 한 글자 이름 줄 우선 등급의 응답 불변(T3·T5)', () => {
  test('SR-T13 ① 한 글자 입력의 결과·차례·쪽·전체 수·query.converted가 기준 코드(모든 단계를 합친 질의)와 같다', async () => {
    // 한 글자·한 글자 로마자·초성·숫자·LIKE 메타 문자. 'a'·'z'·'ㅁ'은 변환 단계가 있다
    const inputs = ['a', 'A', 'z', 'Z', '루', '맘', '캣', 'ㅁ', '7', '가', '각', 'ㄹ', '%', '_', '\\'];
    const conditions: Array<[string, Partial<SearchQuery>]> = [
      ['기본', {}],
      ['인기', { sort: 'POPULAR' }],
      ['오픈 임박', { sort: 'OPEN_SOON' }],
      ['2쪽', { page: 2 }],
      ['noConvert', { noConvert: true }],
      ['지난 공연 포함', { includePast: true }],
      ['장르', { genre: '뮤지컬' }],
      ['상태', { status: 'ON_SALE' }],
      ['공연장', { placeId: PLACES[3] }],
      ['아티스트', { artistId: ARTISTS[7] }],
      ['날짜', { dateFrom: '2026-12-01', dateTo: '2026-12-31' }],
    ];
    let nonEmpty = 0;
    let converted = 0;
    for (const input of inputs) {
      for (const [why, o] of conditions) {
        const [a, b] = await Promise.all([staged.search(query(input, o)), baseline.search(query(input, o))]);
        if (a.items.length > 0) nonEmpty += 1;
        if (a.query.converted !== null) converted += 1;
        expect(json(a), `${input} / ${why}`).toBe(json(b));
      }
    }
    // 빈 결과끼리 같아서 통과하지 않게: 결과가 있는 경우와 변환한 경우를 먼저 센다
    expect(nonEmpty).toBeGreaterThan(inputs.length * 2);
    expect(converted).toBeGreaterThan(0);
    // 두 글자 이상은 새 경로가 아니라 지금 질의다(중간 일치가 빠지지 않는다, T7)
    for (const input of ['빛나', '캣츠', 'DnPt', '별빛나는']) {
      const [a, b] = await Promise.all([staged.search(query(input)), baseline.search(query(input))]);
      expect(json(a), input).toBe(json(b));
      expect(a.items.length, input).toBeGreaterThan(0);
    }
  }, 300_000);

  test('SR-T13 ① 공연명으로만 맞은 공연이 한 글자 입력에서도 나온다', async () => {
    const out = await staged.search(query('큐'));
    expect(ids(out)).toEqual([SPECIAL.prodOnly]);
    expect(out.total).toBe(1);
    expect(json(out)).toBe(json(await baseline.search(query('큐'))));
  });

  test('SR-T13 ① 다른 이름으로만 맞은 공연이 한 글자 입력에서도 한 번 나온다', async () => {
    const out = await staged.search(query('퀴'));
    expect(ids(out)).toEqual([SPECIAL.aliasOnly]);
    expect(out.total).toBe(1);
    expect(new Set(ids(out)).size).toBe(out.items.length);
    expect(json(out)).toBe(json(await baseline.search(query('퀴'))));
  });

  test('SR-T13 ① 아티스트로만 맞은 공연이 한 글자 입력에서도 빠짐없이 나오고 공연명과 함께 맞아도 한 번이다', async () => {
    const out = await staged.search(query('퀀'));
    expect(ids(out).sort()).toEqual([SPECIAL.artistOnly, SPECIAL.multi].sort());
    expect(out.total).toBe(2);
    expect(new Set(ids(out)).size).toBe(out.items.length);
    expect(json(out)).toBe(json(await baseline.search(query('퀀'))));
  });

  test('SR-T13 ① 공연장으로만 맞은 공연이 한 글자 입력에서도 빠짐없이 나온다', async () => {
    const out = await staged.search(query('퀠'));
    expect(ids(out).sort()).toEqual([SPECIAL.placeOnly, SPECIAL.multi].sort());
    expect(out.total).toBe(2);
    expect(new Set(ids(out)).size).toBe(out.items.length);
    expect(json(out)).toBe(json(await baseline.search(query('퀠'))));
  });
});

describe('SR-T13 ① 사전 준비 전·keysOf 없음 fallback(T8)', () => {
  test('SR-T13 ① 사전이 첫 통째로 읽기 전이거나 keysOf가 없으면 지금 질의로 답하고 준비 뒤 새 경로와 응답이 같다', async () => {
    const spy = () => {
      const db = createDatabase({ url: pg.url, applicationName: 'core-svc-bat167-spy', max: 2 });
      const sent: string[] = [];
      db.pool.on('connect', (client) => {
        const original = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = (...a: unknown[]) => {
          const first = a[0] as string | { text?: string };
          const text = typeof first === 'string' ? first : String(first?.text ?? '');
          if (/search_term/.test(text) || /search_document/.test(text)) sent.push(text);
          return original(...a);
        };
      });
      return { db, sent };
    };
    for (const input of ['a', '루']) {
      const want = json(await staged.search(query(input)));
      for (const [why, o] of [
        ['준비 전', { keysOf, ready: () => false }],
        ['keysOf 없음', {}],
      ] as const) {
        const s = spy();
        try {
          const out = await new DrizzleSearchIndex(s.db, ORIGIN, o).search(query(input));
          expect(json(out), `${input} / ${why}`).toBe(want);
          // 모든 단계를 한 질의에 합친 지금 질의 하나이고, 이름 줄만 읽는 첫 질의가 없다
          expect(s.sent.filter((t) => /with hit as/.test(t)).length, `${input} / ${why}`).toBeGreaterThanOrEqual(1);
          expect(s.sent.filter((t) => /distinct t\.kind/.test(t) && !/with hit as/.test(t)), `${input} / ${why}`).toEqual([]);
        } finally {
          await s.db.close();
        }
      }
    }
  }, 120_000);
});

describe('SR-T13 ① 두 읽기의 503(T9)', () => {
  const expectUnavailable = async (input: string, lock: 'search_term' | 'search_document', reason: 'statement-timeout' | 'pool-timeout') => {
    const hold = await admin.pool.connect();
    try {
      await hold.query('begin');
      await hold.query(`lock table ${lock} in access exclusive mode`);
      const err = await staged.search(query(input)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, `${lock} 잠금`).toBeInstanceOf(SearchUnavailable);
      expect((err as SearchUnavailable).reason, `${lock} 잠금`).toBe(reason);
    } finally {
      await hold.query('rollback').catch(() => {});
      hold.release();
    }
  };

  test('SR-T13 ① 한 글자 입력의 첫 이름 줄 읽기와 둘째 공연 줄 읽기 어느 쪽이 질의 상한을 넘어도 SearchUnavailable(statement-timeout)이고 다른 오류가 아니다', async () => {
    // 첫 읽기(search_term): 이름 줄 질의가 잠금을 기다리다 질의 상한(300ms)을 넘는다
    await expectUnavailable('a', 'search_term', 'statement-timeout');
    // 둘째 읽기(search_document): 첫 읽기는 끝나고 공연 줄 질의만 잠금을 기다린다
    await expectUnavailable('a', 'search_document', 'statement-timeout');
  }, 60_000);

  test('SR-T13 ① 검색 전용 묶음이 넘치면(연결 1개·대기 1,500ms) SearchUnavailable(pool-timeout)이다', async () => {
    // 운영 상수(연결 10개·대기 100ms)와 다른 값(BAT-195)
    const small = createDatabase({ url: pg.url, applicationName: 'core-svc-bat167-pool', max: 1, connectionTimeoutMillis: 1_500 });
    try {
      const index = new DrizzleSearchIndex(small, ORIGIN, { keysOf, ready: () => true });
      const held = await small.pool.connect();
      try {
        const err = await index.search(query('a')).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(SearchUnavailable);
        expect((err as SearchUnavailable).reason).toBe('pool-timeout');
      } finally {
        held.release();
      }
    } finally {
      await small.close();
    }
  }, 60_000);

  test('SR-T13 ① 둘째 읽기의 질의 시간 초과는 HTTP 503·Retry-After·no-store·search_pool_saturated 줄이다(다른 5xx가 아니다)', async () => {
    const before = logs.lines().filter((l) => l.event === 'search_pool_saturated').length;
    const hold = await admin.pool.connect();
    try {
      await hold.query('begin');
      await hold.query('lock table search_document in access exclusive mode');
      const r = await svc.http.inject({ method: 'GET', url: '/v1/search?q=a' });
      expect(r.statusCode).toBe(503);
      expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(String(r.headers['content-type'])).toContain('application/problem+json');
    } finally {
      await hold.query('rollback').catch(() => {});
      hold.release();
    }
    const sat = logs.lines().filter((l) => l.event === 'search_pool_saturated').slice(before);
    expect(sat).toHaveLength(1);
    expect(sat[0]).toMatchObject({ event: 'search_pool_saturated', kind: 'security', reason: 'statement-timeout' });
  }, 60_000);
});

describe('SR-T13 ① 동시 검색(T10)', () => {
  test('SR-T13 ① 같은 어댑터에 한 글자 검색 둘을 함께 보내도 각자의 결과가 혼자 보낼 때와 같다', async () => {
    const soloA = await staged.search(query('a'));
    const soloRu = await staged.search(query('루', { page: 2, sort: 'POPULAR' }));
    expect(soloA.total).toBeGreaterThan(0);
    expect(soloRu.total).toBeGreaterThan(0);
    const [gotA, gotRu] = await Promise.all([staged.search(query('a')), staged.search(query('루', { page: 2, sort: 'POPULAR' }))]);
    expect(json(gotA)).toBe(json(soloA));
    expect(json(gotRu)).toBe(json(soloRu));
    const [gotRu2, gotA2] = await Promise.all([staged.search(query('루', { page: 2, sort: 'POPULAR' })), staged.search(query('a'))]);
    expect(json(gotA2)).toBe(json(soloA));
    expect(json(gotRu2)).toBe(json(soloRu));
  }, 60_000);
});
