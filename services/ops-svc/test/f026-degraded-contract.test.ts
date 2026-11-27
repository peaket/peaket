// F-02-6(동결 로컬) 명령 6 진입·상태 조회 Degraded, 명령 4 ASN 만료, C-T12 감사의 계약 시험.
// 구현 전 트리에서 의미 있게 실패하는 것만 둔다(모듈이 없어 실행 전 실패하는 포트 시험은 f026-edge-ports.test.ts).
// 정본: docs/features/control-tower.md §3 명령 4·6, §5 '제어 상태'·'CDN 설정 API', §14 C-T12·C-T44 ⑥,
// docs/features/queue-admission.md §4·§9, ADR-0223 결정 1·8, ADR-0234 결정 5, ADR-0339, ADR-0340 결정 5·6, ADR-0349 결정 9·10, ADR-0365 결정 2·6.
// 수치 주장 없음: 이 파일은 처리량·인원·K1/K2/K7 수치를 새로 주장하지 않는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import {
  checkCommandParams,
  CommandEventBody,
  CommandInputRejected,
  controlDeliveriesOf,
  controlKindOf,
  controlScopesOf,
  CreateCommand,
  ExecuteCommand,
  HandleCommandEvent,
  MemoryCommandStore,
  approvalModeOf,
  blockExpiryVerdict,
  reauthRequiredFor,
  type Command,
} from '../src/modules/commands/index.js';

const NOW = Date.parse('2026-11-28T00:00:00.000Z');
const HOUR = 60 * 60_000;
const REQUESTER = '0193a000-0000-7000-8000-0000000000f1';

/** 명령 6의 params를 그대로 넘기는 작은 도우미(리터럴 타입이 string으로 넓어지지 않게) */
const degraded = (params: Record<string, unknown>) => ({ type: 'DEGRADED_MODE' as const, params });

/** command-writes가 감사 payload에 싣는 값을 꺼낸다 */
const auditPayloads = (audit: MemoryAuditChain, recordType: string): Record<string, unknown>[] =>
  audit.entries.filter((e) => e.recordType === recordType).map((e) => e.record.payload);

describe('F026-ENTRY 명령 6 진입 Degraded의 매개변수 계약', () => {
  test('F026-ENTRY ① ENTRY_DEGRADED는 expiresAt이 필수이고 24시간을 넘으면 422 command-out-of-range다', () => {
    // expiresAt 없음, 모르는 칸, 24시간 + 1ms, 24시간 정각
    expect(() => checkCommandParams('DEGRADED_MODE', { mode: 'ENTRY_DEGRADED' }, NOW)).toThrow(CommandInputRejected);
    expect(() =>
      checkCommandParams('DEGRADED_MODE', { mode: 'ENTRY_DEGRADED', expiresAt: new Date(NOW + HOUR).toISOString(), on: true }, NOW),
    ).toThrow(CommandInputRejected);
    expect(() =>
      checkCommandParams('DEGRADED_MODE', { mode: 'ENTRY_DEGRADED', expiresAt: new Date(NOW + 24 * HOUR + 1).toISOString() }, NOW),
    ).toThrow(CommandInputRejected);
    // 24시간 정각은 받는다(정각 포함 경계). 값은 그대로 돌려준다
    const atLimit = new Date(NOW + 24 * HOUR).toISOString();
    expect(checkCommandParams('DEGRADED_MODE', { mode: 'ENTRY_DEGRADED', expiresAt: atLimit }, NOW)).toEqual({ mode: 'ENTRY_DEGRADED', expiresAt: atLimit });
  });

  test('F026-ENTRY ② STATE_DEGRADED는 EVENT면 소문자 회차 1~100개, PLATFORM이면 회차를 받지 않는다', () => {
    const ids = Array.from({ length: 101 }, () => randomUUID());
    expect(() => checkCommandParams('DEGRADED_MODE', { mode: 'STATE_DEGRADED', scope: 'EVENT', eventIds: ids }, NOW)).toThrow(CommandInputRejected);
    expect(() => checkCommandParams('DEGRADED_MODE', { mode: 'STATE_DEGRADED', scope: 'EVENT', eventIds: [] }, NOW)).toThrow(CommandInputRejected);
    expect(() =>
      checkCommandParams('DEGRADED_MODE', { mode: 'STATE_DEGRADED', scope: 'EVENT', eventIds: [randomUUID(), randomUUID().toUpperCase()] }, NOW),
    ).toThrow(CommandInputRejected);
    expect(() => checkCommandParams('DEGRADED_MODE', { mode: 'STATE_DEGRADED', scope: 'PLATFORM', eventIds: [randomUUID()] }, NOW)).toThrow(CommandInputRejected);
    const one = randomUUID();
    expect(checkCommandParams('DEGRADED_MODE', { mode: 'STATE_DEGRADED', scope: 'EVENT', eventIds: [one] }, NOW)).toEqual({
      mode: 'STATE_DEGRADED',
      scope: 'EVENT',
      eventIds: [one],
    });
  });

  test('F026-ENTRY ③ STATE_MIRROR_FIXED·SOLD_OUT_STATIC은 mode만 받고 모르는 칸은 422다', () => {
    expect(() => checkCommandParams('DEGRADED_MODE', { mode: 'STATE_MIRROR_FIXED', on: true }, NOW)).toThrow(CommandInputRejected);
    expect(() => checkCommandParams('DEGRADED_MODE', { mode: 'SOLD_OUT_STATIC', scope: 'PLATFORM' }, NOW)).toThrow(CommandInputRejected);
    expect(checkCommandParams('DEGRADED_MODE', { mode: 'STATE_MIRROR_FIXED' }, NOW)).toEqual({ mode: 'STATE_MIRROR_FIXED' });
    expect(checkCommandParams('DEGRADED_MODE', { mode: 'SOLD_OUT_STATIC' }, NOW)).toEqual({ mode: 'SOLD_OUT_STATIC' });
  });

  test('F026-ENTRY ④ 네 모드 모두 요청은 commander, 승인은 2인·재인증이다', () => {
    for (const params of [
      { mode: 'ENTRY_DEGRADED', expiresAt: new Date(NOW + HOUR).toISOString() },
      { mode: 'STATE_DEGRADED', scope: 'PLATFORM' },
      { mode: 'STATE_MIRROR_FIXED' },
      { mode: 'SOLD_OUT_STATIC' },
    ]) {
      expect(approvalModeOf('DEGRADED_MODE', params)).toBe('TWO');
      expect(reauthRequiredFor('DEGRADED_MODE', params)).toBe(true);
    }
  });
});

describe('F026-STATE 명령 6 상태 조회 Degraded의 제어 계약', () => {
  test('F026-STATE ② STATE_DEGRADED의 제어는 queue-svc에 가고 APPLY는 stateDegraded=true, REVERT는 false다', () => {
    const c = degraded({ mode: 'STATE_DEGRADED', scope: 'PLATFORM' });
    expect(controlKindOf(c.type, c.params)).toBe('CONTROL_KIND_STATE_DEGRADED');
    expect(controlScopesOf(c)).toEqual(['PLATFORM']);
    expect(controlDeliveriesOf(c, 'APPLY', { sentAtMs: NOW })).toEqual([
      { service: 'queue-svc', scope: 'PLATFORM', kind: 'CONTROL_KIND_STATE_DEGRADED', desiredStateJson: '{"stateDegraded":true}' },
    ]);
    expect(controlDeliveriesOf(c, 'REVERT', { sentAtMs: NOW })).toEqual([
      { service: 'queue-svc', scope: 'PLATFORM', kind: 'CONTROL_KIND_STATE_DEGRADED', desiredStateJson: '{"stateDegraded":false}' },
    ]);
  });

  test('F026-STATE ③ STATE_DEGRADED의 회차 범위는 소문자 회차마다 한 번씩 간다', () => {
    const a = randomUUID();
    const b = randomUUID();
    const c = degraded({ mode: 'STATE_DEGRADED', scope: 'EVENT', eventIds: [b, a, a] });
    expect(controlScopesOf(c)).toEqual([a, b].sort());
    const deliveries = controlDeliveriesOf(c, 'APPLY', { sentAtMs: NOW });
    expect(deliveries.map((d) => d.scope)).toEqual([a, b].sort());
    expect(deliveries.every((d) => d.service === 'queue-svc' && d.kind === 'CONTROL_KIND_STATE_DEGRADED')).toBe(true);
    expect(deliveries.every((d) => d.desiredStateJson === '{"stateDegraded":true}')).toBe(true);
  });

  test('F026-STATE ④ ENTRY_DEGRADED·STATE_MIRROR_FIXED·SOLD_OUT_STATIC은 제어 gRPC로 보내지 않는다', () => {
    for (const params of [
      { mode: 'ENTRY_DEGRADED', expiresAt: new Date(NOW + HOUR).toISOString() },
      { mode: 'STATE_MIRROR_FIXED' },
      { mode: 'SOLD_OUT_STATIC' },
    ]) {
      const c = degraded(params);
      expect(controlKindOf(c.type, c.params)).toBeUndefined();
      expect(controlScopesOf(c)).toEqual([]);
    }
  });
});

describe('F026-WAF 명령 4 ASN 만료 판정', () => {
  type Verdict = { expire: boolean; reason?: string; why?: string };
  type VerdictFn = (
    c: { commandId: string; cidrs: readonly string[]; asnCount: number; expiresAtMs: number },
    nowMs: number,
    sets: Partial<Record<4 | 6, ReadonlySet<string>>>,
    liveOthers: ReadonlySet<string>,
    asns?: ReadonlySet<number>,
  ) => Verdict;
  const verdictOf = blockExpiryVerdict as unknown as VerdictFn;
  const command = (asnCount: number) => ({ commandId: randomUUID(), cidrs: [], asnCount, expiresAtMs: NOW });

  test('F026-WAF ④ 만료가 지나 ASN 목록에서 빠지고 IP 집합에도 없으면 AUTO_EXPIRED다', () => {
    // 만료 전에는 아니고, 만료 정각에 ASN이 비었으면 waf-removed다
    expect(verdictOf(command(1), NOW - 1, {}, new Set(), new Set())).toEqual({ expire: false, why: 'not-expired' });
    expect(verdictOf(command(1), NOW, {}, new Set(), new Set())).toEqual({ expire: true, reason: 'waf-removed' });
  });

  test('F026-WAF ⑤ 다른 만료 전 명령 4가 같은 ASN을 막으면 AUTO_EXPIRED가 아니다', () => {
    expect(verdictOf(command(1), NOW, {}, new Set(), new Set([64512]))).toEqual({ expire: false, why: 'still-blocked' });
  });

  test('F026-WAF ⑥ ASN 항목이 없는 명령은 기존 IP 집합 판정 그대로다', () => {
    expect(verdictOf(command(0), NOW, { 4: new Set() }, new Set(), new Set())).toEqual({ expire: true, reason: 'waf-removed' });
  });
});

describe('C-T12 Degraded Mode 전이 감사 기록', () => {
  const newStore = () => {
    const audit = new MemoryAuditChain();
    const store = new MemoryCommandStore(audit);
    return { audit, store };
  };

  test('C-T12 ① 수동 명령 6의 네 모드가 감사 기록에 mode와 ON을 남긴다', async () => {
    const { audit, store } = newStore();
    const modes: Record<string, unknown>[] = [
      { mode: 'ENTRY_DEGRADED', expiresAt: new Date(NOW + HOUR).toISOString() },
      { mode: 'STATE_DEGRADED', scope: 'PLATFORM' },
      { mode: 'STATE_MIRROR_FIXED' },
      { mode: 'SOLD_OUT_STATIC' },
    ];
    for (const params of modes) {
      await store.create({
        commandId: randomUUID(),
        type: 'DEGRADED_MODE',
        reason: '동결 로컬 F-02-6 계약 시험',
        params,
        requestedBy: REQUESTER,
        requestedRole: 'commander',
        nowMs: NOW,
        approvalMode: 'ONE',
      });
    }
    const created = auditPayloads(audit, 'COMMAND_CREATED');
    expect(created).toHaveLength(4);
    for (const params of modes) {
      expect(created).toContainEqual(expect.objectContaining({ type: 'DEGRADED_MODE', mode: params.mode, transition: 'ON' }));
    }
  });

  test('C-T12 ③ ENTRY_DEGRADED 실행의 ACKED 감사 기록에도 mode와 transition이 남는다', async () => {
    const { audit, store } = newStore();
    const command = await store.create({
      commandId: randomUUID(),
      type: 'DEGRADED_MODE',
      reason: '동결 로컬 F-02-6 계약 시험',
      params: { mode: 'ENTRY_DEGRADED', expiresAt: new Date(NOW + HOUR).toISOString() },
      requestedBy: REQUESTER,
      requestedRole: 'commander',
      nowMs: NOW,
      approvalMode: 'ONE',
    });
    const execution = new ExecuteCommand(store, { execute: async () => ({ status: 'ACKED', ackedAtMs: NOW }) });
    const finished: Command = await execution.run(command, { accountId: REQUESTER, sessionId: '', role: 'commander' }, NOW);
    expect(finished.state).toBe('ACKED');
    const acked = auditPayloads(audit, 'COMMAND_ACKED');
    expect(acked).toContainEqual(expect.objectContaining({ mode: 'ENTRY_DEGRADED', transition: 'ON' }));
  });

  test('C-T12 ② AUTO_ACTION의 DEGRADED_MODE 진입 Degraded도 SYSTEM 행위자로 감사 기록과 DISPATCHED를 남긴다', async () => {
    const { audit, store } = newStore();
    const body = CommandEventBody.parse({
      eventKey: 'f026:auto:entry-degraded:1',
      kind: 'AUTO_ACTION',
      type: 'DEGRADED_MODE',
      params: { mode: 'ENTRY_DEGRADED', expiresAt: new Date(NOW + HOUR).toISOString() },
      reason: '진입 지연 자동 전환(시험)',
    });
    const handler = new HandleCommandEvent({ createCommand: new CreateCommand(store), store });
    const result = await handler.run(body, NOW);
    expect(result.accepted).toBe(true);
    const auto = auditPayloads(audit, 'COMMAND_AUTO_ACTION');
    expect(auto).toContainEqual(expect.objectContaining({ type: 'DEGRADED_MODE', mode: 'ENTRY_DEGRADED', transition: 'ON' }));
    const commandId = result.commandId!;
    expect(store.eventsOf(commandId).map((e) => e.type)).toEqual(['DISPATCHED']);
    expect(store.eventsOf(commandId)[0]!.actorRole).toBe('system');
  });
});
