// F-03-6(FE-T29) 세 묶음(aa1·aa2·single)과 크기·격리·다시 빌드 결과를 합쳐 summary.json·bench-summary.json·summary.md를 쓴다.
// A/A는 MF 대 MF 중앙값 차이, 비교는 single÷mf 비율이다. 판정은 하지 않고 '바꿀 조건에 닿았는지'만 notes에 적는다.
// 실행: node console-baseline/combine.mjs --aa1 <폴더> --aa2 <폴더> --single <폴더> --out <폴더>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { aaDrift, median, nearestRank, ratio, validateResult } from './lib.mjs';
import { REPORT_ROOT } from './stage.mjs';

const { values } = parseArgs({
  options: {
    aa1: { type: 'string' },
    aa2: { type: 'string' },
    single: { type: 'string' },
    out: { type: 'string' },
  },
});
if (!values.aa1 || !values.aa2 || !values.single) throw new Error('--aa1 --aa2 --single 폴더가 필요하다');
const out = values.out ?? path.join(REPORT_ROOT, 'summary');
mkdirSync(out, { recursive: true });

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const loadResult = (dir) => readJson(path.join(dir, 'result.json'));
const aa1 = loadResult(values.aa1);
const aa2 = loadResult(values.aa2);
const single = loadResult(values.single);
const sizesMf = readJson(path.join(REPORT_ROOT, 'sizes-mf.json'));
const sizesSingle = readJson(path.join(REPORT_ROOT, 'sizes-single.json'));
const isolation = ['mf', 'single'].map((b) => readJson(path.join(REPORT_ROOT, `isolation-${b}.json`)));
const rebuild = readJson(path.join(REPORT_ROOT, 'rebuild', 'rebuild.json'));

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const vals = (result, phase, key) => result.runs.map((r) => r?.[phase]?.[key]).filter(finite);

/** 한 묶음의 중앙값·p75 */
function group(result) {
  const one = (phase) => ({
    ready: { median: median(vals(result, phase, 'readyMs')), p75: nearestRank(vals(result, phase, 'readyMs'), 0.75) },
    fcp: { median: median(vals(result, phase, 'fcpMs')), p75: nearestRank(vals(result, phase, 'fcpMs'), 0.75) },
    lcp: { median: median(vals(result, phase, 'lcpMs')), p75: nearestRank(vals(result, phase, 'lcpMs'), 0.75) },
    inp: { median: median(vals(result, phase, 'inpMs')), p75: nearestRank(vals(result, phase, 'inpMs'), 0.75) },
  });
  const remote = (name) => {
    const xs = result.runs.map((r) => r?.cold?.remoteLoadMs?.[name]).filter(finite);
    return xs.length ? { median: median(xs), p75: nearestRank(xs, 0.75) } : null;
  };
  return {
    label: result.label,
    build: result.build,
    runs: result.runs.length,
    cold: one('cold'),
    warm: one('warm'),
    remoteLoad: { queue: remote('queue'), purchase: remote('purchase') },
    stubRequests: result.stub?.requests ?? 0,
  };
}

const g = { aa1: group(aa1), aa2: group(aa2), single: group(single) };

/** A/A 흔들림과 single÷mf 비율 */
const compare = (a, b) => ({ a, b, drift: aaDrift(a, b), ratio: b > 0 ? ratio(a, b) : null });
const aa = {
  readyCold: compare(g.aa1.cold.ready.median, g.aa2.cold.ready.median),
  readyWarm: compare(g.aa1.warm.ready.median, g.aa2.warm.ready.median),
  fcpCold: compare(g.aa1.cold.fcp.median, g.aa2.cold.fcp.median),
  lcpCold: compare(g.aa1.cold.lcp.median, g.aa2.cold.lcp.median),
};
const mfReadyCold = g.aa1.cold.ready.median;
const mfReadyWarm = g.aa1.warm.ready.median;
const readyRatio = {
  cold: mfReadyCold > 0 ? ratio(g.single.cold.ready.median, mfReadyCold) : null,
  warm: mfReadyWarm > 0 ? ratio(g.single.warm.ready.median, mfReadyWarm) : null,
};

const chunkMap = (s) => Object.fromEntries(s.chunks.map((c) => [c.name, c.gzipKB]));
const mfChunks = chunkMap(sizesMf);
const singleChunks = chunkMap(sizesSingle);
const chunkRows = [...new Set([...Object.keys(mfChunks), ...Object.keys(singleChunks)])].sort().map((name) => ({
  name,
  mfKB: mfChunks[name] ?? null,
  singleKB: singleChunks[name] ?? null,
  ratio: mfChunks[name] && singleChunks[name] ? Math.round((singleChunks[name] / mfChunks[name]) * 1000) / 1000 : null,
}));

const validity = [];
for (const [name, result] of [['aa1', aa1], ['aa2', aa2], ['single', single]]) {
  const v = validateResult(result);
  if (!v.ok) validity.push(`${name}: ${v.reasons.join('; ')}`);
}
for (const iso of isolation) {
  if (!Array.isArray(iso.runs) || iso.runs.length !== 3 || iso.runs.some((r) => r.ok !== true)) validity.push(`격리 ${iso.build}: 3회 모두 통과가 아니다`);
}
for (const build of ['mf', 'single']) {
  const records = rebuild.records.filter((r) => r.build === build);
  if (records.length !== rebuild.runs || records.some((r) => r.ok !== true || !(r.ms > 0))) validity.push(`다시 빌드 ${build}: 3회 기록이 아니다`);
}

const firstJsMf = sizesMf.loaded?.gzipKB ?? sizesMf.initial.gzipKB;
const firstJsSingle = sizesSingle.loaded?.gzipKB ?? sizesSingle.initial.gzipKB;
const firstJSRatio = firstJsMf > 0 ? Math.round((firstJsSingle / firstJsMf) * 1000) / 1000 : null;
const rebuildRatio = rebuild.groups.mf.median > 0 ? Math.round((rebuild.groups.single.median / rebuild.groups.mf.median) * 1000) / 1000 : null;
const notes = [
  `MF A/A 첫 그림(빈) ${Math.round((aa.readyCold.drift.ratio ?? 0) * 1000) / 10}%·(채운) ${Math.round((aa.readyWarm.drift.ratio ?? 0) * 1000) / 10}%`,
  `MF 첫 그림 중앙값(빈/채운) ${g.aa1.cold.ready.median}/${g.aa1.warm.ready.median}ms, 한 앱 ${g.single.cold.ready.median}/${g.single.warm.ready.median}ms`,
  `첫 JS ${firstJsMf}/${firstJsSingle}kB(한 앱÷MF ${firstJSRatio})`,
  `다시 빌드 중앙값 ${rebuild.groups.mf.median}/${rebuild.groups.single.median}ms(한 앱÷MF ${rebuildRatio}), 폴더 ${rebuild.groups.mf.folders.length}/${rebuild.groups.single.folders.length}`,
  `바꿀 조건(p75 300ms·첫 JS 20%)은 기록만 한다(정본 FE-T29)`,
].join('; ');

const summary = {
  kpi: 'FE-T29',
  measuredAt: new Date().toISOString(),
  commit: aa1.commit,
  chrome: aa1.chrome,
  cpuThrottle: aa1.cpuThrottle,
  viewport: aa1.viewport,
  path: aa1.path,
  groups: g,
  aa: Object.fromEntries(Object.entries(aa).map(([k, v]) => [k, { a: v.a, b: v.b, drift: v.drift }])),
  readyRatio,
  sizes: {
    mf: { initial: sizesMf.initial, loaded: sizesMf.loaded, chunks: sizesMf.chunks },
    single: { initial: sizesSingle.initial, loaded: sizesSingle.loaded, chunks: sizesSingle.chunks },
    firstJSRatio,
    chunks: chunkRows,
  },
  isolation: isolation.map((x) => ({ build: x.build, runs: x.runs.length, ok: x.runs.every((r) => r.ok === true) })),
  rebuild: { groups: rebuild.groups, ratio: rebuildRatio },
  notes,
  valid: validity.length === 0,
  invalidReasons: validity,
};

const runCount = aa1.runs.length * 2 * 3;
const invalidRuns = [aa1, aa2, single].filter((r) => !validateResult(r).ok).length * 3;
const bench = {
  bench: {
    p99_ms: null,
    error_rate: Math.round((invalidRuns / 9) * 1000) / 1000,
    requests: runCount,
    dropped: invalidRuns,
  },
  summary,
};

writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(path.join(out, 'bench-summary.json'), `${JSON.stringify(bench, null, 2)}\n`);
const md = [
  '# F-03-6(FE-T29) 요약',
  '',
  `- 커밋: ${summary.commit}`,
  `- 브라우저: ${summary.chrome}, CPU ${summary.cpuThrottle}배, ${summary.viewport.width}×${summary.viewport.height}`,
  `- 화면: ${summary.path}`,
  '',
  '| 묶음 | 첫 그림 빈(중앙값/p75) | 첫 그림 채운(중앙값/p75) | FCP 빈 | LCP 빈 | INP 대리 빈 |',
  '| --- | --- | --- | --- | --- | --- |',
  `| MF A/A 1 | ${g.aa1.cold.ready.median}/${g.aa1.cold.ready.p75}ms | ${g.aa1.warm.ready.median}/${g.aa1.warm.ready.p75}ms | ${g.aa1.cold.fcp.median}ms | ${g.aa1.cold.lcp.median}ms | ${g.aa1.cold.inp.median}ms |`,
  `| MF A/A 2 | ${g.aa2.cold.ready.median}/${g.aa2.cold.ready.p75}ms | ${g.aa2.warm.ready.median}/${g.aa2.warm.ready.p75}ms | ${g.aa2.cold.fcp.median}ms | ${g.aa2.cold.lcp.median}ms | ${g.aa2.cold.inp.median}ms |`,
  `| 한 앱 | ${g.single.cold.ready.median}/${g.single.cold.ready.p75}ms | ${g.single.warm.ready.median}/${g.single.warm.ready.p75}ms | ${g.single.cold.fcp.median}ms | ${g.single.cold.lcp.median}ms | ${g.single.cold.inp.median}ms |`,
  '',
  `- A/A 흔들림(첫 그림 빈/채운): ${(aa.readyCold.drift.ratio * 100).toFixed(1)}% / ${(aa.readyWarm.drift.ratio * 100).toFixed(1)}%`,
  `- 한 앱÷MF 첫 그림(빈/채운): ${readyRatio.cold?.toFixed(3) ?? '-'} / ${readyRatio.warm?.toFixed(3) ?? '-'}`,
  `- 첫 JS: MF ${firstJsMf}kB, 한 앱 ${firstJsSingle}kB (${firstJSRatio})`,
  `- 다시 빌드 중앙값: MF ${rebuild.groups.mf.median}ms, 한 앱 ${rebuild.groups.single.median}ms (${rebuildRatio})`,
  `- 격리: ${summary.isolation.map((x) => `${x.build} ${x.runs}회 ${x.ok ? '통과' : '실패'}`).join(', ')}`,
  `- 유효: ${summary.valid ? '예' : '아니오'}${summary.invalidReasons.length ? ` — ${summary.invalidReasons.join('; ')}` : ''}`,
  '',
  '판정이 아니라 기록이다. 바꿀 조건에 닿았는지는 위 숫자와 정본 FE-T29를 보고 소유자가 정한다.',
  '',
].join('\n');
writeFileSync(path.join(out, 'summary.md'), md);
console.log(`요약: ${out} (유효=${summary.valid})`);
if (!summary.valid) process.exitCode = 1;
