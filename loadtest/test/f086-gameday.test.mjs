// F-08-6(MSR-060·MSR-070) Game Day 전체 재실행·포스트모템·SLO/KPI ADR 준비 시험.
//
// 정본: docs/observability.md §4(긁기·평가·알림 간격)·§5(포스트모템·인시던트)·§12(Game Day 33종·K8),
//       docs/verification.md §5.2(실행 방식), docs/planning/01 §3.1~3.2(K8·비즈니스 KPI),
//       docs/planning/03 §4(원인 유형 9), docs/perf-ledger.md §2.1·§7·§8.
// 계획: docs/review/plans/F-08-6.md §6·§8.
// 이 시험은 Docker·kind·k6·브라우저를 쓰지 않는다. 새 모듈은 시험마다 동적 import로 불러
// 구현 전 트리에서 시험마다 따로 실패하게 한다.
// 실행(저장소 뿌리): node --test loadtest/test/f086-gameday.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const P = (...parts) => join(ROOT, ...parts);

/** 새 Game Day 도구(구현 몫). 구현 전 트리에는 없다 */
const gameday = () => import('../runner/gameday.mjs');

const ALL_IDS = Array.from({ length: 33 }, (_, i) => `G-${String(i + 1).padStart(2, '0')}`);
/** docs/verification.md §5.2의 실행 방식 */
const LOCAL = ['G-01', 'G-05', 'G-06', 'G-07', 'G-08', 'G-09', 'G-11', 'G-12', 'G-13', 'G-14', 'G-15', 'G-18', 'G-19', 'G-20', 'G-21', 'G-22', 'G-23', 'G-24', 'G-25', 'G-30', 'G-31'];
const ALTERNATE = ['G-02', 'G-03', 'G-04', 'G-10', 'G-16', 'G-26', 'G-27', 'G-29'];
const SIMULATED = ['G-17', 'G-28', 'G-32', 'G-33'];
/** 이 계획의 무대로 §5.2의 장애를 낼 수 없는 시나리오(RV086-01) */
const STAGE_MISSING = ['G-02', 'G-07', 'G-09', 'G-14', 'G-25', 'G-29', 'G-30'];
/** K8은 G-01~G-10만 본다(docs/observability.md §12) */
const K8_IDS = ALL_IDS.slice(0, 10);
/** 정본 §4: slo-fast만 긁기 5초, 그 밖은 15초. §12: G-08~G-10은 for 30초 */
const FAST_INTERVAL = { scrapeSec: 5, evalSec: 5, groupWaitSec: 5, forSec: 0 };
const OPS_RT_INTERVAL = { scrapeSec: 15, evalSec: 5, groupWaitSec: 5, forSec: 0 };
const CAUSE_INTERVAL = { scrapeSec: 15, evalSec: 5, groupWaitSec: 5, forSec: 30 };
const K8_INTERVAL = Object.fromEntries(K8_IDS.map((id) => [id, id === 'G-07' ? OPS_RT_INTERVAL : ['G-08', 'G-09', 'G-10'].includes(id) ? CAUSE_INTERVAL : FAST_INTERVAL]));
const MODE_BY_ID = Object.fromEntries(ALL_IDS.map((id) => [id, LOCAL.includes(id) ? '로컬 실행' : ALTERNATE.includes(id) ? '대체 장애' : '모의 진행']));
const CAUSE_TYPES = ['변경', '외부 의존', '내부 저장소·메시징', '용량·포화', '코드 결함', '데이터', '보안', '운영 조작', '기반', '기타'];
const RESPONSE_CHECKS = ['expectedAlert', 'expectedAction', 'invariantHeld'];
const NFR_IDS = Array.from({ length: 12 }, (_, i) => `SLO-NFR-${String(i + 1).padStart(3, '0')}`);
const KPI_IDS = ['KPI-SELLOUT-MINUTES', 'KPI-CONVERSION', 'KPI-BOT-SHARE', 'KPI-BOT-TRAFFIC-RATIO', 'KPI-CS-VOLUME', 'KPI-FIRST-IDENTITY', 'KPI-ONSALE-COST'];
const SLO_KPI_IDS = [...NFR_IDS, 'SESSION-TIME', ...KPI_IDS];
const BOUNDARY_IDS = ['NFR-027', 'V-T10', 'V-T27', 'V-T28', 'P-T1', 'SR-T13', 'NFR-028', 'V-T18', 'V-T4', 'V-T5', 'V-T17', 'Q-T2', 'S-T1'];

function read(rel, what) {
  const path = P(rel);
  assert.ok(existsSync(path), `${what}가 없다: ${rel} (구현 전 기준 실패면 이 실패가 맞다)`);
  return readFileSync(path, 'utf8');
}

/** UsageError(이름으로 본다)로 거부하는지. 메시지는 한국어이고 문제의 인자 이름을 담는다 */
function expectUsage(fn, flagRe) {
  assert.throws(fn, (e) => {
    assert.equal(e?.name, 'UsageError', `UsageError가 아니다: ${e?.name}: ${e?.message}`);
    assert.match(e.message, /[가-힣]/);
    if (flagRe) assert.match(e.message, flagRe);
    return true;
  });
}

/** 판정 입력 하나. 정본 문턱은 시험 파일에 적고 코드 상수를 가져오지 않는다 */
function scenarioRun(overrides = {}) {
  const scenario = overrides.scenario ?? 'G-01';
  const interval = K8_INTERVAL[scenario] ?? FAST_INTERVAL;
  const base = {
    scenario,
    window: overrides.window ?? '4d',
    mode: MODE_BY_ID[scenario],
    evidence: SIMULATED.includes(scenario) || scenario === 'G-26' ? '설계만' : '측정함',
    run: {
      complete: true,
      injection: { applied: true, at: '2026-11-27T09:00:00.000Z', strength: { burnMultiple: 30 } },
      intervals: { ...interval },
      host: { cpuPct: 50, procsRunning: 8, logicalCpus: 16 },
      generator: { droppedIterations: 0, cpuPct: 50, memPct: 50 },
      httpReqs: 1000,
      invariants: { oversell: 0, doublePayment: 0, admitBeforeTurn: 0 },
      responseChecks: {
        expectedAlert: { ok: true, evidence: 'Alertmanager 알림 수신' },
        expectedAction: { ok: true, evidence: '명령 ack·런북 실행' },
        invariantHeld: { ok: true, evidence: 'invariants.csv 0건' },
      },
      timeline: {
        T0: '2026-11-27T09:00:00.000Z',
        T1: '2026-11-27T09:00:01.000Z',
        T1p: '2026-11-27T09:00:25.000Z',
        T2: '2026-11-27T09:00:30.000Z',
        T3: '2026-11-27T09:00:40.000Z',
        T4: '2026-11-27T09:05:00.000Z',
      },
    },
    observation: {
      firstSymptomAt: '2026-11-27T09:00:01.000Z',
      firstAlertAt: '2026-11-27T09:00:30.000Z',
      humanNoticedAt: '2026-11-27T09:00:35.000Z',
      detectionPath: '경보',
      commandAt: '2026-11-27T09:00:40.000Z',
      ackAt: '2026-11-27T09:00:42.000Z',
      recoveredAt: '2026-11-27T09:05:00.000Z',
      alertName: 'slo_onsale_fast_burn',
      commandExpected: true,
    },
  };
  const responseChecks = { ...base.run.responseChecks, ...(overrides.run?.responseChecks ?? {}) };
  return {
    ...base,
    ...overrides,
    run: {
      ...base.run,
      ...(overrides.run ?? {}),
      injection: { ...base.run.injection, ...(overrides.run?.injection ?? {}) },
      intervals: { ...base.run.intervals, ...(overrides.run?.intervals ?? {}) },
      host: { ...base.run.host, ...(overrides.run?.host ?? {}) },
      generator: { ...base.run.generator, ...(overrides.run?.generator ?? {}) },
      invariants: { ...base.run.invariants, ...(overrides.run?.invariants ?? {}) },
      responseChecks,
      timeline: { ...base.run.timeline, ...(overrides.run?.timeline ?? {}) },
    },
    observation: { ...base.observation, ...(overrides.observation ?? {}) },
  };
}

/** 경계용: 경보 시각을 옮기면 사람 인지·명령·ack·T1p·T2·T3·T4를 함께 옮긴다 */
function scenarioRunWithAlert(alertAt) {
  const alertMs = Date.parse(alertAt);
  const at = (offsetMs) => new Date(alertMs + offsetMs).toISOString();
  return scenarioRun({
    observation: {
      firstAlertAt: alertAt,
      humanNoticedAt: at(5000),
      commandAt: at(10000),
      ackAt: at(12000),
      recoveredAt: at(60000),
    },
    run: { timeline: { T1p: at(-5000), T2: alertAt, T3: at(10000), T4: at(60000) } },
  });
}

/** 보고서 §1 실행 표의 그 시나리오 줄을 바꾼다. cells는 id 뒤의 7칸이다 */
function setScenarioRow(doc, id, cells) {
  const lines = doc.split('\n');
  const idx = lines.findIndex((l) => l.startsWith(`| ${id} |`));
  assert.ok(idx >= 0, `보고서에 ${id} 행이 없다`);
  lines[idx] = `| ${[id, ...cells].join(' | ')} |`;
  return lines.join('\n');
}

/** 보고서 §3 포스트모템 표에 인시던트 한 줄을 더한다. cells는 id 뒤의 7칸이다 */
function addIncidentRow(doc, cells) {
  const lines = doc.split('\n');
  const idx = lines.findIndex((l) => l.startsWith('| 인시던트 |'));
  assert.ok(idx >= 0, '보고서에 인시던트 표가 없다');
  lines.splice(idx + 2, 0, `| ${cells.join(' | ')} |`);
  return lines.join('\n');
}

/** ADR 초안 표의 그 줄을 바꾼다. cells는 id 뒤의 6칸이다 */
function setAdrRow(doc, id, cells) {
  const lines = doc.split('\n');
  const idx = lines.findIndex((l) => l.startsWith(`| ${id} |`));
  assert.ok(idx >= 0, `ADR 초안에 ${id} 줄이 없다`);
  lines[idx] = `| ${[id, ...cells].join(' | ')} |`;
  return lines.join('\n');
}

/** 포스트모템 하나. 정본 필수 칸을 모두 채운 기준 입력이다 */
function postmortem(overrides = {}) {
  return {
    id: 'PM-01',
    title: 'G-05 결제 승인 지연',
    declaredAt: '2026-11-27T10:00:00.000Z',
    endedAt: '2026-11-27T11:00:00.000Z',
    completedAt: '2026-11-29T10:59:00.000Z',
    firstSymptomAt: '2026-11-27T10:01:00.000Z',
    firstAlertAt: '2026-11-27T10:01:40.000Z',
    humanNoticedAt: '2026-11-27T10:01:50.000Z',
    detectionPath: '경보',
    primaryCauseType: '외부 의존',
    component: 'payment-svc',
    contributingCauseTypes: ['용량·포화'],
    trigger: '결제사 승인 지연 주입',
    impact: { budgetUsedRatio: 0.1, affectedEvents: '1회차', summary: '결제 확정 p99 상승' },
    controlsUsed: '명령 6 결제사 전환 검토',
    followUps: [{ title: '재시도 큐 조정', issue: '#123', p0: false }],
    ...overrides,
  };
}

test('MSR-060 ① Game Day 33종 목록·무대·실행 방식·증거 수준·원인 유형이 정본과 같다', async () => {
  const m = await gameday();
  assert.ok(Array.isArray(m.GAMEDAY_SCENARIOS), 'GAMEDAY_SCENARIOS가 배열이 아니다');
  assert.equal(m.GAMEDAY_SCENARIOS.length, 33);
  assert.deepEqual(m.GAMEDAY_SCENARIOS.map((s) => s.id), ALL_IDS);
  assert.deepEqual(m.GAMEDAY_MODES, ['로컬 실행', '대체 장애', '모의 진행']);
  assert.deepEqual(m.CAUSE_TYPES, CAUSE_TYPES);
  assert.deepEqual(m.DETECTION_PATHS, ['경보', '사람', '외부']);

  const byMode = { '로컬 실행': [], '대체 장애': [], '모의 진행': [] };
  for (const s of m.GAMEDAY_SCENARIOS) byMode[s.mode].push(s.id);
  assert.deepEqual(byMode['로컬 실행'], LOCAL);
  assert.deepEqual(byMode['대체 장애'], ALTERNATE);
  assert.deepEqual(byMode['모의 진행'], SIMULATED);

  const byId = new Map(m.GAMEDAY_SCENARIOS.map((s) => [s.id, s]));
  assert.equal(byId.get('G-16').partial, true);
  assert.equal(byId.get('G-26').evidence, '설계만');
  for (const id of SIMULATED) assert.equal(byId.get(id).evidence, '설계만', `${id}는 설계만이다`);
  for (const id of STAGE_MISSING) {
    assert.equal(byId.get(id).stageReady, false, `${id}는 이 계획 무대에서 낼 수 없다`);
    assert.ok(Array.isArray(byId.get(id).stageMissing) && byId.get(id).stageMissing.length > 0, `${id} stageMissing이 없다`);
  }
  for (const id of ['G-01', 'G-03', 'G-05', 'G-11', 'G-31']) {
    assert.equal(byId.get(id).stageReady, true, `${id}는 이 계획 무대에서 낼 수 있다`);
  }
  for (const id of K8_IDS) assert.deepEqual(byId.get(id).k8Interval, K8_INTERVAL[id], `${id} K8 간격`);
  for (const s of m.GAMEDAY_SCENARIOS.filter((x) => !K8_IDS.includes(x.id))) assert.equal(s.k8Interval, null, `${s.id}는 K8이 아니다`);

  for (const s of m.GAMEDAY_SCENARIOS) {
    for (const key of ['target', 'inject', 'expectedAlert', 'expectedResponse']) {
      assert.equal(typeof s[key], 'string', `${s.id}.${key}가 문자열이 아니다`);
      assert.ok(s[key].length > 0, `${s.id}.${key}가 비었다`);
    }
    assert.deepEqual(s.responseChecks, RESPONSE_CHECKS, `${s.id} 기대 대응 확인 목록`);
    assert.ok(Array.isArray(s.artifacts), `${s.id}.artifacts가 배열이 아니다`);
    for (const a of ['timeline.csv', 'manifest.json', 'alerts.ndjson', 'commands.ndjson', 'faults.ndjson', 'invariants.csv', 'host.json', 'run.json', 'generator.json']) {
      assert.ok(s.artifacts.includes(a), `${s.id} 산출물에 ${a}가 없다`);
    }
  }

  assert.deepEqual(m.GAMEDAY_WINDOWS, ['4d', '4e', '4f', '4g']);
  assert.deepEqual(m.GAMEDAY_DEFAULTS, {
    detectLimitSec: 60,
    propagationLimitSec: 3,
    scrapeFastSec: 5,
    scrapeOtherSec: 15,
    evalSec: 5,
    groupWaitSec: 5,
    k8CauseForSec: 30,
    k8BurnMultipleMin: 27,
    postmortemDueHours: 48,
    budgetP0Ratio: 0.2,
  });
  assert.deepEqual(m.GAMEDAY_PRIOR_MEASUREMENTS, {
    'F-08-5': '무효·미측정',
    'F-08-9': '판정 못 함(무효·부분)',
    'F-08-10': '미측정',
  });
});

test('MSR-060 ② 측정 창 4d~4g·무대·잠금·중단 규칙·인자 규칙이 계획대로다', async () => {
  const m = await gameday();
  const plan = JSON.parse(read('loadtest/plan/f086-plan.json', 'Game Day 실행 계획'));
  assert.equal(plan.batch, 'F-08-6');
  assert.equal(plan.feature, 'F-08-6');
  assert.equal(plan.window, 4);
  assert.deepEqual(plan.windows.map((w) => w.id), ['4d', '4e', '4f', '4g']);
  assert.equal(plan.lock, 'docker lane4-F-08-6');
  assert.ok(!JSON.stringify(plan).includes('docker-all'), '계획에 docker-all이 있다');
  assert.match(plan.startGate, /감독/);
  assert.match(plan.startGate, /docker lane4-F-08-6/);

  const ids = plan.windows.flatMap((w) => w.scenarios);
  assert.deepEqual(ids, ALL_IDS);
  assert.deepEqual(plan.windows.map((w) => w.scenarios.length), [10, 10, 10, 3]);
  assert.deepEqual(plan.scenarioModes, { '로컬 실행': 21, '대체 장애': 8, '모의 진행': 4 });
  assert.equal(plan.stopRules.length, 10);
  assert.deepEqual(plan.stopRules.map((r) => r.id), ['STOP-01', 'STOP-02', 'STOP-03', 'STOP-04', 'STOP-05', 'STOP-06', 'STOP-07', 'STOP-08', 'STOP-09', 'STOP-10']);
  for (const w of plan.windows) {
    assert.ok(Array.isArray(w.commands) && w.commands.length > 0, `${w.id} commands가 없다`);
    assert.ok(w.commands.every((c) => c.includes(`--window ${w.id}`)), `${w.id} 명령에 창이 없다`);
    assert.ok(Array.isArray(w.artifacts) && w.artifacts.length > 0, `${w.id} artifacts가 없다`);
    for (const a of ['timeline.csv', 'manifest.json', 'host.json', 'run.json', 'generator.json']) {
      assert.ok(w.artifacts.includes(a), `${w.id} artifacts에 ${a}가 없다`);
    }
    assert.equal(typeof w.estimatedMin, 'number');
  }

  for (const id of STAGE_MISSING) {
    assert.equal(plan.scenarioStage[id].ready, false, `${id} 계획 무대`);
    assert.ok(Array.isArray(plan.scenarioStage[id].requires) && plan.scenarioStage[id].requires.length > 0, `${id} requires`);
  }
  assert.ok(plan.stage.toxiproxy.includes('cache'), 'G-03 캐시 앞 Toxiproxy');
  assert.ok(plan.stage.toxiproxy.includes('kms'), 'G-27 KMS 끝점 Toxiproxy');
  assert.deepEqual(plan.generator, { droppedIterationsMax: 0, cpuPctMax: 80, memPctMax: 90, minHttpReqs: 1 });
  assert.deepEqual(plan.k8.intervals.fast, FAST_INTERVAL);
  assert.deepEqual(plan.k8.intervals.opsRt, OPS_RT_INTERVAL);
  assert.deepEqual(plan.k8.intervals.cause, CAUSE_INTERVAL);
  assert.equal(plan.k8.minBurnMultiple, 27);
  assert.deepEqual(plan.timeline.columns, ['T0', 'T1', 'T1p', 'T2', 'T3', 'T4']);

  const parsed = m.parseGamedayArgs(['--window', '4d']);
  assert.equal(parsed.command, 'run');
  assert.equal(parsed.window, '4d');
  assert.deepEqual(parsed.scenarios, K8_IDS);

  expectUsage(() => m.parseGamedayArgs([]), /--window/);
  expectUsage(() => m.parseGamedayArgs(['--window', '4z']), /4z|창/);
  expectUsage(() => m.parseGamedayArgs(['--window', '4d', '--scenario', 'G-34']), /G-34|시나리오/);
  expectUsage(() => m.parseGamedayArgs(['--window', '4d', '--scenario', 'G-11']), /4d|창/);
  expectUsage(() => m.parseGamedayArgs(['--window', '4d', '--record']), /run-id|실행 ID/);
  expectUsage(() => m.parseGamedayArgs(['--window', '4d', '--record', '--run-id', 'x', '--rehearsal']), /rehearsal|연습/);
  expectUsage(() => m.parseGamedayArgs(['--window', '4d', '--docker-all']), /docker-all/);
  expectUsage(() => m.parseGamedayArgs(['--window', '4d', '--browser']), /browser|브라우저/);
  expectUsage(() => m.parseGamedayArgs(['--window', '4d', '--leak']), /leak|누수/);
});

test('MSR-060 ③ K8 간격·탐지 60초·전파 3초·소진 배수·발생기·대응 증거·무대를 가른다', async () => {
  const m = await gameday();
  let r = m.judgeScenario(scenarioRun());
  assert.equal(r.verdict, '통과');
  assert.equal(r.detectionSec, 30);
  assert.equal(r.propagationSec, 2);
  assert.equal(r.alertDetected, true);

  // 탐지 60.000초는 통과, 60.001초는 미달. 경보 시각을 옮기면 사람 인지·명령·ack·T1p·T2·T3·T4도 함께 옮긴다.
  r = m.judgeScenario(scenarioRunWithAlert('2026-11-27T09:01:00.000Z'));
  assert.equal(r.detectionSec, 60);
  assert.equal(r.verdict, '통과');
  r = m.judgeScenario(scenarioRunWithAlert('2026-11-27T09:01:00.001Z'));
  assert.equal(r.verdict, '미달');

  // 전파 3.000초는 통과, 3.001초는 미달
  r = m.judgeScenario(scenarioRun({ observation: { ackAt: '2026-11-27T09:00:43.000Z' } }));
  assert.equal(r.propagationSec, 3);
  assert.equal(r.verdict, '통과');
  r = m.judgeScenario(scenarioRun({ observation: { ackAt: '2026-11-27T09:00:43.001Z' } }));
  assert.equal(r.verdict, '미달');

  // 경보가 울리지 않고 사람이 먼저 알면 K8은 미달이다
  r = m.judgeScenario(scenarioRun({ observation: { firstAlertAt: null, detectionPath: '사람' } }));
  assert.equal(r.verdict, '미달');
  assert.equal(r.alertDetected, false);
  // 사람이 경보보다 먼저 알았는데 탐지 경로를 경보로 적으면 미달이다
  r = m.judgeScenario(scenarioRun({ observation: { humanNoticedAt: '2026-11-27T09:00:20.000Z', detectionPath: '경보' } }));
  assert.equal(r.verdict, '미달');

  // 주입 증거 없음·간격 축소·미완주·호스트 포화는 무효
  r = m.judgeScenario(scenarioRun({ run: { injection: { applied: false } } }));
  assert.equal(r.verdict, '무효');
  r = m.judgeScenario(scenarioRun({ run: { complete: false } }));
  assert.equal(r.verdict, '무효');
  r = m.judgeScenario(scenarioRun({ run: { host: { cpuPct: 90, procsRunning: 20, logicalCpus: 16 } } }));
  assert.equal(r.verdict, '무효');

  // 간격은 시나리오별 정본 값과 같아야 한다. 축 하나라도 줄이면 무효
  for (const intervals of [
    { ...FAST_INTERVAL, scrapeSec: 4 },
    { ...FAST_INTERVAL, evalSec: 4 },
    { ...FAST_INTERVAL, groupWaitSec: 4 },
  ]) {
    r = m.judgeScenario(scenarioRun({ run: { intervals } }));
    assert.equal(r.verdict, '무효');
  }
  // G-08~G-10은 긁기 15초·for 30초
  r = m.judgeScenario(scenarioRun({ scenario: 'G-08' }));
  assert.equal(r.verdict, '통과');
  r = m.judgeScenario(scenarioRun({ scenario: 'G-08', run: { intervals: FAST_INTERVAL } }));
  assert.equal(r.verdict, '무효');

  // 소진 배수 27은 통과, 26.9는 60초 안 탐지를 주장할 수 없다
  r = m.judgeScenario(scenarioRun({ run: { injection: { strength: { burnMultiple: 27 } } } }));
  assert.equal(r.verdict, '통과');
  r = m.judgeScenario(scenarioRun({ run: { injection: { strength: { burnMultiple: 26.9 } } } }));
  assert.equal(r.verdict, '판정 못 함');

  // 발생기: dropped 1·CPU 80.1·메모리 90.1·httpReqs 0은 무효, 경계 정각은 통과
  r = m.judgeScenario(scenarioRun({ run: { generator: { droppedIterations: 1 } } }));
  assert.equal(r.verdict, '무효');
  r = m.judgeScenario(scenarioRun({ run: { generator: { cpuPct: 80 } } }));
  assert.equal(r.verdict, '통과');
  r = m.judgeScenario(scenarioRun({ run: { generator: { cpuPct: 80.1 } } }));
  assert.equal(r.verdict, '무효');
  r = m.judgeScenario(scenarioRun({ run: { generator: { memPct: 90 } } }));
  assert.equal(r.verdict, '통과');
  r = m.judgeScenario(scenarioRun({ run: { generator: { memPct: 90.1 } } }));
  assert.equal(r.verdict, '무효');
  r = m.judgeScenario(scenarioRun({ run: { httpReqs: 0 } }));
  assert.equal(r.verdict, '무효');
  r = m.judgeScenario(scenarioRun({ run: { httpReqs: 1 } }));
  assert.equal(r.verdict, '통과');

  // 기대 대응 증거가 없으면 통과가 아니다
  const missingResponse = scenarioRun();
  delete missingResponse.run.responseChecks.expectedAction;
  r = m.judgeScenario(missingResponse);
  assert.equal(r.verdict, '판정 못 함');
  r = m.judgeScenario(scenarioRun({ run: { responseChecks: { expectedAction: { ok: false, evidence: '명령 ack 없음' } } } }));
  assert.equal(r.verdict, '미달');
  r = m.judgeScenario(scenarioRun({ run: { responseChecks: { expectedAction: { ok: true, evidence: '' } } } }));
  assert.equal(r.verdict, '판정 못 함');

  // 무대가 없는 시나리오는 통과가 아니다
  r = m.judgeScenario(scenarioRun({ scenario: 'G-02' }));
  assert.equal(r.verdict, '판정 못 함');
  r = m.judgeScenario(scenarioRun({ scenario: 'G-09' }));
  assert.equal(r.verdict, '판정 못 함');
  // 실행 방식이 정본과 다르면 판정 못 함
  r = m.judgeScenario(scenarioRun({ scenario: 'G-03', mode: '로컬 실행' }));
  assert.equal(r.verdict, '판정 못 함');
  r = m.judgeScenario(scenarioRun({ scenario: 'G-03', mode: '대체 장애' }));
  assert.equal(r.verdict, '통과');

  // timeline T0·T1·T1p·T2·T3·T4가 없으면 통과가 아니다
  r = m.judgeScenario(scenarioRun({ run: { timeline: { T1p: null } } }));
  assert.equal(r.verdict, '판정 못 함');

  // 불변식 위반은 미달
  r = m.judgeScenario(scenarioRun({ run: { invariants: { oversell: 1 } } }));
  assert.equal(r.verdict, '미달');

  // K8 밖 시나리오는 경보·전파가 없어도 기대 대응·불변식·시간선이 있으면 통과
  r = m.judgeScenario(scenarioRun({ scenario: 'G-11', observation: { firstAlertAt: null, detectionPath: null, commandExpected: false } }));
  assert.equal(r.verdict, '통과');
  // G-11도 기대 대응 증거가 없으면 통과가 아니다
  const g11Missing = scenarioRun({ scenario: 'G-11', observation: { firstAlertAt: null, detectionPath: null, commandExpected: false } });
  delete g11Missing.run.responseChecks.expectedAction;
  r = m.judgeScenario(g11Missing);
  assert.equal(r.verdict, '판정 못 함');

  // 모의 진행·설계만은 통과가 아니다
  for (const id of SIMULATED) {
    r = m.judgeScenario(scenarioRun({ scenario: id }));
    assert.equal(r.verdict, '판정 못 함', `${id} 모의 진행`);
  }
  r = m.judgeScenario(scenarioRun({ scenario: 'G-26' }));
  assert.equal(r.verdict, '판정 못 함');

  // K8 종합: 10종 결과가 모두 통과일 때만 통과
  const passResults = K8_IDS.map((id) => ({ scenario: id, verdict: '통과', alertDetected: true, detectionSec: 30, propagationSec: 2 }));
  let k8 = m.judgeK8Results(passResults);
  assert.equal(k8.verdict, '통과');
  assert.equal(k8.detected, 10);
  assert.equal(k8.within60, 10);
  assert.equal(k8.maxPropagationSec, 2);
  k8 = m.judgeK8Results(passResults.map((x) => (x.scenario === 'G-05' ? { ...x, verdict: '미달' } : x)));
  assert.equal(k8.verdict, '미달');
  k8 = m.judgeK8Results(passResults.map((x) => (x.scenario === 'G-05' ? { ...x, verdict: '무효' } : x)));
  assert.equal(k8.verdict, '판정 못 함');
  k8 = m.judgeK8Results(passResults.slice(0, 9));
  assert.equal(k8.verdict, '판정 못 함');

  // 현재 무대에서는 G-09(admission-ctrl 리더)를 낼 수 없어 K8 종합은 판정 못 함
  const rawRuns = K8_IDS.map((id) => m.judgeScenario(scenarioRun({ scenario: id })));
  k8 = m.judgeK8(rawRuns);
  assert.equal(k8.verdict, '판정 못 함');
});

test('MSR-060 ④ 포스트모템 양식이 필수 칸·원인 유형·48시간·P0·이슈 링크를 요구한다', async () => {
  const m = await gameday();
  const template = read('docs/review/measurements/F-08-6-postmortem-template.md', '포스트모템 양식');
  for (const field of m.POSTMORTEM_FIELDS) assert.ok(template.includes(field), `양식에 '${field}' 칸이 없다`);
  for (const cause of CAUSE_TYPES) assert.ok(template.includes(cause), `양식에 원인 유형 '${cause}'가 없다`);
  assert.match(template, /48시간/);
  assert.match(template, /20%/);
  assert.match(template, /P0/);
  assert.match(template, /GitHub Issues/);

  const doc = m.renderPostmortem(postmortem());
  let result = m.validatePostmortem(doc);
  assert.equal(result.ok, true, result.errors.join(' / '));

  // 필수 칸이 비면 거부
  const missing = doc.replace(/\| 첫 경보 시각 \| [^|]+ \|/, '| 첫 경보 시각 |  |');
  assert.equal(m.validatePostmortem(missing).ok, false);
  // 원인 유형 목록 밖은 거부
  assert.equal(m.validatePostmortem(m.renderPostmortem(postmortem({ primaryCauseType: '설정' }))).ok, false);
  // 구성 요소는 하나만
  assert.equal(m.validatePostmortem(m.renderPostmortem(postmortem({ component: 'payment-svc·purchase-svc' }))).ok, false);
  // 기타는 사유가 필요하다
  assert.equal(m.validatePostmortem(m.renderPostmortem(postmortem({ primaryCauseType: '기타' }))).ok, false);
  assert.equal(m.validatePostmortem(m.renderPostmortem(postmortem({ primaryCauseType: '기타', otherCauseReason: '분류 밖 원인' }))).ok, true);
  // 탐지 경로는 경보·사람·외부만
  assert.equal(m.validatePostmortem(m.renderPostmortem(postmortem({ detectionPath: '모니터링' }))).ok, false);
  // 사람이 경보보다 먼저인데 경보로 적으면 거부
  assert.equal(m.validatePostmortem(m.renderPostmortem(postmortem({ humanNoticedAt: '2026-11-27T10:01:20.000Z' }))).ok, false);
  // 후속 조치는 하나 이상, 이슈 링크도 비면 안 된다
  assert.equal(m.validatePostmortem(m.renderPostmortem(postmortem({ followUps: [] }))).ok, false);
  assert.equal(m.validatePostmortem(m.renderPostmortem(postmortem({ followUps: [{ title: '이슈 없음', issue: '', p0: false }] }))).ok, false);
  assert.equal(m.validatePostmortem(m.renderPostmortem(postmortem({ followUps: [{ title: '이슈', issue: '#123', p0: false }] }))).ok, true);

  // 48시간 경계: 정각은 통과, 1분 초과는 미달
  assert.equal(m.validatePostmortem(m.renderPostmortem(postmortem({ completedAt: '2026-11-29T11:00:00.000Z' }))).ok, true);
  assert.equal(m.validatePostmortem(m.renderPostmortem(postmortem({ completedAt: '2026-11-29T11:01:00.000Z' }))).ok, false);

  // 28일 예산 20.0%는 P0가 없어도 되고, 20.1%는 P0가 필요하다
  assert.equal(m.validatePostmortem(m.renderPostmortem(postmortem({ impact: { budgetUsedRatio: 0.2, affectedEvents: '1회차', summary: '경계' } }))).ok, true);
  assert.equal(m.validatePostmortem(m.renderPostmortem(postmortem({ impact: { budgetUsedRatio: 0.201, affectedEvents: '1회차', summary: '초과' } }))).ok, false);
  assert.equal(m.validatePostmortem(m.renderPostmortem(postmortem({
    impact: { budgetUsedRatio: 0.201, affectedEvents: '1회차', summary: '초과' },
    followUps: [{ title: 'P0 조치', issue: '#124', p0: true }],
  }))).ok, true);
});

test('MSR-060 ⑤ 보고서가 무대·기대 대응·인시던트·선행 측정을 통과로 만들지 않는다', async () => {
  const m = await gameday();
  const doc = read('docs/review/measurements/F-08-6-gameday.md', 'Game Day 보고서 뼈대');
  let parsed = m.validateGamedayReport(doc, { runExists: () => false, runResponseOk: () => false, postmortemExists: () => false, postmortemOk: () => false, measured: false });
  assert.equal(parsed.ok, true, parsed.errors.join(' / '));
  assert.equal(parsed.scenarios, 33);
  assert.equal(parsed.passed, 0);
  assert.equal(parsed.incidents, 0);
  assert.equal(parsed.prior.f085, '무효·미측정');
  assert.equal(parsed.prior.f089, '판정 못 함(무효·부분)');
  assert.equal(parsed.prior.f0810, '미측정');

  // 실행 ID·기대 대응 증거가 있는 정상 통과 행은 받아들인다(RV086-09)
  const positive = setScenarioRow(doc, 'G-01', ['4d', '로컬 실행', '측정함', '적용', '통과', '2026-11-27-f086-g01', '정상']);
  parsed = m.validateGamedayReport(positive, {
    runExists: (id) => id === '2026-11-27-f086-g01',
    runResponseOk: (id) => id === '2026-11-27-f086-g01',
    postmortemExists: () => false,
    postmortemOk: () => false,
    measured: true,
  });
  assert.equal(parsed.ok, true, parsed.errors.join(' / '));
  assert.equal(parsed.passed, 1);

  // 실행 ID 없는 통과는 거부
  const noEvidence = setScenarioRow(doc, 'G-01', ['4d', '로컬 실행', '측정함', '적용', '통과', '—', '증거 없음']);
  assert.equal(m.validateGamedayReport(noEvidence, { runExists: () => false, runResponseOk: () => false, measured: true }).ok, false);
  // 실행은 있지만 기대 대응 증거가 없으면 거부
  assert.equal(m.validateGamedayReport(positive, {
    runExists: (id) => id === '2026-11-27-f086-g01',
    runResponseOk: () => false,
    measured: true,
  }).ok, false);
  // 무대가 없는 시나리오(G-02)의 통과는 거부
  const stagePass = setScenarioRow(doc, 'G-02', ['4d', '대체 장애', '측정함', '적용', '통과', '2026-11-27-f086-g02', '무대 없음']);
  assert.equal(m.validateGamedayReport(stagePass, {
    runExists: () => true,
    runResponseOk: () => true,
    measured: true,
  }).ok, false);
  // 설계만·모의 진행은 통과가 아니다
  const designPass = setScenarioRow(doc, 'G-26', ['4f', '대체 장애', '설계만', '적용', '통과', '2026-11-27-f086-g26', '설계만인데 통과']);
  assert.equal(m.validateGamedayReport(designPass, { runExists: () => true, runResponseOk: () => true, measured: true }).ok, false);
  // 선행 측정을 통과로 바꾸면 거부
  const priorPass = doc.replace(/\| F-08-5 \| [^|]+ \| [^|]+ \|/, '| F-08-5 | NFR-027·V-T10 | 통과 | docs/review/measurements/F-08-5-soak.md |');
  assert.equal(m.validateGamedayReport(priorPass, { runExists: () => false, runResponseOk: () => false, measured: false }).ok, false);
  // 금지 수치 주장
  const claim = doc.replace('## 7. 주장하지 않는 것', '## 7. 주장하지 않는 것\n\n- K7 0건을 달성했다.');
  assert.equal(m.validateGamedayReport(claim, { runExists: () => false, runResponseOk: () => false, measured: false }).ok, false);

  // 선언한 인시던트에 포스트모템이 없으면 거부
  const noPm = addIncidentRow(doc, ['I-01', 'G-05', '2026-11-27T10:00:00.000Z', '2026-11-27T11:00:00.000Z', '2026-11-27T12:00:00.000Z', '0.10', '아니오', '—']);
  assert.equal(m.validateGamedayReport(noPm, { runExists: () => false, runResponseOk: () => false, postmortemExists: () => false, postmortemOk: () => false, measured: true }).ok, false);
  // 포스트모템 경로가 있고 48시간·P0가 맞으면 받아들인다
  const pm = addIncidentRow(doc, ['I-01', 'G-05', '2026-11-27T10:00:00.000Z', '2026-11-27T11:00:00.000Z', '2026-11-27T12:00:00.000Z', '0.10', '아니오', 'docs/review/measurements/F-08-6-postmortem-template.md#PM-01']);
  parsed = m.validateGamedayReport(pm, {
    runExists: () => false,
    runResponseOk: () => false,
    postmortemExists: () => true,
    postmortemOk: () => true,
    measured: true,
  });
  assert.equal(parsed.ok, true, parsed.errors.join(' / '));
  assert.equal(parsed.incidents, 1);
  // 20% 초과인데 P0가 없으면 거부
  const noP0 = addIncidentRow(doc, ['I-01', 'G-05', '2026-11-27T10:00:00.000Z', '2026-11-27T11:00:00.000Z', '2026-11-27T12:00:00.000Z', '0.21', '아니오', 'docs/review/measurements/F-08-6-postmortem-template.md#PM-01']);
  assert.equal(m.validateGamedayReport(noP0, { runExists: () => false, runResponseOk: () => false, postmortemExists: () => true, postmortemOk: () => true, measured: true }).ok, false);
  // 48시간을 넘긴 완료 시각은 거부
  const late = addIncidentRow(doc, ['I-01', 'G-05', '2026-11-27T10:00:00.000Z', '2026-11-27T11:00:00.000Z', '2026-11-29T11:01:00.000Z', '0.10', '아니오', 'docs/review/measurements/F-08-6-postmortem-template.md#PM-01']);
  assert.equal(m.validateGamedayReport(late, { runExists: () => false, runResponseOk: () => false, postmortemExists: () => true, postmortemOk: () => true, measured: true }).ok, false);
});

test('MSR-070 ⑥ ADR 초안이 NFR-001~012·세션 시간·비즈니스 KPI를 빠짐없이 다룬다', async () => {
  const m = await gameday();
  assert.deepEqual(m.SLO_KPI_TARGETS.map((t) => t.id), SLO_KPI_IDS);
  const byId = new Map(m.SLO_KPI_TARGETS.map((t) => [t.id, t]));
  assert.equal(byId.get('KPI-BOT-TRAFFIC-RATIO').hasTarget, false);
  assert.equal(byId.get('KPI-FIRST-IDENTITY').hasTarget, false);
  assert.equal(byId.get('KPI-SELLOUT-MINUTES').hasTarget, true);
  for (const t of m.SLO_KPI_TARGETS) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.norm, 'string');
    assert.ok(t.norm.startsWith('docs/'), `${t.id} 정본 위치가 docs/로 시작하지 않는다`);
  }

  const doc = read('docs/review/measurements/F-08-6-slo-kpi-adr-draft.md', 'SLO/KPI ADR 초안');
  const parsed = m.validateSloKpiAdr(doc, { measured: false, runExists: () => false });
  assert.equal(parsed.ok, true, parsed.errors.join(' / '));
  assert.equal(parsed.rows, 20);
  assert.deepEqual(parsed.decisions, Array(20).fill('보류'));
  assert.deepEqual(parsed.measurements, Array(20).fill('미측정'));
  assert.deepEqual(parsed.evidences, Array(20).fill('—'));
});

test('MSR-070 ⑦ ADR 초안이 측정 전 값을 미측정으로 두고 가짜 실행 ID·근거 없는 목표 변경을 거부한다', async () => {
  const m = await gameday();
  const doc = read('docs/review/measurements/F-08-6-slo-kpi-adr-draft.md', 'SLO/KPI ADR 초안');
  assert.match(doc, /미측정/);
  assert.doesNotMatch(doc, /통과/);

  // 측정 전인데 조정하면 거부
  const early = setAdrRow(doc, 'SLO-NFR-001', ['대기열 진입', 'docs/observability.md §4', '정본 값(위치 참조)', '미측정', '조정', '—']);
  assert.equal(m.validateSloKpiAdr(early, { measured: false, runExists: () => false }).ok, false);
  // 측정 뒤라도 근거·되돌릴 조건이 없으면 조정 거부
  const noEvidence = setAdrRow(doc, 'SLO-NFR-001', ['대기열 진입', 'docs/observability.md §4', '정본 값(위치 참조)', '2026-11-27-f086-g01', '조정', '—']);
  assert.equal(m.validateSloKpiAdr(noEvidence, { measured: true, runExists: () => true }).ok, false);
  // 가짜 실행 ID는 거부
  const fakeRun = setAdrRow(doc, 'SLO-NFR-001', ['대기열 진입', 'docs/observability.md §4', '정본 값(위치 참조)', '2026-11-27-fake-g01', '조정', '실행 ID 2026-11-27-fake-g01, 되돌릴 조건: 세 번 연속 미달이면 정본 값으로']);
  assert.equal(m.validateSloKpiAdr(fakeRun, { measured: true, runExists: () => false }).ok, false);
  // 근거·되돌릴 조건이 있으면 조정 가능
  const changed = setAdrRow(doc, 'SLO-NFR-001', ['대기열 진입', 'docs/observability.md §4', '정본 값(위치 참조)', '2026-11-27-f086-g01', '조정', '실행 ID 2026-11-27-f086-g01, 되돌릴 조건: 세 번 연속 미달이면 정본 값으로']);
  assert.equal(m.validateSloKpiAdr(changed, { measured: true, runExists: (id) => id === '2026-11-27-f086-g01' }).ok, true);
  // 문서 인용은 실행 ID 없이도 근거가 된다
  const cited = setAdrRow(doc, 'SLO-NFR-002', ['대기 상태 전파', 'docs/observability.md §4', '정본 값(위치 참조)', '문서 인용', '유지', 'docs/review/measurements/F-08-5-soak.md']);
  assert.equal(m.validateSloKpiAdr(cited, { measured: true, runExists: () => false }).ok, true);
  // 목표가 없는 관측 지표는 조정할 수 없다
  const observed = setAdrRow(doc, 'KPI-BOT-TRAFFIC-RATIO', ['봇 트래픽 비율', 'docs/planning/01-overview.md §3.2', '목표 없음', '2026-11-27-f086-g01', '조정', '실행 ID, 되돌릴 조건: 없음']);
  assert.equal(m.validateSloKpiAdr(observed, { measured: true, runExists: () => true }).ok, false);
  // 중복·누락 줄은 거부
  const duplicate = doc.replace(/(\| SLO-NFR-001 \|[^\n]*\n)/, '$1$1');
  assert.equal(m.validateSloKpiAdr(duplicate, { measured: false, runExists: () => false }).ok, false);
  const missing = doc.split('\n').filter((l) => !l.startsWith('| SLO-NFR-012 |')).join('\n');
  assert.equal(m.validateSloKpiAdr(missing, { measured: false, runExists: () => false }).ok, false);
});

test('MSR-070 ⑧ 실행 계획 JSON과 F-08-2·F-08-5·F-08-8·F-08-9·F-08-10 경계·금지 수치가 맞다', async () => {
  const m = await gameday();
  const plan = JSON.parse(read('loadtest/plan/f086-plan.json', 'Game Day 실행 계획'));
  assert.equal(plan.report, 'docs/review/measurements/F-08-6-gameday.md');
  assert.equal(plan.postmortemTemplate, 'docs/review/measurements/F-08-6-postmortem-template.md');
  assert.equal(plan.sloKpiAdrDraft, 'docs/review/measurements/F-08-6-slo-kpi-adr-draft.md');
  assert.deepEqual(plan.defaults, m.GAMEDAY_DEFAULTS);
  assert.deepEqual(plan.priorMeasurements, {
    'F-08-5': '무효·미측정',
    'F-08-9': '판정 못 함(무효·부분)',
    'F-08-10': '미측정',
  });

  const notIncluded = plan.notIncluded.join('\n');
  for (const token of [...BOUNDARY_IDS, 'F-08-5', 'F-08-9', 'F-08-10', 'K1', 'K2', 'K7', '30,000건/초', '100만', 'docker-all']) {
    assert.ok(notIncluded.includes(token), `notIncluded에 '${token}'가 없다`);
  }
  const risk = plan.remainingRisk.join('\n');
  for (const token of [...BOUNDARY_IDS, 'F-08-5', '무효', 'F-08-9', '판정 못 함', 'G-02', 'G-07', 'G-09', 'G-14', 'G-25', 'G-29', 'G-30', 'G-26', '설계만', '모의 진행']) {
    assert.ok(risk.includes(token), `remainingRisk에 '${token}'가 없다`);
  }

  const text = read('docs/review/plans/F-08-6.md', 'F-08-6 계획');
  for (const heading of [
    '## 1. 정본 자리',
    '## 3. 범위',
    '## 7. 경계 표',
    '## 8. 시험(측정 준비) 설계',
    '## 9. 실패 시나리오',
    '## 10. 완료의 정의',
    '## 11. 크기와 차례',
    '## 12. 담당 표',
    '## 13. 이번 세션의 범위와 리뷰 준비',
    '## 실패 확인',
    '## 검증',
  ]) {
    assert.ok(text.includes(heading), `계획에 '${heading}' 절이 없다`);
  }
  for (const token of [...BOUNDARY_IDS, '30,000건/초', '100만', 'K1', 'K2', 'K7']) {
    assert.ok(text.includes(token), `계획에 '${token}' 경계 문구가 없다`);
  }
  assert.match(text, /닫지 않는다/);
  for (const token of ['timeline.csv', 'T1p', 'responseChecks', 'stageReady', 'incidents', 'runResponseOk', 'judgeK8Results']) {
    assert.ok(text.includes(token), `계획에 '${token}' 계약이 없다`);
  }
});
