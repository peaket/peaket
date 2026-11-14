// 운영 명령 실행·재시도·감사 체크포인트(BAT-465 GAT-300·GAT-310) 단위 시험.
// 승인된 명령이 실제 대상에 전달되고 SUCCEEDED/FAILED로 끝나며, 실행 전후 감사 체크포인트가 이어지는지 본다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { AuditCheckpointService, MemoryAuditChain, MemoryAuditCheckpointStore, auditCheckpointRoot } from '../src/modules/audit/index.js';
import {
  CreateCommand,
  DecideCommand,
  ExecuteCommand,
  ListCommands,
  MemoryCommandStore,
  RetryCommand,
  approvalModeOf,
  type CommandExecutionActor,
  type CommandExecutionResult,
  type CommandExecutor,
} from '../src/modules/commands/index.js';

const NOW = Date.parse('2026-11-14T01:00:00.000Z');
const REQUESTER = '0193a000-0000-7000-8000-000000000001';
const APPROVER = '0193a000-0000-7000-8000-000000000002';
const SESSION = '0193a000-0000-7000-8000-000000000003';

const actor = (accountId: string = REQUESTER): CommandExecutionActor => ({ accountId, sessionId: SESSION, role: 'operator' });

const fixture = (executor?: CommandExecutor) => {
  const audit = new MemoryAuditChain();
  const checkpoints = new MemoryAuditCheckpointStore();
  const checkpointService = new AuditCheckpointService(checkpoints, audit, () => NOW);
  const store = new MemoryCommandStore(audit);
  const execute = new ExecuteCommand(store, executor, checkpointService);
  return {
    audit,
    checkpoints,
    store,
    create: new CreateCommand(store, execute),
    decide: new DecideCommand(store, execute),
    retry: new RetryCommand(store, execute),
    list: new ListCommands(store),
  };
};

const input = (type: 'SCALE_CHANGE' | 'EVENT_CANCEL' | 'LOG_LEVEL' | 'BOT_LEVEL', over: Record<string, unknown> = {}) => ({
  type,
  reason: '장애 대응',
  params: { eventId: randomUUID(), scale: 'LARGE', fault: 'ORGANIZER' },
  requestedBy: REQUESTER,
  requestedRole: 'operator',
  nowMs: NOW,
  actor: actor(),
  ...over,
});

const executorOf = (results: CommandExecutionResult[]): CommandExecutor & { calls: Array<{ commandId: string; actor: CommandExecutionActor }> } => {
  const calls: Array<{ commandId: string; actor: CommandExecutionActor }> = [];
  return {
    calls,
    execute: async (command, a) => {
      calls.push({ commandId: command.commandId, actor: a });
      return results.shift() ?? { status: 'SUCCEEDED' };
    },
  };
};

describe('운영 명령 실행·재시도', () => {
  test('GAT300_1인_SCALE_CHANGE는_접수_뒤_바로_실행하고_SUCCEEDED다', async () => {
    const executor = executorOf([{ status: 'SUCCEEDED', detail: { applied: true } }]);
    const f = fixture(executor);
    const c = await f.create.execute(input('SCALE_CHANGE'));
    expect(c.state).toBe('SUCCEEDED');
    expect(c.attempts).toBe(1);
    expect(c.executedAtMs).toBe(NOW);
    expect(c.result).toEqual({ applied: true });
    expect(executor.calls).toEqual([{ commandId: c.commandId, actor: actor() }]);
    expect(f.audit.entries.map((e) => e.recordType)).toEqual([
      'COMMAND_CREATED',
      'AUDIT_CHECKPOINT_CREATED',
      'COMMAND_EXECUTION_STARTED',
      'COMMAND_SUCCEEDED',
      'AUDIT_CHECKPOINT_CREATED',
    ]);
    expect(f.checkpoints.entries.map((x) => x.reason)).toEqual([`COMMAND_EXECUTION_BEFORE:${c.commandId}`, `COMMAND_EXECUTION_AFTER:${c.commandId}`]);
  });

  test('GAT300_2인_EVENT_CANCEL은_승인_뒤_실행하고_SUCCEEDED다', async () => {
    const executor = executorOf([{ status: 'SUCCEEDED' }]);
    const f = fixture(executor);
    const c = await f.create.execute(input('EVENT_CANCEL'));
    expect(c.state).toBe('PENDING_APPROVAL');
    expect(executor.calls).toHaveLength(0);
    const approved = await f.decide.approve({ commandId: c.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: NOW + 1, actor: actor(APPROVER) });
    expect(approved.state).toBe('SUCCEEDED');
    expect(approved.attempts).toBe(1);
    expect(executor.calls).toEqual([{ commandId: c.commandId, actor: actor(APPROVER) }]);
    expect(approvalModeOf('EVENT_CANCEL')).toBe('TWO');
  });

  test('GAT300_실행_실패는_FAILED와_lastError를_남기고_재시도는_SUCCEEDED다', async () => {
    const executor = executorOf([{ status: 'FAILED', error: 'purchase-svc 503' }, { status: 'SUCCEEDED' }]);
    const f = fixture(executor);
    const c = await f.create.execute(input('EVENT_CANCEL'));
    const failed = await f.decide.approve({ commandId: c.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: NOW + 1, actor: actor(APPROVER) });
    expect(failed.state).toBe('FAILED');
    expect(failed.lastError).toBe('purchase-svc 503');
    expect(failed.attempts).toBe(1);
    const retried = await f.retry.execute({ commandId: c.commandId, actor: actor(APPROVER), nowMs: NOW + 2 });
    expect(retried.state).toBe('SUCCEEDED');
    expect(retried.attempts).toBe(2);
    expect(retried.lastError).toBeUndefined();
    expect(executor.calls).toHaveLength(2);
  });

  test('GAT300_FAILED가_아니면_재시도는_409다', async () => {
    const f = fixture(executorOf([{ status: 'SUCCEEDED' }]));
    const c = await f.create.execute(input('SCALE_CHANGE'));
    await expect(f.retry.execute({ commandId: c.commandId, actor: actor(), nowMs: NOW + 1 })).rejects.toMatchObject({ status: 409, slug: 'command-not-failed' });
  });

  test('GAT310_대상이_없는_유형은_target_not_wired로_FAILED다', async () => {
    const f = fixture();
    const c = await f.create.execute(input('LOG_LEVEL'));
    expect(c.state).toBe('FAILED');
    expect(c.lastError).toBe('target-not-wired');
    expect(c.attempts).toBe(1);
  });

  test('GAT310_감사_체크포인트는_실행_전후_기록을_묶고_검증한다', async () => {
    const f = fixture(executorOf([{ status: 'SUCCEEDED' }]));
    const c = await f.create.execute(input('SCALE_CHANGE'));
    expect(f.checkpoints.entries).toHaveLength(2);
    const [before, after] = f.checkpoints.entries;
    expect(before!.fromSeq).toBe(1);
    expect(before!.toSeq).toBe(1);
    expect(after!.fromSeq).toBe(2);
    expect(after!.toSeq).toBe(4);
    expect(after!.prevCheckpointHash).toBe(before!.rootHash);
    const service = new AuditCheckpointService(f.checkpoints, f.audit, () => NOW);
    expect(await service.verify(before!.checkpointId)).toMatchObject({ valid: true, rootValid: true, prevValid: true });
    expect(await service.verify(after!.checkpointId)).toMatchObject({ valid: true, rootValid: true, prevValid: true });
    // 체인의 기록 하나를 바꾸면 그 기록을 묶은 체크포인트의 루트가 맞지 않는다.
    (f.audit.entries[2] as { hash: string }).hash = '0'.repeat(64);
    expect(await service.verify(after!.checkpointId)).toMatchObject({ valid: false, rootValid: false });
    expect(c.state).toBe('SUCCEEDED');
  });

  test('GAT300_저장소는_실패_뒤_성공에서_lastError를_지운다', async () => {
    const audit = new MemoryAuditChain();
    const store = new MemoryCommandStore(audit);
    const command = await store.create({
      commandId: randomUUID(),
      type: 'SCALE_CHANGE',
      reason: '저장소 시험',
      params: {},
      requestedBy: REQUESTER,
      requestedRole: 'operator',
      nowMs: NOW,
    });
    await store.markDispatched(command.commandId, NOW + 1);
    await store.markDispatchFailed(command.commandId, 'boom', NOW + 2);
    expect((await store.find(command.commandId))?.lastError).toBe('boom');
    await store.markSucceeded(command.commandId, undefined, NOW + 3);
    expect((await store.find(command.commandId))?.lastError).toBeUndefined();
  });

  test('GAT310_체크포인트_루트는_seq와_해시에_따라_달라진다', () => {
    const a = auditCheckpointRoot([{ seq: 1, hash: 'a'.repeat(64) }]);
    const b = auditCheckpointRoot([{ seq: 2, hash: 'a'.repeat(64) }]);
    const c = auditCheckpointRoot([{ seq: 1, hash: 'b'.repeat(64) }]);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(auditCheckpointRoot([{ seq: 1, hash: 'a'.repeat(64) }]));
  });

  test('GAT310_직전_체크포인트_루트가_바뀌면_검증이_실패한다', async () => {
    const f = fixture(executorOf([{ status: 'SUCCEEDED' }, { status: 'SUCCEEDED' }]));
    await f.create.execute(input('SCALE_CHANGE'));
    await f.create.execute(input('SCALE_CHANGE', { nowMs: NOW + 10 }));
    const after = f.checkpoints.entries.at(-1)!;
    const service = new AuditCheckpointService(f.checkpoints, f.audit, () => NOW);
    expect(await service.verify(after.checkpointId)).toMatchObject({ valid: true, prevValid: true });
    (after as { prevCheckpointHash: string }).prevCheckpointHash = '0'.repeat(64);
    expect(await service.verify(after.checkpointId)).toMatchObject({ valid: false, prevValid: false });
  });

  test('GAT310_목록은_updatedAfter로_폴링한다', async () => {
    const f = fixture(executorOf([{ status: 'SUCCEEDED' }, { status: 'SUCCEEDED' }]));
    const a = await f.create.execute(input('SCALE_CHANGE'));
    const b = await f.create.execute(input('SCALE_CHANGE', { nowMs: NOW + 10 }));
    expect((await f.list.execute({ limit: 10, updatedAfterMs: NOW + 5 })).items.map((x) => x.commandId)).toEqual([b.commandId]);
    expect((await f.list.execute({ limit: 10, updatedAfterMs: NOW - 1 })).items.map((x) => x.commandId)).toEqual([b.commandId, a.commandId]);
  });
});
