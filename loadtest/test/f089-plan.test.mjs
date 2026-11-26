// F-08-9 측정 창 실행 계획 시험(F089-9): loadtest/plan/f09-plan.json.
// 정본: 계획 docs/review/plans/F-08-9.md 6.2·7.1~7.2, docs/verification.md V-T27·V-T28, docs/features/search.md SR-T13.
// 이 시험은 아무 측정도 돌리지 않는다. 계획 도구 모양·명령 인자·F-08-8/F-08-10 경계만 본다.
// 실행: node --test loadtest/test/f089-plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePlan } from '../plan/bat025-plan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const PLAN_FILE = join(ROOT, 'loadtest', 'plan', 'f09-plan.json');
const GATE = 'WINDOW-F089';
const REQUIRED_KEYS = [
  'w2-stage',
  'w2-search-10k',
  'w2-search-20k',
  'w2-relay-baseline',
  'w2-relay-fault',
  'w2-pt1-fault',
  'w2-report',
];
const MEASURE_KEYS = ['w2-search-10k', 'w2-search-20k', 'w2-relay-baseline', 'w2-relay-fault', 'w2-pt1-fault'];
const FIELDS = ['n', 'key', 'group', 'title', 'estimate_min', 'stage', 'conditions', 'commands', 'criteria', 'ledger', 'artifact', 'gate'];

const readPlan = () => {
  assert.ok(existsSync(PLAN_FILE), `${PLAN_FILE}이 없다`);
  return JSON.parse(readFileSync(PLAN_FILE, 'utf8'));
};

const runOf = (plan, key) => {
  const run = plan.runs.find((r) => r.key === key);
  assert.ok(run, `${key} 실행이 없다`);
  return run;
};
const argvsOf = (run) => run.commands.flatMap((c) => c.argv);
const hasPair = (argv, flag, value) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] === value;
};
const runIdOf = (argv) => {
  const i = argv.indexOf('--run-id');
  return i >= 0 ? argv[i + 1] : null;
};

test('F089-9 ① 계획은 validatePlan을 지나고, gates 객체·실행 n/gate·필수 칸·명령·판정 자리·예상 시간이 있다', () => {
  const plan = readPlan();
  validatePlan(plan);
  assert.equal(typeof plan.plan, 'string');
  assert.equal(plan.state_file, '.cache/peaket-f09/state.json');
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

test('F089-9 ② 명령은 2GiB 무대·docker 한 자리·12600/s·20/20/60·P-T1 하위 명령·측정마다 기록을 지킨다', () => {
  const plan = readPlan();
  const keys = new Set(plan.runs.map((r) => r.key));
  for (const key of REQUIRED_KEYS) assert.ok(keys.has(key), `${key} 실행이 없다`);

  const stage = runOf(plan, 'w2-stage');
  const stageArgvs = stage.commands.map((c) => c.argv);
  const v1 = stageArgvs.find((a) => a[0] === 'node' && a[1] === 'tools/local/cluster.mjs' && a[2] === 'v1');
  assert.ok(v1, 'w2-stage에 cluster.mjs v1 명령이 없다');
  assert.ok(hasPair(v1, '--memory-mi', '2048'), `v1 무대 2GiB: ${v1.join(' ')}`);
  assert.ok(stageArgvs.some((a) => a.join(' ').includes('core-host') || a.join(' ').includes('core-svc')), '호스트 core-svc 무대 명령');
  assert.ok(stageArgvs.some((a) => a.join(' ').includes('fill-search')), '검색 채우기 명령');
  const lock = stageArgvs.find((a) => a.some((x) => x.endsWith('lock.sh')));
  assert.ok(lock, 'w2-stage에 Docker 잠금 명령이 없다');
  assert.ok(lock.includes('take') && lock.includes('docker') && lock.includes('lane4-F-08-9'), lock.join(' '));
  assert.equal(lock.includes('docker-all'), false, 'docker-all을 쓰면 안 된다');

  const relay = argvsOf(runOf(plan, 'w2-relay-fault'));
  assert.ok(relay.includes('v1') && relay.includes('relay-fault'), relay.join(' '));
  assert.ok(hasPair(relay, '--main', '1800'), 'V-T27 30분');
  assert.ok(hasPair(relay, '--rate', '12600'), 'V-T27 2배 [가정] 12600/s');
  assert.ok(hasPair(relay, '--payment-rate', '300') && hasPair(relay, '--payment-mode', 'load'), '같은 실행 P-T5 부하');
  assert.ok(relay.includes('--record') && relay.includes('--out') && relay.includes('--prom-url'), '기록·산출물·Prometheus');

  const baseline = argvsOf(runOf(plan, 'w2-relay-baseline'));
  assert.ok(baseline.includes('v1') && baseline.includes('relay-fault'), baseline.join(' '));
  assert.ok(hasPair(baseline, '--relay', 'off'), '릴레이 끈 기준 실행');
  assert.ok(hasPair(baseline, '--main', '600'), '기준 실행 10분');
  assert.ok(hasPair(baseline, '--rate', '12600'), '같은 도착률');

  const search10 = argvsOf(runOf(plan, 'w2-search-10k'));
  assert.ok(search10.includes('v1') && search10.includes('search'), search10.join(' '));
  assert.ok(hasPair(search10, '--size', '10000') && hasPair(search10, '--reps', '3'));
  assert.ok(hasPair(search10, '--crowd-rate', '20') && hasPair(search10, '--random-rate', '20') && hasPair(search10, '--duration', '60'));
  assert.ok(hasPair(search10, '--base', 'http://host.docker.internal:3001'), '호스트 core-svc 대상');
  assert.ok(search10.includes('--golden'), 'SR-T12 골든 보고');
  const search20 = argvsOf(runOf(plan, 'w2-search-20k'));
  assert.ok(hasPair(search20, '--size', '20000') && hasPair(search20, '--reps', '3'));
  assert.ok(hasPair(search20, '--base', 'http://host.docker.internal:3001'));
  assert.equal(search20.includes('--golden'), false, '골든은 1만에서 한 번');

  const pt1 = argvsOf(runOf(plan, 'w2-pt1-fault'));
  assert.ok(pt1.includes('v1') && pt1.includes('payment-fault'), pt1.join(' '));
  assert.ok(hasPair(pt1, '--payments', '10000') && hasPair(pt1, '--rate', '100'));
  assert.ok(hasPair(pt1, '--generators', '2'), 'P-T1 발생기 2대');
  assert.ok(hasPair(pt1, '--webhook-duplicates', '2'), '웹훅 중복 2회');
  assert.ok(pt1.includes('--invariants'), 'P-T1 불변식 결과');

  const allArgvs = plan.runs.flatMap((r) => argvsOf(r));
  const drop = allArgvs.find((a) => a.some((x) => x.endsWith('lock.sh')) && a.includes('drop'));
  assert.ok(drop, 'Docker 잠금 drop 명령이 없다');
  assert.ok(drop.includes('docker') && drop.includes('lane4-F-08-9') && !drop.includes('docker-all'), drop.join(' '));

  for (const key of MEASURE_KEYS) {
    const argv = argvsOf(runOf(plan, key));
    assert.ok(argv.includes('--record'), `${key}: --record 없음`);
    assert.ok(argv.includes('--out'), `${key}: --out 없음`);
    assert.ok(argv.includes('--prom-url'), `${key}: --prom-url 없음`);
    assert.match(runIdOf(argv) ?? '', /-f089$/, `${key}: 실행 ID ${runIdOf(argv)}`);
  }

  // F-08-8 명령(v1 queue·seat-hold·payment)은 다시 돌리지 않는다. P-T1은 payment-fault로 가른다.
  const f08 = plan.runs.flatMap((r) => argvsOf(r)).filter((argv) => argv[2] === 'v1' && ['queue', 'seat-hold', 'payment'].includes(argv[3]));
  assert.deepEqual(f08, [], `F-08-8 명령이 섞였다: ${JSON.stringify(f08)}`);
});

test('F089-9 ③ 판정 자리는 V-T27·V-T28·P-T1·SR-T13 ①②만 가리키고, P-T5·취소 반영·게이트를 빠뜨리지 않는다', () => {
  const plan = readPlan();
  const allowed = new Set(['V-T27', 'V-T28', 'P-T1', 'SR-T12', 'SR-T13', 'NFR-028']);
  for (const run of plan.runs) {
    assert.equal(run.gate, GATE, `${run.key}: gate`);
    const text = [...run.criteria, run.ledger].join(' ');
    const ids = text.match(/\b(?:V-T|P-T|SR-T)\d+\b/g) ?? [];
    for (const id of ids) assert.ok(allowed.has(id), `${run.key}: 장부 범위 밖 ${id}`);
  }
  const relay = runOf(plan, 'w2-relay-fault');
  const relayText = [...relay.criteria, relay.ledger].join(' ');
  assert.match(relayText, /V-T27/);
  assert.match(relayText, /V-T28/);
  assert.match(relayText, /P-T5/, 'V-T27의 같은 실행 P-T5');
  const pt1 = runOf(plan, 'w2-pt1-fault');
  const pt1Text = [...pt1.criteria, pt1.ledger].join(' ');
  assert.match(pt1Text, /P-T1/);
  assert.match(pt1Text, /S3|이중 발권.*미측정|미측정.*이중 발권/, 'S3 SKIPPED·이중 발권 미측정');
  for (const key of ['w2-search-10k', 'w2-search-20k']) {
    const text = [...runOf(plan, key).criteria, runOf(plan, key).ledger].join(' ');
    assert.match(text, /SR-T13/);
    assert.match(text, /SR-T15 ①|취소/, `${key}: NFR-028 취소 반영`);
  }
  assert.equal(JSON.stringify(plan).includes('V-T18'), false, 'F-08-10(V-T18)을 가리키면 안 된다');
});
