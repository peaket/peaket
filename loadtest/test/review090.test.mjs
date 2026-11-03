// BSL-090 새 맥락 리뷰(2026-11-03)가 찾은 결함의 재현 시험. 대상: loadtest/runner/side.mjs(곁작업), merge.mjs withoutHistogramChecks,
// probes.mjs deltaJudge. 각 export의 JSDoc을 명세로 본다. 클러스터·Docker는 건드리지 않는다.
// 실행: node --test loadtest/test/review090.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sideTasks } from '../runner/side.mjs';
import { withoutHistogramChecks } from '../runner/merge.mjs';
import { deltaJudge } from '../runner/probes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('BSL090_O-T1_P-T1_곁작업하나가실패해도_처리되지않은거부로죽지않고_다른곁작업은그대로돌며_settle이오류를돌려준다', async () => {
  let t = 1_000;
  const slept = [];
  const side = sideTasks(1_000, { now: () => t, sleep: async (ms) => slept.push(ms) });
  const ran = [];
  side.at(60, async () => {
    ran.push('cut');
    throw new Error('kubectl scale 실패');
  });
  side.at(120, () => ran.push('restore'));
  side.at(30, () => {
    throw 'not-an-error';
  });
  t = 50_000; // 앞 곁작업 시각이 이미 지난 뒤에 더한 것은 곧바로
  side.at(10, () => ran.push('late'));
  const errors = await side.settle();
  assert.deepStrictEqual(ran.sort(), ['cut', 'late', 'restore'], '실패한 곁작업이 있어도 나머지는 돈다');
  assert.equal(errors.length, 2);
  assert.ok(errors.every((e) => e instanceof Error), '오류는 Error로 모은다(던진 값이 글이어도)');
  assert.deepStrictEqual(errors.map((e) => e.message).sort(), ['kubectl scale 실패', 'not-an-error']);
  assert.deepStrictEqual(slept, [60_000, 120_000, 30_000, 0], '부하 시작 기준으로 남은 시간만 잔다(지난 시각은 0)');
  assert.deepStrictEqual(await side.settle(), errors, 'settle을 다시 불러도 같은 오류');
  assert.throws(() => side.at(-1, () => {}), RangeError);
  assert.throws(() => side.at(1, 'x'), RangeError);
  assert.throws(() => sideTasks(Number.NaN), RangeError);
});

test('BSL090_O-T1_곁작업이실패한채로끝나도_Node프로세스가처리되지않은거부로먼저끝나지않는다(실제프로세스)', () => {
  // Node 24는 처리되지 않은 거부를 만나면 프로세스를 곧바로 끝낸다(정리가 돌지 않는다). 곁작업 모음을 쓰면 k6를 기다리는 동안 실패해도 살아 있다
  const code = `
    import { sideTasks } from ${JSON.stringify(new URL('../runner/side.mjs', import.meta.url).href)};
    const side = sideTasks(Date.now());
    side.at(0, async () => { throw new Error('boom'); });
    await new Promise((r) => setTimeout(r, 200)); // k6를 기다리는 동안
    const errors = await side.settle();
    console.log('alive', errors.length, errors[0].message);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', cwd: HERE, timeout: 30_000 });
  assert.equal(r.status, 0, `종료 코드 ${r.status}, 오류 출력: ${r.stderr.slice(-400)}`);
  assert.equal(r.stdout.trim(), 'alive 1 boom');
});

test('BSL090_P-T1_K7②_서버히스토그램점검과지연대조를뺀점검묶음은_나머지점검을그대로두고_뺀이름을돌려주며_입력을바꾸지않는다', () => {
  const input = {
    checks: [
      { name: 'payment_p99_3000ms', allowed: 0.01, trials: 10, violations: 0, target: 'payment p99 ≤ 3000ms' },
      { name: 'payment_server_p99_3000ms', allowed: 0.01, target: '서버', histogram: { metric: 'm', match: 'x', le: 3 } },
      { name: 'hold_p99_50ms', allowed: 0.01, trials: 10, violations: 1, target: 'hold' },
    ],
    crosscheck: { check: 'payment_server_p99_3000ms', k6_metric: 'http_req_duration{phase:main,route:payment}' },
  };
  const snap = structuredClone(input);
  const r = withoutHistogramChecks(input);
  assert.deepStrictEqual(input, snap, '입력을 바꾸지 않는다');
  assert.deepStrictEqual(r.dropped, ['payment_server_p99_3000ms']);
  assert.deepStrictEqual(r.checks, { checks: [snap.checks[0], snap.checks[2]] }, '지연 대조(crosscheck)도 뺀다');
  r.checks.checks[0].trials = 99;
  assert.equal(input.checks[0].trials, 10, '돌려준 것은 사본이다');
  assert.deepStrictEqual(withoutHistogramChecks({ checks: [snap.checks[1]], crosscheck: snap.crosscheck }), { checks: null, dropped: ['payment_server_p99_3000ms'] }, '남는 점검이 없으면 null');
  assert.deepStrictEqual(withoutHistogramChecks(null), { checks: null, dropped: [] });
  assert.throws(() => withoutHistogramChecks({}), RangeError);
  assert.throws(() => withoutHistogramChecks([]), RangeError);
});

test('BSL090_S-T12_K4_받는파드끝표시·맺은연결·맺지못한연결·받는파드CPU가모자라거나넘으면_무효사유를이차례로낸다', () => {
  const ok = { done: 10, listeners: 10, connected: 5000, failed: 0, closed: 0, connections: 5000, clientCpuPct: 80 };
  assert.deepStrictEqual(deltaJudge(ok), [], 'CPU가 한도와 같으면 통과');
  assert.deepStrictEqual(deltaJudge({ ...ok, done: 9, connected: 4500, failed: 3, clientCpuPct: 80.1 }), [
    '받는 파드 끝 표시 9/10',
    '맺은 연결 4500/5000',
    '맺지 못한 연결 3',
    '받는 파드 CPU 80.1%(80% 초과)',
  ]);
  assert.deepStrictEqual(deltaJudge({ ...ok, clientCpuPct: 60 }, 50), ['받는 파드 CPU 60%(50% 초과)']);
  assert.deepStrictEqual(deltaJudge({ ...ok, done: 11, connected: 5001 }), [], '계획보다 많으면 모자란 것이 아니다');
  for (const bad of [{ ...ok, done: -1 }, { ...ok, connected: 1.5 }, { ...ok, clientCpuPct: Number.NaN }, { ...ok, clientCpuPct: -1 }, null]) {
    assert.throws(() => deltaJudge(bad), RangeError);
  }
});

test('BSL090_D-T40_야간비교설정셋은_실행도구가받는인자로_발생기하나(CPU1·1GiB)에_--settle을주어_GitHub러너(CPU4)에자리를잡고_회차사이복제가이어지지않는다', async () => {
  // 2026-11-03 새 맥락 리뷰: 기본 발생기(CPU 4, 요청 = 한도)는 CPU 4개인 ubuntu-24.04 러너에 시스템·두 판 파드와 함께 들어가지 못해 늘 대기(Pending)였다
  const { readFileSync } = await import('node:fs');
  const { parseArgs } = await import('../runner/args.mjs');
  const { pollStages } = await import('../lib/model.mjs');
  const { generatorCount } = await import('../runner/merge.mjs');
  const root = join(HERE, '..', '..');
  for (const f of ['loadtest/nightly/config.json', 'loadtest/nightly/config-aa.json', 'loadtest/nightly/test/config-delay.json']) {
    const cfg = JSON.parse(readFileSync(join(root, ...f.split('/')), 'utf8'));
    assert.deepStrictEqual(cfg.k6.slice(0, 2), ['node', 'loadtest/nightly/k6-run.mjs'], f);
    const runArgs = cfg.k6.slice(2);
    const a = parseArgs(['v0', 'queue', ...runArgs, '--namespace', 'v0-base', '--out', 'x']);
    assert.equal(a.cpus, 1, `${f}: 발생기 CPU 1개`);
    assert.equal(a.memoryMi, 1024, `${f}: 발생기 메모리 1GiB`);
    assert.equal(a.settle, true, `${f}: 회차마다 앱 복제를 최소로 줄인 뒤 시작한다(--settle)`);
    assert.equal(a.generators, undefined, `${f}: 발생기 수는 실행 도구가 정한다`);
    // 계획한 최고 조회 도착률 + 진입 도착률이 CPU 1개 발생기의 보정 용량(500/s, 2026-11-03 calibrate --cpus 1 세 번, docs/verification.md §3.10 '결과') 안이다
    const entryS = Math.ceil(a.users / a.entryRate);
    const plan = pollStages({ users: a.users, entryRate: a.entryRate, admitPerSecond: a.admitPerSecond, startS: entryS, durationS: a.warmS + a.mainS });
    const peak = Math.max(a.entryRate, plan.startRate, ...plan.stages.map((s) => s.target));
    assert.equal(generatorCount(peak), 1, `${f}: 최고 도착률 ${peak}/s는 발생기 하나로 잰다`);
    assert.ok(peak <= 500, `${f}: 최고 도착률 ${peak}/s가 CPU 1개 발생기 용량 500/s를 넘는다`);
  }
});

test('BSL090_O-T1_P-T1_곁작업cancel은_아직돌지않은곁작업을부르지않고_기다리지않고곧바로끝나게하며_이미돈것은그대로다(정리뒤입구가0개로남지않게)', async () => {
  const side = sideTasks(Date.now());
  const ran = [];
  side.at(0, () => ran.push('now'));
  side.at(3600, () => ran.push('later')); // 한 시간 뒤 예정: 취소하면 기다리지 않는다
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  side.cancel();
  const errors = await side.settle();
  assert.ok(Date.now() - t0 < 1000, `취소하면 남은 기다림 없이 끝난다(${Date.now() - t0}ms)`);
  assert.deepStrictEqual(ran, ['now'], '취소 전에 돈 것만 돌았다');
  assert.deepStrictEqual(errors, []);
  side.at(0, () => ran.push('after-cancel'));
  await side.settle();
  assert.deepStrictEqual(ran, ['now'], '취소한 뒤 더한 곁작업도 부르지 않는다');
});

test('BSL090_Q-T2_경로목표점검의구간표는_merge.mjs한곳에있고(대기열진입은prep)_phases의키가경로목록밖이면RangeError다(오타로진입점검이조용히빠지지않게)', async () => {
  const { CHECK_PHASES, checksFromSummary } = await import('../runner/merge.mjs');
  assert.deepStrictEqual(CHECK_PHASES, { queue: { entry: 'prep' } });
  assert.ok(Object.isFrozen(CHECK_PHASES) && Object.isFrozen(CHECK_PHASES.queue), '바꿀 수 없다');
  const metrics = { 'http_reqs{phase:prep,route:entry}': { type: 'counter', values: { count: 3, rate: 0 } } };
  assert.throws(() => checksFromSummary({ metrics }, ['entry', 'status'], { entri: 'prep' }), RangeError);
  assert.equal(checksFromSummary({ metrics }, ['entry', 'status'], CHECK_PHASES.queue).checks[0].name, 'entry_p99_200ms');
});

test('BSL090_S-T12_K4_다맺은뒤본구간에서버가끊은연결이있어도_무효다(입구가다시시작해받은양이0인데유효로남지않게)', () => {
  const ok = { done: 10, listeners: 10, connected: 5000, failed: 0, closed: 0, connections: 5000, clientCpuPct: 10 };
  assert.deepStrictEqual(deltaJudge(ok), []);
  assert.deepStrictEqual(deltaJudge({ ...ok, closed: 5000 }), ['서버가 끊은 연결 5000']);
  assert.deepStrictEqual(deltaJudge({ ...ok, failed: 2, closed: 1 }), ['맺지 못한 연결 2', '서버가 끊은 연결 1'], '맺지 못한 연결 다음 차례');
  assert.throws(() => deltaJudge({ ...ok, closed: -1 }), RangeError);
  const { closed, ...noClosed } = ok;
  assert.throws(() => deltaJudge(noClosed), RangeError, '끊긴 수가 없으면 판정하지 않는다');
});
