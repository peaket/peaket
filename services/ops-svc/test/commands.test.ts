// 운영 명령 접수·2인 승인·감사 해시 체인(GAT-110 첫 몫) 단위 시험.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { auditHash, MemoryAuditChain } from '../src/modules/audit/index.js';
import { CreateCommand, DecideCommand, ListCommands, MemoryCommandStore, approvalModeOf, stateAfterCreate, type CommandDispatcher } from '../src/modules/commands/index.js';

const NOW = Date.parse('2026-11-14T01:00:00.000Z');
const REQUESTER = '0193a000-0000-7000-8000-000000000001';
const APPROVER = '0193a000-0000-7000-8000-000000000002';

const fixture = (dispatcher?: CommandDispatcher) => {
  const audit = new MemoryAuditChain();
  const store = new MemoryCommandStore(audit);
  return { audit, store, create: new CreateCommand(store), list: new ListCommands(store), decide: new DecideCommand(store, dispatcher) };
};

const input = (type: 'LOG_LEVEL' | 'BOT_LEVEL' | 'KILL_SWITCH' | 'AUTOMATION_STOP' | 'EVENT_CANCEL', over: Record<string, unknown> = {}) => ({
  type,
  reason: '장애 대응',
  params: { level: 'DEBUG' },
  requestedBy: REQUESTER,
  requestedRole: 'operator',
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

  test('GAT120_EVENT_CANCEL은_2인_승인_뒤_purchase로_전달하고_DISPATCHED가_된다', async () => {
    const dispatched: string[] = [];
    const f = fixture({ dispatch: async (c) => void dispatched.push(c.commandId) });
    const eventId = randomUUID();
    const c = await f.create.execute(input('EVENT_CANCEL', { params: { eventId, fault: 'ORGANIZER' } }));
    expect(c.state).toBe('PENDING_APPROVAL');
    expect(approvalModeOf('EVENT_CANCEL')).toBe('TWO');
    const approved = await f.decide.approve({ commandId: c.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: NOW + 1 });
    expect(approved.state).toBe('DISPATCHED');
    expect(dispatched).toEqual([c.commandId]);
    expect(f.audit.entries.map((e) => e.recordType)).toEqual(['COMMAND_CREATED', 'COMMAND_APPROVED', 'COMMAND_DISPATCHED']);
  });

  test('GAT120_EVENT_CANCEL_전달이_실패하면_FAILED와_503을_남긴다', async () => {
    const f = fixture({ dispatch: async () => { throw new Error('purchase down'); } });
    const c = await f.create.execute(input('EVENT_CANCEL', { params: { eventId: randomUUID(), fault: 'ORGANIZER' } }));
    await expect(f.decide.approve({ commandId: c.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: NOW + 1 })).rejects.toMatchObject({ status: 503 });
    expect((await f.store.find(c.commandId))?.state).toBe('FAILED');
    expect(f.audit.entries.at(-1)).toMatchObject({ recordType: 'COMMAND_DISPATCH_FAILED' });
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
    const rejected = await f.decide.reject({ commandId: c.commandId, approverRef: APPROVER, approverRole: 'operator', reason: '근거 부족', nowMs: NOW + 1 });
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
