#!/usr/bin/env node
// 규칙 모델 검사 도구(Apalache 묶음 안의 TLC, Quint Rust 평가기)를 고정 판·고정 해시로 받는다(wbs 0.9.1, docs/verification.md §2.2).
// - Quint는 처음 쓸 때 이 둘을 GitHub에서 해시 확인 없이 받는다. 그래서 먼저 이 스크립트로 받아 Quint가 찾는 자리(QUINT_HOME)에 둔다.
//   자리가 차 있으면 Quint는 다시 받지 않는다(Quint 0.33.1 dist/src/apalache.js·rust/binaryManager.js)
// - 해시: 압축 파일은 GitHub 릴리스 자산 다이제스트(2026-11-02 받음), 푼 것은 그 압축을 풀어 잰 값이다. Apalache는 폴더 전체
//   (Quint가 띄우는 bin/apalache-mc와 TLC가 든 lib/apalache.jar 포함)의 해시, 평가기는 실행 파일 해시다.
//   받아 둔 것은 쓸 때마다 다시 본다(옆 파일을 믿지 않는다, tools/local/tools.mjs와 같은 생각, 코드 리뷰 2026-11-02)
// - 받는 곳은 공식 배포 주소(https)뿐이다. 외부 계정은 필요 없다
// 쓰는 법: node tools/spec-check/fetch-tools.mjs   → 받은 apalache.jar·평가기 경로를 찍는다(QUINT_HOME 기본 ~/.quint)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EV = 'https://github.com/quint-co/quint/releases/download/evaluator/v0.7.1/quint_evaluator-';

export const PINS = {
  // package.json의 Quint 판. 판을 올리면 아래 Apalache·평가기 판도 그 판의 dist가 찾는 값으로 바꾼다
  quint: '0.33.1',
  apalache: {
    version: '0.62.4',
    url: 'https://github.com/apalache-mc/apalache/releases/download/v0.62.4/apalache.tgz',
    sha256: '8ac8488422c30d552735bae11b92a2d014d8e02e8608702acc08f9a2d8a9abb2',
    // 푼 apalache/ 폴더 전체(treeHash). apalache.jar 하나는 e5223915507b65cc5f1638bd037ede60f8a4fc1644aff46355779f9b05df9262
    treeSha256: '1d0ad7726196f5f67566b97b331f5b60a0f42d5aeeba3bb8a335b45ce92fd82f',
  },
  evaluator: {
    version: 'v0.7.1',
    assets: {
      'linux-x64': { url: `${EV}x86_64-unknown-linux-gnu.tar.gz`, sha256: 'ce0502bdef65dc26c242a9e56379a9bb26de6f3db38f0e3989339d46a542f5eb', innerSha256: '1764f11e8c1a9f644af5c934e9a71645b313f82f8db1284965866a2f417da9aa' },
      'linux-arm64': { url: `${EV}aarch64-unknown-linux-gnu.tar.gz`, sha256: '706819d56eb2153a12b7d3c07b5060917cf5f4431bf5069f998f9ff1e97c4388', innerSha256: 'd63d72c13e7664665e6397d6859668651ad7bdbaaa0fe3c408313ca74a8fe741' },
      'darwin-x64': { url: `${EV}x86_64-apple-darwin.tar.gz`, sha256: 'b4c2a706cad360151d08b5ce1577e23859a47b4e16ad11e53dbe8de7e5c450ca', innerSha256: 'c9e16a06d1f6140664d82150931225d9333b91696a269ba1951866a55d9554fd' },
      'darwin-arm64': { url: `${EV}aarch64-apple-darwin.tar.gz`, sha256: '62a7b5226bbc73c738cce94a265b1f87d062e3d1b30a16f7210132f00d8b95b2', innerSha256: 'c918492321c1f1db0be02477e4520c4c29ecb42afeaaaefed87b36f16fc21dd8' },
      'win32-x64': { url: `${EV}x86_64-pc-windows-msvc.zip`, sha256: '99832f761f14efe547a17c83122dddf27d9efd69d6169ce1eb5d72ef2d93692a', innerSha256: '50dee18a31682891160aa46de65a7973fdcbd2ae531dfe64379347444dee298d' },
    },
  },
};

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const fileHash = (f) => (existsSync(f) ? sha256(readFileSync(f)) : null);

/** 폴더 해시: 모든 파일의 '상대 경로(/로 이음) 내용 해시' 줄을 경로 순으로 이은 것의 SHA-256. 폴더가 없으면 null */
export function treeHash(dir) {
  if (!existsSync(dir)) return null;
  const lines = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else lines.push(`${r} ${sha256(readFileSync(join(d, e.name)))}\n`);
    }
  };
  walk(dir, '');
  return sha256(lines.sort().join(''));
}

/** 이 플랫폼의 평가기 자산과 실행 파일 이름. 표에 없으면 던진다 */
export function pickEvaluator(platform = process.platform, arch = process.arch, pins = PINS) {
  const a = pins.evaluator.assets[`${platform}-${arch}`];
  if (!a) throw new Error(`지원하지 않는 플랫폼: quint_evaluator ${platform}-${arch}`);
  return { ...a, exe: platform === 'win32' ? 'quint_evaluator.exe' : 'quint_evaluator', archive: a.url.endsWith('.zip') ? 'zip' : 'tar.gz' };
}

async function httpsDownload(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`받기 실패: ${url} HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// 푸는 도구는 받을 자산의 플랫폼이 아니라 이 컴퓨터의 것이다. Windows 10 이후의 시스템 tar(bsdtar)는 zip도 푼다.
// PATH 앞의 Git Bash tar(GNU)는 zip과 드라이브 문자 경로를 못 다뤄 시스템 것을 콕 집는다
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

async function fetchChecked(url, want, download) {
  if (!url.startsWith('https://')) throw new Error(`https 주소만 받는다: ${url}`);
  const bytes = await download(url);
  if (sha256(bytes) !== want) throw new Error(`해시가 맞지 않는다: ${url}`);
  return bytes;
}

function unpack(bytes, archive, parent) {
  const work = mkdtempSync(join(parent, 'unpack-'));
  const file = join(work, `a.${archive}`);
  writeFileSync(file, bytes);
  execFileSync(TAR, archive === 'zip' ? ['-xf', file, '-C', work] : ['-xzf', file, '-C', work], { stdio: 'ignore' });
  rmSync(file);
  return work;
}

/**
 * Apalache 묶음과 평가기를 Quint가 찾는 자리에 둔다. 핵심 파일 해시가 맞으면 받지 않는다.
 * @returns {{ apalacheJar: string, evaluator: string, home: string }}
 */
export async function ensureQuintTools(o = {}) {
  const { pins = PINS, platform = process.platform, arch = process.arch, download = httpsDownload } = o;
  const home = o.home ?? process.env.QUINT_HOME ?? join(homedir(), '.quint');

  // Apalache: QUINT_HOME/apalache-dist-<판>/apalache/{bin,lib}
  const dist = join(home, `apalache-dist-${pins.apalache.version}`);
  const jar = join(dist, 'apalache', 'lib', 'apalache.jar');
  if (treeHash(join(dist, 'apalache')) !== pins.apalache.treeSha256) {
    const bytes = await fetchChecked(pins.apalache.url, pins.apalache.sha256, download);
    mkdirSync(dist, { recursive: true });
    const work = unpack(bytes, 'tar.gz', dist);
    try {
      if (treeHash(join(work, 'apalache')) !== pins.apalache.treeSha256) throw new Error(`푼 apalache 폴더 해시가 맞지 않는다: ${pins.apalache.url}`);
      rmSync(join(dist, 'apalache'), { recursive: true, force: true });
      renameSync(join(work, 'apalache'), join(dist, 'apalache'));
      if (platform !== 'win32') chmodSync(join(dist, 'apalache', 'bin', 'apalache-mc'), 0o755);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  // 평가기: QUINT_HOME/rust-evaluator-<판>/quint_evaluator(.exe)
  const a = pickEvaluator(platform, arch, pins);
  const evDir = join(home, `rust-evaluator-${pins.evaluator.version}`);
  const exe = join(evDir, a.exe);
  if (fileHash(exe) !== a.innerSha256) {
    if (!a.url.startsWith('https://')) throw new Error(`https 주소만 받는다: ${a.url}`);
    const bytes = await fetchChecked(a.url, a.sha256, download);
    mkdirSync(evDir, { recursive: true });
    const work = unpack(bytes, a.archive, evDir);
    try {
      const body = readFileSync(join(work, a.exe));
      if (sha256(body) !== a.innerSha256) throw new Error(`푼 평가기 해시가 맞지 않는다: ${a.url}`);
      const tmp = `${exe}.part`;
      writeFileSync(tmp, body);
      if (platform !== 'win32') chmodSync(tmp, 0o755);
      renameSync(tmp, exe);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return { apalacheJar: jar, evaluator: exe, home };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await ensureQuintTools();
  console.log(`apalache.jar ${r.apalacheJar}`);
  console.log(`quint_evaluator ${r.evaluator}`);
}
