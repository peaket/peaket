// F-02-6(동결 로컬) 명령 6 진입·상태 조회 Degraded, 명령 4 ASN 만료, C-T12 감사의 계약 시험.
// 구현 전 트리에서 의미 있게 실패하는 것만 둔다(모듈이 없어 실행 전 실패하는 포트 시험은 f026-edge-ports.test.ts).
// 정본: docs/features/control-tower.md §3 명령 4·6, §5 '제어 상태'·'CDN 설정 API', §14 C-T12·C-T44 ⑥,
// docs/features/queue-admission.md §4·§9, ADR-0223 결정 1·8, ADR-0234 결정 5, ADR-0339, ADR-0340 결정 5·6, ADR-0349 결정 9·10, ADR-0365 결정 2·6.
// 수치 주장 없음: 이 파일은 처리량·인원·K1/K2/K7 수치를 새로 주장하지 않는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import {
  AUTO_EXPIRE_TYPES,
  checkCommandParams,
  CommandEventBody,
  CommandInputRejected,
  controlDeliveriesOf,
  controlKindOf,
  controlScopesOf,
  CreateCommand,
  ExecuteCommand,
  expiryAfterAckMs,
  HandleCommandEvent,
  MemoryCommandStore,
  RevertCommand,
  approvalModeOf,
  blockExpiryVerdict,
  reauthRequiredFor,
  type Command,
} from '../src/modules/commands/index.js';
import * as commandsModule from '../src/modules/commands/index.js';

const NOW = Date.parse('2026-11-28T00:00:00.000Z');
const HOUR = 60 * 60_000;
const REQUESTER = '0193a000-0000-7000-8000-0000000000f1';
const APPROVER = '0193a000-0000-7000-8000-0000000000f2';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const readDoc = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** 명령 6의 params를 그대로 넘기는 작은 도우미(리터럴 타입이 string으로 넓어지지 않게) */
const degraded = (params: Record<string, unknown>) => ({ type: 'DEGRADED_MODE' as const, params });

/** command-writes가 감사 payload에 싣는 값을 꺼낸다 */
const auditPayloads = (audit: MemoryAuditChain, recordType: string): Record<string, unknown>[] =>
  audit.entries.filter((e) => e.recordType === recordType).map((e) => e.record.payload);

/** 검사 거절의 종류(INVALID·OUT_OF_RANGE)와 걸린 한계를 단언하려고 꺼낸다 */
const rejectionOf = (fn: () => unknown): CommandInputRejected => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CommandInputRejected) return e;
    throw e;
  }
  throw new Error('CommandInputRejected를 던지지 않았다');
};

/** 구현 전에는 없는 공개 함수를 이름으로 꺼낸다(모듈은 있고 함수만 없다: 시험 파일은 로드된다) */
type DegradedScopeOf = (type: 'DEGRADED_MODE', params: Record<string, unknown>) => string;
const degradedScopeOfOf = (): DegradedScopeOf | undefined =>
  (commandsModule as unknown as { degradedScopeOf?: DegradedScopeOf }).degradedScopeOf;

describe('F026-ENTRY 명령 6 진입 Degraded의 매개변수 계약', () => {
  test('F026-ENTRY ① ENTRY_DEGRADED는 expiresAt이 필수이고 24시간을 넘으면 422 command-out-of-range다', () => {
    // expiresAt 없음, 모르는 칸, 24시간 + 1ms, 24시간 정각
    expect(rejectionOf(() => checkCommandParams('DEGRADED_MODE', { mode: 'ENTRY_DEGRADED' }, NOW))).toMatchObject({
      kind: 'OUT_OF_RANGE',
      limit: 'degradedExpiresAt',
    });
    expect(
      rejectionOf(() => checkCommandParams('DEGRADED_MODE', { mode: 'ENTRY_DEGRADED', expiresAt: new Date(NOW + HOUR).toISOString(), on: true }, NOW)),
    ).toMatchObject({ kind: 'INVALID', limit: 'unknown-field:on' });
    expect(
      rejectionOf(() =>
        checkCommandParams('DEGRADED_MODE', { mode: 'ENTRY_DEGRADED', expiresAt: new Date(NOW + 24 * HOUR + 1).toISOString() }, NOW),
      ),
    ).toMatchObject({ kind: 'OUT_OF_RANGE', limit: 'degradedExpiresAt' });
    // 24시간 정각은 받는다(정각 포함 경계). 값은 그대로 돌려준다
    const atLimit = new Date(NOW + 24 * HOUR).toISOString();
    expect(checkCommandParams('DEGRADED_MODE', { mode: 'ENTRY_DEGRADED', expiresAt: atLimit }, NOW)).toEqual({ mode: 'ENTRY_DEGRADED', expiresAt: atLimit });
  });

  test('F026-ENTRY ② STATE_DEGRADED는 EVENT면 소문자 회차 1~100개, PLATFORM이면 회차를 받지 않는다', () => {
    const ids = Array.from({ length: 101 }, () => randomUUID());
    expect(rejectionOf(() => checkCommandParams('DEGRADED_MODE', { mode: 'STATE_DEGRADED', scope: 'EVENT', eventIds: ids }, NOW))).toMatchObject({
      kind: 'OUT_OF_RANGE',
      limit: 'stateDegradedMaxEvents',
    });
    expect(rejectionOf(() => checkCommandParams('DEGRADED_MODE', { mode: 'STATE_DEGRADED', scope: 'EVENT', eventIds: [] }, NOW))).toMatchObject({
      kind: 'INVALID',
      limit: 'eventIds',
    });
    expect(
      rejectionOf(() =>
        checkCommandParams('DEGRADED_MODE', { mode: 'STATE_DEGRADED', scope: 'EVENT', eventIds: [randomUUID(), randomUUID().toUpperCase()] }, NOW),
      ),
    ).toMatchObject({ kind: 'INVALID', limit: 'eventIds' });
    expect(
      rejectionOf(() => checkCommandParams('DEGRADED_MODE', { mode: 'STATE_DEGRADED', scope: 'PLATFORM', eventIds: [randomUUID()] }, NOW)),
    ).toMatchObject({ kind: 'INVALID', limit: 'eventIds' });
    // 같은 소문자 회차를 두 번은 거절한다
    const one = randomUUID();
    expect(rejectionOf(() => checkCommandParams('DEGRADED_MODE', { mode: 'STATE_DEGRADED', scope: 'EVENT', eventIds: [one, one] }, NOW))).toMatchObject({
      kind: 'INVALID',
      limit: 'eventIds-duplicate',
    });
    // 100개 정각은 받고, 101개는 위에서 거절했다
    const hundred = Array.from({ length: 100 }, () => randomUUID());
    expect(checkCommandParams('DEGRADED_MODE', { mode: 'STATE_DEGRADED', scope: 'EVENT', eventIds: hundred }, NOW)).toEqual({
      mode: 'STATE_DEGRADED',
      scope: 'EVENT',
      eventIds: hundred,
    });
    expect(checkCommandParams('DEGRADED_MODE', { mode: 'STATE_DEGRADED', scope: 'EVENT', eventIds: [one] }, NOW)).toEqual({
      mode: 'STATE_DEGRADED',
      scope: 'EVENT',
      eventIds: [one],
    });
  });

  test('F026-ENTRY ③ STATE_MIRROR_FIXED·SOLD_OUT_STATIC은 mode만 받고 모르는 칸은 422다', () => {
    expect(rejectionOf(() => checkCommandParams('DEGRADED_MODE', { mode: 'STATE_MIRROR_FIXED', on: true }, NOW))).toMatchObject({
      kind: 'INVALID',
      limit: 'unknown-field:on',
    });
    expect(rejectionOf(() => checkCommandParams('DEGRADED_MODE', { mode: 'SOLD_OUT_STATIC', scope: 'PLATFORM' }, NOW))).toMatchObject({
      kind: 'INVALID',
      limit: 'unknown-field:scope',
    });
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

  test('F026-ENTRY ⑥ ENTRY_DEGRADED는 명령 행 자동 만료 대상이 아니고 CDN 모드도 만료되지 않는다', () => {
    // ENTRY는 엣지 키의 expireAtMs가 끝내고, 명령 행은 ACKED로 남아 되돌리기로 끈다.
    // AUTO_EXPIRE_TYPES에 DEGRADED_MODE를 넣으면 STATE_MIRROR_FIXED·SOLD_OUT_STATIC까지 만료돼 B10·B11이 깨진다.
    expect(AUTO_EXPIRE_TYPES).not.toContain('DEGRADED_MODE');
    expect(expiryAfterAckMs('DEGRADED_MODE')).toBeUndefined();
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
    // 회차 범위 되돌리기도 회차마다 false를 보낸다
    const reverted = controlDeliveriesOf(c, 'REVERT', { sentAtMs: NOW });
    expect(reverted.map((d) => d.scope)).toEqual([a, b].sort());
    expect(reverted.every((d) => d.desiredStateJson === '{"stateDegraded":false}')).toBe(true);
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
  /** own: 이 명령의 ASN 가운데 WAF 목록에 남은 것, live: 만료 전 다른 ACKED 명령 4의 ASN */
  type AsnSets = { own: ReadonlySet<number>; live: ReadonlySet<number> };
  type VerdictFn = (
    c: { commandId: string; cidrs: readonly string[]; asnCount: number; asns?: readonly number[]; expiresAtMs: number },
    nowMs: number,
    sets: Partial<Record<4 | 6, ReadonlySet<string>>>,
    liveCidrs: ReadonlySet<string>,
    asns?: AsnSets,
  ) => Verdict;
  const verdictOf = blockExpiryVerdict as unknown as VerdictFn;
  const command = (asns: readonly number[]) => ({ commandId: randomUUID(), cidrs: [], asnCount: asns.length, asns, expiresAtMs: NOW });

  test('F026-WAF ④ 만료가 지나 ASN 목록에서 빠지고 IP 집합에도 없으면 AUTO_EXPIRED다', () => {
    // 만료 전에는 아니고, 만료 정각에 이 명령의 ASN이 WAF에서 빠졌으면 waf-removed다
    expect(verdictOf(command([64512]), NOW - 1, {}, new Set(), { own: new Set([64512]), live: new Set() })).toEqual({ expire: false, why: 'not-expired' });
    expect(verdictOf(command([64512]), NOW, {}, new Set(), { own: new Set(), live: new Set() })).toEqual({ expire: true, reason: 'waf-removed' });
  });

  test('F026-WAF ⑤ 다른 만료 전 명령 4가 같은 ASN을 덮어도 만료 명령은 superseded로 AUTO_EXPIRED다', () => {
    // WAF 목록에는 ASN이 남아 있지만 그 소유가 다른 살아 있는 명령이다: CIDR의 superseded와 같은 규칙
    expect(verdictOf(command([64512]), NOW, {}, new Set(), { own: new Set([64512]), live: new Set([64512]) })).toEqual({ expire: true, reason: 'superseded' });
  });

  test('F026-WAF ⑥ 이 명령의 ASN이 WAF에 남고 다른 명령이 덮지 않으면 still-blocked다', () => {
    expect(verdictOf(command([64512]), NOW, {}, new Set(), { own: new Set([64512]), live: new Set() })).toEqual({ expire: false, why: 'still-blocked' });
  });

  test('F026-WAF ⑦ ASN 항목이 없는 명령은 기존 IP 집합 판정 그대로다', () => {
    expect(verdictOf(command([]), NOW, { 4: new Set() }, new Set(), { own: new Set(), live: new Set() })).toEqual({ expire: true, reason: 'waf-removed' });
  });
});

describe('C-T12 Degraded Mode 전이 감사 기록', () => {
  const newStore = () => {
    const audit = new MemoryAuditChain();
    const store = new MemoryCommandStore(audit);
    return { audit, store };
  };
  const executor = () => ({
    execute: async () => ({ status: 'ACKED' as const, ackedAtMs: NOW + 2 }),
    revert: async () => ({ status: 'ACKED' as const, ackedAtMs: NOW + 3 }),
  });
  /** 실제 2인 경로: commander가 접수하면 PENDING_APPROVAL, 다른 operator가 승인한 뒤 실행한다 */
  const pending = async (store: MemoryCommandStore, params: Record<string, unknown>): Promise<Command> => {
    const command = await new CreateCommand(store).execute({
      type: 'DEGRADED_MODE',
      reason: '동결 로컬 F-02-6 계약 시험',
      params,
      requestedBy: REQUESTER,
      requestedRole: 'commander',
      nowMs: NOW,
    });
    expect(command.state).toBe('PENDING_APPROVAL');
    return command;
  };
  const approve = async (store: MemoryCommandStore, commandId: string): Promise<Command> => {
    const decision = await store.approve(commandId, APPROVER, 'operator', NOW + 1);
    expect(decision.status).toBe('APPLIED');
    return (decision as { command: Command }).command;
  };

  test('C-T12 ① 수동 명령 6의 네 모드가 2인 접수 감사 기록에 mode·degradedScopeOf·ON을 남긴다', async () => {
    const { audit, store } = newStore();
    const degradedScopeOf = degradedScopeOfOf();
    expect(typeof degradedScopeOf, 'degradedScopeOf가 공개 면에 없다').toBe('function');
    const eventId = randomUUID();
    const modes = [
      { params: { mode: 'ENTRY_DEGRADED', expiresAt: new Date(NOW + HOUR).toISOString() }, scope: 'PLATFORM' },
      { params: { mode: 'STATE_DEGRADED', scope: 'EVENT', eventIds: [eventId] }, scope: eventId },
      { params: { mode: 'STATE_MIRROR_FIXED' }, scope: 'PLATFORM' },
      { params: { mode: 'SOLD_OUT_STATIC' }, scope: 'PLATFORM' },
    ];
    for (const m of modes) await pending(store, m.params);
    const created = auditPayloads(audit, 'COMMAND_CREATED');
    expect(created).toHaveLength(4);
    for (const m of modes) {
      // 기대 scope를 하드코딩하지 않고 공개 함수가 낸 값으로 감사 기록을 단언한다.
      const scope = degradedScopeOf!('DEGRADED_MODE', m.params);
      expect(scope).toBe(m.scope);
      expect(created).toContainEqual(
        expect.objectContaining({ type: 'DEGRADED_MODE', state: 'PENDING_APPROVAL', mode: m.params.mode, transition: 'ON', scope }),
      );
    }
  });

  test('C-T12 ② AUTO_ACTION의 DEGRADED_MODE 진입 Degraded도 SYSTEM 행위자로 감사 기록과 DISPATCHED를 남기고 같은 eventKey는 한 번만 만든다', async () => {
    const { audit, store } = newStore();
    const body = CommandEventBody.parse({
      eventKey: 'f026:auto:entry-degraded:1',
      kind: 'AUTO_ACTION',
      type: 'DEGRADED_MODE',
      params: { mode: 'ENTRY_DEGRADED', expiresAt: new Date(NOW + HOUR).toISOString() },
      reason: '진입 지연 자동 전환(시험)',
    });
    const handler = new HandleCommandEvent({ createCommand: new CreateCommand(store), store });
    const first = await handler.run(body, NOW);
    const second = await handler.run(body, NOW + 1);
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(second.commandId).toBe(first.commandId);
    const auto = auditPayloads(audit, 'COMMAND_AUTO_ACTION');
    expect(auto).toHaveLength(1);
    expect(auto[0]).toMatchObject({ type: 'DEGRADED_MODE', mode: 'ENTRY_DEGRADED', transition: 'ON', scope: 'PLATFORM' });
    const commandId = first.commandId!;
    const dispatched = store.eventsOf(commandId).find((e) => e.type === 'DISPATCHED');
    expect(dispatched?.actorRole).toBe('system');
    expect(dispatched?.detail).toMatchObject({ mode: 'ENTRY_DEGRADED', transition: 'ON', scope: 'PLATFORM' });
    // 틀린 params는 계약 단계에서 거절한다
    expect(() =>
      CommandEventBody.parse({
        eventKey: 'f026:auto:entry-degraded:bad',
        kind: 'AUTO_ACTION',
        type: 'DEGRADED_MODE',
        params: { mode: 'ENTRY_DEGRADED' },
        reason: 'expiresAt 없음',
      }),
    ).toThrow();
  });

  test('C-T12 ③ 수동 ENTRY_DEGRADED의 승인·실행·되돌리기 감사 기록에 mode·transition·scope가 남는다', async () => {
    const { audit, store } = newStore();
    const degradedScopeOf = degradedScopeOfOf();
    expect(typeof degradedScopeOf, 'degradedScopeOf가 공개 면에 없다').toBe('function');
    const command = await pending(store, { mode: 'ENTRY_DEGRADED', expiresAt: new Date(NOW + HOUR).toISOString() });
    const scope = degradedScopeOf!('DEGRADED_MODE', command.params);
    expect(scope).toBe('PLATFORM');
    const approved = await approve(store, command.commandId);
    const runner = executor();
    const finished = await new ExecuteCommand(store, runner).run(approved, { accountId: APPROVER, sessionId: '', role: 'operator' }, NOW + 2);
    expect(finished.state).toBe('ACKED');
    const dispatched = store.eventsOf(command.commandId).find((e) => e.type === 'DISPATCHED');
    expect(dispatched?.detail).toMatchObject({ mode: 'ENTRY_DEGRADED', transition: 'ON', scope });

    const reverted = await new RevertCommand(store, runner).execute({
      commandId: command.commandId,
      reason: '진입 Degraded 해제',
      actor: { accountId: APPROVER, sessionId: '', role: 'commander' },
      nowMs: NOW + 3,
    });
    expect(reverted.pending).toBe(false);
    expect(reverted.command.state).toBe('REVERTED');

    for (const record of ['COMMAND_APPROVED', 'COMMAND_EXECUTION_STARTED', 'COMMAND_ACKED']) {
      expect(auditPayloads(audit, record)).toContainEqual(expect.objectContaining({ mode: 'ENTRY_DEGRADED', transition: 'ON', scope }));
    }
    for (const record of ['COMMAND_REVERT_STARTED', 'COMMAND_REVERTED']) {
      expect(auditPayloads(audit, record)).toContainEqual(expect.objectContaining({ mode: 'ENTRY_DEGRADED', transition: 'OFF', scope }));
    }
  });
});

describe('F026-AUTO AUTO_ACTION 계약 확장', () => {
  test('F026-AUTO ① asyncapi OpsCommandAutoAction과 ADR-0340 보충이 DEGRADED_MODE·ENTRY_DEGRADED·expiresAt을 싣는다', () => {
    const asyncapi = readDoc('docs/api/asyncapi.yaml');
    // 실제 ops.command-events 채널 블록(:112-118)의 설명만 본다. 다른 채널·설정 줄의 DEGRADED_MODE를 잡으면 거짓 통과다.
    const channelStart = asyncapi.indexOf('  ops.command-events:');
    const channelEnd = asyncapi.indexOf('  telemetry.queue:', channelStart);
    expect(channelStart).toBeGreaterThanOrEqual(0);
    const channel = asyncapi.slice(channelStart, channelEnd);
    const descriptionAt = channel.indexOf('description:');
    const descriptionEnd = channel.indexOf('\n', descriptionAt);
    expect(descriptionAt).toBeGreaterThanOrEqual(0);
    const description = channel.slice(descriptionAt, descriptionEnd);
    expect(description).toContain('DEGRADED_MODE');
    expect(description).toContain('ENTRY_DEGRADED');

    // components.messages의 실제 스키마는 마지막 OpsCommandAutoAction:부터 QueueAggregate: 전까지다.
    const componentStart = asyncapi.lastIndexOf('OpsCommandAutoAction:');
    expect(componentStart).toBeGreaterThan(channelEnd);
    const end = asyncapi.indexOf('QueueAggregate:', componentStart);
    const block = asyncapi.slice(componentStart, end);
    expect(block).toContain('DEGRADED_MODE');
    expect(block).toContain('ENTRY_DEGRADED');
    expect(block).toContain('expiresAt');

    const adr = readDoc('docs/adr/0340-ops-command-lifecycle-dry-run-expiry-revert-actor-refs.md');
    expect(adr).toContain('DEGRADED_MODE');
    expect(adr).toContain('ENTRY_DEGRADED');
  });
});
