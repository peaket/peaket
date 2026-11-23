// postgres_exporter의 쿼리 통계(V-T50 ⑤, docs/verification.md V-T50, docs/observability.md §8 '쿼리 통계 예외', ADR-0067). 계획 docs/review/plans/F-01-4.md §6.
// pg_stat_statements를 켠 PostgreSQL 18과 pg_monitor 역할만 가진 모니터링 계정을 두고, 서로 다른 쿼리를 상위 한도보다 많이(상수에 이메일 꼴 값,
// 쿼리마다 다른 실행 횟수) 돌린다. 원천 deploy/platform/observability/exporters/postgres-exporter.yaml의 image·args로 띄운 exporter의 노출 지표 원문에
// queryid 라벨이 있고, 서로 다른 queryid가 상위 한도(정본에서 읽음) 이하이며, query 라벨과 넣은 상수·쿼리 문장이 원문 바이트 어디에도 없는지 본다.
// 가짜 없음: PostgreSQL·exporter는 실제 이미지다.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createNetwork, parseYaml, POSTGRES_EXPORTER_IMAGE, POSTGRES_IMAGE, readRepo, startContainer, until, type Container, type Network } from './observability-stores.js';

/** docs/observability.md §8 '쿼리 통계 예외'의 상위 N */
function canonTop(): number {
  const line = readRepo('docs/observability.md').split(/\r?\n/).find((l) => /^- 쿼리 통계 예외/.test(l));
  const n = Number(/상위\s*(\d+)\s*개/.exec(line ?? '')?.[1]);
  if (!Number.isInteger(n) || n <= 0) throw new Error("docs/observability.md §8 '쿼리 통계 예외'에서 상위 N을 읽지 못했다");
  return n;
}
/** 서로 다른 쿼리 수 [제안 25, 계획 §6](상위 한도보다 많다) */
const QUERIES = 25;
const EMAIL = 'kim@example.com';
const SUPER = 'peaket-it-super';
const MONITOR = { user: 'peaket_monitor', password: `m-${randomBytes(6).toString('hex')}` };

let net: Network;
let db: Container | undefined;
let exporter: Container | undefined;
let superUrl = '';
beforeAll(async () => {
  net = createNetwork();
  db = startContainer({
    image: POSTGRES_IMAGE,
    network: net,
    alias: 'peaket-pg',
    ports: [5432],
    env: { POSTGRES_PASSWORD: SUPER, POSTGRES_DB: 'peaket' },
    args: ['postgres', '-c', 'shared_preload_libraries=pg_stat_statements'],
  });
  superUrl = `postgres://postgres:${SUPER}@${db.url(5432).slice('http://'.length)}/peaket`;
  // 이미지의 초기화 스크립트가 서버를 한 번 다시 띄우므로 질의가 될 때까지 다시 본다
  await until('PostgreSQL 준비', 90_000, async () => {
    const c = new pg.Client({ connectionString: superUrl, connectionTimeoutMillis: 2000 });
    try {
      await c.connect();
      await c.query('select 1');
      return true;
    } finally {
      await c.end().catch(() => {});
    }
  }, (ok) => ok, db);
}, 180_000);
afterAll(() => {
  exporter?.stop();
  db?.stop();
  net?.remove();
});

test('V-T50 ⑤ postgres_exporter는 queryid만 달고 상위 20개만 내며 쿼리 문장이 없다', async () => {
  const top = canonTop();
  expect(QUERIES).toBeGreaterThan(top);
  const c = new pg.Client({ connectionString: superUrl });
  await c.connect();
  try {
    await c.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    await c.query(`CREATE ROLE ${MONITOR.user} LOGIN PASSWORD '${MONITOR.password}'`);
    await c.query(`GRANT pg_monitor TO ${MONITOR.user}`);
    for (let i = 1; i <= QUERIES; i++) {
      await c.query(`CREATE TABLE probe_${i} (email text)`);
      await c.query(`INSERT INTO probe_${i} SELECT '${EMAIL}' FROM generate_series(1, ${i})`);
    }
    // 서로 다른 쿼리 QUERIES개(표가 달라 queryid가 다르다), 쿼리 i는 i번. 상수는 글자 그대로 넣는다
    for (let i = 1; i <= QUERIES; i++) for (let k = 0; k < i; k++) await c.query(`SELECT count(*) FROM probe_${i} WHERE email = '${EMAIL}'`);
  } finally {
    await c.end();
  }

  // 원천의 image·args 그대로. 접속 주소는 환경 변수로만 준다
  const source = parseYaml(readRepo('deploy/platform/observability/exporters/postgres-exporter.yaml')) as { image: string; args: string[] };
  expect(source.image).toBe(POSTGRES_EXPORTER_IMAGE);
  exporter = startContainer({
    image: source.image,
    network: net,
    ports: [9187],
    env: { DATA_SOURCE_NAME: `postgresql://${MONITOR.user}:${MONITOR.password}@peaket-pg:5432/peaket?sslmode=disable` },
    args: source.args,
  });
  const queryidLines = (text: string) => text.split('\n').filter((l) => !l.startsWith('#') && /[{,]queryid="/.test(l));
  const text = await until('queryid 시계열', 90_000, async () => (await fetch(`${exporter!.url(9187)}/metrics`)).text(), (t) => queryidLines(t).length > 0, exporter);

  const ids = new Set(queryidLines(text).map((l) => /queryid="([^"]*)"/.exec(l)![1]));
  expect(ids.size).toBeGreaterThanOrEqual(1);
  expect(ids.size).toBeLessThanOrEqual(top);
  // query 라벨 0, 넣은 상수와 쿼리 문장은 원문 바이트 어디에도 없다
  expect(text.split('\n').filter((l) => /[{,]query="/.test(l))).toEqual([]);
  for (const needle of [EMAIL, '@example.com', 'SELECT count', 'WHERE email']) expect(text.includes(needle), needle).toBe(false);
}, 240_000);
