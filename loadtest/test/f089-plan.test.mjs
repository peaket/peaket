// F-08-9 측정 창 실행 계획 시험(F089-9): loadtest/plan/f09-plan.json.
// 정본: 계획 docs/review/plans/F-08-9.md 6.2·7.1~7.2, docs/verification.md V-T27·V-T28, docs/features/search.md SR-T13.
// 이 시험은 아무 측정도 돌리지 않는다. 계획 파일의 모양과 F-08-8/F-08-10 경계만 본다.
// 실행: node --test loadtest/test/f089-plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const PLAN_FILE = join(ROOT, 'loadtest', 'plan', 'f09-plan.json');

const REQUIRED_KEYS = [
  'w2-search-golden',
  'w2-search-10k',
  'w2-search-20k',
  'w2-relay-baseline',
  'w2-relay-fault',
  'w2-pt1-fault',
  'w2-report',
];
const FIELDS = ['key', 'group', 'title', 'estimate_min', 'stage', 'conditions', 'commands', 'criteria', 'ledger', 'artifact'];

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

test('F089-9 ① 계획 파일은 실행마다 필수 칸·명령·판정 자리·예상 시간을 갖는다', () => {
  const plan = readPlan();
  assert.equal(plan.state_file, '.cache/peaket-f09/state.json');
  assert.ok(Array.isArray(plan.gates), 'gates 배열');
  assert.ok(plan.gates.includes('WINDOW-F089'), 'WINDOW-F089 게이트');
  assert.ok(String(plan.start_gate).includes('WINDOW-F089'), 'start_gate가 WINDOW-F089를 가리킨다');
  assert.ok(Array.isArray(plan.runs) && plan.runs.length >= REQUIRED_KEYS.length);

  for (const run of plan.runs) {
    for (const field of FIELDS) assert.ok(field in run, `${run.key}: ${field} 없음`);
    assert.ok(Number.isInteger(run.estimate_min) && run.estimate_min > 0, `${run.key}: estimate_min`);
    assert.ok(Array.isArray(run.commands) && run.commands.length > 0, `${run.key}: commands`);
    for (const cmd of run.commands) {
      assert.ok(typeof cmd.label === 'string' && cmd.label.length > 0, `${run.key}: label`);
      assert.ok(Array.isArray(cmd.argv) && cmd.argv.length > 0, `${run.key}: argv`);
      assert.ok(cmd.argv.every((a) => typeof a === 'string' && a.length > 0), `${run.key}: argv 값`);
    }
    assert.ok(Array.isArray(run.criteria) && run.criteria.length > 0, `${run.key}: criteria`);
  }
});

test('F089-9 ② 계획에는 릴레이·검색·P-T1·보고서 실행이 있고, F-08-8의 K1·K2·K7 명령이 없다', () => {
  const plan = readPlan();
  const keys = new Set(plan.runs.map((r) => r.key));
  for (const key of REQUIRED_KEYS) assert.ok(keys.has(key), `${key} 실행이 없다`);

  const relay = argvsOf(runOf(plan, 'w2-relay-fault'));
  assert.ok(relay.includes('loadtest/run.mjs') && relay.includes('v1') && relay.includes('relay-fault'), relay.join(' '));
  assert.equal(relay[relay.indexOf('--main') + 1], '1800', 'V-T27 본구간 30분');
  assert.ok(relay.includes('--rate') && relay.includes('--record'), '도착률·기록 인자');
  assert.ok(relay.includes('--out') && relay.includes('--run-id'), '산출물·실행 ID');
  const baseline = argvsOf(runOf(plan, 'w2-relay-baseline'));
  const relayOff = baseline.indexOf('--relay');
  assert.ok(relayOff >= 0 && baseline[relayOff + 1] === 'off', `릴레이 끈 기준 실행: ${baseline.join(' ')}`);

  const search10 = argvsOf(runOf(plan, 'w2-search-10k'));
  assert.ok(search10.includes('loadtest/run.mjs') && search10.includes('v1') && search10.includes('search'), search10.join(' '));
  assert.equal(search10[search10.indexOf('--size') + 1], '10000');
  assert.equal(search10[search10.indexOf('--reps') + 1], '3');
  const search20 = argvsOf(runOf(plan, 'w2-search-20k'));
  assert.equal(search20[search20.indexOf('--size') + 1], '20000');
  assert.equal(search20[search20.indexOf('--reps') + 1], '3');

  const pt1 = argvsOf(runOf(plan, 'w2-pt1-fault'));
  assert.ok(pt1.includes('v1') && pt1.includes('payment'), pt1.join(' '));
  assert.ok(pt1.includes('--fault-drop-pct') || pt1.some((a) => a.includes('fault')), '장애 주입 인자');

  // F-08-8이 잰 K1·K2·K7을 다시 돌리지 않는다(경계)
  const k1k2k7 = plan.runs.flatMap((r) => argvsOf(r)).filter((argv) => argv[2] === 'v1' && ['queue', 'seat-hold', 'payment'].includes(argv[3]));
  assert.deepEqual(k1k2k7, [], `F-08-8 명령이 섞였다: ${JSON.stringify(k1k2k7)}`);
});

test('F089-9 ③ 판정 자리는 V-T27·V-T28·P-T1·SR-T13 ①②만 가리키고, 다른 장부 ID를 가리키지 않는다', () => {
  const plan = readPlan();
  const allowed = new Set(['V-T27', 'V-T28', 'P-T1', 'SR-T12', 'SR-T13', 'NFR-028']);
  for (const run of plan.runs) {
    const text = [...run.criteria, run.ledger].join(' ');
    const ids = text.match(/\b(?:V-T|P-T|SR-T)\d+\b/g) ?? [];
    for (const id of ids) assert.ok(allowed.has(id), `${run.key}: 장부 범위 밖 ${id}`);
  }
  const relay = runOf(plan, 'w2-relay-fault');
  assert.ok([...relay.criteria, relay.ledger].join(' ').includes('V-T27'), 'V-T27');
  assert.ok([...relay.criteria, relay.ledger].join(' ').includes('V-T28'), 'V-T28');
  const pt1 = runOf(plan, 'w2-pt1-fault');
  assert.ok([...pt1.criteria, pt1.ledger].join(' ').includes('P-T1'), 'P-T1');
  for (const key of ['w2-search-10k', 'w2-search-20k']) {
    const run = runOf(plan, key);
    assert.ok([...run.criteria, run.ledger].join(' ').includes('SR-T13'), `${key}: SR-T13`);
  }
  assert.equal(JSON.stringify(plan).includes('V-T18'), false, 'F-08-10(V-T18)을 가리키면 안 된다');
});
