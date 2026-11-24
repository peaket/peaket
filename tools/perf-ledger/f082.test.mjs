// 100만 외삽·비례 확인의 장부 도구 시험(F-08-2): charts.py usl(V-T2, V-T17 ②), collect.py --host(V-T17 ③), extrapolate.py(F082-7·F082-8).
// 계획 docs/review/plans/F-08-2.md 6.2~6.5·7.2·7.3, 정본 docs/verification.md §3.3(설계 식·비례 확인·USL)·§3.4(v0·v1 식, ±10% 판정)·§3.5 6번.
// 파이썬 도구를 명령줄과 함수로 부르고 OS 임시 폴더를 저장소 루트로 준다. 단언 값은 정본의 식으로 손으로 셈했다.
// 실행: node --test "tools/perf-ledger/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PY = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const CHARTS = join(here, 'charts.py');
const COLLECT = join(here, 'collect.py');
const INDEX = join(here, 'index.py');
const EXTRA = join(here, 'extrapolate.py');
const LEDGER_DOC = '# 성능 장부\n\n## 5. 장부 요약 원장\n\n<!-- ledger:begin -->\n<!-- ledger:end -->\n';

function py(script, args) {
  const r = spawnSync(PY, ['-I', '-X', 'utf8', script, ...args], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** extrapolate.py의 함수를 불러 JSON으로 돌려받는다(계획 7.2의 함수 이름) */
function pyCall(expr) {
  const code = ['import json, sys', `sys.path.insert(0, ${JSON.stringify(here)})`, 'import extrapolate as E', `print(json.dumps(${expr}, ensure_ascii=False))`].join('\n');
  const r = spawnSync(PY, ['-I', '-X', 'utf8', '-c', code], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.equal(r.status, 0, `${expr}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'f082-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const near = (got, want, rel, what) => assert.ok(typeof got === 'number' && Math.abs(got - want) <= Math.abs(want) * rel, `${what}: ${got}가 ${want}의 ±${rel * 100}% 밖`);

// ─────────────── V-T2 USL 계수 되찾기 ───────────────

// 합성 점: α = 0.05, β = 0.0005, X(1) = 1,000. X(N) = 1000 N / (1 + 0.05 (N−1) + 0.0005 N (N−1))
const ALPHA = 0.05;
const BETA = 0.0005;
const uslX = (n) => (1000 * n) / (1 + ALPHA * (n - 1) + BETA * n * (n - 1));
// 정점 N = √((1 − α) ÷ β) = √1,900 ≈ 43.589
const N_PEAK = 43.589;
// 목표 8,000: 0.004 N² − 0.604 N + 7.6 = 0의 작은 근 ≈ 13.854 → 올림 14
const TARGET = 8000;
const N_REQ = 13.854;

const csv = (rows, cols = ['n', 'throughput']) => [cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n') + '\n';

test('V-T2 ① charts.py usl: 합성 점 6개(N = 1·2·3·4·6·8)에서 α·β를 ±5% 안으로 되찾고 정점 N과 목표에 필요한 N을 출력과 .json에 남긴다', () =>
  withTmp((dir) => {
    const pts = join(dir, 'usl.csv');
    writeFileSync(pts, csv([1, 2, 3, 4, 6, 8].map((n) => ({ n, throughput: uslX(n).toFixed(6) }))));
    const out = join(dir, 'usl.svg');
    const r = py(CHARTS, ['usl', '--points', pts, '--target', String(TARGET), '--out', out]);
    assert.equal(r.code, 0, r.out);
    const j = JSON.parse(readFileSync(join(dir, 'usl.json'), 'utf8'));
    near(j.alpha, ALPHA, 0.05, 'alpha');
    near(j.beta, BETA, 0.05, 'beta');
    near(j.n_peak, N_PEAK, 0.01, 'n_peak');
    near(j.n_required, N_REQ, 0.01, 'n_required');
    assert.equal(j.n_required_ceil, 14);
    assert.equal(j.n_measured_max, 8);
    assert.match(r.out, /정점: N=43\.6/);
    assert.match(r.out, /필요한 N=14/);
    assert.doesNotMatch(r.out, /경고/);
  }));

test('V-T2 ② charts.py usl: 서로 다른 N이 6개 미만이면 경고하고, N=1 점이 없으면 실패한다(종료 코드와 글)', () =>
  withTmp((dir) => {
    const five = join(dir, 'five.csv');
    writeFileSync(five, csv([1, 2, 3, 4, 6].map((n) => ({ n, throughput: uslX(n).toFixed(6) }))));
    const r1 = py(CHARTS, ['usl', '--points', five, '--out', join(dir, 'five.svg')]);
    assert.equal(r1.code, 0, r1.out);
    assert.match(r1.out, /경고: 서로 다른 N이 6개보다 적습니다/);
    const noOne = join(dir, 'no1.csv');
    writeFileSync(noOne, csv([2, 3, 4, 6, 8, 10].map((n) => ({ n, throughput: uslX(n).toFixed(6) }))));
    const r2 = py(CHARTS, ['usl', '--points', noOne, '--out', join(dir, 'no1.svg')]);
    assert.notEqual(r2.code, 0, r2.out);
    assert.match(r2.out, /N=1/);
    assert.equal(existsSync(join(dir, 'no1.json')), false);
  }));

test('V-T17 ② charts.py usl: saturated=true인 줄은 맞춤에서 빼고 뺀 점을 .json excluded에 남긴다(entry-scale.mjs와 따로 지킨다)', () =>
  withTmp((dir) => {
    const pts = join(dir, 'sat.csv');
    const rows = [1, 2, 3, 4, 5, 6].map((n) => ({ n, throughput: uslX(n).toFixed(6), saturated: 'false' }));
    rows.push({ n: 8, throughput: '3000', saturated: 'true' }); // 포화한 8대 점(참값 약 5,806): 넣으면 계수가 크게 틀어진다
    writeFileSync(pts, csv(rows, ['n', 'throughput', 'saturated']));
    const r = py(CHARTS, ['usl', '--points', pts, '--out', join(dir, 'sat.svg')]);
    assert.equal(r.code, 0, r.out);
    const j = JSON.parse(readFileSync(join(dir, 'sat.json'), 'utf8'));
    near(j.alpha, ALPHA, 0.01, 'alpha');
    near(j.beta, BETA, 0.01, 'beta');
    assert.equal(j.n_measured_max, 6);
    assert.deepEqual(j.points.map((p) => p.n), [1, 2, 3, 4, 5, 6]);
    const excluded = (j.excluded ?? []).map((e) => (typeof e === 'object' ? e.n : e));
    assert.deepEqual(excluded, [8]);
    assert.match(r.out, /뺀|제외|포화/, '뺀 점을 출력에 알리지 않았다');
  }));

// ─────────────── V-T17 ③ collect.py --host ───────────────

function newRoot(dir) {
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'perf-ledger.md'), LEDGER_DOC);
  return dir;
}

test('V-T17 ③ collect.py --host: 포화 점을 수집하면 manifest host에 값과 호스트 포화 표시가 남고 notes에 적히며 장부 표에 그 행이 그대로 있다', () =>
  withTmp((dir) => {
    const root = newRoot(dir);
    const id = '2026-11-26-msr020-n8-c05-r1-s4';
    // steps.json의 host 꼴(계획 7.2): CPU 92%·실행 대기 40 > 논리 32 → 정본 §3.5 6번 두 조건 모두 포화
    const host = { cpuUtil: 0.92, procsRunning: 40, logicalCpus: 32, throttle: { nrPeriods: 1200, nrThrottled: 300, throttledUsec: 4500000 }, cpuAssigned: 14, tags: ['호스트 포화'] };
    const hostFile = join(dir, 'host.json');
    writeFileSync(hostFile, JSON.stringify(host));
    const r = py(COLLECT, ['--root', root, '--run-id', id, '--kpi', 'K1', '--version', 'v1', '--profile', 'local-1k', '--commit', 'abc123', '--redis-tls', 'true', '--host', hostFile]);
    assert.equal(r.code, 0, r.out);
    const m = JSON.parse(readFileSync(join(root, 'docs', 'perf-ledger', 'runs', id, 'manifest.json'), 'utf8'));
    assert.ok(m.host && typeof m.host === 'object', JSON.stringify(m.host));
    assert.equal(m.host.procs_running, 40);
    assert.equal(m.host.logical_cpus, 32);
    assert.equal(m.host.cpu_assigned, 14);
    assert.ok(Array.isArray(m.host.tags) && m.host.tags.includes('호스트 포화'), JSON.stringify(m.host.tags));
    assert.match(String(m.notes ?? ''), /호스트 포화/);
    const ix = py(INDEX, ['--root', root]);
    assert.equal(ix.code, 0, ix.out);
    const doc = readFileSync(join(root, 'docs', 'perf-ledger.md'), 'utf8');
    assert.ok(doc.split('\n').some((l) => l.includes(`| ${id} |`)), '장부 표에서 포화 점 행이 사라졌다');
  }));

test('V-T17 ③ collect.py --host: 포화가 아닌 점은 호스트 포화 표시를 붙이지 않는다', () =>
  withTmp((dir) => {
    const root = newRoot(dir);
    const id = '2026-11-26-msr020-n2-c05-r1-s3';
    const hostFile = join(dir, 'host.json');
    writeFileSync(hostFile, JSON.stringify({ cpuUtil: 0.41, procsRunning: 6, logicalCpus: 32, throttle: {}, cpuAssigned: 9, tags: [] }));
    const r = py(COLLECT, ['--root', root, '--run-id', id, '--kpi', 'K1', '--version', 'v1', '--profile', 'local-1k', '--commit', 'abc123', '--redis-tls', 'true', '--host', hostFile]);
    assert.equal(r.code, 0, r.out);
    const m = JSON.parse(readFileSync(join(root, 'docs', 'perf-ledger', 'runs', id, 'manifest.json'), 'utf8'));
    assert.deepEqual(m.host.tags, []);
    assert.doesNotMatch(String(m.notes ?? ''), /호스트 포화/);
  }));

// ─────────────── F082-7 extrapolate.py origin ───────────────

test('F082-7 ① v1_origin_expected: 파일은 1,000명당 1개·캐시 수명 1초(채택 전 기본)라 1만 명 10/s·10만 명 100/s·1,500명 2/s다(§3.4)', () => {
  assert.equal(pyCall('E.v1_origin_expected(10000)'), 10);
  assert.equal(pyCall('E.v1_origin_expected(100000)'), 100);
  assert.equal(pyCall('E.v1_origin_expected(1500)'), 2);
});

test('F082-7 ② v0_origin_expected: 입장 28명/s에서 10만 명은 1,680 ÷ 0.5 + 6,720 ÷ 5 + 91,600 ÷ 20 ≈ 9,284/s(정본 "약 9,300")다', () => {
  // 예상 대기 1분 이내 = 28 × 60 = 1,680명(0.5초), 1~5분 = 28 × 240 = 6,720명(5초), 나머지 20초(§3.4, queue-admission §4)
  near(pyCall('E.v0_origin_expected(100000, 28)'), 9284, 0.005, '10만');
  near(pyCall('E.v0_origin_expected(10000, 28)'), 3360 + 1344 + 80, 0.005, '1만'); // 1,600명이 20초 구간
  near(pyCall('E.v0_origin_expected(1000, 28)'), 2000, 0.005, '1천'); // 모두 1분 이내 → 1,000 ÷ 0.5
});

test('F082-7 ③ ratio_verdict: 비가 1 ± 10% 안이면 안, 밖이면 밖이다(양쪽 경계)', () => {
  const v = (m, e) => pyCall(`E.ratio_verdict(${m}, ${e}, 0.1)`);
  for (const [m, e, within] of [
    [1099, 1000, true],
    [1101, 1000, false],
    [901, 1000, true],
    [899, 1000, false],
  ]) {
    const r = v(m, e);
    near(r.ratio, m / e, 1e-9, `${m}/${e} 비`);
    assert.equal(r.within, within, `${m}/${e}`);
  }
});

/** 장부 실행 하나(manifest + metrics/origin_rps.csv + metrics-summary.json). 원 서버 요청은 예열 뒤 일정한 값 */
function writeRun(root, id, { users, rps, valid = true }) {
  const dir = join(root, 'docs', 'perf-ledger', 'runs', id);
  mkdirSync(join(dir, 'metrics'), { recursive: true });
  const start = Date.parse('2026-11-26T01:00:00Z') / 1000;
  const manifest = { run_id: id, kpi: 'K1', version: 'v1', profile: users <= 1000 ? 'local-1k' : users <= 10000 ? 'local-10k' : 'local-100k', scale: { users, arrival_rps: null, duration_s: 120, warmup_s: 30 }, started_at: '2026-11-26T01:00:00Z', valid, invalid_reason: valid ? null : '발생기 놓친 반복 4건', verdict: null };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const rows = ['ts,value,labels', ...Array.from({ length: 150 }, (_, i) => `${start + i},${i < 30 ? rps * 5 : rps},{}`)];
  writeFileSync(join(dir, 'metrics', 'origin_rps.csv'), rows.join('\n') + '\n');
  writeFileSync(join(dir, 'metrics-summary.json'), JSON.stringify({ origin_rps: { points: 120, series: 1, labels: '{}', p50: rps, p99: rps, max: rps, mean: rps } }));
}

function originRun(root, ids, out) {
  return py(EXTRA, ['--root', root, 'origin', '--runs', ...ids, '--version', 'v1', '--out', out]);
}

test('F082-7 ④ extrapolate.py origin(v1): 세 점이 모두 ±10% 안이면 100만 값을 외삽(설계 식)으로 적고, 무효 실행은 계산에서 빼되 표에 남긴다', () =>
  withTmp((dir) => {
    const root = newRoot(dir);
    writeRun(root, '2026-11-26-k1-v1-local-1k-r1-f088', { users: 1000, rps: 1.05 });
    writeRun(root, '2026-11-26-k1-v1-local-10k-r1-f088', { users: 10000, rps: 9.3 });
    writeRun(root, '2026-11-26-k1-v1-local-10k-r2-f088', { users: 10000, rps: 30, valid: false }); // 무효: 비 3.0이지만 판정에 넣지 않는다
    writeRun(root, '2026-11-26-k1-v1-local-100k-r1-f088', { users: 100000, rps: 108 });
    const out = join(dir, 'origin.json');
    const ids = ['2026-11-26-k1-v1-local-1k-r1-f088', '2026-11-26-k1-v1-local-10k-r1-f088', '2026-11-26-k1-v1-local-10k-r2-f088', '2026-11-26-k1-v1-local-100k-r1-f088'];
    const r = originRun(root, ids, out);
    assert.equal(r.code, 0, r.out);
    const j = JSON.parse(readFileSync(out, 'utf8'));
    const byId = Object.fromEntries(j.points.map((p) => [p.run_id, p]));
    assert.deepEqual(Object.keys(byId).sort(), [...ids].sort(), '무효 실행도 표에 남는다');
    near(byId[ids[0]].expected, 1, 1e-9, '1천 예상');
    near(byId[ids[1]].ratio, 0.93, 1e-6, '1만 비');
    near(byId[ids[3]].ratio, 1.08, 1e-6, '10만 비');
    assert.equal(byId[ids[2]].valid, false);
    assert.strictEqual(byId[ids[2]].within ?? null, null, '무효 실행은 안·밖을 판정하지 않는다');
    assert.match(String(j.verdict), /외삽\(설계 식\)/);
  }));

test('F082-7 ⑤ extrapolate.py origin(v1): 한 점이라도 ±10% 밖이면 외삽(설계 식)으로 적지 않는다', () =>
  withTmp((dir) => {
    const root = newRoot(dir);
    writeRun(root, '2026-11-26-k1-v1-local-1k-r1-f088', { users: 1000, rps: 1.02 });
    writeRun(root, '2026-11-26-k1-v1-local-10k-r1-f088', { users: 10000, rps: 6.06 }); // 비 0.606
    writeRun(root, '2026-11-26-k1-v1-local-100k-r1-f088', { users: 100000, rps: 99 });
    const out = join(dir, 'origin.json');
    const r = originRun(root, ['2026-11-26-k1-v1-local-1k-r1-f088', '2026-11-26-k1-v1-local-10k-r1-f088', '2026-11-26-k1-v1-local-100k-r1-f088'], out);
    assert.equal(r.code, 0, r.out);
    const j = JSON.parse(readFileSync(out, 'utf8'));
    assert.doesNotMatch(String(j.verdict), /외삽\(설계 식\)/);
    assert.equal(j.points.find((p) => p.run_id === '2026-11-26-k1-v1-local-10k-r1-f088').within, false);
  }));

test('F082-7 ⑥ extrapolate.py origin(v1): 유효한 규모가 셋(1천·1만·10만)에 모자라면 판정하지 않는다(통과로 세지 않는다)', () =>
  withTmp((dir) => {
    const root = newRoot(dir);
    writeRun(root, '2026-11-26-k1-v1-local-1k-r1-f088', { users: 1000, rps: 1.0 });
    writeRun(root, '2026-11-26-k1-v1-local-10k-r1-f088', { users: 10000, rps: 10.0 });
    writeRun(root, '2026-11-26-k1-v1-local-100k-r1-f088', { users: 100000, rps: 100, valid: false });
    const out = join(dir, 'origin.json');
    const r = originRun(root, ['2026-11-26-k1-v1-local-1k-r1-f088', '2026-11-26-k1-v1-local-10k-r1-f088', '2026-11-26-k1-v1-local-100k-r1-f088'], out);
    assert.equal(r.code, 0, r.out);
    const j = JSON.parse(readFileSync(out, 'utf8'));
    assert.doesNotMatch(String(j.verdict), /외삽\(설계 식\)|pass|통과/);
    assert.match(String(j.verdict ?? '') + r.out, /판정하지 않|판정 안|모자/);
  }));

// ─────────────── F082-8 extrapolate.py 진입 설계 식 ───────────────

// entry_design(x1, r, target, n_measured_max, factor_limit): 필요한 대수 ⌈target ÷ X₁⌉, 외삽 배수 = 필요한 대수 ÷ 잰 최대 대수,
// 배수 문턱(4 [가정, 6.1.1에서 확정]) '넘으면' 외삽(측정 범위의 4배 초과), 용량 = min(필요 대수 × X₁, R), R < 목표면 R이 상한(§3.3)
const design = (x1, r, nMax) => pyCall(`E.entry_design(${x1}, ${r}, 200000, ${nMax}, 4)`);

test('F082-8 ① entry_design: X₁ 1,800·R 49만 800·잰 최대 8대면 필요 112대·배수 14·4배 초과 표시·용량 201,600이다', () => {
  const d = design(1800, 490800, 8);
  assert.equal(d.n_required, 112); // ⌈200,000 ÷ 1,800⌉ = ⌈111.1⌉
  near(d.extrapolation_factor, 14, 1e-9, '배수'); // 112 ÷ 8
  assert.match(d.label, /외삽\(측정 범위의 4배 초과\)/);
  near(d.capacity, 201600, 1e-9, '용량'); // min(112 × 1,800, 490,800)
  assert.doesNotMatch(d.label, /R이 상한/);
});

test('F082-8 ② entry_design: 배수가 문턱 4 정각이면 외삽(설계 식), 조금 넘으면 4배 초과다', () => {
  const at = design(6250, 490800, 8); // 32대 ÷ 8 = 4.0
  assert.equal(at.n_required, 32);
  near(at.extrapolation_factor, 4, 1e-9, '배수');
  assert.match(at.label, /외삽\(설계 식\)/);
  assert.doesNotMatch(at.label, /4배 초과/);
  const over = design(6249, 490800, 8); // ⌈32.005⌉ = 33대 ÷ 8 = 4.125
  assert.equal(over.n_required, 33);
  assert.match(over.label, /4배 초과/);
});

test('F082-8 ③ entry_design: R이 목표보다 작으면 대수와 상관없이 R이 상한이고 용량은 R이다', () => {
  const d = design(6250, 150000, 8);
  assert.match(d.label, /R이 상한/);
  near(d.capacity, 150000, 1e-9, '용량');
});
