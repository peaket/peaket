// 성능 장부 도구의 바깥 경계(명령줄) 시험(BUILD_ORDER BSL-080, wbs 1.4.1, docs/perf-ledger.md §2.2·§7, docs/devops.md §3.3).
// 파이썬 도구를 명령줄로 부르고, 임시 저장소 루트에 생긴 manifest와 장부 표를 본다. Prometheus는 이 시험이 띄운 흉내 서버다.
// 실행: node --test "tools/perf-ledger/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
