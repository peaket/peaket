// 새 결제 진입 정지 판정(domain/entry-pause-judge.ts)과 판정자·해제 쓰임새·시험 재개 받기와 결과·Prometheus 입력·지표.
// 정본: docs/features/payment.md §2 '정지 판정자의 첫 구현'·§9·P-T43, ADR-0105·0250, docs/data.md `payment_entry_pause`, BUILD_ORDER PRF-202, docs/security/asvs/payment.md.
// 실제 PostgreSQL과 시뮬레이터까지 잇는 것은 test-int/payment-entry-pause-judge.int.test.ts가 본다.
import type * as NodeCrypto from 'node:crypto';
import { createHash } from 'node:crypto';
import { fakeClock, PlatformMetrics } from '@peaket/platform';
import { describe, expect, test, vi } from 'vitest';
import { entryPauseLog } from '../src/modules/payment/adapters/entry-pause-log.js';
import { BreakerPgCircuit } from '../src/modules/payment/adapters/pg-circuit.js';
import { PromEntryPauseSignals } from '../src/modules/payment/adapters/prom-entry-pause-signals.js';
import { NO_ENTRY_PAUSE_CLUSTER_INPUTS, PrometheusEntryPauseInputs } from '../src/modules/payment/adapters/prometheus-entry-pause-inputs.js';
import { CachedEntryPauseReader, EntryPauseReleaseWatcher } from '../src/modules/payment/application/entry-pause-cache.js';
import { EntryPauseJudge } from '../src/modules/payment/application/entry-pause-judge.js';
import { PaymentConfirmRunner } from '../src/modules/payment/application/payment-confirm-runner.js';
import { PrepareCheckout } from '../src/modules/payment/application/prepare-checkout.js';
import { ReleaseEntryPause } from '../src/modules/payment/application/release-entry-pause.js';
import { PaymentInputError } from '../src/modules/payment/domain/confirm-command.js';
import type { ConfirmFinish, ConfirmJob, ConfirmTarget } from '../src/modules/payment/domain/confirm-runner.js';
import { type EntryPauses, type EntryPauseRow, PaymentNewPausedError } from '../src/modules/payment/domain/entry-pause.js';
import {
  admitsEntryTrial,
  channelWaitSeconds,
  classifyProbeAnswer,
  type ClusterPauseReading,
  decideEntryPause,
  ENTRY_PAUSE_JUDGE_DEFAULTS as D,
  ENTRY_PAUSE_LEASE_NAME,
  ENTRY_PAUSE_RELEASE_ACTOR_MAX,
  ENTRY_PAUSE_RELEASE_REASON_MAX,
  ENTRY_TRIAL_RETENTION_MS,
  entryTrialDraw,
  EntryPauseProbeWindow,
  type EntryPauseFacts,
  type EntryPauseRecord,
  type EntryPauseWrite,
  type EntryTrialRow,
  firstResultOf,
  freshClusterReading,
  isEntryTrialConclusion,
  nextChannelBelowSince,
  nextPauseRecord,
  p99WindowOf,
  parseReleaseEntryPause,
  summarizeEntryTrial,
} from '../src/modules/payment/domain/entry-pause-judge.js';
import type { ConfirmResult, PaymentGatewayPort, PgCapabilities, PgName, QueryOptions, QueryResult } from '../src/modules/payment/domain/payment-gateway.js';
import { PgCallGuards } from '../src/modules/payment/domain/pg-call-guard.js';
import { PG_CIRCUIT_PROBE_PAYMENT_REF, PG_CIRCUIT_PROBE_TIMEOUT_MS, type PgCallKind, type PgCircuit, PgCircuitOpenError, type PgCircuitState } from '../src/modules/payment/domain/pg-circuit.js';
import { channelTableOf } from '../src/modules/payment/domain/pg-selection.js';
import type { EntryPauseJudgeErrorWhat, EntryPauseStore, EntryTrialOutcome, PaymentGateways } from '../src/modules/payment/domain/ports.js';

// 실제 난수를 그대로 쓰되 부른 범위만 적는다(주입하지 않을 때의 추첨 범위를 본다)
const { randomIntCalls } = vi.hoisted(() => ({ randomIntCalls: [] as unknown[] }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  return {
    ...actual,
    randomInt: (...args: unknown[]) => {
      randomIntCalls.push(args[0]);
      return Reflect.apply(actual.randomInt, actual, args) as number;
    },
  };
});

const NOW = Date.parse('2026-11-09T03:00:00.000Z');
const SEC = 1_000;
const MIN = 60_000;

const record = (o: Partial<EntryPauseRecord> = {}): EntryPauseRecord => ({ pg: 'TOSS', stage: 'OPEN', reason: 'PG_FAILURE', actor: 'SYSTEM', sinceMs: NOW - 10 * MIN, version: 3, ...o });
const healthyCluster: ClusterPauseReading = { openPods: 0, readyPods: 4, sampledAtMs: NOW };
const facts = (o: Partial<EntryPauseFacts> = {}): EntryPauseFacts => ({ nowMs: NOW, cluster: healthyCluster, localCircuitClosed: true, channel: { waitSeconds: 0 }, probeHealthy: false, probeFilling: false, trial: undefined, ...o });
const NO_INPUT = { cluster: undefined } as const;

describe('decideEntryPause: 시작', () => {
  test.each<[string, Partial<EntryPauseFacts>, EntryPauseRecord | undefined, string]>([
    ['행이 없고 모두 정상이면 그대로', {}, undefined, 'STAY'],
    ['OPEN이고 모두 정상이면 그대로', {}, record(), 'STAY'],
    ['파드 절반이 열리면 PG_FAILURE', { cluster: { openPods: 2, readyPods: 4, sampledAtMs: NOW } }, undefined, 'PAUSE:PG_FAILURE'],
    ['절반 미만이면 그대로', { cluster: { openPods: 1, readyPods: 4, sampledAtMs: NOW } }, undefined, 'STAY'],
    ['p99가 5초를 넘으면 PG_FAILURE', { cluster: { ...healthyCluster, p99Seconds: 5.01, p99Samples: 100 } }, record(), 'PAUSE:PG_FAILURE'],
    ['p99가 정확히 5초면 그대로', { cluster: { ...healthyCluster, p99Seconds: 5, p99Samples: 100 } }, record(), 'STAY'],
    ['리뷰 고침 H2: 표본이 100건 미만이면 p99는 표본 없음이다(5초 초과 1건으로 멈추지 않는다)', { cluster: { ...healthyCluster, p99Seconds: 30, p99Samples: 99 } }, record(), 'STAY'],
    ['리뷰 고침 H2: 표본 수를 읽지 못하면 p99는 표본 없음이다', { cluster: { ...healthyCluster, p99Seconds: 30 } }, record(), 'STAY'],
    ['리뷰 고침 H2: 표본이 모자라도 서킷 조건은 그대로다', { cluster: { openPods: 2, readyPods: 4, sampledAtMs: NOW, p99Seconds: 1, p99Samples: 1 } }, record(), 'PAUSE:PG_FAILURE'],
    ['p99 표본이 없으면 참이 아니다(빈 결과를 0으로도 넘김으로도 읽지 않는다)', { cluster: healthyCluster }, record(), 'STAY'],
    ['예상 대기가 60초를 넘으면 CHANNEL_WAIT', { channel: { waitSeconds: 60.01 } }, record(), 'PAUSE:CHANNEL_WAIT'],
    ['예상 대기가 정확히 60초면 그대로', { channel: { waitSeconds: 60 } }, record(), 'STAY'],
    ['둘이 함께면 PG_FAILURE가 이긴다', { cluster: { openPods: 4, readyPods: 4, sampledAtMs: NOW }, channel: { waitSeconds: 600 } }, record(), 'PAUSE:PG_FAILURE'],
    ['대기 건수를 읽지 못하면 상한 정지를 시작하지 않는다', { channel: undefined }, record(), 'STAY'],
    ['입력이 없으면 자기 서킷이 닫혀 있는 한 시작하지 않는다', { ...NO_INPUT }, record(), 'STAY'],
    ['입력이 없으면 자기 서킷만으로 PG_FAILURE', { ...NO_INPUT, localCircuitClosed: false }, record(), 'PAUSE:PG_FAILURE'],
    ['입력이 없으면 상한 정지를 시작하지 않는다', { ...NO_INPUT, channel: { waitSeconds: 600 } }, record(), 'STAY'],
    ['입력이 있으면 자기 서킷 하나로는 시작하지 않는다(다수로 정한다)', { localCircuitClosed: false }, record(), 'STAY'],
  ])('P-T43_%s [ASVS v5.0.0-16.5.3]', (_name, f, row, want) => {
    const d = decideEntryPause(row, facts(f));
    expect(d.kind === 'PAUSE' ? `PAUSE:${d.reason}` : d.kind).toBe(want);
  });

  const majority: ClusterPauseReading = { openPods: 4, readyPods: 4, sampledAtMs: NOW };
  const human = (agoMs: number) => record({ actor: 'cmd-1', reopenedAtMs: NOW - agoMs });

  test.each<[string, Partial<EntryPauseFacts>, EntryPauseRecord, string]>([
    ['리뷰 고침 M5: 사람이 푼 뒤 15초 안에는 서킷 열림을 보지 않는다', { cluster: majority }, human(15 * SEC - 1), 'STAY'],
    ['리뷰 고침 M5: 15초가 지나면 서킷 열림을 다시 본다', { cluster: majority }, human(15 * SEC), 'PAUSE:PG_FAILURE'],
    ['리뷰 고침 M5: 15초 안이어도 p99 조건은 그대로다', { cluster: { ...majority, openPods: 0, p99Seconds: 9, p99Samples: 100 } }, human(SEC), 'PAUSE:PG_FAILURE'],
    ['리뷰 고침 M5: 15초 안에는 입력이 없을 때의 자기 서킷도 보지 않는다', { ...NO_INPUT, localCircuitClosed: false }, human(SEC), 'STAY'],
    ['리뷰 고침 M5: 자동으로 연 행에는 이 유예가 없다', { cluster: majority }, record({ actor: 'SYSTEM', reopenedAtMs: NOW - SEC }), 'PAUSE:PG_FAILURE'],
  ])('P-T43_%s [ASVS v5.0.0-16.5.3]', (_name, f, row, want) => {
    const d = decideEntryPause(row, facts(f));
    expect(d.kind === 'PAUSE' ? `PAUSE:${d.reason}` : d.kind).toBe(want);
  });
});

describe('decideEntryPause: 확인 호출과 상한 해제', () => {
  const probing = record({ stage: 'PROBING', reason: 'PG_FAILURE' });
  const channel = record({ stage: 'PROBING', reason: 'CHANNEL_WAIT' });

  test.each<[string, EntryPauseRecord, Partial<EntryPauseFacts>, string]>([
    ['창이 건강하고 서킷이 닫혔으면 TRIAL', probing, { probeHealthy: true }, 'TRIAL'],
    ['창이 건강하지 않으면 그대로', probing, {}, 'STAY'],
    ['서킷이 닫혀 있지 않으면 그대로', probing, { probeHealthy: true, localCircuitClosed: false }, 'STAY'],
    ['입력이 없으면 앞으로 가지 않는다', probing, { probeHealthy: true, ...NO_INPUT }, 'STAY'],
    ['10초 아래가 1분 이어지면 연다', channel, { channel: { waitSeconds: 1, belowSinceMs: NOW - MIN } }, 'OPEN'],
    ['1분이 안 되면 아직 아니다', channel, { channel: { waitSeconds: 1, belowSinceMs: NOW - MIN + 1 } }, 'STAY'],
    ['기준 아래로 들어온 적이 없으면 그대로', channel, { channel: { waitSeconds: 20 } }, 'STAY'],
    ['입력이 없으면 상한 해제도 하지 않는다', channel, { ...NO_INPUT, channel: { waitSeconds: 1, belowSinceMs: NOW - MIN } }, 'STAY'],
    ['대기 건수를 읽지 못하면 해제하지 않는다', channel, { channel: undefined }, 'STAY'],
  ])('P-T43_%s [ASVS v5.0.0-16.5.3]', (_name, row, f, want) => {
    expect(decideEntryPause(row, facts(f)).kind).toBe(want);
  });
});

describe('decideEntryPause: 시험 재개', () => {
  const trial = (startedAgoMs = MIN) => record({ stage: 'TRIAL', trialStartedAtMs: NOW - startedAgoMs });
  const summary = (counted: number, conclusive: number, failed = counted - conclusive) => ({ counted, conclusive, failed });

  test.each<[string, EntryPauseRecord, Partial<EntryPauseFacts>, string]>([
    ['20건에 19건이 결론이면 연다', trial(), { trial: summary(20, 19) }, 'OPEN'],
    ['20건 모두 결론이면 연다', trial(), { trial: summary(20, 20) }, 'OPEN'],
    ['20건에 18건이면 PROBING', trial(), { trial: summary(20, 18) }, 'PROBING'],
    ['실패 2건이면 20건이 안 돼도 바로 PROBING', trial(), { trial: summary(5, 3) }, 'PROBING'],
    ['실패 1건에 20건 전이면 기다린다', trial(), { trial: summary(5, 4) }, 'STAY'],
    ['시작 뒤 10분이 안 됐으면 표본이 모자라도 기다린다', trial(10 * MIN - 1), { trial: summary(0, 0), probeHealthy: true }, 'STAY'],
    ['10분 예외: 0건도 연다', trial(10 * MIN), { trial: summary(0, 0), probeHealthy: true }, 'OPEN'],
    ['10분 예외: 실패 1건이면 연다', trial(10 * MIN), { trial: summary(3, 2), probeHealthy: true }, 'OPEN'],
    ['10분 예외: 실패 2건이면 PROBING', trial(10 * MIN), { trial: summary(3, 1), probeHealthy: true }, 'PROBING'],
    ['10분 예외: 확인 호출이 건강하지 않으면 PROBING', trial(10 * MIN), { trial: summary(3, 3), probeHealthy: false }, 'PROBING'],
    ['입력이 없으면 20건을 넘겨도 열지 않는다', trial(), { trial: summary(20, 20), ...NO_INPUT }, 'STAY'],
    ['입력이 없어도 뒤로는 간다(실패 2건)', trial(), { trial: summary(5, 3), ...NO_INPUT }, 'PROBING'],
    ['입력이 없어도 뒤로는 간다(20건 미달)', trial(), { trial: summary(20, 18), ...NO_INPUT }, 'PROBING'],
    ['입력이 없으면 10분 예외로 열지 않는다', trial(10 * MIN), { trial: summary(0, 0), probeHealthy: true, ...NO_INPUT }, 'STAY'],
    ['입력이 없어도 10분 예외의 확인 호출 실패는 뒤로 간다', trial(10 * MIN), { trial: summary(0, 0), probeHealthy: false, ...NO_INPUT }, 'PROBING'],
    ['리뷰 고침 M7: 10분이 지났는데 창이 덜 찼으면(판정자가 바뀐 뒤) 돌려보내지 않고 기다린다', trial(10 * MIN), { trial: summary(3, 3), probeFilling: true }, 'STAY'],
    ['리뷰 고침 M7: 창이 덜 찼어도 실패 기준을 넘었으면 돌아간다', trial(10 * MIN), { trial: summary(3, 1), probeFilling: true }, 'PROBING'],
    ['리뷰 고침 M7: 서킷이 닫혀 있지 않아 창을 비운 것이면 덜 찬 것으로 보지 않고 돌아간다', trial(10 * MIN), { trial: summary(3, 3), probeFilling: true, localCircuitClosed: false }, 'PROBING'],
    ['시험 행을 읽지 못한 틱은 그대로', trial(), { trial: undefined }, 'STAY'],
    ['시작 시각이 비면 PROBING으로 돌아간다', record({ stage: 'TRIAL' }), { trial: summary(20, 20) }, 'PROBING'],
  ])('P-T43_%s [ASVS v5.0.0-16.5.3]', (_name, row, f, want) => {
    expect(decideEntryPause(row, facts(f)).kind).toBe(want);
  });
});

describe('nextPauseRecord: 쓸 행', () => {
  const pg: PgName = 'TOSS';

  test('P-T43_첫 정지: 시작 시각은 지금이고 행위자는 SYSTEM이다', () => {
    expect(nextPauseRecord(pg, undefined, { kind: 'PAUSE', reason: 'CHANNEL_WAIT' }, NOW)).toEqual({ pg, stage: 'PROBING', reason: 'CHANNEL_WAIT', actor: 'SYSTEM', sinceMs: NOW });
  });

  test('P-T43_다시 멈출 때 이전 연 시각은 남고 since는 새로 쓴다', () => {
    const row = record({ actor: 'cmd-1', reopenedAtMs: NOW - MIN, sinceMs: NOW - 9 * MIN });
    expect(nextPauseRecord(pg, row, { kind: 'PAUSE', reason: 'PG_FAILURE' }, NOW)).toEqual({ pg, stage: 'PROBING', reason: 'PG_FAILURE', actor: 'SYSTEM', sinceMs: NOW, reopenedAtMs: NOW - MIN });
  });

  test('P-T43_TRIAL: 시험 시작 시각을 쓴다', () => {
    const row = record({ stage: 'PROBING' });
    expect(nextPauseRecord(pg, row, { kind: 'TRIAL' }, NOW)).toMatchObject({ stage: 'TRIAL', trialStartedAtMs: NOW, sinceMs: row.sinceMs });
  });

  test('P-T43_PROBING으로 돌아가면 시험 시작 시각을 비운다', () => {
    const next = nextPauseRecord(pg, record({ stage: 'TRIAL', trialStartedAtMs: NOW - MIN }), { kind: 'PROBING' }, NOW);
    expect(next.stage).toBe('PROBING');
    expect(next.trialStartedAtMs).toBeUndefined();
  });

  test('P-T43_열 때: reopened_at은 지금, 행위자는 SYSTEM, since는 그대로, 시험 시작 시각은 비운다', () => {
    const row = record({ stage: 'TRIAL', trialStartedAtMs: NOW - MIN, sinceMs: NOW - 5 * MIN });
    const next = nextPauseRecord(pg, row, { kind: 'OPEN' }, NOW);
    expect(next).toMatchObject({ stage: 'OPEN', reopenedAtMs: NOW, actor: 'SYSTEM', sinceMs: NOW - 5 * MIN });
    expect(next.trialStartedAtMs).toBeUndefined();
  });
});

describe('p99WindowOf·freshClusterReading', () => {
  test.each<[string, number | undefined, number | undefined]>([
    ['연 적이 없으면 기본 창', undefined, MIN],
    ['연 지 2분이면 기본 창', NOW - 2 * MIN, MIN],
    ['연 지 30초면 30초 창', NOW - 30 * SEC, 30 * SEC],
    ['연 지 10초면 10초 창(긁기 2배)', NOW - 10 * SEC, 10 * SEC],
    ['연 지 9.999초면 표본 없음', NOW - 9_999, undefined],
    ['방금 열었으면 표본 없음', NOW, undefined],
  ])('P-T43_%s', (_name, reopenedAtMs, want) => {
    expect(p99WindowOf(reopenedAtMs === undefined ? undefined : { reopenedAtMs }, NOW)).toBe(want);
  });

  test.each<[string, ClusterPauseReading | undefined, boolean]>([
    ['없으면 입력 없음', undefined, false],
    ['30초 정확히는 쓴다', { ...healthyCluster, sampledAtMs: NOW - 30 * SEC }, true],
    ['30초를 넘으면 입력 없음', { ...healthyCluster, sampledAtMs: NOW - 30 * SEC - 1 }, false],
    ['준비된 파드가 0이면 입력 없음', { ...healthyCluster, readyPods: 0 }, false],
  ])('P-T43_%s [ASVS v5.0.0-16.5.3]', (_name, reading, want) => {
    expect(freshClusterReading(reading, NOW) !== undefined).toBe(want);
  });
});

describe('확인 호출 분류', () => {
  test.each<[string, QueryResult, 'ok' | 'fail', boolean]>([
    ['결제 없음은 성공', { kind: 'NOT_FOUND' }, 'ok', false],
    ['일시 장애(5xx·시간 초과·연결 실패)는 실패', { kind: 'UNKNOWN', outage: true }, 'fail', false],
    ['429는 실패', { kind: 'UNKNOWN', throttled: true }, 'fail', false],
    ['인증 오류(표시 없는 UNKNOWN)는 실패', { kind: 'UNKNOWN' }, 'fail', false],
    ['있는 결제가 돌아오면 실패이고 고정 번호가 겹친 것이다', { kind: 'FOUND', paymentRef: 'x', orderRef: 'y', status: 'APPROVED', amount: 1, balanceAmount: 1 }, 'fail', true],
  ])('P-T43_%s [ASVS v5.0.0-16.5.3]', (_name, answer, outcome, found) => {
    expect(classifyProbeAnswer(answer)).toEqual({ outcome, found });
  });
});

describe('EntryPauseProbeWindow: 3분 창', () => {
  const full = (w: EntryPauseProbeWindow, fails = 0, n = 181) => {
    for (let i = 0; i < n; i += 1) w.add(NOW + i * SEC, i >= fails);
  };
  const end = NOW + 180 * SEC;

  test('P-T43_3분을 다 채웠고 99% 이상이면 건강하다', () => {
    const w = new EntryPauseProbeWindow();
    full(w);
    expect(w.healthy(end)).toBe(true);
  });

  test('P-T43_3분이 안 됐으면 아직 아니다', () => {
    const w = new EntryPauseProbeWindow();
    full(w, 0, 180);
    expect(w.healthy(end - 1)).toBe(false);
  });

  test('P-T43_180건 가운데 실패 1건이면 99%를 넘는다(1건 경계)', () => {
    const w = new EntryPauseProbeWindow();
    for (let i = 0; i <= 180; i += 1) w.add(NOW + i * SEC, i !== 90);
    expect(w.healthy(end)).toBe(true);
  });

  test('P-T43_180건 가운데 실패 2건이면 99% 아래다', () => {
    const w = new EntryPauseProbeWindow();
    for (let i = 0; i <= 180; i += 1) w.add(NOW + i * SEC, i !== 90 && i !== 91);
    expect(w.healthy(end)).toBe(false);
  });

  test('P-T43_틀린 구현: 성공률이 정확히 99%면 건강하다(100건에 실패 1건, 경계를 초과로 바꾸면 잡힌다)', () => {
    const w = new EntryPauseProbeWindow();
    for (let i = 0; i <= 100; i += 1) w.add(NOW + i * SEC, i !== 50);
    expect(w.healthy(NOW + 100 * SEC, { ...D, probeWindowMs: 100 * SEC })).toBe(true);
  });

  test('P-T43_표본이 기대의 80% 이상이면 된다(144건, 건너뛴 틱은 세지 않는다)', () => {
    const w = new EntryPauseProbeWindow();
    w.add(NOW, true);
    for (let i = 1; i <= 180; i += 1) if (i % 5 !== 0) w.add(NOW + i * SEC, true);
    expect(w.healthy(end)).toBe(true);
  });

  test('P-T43_표본이 기대의 80% 아래면 아직 아니다(143건)', () => {
    const w = new EntryPauseProbeWindow();
    w.add(NOW, true);
    for (let i = 0; i < 143; i += 1) w.add(end - i * SEC, true);
    expect(w.healthy(end)).toBe(false);
  });

  test('P-T43_창 밖 표본은 뺀다(옛 실패가 창을 흐리지 않는다)', () => {
    const w = new EntryPauseProbeWindow();
    w.add(NOW, false);
    for (let i = 1; i <= 181; i += 1) w.add(NOW + i * SEC, true);
    expect(w.healthy(NOW + 181 * SEC)).toBe(true);
  });

  test('P-T43_비우면 처음부터다', () => {
    const w = new EntryPauseProbeWindow();
    full(w);
    w.clear();
    expect(w.healthy(end)).toBe(false);
    w.add(end + 1, true);
    expect(w.healthy(end + 1)).toBe(false);
  });

  test.each<[string, (w: EntryPauseProbeWindow) => void, number, string]>([
    ['표본이 없으면 차는 중', () => undefined, end, 'FILLING'],
    ['3분이 안 됐으면 차는 중', (w) => full(w, 0, 180), end - 1, 'FILLING'],
    ['표본이 80% 아래면 차는 중(143건)', (w) => { w.add(NOW, true); for (let i = 0; i < 143; i += 1) w.add(end - i * SEC, true); }, end, 'FILLING'],
    ['다 찼고 99% 이상이면 건강', (w) => full(w), end, 'HEALTHY'],
    ['다 찼고 99% 아래면 건강하지 않음', (w) => full(w, 10), end, 'UNHEALTHY'],
  ])('P-T43_리뷰 고침 M7: %s', (_name, fill, at, want) => {
    const w = new EntryPauseProbeWindow();
    fill(w);
    expect(w.status(at)).toBe(want);
  });
});

describe('시험 재개의 요약과 결과', () => {
  const row = (firstResult: EntryTrialRow['firstResult'], firstCallMs?: number, firstCallAtMs = NOW - MIN): EntryTrialRow => ({ firstCallAtMs, ...(firstResult === undefined ? {} : { firstResult }), ...(firstCallMs === undefined ? {} : { firstCallMs }) });

  test.each<[string, EntryTrialRow, boolean]>([
    ['승인 5초 안은 결론', row('APPROVED', 5_000), true],
    ['거절 5초 안도 결론', row('DECLINED', 100), true],
    ['승인이어도 5초를 넘으면 실패', row('APPROVED', 5_001), false],
    ['시간이 없으면 실패', row('APPROVED'), false],
    ['FAILED는 실패', row('FAILED', 10), false],
    ['UNKNOWN은 실패', row('UNKNOWN', 10), false],
  ])('P-T43_%s', (_name, r, want) => {
    expect(isEntryTrialConclusion(r)).toBe(want);
  });

  test('P-T43_요약은 표본 수까지만 센다', () => {
    const rows = Array.from({ length: 25 }, (_, i) => (i === 24 ? row('FAILED', 1) : row('APPROVED', 1)));
    expect(summarizeEntryTrial(rows, NOW)).toEqual({ counted: 20, conclusive: 20, failed: 0 });
  });

  test('P-T43_리뷰 고침 H4: 호출을 시작한 뒤 5초가 지나도 결과가 없으면 실패로 센다(느린 20%가 표본에서 빠지지 않는다)', () => {
    const rows = Array.from({ length: 20 }, (_, i) => (i < 4 ? row(undefined, undefined, NOW - 5 * SEC - 1) : row('APPROVED', 100)));
    expect(summarizeEntryTrial(rows, NOW)).toEqual({ counted: 20, conclusive: 16, failed: 4 });
  });

  test.each<[string, number]>([
    ['방금 시작', NOW],
    ['정확히 5초(5초 안 결론은 성공이다)', NOW - 5 * SEC],
  ])('P-T43_리뷰 고침 H4: 앞 표본에 결과가 없는 행이 5초 안이면 이 틱은 판정을 미룬다(%s)', (_name, startedAt) => {
    expect(summarizeEntryTrial([row('APPROVED', 100), row(undefined, undefined, startedAt)], NOW)).toBeUndefined();
  });

  test('P-T43_리뷰 고침 H4: 앞 표본 밖의 결과 없는 행은 판정을 미루지 않는다', () => {
    const rows = [...Array.from({ length: 20 }, () => row('APPROVED', 100)), row(undefined, undefined, NOW)];
    expect(summarizeEntryTrial(rows, NOW)).toEqual({ counted: 20, conclusive: 20, failed: 0 });
  });

  test.each<[string, ConfirmResult | undefined, string]>([
    ['승인', { outcome: 'APPROVED', paymentRef: 'x' }, 'APPROVED'],
    ['이미 승인', { outcome: 'ALREADY_APPROVED', paymentRef: 'x' }, 'APPROVED'],
    ['입금 대기', { outcome: 'WAITING_FOR_DEPOSIT', paymentRef: 'x' }, 'APPROVED'],
    ['카드 거절', { outcome: 'DECLINED', paymentRef: 'x', failureCategory: 'CARD_DECLINED' }, 'DECLINED'],
    ['검증 거절', { outcome: 'DECLINED', paymentRef: 'x', failureCategory: 'VALIDATION' }, 'DECLINED'],
    ['429는 실패', { outcome: 'DECLINED', paymentRef: 'x', failureCategory: 'THROTTLED' }, 'FAILED'],
    ['결제사 오류는 실패', { outcome: 'DECLINED', paymentRef: 'x', failureCategory: 'PG_ERROR' }, 'FAILED'],
    ['처리 중은 실패', { outcome: 'IN_PROGRESS', paymentRef: 'x' }, 'FAILED'],
    ['일시 장애는 FAILED', { outcome: 'UNKNOWN', paymentRef: 'x', outage: true }, 'FAILED'],
    ['표시 없는 결과 모름은 UNKNOWN', { outcome: 'UNKNOWN', paymentRef: 'x' }, 'UNKNOWN'],
    ['호출이 던졌으면 UNKNOWN', undefined, 'UNKNOWN'],
  ])('P-T43_%s', (_name, answer, want) => {
    expect(firstResultOf(answer)).toBe(want);
  });

  test.each<[number, boolean]>([
    [0, true],
    [499, true],
    [500, false],
    [9_999, false],
  ])('P-T43_리뷰 고침 H1: 추첨 경계(0~9999): %i는 받음 %s [ASVS v5.0.0-2.3.2]', (draw, want) => {
    expect(admitsEntryTrial(draw)).toBe(want);
  });

  test('P-T43_리뷰 고침 H1: 추첨은 sha256(주문:판 번호)의 앞 4바이트를 10000으로 나눈 나머지다 [ASVS v5.0.0-2.3.2]', () => {
    const orderId = '018f3c1e-0000-7000-8000-000000000001';
    expect(entryTrialDraw(orderId, 7)).toBe(createHash('sha256').update(`${orderId}:7`).digest().readUInt32BE(0) % 10_000);
  });

  test('P-T43_리뷰 고침 H1: 주문 1만 개에서 받는 비율은 4~6%다 [ASVS v5.0.0-2.3.2]', () => {
    let admitted = 0;
    for (let i = 0; i < 10_000; i += 1) if (admitsEntryTrial(entryTrialDraw(`00000000-0000-7000-8000-${String(i).padStart(12, '0')}`, 3))) admitted += 1;
    expect(admitted).toBeGreaterThanOrEqual(400);
    expect(admitted).toBeLessThanOrEqual(600);
  });

  test('P-T43_리뷰 고침 H1: 판 번호가 바뀌면(다음 시험) 다시 뽑는다 [ASVS v5.0.0-2.3.2]', () => {
    const orderIds = Array.from({ length: 200 }, (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`);
    expect(orderIds.some((id) => entryTrialDraw(id, 3) !== entryTrialDraw(id, 4))).toBe(true);
  });

  test('P-T43_예상 대기는 대기 건수 나누기 초당 상한이다', () => {
    expect(channelWaitSeconds(600, 10)).toBe(60);
    expect(channelWaitSeconds(0, 10)).toBe(0);
  });

  test.each<[string, number | undefined, number | undefined, number | undefined]>([
    ['처음 기준 아래로 들어오면 지금을 적는다', undefined, 1, NOW],
    ['이어지면 처음 시각을 둔다', NOW - 5 * SEC, 1, NOW - 5 * SEC],
    ['기준에 닿으면 지운다', NOW - 5 * SEC, 10, undefined],
    ['읽지 못하면 지운다', NOW - 5 * SEC, undefined, undefined],
  ])('P-T43_%s', (_name, prev, wait, want) => {
    expect(nextChannelBelowSince(prev, wait, NOW)).toBe(want);
  });
});

describe('parseReleaseEntryPause', () => {
  test('P-T43_맞는 입력을 돌려준다 [ASVS v5.0.0-2.2.1]', () => {
    expect(parseReleaseEntryPause({ pg: 'PORTONE', actor: 'cmd-1', reason: '확인 호출 경로 고장' })).toEqual({ pg: 'PORTONE', actor: 'cmd-1', reason: '확인 호출 경로 고장' });
  });

  test.each<[string, { pg: string; actor: string; reason: string }, string]>([
    ['모르는 결제사', { pg: 'NICE', actor: 'a', reason: 'r' }, 'pg'],
    ['빈 행위자', { pg: 'TOSS', actor: '  ', reason: 'r' }, 'actor'],
    ['긴 행위자', { pg: 'TOSS', actor: 'a'.repeat(ENTRY_PAUSE_RELEASE_ACTOR_MAX + 1), reason: 'r' }, 'actor'],
    ['제어 문자 행위자', { pg: 'TOSS', actor: 'a\nb', reason: 'r' }, 'actor'],
    ['빈 사유', { pg: 'TOSS', actor: 'a', reason: '' }, 'reason'],
    ['긴 사유', { pg: 'TOSS', actor: 'a', reason: 'r'.repeat(ENTRY_PAUSE_RELEASE_REASON_MAX + 1) }, 'reason'],
    ['제어 문자 사유', { pg: 'TOSS', actor: 'a', reason: 'a\u0000b' }, 'reason'],
  ])('P-T43_%s는 입력 오류다 [ASVS v5.0.0-2.2.1]', (_name, input, field) => {
    let caught: unknown;
    try {
      parseReleaseEntryPause(input);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PaymentInputError);
    expect((caught as PaymentInputError).field).toBe(field);
  });

  test('P-T43_상한 길이까지 받는다 [ASVS v5.0.0-2.2.1]', () => {
    expect(() => parseReleaseEntryPause({ pg: 'TOSS', actor: 'a'.repeat(ENTRY_PAUSE_RELEASE_ACTOR_MAX), reason: 'r'.repeat(ENTRY_PAUSE_RELEASE_REASON_MAX) })).not.toThrow();
  });
});

class FakeStore implements EntryPauseStore {
  readonly rows = new Map<PgName, EntryPauseRecord>();
  readonly writes: { previous: EntryPauseRecord | undefined; next: EntryPauseWrite }[] = [];
  readonly readers: PgName[] = [];
  trials: EntryTrialRow[] = [];
  trialReads: [PgName, number, number][] = [];
  waiting = 0;
  waitingCalls = 0;
  failRead = false;
  failWaiting = false;
  failTrials = false;
  conflictsLeft = 0;
  /** 읽기를 이 결제사만 멈춘다(결제사 사이 독립을 본다) */
  readonly hold = new Set<PgName>();
  async readRecord(pg: PgName): Promise<EntryPauseRecord | undefined> {
    this.readers.push(pg);
    if (this.failRead) throw new Error('읽기 실패');
    if (this.hold.has(pg)) await new Promise(() => undefined);
    return this.rows.get(pg);
  }
  async write(previous: EntryPauseRecord | undefined, next: EntryPauseWrite): Promise<boolean> {
    this.writes.push({ previous, next });
    if (this.conflictsLeft > 0) {
      this.conflictsLeft -= 1;
      return false;
    }
    const pg = next.pg;
    this.rows.set(pg, { ...next, version: (previous?.version ?? 0) + 1 });
    return true;
  }
  async readTrialResults(pg: PgName, trialStartedAtMs: number, limit: number): Promise<EntryTrialRow[]> {
    this.trialReads.push([pg, trialStartedAtMs, limit]);
    if (this.failTrials) throw new Error('시험 행 실패');
    return this.trials;
  }
  async countWaitingConfirms(_pg: PgName, _nowMs: number, _cap: number): Promise<number> {
    this.waitingCalls += 1;
    if (this.failWaiting) throw new Error('세기 실패');
    return this.waiting;
  }
}

class FakeGateway implements Partial<PaymentGatewayPort> {
  readonly queries: [string, QueryOptions | undefined][] = [];
  answer: QueryResult | Error = { kind: 'NOT_FOUND' };
  constructor(
    readonly pg: PgName,
    readonly caps: Partial<PgCapabilities> = {},
  ) {}
  capabilities(): PgCapabilities {
    return { serverConfirm: true, confirmDeadlineMs: 600_000, partialCancel: true, webhookSignature: false, idempotencyRetentionMs: 1, callsPerSecond: 100, redirectCheckout: true, ...this.caps };
  }
  query = async (ref: string, options?: QueryOptions): Promise<QueryResult> => {
    this.queries.push([ref, options]);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  };
}

class FakeCircuit implements PgCircuit {
  current: PgCircuitState = 'closed';
  closeOnTrial = false;
  /** 판단(admits)과 호출(run) 사이에 끊긴 때를 흉내 낸다 */
  openOnRun = false;
  closes = 0;
  state(): PgCircuitState {
    return this.current;
  }
  admits(): boolean {
    return this.current !== 'open';
  }
  close(): void {
    this.closes += 1;
    this.current = 'closed';
  }
  async run<T>(action: () => Promise<T>, _isOutage: (answer: T) => boolean, _kind: PgCallKind): Promise<T> {
    if (this.openOnRun || !this.admits()) throw new PgCircuitOpenError();
    const answer = await action();
    if (this.current === 'half_open' && this.closeOnTrial) this.current = 'closed';
    return answer;
  }
}

function judgeRig(o: { gateways?: FakeGateway[]; podCount?: number; config?: Partial<typeof D> } = {}) {
  const clock = fakeClock({ now: NOW });
  const store = new FakeStore();
  const gateways = o.gateways ?? [new FakeGateway('TOSS')];
  const registry: PaymentGateways = { of: (pg) => gateways.find((g) => g.pg === pg) as unknown as PaymentGatewayPort | undefined };
  const circuits = new Map<PgName, FakeCircuit>(gateways.map((g) => [g.pg, new FakeCircuit()]));
  const guards = new PgCallGuards({ gateways: registry, podCount: o.podCount ?? 1, clock, signals: { throttled: () => undefined, limit: () => undefined, inflight: () => undefined, saturated: () => undefined }, log: { throttledFirst: () => undefined }, circuits: { of: (pg) => circuits.get(pg) } });
  const probes: [PgName, string][] = [];
  const conflicts: PgName[] = [];
  const errors: EntryPauseJudgeErrorWhat[] = [];
  const logs: Record<string, unknown>[] = [];
  let cluster: ClusterPauseReading | undefined = { ...healthyCluster };
  let inputAgeMs = 0;
  const inputCalls: [PgName, number | undefined][] = [];
  let leading = true;
  const silent = { setInterval: () => 0, clearInterval: () => undefined };
  const judge = new EntryPauseJudge({
    store,
    inputs: {
      read: async (pg, q) => {
        inputCalls.push([pg, q.p99WindowMs]);
        return cluster === undefined ? undefined : { ...cluster, sampledAtMs: clock.now() - inputAgeMs };
      },
    },
    gateways: registry,
    guards,
    leader: { isLeader: () => leading },
    podCount: o.podCount ?? 1,
    clock,
    signals: { probe: (pg, outcome) => void probes.push([pg, outcome]), writeConflict: (pg) => void conflicts.push(pg), judgeError: (what) => void errors.push(what) },
    log: { transition: (e) => void logs.push({ kind: 'transition', ...e }), probeFound: (e) => void logs.push({ kind: 'found', ...e }), judgeError: (e) => void logs.push({ kind: 'error', what: e.what, pg: e.pg }), released: () => undefined },
    timer: silent,
    ...(o.config === undefined ? {} : { config: o.config }),
  });
  const tick = async () => {
    await judge.tick();
    await judge.whenIdle();
  };
  return { clock, store, gateways, circuits, guards, probes, conflicts, errors, logs, judge, tick, inputCalls, setCluster: (c: ClusterPauseReading | undefined) => (cluster = c), setInputAge: (ms: number) => (inputAgeMs = ms), setLeader: (v: boolean) => (leading = v) };
}

const SHORT = { probeWindowMs: 3_000, probeIntervalMs: 1_000 };

describe('EntryPauseJudge', () => {
  test('P-T43_Lease 이름은 payment-entry-pause다', () => {
    expect(ENTRY_PAUSE_LEASE_NAME).toBe('payment-entry-pause');
    expect(ENTRY_TRIAL_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test('P-T43_리더가 아니면 읽지도 부르지도 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = judgeRig();
    r.setLeader(false);
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    await r.tick();
    expect(r.store.readers).toEqual([]);
    expect(r.gateways[0]!.queries).toEqual([]);
  });

  test('P-T43_어댑터가 없는 결제사는 돌지 않는다', async () => {
    const r = judgeRig();
    await r.tick();
    expect(r.store.readers).toEqual(['TOSS']);
  });

  test('P-T43_확인 호출: 고정 번호와 기한 1초로 부르고 성공을 ok로 센다', async () => {
    const r = judgeRig();
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    await r.tick();
    expect(r.gateways[0]!.queries).toEqual([[PG_CIRCUIT_PROBE_PAYMENT_REF, { timeoutMs: PG_CIRCUIT_PROBE_TIMEOUT_MS }]]);
    expect(r.probes).toEqual([['TOSS', 'ok']]);
  });

  test('P-T43_열림(OPEN)과 CHANNEL_WAIT에는 확인 호출을 보내지 않는다', async () => {
    const r = judgeRig();
    await r.tick();
    r.store.rows.set('TOSS', record({ stage: 'OPEN' }));
    await r.tick();
    r.store.rows.set('TOSS', record({ stage: 'PROBING', reason: 'CHANNEL_WAIT' }));
    await r.tick();
    expect(r.gateways[0]!.queries).toEqual([]);
    expect(r.probes).toEqual([]);
  });

  test('P-T43_시험 재개 중에도 확인 호출을 계속한다', async () => {
    const r = judgeRig();
    r.store.rows.set('TOSS', record({ stage: 'TRIAL', trialStartedAtMs: NOW }));
    await r.tick();
    expect(r.probes).toEqual([['TOSS', 'ok']]);
  });

  test.each<[string, QueryResult | Error, string]>([
    ['5xx·일시 장애', { kind: 'UNKNOWN', outage: true }, 'fail'],
    ['429', { kind: 'UNKNOWN', throttled: true }, 'fail'],
    ['인증 오류', { kind: 'UNKNOWN' }, 'fail'],
    ['시간 초과로 던짐', new Error('timeout'), 'fail'],
  ])('P-T43_확인 호출 %s는 실패다 [ASVS v5.0.0-16.5.3]', async (_name, answer, want) => {
    const r = judgeRig();
    r.gateways[0]!.answer = answer;
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    await r.tick();
    expect(r.probes).toEqual([['TOSS', want]]);
  });

  test('P-T43_있는 결제가 돌아오면 실패로 세고 오류 로그를 남긴다(응답 본문은 싣지 않는다) [ASVS v5.0.0-16.2.5]', async () => {
    const r = judgeRig();
    r.gateways[0]!.answer = { kind: 'FOUND', paymentRef: 'real', orderRef: 'real-order', status: 'APPROVED', amount: 1, balanceAmount: 1 };
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    await r.tick();
    expect(r.probes).toEqual([['TOSS', 'fail']]);
    expect(r.logs).toEqual([{ kind: 'found', pg: 'TOSS' }]);
    expect(JSON.stringify(r.logs)).not.toContain('real-order');
  });

  test('P-T43_서킷이 열려 있으면 부르지 않고 skipped로 세며 창을 비운다 [ASVS v5.0.0-16.5.2]', async () => {
    const r = judgeRig({ config: SHORT });
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    await r.tick();
    r.clock.advance(1_000);
    r.circuits.get('TOSS')!.current = 'open';
    await r.tick();
    expect(r.gateways[0]!.queries).toHaveLength(1);
    expect(r.probes.at(-1)).toEqual(['TOSS', 'skipped']);
    r.circuits.get('TOSS')!.current = 'closed';
    for (let i = 0; i < 3; i += 1) {
      r.clock.advance(1_000);
      await r.tick();
    }
    // 비운 뒤 3초가 차지 않았다(첫 표본이 닫힌 뒤의 틱)
    expect(r.store.rows.get('TOSS')!.stage).toBe('PROBING');
  });

  test('P-T43_틀린 구현: 판단과 호출 사이에 서킷이 끊으면 부르지 않았으니 실패로 세지 않고 skipped다 [ASVS v5.0.0-16.5.2]', async () => {
    const r = judgeRig();
    r.circuits.get('TOSS')!.openOnRun = true;
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    await r.tick();
    expect(r.probes).toEqual([['TOSS', 'skipped']]);
    expect(r.gateways[0]!.queries).toEqual([]);
  });

  test('P-T43_틀린 구현: 확인 호출은 토큰을 쓰지 않고 서킷만 거친다(토큰이 모자라도 부른다) [ASVS v5.0.0-16.5.2]', async () => {
    const r = judgeRig({ gateways: [new FakeGateway('TOSS', { callsPerSecond: 1 })] });
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    const guard = r.guards.of('TOSS')!;
    while (guard.tryTakeToken()) {
      // 토큰을 다 쓴다
    }
    const take = vi.spyOn(guard, 'tryTakeToken');
    await r.tick();
    await r.tick();
    expect(r.gateways[0]!.queries).toHaveLength(2);
    expect(r.probes).toEqual([['TOSS', 'ok'], ['TOSS', 'ok']]);
    expect(take).not.toHaveBeenCalled();
  });

  test('P-T43_틀린 구현: 서킷이 끊어 부르지 않은 확인 호출은 토큰을 건드리지 않고 skipped이며 다음 틱에 다시 부른다 [ASVS v5.0.0-16.5.2]', async () => {
    const r = judgeRig({ gateways: [new FakeGateway('TOSS', { callsPerSecond: 1 })] });
    r.circuits.get('TOSS')!.openOnRun = true;
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    const guard = r.guards.of('TOSS')!;
    const take = vi.spyOn(guard, 'tryTakeToken');
    const refund = vi.spyOn(guard, 'refundTokens');
    await r.tick();
    r.circuits.get('TOSS')!.openOnRun = false;
    await r.tick();
    expect(r.probes).toEqual([['TOSS', 'skipped'], ['TOSS', 'ok']]);
    expect(take).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
  });

  test('P-T43_리뷰 고침 H3: 파드 몫 토큰이 초당 1건에 못 미쳐도(토스 시험 키, 파드 2개) 표본 80%를 넘겨 PROBING에 갇히지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const r = judgeRig({ gateways: [new FakeGateway('TOSS', { callsPerSecond: 1 })], podCount: 2, config: SHORT });
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    for (let i = 0; i <= 3; i += 1) {
      await r.tick();
      r.clock.advance(1_000);
    }
    expect(r.store.rows.get('TOSS')!.stage).toBe('TRIAL');
    expect(r.probes.filter(([, outcome]) => outcome === 'skipped')).toEqual([]);
  });

  test('P-T43_반 열림의 확인 호출은 서킷을 거쳐 시험 호출이 되고 성공하면 닫힌다', async () => {
    const r = judgeRig({ config: SHORT });
    const c = r.circuits.get('TOSS')!;
    c.current = 'half_open';
    c.closeOnTrial = true;
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    await r.tick();
    expect(c.current).toBe('closed');
    expect(r.probes).toEqual([['TOSS', 'ok']]);
  });

  test.each<[string, QueryResult | Error]>([
    ['던진 호출(시간 초과·연결 실패)', new Error('timeout')],
    ['일시 장애 답', { kind: 'UNKNOWN', outage: true }],
    ['있는 결제 답', { kind: 'FOUND', paymentRef: 'real', orderRef: 'real-order', status: 'APPROVED', amount: 1, balanceAmount: 1 }],
  ])('P-T43_틀린 구현: %s는 창에 성공으로 들어가지 않아 시험 재개로 가지 않는다 [ASVS v5.0.0-16.5.3]', async (_name, answer) => {
    const r = judgeRig({ config: SHORT });
    r.gateways[0]!.answer = answer;
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    for (let i = 0; i < 6; i += 1) {
      await r.tick();
      r.clock.advance(1_000);
    }
    expect(r.store.writes).toEqual([]);
  });

  test('P-T43_3분 창이 차면 TRIAL로 간다(시작 시각과 판 번호 조건)', async () => {
    const r = judgeRig({ config: SHORT });
    r.store.rows.set('TOSS', record({ stage: 'PROBING', version: 7 }));
    for (let i = 0; i <= 3; i += 1) {
      await r.tick();
      if (r.store.rows.get('TOSS')!.stage === 'TRIAL') break;
      r.clock.advance(1_000);
    }
    const row = r.store.rows.get('TOSS')!;
    expect(row.stage).toBe('TRIAL');
    expect(row.trialStartedAtMs).toBe(r.clock.now());
    expect(row.version).toBe(8);
    expect(r.store.writes[0]!.previous?.version).toBe(7);
    expect(r.logs).toContainEqual({ kind: 'transition', pg: 'TOSS', from: 'PROBING', to: 'TRIAL', reason: 'PG_FAILURE', actor: 'SYSTEM' });
  });

  test('P-T43_판정 틱은 시험 행을 표본 수만큼 시험 시작 시각으로 읽는다', async () => {
    const r = judgeRig();
    r.store.rows.set('TOSS', record({ stage: 'TRIAL', trialStartedAtMs: NOW - 1 }));
    await r.tick();
    expect(r.store.trialReads).toEqual([['TOSS', NOW - 1, D.trialSampleSize]]);
  });

  test('P-T43_시험 재개에서 PROBING으로 돌아가면 창을 비운다', async () => {
    const r = judgeRig({ config: SHORT });
    r.store.rows.set('TOSS', record({ stage: 'TRIAL', trialStartedAtMs: NOW }));
    r.store.trials = [{ firstResult: 'FAILED', firstCallMs: 1, firstCallAtMs: NOW }, { firstResult: 'FAILED', firstCallMs: 1, firstCallAtMs: NOW }];
    await r.tick();
    expect(r.store.rows.get('TOSS')!.stage).toBe('PROBING');
    r.store.trials = [];
    for (let i = 0; i < 3; i += 1) {
      r.clock.advance(1_000);
      await r.tick();
    }
    expect(r.store.rows.get('TOSS')!.stage).toBe('PROBING');
  });

  test('P-T43_다시 연 뒤에는 연 시각 뒤의 창으로 p99를 묻고 표본이 짧으면 묻지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = judgeRig();
    r.store.rows.set('TOSS', record({ reopenedAtMs: NOW - 5 * SEC }));
    await r.tick();
    expect(r.inputCalls.at(-1)).toEqual(['TOSS', undefined]);
    r.store.rows.set('TOSS', record({ reopenedAtMs: NOW - 30 * SEC }));
    await r.tick();
    expect(r.inputCalls.at(-1)).toEqual(['TOSS', 30 * SEC]);
  });

  test('P-T43_정지 중에는 p99를 묻지 않는다', async () => {
    const r = judgeRig();
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    await r.tick();
    expect(r.inputCalls).toEqual([['TOSS', undefined]]);
  });

  test('P-T43_입력이 없으면 자기 서킷만으로 멈추고 판 번호 1로 쓴다(행 없음) [ASVS v5.0.0-16.5.2]', async () => {
    const r = judgeRig();
    r.setCluster(undefined);
    r.circuits.get('TOSS')!.current = 'open';
    await r.tick();
    expect(r.store.writes[0]).toMatchObject({ previous: undefined, next: { stage: 'PROBING', reason: 'PG_FAILURE', actor: 'SYSTEM', sinceMs: NOW } });
    expect(r.store.rows.get('TOSS')!.version).toBe(1);
  });

  test('P-T43_틀린 구현: 판정자는 30초를 넘은 입력을 입력 없음으로 보고 앞으로 가지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = judgeRig();
    r.store.rows.set('TOSS', record({ stage: 'TRIAL', trialStartedAtMs: NOW - MIN }));
    r.store.trials = Array.from({ length: D.trialSampleSize }, () => ({ firstResult: 'APPROVED', firstCallMs: 1, firstCallAtMs: NOW - SEC }));
    r.setInputAge(D.inputMaxAgeMs + 1);
    await r.tick();
    expect(r.store.writes).toEqual([]);
    r.setInputAge(D.inputMaxAgeMs);
    await r.tick();
    expect(r.store.rows.get('TOSS')!.stage).toBe('OPEN');
  });

  test('P-T43_판 번호 조건에 걸린 쓰기는 그 틱을 버리고 지표를 올린다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = judgeRig();
    r.setCluster({ openPods: 4, readyPods: 4, sampledAtMs: NOW });
    r.store.conflictsLeft = 1;
    await r.tick();
    expect(r.conflicts).toEqual(['TOSS']);
    expect(r.store.rows.get('TOSS')).toBeUndefined();
    expect(r.logs).toEqual([]);
  });

  test('P-T43_상한 정지: 예상 대기는 파드 수 곱의 초당 상한으로 잰다', async () => {
    const gateways = [new FakeGateway('TOSS', { callsPerSecond: 10, confirmCallCost: 2 })];
    const r = judgeRig({ gateways, podCount: 4 });
    r.store.waiting = 301;
    await r.tick();
    // 초당 승인 수 = 파드당 2.5 × 4파드 ÷ 비용 2 = 5건, 예상 대기 = 301 ÷ 5 = 60.2초
    expect(r.store.rows.get('TOSS')).toMatchObject({ stage: 'PROBING', reason: 'CHANNEL_WAIT' });
  });

  test('P-T43_틀린 구현: 상한 정지는 파드 수를 곱한 초당 상한으로 재므로 정확히 60초면 멈추지 않는다', async () => {
    const gateways = [new FakeGateway('TOSS', { callsPerSecond: 10, confirmCallCost: 2 })];
    const r = judgeRig({ gateways, podCount: 4 });
    r.store.waiting = 300;
    await r.tick();
    expect(r.store.writes).toEqual([]);
  });

  test('P-T43_상한 해제: 10초 아래가 1분 이어지면 열리고 확인 호출은 나가지 않는다', async () => {
    const r = judgeRig({ gateways: [new FakeGateway('TOSS', { callsPerSecond: 10 })] });
    r.store.rows.set('TOSS', record({ stage: 'PROBING', reason: 'CHANNEL_WAIT' }));
    r.store.waiting = 50;
    await r.tick();
    expect(r.store.rows.get('TOSS')!.stage).toBe('PROBING');
    r.clock.advance(MIN);
    await r.tick();
    expect(r.store.rows.get('TOSS')).toMatchObject({ stage: 'OPEN', reopenedAtMs: r.clock.now(), actor: 'SYSTEM' });
    expect(r.probes).toEqual([]);
    expect(r.gateways[0]!.queries).toEqual([]);
  });

  test('P-T43_상한 해제: 중간에 대기가 늘면 처음부터 다시 잰다', async () => {
    const r = judgeRig({ gateways: [new FakeGateway('TOSS', { callsPerSecond: 10 })] });
    r.store.rows.set('TOSS', record({ stage: 'PROBING', reason: 'CHANNEL_WAIT' }));
    r.store.waiting = 50;
    await r.tick();
    r.clock.advance(30 * SEC);
    r.store.waiting = 500;
    await r.tick();
    r.store.waiting = 50;
    r.clock.advance(30 * SEC);
    await r.tick();
    r.clock.advance(30 * SEC);
    await r.tick();
    expect(r.store.rows.get('TOSS')!.stage).toBe('PROBING');
  });

  test('P-T43_대기 건수를 읽지 못하면 그 입력만 없다(지표와 로그) [ASVS v5.0.0-16.5.3]', async () => {
    const r = judgeRig();
    r.store.failWaiting = true;
    await r.tick();
    expect(r.errors).toEqual(['channel']);
    expect(r.store.writes).toEqual([]);
  });

  test('P-T43_시험 행을 읽지 못한 틱은 전이하지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = judgeRig();
    r.store.rows.set('TOSS', record({ stage: 'TRIAL', trialStartedAtMs: NOW }));
    r.store.failTrials = true;
    await r.tick();
    expect(r.errors).toEqual(['trial']);
    expect(r.store.writes).toEqual([]);
  });

  test('P-T43_행을 읽지 못하면 그 결제사의 틱만 쉰다 [ASVS v5.0.0-16.5.2]', async () => {
    const r = judgeRig();
    r.store.failRead = true;
    await r.tick();
    expect(r.errors).toEqual(['read']);
    expect(r.probes).toEqual([]);
  });

  test('P-T43_한 결제사가 멈춰도 다른 결제사의 틱은 돈다', async () => {
    const r = judgeRig({ gateways: [new FakeGateway('TOSS'), new FakeGateway('PORTONE')] });
    r.store.hold.add('TOSS');
    void r.judge.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.store.readers).toContain('PORTONE');
    r.store.rows.set('PORTONE', record({ pg: 'PORTONE', stage: 'PROBING' }));
    void r.judge.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.store.readers.filter((p) => p === 'TOSS')).toHaveLength(1);
    expect(r.store.readers.filter((p) => p === 'PORTONE').length).toBeGreaterThan(1);
  });

  test('P-T43_리더를 잃었다 다시 얻으면 창은 처음부터다', async () => {
    const r = judgeRig({ config: SHORT });
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    await r.tick();
    r.clock.advance(1_000);
    r.setLeader(false);
    await r.tick();
    r.setLeader(true);
    r.clock.advance(2_000);
    await r.tick();
    expect(r.store.rows.get('TOSS')!.stage).toBe('PROBING');
  });

  test('P-T43_틀린 구현: 리더를 잃으면 창을 버려서 다시 얻은 뒤 옛 표본으로 시험 재개에 가지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = judgeRig({ config: SHORT });
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    for (let i = 0; i < 3; i += 1) {
      await r.tick();
      r.clock.advance(1_000);
    }
    r.setLeader(false);
    await r.tick();
    r.setLeader(true);
    await r.tick();
    expect(r.store.writes).toEqual([]);
  });

  test('P-T43_stop 뒤의 틱은 돌지 않는다', async () => {
    const r = judgeRig();
    await r.judge.stop();
    await r.tick();
    expect(r.store.readers).toEqual([]);
  });

  test('P-T43_리뷰 고침 H4: 앞 표본에 답을 기다리는 호출이 있으면 판정을 미루고 5초가 지나면 실패로 센다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = judgeRig();
    r.store.rows.set('TOSS', record({ stage: 'TRIAL', trialStartedAtMs: NOW - MIN }));
    const done = { firstResult: 'APPROVED', firstCallMs: 100, firstCallAtMs: NOW - 10 * SEC } as const;
    r.store.trials = [done, { firstCallAtMs: NOW - 1 }, { firstCallAtMs: NOW - 1 }, ...Array.from({ length: D.trialSampleSize - 3 }, () => done)];
    await r.tick();
    expect(r.store.writes).toEqual([]);
    r.clock.advance(5 * SEC);
    await r.tick();
    expect(r.store.rows.get('TOSS')!.stage).toBe('PROBING');
  });

  test('P-T43_리뷰 고침 H4: 10분 예외도 같은 방식으로 센다(답을 기다리면 미루고, 5초가 지나면 실패다) [ASVS v5.0.0-16.5.3]', async () => {
    const r = judgeRig({ config: SHORT });
    r.store.rows.set('TOSS', record({ stage: 'TRIAL', trialStartedAtMs: NOW - D.trialMaxMs }));
    r.store.trials = [{ firstCallAtMs: NOW - 1 }];
    await r.tick();
    expect(r.store.writes).toEqual([]);
    r.store.trials = [{ firstResult: 'FAILED', firstCallMs: 1, firstCallAtMs: NOW - 1 }, { firstCallAtMs: NOW - 1 }];
    r.clock.advance(5 * SEC);
    await r.tick();
    expect(r.store.rows.get('TOSS')!.stage).toBe('PROBING');
  });

  test('P-T43_리뷰 고침 M7: 판정자가 바뀐 뒤 10분이 지나도 창이 차기 전에는 돌려보내지 않고, 차면 연다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = judgeRig({ config: SHORT });
    r.store.rows.set('TOSS', record({ stage: 'TRIAL', trialStartedAtMs: NOW - 11 * MIN }));
    await r.tick();
    expect(r.store.writes).toEqual([]);
    for (let i = 0; i < 4; i += 1) {
      r.clock.advance(1_000);
      await r.tick();
      if (r.store.rows.get('TOSS')!.stage === 'OPEN') break;
    }
    expect(r.store.rows.get('TOSS')!.stage).toBe('OPEN');
  });
});

describe('EntryPauseReleaseWatcher: 사람이 푼 해제를 파드 서킷에 알린다', () => {
  const rowOf = (o: Partial<EntryPauseRow>): EntryPauseRow => ({ pg: 'TOSS', stage: 'OPEN', reason: 'PG_FAILURE', sinceMs: NOW - MIN, version: 2, ...o });
  const pausesOf = (...rows: EntryPauseRow[]): EntryPauses => new Map(rows.map((row) => [row.pg, row]));
  const rig = () => {
    const closed: PgName[] = [];
    return { closed, watcher: new EntryPauseReleaseWatcher({ closeCircuit: (pg) => void closed.push(pg) }) };
  };

  test('P-T43_리뷰 고침 M5: 첫 읽기는 기록만 한다(파드가 새로 떴을 때 오래된 해제로 닫지 않는다) [ASVS v5.0.0-16.5.3]', () => {
    const r = rig();
    r.watcher.observe(pausesOf(rowOf({ actor: 'cmd-1', reopenedAtMs: NOW - MIN })));
    expect(r.closed).toEqual([]);
  });

  test('P-T43_리뷰 고침 M5: 사람이 푼 새 시각을 보면 그 결제사 서킷을 한 번만 닫는다 [ASVS v5.0.0-16.5.3]', () => {
    const r = rig();
    r.watcher.observe(pausesOf(rowOf({ actor: 'cmd-1', reopenedAtMs: NOW - MIN })));
    r.watcher.observe(pausesOf(rowOf({ actor: 'cmd-2', reopenedAtMs: NOW }), rowOf({ pg: 'PORTONE', stage: 'PROBING', actor: 'SYSTEM' })));
    r.watcher.observe(pausesOf(rowOf({ actor: 'cmd-2', reopenedAtMs: NOW })));
    expect(r.closed).toEqual(['TOSS']);
  });

  test('P-T43_리뷰 고침 M5: 첫 읽기에 행이 없던 결제사의 해제도 닫는다', () => {
    const r = rig();
    r.watcher.observe(pausesOf());
    r.watcher.observe(pausesOf(rowOf({ actor: 'cmd-1', reopenedAtMs: NOW })));
    expect(r.closed).toEqual(['TOSS']);
  });

  test('P-T43_리뷰 고침 M5: 자동으로 연 행(SYSTEM)으로는 닫지 않는다 [ASVS v5.0.0-16.5.3]', () => {
    const r = rig();
    r.watcher.observe(pausesOf());
    r.watcher.observe(pausesOf(rowOf({ actor: 'SYSTEM', reopenedAtMs: NOW })));
    expect(r.closed).toEqual([]);
  });

  test('P-T43_리뷰 고침 M5: 닫기가 던져도 읽기를 막지 않고 같은 값으로 다시 하지 않는다', () => {
    let calls = 0;
    const watcher = new EntryPauseReleaseWatcher({
      closeCircuit: () => {
        calls += 1;
        throw new Error('닫기 실패');
      },
    });
    const human = pausesOf(rowOf({ actor: 'cmd-1', reopenedAtMs: NOW }));
    watcher.observe(pausesOf());
    expect(() => watcher.observe(human)).not.toThrow();
    watcher.observe(human);
    expect(calls).toBe(1);
  });

  test('P-T43_리뷰 고침 M5: 캐시는 저장소에서 읽은 행을 알리고, 캐시로 답한 호출과 실패한 읽기는 알리지 않는다', async () => {
    const clock = fakeClock({ now: NOW });
    const seen: EntryPauses[] = [];
    let fail = false;
    const rows: EntryPauses = pausesOf(rowOf({ actor: 'cmd-1', reopenedAtMs: NOW }));
    const cached = new CachedEntryPauseReader({
      reader: {
        read: async () => {
          if (fail) throw new Error('읽기 실패');
          return rows;
        },
      },
      clock,
      signals: { entryPauseReadFailed: () => undefined },
      onLoaded: (p) => void seen.push(p),
    });
    await cached.read();
    await cached.read();
    expect(seen).toEqual([rows]);
    fail = true;
    clock.advance(2_000);
    await cached.read();
    expect(seen).toEqual([rows]);
  });

  test('P-T43_리뷰 고침 M5: 알림이 던져도 읽기는 값을 돌려준다', async () => {
    const rows: EntryPauses = pausesOf(rowOf({}));
    const cached = new CachedEntryPauseReader({
      reader: { read: async () => rows },
      clock: fakeClock({ now: NOW }),
      signals: { entryPauseReadFailed: () => undefined },
      onLoaded: () => {
        throw new Error('알림 실패');
      },
    });
    await expect(cached.read()).resolves.toBe(rows);
  });

  test('P-T43_리뷰 고침 M5: 보호기는 자기 서킷을 닫고, 실제 차단기는 열린 상태에서 닫힌다', async () => {
    const circuit = new FakeCircuit();
    circuit.current = 'open';
    const gateway = new FakeGateway('TOSS');
    const registry: PaymentGateways = { of: () => gateway as unknown as PaymentGatewayPort };
    const guards = new PgCallGuards({ gateways: registry, podCount: 1, clock: fakeClock({ now: NOW }), signals: { throttled: () => undefined, limit: () => undefined, inflight: () => undefined, saturated: () => undefined }, log: { throttledFirst: () => undefined }, circuits: { of: () => circuit } });
    guards.of('TOSS')!.closeCircuit();
    expect(circuit.current).toBe('closed');

    const clock = fakeClock({ now: NOW });
    const real = new BreakerPgCircuit('TOSS', { service: 'payment-svc', clock, overrides: { minCalls: 2, failureRatePercent: 50 } });
    for (let i = 0; i < 2; i += 1) await real.run(async () => Promise.reject(new Error('장애')), () => false, 'confirm').catch(() => undefined);
    expect(real.state()).toBe('open');
    real.close();
    expect(real.state()).toBe('closed');
    await expect(real.run(async () => 'ok', () => false, 'confirm')).resolves.toBe('ok');
    real.shutdown();
  });
});

describe('ReleaseEntryPause: 명령 6 해제', () => {
  const rig = () => {
    const clock = fakeClock({ now: NOW });
    const store = new FakeStore();
    const released: unknown[] = [];
    const conflicts: PgName[] = [];
    const transitions: unknown[] = [];
    const uc = new ReleaseEntryPause({ store, clock, log: { released: (e) => void released.push(e), transition: (e) => void transitions.push(e) }, signals: { writeConflict: (pg) => void conflicts.push(pg) } });
    return { clock, store, uc, released, conflicts, transitions };
  };
  const input = { pg: 'TOSS', actor: 'cmd-1', reason: '확인 호출 경로만 고장 났다' };

  test('P-T43_행이 없으면 쓰지 않고 이미 열림이다(멱등)', async () => {
    const r = rig();
    await expect(r.uc.execute(input)).resolves.toEqual({ kind: 'ALREADY_OPEN' });
    expect(r.store.writes).toEqual([]);
  });

  test('P-T43_OPEN이면 쓰지 않고 이미 열림이다(멱등)', async () => {
    const r = rig();
    r.store.rows.set('TOSS', record());
    await expect(r.uc.execute(input)).resolves.toEqual({ kind: 'ALREADY_OPEN' });
    expect(r.store.writes).toEqual([]);
  });

  test.each<[string, Partial<EntryPauseRecord>]>([
    ['확인 호출 중', { stage: 'PROBING' }],
    ['시험 재개 중', { stage: 'TRIAL', trialStartedAtMs: NOW - MIN }],
    ['상한 정지 중', { stage: 'PROBING', reason: 'CHANNEL_WAIT' }],
  ])('P-T43_%s에도 바로 연다: actor·reopened_at을 쓰고 시험 시작 시각을 비운다', async (_name, o) => {
    const r = rig();
    r.store.rows.set('TOSS', record({ sinceMs: NOW - 9 * MIN, version: 4, ...o }));
    await expect(r.uc.execute(input)).resolves.toEqual({ kind: 'RELEASED' });
    const row = r.store.rows.get('TOSS')!;
    expect(row).toMatchObject({ stage: 'OPEN', actor: 'cmd-1', reopenedAtMs: NOW, sinceMs: NOW - 9 * MIN, version: 5 });
    expect(row.trialStartedAtMs).toBeUndefined();
    expect(r.released).toEqual([{ pg: 'TOSS', actor: 'cmd-1' }]);
  });

  test('P-T43_겨루어 지면 다시 읽어 2회 더 해 본다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = rig();
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    r.store.conflictsLeft = 2;
    await expect(r.uc.execute(input)).resolves.toEqual({ kind: 'RELEASED' });
    expect(r.store.writes).toHaveLength(3);
    expect(r.conflicts).toEqual(['TOSS', 'TOSS']);
  });

  test('P-T43_3번 모두 지면 겨룸으로 답한다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = rig();
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    r.store.conflictsLeft = 3;
    await expect(r.uc.execute(input)).resolves.toEqual({ kind: 'CONFLICT' });
    expect(r.store.writes).toHaveLength(3);
    expect(r.released).toEqual([]);
  });

  test('P-T43_입력이 틀리면 읽지 않는다 [ASVS v5.0.0-2.2.1]', async () => {
    const r = rig();
    await expect(r.uc.execute({ ...input, pg: 'NICE' })).rejects.toBeInstanceOf(PaymentInputError);
    expect(r.store.readers).toEqual([]);
  });

  test('P-T43_사유 글은 로그에 남기지 않는다 [ASVS v5.0.0-16.2.5]', async () => {
    const r = rig();
    r.store.rows.set('TOSS', record({ stage: 'PROBING' }));
    await r.uc.execute(input);
    expect(JSON.stringify([r.released, r.transitions])).not.toContain('확인 호출 경로만');
  });
});

describe('PrepareCheckout: 시험 재개 받기', () => {
  const ORDER = '11111111-1111-7111-8111-111111111111';
  const trialRow: EntryPauseRow = { pg: 'TOSS', stage: 'TRIAL', reason: 'PG_FAILURE', sinceMs: NOW, version: 2 };
  const gateway = {
    pg: 'TOSS' as const,
    capabilities: (): PgCapabilities => ({ serverConfirm: true, confirmDeadlineMs: 600_000, partialCancel: true, webhookSignature: false, idempotencyRetentionMs: 1, callsPerSecond: 10, redirectCheckout: true }),
    checkout: () => ({ toss: { clientKey: 'ck', customerKey: 'c', orderId: ORDER, orderName: 'x', amount: 1, successUrl: 'https://x/s', failUrl: 'https://x/f' } }),
  } as unknown as PaymentGatewayPort;

  const rig = (o: { draw?: number; realDraw?: boolean; admitted?: boolean; failAdmit?: boolean; pauses?: EntryPauses } = {}) => {
    const admits: [string, PgName, number][] = [];
    const draws: [string, number][] = [];
    const outcomes: [PgName, EntryTrialOutcome][] = [];
    const failed: string[] = [];
    const prepared: string[] = [];
    const admittedReads: string[] = [];
    const registry = { of: (pg: PgName) => (pg === 'TOSS' ? gateway : undefined) };
    const uc = new PrepareCheckout({
      selection: { read: async () => ({}) },
      pauses: { read: async () => o.pauses ?? new Map([['TOSS', trialRow]]) },
      trials: {
        isAdmitted: async (orderId) => {
          admittedReads.push(orderId);
          return o.admitted === true;
        },
        admit: async (orderId, pg, nowMs) => {
          if (o.failAdmit === true) throw new Error('쓰기 실패');
          admits.push([orderId, pg, nowMs]);
        },
      },
      ...(o.realDraw === true
        ? {}
        : {
            drawEntryTrial: (orderId: string, version: number) => {
              draws.push([orderId, version]);
              return o.draw ?? 9_999;
            },
          }),
      trialSignals: { trial: (pg, outcome) => void outcomes.push([pg, outcome]), trialWriteFailed: (step) => void failed.push(step) },
      gateways: registry,
      channels: channelTableOf(registry),
      defaults: { primary: 'TOSS' },
      webOrigin: 'https://www.example',
      virtualAccountReady: true,
      clock: fakeClock({ now: NOW }),
      log: { pgUnavailable: () => undefined, methodUnsupported: () => undefined },
      signals: { prepared: (_pg, outcome) => void prepared.push(outcome) },
    });
    const raw = { orderKind: 'TICKET', orderId: ORDER, attemptId: ORDER, eventId: ORDER, amount: 1000, orderName: '공연', payMethod: 'CARD' } as never;
    return { uc, raw, admits, draws, outcomes, failed, prepared, admittedReads };
  };

  test('P-T43_리뷰 고침 H1: 추첨값 499는 받아 행을 쓰고 통과한다(주입한 함수에 주문과 판 번호를 준다) [ASVS v5.0.0-2.3.2]', async () => {
    const r = rig({ draw: 499 });
    await expect(r.uc.execute(r.raw)).resolves.toMatchObject({ pg: 'TOSS' });
    expect(r.draws).toEqual([[ORDER, trialRow.version]]);
    expect(r.admits).toEqual([[ORDER, 'TOSS', NOW]]);
    expect(r.outcomes).toEqual([['TOSS', 'admitted']]);
  });

  test('P-T43_리뷰 고침 H1: 추첨값 500은 받지 않고 503이다 [ASVS v5.0.0-2.3.2]', async () => {
    const r = rig({ draw: 500 });
    await expect(r.uc.execute(r.raw)).rejects.toBeInstanceOf(PaymentNewPausedError);
    expect(r.admits).toEqual([]);
    expect(r.outcomes).toEqual([['TOSS', 'rejected']]);
    expect(r.prepared).toEqual(['new_payment_paused']);
  });

  test('P-T43_리뷰 고침 H1: 떨어진 주문은 시험 행을 읽거나 쓰지 않는다 [ASVS v5.0.0-2.3.2]', async () => {
    const r = rig({ draw: 500, admitted: true });
    await expect(r.uc.execute(r.raw)).rejects.toBeInstanceOf(PaymentNewPausedError);
    expect(r.admittedReads).toEqual([]);
    expect(r.admits).toEqual([]);
  });

  test('P-T43_틀린 구현: 추첨 함수를 주입하지 않으면 난수가 아니라 주문과 판 번호의 해시로 뽑는다(재호출로 다시 뽑히지 않는다) [ASVS v5.0.0-2.3.2]', async () => {
    randomIntCalls.length = 0;
    const r = rig({ realDraw: true });
    const admits = admitsEntryTrial(createHash('sha256').update(`${ORDER}:${trialRow.version}`).digest().readUInt32BE(0) % 10_000);
    const answer = await r.uc.execute(r.raw).then(
      () => 'passed',
      () => 'paused',
    );
    expect(answer).toBe(admits ? 'passed' : 'paused');
    expect(randomIntCalls).toEqual([]);
  });

  test('P-T43_리뷰 고침 H1: 같은 주문을 200번 다시 불러도 답이 같다(Retry-After로 뚫리지 않는다) [ASVS v5.0.0-2.3.2]', async () => {
    const r = rig({ realDraw: true });
    const answers = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      answers.add(
        await r.uc.execute(r.raw).then(
          () => 'passed',
          () => 'paused',
        ),
      );
    }
    expect(answers.size).toBe(1);
  });

  test('P-T43_이미 받은 주문은 다시 받지 않는다(행을 다시 쓰지 않고 admitted를 다시 세지 않는다) [ASVS v5.0.0-2.3.2]', async () => {
    const r = rig({ draw: 0, admitted: true });
    await expect(r.uc.execute(r.raw)).resolves.toMatchObject({ pg: 'TOSS' });
    expect(r.admits).toEqual([]);
    expect(r.outcomes).toEqual([]);
  });

  test('P-T43_쓰기가 실패하면 받지 않고 503이다(받았는데 세지 못하는 일을 만들지 않는다) [ASVS v5.0.0-16.5.3]', async () => {
    const r = rig({ draw: 0, failAdmit: true });
    await expect(r.uc.execute(r.raw)).rejects.toBeInstanceOf(PaymentNewPausedError);
    expect(r.failed).toEqual(['admit']);
    expect(r.outcomes).toEqual([]);
  });

  test('P-T43_PROBING은 추첨하지 않는다 [ASVS v5.0.0-2.3.2]', async () => {
    const r = rig({ draw: 0, pauses: new Map([['TOSS', { ...trialRow, stage: 'PROBING' }]]) });
    await expect(r.uc.execute(r.raw)).rejects.toBeInstanceOf(PaymentNewPausedError);
    expect(r.draws).toEqual([]);
  });
});

describe('PaymentConfirmRunner: 첫 승인 결과 쓰기', () => {
  const pausedCache = (stage: 'PROBING' | 'TRIAL' | 'OPEN' | 'none') => ({
    read: async (): Promise<EntryPauses> => (stage === 'none' ? new Map() : new Map([['SIMULATOR', { pg: 'SIMULATOR', stage, reason: 'PG_FAILURE', sinceMs: NOW, version: 1 } as EntryPauseRow]])),
  });
  const target: ConfirmTarget = { paymentId: 'p1', orderId: 'o1', eventId: 'e1', attemptId: 'a1', attemptNo: 1, pg: 'SIMULATOR', paymentRef: 'ref', amount: 1000, authenticatedAtMs: NOW - 1000, confirmSent: false, status: 'ACCEPTED' } as unknown as ConfirmTarget;
  const job = (over: Partial<ConfirmJob> = {}): ConfirmJob => ({ paymentId: 'p1', pg: 'SIMULATOR', owner: 'pod', leaseUntilMs: NOW + 75_000, attempts: 0, hadPreviousOwner: false, ...over }) as ConfirmJob;

  const rig = (answer: ConfirmResult | Error, o: { stage?: 'PROBING' | 'TRIAL' | 'OPEN' | 'none'; failRecord?: boolean; failFirstCall?: boolean; recorded?: boolean; sentBefore?: boolean } = {}) => {
    const clock = fakeClock({ now: NOW });
    const writes: [string, unknown][] = [];
    const firstCalls: [string, number][] = [];
    const events: string[] = [];
    const outcomes: [PgName, EntryTrialOutcome][] = [];
    const failed: string[] = [];
    const finishes: ConfirmFinish[] = [];
    const gateway = {
      pg: 'SIMULATOR' as const,
      capabilities: (): PgCapabilities => ({ serverConfirm: true, confirmDeadlineMs: 600_000, partialCancel: true, webhookSignature: false, idempotencyRetentionMs: 1, callsPerSecond: 100, redirectCheckout: true }),
      confirm: async () => {
        events.push('confirm');
        clock.advance(123);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    } as unknown as PaymentGatewayPort;
    const gateways: PaymentGateways = { of: (pg) => (pg === 'SIMULATOR' ? gateway : undefined) };
    const guards = new PgCallGuards({ gateways, podCount: 1, clock, signals: { throttled: () => undefined, limit: () => undefined, inflight: () => undefined, saturated: () => undefined }, log: { throttledFirst: () => undefined } });
    const jobs = {
      claimDue: async () => [],
      claimExpired: async () => [],
      hasDue: async () => false,
      read: async () => ({ ...target, ...(o.sentBefore === true ? { confirmSent: true } : {}) }),
      markSent: async () => (o.sentBefore === true ? 'ALREADY' : 'MARKED'),
      finish: async (_t: ConfirmTarget, f: ConfirmFinish) => (events.push('finish'), finishes.push(f), 'APPLIED'),
      reschedule: async () => true,
      dropJob: async () => true,
      release: async () => true,
    };
    const runner = new PaymentConfirmRunner({
      jobs: jobs as never,
      gateways,
      guards,
      log: { amountMismatch: () => undefined, noAdapter: () => undefined, writeFailed: () => undefined, staleAnswer: () => undefined, runError: () => undefined, pgError: () => undefined },
      signals: { outcome: () => undefined, declined: () => undefined, callSeconds: () => undefined, inFlight: () => undefined, writeFailure: () => undefined },
      clock,
      podId: 'pod',
      timer: { setInterval: () => 0, clearInterval: () => undefined },
      trialResults: {
        recordFirstCall: async (orderId, atMs) => {
          events.push('first_call');
          if (o.failFirstCall === true) throw new Error('쓰기 실패');
          firstCalls.push([orderId, atMs]);
          return true;
        },
        recordFirstResult: async (orderId, result) => {
          events.push('result');
          if (o.failRecord === true) throw new Error('쓰기 실패');
          writes.push([orderId, result]);
          return o.recorded !== false;
        },
      },
      pauses: pausedCache(o.stage ?? 'TRIAL'),
      trialSignals: { trial: (pg, outcome) => void outcomes.push([pg, outcome]), trialWriteFailed: (step) => void failed.push(step) },
    });
    return { runner, writes, firstCalls, events, outcomes, failed, finishes };
  };
  const approved: ConfirmResult = { outcome: 'APPROVED', paymentRef: 'ref', amount: 1000, approvedAt: '2026-11-09T03:00:00.000Z' };

  test('P-T43_첫 승인 호출의 결과와 호출 시간을 쓴다', async () => {
    const r = rig(approved);
    await r.runner.runJob(job());
    expect(r.writes).toEqual([['o1', { firstResult: 'APPROVED', atMs: NOW + 123, callMs: 123 }]]);
    expect(r.outcomes).toEqual([['SIMULATOR', 'success']]);
  });

  test('P-T43_거절도 결론이라 success로 센다', async () => {
    const r = rig({ outcome: 'DECLINED', paymentRef: 'ref', failureCategory: 'CARD_DECLINED' });
    await r.runner.runJob(job());
    expect(r.writes[0]![1]).toMatchObject({ firstResult: 'DECLINED' });
    expect(r.outcomes).toEqual([['SIMULATOR', 'success']]);
  });

  test('P-T43_일시 장애는 FAILED이고 failure로 센다', async () => {
    const r = rig({ outcome: 'UNKNOWN', paymentRef: 'ref', outage: true });
    await r.runner.runJob(job());
    expect(r.writes[0]![1]).toMatchObject({ firstResult: 'FAILED' });
    expect(r.outcomes).toEqual([['SIMULATOR', 'failure']]);
  });

  test('P-T43_호출이 던지면 UNKNOWN이다', async () => {
    const r = rig(new Error('연결 끊김'));
    await r.runner.runJob(job());
    expect(r.writes[0]![1]).toMatchObject({ firstResult: 'UNKNOWN' });
  });

  test('P-T43_재시도 큐 건은 쓰지 않는다 [ASVS v5.0.0-2.3.2]', async () => {
    const r = rig(approved);
    await r.runner.runJob(job({ queued: true }));
    expect(r.writes).toEqual([]);
  });

  test('P-T43_틀린 구현: 서킷이 끊어 부르지 않은 승인은 첫 결과로 쓰지 않는다 [ASVS v5.0.0-2.3.2]', async () => {
    const r = rig(new PgCircuitOpenError());
    await r.runner.runJob(job());
    expect(r.writes).toEqual([]);
    expect(r.outcomes).toEqual([]);
  });

  test('P-T43_재전송은 쓰지 않는다 [ASVS v5.0.0-2.3.2]', async () => {
    const r = rig(approved, { sentBefore: true });
    await r.runner.runJob(job());
    expect(r.writes).toEqual([]);
  });

  test.each<['OPEN' | 'none']>([['OPEN'], ['none']])('P-T43_캐시가 열림(%s)으로 보면 문장을 내지 않는다', async (stage) => {
    const r = rig(approved, { stage });
    await r.runner.runJob(job());
    expect(r.writes).toEqual([]);
    expect(r.firstCalls).toEqual([]);
    expect(r.finishes).toHaveLength(1);
  });

  test('P-T43_리뷰 고침 H4: 첫 승인 호출을 시작할 때 시작 시각을 먼저 쓴다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = rig(approved);
    await r.runner.runJob(job());
    expect(r.firstCalls).toEqual([['o1', NOW]]);
    expect(r.events.indexOf('first_call')).toBeLessThan(r.events.indexOf('confirm'));
  });

  test.each<[string, Parameters<typeof rig>[1], Partial<ConfirmJob>]>([
    ['재시도 큐 건', {}, { queued: true }],
    ['재전송', { sentBefore: true }, {}],
    ['TRIAL이 아닌 정지(PROBING)', { stage: 'PROBING' }, {}],
  ])('P-T43_리뷰 고침 H4: %s은 시작 시각을 쓰지 않는다 [ASVS v5.0.0-2.3.2]', async (_name, options, over) => {
    const r = rig(approved, options);
    await r.runner.runJob(job(over));
    expect(r.firstCalls).toEqual([]);
  });

  test('P-T43_리뷰 고침 H4: 시작 시각 쓰기가 실패해도 호출은 그대로 나가고 지표만 오른다 [ASVS v5.0.0-16.5.2]', async () => {
    const r = rig(approved, { failFirstCall: true });
    await expect(r.runner.runJob(job())).resolves.toMatchObject({ kind: 'FINISHED', status: 'APPROVED' });
    expect(r.events).toContain('confirm');
    expect(r.failed).toEqual(['call']);
  });

  test('P-T43_리뷰 고침 L9: 결과 쓰기는 정지 캐시가 TRIAL일 때만 한다 [ASVS v5.0.0-2.3.2]', async () => {
    const r = rig(approved, { stage: 'PROBING' });
    await r.runner.runJob(job());
    expect(r.writes).toEqual([]);
    expect(r.finishes).toHaveLength(1);
  });

  test('P-T43_리뷰 고침 L9: 결과 쓰기는 원장을 확정한 뒤에 한다(늦어도 승인 확정을 늦추지 않는다) [ASVS v5.0.0-16.5.2]', async () => {
    const r = rig(approved);
    await r.runner.runJob(job());
    expect(r.events.filter((e) => e === 'finish' || e === 'result')).toEqual(['finish', 'result']);
  });

  test('P-T43_시험 행이 없으면 지표를 세지 않는다', async () => {
    const r = rig(approved, { recorded: false });
    await r.runner.runJob(job());
    expect(r.outcomes).toEqual([]);
  });

  test('P-T43_쓰기가 실패해도 승인 흐름은 그대로이고 지표만 오른다 [ASVS v5.0.0-16.5.2]', async () => {
    const r = rig(approved, { failRecord: true });
    await expect(r.runner.runJob(job())).resolves.toMatchObject({ kind: 'FINISHED', status: 'APPROVED' });
    expect(r.failed).toEqual(['result']);
    expect(r.finishes).toHaveLength(1);
  });
});

describe('PrometheusEntryPauseInputs', () => {
  const ok = (result: unknown) => new Response(JSON.stringify({ status: 'success', data: { result } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const series = (value: string) => [{ metric: {}, value: [1, value] }];

  const rig = (answers: (expr: string) => Response | Promise<Response>) => {
    const queries: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const expr = url.searchParams.get('query') ?? '';
      queries.push(expr);
      return answers(expr);
    }) as typeof fetch;
    return { inputs: new PrometheusEntryPauseInputs({ baseUrl: 'http://prometheus.test:9090', fetchImpl }), queries };
  };
  const healthy = (expr: string): Response => {
    if (expr.includes('_count{')) return ok(series('120'));
    if (expr.startsWith('sum(')) return ok(series('1'));
    if (expr.startsWith('count(')) return ok(series('4'));
    if (expr.startsWith('max(timestamp')) return ok(series('1762657200'));
    return ok(series('6.5'));
  };

  test('P-T43_값을 모아 돌려준다', async () => {
    const r = rig(healthy);
    await expect(r.inputs.read('TOSS', { p99WindowMs: MIN })).resolves.toEqual({ openPods: 1, readyPods: 4, sampledAtMs: 1_762_657_200_000, p99Seconds: 6.5, p99Samples: 120 });
  });

  test('P-T43_리뷰 고침 H2: 같은 창의 direct 표본 수(_count 증가량)를 함께 읽는다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = rig(healthy);
    await r.inputs.read('TOSS', { p99WindowMs: 30_000 });
    const samples = r.queries.find((q) => q.includes('_count{'))!;
    expect(samples).toContain('increase(payment_confirm_resolution_seconds_count{pg="TOSS",path="direct"}[30s])');
  });

  test('P-T43_리뷰 고침 H2: 표본 수가 비면 p99는 있고 표본 수만 없다(판정이 표본 없음으로 본다)', async () => {
    const r = rig((expr) => (expr.includes('_count{') ? ok([]) : healthy(expr)));
    await expect(r.inputs.read('TOSS', { p99WindowMs: MIN })).resolves.toEqual({ openPods: 1, readyPods: 4, sampledAtMs: 1_762_657_200_000, p99Seconds: 6.5 });
  });

  test('P-T43_리뷰 고침 H2: p99를 묻지 않으면 표본 수도 묻지 않는다', async () => {
    const r = rig(healthy);
    await r.inputs.read('TOSS', {});
    expect(r.queries.some((q) => q.includes('_count{'))).toBe(false);
  });

  test('P-T43_재시도 큐 건을 뺀 PromQL이다(path="direct") [ASVS v5.0.0-16.5.3]', async () => {
    const r = rig(healthy);
    await r.inputs.read('TOSS', { p99WindowMs: 30_000 });
    const p99 = r.queries.find((q) => q.includes('histogram_quantile'))!;
    expect(p99).toContain('payment_confirm_resolution_seconds_bucket{pg="TOSS",path="direct"}');
    expect(p99).toContain('[30s]');
    expect(p99).not.toContain('retry_queue');
  });

  test('P-T43_서킷 수는 준비된 파드로 고른다', async () => {
    const r = rig(healthy);
    await r.inputs.read('PORTONE', {});
    const open = r.queries.find((q) => q.startsWith('sum('))!;
    expect(open).toContain('payment_pg_circuit_open{pg="PORTONE"}');
    expect(open).toContain('kube_pod_status_ready{condition="true"} == 1');
    expect(r.queries.some((q) => q.includes('histogram_quantile'))).toBe(false);
  });

  test('P-T43_p99 표본이 없으면 입력은 있고 p99는 없다(NaN·빈 결과) [ASVS v5.0.0-16.5.3]', async () => {
    for (const blank of [() => ok(series('NaN')), () => ok([])]) {
      const r = rig((expr) => (expr.includes('histogram_quantile') ? blank() : healthy(expr)));
      const got = await r.inputs.read('TOSS', { p99WindowMs: MIN });
      expect(got).toEqual({ openPods: 1, readyPods: 4, sampledAtMs: 1_762_657_200_000 });
    }
  });

  test.each<[string, (expr: string) => Response]>([
    ['서킷 값이 비면', (expr) => (expr.startsWith('sum(') ? ok([]) : healthy(expr))],
    ['파드 수가 비면', (expr) => (expr.startsWith('count(') ? ok([]) : healthy(expr))],
    ['표본 시각이 비면', (expr) => (expr.startsWith('max(timestamp') ? ok([]) : healthy(expr))],
    ['p99 조회가 실패하면', (expr) => (expr.includes('histogram_quantile') ? new Response('{}', { status: 503 }) : healthy(expr))],
    ['리뷰 고침 H2: 표본 수 조회가 실패하면', (expr) => (expr.includes('_count{') ? new Response('{}', { status: 503 }) : healthy(expr))],
    ['status가 success가 아니면', () => new Response(JSON.stringify({ status: 'error' }), { status: 200 })],
  ])('P-T43_%s 입력 없음이다 [ASVS v5.0.0-16.5.3]', async (_name, answers) => {
    await expect(rig(answers).inputs.read('TOSS', { p99WindowMs: MIN })).resolves.toBeUndefined();
  });

  test('P-T43_fetch가 던져도 던지지 않고 입력 없음이다 [ASVS v5.0.0-16.5.2]', async () => {
    const fetchImpl = (async () => {
      throw new Error('연결 실패');
    }) as typeof fetch;
    await expect(new PrometheusEntryPauseInputs({ baseUrl: 'http://prometheus.test:9090', fetchImpl }).read('TOSS', {})).resolves.toBeUndefined();
  });

  test('P-T43_주소가 틀리면 만들 때 던진다', () => {
    expect(() => new PrometheusEntryPauseInputs({ baseUrl: 'ftp://prometheus.test' })).toThrow();
  });

  test('P-T43_주소 설정이 없으면 언제나 입력 없음이다', async () => {
    await expect(NO_ENTRY_PAUSE_CLUSTER_INPUTS.read('TOSS', { p99WindowMs: MIN })).resolves.toBeUndefined();
  });
});

describe('PromEntryPauseSignals', () => {
  const pausesOf = (pg: PgName, stage: 'OPEN' | 'PROBING' | 'TRIAL'): EntryPauses => new Map([[pg, { pg, stage, reason: 'PG_FAILURE', sinceMs: NOW, version: 1 }]]);

  test('P-T43_지표를 미리 0으로 보이고 단계는 캐시한 행에서 낸다(열림도 0)', async () => {
    const metrics = new PlatformMetrics('payment-svc');
    const signals = new PromEntryPauseSignals().register(metrics.registry, { read: async () => pausesOf('TOSS', 'TRIAL') });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/payment_new_entry_pause_stage\{pg="TOSS"\} 2/);
    expect(text).toMatch(/payment_new_entry_pause_stage\{pg="PORTONE"\} 0/);
    for (const outcome of ['ok', 'fail', 'skipped']) expect(text).toContain(`payment_pg_probe_total{pg="TOSS",outcome="${outcome}"} 0`);
    for (const outcome of ['admitted', 'rejected', 'success', 'failure']) expect(text).toContain(`payment_entry_trial_total{pg="SIMULATOR",outcome="${outcome}"} 0`);
    expect(text).toContain('payment_entry_pause_write_conflicts_total{pg="TOSS"} 0');
    signals.probe('TOSS', 'ok');
    signals.writeConflict('TOSS');
    signals.judgeError('read');
    signals.trial('TOSS', 'admitted');
    signals.trialWriteFailed('result');
    const after = await metrics.registry.metrics();
    expect(after).toContain('payment_pg_probe_total{pg="TOSS",outcome="ok"} 1');
    expect(after).toContain('payment_entry_pause_write_conflicts_total{pg="TOSS"} 1');
    expect(after).toContain('payment_entry_pause_judge_errors_total{what="read"} 1');
    expect(after).toContain('payment_entry_trial_total{pg="TOSS",outcome="admitted"} 1');
    expect(after).toContain('payment_entry_trial_write_failed_total{step="result"} 1');
  });

  test('P-T43_리뷰 고침 M8: 판정자 표시는 처음 0이고 리더가 되면 1, 잃으면 0이다(라벨 없음) [ASVS v5.0.0-16.5.3]', async () => {
    const metrics = new PlatformMetrics('payment-svc');
    const signals = new PromEntryPauseSignals().register(metrics.registry, { read: async () => new Map() });
    expect(await metrics.registry.metrics()).toMatch(/^payment_entry_pause_judge_leader 0$/m);
    signals.judgeLeader(true);
    expect(await metrics.registry.metrics()).toMatch(/^payment_entry_pause_judge_leader 1$/m);
    signals.judgeLeader(false);
    expect(await metrics.registry.metrics()).toMatch(/^payment_entry_pause_judge_leader 0$/m);
  });

  test('P-T43_리뷰 고침 H4: 시작 시각 쓰기 실패도 센다', async () => {
    const metrics = new PlatformMetrics('payment-svc');
    const signals = new PromEntryPauseSignals().register(metrics.registry, { read: async () => new Map() });
    expect(await metrics.registry.metrics()).toContain('payment_entry_trial_write_failed_total{step="call"} 0');
    signals.trialWriteFailed('call');
    expect(await metrics.registry.metrics()).toContain('payment_entry_trial_write_failed_total{step="call"} 1');
  });

  test('P-T43_확인 호출 단계는 1이다', async () => {
    const metrics = new PlatformMetrics('payment-svc');
    new PromEntryPauseSignals().register(metrics.registry, { read: async () => pausesOf('TOSS', 'PROBING') });
    expect(await metrics.registry.metrics()).toMatch(/payment_new_entry_pause_stage\{pg="TOSS"\} 1/);
  });

  test('P-T43_행을 읽지 못하면 값을 내지 않는다(모름, 0으로 쓰지 않는다) [ASVS v5.0.0-16.5.3]', async () => {
    const metrics = new PlatformMetrics('payment-svc');
    new PromEntryPauseSignals().register(metrics.registry, {
      read: async () => {
        throw new Error('읽기 실패');
      },
    });
    expect(await metrics.registry.metrics()).not.toMatch(/payment_new_entry_pause_stage\{/);
  });
});

describe('entryPauseLog', () => {
  const rig = () => {
    const lines: [string, Record<string, unknown>][] = [];
    const logger = {
      info: (o: Record<string, unknown>) => void lines.push(['info', o]),
      warn: (o: Record<string, unknown>) => void lines.push(['warn', o]),
      error: (o: Record<string, unknown>) => void lines.push(['error', o]),
    };
    return { log: entryPauseLog(logger as never), lines };
  };

  test('P-T43_종류와 결제사·단계만 싣는다 [ASVS v5.0.0-16.2.5]', () => {
    const r = rig();
    r.log.transition({ pg: 'TOSS', from: 'OPEN', to: 'PROBING', reason: 'PG_FAILURE', actor: 'SYSTEM' });
    r.log.probeFound({ pg: 'TOSS' });
    r.log.released({ pg: 'TOSS', actor: 'cmd-1' });
    expect(r.lines).toEqual([
      ['info', { kind: 'payment-entry-pause-transition', pg: 'TOSS', from: 'OPEN', to: 'PROBING', reason: 'PG_FAILURE', actor: 'SYSTEM' }],
      ['error', { kind: 'payment-entry-pause-probe-found', pg: 'TOSS' }],
      ['info', { kind: 'payment-entry-pause-released', pg: 'TOSS', actor: 'cmd-1' }],
    ]);
  });

  test('P-T43_판정 오류는 안전한 오류 코드만 싣는다(문장 값이 실릴 수 있는 글을 싣지 않는다) [ASVS v5.0.0-16.2.5]', () => {
    const r = rig();
    r.log.judgeError({ what: 'read', pg: 'TOSS', err: new Error('비밀 문장 값') });
    expect(JSON.stringify(r.lines)).not.toContain('비밀');
    expect(r.lines[0]![1]).toMatchObject({ kind: 'payment-entry-pause-judge-error', what: 'read', pg: 'TOSS' });
  });
});
