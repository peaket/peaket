// 운영 명령 수명주기의 실제 PostgreSQL 18 통합 시험(BAT-355 OPS-260, ADR-0340, docs/data.md ops_command·command_event·command_approval·command_actor·idempotency_record).
// 안전 한계 422의 반영 0행(C-T3), 승인 기한 정각의 같은 트랜잭션 닫기(C-T4), 2인 분리의 두 가드(응용 층 403과 command_actor 부분 유일 색인, AZ-T10),
// 한 트랜잭션(2.3.3), 사람 칸의 가명 참조와 대응 행 지우기(16.2.1), 실행 5분 뒤 비교(C-T6 ③), 접수 멱등을 DB 행으로 본다.
// 타이머(작업자·정비)는 끄고(background: false) 정비 한 바퀴를 손으로 돌린다. 시계는 가짜 시계다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createService, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import {
  DrizzleCommandStore,
  DuplicateCommandActor,
  MaintainCommands,
  type CommandExecutor,
  type DryRunCountResult,
  type DryRunSource,
  type DryRunTarget,
} from '../src/modules/commands/index.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { adminAccountsForCommands, reauthFor } from './reauth.js';

const NOW = Date.parse('2026-11-22T09:00:00.000Z');
const MIN = 60_000;
const SYSTEM_REF = '00000000-0000-0000-0000-000000000000';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const iso = (ms: number) => new Date(ms).toISOString();

/** 센 값 원천 대역(포트 DryRunSource). 실제 원천 어댑터는 BAT-365다 */
class ScriptedSource implements DryRunSource {
  mode: 'values' | 'throw' = 'values';
  values: Record<string, number> = { currentTarget: 3_000, slotsUsed: 2_700, soonAdmitted: 150, inFlight: 90, admitRatio: 0.6, avgDwellSeconds: 480, servingRateCap: 40, servingRate: 5 };
  async count(_t: DryRunTarget, keys: readonly string[], nowMs: number): Promise<DryRunCountResult> {
    if (this.mode === 'throw') throw new Error('admission-ctrl unavailable');
    return { counted: keys.filter((k) => k in this.values).map((key) => ({ key, value: this.values[key]!, source: 'admission-ctrl', measuredAt: iso(nowMs) })), unavailable: [] };
  }
}

const identity = new FakeIdentity();
const clock = fakeClock({ now: NOW });
const source = new ScriptedSource();
const executed: string[] = [];
const executor: CommandExecutor = {
  execute: async (c) => (executed.push(c.commandId), c.type === 'SCALE_CHANGE' ? { status: 'SUCCEEDED' } : { status: 'ACKED', ackedAtMs: clock.now() }),
};
let container: PostgresContainer | undefined;
let db: Database;
let admin: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;
let store: DrizzleCommandStore;

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-command-lifecycle-it' });
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  store = new DrizzleCommandStore(db);
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ database: db, executor, background: false, adminAccounts: adminAccountsForCommands, commandExtras: { dryRunSources: { ADMISSION_TARGET: source } } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
  await admin?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  container?.stop();
});

type Headers = Record<string, string>;
const post = (url: string, headers: Headers, body: unknown) =>
  svc.http.inject({ method: 'POST', url, headers: { ...reauthFor(url, headers), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const get = (url: string, headers: Headers) => svc.http.inject({ method: 'GET', url, headers });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const slug = (r: { payload: string }) => String(json(r).type ?? '');
const q = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) => admin.query<R>(text, params);
const count = async (text: string, params: unknown[] = []) => Number((await q<{ n: string }>(text, params)).rows[0]!.n);
/** 명령에 딸린 표마다 행 수 */
const tables = async () => ({
  ops_command: await count('select count(*) as n from ops_command'),
  command_event: await count('select count(*) as n from command_event'),
  command_actor: await count('select count(*) as n from command_actor'),
  command_approval: await count('select count(*) as n from command_approval'),
  audit_chain: await count('select count(*) as n from audit_chain'),
  idempotency_record: await count("select count(*) as n from idempotency_record where operation = 'CREATE_OPS_COMMAND'"),
});
const lastEvent = async (id: string) => (await q<{ type: string; actor_ref: string; actor_role: string; reason: string }>('select type, actor_ref, actor_role, reason from command_event where command_id = $1 order by seq desc limit 1', [id])).rows[0];

describe('C-T3·C-T4 실제 DB', () => {
  test('C-T3 동시 입장 목표 8,001·999는 422이고 ops_command·command_event·command_actor·audit_chain·멱등 기록이 한 행도 늘지 않으며, 같은 키의 7,999는 처음처럼 받는다(실제 DB)', async () => {
    const op = identity.ops('operator');
    const eventId = randomUUID();
    const before = await tables();
    const key = randomUUID();
    for (const value of [8_001, 999]) {
      const r = await post('/v1/ops/commands', { ...op, 'idempotency-key': key }, { type: 'ADMISSION_TARGET', reason: '목표', params: { eventId, target: value } });
      expect([r.statusCode, slug(r)], String(value)).toEqual([422, expect.stringMatching(/command-out-of-range$/)]);
    }
    expect(await tables()).toEqual(before);
    expect(executed).toEqual([]);
    const ok = await post('/v1/ops/commands', { ...op, 'idempotency-key': key }, { type: 'ADMISSION_TARGET', reason: '목표', params: { eventId, target: 7_999 } });
    expect([ok.statusCode, json(ok).state]).toEqual([201, 'ACKED']);
    const id = json(ok).commandId as string;
    // 받은 한 명령: 행 1, 사건 5(CREATED·DRY_RUN·APPROVED·DISPATCHED·ACKED), 요청자 대응 1, 그 명령의 감사 3(접수·실행 시작·ack), 멱등 1
    const after = await tables();
    expect([after.ops_command - before.ops_command, after.idempotency_record - before.idempotency_record]).toEqual([1, 1]);
    expect((await q<{ type: string }>('select type from command_event where command_id = $1 order by seq', [id])).rows.map((r) => r.type)).toEqual(['CREATED', 'DRY_RUN', 'APPROVED', 'DISPATCHED', 'ACKED']);
    expect(await count('select count(*) as n from command_actor where command_id = $1', [id])).toBe(1);
    expect((await q<{ record_type: string }>('select record_type from audit_chain where record_id = $1 order by seq', [id])).rows.map((r) => r.record_type)).toEqual(['COMMAND_CREATED', 'COMMAND_EXECUTION_STARTED', 'COMMAND_ACKED']);
  });

  test('C-T4 [ASVS v5.0.0-2.3.2] 승인 기한 − 1ms의 승인은 통과하고 10분 정각의 승인은 409이며 같은 트랜잭션에서 REJECTED(SYSTEM, approval-expired)로 닫힌다(실제 DB)', async () => {
    const requester = identity.ops('commander');
    const make = async (reason: string) => json(await post('/v1/ops/commands', requester, { type: 'BOT_LEVEL', reason, params: { level: 'STANDARD' } })).commandId as string;
    const start = clock.now();
    const early = await make('기한 직전');
    const late = await make('기한 정각');
    const swept = await make('정비가 닫음');
    const row = await q<{ approval_expires_at: Date }>('select approval_expires_at from ops_command where id = $1', [late]);
    expect(row.rows[0]!.approval_expires_at.getTime()).toBe(start + 10 * MIN);
    const approver = identity.ops('commander');
    clock.advance(10 * MIN - 1);
    expect((await post(`/v1/ops/commands/${early}/approvals`, approver, {})).statusCode).toBe(200);
    expect(await svc.app.get(MaintainCommands).runOnce(clock.now())).toMatchObject({ approvalsExpired: 0 });
    expect((await q<{ state: string }>('select state from ops_command where id = $1', [swept])).rows[0]!.state).toBe('PENDING_APPROVAL');
    clock.advance(1);
    const tooLate = await post(`/v1/ops/commands/${late}/approvals`, approver, {});
    expect([tooLate.statusCode, slug(tooLate)]).toEqual([409, expect.stringMatching(/command-not-pending$/)]);
    expect(await svc.app.get(MaintainCommands).runOnce(clock.now())).toMatchObject({ approvalsExpired: 1 });
    for (const id of [late, swept]) {
      expect((await q<{ state: string; approval_expires_at: Date | null }>('select state, approval_expires_at from ops_command where id = $1', [id])).rows[0]).toEqual({ state: 'REJECTED', approval_expires_at: null });
      expect(await lastEvent(id)).toEqual({ type: 'REJECTED', actor_ref: SYSTEM_REF, actor_role: 'system', reason: 'approval-expired' });
      expect(await count('select count(*) as n from command_approval where command_id = $1', [id])).toBe(0);
      const [audit] = (await q<{ record_type: string; record_json: { payload: Record<string, unknown> } }>('select record_type, record_json from audit_chain where record_id = $1 order by seq desc limit 1', [id])).rows;
      expect(audit).toEqual({ record_type: 'COMMAND_REJECTED', record_json: expect.objectContaining({ payload: { decision: 'REJECTED', approverRef: SYSTEM_REF, approverRole: 'system', reason: 'approval-expired' } }) });
    }
    expect((await q<{ state: string }>('select state from ops_command where id = $1', [early])).rows[0]!.state).toBe('ACKED');
  });
});

describe('AZ-T10 실제 DB의 2인 분리', () => {
  test('AZ-T10 요청자 본인 403·낮은 역할 403·같은 사람 동시 두 번은 하나만 200이고 command_approval·command_actor의 승인자는 한 명이다(실제 DB)', async () => {
    const requester = identity.ops('commander');
    const id = json(await post('/v1/ops/commands', requester, { type: 'BOT_LEVEL', reason: '분리', params: { level: 'RELAXED' } })).commandId as string;
    const self = await post(`/v1/ops/commands/${id}/approvals`, requester, {});
    expect([self.statusCode, slug(self)]).toEqual([403, expect.stringMatching(/command-requester-cannot-approve$/)]);
    const low = await post(`/v1/ops/commands/${id}/approvals`, identity.ops('operator'), {});
    expect([low.statusCode, slug(low)]).toEqual([403, expect.stringMatching(/command-role-forbidden$/)]);
    expect(await count('select count(*) as n from command_approval where command_id = $1', [id])).toBe(0);
    expect(await count("select count(*) as n from command_actor where command_id = $1 and side = 'APPROVER'", [id])).toBe(0);
    const approver = identity.ops('commander');
    const both = await Promise.all([post(`/v1/ops/commands/${id}/approvals`, approver, {}), post(`/v1/ops/commands/${id}/approvals`, approver, {})]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await count('select count(*) as n from command_approval where command_id = $1', [id])).toBe(1);
    expect((await q<{ admin_account_id: string }>("select admin_account_id::text as admin_account_id from command_actor where command_id = $1 and side = 'APPROVER'", [id])).rows).toEqual([{ admin_account_id: approver['x-user-id'] }]);
    // 서로 다른 두 사람이 동시에 승인해도 승인은 한 번이다
    const id2 = json(await post('/v1/ops/commands', requester, { type: 'BOT_LEVEL', reason: '경쟁', params: { level: 'RELAXED' } })).commandId as string;
    const race = await Promise.all([post(`/v1/ops/commands/${id2}/approvals`, identity.ops('commander'), {}), post(`/v1/ops/commands/${id2}/approvals`, identity.ops('commander'), {})]);
    expect(race.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await count('select count(*) as n from command_approval where command_id = $1', [id2])).toBe(1);
    expect(executed.filter((x) => x === id2)).toEqual([id2]);
  });

  test('AZ-T10 command_actor의 회차별 부분 유일 색인은 응용 층 검사와 따로 같은 사람의 요청·승인 두 행을 막는다(ACTOR와 다른 회차는 막지 않는다)', async () => {
    const requester = identity.ops('commander');
    const account = requester['x-user-id']!;
    const id = json(await post('/v1/ops/commands', requester, { type: 'DEGRADED_MODE', reason: '색인', params: { mode: 'PAYMENT' } })).commandId as string;
    // 응용 층을 지나지 않고 쓰기 면으로 바로 넣어도 DB가 막고, 트랜잭션째 되돌아간다
    await expect(store.mutate(id, async (w) => w.actor('APPROVER', 0, account, clock.now()))).rejects.toBeInstanceOf(DuplicateCommandActor);
    expect((await q<{ side: string; admin_account_id: string }>('select side, admin_account_id::text as admin_account_id from command_actor where command_id = $1', [id])).rows).toEqual([{ side: 'REQUESTER', admin_account_id: account }]);
    await admin.query('begin');
    try {
      const insert = (side: string, round: number) =>
        admin.query("insert into command_actor (actor_ref, command_id, round, side, admin_account_id, recorded_at) values (gen_random_uuid(), $1, $2, $3, $4, now())", [id, round, side, account]);
      await insert('ACTOR', 0);
      await insert('APPROVER', 1);
      await admin.query('savepoint dup');
      await expect(insert('APPROVER', 0)).rejects.toMatchObject({ code: '23505', constraint: 'command_actor_person_key' });
      await admin.query('rollback to savepoint dup');
      await expect(insert('REQUESTER', 0)).rejects.toMatchObject({ code: '23505', constraint: 'command_actor_person_key' });
    } finally {
      await admin.query('rollback');
    }
    expect(await count('select count(*) as n from command_actor where command_id = $1', [id])).toBe(1);
  });
});

describe('한 트랜잭션과 가명 참조(ASVS 2.3.3·16.2.1)', () => {
  test('[ASVS v5.0.0-2.3.3] 감사 행·체인 머리·사건을 쓴 뒤 커밋 직전에 실패해도(그리고 대응 행 쓰기에서 실패해도) 명령 행·사건·command_actor·감사 행·체인 머리·멱등 기록이 모두 되돌아간다(실제 DB)', async () => {
    const headOf = async () => (await q<{ last_seq: string; last_hash: string }>("select last_seq, encode(last_hash, 'hex') as last_hash from audit_chain_head where id = 1")).rows[0]!;
    const errorText = (e: unknown): string => {
      const parts: string[] = [];
      for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) parts.push(x.message);
      return parts.join(' | ');
    };
    const insert = (reason: string, requestedBy: string) =>
      store.insert({
        commandId: randomUUID(),
        type: 'LOG_LEVEL',
        reason,
        params: { service: 'queue-svc', level: 'DEBUG' },
        requestedBy,
        requestedRole: 'operator',
        nowMs: clock.now(),
        idempotency: { accountRef: requestedBy, operation: 'CREATE_OPS_COMMAND', key: randomUUID(), requestHash: new Uint8Array(32) },
      });
    // ① 늦은 실패: 그 트랜잭션의 마지막 쓰기(감사 행·체인 머리) 뒤, 커밋할 때 터지는 지연 제약 트리거(시험만 걸고 끝나면 지운다).
    //    트리거는 터지는 그때 같은 트랜잭션에 이미 쓰인 사건·대응 행·멱등 기록·머리를 세어 오류 글에 싣는다(실패가 정말 감사 행 뒤였음을 본다)
    await admin.query(`
      create or replace function test_fail_at_commit() returns trigger language plpgsql as $f$
      begin
        if new.record_json->'payload'->>'reason' = '커밋 직전 실패' then
          raise exception 'test-fail-at-commit events=% actors=% idem=% head=% seq=%',
            (select count(*) from command_event where command_id = new.record_id),
            (select count(*) from command_actor where command_id = new.record_id),
            (select count(*) from idempotency_record where operation = 'CREATE_OPS_COMMAND'),
            (select last_seq from audit_chain_head where id = 1),
            new.seq;
        end if;
        return null;
      end
      $f$`);
    await admin.query('create constraint trigger test_fail_at_commit after insert on audit_chain deferrable initially deferred for each row execute function test_fail_at_commit()');
    try {
      const before = await tables();
      const head = await headOf();
      const late = await insert('커밋 직전 실패', randomUUID()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(late).toBeInstanceOf(Error);
      const seq = Number(head.last_seq) + 1;
      expect(errorText(late)).toContain(`test-fail-at-commit events=3 actors=1 idem=${before.idempotency_record + 1} head=${seq} seq=${seq}`);
      expect(await tables()).toEqual(before);
      expect(await headOf()).toEqual(head);
      expect(await count("select count(*) as n from ops_command where reason = '커밋 직전 실패'")).toBe(0);
    } finally {
      await admin.query('drop trigger if exists test_fail_at_commit on audit_chain');
      await admin.query('drop function if exists test_fail_at_commit()');
    }
    // ② 이른 실패: command_actor.admin_account_id는 uuid라 이 값의 대응 행 쓰기가 실패한다
    const before = await tables();
    const head = await headOf();
    await expect(insert('대응 행 실패', 'not-a-uuid')).rejects.toThrow();
    expect(await tables()).toEqual(before);
    expect(await headOf()).toEqual(head);
    // 트리거를 지운 뒤에는 같은 접수가 그대로 커밋된다(시험 장치가 남지 않았다)
    const ok = await insert('트리거 뒤 정상 접수', randomUUID());
    expect(ok.replayed).toBe(false);
    expect(await count('select count(*) as n from ops_command where id = $1', [ok.command.commandId])).toBe(1);
    expect(Number((await headOf()).last_seq)).toBe(Number(head.last_seq) + 1);
  });

  test('[ASVS v5.0.0-16.2.1] 실제 DB의 명령 기록(requested_by·actor_ref·approver_ref·감사 record_json)에는 관리 계정 ID가 없고 대응 표로만 풀리며, 3년 [가정]이 지난 대응 행만 지우고 보류 행은 남긴다', async () => {
    const requester = identity.ops('commander');
    const approver = identity.ops('commander');
    const [a, b] = [requester['x-user-id']!, approver['x-user-id']!];
    const id = json(await post('/v1/ops/commands', requester, { type: 'BOT_LEVEL', reason: '가명', params: { level: 'AGGRESSIVE' } })).commandId as string;
    expect((await post(`/v1/ops/commands/${id}/approvals`, approver, {})).statusCode).toBe(200);
    const accounts = [a, b];
    expect(await count('select count(*) as n from ops_command where id = $1 and requested_by = any($2)', [id, accounts])).toBe(0);
    expect(await count('select count(*) as n from command_event where command_id = $1 and actor_ref = any($2)', [id, accounts])).toBe(0);
    expect(await count('select count(*) as n from command_approval where command_id = $1 and approver_ref = any($2)', [id, accounts])).toBe(0);
    for (const x of accounts) expect(await count("select count(*) as n from audit_chain where record_id = $1 and record_json::text like '%' || $2 || '%'", [id, x])).toBe(0);
    const refs = (await q<{ actor_ref: string }>('select distinct actor_ref from command_event where command_id = $1', [id])).rows.map((r) => r.actor_ref);
    for (const r of refs) expect(r === SYSTEM_REF || UUID_V4.test(r), r).toBe(true);
    const actors = (await q<{ actor_ref: string; side: string; admin_account_id: string; recorded_at: Date }>('select actor_ref::text as actor_ref, side, admin_account_id::text as admin_account_id, recorded_at from command_actor where command_id = $1 order by side desc', [id])).rows;
    expect(actors.map((x) => [x.side, x.admin_account_id])).toEqual([
      ['REQUESTER', a],
      ['APPROVER', b],
    ]);
    // 사건의 행위자 칸은 대응 표의 참조와 같다(요청 사건 셋은 요청자 참조, 승인 사건은 승인자 참조)
    const events = (await q<{ type: string; actor_ref: string }>('select type, actor_ref from command_event where command_id = $1 order by seq', [id])).rows;
    expect(events.map((e) => e.type)).toEqual(['CREATED', 'DRY_RUN', 'PENDING_APPROVAL', 'APPROVED', 'DISPATCHED', 'ACKED']);
    expect(events.slice(0, 3).map((e) => e.actor_ref)).toEqual([actors[0]!.actor_ref, actors[0]!.actor_ref, actors[0]!.actor_ref]);
    expect(events[3]!.actor_ref).toBe(actors[1]!.actor_ref);
    const detail = json(await get(`/v1/ops/commands/${id}`, approver));
    expect(detail).toMatchObject({ reason: '가명', requestedBy: { adminAccountId: a, role: 'commander' }, approvals: [b], ackedAt: iso(clock.now()) });
    expect(detail.dryRun).toMatchObject({ version: 1, approvalMode: 'TWO', reauthRequired: true });

    // 지우기: 기준 시각보다 이른 행만(같은 시각은 남김), 보류 행은 남김. 기록·체인은 그대로
    await q('update command_actor set delete_hold_ref = $2 where actor_ref = $1::uuid', [actors[1]!.actor_ref, randomUUID()]);
    const recordedAt = actors[0]!.recorded_at.getTime();
    const auditRows = await count('select count(*) as n from audit_chain');
    const eventRows = await count('select count(*) as n from command_event');
    const older = await count('select count(*) as n from command_actor where recorded_at < $1 and delete_hold_ref is null', [new Date(recordedAt)]);
    expect(await store.purgeActors(recordedAt)).toBe(older);
    expect(await count('select count(*) as n from command_actor where actor_ref = $1::uuid', [actors[0]!.actor_ref])).toBe(1);
    const due = await count('select count(*) as n from command_actor where recorded_at < $1 and delete_hold_ref is null', [new Date(recordedAt + 1)]);
    expect(due).toBeGreaterThanOrEqual(1);
    expect(await store.purgeActors(recordedAt + 1)).toBe(due);
    expect(await count('select count(*) as n from command_actor where recorded_at < $1 and delete_hold_ref is null', [new Date(recordedAt + 1)])).toBe(0);
    expect(await count('select count(*) as n from command_actor where actor_ref = $1::uuid', [actors[1]!.actor_ref])).toBe(1);
    expect(await count('select count(*) as n from audit_chain')).toBe(auditRows);
    expect(await count('select count(*) as n from command_event')).toBe(eventRows);
    const after = json(await get(`/v1/ops/commands/${id}`, approver));
    expect((after.requestedBy as Record<string, unknown>).adminAccountId).toBeUndefined();
    expect(after).toMatchObject({ requestedBy: { role: 'commander' }, approvals: [b] });
  });
});

describe('C-T6 ③·멱등 실제 DB', () => {
  test('C-T6 ③ 처음 DISPATCHED + 5분이 compare_due_at이고, 정비는 5분 − 1ms에는 남기지 않고 5분에 DRY_RUN_COMPARED(예측·실제)를 남긴 뒤 칸을 비우며 원천 실패는 unavailable로 남긴다(실제 DB)', async () => {
    const op = identity.ops('operator');
    const maintain = svc.app.get(MaintainCommands);
    const compared = (id: string) => q<{ actor_ref: string; detail: { pairs: Array<{ key: string; predicted: number; actual: number; diff: number }>; unavailable: Array<{ key: string }> } }>("select actor_ref, detail from command_event where command_id = $1 and type = 'DRY_RUN_COMPARED'", [id]);
    const dueOf = async (id: string) => (await q<{ compare_due_at: Date | null }>('select compare_due_at from ops_command where id = $1', [id])).rows[0]!.compare_due_at?.getTime();
    const create = async (reason: string, value: number) => {
      const c = json(await post('/v1/ops/commands', op, { type: 'ADMISSION_TARGET', reason, params: { eventId: randomUUID(), target: value } }));
      expect(c.state, reason).toBe('ACKED');
      return c.commandId as string;
    };
    source.mode = 'values';
    const base = { ...source.values };
    const id = await create('목표 올림', 4_200);
    const dispatchedAt = clock.now();
    expect(await dueOf(id)).toBe(dispatchedAt + 5 * MIN);
    source.values = { ...base, slotsUsed: 3_900, soonAdmitted: 120, inFlight: 60, servingRate: 13.1 };
    await maintain.runOnce(dispatchedAt + 5 * MIN - 1);
    expect((await compared(id)).rows).toEqual([]);
    expect(await dueOf(id)).toBe(dispatchedAt + 5 * MIN);
    await maintain.runOnce(dispatchedAt + 5 * MIN);
    const [cmp] = (await compared(id)).rows;
    expect(cmp!.actor_ref).toBe(SYSTEM_REF);
    const actualVacancy = 4_200 - 3_900 - 120 - 60;
    expect(cmp!.detail.pairs.find((p) => p.key === 'vacancy')).toEqual({ key: 'vacancy', predicted: 1_260, actual: actualVacancy, diff: actualVacancy - 1_260 });
    expect(cmp!.detail.pairs.find((p) => p.key === 'servingRate')!.actual).toBe(13.1);
    expect(await dueOf(id)).toBeUndefined();
    expect(await count("select count(*) as n from audit_chain where record_id = $1 and record_type = 'COMMAND_DRY_RUN_COMPARED'", [id])).toBe(1);
    await maintain.runOnce(dispatchedAt + 10 * MIN);
    expect((await compared(id)).rows).toHaveLength(1);
    // 비교 때 원천이 실패하면 짝 없이 unavailable로 남긴다('일치'로 적지 않는다)
    source.values = base;
    const failing = await create('목표 올림 2', 4_100);
    const due2 = (await dueOf(failing))!;
    source.mode = 'throw';
    await maintain.runOnce(due2);
    const [bad] = (await compared(failing)).rows;
    expect(bad!.detail.pairs).toEqual([]);
    expect(bad!.detail.unavailable.map((u) => u.key)).toEqual(expect.arrayContaining(['vacancy', 'servingRate', 'slotsUsed']));
    expect(await dueOf(failing)).toBeUndefined();
    // 접수 때 원천을 세지 못하면 예측이 없어 비교 때를 두지 않는다
    const unpredicted = await create('목표 올림 3', 4_300);
    expect(await dueOf(unpredicted)).toBeUndefined();
    source.mode = 'values';
  });

  test('OPS-260 실제 DB 멱등: 같은 키·같은 본문은 같은 명령(멱등 기록 1행, 사건 그대로), 같은 키·다른 본문은 422 idempotency-key-reused다', async () => {
    const op = identity.ops('operator');
    const key = randomUUID();
    const body = { type: 'LOG_LEVEL', reason: '멱등', params: { service: 'queue-svc', level: 'DEBUG' } };
    const first = await post('/v1/ops/commands', { ...op, 'idempotency-key': key }, body);
    expect(first.statusCode).toBe(201);
    const id = json(first).commandId as string;
    const before = await tables();
    const again = await post('/v1/ops/commands', { ...op, 'idempotency-key': key }, body);
    expect([again.statusCode, json(again).commandId]).toEqual([201, id]);
    expect(await tables()).toEqual(before);
    expect((await q<{ result_ref: string }>("select result_ref from idempotency_record where operation = 'CREATE_OPS_COMMAND' and idempotency_key = $1", [key])).rows).toEqual([{ result_ref: id }]);
    const reused = await post('/v1/ops/commands', { ...op, 'idempotency-key': key }, { ...body, reason: '다른 본문' });
    expect([reused.statusCode, slug(reused)]).toEqual([422, expect.stringMatching(/idempotency-key-reused$/)]);
    expect(await tables()).toEqual(before);
  });
});
