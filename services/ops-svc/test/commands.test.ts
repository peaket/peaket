// 운영 명령 접수·2인 승인·감사 해시 체인(GAT-110 첫 몫) 단위 시험.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { auditHash, MemoryAuditChain } from '../src/modules/audit/index.js';
import {
  CreateCommand,
  DecideCommand,
  ExecuteCommand,
  ListCommands,
  MemoryCommandStore,
  approvalModeOf,
  approverRolesOf,
  requesterRolesOf,
  stateAfterCreate,
  viewOf,
  type CommandExecutor,
  type CommandType,
} from '../src/modules/commands/index.js';
import { MemoryEventCancellationStore, StoreCancelledEventGuard, type EventCancellationStatus } from '../src/modules/event-cancellations/index.js';

const NOW = Date.parse('2026-11-14T01:00:00.000Z');
const REQUESTER = '0193a000-0000-7000-8000-000000000001';
const APPROVER = '0193a000-0000-7000-8000-000000000002';

const fixture = (executor?: CommandExecutor) => {
  const audit = new MemoryAuditChain();
  const store = new MemoryCommandStore(audit);
  const execution = executor ? new ExecuteCommand(store, executor) : undefined;
  return { audit, store, create: new CreateCommand(store, execution), list: new ListCommands(store), decide: new DecideCommand(store, execution) };
};

const COMMANDER_TYPES = ['BOT_LEVEL', 'KILL_SWITCH', 'AUTOMATION_STOP', 'SALE_STOP', 'SALE_RESUME', 'DEGRADED_MODE'];
/** 명령 1·2·3·4·5는 openapi Command.params의 칸만 받는다(ADR-0340 결정 9). 그 밖의 유형은 OPS-300 전까지 열린 객체다 */
const PARAMS: Partial<Record<CommandType, Record<string, unknown>>> = {
  BOT_LEVEL: { level: 'AGGRESSIVE' },
  KILL_SWITCH: { scope: 'PLATFORM' },
  AUTOMATION_STOP: {},
};
const input = (type: CommandType, over: Record<string, unknown> = {}) => ({
  type,
  reason: '장애 대응',
  params: PARAMS[type] ?? { level: 'DEBUG' },
  requestedBy: REQUESTER,
  requestedRole: COMMANDER_TYPES.includes(type) ? 'commander' : 'operator',
  nowMs: NOW,
  ...over,
});

describe('운영 명령 접수·승인', () => {
  test('GAT110_1인_명령은_바로_APPROVED이고_감사_기록이_남는다', async () => {
    const f = fixture();
    const c = await f.create.execute(input('LOG_LEVEL'));
    expect(c.state).toBe('APPROVED');
    expect(c.approvalExpiresAtMs).toBeUndefined();
    expect(f.audit.entries).toHaveLength(1);
    expect(f.audit.entries[0]).toMatchObject({ recordType: 'COMMAND_CREATED', recordId: c.commandId });
  });

  test('GAT110_2인_명령은_PENDING_APPROVAL과_10분_승인_기한을_둔다', async () => {
    const f = fixture();
    const c = await f.create.execute(input('BOT_LEVEL'));
    expect(c.state).toBe('PENDING_APPROVAL');
    expect(c.approvalExpiresAtMs).toBe(NOW + 10 * 60_000);
    expect(approvalModeOf('BOT_LEVEL')).toBe('TWO');
    expect(approvalModeOf('BLOCK_ASN_IP')).toBe('TWO');
    expect(stateAfterCreate('TWO')).toBe('PENDING_APPROVAL');
  });

  test('GAT110_멈추는_명령은_승인_대기_없이_APPROVED다', async () => {
    const f = fixture();
    const kill = await f.create.execute(input('KILL_SWITCH'));
    const stop = await f.create.execute(input('AUTOMATION_STOP'));
    expect(kill.state).toBe('APPROVED');
    expect(stop.state).toBe('APPROVED');
    expect(approvalModeOf('KILL_SWITCH')).toBe('NONE');
    expect(approvalModeOf('AUTOMATION_STOP')).toBe('NONE');
  });

  test('B3H01_commander_전용_명령은_operator가_요청·승인할_수_없고_canApprove가_역할을_따른다', async () => {
    const f = fixture();
    await expect(f.create.execute(input('KILL_SWITCH', { requestedRole: 'operator' }))).rejects.toMatchObject({ status: 403 });
    expect(requesterRolesOf('SALE_STOP')).toEqual(['operator', 'commander']);
    expect(approverRolesOf('SALE_STOP')).toEqual(['commander']);
    expect(requesterRolesOf('KILL_SWITCH')).toEqual(['commander']);
    expect(requesterRolesOf('EVENT_CANCEL')).toEqual(['operator', 'commander']);
    expect(approverRolesOf('EVENT_CANCEL')).toEqual(['operator', 'commander']);

    const c = await f.create.execute(input('SALE_STOP', { params: { eventId: randomUUID() } }));
    expect(c.state).toBe('PENDING_APPROVAL');
    await expect(f.decide.approve({ commandId: c.commandId, approverRef: APPROVER, approverRole: 'operator', nowMs: NOW + 1 })).rejects.toMatchObject({ status: 403 });
    const principal = (accountId: string, role: string) => ({ accountId, sessionId: '', aud: 'ops' as const, scopes: [], role });
    expect(viewOf(c, principal(APPROVER, 'operator')).canApprove).toBe(false);
    expect(viewOf(c, principal(APPROVER, 'commander')).canApprove).toBe(true);
    const approved = await f.decide.approve({ commandId: c.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: NOW + 1 });
    expect(approved.state).toBe('APPROVED');
  });

  test('GAT110_회차_ID가_UUID가_아니면_422다', async () => {
    const f = fixture();
    await expect(f.create.execute(input('LOG_LEVEL', { params: { eventId: 'not-a-uuid' } }))).rejects.toMatchObject({ status: 422 });
  });

  test('GAT110_eventIds_배열이면_첫_회차를_목록_필터로_쓴다', async () => {
    const f = fixture();
    const eventId = randomUUID();
    const c = await f.create.execute(input('LOG_LEVEL', { params: { eventIds: [eventId, randomUUID()] } }));
    expect((await f.list.execute({ eventId, limit: 10 })).items.map((x) => x.commandId)).toEqual([c.commandId]);
  });

  test('GAT110_빈_사유와_빈_거부_사유는_직접_불러도_422다', async () => {
    const f = fixture();
    await expect(f.create.execute(input('LOG_LEVEL', { reason: '   ' }))).rejects.toMatchObject({ status: 422 });
    const c = await f.create.execute(input('BOT_LEVEL'));
    await expect(f.decide.reject({ commandId: c.commandId, approverRef: APPROVER, approverRole: 'operator', reason: '   ', nowMs: NOW + 1 })).rejects.toMatchObject({ status: 422 });
    await expect(f.decide.reject({ commandId: c.commandId, approverRef: APPROVER, approverRole: 'operator', reason: '근거\u0000부족', nowMs: NOW + 1 })).rejects.toMatchObject({ status: 422 });
  });

  test('GAT120_EVENT_CANCEL은_2인_승인_뒤_purchase로_전달하고_SUCCEEDED가_된다', async () => {
    const dispatched: string[] = [];
    const f = fixture({ execute: async (c) => (dispatched.push(c.commandId), { status: 'SUCCEEDED' as const }) });
    const eventId = randomUUID();
    const c = await f.create.execute(input('EVENT_CANCEL', { params: { eventId, fault: 'ORGANIZER' } }));
    expect(c.state).toBe('PENDING_APPROVAL');
    expect(approvalModeOf('EVENT_CANCEL')).toBe('TWO');
    const approved = await f.decide.approve({ commandId: c.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: NOW + 1 });
    expect(approved.state).toBe('SUCCEEDED');
    expect(dispatched).toEqual([c.commandId]);
    expect(f.audit.entries.map((e) => e.recordType)).toEqual(['COMMAND_CREATED', 'COMMAND_APPROVED', 'COMMAND_EXECUTION_STARTED', 'COMMAND_SUCCEEDED']);
  });

  test('GAT120_EVENT_CANCEL_전달이_실패하면_FAILED를_남긴다', async () => {
    const f = fixture({ execute: async () => { throw new Error('purchase down'); } });
    const c = await f.create.execute(input('EVENT_CANCEL', { params: { eventId: randomUUID(), fault: 'ORGANIZER' } }));
    const failed = await f.decide.approve({ commandId: c.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: NOW + 1 });
    expect(failed.state).toBe('FAILED');
    expect(failed.lastError).toBe('purchase down');
    expect((await f.store.find(c.commandId))?.state).toBe('FAILED');
    expect(f.audit.entries.at(-1)).toMatchObject({ recordType: 'COMMAND_EXECUTION_FAILED' });
  });

  test('GAT110_요청자_본인은_승인할_수_없고_다른_계정은_승인한다', async () => {
    const f = fixture();
    const c = await f.create.execute(input('BOT_LEVEL'));
    await expect(f.decide.approve({ commandId: c.commandId, approverRef: REQUESTER, approverRole: 'commander', nowMs: NOW + 1 })).rejects.toMatchObject({ status: 403 });
    const approved = await f.decide.approve({ commandId: c.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: NOW + 1 });
    expect(approved.state).toBe('APPROVED');
    expect(approved.approvals).toEqual([APPROVER]);
    expect(approved.approvalExpiresAtMs).toBeUndefined();
    expect(f.audit.entries.map((e) => e.recordType)).toEqual(['COMMAND_CREATED', 'COMMAND_APPROVED']);
  });

  test('GAT110_거부는_REJECTED와_사유를_남긴다', async () => {
    const f = fixture();
    const c = await f.create.execute(input('BOT_LEVEL'));
    const rejected = await f.decide.reject({ commandId: c.commandId, approverRef: APPROVER, approverRole: 'commander', reason: '근거 부족', nowMs: NOW + 1 });
    expect(rejected.state).toBe('REJECTED');
    expect(f.audit.entries.at(-1)).toMatchObject({ recordType: 'COMMAND_REJECTED' });
  });

  test('GAT110_승인_대기가_아니면_409다', async () => {
    const f = fixture();
    const c = await f.create.execute(input('LOG_LEVEL'));
    await expect(f.decide.approve({ commandId: c.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: NOW + 1 })).rejects.toMatchObject({ status: 409 });
  });

  test('GAT110_목록은_유형·상태로_거르고_커서로_나눈다', async () => {
    const f = fixture();
    const a = await f.create.execute(input('LOG_LEVEL', { reason: '첫째' }));
    const b = await f.create.execute(input('BOT_LEVEL', { reason: '둘째' }));
    const first = await f.list.execute({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await f.list.execute({ limit: 1, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.commandId).not.toBe(first.items[0]!.commandId);
    expect((await f.list.execute({ limit: 10, type: 'BOT_LEVEL' })).items.map((c) => c.commandId)).toEqual([b.commandId]);
    expect((await f.list.execute({ limit: 10, states: ['APPROVED'] })).items.map((c) => c.commandId)).toEqual([a.commandId]);
  });
});

// BAT-420 GAT-110 H(ADR-0280 결정 2): 회차 취소가 확정된 회차의 판매 재개를 만들 때·실행 때 막는다. 시험 담당이 구현 전에 썼다.
describe('회차 취소 확정 회차의 판매 재개 막기 [BAT-420]', () => {
  const guarded = async (records: Array<{ status: EventCancellationStatus; kind?: 'CANCEL' | 'POSTPONE'; eventId: string }>, executor?: CommandExecutor) => {
    const audit = new MemoryAuditChain();
    const store = new MemoryCommandStore(audit);
    const cancellations = new MemoryEventCancellationStore();
    for (const r of records) {
      await cancellations.insert({
        requestId: randomUUID(),
        eventId: r.eventId,
        kind: r.kind ?? 'CANCEL',
        status: r.status,
        reason: '공연 취소',
        requestedBy: REQUESTER,
        requestedAt: new Date(NOW - 60_000),
        fault: null,
        judgementReason: null,
        fanNoticeReason: null,
        judgedBy: null,
        judgedAt: null,
        approvedBy: null,
        approvedAt: null,
        refundJobState: null,
        version: 1,
        updatedAt: new Date(NOW - 60_000),
      });
    }
    const guard = new StoreCancelledEventGuard(cancellations);
    const execution = executor ? new ExecuteCommand(store, executor, undefined, guard) : undefined;
    return { store, cancellations, create: new CreateCommand(store, execution, guard), decide: new DecideCommand(store, execution) };
  };
  const resume = (eventId: string) => input('SALE_RESUME', { params: { eventId } });

  test('R-T37 ⑤ 회차 취소가 APPROVED·RUNNING·PAUSED·COMPLETED인 회차의 판매 재개 명령은 만들 때 409 event-cancelled다', async () => {
    for (const status of ['APPROVED', 'RUNNING', 'PAUSED', 'COMPLETED'] as const) {
      const eventId = randomUUID();
      const f = await guarded([{ status, eventId }]);
      await expect(f.create.execute(resume(eventId))).rejects.toMatchObject({ status: 409, slug: 'event-cancelled' });
      expect((await f.store.list({ limit: 10 })).items).toEqual([]);
    }
  });

  test('R-T37 ⑤ 확정 전·반려된 회차 취소, 연기, 다른 회차와 판매 중지는 판매 재개를 막지 않는다(목록 밖 값마다)', async () => {
    for (const status of ['REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'REJECTED'] as const) {
      const eventId = randomUUID();
      const f = await guarded([{ status, eventId }]);
      expect((await f.create.execute(resume(eventId))).state).toBe('PENDING_APPROVAL');
    }
    for (const status of ['RUNNING', 'REFUND_WINDOW', 'COMPLETED'] as const) {
      const eventId = randomUUID();
      const f = await guarded([{ status, kind: 'POSTPONE', eventId }]);
      expect((await f.create.execute(resume(eventId))).state).toBe('PENDING_APPROVAL');
    }
    const cancelled = randomUUID();
    const f = await guarded([{ status: 'RUNNING', eventId: cancelled }]);
    expect((await f.create.execute(resume(randomUUID()))).state).toBe('PENDING_APPROVAL');
    expect((await f.create.execute(input('SALE_STOP', { params: { eventId: cancelled } }))).state).toBe('PENDING_APPROVAL');
  });

  test('R-T37 ⑤ 확정 전에 만든 판매 재개를 확정 뒤 실행하면 FAILED event-cancelled이고 실행기를 부르지 않는다', async () => {
    const calls: string[] = [];
    const eventId = randomUUID();
    const f = await guarded([], { execute: async (c) => (calls.push(`${c.type}:${c.commandId}`), { status: 'SUCCEEDED' as const }) });
    const early = await f.create.execute(resume(eventId));
    expect(early.state).toBe('PENDING_APPROVAL');
    const stop = await f.create.execute(input('SALE_STOP', { params: { eventId } }));
    await f.cancellations.insert({
      requestId: randomUUID(),
      eventId,
      kind: 'CANCEL',
      status: 'RUNNING',
      reason: '공연 취소',
      requestedBy: REQUESTER,
      requestedAt: new Date(NOW),
      fault: 'ORGANIZER',
      judgementReason: '주최 측 귀책',
      fanNoticeReason: '공연이 취소되었습니다',
      judgedBy: REQUESTER,
      judgedAt: new Date(NOW),
      approvedBy: APPROVER,
      approvedAt: new Date(NOW),
      refundJobState: 'RUNNING',
      version: 4,
      updatedAt: new Date(NOW),
    });
    const ran = await f.decide.approve({ commandId: early.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: NOW + 1 });
    expect(ran).toMatchObject({ state: 'FAILED', lastError: 'event-cancelled' });
    expect(calls).toEqual([]);
    // 판매 중지는 그대로 실행한다(재개만 막는다)
    const stopped = await f.decide.approve({ commandId: stop.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: NOW + 2 });
    expect(stopped.state).toBe('SUCCEEDED');
    expect(calls).toEqual([`SALE_STOP:${stop.commandId}`]);
  });
});

describe('감사 해시 체인', () => {
  test('GAT110_각_기록의_해시는_직전_해시와_기록으로_이어지고_바꾸면_깨진다', async () => {
    const audit = new MemoryAuditChain();
    await audit.append({ recordType: 'A', recordId: '0193a000-0000-7000-8000-000000000001', payload: { n: 1 }, nowMs: NOW });
    await audit.append({ recordType: 'B', recordId: '0193a000-0000-7000-8000-000000000002', payload: { n: 2 }, nowMs: NOW + 1 });
    expect(audit.entries).toHaveLength(2);
    expect(audit.entries[1]!.prevHash).toBe(audit.entries[0]!.hash);
    const recomputed = auditHash(audit.entries[0]!.hash, { recordType: 'B', recordId: audit.entries[1]!.recordId, payload: { n: 2 }, nowMs: NOW + 1 });
    expect(recomputed).toBe(audit.entries[1]!.hash);
    expect(auditHash(audit.entries[0]!.hash, { recordType: 'B', recordId: audit.entries[1]!.recordId, payload: { n: 3 }, nowMs: NOW + 1 })).not.toBe(audit.entries[1]!.hash);
  });

  test('GAT110_해시는_직전_해시·기록_ID·시각·종류가_다르면_달라진다', () => {
    const base = { recordType: 'A', recordId: '0193a000-0000-7000-8000-000000000001', payload: { n: 1 }, nowMs: NOW };
    expect(auditHash('a', base)).not.toBe(auditHash('b', base));
    expect(auditHash('a', base)).not.toBe(auditHash('a', { ...base, recordId: '0193a000-0000-7000-8000-000000000002' }));
    expect(auditHash('a', base)).not.toBe(auditHash('a', { ...base, nowMs: NOW + 1 }));
    expect(auditHash('a', base)).not.toBe(auditHash('a', { ...base, recordType: 'B' }));
    expect(auditHash('a', { ...base, payload: { a: 1, b: 2 } })).toBe(auditHash('a', { ...base, payload: { b: 2, a: 1 } }));
  });

  test('GAT110_메모리_체인은_seq를_1부터_이어_붙인다', async () => {
    const audit = new MemoryAuditChain();
    await audit.append({ recordType: 'A', recordId: '0193a000-0000-7000-8000-000000000001', payload: {}, nowMs: NOW });
    await audit.append({ recordType: 'B', recordId: '0193a000-0000-7000-8000-000000000002', payload: {}, nowMs: NOW + 1 });
    expect(audit.entries.map((e) => e.seq)).toEqual([1, 2]);
  });
});
