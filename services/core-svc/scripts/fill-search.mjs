// 검색 측정(SR-T13 ①, BAT-165 M-1)용 카탈로그 채우기. 공연 N개(기본 1만, 2만도 [가정])를 승인된 상태로 넣고 검색 읽기 모델을 따라잡기로 채운다.
// - 공연·회차·공연장·아티스트·다른 이름은 SQL로 넣고, 읽기 모델(search_document·search_term)은 서버와 같은 동기화 코드(DrizzleSearchReadModel.reconcileAll)로 채운다.
//   그래서 먼저 빌드해 둔다: pnpm --filter @peaket/core-svc build(dist를 읽는다).
// - 이름은 loadtest/scenarios/v1-search.js의 몰림 키(루멘·오로라·은하 …)와 같은 말 조각으로 만들어, 몰림·무작위 입력이 실제 후보를 낸다.
// - 오픈 예정·판매 중·지난 공연을 6:3:1 [가정]로 섞는다. 같은 값을 다시 돌리면 같은 ID라 이미 있는 줄은 건너뛴다.
// - PEAKET_ENV가 local·ci이고 DB 호스트가 localhost·127.0.0.1·::1일 때만 돈다(ADR-0271 결정 21). 그 밖에는 DB에 붙기 전에 멈춘다.
// 쓰는 법: PEAKET_ENV=local PEAKET_DATABASE_URL=postgres://…@127.0.0.1:…/peaket node scripts/fill-search.mjs [--count 10000] [--now 2026-11-16T00:00:00Z]
import { parseArgs } from 'node:util';
import pg from 'pg';

const { values } = parseArgs({ options: { count: { type: 'string', default: '10000' }, now: { type: 'string' } } });
const COUNT = Number(values.count);
if (!Number.isInteger(COUNT) || COUNT < 1 || COUNT > 200_000) throw new Error(`--count는 1~200000 정수다: ${values.count}`);
const NOW = values.now ? Date.parse(values.now) : Date.now();
if (!Number.isFinite(NOW)) throw new Error(`--now가 시각이 아니다: ${values.now}`);
const url = process.env.PEAKET_DATABASE_URL;
if (!url) {
  console.error('PEAKET_DATABASE_URL이 없다');
  process.exit(2);
}
// 환경 확인(ADR-0271 결정 21): 로컬·CI의 로컬 DB에서만 돈다. 덮어쓰는 깃발은 없다. DB에 붙기 전에 멈춘다
const env = process.env.PEAKET_ENV ?? '';
if (env !== 'local' && env !== 'ci') {
  console.error(`PEAKET_ENV가 local·ci가 아니라(${JSON.stringify(env)}) 채우지 않는다. 측정용 채우기는 로컬·CI에서만 돈다`);
  process.exit(2);
}
// 호스트는 실제로 붙을 값으로 본다: pg가 연결 문자열을 해석한 결과(pg-connection-string parse, 쿼리 ?host=가 주소의 호스트를 덮어쓴 값까지)다.
// 여럿(쉼표)·빈 값·소켓 경로(/로 시작)는 멈춘다. 연결은 이 해석 결과로만 만든다(ADR-0271 결정 21 보탬, 리뷰 W7L2-S12)
/** @type {{ host: string; port: number; user: string; password: string; database: string }} */
let target;
try {
  const probe = new pg.Client({ connectionString: url });
  target = { host: String(probe.host ?? ''), port: Number(probe.port), user: String(probe.user ?? ''), password: String(probe.password ?? ''), database: String(probe.database ?? '') };
} catch {
  console.error('PEAKET_DATABASE_URL에서 DB 호스트를 해석하지 못해 채우지 않는다');
  process.exit(2);
}
const host = target.host;
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  console.error(`DB 호스트 ${JSON.stringify(host)}가 로컬(localhost·127.0.0.1·::1)이 아니라 채우지 않는다(여럿·빈 값·소켓 경로도 멈춘다)`);
  process.exit(2);
}
/** 해석 결과로 다시 만든 주소(쿼리 없음). 아래 두 연결 모두 이것만 쓴다 */
const checkedUrl = `postgres://${encodeURIComponent(target.user)}:${encodeURIComponent(target.password)}@${host.includes(':') ? `[${host}]` : host}:${target.port}/${encodeURIComponent(target.database)}`;

const MIN = 60_000;
const DAY = 1440 * MIN;
const WORDS = ['루멘', '오로라', '은하', '별빛', '하늘', '바다', '노을', '새벽', '달빛', '봄날', 'LUMEN', 'AURORA', 'Starry', 'Ocean', 'Dawn'];
const KINDS = ['콘서트', '투어', '뮤지컬', '팬미팅', '페스티벌', '연극', '리사이틀'];
const GENRES = ['콘서트', '뮤지컬', '연극', '클래식', '페스티벌', '팬미팅', '기타'];
const PLACES = 200;
const ARTISTS = 2_000;
/**
 * 정해진 ID(같은 값으로 다시 돌리면 같은 줄)
 * @param {string} prefix
 * @param {number} n
 */
const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROMOTER = id('4f000000', 1);
const ACTOR = id('4f000000', 2);

const client = new pg.Client({ host: target.host, port: target.port, user: target.user, password: target.password, database: target.database });
await client.connect();
try {
  await client.query('begin');
  await client.query(`insert into promoter (id, legal_name) values ($1, '(주)검색측정') on conflict do nothing`, [PROMOTER]);
  for (let i = 0; i < PLACES; i += 100) {
    const rows = Array.from({ length: Math.min(100, PLACES - i) }, (_, k) => i + k);
    await client.query(
      `insert into place (id, name, address, region, created_by) select unnest($1::uuid[]), unnest($2::text[]), '서울', '서울', $3 on conflict do nothing`,
      [rows.map((n) => id('2f000000', n)), rows.map((n) => `${WORDS[n % WORDS.length]}홀 ${n}`), ACTOR],
    );
  }
  for (let i = 0; i < ARTISTS; i += 500) {
    const rows = Array.from({ length: Math.min(500, ARTISTS - i) }, (_, k) => i + k);
    await client.query(`insert into artist (id, name, created_by) select unnest($1::uuid[]), unnest($2::text[]), $3 on conflict do nothing`, [
      rows.map((n) => id('1f000000', n)),
      rows.map((n) => `${WORDS[(n * 7) % WORDS.length]} ${n}`),
      ACTOR,
    ]);
  }
  for (let i = 0; i < COUNT; i += 500) {
    const ns = Array.from({ length: Math.min(500, COUNT - i) }, (_, k) => i + k);
    const prod = ns.map((n) => id('0f000000', n));
    await client.query(
      `insert into production (id, promoter_id, place_id, title, genre, sale_review, sale_approved_at)
       select unnest($1::uuid[]), $2, unnest($3::uuid[]), unnest($4::text[]), unnest($5::text[]), 'APPROVED', $6 on conflict do nothing`,
      [prod, PROMOTER, ns.map((n) => id('2f000000', n % PLACES)), ns.map((n) => `${WORDS[n % WORDS.length]} ${KINDS[n % KINDS.length]} ${n}`), ns.map((n) => GENRES[n % GENRES.length]), new Date(NOW - 30 * DAY)],
    );
    // 오픈 예정 6 : 판매 중 3 : 지난 1 [가정]
    const open = ns.map((n) => (n % 10 < 6 ? NOW + (1 + (n % 30)) * DAY : n % 10 < 9 ? NOW - (1 + (n % 20)) * DAY : NOW - 60 * DAY));
    const start = ns.map((n, k) => (n % 10 < 9 ? open[k] + (20 + (n % 40)) * DAY : NOW - 10 * DAY));
    await client.query(
      `insert into event (id, production_id, promoter_id, venue_id, open_at, starts_at, ends_at)
       select unnest($1::uuid[]), unnest($2::uuid[]), $3, null, unnest($4::timestamptz[]), unnest($5::timestamptz[]), unnest($6::timestamptz[]) on conflict do nothing`,
      [ns.map((n) => id('3f000000', n)), prod, PROMOTER, open.map((t) => new Date(t)), start.map((t) => new Date(t)), start.map((t) => new Date(t + 150 * MIN))],
    );
    await client.query(`insert into production_artist (production_id, artist_id, sort_order) select unnest($1::uuid[]), unnest($2::uuid[]), 0 on conflict do nothing`, [prod, ns.map((n) => id('1f000000', n % ARTISTS))]);
    const aliased = ns.filter((n) => n % 4 === 0);
    await client.query(
      `insert into search_alias (id, target_kind, target_id, alias, source, created_by) select unnest($1::uuid[]), 'PRODUCTION', unnest($2::uuid[]), unnest($3::text[]), 'PARTNER', $4 on conflict do nothing`,
      [aliased.map((n) => id('6f000000', n)), aliased.map((n) => id('0f000000', n)), aliased.map((n) => `${WORDS[(n + 3) % WORDS.length]} ${n} 다른이름`), ACTOR],
    );
  }
  await client.query('commit');
} catch (e) {
  await client.query('rollback').catch(() => {});
  throw e;
} finally {
  await client.end();
}

// 읽기 모델은 서버와 같은 동기화 코드로 채운다(시작 따라잡기, ADR-0271 결정 12)
const { createDatabase } = await import('@peaket/platform');
// 빌드 결과(dist)는 이 스크립트를 돌리기 직전에 만든다. 타입 검사가 빌드 전 dist를 읽지 않게 경로를 값으로 넘긴다
const catalogModule = '../dist/modules/catalog/index.js';
const { DrizzleSearchReadModel } = /** @type {{ DrizzleSearchReadModel: new (db: unknown) => { reconcileAll(at: Date): Promise<{ ran: boolean; productions: number; version: number | null }> } }} */ (await import(catalogModule));
const database = createDatabase({ url: checkedUrl, applicationName: 'core-svc-fill-search', max: 2 });
try {
  const started = Date.now();
  const r = await new DrizzleSearchReadModel(database).reconcileAll(new Date(NOW));
  if (!r.ran) throw new Error('다른 프로세스가 따라잡기 잠금을 쥐고 있다. 서버를 내리고 다시 돌린다');
  console.log(`공연 ${COUNT}개를 넣고 읽기 모델 ${r.productions}개를 채웠다(판 ${r.version}, ${Date.now() - started}ms)`);
} finally {
  await database.close();
}
