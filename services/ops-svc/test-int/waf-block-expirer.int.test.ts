// 만료 차단 정리 작업의 실제 PostgreSQL 18 통합 시험(BAT-360 OPS-290, ADR-0349 결정 9·10, control-tower §5 'AWS WAF API' 행·§14 C-T61, docs/data.md §4 6번).
// ops-svc가 HTTP로 명령 4(대역 차단)를 받아 ops_command.expires_at을 적고, 작업은 DB 역할 waf_block_expirer로 보기 waf_block_expiry_v만 읽어 IP 집합을 고친다.
// - C-T61 ①~④: ① 만료가 지난 명령 4의 대역만 빠지고 ② 만료 전 다른 명령 4도 막는 대역 ③ 명령 기록에 없는 대역 ④ 만료 전 대역은 남는다(ops-svc는 내린 채 작업만 돈다).
// - C-T61 ⑥: ops-svc 정비 바퀴가 다시 돌면 대역이 빠진 명령이 AUTO_EXPIRED(행위자 SYSTEM)이고 DB 사건에 남는다.
// - B12: 작업 역할은 명령 상태 표·command_event·감사 체인을 읽지 못하고 보기에는 사유·요청자 칸이 없다.
// WAF IP 집합은 제품 메모리 짝 가짜 MemoryWafIpSets(WafIpSets 포트 구현, GetIPSet·UpdateIPSet·잠금 토큰 흉내)다. 실제 WAF·IAM은 구간 5(장부 미검증).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createService, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleWafBlockExpiryView, ExpireWafBlocks, MaintainCommands, MemoryWafIpSets, SYSTEM_ACTOR_REF, type CommandExecutor } from '../src/modules/commands/index.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { adminAccountsForCommands } from './reauth.js';

const NOW = Date.parse('2026-11-26T03:00:00.000Z');
const HOUR = 60 * 60_000;
const identity = new FakeIdentity();
const clock = fakeClock({ now: NOW });
const sets = new MemoryWafIpSets({ 4: [], 6: [] });
let container: PostgresContainer;
let admin: pg.Client;
let db: Database;
let expirerDb: Database;
let svc: Awaited<ReturnType<typeof createService>>;
const executor: CommandExecutor = { execute: async () => ({ status: 'ACKED', ackedAtMs: clock.now() }) };

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  // 작업의 로그인 사용자: 역할 waf_block_expirer의 권한만 갖는다(운영은 비밀 관리가 만든다, 0024 주석)
  await admin.query("CREATE ROLE waf_expirer_it LOGIN PASSWORD 'waf-it' IN ROLE waf_block_expirer");
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-waf-it' });
  expirerDb = createDatabase({ url: container.urlFor('waf_expirer_it', 'waf-it'), applicationName: 'ops-svc-waf-expirer-it' });
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ database: db, executor, background: false, adminAccounts: adminAccountsForCommands, commandExtras: { blockIpSets: sets } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
}, 180_000);

afterAll(async () => {
  await svc?.close().catch(() => undefined);
  await expirerDb?.close().catch(() => undefined);
  await db?.close().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  container?.stop();
});

async function block(cidrs: string[], expiresAtMs: number): Promise<string> {
  const r = await svc.http.inject({
    method: 'POST',
    url: '/v1/ops/commands',
    headers: { ...identity.ops('operator'), 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
    payload: JSON.stringify({ type: 'BLOCK_ASN_IP', reason: `대역 차단 ${cidrs.join(',')}`, params: { cidrs, expiresAt: new Date(expiresAtMs).toISOString() } }),
  });
  expect(r.statusCode, r.payload).toBe(201);
  const body = JSON.parse(r.payload) as { commandId: string; state: string };
  expect(body.state).toBe('ACKED');
  return body.commandId;
}
const stateOf = async (id: string) => (await admin.query<{ state: string }>('select state from ops_command where id = $1', [id])).rows[0]!.state;

describe('C-T61 만료된 WAF 차단 거두기(PostgreSQL)', () => {
  test('C-T61 ①~④·⑥ 작업은 보기만 읽어 만료가 지난 대역만 빼고, ops-svc가 다시 돌면 그 명령만 AUTO_EXPIRED(SYSTEM)가 된다', async () => {
    const expired = await block(['198.51.100.0/24'], NOW + HOUR); // ①
    const sharedOld = await block(['192.0.2.0/25'], NOW + HOUR); // ② 만료가 지나지만
    const sharedLive = await block(['192.0.2.0/25'], NOW + 3 * HOUR); // ② 만료 전 다른 명령이 같은 대역을 막는다
    const future = await block(['2001:db8:5::/48'], NOW + 2 * HOUR); // ④
    // 접수가 걸어 둔 IP 집합 + ③ 명령 기록에 없는 대역
    sets.put(4, ['198.51.100.0/24', '192.0.2.0/25', '203.0.113.9/32']);
    sets.put(6, ['2001:db8:5::/48', '2001:db8:ffff::/48']);
    // 보기는 명령 4의 대역마다 한 행이고 만료 시각을 ops_command.expires_at에서 보인다
    const view = await new DrizzleWafBlockExpiryView(expirerDb).rows();
    expect(view.filter((r) => [expired, sharedOld, sharedLive, future].includes(r.commandId)).map((r) => [r.commandId, r.cidr, r.expiresAtMs]).sort()).toEqual(
      [
        [expired, '198.51.100.0/24', NOW + HOUR],
        [sharedOld, '192.0.2.0/25', NOW + HOUR],
        [sharedLive, '192.0.2.0/25', NOW + 3 * HOUR],
        [future, '2001:db8:5::/48', NOW + 2 * HOUR],
      ].sort(),
    );
    const job = new ExpireWafBlocks({ view: new DrizzleWafBlockExpiryView(expirerDb), ipSets: sets });
    // 만료 − 1ms: 아무것도 빼지 않는다
    expect((await job.run(NOW + HOUR - 1)).families.flatMap((f) => f.removed)).toEqual([]);
    const run = await job.run(NOW + HOUR);
    expect(run.failed).toBe(false);
    expect(sets.sets[4].addresses).toEqual(['192.0.2.0/25', '203.0.113.9/32']);
    expect(sets.sets[6].addresses).toEqual(['2001:db8:5::/48', '2001:db8:ffff::/48']);
    expect(run.families.flatMap((f) => f.commandIds)).toEqual([expired]);
    // ⑥ ops-svc 정비 바퀴: 대역이 빠진 명령은 AUTO_EXPIRED, 다른 명령이 덮는 만료 명령도 AUTO_EXPIRED(결정 10), 만료 전은 그대로
    clock.advance(HOUR);
    await svc.app.get(MaintainCommands).runOnce(clock.now());
    expect(await stateOf(expired)).toBe('AUTO_EXPIRED');
    expect(await stateOf(sharedOld)).toBe('AUTO_EXPIRED');
    expect(await stateOf(sharedLive)).toBe('ACKED');
    expect(await stateOf(future)).toBe('ACKED');
    const ev = (await admin.query<{ type: string; actor_ref: string; actor_role: string }>("select type, actor_ref, actor_role from command_event where command_id = $1 and type = 'AUTO_EXPIRED'", [expired])).rows;
    expect(ev).toEqual([{ type: 'AUTO_EXPIRED', actor_ref: SYSTEM_ACTOR_REF, actor_role: 'system' }]);
  });

  test('B12 작업 역할 waf_block_expirer는 보기 하나만 읽고 명령 상태 표·사건·감사 체인은 읽지 못하며(42501) 보기에 사유·요청자 칸이 없다', async () => {
    const c = await expirerDb.pool.connect();
    try {
      for (const t of ['ops_command', 'command_event', 'audit_chain', 'command_approval']) await expect(c.query(`select 1 from ${t} limit 1`)).rejects.toMatchObject({ code: '42501' });
      await expect(c.query("update ops_command set state = 'AUTO_EXPIRED'")).rejects.toMatchObject({ code: '42501' });
      await expect(c.query('select reason from waf_block_expiry_v')).rejects.toMatchObject({ code: '42703' });
      await expect(c.query('select requested_by from waf_block_expiry_v')).rejects.toMatchObject({ code: '42703' });
      const cols = (await c.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'waf_block_expiry_v' order by column_name")).rows.map((r) => r.column_name);
      expect(cols).toEqual(['cidr', 'command_id', 'expires_at', 'state']);
    } finally {
      c.release();
    }
  });
});
