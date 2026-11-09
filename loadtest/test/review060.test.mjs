// BSL-060 새 맥락 코드 리뷰(2026-11-03)가 찾은 결함의 재현 시험. 고치기 전에 실패하는 것을 보고 고쳤다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainPhaseSummary } from '../lib/model.mjs';
import { UsageError, parseArgs } from '../runner/args.mjs';
import { NODE_ROOT, RUN_SCRIPT, generatorPod } from '../runner/manifests.mjs';
import { collectArgs, judgeGenerator, withScenarioErrors } from '../runner/results.mjs';

const usage = (argv) => assert.throws(() => parseArgs(argv), UsageError, argv.join(' '));

test('NFR-013 ADR-0057: mainPhaseSummary에 본구간 길이를 주면 본구간 http_reqs의 rate를 count ÷ mainS로 다시 쓴다(k6는 시험 전체 시간으로 나눈다)', () => {
  const metrics = {
    http_reqs: { values: { count: 40000, rate: 1000 } },
    'http_reqs{phase:main}': { values: { count: 30000, rate: 750 } },
    http_req_duration: { values: { 'p(99)': 1 } },
    'http_req_duration{phase:main}': { values: { 'p(99)': 0.5 } },
  };
  const out = mainPhaseSummary(metrics, 30);
  assert.equal(out.http_reqs.values.count, 30000);
  assert.equal(out.http_reqs.values.rate, 1000);
  // 입력은 바꾸지 않는다
  assert.equal(metrics['http_reqs{phase:main}'].values.rate, 750);
  // 주지 않으면 k6 값 그대로(예전과 같다)
  assert.equal(mainPhaseSummary(metrics).http_reqs.values.rate, 750);
  for (const bad of [0, -1, 1.5, '30', NaN]) assert.throws(() => mainPhaseSummary(metrics, bad), RangeError, String(bad));
});

test('NFR-013 [ASVS v5.0.0-2.2.1]: 본구간은 5초 이상이어야 한다(양 끝 1초를 빼고 발생기 표본이 둘 이상이게, 긴 준비 뒤에 실패하지 않게)', () => {
  usage(['v0', 'queue', '--users', '100', '--entry-rate', '100', '--admit-per-second', '5', '--main', '4']);
  assert.equal(parseArgs(['v0', 'queue', '--users', '100', '--entry-rate', '100', '--admit-per-second', '5', '--main', '5']).mainS, 5);
  usage(['calibrate', '--main', '4']);
});

test('NFR-013 [ASVS v5.0.0-2.2.1]: 토큰 수명(예상 시간 + 10분)이 3시간을 넘는 실행은 클러스터를 건드리기 전에 거부한다', () => {
  // queue: ceil(131072 ÷ 10) = 13108초 진입만으로 3시간을 넘는다
  usage(['v0', 'queue', '--users', '131072', '--entry-rate', '10', '--admit-per-second', '5']);
  // 예열 3600 + 본구간 7200 + 60 + 진입 1 + 600 > 10800
  usage(['v0', 'queue', '--users', '1', '--entry-rate', '1', '--admit-per-second', '1', '--warm', '3600', '--main', '7200']);
  // 경계: 1 + 3000 + 7139 + 60 + 600 = 10800은 받는다, 하나 더면 거부
  assert.equal(parseArgs(['v0', 'queue', '--users', '1', '--entry-rate', '1', '--admit-per-second', '1', '--warm', '3000', '--main', '7139']).mainS, 7139);
  usage(['v0', 'queue', '--users', '1', '--entry-rate', '1', '--admit-per-second', '1', '--warm', '3000', '--main', '7140']);
  // seat-hold: 준비 2 × ceil(1 ÷ 1) + 3 = 5초
  assert.equal(parseArgs(['v0', 'seat-hold', '--users', '1', '--rate', '1', '--warm', '3000', '--main', '7135']).mainS, 7135);
  usage(['v0', 'seat-hold', '--users', '1', '--rate', '1', '--warm', '3000', '--main', '7136']);
});

// (1차 수정의 IP당 한도 시험 `rate × 2 ≤ 10 × users`는 2차 리뷰의 60% 규칙 시험이 대신한다)

test('[ASVS v5.0.0-13.2.2]: 발생기 파드에는 실행 시간 상한(activeDeadlineSeconds)이 있어 실행 도구가 강제로 끝나도 파드가 끝난다', () => {
  const base = { name: 'loadgen-x', cpus: 2, memoryMi: 1024, hostDir: `${NODE_ROOT}/abc` };
  assert.equal(generatorPod(base).spec.activeDeadlineSeconds, 11400);
  assert.equal(generatorPod({ ...base, deadlineS: 600 }).spec.activeDeadlineSeconds, 600);
  for (const bad of [59, 11401, 1.5, '600', 0]) assert.throws(() => generatorPod({ ...base, deadlineS: bad }), RangeError, String(bad));
});

test('NFR-013: 실행 스크립트는 종료 코드를 임시 파일에 다 쓴 뒤 이름을 바꿔 넣는다(반쯤 쓴 out/exit를 0으로 읽지 않게)', () => {
  const lines = RUN_SCRIPT.split('\n');
  const k6 = lines.findIndex((l) => l.startsWith('k6 run '));
  assert.equal(lines[k6 + 1], 'echo $? > out/exit.tmp');
  assert.equal(lines[k6 + 2], 'mv out/exit.tmp out/exit');
  assert.ok(lines.some((l) => l.startsWith('rm -f ') && l.includes(' out/exit ') && l.includes(' out/exit.tmp ')));
});

test('NFR-013 [ASVS v5.0.0-1.2.5]: collectArgs는 발생기 설명을 --generator로 맨 뒤에 싣고, 비었거나 -로 시작하면 거부한다', () => {
  const o = { runId: '2026-11-03-k1-v0-local-1k-x', kpi: 'K1', version: 'v0', profile: 'local-1k', durationS: 60, warmupS: 30, scenario: 'loadtest/scenarios/v0-queue.js', summaryFile: 's.json', infraFile: 'i.txt', notes: 'n' };
  const a = collectArgs({ ...o, generator: 'k6 1.4.2, 파드 1대(CPU 4·메모리 4096Mi)' });
  assert.deepEqual(a.slice(-2), ['--generator', 'k6 1.4.2, 파드 1대(CPU 4·메모리 4096Mi)']);
  assert.ok(!collectArgs(o).includes('--generator'));
  for (const bad of ['', '-x']) assert.throws(() => collectArgs({ ...o, generator: bad }), Error, JSON.stringify(bad));
});

test('K2 S-T1 V-T3: 시나리오 오류(잘못된 좌석 ID 등)가 하나라도 있으면 발생기 판정이 유효여도 무효로 하고 사유를 끝에 더한다', () => {
  const ok = judgeGenerator({ dropped: 0, cpuMeanPct: 10, memMaxPct: 10 });
  assert.deepEqual(withScenarioErrors(ok, 0), { valid: true, reasons: [] });
  assert.deepEqual(withScenarioErrors(ok, 3), { valid: false, reasons: ['시나리오 오류 3건'] });
  const bad = judgeGenerator({ dropped: 2, cpuMeanPct: 10, memMaxPct: 10 });
  const out = withScenarioErrors(bad, 1);
  assert.deepEqual(out, { valid: false, reasons: ['발생기가 반복을 시작하지 못함(dropped_iterations 2)', '시나리오 오류 1건'] });
  assert.deepEqual(bad.reasons, ['발생기가 반복을 시작하지 못함(dropped_iterations 2)']);
  for (const n of [-1, 1.5, NaN, '1']) assert.throws(() => withScenarioErrors(ok, n), RangeError, String(n));
});

// ── 2차 새 맥락 리뷰(2026-11-03) ──
import { readFileSync } from 'node:fs';
import { GATEWAY_RATE_PER_IP } from '../runner/args.mjs';

test('K2 S-T1 [ASVS v5.0.0-2.2.1]: seat-hold는 IP당 한도의 60%만 쓴다(무작위로 고른 사람의 요청이 몰려도 입구 429가 섞이지 않게): rate × 2 ≤ 0.6 × 10 × users', () => {
  assert.equal(parseArgs(['v0', 'seat-hold', '--users', '100', '--rate', '300']).rate, 300);
  usage(['v0', 'seat-hold', '--users', '100', '--rate', '301']);
  usage(['v0', 'seat-hold', '--users', '100', '--rate', '500']); // 1차 수정의 경계(평균이 한도와 같음)는 거부한다
});

test('K2 S-T1: 실행 도구가 쓰는 IP당 한도는 로컬 입구 설정(deploy/envs/local/v0-gateway.yaml)과 같다', () => {
  const yaml = readFileSync(new URL('../../deploy/envs/local/v0-gateway.yaml', import.meta.url), 'utf8');
  const m = /PEAKET_V0_RATE_PER_SECOND:\s*"?(\d+)"?/.exec(yaml);
  assert.ok(m, '입구 설정에 IP당 한도가 없다');
  assert.equal(GATEWAY_RATE_PER_IP, Number(m[1]));
});

test('[ASVS v5.0.0-2.2.1]: cleanup 명령은 인자 없이만 받는다(강제 종료 뒤 남은 발생기를 멈춘다)', () => {
  assert.deepEqual(parseArgs(['cleanup']), { command: 'cleanup' });
  usage(['cleanup', '--out', 'x']);
  usage(['cleanup', 'extra']);
});

test('NFR-013 [ASVS v5.0.0-2.2.1]: 보정 전체 길이(단계 수 × (예열 + 본구간 + 30) + 10분)가 파드 실행 시간 상한(11,400초)을 넘으면 거부한다', () => {
  usage(['calibrate', '--rates', '1000', '--warm', '3600', '--main', '7200']);
  // 경계: 2 × (10 + 5340 + 30) + 600 = 11,360은 받고, 3단계면 거부
  assert.deepEqual(parseArgs(['calibrate', '--rates', '1000,2000', '--warm', '10', '--main', '5340']).rates, [1000, 2000]);
  usage(['calibrate', '--rates', '1000,2000,3000', '--warm', '10', '--main', '5340']);
});
