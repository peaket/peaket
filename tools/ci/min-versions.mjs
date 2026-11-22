#!/usr/bin/env node
// 최소 판 검사(docs/devops.md §4.4 '설정이 기대는 최소 판', ADR-0356 결정 5, V-T39 ③, ASVS v5.0.0-15.2.1).
// 개인정보·보안 설정이 어느 판부터 생긴 기능에 기대면 그 판을 §4.4에 적는다. 판이 낮으면 설정이 오류 없이 조용히 먹지 않는다.
// 판 숫자는 이 파일에 적지 않는다: §4.4의 그 항목 줄에서 첫 '<판> 이상'을 읽는다.
// - Sentry JavaScript SDK: 잠금 파일(pnpm-lock.yaml)의 @sentry/* SDK 패키지 판이 모두 최소 판 이상이고 서로 같다(브라우저·서버 같은 판)
// - PgBouncer 이미지: deploy/·tools/local/ 파일의 PgBouncer 이미지 이름표가 최소 판 이상이다
// 판은 숫자 마디로 견준다(10.9.0 < 10.57.0). 정본 줄·잠금 파일을 읽지 못하면 통과로 보지 않는다.
// 쓰는 법: node tools/ci/min-versions.mjs [--root <저장소>]
//   끝 코드 0 통과, 1 위반(모두 찍는다), 2 인자 오류·정본 줄이나 잠금 파일을 읽지 못함·검사 방법이 없는 항목
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = '쓰는 법: node tools/ci/min-versions.mjs [--root <저장소>]';
const DEVOPS = 'docs/devops.md';
const LOCKFILE = 'pnpm-lock.yaml';
/** §4.4에서 항목 목록이 시작하는 줄의 표시 */
const SECTION_MARK = '**설정이 기대는 최소 판';
/** 판을 따로 매기는 @sentry 도구 패키지(JavaScript SDK가 아니다). 이것들은 SDK 판과 견주지 않는다 */
const SENTRY_NON_SDK = [/^@sentry\/conventions$/, /^@sentry\/cli(?:-.+)?$/, /^@sentry\/babel-plugin-component-annotate$/, /^@sentry\/bundler-plugin-core$/, /^@sentry\/[a-z]+-plugin$/];
/** PgBouncer 이미지 이름표를 찾는 폴더 */
const IMAGE_DIRS = ['deploy', 'tools/local'];
const TEXT_FILE = /\.(?:ya?ml|json|mjs|cjs|js|ts|tpl|txt|toml|conf|env)$|(?:^|\/)Dockerfile[^/]*$/;

/** 읽기 실패(끝 코드 2) */
class ReadError extends Error {}

/**
 * 판 두 개를 숫자 마디로 견준다. 앞의 'v'와 뒤의 꼬리(-rc.1, +빌드)는 무시하고, 빠진 마디는 0으로 본다.
 * @param {string} a @param {string} b @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  const parts = (v) => {
    const m = /^v?(\d+(?:\.\d+)*)/.exec(String(v).trim());
    if (!m) throw new ReadError(`판 번호가 아니다: ${v}`);
    return m[1].split('.').map((x) => Number(x));
  };
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** §4.4 '설정이 기대는 최소 판'의 항목들: [{ name, min, line }] */
export function readMinimums(root) {
  const file = join(root, DEVOPS);
  if (!existsSync(file)) throw new ReadError(`${DEVOPS}가 없다`);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(SECTION_MARK));
  if (start < 0) throw new ReadError(`${DEVOPS}: '설정이 기대는 최소 판' 줄을 찾지 못했다`);
  const items = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    // 들여 쓴 하위 항목만 읽는다. 들여 쓰지 않은 다음 항목·제목·빈 줄 뒤 본문에서 멈춘다
    const m = /^\s+-\s+(.*)$/.exec(l);
    if (!m) break;
    const text = m[1];
    const name = text.split(/[:(]/, 1)[0].trim();
    const min = /(\d+(?:\.\d+)+)\s*이상/.exec(text)?.[1];
    if (!min) throw new ReadError(`${DEVOPS}:${i + 1}: '${name}' 항목에 '<판> 이상'이 없다`);
    items.push({ name, min, line: i + 1 });
  }
  if (items.length === 0) throw new ReadError(`${DEVOPS}: '설정이 기대는 최소 판' 아래 항목이 없다`);
  return items;
}

/** 잠금 파일의 @sentry/* 패키지와 판: [{ name, version }] */
export function readSentryPackages(root) {
  const file = join(root, LOCKFILE);
  if (!existsSync(file)) throw new ReadError(`${LOCKFILE}이 없다`);
  const text = readFileSync(file, 'utf8');
  const pkgStart = text.search(/^packages:\s*$/m);
  if (pkgStart < 0) throw new ReadError(`${LOCKFILE}: packages: 절이 없다`);
  const keys = [...text.slice(pkgStart).matchAll(/^ {2}'?((?:@[^@'/\s]+\/)?[^@'\s(]+)@([^'(:\s]+)/gm)];
  if (keys.length === 0) throw new ReadError(`${LOCKFILE}: 패키지 항목이 하나도 없다`);
  const seen = new Map();
  for (const [, name, version] of keys) if (name.startsWith('@sentry/')) seen.set(`${name}@${version}`, { name, version });
  return [...seen.values()];
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/** deploy/·tools/local/의 PgBouncer 이미지 이름표: [{ file, line, ref, version }] */
export function readPgbouncerImages(root) {
  const found = [];
  for (const d of IMAGE_DIRS) {
    for (const p of walk(join(root, d))) {
      const rel = relative(root, p).split('\\').join('/');
      if (!TEXT_FILE.test(rel) || /\.test\.[cm]?js$/.test(rel) || statSync(p).size > 2_000_000) continue;
      const lines = readFileSync(p, 'utf8').split(/\r?\n/);
      lines.forEach((l, i) => {
        // 이미지 줄만 본다(주소의 pgbouncer:6432 같은 포트를 판으로 읽지 않게)
        if (!/image/i.test(l)) return;
        for (const m of l.matchAll(/(?:^|[\s"'=:[,])([\w.\/-]*pgbouncer[\w.-]*):(v?\d+(?:\.\d+)+)/gi)) {
          found.push({ file: rel, line: i + 1, ref: `${m[1]}:${m[2]}`, version: m[2] });
        }
      });
    }
  }
  return found;
}

/** 항목 이름마다 검사 방법 */
const CHECKS = [
  {
    match: /^Sentry\b/,
    run(root, item) {
      const pkgs = readSentryPackages(root).filter((p) => !SENTRY_NON_SDK.some((re) => re.test(p.name)));
      const out = { problems: [], seen: pkgs.map((p) => `${p.name}@${p.version}`) };
      for (const p of pkgs) {
        if (compareVersions(p.version, item.min) < 0) out.problems.push(`${LOCKFILE}: ${p.name} ${p.version}이 최소 판 ${item.min}보다 낮다(${DEVOPS}:${item.line})`);
      }
      const versions = [...new Set(pkgs.map((p) => p.version))];
      if (versions.length > 1) {
        out.problems.push(`${LOCKFILE}: @sentry SDK 판이 서로 다르다(${pkgs.map((p) => `${p.name} ${p.version}`).join(', ')}). 브라우저와 서버는 같은 판이어야 한다(${DEVOPS}:${item.line})`);
      }
      return out;
    },
  },
  {
    match: /^PgBouncer\b/,
    run(root, item) {
      const images = readPgbouncerImages(root);
      const out = { problems: [], seen: images.map((x) => `${x.file}:${x.line} ${x.ref}`) };
      for (const x of images) {
        if (compareVersions(x.version, item.min) < 0) out.problems.push(`${x.file}:${x.line}: PgBouncer 이미지 ${x.ref}가 최소 판 ${item.min}보다 낮다(${DEVOPS}:${item.line})`);
      }
      return out;
    },
  },
];

/** 위반 목록(빈 배열이면 통과). 읽기 실패와 검사 방법이 없는 항목은 ReadError로 던진다 */
export function checkMinVersions(root) {
  return runChecks(root).problems;
}

function runChecks(root) {
  const items = readMinimums(root);
  const problems = [];
  const report = [];
  for (const item of items) {
    const check = CHECKS.find((c) => c.match.test(item.name));
    if (!check) throw new ReadError(`${DEVOPS}:${item.line}: '${item.name}' 항목을 볼 방법이 이 검사에 없다(tools/ci/min-versions.mjs의 CHECKS에 더한다)`);
    const r = check.run(root, item);
    problems.push(...r.problems);
    report.push(`${item.name} ${item.min} 이상: ${r.seen.length ? r.seen.join(', ') : '없음'}`);
  }
  return { problems, report };
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) root = resolve(argv[++i]);
    else {
      console.error(`min-versions: 모르는 인자 ${argv[i]}\n${USAGE}`);
      return 2;
    }
  }
  let result;
  try {
    result = runChecks(root);
  } catch (e) {
    if (e instanceof ReadError) {
      console.error(`min-versions: 읽지 못했다(통과로 보지 않는다): ${e.message}`);
      return 2;
    }
    throw e;
  }
  for (const r of result.report) console.log(`min-versions: ${r}`);
  if (result.problems.length) {
    console.error(`min-versions: 최소 판 위반 ${result.problems.length}건`);
    for (const p of result.problems) console.error(`막음: ${p}`);
    return 1;
  }
  console.log('min-versions: 통과');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
