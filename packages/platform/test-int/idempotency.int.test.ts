// 멱등 기록의 실제 PostgreSQL 시험(openspec 변경 add-idempotency-and-outbox 결정 6, BUILD_ORDER FND-080, docs/api/guidelines.md §4, ADR-0146 결정 1).
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  IDEMPOTENCY_WAIT_MS,
  IdempotencyStore,
  ProblemError,
  createDatabase,
  deleteExpiredIdempotencyRecords,
  fakeClock,
  requestFingerprint,
  type Database,
  type DbTransaction,
  type IdempotencyRequest,
} from '../src/index.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

let pgc: PostgresContainer;
let database: Database;
const clock = fakeClock({ now: Date.parse('2026-11-01T03:00:00Z') });
// 시험 시간을 줄이려고 기다림을 300ms로 둔다(기본값 1초는 아래 상수 시험이 본다)
const store = new IdempotencyStore({ clock, waitMs: 300 });

beforeAll(async () => {
  pgc = await startPostgres();
  const admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  // 서비스 뼈대의 마이그레이션(작업 목록 CREATE_NOTE)을 그대로 쓰고, 시험용 작업 이름을 CHECK에 더한다
  await admin.query(readFileSync(new URL('../template/migrations/0001_idempotency_record.sql', import.meta.url), 'utf8'));
  await admin.query(`
    alter table idempotency_record drop constraint idempotency_record_operation_check;
    alter table idempotency_record add constraint idempotency_record_operation_check check (operation in ('CREATE_NOTE', 'CREATE_ITEM'));
    create table item (id text primary key, account text not null, v text not null);`);
  await admin.end();
  database = createDatabase({ url: pgc.url, applicationName: 'idem-int' });
}, 120_000);

afterAll(async () => {
  await database?.close();
  pgc?.stop();
});

beforeEach(async () => {
  await database.db.execute(sql`truncate idempotency_record, item`);
});

const KEY = '0190f3a1-7c2e-4a00-8000-000000000001';
const req = (body: string, o: Partial<IdempotencyRequest> = {}): IdempotencyRequest => ({
  accountRef: 'acc-1',
  operation: 'CREATE_ITEM',
  key: KEY,
  requestHash: requestFingerprint('POST', '/v1/items', Buffer.from(body)),
  ...o,
});

let seq = 0;
/** 업무 하나: item 행을 넣고 그 ID를 결과 참조로 둔다 */
function createItem(tx: DbTransaction, r: IdempotencyRequest, o: { before?: () => Promise<void>; fail?: boolean } = {}) {
  let executed = false;
  const done = store.run(tx, r, {
    async execute() {
      executed = true;
      await o.before?.();
      const id = `item-${++seq}`;
      await tx.execute(sql`insert into item values (${id}, ${r.accountRef}, ${'v'})`);
      if (o.fail) throw new Error('업무 실패');
      return { resultRef: id, value: { id, replayed: false } };
    },
    async replay(ref) {
      const rows = (await tx.execute(sql`select id from item where id = ${ref}`)).rows as { id: string }[];
      return { id: rows[0]!.id, replayed: true };
    },
  });
  return { done, executed: () => executed };
}

const run = (r: IdempotencyRequest, o: Parameters<typeof createItem>[2] = {}) =>
  database.transaction(async (tx) => {
    const c = createItem(tx, r, o);
    const v = await c.done;
    return { ...v, executed: c.executed() };
  });

const items = async () => Number(((await database.db.execute(sql`select count(*)::int as n from item`)).rows[0] as { n: number }).n);
const slugOf = (e: unknown) => (e instanceof ProblemError ? e.slug : String(e));

function deferred() {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
}

describe('다시 보냄과 다른 본문', () => {
  test('FND080_같은키같은본문은_업무를한번만하고_처음결과를돌려준다 [ASVS v5.0.0-2.3.4]', async () => {
    const a = await run(req('{"v":1}'));
    const b = await run(req('{"v":1}'));
    expect(a).toEqual({ id: 'item-' + seq, replayed: false, executed: true });
    expect(b).toEqual({ id: a.id, replayed: true, executed: false });
    expect(await items()).toBe(1);
  });

  test('FND080_같은키다른본문은_422_idempotency_key_reused이고_업무행이늘지않는다', async () => {
    await run(req('{"v":1}'));
    await expect(run(req('{"v":2}'))).rejects.toSatisfy((e) => slugOf(e) === 'idempotency-key-reused');
    expect(await items()).toBe(1);
  });

  test('FND080_다른계정의같은키는_따로처리한다', async () => {
    await run(req('{"v":1}'));
    const other = await run(req('{"v":2}', { accountRef: 'acc-2' }));
    expect(other.executed).toBe(true);
    expect(await items()).toBe(2);
  });

  test('FND080_업무가실패하면_키행도남지않아_다시처리한다', async () => {
    await expect(run(req('{"v":1}'), { fail: true })).rejects.toThrow('업무 실패');
    expect(await items()).toBe(0);
    const again = await run(req('{"v":1}'));
    expect(again.executed).toBe(true);
  });

  test('FND080_보관기간이지난키는_다른본문이어도새요청이다', async () => {
    await run(req('{"v":1}'));
    clock.advance(24 * 60 * 60 * 1000 + 1);
    const later = await run(req('{"v":2}'));
    expect(later.executed).toBe(true);
    expect(await items()).toBe(2);
    // 다시 잡은 행의 지문으로 견준다
    expect((await run(req('{"v":2}'))).replayed).toBe(true);
  });
});

describe('처리 중(lock_timeout)', () => {
  test('FND080_처리중인첫요청이_기다림안에커밋하면_뒤요청은그결과를받는다 [ASVS v5.0.0-2.3.4]', async () => {
    const entered = deferred();
    const release = deferred();
    const first = run(req('{"v":1}'), {
      before: async () => {
        entered.resolve();
        await release.p;
      },
    });
    await entered.p;
    const second = run(req('{"v":1}'));
    setTimeout(release.resolve, 100);
    const [a, b] = await Promise.all([first, second]);
    expect(b).toEqual({ id: a.id, replayed: true, executed: false });
    expect(await items()).toBe(1);
  });

  test('FND080_첫요청이기다림을넘기면_409와RetryAfter1이다 [ASVS v5.0.0-13.1.3]', async () => {
    const entered = deferred();
    const release = deferred();
    const first = run(req('{"v":1}'), {
      before: async () => {
        entered.resolve();
        await release.p;
      },
    });
    await entered.p;
    const started = Date.now();
    const err = await run(req('{"v":1}')).catch((e: unknown) => e);
    const waited = Date.now() - started;
    release.resolve();
    await first;
    expect(err).toBeInstanceOf(ProblemError);
    expect(err).toMatchObject({ slug: 'idempotency-request-in-progress', status: 409, retryAfterSeconds: 1 });
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(2000);
    expect(IDEMPOTENCY_WAIT_MS).toBe(1000);
  });

  test('FND080_처리중인첫요청이되돌아가면_뒤요청이새로처리한다', async () => {
    const entered = deferred();
    const release = deferred();
    const first = run(req('{"v":1}'), {
      fail: true,
      before: async () => {
        entered.resolve();
        await release.p;
      },
    }).catch((e: unknown) => e);
    await entered.p;
    const second = run(req('{"v":1}'));
    setTimeout(release.resolve, 100);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBeInstanceOf(Error);
    expect(b.executed).toBe(true);
    expect(await items()).toBe(1);
  });

  test('FND080_리뷰_문장시간한도가기다림보다짧아도_처리중은500이아니라409다', async () => {
    // 코드 리뷰 2026-11-01: 핫패스 역할의 문장 한도(1초)나 데드라인으로 건 한도가 먼저 끝나면 57014가 나 500이 나갔다
    const entered = deferred();
    const release = deferred();
    const first = run(req('{"v":1}'), {
      before: async () => {
        entered.resolve();
        await release.p;
      },
    });
    await entered.p;
    const slow = new IdempotencyStore({ clock, waitMs: 1000 });
    const err = await database
      .transaction((tx) => slow.run(tx, req('{"v":1}'), { execute: async () => ({ resultRef: 'x', value: 1 }), replay: async () => 2 }), { statementTimeoutMs: 200 })
      .catch((e: unknown) => e);
    release.resolve();
    await first;
    expect(err).toMatchObject({ slug: 'idempotency-request-in-progress', status: 409 });
  });

  test('FND080_키를잡은뒤에는_lock_timeout이역할기본값으로돌아간다', async () => {
    const after = await database.transaction(async (tx) => {
      await createItem(tx, req('{"v":1}')).done;
      return ((await tx.execute(sql`select current_setting('lock_timeout') as v`)).rows[0] as { v: string }).v;
    });
    expect(after).toBe('0');
  });

  test('FND080_결과참조없이커밋된기록은_다시돌려주지않고던진다', async () => {
    await database.db.execute(sql`insert into idempotency_record values ('acc-1', 'CREATE_ITEM', ${KEY}, ${Buffer.from(req('{"v":1}').requestHash)}, null, ${new Date(clock.now())})`);
    await expect(run(req('{"v":1}'))).rejects.toThrow(/결과 참조/);
  });
});

describe('정리', () => {
  test('FND080_리뷰_정비삭제는_기다리는동안다시잡혀커밋된키를지우지않는다', async () => {
    // 코드 리뷰 2026-11-01: 지울 조건이 안쪽 질의에만 있어, 기다린 뒤 다시 잡힌 새 판을 다시 보지 않고 지웠다(같은 키가 다시 처리된다)
    const old = new Date(clock.now() - 25 * 60 * 60 * 1000);
    await database.db.execute(sql`insert into idempotency_record values ('acc-1', 'CREATE_ITEM', ${KEY}, ${Buffer.alloc(32)}, 'old', ${old})`);
    const entered = deferred();
    const release = deferred();
    const first = run(req('{"v":1}'), {
      before: async () => {
        entered.resolve();
        await release.p;
      },
    });
    await entered.p;
    const deleting = deleteExpiredIdempotencyRecords(database, { clock });
    await new Promise((r) => setTimeout(r, 200));
    release.resolve();
    const [a, n] = await Promise.all([first, deleting]);
    expect(a.executed).toBe(true);
    expect(n).toBe(0);
    expect((await run(req('{"v":1}'))).replayed).toBe(true);
  });

  test('FND080_보관기간이지난기록만_묶음으로나눠지운다', async () => {
    const now = clock.now();
    const old = new Date(now - 25 * 60 * 60 * 1000);
    const fresh = new Date(now - 60 * 1000);
    for (let i = 0; i < 25; i += 1) {
      await database.db.execute(sql`insert into idempotency_record values (${`acc-${i}`}, 'CREATE_ITEM', ${KEY}, ${Buffer.alloc(32)}, 'r', ${old})`);
    }
    for (let i = 0; i < 3; i += 1) {
      await database.db.execute(sql`insert into idempotency_record values (${`new-${i}`}, 'CREATE_ITEM', ${KEY}, ${Buffer.alloc(32)}, 'r', ${fresh})`);
    }
    let pauses = 0;
    const n = await deleteExpiredIdempotencyRecords(database, { clock, batchSize: 10, pause: async () => void (pauses += 1) });
    expect(n).toBe(25);
    expect(pauses).toBe(2);
    const left = ((await database.db.execute(sql`select count(*)::int as n from idempotency_record`)).rows[0] as { n: number }).n;
    expect(left).toBe(3);
  });
});
