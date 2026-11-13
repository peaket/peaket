// ops-svc 실제 PostgreSQL 18 통합 시험(GAT-110 첫 몫, R-552).
// 0000 마이그레이션 적용·재적용, ops_command·command_event·command_approval·audit_chain 저장소,
// 2인 승인·요청자≠승인자, 감사 해시 체인, CS REFUND_FAILED 열린 건 멱등을 실제 DB에서 본다.
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { auditHash } from '../src/modules/audit/index.js';
import { DrizzleCsCaseStore, ReceiveCaseRequested } from '../src/modules/cases/index.js';
import {
  APPROVAL_TTL_MS,
  CreateCommand,
  DecideCommand,
  DrizzleCommandStore,
  GetCommand,
  ListCommands,
} from '../src/modules/commands/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-14T01:00:00.000Z');
const REQUESTER = '0193a000-0000-7000-8000-000000000001';
const APPROVER = '0193a000-0000-7000-8000-000000000002';

let container: PostgresContainer | undefined;
let url = '';
let db: Database;
let admin: pg.Client;
let store: DrizzleCommandStore;
let create: CreateCommand;
let decide: DecideCommand;
let get: GetCommand;
let list: ListCommands;
let cases: DrizzleCsCaseStore;
let receiveCase: ReceiveCaseRequested;

beforeAll(async () => {
  container = await startPostgres();
  url = container.url;
  await migrateOps(url);
  db = createDatabase({ url, applicationName: 'ops-svc-it' });
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  store = new DrizzleCommandStore(db);
  create = new CreateCommand(store);
  decide = new DecideCommand(store);
  get = new GetCommand(store);
  list = new ListCommands(store);
  cases = new DrizzleCsCaseStore(db);
  receiveCase = new ReceiveCaseRequested(cases);
});

afterAll(async () => {
  await admin?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  container?.stop();
});

const q = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) => admin.query<R>(text, params);
const count = async (text: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string }>(text, params)).rows[0]!.n);
const commandInput = (type: 'LOG_LEVEL' | 'BOT_LEVEL' | 'DEGRADED_MODE' | 'KILL_SWITCH', over: Record<string, unknown> = {}) => ({
  type,
  reason: '장애 대응',
  params: {},
  requestedBy: REQUESTER,
  requestedRole: 'operator',
  nowMs: NOW,
  ...over,
});

describe('0000 마이그레이션과 표 모양', () => {
  test('GAT110_0000_마이그레이션은_재적용해도_같고_명령·승인·감사·CS_표를_만든다', async () => {
    const tables = async () =>
      (await q<{ relname: string }>("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname")).rows.map((r) => r.relname);
    const before = await tables();
    expect(before).toEqual(expect.arrayContaining(['ops_command', 'command_event', 'command_approval', 'audit_chain', 'audit_chain_head', 'cs_case']));

    await migrateOps(url);
    await migrateOps(url);
    expect(await tables()).toEqual(before);
    expect(await count('select count(*) as n from ops_migration')).toBe(1);
  });

  test('GAT110_0000_제약과_CS_열린_건_부분_유일_색인을_실제_DB에_건다', async () => {
    const checks = await q<{ conname: string }>(
      "select conname from pg_constraint where conrelid in ('public.ops_command'::regclass, 'public.command_approval'::regclass, 'public.cs_case'::regclass, 'public.audit_chain_head'::regclass) and contype = 'c' order by conname",
    );
    expect(checks.rows.map((r) => r.conname)).toEqual(
      expect.arrayContaining(['audit_chain_head_one', 'command_approval_decision_check', 'cs_case_status_check', 'ops_command_state_check', 'ops_command_type_check']),
    );

    const idx = await q<{ indexdef: string }>("select indexdef from pg_indexes where schemaname = 'public' and tablename = 'cs_case' and indexname = 'cs_case_open_key'");
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0]!.indexdef).toContain("WHERE (status <> 'RESOLVED'::text)");

    const head = await q<{ last_seq: string; last_hash: string }>("select last_seq, encode(last_hash, 'hex') as last_hash from audit_chain_head where id = 1");
    expect(head.rows).toEqual([{ last_seq: '0', last_hash: '' }]);

    const cid = randomUUID();
    await q("insert into ops_command (id, type, state, reason, params, requested_by, requested_role, created_at, updated_at) values ($1, 'LOG_LEVEL', 'APPROVED', 'x', '{}', 'r', 'operator', now(), now())", [cid]);
    await expect(q("update ops_command set state = 'BROKEN' where id = $1", [cid])).rejects.toThrow(/ops_command_state_check/);
    await expect(
      q("insert into ops_command (id, type, state, reason, params, requested_by, requested_role, created_at, updated_at) values ($1, 'NOPE', 'APPROVED', 'x', '{}', 'r', 'operator', now(), now())", [randomUUID()]),
    ).rejects.toThrow(/ops_command_type_check/);
    await expect(
      q("insert into command_approval (command_id, approver_ref, approver_role, decision, decided_at) values ($1, 'a', 'operator', 'MAYBE', now())", [cid]),
    ).rejects.toThrow(/command_approval_decision_check/);
    await expect(q("insert into audit_chain_head (id, last_seq, last_hash) values (2, 0, ''::bytea)")).rejects.toThrow(/audit_chain_head_one/);

    await q("insert into command_event (command_id, seq, type, actor_ref, actor_role, reason, created_at) values ($1, 1, 'CREATED', 'a', 'operator', 'x', now())", [cid]);
    await expect(
      q("insert into command_event (command_id, seq, type, actor_ref, actor_role, reason, created_at) values ($1, 1, 'CREATED', 'a', 'operator', 'x', now())", [cid]),
    ).rejects.toThrow(/command_event_pkey/);
  });
});

describe('운영 명령 저장소와 감사 해시 체인', () => {
  test('GAT110_2인_명령은_PENDING_APPROVAL·10분_기한·사건_2개·감사_1개를_남긴다', async () => {
    const command = await create.execute(commandInput('BOT_LEVEL', { reason: '봇 급증', params: { level: 'AGGRESSIVE' } }));
    expect(command.state).toBe('PENDING_APPROVAL');
    expect(command.approvalExpiresAtMs).toBe(NOW + APPROVAL_TTL_MS);

    const row = await q<{ state: string; approval_expires_at: Date }>('select state, approval_expires_at from ops_command where id = $1', [command.commandId]);
    expect(row.rows[0]!.state).toBe('PENDING_APPROVAL');
    expect(row.rows[0]!.approval_expires_at.getTime()).toBe(NOW + APPROVAL_TTL_MS);

    const events = await q<{ seq: number; type: string; actor_ref: string }>('select seq, type, actor_ref from command_event where command_id = $1 order by seq', [command.commandId]);
    expect(events.rows).toEqual([
      { seq: 1, type: 'CREATED', actor_ref: REQUESTER },
      { seq: 2, type: 'PENDING_APPROVAL', actor_ref: REQUESTER },
    ]);

    const audit = await q<{ seq: string; record_type: string; record_id: string; hash: string; mac: Buffer | null; salt_len: number }>(
      "select seq, record_type, record_id, encode(record_sha256, 'hex') as hash, mac, octet_length(leaf_salt) as salt_len from audit_chain where record_id = $1 order by seq",
      [command.commandId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ record_type: 'COMMAND_CREATED', record_id: command.commandId, mac: null, salt_len: 32 });
    expect(audit.rows[0]!.hash).toBe(
      auditHash('', {
        recordType: 'COMMAND_CREATED',
        recordId: command.commandId,
        payload: { type: 'BOT_LEVEL', state: 'PENDING_APPROVAL', requestedBy: REQUESTER, reason: '봇 급증' },
        nowMs: NOW,
      }),
    );

    const head = await q<{ last_seq: string; hash: string }>("select last_seq, encode(last_hash, 'hex') as hash from audit_chain_head where id = 1");
    expect(head.rows[0]).toEqual({ last_seq: audit.rows[0]!.seq, hash: audit.rows[0]!.hash });
  });

  test('GAT110_요청자_본인은_승인하지_못하고_다른_계정_승인은_APPROVED·사건·감사를_남긴다', async () => {
    const command = await create.execute(commandInput('BOT_LEVEL'));
    await expect(decide.approve({ commandId: command.commandId, approverRef: REQUESTER, approverRole: 'commander', nowMs: NOW + 1 })).rejects.toMatchObject({ status: 403 });
    expect(await count('select count(*) as n from command_approval where command_id = $1', [command.commandId])).toBe(0);

    const approved = await decide.approve({ commandId: command.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: NOW + 1 });
    expect(approved.state).toBe('APPROVED');
    expect(approved.approvalExpiresAtMs).toBeUndefined();
    expect((await get.execute(command.commandId)).approvals).toEqual([APPROVER]);

    const approval = await q<{ approver_ref: string; approver_role: string; decision: string; reason: string | null }>(
      'select approver_ref, approver_role, decision, reason from command_approval where command_id = $1',
      [command.commandId],
    );
    expect(approval.rows).toEqual([{ approver_ref: APPROVER, approver_role: 'commander', decision: 'APPROVED', reason: null }]);

    const events = await q<{ seq: number; type: string; actor_ref: string }>('select seq, type, actor_ref from command_event where command_id = $1 order by seq', [command.commandId]);
    expect(events.rows).toEqual([
      { seq: 1, type: 'CREATED', actor_ref: REQUESTER },
      { seq: 2, type: 'PENDING_APPROVAL', actor_ref: REQUESTER },
      { seq: 3, type: 'APPROVED', actor_ref: APPROVER },
    ]);

    const audit = await q<{ seq: string; hash: string }>("select seq, encode(record_sha256, 'hex') as hash from audit_chain where record_id = $1 order by seq", [command.commandId]);
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[1]!.hash).toBe(
      auditHash(audit.rows[0]!.hash, {
        recordType: 'COMMAND_APPROVED',
        recordId: command.commandId,
        payload: { decision: 'APPROVED', approverRef: APPROVER, approverRole: 'commander' },
        nowMs: NOW + 1,
      }),
    );
    const head = await q<{ last_seq: string; hash: string }>("select last_seq, encode(last_hash, 'hex') as hash from audit_chain_head where id = 1");
    expect(head.rows[0]).toEqual({ last_seq: audit.rows[1]!.seq, hash: audit.rows[1]!.hash });
  });

  test('GAT110_거부는_REJECTED와_사유를_남기고_다시_승인할_수_없다', async () => {
    const command = await create.execute(commandInput('DEGRADED_MODE'));
    const rejected = await decide.reject({ commandId: command.commandId, approverRef: APPROVER, approverRole: 'operator', reason: '근거 부족', nowMs: NOW + 2 });
    expect(rejected.state).toBe('REJECTED');

    const approval = await q<{ decision: string; reason: string | null }>('select decision, reason from command_approval where command_id = $1', [command.commandId]);
    expect(approval.rows).toEqual([{ decision: 'REJECTED', reason: '근거 부족' }]);
    const row = await q<{ approval_expires_at: Date | null }>('select approval_expires_at from ops_command where id = $1', [command.commandId]);
    expect(row.rows[0]!.approval_expires_at).toBeNull();

    await expect(decide.approve({ commandId: command.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: NOW + 3 })).rejects.toMatchObject({ status: 409 });
  });

  test('GAT110_1인·즉시_명령은_승인_대기_없이_APPROVED이고_승인할_수_없다', async () => {
    const one = await create.execute(commandInput('LOG_LEVEL'));
    const none = await create.execute(commandInput('KILL_SWITCH'));
    expect(one.state).toBe('APPROVED');
    expect(none.state).toBe('APPROVED');
    expect(one.approvalExpiresAtMs).toBeUndefined();

    const row = await q<{ approval_expires_at: Date | null }>('select approval_expires_at from ops_command where id = $1', [one.commandId]);
    expect(row.rows[0]!.approval_expires_at).toBeNull();
    await expect(decide.approve({ commandId: one.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: NOW + 1 })).rejects.toMatchObject({ status: 409 });
  });

  test('GAT110_목록은_유형·상태·회차로_거르고_커서로_나누며_상세는_params를_싣는다', async () => {
    const eventId = randomUUID();
    const a = await create.execute(commandInput('LOG_LEVEL', { params: { eventId }, nowMs: NOW + 10 }));
    const b = await create.execute(commandInput('BOT_LEVEL', { params: { eventId }, nowMs: NOW + 11 }));

    const page1 = await list.execute({ eventId, limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await list.execute({ eventId, limit: 1, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.commandId).not.toBe(page1.items[0]!.commandId);
    expect([page1.items[0]!.commandId, page2.items[0]!.commandId]).toEqual([b.commandId, a.commandId]);

    expect((await list.execute({ eventId, type: 'BOT_LEVEL', limit: 10 })).items.map((c) => c.commandId)).toEqual([b.commandId]);
    expect((await list.execute({ eventId, states: ['APPROVED'], limit: 10 })).items.map((c) => c.commandId)).toEqual([a.commandId]);

    expect((await get.execute(a.commandId)).params).toEqual({ eventId });
    await expect(get.execute(randomUUID())).rejects.toMatchObject({ status: 404 });
  });

  test('GAT110_동시_접수도_감사_체인_seq와_머리가_어긋나지_않는다', async () => {
    const before = await q<{ last_seq: string }>('select last_seq from audit_chain_head where id = 1');
    const start = Number(before.rows[0]!.last_seq);
    const created = await Promise.all(Array.from({ length: 5 }, (_, i) => create.execute(commandInput('LOG_LEVEL', { reason: `동시 ${i}`, nowMs: NOW + 20 + i }))));

    const rows = await q<{ seq: string; hash: string }>("select seq, encode(record_sha256, 'hex') as hash from audit_chain order by seq");
    expect(rows.rows).toHaveLength(start + created.length);
    expect(rows.rows.map((r) => Number(r.seq))).toEqual(Array.from({ length: start + created.length }, (_, i) => i + 1));

    const head = await q<{ last_seq: string; hash: string }>("select last_seq, encode(last_hash, 'hex') as hash from audit_chain_head where id = 1");
    expect(head.rows[0]).toEqual({ last_seq: String(rows.rows.length), hash: rows.rows.at(-1)!.hash });
  });
});

describe('CS 처리함 REFUND_FAILED', () => {
  test('GAT110_REFUND_FAILED는_같은_대상이면_열린_건_하나이고_RESOLVED_뒤에는_새_건이다', async () => {
    const target = `cancel-${randomUUID()}`;
    const payload = { eventKey: randomUUID(), kind: 'REFUND_FAILED' as const, sourceId: target, category: 'REFUND', createdAt: new Date(NOW).toISOString() };

    const a = await receiveCase.handle(payload, NOW);
    const b = await receiveCase.handle({ ...payload, eventKey: randomUUID() }, NOW + 1);
    expect(a.accepted).toBe(true);
    expect(b.accepted).toBe(true);
    expect(b.case!.caseId).toBe(a.case!.caseId);
    expect(await count('select count(*) as n from cs_case where kind = $1 and target_ref = $2', ['REFUND_FAILED', target])).toBe(1);

    await q("update cs_case set status = 'RESOLVED', updated_at = now() where id = $1", [a.case!.caseId]);
    const c = await receiveCase.handle(payload, NOW + 2);
    expect(c.case!.caseId).not.toBe(a.case!.caseId);
    expect(await count('select count(*) as n from cs_case where kind = $1 and target_ref = $2', ['REFUND_FAILED', target])).toBe(2);

    const inquiry = await receiveCase.handle({ ...payload, kind: 'INQUIRY' }, NOW + 3);
    expect(inquiry.accepted).toBe(false);
    expect(await count('select count(*) as n from cs_case where kind = $1 and target_ref = $2', ['INQUIRY', target])).toBe(0);

    const otherKind = await cases.open({ caseId: randomUUID(), kind: 'INQUIRY', targetRef: target, nowMs: NOW + 4 });
    expect(otherKind.caseId).not.toBe(c.case!.caseId);
  });

  test('GAT110_CS_제약은_잘못된_상태와_같은_열린_건_직접_쓰기를_막는다', async () => {
    const target = `cancel-${randomUUID()}`;
    const id = randomUUID();
    await expect(
      q("insert into cs_case (id, kind, target_ref, status, created_at, updated_at) values ($1, 'REFUND_FAILED', $2, 'OPEN', now(), now())", [id, target]),
    ).resolves.toBeDefined();
    await expect(
      q("insert into cs_case (id, kind, target_ref, status, created_at, updated_at) values ($1, 'REFUND_FAILED', $2, 'OPEN', now(), now())", [randomUUID(), target]),
    ).rejects.toThrow(/cs_case_open_key/);
    await expect(
      q("insert into cs_case (id, kind, target_ref, status, created_at, updated_at) values ($1, 'REFUND_FAILED', $2, 'BROKEN', now(), now())", [randomUUID(), `cancel-${randomUUID()}`]),
    ).rejects.toThrow(/cs_case_status_check/);
  });
});
