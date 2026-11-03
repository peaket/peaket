// 성능 장부 도구의 바깥 경계(명령줄) 시험(BUILD_ORDER BSL-080, wbs 1.4.1, docs/perf-ledger.md §2.2·§7, docs/devops.md §3.3).
// 파이썬 도구를 명령줄로 부르고, 임시 저장소 루트에 생긴 manifest와 장부 표를 본다. Prometheus는 이 시험이 띄운 흉내 서버다.
// 실행: node --test "tools/perf-ledger/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const PY = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const COLLECT = join(here, 'collect.py');
const INDEX = join(here, 'index.py');
const NIGHTLY = join(here, 'nightly.py');

const LEDGER_DOC = '# 성능 장부\n\n## 5. 장부 요약 원장\n\n<!-- ledger:begin -->\n<!-- ledger:end -->\n';

function newRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ledger-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'perf-ledger.md'), LEDGER_DOC);
  return root;
}

function py(script, args, opts = {}) {
  const r = spawnSync(PY, ['-I', '-X', 'utf8', script, ...args], { encoding: 'utf8', ...opts });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 비동기 흉내 서버를 쓰는 시험용: spawnSync는 이벤트 루프를 막으므로 자식 프로세스를 비동기로 기다린다 */
async function pyAsync(script, args) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const c = spawn(PY, ['-I', '-X', 'utf8', script, ...args]);
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ code, out }));
  });
}

function writeJson(dir, name, value) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(value));
  return p;
}

function collect(root, runId, extra) {
  return py(COLLECT, ['--root', root, '--run-id', runId, '--kpi', 'K1', '--version', 'v0', '--profile', 'local-10k', '--commit', 'abc123', ...extra]);
}

const manifestOf = (root, runId) => JSON.parse(readFileSync(join(root, 'docs', 'perf-ledger', 'runs', runId, 'manifest.json'), 'utf8'));
const runExists = (root, runId) => existsSync(join(root, 'docs', 'perf-ledger', 'runs', runId));

const k6Summary = (p99) => ({ metrics: { http_req_duration: { avg: p99 / 2, med: p99 / 3, 'p(95)': p99 * 0.9, 'p(99)': p99 }, http_req_failed: { value: 0 }, http_reqs: { count: 5000, rate: 100 }, dropped_iterations: { count: 0 } } });

// --- 비율·백분위 판정(docs/planning/02 §3.1 원칙 6, 기술 검토 중간-002, ADR-0128) ---

test('ADR-0128 중간-002: 시행 수·어긴 수를 준 점검마다 cp_upper·최소 시행 수·결과를 남기고 모두 통과면 verdict pass', () => {
  const root = newRoot();
  const checks = writeJson(root, 'checks.json', {
    checks: [
      { name: 'entry_ok', target: '성공률 99.9%', allowed: 0.001, trials: 3000, violations: 0 },
      { name: 'entry_p99_200ms', allowed: 0.01, trials: 400, violations: 0 },
    ],
  });
  const r = collect(root, 'r-pass', ['--checks', checks]);
  assert.equal(r.code, 0, r.out);
  const m = manifestOf(root, 'r-pass');
  assert.equal(m.verdict, 'pass');
  const [a, b] = m.checks;
  assert.deepEqual([a.name, a.trials, a.violations, a.min_trials, a.result], ['entry_ok', 3000, 0, 2995, 'pass']);
  assert.ok(Math.abs(a.cp_upper - 0.000998) < 1e-6, String(a.cp_upper));
  assert.deepEqual([b.min_trials, b.result], [299, 'pass']);
});

test('ADR-0128 중간-002: 상한이 허용 비율을 넘으면 그 점검은 fail이고 verdict fail', () => {
  const root = newRoot();
  const checks = writeJson(root, 'c.json', { checks: [{ name: 'ok', allowed: 0.001, trials: 3000, violations: 3 }] });
  const r = collect(root, 'r-fail', ['--checks', checks]);
  assert.equal(r.code, 0, r.out);
  const m = manifestOf(root, 'r-fail');
  assert.equal(m.checks[0].result, 'fail');
  assert.equal(m.verdict, 'fail');
});

test('ADR-0128 중간-002: 최소 시행 수 미달은 observed이고 verdict를 비우며 notes에 관측값을 적는다', () => {
  const root = newRoot();
  const checks = writeJson(root, 'c.json', { checks: [{ name: 'p95', allowed: 0.05, trials: 40, violations: 0 }] });
  const r = collect(root, 'r-obs', ['--checks', checks, '--notes', '첫 리허설']);
  assert.equal(r.code, 0, r.out);
  const m = manifestOf(root, 'r-obs');
  assert.equal(m.checks[0].result, 'observed');
  assert.equal(m.checks[0].min_trials, 59);
  assert.equal(m.verdict, null);
  assert.match(m.notes, /첫 리허설/);
  assert.match(m.notes, /관측값\(시행 40번, 최소 시행 수 미달\)/);
});

test('ADR-0128 중간-002: --verdict pass가 점검과 어긋나면 측정 폴더를 만들지 않고 거부하고, baseline·fail은 그대로 둔다', () => {
  const root = newRoot();
  const failing = writeJson(root, 'f.json', { checks: [{ name: 'ok', allowed: 0.001, trials: 3000, violations: 9 }] });
  const passing = writeJson(root, 'p.json', { checks: [{ name: 'ok', allowed: 0.001, trials: 3000, violations: 0 }] });
  const observed = writeJson(root, 'o.json', { checks: [{ name: 'ok', allowed: 0.001, trials: 10, violations: 0 }] });
  for (const [id, file, verdict] of [['x1', failing, 'pass'], ['x2', observed, 'pass']]) {
    const r = collect(root, id, ['--checks', file, '--verdict', verdict]);
    assert.notEqual(r.code, 0, `${id}: ${r.out}`);
    assert.match(r.out, /거부/);
    assert.equal(runExists(root, id), false, id);
  }
  const r = collect(root, 'x4', ['--checks', failing, '--verdict', 'baseline']);
  assert.equal(r.code, 0, r.out);
  const m = manifestOf(root, 'x4');
  assert.equal(m.verdict, 'baseline');
  assert.equal(m.checks[0].result, 'fail');
  // fail은 점검 밖의 까닭(불변식 위반 등)이 있을 수 있어 점검이 모두 통과해도 받는다
  for (const [id, file] of [['x5', observed], ['x6', passing]]) {
    const r2 = collect(root, id, ['--checks', file, '--verdict', 'fail']);
    assert.equal(r2.code, 0, r2.out);
    assert.equal(manifestOf(root, id).verdict, 'fail');
  }
});

test('ADR-0128 중간-002: 어긴 수가 아주 많아도 상한 계산이 빨리 끝난다', () => {
  const root = newRoot();
  const checks = writeJson(root, 'big.json', { checks: [{ name: 'big', allowed: 0.05, trials: 2000000, violations: 150000 }] });
  const t = Date.now();
  const r = collect(root, 'big', ['--checks', checks]);
  assert.equal(r.code, 0, r.out);
  const c = manifestOf(root, 'big').checks[0];
  assert.equal(c.result, 'fail');
  assert.ok(c.cp_upper > 0.075 && c.cp_upper < 0.0760, String(c.cp_upper));
  assert.ok(Date.now() - t < 5000, `${Date.now() - t}ms`);
});

test('[ASVS v5.0.0-2.2.1] ADR-0128: 점검 파일의 모르는 키와 범위 밖 값을 측정 폴더를 만들기 전에 거부한다', () => {
  const root = newRoot();
  const bad = [
    { checks: [{ name: 'a', allowed: 0.01, trials: 10, violations: 0, extra: 1 }] },
    { checks: [{ name: 'a', allowed: 0.01, trials: 10, violations: 11 }] },
    { checks: [{ name: 'a', allowed: 1.5, trials: 10, violations: 0 }] },
    { checks: [{ name: 'a', allowed: 0.01, trials: -1, violations: 0 }] },
    { checks: [{ name: 'a', allowed: 0.01, trials: 10.5, violations: 0 }] },
    { checks: [{ name: 'a b', allowed: 0.01, trials: 10, violations: 0 }] },
    { checks: [{ name: 'a', allowed: 0.01 }] },
    { checks: [{ name: 'a', allowed: 0.01, trials: 10, violations: 0 }, { name: 'a', allowed: 0.01, trials: 10, violations: 0 }] },
    { checks: [], other: true },
    { checks: [] },
    { checks: [{ name: 'h', allowed: 0.01, histogram: { metric: 'm', match: 'route="/x"}' , le: 0.2 } }] },
  ];
  bad.forEach((v, i) => {
    const r = collect(root, `bad${i}`, ['--checks', writeJson(root, `bad${i}.json`, v)]);
    assert.notEqual(r.code, 0, `${i}: ${r.out}`);
    assert.equal(runExists(root, `bad${i}`), false, `${i}`);
  });
  // JSON 바깥 값(Infinity·NaN)은 파이썬 json이 기본으로 받으므로 따로 막는다
  const raw = join(root, 'inf.json');
  writeFileSync(raw, '{"checks":[{"name":"h","allowed":0.01,"histogram":{"metric":"m","match":"a=\\"b\\"","le":Infinity}}]}');
  const r = collect(root, 'inf', ['--checks', raw]);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(runExists(root, 'inf'), false);
});

// --- 서버 히스토그램 점검과 클라이언트·서버 지연 대조(ADR-0077) ---

/**
 * Prometheus 즉시 조회 흉내. 측정 창 끝·시작의 칸 카운터 합(sum by (le)), 창 안에서 사라진 시계열 수, 카운터 되돌아감 수를 돌려준다.
 * opts: end·start(le → 누적 개수), startTs(창 시작 시각), lost(사라진 시계열 수), resets(되돌아감 수)
 */
async function fakeProm(opts) {
  const seen = [];
  const vec = (obj) => Object.entries(obj).map(([le, v]) => ({ metric: { le }, value: [0, String(v)] }));
  const one = (v) => (v ? [{ metric: {}, value: [0, String(v)] }] : []);
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const query = u.searchParams.get('query');
    const time = Number(u.searchParams.get('time'));
    seen.push({ path: u.pathname, query, time });
    let result = [];
    if (query.startsWith('sum by (le) (')) result = vec(time === opts.startTs ? opts.start : opts.end);
    else if (query.startsWith('count(')) result = one(opts.lost ?? 0);
    else if (query.startsWith('sum(resets(')) result = one(opts.resets ?? 0);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

const T0 = Date.parse('2026-11-02T00:00:00Z') / 1000;
const T1 = Date.parse('2026-11-02T00:10:00Z') / 1000;
const M = 'http_server_request_duration_seconds';
const histArgs = (root, id, checks, extra = []) => ['--root', root, '--run-id', id, '--kpi', 'K1', '--version', 'v0', '--profile', 'local-10k', '--commit', 'abc',
  '--checks', checks, '--start', '2026-11-02T00:00:00Z', '--end', '2026-11-02T00:10:00Z', ...extra];

test('ADR-0077: 히스토그램 점검은 측정 창(시작+예열~끝)의 칸 카운터 차이로 시행 수와 기준값을 넘은 수를 센다', async () => {
  // 창 시작(T0+120)과 끝(T1)의 카운터 합 차이: 전체 4,000, 0.2초 이하 3,990 → 넘은 것 10
  const prom = await fakeProm({ startTs: T0 + 120, start: { '0.05': 500, '0.1': 700, '0.2': 990, '+Inf': 1000 }, end: { '0.05': 2500, '0.1': 3700, '0.2': 4980, '+Inf': 5000 } });
  try {
    const root = newRoot();
    const sel = 'route="/v1/queues/{eventId}/entries"';
    const checks = writeJson(root, 'h.json', { checks: [{ name: 'entry_p99_200ms', allowed: 0.01, histogram: { metric: M, match: sel, le: 0.2 } }] });
    const r = await pyAsync(COLLECT, histArgs(root, 'h1', checks, ['--prom-url', prom.url, '--warmup', '120']));
    assert.equal(r.code, 0, r.out);
    const c = manifestOf(root, 'h1').checks[0];
    // 4,000번 중 10번(0.25%)이 기준을 넘었다. 상한 약 0.42%가 허용 1% 이하라 통과
    assert.deepEqual([c.trials, c.violations, c.result], [4000, 10, 'pass']);
    assert.ok(c.cp_upper > 0.0025 && c.cp_upper < 0.01, String(c.cp_upper));
    const sums = prom.seen.filter((q) => q.query === `sum by (le) (${M}_bucket{${sel}})`);
    assert.deepEqual(sums.map((q) => q.time).sort(), [T0 + 120, T1]);
    assert.ok(prom.seen.some((q) => q.query === `count(last_over_time(${M}_bucket{${sel}}[480s]) unless ${M}_bucket{${sel}})` && q.time === T1), JSON.stringify(prom.seen));
    // 창 시작 직전 표본과 직후 표본 사이의 재시작도 보도록 조회 유예(5분)만큼 넓힌다
    assert.ok(prom.seen.some((q) => q.query === `sum(resets(${M}_bucket{${sel}}[780s]))` && q.time === T1));
  } finally {
    await prom.close();
  }
});

test('ADR-0077: 측정 중에 새로 뜬 파드의 시계열(창 시작에 없음)은 0부터 다 센다', async () => {
  // 시작에는 칸이 없다(시계열 없음) → 끝의 값 전부가 측정 창의 요청이다(increase()처럼 첫 표본을 잃지 않는다)
  const prom = await fakeProm({ startTs: T0, start: {}, end: { '0.2': 3000, '+Inf': 3000 } });
  try {
    const root = newRoot();
    const checks = writeJson(root, 'h.json', { checks: [{ name: 'p', allowed: 0.01, histogram: { metric: M, match: 'route="/x"', le: 0.2 } }] });
    const r = await pyAsync(COLLECT, histArgs(root, 'h-new', checks, ['--prom-url', prom.url]));
    assert.equal(r.code, 0, r.out);
    const c = manifestOf(root, 'h-new').checks[0];
    assert.deepEqual([c.trials, c.violations], [3000, 0]);
  } finally {
    await prom.close();
  }
});

test('ADR-0077: 창 안에서 사라진 시계열이나 카운터 되돌아감(파드 종료·재시작)이 있으면 셀 수 없어 거부한다', async () => {
  for (const [id, extra] of [['h-lost', { lost: 2 }], ['h-reset', { resets: 1 }]]) {
    const prom = await fakeProm({ startTs: T0, start: { '0.2': 10, '+Inf': 10 }, end: { '0.2': 3000, '+Inf': 3000 }, ...extra });
    try {
      const root = newRoot();
      const checks = writeJson(root, 'h.json', { checks: [{ name: 'p', allowed: 0.01, histogram: { metric: M, match: 'route="/x"', le: 0.2 } }] });
      const r = await pyAsync(COLLECT, histArgs(root, id, checks, ['--prom-url', prom.url]));
      assert.notEqual(r.code, 0, `${id}: ${r.out}`);
      assert.match(r.out, /사라진 시계열|되돌아/);
      assert.equal(runExists(root, id), false, id);
    } finally {
      await prom.close();
    }
  }
});

test('ADR-0077: 같은 경계를 다르게 적은 칸("1"·"1.0")은 합쳐 센다', async () => {
  const prom = await fakeProm({ startTs: T0, start: {}, end: { '1': 1000, '1.0': 1990, '+Inf': 3000 } });
  try {
    const root = newRoot();
    const checks = writeJson(root, 'h.json', { checks: [{ name: 'p', allowed: 0.01, histogram: { metric: M, match: 'route="/x"', le: 1 } }] });
    const r = await pyAsync(COLLECT, histArgs(root, 'h-dup', checks, ['--prom-url', prom.url]));
    assert.equal(r.code, 0, r.out);
    assert.equal(manifestOf(root, 'h-dup').checks[0].violations, 10);
  } finally {
    await prom.close();
  }
});

test('ADR-0077: 기준값과 같은 칸 경계가 없으면 측정 폴더를 만들지 않고 거부한다', async () => {
  const prom = await fakeProm({ startTs: T0, start: {}, end: { '0.1': 3000, '0.2': 3990, '+Inf': 4000 } });
  try {
    const root = newRoot();
    const checks = writeJson(root, 'h.json', { checks: [{ name: 'p99_250', allowed: 0.01, histogram: { metric: M, match: 'route="/x"', le: 0.25 } }] });
    const r = await pyAsync(COLLECT, histArgs(root, 'h2', checks, ['--prom-url', prom.url]));
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /칸 경계/);
    assert.equal(runExists(root, 'h2'), false);
  } finally {
    await prom.close();
  }
});

test('ADR-0077: latency_crosscheck는 k6 p99와 서버 p99·기준값 안 비율·차이를 남기고, 서버가 목표 안인데 k6가 밖이면 측정 지점 의심이다', async () => {
  // 서버: 기준(0.2초) 넘은 것 0, p99는 0.1~0.2초 칸 안에서 보간
  const prom = await fakeProm({ startTs: T0, start: {}, end: { '0.05': 2000, '0.1': 3000, '0.2': 4000, '+Inf': 4000 } });
  try {
    const root = newRoot();
    const checks = writeJson(root, 'h.json', {
      checks: [{ name: 'entry_p99_200ms', allowed: 0.01, histogram: { metric: M, match: 'route="/e"', le: 0.2 } }],
      crosscheck: { check: 'entry_p99_200ms', k6_metric: 'http_req_duration' },
    });
    const slow = await pyAsync(COLLECT, histArgs(root, 'c1', checks, ['--prom-url', prom.url, '--k6-summary', writeJson(root, 'k1.json', k6Summary(260))]));
    assert.equal(slow.code, 0, slow.out);
    const x = manifestOf(root, 'c1').latency_crosscheck;
    assert.equal(x.k6_p99_ms, 260);
    assert.ok(Math.abs(x.server_p99_ms - 196) < 1e-6, String(x.server_p99_ms)); // 0.1 + (3960-3000)/(4000-3000)*0.1 = 0.196초
    assert.equal(x.server_within_ratio, 1);
    assert.ok(Math.abs(x.diff_ms - 64) < 1e-6, String(x.diff_ms));
    assert.equal(x.target_ms, 200); // 목표는 그 점검의 기준값 칸(le)이다
    assert.equal(x.suspect, true);
    const fast = await pyAsync(COLLECT, histArgs(root, 'c2', checks, ['--prom-url', prom.url, '--k6-summary', writeJson(root, 'k2.json', k6Summary(190))]));
    assert.equal(fast.code, 0, fast.out);
    assert.equal(manifestOf(root, 'c2').latency_crosscheck.suspect, false);
  } finally {
    await prom.close();
  }
});

test('ADR-0077: crosscheck의 k6 하위 지표가 요약에 없으면 시나리오에 그 하위 지표의 기준(threshold)을 두라고 안내하며 거부한다', async () => {
  const prom = await fakeProm({ startTs: T0, start: {}, end: { '0.2': 4000, '+Inf': 4000 } });
  try {
    const root = newRoot();
    const checks = writeJson(root, 'h.json', {
      checks: [{ name: 'p', allowed: 0.01, histogram: { metric: M, match: 'route="/e"', le: 0.2 } }],
      crosscheck: { check: 'p', k6_metric: 'http_req_duration{phase:measure}' },
    });
    const r = await pyAsync(COLLECT, histArgs(root, 'sub', checks, ['--prom-url', prom.url, '--k6-summary', writeJson(root, 'k.json', k6Summary(100))]));
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /threshold/);
    assert.equal(runExists(root, 'sub'), false);
  } finally {
    await prom.close();
  }
});

test('ADR-0077: crosscheck의 목표가 점검의 기준값 칸과 다르거나 k6 지표 이름이 없으면 거부한다', () => {
  const root = newRoot();
  const h = { name: 'p', allowed: 0.01, histogram: { metric: M, match: 'route="/x"', le: 0.2 } };
  const cases = [{ check: 'p', k6_metric: 'http_req_duration', target_ms: 300 }, { check: 'p' }];
  cases.forEach((cross, i) => {
    const r = collect(root, `cx${i}`, ['--checks', writeJson(root, `cx${i}.json`, { checks: [h], crosscheck: cross })]);
    assert.notEqual(r.code, 0, r.out);
    assert.equal(runExists(root, `cx${i}`), false);
  });
});

// --- 장부 표의 증거 수준 칸(기술 검토 중간-111, ADR-0128) ---

test('ADR-0128 중간-111: 장부 표에 증거 수준 칸이 있고 기본은 측정함, --evidence 계산만이면 그 값이다', () => {
  const root = newRoot();
  assert.equal(collect(root, '2026-11-02-a', []).code, 0);
  assert.equal(collect(root, '2026-11-02-b', ['--evidence', '계산만']).code, 0);
  assert.notEqual(collect(root, '2026-11-02-c', ['--evidence', '추정']).code, 0);
  const r = py(INDEX, ['--root', root]);
  assert.equal(r.code, 0, r.out);
  const doc = readFileSync(join(root, 'docs', 'perf-ledger.md'), 'utf8');
  assert.match(doc, /\| 판정 \| 증거 수준 \| 비용\(원\) \|/);
  const row = (id) => doc.split('\n').find((l) => l.includes(`| ${id} |`)).split(' | ');
  assert.equal(row('2026-11-02-a')[9], '측정함');
  assert.equal(row('2026-11-02-b')[9], '계산만');
  assert.equal(manifestOf(root, '2026-11-02-a').evidence, '측정함');
});

// --- 야간 축소 성능 상대 비교(D-T40, ADR-0133 낮음-016, docs/devops.md §3.3) ---

/** 가짜 k6: --summary-export 파일에 BASE_URL별 p99를 쓴다. 지연표는 환경 값 FAKE_K6_P99(JSON) */
function fakeK6(dir) {
  const p = join(dir, 'fake-k6.mjs');
  writeFileSync(p, `
import { writeFileSync, appendFileSync } from 'node:fs';
const a = process.argv.slice(2);
const out = a[a.indexOf('--summary-export') + 1];
const url = a.find((x) => x.startsWith('BASE_URL=')).slice(9);
appendFileSync(process.env.FAKE_K6_LOG, url + '\\n');
const p99 = JSON.parse(process.env.FAKE_K6_P99)[url];
// FAKE_K6_SKIP=<주소>면 그 판은 요약을 쓰지 못한 것처럼(컨테이너 권한 문제) 아무것도 쓰지 않고 0으로 끝난다
if (process.env.FAKE_K6_SKIP !== url) writeFileSync(out, JSON.stringify({ metrics: { http_req_duration: { 'p(99)': p99 } } }));
process.exit(Number(process.env.FAKE_K6_EXIT ?? 0));
`);
  return p;
}

function nightlySetup(p99Table) {
  const root = newRoot();
  const k6 = fakeK6(root);
  const prep = join(root, 'prep.mjs');
  writeFileSync(prep, `process.stdout.write(JSON.stringify({ base_url: 'http://base', new_url: 'http://new' }) + '\\n');`);
  const config = writeJson(root, 'config.json', { scenario: 'loadtest/nightly/hot.js', rounds: 5, prepare: [process.execPath, prep] });
  const env = { ...process.env, FAKE_K6_P99: JSON.stringify(p99Table), FAKE_K6_LOG: join(root, 'k6.log') };
  const run = (out, more = {}) => py(NIGHTLY, ['run', '--config', config, '--out', out, '--k6', process.execPath, k6], { env: { ...env, ...more }, cwd: root });
  return { root, run, env };
}

test('D-T40 ①: A/A 실행은 기준·새를 번갈아 판마다 5번 돌려 비율을 남기고, 10번의 비율로 기준값(1 + 가장 큰 벗어남)을 정한다', () => {
  const { root, run } = nightlySetup({ 'http://base': 100, 'http://new': 100 });
  const outs = [];
  for (let i = 0; i < 10; i++) {
    const out = join(root, `aa-${i}.json`);
    const r = run(out);
    assert.equal(r.code, 0, r.out);
    outs.push(out);
  }
  const log = readFileSync(join(root, 'k6.log'), 'utf8').trim().split('\n');
  assert.deepEqual(log.slice(0, 10), Array.from({ length: 10 }, (_, i) => (i % 2 ? 'http://new' : 'http://base')));
  assert.equal(log.length, 100);
  const first = JSON.parse(readFileSync(outs[0], 'utf8'));
  assert.equal(first.runs.length, 10);
  assert.equal(first.ratio, 1);
  // 실제 A/A는 잡음이 있다: 비율을 손으로 흔든 결과 파일 10개
  const noisy = [1.0, 1.03, 0.98, 1.05, 0.96, 1.01, 1.02, 0.99, 1.04, 1.0].map((ratio, i) => writeJson(root, `n${i}.json`, { ...first, ratio }));
  const th = join(root, 'threshold.json');
  const r = py(NIGHTLY, ['aa-threshold', '--results', ...noisy, '--out', th]);
  assert.equal(r.code, 0, r.out);
  const t = JSON.parse(readFileSync(th, 'utf8'));
  assert.ok(Math.abs(t.max_ratio - 1.05) < 1e-9, String(t.max_ratio));
  assert.equal(t.aa_ratios.length, 10);
  const few = py(NIGHTLY, ['aa-threshold', '--results', ...noisy.slice(0, 9), '--out', th]);
  assert.notEqual(few.code, 0, few.out);
});

test('D-T40 ②: 새 판에 30ms 지연을 넣으면 기준값을 넘어 실패(종료 코드 1)하고 SEV3 알림 본문을 남긴다', () => {
  const { root, run } = nightlySetup({ 'http://base': 100, 'http://new': 130 });
  const out = join(root, 'ab.json');
  assert.equal(run(out).code, 0);
  const th = writeJson(root, 'threshold.json', { max_ratio: 1.05, aa_ratios: [1, 1.05], decided_at: '2026-11-02' });
  const alert = join(root, 'alert.md');
  const r = py(NIGHTLY, ['compare', '--results', out, '--threshold', th, '--alert-out', alert]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /::error::/);
  const body = readFileSync(alert, 'utf8');
  assert.match(body, /SEV3/);
  assert.match(body, /1\.3/);
  const ok = py(NIGHTLY, ['compare', '--results', writeJson(root, 'same.json', { runs: [], base_p99_ms: 100, new_p99_ms: 104, ratio: 1.04 }), '--threshold', th]);
  assert.equal(ok.code, 0, ok.out);
});

test('D-T40 ③: 기준값을 정하기 전(max_ratio 없음)에는 지연을 넣은 판도 경고만 하고 성공으로 끝난다', () => {
  const { root, run } = nightlySetup({ 'http://base': 100, 'http://new': 130 });
  const out = join(root, 'ab.json');
  assert.equal(run(out).code, 0);
  const th = writeJson(root, 'threshold.json', { max_ratio: null });
  const r = py(NIGHTLY, ['compare', '--results', out, '--threshold', th]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /::warning::/);
});

test('D-T40: 요약을 쓰지 못한 회차는 지난 실행의 요약을 다시 읽지 않고 실패(종료 2)한다', () => {
  const { root, run } = nightlySetup({ 'http://base': 100, 'http://new': 100 });
  mkdirSync(join(root, '.cache', 'nightly'), { recursive: true });
  // 다섯 회차의 기준판 요약이 모두 지난 실행의 것으로 남아 있다(이번에는 하나도 쓰지 못함)
  for (let i = 0; i < 5; i++) writeFileSync(join(root, '.cache', 'nightly', `0${i}-base.json`), JSON.stringify({ metrics: { http_req_duration: { 'p(99)': 999 } } }));
  const r = run(join(root, 'stale.json'), { FAKE_K6_SKIP: 'http://base' });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /요약/);
});

test('D-T40 ②: k6가 시나리오 기준을 넘어 종료 코드 99로 끝나도 요약이 있으면 비교까지 간다', () => {
  const { root, run } = nightlySetup({ 'http://base': 100, 'http://new': 400 });
  const out = join(root, 'th.json');
  const r = run(out, { FAKE_K6_EXIT: '99' });
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).ratio, 4);
  const other = run(join(root, 'x.json'), { FAKE_K6_EXIT: '107' });
  assert.equal(other.code, 2, other.out);
});

test('D-T40: perf-nightly.yml은 YAML로 읽히고, 실패 알림 단계는 준비가 끝난 뒤의 모든 실패에서 돈다', async () => {
  const { parse } = await import('yaml');
  const wf = parse(readFileSync(join(here, '..', '..', '.github', 'workflows', 'perf-nightly.yml'), 'utf8'));
  const job = wf.jobs.nightly;
  const alert = job.steps.find((st) => typeof st.run === 'string' && st.run.includes('gh issue create'));
  assert.ok(alert, '알림 단계');
  assert.equal(alert.if, "failure() && steps.plan.outputs.ready == 'true'");
  assert.match(alert.run, /printf/);
  // 파이썬 쪽 전체 기한(--deadline-s)이 잡 시간 제한보다 짧아야 멈춘 k6도 실패(알림)로 끝난다
  const run = job.steps.find((st) => typeof st.run === 'string' && st.run.includes('nightly.py run'));
  const deadline = Number(/--deadline-s (\d+)/.exec(run.run)?.[1]);
  assert.ok(deadline > 0 && deadline + 15 * 60 < job['timeout-minutes'] * 60, `기한 ${deadline}초, 잡 ${job['timeout-minutes']}분`);
});

test('D-T40: 전체 기한(--deadline-s)을 넘기면 멈춘 k6를 끊고 종료 2로 끝낸다', () => {
  const root = newRoot();
  const slow = join(root, 'slow-k6.mjs');
  writeFileSync(slow, 'setTimeout(() => {}, 60000);');
  const prep = join(root, 'prep.mjs');
  writeFileSync(prep, "process.stdout.write(JSON.stringify({ base_url: 'http://base', new_url: 'http://new' }) + '\\n');");
  const config = writeJson(root, 'config.json', { scenario: 's.js', rounds: 5, prepare: [process.execPath, prep] });
  const t = Date.now();
  const r = py(NIGHTLY, ['run', '--config', config, '--out', join(root, 'o.json'), '--deadline-s', '2', '--k6', process.execPath, slow], { cwd: root });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /기한/);
  assert.ok(Date.now() - t < 20000, `${Date.now() - t}ms`);
});

test('[ASVS v5.0.0-1.2.5] D-T40: 준비 명령은 셸 문자열이 아니라 인자 목록이어야 하고, 설정·기준값 파일의 모르는 키를 거부한다', () => {
  const root = newRoot();
  const bad = [
    { scenario: 's.js', rounds: 5, prepare: 'node prep.mjs; rm -rf /' },
    { scenario: 's.js', rounds: 0, prepare: ['node'] },
    { scenario: 's.js', rounds: 5, prepare: ['node'], shell: true },
  ];
  bad.forEach((c, i) => {
    const r = py(NIGHTLY, ['run', '--config', writeJson(root, `c${i}.json`, c), '--out', join(root, 'o.json')]);
    assert.notEqual(r.code, 0, `${i}: ${r.out}`);
  });
  const r = py(NIGHTLY, ['compare', '--results', writeJson(root, 'r.json', { runs: [], base_p99_ms: 1, new_p99_ms: 1, ratio: 1 }), '--threshold', writeJson(root, 't.json', { max_ratio: 0.5 })]);
  assert.equal(r.code, 2, r.out);
  const nan = join(root, 'nan.json');
  writeFileSync(nan, '{"max_ratio": NaN}');
  const r2 = py(NIGHTLY, ['compare', '--results', join(root, 'r.json'), '--threshold', nan]);
  assert.equal(r2.code, 2, r2.out);
  const notObj = join(root, 'prep2.mjs');
  writeFileSync(notObj, 'console.log("[1,2]")');
  const r3 = py(NIGHTLY, ['run', '--config', writeJson(root, 'c9.json', { scenario: 's.js', rounds: 1, prepare: [process.execPath, notObj] }), '--out', join(root, 'o.json')]);
  assert.equal(r3.code, 2, r3.out);
  const r4 = py(NIGHTLY, ['run', '--config', writeJson(root, 'c10.json', { scenario: 's.js', rounds: 1, prepare: ['no-such-command-peaket'] }), '--out', join(root, 'o.json')]);
  assert.equal(r4.code, 2, r4.out);
});

// --- BSL-090: 야간 비교 설정의 k6 명령, A/A 실행(aa), 큰 원본을 보낼 폴더, ots 없이 하루 해시 묶음 쓰기
//     (D-T40, ADR-0133 낮음-016, 기술 검토 낮음-056, docs/devops.md §3.3, docs/perf-ledger.md §2.1·§9) ---

/** 기본 docker 명령으로 잘못 빠져도 이미지를 받지 않고 곧바로 실패하게 docker 데몬 주소를 닫힌 로컬 포트로 둔다 */
const NO_DOCKER = { DOCKER_HOST: 'tcp://127.0.0.1:9' };
/** 도구 한 번 부름의 상한. spawnSync는 이벤트 루프를 막아 시험의 시간 제한이 듣지 않으므로, 잘못 만든 도구가 멈춰도 시험이 끝나게 한다 */
const CALL_LIMIT = { timeout: 120000 };
const SCENARIO = 'loadtest/nightly/hot.js';

/**
 * 가짜 k6(인자 기록용). 부를 때마다 받은 인자 목록을 FAKE_K6_ARGS 파일에 JSON 한 줄로 남기고 --summary-export 경로에 p99 요약을 쓴다(폴더는 만들지 않는다).
 * p99는 FAKE_K6_SEQ(JSON 배열, 몇 번째 부름인지(0부터)로 고름)가 있으면 그 값, 없으면 FAKE_K6_P99(주소 → p99)다.
 * FAKE_K6_SKIP_AT(JSON 배열)에 든 차례에는 요약을 쓰지 않고 0으로 끝나고, FAKE_K6_FAIL_AT 차례부터는 요약 없이 종료 107로 끝난다.
 * FAKE_K6_SLEEP_MS가 있으면 요약을 쓰기 전에 그만큼 기다린다(기한 시험).
 */
function argsK6(dir) {
  const p = join(dir, 'fake-k6-args.mjs');
  writeFileSync(p, `
import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
const a = process.argv.slice(2);
const log = process.env.FAKE_K6_ARGS;
const n = existsSync(log) ? readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0;
appendFileSync(log, JSON.stringify(a) + '\\n');
if (process.env.FAKE_K6_FAIL_AT !== undefined && n >= Number(process.env.FAKE_K6_FAIL_AT)) process.exit(107);
if (process.env.FAKE_K6_SLEEP_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_K6_SLEEP_MS)));
const out = a[a.indexOf('--summary-export') + 1];
const url = a.find((x) => x.startsWith('BASE_URL=')).slice(9);
const p99 = process.env.FAKE_K6_SEQ ? JSON.parse(process.env.FAKE_K6_SEQ)[n] : JSON.parse(process.env.FAKE_K6_P99)[url];
if (!JSON.parse(process.env.FAKE_K6_SKIP_AT ?? '[]').includes(n)) writeFileSync(out, JSON.stringify({ metrics: { http_req_duration: { 'p(99)': p99 } } }));
`);
  return p;
}

/** JSON 한 줄씩 쌓은 기록 파일(없으면 빈 목록) */
const jsonLines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const k6Calls = jsonLines;
const summaryOf = (args) => args[args.indexOf('--summary-export') + 1];
const aaName = (i) => `aa-${String(i).padStart(2, '0')}.json`;
const aaFiles = (dir) => readdirSync(dir).filter((f) => /^aa-\d+\.json$/.test(f)).sort();
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const RESULT_KEYS = ['base_p99_ms', 'ended_at', 'new_p99_ms', 'ratio', 'rounds', 'runs', 'scenario', 'started_at'];
/** 결과 파일의 모양: 맨 위 키와 runs 항목의 키 */
const shapeOf = (x) => ({ top: Object.keys(x).sort(), run: [...new Set(x.runs.flatMap((y) => Object.keys(y)))].sort() });
const todayUtc = () => new Date().toISOString().slice(0, 10);
/** 글 안에 수 n이 따로(다른 숫자에 붙지 않고) 나오는지 */
const mentions = (text, n) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(text);

/** nightly.py가 k6 명령 뒤에 붙이는 인자(docs/devops.md §3.3). 요약 경로만 부를 때마다 다르다 */
const k6Tail = (summary, url, scenario) => ['run', '--quiet', '--summary-trend-stats', 'med,p(95),p(99),max', '--summary-export', summary, '-e', `BASE_URL=${url}`, scenario];
const K6_TAIL = k6Tail('', '', '').length;

/** k6 부름 n번이 기준·새를 번갈아 가고, 저마다 인자가 정확히 [k6 명령의 인자…, k6 인자…]인지 본다(다른 명령의 인자를 앞뒤에 섞지 않는다) */
function assertK6Calls(calls, n, head, scenario = SCENARIO) {
  assert.equal(calls.length, n, JSON.stringify(calls));
  calls.forEach((a, i) => assert.deepEqual(a, [...head, ...k6Tail(summaryOf(a), i % 2 ? 'http://new' : 'http://base', scenario)], `${i}번째 부름: ${JSON.stringify(a)}`));
}

/** 같은 폴더·파일인지(Windows는 대소문자를 가리지 않는다) */
function samePath(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  const real = (p) => (process.platform === 'win32' ? realpathSync.native(p).toLowerCase() : realpathSync.native(p));
  return real(a) === real(b);
}

// 바깥 명령 바꿔 끼우기(fakeTools): 도구 스크립트를 그대로 돌리되, subprocess.Popen(run·call·check_output이 모두 거친다)과 os.system으로 부르는
// 명령의 이름(경로와 .exe를 뗀 것)이 FAKE_TOOLS에 들면 진짜 명령 대신 기록기를 부른다. PATH 앞에 가짜 실행 파일을 두는 길은 쓰지 않는다
// (파이썬은 셸 없이 부르므로 Windows에서는 .exe라야 찾는데, node.exe를 그 이름으로 걸 권한이 없어 복사해야 한다)
const FAKE_TOOLS_WRAPPER = String.raw`"""시험용(ledger.test.mjs fakeTools): 도구를 그대로 돌리되 FAKE_TOOLS에 든 바깥 명령은 기록기로 바꿔 부른다."""
import json
import os
import runpy
import subprocess
import sys

FAKES = {x for x in os.environ.get('FAKE_TOOLS', '').split(',') if x}
CONF = json.dumps({'log': os.environ['FAKE_TOOL_LOG'], 'p99': os.environ.get('FAKE_K6_P99'),
                   'exit': {k[len('FAKE_EXIT_'):].lower(): int(v) for k, v in os.environ.items() if k.upper().startswith('FAKE_EXIT_')}})
RECORDER = os.environ['FAKE_TOOL_RECORDER']
REAL_POPEN = subprocess.Popen
REAL_SYSTEM = os.system


def faked(argv):
    name = os.path.basename(argv[0]).lower() if argv else ''
    name = name[:-4] if name.endswith('.exe') else name
    return name if name in FAKES else None


class Popen(REAL_POPEN):
    def __init__(self, *args, **kwargs):
        cmd = args[0] if args else kwargs.get('args')
        argv = [os.fsdecode(x) for x in cmd] if isinstance(cmd, (list, tuple)) else os.fsdecode(cmd).split()
        name = faked(argv)
        if name:
            fake = [sys.executable, '-I', RECORDER, CONF, name, *argv[1:]]
            kwargs.pop('executable', None)
            kwargs['shell'] = False
            if args:
                args = (fake, *args[1:])
            else:
                kwargs['args'] = fake
        super().__init__(*args, **kwargs)


def system(command):
    argv = os.fsdecode(command).split()
    return subprocess.call(argv) if faked(argv) else REAL_SYSTEM(command)


subprocess.Popen = Popen
os.system = system
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
`;

const FAKE_TOOLS_RECORDER = String.raw`"""시험용 바깥 명령 기록기(ledger.test.mjs fakeTools). [이름, 인자…]를 기록 파일에 JSON 한 줄로 남기고 정한 코드(기본 97)로 끝난다."""
import io
import json
import sys

conf, name, args = json.loads(sys.argv[1]), sys.argv[2], sys.argv[3:]
with io.open(conf['log'], 'a', encoding='utf-8', newline='\n') as f:
    f.write(json.dumps([name, *args], ensure_ascii=False) + '\n')
if name == 'docker' and '--summary-export' in args and conf['p99']:
    # 컨테이너 안 k6처럼 작업 폴더(/w) 기준 경로에 요약을 쓴다. 폴더는 만들지 않는다
    out = args[args.index('--summary-export') + 1]
    url = next(x for x in args if x.startswith('BASE_URL='))[len('BASE_URL='):]
    with io.open(out, 'w', encoding='utf-8') as f:
        json.dump({'metrics': {'http_req_duration': {'p(99)': json.loads(conf['p99'])[url]}}}, f)
sys.exit(conf['exit'].get(name, 97))
`;

/**
 * 바깥 명령(aws·ots·docker)을 부르는지 보는 실행. run(도구, 인자, { env, cwd, names, exits })는 names에 든 명령을 기록기로 바꿔 끼워 도구를 돌리고,
 * calls(이름)는 그 명령이 받은 인자 목록들(부른 차례대로)이다. 기록기는 exits[이름](기본 97, 실패)으로 끝나고, docker 기록기는 컨테이너 안 k6처럼
 * --summary-export 경로(작업 폴더 기준)에 FAKE_K6_P99의 p99 요약을 쓴다. 개발 PC의 진짜 aws·ots·docker는 불리지 않는다
 * (offlineEnv·NO_DOCKER는 그래도 두는 두 번째 울타리다). 대조 시험(바꿔 끼우지 않으면 부르는 경우)으로 기록기가 부름을 잡는지 먼저 본다.
 */
function fakeTools(dir) {
  const wrapper = join(dir, 'fake-tools-wrap.py');
  const recorder = join(dir, 'fake-tools-record.py');
  const log = join(dir, 'fake-tools.log');
  writeFileSync(wrapper, FAKE_TOOLS_WRAPPER);
  writeFileSync(recorder, FAKE_TOOLS_RECORDER);
  return {
    run: (script, args, { env, cwd, names, exits = {} }) => py(wrapper, [script, ...args], {
      env: { ...env, FAKE_TOOLS: names.join(','), FAKE_TOOL_RECORDER: recorder, FAKE_TOOL_LOG: log,
        ...Object.fromEntries(Object.entries(exits).map(([k, v]) => [`FAKE_EXIT_${k}`, String(v)])) },
      cwd, ...CALL_LIMIT,
    }),
    calls: (name) => jsonLines(log).filter(([n]) => n === name).map(([, ...a]) => a),
  };
}

/** 준비 명령 흉내: 부를 때마다 prep.log에 한 줄을 남기고 두 주소를 JSON 한 줄로 낸다. FAKE_PREP_EXIT가 있으면 그 종료 코드로 실패한다 */
function countingPrep(dir) {
  const log = join(dir, 'prep.log');
  const p = join(dir, 'prep-count.mjs');
  writeFileSync(p, `
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, 'called\\n');
if (process.env.FAKE_PREP_EXIT) { console.error('prepare failed on purpose'); process.exit(Number(process.env.FAKE_PREP_EXIT)); }
process.stdout.write(JSON.stringify({ base_url: 'http://base', new_url: 'http://new' }) + '\\n');
`);
  return { cmd: [process.execPath, p], calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0) };
}

/**
 * aa 시험 준비. k6InConfig면 k6를 설정의 k6 키로만 주고(명령줄 --k6 없음), 아니면 명령줄 --k6로 준다.
 * 어느 쪽을 썼는지 보이게 명령 끝에 표시 인자(from-config·from-cli)를 하나 붙인다: 가짜 k6가 받는 첫 인자가 그것이다(prefix).
 * freshOutDir면 워크플로(perf-nightly.yml의 aa 잡, 새로 받은 저장소)처럼 아직 없는 상대 경로 .cache/aa를 --out-dir로 준다
 */
function aaSetup({ rounds = 1, k6InConfig = false, freshOutDir = false } = {}) {
  const root = newRoot();
  const k6 = argsK6(root);
  const prep = countingPrep(root);
  const cfg = { scenario: SCENARIO, rounds, prepare: prep.cmd };
  if (k6InConfig) cfg.k6 = [process.execPath, k6, 'from-config'];
  const config = writeJson(root, 'config.json', cfg);
  const outDir = freshOutDir ? join(root, '.cache', 'aa') : join(root, 'aa-out');
  if (!freshOutDir) mkdirSync(outDir);
  const outDirArg = freshOutDir ? '.cache/aa' : outDir;
  const argsLog = join(root, 'k6-args.log');
  const env = { ...process.env, ...NO_DOCKER, FAKE_K6_ARGS: argsLog };
  const aa = (runs, more = {}, extra = []) => py(NIGHTLY, ['aa', '--config', config, '--runs', String(runs), '--out-dir', outDirArg, ...extra,
    ...(k6InConfig ? [] : ['--k6', process.execPath, k6, 'from-cli'])], { env: { ...env, ...more }, cwd: root, ...CALL_LIMIT });
  return { root, k6, config, outDir, env, aa, prepCalls: prep.calls, calls: (log = argsLog) => k6Calls(log), prefix: [k6InConfig ? 'from-config' : 'from-cli'] };
}

test('D-T40: 설정의 k6 명령(인자 목록)은 --k6 없이도 쓰이고, 그 뒤에 k6 인자(run --quiet --summary-trend-stats … --summary-export <경로> -e BASE_URL=<주소> <시나리오>)를 붙인다', () => {
  const root = newRoot();
  const k6 = argsK6(root);
  const prep = countingPrep(root);
  // 설정의 k6 명령에 인자가 더 있어도(예: 클러스터 안의 k6를 부르는 명령) 그대로 두고 그 뒤에 k6 인자를 붙인다
  const config = writeJson(root, 'config.json', { scenario: SCENARIO, rounds: 1, prepare: prep.cmd, k6: [process.execPath, k6, 'prefix-arg'] });
  const log = join(root, 'k6-args.log');
  const out = join(root, 'o.json');
  const env = { ...process.env, ...NO_DOCKER, FAKE_K6_ARGS: log, FAKE_K6_P99: JSON.stringify({ 'http://base': 100, 'http://new': 120 }) };
  const r = py(NIGHTLY, ['run', '--config', config, '--out', out], { env, cwd: root, ...CALL_LIMIT });
  assert.equal(r.code, 0, r.out);
  const calls = k6Calls(log);
  assertK6Calls(calls, 2, ['prefix-arg']);
  calls.forEach((a) => assert.ok(summaryOf(a).length > 0, JSON.stringify(a)));
  const res = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual([res.base_p99_ms, res.new_p99_ms, res.ratio], [100, 120, 1.2]);
  assert.equal(prep.calls(), 1);
});

test('D-T40: 명령줄 --k6가 설정의 k6 명령보다 앞서고, 두 명령을 섞지 않는다(run·aa)', () => {
  const root = newRoot();
  const good = argsK6(root);
  const marker = join(root, 'config-k6-called');
  const fromConfig = join(root, 'config-k6.mjs');
  writeFileSync(fromConfig, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(107);`);
  const prep = countingPrep(root);
  const config = writeJson(root, 'config.json', { scenario: 's.js', rounds: 1, prepare: prep.cmd, k6: [process.execPath, fromConfig, 'from-config'] });
  const outDir = join(root, 'aa-out');
  mkdirSync(outDir);
  const cli = ['--k6', process.execPath, good, 'from-cli'];
  const env = { ...process.env, ...NO_DOCKER, FAKE_K6_P99: JSON.stringify({ 'http://base': 100, 'http://new': 100 }) };
  for (const [what, args] of [['run', ['run', '--config', config, '--out', join(root, 'o.json'), ...cli]],
    ['aa', ['aa', '--config', config, '--runs', '1', '--out-dir', outDir, ...cli]]]) {
    const log = join(root, `k6-args-${what}.log`);
    const r = py(NIGHTLY, args, { env: { ...env, FAKE_K6_ARGS: log }, cwd: root, ...CALL_LIMIT });
    assert.equal(r.code, 0, `${what}: ${r.out}`);
    assert.equal(existsSync(marker), false, `${what}: 명령줄 --k6가 있는데 설정의 k6를 불렀다`);
    // 명령줄 명령의 인자 바로 뒤에 k6 인자가 온다(설정의 명령을 앞이나 뒤에 붙이지 않는다)
    assertK6Calls(k6Calls(log), 2, ['from-cli'], 's.js');
  }
  assert.equal(prep.calls(), 2);
});

test('D-T40: 설정에도 명령줄에도 k6 명령이 없으면 기본 명령(다이제스트 고정 k6 이미지를 docker로, 작업 폴더를 /w로 붙임)을 쓰고, 요약 경로는 작업 폴더 안의 상대 경로다(run·aa)', () => {
  const root = newRoot();
  const tools = fakeTools(root);
  const prep = countingPrep(root);
  const config = writeJson(root, 'config.json', { scenario: SCENARIO, rounds: 1, prepare: prep.cmd });
  const outDir = join(root, 'aa-out');
  mkdirSync(outDir);
  const opts = { env: { ...process.env, ...NO_DOCKER, FAKE_K6_P99: JSON.stringify({ 'http://base': 100, 'http://new': 125 }) }, cwd: root, names: ['docker'], exits: { docker: 0 } };
  const run = tools.run(NIGHTLY, ['run', '--config', config, '--out', join(root, 'o.json')], opts);
  assert.equal(run.code, 0, run.out);
  const aa = tools.run(NIGHTLY, ['aa', '--config', config, '--runs', '1', '--out-dir', outDir], opts);
  assert.equal(aa.code, 0, aa.out);
  // k6를 돌린 docker 부름만 본다(그 밖의 docker 부름, 예: 판 확인은 막지 않는다)
  const calls = tools.calls('docker').filter((a) => a.includes('--summary-export'));
  assert.equal(calls.length, 4, JSON.stringify(tools.calls('docker')));
  calls.forEach((a, i) => {
    const what = `${i < 2 ? 'run' : 'aa'}: ${JSON.stringify(a)}`;
    assert.deepEqual(a.slice(-K6_TAIL), k6Tail(summaryOf(a), i % 2 ? 'http://new' : 'http://base', SCENARIO), what);
    const docker = a.slice(0, -K6_TAIL);
    assert.equal(docker[0], 'run', what);
    assert.ok(docker.includes('--rm'), what);
    // 이미지는 태그와 다이제스트로 고정하고(docs/devops.md §4.4) 그 바로 뒤에 k6 인자가 온다
    assert.match(docker.at(-1), /^grafana\/k6:[\w.-]+@sha256:[0-9a-f]{64}$/, what);
    const mount = docker[docker.indexOf('-v') + 1] ?? '';
    assert.ok(mount.endsWith(':/w') && samePath(mount.slice(0, -':/w'.length), root), `작업 폴더를 /w로 붙이지 않았다: ${what}`);
    assert.equal(docker[docker.indexOf('-w') + 1], '/w', what);
    // 공식 이미지(사용자 12345)가 러너의 폴더에 요약을 쓸 수 있게 같은 사용자로 돌린다(사용자 번호가 있는 OS만)
    if (typeof process.getuid === 'function') assert.equal(docker[docker.indexOf('--user') + 1], `${process.getuid()}:${process.getgid()}`, what);
    // 컨테이너 안 k6는 /w(= 작업 폴더)만 본다: 요약은 그 안의 상대 경로라야 쓸 수 있다
    const summary = summaryOf(a);
    assert.ok(!isAbsolute(summary) && !summary.split(/[\\/]/).includes('..'), `요약 경로가 작업 폴더 밖이다: ${what}`);
  });
  // 결과는 docker(컨테이너 안 k6)가 쓴 요약으로 계산한다
  assert.equal(JSON.parse(readFileSync(join(root, 'o.json'), 'utf8')).ratio, 1.25);
  assert.equal(JSON.parse(readFileSync(join(outDir, aaName(1)), 'utf8')).ratio, 1.25);
  assert.equal(prep.calls(), 2);
});

test('[ASVS v5.0.0-1.2.5] D-T40: 설정의 k6 명령도 빈 글이 없는 인자 목록만 받고(셸 문자열·빈 목록·글 아닌 값은 준비 명령을 부르기 전에 종료 2, 명령줄 --k6가 있어도), 설정 키는 scenario·rounds·prepare·k6뿐이다', () => {
  const root = newRoot();
  const k6 = argsK6(root);
  const prep = countingPrep(root);
  const log = join(root, 'k6-args.log');
  const env = { ...process.env, ...NO_DOCKER, FAKE_K6_ARGS: log, FAKE_K6_P99: JSON.stringify({ 'http://base': 100, 'http://new': 100 }) };
  const base = { scenario: 's.js', rounds: 1, prepare: prep.cmd };
  const outDir = join(root, 'aa-out');
  mkdirSync(outDir);
  const bad = [
    { k6: 'k6 run; rm -rf /' }, // 셸 문자열
    { k6: 'k6' }, // 낱말 하나라도 문자열이면 셸 문자열이다
    { k6: [] },
    { k6: [''] },
    { k6: [process.execPath, ''] },
    { k6: [process.execPath, 1] },
    { k6: [process.execPath, null] },
    { k6: [[process.execPath, k6]] },
    { k6: { cmd: process.execPath } },
    { k6: true },
    { k6: null }, // 목록이 아니다(기본 명령을 쓰려면 키를 두지 않는다)
    { k6: [process.execPath, k6], shell: true },
    { k6: [process.execPath, k6], k6_args: ['--vus', '1'] },
  ];
  bad.forEach((extra, i) => {
    const config = writeJson(root, `bad${i}.json`, { ...base, ...extra });
    // 셸 문자열과 null은 명령줄 --k6가 있어 설정의 k6를 쓰지 않을 때도 거부한다(쓸지와 상관없는 설정 파일 검사다)
    const clis = [[], ...(i === 0 || extra.k6 === null ? [['--k6', process.execPath, k6]] : [])];
    for (const cmd of [['run', '--config', config, '--out', join(root, 'o.json')], ['aa', '--config', config, '--runs', '1', '--out-dir', outDir]]) {
      for (const cli of clis) {
        const r = py(NIGHTLY, [...cmd, ...cli], { env, cwd: root, ...CALL_LIMIT });
        const what = `${i} ${cmd[0]}${cli.length ? ' --k6' : ''} ${JSON.stringify(extra)}`;
        assert.equal(r.code, 2, `${what}: ${r.out}`);
        assert.match(r.out, /::error::/, `${what}: ${r.out}`);
      }
    }
  });
  assert.equal(prep.calls(), 0, '설정이 틀렸는데 준비 명령을 불렀다');
  assert.equal(k6Calls(log).length, 0, '설정이 틀렸는데 k6를 불렀다');
  // 바른 k6 목록은 받는다(위 거부가 k6 키 자체를 모르는 탓이 아님을 본다)
  const ok = py(NIGHTLY, ['run', '--config', writeJson(root, 'ok.json', { ...base, k6: [process.execPath, k6] }), '--out', join(root, 'o.json')], { env, cwd: root, ...CALL_LIMIT });
  assert.equal(ok.code, 0, ok.out);
  assert.equal(prep.calls(), 1);
});

test('D-T40 ①: aa는 준비 명령을 한 번만 부르고 A/A 측정 N번(판마다 기준·새를 번갈아)을 aa-01.json…(run --out과 같은 모양)로 남기며, 10번이면 threshold.json(aa-threshold와 같은 규칙)까지 쓴다(--out-dir가 없으면 만든다)', () => {
  // 워크플로처럼 아직 없는 .cache/aa(작업 폴더 기준 상대 경로)를 준다
  const s = aaSetup({ rounds: 1, freshOutDir: true });
  // 부름 차례마다 p99: A/A마다 [기준, 새]. 비율은 1, 1.03, 0.98, 1.05, 0.96, 1.01, 0.93, 0.99, 1.04, 1이고 가장 큰 벗어남은 0.93의 0.07이다(1보다 작은 쪽)
  const seq = [100, 100, 200, 206, 100, 98, 200, 210, 100, 96, 200, 202, 100, 93, 200, 198, 100, 104, 200, 200];
  const ratios = [1, 1.03, 0.98, 1.05, 0.96, 1.01, 0.93, 0.99, 1.04, 1];
  const day0 = todayUtc();
  const r = s.aa(10, { FAKE_K6_SEQ: JSON.stringify(seq) });
  const day1 = todayUtc();
  assert.equal(r.code, 0, r.out);
  assert.equal(s.prepCalls(), 1, '준비 명령은 한 번만 부른다');
  assertK6Calls(s.calls(), 20, s.prefix);
  // 같은 설정으로 run --out을 한 번 내어 모양(맨 위 키·runs 항목 키)을 견준다
  const runOut = join(s.root, 'run.json');
  const rr = py(NIGHTLY, ['run', '--config', s.config, '--out', runOut, '--k6', process.execPath, s.k6],
    { env: { ...s.env, FAKE_K6_ARGS: join(s.root, 'k6-run.log'), FAKE_K6_P99: JSON.stringify({ 'http://base': 100, 'http://new': 100 }) }, cwd: s.root, ...CALL_LIMIT });
  assert.equal(rr.code, 0, rr.out);
  const runShape = shapeOf(JSON.parse(readFileSync(runOut, 'utf8')));
  const names = Array.from({ length: 10 }, (_, i) => aaName(i + 1));
  assert.deepEqual(aaFiles(s.outDir), names);
  names.forEach((name, i) => {
    const x = JSON.parse(readFileSync(join(s.outDir, name), 'utf8'));
    assert.deepEqual(Object.keys(x).sort(), RESULT_KEYS, name);
    assert.deepEqual(shapeOf(x), runShape, `${name}: run --out과 모양이 다르다`);
    assert.deepEqual([x.scenario, x.rounds], [SCENARIO, 1], name);
    assert.deepEqual(x.runs.map((y) => [y.round, y.side, y.p99_ms]), [[1, 'base', seq[2 * i]], [1, 'new', seq[2 * i + 1]]], name);
    assert.deepEqual([x.base_p99_ms, x.new_p99_ms], [seq[2 * i], seq[2 * i + 1]], name);
    assert.ok(Math.abs(x.ratio - ratios[i]) < 1e-9, `${name}: ${x.ratio}`);
    assert.match(x.started_at, ISO_UTC, name);
    assert.match(x.ended_at, ISO_UTC, name);
  });
  const th = join(s.outDir, 'threshold.json');
  const t = JSON.parse(readFileSync(th, 'utf8'));
  assert.deepEqual(Object.keys(t).sort(), ['aa_ratios', 'basis', 'decided_at', 'max_ratio']);
  assert.ok(Math.abs(t.max_ratio - 1.07) < 1e-9, String(t.max_ratio));
  assert.equal(t.aa_ratios.length, 10);
  t.aa_ratios.forEach((v, i) => assert.ok(Math.abs(v - ratios[i]) < 1e-9, `aa_ratios[${i}] = ${v}`));
  assert.ok([day0, day1].includes(t.decided_at), `decided_at ${t.decided_at}이 오늘(UTC)이 아니다`);
  assert.ok(mentions(t.basis, 10), t.basis);
  // aa-threshold에 같은 결과 파일 10개를 주면 같은 기준값이 나온다(같은 규칙, 소수 여섯째 자리 반올림까지)
  const th2 = join(s.root, 'threshold-2.json');
  const again = py(NIGHTLY, ['aa-threshold', '--results', ...names.map((n) => join(s.outDir, n)), '--out', th2], CALL_LIMIT);
  assert.equal(again.code, 0, again.out);
  const t2 = JSON.parse(readFileSync(th2, 'utf8'));
  assert.deepEqual([t.max_ratio, t.aa_ratios], [t2.max_ratio, t2.aa_ratios]);
  // compare가 이 기준값 파일을 그대로 받는다(비율 1.05 ≤ 1.07이라 통과)
  const c = py(NIGHTLY, ['compare', '--results', join(s.outDir, aaName(4)), '--threshold', th], CALL_LIMIT);
  assert.equal(c.code, 0, c.out);
});

test('D-T40 ①: aa가 10번보다 많으면(11번) 모든 A/A의 비율을 실행 순서대로 모아 기준값을 정한다(앞 10번만 보지 않는다)', () => {
  const s = aaSetup({ rounds: 1 });
  // 11번째 A/A가 가장 크게 벗어난다(1.08). 앞 10번만 보면 1.03이 된다
  const ratios = [1, 1.01, 0.99, 1.02, 0.98, 1.03, 0.97, 1, 1.01, 0.99, 1.08];
  const seq = ratios.flatMap((x) => [200, Math.round(200 * x)]);
  const r = s.aa(11, { FAKE_K6_SEQ: JSON.stringify(seq) });
  assert.equal(r.code, 0, r.out);
  assert.equal(s.prepCalls(), 1);
  assertK6Calls(s.calls(), 22, s.prefix);
  assert.deepEqual(aaFiles(s.outDir), Array.from({ length: 11 }, (_, i) => aaName(i + 1)));
  const t = JSON.parse(readFileSync(join(s.outDir, 'threshold.json'), 'utf8'));
  assert.ok(Math.abs(t.max_ratio - 1.08) < 1e-9, String(t.max_ratio));
  assert.equal(t.aa_ratios.length, 11);
  t.aa_ratios.forEach((v, i) => assert.ok(Math.abs(v - ratios[i]) < 1e-9, `aa_ratios[${i}] = ${v}`));
  assert.ok(mentions(t.basis, 11), t.basis);
});

test('D-T40 ①: aa가 10번보다 적으면(9번) threshold.json을 쓰지 않고 10번이 있어야 정한다고 알린 뒤 0으로 끝나며, 설정의 k6 명령과 판마다 회차 수(rounds)를 따른다', () => {
  const s = aaSetup({ rounds: 2, k6InConfig: true });
  // A/A마다 기준·새·기준·새. i번째(0부터) A/A의 기준 중앙값은 100(i+1), 새 중앙값은 그 ratios[i]배다(A/A마다 제 회차만으로 계산해야 맞는다)
  const ratios = [1, 1.1, 0.95, 1.2, 0.9, 1.05, 1, 0.8, 1.25];
  const plan = ratios.map((ratio, i) => {
    const b = 100 * (i + 1);
    const n = Math.round(b * ratio);
    return { b, n, seq: [b - 10, n - 4, b + 10, n + 4] };
  });
  const r = s.aa(9, { FAKE_K6_SEQ: JSON.stringify(plan.flatMap((p) => p.seq)) });
  assert.equal(r.code, 0, r.out);
  assert.equal(existsSync(join(s.outDir, 'threshold.json')), false, '10번보다 적은데 threshold.json을 썼다');
  assert.ok(r.out.split(/\r?\n/).some((l) => /기준값|threshold/.test(l) && mentions(l, 10)), `기준값은 A/A 10번이 있어야 정한다는 알림이 없다: ${r.out}`);
  assert.equal(s.prepCalls(), 1);
  assertK6Calls(s.calls(), 36, s.prefix);
  assert.deepEqual(aaFiles(s.outDir), Array.from({ length: 9 }, (_, i) => aaName(i + 1)));
  plan.forEach(({ b, n, seq }, i) => {
    const name = aaName(i + 1);
    const x = JSON.parse(readFileSync(join(s.outDir, name), 'utf8'));
    assert.deepEqual(Object.keys(x).sort(), RESULT_KEYS, name);
    assert.equal(x.rounds, 2, name);
    assert.deepEqual(x.runs.map((y) => [y.round, y.side, y.p99_ms]), [[1, 'base', seq[0]], [1, 'new', seq[1]], [2, 'base', seq[2]], [2, 'new', seq[3]]], name);
    assert.deepEqual([x.base_p99_ms, x.new_p99_ms], [b, n], name);
    assert.ok(Math.abs(x.ratio - n / b) < 1e-9, `${name}: ${x.ratio}`);
  });
});

test('D-T40 ①: aa의 --runs는 1~50이고, 범위 밖이면 준비 명령을 부르기 전에 종료 2로 거부한다', () => {
  const s = aaSetup({ rounds: 1 });
  const p99 = { FAKE_K6_P99: JSON.stringify({ 'http://base': 100, 'http://new': 100 }) };
  for (const n of ['0', '51', '-1', 'x', '2.5']) {
    const r = s.aa(n, p99);
    assert.equal(r.code, 2, `--runs ${n}: ${r.out}`);
    assert.equal(s.prepCalls(), 0, `--runs ${n}: 준비 명령을 불렀다`);
    assert.equal(s.calls().length, 0, `--runs ${n}: k6를 불렀다`);
  }
  // 경계 50은 받는다: 준비 명령을 부르고 첫 k6까지 가는지만 보고(첫 k6를 일부러 실패시켜) 50번을 다 돌리지는 않는다
  const r50 = s.aa('50', { ...p99, FAKE_K6_FAIL_AT: '0' });
  assert.equal(r50.code, 2, r50.out);
  assert.equal(s.prepCalls(), 1, '--runs 50을 받지 않았다');
  assert.equal(s.calls().length, 1, '--runs 50으로 측정을 시작하지 않았다');
  const r1 = s.aa('1', p99);
  assert.equal(r1.code, 0, r1.out);
  assert.equal(s.prepCalls(), 2);
  assert.equal(s.calls().length, 3);
  assert.equal(JSON.parse(readFileSync(join(s.outDir, aaName(1)), 'utf8')).ratio, 1);
  assert.equal(existsSync(join(s.outDir, 'threshold.json')), false);
});

test('D-T40 ①: aa는 준비 명령·k6가 실패하거나 전체 기한(--deadline-s, aa 전체에 하나)을 넘기면 그 자리에서 종료 2로 끝나고 threshold.json을 쓰지 않는다', () => {
  const p99 = { FAKE_K6_P99: JSON.stringify({ 'http://base': 100, 'http://new': 100 }) };
  {
    const s = aaSetup();
    const r = s.aa(10, { ...p99, FAKE_PREP_EXIT: '1' });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /준비 명령/);
    assert.equal(s.prepCalls(), 1);
    assert.equal(s.calls().length, 0, '준비 명령이 실패했는데 k6를 불렀다');
    assert.deepEqual(aaFiles(s.outDir), [], '준비 명령이 실패했는데 A/A 결과를 썼다');
    assert.equal(existsSync(join(s.outDir, 'threshold.json')), false);
  }
  {
    // 6번째 부름(3번째 A/A의 새 판)부터 k6가 종료 107로 끝난다: 거기서 멈추고, 끝내지 못한 3번째 A/A의 결과 파일은 쓰지 않는다
    const s = aaSetup();
    const r = s.aa(10, { ...p99, FAKE_K6_FAIL_AT: '5' });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /k6/);
    assert.equal(s.calls().length, 6, `k6 ${s.calls().length}번(실패한 뒤에도 불렀다)`);
    assert.equal(existsSync(join(s.outDir, aaName(3))), false, '끝내지 못한 A/A의 결과를 썼다');
    assert.equal(existsSync(join(s.outDir, 'threshold.json')), false);
  }
  {
    // k6 한 번은 0.6초라 A/A 하나(기준·새 1.2초)는 기한 2초 안이지만 10번 전체(12초 넘음)는 넘는다: 기한은 A/A마다가 아니라 aa 전체에 하나다
    const s = aaSetup();
    const t = Date.now();
    const r = s.aa(10, { ...p99, FAKE_K6_SLEEP_MS: '600' }, ['--deadline-s', '2']);
    const ms = Date.now() - t;
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /기한/);
    assert.ok(ms < 10000, `${ms}ms`);
    assert.ok(s.calls().length < 20, `k6 ${s.calls().length}번(기한을 넘겼는데 다 돌렸다)`);
    assert.equal(s.prepCalls(), 1);
    assert.equal(existsSync(join(s.outDir, 'threshold.json')), false);
  }
});

test('D-T40: aa의 A/A 회차들은 서로 다른 요약 파일을 쓰고, 요약을 쓰지 못한 회차는 앞 회차나 지난 실행의 요약을 읽지 않고 종료 2로 끝난다', () => {
  const p99 = { FAKE_K6_P99: JSON.stringify({ 'http://base': 100, 'http://new': 100 }) };
  const s = aaSetup({ rounds: 2 });
  const ok = s.aa(2, p99);
  assert.equal(ok.code, 0, ok.out);
  const paths = s.calls().map(summaryOf);
  assert.equal(paths.length, 8);
  assert.equal(new Set(paths.map((p) => resolve(s.root, p))).size, 8, `요약 경로가 겹친다: ${paths.join(', ')}`);
  // 지난 aa 실행의 요약이 남은 같은 작업 폴더에서, 이번 첫 기준판이 요약을 쓰지 못한다
  const log2 = join(s.root, 'k6-args-2.log');
  const stale = s.aa(1, { ...p99, FAKE_K6_ARGS: log2, FAKE_K6_SKIP_AT: '[0]' });
  assert.equal(stale.code, 2, stale.out);
  assert.match(stale.out, /요약/);
  // 같은 실행 안: 2번째 A/A의 기준판(3번째 부름)이 요약을 쓰지 못하면 1번째 A/A의 요약을 읽지 않는다
  const s2 = aaSetup({ rounds: 1 });
  const mid = s2.aa(2, { ...p99, FAKE_K6_SKIP_AT: '[2]' });
  assert.equal(mid.code, 2, mid.out);
  assert.match(mid.out, /요약/);
});

/** 바깥으로 나가지 않는 환경: 개발 PC의 AWS 자격 증명을 못 찾게 하고 주소도 닫힌 로컬 포트로 돌린다(aws를 잘못 부르면 곧바로 실패). docker도 같다 */
function offlineEnv(dir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^AWS_/i.test(k)));
  return { ...env, ...NO_DOCKER, AWS_SHARED_CREDENTIALS_FILE: join(dir, 'no-aws-credentials'), AWS_CONFIG_FILE: join(dir, 'no-aws-config'),
    AWS_EC2_METADATA_DISABLED: 'true', AWS_ENDPOINT_URL: 'http://127.0.0.1:9', AWS_MAX_ATTEMPTS: '1' };
}

const collectArgs = (root, runId) => ['--root', root, '--run-id', runId, '--kpi', 'K1', '--version', 'v0', '--profile', 'local-10k', '--commit', 'abc123'];
const runDirOf = (root, runId) => join(root, 'docs', 'perf-ledger', 'runs', runId);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sumsOf = (root, runId) => Object.fromEntries(readFileSync(join(runDirOf(root, runId), 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean)
  .map((l) => [l.slice(l.indexOf('  ') + 2), l.slice(0, l.indexOf('  '))]));
const filesUnder = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? filesUnder(join(dir, d.name)).map((f) => `${d.name}/${f}`) : [d.name])) : []);
/** S3 원본 버킷에 두는 큰 원본(docs/perf-ledger.md §2.1): stdout.log는 collect.py가 쓰고 나머지는 rawSources가 --extra로 넣는다 */
const RAWS = ['grafana/k1.png', 'metrics/origin_rps.csv', 'stdout.log', 'traces/slow-1.json'];

function rawSources(root) {
  const src = join(root, 'src');
  const files = {
    'metrics/origin_rps.csv': 'ts,value,labels\n1762128000,1000,{}\n1762128001,1002,{}\n',
    'traces/slow-1.json': '{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736"}',
    'grafana/k1.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80]),
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(src, rel)), { recursive: true });
    writeFileSync(join(src, rel), body);
  }
  writeFileSync(join(src, 'infra.txt'), 'cpu 4, memory 16GiB\n');
  return { files, infra: join(src, 'infra.txt'), extra: ['metrics', 'traces', 'grafana'].flatMap((d) => ['--extra', join(src, d)]) };
}

test('BSL090 낮음-056: --raw-outbox는 큰 원본을 aws로 올리지 않고(aws를 부르지 않는다) 보낼 폴더의 runs/<run-id>/<경로>.gz로 gzip해 두며, 다 쓴 뒤 측정 폴더의 원본을 지운다(--raw-bucket 없이는 종료 2)', () => {
  const root = newRoot();
  const env = offlineEnv(root);
  const tools = fakeTools(root);
  const viaFakes = (args) => tools.run(COLLECT, args, { env, names: ['aws'] });
  const outbox = join(root, 'outbox');
  mkdirSync(outbox);
  const { files, infra, extra } = rawSources(root);
  // 대조: 보낼 폴더 없이 원본 버킷만 주면 지금처럼 aws로 올린다. 가짜 aws(실패로 끝난다)가 그 부름을 잡는지 먼저 본다
  const ridAws = '2026-11-03-k1-v0-local-10k-aws';
  viaFakes([...collectArgs(root, ridAws), '--raw-bucket', 's3://selftest-raw', ...extra]);
  const control = tools.calls('aws');
  assert.ok(control.some((a) => a.some((x) => x.startsWith(`s3://selftest-raw/runs/${ridAws}/`))), `가짜 aws가 올리기를 잡지 못했다: ${JSON.stringify(control)}`);
  // 보낼 폴더는 원본 버킷 대신이라 --raw-bucket(raw_uri)과 함께일 때만 받는다
  const lone = viaFakes([...collectArgs(root, 'lone'), '--raw-outbox', outbox, ...extra]);
  assert.equal(lone.code, 2, lone.out);
  assert.equal(runExists(root, 'lone'), false);
  assert.deepEqual(filesUnder(outbox), []);
  const rid = '2026-11-03-k1-v0-local-10k-outbox';
  const r = viaFakes([...collectArgs(root, rid), '--raw-bucket', 's3://selftest-raw', '--raw-outbox', outbox, '--infra-file', infra, ...extra]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(tools.calls('aws'), control, '--raw-outbox인데 aws를 불렀다');
  assert.equal(manifestOf(root, rid).raw_uri, `s3://selftest-raw/runs/${rid}/`);
  const sums = sumsOf(root, rid);
  for (const rel of RAWS) assert.match(sums[rel] ?? '', /^[0-9a-f]{64}$/, `SHA256SUMS에 ${rel}이 없다`);
  // 버킷 안 객체 이름(runs/<run-id>/<경로>.gz)과 같은 자리에 이 실행의 큰 원본만 둔다. 작은 파일(manifest·infra·SHA256SUMS)은 보내지 않는다
  assert.deepEqual(filesUnder(outbox).sort(), RAWS.map((x) => `runs/${rid}/${x}.gz`));
  const box = join(outbox, 'runs', rid);
  const runDir = runDirOf(root, rid);
  for (const rel of RAWS) {
    const body = gunzipSync(readFileSync(join(box, `${rel}.gz`)));
    assert.equal(sha256(body), sums[rel], `${rel}: 풀어 낸 내용의 해시가 SHA256SUMS와 다르다`);
    if (files[rel] !== undefined) assert.deepEqual(body, Buffer.from(files[rel]), rel);
    assert.equal(existsSync(join(runDir, rel)), false, `${rel}: 원본이 측정 폴더에 남았다`);
  }
  for (const rel of ['manifest.json', 'SHA256SUMS', 'infra.txt']) assert.ok(existsSync(join(runDir, rel)), `${rel}: 작은 파일은 측정 폴더(Git)에 남는다`);
});

test('BSL090_낮음-056_불변식위반행invariants-detail.ndjson도_큰원본이라_해시만SHA256SUMS에남기고_보낼폴더의runs/<run-id>/로gzip해옮긴다', () => {
  // docs/perf-ledger.md §2.1: 큰 원본(metrics/*.csv·traces/·grafana/·stdout.log)과 불변식 위반 행 invariants-detail.ndjson은 S3 원본 버킷의
  // runs/<run-id>/에 두고 Git에는 해시만 남는다(합성 데이터라도 ID 목록이라서). 결과 건수 invariants.csv는 Git에 남는다.
  // Before 측정의 K7 ②(결제사 장애·앱 강제 종료)는 위반 행이 나오는 실행이다(docs/verification.md §3.10)
  const root = newRoot();
  const env = offlineEnv(root);
  const tools = fakeTools(root);
  const { extra } = rawSources(root);
  const detail = join(root, 'src', 'invariants-detail.ndjson');
  const detailBody = '{"invariant":"P6","order_id":"7c0e4a52-3f1b-4c8d-9a6e-2b5d8f1e0c93","pg_tx":"sim_tx_0001"}\n';
  writeFileSync(detail, detailBody);
  const csv = join(root, 'src', 'invariants.csv');
  writeFileSync(csv, 'invariant,violations\nP6,1\n');
  const outbox = join(root, 'outbox');
  mkdirSync(outbox);
  const rid = '2026-11-03-k7-v0-local-10k-fault';
  const r = tools.run(COLLECT, [...collectArgs(root, rid), '--raw-bucket', 's3://selftest-raw', '--raw-outbox', outbox, '--invariants', csv, '--extra', detail, ...extra],
    { env, names: ['aws'] });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(tools.calls('aws'), [], '--raw-outbox인데 aws를 불렀다');
  const runDir = runDirOf(root, rid);
  const sums = sumsOf(root, rid);
  assert.match(sums['invariants-detail.ndjson'] ?? '', /^[0-9a-f]{64}$/, 'SHA256SUMS에 위반 행 파일의 해시가 없다');
  assert.ok(existsSync(join(runDir, 'invariants.csv')), '결과 건수 invariants.csv는 측정 폴더(Git)에 남는다');
  assert.equal(existsSync(join(runDir, 'invariants-detail.ndjson')), false, '위반 행 파일이 측정 폴더(Git)에 남았다');
  const gz = join(outbox, 'runs', rid, 'invariants-detail.ndjson.gz');
  assert.ok(existsSync(gz), `보낼 폴더에 위반 행 파일이 없다: ${JSON.stringify(filesUnder(outbox))}`);
  const body = gunzipSync(readFileSync(gz));
  assert.equal(sha256(body), sums['invariants-detail.ndjson'], '풀어 낸 내용의 해시가 SHA256SUMS와 다르다');
  assert.equal(body.toString('utf8'), detailBody);
});

test('BSL090 낮음-056: 보낼 폴더에 다 쓰지 못하면 원본을 하나도 지우지 않고, --upload-raw <RUN_ID> --raw-outbox가 남은 원본을 같은 자리에 gzip으로 다시 둔다(aws는 부르지 않는다)', () => {
  const root = newRoot();
  const env = offlineEnv(root);
  const tools = fakeTools(root);
  const viaFakes = (args) => tools.run(COLLECT, args, { env, names: ['aws'] });
  const { extra } = rawSources(root);
  const rid = '2026-11-03-k1-v0-local-10k-retry';
  // 보낼 폴더의 runs/<run-id>/metrics 자리에 파일이 있어 metrics/….gz는 쓰지 못한다(stdout.log.gz·grafana/….gz는 쓸 수 있다)
  const blocked = join(root, 'outbox-blocked');
  mkdirSync(join(blocked, 'runs', rid), { recursive: true });
  writeFileSync(join(blocked, 'runs', rid, 'metrics'), 'not a folder');
  const r = viaFakes([...collectArgs(root, rid), '--raw-bucket', 's3://selftest-raw', '--raw-outbox', blocked, ...extra]);
  assert.notEqual(r.code, 0, r.out);
  const runDir = runDirOf(root, rid);
  assert.ok(existsSync(join(runDir, 'manifest.json')), `측정 폴더가 없다: ${r.out}`);
  for (const rel of RAWS) assert.ok(existsSync(join(runDir, rel)), `${rel}: 다 쓰지 못했는데 원본을 지웠다`);
  const outbox = join(root, 'outbox');
  mkdirSync(outbox);
  const again = viaFakes(['--root', root, '--upload-raw', rid, '--raw-outbox', outbox]);
  assert.equal(again.code, 0, again.out);
  assert.deepEqual(tools.calls('aws'), [], '--raw-outbox인데 aws를 불렀다');
  const sums = sumsOf(root, rid);
  assert.deepEqual(filesUnder(outbox).sort(), RAWS.map((x) => `runs/${rid}/${x}.gz`));
  for (const rel of RAWS) {
    const gz = join(outbox, 'runs', rid, `${rel}.gz`);
    assert.equal(sha256(gunzipSync(readFileSync(gz))), sums[rel], `${rel}: 풀어 낸 내용의 해시가 SHA256SUMS와 다르다`);
    assert.equal(existsSync(join(runDir, rel)), false, `${rel}: 다시 둔 뒤에도 원본이 남았다`);
  }
  assert.equal(manifestOf(root, rid).raw_uri, `s3://selftest-raw/runs/${rid}/`);
});

test('BSL090 낮음-056: index.py --stamp --no-ots는 timestamps/<날짜>.txt를 --stamp와 똑같이 쓰되(이미 고정한 날이 바뀌면 거부하는 것도 같다) ots를 부르지 않고, OpenTimestamps 고정은 소유자 몫이라고 알린다(--stamp 없이는 종료 2)', () => {
  const root = newRoot();
  const env = offlineEnv(root);
  const tools = fakeTools(root);
  const index = (args, exits) => tools.run(INDEX, ['--root', root, ...args], { env, names: ['ots'], exits });
  const on = (day) => ['--start', `${day}T00:00:00Z`, '--end', `${day}T00:10:00Z`];
  for (const id of ['2026-10-30-k1-b', '2026-10-30-k1-a']) {
    const c = py(COLLECT, [...collectArgs(root, id), ...on('2026-10-30')], { env, ...CALL_LIMIT });
    assert.equal(c.code, 0, c.out);
  }
  const other = py(COLLECT, [...collectArgs(root, '2026-10-31-k1-a'), ...on('2026-10-31')], { env, ...CALL_LIMIT });
  assert.equal(other.code, 0, other.out);
  for (const args of [['--no-ots'], ['--upgrade', '--no-ots']]) {
    const lone = index(args);
    assert.equal(lone.code, 2, `${args.join(' ')}: ${lone.out}`);
  }
  const r = index(['--stamp', '2026-10-30', '--no-ots']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /소유자/);
  assert.match(r.out, /OpenTimestamps|ots stamp/);
  assert.deepEqual(tools.calls('ots'), [], '--no-ots인데 ots를 불렀다');
  // --stamp와 같은 내용: 그날 끝난 실행마다 SHA256SUMS의 해시와 경로(실행 ID 순서), 다른 날 실행은 넣지 않는다
  const expected = ['2026-10-30-k1-a', '2026-10-30-k1-b']
    .map((id) => `${sha256(readFileSync(join(runDirOf(root, id), 'SHA256SUMS')))}  runs/${id}/SHA256SUMS\n`).join('');
  const dayFile = join(root, 'docs', 'perf-ledger', 'timestamps', '2026-10-30.txt');
  assert.equal(readFileSync(dayFile, 'utf8'), expected);
  assert.equal(existsSync(`${dayFile}.ots`), false, '--no-ots인데 OpenTimestamps 증명이 생겼다');
  // 대조: --no-ots 없는 --stamp는 지금처럼 `ots stamp <그날 묶음 파일>`을 부른다. 가짜 ots가 그 부름을 잡는지 본다
  const pinned = index(['--stamp', '2026-10-31'], { ots: 0 });
  assert.equal(pinned.code, 0, pinned.out);
  const calls = tools.calls('ots');
  const stamps = calls.filter((a) => a[0] === 'stamp');
  assert.equal(stamps.length, 1, JSON.stringify(calls));
  assert.ok(samePath(stamps[0].at(-1), join(root, 'docs', 'perf-ledger', 'timestamps', '2026-10-31.txt')), JSON.stringify(calls));
  // 소유자가 이미 고정한 날(.ots가 있음)에 실행이 늘면 --no-ots도 --stamp처럼 거부하고 묶음 파일을 고치지 않는다(증명이 깨진다)
  writeFileSync(`${dayFile}.ots`, 'pinned by the owner');
  const late = py(COLLECT, [...collectArgs(root, '2026-10-30-k1-c'), ...on('2026-10-30')], { env, ...CALL_LIMIT });
  assert.equal(late.code, 0, late.out);
  const changed = index(['--stamp', '2026-10-30', '--no-ots']);
  assert.notEqual(changed.code, 0, changed.out);
  assert.equal(readFileSync(dayFile, 'utf8'), expected, '이미 고정한 날의 묶음을 고쳐 썼다');
  assert.equal(tools.calls('ots').length, calls.length, '--no-ots인데 ots를 불렀다');
});

test('BSL090_D-T40: run --out의 폴더가 없으면 만들어 쓴다(측정을 다 하고 결과를 쓰다 잃지 않게, 2026-11-03 30ms 지연 판 실행에서 재현)', () => {
  const root = newRoot();
  const k6 = argsK6(root);
  const prep = countingPrep(root);
  const config = writeJson(root, 'config.json', { scenario: SCENARIO, rounds: 1, prepare: prep.cmd, k6: [process.execPath, k6] });
  const out = join(root, 'not', 'yet', 'results.json');
  const env = { ...process.env, ...NO_DOCKER, FAKE_K6_ARGS: join(root, 'k6-args.log'), FAKE_K6_P99: JSON.stringify({ 'http://base': 100, 'http://new': 130 }) };
  const r = py(NIGHTLY, ['run', '--config', config, '--out', out], { env, cwd: root, ...CALL_LIMIT });
  assert.equal(r.code, 0, r.out);
  const res = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual([res.base_p99_ms, res.new_p99_ms, res.ratio], [100, 130, 1.3]);
});

test('BSL090_ADR-0077: 창 안의 파드 재시작으로 히스토그램을 셀 수 없을 때만 종료 코드 3이고(실행 도구가 그 점검만 빼고 다시 남긴다), 다른 거부는 3이 아니다', async () => {
  for (const [id, extra, want3] of [['x-lost', { lost: 2 }, true], ['x-reset', { resets: 1 }, true], ['x-empty', { start: { '0.2': 10, '+Inf': 10 }, end: { '0.2': 10, '+Inf': 10 } }, false]]) {
    const prom = await fakeProm({ startTs: T0, start: { '0.2': 10, '+Inf': 10 }, end: { '0.2': 3000, '+Inf': 3000 }, ...extra });
    try {
      const root = newRoot();
      const checks = writeJson(root, 'h.json', { checks: [{ name: 'p', allowed: 0.01, histogram: { metric: M, match: 'route="/x"', le: 0.2 } }] });
      const r = await pyAsync(COLLECT, histArgs(root, id, checks, ['--prom-url', prom.url]));
      if (want3) assert.equal(r.code, 3, `${id}: ${r.out}`);
      else assert.ok(r.code !== 0 && r.code !== 3, `${id}: 재시작이 아닌 거부는 3이 아니다(종료 코드 ${r.code}): ${r.out}`);
      assert.equal(runExists(root, id), false, id);
    } finally {
      await prom.close();
    }
  }
});
