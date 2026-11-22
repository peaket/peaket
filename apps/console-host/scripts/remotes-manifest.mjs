// 원격 목록 만들기·원격 산출물 검사(docs/frontend.md §4.5·§5.8 관제 줄, OPS-350, ADR-0361 결정 2~4·11).
// - 원격 빌드는 dist/remotes/<이름>/<sha>/remoteEntry.js 한 파일을 낸다(webpack.config.mjs). 이 스크립트가 그 바이트의 sha384를 계산해
//   원격 목록 [{name, sha, entry, integrity, contractMajor}]을 쓴다(기본 dist/remotes.json). 호스트는 이 목록의 무결성 값으로만 원격을 싣는다.
// - --remote <이름>: 그 원격 하나만 보고 목록 조각(dist/remotes-<이름>.json, 항목 하나짜리 배열)을 쓴다(공용 워크플로 build-remote.yml).
// - --check: 원격 sha 폴더가 remoteEntry.js 한 파일인지, gzip 크기가 --max-gzip(기본 80KB [가정], frontend §5.8 관제 '원격마다')를 넘지 않는지,
//   공유 싱글턴(react·계약 패키지)의 사본이 원격에 들지 않았는지 본다. 틀리면 끝 코드 1.
// - 개발 서버는 remotesJsonMiddleware로 메모리에 빌드한 원격 바이트에서 그 순간의 목록을 내준다(무결성을 끄는 개발 갈래를 두지 않는다).
// sha: PEAKET_REMOTE_SHA → GITHUB_SHA → git HEAD(원격 폴더·계약 패키지에 커밋 안 한 변경이 없을 때) → 원천 파일 내용의 sha256. 앞 12자.
//   실행: node scripts/remotes-manifest.mjs [--remote <이름>] [--out <파일>] [--check] [--max-gzip <바이트>]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(dirname, '..');
const repoRoot = path.join(appDir, '../..');
const CONTRACT_DIR = path.join(repoRoot, 'packages/console-contract');

/** 원격 이름 → 원천 폴더(webpack.config.mjs REMOTES와 같다) */
export const REMOTE_DIRS = { queue: path.join(repoRoot, 'apps/widgets/queue'), purchase: path.join(repoRoot, 'apps/widgets/purchase') };

/** 원격 gzip 상한 80KB [가정](docs/frontend.md §5.8 관제 콘솔 '원격마다 80KB') */
export const REMOTE_MAX_GZIP = 80_000;

const SHA = /^[0-9a-f]{7,40}$/;

/** 계약 패키지 판(package.json version). 큰 수가 계약 판이다 */
export function contractVersion() {
  return JSON.parse(readFileSync(path.join(CONTRACT_DIR, 'package.json'), 'utf8')).version;
}

/** 계약 판(계약 패키지 판의 큰 수, @peaket/console-contract CONTRACT_MAJOR와 같다) */
export const CONTRACT_MAJOR = Number(contractVersion().split('.')[0]);

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules') out.push(...walk(p));
    } else out.push(p);
  }
  return out;
}

/** 원격 원천(그 원격 src·package.json과 계약 패키지 src·package.json) 내용의 sha256 앞 12자 */
function sourceDigest(name) {
  const h = createHash('sha256');
  for (const root of [REMOTE_DIRS[name], CONTRACT_DIR]) {
    for (const f of [path.join(root, 'package.json'), ...walk(path.join(root, 'src'))]) {
      if (!existsSync(f)) continue;
      h.update(path.relative(repoRoot, f).split(path.sep).join('/'));
      h.update('\0');
      h.update(readFileSync(f));
      h.update('\0');
    }
  }
  return h.digest('hex').slice(0, 12);
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

/** 원격 경로의 sha(앞 12자). 같은 바이트는 같은 경로, 다른 바이트는 다른 경로가 되게 고른다 */
export function remoteSha(name, env = process.env) {
  const given = (env.PEAKET_REMOTE_SHA || env.GITHUB_SHA || '').toLowerCase();
  if (given) {
    if (!SHA.test(given)) throw new TypeError(`PEAKET_REMOTE_SHA·GITHUB_SHA가 16진 7~40자가 아니다: ${given}`);
    return given.slice(0, 12);
  }
  const head = git(['rev-parse', 'HEAD']);
  if (head && SHA.test(head)) {
    const dirty = git(['status', '--porcelain', '--', path.relative(repoRoot, REMOTE_DIRS[name]), path.relative(repoRoot, CONTRACT_DIR)]);
    if (dirty === '') return head.slice(0, 12);
  }
  return sourceDigest(name);
}

/** SRI 값(sha384-<base64>) */
export function integrityOf(bytes) {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

/** dist/remotes/<이름>/ 아래 sha 폴더(정확히 하나여야 한다) */
function shaDirs(fs, distRemotes, name) {
  const dir = path.join(distRemotes, name);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => SHA.test(String(d)) && fs.existsSync(path.join(dir, String(d), 'remoteEntry.js')));
}

/**
 * 빌드한 원격의 목록 항목을 만든다
 * @param {{ dist: string, names?: string[], fs?: { existsSync(p: string): boolean, readdirSync(p: string): string[], readFileSync(p: string): Buffer } }} o
 */
export function manifestEntries(o) {
  const fs = o.fs ?? { existsSync, readdirSync, readFileSync };
  const distRemotes = path.join(o.dist, 'remotes');
  const names = o.names ?? (fs.existsSync(distRemotes) ? fs.readdirSync(distRemotes).map(String).filter((n) => n in REMOTE_DIRS).sort() : []);
  return names.map((name) => {
    const dirs = shaDirs(fs, distRemotes, name);
    if (dirs.length !== 1) throw new Error(`원격 ${name}의 sha 폴더가 하나가 아니다: [${dirs.join(', ')}](원격 빌드를 다시 한다)`);
    const sha = String(dirs[0]);
    const bytes = fs.readFileSync(path.join(distRemotes, name, sha, 'remoteEntry.js'));
    return { name, sha, entry: `/remotes/${name}/${sha}/remoteEntry.js`, integrity: integrityOf(bytes), contractMajor: CONTRACT_MAJOR };
  });
}

/** 원격 산출물 검사(한 파일·크기·공유 싱글턴 사본). 문제 목록을 돌려준다 */
export function checkRemote(dist, name, { maxGzip = REMOTE_MAX_GZIP } = {}) {
  const problems = [];
  const distRemotes = path.join(dist, 'remotes');
  const dirs = shaDirs({ existsSync, readdirSync, readFileSync }, distRemotes, name);
  if (dirs.length !== 1) return [`${name}: sha 폴더가 하나가 아니다(${dirs.length})`];
  const shaDir = path.join(distRemotes, name, dirs[0]);
  const files = readdirSync(shaDir);
  if (files.length !== 1 || files[0] !== 'remoteEntry.js') problems.push(`${name}: sha 폴더가 remoteEntry.js 한 파일이 아니다: ${files.join(', ')}`);
  const bytes = readFileSync(path.join(shaDir, 'remoteEntry.js'));
  const gz = gzipSync(bytes, { level: 9 }).length;
  if (gz > maxGzip) problems.push(`${name}: gzip ${gz}바이트가 상한 ${maxGzip}바이트를 넘는다`);
  const text = bytes.toString('utf8');
  // react 본체(19)의 내부 칸 이름과 계약 패키지의 오류 글자: 있으면 공유 싱글턴 사본이 원격에 들었다
  if (text.includes('__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE')) problems.push(`${name}: react 사본이 들었다(공유 싱글턴 import: false)`);
  if (text.includes('위젯 이름은 케밥 표기여야 한다')) problems.push(`${name}: @peaket/console-contract 사본이 들었다(공유 싱글턴 import: false)`);
  return problems;
}

/**
 * 개발 서버 미들웨어: 메모리에 빌드한 원격 바이트로 /remotes.json을 내준다
 * @param {{ middleware?: { waitUntilValid(cb: () => void): void, context: { outputFileSystem: unknown } } }} server webpack-dev-server
 * @param {string} dist 산출물 폴더(메모리 파일 체계 안의 경로)
 */
export function remotesJsonMiddleware(server, dist) {
  return (_req, res) => {
    const send = () => {
      try {
        const fs = server.middleware.context.outputFileSystem;
        const body = JSON.stringify(manifestEntries({ dist, fs }));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(body);
      } catch (e) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(String(e instanceof Error ? e.message : e));
      }
    };
    if (server.middleware?.waitUntilValid) server.middleware.waitUntilValid(send);
    else send();
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({
    options: { remote: { type: 'string' }, out: { type: 'string' }, dist: { type: 'string' }, check: { type: 'boolean' }, 'max-gzip': { type: 'string' } },
  });
  const dist = path.resolve(values.dist ?? path.join(appDir, 'dist'));
  if (!existsSync(path.join(dist, 'remotes'))) {
    // 한 앱 빌드(PEAKET_CONSOLE_BUILD=single)·SEED CSS PoC 빌드는 원격이 없다
    console.log('원격 산출물이 없다(한 앱 빌드): 원격 목록을 쓰지 않는다');
    process.exit(0);
  }
  const names = values.remote ? [values.remote] : undefined;
  if (values.remote && !(values.remote in REMOTE_DIRS)) {
    console.error(`모르는 원격: ${values.remote}`);
    process.exit(1);
  }
  const entries = manifestEntries({ dist, ...(names ? { names } : {}) });
  if (values.check) {
    const maxGzip = values['max-gzip'] ? Number(values['max-gzip']) : REMOTE_MAX_GZIP;
    const problems = entries.flatMap((e) => checkRemote(dist, e.name, { maxGzip }));
    for (const p of problems) console.error(p);
    if (problems.length > 0) process.exit(1);
  }
  const out = path.resolve(values.out ?? (values.remote ? path.join(dist, `remotes-${values.remote}.json`) : path.join(dist, 'remotes.json')));
  writeFileSync(out, `${JSON.stringify(entries, null, 2)}\n`);
  for (const e of entries) console.log(`${e.name} ${e.entry} ${e.integrity}`);
}
