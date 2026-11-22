// 웹훅 발송기 전용 DB 역할 core_notify 통합 시험(AZ-T19, W12-core-notify, ADR-0351, docs/security/authz-matrix.md §5.3·§7).
// 실제 PostgreSQL 18 컨테이너에 0043까지 올린 뒤, 운영과 같은 그룹 역할(core_notify)의 로그인 사용자로 발송기 저장소·발송기를 돌린다.
// 시드는 admin(슈퍼유저)으로 넣어 행 보안·칸 권한을 지난다. 단언 값은 정본에서: 권한·정책·칸 목록(ADR-0351 결정 3),
// 발송기 메서드(notify/adapters/db/drizzle-webhook-store.ts), 서명 규격(docs/features/notify.md §9).
// core_app이 이 묶음 뒤에도 두 표를 쓸 수 있는 것은 알려진 위험(두 번 나눔, ADR-0351 결정 5)이라 시험하지 않는다.
import 'reflect-metadata';
import { createDatabase, createService, type Database, type Clock } from '@peaket/platform';
import { eq, sql } from 'drizzle-orm';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { migrateCore } from '../scripts/migrate.mjs';
import { webhookDelivery, webhookEndpoint } from '../src/modules/notify/adapters/db/schema.js';
import { DrizzleWebhookStore, WebhookDispatcher, type WebhookTransport } from '../src/modules/notify/index.js';
import { NOTIFY_APP_STORE } from '../src/modules/notify/notify.module.js';
import type { WebhookStore } from '../src/modules/notify/domain/ports.js';
import { FakeIdentity, quiet, testMedia } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

const NOW = Date.parse('2026-11-20T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const A = randomUUID();
const B = randomUUID();
const A1 = randomUUID();
const A2 = randomUUID();
const B1 = randomUUID();
const E = randomUUID();
const F = randomUUID();
const P1 = randomUUID();
const P2 = randomUUID();
const D1 = randomUUID();
const S1 = randomUUID();

let pg: PostgresContainer;
let admin: Database;
let notify: Database;

type EndpointRow = typeof webhookEndpoint.$inferSelect;
const endpointSeed = (id: string, promoterId: string, o: Partial<EndpointRow>): EndpointRow => ({
  id,
  promoterId,
  url: 'https://seed.example/hook',
  eventTypes: ['order.confirmed'],
  status: 'ACTIVE',
  disabledReason: null,
  secret: 'whsec_seed',
  previousSecret: null,
  secretIssuedAt: new Date('2026-11-01T00:00:00.000Z'),
  previousSecretValidUntil: null,
  version: 1,
  ...o,
});
const SEED_ENDPOINTS: Record<string, EndpointRow> = {
  [A1]: endpointSeed(A1, A, { url: 'https://a1.partner-a.example/hook', secret: 'whsec_seed_a1' }),
  [A2]: endpointSeed(A2, A, { url: 'https://a2.partner-a.example/hook', eventTypes: ['order.cancelled'], status: 'DISABLED', disabledReason: 'PARTNER', secret: 'whsec_seed_a2', version: 3 }),
  // B1은 다른 사건만 구독해 ⑧의 order.confirmed를 받지 않는다
  [B1]: endpointSeed(B1, B, { url: 'https://b1.partner-b.example/hook', eventTypes: ['event.sold_out'], secret: 'whsec_seed_b1' }),
  // E는 발송기용: 켜짐, 옛 비밀이 아직 유효
  [E]: endpointSeed(E, B, {
    url: 'https://e.partner-b.example/hook',
    secret: 'whsec_seed_e',
    previousSecret: 'whsec_seed_e_old',
    secretIssuedAt: new Date(NOW - DAY),
    previousSecretValidUntil: new Date(NOW + 3 * DAY),
  }),
  [F]: endpointSeed(F, B, { url: 'https://f.partner-b.example/hook', status: 'DISABLED', disabledReason: 'PARTNER', secret: 'whsec_seed_f' }),
};

type DeliveryRow = typeof webhookDelivery.$inferInsert;
const deliverySeed = (id: string, status: DeliveryRow['status'], o: Partial<DeliveryRow>): DeliveryRow => ({
  id,
  endpointId: E,
  webhookId: `wh_${id}`,
  eventType: 'order.confirmed',
  status,
  attemptCount: 0,
  lastHttpStatus: null,
  lastError: null,
  nextAttemptAt: null,
  createdAt: new Date(NOW - DAY),
  finishedAt: null,
  payload: { type: 'order.confirmed', timestamp: new Date(NOW - DAY).toISOString(), data: { seed: true } },
  ...o,
});
const SEED_DELIVERIES: DeliveryRow[] = [
  deliverySeed(P1, 'PENDING', { nextAttemptAt: new Date(NOW) }),
  deliverySeed(P2, 'PENDING', { nextAttemptAt: new Date(NOW + DAY) }),
  deliverySeed(D1, 'DEAD', { attemptCount: 7, lastError: 'http-500', finishedAt: new Date(NOW - DAY), createdAt: new Date(NOW - 2 * DAY) }),
  deliverySeed(S1, 'SUCCEEDED', { attemptCount: 1, lastHttpStatus: 200, finishedAt: new Date(NOW - DAY), createdAt: new Date(NOW - 2 * DAY) }),
];

/** 거부된 쿼리의 SQLSTATE. Drizzle은 pg 오류를 cause로 감싼다. DB 오류가 아니면 그 글을 돌려 단언 차이에 드러낸다 */
const sqlState = (e: unknown): string => {
  const cause = e instanceof Error ? e.cause : undefined;
  return typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : `DB 오류 아님: ${String(e)}`;
};
/** 쿼리 하나의 결과: 바뀐 행 수(rowCount) 또는 거부된 SQLSTATE */
const run = (q: Promise<{ rowCount: number | null }>): Promise<number | null | string> => q.then((r) => r.rowCount, sqlState);

const endpointsNow = async () => Object.fromEntries((await admin.db.select().from(webhookEndpoint)).map((r) => [r.id, r]));
const deliveriesNow = async () => Object.fromEntries((await admin.db.select().from(webhookDelivery)).map((r) => [r.id, r]));

/** 시험마다 admin으로 시드를 새로 넣는다. 구현 전 트리에서는 고치기가 실제로 되므로 실패한 시험의 변경도 다음 시험 전에 지운다 */
async function seed(): Promise<void> {
  await admin.pool.query('delete from webhook_endpoint');
  await admin.db.insert(webhookEndpoint).values(Object.values(SEED_ENDPOINTS));
  await admin.db.insert(webhookDelivery).values(SEED_DELIVERIES);
}

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-notify-role-int-admin', max: 2 });
  notify = await loginFor(admin, pg, 'core_notify_login', 'core_notify', 2);
}, 180_000);
beforeEach(seed);
afterAll(async () => {
  await notify?.close();
  await admin?.close();
  pg?.stop();
});

describe('웹훅 발송기 전용 DB 역할 core_notify(ADR-0351)', () => {
  test('AZ-T19 ① 발송기 역할 core_notify는 끝점 읽기·끄기와 발송 원장 넣기·집기·저장·세기·마지막 성공을 할 수 있다 [ASVS v5.0.0-8.4.1]', async () => {
    const store = new DrizzleWebhookStore(notify);
    const active = await store.listActiveEndpoints(B);
    const found = await store.findEndpointById(E);
    const n1 = randomUUID();
    await store.insertDeliveries([
      {
        deliveryId: n1,
        endpointId: E,
        webhookId: 'wh_inserted',
        eventType: 'order.confirmed',
        status: 'PENDING',
        attemptCount: 0,
        lastHttpStatus: null,
        lastError: null,
        nextAttemptAt: new Date(NOW - 60_000),
        createdAt: new Date(NOW - 60_000),
        finishedAt: null,
        payload: { type: 'order.confirmed', timestamp: new Date(NOW - 60_000).toISOString(), data: { inserted: true } },
      },
    ]);
    const due = await store.listDueDeliveries(new Date(NOW), 10);
    const dueIds = due.map((d) => d.deliveryId);
    const leases = (await admin.pool.query<{ id: string; lease_until: Date | null }>('select id, lease_until from webhook_delivery where id = any($1::uuid[]) order by id', [[n1, P1]])).rows;
    const p1 = due.find((d) => d.deliveryId === P1)!;
    await store.saveDelivery({ ...p1, status: 'SUCCEEDED', attemptCount: 1, lastHttpStatus: 200, lastError: null, nextAttemptAt: null, finishedAt: new Date(NOW) });
    const dead = await store.countDeadSince(E, new Date(NOW - 5 * DAY));
    const lastSuccess = await store.lastSuccessAt(E);
    await store.disableEndpoint(A1, new Date(NOW));

    expect({
      active: active.map((e) => e.endpointId).sort(),
      found: found && { url: found.url, secret: found.secret, previousSecret: found.previousSecret, previousSecretValidUntil: found.previousSecretValidUntil },
      hasInserted: Boolean((await admin.db.select({ id: webhookDelivery.id }).from(webhookDelivery).where(eq(webhookDelivery.id, n1)))[0]),
      dueIds: dueIds.sort(),
      leaseMinutes: leases.map((r) => (r.lease_until ? Math.round((new Date(r.lease_until).getTime() - NOW) / 60_000) : null)),
      saved: { status: (await deliveriesNow())[P1]!.status, attemptCount: (await deliveriesNow())[P1]!.attemptCount, finishedAt: (await deliveriesNow())[P1]!.finishedAt },
      dead,
      lastSuccess,
      disabled: (await endpointsNow())[A1],
    }).toEqual({
      active: [B1, E].sort(),
      found: { url: SEED_ENDPOINTS[E]!.url, secret: 'whsec_seed_e', previousSecret: 'whsec_seed_e_old', previousSecretValidUntil: new Date(NOW + 3 * DAY) },
      hasInserted: true,
      dueIds: [n1, P1].sort(),
      leaseMinutes: [2, 2],
      saved: { status: 'SUCCEEDED', attemptCount: 1, finishedAt: new Date(NOW) },
      dead: 1,
      lastSuccess: new Date(NOW),
      disabled: { ...SEED_ENDPOINTS[A1]!, status: 'DISABLED', disabledReason: 'FAILING', version: 2 },
    });
  });

  test('AZ-T19 ② core_notify는 webhook_endpoint·webhook_delivery 밖의 표를 읽거나 쓰지 못한다 [ASVS v5.0.0-8.4.1]', async () => {
    const others = ['product', 'merch_order', 'production', 'outbox', 'attendee_export_audit'];
    const outcome: Record<string, { select: string | null | number; insert: string | null | number; delete: string | null | number }> = {};
    for (const table of others) {
      outcome[table] = {
        select: await run(notify.db.execute(sql.raw(`select count(*) from "${table}"`))),
        insert: await run(notify.db.execute(sql.raw(`insert into "${table}" select * from "${table}" where false`))),
        delete: await run(notify.db.execute(sql.raw(`delete from "${table}" where false`))),
      };
    }
    expect(outcome).toEqual(
      Object.fromEntries(others.map((t) => [t, { select: '42501', insert: '42501', delete: '42501' }])),
    );
  });

  test('AZ-T19 ③ core_notify는 webhook_endpoint의 비밀·주소·구독·판매자·끝점 ID를 고치지 못하고 켜진 끝점을 FAILING으로 끄는 세 칸만 고친다 [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-8.2.3]', async () => {
    const onA1 = eq(webhookEndpoint.id, A1);
    /** 칸 권한만 본다: 허용된 끄기(status·disabled_reason)를 함께 SET해 정책을 통과시키고, 고치기가 되면 트랜잭션을 되돌린다(칸 권한이 없으면 42501) */
    const attempt = async (values: Partial<typeof webhookEndpoint.$inferInsert>): Promise<string> => {
      try {
        await notify.db.transaction(async (tx) => {
          await tx.update(webhookEndpoint).set({ ...values, status: 'DISABLED', disabledReason: 'FAILING' }).where(onA1);
          tx.rollback();
        });
        return 'COMMITTED';
      } catch (e) {
        return sqlState(e);
      }
    };
    /** 끝점 ID는 Drizzle에서 SQL 식만 받으므로 따로 둔다 */
    const attemptId = async (): Promise<string> => {
      try {
        await notify.db.transaction(async (tx) => {
          await tx.update(webhookEndpoint).set({ id: sql`${webhookEndpoint.id}`, status: 'DISABLED', disabledReason: 'FAILING' }).where(onA1);
          tx.rollback();
        });
        return 'COMMITTED';
      } catch (e) {
        return sqlState(e);
      }
    };
    const denied = {
      secret: await attempt({ secret: 'whsec_attacker' }),
      url: await attempt({ url: 'https://attacker.example/hook' }),
      previousSecret: await attempt({ previousSecret: 'whsec_attacker_old' }),
      previousSecretValidUntil: await attempt({ previousSecretValidUntil: new Date('2027-06-01T00:00:00.000Z') }),
      eventTypes: await attempt({ eventTypes: ['payout.completed'] }),
      secretIssuedAt: await attempt({ secretIssuedAt: new Date('2026-11-19T00:00:00.000Z') }),
      promoterId: await attempt({ promoterId: B }),
      id: await attemptId(),
    };
    const allowed = await run(notify.db.update(webhookEndpoint).set({ status: 'DISABLED', disabledReason: 'FAILING', version: sql`${webhookEndpoint.version} + 1` }).where(onA1));
    const reEnable = await run(notify.db.update(webhookEndpoint).set({ status: 'ACTIVE', disabledReason: null }).where(eq(webhookEndpoint.id, A2)));
    const wrongReason = await run(notify.db.update(webhookEndpoint).set({ disabledReason: 'PARTNER' }).where(onA1));
    // 켜진 B1을 사유 PARTNER로 끄는 것은 USING은 지나지만 WITH CHECK(사유 FAILING)에 걸려 42501이다
    const partnerOff = await run(notify.db.update(webhookEndpoint).set({ status: 'DISABLED', disabledReason: 'PARTNER' }).where(eq(webhookEndpoint.id, B1)));

    expect({ denied, allowed, reEnable, wrongReason, partnerOff, endpoints: await endpointsNow() }).toEqual({
      denied: { secret: '42501', url: '42501', previousSecret: '42501', previousSecretValidUntil: '42501', eventTypes: '42501', secretIssuedAt: '42501', promoterId: '42501', id: '42501' },
      allowed: 1,
      reEnable: 0,
      wrongReason: 0,
      partnerOff: '42501',
      endpoints: { ...SEED_ENDPOINTS, [A1]: { ...SEED_ENDPOINTS[A1]!, status: 'DISABLED', disabledReason: 'FAILING', version: 2 } },
    });
  });

  test('AZ-T19 ⑤ core_notify는 끝난 발송 원장 행을 되돌리거나 본문·식별 칸을 고치지 못한다 [ASVS v5.0.0-8.4.1]', async () => {
    const onP1 = eq(webhookDelivery.id, P1);
    const denied = {
      payload: await run(notify.db.update(webhookDelivery).set({ payload: { hacked: true } }).where(onP1)),
      endpointId: await run(notify.db.update(webhookDelivery).set({ endpointId: B1 }).where(onP1)),
      webhookId: await run(notify.db.update(webhookDelivery).set({ webhookId: 'wh_hacked' }).where(onP1)),
      eventType: await run(notify.db.update(webhookDelivery).set({ eventType: 'payout.completed' }).where(onP1)),
      createdAt: await run(notify.db.update(webhookDelivery).set({ createdAt: new Date(NOW) }).where(onP1)),
    };
    const reviveDead = await run(notify.db.update(webhookDelivery).set({ status: 'PENDING', finishedAt: null, nextAttemptAt: new Date(NOW), leaseUntil: null }).where(eq(webhookDelivery.id, D1)));
    const reviveSuccess = await run(notify.db.update(webhookDelivery).set({ status: 'RETRYING', finishedAt: null, nextAttemptAt: new Date(NOW), leaseUntil: null }).where(eq(webhookDelivery.id, S1)));
    const finishDue = await run(notify.db.update(webhookDelivery).set({ status: 'DEAD', finishedAt: new Date(NOW), nextAttemptAt: null, leaseUntil: null }).where(onP1));
    const seededNow = Object.fromEntries(SEED_DELIVERIES.map((d) => [d.id!, { ...d, leaseUntil: null }]));

    expect({ denied, reviveDead, reviveSuccess, finishDue, deliveries: await deliveriesNow() }).toEqual({
      denied: { payload: '42501', endpointId: '42501', webhookId: '42501', eventType: '42501', createdAt: '42501' },
      reviveDead: 0,
      reviveSuccess: 0,
      finishDue: 1,
      deliveries: { ...seededNow, [P1]: { ...SEED_DELIVERIES[0]!, status: 'DEAD', finishedAt: new Date(NOW), nextAttemptAt: null, leaseUntil: null } },
    });
  });

  test('AZ-T19 ⑥ core_notify는 끝점을 넣거나 두 표의 행을 지우지 못한다 [ASVS v5.0.0-8.4.1]', async () => {
    const outcome = {
      insertEndpoint: await run(notify.db.execute(sql.raw('insert into webhook_endpoint select * from webhook_endpoint where false'))),
      deleteEndpoint: await run(notify.db.execute(sql.raw('delete from webhook_endpoint where false'))),
      deleteDelivery: await run(notify.db.execute(sql.raw('delete from webhook_delivery where false'))),
      truncateDelivery: await run(notify.db.execute(sql.raw('truncate webhook_delivery'))),
    };
    expect(outcome).toEqual({ insertEndpoint: '42501', deleteEndpoint: '42501', deleteDelivery: '42501', truncateDelivery: '42501' });
  });

  test('AZ-T19 ⑦ core_notify 역할·정책·칸 권한이 ADR-0351 결정 1·3과 같고 표 소유자가 아니며 FORCE가 없다 [ASVS v5.0.0-8.4.1]', async () => {
    const rows = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await admin.pool.query<T>(text, params)).rows;
    const TABLES = ['webhook_delivery', 'webhook_endpoint'];
    const role = (await rows<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>('select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = $1', ['core_notify']))[0];
    const tables = await rows<{ relname: string; rls: boolean; forced: boolean; owner: string }>(
      `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner) as owner
       from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1) order by c.relname collate "C"`,
      [TABLES],
    );
    const policies = await rows<{ tablename: string; policyname: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null }>(
      `select tablename, policyname, cmd, roles::text[] as roles, qual, with_check from pg_policies where schemaname = 'public' and tablename = any($1) order by tablename collate "C", policyname collate "C"`,
      [TABLES],
    );
    // 이 묶음이 더한 정책만 본다. core_app·core_partner의 기존 정책은 다음 배포의 회수 몫이라 여기서 세지 않는다(알려진 위험)
    const notifyPolicies = policies.filter((p) => p.roles.includes('core_notify'));
    const columnsWith = async (table: string, privilege: 'UPDATE' | 'INSERT' | 'SELECT') =>
      (
        await rows<{ attname: string }>(
          `select a.attname from pg_attribute a where a.attrelid = ('public.' || $1::text)::regclass and a.attnum > 0 and not a.attisdropped and has_column_privilege('core_notify', a.attrelid, a.attnum, $2::text)`,
          [table, privilege],
        )
      )
        .map((r) => r.attname)
        .sort();
    const tablePriv = async (table: string, privilege: string) => (await rows<{ ok: boolean }>(`select has_table_privilege('core_notify', 'public.' || $1::text, $2::text) as ok`, [table, privilege]))[0]!.ok;
    const privileges = {
      endpoint: {
        select: await tablePriv('webhook_endpoint', 'SELECT'),
        insert: await tablePriv('webhook_endpoint', 'INSERT'),
        updateTable: await tablePriv('webhook_endpoint', 'UPDATE'),
        delete: await tablePriv('webhook_endpoint', 'DELETE'),
        updateColumns: await columnsWith('webhook_endpoint', 'UPDATE'),
      },
      delivery: {
        select: await tablePriv('webhook_delivery', 'SELECT'),
        insert: await tablePriv('webhook_delivery', 'INSERT'),
        updateTable: await tablePriv('webhook_delivery', 'UPDATE'),
        delete: await tablePriv('webhook_delivery', 'DELETE'),
        updateColumns: await columnsWith('webhook_delivery', 'UPDATE'),
      },
      roles: {
        coreApp: (await rows<{ ok: boolean }>(`select pg_has_role('core_notify', 'core_app', 'member') as ok`))[0]!.ok,
        corePartner: (await rows<{ ok: boolean }>(`select pg_has_role('core_notify', 'core_partner', 'member') as ok`))[0]!.ok,
      },
    };
    const appRoles = ['core_app', 'core_partner', 'core_ops', 'core_maintenance', 'core_search', 'core_notify', 'core_notify_login'];

    expect({
      role,
      tables: tables.map((t) => ({ relname: t.relname, rls: t.rls, forced: t.forced, appOwner: appRoles.includes(t.owner) })),
      policyKeys: notifyPolicies.map((p) => ({ tablename: p.tablename, policyname: p.policyname, cmd: p.cmd, roles: p.roles })),
      endpointPolicy: {
        disable: notifyPolicies.find((p) => p.policyname === 'webhook_endpoint_notify_disable'),
        read: notifyPolicies.find((p) => p.policyname === 'webhook_endpoint_notify_read'),
      },
      deliveryPolicy: {
        insert: notifyPolicies.find((p) => p.policyname === 'webhook_delivery_notify_insert'),
        read: notifyPolicies.find((p) => p.policyname === 'webhook_delivery_notify_read'),
        update: notifyPolicies.find((p) => p.policyname === 'webhook_delivery_notify_update'),
      },
      privileges,
    }).toEqual({
      role: { rolcanlogin: false, rolsuper: false, rolbypassrls: false },
      tables: TABLES.map((relname) => ({ relname, rls: true, forced: false, appOwner: false })),
      policyKeys: [
        { tablename: 'webhook_delivery', policyname: 'webhook_delivery_notify_insert', cmd: 'INSERT', roles: ['core_notify'] },
        { tablename: 'webhook_delivery', policyname: 'webhook_delivery_notify_read', cmd: 'SELECT', roles: ['core_notify'] },
        { tablename: 'webhook_delivery', policyname: 'webhook_delivery_notify_update', cmd: 'UPDATE', roles: ['core_notify'] },
        { tablename: 'webhook_endpoint', policyname: 'webhook_endpoint_notify_disable', cmd: 'UPDATE', roles: ['core_notify'] },
        { tablename: 'webhook_endpoint', policyname: 'webhook_endpoint_notify_read', cmd: 'SELECT', roles: ['core_notify'] },
      ],
      endpointPolicy: {
        disable: expect.objectContaining({ qual: expect.stringMatching(/status = 'ACTIVE'::text/), with_check: expect.stringMatching(/status = 'DISABLED'::text[\s\S]*disabled_reason = 'FAILING'::text/) }),
        read: expect.objectContaining({ qual: 'true', with_check: null }),
      },
      deliveryPolicy: {
        insert: expect.objectContaining({ qual: null, with_check: 'true' }),
        read: expect.objectContaining({ qual: 'true', with_check: null }),
        update: expect.objectContaining({
          qual: expect.stringMatching(/status = ANY[\s\S]*PENDING[\s\S]*RETRYING/),
          with_check: expect.stringMatching(/status = ANY[\s\S]*PENDING[\s\S]*RETRYING[\s\S]*SUCCEEDED[\s\S]*DEAD/),
        }),
      },
      privileges: {
        endpoint: { select: true, insert: false, updateTable: false, delete: false, updateColumns: ['disabled_reason', 'status', 'version'] },
        delivery: { select: true, insert: true, updateTable: false, delete: false, updateColumns: ['attempt_count', 'finished_at', 'last_error', 'last_http_status', 'lease_until', 'next_attempt_at', 'status'] },
        roles: { coreApp: false, corePartner: false },
      },
    });
    // 식은 정확히: UPDATE 정책의 USING에는 SUCCEEDED·DEAD가 없고, WITH CHECK에는 네 상태가 모두 있다
    expect(notifyPolicies.find((p) => p.policyname === 'webhook_delivery_notify_update')!.qual).not.toMatch(/SUCCEEDED|DEAD/);
  });

  test('AZ-T19 ⑧ 실제 발송기를 core_notify 저장소로 돌리면 구독한 끝점에 서명해 보내고 성공을 원장에 남긴다 [ASVS v5.0.0-8.4.1]', async () => {
    await admin.pool.query('delete from webhook_delivery');
    class Receiver implements WebhookTransport {
      readonly calls: { url: string; headers: Record<string, string>; body: string }[] = [];
      async send(input: { url: string; headers: Record<string, string>; body: string }) {
        this.calls.push(input);
        return { status: 200 };
      }
    }
    const receiver = new Receiver();
    const clock: Clock = { now: () => NOW, monotonicMs: () => 0 };
    const dispatcher = new WebhookDispatcher({ store: new DrizzleWebhookStore(notify), transport: receiver, clock });
    const enqueued = await dispatcher.enqueue({ promoterId: B, eventType: 'order.confirmed', data: { orderId: 'o-1' } });
    const sent = await dispatcher.processDue(new Date(NOW), 10);
    const timestamp = String(Math.floor(NOW / 1000));
    // jsonb는 칸 차례를 보존하지 않으므로 저장한 본문 그대로(수신기가 받은 문자열)로 서명을 검증한다
    const call = receiver.calls[0]!;
    const content = `${enqueued[0]!.webhookId}.${timestamp}.${call.body}`;
    const sign = (secret: string) => `v1,${createHmac('sha256', secret).update(content).digest('base64')}`;
    // E의 옛 비밀이 아직 유효하므로 두 서명을 함께 붙인다(notify.md §9, ADR-0053 결정 4)
    const expectedSignature = `${sign('whsec_seed_e')} ${sign('whsec_seed_e_old')}`;
    const saved = (await admin.db.select().from(webhookDelivery).where(eq(webhookDelivery.id, enqueued[0]!.deliveryId)))[0];

    expect({ enqueued: enqueued.map((d) => ({ endpointStatus: d.status, eventType: d.eventType })), sent, calls: receiver.calls.map((c) => ({ url: c.url, headers: c.headers, body: JSON.parse(c.body) })), saved: saved && { status: saved.status, attemptCount: saved.attemptCount, lastHttpStatus: saved.lastHttpStatus, finishedAt: saved.finishedAt } }).toEqual({
      enqueued: [{ endpointStatus: 'PENDING', eventType: 'order.confirmed' }],
      sent: { attempted: 1, succeeded: 1, retrying: 0, dead: 0, disabled: [] },
      calls: [
        {
          url: SEED_ENDPOINTS[E]!.url,
          headers: {
            'content-type': 'application/json',
            'webhook-id': enqueued[0]!.webhookId,
            'webhook-timestamp': timestamp,
            'webhook-signature': expectedSignature,
            'user-agent': 'PEAKET-Webhook/1',
          },
          body: { type: 'order.confirmed', timestamp: new Date(NOW).toISOString(), data: { orderId: 'o-1' } },
        },
      ],
      saved: { status: 'SUCCEEDED', attemptCount: 1, lastHttpStatus: 200, finishedAt: new Date(NOW) },
    });
  });

  test('AZ-T19 ⑧ 내부 입구의 NOTIFY_APP_STORE도 notifyDatabase 저장소를 쓴다(팬 경로 풀로 되돌아가지 않는다) [ASVS v5.0.0-8.4.1]', async () => {
    // 닿지 않는 notifyDatabase를 주고, 팬 경로 database(admin)로 몰래 되돌아가면 이 읽기가 성공해 버린다
    const broken = createDatabase({ url: 'postgres://127.0.0.1:1/peaket', applicationName: 'notify-wiring-broken', max: 1, connectionTimeoutMillis: 200 });
    const svc = await createService({
      name: 'core-svc',
      module: AppModule.register({ database: admin, notifyDatabase: broken, partnerDatabase: admin, media: testMedia() }),
      env: { PEAKET_ENV: 'ci' },
      logDestination: quiet(),
      adminAuthz: new FakeIdentity(),
    });
    try {
      const store = svc.app.get<WebhookStore>(NOTIFY_APP_STORE);
      await expect(store.listActiveEndpoints(B)).rejects.toThrow();
    } finally {
      await svc.close();
      await broken.close();
    }
  });
});
