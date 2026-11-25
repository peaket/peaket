// 설정 사건의 판(원장)과 한 트랜잭션(F-02-5 OPS-300, ADR-0365 결정 1·13, 계획 6절 B7·B8, ASVS v5.0.0-2.3.3).
// 정본 값:
// - 판은 원장이 (범위, 'SETTING:<종류>:<대상>')마다 max(마지막 판 + 1, 지금 밀리초)로 매긴다. 같은 밀리초 두 명령은 다른 판이고 뒤 것이 크다.
//   명령 12도 같은 원장(종류 'SETTING:PG_ASSIGNMENT:', 범위 = 회차)이다(ADR-0365 결정 13)
// - 명령 8의 expiresAt은 '판 + 30분'이다(시계가 되돌아가 판이 지금보다 크면 판 기준)
// - 상태 쓰기(ACKED·REVERTED·AUTO_EXPIRED)·명령 사건·감사·적용 확인 행·Outbox 행은 한 트랜잭션이고, 하나라도 실패하면 모두 되돌아가며
//   명령은 FAILED(사유 settings-outbox-not-wired 또는 오류 이름)다(ADR-0365 결정 13, ASVS 2.3.3)
// 시험 값: 두 자리 넘김(9 → 10)은 밀리초 판이 자리 수를 넘는 9,999,999,999,999 → 10,000,000,000,000으로 잰다(글로 견주는 결함을 잡는다).
// 실패 주입: 저장소 쓰기 손(CommandWriter)의 설정 사건·적용 확인 행 쓰기만 던지게 감싼 메모리 저장소(진짜 MemoryCommandStore의 트랜잭션 규칙을 그대로 쓴다).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { controlEventCodec, createService, fakeClock, type FakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import {
  COMMAND_STORE,
  ComputeDryRun,
  CreateCommand,
  DecideCommand,
  ExecuteCommand,
  MaintainCommands,
  MemoryCommandStore,
  RevertCommand,
  pgAssignmentVerdictOf,
  type CommandExecutionActor,
  type CommandWriter,
  type MemoryOutboxSetting,
  type OnsaleStartSource,
  type PgAssignmentCheck,
  type PgAssignmentVerdict,
} from '../src/modules/commands/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-23T05:00:00.000Z');
const MIN = 60_000;
/** 명령 8 자동 복귀(정본 30분) */
const LOG_LEVEL_TTL = 30 * MIN;
/** 자리 수가 바뀌기 직전의 밀리초(13자리 → 14자리) */
const NINES = 9_999_999_999_999;

const actor = (role = 'operator'): CommandExecutionActor => ({ accountId: randomUUID(), sessionId: randomUUID(), role });
const payloadOf = (s: MemoryOutboxSetting) => controlEventCodec.setting(Buffer.from(s.message.payload));

const fixture = (store: MemoryCommandStore = new MemoryCommandStore(new MemoryAuditChain())) => {
  const execute = new ExecuteCommand(store);
  return { store, create: new CreateCommand(store, execute), revert: new RevertCommand(store), maintain: new MaintainCommands(store, new ComputeDryRun()) };
};
const logLevel = (f: ReturnType<typeof fixture>, service: string, nowMs: number, level = 'DEBUG') =>
  f.create.execute({ type: 'LOG_LEVEL', reason: '로그 올림', params: { service, level }, requestedBy: randomUUID(), requestedRole: 'operator', nowMs, actor: actor() });
const featureOff = (f: ReturnType<typeof fixture>, nowMs: number) =>
  f.create.execute({ type: 'FEATURE_OFF', reason: '후기 끄기', params: { flag: 'reviews' }, requestedBy: randomUUID(), requestedRole: 'operator', nowMs, actor: actor() });

describe('F025-VER 설정 판 원장(ADR-0365 결정 1·13, B7)', () => {
  test('F025-VER ① 같은 밀리초에 같은 키로 낸 명령 8 둘은 다른 판이고 뒤 것이 크며, 다른 서비스 키는 따로 센다', async () => {
    const f = fixture();
    const a = await logLevel(f, 'queue-svc', NOW);
    const b = await logLevel(f, 'queue-svc', NOW, 'TRACE');
    const c = await logLevel(f, 'purchase-svc', NOW);
    expect([a.state, b.state, c.state]).toEqual(['ACKED', 'ACKED', 'ACKED']);
    const [ea, eb, ec] = f.store.outboxSettings().map(payloadOf);
    expect([ea!.commandId, eb!.commandId, ec!.commandId]).toEqual([a.commandId, b.commandId, c.commandId]);
    expect(ea!.occurredAt).toBe(NOW);
    expect(eb!.occurredAt).toBe(NOW + 1);
    // 키마다의 원장이라 다른 서비스는 그 키의 첫 판(지금)이다
    expect(ec!.occurredAt).toBe(NOW);
    expect(f.store.controlVersionOf('PLATFORM', 'SETTING:LOG_LEVEL:queue-svc')).toBe(NOW + 1);
    expect(f.store.controlVersionOf('PLATFORM', 'SETTING:LOG_LEVEL:purchase-svc')).toBe(NOW);
    // 판 + 30분(같은 밀리초 둘째는 그 판 기준)
    expect(eb!.expiresAt).toBe(NOW + 1 + LOG_LEVEL_TTL);
    expect(await f.store.latestOf(b.commandId)).toMatchObject({ stage: 'ACKED', version: NOW + 1 });
  });

  test('F025-VER ② 판이 자리 수를 넘어도(9,999,999,999,999 → 10,000,000,000,000) 뒤 판이 크다', async () => {
    const f = fixture();
    const a = await featureOff(f, NINES);
    const b = await featureOff(f, NINES);
    const [ea, eb] = f.store.outboxSettings().map(payloadOf);
    expect(ea!.occurredAt).toBe(NINES);
    expect(eb!.occurredAt).toBe(10_000_000_000_000);
    expect(eb!.occurredAt).toBeGreaterThan(ea!.occurredAt);
    expect(f.store.controlVersionOf('PLATFORM', 'SETTING:FEATURE_FLAG:reviews')).toBe(10_000_000_000_000);
    expect((await f.store.latestOf(a.commandId))?.version).toBe(NINES);
    expect((await f.store.latestOf(b.commandId))?.version).toBe(10_000_000_000_000);
  });

  test('F025-VER ③ 시계가 되돌아가도 판은 늘고, 명령 8의 expiresAt은 그 판 + 30분이다', async () => {
    const f = fixture();
    await logLevel(f, 'identity-svc', NOW + 5_000);
    const back = await logLevel(f, 'identity-svc', NOW);
    const e = payloadOf(f.store.outboxSettings()[1]!);
    expect(e.commandId).toBe(back.commandId);
    expect(e.occurredAt).toBe(NOW + 5_001);
    expect(e.expiresAt).toBe(NOW + 5_001 + LOG_LEVEL_TTL);
  });

  test('F025-VER ④ 같은 밀리초의 실행과 되돌리기(명령 9)는 되돌리기 판이 더 커서 받는 쪽이 버리지 않는다', async () => {
    const f = fixture();
    const c = await featureOff(f, NOW);
    const r = await f.revert.execute({ commandId: c.commandId, reason: '바로 되돌림', actor: actor(), nowMs: NOW });
    expect(r.command.state).toBe('REVERTED');
    const [apply, revert] = f.store.outboxSettings().map(payloadOf);
    expect(apply).toMatchObject({ value: { enabled: false }, occurredAt: NOW });
    expect(revert).toMatchObject({ value: { enabled: true }, occurredAt: NOW + 1 });
    expect(await f.store.latestOf(c.commandId)).toMatchObject({ stage: 'REVERTED', version: NOW + 1 });
  });

  test('F025-VER ⑤ 명령 5의 원장 종류는 SETTING:BOT_LEVEL:이다(되돌리기가 실행 판보다 크다)', async () => {
    const f = fixture();
    const requester = actor('commander');
    const approver = actor('commander');
    const created = await f.create.execute({ type: 'BOT_LEVEL', reason: '봇', params: { level: 'AGGRESSIVE' }, requestedBy: requester.accountId, requestedRole: 'commander', nowMs: NOW, actor: requester });
    const acked = await new DecideCommand(f.store, new ExecuteCommand(f.store)).approve({ commandId: created.commandId, approverRef: approver.accountId, approverRole: 'commander', nowMs: NOW, actor: approver });
    expect(acked.state).toBe('ACKED');
    await f.revert.execute({ commandId: created.commandId, reason: '되돌림', actor: approver, nowMs: NOW });
    expect(f.store.outboxSettings().map((s) => payloadOf(s).occurredAt)).toEqual([NOW, NOW + 1]);
    expect(f.store.controlVersionOf('PLATFORM', 'SETTING:BOT_LEVEL:')).toBe(NOW + 1);
  });
});

/** 판매 시작 원천 짝 가짜(판매 승인 전 = 창 밖) */
class NoOnsale implements OnsaleStartSource {
  async saleStartMs(): Promise<number | undefined> {
    return undefined;
  }
}
/** 하위 결제사 판정 짝 가짜: payment.proto 꼴의 허용 답을 제품 해독 함수로 읽는다 */
class AllowPg implements PgAssignmentCheck {
  async check(): Promise<PgAssignmentVerdict> {
    return pgAssignmentVerdictOf({ allowed: true, current_primary_pg: 'PG_PROVIDER_TOSS', approval_limits: [] });
  }
}

describe('F025-VER 명령 12도 원장 판(ADR-0365 결정 13, B7)', () => {
  const opened: { svc: Awaited<ReturnType<typeof createService>> }[] = [];
  afterEach(async () => {
    for (const o of opened.splice(0)) await o.svc.close();
  });

  test('F025-VER ⑥ 같은 밀리초에 같은 회차로 낸 명령 12 둘의 occurredAt은 원장 판(종류 SETTING:PG_ASSIGNMENT:, 범위 = 회차)이라 다르고, 다른 회차는 따로 센다', async () => {
    const clock: FakeClock = fakeClock({ now: NOW + 1_234 });
    const identity = new FakeIdentity();
    const svc = await createService({
      name: 'ops-svc',
      module: AppModule.register({ memory: true, auditChain: new MemoryAuditChain(), commandExtras: { pgAssignment: { onsale: new NoOnsale(), pgCheck: new AllowPg() } } }),
      env: { PEAKET_ENV: 'ci' },
      clock,
      logDestination: quiet(),
      adminAuthz: identity,
    });
    opened.push({ svc });
    const found: unknown = svc.app.get(COMMAND_STORE);
    if (!(found instanceof MemoryCommandStore)) throw new Error('메모리 조립의 명령 저장소가 아니다');
    const op = identity.ops('operator');
    const post = (params: Record<string, unknown>) =>
      svc.http.inject({ method: 'POST', url: '/v1/ops/commands', headers: { 'idempotency-key': randomUUID(), ...op, 'content-type': 'application/json' }, payload: JSON.stringify({ type: 'PG_ASSIGN', reason: '결제사 지정', params }) });
    const eventId = randomUUID();
    const other = randomUUID();
    for (const params of [{ eventId, primaryPg: 'TOSS' }, { eventId, primaryPg: 'PORTONE' }, { eventId: other, primaryPg: 'TOSS' }]) {
      const r = await post(params);
      expect([r.statusCode, (JSON.parse(r.payload) as { state: string }).state], r.payload).toEqual([201, 'ACKED']);
    }
    const events = found.outboxSettings().map(payloadOf);
    expect(events.map((e) => [e.scope, e.occurredAt])).toEqual([
      [eventId, NOW + 1_234],
      [eventId, NOW + 1_235],
      [other, NOW + 1_234],
    ]);
    expect(found.controlVersionOf(eventId, 'SETTING:PG_ASSIGNMENT:')).toBe(NOW + 1_235);
    expect(found.controlVersionOf(other, 'SETTING:PG_ASSIGNMENT:')).toBe(NOW + 1_234);
    // 명령 12도 적용 확인 행을 둔다(받는 서비스 payment-svc, ADR-0365 결정 10)
    const second = events[1]!.commandId;
    expect(await found.latestOf(second)).toMatchObject({ stage: 'ACKED', version: NOW + 1_235, messageKey: `${eventId}:PG_ASSIGNMENT:`, service: 'payment-svc' });
  });
});

/** 던질 쓰기: 설정 사건(setting), 적용 확인 행(applyCheck), 또는 설정 사건 쓰기가 없는 저장소(unwired) */
type Fault = 'setting' | 'applyCheck' | 'unwired';

/** 이름과 글이 같은 오류(사유가 오류 이름이든 글이든 같은 값이 되게) */
const outboxDown = (): Error => {
  const e = new Error('outbox-write-failed');
  e.name = 'outbox-write-failed';
  return e;
};

/**
 * 진짜 메모리 저장소의 트랜잭션(쓰기 손이 끝까지 성공해야 반영)을 그대로 쓰고, 쓰기 손의 한 자리만 던지게(또는 없게) 감싼다.
 * 상태·사건·감사·원장·Outbox를 되돌리는 규칙은 진짜 저장소의 것이다(업무 로직을 가짜로 바꾸지 않는다)
 */
class FaultyCommandStore extends MemoryCommandStore {
  fault: Fault | undefined;
  override async mutate<T>(commandId: string, fn: (w: CommandWriter) => Promise<T>): Promise<T | undefined> {
    const fault = this.fault;
    if (!fault) return super.mutate(commandId, fn);
    return super.mutate(commandId, (w) =>
      fn(
        new Proxy<CommandWriter>(w, {
          get(target, key) {
            if (key === (fault === 'unwired' ? 'setting' : fault)) {
              if (fault === 'unwired') return undefined;
              return async () => {
                throw outboxDown();
              };
            }
            return Reflect.get(target, key);
          },
        }),
      ),
    );
  }
}

const faulty = () => {
  const audit = new MemoryAuditChain();
  const store = new FaultyCommandStore(audit);
  return { audit, ...fixture(store), store };
};
const auditsOf = (audit: MemoryAuditChain, id: string) => audit.entries.filter((e) => e.recordId === id).map((e) => e.recordType);

describe('[ASVS v5.0.0-2.3.3] 설정 사건·적용 확인 행·상태·감사는 한 트랜잭션(ADR-0365 결정 13, B8)', () => {
  test('[ASVS v5.0.0-2.3.3] ① 실행: 설정 사건을 쓰지 못하면 ACKED·COMMAND_ACKED·적용 확인 행·Outbox가 모두 없고 명령은 FAILED(오류 이름)다', async () => {
    const f = faulty();
    f.store.fault = 'setting';
    const c = await logLevel(f, 'queue-svc', NOW);
    expect(c.state).toBe('FAILED');
    expect(c.lastError).toBe('outbox-write-failed');
    expect(c.expiresAtMs).toBeUndefined();
    expect(f.store.outboxSettings()).toEqual([]);
    expect(await f.store.latestOf(c.commandId)).toBeUndefined();
    expect(auditsOf(f.audit, c.commandId)).not.toContain('COMMAND_ACKED');
    expect(f.store.eventsOf(c.commandId).map((e) => e.type)).not.toContain('ACKED');
    // 되돌아간 판은 원장에도 남지 않는다
    expect(f.store.controlVersionOf('PLATFORM', 'SETTING:LOG_LEVEL:queue-svc')).toBeUndefined();
  });

  test('[ASVS v5.0.0-2.3.3] ② 실행: 적용 확인 행을 쓰지 못해도 사건·ACKED·감사가 함께 없고 FAILED다', async () => {
    const f = faulty();
    f.store.fault = 'applyCheck';
    const c = await featureOff(f, NOW);
    expect(c.state).toBe('FAILED');
    expect(c.lastError).toBe('outbox-write-failed');
    expect(f.store.outboxSettings()).toEqual([]);
    expect(await f.store.latestOf(c.commandId)).toBeUndefined();
    expect(auditsOf(f.audit, c.commandId)).not.toContain('COMMAND_ACKED');
  });

  test('[ASVS v5.0.0-2.3.3] ③ 실행: 설정 사건 쓰기가 없는 저장소는 FAILED(settings-outbox-not-wired)이고 아무것도 남지 않는다', async () => {
    const f = faulty();
    f.store.fault = 'unwired';
    const c = await logLevel(f, 'ticket-svc', NOW);
    expect(c).toMatchObject({ state: 'FAILED', lastError: 'settings-outbox-not-wired' });
    expect(f.store.outboxSettings()).toEqual([]);
    expect(await f.store.latestOf(c.commandId)).toBeUndefined();
    expect(auditsOf(f.audit, c.commandId)).not.toContain('COMMAND_ACKED');
  });

  test('[ASVS v5.0.0-2.3.3] ④ 되돌리기: 설정 사건을 쓰지 못하면 REVERTED·COMMAND_REVERTED·새 사건·새 적용 확인 행이 없고 ACKED 그대로다(502 command-dispatch-failed)', async () => {
    const f = faulty();
    const c = await featureOff(f, NOW);
    expect(c.state).toBe('ACKED');
    f.store.fault = 'setting';
    await expect(f.revert.execute({ commandId: c.commandId, reason: '되돌림', actor: actor(), nowMs: NOW + MIN })).rejects.toMatchObject({ status: 502 });
    expect((await f.store.find(c.commandId))?.state).toBe('ACKED');
    expect(f.store.outboxSettings()).toHaveLength(1);
    expect(auditsOf(f.audit, c.commandId)).not.toContain('COMMAND_REVERTED');
    expect(await f.store.latestOf(c.commandId)).toMatchObject({ stage: 'ACKED' });
    // 고치면 같은 되돌리기가 그대로 된다
    f.store.fault = undefined;
    const ok = await f.revert.execute({ commandId: c.commandId, reason: '되돌림', actor: actor(), nowMs: NOW + 2 * MIN });
    expect(ok.command.state).toBe('REVERTED');
    expect(payloadOf(f.store.outboxSettings()[1]!)).toMatchObject({ value: { enabled: true } });
  });

  test('[ASVS v5.0.0-2.3.3] ⑤ 만료: 설정 사건을 쓰지 못하면 AUTO_EXPIRED·COMMAND_AUTO_EXPIRED·INFO 사건·새 적용 확인 행이 없고, 고친 다음 바퀴에 한 번 만료된다', async () => {
    const f = faulty();
    const c = await logLevel(f, 'core-svc', NOW);
    expect(c.state).toBe('ACKED');
    f.store.fault = 'setting';
    // 정비 바퀴가 이 명령에서 실패하든(던짐) 건너뛰든, 상태 쓰기는 남지 않아야 한다
    await f.maintain.runOnce(NOW + LOG_LEVEL_TTL).then(
      () => undefined,
      () => undefined,
    );
    expect((await f.store.find(c.commandId))?.state).toBe('ACKED');
    expect(f.store.outboxSettings()).toHaveLength(1);
    expect(auditsOf(f.audit, c.commandId)).not.toContain('COMMAND_AUTO_EXPIRED');
    expect(await f.store.latestOf(c.commandId)).toMatchObject({ stage: 'ACKED' });
    f.store.fault = undefined;
    expect(await f.maintain.runOnce(NOW + LOG_LEVEL_TTL + 5_000)).toMatchObject({ autoExpired: 1 });
    expect((await f.store.find(c.commandId))?.state).toBe('AUTO_EXPIRED');
    expect(f.store.outboxSettings().map((s) => payloadOf(s).value)).toEqual([{ level: 'DEBUG' }, { level: 'INFO' }]);
    expect(auditsOf(f.audit, c.commandId).filter((t) => t === 'COMMAND_AUTO_EXPIRED')).toHaveLength(1);
  });
});
