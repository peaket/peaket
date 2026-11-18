// 자동완성 사전 원천을 읽기 전용 복제본(로컬 PostgreSQL 18 핫 스탠바이, Aurora 읽기 전용 복제본의 대역)에서 읽는다(BAT-165 웨이브 7 T-15, SR-T15 ②).
// 정본: docs/features/search.md §2.3(56줄: 판·바뀐 줄·지운 표시는 같은 복제본에 붙은 한 연결의 한 읽기 전용 REPEATABLE READ 트랜잭션에서, 판을 먼저 읽는다.
// PostgreSQL 18은 복제본에서 직렬화 격리만 막고 REPEATABLE READ는 받는다), :306 SR-T15 ②. Aurora 확인(③)은 AWS 계정 뒤라 여기서 하지 않는다.
// 같은 이미지로 주 서버와 대기 서버를 띄운다(대기는 pg_basebackup -R로 스트리밍 복제). 컨테이너와 망은 끝에 지운다.
import 'reflect-metadata';
import { createDatabase, type Database } from '@peaket/platform';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pgLib from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { event, place, production, promoter } from '../src/modules/catalog/adapters/db/schema.js';
import { DrizzleSearchReadModel } from '../src/modules/catalog/index.js';
import { POSTGRES_IMAGE } from './postgres.js';

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();
const tag = `${process.env.PEAKET_TEST_CONTAINER_PREFIX ?? 'bat165-'}standby-${Math.random().toString(36).slice(2, 8)}`;
const NET = `${tag}-net`;
const PRIMARY = `${tag}-primary`;
const STANDBY = `${tag}-standby`;
const PASSWORD = 'peaket-test';
const NOW = Date.parse('2026-11-16T00:00:00.000Z');
const D = 86_400_000;
let primary: Database;
let standby: Database;
let standbyUrl = '';
const PROMOTER = randomUUID();
const PLACE = randomUUID();

const portOf = (name: string) => {
  const mapped = docker(['port', name, '5432/tcp']).split('\n')[0]!;
  return Number(mapped.slice(mapped.lastIndexOf(':') + 1));
};
const urlOf = (name: string) => `postgres://postgres:${PASSWORD}@127.0.0.1:${portOf(name)}/peaket`;

async function until<T>(what: string, fn: () => Promise<T | undefined>, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) throw new Error(`${what}을(를) 기다리다 시간이 지났다: ${String(last)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function ask(url: string, text: string, values: unknown[] = []) {
  const c = new pgLib.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  await c.connect();
  try {
    return (await c.query(text, values)).rows as Record<string, unknown>[];
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  docker(['network', 'create', NET]);
  docker(['run', '-d', '--rm', '--name', PRIMARY, '--network', NET, '-e', `POSTGRES_PASSWORD=${PASSWORD}`, '-e', 'POSTGRES_DB=peaket', '-p', '127.0.0.1::5432', POSTGRES_IMAGE, '-c', 'wal_level=replica', '-c', 'max_wal_senders=4']);
  const primaryUrl = urlOf(PRIMARY);
  await until('주 서버', async () => ((await ask(primaryUrl, 'select 1 as ok'))[0]?.ok === 1 ? true : undefined));
  docker(['exec', PRIMARY, 'sh', '-c', 'echo "host replication all all scram-sha-256" >> "$PGDATA/pg_hba.conf"']);
  await ask(primaryUrl, 'select pg_reload_conf()');
  await migrateCore(primaryUrl);
  primary = createDatabase({ url: primaryUrl, applicationName: 'core-search-standby-primary', max: 2 });
  await primary.db.insert(promoter).values({ id: PROMOTER, legalName: '(주)에이' });
  await primary.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울', region: '서울', createdBy: PROMOTER });

  docker([
    'run', '-d', '--rm', '--name', STANDBY, '--network', NET, '-e', `PGPASSWORD=${PASSWORD}`, '-p', '127.0.0.1::5432', '--entrypoint', 'sh', POSTGRES_IMAGE, '-c',
    `set -e; mkdir -p "$PGDATA"; chown postgres:postgres "$PGDATA"; chmod 700 "$PGDATA"; gosu postgres pg_basebackup -h ${PRIMARY} -U postgres -D "$PGDATA" -R -X stream; exec gosu postgres postgres -c hot_standby=on`,
  ]);
  standbyUrl = urlOf(STANDBY);
  await until('대기 서버', async () => ((await ask(standbyUrl, 'select pg_is_in_recovery() as r'))[0]?.r === true ? true : undefined));
  standby = createDatabase({ url: standbyUrl, applicationName: 'core-search-standby-reader', max: 2 });
}, 240_000);

afterAll(async () => {
  await standby?.close();
  await primary?.close();
  for (const n of [STANDBY, PRIMARY]) {
    try {
      docker(['rm', '-f', '-v', n]);
    } catch {
      // 이미 멈췄다
    }
  }
  try {
    docker(['network', 'rm', NET]);
  } catch {
    // 이미 없다
  }
});

async function approved(title: string): Promise<string> {
  const id = randomUUID();
  await primary.db.insert(production).values({ id, promoterId: PROMOTER, placeId: PLACE, title, genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date(NOW - 10 * D) });
  await primary.db.insert(event).values({ id: randomUUID(), productionId: id, promoterId: PROMOTER, venueId: null, openAt: new Date(NOW - D), startsAt: new Date(NOW + 20 * D), endsAt: new Date(NOW + 20 * D + 7_200_000) });
  return id;
}

/** 대기 서버가 주 서버의 판까지 따라올 때까지 기다린다 */
async function caughtUp(): Promise<number> {
  const v = Number((await ask(urlOf(PRIMARY), 'select version from search_version where id = 1'))[0]!.version);
  await until('복제 따라잡기', async () => (Number((await ask(standbyUrl, 'select version from search_version where id = 1'))[0]?.version) === v ? true : undefined));
  return v;
}

describe('SR-T15 ② 읽기 전용 복제본', () => {
  test('SR-T15 ② 로컬 PostgreSQL 18 핫 스탠바이에서 REPEATABLE READ 읽기 전용 트랜잭션으로 판·바뀐 줄·지운 표시를 읽는다', async () => {
    // 대조: 정말 대기 서버이고, 직렬화 격리는 거절되며 REPEATABLE READ 읽기 전용은 된다
    expect((await ask(standbyUrl, 'select pg_is_in_recovery() as r'))[0]!.r).toBe(true);
    const c = new pgLib.Client({ connectionString: standbyUrl });
    await c.connect();
    try {
      await expect(
        (async () => {
          await c.query('begin isolation level serializable read only');
          await c.query('select version from search_version');
        })(),
      ).rejects.toThrow(/serializable|hot standby/i);
      await c.query('rollback');
      await c.query('begin isolation level repeatable read read only');
      await expect(c.query('select version from search_version')).resolves.toBeTruthy();
      await c.query('rollback');
    } finally {
      await c.end();
    }

    const sync = new DrizzleSearchReadModel(primary);
    const source = new DrizzleSearchReadModel(standby);
    const p1 = await approved('복제본시험 첫공연');
    const p2 = await approved('복제본시험 둘째공연');
    await primary.transaction((tx) => sync.sync(tx, [p1, p2], new Date(NOW)));
    const v1 = await caughtUp();

    const full = await source.read(null);
    expect(full.version).toBe(v1);
    expect(full.full).toBe(true);
    expect(full.documents.map((d) => d.productionId).sort()).toEqual([p1, p2].sort());
    expect(full.terms.filter((t) => t.kind === 'PRODUCTION').map((t) => t.targetId).sort()).toEqual([p1, p2].sort());
    expect(await source.version()).toBe(v1);

    // 주 서버에서 p2를 빼고(판매 중지) p3를 넣으면, 대기 서버에서 판 v1 뒤의 줄과 지운 표시만 읽는다
    const p3 = await approved('복제본시험 셋째공연');
    await primary.transaction(async (tx) => {
      await tx.update(production).set({ saleReview: 'SUSPENDED' }).where(eq(production.id, p2));
      return sync.sync(tx, [p2, p3], new Date(NOW));
    });
    const v2 = await caughtUp();
    expect(v2).toBe(v1 + 1);
    const inc = await source.read(v1);
    expect(inc.version).toBe(v2);
    expect(inc.full).toBe(false);
    expect(inc.documents.map((d) => d.productionId)).toEqual([p3]);
    expect(inc.terms.map((t) => t.targetId)).toEqual([p3]);
    expect(inc.removals.filter((r) => r.kind === 'DOCUMENT')).toEqual([{ version: v2, kind: 'DOCUMENT', targetId: p2 }]);
    expect(inc.removals.filter((r) => r.kind === 'TERM')).toHaveLength(1);
    // 바뀐 것이 없으면 빈 증분이다
    const none = await source.read(v2);
    expect([none.version, none.documents, none.terms, none.removals]).toEqual([v2, [], [], []]);
  });
});
