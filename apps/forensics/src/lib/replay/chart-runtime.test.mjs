// F-04-18 차트 런타임 시험. 정본: docs/features/forensic-replay.md §2.1~§2.2·§3.1·§3.3·§7.1,
// docs/security/asvs/forensic-replay.md(v5.0.0-1.4.3·3.5.5·3.7.1).
// 브라우저 없이 순수 함수로 로그 눈금·2D 표본·Worker 계약·성능 판정 경계만 본다. 실제 GPU·Worker 실행은 미실행이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeColumns } from '../forensics/events.ts';

async function load(name) {
  const path = new URL(`./${name}.ts`, import.meta.url);
  if (!existsSync(path)) return null;
  return await import(`./${name}.ts`);
}

const runtime = await load('chart-runtime');
const perf = await load('perf');
const candidate = await load('candidate');

function need(module, moduleName, name) {
  assert.ok(module, `순수 모듈(src/lib/replay/${moduleName}.ts)이 없다`);
  assert.equal(typeof module[name], 'function', `${moduleName}.${name}이 없다`);
  return module[name];
}

const nearly = (actual, expected, label) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
};

function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function replaySources() {
  const roots = [resolve(process.cwd(), 'src/operating'), resolve(process.cwd(), 'src/lib/replay'), resolve(process.cwd(), 'src/workers')];
  const out = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const visit = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (/\.(ts|tsx)$/.test(path)) out.push({ path, source: codeOnly(readFileSync(path, 'utf8')) });
      }
    };
    visit(root);
  }
  assert.ok(out.length > 0, '운영 화면·재생 모듈 파일이 없다');
  return out;
}

test('UI-11 ①③ FX-T9 ⑧ 산점도는 로그 가로축·축 밖 가장자리를 쓰고, 2D 표본은 집계에 새지 않는다', () => {
  const planOf = need(runtime, 'chart-runtime', 'renderPlan');
  const sample = need(runtime, 'chart-runtime', 'samplePoints');
  const available = need(runtime, 'chart-runtime', 'webgl2Available');
  const label = need(runtime, 'chart-runtime', 'map2dLabel');
  const logPosition = need(runtime, 'chart-runtime', 'logPosition');
  const linearPosition = need(runtime, 'chart-runtime', 'linearPosition');
  const scatterPosition = need(runtime, 'chart-runtime', 'scatterPosition');
  const selectionStats = need(candidate, 'candidate', 'selectionStats');

  assert.deepEqual(planOf(0, false), { mode: '2d-sample', count: 0, stride: 1 });
  assert.deepEqual(planOf(15_000, false), { mode: '2d-sample', count: 15_000, stride: 1 });
  assert.deepEqual(planOf(20_000, false), { mode: '2d-sample', count: 20_000, stride: 1 });
  assert.equal(planOf(20_001, false).count, 20_000);
  assert.equal(planOf(50_000, false).count, 20_000);
  assert.equal(planOf(50_000, false).stride, 2.5);
  assert.deepEqual(planOf(50_000, true), { mode: 'webgl2', count: 50_000, stride: 1 });
  assert.deepEqual(planOf(3_000_000, true), { mode: 'webgl2', count: 3_000_000, stride: 1 });

  assert.equal(label(), '이 기기는 표본으로 그립니다');
  assert.equal(available(null), false);
  assert.equal(available({ getContext: (name) => (name === 'webgl2' ? {} : null) }), true);
  assert.equal(available({ getContext: () => null }), false);
  assert.equal(
    available({
      getContext: () => {
        throw new Error('GPU 없음');
      },
    }),
    false,
  );

  // 가로는 10ms~10s 로그 눈금이고, 축 밖 값은 가장자리로 자른다.
  assert.equal(logPosition(10), 0);
  nearly(logPosition(100), 1 / 3, '100ms 위치');
  assert.equal(logPosition(10_000), 1);
  assert.equal(logPosition(5), 0);
  assert.equal(logPosition(20_000), 1);
  assert.ok(Number.isNaN(logPosition(Number.NaN)));
  assert.equal(linearPosition(0), 0);
  assert.equal(linearPosition(0.5), 0.5);
  assert.equal(linearPosition(1), 1);
  assert.equal(linearPosition(-1), 0);
  assert.equal(linearPosition(2), 1);
  assert.ok(Number.isNaN(linearPosition(Number.NaN)));
  assert.deepEqual(scatterPosition(100, 0.5), { u: 1 / 3, v: 0.5 });
  assert.deepEqual(scatterPosition(1, -1), { u: 0, v: 0 });
  assert.deepEqual(scatterPosition(20_000, 2), { u: 1, v: 1 });

  const points = Array.from({ length: 50_000 }, (_, i) => i);
  const sampled = sample(points, planOf(50_000, false));
  assert.equal(sampled.length, 20_000);
  assert.equal(sampled[0], 0);
  assert.equal(sampled[sampled.length - 1], 49_997);
  for (let i = 1; i < sampled.length; i += 1) assert.ok(sampled[i] > sampled[i - 1]);
  assert.equal(sample(points, planOf(15_000, false)), points, '표본이 필요 없으면 복사하지 않는다');
  assert.equal(sample([], planOf(0, false)).length, 0);

  // 25,000점을 모두 덮는 영역의 집계는 표본 2만 점이 아니라 전체 25,000점이어야 한다.
  const many = Array.from({ length: 25_000 }, (_, i) => ({
    session: i,
    x: 100,
    y: 0.5,
    bot: i % 10 === 0,
  }));
  const stats = selectionStats(many, { x0: 0, x1: 10_000, y0: 0, y1: 1 }, 2_500);
  assert.equal(stats.sessions, 25_000);
  assert.equal(stats.bots, 2_500);
  assert.equal(stats.recall, 1);
  assert.equal(planOf(25_000, false).count, 20_000);
});

test('FX-T5 ① [가정] 성능 판정은 필터 p95 50ms·프레임 p95 20ms 경계로 가른다', () => {
  const p95 = need(perf, 'perf', 'p95');
  const statusOf = need(perf, 'perf', 'perfStatus');

  assert.equal(perf.FILTER_P95_BUDGET_MS, 50);
  assert.equal(perf.FRAME_P95_BUDGET_MS, 20);
  assert.equal(p95([]), null, '빈 측정은 0이 아니라 없음이다');
  assert.equal(p95([5]), 5);
  assert.equal(p95([1, 2, 3, 4, 5]), 5);
  assert.equal(p95(Array.from({ length: 100 }, (_, i) => i + 1)), 95);

  const empty = statusOf({ filterMs: [], frameMs: [], longTasks: 0 });
  assert.deepEqual(empty, {
    filterP95: null,
    frameP95: null,
    filterOk: false,
    frameOk: false,
    longTasks: 0,
  });

  const repeated = (value, count) => Array.from({ length: count }, () => value);
  const atBoundary = statusOf({
    filterMs: [...repeated(50, 95), ...repeated(51, 5)],
    frameMs: [...repeated(20, 95), ...repeated(21, 5)],
    longTasks: 3,
  });
  assert.equal(atBoundary.filterP95, 50);
  assert.equal(atBoundary.frameP95, 20);
  assert.equal(atBoundary.filterOk, true);
  assert.equal(atBoundary.frameOk, true);
  assert.equal(atBoundary.longTasks, 3);

  const over = statusOf({
    filterMs: [...repeated(50, 94), ...repeated(51, 6)],
    frameMs: [...repeated(20, 94), ...repeated(21, 6)],
    longTasks: 0,
  });
  assert.equal(over.filterP95, 51);
  assert.equal(over.frameP95, 21);
  assert.equal(over.filterOk, false);
  assert.equal(over.frameOk, false);

  // 한쪽만 비어도 그쪽은 합격이 아니다.
  const half = statusOf({ filterMs: [40], frameMs: [], longTasks: 1 });
  assert.equal(half.filterP95, 40);
  assert.equal(half.filterOk, true);
  assert.equal(half.frameP95, null);
  assert.equal(half.frameOk, false);
});

test('ASVS v5.0.0-3.5.5 Worker 메시지는 정해진 종류·판 번호·형만 받고 나머지는 버린다', () => {
  const decode = need(runtime, 'chart-runtime', 'decodeWorkerMessage');
  const columns = makeColumns(2);
  const keep = new Uint8Array(2);
  const request = { kind: 'candidate', version: 3, source: 'SYNTHETIC', columns, keep };
  const decodedRequest = decode(request);
  assert.ok(decodedRequest);
  assert.equal(decodedRequest.kind, 'candidate');
  assert.equal(decodedRequest.version, 3);
  assert.equal(decodedRequest.source, 'SYNTHETIC');
  assert.equal(decodedRequest.columns.t_ms.length, 2);
  assert.equal(decodedRequest.keep.length, 2);

  for (const bad of [
    null,
    undefined,
    0,
    'candidate',
    {},
    { kind: 'nope', version: 1 },
    { kind: 'candidate', version: 1.5, source: 'SYNTHETIC', columns, keep },
    { kind: 'candidate', version: -1, source: 'SYNTHETIC', columns, keep },
    { kind: 'candidate', version: 1, source: 'OTHER', columns, keep },
    { kind: 'candidate', version: 1, source: 'SYNTHETIC', columns },
    { kind: 'candidate', version: 1, source: 'SYNTHETIC', columns, keep: new Uint8Array(3) },
    { kind: 'candidate', version: 1, source: 'SYNTHETIC', columns: makeColumns(3), keep },
    { kind: 'candidate-done', version: 1, panel: 'nope', points: new Float32Array(4), sessions: new Uint32Array(2), bots: new Uint8Array(2), totalSessions: 2, totalBots: 1, bursts: [], histogram: null },
    { kind: 'candidate-done', version: 1, panel: 'scatter', points: new Float32Array(2), sessions: new Uint32Array(2), bots: new Uint8Array(2), totalSessions: 2, totalBots: 1, bursts: [], histogram: null },
    { kind: 'candidate-done', version: 1, panel: 'scatter', points: new Float32Array(4), sessions: new Uint32Array(3), bots: new Uint8Array(2), totalSessions: 2, totalBots: 1, bursts: [], histogram: null },
    { kind: 'candidate-done', version: 1, panel: 'scatter', points: new Float32Array(4), sessions: new Uint32Array(2), bots: new Uint8Array(3), totalSessions: 2, totalBots: 1, bursts: [], histogram: null },
    { kind: 'candidate-done', version: 1, panel: 'scatter', points: new Float32Array(4), sessions: new Uint32Array(2), bots: new Uint8Array(2), totalSessions: 2, totalBots: -1, bursts: [], histogram: null },
    { kind: 'candidate-done', version: 1, panel: 'scatter', points: new Float32Array(4), sessions: new Uint32Array(2), bots: new Uint8Array(2), totalSessions: 2, totalBots: 1, bursts: [{ deviceGroup: 7 }], histogram: null },
    { kind: 'candidate-done', version: 1, panel: 'distribution', points: new Float32Array(0), sessions: new Uint32Array(0), bots: new Uint8Array(0), totalSessions: 0, totalBots: 0, bursts: [], histogram: { bins: new Uint32Array(2), edges: new Float64Array(2) } },
    { kind: 'error', version: 1, message: 42 },
    { kind: 'error', version: 1, message: 'x'.repeat(201) },
  ]) {
    assert.equal(decode(bad), null, JSON.stringify(bad));
  }

  const points = new Float32Array([100, 0.5, 200, 0.6]);
  const sessions = new Uint32Array([7, 8]);
  const bots = new Uint8Array([0, 1]);
  const done = {
    kind: 'candidate-done',
    version: 2,
    panel: 'scatter',
    points,
    sessions,
    bots,
    totalSessions: 2,
    totalBots: 1,
    bursts: [{ deviceGroup: 7, sessions: 1, attempts: 2, firstAtMs: 1_000, lastAtMs: 1_005 }],
    histogram: null,
  };
  const decodedDone = decode(done);
  assert.ok(decodedDone);
  assert.deepEqual(decodedDone.points, points);
  assert.deepEqual(decodedDone.sessions, sessions);
  assert.deepEqual(decodedDone.bots, bots);
  assert.equal(decodedDone.bursts.length, 1);

  const withHistogram = decode({
    ...done,
    panel: 'distribution',
    points: new Float32Array(0),
    sessions: new Uint32Array(0),
    bots: new Uint8Array(0),
    totalSessions: 0,
    totalBots: 0,
    bursts: [],
    histogram: { bins: new Uint32Array([2, 3]), edges: new Float64Array([10, 100, 1_000]) },
  });
  assert.ok(withHistogram);
  assert.equal(withHistogram.histogram.bins.length, 2);
  assert.equal(withHistogram.histogram.edges.length, 3);

  assert.equal(decode({ kind: 'error', version: 0, message: 'x'.repeat(200) }).message.length, 200);
});

test('UI-13 ① [ASVS v5.0.0-1.4.3] 공유 시계를 더하지 않고 후보 요청 복사본만 전송 목록으로 넘긴다', () => {
  const requestOf = need(runtime, 'chart-runtime', 'candidateRequest');
  const doneBuffers = need(runtime, 'chart-runtime', 'candidateDoneBuffers');
  const clockLabel = need(runtime, 'chart-runtime', 'clockModeLabel');

  assert.equal(runtime.SHARED_CLOCK_ENABLED, false);
  assert.equal(clockLabel(false), '복사 방식');
  assert.equal(clockLabel(true), '공유 메모리 켜짐');

  const columns = makeColumns(2);
  columns.t_ms[0] = -100;
  columns.t_ms[1] = 200;
  const keep = new Uint8Array([1, 0]);
  const { message, transfer } = requestOf(1, 'SYNTHETIC', columns, keep);
  assert.equal(message.kind, 'candidate');
  assert.notEqual(message.columns.t_ms, columns.t_ms, '요청은 메인의 열을 그대로 보내지 않는다');
  assert.notEqual(message.keep, keep, '요청은 메인의 keep을 그대로 보내지 않는다');
  assert.equal(message.columns.t_ms[0], -100);
  assert.equal(message.keep[0], 1);
  assert.equal(transfer.length, 17, '열 16개와 keep 하나를 전송한다');
  assert.ok(transfer.includes(message.columns.t_ms.buffer));
  assert.ok(transfer.includes(message.keep.buffer));

  // 전송 목록으로 넘기면 복사본 버퍼는 분리되고, 메인의 원본은 그대로다.
  structuredClone(message, { transfer });
  assert.equal(message.columns.t_ms.buffer.byteLength, 0);
  assert.equal(message.keep.buffer.byteLength, 0);
  assert.ok(columns.t_ms.buffer.byteLength > 0);
  assert.equal(columns.t_ms[0], -100);
  assert.equal(keep[0], 1);

  const done = {
    kind: 'candidate-done',
    version: 1,
    panel: 'distribution',
    points: new Float32Array(0),
    sessions: new Uint32Array(0),
    bots: new Uint8Array(0),
    totalSessions: 0,
    totalBots: 0,
    bursts: [],
    histogram: { bins: new Uint32Array([2, 3]), edges: new Float64Array([10, 100, 1_000]) },
  };
  const buffers = doneBuffers(done);
  assert.equal(buffers.length, 5);
  assert.equal(new Set(buffers).size, 5, '같은 버퍼를 두 번 넘기지 않는다');

  for (const { path, source } of replaySources()) {
    assert.doesNotMatch(source, /new\s+SharedArrayBuffer|SharedArrayBuffer\s*\(/, `${path}에 공유 메모리를 만든다`);
    assert.doesNotMatch(source, /\bAtomics\./, `${path}에 Atomics를 쓴다`);
  }
});
