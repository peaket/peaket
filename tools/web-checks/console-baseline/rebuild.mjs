// F-03-6(FE-T29) ④ 위젯 하나를 고쳐 다시 내보내는 시간과 폴더 수.
// - MF: 대기열 원격 하나만 다시 빌드하고 원격 목록(sha384)을 다시 쓴 뒤 정적 자리로 복사한다. 폴더 수는 원격 소스 1.
// - 한 앱: 호스트 전체를 다시 빌드한다. 폴더 수는 webpack 통계의 모듈 경로에서 apps/*·packages/* 첫 마디를 센다.
// - 소스는 apps/widgets/queue/src/AdmissionRateRemote.tsx의 화면 글 한 줄을 바꿨다가 finally에서 바이트 그대로 되돌린다.
//   git에서 더러운 파일이면 ④를 미측정으로 남기고 멈춘다(남의 변경을 건드리지 않는다).
// 실행: node console-baseline/rebuild.mjs --runs 3
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { countFolders, median, nearestRank } from './lib.mjs';
import { REPO, REPORT_ROOT } from './stage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = 'apps/widgets/queue/src/AdmissionRateRemote.tsx';
const SOURCE_TEXT = '입장 비율·빈자리';
const DIST = path.join(REPO, 'apps/console-host/dist');

const { values } = parseArgs({ options: { runs: { type: 'string', default: '3' }, out: { type: 'string' } } });
const RUNS = Number(values.runs);
if (!Number.isInteger(RUNS) || RUNS < 3) throw new Error('--runs는 3 이상의 정수여야 한다');

const sha = (b) => createHash('sha256').update(b).digest('hex');

function run(command, env = {}) {
  const started = performance.now();
  const r = spawnSync(command, { cwd: REPO, env: { ...process.env, ...env }, encoding: 'utf8', shell: true, maxBuffer: 512 * 1024 * 1024, timeout: 15 * 60_000 });
  if (r.status !== 0) throw new Error(`명령 실패(${r.status}${r.error ? `, ${r.error.message}` : ''}): ${command}\n${String(r.stderr ?? '').split(/\r?\n/).slice(-10).join('\n')}`);
  return { ms: performance.now() - started, stdout: r.stdout };
}

function assertClean() {
  const r = spawnSync('git', ['status', '--porcelain', '--', SOURCE], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git status 실패: ${r.stderr}`);
  if (r.stdout.trim() !== '') throw new Error(`${SOURCE}에 미커밋 변경이 있어 ④를 재지 않는다(남의 변경을 건드리지 않는다)`);
}

function mutate(original) {
  const text = original.toString('utf8');
  const at = text.indexOf(SOURCE_TEXT);
  if (at < 0) throw new Error(`바꿀 글자를 찾지 못했다: ${SOURCE_TEXT}`);
  return Buffer.from(text.slice(0, at) + `${SOURCE_TEXT}(F-03-6 측정)` + text.slice(at + SOURCE_TEXT.length), 'utf8');
}

function foldersFromJson(stdout) {
  const base = ['apps/console-host', 'apps/widgets/queue', 'apps/widgets/purchase'];
  try {
    const stats = JSON.parse(stdout);
    const names = (stats.modules ?? []).map((m) => m.name ?? m.identifier).filter((x) => typeof x === 'string');
    return [...new Set([...base, ...countFolders(names)])].sort();
  } catch {
    return base;
  }
}

function main() {
  const out = values.out ?? path.join(REPORT_ROOT, 'rebuild');
  mkdirSync(out, { recursive: true });
  assertClean();
  const file = path.join(REPO, SOURCE);
  const original = readFileSync(file);
  const before = sha(original);
  const records = [];
  try {
    for (let i = 0; i < RUNS; i++) {
      writeFileSync(file, mutate(original));
      try {
        const build = run('corepack pnpm --filter @peaket/console-host exec webpack --mode production --config-name remote-queue');
        const manifest = run('node apps/console-host/scripts/remotes-manifest.mjs');
        const target = path.join(out, `mf-${i + 1}`);
        rmSync(target, { recursive: true, force: true });
        cpSync(DIST, target, { recursive: true, filter: (src) => !src.endsWith('.map') && path.basename(src) !== 'maps' });
        records.push({ build: 'mf', run: i + 1, ok: true, ms: Math.round(build.ms + manifest.ms), folders: ['apps/widgets/queue'], steps: ['remote-queue', 'remotes-manifest', 'copy'], target });
      } finally {
        writeFileSync(file, original);
      }
    }
    // 폴더 수는 따로 한 번(시간에 넣지 않는다): --json 통계가 빌드 시간을 늘리기 때문이다
    writeFileSync(file, mutate(original));
    let singleFolders;
    try {
      const statsDir = path.join(out, 'stats-single');
      rmSync(statsDir, { recursive: true, force: true });
      const s = run(`corepack pnpm --filter @peaket/console-host exec webpack --mode production --json --output-path "${statsDir}"`, { PEAKET_CONSOLE_BUILD: 'single' });
      singleFolders = foldersFromJson(s.stdout);
    } finally {
      writeFileSync(file, original);
    }
    for (let i = 0; i < RUNS; i++) {
      writeFileSync(file, mutate(original));
      try {
        const target = path.join(out, `single-${i + 1}`);
        rmSync(target, { recursive: true, force: true });
        const r = run(`corepack pnpm --filter @peaket/console-host exec webpack --mode production --output-path "${target}"`, { PEAKET_CONSOLE_BUILD: 'single' });
        records.push({ build: 'single', run: i + 1, ok: true, ms: Math.round(r.ms), folders: singleFolders, foldersSource: 'webpack-stats', steps: ['host'], target });
      } finally {
        writeFileSync(file, original);
      }
    }
  } finally {
    writeFileSync(file, original);
    const after = sha(readFileSync(file));
    if (after !== before) throw new Error(`소스 되돌리기 해시가 다르다: ${before} → ${after}`);
  }
  if (records.length !== RUNS * 2) throw new Error(`다시 빌드 기록이 모자란다: ${records.length}/${RUNS * 2}`);
  const groups = {};
  for (const build of ['mf', 'single']) {
    const xs = records.filter((r) => r.build === build).map((r) => r.ms);
    groups[build] = { runs: xs.length, median: median(xs), p75: nearestRank(xs, 0.75), values: xs, folders: records.find((r) => r.build === build)?.folders ?? [] };
  }
  const report = { commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(), runs: RUNS, records, groups, sourceRestored: true };
  writeFileSync(path.join(out, 'rebuild.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`다시 빌드: MF 중앙값 ${groups.mf.median}ms, 한 앱 중앙값 ${groups.single.median}ms (${out})`);
}

main();
