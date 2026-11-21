// B3-H01 명령 유형별 역할(요청·승인·반려·재시도) 계약(R-614, control-tower §3·§4, POL-021·POL-038).
// 유스케이스(접수·승인·재시도)와 저장소가 같은 정책을 두 번 검사해, HTTP 밖 내부 사건·직접 호출·
// 정책 도입 전 레거시 행으로도 operator가 commander 전용 명령을 움직이지 못하게 한다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import {
  COMMAND_TYPES,
  CreateCommand,
  DecideCommand,
  ExecuteCommand,
  MemoryCommandStore,
  RetryCommand,
  approverRolesOf,
  requesterRolesOf,
  viewOf,
  type CommandExecutionActor,
  type CommandType,
} from '../src/modules/commands/index.js';
import * as commandModule from '../src/modules/commands/index.js';

const NOW = Date.parse('2026-11-14T01:00:00.000Z');
const REQUESTER = '0193a000-0000-7000-8000-000000000001';
const APPROVER = '0193a000-0000-7000-8000-000000000002';
const OTHER = '0193a000-0000-7000-8000-000000000003';

/** commander만 요청·승인·재시도하는 유형(control-tower §3: 멈춤·재개·킬스위치·자동화 정지·봇 강도·Degraded Mode) */
const COMMANDER_ONLY: readonly CommandType[] = ['AUTOMATION_STOP', 'BOT_LEVEL', 'DEGRADED_MODE', 'KILL_SWITCH', 'SALE_RESUME', 'SALE_STOP'];

const actor = (accountId: string, role: string): CommandExecutionActor => ({ accountId, sessionId: `s-${accountId}`, role });
const principal = (accountId: string, role: string) => ({ accountId, sessionId: '', aud: 'ops' as const, scopes: [], role });

const fixture = () => {
  const audit = new MemoryAuditChain();
  const store = new MemoryCommandStore(audit);
  const execution = new ExecuteCommand(store, { execute: async () => ({ status: 'FAILED' as const, error: 'target-not-wired' }) });
  // 승인·반려는 상태 전이만 보고, 실행은 ExecuteCommand가 따로 맡는다(실행 실패가 승인 결과를 덮지 않게).
  return { audit, store, create: new CreateCommand(store, execution), decide: new DecideCommand(store), retry: new RetryCommand(store, execution) };
};

const input = (type: CommandType, over: Record<string, unknown> = {}) => ({
  type,
  reason: '감사 역할 시험',
  params: { eventId: randomUUID() },
  requestedBy: REQUESTER,
  requestedRole: 'commander',
  nowMs: NOW,
  ...over,
});

describe('B3-H01 명령 유형별 역할', () => {
  test('정책 표가 모든 명령 유형을 덮고 commander 전용 유형은 요청·승인 모두 commander다', () => {
    for (const type of COMMAND_TYPES) {
      const policy = commandModule.rolePolicyOf(type);
      expect(policy.requesterRoles.length).toBeGreaterThan(0);
      expect(policy.approverRoles.length).toBeGreaterThan(0);
      // 승인자는 요청 가능 역할의 부분집합이어야 한다(승인만 열린 역할이 생기면 2인 분리가 깨진다).
      expect(policy.approverRoles.every((role) => policy.requesterRoles.includes(role))).toBe(true);
    }
    const commanderOnly = COMMAND_TYPES.filter((type) => requesterRolesOf(type).join(',') === 'commander');
    expect([...commanderOnly].sort()).toEqual([...COMMANDER_ONLY].sort());
    // 회차 취소는 문서대로 operator 이상이 승인한다(과잉 축소 방지).
    expect(approverRolesOf('EVENT_CANCEL')).toEqual(['operator', 'commander']);
  });

  test('operator는 commander 전용 명령을 요청할 수 없고 허용 유형은 그대로 열려 있다', async () => {
    const f = fixture();
    for (const type of COMMANDER_ONLY) {
      await expect(f.create.execute(input(type, { requestedRole: 'operator' }))).rejects.toMatchObject({ status: 403, slug: 'command-role-forbidden' });
    }
    // viewer는 어떤 명령도 요청할 수 없다.
    await expect(f.create.execute(input('LOG_LEVEL', { requestedRole: 'viewer' }))).rejects.toMatchObject({ status: 403, slug: 'command-role-forbidden' });
    expect(f.audit.entries).toHaveLength(0);

    const allowed = await f.create.execute(input('EVENT_CANCEL', { requestedRole: 'operator' }));
    expect(allowed).toMatchObject({ type: 'EVENT_CANCEL', state: 'PENDING_APPROVAL', requestedRole: 'operator' });
    expect(f.audit.entries.map((e) => e.recordType)).toEqual(['COMMAND_CREATED']);
  });

  test('저장소 승인·반려는 레거시 operator 요청 행도 역할 위반으로 닫는다', async () => {
    const f = fixture();
    // 정책 도입 전에 만들어진 행을 흉내 낸다: CreateCommand를 거치지 않고 저장소에 직접 넣는다.
    const legacy = await f.store.create({
      commandId: randomUUID(),
      type: 'SALE_STOP',
      reason: '정책 이전 행',
      params: { eventId: randomUUID() },
      requestedBy: REQUESTER,
      requestedRole: 'operator',
      nowMs: NOW,
    });
    expect(legacy.state).toBe('PENDING_APPROVAL');
    await expect(f.decide.approve({ commandId: legacy.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: NOW + 1 })).rejects.toMatchObject({
      status: 403,
      slug: 'command-role-forbidden',
    });
    await expect(f.decide.reject({ commandId: legacy.commandId, approverRef: APPROVER, approverRole: 'commander', reason: '역할 위반', nowMs: NOW + 1 })).rejects.toMatchObject({
      status: 403,
      slug: 'command-role-forbidden',
    });
    expect((await f.store.find(legacy.commandId))?.state).toBe('PENDING_APPROVAL');
  });

  test('operator는 commander 전용 명령을 승인·반려할 수 없고 canApprove도 거짓이다', async () => {
    const f = fixture();
    const created = await f.create.execute(input('SALE_STOP'));
    expect(created.state).toBe('PENDING_APPROVAL');
    await expect(f.decide.approve({ commandId: created.commandId, approverRef: APPROVER, approverRole: 'operator', nowMs: NOW + 1 })).rejects.toMatchObject({
      status: 403,
      slug: 'command-role-forbidden',
    });
    await expect(
      f.decide.reject({ commandId: created.commandId, approverRef: APPROVER, approverRole: 'operator', reason: 'operator 반려', nowMs: NOW + 1 }),
    ).rejects.toMatchObject({ status: 403, slug: 'command-role-forbidden' });
    expect(viewOf(created, principal(APPROVER, 'operator')).canApprove).toBe(false);
    expect(viewOf(created, principal(APPROVER, 'commander')).canApprove).toBe(true);

    const approved = await f.decide.approve({ commandId: created.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: NOW + 2 });
    expect(approved.state).toBe('APPROVED');
  });

  test('operator는 실패한 commander 전용 명령을 재시도할 수 없고 레거시 요청 역할도 함께 본다', async () => {
    const f = fixture();
    // commander가 요청해 실패한 KILL_SWITCH: operator 재시도는 403, commander만 시도할 수 있다.
    const failed = await f.create.execute(input('KILL_SWITCH', { params: { scope: 'EVENT', eventIds: [randomUUID()] } }));
    expect(failed.state).toBe('FAILED');
    await expect(f.retry.execute({ commandId: failed.commandId, actor: actor(OTHER, 'operator'), nowMs: NOW + 1 })).rejects.toMatchObject({
      status: 403,
      slug: 'command-role-forbidden',
    });
    expect((await f.store.find(failed.commandId))?.attempts).toBe(1);

    // 레거시 operator 요청 행은 commander가 재시도해도 요청 역할이 정책 밖이라 닫힌다.
    const legacy = await f.store.create({
      commandId: randomUUID(),
      type: 'AUTOMATION_STOP',
      reason: '정책 이전 행',
      params: {},
      requestedBy: REQUESTER,
      requestedRole: 'operator',
      nowMs: NOW,
    });
    await f.store.markDispatched(legacy.commandId, NOW + 1);
    await f.store.markDispatchFailed(legacy.commandId, 'target-not-wired', NOW + 2);
    await expect(f.retry.execute({ commandId: legacy.commandId, actor: actor(APPROVER, 'commander'), nowMs: NOW + 3 })).rejects.toMatchObject({
      status: 403,
      slug: 'command-role-forbidden',
    });
    expect((await f.store.find(legacy.commandId))?.attempts).toBe(1);

    const retried = await f.retry.execute({ commandId: failed.commandId, actor: actor(APPROVER, 'commander'), nowMs: NOW + 4 });
    expect(retried.attempts).toBe(2);
  });
});
