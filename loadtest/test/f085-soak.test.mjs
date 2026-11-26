// F-08-5(MSR-050) 장시간 시험·누수 주입 측정 준비 도구 시험.
//
// 정본: docs/verification.md §3.6(장시간 시험)·§3.5(측정 정직성)·V-T10(636행),
//       docs/architecture.md §7 NFR-003·NFR-006·NFR-027, docs/perf-ledger.md §2.3·§7.
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
/** 보고서 시험에서 대상마다 다른 실행 ID를 쓴다(RV085-08) */
const RUN_BY_TARGET = Object.freeze({
  'queue-svc': REAL_RUN,
  'purchase-svc': '2026-11-27-f085-purchase-r1',
  'payment-svc': '2026-11-27-f085-payment-r1',
  'realtime-gw': '2026-11-27-f085-realtime-r1',
  'outbox-relay': '2026-11-27-f085-relay-r1',
});
const LEAK_RUN = '2026-11-27-f085-purchase-leak-r1';
const fixedRun = RUN_BY_TARGET['purchase-svc'];
/** 실행 ID가 그 대상의 장부 실행인지. 한 ID로 여러 대상을 통과시키지 못하게 대상까지 본다 */
const runExists = (id, target) => id === RUN_BY_TARGET[target] || (target === 'purchase-svc' && id === LEAK_RUN);

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
const P99_CHANGE_LIMIT = 0.1;
/** 표본 1분·예열 뒤 330개(5시간 30분) */
const MIN_SAMPLES = 330;
/** 표본 사이 허용 간격(분) */
const MAX_GAP_MIN = 2;
/** 장부 §7의 0.1% 최소 시행 수(0건) */
const MIN_TRIALS_01 = 2995;
/** 0.05%의 최소 시행 수(0건) */
const MIN_TRIALS_005 = 5991;

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

/** 예열(30분) 뒤 표본 n개. min은 30부터 1분 간격이다 */
function windowSamples(n, { start = 100, perHour = 0.5 } = {}) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const min = WARMUP_MINUTES + i;
    const value = start + perHour * ((min - WARMUP_MINUTES) / 60);
    rows.push({ min, heapAfterGcMb: value, rssMb: value, openFds: value, activeHandles: value, dbConns: value, redisConns: value });
  }
  return rows;
}

/** p99의 첫 30분·마지막 30분 창. overallMs는 일부러 넣어 전체 실행 p99를 쓰지 않는지 본다 */
function p99Windows(startMs, endMs, overallMs = 999) {
  return {
    startWindow: { fromMin: 30, toMin: 60, p99Ms: startMs },
    endWindow: { fromMin: 330, toMin: 360, p99Ms: endMs },
    overallMs,
  };
}

/** 오류 점검 입력. cpUpper는 정확 이항 단측 95% 상한(장부 §7) */
function errors({ trials = 10000, violations = 1, expectedRejections = 100, cpUpper = 0.0005 } = {}) {
  return { trials, violations, expectedRejections, cpUpper };
}

/** judgeNFR027 입력 하나. 바꿀 칸만 덮어 쓴다 */
function nfrRun(over = {}) {
  return {
    target: 'queue-svc',
    durationMin: SOAK_MINUTES,
    warmupMin: WARMUP_MINUTES,
    samples: windowSamples(331),
    restarts: 0,
    dropped: 0,
    generator: { cpuPct: 50, memoryPct: 50 },
    host: { cpuPct: 50, procsRunning: 8, logicalCpus: 32 },
    dependencyRestarts: 0,
    p99: p99Windows(150, 160),
    errors: errors(),
    rehearsal: false,
    ...over,
  };
}

/** 지표 하나만 시간당 2%로 늘어난 실행(다른 지표는 0.5%/시간) */
function oneMetricLeaking(metric, over = {}) {
  const samples = windowSamples(331);
  for (const row of samples) row[metric] = 100 + 2 * ((row.min - WARMUP_MINUTES) / 60);
  return nfrRun({ samples, ...over });
}

/** V-T10 입력 한쪽. nfr027 판정 결과와 명목 조건을 담는다 */
function vtRun(variant, nfr027, over = {}) {
  return {
    target: 'purchase-svc',
    variant,
    stage: variant === 'leak' ? '4c' : '4a',
    rate: 1000,
    durationMin: SOAK_MINUTES,
    warmupMin: WARMUP_MINUTES,
    baseCommit: '619c95b74',
    leakIntervalMin: 10,
    dbStart: 16,
    fdStart: 100,
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

test('MSR-050 ① 대상 다섯·대상별 오류 기준·기본값·인자 검사를 지킨다', async () => {
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

  const byId = Object.fromEntries(m.SOAK_TARGETS.map((t) => [t.id, t]));
  // 결제는 NFR-006 완료율 99.95% → 실패 허용 0.05%다. 0.1%를 쓰면 두 배 느슨하다.
  assert.equal(byId['payment-svc'].errorRateLimit, 0.0005);
  assert.equal(byId['payment-svc'].minTrials, MIN_TRIALS_005);
  assert.match(byId['payment-svc'].errorRateSource, /99\.95|0\.05/);
  // queue는 0.1%, purchase는 정본에 오류율 기준이 없어 가정이다.
  assert.equal(byId['queue-svc'].errorRateLimit, 0.001);
  assert.equal(byId['queue-svc'].minTrials, MIN_TRIALS_01);
  assert.equal(byId['purchase-svc'].errorRateLimit, 0.001);
  assert.match(byId['purchase-svc'].errorRateSource, /\[가정/);
  assert.match(byId['realtime-gw'].errorRateSource, /\[가정/);
  assert.match(byId['outbox-relay'].errorRateSource, /\[가정/);
  // realtime-gw는 연결만 50%다. 홀드 125/s는 설계의 100%라 63/s로 낮춘다.
  assert.equal(byId['realtime-gw'].connections, 2500);
  assert.equal(byId['realtime-gw'].holdRate, 63);
  assert.match(byId['realtime-gw'].rateSource, /50%/);
  assert.equal(byId['queue-svc'].rate, 500);
  assert.equal(byId['queue-svc'].entryUsers, 5000);
  assert.equal(byId['queue-svc'].entrySeconds, 10);
  assert.equal(byId['queue-svc'].admitPerSecond, 28);

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

  // 누수 주입은 purchase-svc의 6시간 실행만 받는다. 연습·359분·기록은 V-T10 입력이 아니다.
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
  expectUsage(
    () => m.parseSoakArgs(['--target', 'purchase-svc', '--rate', '1000', '--out', 'x', '--leak', 'db-conn', '--rehearsal']),
    /rehearsal|연습/,
  );
  expectUsage(
    () => m.parseSoakArgs(['--target', 'purchase-svc', '--rate', '1000', '--out', 'x', '--leak', 'db-conn', '--duration-min', '359']),
    /duration|360/,
  );

  // 장부 기록은 실행 ID가 있어야 하고, 연습은 장부에 넣지 않는다.
  expectUsage(() => m.parseSoakArgs(['--target', 'queue-svc', '--rate', '500', '--out', 'x', '--record']), /run-id/);
  expectUsage(
    () => m.parseSoakArgs(['--target', 'queue-svc', '--rate', '500', '--out', 'x', '--record', '--rehearsal', '--run-id', 'x']),
    /rehearsal|연습/,
  );
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
  // 0·0.1·1시간: 끝점 기울기 1/h가 아니라 최소제곱 0.604395604/h다.
  assert.ok(near(m.slopePerHour([{ min: 0, value: 100 }, { min: 6, value: 101 }, { min: 60, value: 101 }]), 0.604395604));
  assert.ok(!near(m.slopePerHour([{ min: 0, value: 100 }, { min: 6, value: 101 }, { min: 60, value: 101 }]), 1));
  assert.ok(near(m.slopePerHour([{ min: 0, value: 100 }, { min: 60, value: 99 }]), -1));
  assert.equal(m.slopePerHour([{ min: 0, value: 100 }]), null, '표본 1개는 기울기를 낼 수 없다');
  assert.equal(m.slopePerHour([{ min: 0, value: 100 }, { min: 0, value: 101 }]), null, '같은 시각 표본은 기울기를 낼 수 없다');
  assert.equal(m.slopePerHour([{ min: 0, value: 100 }, { min: 60, value: null }]), null, '빠진 값은 0으로 바꾸지 않는다');

  // 경계: 시작값 100의 1.00%는 1.0/시간, 1.01%는 1.01/시간이다.
  const pass = m.judgeNFR027(nfrRun({ samples: windowSamples(331, { perHour: 1.0 }) }));
  assert.equal(pass.verdict, '통과');
  assert.equal(pass.metrics.heapAfterGcMb.verdict, '통과');
  const fail = m.judgeNFR027(nfrRun({ samples: windowSamples(331, { perHour: 1.01 }) }));
  assert.equal(fail.verdict, '미달');
  assert.equal(fail.metrics.heapAfterGcMb.verdict, '미달');
  const below = m.judgeNFR027(nfrRun({ samples: windowSamples(331, { perHour: 0.99 }) }));
  assert.equal(below.verdict, '통과');

  // 줄어드는 것은 누수가 아니다.
  const down = m.judgeNFR027(nfrRun({ samples: windowSamples(331, { perHour: -0.5 }) }));
  assert.equal(down.verdict, '통과');

  // 시작값 0: 평평하면 통과, 양수 기울기면 미달.
  const flatZero = m.judgeNFR027(nfrRun({ samples: windowSamples(331, { start: 0, perHour: 0 }) }));
  assert.equal(flatZero.verdict, '통과');
  const upZero = m.judgeNFR027(nfrRun({ samples: windowSamples(331, { start: 0, perHour: 0.1 }) }));
  assert.equal(upZero.verdict, '미달');
});

test('MSR-050 ③ NFR-027 예열·재시작·p99 창·오류 상한·표본 경계·유효 조건을 가른다', async () => {
  const m = await soak();

  // 예열: 29.9분 표본은 빠지고 30분 표본은 들어간다. 시작값으로 확인한다.
  const warm = series({ perHour: 0 }).filter((r) => r.min !== 29);
  warm.push({ min: 29.9, heapAfterGcMb: 9999, rssMb: 100, openFds: 100, activeHandles: 100, dbConns: 100, redisConns: 100 });
  const before30 = m.judgeNFR027(nfrRun({ samples: warm }));
  assert.equal(before30.metrics.heapAfterGcMb.start, 100, '29.9분 표본은 예열로 빠져야 한다');
  const at30 = series({ perHour: 0 }).map((r) => (r.min === 30 ? { ...r, heapAfterGcMb: 777 } : r));
  const from30 = m.judgeNFR027(nfrRun({ samples: at30 }));
  assert.equal(from30.metrics.heapAfterGcMb.start, 777, '30분 표본은 들어가야 한다');

  // 재시작 1회는 미달, 0회는 통과.
  const restart = m.judgeNFR027(nfrRun({ restarts: 1 }));
  assert.equal(restart.verdict, '미달');
  assert.ok(restart.reasons.some((r) => r.includes('재시작')), '재시작 까닭을 남긴다');
  assert.equal(m.judgeNFR027(nfrRun({ restarts: 0 })).verdict, '통과');

  // p99는 첫 30분(T+30~T+60)과 마지막 30분(T+330~T+360) 창으로만 본다. 전체 p99는 무시한다.
  assert.equal(m.judgeNFR027(nfrRun({ p99: p99Windows(100, 110, 300) })).verdict, '통과', '전체 p99 300을 쓰면 실패해야 한다');
  assert.equal(m.judgeNFR027(nfrRun({ p99: p99Windows(100, 110.1) })).verdict, '미달');
  assert.equal(m.judgeNFR027(nfrRun({ p99: p99Windows(100, 90) })).verdict, '통과');
  assert.equal(m.judgeNFR027(nfrRun({ p99: p99Windows(0, 10) })).verdict, '판정 못 함');
  assert.equal(m.judgeNFR027(nfrRun({ p99: p99Windows(0, 0) })).verdict, '통과');
  assert.equal(m.judgeNFR027(nfrRun({ p99: p99Windows(100, 120, 100) })).verdict, '미달', '전체 p99 100을 쓰면 통과해야 한다');
  const wrongWindow = p99Windows(100, 110);
  wrongWindow.startWindow = { fromMin: 0, toMin: 60, p99Ms: 100 };
  assert.equal(m.judgeNFR027(nfrRun({ p99: wrongWindow })).verdict, '판정 못 함', '창 경계가 틀리면 판정하지 않는다');

  // 오류율은 점추정이 아니라 정확 이항 단측 95% 상한과 최소 시행 수로 본다.
  assert.equal(m.judgeNFR027(nfrRun({ errors: errors({ trials: MIN_TRIALS_01, violations: 0, cpUpper: 0.000998 }) })).verdict, '통과');
  assert.equal(m.judgeNFR027(nfrRun({ errors: errors({ trials: 2000, violations: 2, cpUpper: 0.0037 }) })).verdict, '미달', '2/2,000의 점추정 0.1%를 통과로 세면 안 된다');
  assert.equal(m.judgeNFR027(nfrRun({ errors: errors({ trials: 1000, violations: 0, cpUpper: 0 }) })).verdict, '미달', '최소 시행 수 미달은 통과가 아니다');
  assert.equal(m.judgeNFR027(nfrRun({ errors: errors({ trials: 10000, violations: 5, cpUpper: 0.001001 }) })).verdict, '미달');
  // 결제는 0.05%다. 0.05% 정각 통과, 0.0501% 미달.
  assert.equal(
    m.judgeNFR027(nfrRun({ target: 'payment-svc', errors: errors({ trials: 10000, violations: 4, cpUpper: 0.0005 }) })).verdict,
    '통과',
  );
  assert.equal(
    m.judgeNFR027(nfrRun({ target: 'payment-svc', errors: errors({ trials: 10000, violations: 4, cpUpper: 0.000501 }) })).verdict,
    '미달',
  );
  // 기대 409/422는 오류가 아니라 따로 센다.
  assert.equal(
    m.judgeNFR027(nfrRun({ errors: errors({ trials: 10000, violations: 1, cpUpper: 0.0005, expectedRejections: 1000 }) })).verdict,
    '통과',
  );

  // 길이 경계: 359분은 무효, 360분은 유효 후보다. 연습은 판정하지 않는다.
  assert.equal(m.judgeNFR027(nfrRun({ durationMin: 359, samples: windowSamples(329) })).verdict, '무효');
  assert.equal(m.judgeNFR027(nfrRun({ durationMin: 360 })).verdict, '통과');
  const rehearsal = m.judgeNFR027(nfrRun({ durationMin: 120, samples: windowSamples(90), rehearsal: true }));
  assert.equal(rehearsal.verdict, '미측정');
  assert.equal(rehearsal.judged, false);

  // 유효 조건: 발생기·호스트 포화·의존 저장소 재시작·표본 수·간격·놓친 반복.
  assert.equal(m.judgeNFR027(nfrRun({ dropped: 1 })).verdict, '무효');
  assert.equal(m.judgeNFR027(nfrRun({ generator: { cpuPct: 81, memoryPct: 50 } })).verdict, '무효');
  assert.equal(m.judgeNFR027(nfrRun({ generator: { cpuPct: 50, memoryPct: 91 } })).verdict, '무효');
  assert.equal(m.judgeNFR027(nfrRun({ host: { cpuPct: 85, procsRunning: 8, logicalCpus: 32 } })).verdict, '무효');
  assert.equal(m.judgeNFR027(nfrRun({ host: { cpuPct: 50, procsRunning: 33, logicalCpus: 32 } })).verdict, '무효');
  assert.equal(m.judgeNFR027(nfrRun({ dependencyRestarts: 1 })).verdict, '무효');

  // 표본 수 경계: 330개 통과, 329개 무효, 1개는 판정 못 함.
  assert.equal(m.judgeNFR027(nfrRun({ samples: windowSamples(MIN_SAMPLES) })).verdict, '통과');
  assert.equal(m.judgeNFR027(nfrRun({ samples: windowSamples(MIN_SAMPLES - 1) })).verdict, '무효');
  assert.equal(m.judgeNFR027(nfrRun({ samples: windowSamples(1) })).verdict, '판정 못 함');
  // 간격 경계: 2분 통과, 3분 무효. 3분 쪽은 표본 수를 330으로 맞춰 간격만 어기게 한다.
  const gap2 = windowSamples(331).filter((r) => r.min !== 100);
  assert.equal(m.judgeNFR027(nfrRun({ samples: gap2 })).verdict, '통과', '2분 간격은 허용한다');
  const filler = { min: 361, heapAfterGcMb: 100, rssMb: 100, openFds: 100, activeHandles: 100, dbConns: 100, redisConns: 100 };
  const gap3 = [...windowSamples(331).filter((r) => r.min !== 100 && r.min !== 101), filler];
  assert.equal(gap3.length, MIN_SAMPLES, '간격 시험의 표본 수는 330이어야 한다');
  assert.equal(m.judgeNFR027(nfrRun({ samples: gap3 })).verdict, '무효', '3분 간격은 무효다');
  assert.equal(m.judgeNFR027(nfrRun({ samples: windowSamples(331).filter((r) => r.min !== 100 && r.min !== 101) })).verdict, '무효');

  // 지표가 없으면 통과가 아니다.
  assert.equal(m.judgeNFR027(nfrRun({ samples: windowSamples(331).map((r) => ({ ...r, redisConns: undefined })) })).verdict, '판정 못 함');
  const nulled = windowSamples(331).map((r) => ({ ...r, dbConns: null }));
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
    const result = m.judgeNFR027(nfrRun({ samples: windowSamples(331).map((r) => { const x = { ...r }; delete x[metric]; return x; }) }));
    assert.equal(result.verdict, '판정 못 함', `${metric}가 없으면 통과가 아니다`);
    assert.equal(result.metrics[metric], null, `${metric}의 자리는 null이어야 한다`);
  }

  // DB 연결 수와 FD가 넘어도 힙이 빠지면 통과가 아니다.
  const samples = windowSamples(331);
  for (const row of samples) {
    row.dbConns = 100 + 2 * ((row.min - WARMUP_MINUTES) / 60);
    row.openFds = 100 + 2 * ((row.min - WARMUP_MINUTES) / 60);
    delete row.heapAfterGcMb;
  }
  const partial = m.judgeNFR027(nfrRun({ samples }));
  assert.equal(partial.verdict, '판정 못 함');
});

test('MSR-050 ⑤ 누수 주입 판과 고친 판을 같은 명목 조건에서만 대조한다', async () => {
  const m = await soak();

  const fixedPass = m.judgeNFR027(nfrRun({ target: 'purchase-svc' }));
  assert.equal(fixedPass.verdict, '통과');

  const leakingSamples = windowSamples(331);
  for (const row of leakingSamples) {
    row.dbConns = 100 + 6 * ((row.min - WARMUP_MINUTES) / 60);
    row.openFds = 100 + 6 * ((row.min - WARMUP_MINUTES) / 60);
  }
  const leakFail = m.judgeNFR027(nfrRun({ target: 'purchase-svc', samples: leakingSamples }));
  assert.equal(leakFail.verdict, '미달');
  assert.equal(leakFail.metrics.dbConns.verdict, '미달');
  assert.equal(leakFail.metrics.openFds.verdict, '미달');

  // 4a(고친 판)와 4c(누수 판)는 다른 무대 인스턴스다. 같은 명목 조건이면 허용한다.
  const pass = m.judgeVT10({ leak: vtRun('leak', leakFail), fixed: vtRun('fixed', fixedPass) });
  assert.equal(pass.verdict, '통과');
  assert.equal(pass.detected.dbConns, true);
  assert.equal(pass.detected.openFds, true);
  assert.equal(pass.leak.stage, '4c');
  assert.equal(pass.fixed.stage, '4a');

  // 주입이 효과가 없어 누수 판이 통과하면 판정 못 함이다.
  assert.equal(m.judgeVT10({ leak: vtRun('leak', fixedPass), fixed: vtRun('fixed', fixedPass) }).verdict, '판정 못 함');

  // DB 연결 수만 넘고 FD가 안 넘으면 V-T10이 요구하는 두 지표를 다 보여 주지 못한 것이다.
  const onlyDb = windowSamples(331);
  for (const row of onlyDb) row.dbConns = 100 + 6 * ((row.min - WARMUP_MINUTES) / 60);
  const onlyDbFail = m.judgeNFR027(nfrRun({ target: 'purchase-svc', samples: onlyDb }));
  assert.equal(onlyDbFail.metrics.dbConns.verdict, '미달');
  assert.equal(onlyDbFail.metrics.openFds.verdict, '통과');
  assert.equal(m.judgeVT10({ leak: vtRun('leak', onlyDbFail), fixed: vtRun('fixed', fixedPass) }).verdict, '판정 못 함');

  // FD 시작값이 600이면 6/h가 1% 정각이라 FD는 미달이 아니다. 이때 V-T10은 판정 못 함이다.
  const fd600 = windowSamples(331);
  for (const row of fd600) {
    row.openFds = 600 + 6 * ((row.min - WARMUP_MINUTES) / 60);
    row.dbConns = 100 + 6 * ((row.min - WARMUP_MINUTES) / 60);
  }
  const fd600Run = m.judgeNFR027(nfrRun({ target: 'purchase-svc', samples: fd600 }));
  assert.equal(fd600Run.metrics.openFds.verdict, '통과');
  assert.equal(fd600Run.metrics.dbConns.verdict, '미달');
  assert.equal(m.judgeVT10({ leak: vtRun('leak', fd600Run, { fdStart: 600 }), fixed: vtRun('fixed', fixedPass) }).verdict, '판정 못 함');

  // 고친 판이 미달이면 미달이다.
  const fixedFail = m.judgeNFR027(nfrRun({ target: 'purchase-svc', restarts: 1 }));
  assert.equal(fixedFail.verdict, '미달');
  assert.equal(m.judgeVT10({ leak: vtRun('leak', leakFail), fixed: vtRun('fixed', fixedFail) }).verdict, '미달');

  // 명목 조건이 다르면 대조하지 않는다. variant가 둘 다 leak이거나 target이 다르면 V-T10이 아니다.
  for (const changed of [{ rate: 900 }, { durationMin: 300 }, { warmupMin: 29 }, { baseCommit: 'deadbee' }, { leakIntervalMin: 5 }]) {
    const result = m.judgeVT10({
      leak: vtRun('leak', leakFail, changed),
      fixed: vtRun('fixed', fixedPass),
    });
    assert.equal(result.verdict, '판정 못 함', `조건 차이(${JSON.stringify(changed)})를 통과로 세면 안 된다`);
  }
  assert.equal(m.judgeVT10({ leak: vtRun('leak', leakFail), fixed: vtRun('leak', fixedPass) }).verdict, '판정 못 함');
  assert.equal(
    m.judgeVT10({ leak: vtRun('leak', leakFail, { target: 'queue-svc' }), fixed: vtRun('fixed', fixedPass) }).verdict,
    '판정 못 함',
  );
  assert.equal(
    m.judgeVT10({ leak: vtRun('leak', leakFail), fixed: vtRun('fixed', fixedPass, { target: 'queue-svc' }) }).verdict,
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

test('MSR-050 ⑥ 보고서 뼈대를 실제 검증기로 읽고, 표시·실행 ID·종합 통과·금지 주장을 가른다', async () => {
  const m = await soak();
  const mdPath = 'docs/review/measurements/F-08-5-soak.md';
  const doc = read(mdPath, '장시간 시험 보고서 뼈대');

  // RV085-01: 뼈대를 실제 validateSoakReport에 넘긴다. '미측정' 문자열만 보지 않는다.
  const docParsed = m.validateSoakReport(doc, { runExists: () => false });
  assert.equal(docParsed.targets, 5);
  assert.equal(docParsed.pass, 0);
  assert.equal(docParsed.vt10, '미측정');
  assert.match(doc, /10분에 1개/, '뼈대 §5에 누수율이 있어야 한다');

  const runs = m.SOAK_TARGETS.map((t) => reportRun(t.id));
  const base = {
    title: 'F-08-5 장시간 시험 보고서',
    stage: { window: '4a~4c', lock: 'docker lane4-F-08-5', cluster: 'lane4-f085' },
    runs,
    nfr027: '미측정',
    vt10: {
      verdict: '미측정',
      leak: { target: 'purchase-svc', stage: '4c', rate: 1000, durationMin: 360, leakIntervalMin: 10, fdStart: 100, verdict: '미측정', label: '미측정', runId: null },
      fixed: { target: 'purchase-svc', stage: '4a', rate: 1000, durationMin: 360, leakIntervalMin: 0, fdStart: 100, verdict: '미측정', label: '미측정', runId: null },
    },
  };
  const md = m.renderSoakReport(base);
  const parsed = m.validateSoakReport(md, { runExists: () => false });
  assert.equal(parsed.targets, 5);
  assert.equal(parsed.pass, 0);
  assert.equal(parsed.vt10, '미측정');

  // RV085-07: 실행 ID는 실제로 있고 표시만 빠진 줄을 만든다. 실패 까닭은 '표시' 하나여야 한다.
  const unlabeled = `${md}\n| queue-svc | 500 | 360 | 통과 | 확인 | ${REAL_RUN} |\n`;
  assert.throws(
    () => m.validateSoakReport(unlabeled, { runExists: (id) => id === REAL_RUN }),
    /표시/,
  );

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

  // RV085-07: 한 대상만 미측정인데 종합 통과면 거부한다. 실행 ID는 다른 대상에 실제로 있다.
  const prematureRuns = runs.map((r) => (r.target === 'queue-svc'
    ? r
    : { ...r, verdict: '통과', label: '실측(PC)', runId: RUN_BY_TARGET[r.target] }));
  const premature = m.renderSoakReport({ ...base, runs: prematureRuns, nfr027: '통과' });
  assert.throws(
    () => m.validateSoakReport(premature, { runExists }),
    /종합|미측정/,
    '종합 통과인데 미측정 대상이 있으면 실행 ID가 아니라 종합 규칙으로 실패해야 한다',
  );

  // 모두 통과라도 실행 ID가 없거나 가짜면 거부한다.
  const allPassNoId = {
    ...base,
    runs: runs.map((r) => ({ ...r, verdict: '통과', label: '실측(PC)' })),
    nfr027: '통과',
  };
  assert.throws(() => m.validateSoakReport(m.renderSoakReport(allPassNoId), { runExists: () => false }), /실행 ID/);

  const allPass = {
    ...allPassNoId,
    runs: runs.map((r) => ({ ...r, runId: RUN_BY_TARGET[r.target] })),
    vt10: {
      verdict: '통과',
      leak: { target: 'purchase-svc', stage: '4c', rate: 1000, durationMin: 360, leakIntervalMin: 10, fdStart: 100, verdict: '통과', label: '실측(PC)', runId: LEAK_RUN },
      fixed: { target: 'purchase-svc', stage: '4a', rate: 1000, durationMin: 360, leakIntervalMin: 0, fdStart: 100, verdict: '통과', label: '실측(PC)', runId: fixedRun },
    },
  };
  const allPassMd = m.renderSoakReport(allPass);
  const allPassParsed = m.validateSoakReport(allPassMd, { runExists });
  assert.equal(allPassParsed.pass, 5);
  assert.equal(allPassParsed.vt10, '통과');
  assert.throws(
    () => m.validateSoakReport(allPassMd, { runExists: () => false }),
    /실행 ID/,
    '가짜 실행 ID를 통과로 세면 안 된다',
  );

  // RV085-08: 한 실행 ID로 두 대상의 통과를 주장하면 거부한다.
  const duplicated = { ...allPass, runs: allPass.runs.map((r) => (r.target === 'payment-svc' ? { ...r, runId: REAL_RUN } : r)) };
  assert.throws(
    () => m.validateSoakReport(m.renderSoakReport(duplicated), { runExists: (id) => id === REAL_RUN }),
    /같은 실행 ID|중복/,
  );

  // V-T10 통과는 누수 판·고친 판 두 줄이 다 있어야 한다.
  const oneRow = {
    ...allPass,
    vt10: { ...allPass.vt10, fixed: { ...allPass.vt10.fixed, verdict: '미측정', label: '미측정', runId: null } },
  };
  assert.throws(
    () => m.validateSoakReport(m.renderSoakReport(oneRow), { runExists }),
    /V-T10|고친/,
  );

  // 누수율이 10분에 1개가 아니면 V-T10 통과로 세지 않는다.
  const wrongInterval = {
    ...allPass,
    vt10: { ...allPass.vt10, leak: { ...allPass.vt10.leak, leakIntervalMin: 5 } },
  };
  assert.throws(
    () => m.validateSoakReport(m.renderSoakReport(wrongInterval), { runExists }),
    /누수율|10분/,
  );
});

test('MSR-050 ⑦ 표본 도구는 GC를 먼저 부르고, FD·DB·Redis 값을 0이 아니라 null로 남긴다', async () => {
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

  // DB 질의는 네임스페이스와 누수 판 application_name을 포함해야 한다.
  const query = p.pgActivityQuery({ namespace: 'v1', database: 'peaket_purchase', applicationNames: ['purchase-svc', 'purchase-svc-leak'] });
  assert.match(query, /-n\s+v1/);
  assert.match(query, /purchase-svc-leak/);
  assert.match(query, /pg_stat_activity/);

  assert.equal(p.parseRedisClients('connected_clients:12\n'), 12);
  assert.equal(p.parseRedisClients('connected_clients:12\nblocked_clients:0\n'), 12);
  assert.equal(p.parseRedisClients('# Clients\nused_memory:1\n'), null);
  assert.equal(p.parseRedisClients('connected_clients:NaN\n'), null);
  const clientList = 'id=1 name=purchase-svc addr=1\nid=2 name=purchase-svc-leak addr=2\nid=3 name=other addr=3\n';
  assert.equal(p.parseRedisClientList(clientList, ['purchase-svc', 'purchase-svc-leak']), 2, '대상 이름으로 거른다');
  assert.equal(p.parseRedisClientList(clientList, ['purchase-svc']), 2, '접두 이름을 쓴다');
  assert.equal(p.parseRedisClientList('# Clients\n', ['purchase-svc']), null);

  const calls = [];
  const expressions = [];
  const cdp = {
    async send(method, params) {
      calls.push(method);
      if (method === 'HeapProfiler.collectGarbage') return {};
      if (method === 'Runtime.evaluate') {
        expressions.push(params.expression);
        return { result: { value: { heapUsed: 1048576, rss: 2097152, openFds: 3, activeHandles: 1 } } };
      }
      throw new Error(`모르는 CDP: ${method} ${JSON.stringify(params)}`);
    },
  };
  const sampled = await p.sampleWithGc(cdp, () => 0);
  assert.deepEqual(calls, ['HeapProfiler.collectGarbage', 'Runtime.evaluate'], 'GC가 evaluate보다 먼저여야 한다');
  assert.equal(sampled.heapAfterGcMb, 1);
  assert.match(expressions[0], /process\.memoryUsage/);
  assert.match(expressions[0], /\/proc\/self\/fd/);
  assert.match(expressions[0], /_getActiveHandles/);

  // FD를 못 읽으면 0으로 채우지 않고 null로 남긴다.
  const noFd = {
    async send(method) {
      if (method === 'HeapProfiler.collectGarbage') return {};
      return { result: { value: { heapUsed: 1048576, rss: 2097152, activeHandles: 1 } } };
    },
  };
  const noFdSample = await p.sampleWithGc(noFd, () => 0);
  assert.equal(noFdSample.openFds, null);
  assert.ok(noFdSample.reason.includes('openFds'), 'FD 빠짐의 까닭을 남긴다');

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

test('MSR-050 ⑧ 시나리오·실행 계획·경계·누수 패치가 대상별 세기와 함께 준비돼 있다', async () => {
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
  const byId = Object.fromEntries(plan.targets.map((t) => [t.id, t]));
  assert.equal(byId['queue-svc'].rate, 500);
  assert.equal(byId['queue-svc'].entryUsers, 5000);
  assert.equal(byId['queue-svc'].entrySeconds, 10);
  assert.equal(byId['queue-svc'].admitPerSecond, 28);
  assert.equal(byId['purchase-svc'].rate, 1000);
  assert.equal(byId['payment-svc'].rate, 150);
  assert.equal(byId['realtime-gw'].connections, 2500);
  assert.equal(byId['realtime-gw'].holdRate, 63);
  assert.equal(byId['outbox-relay'].rate, 100);
  for (const t of plan.targets) {
    assert.ok(Array.isArray(t.commands) && t.commands.length > 0, `${t.id} 명령이 없다`);
    assert.ok(Array.isArray(t.artifacts) && t.artifacts.length > 0, `${t.id} 산출물이 없다`);
    assert.match(t.judge, /NFR-027/);
  }
  assert.equal(plan.leak.target, 'purchase-svc');
  assert.equal(plan.leak.variant, 'db-conn');
  assert.equal(plan.leak.intervalMin, 10);
  assert.equal(plan.leak.connectionsPerHour, 6);
  assert.equal(plan.leak.fdStartMax, 600);
  assert.equal(plan.leak.applicationName, 'purchase-svc-leak');
  assert.match(plan.leak.patch, /db-conn-leak\.patch/);
  assert.match(plan.report, /docs\/review\/measurements\/F-08-5-soak\.md/);

  const scenario = read('loadtest/scenarios/v1-soak.js', 'F-08-5 k6 시나리오');
  for (const id of ['queue-svc', 'purchase-svc', 'payment-svc', 'realtime-gw', 'outbox-relay']) {
    assert.ok(scenario.includes(id), `시나리오에 ${id}가 없다`);
  }
  assert.match(scenario, /phase:\s*['"]warm['"]/);
  assert.match(scenario, /phase:\s*['"]main['"]/);
  assert.match(scenario, /records\.ndjson/);
  assert.match(scenario, /markStart|markEnd/);
  assert.match(scenario, /constant-arrival-rate/);
  assert.match(scenario, /dropped_iterations/);
  assert.match(scenario, /TARGET/);
  assert.match(scenario, /RATE/);
  assert.match(scenario, /DURATION_S|duration/);

  const patch = read('loadtest/soak/db-conn-leak.patch', 'V-T10 누수 패치');
  assert.match(patch, /PEAKET_ENV/);
  assert.match(patch, /local/);
  assert.match(patch, /application_name/);
  assert.match(patch, /purchase-svc-leak/);
  assert.match(patch, /10/);
  assert.match(patch, /intervalMin|interval/);
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
  assert.match(doc, /99\.95|0\.05%/);
  assert.match(doc, /63\/s|63\/초/);
  assert.match(doc, /constant-arrival-rate/);
  assert.match(doc, /10분에 1개/);
  assert.match(doc, /FD/);
});