// F-08-12 Game Day 로컬 ①·② 시험. Docker·kind·k6·브라우저 없이 카탈로그·판정·보고서·계획만 본다.
// 정본 값은 시험 안에 적고, 구현 상수를 가져오지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNER = path.join(ROOT, 'loadtest', 'runner', 'gameday-local.mjs');
const PLAN_JSON = path.join(ROOT, 'loadtest', 'plan', 'f0812-plan.json');
const REPORT = path.join(ROOT, 'docs', 'review', 'measurements', 'F-08-12-gameday-local.md');
const PLAN_DOC = path.join(ROOT, 'docs', 'review', 'plans', 'F-08-12.md');

// docs/observability.md §12·docs/verification.md §5.2에서 온 14종.
// stageReady는 '전체 시나리오 무대가 준비됐는가'다. partialParts는 무대가 없어도 할 수 있는 부분이다.
const EXPECTED = [
  { id: 'G-02', order: 1, group: 'A', window: '3a', mode: '대체 장애', evidence: '측정함', stageReady: false, partial: 1, runbook: 'RB-06', name: /좌석 Redis/ },
  { id: 'G-10', order: 2, group: 'A', window: '3a', mode: '대체 장애', evidence: '측정함', stageReady: false, partial: 0, runbook: 'RB-11', name: /Kafka/ },
  { id: 'G-29', order: 3, group: 'A', window: '3a', mode: '대체 장애', evidence: '측정함', stageReady: false, partial: 1, runbook: 'RB-05', name: /세션·캐시 Redis/ },
  { id: 'G-30', order: 4, group: 'A', window: '3a', mode: '로컬 실행', evidence: '측정함', stageReady: false, partial: 0, runbook: 'RB-18', name: /Schema Registry/ },
  { id: 'G-31', order: 5, group: 'A', window: '3a', mode: '로컬 실행', evidence: '측정함', stageReady: true, partial: 0, runbook: 'RB-11·RB-39', name: /MSK/ },
  { id: 'G-17', order: 6, group: 'B', window: '3b', mode: '모의 진행', evidence: '설계만', stageReady: true, partial: 0, runbook: 'RB-20·RB-17', name: /보안 사고/ },
  { id: 'G-18', order: 7, group: 'B', window: '3b', mode: '로컬 실행', evidence: '측정함', stageReady: false, partial: 0, runbook: 'RB-23', name: /나쁜 배포/ },
  { id: 'G-19', order: 8, group: 'B', window: '3b', mode: '로컬 실행', evidence: '측정함', stageReady: false, partial: 0, runbook: 'RB-28', name: /변경 동결/ },
  { id: 'G-20', order: 9, group: 'B', window: '3b', mode: '로컬 실행', evidence: '측정함', stageReady: false, partial: 1, runbook: 'RB-27', name: /Kyverno/ },
  { id: 'G-21', order: 10, group: 'B', window: '3b', mode: '로컬 실행', evidence: '측정함', stageReady: true, partial: 0, runbook: 'RB-09', name: /제어 입력/ },
  { id: 'G-22', order: 11, group: 'B', window: '3c', mode: '로컬 실행', evidence: '측정함', stageReady: false, partial: 0, runbook: 'RB-30', name: /KEDA/ },
  { id: 'G-23', order: 12, group: 'B', window: '3c', mode: '로컬 실행', evidence: '측정함', stageReady: true, partial: 0, runbook: 'RB-06·RB-32', name: /공유 의존성/ },
  { id: 'G-24', order: 13, group: 'B', window: '3c', mode: '로컬 실행', evidence: '측정함', stageReady: false, partial: 1, runbook: 'RB-31·RB-32', name: /재시작 전 증거/ },
  { id: 'G-25', order: 14, group: 'B', window: '3c', mode: '로컬 실행', evidence: '측정함', stageReady: false, partial: 0, runbook: 'RB-33', name: /조용한 실패/ },
];
const IDS = EXPECTED.map((s) => s.id);
const GROUP_A = ['G-02', 'G-10', 'G-29', 'G-30', 'G-31'];
const GROUP_B = ['G-17', 'G-18', 'G-19', 'G-20', 'G-21', 'G-22', 'G-23', 'G-24', 'G-25'];
const OUTSIDE = [
  { id: 'G-01', owner: 'F-08-6' },
  { id: 'G-03', owner: 'F-08-6' },
  { id: 'G-04', owner: 'F-08-6' },
  { id: 'G-05', owner: 'F-08-6' },
  { id: 'G-06', owner: 'F-08-6' },
  { id: 'G-07', owner: 'F-08-6' },
  { id: 'G-08', owner: 'F-08-6' },
  { id: 'G-09', owner: 'F-08-6' },
  { id: 'G-11', owner: 'F-08-6' },
  { id: 'G-12', owner: 'F-08-6' },
  { id: 'G-13', owner: 'F-08-6' },
  { id: 'G-14', owner: 'F-08-6' },
  { id: 'G-15', owner: 'F-08-6' },
  { id: 'G-16', owner: 'F-08-6' },
  { id: 'G-26', owner: 'F-08-13' },
  { id: 'G-27', owner: 'F-08-13' },
  { id: 'G-28', owner: 'F-08-13' },
  { id: 'G-32', owner: 'F-08-13' },
  { id: 'G-33', owner: 'F-08-13' },
];
const ARTIFACTS = ['timeline.csv', 'manifest.json', 'alerts.ndjson', 'faults.ndjson', 'invariants.csv', 'host.json', 'run.json', 'generator.json'];
const CAUSES = ['변경', '외부 의존', '내부 저장소·메시징', '용량·포화', '코드 결함', '데이터', '보안', '운영 조작', '기반'];
const FORBIDDEN = ['30k/s', '30,000건/초', '100만', 'K1', 'K2', 'K7'];
const EXECUTION_CLAIMS = ['실행했다', '검증됐다', '측정했다'];

async function load() {
  if (!fs.existsSync(RUNNER)) return { missing: 'loadtest/runner/gameday-local.mjs' };
  try {
    return await import(pathToFileURL(RUNNER).href);
  } catch (error) {
    return { error };
  }
}

function need(mod) {
  if (mod.missing) assert.fail(`${mod.missing}가 없다`);
  if (mod.error) assert.fail(`loadtest/runner/gameday-local.mjs를 읽지 못했다: ${mod.error.message}`);
  return mod;
}

function read(rel) {
  const file = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!fs.existsSync(file)) assert.fail(`${path.relative(ROOT, file)}가 없다`);
  return fs.readFileSync(file, 'utf8');
}

function readJson(file) {
  if (!fs.existsSync(file)) assert.fail(`${path.relative(ROOT, file)}가 없다`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    assert.fail(`${path.relative(ROOT, file)} JSON을 읽지 못했다: ${error.message}`);
  }
}

function scenarioOf(mod, id) {
  assert.equal(typeof mod.scenarioOf, 'function', 'scenarioOf 함수가 없다');
  const s = mod.scenarioOf(id);
  assert.ok(s, `시나리오 ${id}가 없다`);
  return s;
}

function usage(fn) {
  assert.throws(fn, (error) => {
    if (error?.name === 'UsageError') return true;
    return /window|창|scenario|시나리오|group|묶음|run-id|기록|docker-all|browser|leak|모르는|필수/.test(String(error?.message ?? ''));
  });
}

const OBS = {
  detectionPath: '경보',
  firstAlertAt: '2026-11-28T10:00:20.000+09:00',
  humanNoticedAt: '2026-11-28T10:00:25.000+09:00',
  commandAt: '2026-11-28T10:00:30.000+09:00',
  ackAt: '2026-11-28T10:00:32.000+09:00',
  commandExpected: false,
};

function cleanRun(overrides = {}) {
  return {
    complete: true,
    injection: { at: '2026-11-28T10:00:00.000+09:00', applied: true, evidence: 'Valkey 파드 종료 확인', rollbackOk: true },
    host: { cpuPct: 50, procsRunning: 4, logicalCpus: 8 },
    generator: { droppedIterations: 0, cpuPct: 40, memPct: 50 },
    httpReqs: 100,
    invariants: { oversell: 0, doublePayment: 0, admitBeforeTurn: 0 },
    responseChecks: {
      expectedAlert: { ok: true, evidence: 'ALERTS firing' },
      expectedAction: { ok: true, evidence: '503 관측' },
      invariantHeld: { ok: true, evidence: 'invariants 0' },
    },
    timeline: { T0: '09:59:00', T1: '10:00:00', T1p: '10:00:10', T2: '10:00:20', T3: '10:00:30', T4: '10:00:40' },
    ...overrides,
  };
}

function input(id, overrides = {}) {
  const spec = EXPECTED.find((s) => s.id === id);
  return {
    scenario: id,
    mode: spec.mode,
    evidence: spec.evidence,
    run: cleanRun(),
    observation: { ...OBS },
    ...overrides,
  };
}

function verdict(mod, id, overrides = {}) {
  const result = mod.judgeLocalScenario(input(id, overrides));
  assert.ok(result && typeof result.verdict === 'string', `${id} 판정 결과가 없다`);
  return result;
}

function reportFixture({ pass = null, incident = null } = {}) {
  const rows = EXPECTED.map((s) => {
    if (pass && s.id === pass.id) return `| ${s.id} | ${s.window} | ${s.mode} | 측정함 | 적용 | 통과 | ${pass.runId} |`;
    return `| ${s.id} | ${s.window} | ${s.mode} | ${s.evidence} | — | 미측정 | — |`;
  }).join('\n');
  const incidents = [
    '| 인시던트 | 시나리오 | 선언 시각 | 끝 시각 | 완료 시각 | 예산 비율 | P0 | 포스트모템 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    incident ?? '',
  ].join('\n');
  return [
    '# F-08-12 Game Day 로컬 ①·② 보고서',
    '',
    '- **상태**: 미측정.',
    '',
    '## 1. 실행 표',
    '',
    '| 시나리오 | 창 | 실행 방식 | 증거 수준 | 주입 | 판정 | 증거 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    rows,
    '',
    '## 3. 인시던트와 포스트모템',
    '',
    incidents,
    '',
    '## 4. 선행 측정 인용',
    '',
    '- F-08-5: 무효·미측정',
    '- F-08-9: 판정 못 함(무효·부분)',
    '- F-08-10: 미측정',
    '',
    '## 7. 주장하지 않는 것',
    '',
    '- 30,000건/초·100만·K1/K2/K7 0을 주장하지 않는다.',
  ].join('\n');
}

test('F0812-1 ① 14종의 묶음·차례·ID가 ① 5종·② 9종과 같다', async () => {
  const mod = need(await load());
  assert.equal(mod.F0812_SCENARIOS.length, 14, '시나리오가 14종이 아니다');
  assert.deepEqual(mod.F0812_SCENARIOS.map((s) => s.id), IDS, '14종 ID·차례가 다르다');
  assert.deepEqual(mod.F0812_SCENARIOS.map((s) => s.order), EXPECTED.map((s) => s.order), 'order가 1~14가 아니다');
  assert.deepEqual(mod.F0812_GROUPS.map((g) => g.id), ['A', 'B'], '묶음이 A·B가 아니다');
  assert.deepEqual(mod.F0812_GROUPS[0].scenarioIds, GROUP_A, '① 5종이 다르다');
  assert.deepEqual(mod.F0812_GROUPS[1].scenarioIds, GROUP_B, '② 9종이 다르다');
  assert.equal(mod.F0812_SCENARIOS.filter((s) => s.group === 'A').length, 5, '①이 5종이 아니다');
  assert.equal(mod.F0812_SCENARIOS.filter((s) => s.group === 'B').length, 9, '②가 9종이 아니다');
});

test('F0812-1 ② 14종의 방식·증거·무대·런북·기대 대응·산출물이 정본과 같다', async () => {
  const mod = need(await load());
  assert.deepEqual(mod.F0812_MODES, ['로컬 실행', '대체 장애', '모의 진행'], '실행 방식 목록이 다르다');
  assert.deepEqual(mod.F0812_EVIDENCE, ['측정함', '설계만'], '증거 수준 목록이 다르다');
  assert.deepEqual(mod.F0812_VERDICTS, ['통과', '미달', '판정 못 함', '무효', '미측정'], '판정값 목록이 다르다');
  assert.deepEqual([...mod.F0812_ARTIFACTS].sort(), [...ARTIFACTS].sort(), '산출물 목록이 다르다');
  for (const s of EXPECTED) {
    const got = scenarioOf(mod, s.id);
    assert.equal(got.order, s.order, `${s.id} order가 다르다`);
    assert.equal(got.group, s.group, `${s.id} 묶음이 다르다`);
    assert.equal(got.window, s.window, `${s.id} 창이 다르다`);
    assert.equal(got.mode, s.mode, `${s.id} 실행 방식이 다르다`);
    assert.equal(got.evidence, s.evidence, `${s.id} 증거 수준이 다르다`);
    assert.equal(got.stageReady, s.stageReady, `${s.id} 무대 온전 여부가 다르다`);
    assert.equal(got.runbook, s.runbook, `${s.id} 런북이 다르다`);
    assert.match(got.name, s.name, `${s.id} 이름이 정본과 다르다`);
    assert.ok(Array.isArray(got.missing), `${s.id} missing이 배열이 아니다`);
    assert.ok(Array.isArray(got.partialParts), `${s.id} partialParts가 배열이 아니다`);
    assert.equal(got.partialParts.length, s.partial, `${s.id} 부분 실행 수가 다르다`);
    if (s.stageReady) assert.deepEqual(got.missing, [], `${s.id} 무대가 온전한데 빠진 부품이 있다`);
    else assert.ok(got.missing.length > 0, `${s.id} 무대가 없는데 빠진 부품이 비었다`);
    for (const key of ['fault', 'expectedAlert', 'expectedAction', 'invariant']) {
      assert.equal(typeof got[key], 'string', `${s.id} ${key}가 문자열이 아니다`);
      assert.ok(got[key].trim().length > 0, `${s.id} ${key}가 비었다`);
    }
    assert.equal(typeof got.load, 'boolean', `${s.id} load가 불리언이 아니다`);
    assert.equal(typeof got.commandExpected, 'boolean', `${s.id} commandExpected가 불리언이 아니다`);
    assert.deepEqual([...got.artifacts].sort(), [...ARTIFACTS].sort(), `${s.id} 산출물이 다르다`);
    if (s.id === 'G-29' || s.id === 'G-30') {
      assert.equal(typeof got.runbookNote, 'string', `${s.id} 런북 공백 메모가 없다`);
      assert.match(got.runbookNote, /없/, `${s.id} 런북 공백 메모가 공백을 말하지 않는다`);
    }
  }
  assert.equal(scenarioOf(mod, 'G-17').mode, '모의 진행', 'G-17이 모의 진행이 아니다');
  assert.equal(scenarioOf(mod, 'G-17').evidence, '설계만', 'G-17이 설계만이 아니다');
  assert.equal(scenarioOf(mod, 'G-17').load, false, 'G-17에 부하가 있다');
  assert.equal(scenarioOf(mod, 'G-23').load, true, 'G-23에 부하가 없다');
  assert.equal(scenarioOf(mod, 'G-31').commandExpected, true, 'G-31에 명령 전파가 없다');
  assert.equal(scenarioOf(mod, 'G-23').commandExpected, false, 'G-23에 명령 전파가 있다');
});

test('F0812-1 ③ 시나리오 ID·런북이 정본 문서와 파일에 있고 G-29·G-30 공백을 적는다', async () => {
  const mod = need(await load());
  const canon = read('docs/observability.md');
  const infra = read('docs/infra.md');
  for (const id of IDS) {
    assert.match(canon, new RegExp(`\\|\\s*${id}\\s*\\|`), `docs/observability.md §12에 ${id} 행이 없다`);
    const got = scenarioOf(mod, id);
    for (const rb of got.runbook.split('·')) {
      assert.match(rb, /^RB-\d\d$/, `${id} 런북 ID ${rb}가 RB-NN 꼴이 아니다`);
      assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'runbooks', `${rb}.md`)), `${id} 런북 ${rb}.md가 없다`);
      assert.ok(infra.includes(`(runbooks/${rb}.md)`), `docs/infra.md §10이 ${rb} 파일을 가리키지 않는다`);
    }
  }
  const g29 = scenarioOf(mod, 'G-29');
  const g30 = scenarioOf(mod, 'G-30');
  assert.match(g29.runbookNote, /세션|캐시|Redis/, 'G-29 런북 공백이 세션·캐시 Redis를 말하지 않는다');
  assert.match(g30.runbookNote, /Schema Registry/, 'G-30 런북 공백이 Schema Registry를 말하지 않는다');
  assert.match(read('docs/runbooks/incident-criteria.md'), /48시간/, '인시던트 기준에 48시간이 없다');
  assert.match(read('docs/runbooks/index.md'), /RB-17/, '런북 색인에 RB-17이 없다');
});

test('F0812-2 ① 창 3a~3c·5/5/4·잠금·중단 규칙 10·경계 19종이 맞다', async () => {
  const mod = need(await load());
  assert.deepEqual(mod.F0812_WINDOWS.map((w) => w.id), ['3a', '3b', '3c'], '창이 3a~3c가 아니다');
  assert.deepEqual(mod.F0812_WINDOWS.map((w) => w.scenarioIds), [GROUP_A, ['G-17', 'G-18', 'G-19', 'G-20', 'G-21'], ['G-22', 'G-23', 'G-24', 'G-25']], '창별 시나리오가 다르다');
  assert.deepEqual(mod.F0812_WINDOWS.map((w) => w.scenarioIds.length), [5, 5, 4], '창별 5/5/4가 아니다');
  assert.deepEqual(mod.F0812_DEFAULTS, {
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
    maxHostCpuPct: 85,
    maxGeneratorCpuPct: 80,
    maxGeneratorMemPct: 90,
  }, '기본값이 정본과 다르다');
  assert.equal(mod.F0812_LOCK.take, 'docker lane4-F-08-12', '잠금 take가 다르다');
  assert.equal(mod.F0812_LOCK.drop, 'docker lane4-F-08-12', '잠금 drop이 다르다');
  assert.equal(mod.F0812_LOCK.dockerAll, false, 'docker-all을 허용한다');
  assert.equal(mod.F0812_STOP_RULES.length, 10, '중단 규칙이 10개가 아니다');
  assert.deepEqual(mod.F0812_STOP_RULES.map((r) => r.id), Array.from({ length: 10 }, (_, i) => `STOP-${String(i + 1).padStart(2, '0')}`), '중단 규칙 ID가 STOP-01~10이 아니다');
  assert.deepEqual(mod.F0812_PRIOR_MEASUREMENTS, { 'F-08-5': '무효·미측정', 'F-08-9': '판정 못 함(무효·부분)', 'F-08-10': '미측정' }, '선행 측정 인용이 다르다');
  assert.equal(mod.F0812_OUTSIDE.length, 19, '경계 19종이 아니다');
  assert.deepEqual([...mod.F0812_OUTSIDE.map((s) => s.id)].sort(), [...OUTSIDE.map((s) => s.id)].sort(), '경계 19종 ID가 다르다');
  for (const s of OUTSIDE) {
    const got = mod.F0812_OUTSIDE.find((x) => x.id === s.id);
    assert.equal(got?.owner, s.owner, `${s.id} 소유 기능이 다르다`);
  }
  assert.equal(mod.F0812_OUTSIDE.filter((s) => s.owner === 'F-08-6').length, 14, 'F-08-6 경계가 14종이 아니다');
  assert.equal(mod.F0812_OUTSIDE.filter((s) => s.owner === 'F-08-13').length, 5, 'F-08-13 경계가 5종이 아니다');
  assert.deepEqual(mod.F0812_POSTMORTEM.causeTypes, CAUSES, '포스트모템 원인 유형 9가지가 다르다');
  assert.equal(mod.F0812_POSTMORTEM.dueHours, 48, '포스트모템 48시간이 아니다');
  assert.equal(mod.F0812_POSTMORTEM.p0BudgetRatio, 0.2, 'P0 예산 20%가 아니다');
});

test('F0812-2 ② 인자 검사가 창·시나리오·기록·재연·금지 인자를 가른다', async () => {
  const mod = need(await load());
  usage(() => mod.parseGamedayLocalArgs([]));
  usage(() => mod.parseGamedayLocalArgs(['--window', '4d']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3b', '--scenario', 'G-02']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--group', 'B']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--record']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--record', '--run-id', '2026-11-28-g02']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--rehearsal', '--record', '--run-id', '2026-11-28-f0812']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--docker-all']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--browser']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--leak']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--unknown']));

  const plain = mod.parseGamedayLocalArgs(['--window', '3a']);
  assert.equal(plain.window, '3a');
  assert.equal(plain.record, false);
  assert.equal(plain.rehearsal, false);
  const one = mod.parseGamedayLocalArgs(['--window', '3a', '--scenario', 'G-02', '--record', '--run-id', '2026-11-28-f0812-g02', '--out', '.cache/peaket-f0812/g02']);
  assert.equal(one.scenario, 'G-02');
  assert.equal(one.record, true);
  assert.equal(one.runId, '2026-11-28-f0812-g02');
  assert.equal(one.out, '.cache/peaket-f0812/g02');
  const group = mod.parseGamedayLocalArgs(['--window', '3b', '--group', 'B', '--rehearsal']);
  assert.equal(group.group, 'B');
  assert.equal(group.rehearsal, true);
  assert.equal(group.record, false);
  const judge = mod.parseGamedayLocalArgs(['--window', '3a', '--judge', '.cache/peaket-f0812/judge']);
  assert.equal(judge.judge, '.cache/peaket-f0812/judge');
});

test('F0812-3 ① 무대 없음·부분·방식·증거가 다르면 통과가 아니다', async () => {
  const mod = need(await load());
  assert.equal(verdict(mod, 'G-30').verdict, '판정 못 함', '무대 없는 G-30이 통과했다');
  assert.equal(verdict(mod, 'G-02').verdict, '판정 못 함', '부분 실행 G-02가 통과했다');
  assert.equal(verdict(mod, 'G-20').verdict, '판정 못 함', '부분 실행 G-20이 통과했다');
  assert.equal(verdict(mod, 'G-24').verdict, '판정 못 함', '부분 실행 G-24가 통과했다');
  assert.equal(verdict(mod, 'G-29').verdict, '판정 못 함', '부분 실행 G-29가 통과했다');
  assert.equal(verdict(mod, 'G-17').verdict, '판정 못 함', '모의 진행 G-17이 통과했다');
  assert.equal(verdict(mod, 'G-23', { mode: '대체 장애' }).verdict, '판정 못 함', '실행 방식이 달라도 통과했다');
  assert.equal(verdict(mod, 'G-23', { evidence: '설계만' }).verdict, '판정 못 함', '증거 수준이 달라도 통과했다');
  assert.equal(verdict(mod, 'G-23').verdict, '통과', '무대가 온전한 G-23 깨끗한 실행이 통과하지 않았다');
  assert.equal(verdict(mod, 'G-31').verdict, '통과', '무대가 온전한 G-31 깨끗한 실행이 통과하지 않았다');
});

test('F0812-3 ② 미완주·주입 증거 없음·롤백 실패·호스트 포화는 무효다', async () => {
  const mod = need(await load());
  assert.equal(verdict(mod, 'G-23', { run: cleanRun({ complete: false }) }).verdict, '무효');
  assert.equal(verdict(mod, 'G-23', { run: cleanRun({ injection: { ...cleanRun().injection, applied: false } }) }).verdict, '무효');
  assert.equal(verdict(mod, 'G-23', { run: cleanRun({ injection: { ...cleanRun().injection, evidence: '' } }) }).verdict, '무효');
  assert.equal(verdict(mod, 'G-23', { run: cleanRun({ injection: { ...cleanRun().injection, rollbackOk: false } }) }).verdict, '무효');
  assert.equal(verdict(mod, 'G-23', { run: cleanRun({ host: { cpuPct: 85, procsRunning: 4, logicalCpus: 8 } }) }).verdict, '무효');
  assert.equal(verdict(mod, 'G-23', { run: cleanRun({ host: { cpuPct: 84.9, procsRunning: 4, logicalCpus: 8 } }) }).verdict, '통과');
  assert.equal(verdict(mod, 'G-23', { run: cleanRun({ host: { cpuPct: 50, procsRunning: 9, logicalCpus: 8 } }) }).verdict, '무효');
});

test('F0812-3 ③ 발생기 dropped·CPU·메모리·http_reqs 경계를 무효로 가른다', async () => {
  const mod = need(await load());
  const withGen = (generator, extra = {}) => cleanRun({ generator: { ...cleanRun().generator, ...generator }, ...extra });
  assert.equal(verdict(mod, 'G-23', { run: withGen({ droppedIterations: 1 }) }).verdict, '무효');
  assert.equal(verdict(mod, 'G-23', { run: withGen({ droppedIterations: 0 }) }).verdict, '통과');
  assert.equal(verdict(mod, 'G-23', { run: withGen({ cpuPct: 80 }) }).verdict, '통과');
  assert.equal(verdict(mod, 'G-23', { run: withGen({ cpuPct: 80.1 }) }).verdict, '무효');
  assert.equal(verdict(mod, 'G-23', { run: withGen({ memPct: 90 }) }).verdict, '통과');
  assert.equal(verdict(mod, 'G-23', { run: withGen({ memPct: 90.1 }) }).verdict, '무효');
  assert.equal(verdict(mod, 'G-23', { run: cleanRun({ httpReqs: 0 }) }).verdict, '무효');
  assert.equal(verdict(mod, 'G-23', { run: cleanRun({ httpReqs: 1 }) }).verdict, '통과');
});

test('F0812-3 ④ 불변식·경보·사람 우선·탐지 60초·전파 3초 경계를 미달로 가른다', async () => {
  const mod = need(await load());
  for (const key of ['oversell', 'doublePayment', 'admitBeforeTurn']) {
    const run = cleanRun({ invariants: { ...cleanRun().invariants, [key]: 1 } });
    assert.equal(verdict(mod, 'G-23', { run }).verdict, '미달', `${key} 1건이 미달이 아니다`);
  }
  assert.equal(verdict(mod, 'G-23', { observation: { ...OBS, detectionPath: '사람' } }).verdict, '미달');
  assert.equal(verdict(mod, 'G-23', { observation: { ...OBS, firstAlertAt: null } }).verdict, '미달');
  assert.equal(verdict(mod, 'G-23', { observation: { ...OBS, humanNoticedAt: '2026-11-28T10:00:10.000+09:00' } }).verdict, '미달');
  assert.equal(verdict(mod, 'G-23', { observation: { ...OBS, firstAlertAt: '2026-11-28T10:01:00.000+09:00', humanNoticedAt: '2026-11-28T10:01:05.000+09:00' } }).verdict, '통과');
  assert.equal(verdict(mod, 'G-23', { observation: { ...OBS, firstAlertAt: '2026-11-28T10:01:00.001+09:00', humanNoticedAt: '2026-11-28T10:01:05.000+09:00' } }).verdict, '미달');
  const command3 = { ...OBS, commandExpected: true, commandAt: '2026-11-28T10:00:30.000+09:00', ackAt: '2026-11-28T10:00:33.000+09:00' };
  assert.equal(verdict(mod, 'G-31', { observation: command3 }).verdict, '통과');
  const command3001 = { ...command3, ackAt: '2026-11-28T10:00:33.001+09:00' };
  assert.equal(verdict(mod, 'G-31', { observation: command3001 }).verdict, '미달');
});

test('F0812-3 ⑤ 기대 대응·시간선·모의 진행은 판정 못 함이고 깨끗한 실행만 통과다', async () => {
  const mod = need(await load());
  const noAlert = cleanRun({ responseChecks: { ...cleanRun().responseChecks, expectedAlert: undefined } });
  assert.equal(verdict(mod, 'G-23', { run: noAlert }).verdict, '판정 못 함');
  const badAction = cleanRun({ responseChecks: { ...cleanRun().responseChecks, expectedAction: { ok: false, evidence: '503 없음' } } });
  assert.equal(verdict(mod, 'G-23', { run: badAction }).verdict, '미달');
  const emptyEvidence = cleanRun({ responseChecks: { ...cleanRun().responseChecks, invariantHeld: { ok: true, evidence: '' } } });
  assert.equal(verdict(mod, 'G-23', { run: emptyEvidence }).verdict, '판정 못 함');
  const noT1p = cleanRun({ timeline: { ...cleanRun().timeline, T1p: undefined } });
  assert.equal(verdict(mod, 'G-23', { run: noT1p }).verdict, '판정 못 함');
  const clean = mod.judgeLocalScenario(input('G-23'));
  assert.equal(clean.verdict, '통과');
  assert.equal(clean.detectionSec, 20);
  assert.ok(clean.propagationSec === 2 || clean.propagationSec === null, '전파 값이 2초도 null도 아니다');
  assert.equal(clean.alertDetected, true);
});

test('F0812-4 ① 묶음 종합이 무효·판정 못 함·미달·통과를 가른다', async () => {
  const mod = need(await load());
  const result = (verdicts) => Object.entries(verdicts).map(([scenario, v]) => ({ scenario, verdict: v }));
  const passA = result(Object.fromEntries(GROUP_A.map((id) => [id, '통과'])));
  assert.equal(mod.judgeLocalGroup('A', passA).verdict, '통과');
  assert.equal(mod.judgeLocalGroup('A', result({ ...Object.fromEntries(GROUP_A.map((id) => [id, '통과'])), 'G-02': '미달' })).verdict, '미달');
  assert.equal(mod.judgeLocalGroup('A', result({ ...Object.fromEntries(GROUP_A.map((id) => [id, '통과'])), 'G-02': '무효' })).verdict, '판정 못 함');
  assert.equal(mod.judgeLocalGroup('A', result({ ...Object.fromEntries(GROUP_A.map((id) => [id, '통과'])), 'G-02': '판정 못 함' })).verdict, '판정 못 함');
  assert.equal(mod.judgeLocalGroup('A', []).verdict, '판정 못 함');
  assert.equal(mod.judgeLocalGroup('B', result(Object.fromEntries(GROUP_B.slice(0, 8).map((id) => [id, '통과'])))).verdict, '판정 못 함');
});

test('F0812-4 ② 보고서 뼈대가 14행·0통과·선행 인용·인시던트 표를 둔다', async () => {
  const mod = need(await load());
  const md = mod.renderLocalReport({});
  assert.match(md, /F-08-12/, '보고서 제목에 F-08-12가 없다');
  const exec = md.split(/\n## /).find((part) => part.startsWith('1.')) ?? '';
  const rows = exec.split('\n').filter((line) => /^\|\s*G-\d\d\s*\|/.test(line));
  assert.equal(rows.length, 14, '보고서 실행 표가 14행이 아니다');
  assert.ok(!/\| 통과 \|/.test(md), '미측정 뼈대에 통과 행이 있다');
  assert.ok(!rows.some((row) => row.includes('실측(PC)')), '미측정 뼈대 실행 행에 실측(PC) 표시가 있다');
  assert.match(md, /F-08-5/, 'F-08-5 선행 인용이 없다');
  assert.match(md, /무효·미측정/, 'F-08-5 무효·미측정이 없다');
  assert.match(md, /F-08-9/, 'F-08-9 선행 인용이 없다');
  assert.match(md, /판정 못 함\(무효·부분\)/, 'F-08-9 판정 못 함(무효·부분)이 없다');
  assert.match(md, /F-08-10/, 'F-08-10 선행 인용이 없다');
  assert.match(md, /인시던트 \| 시나리오 \| 선언 시각/, '인시던트 표가 없다');
  const check = mod.validateLocalReport(md, { measured: false, runExists: () => false, runResponseOk: () => false, postmortemExists: () => false, postmortemOk: () => false });
  assert.equal(check.ok, true, `미측정 뼈대를 거부했다: ${(check.reasons ?? []).join('; ')}`);
  assert.equal(check.passed, 0, '미측정 뼈대의 통과 수가 0이 아니다');
});

test('F0812-4 ③ 보고서가 실행 ID·기대 대응·무대·포스트모템 없는 통과와 금지 수치를 거부한다', async () => {
  const mod = need(await load());
  const pass = reportFixture({ pass: { id: 'G-23', runId: '2026-11-28-f0812-g23' } });
  const options = { measured: true, runExists: (id) => id === '2026-11-28-f0812-g23', runResponseOk: () => true, postmortemExists: () => true, postmortemOk: () => true };
  assert.equal(mod.validateLocalReport(pass, options).ok, true, '정상 통과 행을 거부했다');
  assert.equal(mod.validateLocalReport(pass, options).passed, 1, '통과 수가 1이 아니다');
  assert.equal(mod.validateLocalReport(pass, { ...options, measured: false }).ok, false, '측정 전 통과를 허용했다');
  assert.equal(mod.validateLocalReport(pass, { ...options, runExists: () => false }).ok, false, '실행 ID 없는 통과를 허용했다');
  assert.equal(mod.validateLocalReport(pass, { ...options, runResponseOk: () => false }).ok, false, '기대 대응 없는 통과를 허용했다');
  const stagePass = reportFixture({ pass: { id: 'G-30', runId: '2026-11-28-f0812-g30' } });
  assert.equal(mod.validateLocalReport(stagePass, { ...options, runExists: () => true, runResponseOk: () => true }).ok, false, '무대 없는 G-30 통과를 허용했다');
  const incident = '| INC-1 | G-23 | 2026-11-28T10:00:00+09:00 | 2026-11-28T10:30:00+09:00 | 2026-11-29T09:00:00+09:00 | 25% | P0 | docs/review/measurements/F-08-12-postmortem-1.md |';
  const withIncident = reportFixture({ pass: { id: 'G-23', runId: '2026-11-28-f0812-g23' }, incident });
  assert.equal(mod.validateLocalReport(withIncident, { ...options, postmortemExists: () => false }).ok, false, '포스트모템 없는 인시던트를 허용했다');
  assert.equal(mod.validateLocalReport(withIncident, { ...options, postmortemOk: () => false }).ok, false, '포스트모템 내용이 틀린 인시던트를 허용했다');
  assert.equal(mod.validateLocalReport(withIncident, options).ok, true, '정상 인시던트를 거부했다');
  const late = `| INC-2 | G-23 | 2026-11-28T10:00:00+09:00 | 2026-11-28T10:30:00+09:00 | 2026-11-30T11:00:00+09:00 | 25% | P0 | docs/review/measurements/F-08-12-postmortem-2.md |`;
  assert.equal(mod.validateLocalReport(reportFixture({ pass: { id: 'G-23', runId: '2026-11-28-f0812-g23' }, incident: late }), options).ok, false, '48시간을 넘긴 포스트모템을 허용했다');
  const noP0 = `| INC-3 | G-23 | 2026-11-28T10:00:00+09:00 | 2026-11-28T10:30:00+09:00 | 2026-11-29T09:00:00+09:00 | 25% | — | docs/review/measurements/F-08-12-postmortem-3.md |`;
  assert.equal(mod.validateLocalReport(reportFixture({ pass: { id: 'G-23', runId: '2026-11-28-f0812-g23' }, incident: noP0 }), options).ok, false, '20% 초과에 P0가 없는 인시던트를 허용했다');
  assert.equal(mod.validateLocalReport(`${reportFixture()}\n- 30k/s 달성\n`, { measured: false }).ok, false, '금지 수치 주장을 허용했다');
  assert.equal(mod.validateLocalReport(`${reportFixture()}\n- 30k/s는 주장하지 않는다\n`, { measured: false }).ok, true, '부정문 안의 금지 수치를 거부했다');
});

test('F0812-5 ① 계획 JSON이 batch·창·14종·잠금·중단 규칙·선행 인용을 담는다', async () => {
  const mod = need(await load());
  const plan = readJson(PLAN_JSON);
  const check = mod.validateLocalPlan(plan);
  assert.equal(check.ok, true, `계획 JSON이 검증을 지나지 않았다: ${(check.reasons ?? []).join('; ')}`);
  assert.equal(plan.batch, 'F-08-12');
  assert.equal(plan.feature, 'F-08-12');
  assert.deepEqual(plan.windows, ['3a', '3b', '3c']);
  assert.equal(plan.scenarios.length, 14, '계획 JSON 시나리오가 14종이 아니다');
  assert.deepEqual(plan.scenarios.map((s) => s.id), IDS, '계획 JSON 시나리오 ID·차례가 다르다');
  assert.equal(plan.lock.take, 'docker lane4-F-08-12');
  assert.equal(plan.lock.drop, 'docker lane4-F-08-12');
  assert.equal(plan.lock.dockerAll, false);
  assert.equal(plan.stopRules.length, 10, '계획 JSON 중단 규칙이 10개가 아니다');
  assert.deepEqual(plan.priorMeasurements, { 'F-08-5': '무효·미측정', 'F-08-9': '판정 못 함(무효·부분)', 'F-08-10': '미측정' });
  const notIncluded = JSON.stringify(plan.notIncluded);
  for (const token of ['F-08-6', 'F-08-9', 'F-08-10', 'F-08-11', 'F-08-13', 'F-08-8', 'F-08-5', 'F-08-2', 'K1', 'K2', 'K7', '30,000', '100만']) {
    assert.ok(notIncluded.includes(token), `계획 JSON notIncluded에 ${token}이 없다`);
  }
  assert.ok(plan.boundaries && typeof plan.boundaries === 'object', '계획 JSON boundaries가 없다');
  assert.ok(plan.boundaries['F-08-6'] && plan.boundaries['F-08-11'] && plan.boundaries['F-08-13'], '계획 JSON 경계에 F-08-6·F-08-11·F-08-13이 없다');
});

test('F0812-5 ② 계획 JSON의 명령·산출물·런북·경계가 기록·금지 인자·다른 기능 ID를 지킨다', async () => {
  const mod = need(await load());
  const plan = readJson(PLAN_JSON);
  for (const s of plan.scenarios) {
    assert.ok(Array.isArray(s.commands) && s.commands.length > 0, `${s.id} 명령이 없다`);
    const text = JSON.stringify(s.commands);
    assert.ok(text.includes('--record'), `${s.id} 명령에 --record가 없다`);
    assert.ok(text.includes('--run-id'), `${s.id} 명령에 --run-id가 없다`);
    assert.match(text, /-f0812/, `${s.id} 실행 ID가 -f0812로 끝나지 않는다`);
    assert.ok(text.includes('--out'), `${s.id} 명령에 --out이 없다`);
    assert.ok(!text.includes('--browser'), `${s.id} 명령에 --browser가 있다`);
    assert.ok(!text.includes('--leak'), `${s.id} 명령에 --leak이 있다`);
    assert.ok(!text.includes('--docker-all'), `${s.id} 명령에 --docker-all이 있다`);
    assert.ok(!/V-T18|V-T27|V-T28|SR-T13|P-T1|K1|K2|K7/.test(JSON.stringify(s)), `${s.id}가 다른 기능의 ID를 주장한다`);
    assert.ok(Array.isArray(s.artifacts) && s.artifacts.includes('timeline.csv'), `${s.id} 산출물에 timeline.csv가 없다`);
    assert.ok(s.runbook && fs.existsSync(path.join(ROOT, 'docs', 'runbooks', `${String(s.runbook).split('·')[0]}.md`)), `${s.id} 런북 파일이 없다`);
  }
  assert.ok(!JSON.stringify(plan.scenarios).includes('docker-all'), '계획 시나리오에 docker-all이 있다');
});

test('F0812-6 ① 계획 문서가 정본 자리·범위·측정 설계·경계·검증 절과 금지 수치를 지킨다', () => {
  const text = read(PLAN_DOC);
  for (const heading of [
    '## 1. 정본 자리',
    '## 2. 감독에게',
    '## 3. 범위',
    '### 3.3 수용 기준·완료의 정의·실패 시나리오',
    '## 4. 현재 상태',
    '## 5. 장부 범위',
    '## 6. 측정 설계',
    '### 6.3 시나리오 14종',
    '### 6.5 중단 규칙',
    '### 6.7 포스트모템',
    '## 7. 경계 표',
    '## 8. 시험',
    '## 9. 실패 확인',
    '## 10. 리뷰',
    '## 검증',
    '## 담당 표',
    '## 크기와 차례',
  ]) {
    assert.ok(text.includes(heading), `계획에 '${heading}' 절이 없다`);
  }
  for (const id of IDS) assert.ok(text.includes(id), `계획에 ${id}가 없다`);
  for (const boundary of ['F-08-6', 'F-08-11', 'F-08-13']) assert.ok(text.includes(boundary), `계획에 ${boundary} 경계가 없다`);
  assert.match(text, /docker lane4-F-08-12/, '계획에 잠금 이름이 없다');
  const dockerAllLines = text.split('\n').filter((l) => l.includes('docker-all'));
  assert.ok(dockerAllLines.length > 0, '계획에 docker-all 경계가 없다');
  for (const line of dockerAllLines) assert.match(line, /금지|쓰지|없|않|거부/, 'docker-all을 부정하지 않는 줄이 있다');
  assert.match(text, /미실행|미측정/, '계획에 미실행·미측정 표시가 없다');
  assert.ok(Buffer.byteLength(text) < 90_000, '계획 파일이 90KB를 넘는다');
  assert.ok(!new RegExp(EXECUTION_CLAIMS.join('|')).test(text), '계획에 실행 주장 낱말이 있다');

  const allowed = /주장하지 않는다|쓰지 않는다|하지 않는다|않는다|없고|없다|아니다|못 한다|인용|범위 밖|위반|미측정|판정 못 함|무효|동결|닫지 않는다|닫지 않는|미실행|설계만|외삽은 하지 않는다/;
  for (const line of text.split('\n')) {
    if (!FORBIDDEN.some((token) => line.includes(token))) continue;
    assert.match(line, allowed, `금지 수치가 부정문 밖에 있다: ${line}`);
  }
});
