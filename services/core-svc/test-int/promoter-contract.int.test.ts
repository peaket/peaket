// 파트너 계약 조건·기간 이력·2인 승인 적용과 판매 승인 때 수수료율 고정(BAT-615 LCH-070, J-T29 ②③⑨, J-T30 ①~⑤).
// 실제 PostgreSQL 18 컨테이너에 0033 전 마이그레이션을 먼저 적용하고 기존 파트너를 심은 뒤 0033을 적용해 백필을 본다.
// 그 뒤 운영과 같은 DB 역할(core_app·core_partner·core_ops)로 계약 기간·WITHOUT OVERLAPS·트랜잭션 되돌림·판매 승인 고정을 확인한다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Clock, createDatabase, createService, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import pgClient from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleCommissionRate, DrizzleSaleConfigMaintenanceStore, DrizzleSaleConfigStore, DrizzleSaleStore, MemoryOpsApprovals, NoopSaleConfigFacts, PublishSaleConfigs, saleConfigMaintenanceTasks } from '../src/modules/catalog/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';
import { FakeIdentity, quiet, testMedia } from '../test/support.js';

const NOW = Date.parse('2026-11-20T00:00:00.000Z');
const clock: Clock = { now: () => NOW, monotonicMs: () => performance.now() };
const identity = new FakeIdentity();
const opsApprovals = new MemoryOpsApprovals();

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let opsDb: Database;
let svc: Awaited<ReturnType<typeof createService>>;
let migDir: string | undefined;

/** 0033과 그 뒤 마이그레이션을 빼고 적용해 '기존 파트너'를 심을 수 있는 DB를 만든다 */
async function migrateBeforePromoterContract(url: string): Promise<string> {
  const source = fileURLToPath(new URL('../migrations', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'peaket-core-0033-'));
  const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  const kept = journal.entries.filter((e) => e.tag < '0033_promoter_contract');
  await mkdir(join(dir, 'meta'), { recursive: true });
  for (const e of kept) await copyFile(join(source, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  await writeFile(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }));
  const client = new pgClient.Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder: dir });
  } finally {
    await client.end();
  }
  return dir;
}

const OLD_A = randomUUID();
const OLD_B = randomUUID();
/** 0033 이전에 이미 판매 승인된 회차(백필 시험용) */
const OLD_PLACE = randomUUID();
const OLD_PRODUCTION = randomUUID();
const OLD_EVENT = randomUUID();
const PLACE = randomUUID();
const general = { version: 1, name: '일반', rounds: 'ALL', rule: { then: { limitPerPerson: 4 } } };

beforeAll(async () => {
  pg = await startPostgres();
  migDir = await migrateBeforePromoterContract(pg.url);
  // 0033 전에는 commission_rate_bp 칸이 없다. 상호만 있는 기존 파트너 둘을 심는다.
  const seed = new pgClient.Client({ connectionString: pg.url });
  await seed.connect();
  try {
    await seed.query('insert into promoter (id, legal_name) values ($1, $2), ($3, $4)', [OLD_A, '(주)먼저온파트너', OLD_B, '(주)옛계약']);
    // 0033 이전에 이미 판매 승인된 공연·회차와 그때의 설정 사본(수수료율 없음)을 심는다.
    // 0033이 이 회차들의 event.commission_rate_bp를 계약(백필 1000bp)으로 채우는지 본다(RV-02).
    await seed.query('insert into place (id, name, address, region, created_by) values ($1, $2, $3, $4, $5)', [OLD_PLACE, '옛공연장', '서울 옛길 1', '서울', randomUUID()]);
    await seed.query(
      `insert into production (id, promoter_id, place_id, title, genre, sale_review, sale_approved_at, sale_policy, sale_policy_version)
       values ($1, $2, $3, $4, '콘서트', 'APPROVED', $5, $6::jsonb, 1)`,
      [OLD_PRODUCTION, OLD_A, OLD_PLACE, '0033 이전 승인 공연', new Date(NOW - 86_400_000), JSON.stringify([general])],
    );
    await seed.query(
      `insert into event (id, production_id, promoter_id, open_at, starts_at, ends_at, version)
       values ($1, $2, $3, $4, $5, $6, 1)`,
      [OLD_EVENT, OLD_PRODUCTION, OLD_A, new Date(NOW - 43_200_000), new Date(NOW + 9 * 86_400_000), new Date(NOW + 9 * 86_400_000 + 9_000_000)],
    );
    await seed.query(
      `insert into event_sale_config (event_id, production_id, promoter_id, rev, payload, updated_at)
       values ($1, $2, $3, 1, $4::jsonb, $5)`,
      [OLD_EVENT, OLD_PRODUCTION, OLD_A, JSON.stringify({ eventId: OLD_EVENT, productionId: OLD_PRODUCTION, promoterId: OLD_A, rev: 1 }), new Date(NOW - 86_400_000)],
    );
  } finally {
    await seed.end();
  }
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-promoter-contract-it', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 4);
  opsDb = await loginFor(admin, pg, 'core_ops_login', 'core_ops', 4);
  await admin.pool.query('insert into place (id, name, address, region, created_by) values ($1, $2, $3, $4, $5)', [PLACE, '피켓홀', '서울 어딘가 1', '서울', randomUUID()]);
  svc = await createService({
    name: 'core-svc-promoter-contract',
    module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, opsDatabase: opsDb, media: testMedia(), opsApprovals }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
}, 240_000);

afterAll(async () => {
  await svc?.close().catch(() => undefined);
  await appDb?.close().catch(() => undefined);
  await partnerDb?.close().catch(() => undefined);
  await opsDb?.close().catch(() => undefined);
  await admin?.close().catch(() => undefined);
  pg?.stop();
  if (migDir) await rm(migDir, { recursive: true, force: true }).catch(() => undefined);
});

const headers = (extra: Record<string, string> = {}) => ({ ...identity.ops('operator'), ...extra });
const withJson = (extra: Record<string, string> = {}) => headers({ 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...extra });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

async function createPromoter(o: { name?: string; commissionRateBp?: number; guaranteeRateBp?: number; guaranteeKind?: 'DEPOSIT' | 'PERFORMANCE_BOND' } = {}): Promise<string> {
  const r = await svc.http.inject({
    method: 'POST',
    url: '/v1/ops/promoters',
    headers: withJson(),
    payload: JSON.stringify({
      legalName: o.name ?? `새파트너-${randomUUID().slice(0, 8)}`,
      commissionRateBp: o.commissionRateBp ?? 875,
      guaranteeRateBp: o.guaranteeRateBp ?? 700,
      guaranteeKind: o.guaranteeKind ?? 'PERFORMANCE_BOND',
    }),
  });
  expect(r.statusCode, r.payload).toBe(201);
  return (json(r).promoterId as string);
}

/** 등록 응답 경로(detail)의 시각 변환을 거치지 않고 DB에 파트너·첫 계약을 심는다(계약 적용·판매 승인 시험용) */
async function seedPromoter(o: { commissionRateBp?: number; guaranteeRateBp?: number; guaranteeKind?: 'DEPOSIT' | 'PERFORMANCE_BOND' } = {}): Promise<string> {
  const id = randomUUID();
  const commissionRateBp = o.commissionRateBp ?? 875;
  const guaranteeRateBp = o.guaranteeRateBp ?? 700;
  const guaranteeKind = o.guaranteeKind ?? 'PERFORMANCE_BOND';
  await admin.pool.query('insert into promoter (id, legal_name, commission_rate_bp) values ($1, $2, $3)', [id, `심은파트너-${id.slice(0, 8)}`, commissionRateBp]);
  await admin.pool.query(
    `insert into promoter_contract (id, promoter_id, commission_rate_bp, guarantee_rate_bp, guarantee_kind, valid_during, created_by)
     values ($1, $2, $3, $4, $5, tstzrange($6, NULL, '[)'), $7)`,
    [randomUUID(), id, commissionRateBp, guaranteeRateBp, guaranteeKind, new Date(NOW), randomUUID()],
  );
  return id;
}

/** 승인 적용 대신 계약을 직접 900bp로 바꾼다(판매 승인 고정만 볼 때) */
async function changeContractDirect(promoterId: string, commissionRateBp: number, at: Date): Promise<void> {
  await admin.pool.query(`update promoter_contract set valid_during = tstzrange(lower(valid_during), $2, '[)') where promoter_id = $1 and upper_inf(valid_during)`, [promoterId, at]);
  await admin.pool.query(
    `insert into promoter_contract (id, promoter_id, commission_rate_bp, guarantee_rate_bp, guarantee_kind, valid_during, approval_id, created_by)
     values ($1, $2, $3, 650, 'DEPOSIT', tstzrange($4, NULL, '[)'), $5, $6)`,
    [randomUUID(), promoterId, commissionRateBp, at, randomUUID(), randomUUID()],
  );
  await admin.pool.query('update promoter set commission_rate_bp = $2 where id = $1', [promoterId, commissionRateBp]);
}

const askChange = (promoterId: string, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/promoters/${promoterId}/contract-term-changes`, headers: withJson(), payload: JSON.stringify(body) });
const applyChange = (promoterId: string, approvalId: string, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: `/internal/v1/promoters/${promoterId}/contract-approvals/${approvalId}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const cancelChange = (promoterId: string, approvalId: string) =>
  svc.http.inject({ method: 'POST', url: `/internal/v1/promoters/${promoterId}/contract-approvals/${approvalId}/cancellations`, headers: { 'content-type': 'application/json' }, payload: '{}' });

interface PeriodRow {
  commission_rate_bp: number;
  guarantee_rate_bp: number;
  guarantee_kind: string;
  from: Date;
  until: Date | null;
  inf: boolean;
  approval_id: string | null;
}

const periods = async (promoterId: string): Promise<PeriodRow[]> =>
  (
    await admin.pool.query<PeriodRow>(
      `select commission_rate_bp, guarantee_rate_bp, guarantee_kind, lower(valid_during) as "from", upper(valid_during) as "until",
              upper_inf(valid_during) as inf, approval_id
         from promoter_contract where promoter_id = $1 order by lower(valid_during)`,
      [promoterId],
    )
  ).rows;

const promoterRow = async (promoterId: string): Promise<{ commission_rate_bp: number; pending_contract_approval_id: string | null }> =>
  (await admin.pool.query<{ commission_rate_bp: number; pending_contract_approval_id: string | null }>('select commission_rate_bp, pending_contract_approval_id from promoter where id = $1', [promoterId])).rows[0]!;

const overlapCount = async (): Promise<number> =>
  Number(
    (
      await admin.pool.query<{ n: string }>(
        `select count(*) as n from promoter_contract a join promoter_contract b
           on a.promoter_id = b.promoter_id and a.id < b.id and a.valid_during && b.valid_during`,
      )
    ).rows[0]!.n,
  );

/** 판매 승인 대기 공연 하나(공개본 규칙 general) */
async function makeSubmitted(promoterId: string, eventIds: string[]): Promise<string> {
  const productionId = randomUUID();
  await admin.pool.query(
    `insert into production (id, promoter_id, place_id, title, genre, sale_review, sale_policy, sale_policy_version)
     values ($1, $2, $3, $4, '콘서트', 'SUBMITTED', $5::jsonb, 1)`,
    [productionId, promoterId, PLACE, `공연-${productionId.slice(0, 8)}`, JSON.stringify([general])],
  );
  for (const [i, eventId] of eventIds.entries()) {
    await admin.pool.query(
      `insert into event (id, production_id, promoter_id, open_at, starts_at, ends_at, version)
       values ($1, $2, $3, $4, $5, $6, 1)`,
      [eventId, productionId, promoterId, new Date(NOW + (i + 1) * 86_400_000), new Date(NOW + (i + 10) * 86_400_000), new Date(NOW + (i + 10) * 86_400_000 + 9_000_000)],
    );
  }
  return productionId;
}

const approveSale = (productionId: string, eventIds: string[]) =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/ops/sale-reviews/${productionId}/approvals`,
    headers: withJson(),
    payload: JSON.stringify({ scales: eventIds.map((eventId, i) => ({ eventId, scale: i % 2 === 0 ? 'SMALL' : 'MEDIUM' })), placeId: PLACE }),
  });

const eventRow = async (eventId: string) =>
  (await admin.pool.query<{ commission_rate_bp: number | null; version: number }>('select commission_rate_bp, version from event where id = $1', [eventId])).rows[0];
const configRow = async (eventId: string) =>
  (await admin.pool.query<{ rev: number; payload: Record<string, unknown> }>('select rev, payload from event_sale_config where event_id = $1', [eventId])).rows[0];

const internalRate = (eventId: string) => svc.http.inject({ method: 'GET', url: `/internal/v1/events/${eventId}/commission-rate` });
const internalConfig = (eventId: string) => svc.http.inject({ method: 'GET', url: `/internal/v1/events/${eventId}/sale-config` });

describe('J-T30 ⑤ 마이그레이션 백필과 기간 제약(실제 PostgreSQL)', () => {
  test('[ASVS v5.0.0-2.3.4] J-T30 ⑤_기존_파트너마다_1000bp_계약_한_기간이_생기고_현재_값이_1000bp다', async () => {
    for (const promoterId of [OLD_A, OLD_B]) {
      const rows = await periods(promoterId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ commission_rate_bp: 1000, guarantee_rate_bp: 1000, guarantee_kind: 'DEPOSIT', until: null, inf: true, approval_id: null });
      expect((await promoterRow(promoterId)).commission_rate_bp).toBe(1000);
    }
    expect(await overlapCount()).toBe(0);
  });

  test('J-T30 ⑤_RV-02_0033_이전_승인_회차는_계약_수수료율로_백필되고_정산_503이_풀린다', async () => {
    // 0033 이전에 승인된 회차는 event.commission_rate_bp가 없고 설정 사본에도 수수료율이 없어 payment-svc 정산이 503으로 닫혔다.
    // 0033이 그 파트너의 지금 계약(기존 행 백필 1000bp)으로 한 번 채우고, 정비 일이 사본을 다시 쓰면 내부 경로가 200이 된다.
    expect((await eventRow(OLD_EVENT))?.commission_rate_bp).toBe(1000);

    const publish = new PublishSaleConfigs(new DrizzleSaleStore(opsDb), new DrizzleSaleConfigStore(opsDb), new NoopSaleConfigFacts(), clock);
    const [task] = saleConfigMaintenanceTasks(new DrizzleSaleConfigMaintenanceStore(opsDb), publish);
    await expect(task!.run()).resolves.toMatchObject({ failed: 0 });

    expect((await configRow(OLD_EVENT))?.payload).toMatchObject({ commissionRateBp: 1000 });
    const rate = await internalRate(OLD_EVENT);
    expect(rate.statusCode).toBe(200);
    expect(json(rate)).toEqual({ commissionRateBp: 1000 });
  });

  test('J-T30 ⑤_btree_gist와_WITHOUT_OVERLAPS가_있고_겹치는_기간은_거절한다', async () => {
    const ext = await admin.pool.query("select 1 from pg_extension where extname = 'btree_gist'");
    expect(ext.rowCount).toBe(1);
    const cons = await admin.pool.query<{ conname: string; def: string }>("select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'promoter_contract'::regclass");
    expect(cons.rows.find((r) => r.conname === 'promoter_contract_promoter_period_uq')?.def).toContain('WITHOUT OVERLAPS');

    // 경계가 맞닿은 기간은 겹치지 않는다. 1ms만 겹쳐도 btree_gist가 막는다.
    const p = randomUUID();
    await admin.pool.query('insert into promoter (id, legal_name, commission_rate_bp) values ($1, $2, 900)', [p, '(주)경계시험']);
    const t0 = new Date('2027-01-01T00:00:00.000Z');
    const t1 = new Date('2027-02-01T00:00:00.000Z');
    const t2 = new Date('2027-03-01T00:00:00.000Z');
    await admin.pool.query(`insert into promoter_contract (id, promoter_id, commission_rate_bp, guarantee_rate_bp, guarantee_kind, valid_during) values ($1, $2, 900, 700, 'DEPOSIT', tstzrange($3, $4, '[)'))`, [randomUUID(), p, t0, t1]);
    await admin.pool.query(`insert into promoter_contract (id, promoter_id, commission_rate_bp, guarantee_rate_bp, guarantee_kind, valid_during) values ($1, $2, 900, 700, 'DEPOSIT', tstzrange($3, $4, '[)'))`, [randomUUID(), p, t1, t2]);
    await expect(
      admin.pool.query(`insert into promoter_contract (id, promoter_id, commission_rate_bp, guarantee_rate_bp, guarantee_kind, valid_during) values ($1, $2, 900, 700, 'DEPOSIT', tstzrange($3, $4, '[)'))`, [
        randomUUID(),
        p,
        new Date(t1.getTime() - 1),
        t2,
      ]),
    ).rejects.toMatchObject({ code: '23P01' });
    expect(await overlapCount()).toBe(0);
    await admin.pool.query('delete from promoter_contract where promoter_id = $1', [p]);
    await admin.pool.query('delete from promoter where id = $1', [p]);
  });

  test('J-T30 ⑤_새_파트너는_등록_값_그대로_첫_계약을_받는다(백필_1000bp를_쓰지_않는다)', async () => {
    const id = await createPromoter({ commissionRateBp: 875, guaranteeRateBp: 700, guaranteeKind: 'PERFORMANCE_BOND' });
    expect(await periods(id)).toEqual([expect.objectContaining({ commission_rate_bp: 875, guarantee_rate_bp: 700, guarantee_kind: 'PERFORMANCE_BOND', until: null, inf: true, approval_id: null })]);
    expect((await promoterRow(id)).commission_rate_bp).toBe(875);
  });

  test('J-T30 ⑤_core_app은_계약_표를_읽지_못하고_core_partner는_자기_계약만_본다', async () => {
    await expect(appDb.pool.query('select count(*) from promoter_contract')).rejects.toThrow(/permission denied/i);
    const countFor = async (tenantId: string, promoterId: string): Promise<number> =>
      partnerDb.transaction(
        async (tx) => {
          const out = await tx.execute(sql`select count(*) as n from promoter_contract where promoter_id = ${promoterId}::uuid`);
          return Number((out.rows[0] as { n: string }).n);
        },
        { tenantId },
      );
    expect(await countFor(OLD_A, OLD_A)).toBe(1);
    expect(await countFor(OLD_A, OLD_B)).toBe(0);
    const all = await opsDb.pool.query<{ n: string }>('select count(*) as n from promoter_contract');
    expect(Number(all.rows[0]!.n)).toBeGreaterThanOrEqual(2);
  });
});

describe('J-T29 ②⑨ 계약 변경 적용·취소의 실제 트랜잭션', () => {
  test('[ASVS v5.0.0-2.3.3] J-T29 ②_승인_적용은_옛_기간을_자르고_새_기간·현재_값·대기_표시를_한_번에_바꾼다', async () => {
    const promoterId = await seedPromoter({ commissionRateBp: 875, guaranteeRateBp: 700, guaranteeKind: 'PERFORMANCE_BOND' });
    const asked = await askChange(promoterId, { commissionRateBp: 900, guaranteeRateBp: 650, reason: '실제 DB 승인' });
    expect(asked.statusCode).toBe(202);
    const approvalId = json(asked).approvalId as string;
    expect((await promoterRow(promoterId)).pending_contract_approval_id).toBe(approvalId);

    const approvedAt = new Date(NOW + 3_600_000);
    const applied = await applyChange(promoterId, approvalId, { commissionRateBp: 900, guaranteeRateBp: 650, approvedAt: approvedAt.toISOString(), approverId: randomUUID() });
    expect(applied.statusCode).toBe(200);
    expect(json(applied)).toEqual({ applied: true, validFrom: approvedAt.toISOString() });

    const rows = await periods(promoterId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ commission_rate_bp: 875, guarantee_rate_bp: 700, inf: false, approval_id: null });
    expect(rows[0]!.until?.getTime()).toBe(approvedAt.getTime());
    expect(rows[1]).toMatchObject({ commission_rate_bp: 900, guarantee_rate_bp: 650, from: approvedAt, until: null, inf: true, approval_id: approvalId });
    expect((await promoterRow(promoterId))).toMatchObject({ commission_rate_bp: 900, pending_contract_approval_id: null });
    expect(await overlapCount()).toBe(0);

    // 같은 승인 ID를 다시 보내도 기간이 두 번 생기지 않는다.
    expect((await applyChange(promoterId, approvalId, { commissionRateBp: 900, guaranteeRateBp: 650, approvedAt: approvedAt.toISOString(), approverId: randomUUID() })).statusCode).toBe(200);
    expect(await periods(promoterId)).toHaveLength(2);

    const open = await askChange(promoterId, { commissionRateBp: 925, reason: '다음 변경' });
    expect(open.statusCode).toBe(202);
    const cancelled = await cancelChange(promoterId, json(open).approvalId as string);
    expect(cancelled.statusCode).toBe(200);
    expect((await promoterRow(promoterId)).pending_contract_approval_id).toBeNull();
    expect(await periods(promoterId)).toHaveLength(2);
    expect((await askChange(promoterId, { commissionRateBp: 925, reason: '취소 뒤 다시' })).statusCode).toBe(202);
  });

  test('[ASVS v5.0.0-2.3.3] J-T29 ⑨_기간_삽입이_실패하면_옛_기간과_현재_값·대기_표시가_모두_되돌아간다', async () => {
    const promoterId = await seedPromoter({ commissionRateBp: 875 });
    const approvalId = json(await askChange(promoterId, { commissionRateBp: 900, reason: '트랜잭션 시험' })).approvalId as string;
    const fn = `r615_fail_${approvalId.replaceAll('-', '')}`;
    await admin.pool.query(`create or replace function ${fn}() returns trigger as $$
      begin
        if new.approval_id = '${approvalId}'::uuid then raise exception 'injected promoter_contract insert failure'; end if;
        return new;
      end $$ language plpgsql`);
    await admin.pool.query(`create trigger ${fn}_trg before insert on promoter_contract for each row execute function ${fn}()`);
    try {
      const failed = await applyChange(promoterId, approvalId, { commissionRateBp: 900, approvedAt: new Date(NOW + 7_200_000).toISOString(), approverId: randomUUID() });
      expect(failed.statusCode).toBe(500);
      const rows = await periods(promoterId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ commission_rate_bp: 875, until: null, inf: true });
      expect(await promoterRow(promoterId)).toMatchObject({ commission_rate_bp: 875, pending_contract_approval_id: approvalId });
    } finally {
      await admin.pool.query(`drop trigger if exists ${fn}_trg on promoter_contract`);
      await admin.pool.query(`drop function if exists ${fn}()`);
    }

    const approvedAt = new Date(NOW + 7_200_000);
    expect((await applyChange(promoterId, approvalId, { commissionRateBp: 900, approvedAt: approvedAt.toISOString(), approverId: randomUUID() })).statusCode).toBe(200);
    const rows = await periods(promoterId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.until?.getTime()).toBe(approvedAt.getTime());
    expect(rows[1]).toMatchObject({ commission_rate_bp: 900, from: approvedAt, inf: true, approval_id: approvalId });
    expect((await promoterRow(promoterId))).toMatchObject({ commission_rate_bp: 900, pending_contract_approval_id: null });
    expect(await overlapCount()).toBe(0);
  });

  test('J-T29 ⑨_같은_승인을_동시에_적용해도_기간은_한_번만_생긴다', async () => {
    const promoterId = await seedPromoter({ commissionRateBp: 875 });
    const approvalId = json(await askChange(promoterId, { commissionRateBp: 900, reason: '동시 적용' })).approvalId as string;
    const approvedAt = new Date(NOW + 10_800_000).toISOString();
    const [a, b] = await Promise.all([
      applyChange(promoterId, approvalId, { commissionRateBp: 900, approvedAt, approverId: randomUUID() }),
      applyChange(promoterId, approvalId, { commissionRateBp: 900, approvedAt, approverId: randomUUID() }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(await periods(promoterId)).toHaveLength(2);
    expect(await overlapCount()).toBe(0);
  });
});

describe('J-T30 ①~③ 판매 승인 트랜잭션의 수수료율 고정(실제 PostgreSQL)', () => {
  test('[ASVS v5.0.0-2.3.3] J-T30 ①_첫_승인은_모든_회차와_설정_사본·내부_경로에_875bp를_쓴다', async () => {
    const promoterId = await seedPromoter({ commissionRateBp: 875, guaranteeRateBp: 700, guaranteeKind: 'PERFORMANCE_BOND' });
    const ev1 = randomUUID();
    const ev2 = randomUUID();
    const productionId = await makeSubmitted(promoterId, [ev1, ev2]);
    const approved = await approveSale(productionId, [ev1, ev2]);
    expect(approved.statusCode, approved.payload).toBe(200);
    expect(json(approved)).toEqual({ applied: true, events: 2 });

    for (const eventId of [ev1, ev2]) {
      expect(await eventRow(eventId)).toMatchObject({ commission_rate_bp: 875 });
      const config = await configRow(eventId);
      expect(config).toMatchObject({ payload: expect.objectContaining({ commissionRateBp: 875 }) });
      const rate = await internalRate(eventId);
      expect(rate.statusCode).toBe(200);
      expect(rate.headers['cache-control']).toBe('no-store');
      expect(json(rate)).toEqual({ commissionRateBp: 875 });
      const one = await internalConfig(eventId);
      expect(json(one)).toMatchObject({ commissionRateBp: 875, promoterId });
    }
  });

  test('J-T30 ②_계약을_900bp로_바꿔도_이미_승인된_회차·사본은_875이고_새_공연은_900이다', async () => {
    const promoterId = await seedPromoter({ commissionRateBp: 875 });
    const ev1 = randomUUID();
    const productionId = await makeSubmitted(promoterId, [ev1]);
    expect((await approveSale(productionId, [ev1])).statusCode).toBe(200);
    expect(await eventRow(ev1)).toMatchObject({ commission_rate_bp: 875 });
    expect((await configRow(ev1)).payload).toMatchObject({ commissionRateBp: 875 });

    await changeContractDirect(promoterId, 900, new Date(NOW + 86_400_000));
    // 이미 승인된 회차와 사본은 그대로다.
    expect(await eventRow(ev1)).toMatchObject({ commission_rate_bp: 875 });
    expect((await configRow(ev1)).payload).toMatchObject({ commissionRateBp: 875 });
    expect((await internalRate(ev1)).statusCode).toBe(200);

    const ev2 = randomUUID();
    const second = await makeSubmitted(promoterId, [ev2]);
    expect((await approveSale(second, [ev2])).statusCode).toBe(200);
    expect(await eventRow(ev2)).toMatchObject({ commission_rate_bp: 900 });
    expect((await configRow(ev2)).payload).toMatchObject({ commissionRateBp: 900 });
    expect(json(await internalRate(ev2))).toEqual({ commissionRateBp: 900 });
  });

  test('J-T30 ③_재승인은_기존_회차를_그대로_두고_더한_회차에만_그때의_900bp를_쓴다', async () => {
    const promoterId = await seedPromoter({ commissionRateBp: 875 });
    const ev1 = randomUUID();
    const productionId = await makeSubmitted(promoterId, [ev1]);
    expect((await approveSale(productionId, [ev1])).statusCode).toBe(200);

    await changeContractDirect(promoterId, 900, new Date(NOW + 86_400_000));

    const ev2 = randomUUID();
    await admin.pool.query(`update production set sale_review = 'SUBMITTED', pending_revision = $2::jsonb where id = $1`, [
      productionId,
      JSON.stringify({
        addedEvents: [
          {
            eventId: ev2,
            openAt: new Date(NOW + 5 * 86_400_000).toISOString(),
            startsAt: new Date(NOW + 15 * 86_400_000).toISOString(),
            endsAt: new Date(NOW + 15 * 86_400_000 + 9_000_000).toISOString(),
            entryOpensAt: null,
            lobbyMinutes: 10,
            lobbyShuffle: true,
            openBatch: true,
            seatAssignment: 'PICK',
            perPersonLimit: 4,
            reentryAllowed: false,
            addedAt: new Date(NOW + 86_400_000).toISOString(),
            venueId: null,
          },
        ],
      }),
    ]);
    expect((await approveSale(productionId, [ev1, ev2])).statusCode).toBe(200);
    expect(await eventRow(ev1)).toMatchObject({ commission_rate_bp: 875 });
    expect(await eventRow(ev2)).toMatchObject({ commission_rate_bp: 900 });
    expect((await configRow(ev1)).payload).toMatchObject({ commissionRateBp: 875 });
    expect((await configRow(ev2)).payload).toMatchObject({ commissionRateBp: 900 });
  });

  test('J-T30 ④_계약_표_원천은_지금_900bp를_읽고_계약이_없으면_1000bp로_대신하지_않는다', async () => {
    const id = await seedPromoter({ commissionRateBp: 875 });
    const rate = new DrizzleCommissionRate(partnerDb);
    expect(await rate.rateBp(id)).toBe(875);
    await changeContractDirect(id, 900, new Date(NOW + 1_800_000));
    expect(await rate.rateBp(id)).toBe(900);
    await expect(rate.rateBp(randomUUID())).rejects.toThrow('계약 조건이 없어 상품 수수료율을 정할 수 없다');
  });

  test('J-T30 ⑤_수수료율이_고정되지_않은_회차는_내부_경로가_404다(임의_1000bp_없음)', async () => {
    // 판매 승인을 거치지 않은 회차(수수료율 null)는 payment-svc가 503으로 닫는 쪽을 유지한다.
    const promoterId = await seedPromoter({ commissionRateBp: 875 });
    const productionId = randomUUID();
    const eventId = randomUUID();
    await admin.pool.query(`insert into production (id, promoter_id, place_id, title, genre, sale_review, sale_approved_at, sale_policy, sale_policy_version) values ($1, $2, $3, '직접 넣은 공연', '콘서트', 'APPROVED', now(), $4::jsonb, 1)`, [productionId, promoterId, PLACE, JSON.stringify([general])]);
    await admin.pool.query(`insert into event (id, production_id, promoter_id, open_at, starts_at, ends_at, version) values ($1, $2, $3, $4, $5, $6, 1)`, [eventId, productionId, promoterId, new Date(NOW + 86_400_000), new Date(NOW + 10 * 86_400_000), new Date(NOW + 10 * 86_400_000 + 9_000_000)]);
    const r = await internalRate(eventId);
    expect(r.statusCode).toBe(404);
    expect(json(r).type).toContain('not-found');
  });

  test('J-T30 ⑤_RV-01_계약_기간이_없는_파트너_행의_판매_승인은_1000bp를_고정하지_않는다', async () => {
    // 파트너 행은 있고 0033 기본값(1000bp)도 있지만 promoter_contract 기간이 없다(직접 넣은 데이터·옛 데이터·계약 삭제).
    // 그 값을 계약으로 대신 쓰면 임의 10%를 만드는 것이라, 승인은 수수료율을 비우거나(회차 NULL) 409/422로 거절해야 한다(ADR-0320 결정 4).
    const promoterId = randomUUID();
    await admin.pool.query('insert into promoter (id, legal_name, commission_rate_bp) values ($1, $2, 1000)', [promoterId, '계약기간없는파트너']);
    const eventId = randomUUID();
    const productionId = await makeSubmitted(promoterId, [eventId]);

    const approved = await approveSale(productionId, [eventId]);
    if (approved.statusCode !== 200) expect([409, 422]).toContain(approved.statusCode);
    expect((await eventRow(eventId))?.commission_rate_bp).toBeNull();
    expect((await configRow(eventId))?.payload?.commissionRateBp).toBeUndefined();
    expect((await internalRate(eventId)).statusCode).toBe(404);
  });
});
