// BAT-455 N-T24 통합: 실제 PostgreSQL에서 RecipientQueryService의 받는 사람 묶음(상태·본인확인·언어·이메일).
import 'reflect-metadata';
import { createDatabase, type Database, systemClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { GetRecipients } from '../src/modules/session/application/get-recipients.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-22T00:00:00.000Z');
let pg: PostgresContainer;
let db: Database;
let store: DrizzleSessionStore;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  db = createDatabase({ url: pg.url, applicationName: 'identity-recipients-int', max: 2 });
  store = new DrizzleSessionStore(db, systemClock);
}, 180_000);
afterAll(async () => {
  await db?.close();
  pg?.stop();
});

describe('BAT-455 받는 사람 묶음 조회', () => {
  test('N-T24 ③ 실제 DB에서 상태·본인확인·언어·이메일을 요청 순서대로 준다', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const merged = randomUUID();
    const none = randomUUID();
    await store.transaction((tx) => tx.createAccount({ id: a, email: 'a@example.com', emailVerified: true }, NOW));
    await store.transaction((tx) => tx.createAccount({ id: b, email: 'b@example.com', emailVerified: true }, NOW));
    await store.transaction((tx) => tx.createAccount({ id: merged, email: 'm@example.com', emailVerified: true }, NOW));
    await db.pool.query("update account set locale = 'en' where id = $1", [b]);
    await db.pool.query("insert into identity_verification (account_id, ci_hmac, ci_hmac_key_version, pid, pid_key_version, verified_at, source_record) values ($1, $2, 1, $3, 1, now(), 'int')", [a, Buffer.from('ci-a'), Buffer.from('pid-a')]);
    await store.transaction((tx) => tx.mergeAccounts({ mergeId: randomUUID(), primaryAccountId: a, absorbedAccountId: merged, mergedProvider: 'google', moved: {}, requestedAt: NOW - 1000, now: NOW }));

    const got = await new GetRecipients(store).run({ accountIds: [b, a, merged, none], includeEmail: true });
    expect(got.map((r) => r.accountId)).toEqual([b, a, merged, none]);
    expect(got[0]).toMatchObject({ status: 'ACTIVE', verified: false, locale: 'en', email: 'b@example.com' });
    expect(got[1]).toMatchObject({ status: 'ACTIVE', verified: true, locale: 'ko', email: 'a@example.com' });
    expect(got[2]).toMatchObject({ status: 'MERGED', email: null });
    expect(got[3]).toMatchObject({ status: 'NOT_FOUND', email: null });

    const without = await new GetRecipients(store).run({ accountIds: [a], includeEmail: false });
    expect(without[0]!.email).toBeUndefined();
  });
});
