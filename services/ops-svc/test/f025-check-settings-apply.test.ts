// 적용 확인 바퀴(CheckSettingsApply.runOnce)가 명령 8의 적용 확인 행을 정비 바퀴 간격으로 보며 상태·SEV3 경보를 바꾸는지 본다
// (F-02-5 OPS-300, docs/features/control-tower.md C-T54 ①②③의 서버 몫 단위 층, ADR-0365 결정 10·14·15, 계획 6절 B10~B13, 8.2 '응용').
// - 명령은 진짜 CreateCommand → ExecuteCommand로 낸다(명령 8은 실행기 없이 ACKED와 같은 트랜잭션에 설정 사건·적용 확인 행, 결정 13).
// - 저장소는 MemoryCommandStore(ApplyCheckStore 구현, Outbox 나감 손잡이 markOutboxSent), 경보는 진짜 RecordOpsAlert 위의 메모리 경보 저장소다.
//   경보 저장소는 OpsAlertStore를 구현한 짝 가짜로 감싸 open 부름 수를 센다(SEV3를 '한 번' 여는지).
// - Prometheus는 바깥 경계라 SettingsApplyProbe를 구현한 짝 가짜(답은 계획 8.2 ProbeResult 꼴, Prometheus 응답 해석은 f025-prometheus-probe.test.ts)다.
// - 바퀴는 정비 바퀴처럼 일정 간격으로 돌린다. 간격은 5초 상수와 다르게 2,500ms(시험 값)로 고른다. 시계는 주입 값이다.
// 정본 값: 30초는 나간 시각부터, SEV3 경보 settings-apply-unconfirmed(경보 사건 키 = 명령 ID), 경보 근원 ops-svc, Prometheus 실패는 UNKNOWN·경보 없음.
import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fakeClock } from '@peaket/platform';
import { MemoryOpsAlertStore, RecordOpsAlert, type OpsAlert, type OpsAlertStore } from '../src/modules/alerts/index.js';
import { AuditCheckpointService, MemoryAuditChain, MemoryAuditCheckpointStore } from '../src/modules/audit/index.js';
import {
  APPLY_CHECK_ROUND_MS,
  CheckSettingsApply,
  CommandMaintenanceJob,
  CreateCommand,
  ExecuteCommand,
  MaintainCommands,
  MemoryCommandStore,
  applyCheckViewOf,
  type ApplyCheckRow,
  type CommandExecutionActor,
  type ProbeResult,
  type SettingsApplyProbe,
} from '../src/modules/commands/index.js';

const SEC = 1_000;
const NOW = Date.parse('2026-11-23T06:00:00.000Z');
/** 정본 경계(결정 14) */
const WINDOW = 30 * SEC;
/** 바퀴 간격(시험 값) */
const ROUND = 2_500;
/** Outbox가 쓴 뒤 1,300ms에 나갔다(시험 값) */
const SENT = NOW + 1_300;
const ALERT_KIND = 'settings-apply-unconfirmed';
/** 정비 바퀴 간격(결정 10 '5초 [가정]'). 행의 다음 볼 시각이 이만큼 늦을 수 있어 '그다음 바퀴'의 여유로 쓴다 */
const CANON_ROUND = 5 * SEC;

const REQUESTER = '0193f100-0000-7000-8000-000000000001';
const actor: CommandExecutionActor = { accountId: REQUESTER, sessionId: '0193f100-0000-7000-8000-000000000002', role: 'operator' };

/** 경보 저장소 짝 가짜: 진짜 메모리 저장소를 그대로 부르고 open 부름만 센다 */
class CountingAlertStore implements OpsAlertStore {
  readonly inner = new MemoryOpsAlertStore();
  opens = 0;
  async open(input: Parameters<OpsAlertStore['open']>[0]): Promise<OpsAlert> {
    this.opens += 1;
    return this.inner.open(input);
  }
  async resolve(input: Parameters<OpsAlertStore['resolve']>[0]): Promise<OpsAlert | undefined> {
    return this.inner.resolve(input);
  }
}

/** Prometheus 짝 가짜: 지금 답(answer)을 돌려주고 물은 것을 적는다 */
class ScriptedProbe implements SettingsApplyProbe {
  answer: ProbeResult = { ok: true, pods: [] };
  readonly asked: { service: string; messageKey: string; version: number }[] = [];
  async probe(q: { service: string; messageKey: string; version: number }): Promise<ProbeResult> {
    this.asked.push({ ...q });
    return this.answer;
  }
}

async function harness() {
  let now = NOW;
  const clock = { now: () => now };
  const audit = new MemoryAuditChain();
  const checkpoints = new AuditCheckpointService(new MemoryAuditCheckpointStore(), audit, () => now);
  const store = new MemoryCommandStore(audit);
  const execute = new ExecuteCommand(store, undefined, checkpoints);
  const create = new CreateCommand(store, execute);
  const alertStore = new CountingAlertStore();
  const alerts = new RecordOpsAlert(alertStore, () => now);
  const probe = new ScriptedProbe();
  const check = new CheckSettingsApply({ store, probe, alerts, clock });

  const command = await create.execute({
    type: 'LOG_LEVEL',
    reason: '결제 지연 조사',
    params: { service: 'purchase-svc', level: 'DEBUG' },
    requestedBy: REQUESTER,
    requestedRole: 'operator',
    nowMs: NOW,
    actor,
  });
  const first = await store.latestOf(command.commandId);
  if (!first) throw new Error('적용 확인 행이 없다');
  const row: ApplyCheckRow = first;

  /** 다음 바퀴부터 untilMs까지 ROUND 간격으로 runOnce를 돌린다. 마지막 바퀴의 결과를 돌려준다 */
  const roundsTo = async (untilMs: number) => {
    let last = { checked: 0, opened: 0, resolved: 0 };
    let total = { checked: 0, opened: 0, resolved: 0 };
    while (now + ROUND <= untilMs) {
      now += ROUND;
      last = await check.runOnce();
      total = { checked: total.checked + last.checked, opened: total.opened + last.opened, resolved: total.resolved + last.resolved };
    }
    if (now < untilMs) {
      now = untilMs;
      last = await check.runOnce();
      total = { checked: total.checked + last.checked, opened: total.opened + last.opened, resolved: total.resolved + last.resolved };
    }
    return total;
  };
  const latest = async () => {
    const r = await store.latestOf(command.commandId);
    if (!r) throw new Error('적용 확인 행이 없다');
    return r;
  };
  const openAlerts = () => alertStore.inner.alerts.filter((a) => a.resolvedAtMs === undefined);
  return { store, probe, alertStore, command, row, roundsTo, latest, openAlerts, setNow: (t: number) => (now = t) };
}

const podsOf = (version: number, missing: boolean): ProbeResult => ({
  ok: true,
  pods: [{ pod: 'purchase-svc-0', version }, missing ? { pod: 'purchase-svc-1' } : { pod: 'purchase-svc-1', version }],
});

describe('C-T54 적용 확인 바퀴(서버 몫, 단위 층)', () => {
  test('C-T54 ① 명령 8의 받는 파드 하나가 판을 내지 않으면 나간 뒤 30초 전에는 CHECKING, 30초를 지난 바퀴에 UNCONFIRMED·SEV3 하나이고 다시 돌아도 경보는 하나다', async () => {
    const h = await harness();
    expect(h.row).toMatchObject({ stage: 'ACKED', messageKey: 'PLATFORM:LOG_LEVEL:purchase-svc', service: 'purchase-svc' });
    h.store.markOutboxSent(h.row.outboxId, SENT);
    h.probe.answer = podsOf(h.row.version, true);

    await h.roundsTo(SENT + WINDOW - 1);
    expect((await h.latest()).status).toBe('CHECKING');
    expect(h.alertStore.opens).toBe(0);
    // 받는 서비스·키·판으로 물었다
    expect(h.probe.asked.at(-1)).toEqual({ service: 'purchase-svc', messageKey: 'PLATFORM:LOG_LEVEL:purchase-svc', version: h.row.version });

    const run = await h.roundsTo(SENT + WINDOW + CANON_ROUND + ROUND);
    const row = await h.latest();
    expect(row.status).toBe('UNCONFIRMED');
    expect(run.opened).toBe(1);
    expect(applyCheckViewOf(row)).toEqual({ kind: 'APPLY_CHECK', applyStatus: 'UNCONFIRMED', targetCount: 2, ackedCount: 1, unackedTargets: ['purchase-svc-1:-'] });
    expect(h.openAlerts()).toHaveLength(1);
    const alert = h.openAlerts()[0]!;
    expect(alert).toMatchObject({ eventKey: h.command.commandId, kind: ALERT_KIND, severity: 'SEV3', source: 'ops-svc' });
    expect(alert.detail).toMatchObject({ messageKey: 'PLATFORM:LOG_LEVEL:purchase-svc', version: h.row.version });
    expect(JSON.stringify(alert.detail.pods)).toContain('purchase-svc-1');
    // 경보 줄에 요청자 계정 ID가 없다
    expect(JSON.stringify(alert)).not.toContain(REQUESTER);

    // 1분 넘게 다시 봐도 못 미치면 경보를 다시 열지 않는다
    await h.roundsTo(SENT + WINDOW + 3 * 60 * SEC);
    expect((await h.latest()).status).toBe('UNCONFIRMED');
    expect(h.alertStore.opens).toBe(1);
    expect(h.openAlerts()).toHaveLength(1);
  });

  test('C-T54 ② 모두 판 이상이면 그 바퀴에 CONFIRMED이고 경보가 없다', async () => {
    const h = await harness();
    h.store.markOutboxSent(h.row.outboxId, SENT);
    h.probe.answer = podsOf(h.row.version, false);
    await h.roundsTo(SENT + CANON_ROUND + ROUND);
    const row = await h.latest();
    expect(row.status).toBe('CONFIRMED');
    expect(applyCheckViewOf(row)).toEqual({ kind: 'APPLY_CHECK', applyStatus: 'CONFIRMED', targetCount: 2, ackedCount: 2, unackedTargets: [] });
    // 확인된 뒤에는 30초가 지나도 경보가 없다
    await h.roundsTo(SENT + WINDOW + 10 * SEC);
    expect((await h.latest()).status).toBe('CONFIRMED');
    expect(h.alertStore.opens).toBe(0);
  });

  test('C-T54 ② UNCONFIRMED 뒤 못 받은 파드가 판을 내면 다시 보기 바퀴에 CONFIRMED로 바뀌고 경보가 닫힌다', async () => {
    const h = await harness();
    h.store.markOutboxSent(h.row.outboxId, SENT);
    h.probe.answer = podsOf(h.row.version, true);
    await h.roundsTo(SENT + WINDOW + CANON_ROUND + ROUND);
    expect((await h.latest()).status).toBe('UNCONFIRMED');
    expect(h.openAlerts()).toHaveLength(1);

    h.probe.answer = podsOf(h.row.version, false);
    const run = await h.roundsTo(SENT + WINDOW + 2 * 60 * SEC);
    expect((await h.latest()).status).toBe('CONFIRMED');
    expect(run.resolved).toBe(1);
    expect(h.openAlerts()).toHaveLength(0);
    const closed = h.alertStore.inner.alerts.find((a) => a.eventKey === h.command.commandId && a.kind === ALERT_KIND);
    expect(closed?.resolvedAtMs).toBeGreaterThan(SENT + WINDOW);
  });

  test('C-T54 ③ Prometheus를 막으면 UNKNOWN이고 30초가 지나도 UNCONFIRMED가 아니며 경보가 0건이다', async () => {
    const h = await harness();
    h.store.markOutboxSent(h.row.outboxId, SENT);
    h.probe.answer = { ok: false, reason: 'prometheus-unreachable' };
    const run = await h.roundsTo(SENT + WINDOW + 20 * SEC);
    const row = await h.latest();
    expect(row.status).toBe('UNKNOWN');
    expect(applyCheckViewOf(row)).toMatchObject({ kind: 'APPLY_CHECK', applyStatus: 'UNKNOWN' });
    expect(run.opened).toBe(0);
    expect(h.alertStore.opens).toBe(0);
    // UNKNOWN 바퀴가 실제로 있었다(막힌 동안 계속 물었다)
    expect(h.probe.asked.length).toBeGreaterThanOrEqual(Math.floor((WINDOW + 20 * SEC) / CANON_ROUND) - 1);
  });

  test('C-T54 ① Outbox가 나가지 않은 동안은 Prometheus를 묻지 않고, 쓴 뒤 5초를 넘기면 OUTBOX_WAITING이다', async () => {
    const h = await harness();
    h.probe.answer = podsOf(h.row.version, true);
    await h.roundsTo(NOW + 40 * SEC);
    expect((await h.latest()).status).toBe('OUTBOX_WAITING');
    expect(h.probe.asked).toHaveLength(0);
    expect(h.alertStore.opens).toBe(0);
  });

  test('F025-APPLY ⑱ 나간 시각 + 10분 30초를 넘긴 UNCONFIRMED 행은 더 묻지 않고 경보를 연 채 둔다', async () => {
    const h = await harness();
    h.store.markOutboxSent(h.row.outboxId, SENT);
    h.probe.answer = podsOf(h.row.version, true);
    await h.roundsTo(SENT + 10 * 60 * SEC + 30 * SEC + 2 * ROUND);
    expect((await h.latest()).status).toBe('UNCONFIRMED');
    const askedAtStop = h.probe.asked.length;
    h.probe.answer = podsOf(h.row.version, false);
    await h.roundsTo(SENT + 15 * 60 * SEC);
    expect(h.probe.asked).toHaveLength(askedAtStop);
    expect((await h.latest()).status).toBe('UNCONFIRMED');
    expect(h.openAlerts()).toHaveLength(1);
  });

  test('F025-APPLY ⑲ 정비 바퀴는 한 번에 limit 행까지만 본다', async () => {
    const h = await harness();
    h.store.markOutboxSent(h.row.outboxId, SENT);
    h.probe.answer = podsOf(h.row.version, false);
    const at = SENT + 2 * CANON_ROUND;
    h.setNow(at);
    const check = new CheckSettingsApply({ store: h.store, probe: h.probe, clock: { now: () => at } });
    expect(await check.runOnce(0)).toEqual({ checked: 0, opened: 0, resolved: 0 });
    expect(h.probe.asked).toHaveLength(0);
    expect((await check.runOnce(1)).checked).toBe(1);
  });
});

describe('F025-APPLY 정비 바퀴의 적용 확인(TR-01)', () => {
  /** 정비 한 바퀴를 부른 시각만 적는 짝(CommandMaintenanceJob은 정비와 적용 확인을 따로 부른다) */
  const fakeMaintain = (calls: number[]): MaintainCommands =>
    ({ runOnce: async (nowMs: number) => (calls.push(nowMs), { approvalsExpired: 0, revertsExpired: 0, autoExpired: 0, compared: 0, actorsPurged: 0 }) }) as unknown as MaintainCommands;
  /** 적용 확인 한 바퀴를 부른 시각만 적는 짝 */
  const fakeCheck = (calls: number[]): CheckSettingsApply =>
    ({ runOnce: async () => (calls.push(1), { checked: 0, opened: 0, resolved: 0 }) }) as unknown as CheckSettingsApply;

  test('F025-APPLY ⑳ 적용 확인 바퀴 기본값은 정본 5,000ms이고, 주면 그 간격마다 CheckSettingsApply.runOnce를 부른다', async () => {
    // 정본 값(ADR-0365 결정 10·14 '정비 바퀴 5초', 계획 8.2)
    expect(APPLY_CHECK_ROUND_MS).toBe(5_000);

    // 기본값: 4,999ms에는 아직, 5,000ms 정각에 한 번
    vi.useFakeTimers();
    try {
      const defaultCalls: number[] = [];
      const clock = { now: () => NOW };
      const byDefault = new CommandMaintenanceJob(fakeMaintain([]), clock, { enabled: true, intervalMs: 30_000 }, undefined, { settingsApply: fakeCheck(defaultCalls) });
      byDefault.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(APPLY_CHECK_ROUND_MS - 1);
      expect(defaultCalls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(defaultCalls).toHaveLength(1);

      // 첫 tick은 시작 직후가 아니라 간격(1,500ms) 뒤다(기존 CommandMaintenanceJob의 정비 타이머와 같은 규칙,
      // 계획 8.2 'applyCheckRoundMs마다'). 그래서 기본 job도 4,999ms에 0, 5,000ms에 1이고, 주입 job은 1,499ms에 0이다.
      const checkCalls: number[] = [];
      const maintainCalls: number[] = [];
      const job = new CommandMaintenanceJob(fakeMaintain(maintainCalls), clock, { enabled: true, intervalMs: 30_000, applyCheckRoundMs: 1_500 }, undefined, { settingsApply: fakeCheck(checkCalls) });
      job.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(1_499);
      expect(checkCalls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(checkCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(checkCalls).toHaveLength(2);
      // 정비 바퀴(30초)는 적용 확인 간격에 끌려 빨라지지 않는다. 두 번째 job은 t=5,000ms에 시작했고
      // 지금 t=8,000ms이라, 27,000ms를 더한 t=35,000ms(시작 +30,000ms)에 정확히 한 번 돈다.
      // 15초로 빨라진 구현이면 t=20,000·35,000 두 번이라 아래 단언이 잡는다.
      expect(maintainCalls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(30_000 - 3_000);
      expect(maintainCalls).toHaveLength(1);
      job.onModuleDestroy();
      byDefault.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('F025-APPLY ㉑ 적용 확인 손잡이가 없으면(settingsApply 없음) 적용 확인 바퀴는 돌지 않고 정비만 돈다', async () => {
    vi.useFakeTimers();
    try {
      const maintainCalls: number[] = [];
      const job = new CommandMaintenanceJob(fakeMaintain(maintainCalls), fakeClock({ now: NOW }), { enabled: true, intervalMs: 30_000 }, undefined);
      job.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(maintainCalls).toHaveLength(1);
      job.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('F025-APPLY ㉒ 시작 파일(main.ts)이 settingsProbeFromEnv·DrizzleApplyChecks·DrizzleOpsAlertStore를 settingsApply로 넘긴다', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    // commandExtras 안의 settingsApply 블록만 본다(다른 곳의 같은 이름에 기대지 않는다)
    const inside = /commandExtras:\s*\{[\s\S]*?settingsApply:\s*\{([\s\S]*?)\}/.exec(main)?.[1] ?? '';
    expect(inside, 'main.ts에 commandExtras.settingsApply가 없다').not.toBe('');
    expect(inside).toContain('settingsProbeFromEnv(process.env)');
    expect(inside).toContain('new DrizzleApplyChecks(database)');
    expect(inside).toContain('new DrizzleOpsAlertStore(database)');
    // 환경 값에서 만든 주소를 쓴다(운영과 같은 환경에서 없으면 시작 실패는 settingsProbeFromEnv가 맡는다)
    expect(inside).toMatch(/PEAKET_PROMETHEUS_URL|settingsProbeFromEnv/);
  });
});
