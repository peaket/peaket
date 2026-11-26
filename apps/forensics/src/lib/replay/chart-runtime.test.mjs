// F-04-18 차트 런타임 시험. 정본: docs/features/forensic-replay.md §2.2·§3.1·§3.3·§7.1,
// docs/security/asvs/forensic-replay.md(v5.0.0-1.4.3·3.5.5·3.7.1).
// 브라우저 없이 순수 함수로 2D 표본·Worker 메시지·성능 판정 경계만 본다. 실제 GPU·Worker 실행은 미실행이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

async function load(name) {
  try {
    return await import(`./${name}.ts`);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const runtime = await load('chart-runtime');
const perf = await load('perf');

function need(module, moduleName, name) {
  assert.ok(module, `순수 모듈(src/lib/replay/${moduleName}.ts)이 없다`);
  assert.equal(typeof module[name], 'function', `${moduleName}.${name}이 없다`);
  return module[name];
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
        else if (/\.(ts|tsx)$/.test(path)) out.push({ path, source: readFileSync(path, 'utf8') });
      }
    };
    visit(root);
  }
  assert.ok(out.length > 0, '운영 화면·재생 모듈 파일이 없다');
  return out;
}

test('UI-11 ① WebGL2가 없으면 2D 표본 2만 점으로 그리고 안내 문구를 보인다', () => {
  const planOf = need(runtime, 'chart-runtime', 'renderPlan');
  const sample = need(runtime, 'chart-runtime', 'samplePoints');
  const available = need(runtime, 'chart-runtime', 'webgl2Available');
  const label = need(runtime, 'chart-runtime', 'map2dLabel');

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

  const points = Array.from({ length: 50_000 }, (_, i) => i);
  const sampled = sample(points, planOf(50_000, false));
  assert.equal(sampled.length, 20_000);
  assert.equal(sampled[0], 0);
  assert.equal(sampled[sampled.length - 1], 49_997);
  for (let i = 1; i < sampled.length; i += 1) assert.ok(sampled[i] > sampled[i - 1]);
  assert.equal(sample(points, planOf(15_000, false)), points, '표본이 필요 없으면 복사하지 않는다');
  assert.equal(sample([], planOf(0, false)).length, 0);
});

test('FX-T5 ① [가정] 성능 판정은 필터 p95 50ms·프레임 p95 20ms 경계로 가른다', () => {
  const p95 = need(perf, 'perf', 'p95');
  const statusOf = need(perf, 'perf', 'perfStatus');

  assert.equal(p95([]), 0);
  assert.equal(p95([5]), 5);
  assert.equal(p95([1, 2, 3, 4, 5]), 5);
  assert.equal(p95(Array.from({ length: 100 }, (_, i) => i + 1)), 95);

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
});

test('ASVS v5.0.0-3.5.5 Worker 메시지는 정해진 종류·판 번호만 받고 나머지는 버린다', () => {
  const decode = need(runtime, 'chart-runtime', 'decodeWorkerMessage');
  const tick = { kind: 'tick', version: 3, playheadMs: 1_200, playing: true };
  assert.deepEqual(decode(tick), tick);

  for (const bad of [
    null,
    undefined,
    0,
    'tick',
    {},
    { kind: 'nope', version: 1 },
    { kind: 'tick', version: 1.5, playheadMs: 0, playing: true },
    { kind: 'tick', version: -1, playheadMs: 0, playing: true },
    { kind: 'tick', version: 1, playheadMs: '0', playing: true },
    { kind: 'tick', version: 1, playheadMs: 0, playing: 1 },
    { kind: 'candidate-done', version: 1, points: new Float32Array(2), sessions: new Uint32Array(2), bots: new Uint8Array(2), totalBots: 1, sampled: false, extra: true },
    { kind: 'candidate-done', version: 1, points: [1, 2], sessions: new Uint32Array(2), bots: new Uint8Array(2), totalBots: 1, sampled: false },
    { kind: 'candidate-done', version: 1, points: new Float32Array(2), sessions: new Uint32Array(3), bots: new Uint8Array(2), totalBots: 1, sampled: false },
    { kind: 'candidate-done', version: 1, points: new Float32Array(2), sessions: new Uint32Array(2), bots: new Uint8Array(2), totalBots: -1, sampled: false },
    { kind: 'error', version: 1, message: 42 },
    { kind: 'error', version: 1, message: 'x'.repeat(201) },
  ]) {
    assert.equal(decode(bad), null, JSON.stringify(bad));
  }

  const points = new Float32Array([1, 2, 3, 4]);
  const sessions = new Uint32Array([7, 8]);
  const bots = new Uint8Array([0, 1]);
  const done = { kind: 'candidate-done', version: 2, points, sessions, bots, totalBots: 1, sampled: false };
  const decoded = decode(done);
  assert.ok(decoded);
  assert.equal(decoded.points, points);
  assert.equal(decoded.sessions, sessions);
  assert.equal(decoded.bots, bots);
  assert.equal(decode({ kind: 'error', version: 0, message: 'x'.repeat(200) }).message.length, 200);
});

test('UI-13 ① 공유 시계는 더하지 않고 복사 방식의 3칸 시계만 쓴다', () => {
  const wordsOf = need(runtime, 'chart-runtime', 'clockWords');
  const clockOf = need(runtime, 'chart-runtime', 'clockFromWords');

  const words = wordsOf({ playheadMs: 1_234, playing: true, version: 7 });
  assert.ok(words instanceof Int32Array);
  assert.deepEqual([...words], [1_234, 1, 7]);
  assert.deepEqual(clockOf(words), { playheadMs: 1_234, playing: true, version: 7 });
  assert.deepEqual(clockOf(wordsOf({ playheadMs: -600_000, playing: false, version: 0 })), {
    playheadMs: -600_000,
    playing: false,
    version: 0,
  });
  for (const bad of [
    new Int32Array([1, 0]),
    new Int32Array([1, 0, 0, 0]),
    new Int32Array([1, 2, 0]),
    new Int32Array([1, 0, -1]),
    new Int32Array([1.5, 0, 0]),
  ]) {
    assert.equal(clockOf(bad), null);
  }

  for (const { path, source } of replaySources()) {
    assert.doesNotMatch(source, /SharedArrayBuffer/, `${path}에 SharedArrayBuffer가 있다`);
    assert.doesNotMatch(source, /\bAtomics\./, `${path}에 Atomics가 있다`);
  }
});
