// F-08-10 측정 창 실행 계획 시험(F0810-6): loadtest/plan/f10-plan.json.
// 정본: 계획 docs/review/plans/F-08-10.md 6.2·7.1~7.2, docs/verification.md §3.8·V-T18.
// 이 시험은 아무 측정도 돌리지 않는다. 계획 도구 모양·명령 인자·F-08-2/F-08-8/F-08-9 경계만 본다.
// 실행: node --test loadtest/test/f0810-plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePlan } from '../plan/bat025-plan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const PLAN_FILE = join(ROOT, 'loadtest', 'plan', 'f10-plan.json');
const GATE = 'WINDOW-F0810';
const FIELDS = ['n', 'key', 'group', 'title', 'estimate_min', 'stage', 'conditions', 'commands', 'criteria', 'ledger', 'artifact', 'gate'];
const MEASURE_KEYS = [];
for (const config of ['bundle', 'by-role']) {
  for (const entry of ['none', '100', '120']) {
    for (const rep of [1, 2, 3]) MEASURE_KEYS.push(`w2-${config}-${entry}-r${rep}`);
  }
}
const FORBIDDEN = ['K1', 'K2', 'K7', 'V-T27', 'V-T28', 'P-T1', 'SR-T13', 'F-08-5', 'F-08-6'];

const readPlan = () => {
  assert.ok(existsSync(PLAN_FILE), `${PLAN_FILE}이 없다`);
  return JSON.parse(readFileSync(PLAN_FILE, 'utf8'));
};

const runOf = (plan, key) => {
  const run = plan.runs.find((r) => r.key === key);
  assert.ok(run, `${key} 실행이 없다`);
  return run;
};
const argvsOf = (run) => run.commands.map((c) => c.argv);
const hasPair = (argv, flag, value) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] === value;
};
const runIdOf = (argv) => {
  const i = argv.indexOf('--run-id');
  return i >= 0 ? argv[i + 1] : null;
};

test('F0810-6 ① 계획은 validatePlan을 지나고, gates 객체·모든 실행의 n/gate·필수 칸·명령·판정 자리·예상 시간이 있다', () => {
  const plan = readPlan();
  validatePlan(plan);
  assert.equal(plan.plan, 'f10-split-compare');
  assert.equal(plan.state_file, '.cache/peaket-f10/state.json');
  assert.equal(typeof plan.gates, 'object');
  assert.equal(Array.isArray(plan.gates), false, 'gates는 객체다(계획 도구 validatePlan)');
  assert.ok(Object.hasOwn(plan.gates, GATE), `gates에 ${GATE}가 없다`);
  assert.ok(String(plan.start_gate).includes(GATE), 'start_gate가 게이트를 가리킨다');

  plan.runs.forEach((run, i) => {
    assert.equal(run.n, i + 1, `${run.key}: n이 차례가 아니다`);
    assert.equal(run.gate, GATE, `${run.key}: gate가 ${GATE}가 아니다`);
    for (const field of FIELDS) assert.ok(field in run, `${run.key}: ${field} 없음`);
    assert.ok(Number.isInteger(run.estimate_min) && run.estimate_min > 0, `${run.key}: estimate_min`);
    assert.ok(Array.isArray(run.commands) && run.commands.length > 0, `${run.key}: commands`);
    for (const cmd of run.commands) {
      assert.ok(typeof cmd.label === 'string' && cmd.label.length > 0, `${run.key}: label`);
      assert.ok(Array.isArray(cmd.argv) && cmd.argv.length > 0, `${run.key}: argv`);
      assert.ok(cmd.argv.every((a) => typeof a === 'string' && a.length > 0), `${run.key}: argv 값`);
    }
    assert.ok(Array.isArray(run.criteria) && run.criteria.length > 0, `${run.key}: criteria`);
    assert.equal(typeof run.ledger, 'string');
    assert.equal(typeof run.artifact, 'string');
  });
});

test('F0810-6 ② 무대 둘·18회 측정·보고가 있고, 측정은 구성·단계·회차·300 TPS·기록·{entryRate}를 지키며 services 실행이 없다', () => {
  const plan = readPlan();
  const keys = new Set(plan.runs.map((r) => r.key));
  for (const key of ['w2-stage', 'w2-stage-by-role', 'w2-report', ...MEASURE_KEYS]) assert.ok(keys.has(key), `${key} 실행이 없다`);
  assert.equal(MEASURE_KEYS.length, 18);

  const stage = argvsOf(runOf(plan, 'w2-stage'));
  const v1 = stage.find((a) => a[0] === 'node' && a[1] === 'tools/local/cluster.mjs' && a[2] === 'v1');
  assert.ok(v1, 'w2-stage에 cluster.mjs v1 명령이 없다');
  assert.ok(hasPair(v1, '--memory-mi', '2048'), `v1 무대 2GiB: ${v1.join(' ')}`);
  assert.ok(hasPair(v1, '--replicas', '3'), 'v1 복제 3');
  assert.ok(stage.some((a) => a.join(' ').includes('compare-stage.mjs') && a.includes('bundle')), 'w2-stage에 합본 single 무대 명령이 없다');
  const lock = stage.find((a) => a.some((x) => x.endsWith('lock.sh')));
  assert.ok(lock, 'w2-stage에 Docker 잠금 명령이 없다');
  assert.ok(lock.includes('take') && lock.includes('docker-all') && lock.includes('lane4-F-08-10'), lock.join(' '));

  const switchRole = argvsOf(runOf(plan, 'w2-stage-by-role')).find((a) => a.join(' ').includes('compare-stage.mjs'));
  assert.ok(switchRole, 'w2-stage-by-role에 compare-stage.mjs 명령이 없다');
  assert.ok(switchRole.includes('by-role'), switchRole.join(' '));

  for (const key of MEASURE_KEYS) {
    const run = runOf(plan, key);
    const argv = argvsOf(run).find((a) => a.includes('compare')) ?? argvsOf(run)[0];
    assert.ok(argv.includes('v1') && argv.includes('compare'), `${key}: v1 compare 명령이 아니다: ${argv.join(' ')}`);
    const [, config, entry, rep] = key.match(/^w2-(bundle|by-role)-(none|100|120)-r([1-3])$/) ?? [];
    assert.ok(config && entry && rep, `${key}: 키 꼴`);
    assert.ok(hasPair(argv, '--config', config), `${key}: --config ${config}`);
    assert.ok(hasPair(argv, '--entry', entry), `${key}: --entry ${entry}`);
    assert.ok(hasPair(argv, '--rep', rep), `${key}: --rep ${rep}`);
    assert.ok(hasPair(argv, '--payment-tps', '300'), `${key}: 결제 300 TPS`);
    assert.ok(argv.includes('--record') && argv.includes('--out') && argv.includes('--prom-url'), `${key}: 기록·산출물·Prometheus`);
    assert.ok((runIdOf(argv) ?? '').endsWith('-f0810'), `${key}: 실행 ID가 -f0810로 끝나지 않는다: ${runIdOf(argv)}`);
    if (entry === 'none') assert.equal(argv.includes('--entry-max-rate'), false, `${key}: none에 --entry-max-rate를 주면 안 된다`);
    else assert.ok(hasPair(argv, '--entry-max-rate', '{entryRate}'), `${key}: --entry-max-rate {entryRate}`);
  }

  for (const run of plan.runs) {
    for (const argv of argvsOf(run)) assert.equal(argv.includes('services'), false, `${run.key}: 로컬에서 services를 실행하면 안 된다`);
  }

  const report = argvsOf(runOf(plan, 'w2-report')).flat();
  assert.ok(report.includes('compare-report'), 'w2-report에 비교 요약 명령이 없다');
  const drop = argvsOf(runOf(plan, 'w2-report')).find((a) => a.some((x) => x.endsWith('lock.sh')));
  assert.ok(drop && drop.includes('drop') && drop.includes('docker-all') && drop.includes('lane4-F-08-10'), 'w2-report가 잠금을 놓지 않는다');
});

test('F0810-6 ③ 판정 자리는 V-T18·§3.8만 가리키고, K1/K2/K7·F-08-9·F-08-5·F-08-6을 가리키지 않는다', () => {
  const plan = readPlan();
  for (const key of MEASURE_KEYS) {
    const run = runOf(plan, key);
    assert.equal(run.ledger, 'V-T18', `${key}: ledger`);
    const text = run.criteria.join(' ');
    assert.ok(text.includes('V-T18'), `${key}: criteria에 V-T18이 없다`);
    assert.ok(text.includes('§3.8') || text.includes('3.8'), `${key}: criteria에 §3.8이 없다`);
    for (const id of FORBIDDEN) assert.equal(text.includes(id), false, `${key}: criteria가 ${id}를 가리킨다`);
    assert.ok(run.artifact.includes('.cache/peaket-f10/'), `${key}: artifact`);
  }
  const all = plan.runs.map((r) => `${r.title} ${r.conditions} ${r.criteria.join(' ')} ${r.ledger}`).join(' ');
  assert.ok(all.includes('split-3way'), '계획이 실험 묶음 split-3way를 밝히지 않는다');
  assert.ok(all.includes('미측정'), '계획이 (다) 미측정을 밝히지 않는다');
});
