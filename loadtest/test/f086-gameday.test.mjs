// F-08-6(MSR-060·MSR-070) Game Day 전체 재실행·포스트모템·SLO/KPI ADR 준비 시험.
//
// 정본: docs/observability.md §5(포스트모템·인시던트)·§12(Game Day 33종·K8),
//       docs/verification.md §5.2(실행 방식), docs/planning/01 §3.1~3.2(K8·비즈니스 KPI),
//       docs/planning/03 §4(원인 유형 9), docs/perf-ledger.md §8(K8 간격).
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
/** K8은 G-01~G-10만 본다(docs/observability.md §12) */
const K8_IDS = ALL_IDS.slice(0, 10);
const NFR_IDS = Array.from({ length: 12 }, (_, i) => `SLO-NFR-${String(i + 1).padStart(3, '0')}`);
const KPI_IDS = ['KPI-SELLOUT-MINUTES', 'KPI-CONVERSION', 'KPI-BOT-SHARE', 'KPI-BOT-TRAFFIC-RATIO', 'KPI-CS-VOLUME', 'KPI-FIRST-IDENTITY', 'KPI-ONSALE-COST'];
const SLO_KPI_IDS = [...NFR_IDS, 'SESSION-TIME', ...KPI_IDS];

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
  const base = {
    scenario: 'G-01',
    window: '4d',
    mode: '로컬 실행',
    evidence: '측정함',
    run: {
      complete: true,
      injection: { applied: true, at: '2026-11-27T09:00:00.000Z', strength: { burnMultiple: 30 } },
      intervals: { scrapeSec: 5, evalSec: 5, groupWaitSec: 5 },
      host: { cpuPct: 50, procsRunning: 8, logicalCpus: 16 },
      invariants: { oversell: 0, doublePayment: 0, admitBeforeTurn: 0 },
    },
    observation: {
      firstSymptomAt: '2026-11-27T09:00:01.000Z',
      firstAlertAt: '2026-11-27T09:00:30.000Z',
      humanNoticedAt: '2026-11-27T09:00:20.000Z',
      detectionPath: '경보',
      commandAt: '2026-11-27T09:00:40.000Z',
      ackAt: '2026-11-27T09:00:42.000Z',
      recoveredAt: '2026-11-27T09:05:00.000Z',
      alertName: 'slo_onsale_fast_burn',
      commandExpected: true,
    },
  };
  return {
    ...base,
    ...overrides,
    run: {
      ...base.run,
      ...(overrides.run ?? {}),
      injection: { ...base.run.injection, ...(overrides.run?.injection ?? {}) },
      intervals: { ...base.run.intervals, ...(overrides.run?.intervals ?? {}) },
      host: { ...base.run.host, ...(overrides.run?.host ?? {}) },
      invariants: { ...base.run.invariants, ...(overrides.run?.invariants ?? {}) },
    },
    observation: { ...base.observation, ...(overrides.observation ?? {}) },
  };
}

/** 보고서 §1 실행 표의 그 시나리오 줄을 바꾼다. cells는 id 뒤의 7칸이다 */
function setScenarioRow(doc, id, cells) {
  const lines = doc.split('\n');
  const idx = lines.findIndex((l) => l.startsWith(`| ${id} |`));
  assert.ok(idx >= 0, `보고서에 ${id} 행이 없다`);
  lines[idx] = `| ${[id, ...cells].join(' | ')} |`;
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
    humanNoticedAt: '2026-11-27T10:01:20.000Z',
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

test('MSR-060 ① Game Day 33종 목록·실행 방식·증거 수준이 정본과 같다', async () => {
  const m = await gameday();
  assert.ok(Array.isArray(m.GAMEDAY_SCENARIOS), 'GAMEDAY_SCENARIOS가 배열이 아니다');
  assert.equal(m.GAMEDAY_SCENARIOS.length, 33);
  assert.deepEqual(m.GAMEDAY_SCENARIOS.map((s) => s.id), ALL_IDS);
  assert.deepEqual(m.GAMEDAY_MODES, ['로컬 실행', '대체 장애', '모의 진행']);

  const byMode = { '로컬 실행': [], '대체 장애': [], '모의 진행': [] };
  for (const s of m.GAMEDAY_SCENARIOS) byMode[s.mode].push(s.id);
  assert.deepEqual(byMode['로컬 실행'], LOCAL);
  assert.deepEqual(byMode['대체 장애'], ALTERNATE);
  assert.deepEqual(byMode['모의 진행'], SIMULATED);

  const byId = new Map(m.GAMEDAY_SCENARIOS.map((s) => [s.id, s]));
  assert.equal(byId.get('G-16').mode, '대체 장애');
  assert.equal(byId.get('G-16').partial, true);
  assert.equal(byId.get('G-26').mode, '대체 장애');
  assert.equal(byId.get('G-26').evidence, '설계만');
  for (const id of SIMULATED) assert.equal(byId.get(id).evidence, '설계만', `${id}는 설계만이다`);

  for (const s of m.GAMEDAY_SCENARIOS) {
    for (const key of ['target', 'inject', 'expectedAlert', 'expectedResponse']) {
      assert.equal(typeof s[key], 'string', `${s.id}.${key}가 문자열이 아니다`);
      assert.ok(s[key].length > 0, `${s.id}.${key}가 비었다`);
    }
    assert.ok(Array.isArray(s.artifacts), `${s.id}.artifacts가 배열이 아니다`);
    for (const a of ['timeline.ndjson', 'alerts.ndjson', 'commands.ndjson', 'faults.ndjson', 'invariants.csv']) {
      assert.ok(s.artifacts.includes(a), `${s.id} 산출물에 ${a}가 없다`);
    }
  }

  assert.deepEqual(m.GAMEDAY_WINDOWS, ['4d', '4e', '4f', '4g']);
  assert.deepEqual(m.GAMEDAY_DEFAULTS, {
    detectLimitSec: 60,
    propagationLimitSec: 3,
    scrapeSec: 5,
    evalSec: 5,
    groupWaitSec: 5,
    postmortemDueHours: 48,
    budgetP0Ratio: 0.2,
  });
  assert.deepEqual(m.DETECTION_PATHS, ['경보', '사람', '외부']);
  assert.ok(m.CAUSE_TYPES.includes('변경'));
  assert.ok(m.CAUSE_TYPES.includes('기반'));
  assert.ok(m.CAUSE_TYPES.includes('기타'));
});

test('MSR-060 ② 측정 창 4d~4g·잠금·중단 규칙·인자 규칙이 계획대로다', async () => {
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
    assert.equal(typeof w.estimatedMin, 'number');
  }

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

test('MSR-060 ③ K8 탐지 60초·전파 3초 경계와 무효·판정 못 함을 가른다', async () => {
  const m = await gameday();
  let r = m.judgeScenario(scenarioRun());
  assert.equal(r.verdict, '통과');
  assert.equal(r.detectionSec, 30);
  assert.equal(r.propagationSec, 2);
  assert.equal(r.alertDetected, true);

  // 탐지 60.000초는 통과, 60.001초는 미달
  r = m.judgeScenario(scenarioRun({ observation: { firstAlertAt: '2026-11-27T09:01:00.000Z' } }));
  assert.equal(r.detectionSec, 60);
  assert.equal(r.verdict, '통과');
  r = m.judgeScenario(scenarioRun({ observation: { firstAlertAt: '2026-11-27T09:01:00.001Z' } }));
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

  // 주입 증거 없음·간격 축소·미완주·호스트 포화는 무효
  r = m.judgeScenario(scenarioRun({ run: { injection: { applied: false } } }));
  assert.equal(r.verdict, '무효');
  r = m.judgeScenario(scenarioRun({ run: { intervals: { scrapeSec: 1, evalSec: 1, groupWaitSec: 1 } } }));
  assert.equal(r.verdict, '무효');
  r = m.judgeScenario(scenarioRun({ run: { complete: false } }));
  assert.equal(r.verdict, '무효');
  r = m.judgeScenario(scenarioRun({ run: { host: { cpuPct: 90, procsRunning: 20, logicalCpus: 16 } } }));
  assert.equal(r.verdict, '무효');

  // 불변식 위반은 미달
  r = m.judgeScenario(scenarioRun({ run: { invariants: { oversell: 1 } } }));
  assert.equal(r.verdict, '미달');

  // K8 밖 시나리오는 경보·전파가 없어도 불변식이 지켜지면 통과
  r = m.judgeScenario(scenarioRun({ scenario: 'G-11', observation: { firstAlertAt: null, detectionPath: null, commandExpected: false } }));
  assert.equal(r.verdict, '통과');
  r = m.judgeScenario(scenarioRun({ scenario: 'G-11', observation: { firstAlertAt: null, detectionPath: null, commandExpected: false }, run: { invariants: { doublePayment: 1 } } }));
  assert.equal(r.verdict, '미달');

  // 모의 진행·설계만은 통과가 아니다
  r = m.judgeScenario(scenarioRun({ scenario: 'G-17', mode: '모의 진행', evidence: '설계만' }));
  assert.equal(r.verdict, '판정 못 함');
  r = m.judgeScenario(scenarioRun({ scenario: 'G-26', mode: '대체 장애', evidence: '설계만' }));
  assert.equal(r.verdict, '판정 못 함');

  // K8 종합: 10종 모두 통과, 하나라도 미달·무효·누락이면 통과가 아니다
  const allPass = K8_IDS.map((id) => m.judgeScenario(scenarioRun({ scenario: id })));
  let k8 = m.judgeK8(allPass);
  assert.equal(k8.verdict, '통과');
  assert.equal(k8.detected, 10);
  assert.equal(k8.within60, 10);
  assert.equal(k8.maxPropagationSec, 2);

  const oneFail = K8_IDS.map((id) => m.judgeScenario(scenarioRun({
    scenario: id,
    observation: id === 'G-05' ? { firstAlertAt: '2026-11-27T09:01:00.001Z' } : {},
  })));
  k8 = m.judgeK8(oneFail);
  assert.equal(k8.verdict, '미달');

  const oneInvalid = K8_IDS.map((id) => m.judgeScenario(scenarioRun({
    scenario: id,
    run: id === 'G-05' ? { injection: { applied: false } } : {},
  })));
  k8 = m.judgeK8(oneInvalid);
  assert.equal(k8.verdict, '판정 못 함');

  k8 = m.judgeK8(allPass.slice(0, 9));
  assert.equal(k8.verdict, '판정 못 함');
});

test('MSR-060 ④ 포스트모템 양식이 필수 칸·원인 유형·48시간·P0 규칙을 요구한다', async () => {
  const m = await gameday();
  const template = read('docs/review/measurements/F-08-6-postmortem-template.md', '포스트모템 양식');
  for (const field of m.POSTMORTEM_FIELDS) assert.ok(template.includes(field), `양식에 '${field}' 칸이 없다`);
  for (const cause of m.CAUSE_TYPES) assert.ok(template.includes(cause), `양식에 원인 유형 '${cause}'가 없다`);
  assert.match(template, /48시간/);
  assert.match(template, /20%/);
  assert.match(template, /P0/);

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
  // 후속 조치는 하나 이상
  assert.equal(m.validatePostmortem(m.renderPostmortem(postmortem({ followUps: [] }))).ok, false);

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

test('MSR-060 ⑤ 보고서가 무효·부분·미측정을 통과로 만들지 않고 선행 측정을 인용한다', async () => {
  const m = await gameday();
  const doc = read('docs/review/measurements/F-08-6-gameday.md', 'Game Day 보고서 뼈대');
  let parsed = m.validateGamedayReport(doc, { runExists: () => false, measured: false });
  assert.equal(parsed.ok, true, parsed.errors.join(' / '));
  assert.equal(parsed.scenarios, 33);
  assert.equal(parsed.passed, 0);
  assert.equal(parsed.prior.f085, '무효');
  assert.equal(parsed.prior.f089, '판정 못 함');
  assert.equal(parsed.prior.f0810, '미측정');

  // 실행 ID 없는 통과는 거부
  const noEvidence = setScenarioRow(doc, 'G-01', ['4d', '로컬 실행', '측정함', '적용', '통과', '—', '증거 없음']);
  assert.equal(m.validateGamedayReport(noEvidence, { runExists: () => false, measured: true }).ok, false);
  // 설계만·모의 진행은 통과가 아니다
  const designPass = setScenarioRow(doc, 'G-26', ['4f', '대체 장애', '설계만', '적용', '통과', '2026-11-27-f086-g26', '설계만인데 통과']);
  assert.equal(m.validateGamedayReport(designPass, { runExists: (id) => id === '2026-11-27-f086-g26', measured: true }).ok, false);
  // 선행 측정을 통과로 바꾸면 거부
  const priorPass = doc.replace(/\| F-08-5 \| [^|]+ \| [^|]+ \|/, '| F-08-5 | NFR-027·V-T10 | 통과 | docs/review/measurements/F-08-5-soak.md |');
  assert.equal(m.validateGamedayReport(priorPass, { runExists: () => false, measured: false }).ok, false);
  // 금지 수치 주장
  const claim = doc.replace('## 7. 주장하지 않는 것', '## 7. 주장하지 않는 것\n\n- K7 0건을 달성했다.');
  assert.equal(m.validateGamedayReport(claim, { runExists: () => false, measured: false }).ok, false);
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
  const parsed = m.validateSloKpiAdr(doc, { measured: false });
  assert.equal(parsed.ok, true, parsed.errors.join(' / '));
  assert.equal(parsed.rows, 20);
  assert.deepEqual(parsed.decisions, Array(20).fill('보류'));
});

test('MSR-070 ⑦ ADR 초안이 측정 전 값을 미측정으로 두고 근거 없는 목표 변경을 거부한다', async () => {
  const m = await gameday();
  const doc = read('docs/review/measurements/F-08-6-slo-kpi-adr-draft.md', 'SLO/KPI ADR 초안');
  assert.match(doc, /미측정/);
  assert.doesNotMatch(doc, /통과/);

  // 측정 전인데 조정하면 거부
  const early = setAdrRow(doc, 'SLO-NFR-001', ['대기열 진입', 'docs/observability.md §4', '정본 값(위치 참조)', '미측정', '조정', '—']);
  assert.equal(m.validateSloKpiAdr(early, { measured: false }).ok, false);
  // 측정 뒤라도 근거·되돌릴 조건이 없으면 조정 거부
  const noEvidence = setAdrRow(doc, 'SLO-NFR-001', ['대기열 진입', 'docs/observability.md §4', '정본 값(위치 참조)', '2026-11-27-f086-g01', '조정', '—']);
  assert.equal(m.validateSloKpiAdr(noEvidence, { measured: true }).ok, false);
  // 근거와 되돌릴 조건이 있으면 조정 가능
  const changed = setAdrRow(doc, 'SLO-NFR-001', ['대기열 진입', 'docs/observability.md §4', '정본 값(위치 참조)', '2026-11-27-f086-g01', '조정', '실행 ID 2026-11-27-f086-g01, 되돌릴 조건: 세 번 연속 미달이면 정본 값으로']);
  assert.equal(m.validateSloKpiAdr(changed, { measured: true }).ok, true);
  // 목표가 없는 관측 지표는 조정할 수 없다
  const observed = setAdrRow(doc, 'KPI-BOT-TRAFFIC-RATIO', ['봇 트래픽 비율', 'docs/planning/01-overview.md §3.2', '목표 없음', '2026-11-27-f086-g01', '조정', '실행 ID, 되돌릴 조건: 없음']);
  assert.equal(m.validateSloKpiAdr(observed, { measured: true }).ok, false);
  // 중복·누락 줄은 거부
  const duplicate = doc.replace(/(\| SLO-NFR-001 \|[^\n]*\n)/, '$1$1');
  assert.equal(m.validateSloKpiAdr(duplicate, { measured: false }).ok, false);
  const missing = doc.split('\n').filter((l) => !l.startsWith('| SLO-NFR-012 |')).join('\n');
  assert.equal(m.validateSloKpiAdr(missing, { measured: false }).ok, false);
});

test('MSR-070 ⑧ 실행 계획 JSON과 F-08-5·F-08-9·F-08-10 경계·금지 수치가 맞다', async () => {
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
  for (const token of ['F-08-5', 'F-08-9', 'F-08-10', 'K1', 'K2', 'K7', '30,000건/초', '100만', 'docker-all']) {
    assert.ok(notIncluded.includes(token), `notIncluded에 '${token}'가 없다`);
  }
  const risk = plan.remainingRisk.join('\n');
  for (const token of ['F-08-5', '무효', 'F-08-9', '판정 못 함', 'G-26', '설계만', '모의 진행']) {
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
  for (const token of ['F-08-5', 'F-08-9', 'F-08-10', '미측정', '무효', '판정 못 함', '30,000건/초', '100만', 'K1', 'K2', 'K7']) {
    assert.ok(text.includes(token), `계획에 '${token}' 경계 문구가 없다`);
  }
});
