// F-08-5(MSR-050) 장시간 시험·누수 주입 측정 준비 도구 시험.
//
// 정본: docs/verification.md §3.6(장시간 시험)·§3.5(측정 정직성)·V-T10(636행),
//       docs/architecture.md §7 NFR-027, docs/perf-ledger.md §2.3·§7.
// 계획: docs/review/plans/F-08-5.md §6·§8.
// 이 시험은 Docker·kind·k6를 쓰지 않는다. 새 모듈은 시험마다 동적 import로 불러
// 구현 전 트리에서 시험마다 따로 실패하게 한다.
// 실행(저장소 뿌리): node --test loadtest/test/f085-soak.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const P = (...parts) => join(ROOT, ...parts);

/** 새 측정 도구(구현 몫). 구현 전 트리에는 없다 */
const soak = () => import('../runner/soak.mjs');
/** 새 표본 도구(구현 몫). 구현 전 트리에는 없다 */
const probe = () => import('../runner/soak-probe.mjs');

/** 실제 장부에 있는 실행 ID. 실행 ID 때문에 실패하는 것과 다른 까닭을 가르려고 쓴다 */
const REAL_RUN = '2026-11-01-incr-batch-tls-r1-local-poc';

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

/** NFR-027 정본 문턱(정본 글에서 옮긴 값. 코드 상수를 가져오지 않는다) */
const SOAK_MINUTES = 360;
const WARMUP_MINUTES = 30;
const SLOPE_LIMIT = 0.01;
const P99_CHANGE_LIMIT = 0.1;
const ERROR_RATE_LIMIT = 0.001;
/** 표본 1분·예열 뒤 330개(5시간 30분) */
const MIN_SAMPLES = 330;
/** 표본 사이 허용 간격(분) */
const MAX_GAP_MIN = 2;

/** 자원 시계열 하나. `perHour`는 시작값 대비가 아니라 값 자체의 시간당 증가다 */
function series({
  minutes = SOAK_MINUTES,
  step = 1,
  start = 100,
  perHour = 0.5,
  overrides = {},
  omit = undefined,
} = {}) {
  const rows = [];
  for (let min = 0; min <= minutes; min += step) {
    const value = start + perHour * (min / 60);
    const row = {
      min,
      heapAfterGcMb: value,
      rssMb: value,
      openFds: value,
      activeHandles: value,
      dbConns: value,
      redisConns: value,
      ...overrides,
    };
    if (omit) delete row[omit];
    rows.push(row);
  }
  return rows;
}

/** judgeNFR027 입력 하나. 바꿀 칸만 덮어 쓴다 */
function nfrRun(over = {}) {
  return {
    target: 'queue-svc',
    durationMin: SOAK_MINUTES,
    warmupMin: WARMUP_MINUTES,
    samples: series(),
    restarts: 0,
    dropped: 0,
    generator: { cpuPct: 50, memoryPct: 50 },
    host: { cpuPct: 50, procsRunning: 8, logicalCpus: 32 },
    dependencyRestarts: 0,
    p99: { startMs: 150, endMs: 160 },
    errorRate: 0.0005,
    errorRateLimit: ERROR_RATE_LIMIT,
    ...over,
  };
}

/** 지표 하나만 시간당 2%로 늘어난 실행(다른 지표는 0.5%/시간) */
function oneMetricLeaking(metric, over = {}) {
  const samples = series();
  for (const row of samples) row[metric] = 100 + 2 * (row.min / 60);
  return nfrRun({ samples, ...over });
}

/** V-T10 입력 한쪽. nfr027 판정 결과를 담는다 */
function vtRun(variant, nfr027, over = {}) {
  return {
    target: 'purchase-svc',
    variant,
    rate: 1000,
    durationMin: SOAK_MINUTES,
    warmupMin: WARMUP_MINUTES,
    baseCommit: '619c95b74',
    nfr027,
    ...over,
  };
}

/** 보고서 입력의 대상 한 줄 */
function reportRun(target, over = {}) {
  return {
    target,
    rate: 500,
    durationMin: SOAK_MINUTES,
    verdict: '미측정',
    label: '미측정',
    runId: null,
    ...over,
  };
}

test('MSR-050 ① 대상 다섯·기본값·인자 검사를 지킨다', async () => {
  const m = await soak();

  assert.deepEqual(
    m.SOAK_TARGETS.map((t) => t.id),
    ['queue-svc', 'purchase-svc', 'payment-svc', 'realtime-gw', 'outbox-relay'],
    'NFR-027의 대상 다섯이 순서대로 있어야 한다',
  );
  assert.deepEqual(
    [...m.NFR027_METRICS],
    ['heapAfterGcMb', 'rssMb', 'openFds', 'activeHandles', 'dbConns', 'redisConns'],
    '자원 지표 여섯이 정본과 같아야 한다',
  );
  assert.equal(m.SOAK_DEFAULTS.durationMin, SOAK_MINUTES);
  assert.equal(m.SOAK_DEFAULTS.warmupMin, WARMUP_MINUTES);
  assert.equal(m.SOAK_DEFAULTS.sampleSec, 60);

  const ok = m.parseSoakArgs(['--target', 'queue-svc', '--rate', '500', '--out', '.cache/x']);
  assert.equal(ok.target, 'queue-svc');
  assert.equal(ok.rate, 500);
  assert.equal(ok.durationMin, SOAK_MINUTES);
  assert.equal(ok.warmupMin, WARMUP_MINUTES);
  assert.equal(ok.sampleSec, 60);
  assert.equal(ok.rehearsal, false);
  assert.equal(ok.judged, true);

  // 6시간 미만은 연습일 때만 받는다. 359분은 판정 대상이 아니다.
  expectUsage(() => m.parseSoakArgs(['--target', 'queue-svc', '--rate', '500', '--out', 'x', '--duration-min', '359']), /duration/);
  const rehearsal = m.parseSoakArgs([
    '--target', 'queue-svc', '--rate', '500', '--out', 'x', '--duration-min', '359', '--rehearsal',
  ]);
  assert.equal(rehearsal.rehearsal, true);
  assert.equal(rehearsal.judged, false);

  // 360분 경계는 판정 대상이다.
  const exact = m.parseSoakArgs(['--target', 'queue-svc', '--rate', '500', '--out', 'x', '--duration-min', '360']);
  assert.equal(exact.judged, true);

  expectUsage(() => m.parseSoakArgs(['--target', 'unknown', '--rate', '500', '--out', 'x']), /target/);
  expectUsage(() => m.parseSoakArgs(['--rate', '500', '--out', 'x']), /target/);
  expectUsage(() => m.parseSoakArgs(['--target', 'queue-svc', '--rate', '0', '--out', 'x']), /rate/);
  expectUsage(() => m.parseSoakArgs(['--target', 'queue-svc', '--rate', '500']), /out/);
  expectUsage(() => m.parseSoakArgs(['--target', 'queue-svc', '--rate', '500', '--out', 'x', '--warmup-min', '29']), /warmup/);
  expectUsage(() => m.parseSoakArgs(['--target', 'queue-svc', '--rate', '500', '--out', 'x', '--docker-all']), /docker-all/);

  // 누수 주입은 purchase-svc만 받는다.
  const leak = m.parseSoakArgs([
    '--target', 'purchase-svc', '--rate', '1000', '--out', 'x', '--leak', 'db-conn',
  ]);
  assert.equal(leak.leak, 'db-conn');
  expectUsage(
    () => m.parseSoakArgs(['--target', 'queue-svc', '--rate', '500', '--out', 'x', '--leak', 'db-conn']),
    /leak|purchase/,
  );
  expectUsage(
    () => m.parseSoakArgs(['--target', 'purchase-svc', '--rate', '1000', '--out', 'x', '--leak', 'memory']),
    /leak/,
  );

  // 장부 기록은 실행 ID가 있어야 한다.
  expectUsage(() => m.parseSoakArgs(['--target', 'queue-svc', '--rate', '500', '--out', 'x', '--record']), /run-id/);
  const rec = m.parseSoakArgs([
    '--target', 'queue-svc', '--rate', '500', '--out', 'x', '--record', '--run-id', '2026-11-27-f085-queue-r1',
  ]);
  assert.equal(rec.record, true);
  assert.equal(rec.runId, '2026-11-27-f085-queue-r1');
});

test('MSR-050 ② 시간당 기울기는 균등·불균등 간격과 경계에서 맞는다', async () => {
  const m = await soak();

  const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
  assert.ok(near(m.slopePerHour([{ min: 0, value: 100 }, { min: 60, value: 101 }]), 1));
  assert.ok(near(m.slopePerHour([{ min: 0, value: 100 }, { min: 30, value: 100.5 }, { min: 60, value: 101 }]), 1));
  assert.ok(near(m.slopePerHour([{ min: 0, value: 100 }, { min: 60, value: 99 }]), -1));
  assert.equal(m.slopePerHour([{ min: 0, value: 100 }]), null, '표본 1개는 기울기를 낼 수 없다');
  assert.equal(m.slopePerHour([{ min: 0, value: 100 }, { min: 0, value: 101 }]), null, '같은 시각 표본은 기울기를 낼 수 없다');
  assert.equal(m.slopePerHour([{ min: 0, value: 100 }, { min: 60, value: null }]), null, '빠진 값은 0으로 바꾸지 않는다');

  // 경계: 시작값 100의 1.00%는 1.0/시간, 1.01%는 1.01/시간이다.
  const pass = m.judgeNFR027(nfrRun({ samples: series({ perHour: 1.0 }) }));
  assert.equal(pass.verdict, '통과');
  assert.equal(pass.metrics.heapAfterGcMb.verdict, '통과');
  const fail = m.judgeNFR027(nfrRun({ samples: series({ perHour: 1.01 }) }));
  assert.equal(fail.verdict, '미달');
  assert.equal(fail.metrics.heapAfterGcMb.verdict, '미달');
  const below = m.judgeNFR027(nfrRun({ samples: series({ perHour: 0.99 }) }));
  assert.equal(below.verdict, '통과');

  // 줄어드는 것은 누수가 아니다.
  const down = m.judgeNFR027(nfrRun({ samples: series({ perHour: -0.5 }) }));
  assert.equal(down.verdict, '통과');

  // 시작값 0: 평평하면 통과, 양수 기울기면 미달.
  const flatZero = m.judgeNFR027(nfrRun({ samples: series({ start: 0, perHour: 0 }) }));
  assert.equal(flatZero.verdict, '통과');
  const upZero = m.judgeNFR027(nfrRun({ samples: series({ start: 0, perHour: 0.1 }) }));
  assert.equal(upZero.verdict, '미달');
});

test('MSR-050 ③ NFR-027 예열·재시작·p99·오류율·유효 조건을 가른다', async () => {
  const m = await soak();

  // 예열: 29분 표본은 빠지고 30분 표본은 들어간다. 시작값으로 확인한다.
  const warm = series({ perHour: 0 }).map((r) => (r.min === 29 ? { ...r, heapAfterGcMb: 9999 } : r));
  const before30 = m.judgeNFR027(nfrRun({ samples: warm }));
  assert.equal(before30.metrics.heapAfterGcMb.start, 100, '29분 표본은 예열로 빠져야 한다');
  const at30 = series({ perHour: 0 }).map((r) => (r.min === 30 ? { ...r, heapAfterGcMb: 777 } : r));
  const from30 = m.judgeNFR027(nfrRun({ samples: at30 }));
  assert.equal(from30.metrics.heapAfterGcMb.start, 777, '30분 표본은 들어가야 한다');

  // 재시작 1회는 미달, 0회는 통과.
  const restart = m.judgeNFR027(nfrRun({ restarts: 1 }));
  assert.equal(restart.verdict, '미달');
  assert.ok(restart.reasons.some((r) => r.includes('재시작')), '재시작 까닭을 남긴다');
  assert.equal(m.judgeNFR027(nfrRun({ restarts: 0 })).verdict, '통과');

  // p99 변화 10.0%는 통과, 10.1%는 미달, 감소는 통과, 시작 0은 판정 못 함.
  assert.equal(m.judgeNFR027(nfrRun({ p99: { startMs: 100, endMs: 110 } })).verdict, '통과');
  assert.equal(m.judgeNFR027(nfrRun({ p99: { startMs: 100, endMs: 110.1 } })).verdict, '미달');
  assert.equal(m.judgeNFR027(nfrRun({ p99: { startMs: 100, endMs: 90 } })).verdict, '통과');
  assert.equal(m.judgeNFR027(nfrRun({ p99: { startMs: 0, endMs: 10 } })).verdict, '판정 못 함');
  assert.equal(m.judgeNFR027(nfrRun({ p99: { startMs: 0, endMs: 0 } })).verdict, '통과');

  // 오류율 0.1%는 통과, 0.1001%는 미달.
  assert.equal(m.judgeNFR027(nfrRun({ errorRate: 0.001 })).verdict, '통과');
  assert.equal(m.judgeNFR027(nfrRun({ errorRate: 0.001001 })).verdict, '미달');

  // 길이 경계: 359분은 무효, 360분은 유효 후보다. 연습은 판정하지 않는다.
  assert.equal(m.judgeNFR027(nfrRun({ durationMin: 359, samples: series({ minutes: 359 }) })).verdict, '무효');
  assert.equal(m.judgeNFR027(nfrRun({ durationMin: 360 })).verdict, '통과');
  const rehearsal = m.judgeNFR027(nfrRun({ durationMin: 120, samples: series({ minutes: 120 }), rehearsal: true }));
  assert.equal(rehearsal.verdict, '미측정');
  assert.equal(rehearsal.judged, false);

  // 유효 조건: 발생기·호스트 포화·의존 저장소 재시작·표본 빠짐·놓친 반복.
  assert.equal(m.judgeNFR027(nfrRun({ dropped: 1 })).verdict, '무효');
  assert.equal(m.judgeNFR027(nfrRun({ generator: { cpuPct: 81, memoryPct: 50 } })).verdict, '무효');
  assert.equal(m.judgeNFR027(nfrRun({ generator: { cpuPct: 50, memoryPct: 91 } })).verdict, '무효');
  assert.equal(m.judgeNFR027(nfrRun({ host: { cpuPct: 85, procsRunning: 8, logicalCpus: 32 } })).verdict, '무효');
  assert.equal(m.judgeNFR027(nfrRun({ host: { cpuPct: 50, procsRunning: 33, logicalCpus: 32 } })).verdict, '무효');
  assert.equal(m.judgeNFR027(nfrRun({ dependencyRestarts: 1 })).verdict, '무효');
  const gapped = series().filter((r) => r.min !== 100);
  assert.equal(m.judgeNFR027(nfrRun({ samples: gapped })).verdict, '통과', '1분 빠짐은 허용 간격 안이다');
  const tooGapped = series().filter((r) => r.min < 100 || r.min > 103);
  assert.equal(m.judgeNFR027(nfrRun({ samples: tooGapped })).verdict, '무효');
  assert.equal(m.judgeNFR027(nfrRun({ samples: series({ minutes: 300 }) })).verdict, '무효');

  // 지표가 없으면 통과가 아니다.
  assert.equal(m.judgeNFR027(nfrRun({ samples: series({ omit: 'redisConns' }) })).verdict, '판정 못 함');
  const nulled = series().map((r) => ({ ...r, dbConns: null }));
  assert.equal(m.judgeNFR027(nfrRun({ samples: nulled })).verdict, '판정 못 함');
});

test('MSR-050 ④ 자원 지표 여섯을 하나씩 넘겨도 그 지표만 미달로 잡는다', async () => {
  const m = await soak();

  for (const metric of m.NFR027_METRICS) {
    const result = m.judgeNFR027(oneMetricLeaking(metric));
    assert.equal(result.verdict, '미달', `${metric} 누수를 통과로 세면 안 된다`);
    assert.equal(result.metrics[metric].verdict, '미달', `${metric} 지표가 미달이어야 한다`);
    for (const other of m.NFR027_METRICS) {
      if (other === metric) continue;
      assert.equal(result.metrics[other].verdict, '통과', `${other}는 이 실행에서 통과여야 한다`);
    }
  }

  // 여섯 중 하나가 빠지면 판정 못 함이고, 다른 지표가 좋아도 통과가 아니다.
  for (const metric of m.NFR027_METRICS) {
    const result = m.judgeNFR027(nfrRun({ samples: series({ omit: metric }) }));
    assert.equal(result.verdict, '판정 못 함', `${metric}가 없으면 통과가 아니다`);
    assert.equal(result.metrics[metric], null, `${metric}의 자리는 null이어야 한다`);
  }

  // DB 연결 수와 FD가 넘어도 힙이 빠지면 통과가 아니다.
  const samples = series();
  for (const row of samples) {
    row.dbConns = 100 + 2 * (row.min / 60);
    row.openFds = 100 + 2 * (row.min / 60);
    delete row.heapAfterGcMb;
  }
  const partial = m.judgeNFR027(nfrRun({ samples }));
  assert.equal(partial.verdict, '판정 못 함');
});

test('MSR-050 ⑤ 누수 주입 판과 고친 판을 같은 조건에서만 대조한다', async () => {
  const m = await soak();

  const fixedPass = m.judgeNFR027(nfrRun({ target: 'purchase-svc' }));
  assert.equal(fixedPass.verdict, '통과');

  const leakingSamples = series();
  for (const row of leakingSamples) {
    row.dbConns = 100 + 2 * (row.min / 60);
    row.openFds = 100 + 2 * (row.min / 60);
  }
  const leakFail = m.judgeNFR027(nfrRun({ target: 'purchase-svc', samples: leakingSamples }));
  assert.equal(leakFail.verdict, '미달');
  assert.equal(leakFail.metrics.dbConns.verdict, '미달');
  assert.equal(leakFail.metrics.openFds.verdict, '미달');

  const pass = m.judgeVT10({ leak: vtRun('leak', leakFail), fixed: vtRun('fixed', fixedPass) });
  assert.equal(pass.verdict, '통과');
  assert.equal(pass.detected.dbConns, true);
  assert.equal(pass.detected.openFds, true);

  // 주입이 효과가 없어 누수 판이 통과하면 판정 못 함이다.
  const noEffect = m.judgeVT10({ leak: vtRun('leak', fixedPass), fixed: vtRun('fixed', fixedPass) });
  assert.equal(noEffect.verdict, '판정 못 함');

  // DB 연결 수만 넘고 FD가 안 넘으면 V-T10이 요구하는 두 지표를 다 보여 주지 못한 것이다.
  const onlyDb = series();
  for (const row of onlyDb) row.dbConns = 100 + 2 * (row.min / 60);
  const onlyDbFail = m.judgeNFR027(nfrRun({ target: 'purchase-svc', samples: onlyDb }));
  assert.equal(onlyDbFail.metrics.dbConns.verdict, '미달');
  assert.equal(onlyDbFail.metrics.openFds.verdict, '통과');
  assert.equal(m.judgeVT10({ leak: vtRun('leak', onlyDbFail), fixed: vtRun('fixed', fixedPass) }).verdict, '판정 못 함');

  // 고친 판이 미달이면 미달이다.
  const fixedFail = m.judgeNFR027(nfrRun({ target: 'purchase-svc', restarts: 1 }));
  assert.equal(fixedFail.verdict, '미달');
  assert.equal(m.judgeVT10({ leak: vtRun('leak', leakFail), fixed: vtRun('fixed', fixedFail) }).verdict, '미달');

  // 조건이 다르면 대조하지 않는다.
  for (const changed of [{ rate: 900 }, { durationMin: 300 }, { baseCommit: 'deadbee' }]) {
    const result = m.judgeVT10({
      leak: vtRun('leak', leakFail, changed),
      fixed: vtRun('fixed', fixedPass),
    });
    assert.equal(result.verdict, '판정 못 함', `조건 차이(${JSON.stringify(changed)})를 통과로 세면 안 된다`);
  }

  // 대상이 purchase-svc가 아니면 V-T10이 아니다.
  assert.equal(
    m.judgeVT10({
      leak: vtRun('leak', leakFail, { target: 'queue-svc' }),
      fixed: vtRun('fixed', fixedPass),
    }).verdict,
    '판정 못 함',
  );

  // 누수 판이 6시간을 못 채운 실행(무효)은 통과가 아니다.
  assert.equal(
    m.judgeVT10({
      leak: vtRun('leak', { verdict: '무효', metrics: {}, reasons: ['6시간 미달'] }),
      fixed: vtRun('fixed', fixedPass),
    }).verdict,
    '판정 못 함',
  );

  // 한쪽이 없으면 미측정이다.
  assert.equal(m.judgeVT10({ leak: null, fixed: vtRun('fixed', fixedPass) }).verdict, '미측정');
});

test('MSR-050 ⑥ 보고서는 표시 없는 숫자·가짜 실행 ID·금지 주장·성급한 통과를 거부한다', async () => {
  const m = await soak();
  const mdPath = 'docs/review/measurements/F-08-5-soak.md';
  const doc = read(mdPath, '장시간 시험 보고서 뼈대');
  assert.match(doc, /미측정/, '측정 전 뼈대는 미측정이어야 한다');

  const runs = m.SOAK_TARGETS.map((t) => reportRun(t.id));
  const base = {
    title: 'F-08-5 장시간 시험 보고서',
    stage: { window: '4a~4c', lock: 'docker lane4-F-08-5', cluster: 'lane4-f085' },
    runs,
    nfr027: '미측정',
    vt10: {
      verdict: '미측정',
      leak: { target: 'purchase-svc', rate: 1000, durationMin: 360, verdict: '미측정', label: '미측정', runId: null },
      fixed: { target: 'purchase-svc', rate: 1000, durationMin: 360, verdict: '미측정', label: '미측정', runId: null },
    },
  };
  const md = m.renderSoakReport(base);
  const parsed = m.validateSoakReport(md, { runExists: () => false });
  assert.equal(parsed.targets, 5);
  assert.equal(parsed.pass, 0);
  assert.equal(parsed.vt10, '미측정');

  // 표시 없는 숫자 줄은 거부한다.
  const unlabeled = `${md}\n| queue-svc | 500 | 360 | 통과 |\n`;
  assert.throws(() => m.validateSoakReport(unlabeled, { runExists: () => false }), /표시|실행 ID/);

  // 30,000건/초·100만·K1/K2/K7 주장은 거부하고, '주장하지 않는다'는 허용한다.
  for (const claim of ['30,000건/초를 통과했다', '100만 명을 처리했다', 'K1 통과', 'K2 통과', 'K7 통과']) {
    assert.throws(
      () => m.validateSoakReport(`${md}\n- ${claim}\n`, { runExists: () => false }),
      /금지|주장/,
      `${claim}을 금지하지 않았다`,
    );
  }
  const allowed = `${md}\n- 30,000건/초·100만·K1/K2/K7은 주장하지 않는다(문서 인용만).\n`;
  m.validateSoakReport(allowed, { runExists: () => false });

  // 대상 하나가 미측정인데 종합 통과면 거부한다.
  const premature = md.replace(/- NFR-027 종합: 미측정/, '- NFR-027 종합: 통과');
  assert.throws(() => m.validateSoakReport(premature, { runExists: () => false }), /통과|미측정|실행 ID/);

  // 모두 통과라도 실행 ID가 없거나 가짜면 거부한다.
  const allPassNoId = {
    ...base,
    runs: runs.map((r) => ({ ...r, verdict: '통과', label: '실측(PC)' })),
    nfr027: '통과',
  };
  assert.throws(() => m.validateSoakReport(m.renderSoakReport(allPassNoId), { runExists: () => false }), /실행 ID/);

  const allPass = {
    ...allPassNoId,
    runs: runs.map((r) => ({ ...r, runId: REAL_RUN })),
    vt10: {
      verdict: '통과',
      leak: { target: 'purchase-svc', rate: 1000, durationMin: 360, verdict: '통과', label: '실측(PC)', runId: REAL_RUN },
      fixed: { target: 'purchase-svc', rate: 1000, durationMin: 360, verdict: '통과', label: '실측(PC)', runId: REAL_RUN },
    },
  };
  const allPassMd = m.renderSoakReport(allPass);
  const allPassParsed = m.validateSoakReport(allPassMd, { runExists: (id) => id === REAL_RUN });
  assert.equal(allPassParsed.pass, 5);
  assert.equal(allPassParsed.vt10, '통과');
  assert.throws(
    () => m.validateSoakReport(allPassMd, { runExists: () => false }),
    /실행 ID/,
    '가짜 실행 ID를 통과로 세면 안 된다',
  );

  // V-T10 통과는 누수 판·고친 판 두 줄이 다 있어야 한다.
  const oneRow = {
    ...allPass,
    vt10: { ...allPass.vt10, fixed: { ...allPass.vt10.fixed, verdict: '미측정', label: '미측정', runId: null } },
  };
  assert.throws(
    () => m.validateSoakReport(m.renderSoakReport(oneRow), { runExists: (id) => id === REAL_RUN }),
    /V-T10|고친/,
  );
});

test('MSR-050 ⑦ 표본 도구는 GC를 먼저 부르고, 빠진 값은 0이 아니라 null로 남긴다', async () => {
  const p = await probe();

  const sample = p.parseInspectorSample({
    value: { heapUsed: 104857600, rss: 209715200, openFds: 42, activeHandles: 7 },
  });
  assert.equal(sample.heapAfterGcMb, 100);
  assert.equal(sample.rssMb, 200);
  assert.equal(sample.openFds, 42);
  assert.equal(sample.activeHandles, 7);

  const missing = p.parseInspectorSample({ value: { rss: 100 } });
  assert.equal(missing.heapAfterGcMb, null);
  assert.equal(missing.openFds, null);
  assert.ok(missing.reason.includes('heap'), '빠진 칸의 까닭을 남긴다');

  const bad = p.parseInspectorSample({ value: { heapUsed: 'NaN', rss: 100, openFds: -1, activeHandles: 1.5 } });
  assert.equal(bad.heapAfterGcMb, null, '숫자가 아닌 값은 null이다');
  assert.equal(bad.openFds, null, '음수는 null이다');
  assert.equal(bad.activeHandles, null, '정수가 아닌 값은 null이다');

  assert.equal(p.parsePgActivityCount('42\n'), 42);
  assert.equal(p.parsePgActivityCount(''), null);
  assert.equal(p.parsePgActivityCount('NaN\n'), null);
  assert.equal(p.parsePgActivityCount('-1\n'), null);

  assert.equal(p.parseRedisClients('connected_clients:12\n'), 12);
  assert.equal(p.parseRedisClients('connected_clients:12\nblocked_clients:0\n'), 12);
  assert.equal(p.parseRedisClients('# Clients\nused_memory:1\n'), null);
  assert.equal(p.parseRedisClients('connected_clients:NaN\n'), null);

  const calls = [];
  const cdp = {
    async send(method, params) {
      calls.push(method);
      if (method === 'HeapProfiler.collectGarbage') return {};
      if (method === 'Runtime.evaluate') return { result: { value: { heapUsed: 1048576, rss: 2097152, openFds: 3, activeHandles: 1 } } };
      throw new Error(`모르는 CDP: ${method} ${JSON.stringify(params)}`);
    },
  };
  const sampled = await p.sampleWithGc(cdp, () => 0);
  assert.deepEqual(calls, ['HeapProfiler.collectGarbage', 'Runtime.evaluate'], 'GC가 evaluate보다 먼저여야 한다');
  assert.equal(sampled.heapAfterGcMb, 1);

  // GC가 실패하면 0으로 채우지 않고 까닭을 남긴다.
  const failing = {
    async send(method) {
      calls.push(method);
      if (method === 'HeapProfiler.collectGarbage') throw new Error('GC 없음');
      return { result: { value: {} } };
    },
  };
  const failed = await p.sampleWithGc(failing, () => 0);
  assert.equal(failed.heapAfterGcMb, null);
  assert.ok(failed.reason.includes('GC') || failed.reason.includes('gc'), 'GC 실패 까닭을 남긴다');
});

test('MSR-050 ⑧ 시나리오·실행 계획·경계·누수 패치가 준비돼 있다', async () => {
  const planRaw = read('loadtest/plan/f085-plan.json', 'F-08-5 실행 계획');
  const plan = JSON.parse(planRaw);

  assert.equal(plan.batch, 'F-08-5');
  assert.equal(plan.window, 4);
  assert.deepEqual(plan.windows, ['4a', '4b', '4c']);
  assert.equal(plan.lock, 'docker lane4-F-08-5');
  assert.ok(!planRaw.includes('docker-all'), 'docker-all을 쓰면 안 된다');
  assert.equal(plan.defaults.durationMin, 360);
  assert.equal(plan.defaults.warmupMin, 30);
  assert.equal(plan.defaults.sampleSec, 60);
  assert.deepEqual(
    plan.targets.map((t) => t.id),
    ['queue-svc', 'purchase-svc', 'payment-svc', 'realtime-gw', 'outbox-relay'],
  );
  assert.equal(plan.leak.target, 'purchase-svc');
  assert.equal(plan.leak.variant, 'db-conn');
  assert.match(plan.report, /docs\/review\/measurements\/F-08-5-soak\.md/);

  const scenario = read('loadtest/scenarios/v1-soak.js', 'F-08-5 k6 시나리오');
  for (const id of ['queue-svc', 'purchase-svc', 'payment-svc', 'realtime-gw', 'outbox-relay']) {
    assert.ok(scenario.includes(id), `시나리오에 ${id}가 없다`);
  }
  assert.match(scenario, /phase:\s*['"]warm['"]/);
  assert.match(scenario, /phase:\s*['"]main['"]/);
  assert.match(scenario, /records\.ndjson/);
  assert.match(scenario, /markStart|markEnd/);

  const patch = read('loadtest/soak/db-conn-leak.patch', 'V-T10 누수 패치');
  assert.match(patch, /PEAKET_ENV/);
  assert.match(patch, /local/);
  assert.ok(!patch.includes('deploy/'), '누수 패치는 deploy/를 건드리지 않는다');

  const doc = read('docs/review/plans/F-08-5.md', 'F-08-5 계획');
  for (const word of ['NFR-027', 'V-T10', 'F-08-4', 'F-08-6', 'docker lane4-F-08-5', 'docker-all', '미측정']) {
    assert.ok(doc.includes(word), `계획에 ${word}가 없다`);
  }
  assert.match(doc, /6시간/);
  assert.match(doc, /예열 30분/);
  assert.match(doc, /시간당.*1%/s);
  assert.match(doc, /p99.*10%/s);
  assert.match(doc, /재시작 0/);
});
