// 멱등 기록 표(idempotency_record)의 역할·작업 행 보안 통합 시험(실제 PostgreSQL 18 컨테이너, AZ-T17 ①~⑤·⑧, FR-021, W12-core-idem).
// 정본: ADR-0337 결정 1(작업과 역할의 짝)·2(파트너 기록의 테넌트 칸)·3(정책 열 개, FORCE 없음)·4(칸 권한), docs/security/authz-matrix.md §5.3·§7 AZ-T17,
// docs/api/guidelines.md §4(보관 기간 24시간 [가정], 같은 키 다른 지문 422 idempotency-key-reused).
// 기록은 각 역할의 실제 연결로 platform IdempotencyStore.run을 불러 넣는다(파트너는 테넌트를 건 트랜잭션). 새 칸에 기대지 않으므로 0041 전 트리에서도 준비가 돈다.
// 시험의 쿼리에는 일부러 조건(WHERE)을 빼 앱 쿼리 조건이 아니라 DB 행 보안·칸 권한만 거르는지 본다. 칸을 읽지 않는 고치기(WHERE·RETURNING 없음)는 고치기 USING만 본다.
import 'reflect-metadata';
import { createDatabase, type Database, type DbTransaction, fakeClock, IdempotencyStore, requestFingerprint } from '@peaket/platform';
import { type SQL, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

// ---- 정본 값(ADR-0337 결정 1·3·4) ----

/** 결정 1: 역할마다 쓰는 작업 */
const PARTNER_OPS = ['CREATE_PRODUCTION', 'CREATE_PRODUCTION_EVENT'] as const;
const APP_OPS = ['CREATE_MERCH_ORDER', 'START_MERCH_PAYMENT', 'ACCEPT_MERCH_PAYMENT', 'CREATE_TICKET_ADDON', 'CANCEL_MERCH_ORDER', 'RETURN_MERCH_ORDER', 'SHOP_CANCEL_REFUND_ACCOUNT'] as const;
const OPS_OPS = ['CREATE_OPS_PROMOTER', 'CREATE_OPS_PROMOTER_CONTRACT_CHANGE'] as const;
type Role = 'core_partner' | 'core_app' | 'core_ops';
const OPS_OF: Record<Role, readonly string[]> = { core_partner: PARTNER_OPS, core_app: APP_OPS, core_ops: OPS_OPS };

/** 결정 3: 정책 열 개(이름 차례). using = USING 식이 있다, check = WITH CHECK 식이 있다 */
const POLICIES = [
  { name: 'idempotency_record_app_insert', cmd: 'INSERT', roles: ['core_app'], using: false, check: true },
  { name: 'idempotency_record_app_read', cmd: 'SELECT', roles: ['core_app'], using: true, check: false },
  { name: 'idempotency_record_app_update', cmd: 'UPDATE', roles: ['core_app'], using: true, check: true },
  { name: 'idempotency_record_ops_delete', cmd: 'DELETE', roles: ['core_ops'], using: true, check: false },
  { name: 'idempotency_record_ops_insert', cmd: 'INSERT', roles: ['core_ops'], using: false, check: true },
  { name: 'idempotency_record_ops_read', cmd: 'SELECT', roles: ['core_ops'], using: true, check: false },
  { name: 'idempotency_record_ops_update', cmd: 'UPDATE', roles: ['core_ops'], using: true, check: true },
  { name: 'idempotency_record_partner_insert', cmd: 'INSERT', roles: ['core_partner'], using: false, check: true },
  { name: 'idempotency_record_partner_read', cmd: 'SELECT', roles: ['core_partner'], using: true, check: false },
  { name: 'idempotency_record_partner_update', cmd: 'UPDATE', roles: ['core_partner'], using: true, check: true },
] as const;

/** 결정 4: 넣기 여섯 칸, 고치기 세 칸. tenant_id는 둘 다 아니다 */
const COLUMNS = ['account_ref', 'operation', 'idempotency_key', 'request_hash', 'result_ref', 'created_at', 'tenant_id'] as const;
const INSERTABLE: readonly string[] = ['account_ref', 'operation', 'idempotency_key', 'request_hash', 'result_ref', 'created_at'];
const UPDATABLE: readonly string[] = ['request_hash', 'result_ref', 'created_at'];

/** guidelines §4 보관 기간 24시간 [가정] */
const DAY_MS = 24 * 60 * 60 * 1000;
/** 관제 계약 변경 요청의 작업 범위(docs/data.md '서비스마다 둔 멱등 기록 표', 계정 대신 쓰는 값) */
const CONTRACT_SCOPE = 'ops-contract-change';

// ---- 시드: 파트너 A·B, 팬 C·D, 관제 계정 하나와 계약 변경 범위 ----

const A = randomUUID();
const B = randomUUID();
/** 파트너 A·B의 로그인 계정(테넌트와 다른 값) */
const PA = randomUUID();
const PA2 = randomUUID();
const PB = randomUUID();
const C = randomUUID();
const D = randomUUID();
const OPS = randomUUID();
const T0 = Date.parse('2026-12-09T05:41:00.000Z');

interface Seed {
  readonly role: Role;
  readonly tenant?: string;
  readonly accountRef: string;
  readonly operation: string;
  readonly key: string;
  readonly resultRef: string;
}

const seed = (role: Role, accountRef: string, operation: string, resultRef: string, tenant?: string): Seed => ({ role, accountRef, operation, key: randomUUID(), resultRef, ...(tenant ? { tenant } : {}) });

const SEEDS: readonly Seed[] = [
  seed('core_partner', PA, 'CREATE_PRODUCTION', JSON.stringify({ productionId: randomUUID(), eventIds: [randomUUID()], warnings: [] }), A),
  seed('core_partner', PA, 'CREATE_PRODUCTION_EVENT', JSON.stringify({ eventId: randomUUID(), pending: false, warnings: [] }), A),
  seed('core_partner', PB, 'CREATE_PRODUCTION', JSON.stringify({ productionId: randomUUID(), eventIds: [], warnings: [] }), B),
  seed('core_app', C, 'CREATE_MERCH_ORDER', randomUUID()),
  seed(
    'core_app',
    C,
    'START_MERCH_PAYMENT',
    JSON.stringify({
      attemptId: randomUUID(),
      pg: 'TOSS',
      switched: false,
      holdExpiresAt: '2026-12-09T05:56:00.000Z',
      allowedPayMethods: ['CARD'],
      checkout: { clientKey: 'test_ck_az_t17', customerKey: 'cust-az-t17', orderId: randomUUID(), orderName: '시험 굿즈', amount: 23_700, successUrl: 'https://peaket.test/r', failUrl: 'https://peaket.test/r' },
    }),
  ),
  seed('core_app', C, 'ACCEPT_MERCH_PAYMENT', 'accepted'),
  seed('core_app', C, 'CREATE_TICKET_ADDON', randomUUID()),
  seed('core_app', D, 'CANCEL_MERCH_ORDER', `cancel:${randomUUID()}`),
  seed('core_app', D, 'RETURN_MERCH_ORDER', `return:${randomUUID()}`),
  seed('core_app', D, 'SHOP_CANCEL_REFUND_ACCOUNT', `cancel:${randomUUID()}`),
  seed('core_ops', OPS, 'CREATE_OPS_PROMOTER', randomUUID()),
  seed('core_ops', CONTRACT_SCOPE, 'CREATE_OPS_PROMOTER_CONTRACT_CHANGE', JSON.stringify({ promoterId: randomUUID(), status: 'PENDING' })),
];

const byRole = (role: Role, tenant?: string) => SEEDS.filter((s) => s.role === role && (tenant === undefined || s.tenant === tenant));
const seedOf = (role: Role, operation: string, accountRef: string): Seed => {
  const s = SEEDS.find((x) => x.role === role && x.operation === operation && x.accountRef === accountRef);
  if (!s) throw new Error(`시드 없음: ${role} ${operation}`);
  return s;
};

// ---- 연결 ----

let pg: PostgresContainer;
let admin: Database;
let partner: Database;
let app: Database;
let ops: Database;

type Runner = <T>(fn: (tx: DbTransaction) => Promise<T>) => Promise<T>;
const asPartner =
  (tenantId: string): Runner =>
  (fn) =>
    partner.transaction(fn, { tenantId });
const asApp: Runner = (fn) => app.transaction(fn);
const asOps: Runner = (fn) => ops.transaction(fn);
const runnerOf = (s: Seed): Runner => (s.role === 'core_partner' ? asPartner(s.tenant!) : s.role === 'core_app' ? asApp : asOps);

const hashOf = (s: string) => requestFingerprint('POST', `/az-t17/${s}`, Buffer.from(`{"k":"${s}"}`, 'utf8'));

/** 기록 하나를 그 역할의 실제 연결로 플랫폼 멱등 문장에 넣는다(처음 요청의 execute가 결과 참조를 돌려준다) */
async function put(s: Seed, store: IdempotencyStore): Promise<void> {
  await runnerOf(s)((tx) =>
    store.run(tx, { accountRef: s.accountRef, operation: s.operation, key: s.key, requestHash: hashOf(s.key) }, { execute: async () => ({ resultRef: s.resultRef, value: undefined }), replay: async () => undefined }),
  );
}

interface View {
  accountRef: string;
  operation: string;
  key: string;
  resultRef: string | null;
}
const viewOf = (rows: readonly Record<string, unknown>[]): View[] =>
  rows
    .map((r) => ({ accountRef: String(r.account_ref), operation: String(r.operation), key: String(r.idempotency_key), resultRef: r.result_ref === null ? null : String(r.result_ref) }))
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
const expected = (seeds: readonly Seed[], resultRef?: (s: Seed) => string): View[] =>
  viewOf(seeds.map((s) => ({ account_ref: s.accountRef, operation: s.operation, idempotency_key: s.key, result_ref: resultRef ? resultRef(s) : s.resultRef })));

const SELECT_ALL = sql`select account_ref, operation, idempotency_key, result_ref from idempotency_record`;
/** 표 전체(소유자 연결, 행 보안을 건너뛴다) */
const all = async (): Promise<View[]> => viewOf((await admin.pool.query('select account_ref, operation, idempotency_key, result_ref from idempotency_record')).rows as Record<string, unknown>[]);
const denied = (run: Runner, q: SQL) => expect(run((tx) => tx.execute(q))).rejects.toMatchObject({ cause: { code: '42501' } });

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-idempotency-rls-int', max: 2 });
  // 연결 하나짜리 풀: 앞 트랜잭션의 set_config(…, true)가 끝난 연결을 다시 쓰는 경우를 만든다(rls.int.test.ts와 같은 꼴)
  partner = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 1);
  app = await loginFor(admin, pg, 'core_app_login', 'core_app', 2);
  ops = await loginFor(admin, pg, 'core_ops_login', 'core_ops', 2);
});
afterAll(async () => {
  await partner?.close();
  await app?.close();
  await ops?.close();
  await admin?.close();
  pg?.stop();
});

beforeEach(async () => {
  // 시험마다 표를 비우고 같은 시드를 각 역할의 연결로 다시 넣는다(앞 시험이 바꾼 값이 남지 않게)
  await admin.pool.query('delete from idempotency_record');
  const store = new IdempotencyStore({ clock: fakeClock({ now: T0 }) });
  for (const s of SEEDS) await put(s, store);
  expect(await all()).toEqual(expected(SEEDS));
});

describe('AZ-T17 멱등 기록 표의 역할 나누기(행 보안)', () => {
  test('AZ-T17 ① 파트너 트랜잭션은 조건 없이 읽어도 자기 테넌트의 파트너 작업 기록만 보고 그것만 고친다 [ASVS v5.0.0-8.4.1]', async () => {
    const seenA = await asPartner(A)(async (tx) => viewOf((await tx.execute(SELECT_ALL)).rows));
    expect(seenA).toEqual(expected(byRole('core_partner', A)));
    const seenB = await asPartner(B)(async (tx) => viewOf((await tx.execute(SELECT_ALL)).rows));
    expect(seenB).toEqual(expected(byRole('core_partner', B)));
    // WHERE·RETURNING 없는 고치기: 고치기 USING만 행을 거른다
    const changed = await asPartner(A)(async (tx) => (await tx.execute(sql`update idempotency_record set result_ref = '바뀜'`)).rowCount);
    expect(changed).toBe(2);
    const mineA = new Set(byRole('core_partner', A).map((s) => s.key));
    expect(await all()).toEqual(expected(SEEDS, (s) => (mineA.has(s.key) ? '바뀜' : s.resultRef)));
  });

  test('AZ-T17 ② 테넌트를 걸지 않은 파트너 트랜잭션과 트랜잭션 밖 읽기는 0건이고 고치기도 0건이다(앞 트랜잭션이 쓴 연결을 다시 써도 오류 없이) [ASVS v5.0.0-8.4.1]', async () => {
    // 테넌트 A 트랜잭션을 먼저 돌려 그 연결에 app.tenant_id를 한 번 걸었다 푼다
    await asPartner(A)(async (tx) => tx.execute(SELECT_ALL));
    const out = await partner.transaction(async (tx) => ({
      setting: (await tx.execute(sql`select current_setting('app.tenant_id', true) as t`)).rows[0]?.t,
      seen: viewOf((await tx.execute(SELECT_ALL)).rows),
      changed: (await tx.execute(sql`update idempotency_record set result_ref = '바뀜'`)).rowCount,
    }));
    // 같은 연결을 다시 쓴 경우다: 끝난 SET LOCAL은 NULL이 아니라 빈 글로 남는다(nullif가 거르는 경우)
    expect(out).toEqual({ setting: '', seen: [], changed: 0 });
    expect(viewOf((await partner.db.execute(SELECT_ALL)).rows)).toEqual([]);
    expect((await partner.db.execute(sql`update idempotency_record set result_ref = '바뀜'`)).rowCount).toBe(0);
    expect(await all()).toEqual(expected(SEEDS));
  });

  test('AZ-T17 ③ 팬 경로 사용자는 조건 없이 읽고 고쳐도 팬 작업 일곱의 기록에만 닿고 지우지 못한다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.4.1]', async () => {
    const fans = byRole('core_app');
    // 시드가 팬 작업 일곱을 모두 담는다(작업 목록에서 하나가 빠지면 그 기록이 안 보인다)
    expect([...new Set(fans.map((s) => s.operation))].sort()).toEqual([...APP_OPS].sort());
    expect(viewOf((await app.db.execute(SELECT_ALL)).rows)).toEqual(expected(fans));
    expect((await app.db.execute(sql`update idempotency_record set result_ref = '바뀜'`)).rowCount).toBe(fans.length);
    const mine = new Set(fans.map((s) => s.key));
    expect(await all()).toEqual(expected(SEEDS, (s) => (mine.has(s.key) ? '바뀜' : s.resultRef)));
    await expect(app.db.execute(sql`delete from idempotency_record`)).rejects.toMatchObject({ cause: { code: '42501' } });
    expect((await all()).length).toBe(SEEDS.length);
  });

  test('AZ-T17 ③ 관제 경로 사용자는 조건 없이 읽고 고치고 지워도 관제 작업 둘의 기록에만 닿는다 [ASVS v5.0.0-8.4.1]', async () => {
    const mineSeeds = byRole('core_ops');
    expect(viewOf((await ops.db.execute(SELECT_ALL)).rows)).toEqual(expected(mineSeeds));
    expect((await ops.db.execute(sql`update idempotency_record set result_ref = '바뀜'`)).rowCount).toBe(mineSeeds.length);
    const mine = new Set(mineSeeds.map((s) => s.key));
    expect(await all()).toEqual(expected(SEEDS, (s) => (mine.has(s.key) ? '바뀜' : s.resultRef)));
    expect((await ops.db.execute(sql`delete from idempotency_record`)).rowCount).toBe(mineSeeds.length);
    expect(await all()).toEqual(expected(SEEDS.filter((s) => !mine.has(s.key))));
  });

  test('AZ-T17 ③ 세 역할은 다른 역할의 작업 이름으로 기록을 넣지 못한다 [ASVS v5.0.0-8.4.1]', async () => {
    const store = new IdempotencyStore({ clock: fakeClock({ now: T0 + 60_000 }) });
    let executed = 0;
    const attempts: [string, Runner, string, string][] = [
      ['파트너', asPartner(A), PA, 'START_MERCH_PAYMENT'],
      ['파트너', asPartner(A), PA, 'CREATE_OPS_PROMOTER'],
      ['팬', asApp, C, 'CREATE_PRODUCTION'],
      ['팬', asApp, C, 'CREATE_OPS_PROMOTER_CONTRACT_CHANGE'],
      ['관제', asOps, OPS, 'START_MERCH_PAYMENT'],
      ['관제', asOps, OPS, 'CREATE_PRODUCTION_EVENT'],
    ];
    for (const [who, run, accountRef, operation] of attempts) {
      const key = randomUUID();
      await expect(
        run((tx) =>
          store.run(
            tx,
            { accountRef, operation, key, requestHash: hashOf(key) },
            {
              execute: async () => {
                executed++;
                return { resultRef: 'x', value: undefined };
              },
              replay: async () => undefined,
            },
          ),
        ),
        `${who} ${operation}`,
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    }
    expect(executed).toBe(0);
    expect(await all()).toEqual(expected(SEEDS));
  });

  test('AZ-T17 ④ 세 역할 모두 범위 칸(계정·작업·키)과 테넌트 칸을 칸마다 고치지 못하고 테넌트 칸을 적어 넣지 못한다 [ASVS v5.0.0-8.4.1]', async () => {
    // 바꾸는 값은 그 역할 목록 안의 다른 작업·자기 테넌트 값으로 골라 WITH CHECK는 지나게 한다(칸 권한만 본다, 계획 3.2 '겹친 가드')
    const cases: { who: string; run: Runner; own: Seed; account: string; operation: string; tenant: SQL }[] = [
      { who: '파트너', run: asPartner(A), own: seedOf('core_partner', 'CREATE_PRODUCTION', PA), account: PA2, operation: 'CREATE_PRODUCTION_EVENT', tenant: sql`${A}::uuid` },
      { who: '팬', run: asApp, own: seedOf('core_app', 'CREATE_MERCH_ORDER', C), account: D, operation: 'START_MERCH_PAYMENT', tenant: sql`null::uuid` },
      { who: '관제', run: asOps, own: seedOf('core_ops', 'CREATE_OPS_PROMOTER', OPS), account: CONTRACT_SCOPE, operation: 'CREATE_OPS_PROMOTER_CONTRACT_CHANGE', tenant: sql`null::uuid` },
    ];
    for (const c of cases) {
      const where = sql`where account_ref = ${c.own.accountRef} and operation = ${c.own.operation} and idempotency_key = ${c.own.key}`;
      await denied(c.run, sql`update idempotency_record set account_ref = ${c.account} ${where}`);
      await denied(c.run, sql`update idempotency_record set operation = ${c.operation} ${where}`);
      await denied(c.run, sql`update idempotency_record set idempotency_key = ${randomUUID()} ${where}`);
      await denied(c.run, sql`update idempotency_record set tenant_id = ${c.tenant} ${where}`);
      const key = randomUUID();
      await denied(
        c.run,
        sql`insert into idempotency_record (account_ref, operation, idempotency_key, request_hash, result_ref, created_at, tenant_id)
            values (${c.own.accountRef}, ${c.own.operation}, ${key}, ${Buffer.from(hashOf(key))}, null, ${new Date(T0)}, ${c.tenant})`,
      );
    }
    expect(await all()).toEqual(expected(SEEDS));
  });

  test('AZ-T17 ⑤ 세 역할의 연결로 낸 처음 요청·같은 키 재요청·다른 지문 요청이 처음 결과·같은 결과·422이고 보관 기간이 지난 키는 다시 처리되며 파트너 기록에만 요청 테넌트가 든다 [ASVS v5.0.0-8.4.1]', async () => {
    const roles: { who: string; run: Runner; accountRef: string; operation: string; tenant: string | null }[] = [
      { who: '파트너', run: asPartner(A), accountRef: PA, operation: 'CREATE_PRODUCTION_EVENT', tenant: A },
      { who: '팬', run: asApp, accountRef: C, operation: 'RETURN_MERCH_ORDER', tenant: null },
      { who: '관제', run: asOps, accountRef: CONTRACT_SCOPE, operation: 'CREATE_OPS_PROMOTER_CONTRACT_CHANGE', tenant: null },
    ];
    for (const r of roles) {
      const clock = fakeClock({ now: T0 + 3_600_000 });
      const store = new IdempotencyStore({ clock });
      const key = randomUUID();
      const same = requestFingerprint('POST', `/az-t17/${r.who}`, Buffer.from('{"n":1}', 'utf8'));
      const other = requestFingerprint('POST', `/az-t17/${r.who}`, Buffer.from('{"n":2}', 'utf8'));
      let executed = 0;
      const call = (requestHash: Uint8Array, ref: string) =>
        r.run((tx) =>
          store.run(
            tx,
            { accountRef: r.accountRef, operation: r.operation, key, requestHash },
            {
              execute: async () => {
                executed++;
                return { resultRef: ref, value: `처음:${ref}` };
              },
              replay: async (got) => `다시:${got}`,
            },
          ),
        );
      expect(await call(same, 'ref-1'), r.who).toBe('처음:ref-1');
      expect(executed, r.who).toBe(1);
      expect(await call(same, 'ref-2'), r.who).toBe('다시:ref-1');
      expect(executed, r.who).toBe(1);
      await expect(call(other, 'ref-3'), r.who).rejects.toMatchObject({ status: 422, slug: 'idempotency-key-reused' });
      expect(executed, r.who).toBe(1);
      // 보관 기간 경계: 처음 요청 + 24시간 − 1ms는 아직 같은 결과, + 24시간 + 1ms는 새 요청
      clock.advance(DAY_MS - 1);
      expect(await call(same, 'ref-4'), r.who).toBe('다시:ref-1');
      expect(executed, r.who).toBe(1);
      clock.advance(2);
      expect(await call(same, 'ref-5'), r.who).toBe('처음:ref-5');
      expect(executed, r.who).toBe(2);
      const row = (await admin.pool.query('select tenant_id, result_ref from idempotency_record where idempotency_key = $1', [key])).rows as { tenant_id: string | null; result_ref: string }[];
      expect(row, r.who).toEqual([{ tenant_id: r.tenant, result_ref: 'ref-5' }]);
    }
  });

  test('AZ-T17 ⑧ 행 보안이 켜져 있고 FORCE가 없으며 소유자가 앱 역할이 아니고 정책 열 개와 작업 목록·칸 권한이 정한 모양이다 [ASVS v5.0.0-8.4.1]', async () => {
    const table = (
      await admin.pool.query(
        `select c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = 'idempotency_record' and c.relkind = 'r'`,
      )
    ).rows as { relrowsecurity: boolean; relforcerowsecurity: boolean; owner: string }[];
    expect(table.map((t) => ({ rls: t.relrowsecurity, force: t.relforcerowsecurity }))).toEqual([{ rls: true, force: false }]);
    expect(['core_partner', 'core_app', 'core_ops', 'core_partner_login', 'core_app_login', 'core_ops_login']).not.toContain(table[0]!.owner);

    const policies = (
      await admin.pool.query(
        `select policyname, cmd, roles::text[] as roles, qual, with_check from pg_policies
         where schemaname = 'public' and tablename = 'idempotency_record' order by policyname`,
      )
    ).rows as { policyname: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null }[];
    expect(policies.map((p) => ({ name: p.policyname, cmd: p.cmd, roles: p.roles, using: p.qual !== null, check: p.with_check !== null }))).toEqual(POLICIES.map((p) => ({ ...p, roles: [...p.roles] })));

    // 정책 식의 작업 글: 정책마다 그 역할 목록과 같고, 역할끼리 겹치지 않으며, 합이 작업 CHECK 목록과 같다
    const opsIn = (expr: string): string[] => [...expr.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]!).sort();
    const tenantQual = (await admin.pool.query(`select qual from pg_policies where tablename = 'production' and policyname = 'production_partner_tenant'`)).rows as { qual: string }[];
    expect(tenantQual).toHaveLength(1);
    expect(tenantQual[0]!.qual).toContain('promoter_id');
    const tenantExpr = tenantQual[0]!.qual.replace('promoter_id', 'tenant_id');
    const collected: Record<Role, Set<string>> = { core_partner: new Set(), core_app: new Set(), core_ops: new Set() };
    for (const p of policies) {
      const role = p.roles[0] as Role;
      for (const expr of [p.qual, p.with_check]) {
        if (expr === null) continue;
        expect(opsIn(expr), p.policyname).toEqual([...OPS_OF[role]].sort());
        for (const o of opsIn(expr)) collected[role].add(o);
        if (role === 'core_partner') expect(expr, p.policyname).toContain(tenantExpr);
        else expect(expr, p.policyname).not.toContain('app.tenant_id');
      }
    }
    const flat = [...collected.core_partner, ...collected.core_app, ...collected.core_ops];
    expect(new Set(flat).size).toBe(flat.length);
    const constraint = (await admin.pool.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'idempotency_record_operation_check'`)).rows as { def: string }[];
    expect(constraint).toHaveLength(1);
    expect([...flat].sort()).toEqual(opsIn(constraint[0]!.def));

    // 칸 권한: 넣기 여섯 칸·고치기 세 칸만, 표 단위 넣기·고치기는 없고, 읽기는 표 단위, 지우기는 관제만
    for (const role of ['core_partner', 'core_app', 'core_ops'] as const) {
      const cols = (
        await admin.pool.query(
          `select c as col, has_column_privilege($1, 'idempotency_record', c, 'INSERT') as ins, has_column_privilege($1, 'idempotency_record', c, 'UPDATE') as upd
           from unnest($2::text[]) with ordinality as u(c, n) order by n`,
          [role, [...COLUMNS]],
        )
      ).rows as { col: string; ins: boolean; upd: boolean }[];
      expect(cols, role).toEqual(COLUMNS.map((col) => ({ col, ins: INSERTABLE.includes(col), upd: UPDATABLE.includes(col) })));
      const t = (
        await admin.pool.query(
          `select has_table_privilege($1, 'idempotency_record', 'SELECT') as sel, has_table_privilege($1, 'idempotency_record', 'INSERT') as ins,
                  has_table_privilege($1, 'idempotency_record', 'UPDATE') as upd, has_table_privilege($1, 'idempotency_record', 'DELETE') as del`,
          [role],
        )
      ).rows as { sel: boolean; ins: boolean; upd: boolean; del: boolean }[];
      expect(t, role).toEqual([{ sel: true, ins: false, upd: false, del: role === 'core_ops' }]);
    }
    // 정비·검색 역할은 이 표의 권한이 없다(정책도 없다, 결정 3)
    for (const role of ['core_maintenance', 'core_search'] as const) {
      const t = (
        await admin.pool.query(
          `select has_any_column_privilege($1, 'idempotency_record', 'SELECT, INSERT, UPDATE') as cols, has_table_privilege($1, 'idempotency_record', 'DELETE') as del`,
          [role],
        )
      ).rows as { cols: boolean; del: boolean }[];
      expect(t, role).toEqual([{ cols: false, del: false }]);
    }
    // 행 보안을 거치지 않는 비우기(TRUNCATE)와 이 표에 쓰지 않는 참조·트리거 권한은 다섯 역할 모두 없다
    // (결정 4: 표 단위로 남는 것은 읽기와 core_ops 지우기뿐, 결정 3 끝: 정비·검색 역할은 권한이 없다. 검증 V8·리뷰 RV6)
    for (const role of ['core_partner', 'core_app', 'core_ops', 'core_maintenance', 'core_search'] as const) {
      const t = (
        await admin.pool.query(
          `select has_table_privilege($1, 'idempotency_record', 'TRUNCATE') as truncate, has_table_privilege($1, 'idempotency_record', 'REFERENCES') as refs,
                  has_any_column_privilege($1, 'idempotency_record', 'REFERENCES') as col_refs, has_table_privilege($1, 'idempotency_record', 'TRIGGER') as trig`,
          [role],
        )
      ).rows as { truncate: boolean; refs: boolean; col_refs: boolean; trig: boolean }[];
      expect(t, role).toEqual([{ truncate: false, refs: false, col_refs: false, trig: false }]);
    }
  });
});
