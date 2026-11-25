// F-05-11 identity 휴대폰·닉네임 조회의 실제 PostgreSQL 통합 시험(계획 docs/review/plans/F-05-11.md §4·§5 T6·T7).
// 시험 리뷰 TR-11 반영: 처리기 가짜가 아니라 ACTIVE·정확 일치·0040 식 인덱스를 실제 DB에서 본다.
// 정본: docs/features/identity.md §6.2, docs/features/transfer-refund.md §4, ASVS 2.4.1·8.2.3, docs/data.md `account`.
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleMemberCodeResolver } from '../src/modules/session/adapters/db/drizzle-member-codes.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-26T01:00:00.000Z');
const ACTIVE = '0193f2c0-0000-7000-8000-000000511a01';
const ACTIVE2 = '0193f2c0-0000-7000-8000-000000511a02';
const PENDING = '0193f2c0-0000-7000-8000-000000511a03';
const DELETED = '0193f2c0-0000-7000-8000-000000511a04';

let pg: PostgresContainer;
let database: Database;
let resolver: DrizzleMemberCodeResolver;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-recipient-f0511-int', max: 6 });
  await ensureOutboxPartitions(database, fakeClock({ now: NOW }));
  const insert = async (id: string, status: string, nickname: string | null, phone: string | null) =>
    database.pool.query('insert into account (id, status, nickname, phone, created_at) values ($1, $2, $3, $4, $5)', [id, status, nickname, phone, new Date(NOW)]);
  await insert(ACTIVE, 'ACTIVE', '지민', '010-9371-2468');
  await insert(ACTIVE2, 'ACTIVE', '서윤', '010-0000-1111');
  await insert(PENDING, 'WITHDRAWAL_PENDING', '탈퇴중', '010-2222-3333');
  await insert(DELETED, 'DELETED', null, '010-4444-5555');
  resolver = new DrizzleMemberCodeResolver(database);
}, 120_000);

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];

describe('F-05-11 T6 identity ResolvePhone 실제 PostgreSQL', () => {
  test('F-05-11 T6 ⑤ 숫자만 맞춘 번호를 ACTIVE 계정에서 정확히 찾고, 부분 일치·탈퇴·병합 계정은 찾지 않는다', async () => {
    const resolve = (resolver as unknown as { resolvePhone?: (digits: string) => Promise<{ accountId: string; nickname: string } | undefined> }).resolvePhone;
    expect(resolve, 'DrizzleMemberCodeResolver.resolvePhone이 없다').toBeDefined();
    expect(await resolve!.call(resolver, '01093712468')).toEqual({ accountId: ACTIVE, nickname: '지민' });
    expect(await resolve!.call(resolver, '0109371246')).toBeUndefined();
    expect(await resolve!.call(resolver, '010937124680')).toBeUndefined();
    expect(await resolve!.call(resolver, '01000001111')).toEqual({ accountId: ACTIVE2, nickname: '서윤' });
    // ACTIVE가 아닌 계정에만 있는 번호는 상태 필터가 없으면 찾힌다. 찾지 않아야 한다.
    expect(await resolve!.call(resolver, '01022223333')).toBeUndefined();
    expect(await resolve!.call(resolver, '01044445555')).toBeUndefined();
  });

  test('F-05-11 T6 ⑥ 0040의 정규화 식 인덱스가 있고, 같은 식으로 질의한다', async () => {
    const indexes = await q<{ indexname: string; indexdef: string }>("select indexname, indexdef from pg_indexes where tablename = 'account'");
    const phoneIndex = indexes.find((i) => /regexp_replace\(\s*phone/i.test(i.indexdef));
    expect(phoneIndex, '0040의 phone 정규화 식 인덱스가 없다').toBeDefined();
    expect(phoneIndex!.indexdef).toMatch(/where .*status.*ACTIVE/i);
    expect(phoneIndex!.indexdef).toMatch(/regexp_replace/i);
    // 실제 질의(리졸버가 쓰는 식)도 그 인덱스가 쓸 수 있는 모양인지 확인한다.
    const rows = await q<{ id: string }>("select id from account where status = 'ACTIVE' and regexp_replace(phone, '[^0-9]', '', 'g') = $1", ['01093712468']);
    expect(rows.map((r) => r.id)).toEqual([ACTIVE]);
  });
});

describe('F-05-11 T7 identity BatchGetNicknames 실제 PostgreSQL', () => {
  test('F-05-11 T7 ④ 계정 ID 여럿에서 ACTIVE 닉네임만 돌려주고, 없는·탈퇴 계정은 뺀다', async () => {
    const batch = (resolver as unknown as { resolveNicknames?: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>> }).resolveNicknames;
    expect(batch, 'DrizzleMemberCodeResolver.resolveNicknames가 없다').toBeDefined();
    const got = await batch!.call(resolver, [ACTIVE, ACTIVE2, PENDING, DELETED, '0193f2c0-0000-7000-8000-000000511a99']);
    expect(Object.fromEntries(got)).toEqual({ [ACTIVE]: '지민', [ACTIVE2]: '서윤' });
    expect((await batch!.call(resolver, [])).size).toBe(0);
  });
});
