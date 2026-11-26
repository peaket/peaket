// F-04-15 core-svc support 소명 표·저장소 통합 시험(실제 PostgreSQL 18, 동결 로컬, LCH-310).
// 정본: docs/data.md appeal, docs/features/transfer-refund.md §7.1, docs/api/openapi.yaml 태그 support.
// 0048이 표·검사·인덱스·core_app 권한을 만들고, DrizzleSupportAppealStore가 운영 연결(core_app)로 저장·조회·고치기를 지키는지 본다.
import { createDatabase, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { DrizzleSupportAppealStore } from '../src/modules/support/index.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { loginFor } from './roles.js';

const CASE = '0194b220-0000-7000-8000-000000000301';
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse('2026-11-26T00:00:00.000Z');

let container: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let store: DrizzleSupportAppealStore;

beforeAll(async () => {
  container = await startPostgres();
  await migrateCore(container.url);
  admin = createDatabase({ url: container.url, applicationName: 'core-svc-support-int', max: 2 });
  appDb = await loginFor(admin, container, 'core_app_login', 'core_app', 2);
  partnerDb = await loginFor(admin, container, 'core_partner_login', 'core_partner', 2);
  store = new DrizzleSupportAppealStore(appDb);
});
afterAll(async () => {
  await partnerDb?.close();
  await appDb?.close();
  await admin?.close();
  container?.stop();
});

const q = (sql: string, params: unknown[] = []) => admin.pool.query(sql, params);
const rejects = async (p: Promise<unknown>, code: string) => {
  const err = (await p.then(
    () => undefined,
    (e: unknown) => e,
  )) as { code?: string } | undefined;
  expect(err, '거절되어야 한다').toBeDefined();
  expect(err!.code).toBe(code);
};

describe('0048 소명 표(실제 PostgreSQL)', () => {
  test('FX-T20 ⑬ 0048은 appeal 표·검사·인덱스·core_app 권한을 만든다', async () => {
    const columns = await q("select column_name, is_nullable from information_schema.columns where table_name = 'appeal' order by ordinal_position");
    expect(columns.rows.map((r: { column_name: string }) => r.column_name)).toEqual(['id', 'account_id', 'kind', 'target_id', 'body', 'status', 'result', 'case_id', 'submitted_at', 'decided_at']);
    const indexes = await q("select indexname from pg_indexes where tablename = 'appeal' order by indexname");
    expect(indexes.rows.map((r: { indexname: string }) => r.indexname)).toEqual(['appeal_account_submitted_idx', 'appeal_pkey', 'appeal_target_id_idx']);
    const grants = await q("select has_table_privilege('core_app', 'appeal', 'SELECT') as s, has_table_privilege('core_app', 'appeal', 'INSERT') as i, has_table_privilege('core_app', 'appeal', 'UPDATE') as u");
    expect(grants.rows[0]).toEqual({ s: true, i: true, u: true });
  });

  test('FX-T19 ⑫ DrizzleSupportAppealStore는 core_app 연결로 저장·조회·목록·고치기를 지킨다', async () => {
    const me = randomUUID();
    const other = randomUUID();
    const first = {
      id: randomUUID(),
      accountId: me,
      kind: 'FRAUD_CASE' as const,
      targetId: CASE,
      body: '가족이 대신 예매했습니다',
      status: 'SUBMITTED' as const,
      result: null,
      caseId: null,
      submittedAtMs: NOW - 1_000,
      decidedAtMs: null,
    };
    const second = { ...first, id: randomUUID(), kind: 'RESTRICTION' as const, targetId: 'restriction-1', body: '사정이 있습니다', submittedAtMs: NOW };
    const foreign = { ...first, id: randomUUID(), accountId: other, body: '남의 소명' };
    expect(await store.put(first)).toMatchObject({ replayed: false });
    expect(await store.put(second)).toMatchObject({ replayed: false });
    expect(await store.put(foreign)).toMatchObject({ replayed: false });

    expect(await store.get(first.id)).toMatchObject({ accountId: me, kind: 'FRAUD_CASE', targetId: CASE, body: '가족이 대신 예매했습니다', status: 'SUBMITTED', submittedAtMs: NOW - 1_000 });
    const firstPage = await store.listByAccount(me, { limit: 1 });
    expect(firstPage.items.map((x: { id: string }) => x.id)).toEqual([second.id]);
    expect(firstPage.nextCursor).toBe(second.id);
    const secondPage = await store.listByAccount(me, { limit: 1, cursor: firstPage.nextCursor! });
    expect(secondPage.items.map((x: { id: string }) => x.id)).toEqual([first.id]);
    expect(secondPage.nextCursor).toBeNull();
    expect((await store.listByAccount(other, { limit: 10 })).items.map((x: { id: string }) => x.id)).toEqual([foreign.id]);

    expect(await store.update({ ...first, status: 'DECIDED', result: 'ACCEPTED', caseId: CASE, decidedAtMs: NOW + 1_000 })).toBe(true);
    expect(await store.get(first.id)).toMatchObject({ status: 'DECIDED', result: 'ACCEPTED', caseId: CASE, decidedAtMs: NOW + 1_000 });
    expect(await store.update({ ...first, id: randomUUID() })).toBe(false);
  });

  test('IR-06 소명 멱등은 idempotency_record로 남아 재시작·다중 인스턴스에서 재생하고 DB 실패는 남지 않는다', async () => {
    const me = randomUUID();
    const key = randomUUID();
    const requestHash = new Uint8Array([1, 2, 3]);
    const record = {
      id: randomUUID(),
      accountId: me,
      kind: 'FRAUD_CASE' as const,
      targetId: CASE,
      body: '가족이 대신 예매했습니다',
      status: 'SUBMITTED' as const,
      result: null,
      caseId: null,
      submittedAtMs: NOW,
      decidedAtMs: null,
    };
    const idem = { accountRef: me, operation: 'CREATE_APPEAL', key, requestHash };
    expect(await store.put(record, { idem, result: { appealId: record.id } })).toMatchObject({ replayed: false });
    const rows = await q('select result_ref from idempotency_record where account_ref = $1 and operation = $2 and idempotency_key = $3', [me, 'CREATE_APPEAL', key]);
    expect(rows.rows).toEqual([{ result_ref: record.id }]);

    // 서버를 다시 띄운 것과 같은 새 저장소 인스턴스가 같은 키를 재생한다.
    const restarted = new DrizzleSupportAppealStore(appDb);
    expect(await restarted.findIdempotent(idem)).toMatchObject({ kind: 'replay', result: { appealId: record.id } });
    expect(await restarted.put({ ...record, id: randomUUID() }, { idem, result: { appealId: 'other' } })).toMatchObject({ replayed: true });

    // DB insert가 실패하면 멱등 기록도 남지 않아 같은 키로 다시 할 수 있다.
    const failedKey = randomUUID();
    const failedIdem = { accountRef: me, operation: 'CREATE_APPEAL', key: failedKey, requestHash };
    await expect(store.put({ ...record, id: randomUUID(), body: '가'.repeat(2001) }, { idem: failedIdem, result: { appealId: 'x' } })).rejects.toThrow();
    expect(await store.findIdempotent(failedIdem)).toEqual({ kind: 'none' });
    const retry = { ...record, id: randomUUID() };
    expect(await store.put(retry, { idem: failedIdem, result: { appealId: retry.id } })).toMatchObject({ replayed: false });
    expect(await store.findIdempotent(failedIdem)).toMatchObject({ kind: 'replay', result: { appealId: retry.id } });
  });

  test('FX-T20 ⑬ appeal 검사는 kind·status·result·본문 2,000자를 지킨다', async () => {
    const row = (over: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      accountId: randomUUID(),
      kind: 'FRAUD_CASE',
      targetId: CASE,
      body: '내용',
      status: 'SUBMITTED',
      result: null,
      caseId: null,
      submittedAt: iso(NOW),
      decidedAt: null,
      ...over,
    });
    const insert = (r: Record<string, unknown>) =>
      q('insert into appeal (id, account_id, kind, target_id, body, status, result, case_id, submitted_at, decided_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [r.id, r.accountId, r.kind, r.targetId, r.body, r.status, r.result, r.caseId, r.submittedAt, r.decidedAt]);
    await insert(row({ body: '가'.repeat(2000) }));
    await rejects(insert(row({ body: '가'.repeat(2001) })), '23514');
    await rejects(insert(row({ kind: 'OTHER' })), '23514');
    await rejects(insert(row({ status: 'OPEN' })), '23514');
    await rejects(insert(row({ result: 'UNKNOWN' })), '23514');
    await insert(row({ kind: 'RECLAIM', result: 'RECLAIMED', status: 'DECIDED', decidedAt: iso(NOW) }));
  });

  test('FX-T20 ⑬ appeal은 core_app만 읽고 쓸 수 있고 core_partner는 막힌다', async () => {
    await rejects(partnerDb.pool.query('select id from appeal limit 1'), '42501');
    await rejects(partnerDb.pool.query("insert into appeal (id, account_id, kind, target_id, body, status, submitted_at) values ($1,$2,'FRAUD_CASE',$3,'내용','SUBMITTED',now())", [randomUUID(), randomUUID(), CASE]), '42501');
  });
});
