// F-03-6(FE-T29) 측정 도구의 순수 함수 시험. 브라우저·빌드 없이 도구가 0건·SKIPPED·빈 결과를 통과로
// 흘리지 않는지, 중앙값·p75·A/A·크기·격리 경로·다시 빌드 폴더 계산이 정본 규칙과 같은지 본다.
// 기준 트리(계획 커밋)에서는 lib.mjs가 없어 이 파일이 실행되지 않는다. '실패 확인'에 그 사실과 함께
// 표시 지점이 없어 측정이 미측정이라는 사실을 적는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MARK, CPU_THROTTLE, EXPECTED_SLOTS, median, nearestRank, summarize, validateRun, validateResult, aaDrift, ratio, chunkNameOf, blockRule, countFolders, buildSizes } from './lib.mjs';

/** @param {'mf'|'single'} build */
function goodRun(build = 'mf') {
  return {
    readyMarkCount: 1,
    readyMs: 842,
    fcpMs: 210,
    lcpMs: 930,
    inpMs: 88,
    longTasks: 0,
    cpuThrottle: CPU_THROTTLE,
    slotCounts: { loading: 0, value: EXPECTED_SLOTS, fallback: 0 },
    remoteEntries: build === 'mf' ? [{ name: 'queue', ms: 120 }, { name: 'purchase', ms: 140 }] : [],
    remoteLoadMs: build === 'mf' ? { queue: 120, purchase: 140 } : { queue: null, purchase: null },
    pageErrors: [],
    cspViolations: 0,
  };
}

test('F-03-6 T1 ① 중앙값은 가운데 값, p75는 가장 가까운 순위(3회면 가장 늦은 값)이고 빈 값은 통과가 아니다', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([5]), 5);
  assert.throws(() => median([]), /값이 없다/);
  assert.equal(nearestRank([1, 2, 3], 0.75), 3);
  assert.equal(nearestRank([9, 2, 5], 0.75), 9);
  assert.equal(nearestRank([4], 0.75), 4);
  const s = summarize([3, 1, 2]);
  assert.deepEqual(s, { runs: 3, median: 2, p75: 3, min: 1, max: 3 });
  assert.throws(() => summarize([]), /값이 없다/);
  assert.equal(MARK, 'peaket:dashboard-ready');
});

test('F-03-6 T2 ② 실행 유효성: 표시 없음·자리 0·원격 없음·페이지 오류·CSP 위반·스로틀 미적용은 무효다', () => {
  const ok = validateRun(goodRun('mf'), { build: 'mf' });
  assert.equal(ok.ok, true, ok.reasons.join(' / '));
  const cases = [
    [{ readyMarkCount: 0 }, /표시/],
    [{ readyMarkCount: 2 }, /표시/],
    [{ readyMs: 0 }, /첫 그림/],
    [{ slotCounts: { loading: 0, value: 0, fallback: 0 } }, /자리/],
    [{ slotCounts: { loading: 1, value: EXPECTED_SLOTS, fallback: 0 } }, /불러오는 중/],
    [{ remoteEntries: [{ name: 'queue', ms: 1 }] }, /원격/],
    [{ pageErrors: ['boom'] }, /페이지 오류/],
    [{ cspViolations: 1 }, /CSP/],
    [{ cpuThrottle: 1 }, /스로틀/],
    [{ fcpMs: 0 }, /FCP/],
    [{ lcpMs: 0 }, /LCP/],
  ];
  for (const [patch, reason] of cases) {
    const r = validateRun({ ...goodRun('mf'), ...patch }, { build: 'mf' });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.ok(r.reasons.some((x) => reason.test(x)), `${JSON.stringify(patch)} → ${r.reasons.join(' / ')}`);
  }
  const single = validateRun(goodRun('single'), { build: 'single' });
  assert.equal(single.ok, true, single.reasons.join(' / '));
  const singleRemote = validateRun({ ...goodRun('single'), remoteEntries: [{ name: 'queue', ms: 1 }] }, { build: 'single' });
  assert.equal(singleRemote.ok, false);
  assert.ok(singleRemote.reasons.some((x) => /원격/.test(x)));
});

test('F-03-6 T1 ③ 묶음 유효성: 3회가 아니거나 한 회라도 무효면 통과가 아니다', () => {
  const runs = [0, 1, 2].map(() => ({ cold: goodRun('mf'), warm: goodRun('mf') }));
  const ok = validateResult({ build: 'mf', runs });
  assert.equal(ok.ok, true, ok.reasons.join(' / '));
  assert.equal(validateResult({ build: 'mf', runs: [] }).ok, false);
  assert.equal(validateResult({ build: 'mf', runs: runs.slice(0, 2) }).ok, false);
  const bad = structuredClone(runs);
  bad[1].warm.readyMarkCount = 0;
  const r = validateResult({ build: 'mf', runs: bad });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /2회차|표시/.test(x)));
  assert.equal(validateResult({ build: 'mf', runs, valid: false }).ok, false);
});

test('F-03-6 T6 A/A 흔들림은 25%[가정]부터 noisy, 비교 비율은 single÷mf다', () => {
  const d = aaDrift(100, 110);
  assert.equal(d.abs, 10);
  assert.equal(d.ratio, 0.1);
  assert.equal(d.noisy, false);
  assert.equal(aaDrift(100, 126).noisy, true);
  assert.equal(aaDrift(0, 10).ratio, null);
  assert.equal(ratio(110, 100), 1.1);
  assert.equal(ratio(90, 100), 0.9);
});

test('F-03-6 T3 ④ 크기: 첫 HTML 스크립트와 화면·위젯 덩어리를 gzip으로 세고 이름을 알아본다', () => {
  assert.equal(chunkNameOf('/assets/main.abc123.js'), 'main');
  assert.equal(chunkNameOf('/assets/scr-029.abc123.chunk.js'), 'scr-029');
  assert.equal(chunkNameOf('/assets/scr-029-d.abc123.chunk.js'), 'scr-029-d');
  assert.equal(chunkNameOf('/assets/widgets-queue.abc123.chunk.js'), 'widgets-queue');
  assert.equal(chunkNameOf('/remotes/queue/1d10d6da3/remoteEntry.js'), 'remote:queue');
  assert.equal(chunkNameOf('/assets/999.abc.chunk.js'), null);
  const html = '<html><head><link rel="modulepreload" href="/assets/main.abc.js"></head><body><script src="/assets/main.abc.js"></script><script src="/assets/scr-029.abc.chunk.js"></script></body></html>';
  const files = {
    '/assets/main.abc.js': 'a'.repeat(4000),
    '/assets/scr-029.abc.chunk.js': 'b'.repeat(2000),
    '/assets/scr-029-d.abc.chunk.js': 'c'.repeat(1000),
    '/assets/widgets-queue.abc.chunk.js': 'd'.repeat(500),
    '/remotes/queue/1d10d6da3/remoteEntry.js': 'e'.repeat(300),
  };
  const sizes = buildSizes({ html, files, build: 'mf' });
  assert.deepEqual(sizes.initial.files, ['/assets/main.abc.js', '/assets/scr-029.abc.chunk.js']);
  assert.ok(sizes.initial.gzipKB > 0);
  const byName = Object.fromEntries(sizes.chunks.map((c) => [c.name, c.gzipKB]));
  assert.ok(byName['scr-029-d'] > 0);
  assert.ok(byName['widgets-queue'] > 0);
  assert.ok(byName['remote:queue'] > 0);
  assert.equal(byName['remote:purchase'], undefined);
});

test('F-03-6 T4 ⑤ 격리 경로: MF는 원격 폴더, 한 앱은 위젯 덩어리 하나를 막는다', () => {
  const mf = blockRule('mf', 'queue');
  assert.equal(mf.test('/remotes/queue/1d10d6da3/remoteEntry.js'), true);
  assert.equal(mf.test('/remotes/purchase/1d10d6da3/remoteEntry.js'), false);
  const single = blockRule('single', 'queue');
  assert.equal(single.test('/assets/widgets-queue.abc123.chunk.js'), true);
  assert.equal(single.test('/assets/widgets-purchase.abc123.chunk.js'), false);
  assert.throws(() => blockRule('other', 'queue'), /빌드/);
});

test('F-03-6 T5 ⑥ 다시 빌드 폴더: webpack 모듈 경로에서 작업 공간 폴더를 세고 0이면 실패다', () => {
  const folders = countFolders([
    '../../apps/console-host/src/main.tsx',
    '../../apps/widgets/queue/src/remote.ts',
    '../../apps/widgets/purchase/src/remote.ts',
    '../../packages/ds/src/components/button.tsx',
    '../../packages/console-contract/src/index.ts',
    './src/app/layout.tsx',
  ]);
  assert.deepEqual(folders, ['apps/console-host', 'apps/widgets/purchase', 'apps/widgets/queue', 'packages/console-contract', 'packages/ds']);
  assert.deepEqual(countFolders([]), []);
});
