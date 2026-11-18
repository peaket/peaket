// BAT-166 구현 뒤 통합 시험(실제 PostgreSQL 18, 계획 docs/review/plans/BAT-166.md §4 A1~A5).
// 정본: ADR-0271 결정 14(시작 따라잡기도 준비 확인에 넣지 않는다: 그동안 /ready 200, 검색은 표에 있는 줄로, 자동완성은 빈 후보·no-store·dictionaryVersion 0,
// 차례는 따라잡기 → 사전 첫 읽기 → 주기 일), 결정 22(후보 질의는 갈래마다, 공연 줄마다 되풀이되는 SubPlan 없음, 한 공연은 한 번),
// 결정 23(이름 비교 값을 요청마다 후보 전체에 다시 만들지 않는다, 캐시는 옛 이름으로 맞지 않게), docs/features/search.md §7.2(244줄: 연결 10개·대기 100ms·질의 상한 300ms, 넘치면 503),
// §10(275줄: 게이지 search_pool_waiting), SR-T13 ①(306줄), SR-T4(297줄: 'LUMEN'은 바꾸지 않는다), §3.2 ④, docs/data.md:2954 '공연 검색' 줄.
// 공연 2,000개 [가정](아티스트 200·공연장 20)는 아티스트로만 맞는 공연이 많게 채운다(계획 A1).
import 'reflect-metadata';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as normalizePkg from '@peaket/search-normalize';
import { createDatabase, createService, type Database, ensureOutboxPartitions, systemClock, type Clock } from '@peaket/platform';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleSearchIndex, DrizzleSearchReadModel, registerSearchPoolWaiting, SearchCatalog, SearchUnavailable } from '../src/modules/catalog/index.js';
import { production } from '../src/modules/catalog/adapters/db/schema.js';
import type { SearchQuery } from '../src/modules/catalog/domain/search.js';
import { FakeIdentity, quiet, testMedia } from '../test/support.js';
import { buildDist, freePort, logLines, SERVICE_DIR, until } from './media-support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { ensureSearchLogin, loginFor } from './roles.js';

// 이름 비교 값을 새로 만든 호출을 센다(동작은 그대로 넘긴다). core-svc가 부른 것만 세진다(패키지 안의 호출은 세지 않는다)
vi.mock(import('@peaket/search-normalize'), async (orig) => {
  const m = await orig();
  return { ...m, nameKeys: vi.fn(m.nameKeys), indexNames: vi.fn(m.indexNames) as typeof m.indexNames, indexName: vi.fn(m.indexName) as typeof m.indexName };
});

type Svc = Awaited<ReturnType<typeof createService>>;
let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let opsDb: Database;
let svc: Svc;
let model: DrizzleSearchReadModel;
const now = Date.parse('2026-11-18T00:00:00.000Z');
const clock: Clock = { now: () => now, monotonicMs: () => performance.now() };
const H = 3_600_000;
const D = 24 * H;
const PROMOTER = randomUUID();
const ACTOR = randomUUID();
const pad = (n: number, w: number) => String(n).padStart(w, '0');

const PLACES = Array.from({ length: 20 }, () => randomUUID());
const ARTISTS = Array.from({ length: 200 }, () => randomUUID());
const BULK = 2_000;
const BULK_IDS = Array.from({ length: BULK }, () => randomUUID());

const query = (q: string, o: Partial<SearchQuery> = {}): SearchQuery => ({ q, includePast: false, noConvert: false, page: 1, now: new Date(now), ...o });

/** 공연 하나(회차 하나, 판매 중). 아티스트는 차례대로 sort_order 0, 1, 2 … */
async function addProduction(o: { title: string; placeId?: string | null; artists?: string[]; alias?: string }): Promise<string> {
  const id = randomUUID();
  await admin.pool.query(`insert into production (id, promoter_id, place_id, title, genre, sale_review, sale_approved_at) values ($1, $2, $3, $4, '콘서트', 'APPROVED', $5)`, [
    id,
    PROMOTER,
    o.placeId === undefined ? PLACES[0] : o.placeId,
    o.title,
    new Date(now - 10 * D),
  ]);
  await admin.pool.query(`insert into event (id, production_id, promoter_id, venue_id, open_at, starts_at, ends_at) values ($1, $2, $3, null, $4, $5, $6)`, [
    randomUUID(),
    id,
    PROMOTER,
    new Date(now - D),
    new Date(now + 20 * D),
    new Date(now + 20 * D + 2 * H),
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

// A2의 갈래별 경우(정본 결정 22: 공연명·다른 이름·공연장·아티스트 갈래, 한 공연은 한 번)
const CASE: Record<string, string[]> = {};

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-bat166', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 4);
  opsDb = await loginFor(admin, pg, 'core_ops_login', 'core_ops', 4);
  model = new DrizzleSearchReadModel(admin, 'https://img.test');
  await admin.pool.query(`insert into promoter (id, legal_name) values ($1, '(주)BAT166')`, [PROMOTER]);
  await admin.pool.query(`insert into place (id, name, address, region, created_by) select unnest($1::uuid[]), unnest($2::text[]), '서울', '서울', $3`, [PLACES, PLACES.map((_, i) => `공연장${pad(i, 2)}`), ACTOR]);
  await admin.pool.query(`insert into artist (id, name, created_by) select unnest($1::uuid[]), unnest($2::text[]), $3`, [ARTISTS, ARTISTS.map((_, i) => `아티스트${pad(i, 3)}`), ACTOR]);
  // 공연 2,000개: 공연 n은 공연장 n % 20, 아티스트 n % 200(아티스트마다 공연 10개, 공연장마다 100개)
  for (let i = 0; i < BULK; i += 500) {
    const ns = Array.from({ length: Math.min(500, BULK - i) }, (_, k) => i + k);
    const ids = ns.map((n) => BULK_IDS[n]!);
    await admin.pool.query(
      `insert into production (id, promoter_id, place_id, title, genre, sale_review, sale_approved_at) select unnest($1::uuid[]), $2, unnest($3::uuid[]), unnest($4::text[]), '콘서트', 'APPROVED', $5`,
      [ids, PROMOTER, ns.map((n) => PLACES[n % 20]!), ns.map((n) => `일반 공연 ${n}`), new Date(now - 10 * D)],
    );
    await admin.pool.query(
      `insert into event (id, production_id, promoter_id, venue_id, open_at, starts_at, ends_at) select unnest($1::uuid[]), unnest($2::uuid[]), $3, null, $4, $5, $6`,
      [ns.map(() => randomUUID()), ids, PROMOTER, new Date(now - D), new Date(now + 20 * D), new Date(now + 20 * D + 2 * H)],
    );
    await admin.pool.query(`insert into production_artist (production_id, artist_id, sort_order) select unnest($1::uuid[]), unnest($2::uuid[]), 0`, [ids, ns.map((n) => ARTISTS[n % 200]!)]);
  }
  // 갈래별 경우
  const third = await addArtist('별무리셋');
  CASE['별무리셋'] = [await addProduction({ title: '일반 셋째 아티스트 공연', artists: [ARTISTS[0]!, ARTISTS[1]!, third] })];
  const shared = await addArtist('공유가수');
  CASE['공유가수'] = [await addProduction({ title: '일반 공유 하나', artists: [shared] }), await addProduction({ title: '일반 공유 둘', artists: [shared] }), await addProduction({ title: '일반 공유 셋', artists: [shared] })];
  CASE['무아티스트'] = [await addProduction({ title: '무아티스트 공연', artists: [] })];
  const alone = await addPlace('단독홀');
  CASE['단독홀'] = [await addProduction({ title: '일반 단독 하나', placeId: alone }), await addProduction({ title: '일반 단독 둘', placeId: alone })];
  CASE['숨은이름'] = [await addProduction({ title: '일반 다른 이름만', alias: '숨은이름' })];
  const overlap = await addArtist('겹침가수');
  CASE['겹침가수'] = [await addProduction({ title: '겹침가수 투어', artists: [overlap] }), await addProduction({ title: '일반 겹침 아티스트만', artists: [overlap] })];
  // 읽기 모델은 서버와 같은 따라잡기로 채운다
  const r = await model.reconcileAll(new Date(now));
  expect(r.ran).toBe(true);
  await admin.pool.query('analyze');
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, opsDatabase: opsDb, media: testMedia() }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
}, 300_000);

afterAll(async () => {
  await svc?.close();
  for (const d of [appDb, partnerDb, opsDb, admin]) await d?.close();
  pg?.stop();
});

const ids = (items: { productionId: string }[]) => items.map((x) => x.productionId);

type PlanNode = { 'Node Type': string; 'Parent Relationship'?: string; 'Subplan Name'?: string; 'Actual Loops'?: number; Plans?: PlanNode[] };
const walk = (n: PlanNode, out: PlanNode[] = []): PlanNode[] => {
  out.push(n);
  for (const c of n.Plans ?? []) walk(c, out);
  return out;
};

describe('A1·A2 후보 질의 모양(ADR-0271 결정 22)', () => {
  test('SR-T13 ① 후보 검색 질의에 공연마다 되풀이되는 하위 계획이 없다', async () => {
    const searchDb = createDatabase({ url: pg.url, applicationName: 'core-svc-bat166-explain', max: 2 });
    // 어댑터가 실제로 보낸 후보 질의(이름 줄 hit와 search_document가 함께 든 것)의 글과 값을 잡는다
    const sent: { text: string; values: unknown[] }[] = [];
    searchDb.pool.on('connect', (client) => {
      const q = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
      (client as unknown as { query: unknown }).query = (...a: unknown[]) => {
        const first = a[0] as string | { text?: string; values?: unknown[] };
        const text = typeof first === 'string' ? first : String(first?.text ?? '');
        // 값은 설정 객체에 들거나 둘째 인자로 온다
        const values = (typeof first === 'string' ? a[1] : (first?.values ?? (Array.isArray(a[1]) ? a[1] : undefined))) as unknown[] | undefined;
        if (/search_term/.test(text) && /search_document/.test(text)) sent.push({ text, values: values ?? [] });
        return q(...a);
      };
    });
    try {
      const index = new DrizzleSearchIndex(searchDb, 'https://img.test');
      // 아티스트 이름으로 맞는 것(공연 10개)과 공연장 이름으로 맞는 것(공연 100개)
      for (const [input, want] of [
        ['아티스트007', 10],
        ['공연장07', 100],
      ] as const) {
        sent.length = 0;
        const out = await index.search(query(input));
        // 빈 결과로 통과하지 않게 결과 수를 먼저 본다
        expect(out.total, input).toBe(want);
        expect(sent.length, `${input}: 잡은 후보 질의`).toBeGreaterThanOrEqual(1);
        for (const s of sent) {
          const res = await admin.pool.query(`explain (analyze, format json) ${s.text}`, s.values);
          const plan = (res.rows[0] as { 'QUERY PLAN': { Plan: PlanNode }[] })['QUERY PLAN'][0]!.Plan;
          const all = walk(plan);
          expect(all.length).toBeGreaterThan(1);
          // 부모 관계가 SubPlan인 노드는 한 번까지만 돈다(InitPlan은 된다). 공연 줄마다 돌면 Actual Loops가 공연 수다
          const repeated = all.filter((n) => n['Parent Relationship'] === 'SubPlan' && (n['Actual Loops'] ?? 0) > 1).map((n) => `${n['Subplan Name'] ?? ''} ${n['Node Type']} loops=${n['Actual Loops']}`);
          expect(repeated, input).toEqual([]);
        }
      }
    } finally {
      await searchDb.close();
    }
  });

  test('SR-T13 ① 아티스트·공연장·공연명·다른 이름 어느 갈래로만 맞은 공연과 여러 갈래로 맞은 공연이 빠짐·겹침 없이 한 번씩 나온다', async () => {
    const index = new DrizzleSearchIndex(admin, 'https://img.test');
    for (const [input, want] of Object.entries(CASE)) {
      const out = await index.search(query(input));
      expect(ids(out.items).sort(), input).toEqual([...want].sort());
      expect(out.total, input).toBe(want.length);
      expect(new Set(ids(out.items)).size, `${input}: 겹침`).toBe(out.items.length);
    }
    // 여러 공연이 함께 쓰는 아티스트(공연 10개)와 공연장(공연 100개, 쪽마다 20개)도 빠짐·겹침이 없다
    const artist = await index.search(query('아티스트007'));
    expect(ids(artist.items).sort()).toEqual(BULK_IDS.filter((_, n) => n % 200 === 7).sort());
    const seen: string[] = [];
    for (let page = 1; page <= 5; page++) seen.push(...ids((await index.search(query('공연장07', { page }))).items));
    expect(seen.sort()).toEqual(BULK_IDS.filter((_, n) => n % 20 === 7).sort());
  });
});

describe('A3 처리기 계산 줄이기(ADR-0271 결정 23)', () => {
  const fresh = () => {
    const nk = vi.mocked(normalizePkg.nameKeys).mock.calls.length;
    const ix = vi.mocked(normalizePkg.indexNames).mock.calls.reduce((s, c) => s + [...(c[0] as readonly { aliases: readonly string[] }[])].reduce((t, i) => t + 1 + i.aliases.length, 0), 0);
    const one = vi.mocked(normalizePkg.indexName).mock.calls.length;
    return nk + ix + one;
  };
  const clear = () => {
    for (const f of [normalizePkg.nameKeys, normalizePkg.indexNames, normalizePkg.indexName]) vi.mocked(f).mockClear();
  };

  test('SR-T13 ① 사전이 준비된 뒤의 검색은 후보 공연마다 이름 비교 값을 새로 만들지 않는다(서비스 조립이 사전 값을 넘긴다)', async () => {
    await svc.app.get(SearchCatalog).dictionary.refresh();
    clear();
    const r = await svc.http.inject({ method: 'GET', url: `/v1/search?q=${encodeURIComponent('아티스트007')}` });
    expect(r.statusCode).toBe(200);
    // 후보 10개(이름 셋씩: 공연명·공연장·아티스트)를 다 만들면 30이다. 걸린 이름 줄 수(1) 이하
    expect((JSON.parse(r.payload) as { total: number }).total).toBe(10);
    expect(fresh()).toBeLessThanOrEqual(1);
  });

  test('SR-T13 ① 이름이 바뀐 공연은 새 이름으로만 맞고 옛 이름으로는 0건이다(사전을 다시 읽기 전과 뒤 모두)', async () => {
    const id = await addProduction({ title: '옛이름전시회 공연', artists: [] });
    await admin.transaction((tx) => model.sync(tx, [id], new Date(now)));
    const dict = svc.app.get(SearchCatalog).dictionary;
    await dict.refresh();
    const found = async (q: string) => {
      const r = await svc.http.inject({ method: 'GET', url: `/v1/search?q=${encodeURIComponent(q)}` });
      expect(r.statusCode).toBe(200);
      return ids((JSON.parse(r.payload) as { items: { productionId: string }[] }).items);
    };
    expect(await found('옛이름전시회')).toEqual([id]);
    await admin.db.update(production).set({ title: '새이름박람회 공연' }).where(eq(production.id, id));
    await admin.transaction((tx) => model.sync(tx, [id], new Date(now)));
    // 사전은 아직 옛 판(10초 주기 일 전)
    expect(await found('새이름박람회')).toEqual([id]);
    expect(await found('옛이름전시회')).toEqual([]);
    await dict.refresh();
    expect(await found('새이름박람회')).toEqual([id]);
    expect(await found('옛이름전시회')).toEqual([]);
  });
});

describe('SR-T4 PostgreSQL 어댑터의 query.converted(§3.2 ④)', () => {
  test("SR-T4 PostgreSQL 어댑터도 로마자 이름이 그대로 맞으면('LUMEN') query.converted가 null이고, 소문자로 바꿔 찾았으면 그 값('DnPt' → '웻')이다", async () => {
    const lumen = await addProduction({ title: '루멘로마자 공연', artists: [], alias: 'LUMEN' });
    const wet = await addProduction({ title: '웻 로마자 공연', artists: [] });
    await admin.transaction((tx) => model.sync(tx, [lumen, wet], new Date(now)));
    const get = async (q: string) => {
      const r = await svc.http.inject({ method: 'GET', url: `/v1/search?q=${encodeURIComponent(q)}` });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.payload) as { items: { productionId: string }[]; query: { converted?: unknown } };
      return { ids: ids(body.items), converted: body.query.converted };
    };
    expect(await get('LUMEN')).toEqual({ ids: [lumen], converted: null });
    expect(await get('DnPt')).toEqual({ ids: [wet], converted: { from: 'DnPt', to: '웻' } });
  });
});

describe('A4 게이지 search_pool_waiting', () => {
  test('SR-T13 ① 게이지 search_pool_waiting은 검색 전용 연결을 기다리는 요청 수이고 대기가 풀리면 0이며, 대기 한도를 넘긴 요청은 SearchUnavailable(pool-timeout)이다', async () => {
    // 묶음 크기 2·대기 1,500ms(운영 상수 10·100ms와 다르게)
    const searchDb = createDatabase({ url: pg.url, applicationName: 'core-svc-bat166-pool', max: 2, connectionTimeoutMillis: 1_500 });
    registerSearchPoolWaiting(svc.metrics.registry, searchDb.pool);
    const gauge = async () => Number(/^search_pool_waiting (\d+)$/m.exec(await svc.metrics.registry.metrics())?.[1] ?? 'NaN');
    const index = new DrizzleSearchIndex(searchDb, 'https://img.test');
    try {
      expect(await gauge()).toBe(0);
      const held = [await searchDb.pool.connect(), await searchDb.pool.connect()];
      const waiting = [index.search(query('아티스트007')), index.search(query('아티스트007')), index.search(query('아티스트007'))];
      await until(async () => (await gauge()) === 3, '기다리는 검색 셋', 1_000, 10);
      for (const c of held) c.release();
      for (const out of await Promise.all(waiting)) expect(out.total).toBe(10);
      expect(await gauge()).toBe(0);
      // 대기 한도를 넘기면 pool-timeout이고 그 뒤 0이다
      const held2 = [await searchDb.pool.connect(), await searchDb.pool.connect()];
      try {
        const late = index.search(query('아티스트007')).then(
          () => undefined,
          (e: unknown) => e,
        );
        await until(async () => (await gauge()) === 1, '기다리는 검색 하나', 1_000, 10);
        const err = await late;
        expect(err).toBeInstanceOf(SearchUnavailable);
        expect((err as SearchUnavailable).reason).toBe('pool-timeout');
        expect(await gauge()).toBe(0);
      } finally {
        for (const c of held2) c.release();
      }
    } finally {
      await searchDb.close();
    }
  });
});

describe('A5 시작 파일(main.ts) 조립', () => {
  let child: ChildProcess;
  let exited: Promise<number | null>;
  let text = '';
  let port = 0;
  let mgmt = 0;
  let dir = '';
  let probe: string;
  let hold: import('pg').PoolClient | undefined;
  const app = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
  const metric = async () => Number(/^search_pool_waiting (\d+)$/m.exec(await (await fetch(`http://127.0.0.1:${mgmt}/metrics`)).text())?.[1] ?? 'NaN');
  const lines = (event: string) => logLines(text).filter((l) => l.event === event);

  beforeAll(async () => {
    buildDist();
    // 표에 이미 있는 공연(따라잡기 전에도 검색이 답하는지 본다)
    probe = await addProduction({ title: '따라잡기대조 공연', artists: [] });
    await admin.transaction((tx) => model.sync(tx, [probe], new Date(now)));
    // 시작 따라잡기의 첫 끊음을 붙잡는다: 끊음은 권고 잠금을 시도로 잡은 뒤 search_version 줄을 for update로 읽는다. 그 줄을 열린 트랜잭션에서 쥔다
    hold = await admin.pool.connect();
    await hold.query('begin');
    await hold.query('select 1 from search_version where id = 1 for update');
    [port, mgmt] = [await freePort(), await freePort()];
    dir = await mkdtemp(join(tmpdir(), 'peaket-bat166-'));
    const base: Record<string, string> = {};
    for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[k]) base[k] = process.env[k]!;
    const env = {
      ...base,
      PEAKET_ENV: 'local',
      PORT: String(port),
      PEAKET_MANAGEMENT_PORT: String(mgmt),
      PEAKET_DATABASE_URL: pg.urlFor('core_app_login', 'peaket-test'),
      PEAKET_PARTNER_DATABASE_URL: pg.urlFor('core_partner_login', 'peaket-test'),
      PEAKET_SEARCH_DATABASE_URL: await ensureSearchLogin(admin, pg),
      PEAKET_OPS_DATABASE_URL: pg.urlFor('core_ops_login', 'peaket-test'),
      PEAKET_IDENTITY_GRPC_URL: '127.0.0.1:1',
      PEAKET_IMAGE_GRPC_URL: '127.0.0.1:1',
      PEAKET_SEATMAP_GRPC_URL: '127.0.0.1:1',
      PEAKET_IMAGE_BASE_URL: 'http://127.0.0.1:1',
      PEAKET_IMAGE_STORE_DIR: dir,
      PEAKET_PUBLIC_FILE_DIR: join(dir, 'public-files'),
    };
    child = spawn(process.execPath, ['dist/main.js'], { cwd: SERVICE_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', (d) => (text += String(d)));
    child.stderr!.on('data', (d) => (text += String(d)));
    exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
    await until(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${mgmt}/ready`)).status === 200;
        } catch {
          return false;
        }
      },
      `core-svc 준비: ${text.slice(-500)}`,
      60_000,
      200,
    );
  }, 300_000);

  afterAll(async () => {
    if (hold) {
      await hold.query('rollback').catch(() => {});
      hold.release();
    }
    child?.kill();
    await exited;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('HOT-270 시작 따라잡기가 도는 동안 /ready는 200이고 검색은 답하며 자동완성은 빈 후보·no-store다(ADR-0271 결정 14)', async () => {
    // 따라잡기가 실제로 붙잡혀 있다(끝났다는 줄이 없다). 1초 지켜본다
    await new Promise((r) => setTimeout(r, 1_000));
    expect(lines('search_reconciled')).toEqual([]);
    expect((await fetch(`http://127.0.0.1:${mgmt}/ready`)).status).toBe(200);
    const s = await app(`/v1/search?q=${encodeURIComponent('따라잡기대조')}`);
    expect(s.status).toBe(200);
    expect(ids(((await s.json()) as { items: { productionId: string }[] }).items)).toEqual([probe]);
    const sug = await app(`/v1/search/suggestions?q=${encodeURIComponent('따라잡기대조')}`);
    expect(sug.status).toBe(200);
    expect(sug.headers.get('cache-control')).toContain('no-store');
    expect(((await sug.json()) as { items: unknown[] }).items).toEqual([]);
    await until(() => lines('search_suggest').length > 0, 'search_suggest 줄', 2_000);
    expect(lines('search_suggest').at(-1)).toMatchObject({ candidates: 0, dictionaryVersion: 0 });
    expect(lines('search_reconciled')).toEqual([]);
    // 잠금을 풀면 따라잡기가 끝나고, 그 뒤 사전 첫 읽기를 거쳐 자동완성이 후보를 낸다(대조군)
    await hold!.query('commit');
    hold!.release();
    hold = undefined;
    await until(() => lines('search_reconciled').some((l) => l.ran === true), `search_reconciled: ${text.slice(-500)}`, 30_000, 100);
    await until(
      async () => {
        const r = await app(`/v1/search/suggestions?q=${encodeURIComponent('따라잡기대조')}`);
        return r.status === 200 && ((await r.json()) as { items: unknown[] }).items.length > 0;
      },
      '자동완성 후보',
      30_000,
      200,
    );
    const ready = await app(`/v1/search/suggestions?q=${encodeURIComponent('따라잡기대조')}`);
    expect(ready.headers.get('cache-control')).not.toContain('no-store');
  }, 120_000);

  test('SR-T13 ① 시작 조립(main.ts)이 search_pool_waiting을 관리 포트에 낸다(검색 전용 묶음이 넘칠 때 0이 아니고 503, 풀리면 0)', async () => {
    expect(await metric()).toBe(0);
    // 검색 표를 잠가 검색 질의가 연결을 쥔 채 기다리게 한다(질의 상한 300ms 뒤 풀림). 그동안 계속 보내 검색 전용 묶음(연결 10개)을 넘친다
    const lock = await admin.pool.connect();
    const sent: Promise<number>[] = [];
    let max = 0;
    try {
      await lock.query('begin');
      await lock.query('lock table search_document in access exclusive mode');
      const until2 = Date.now() + 1_500;
      while (Date.now() < until2) {
        for (let i = 0; i < 5; i++) sent.push(app(`/v1/search?q=${encodeURIComponent('따라잡기대조')}`).then((r) => r.status, () => -1));
        max = Math.max(max, await metric());
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      await lock.query('commit');
      lock.release();
    }
    const statuses = await Promise.all(sent);
    // 기본 core_app 묶음에 붙였다면 여기는 0이다
    expect(max).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((s) => s === 503).length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((s) => s !== 200 && s !== 503)).toEqual([]);
    await until(async () => (await metric()) === 0, '대기 0', 5_000, 50);
  }, 120_000);
});
