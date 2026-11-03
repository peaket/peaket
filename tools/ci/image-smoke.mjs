#!/usr/bin/env node
// 이미지 스모크(docs/devops.md §3.1 build-image.yml ①의 arm64 러너 스모크). 이미지 안에서 그 이미지의 node로 돈다:
//   docker run --rm --network none -v <이 파일>:/smoke.mjs:ro <이미지> node /smoke.mjs <x64|arm64> [뿌리 폴더, 기본 /app]
// 1. process.platform이 linux이고 process.arch가 기대한 값인가
// 2. 뿌리 폴더 아래(node_modules/.pnpm 포함)의 네이티브 모듈(.node)이 모두 열리는가(모듈마다 새 node 프로세스의 process.dlopen)
// 결과를 한 줄 JSON으로 찍고, 하나라도 틀리면 종료 코드 1이다. 의존성 없이 node: 모듈만 쓴다.
import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 뿌리 폴더 아래의 .node 파일(심볼릭 링크는 따라가지 않는다, 실제 경로로 겹치지 않게)
 * @param {string} root
 * @returns {string[]}
 */
export function findNativeModules(root) {
  /** @type {Set<string>} */
  const found = new Set();
  const walk = (/** @type {string} */ dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith('.node')) found.add(realpathSync(p));
    }
  };
  walk(root);
  return [...found].sort();
}

/**
 * 스모크 판정
 * @param {{ expectedArch: string, root: string, runtime?: { platform: string, arch: string }, dlopen?: (file: string) => void }} o
 * @returns {{ ok: boolean, platform: string, arch: string, nativeModules: string[], failures: string[] }}
 */
export function smoke(o) {
  const runtime = o.runtime ?? { platform: process.platform, arch: process.arch };
  // 모듈마다 새 node 프로세스에서 연다. 같은 애드온의 사본 둘(build/Release와 중간 산출물 obj.target)을 한 프로세스에서 열면
  // 두 번째가 'Module did not self-register'로 실패하기 때문이다(실제 v0 이미지에서 확인, 2026-11-03)
  const load =
    o.dlopen ??
    ((file) => {
      const r = spawnSync(process.execPath, ['-e', 'process.dlopen({ exports: {} }, process.argv[1])', file], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error((r.stderr || r.error?.message || `종료 코드 ${r.status}`).trim().split('\n').slice(-3).join(' '));
    });
  /** @type {string[]} */
  const failures = [];
  if (runtime.platform !== 'linux') failures.push(`플랫폼이 linux가 아니다: ${runtime.platform}`);
  if (runtime.arch !== o.expectedArch) failures.push(`아키텍처가 ${o.expectedArch}가 아니다: ${runtime.arch}`);
  const nativeModules = findNativeModules(o.root);
  // 하나가 실패해도 나머지를 모두 열어 본다(한 번에 다 보이게)
  for (const file of nativeModules) {
    try {
      load(file);
    } catch (err) {
      failures.push(`네이티브 모듈을 열지 못했다: ${file} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { ok: failures.length === 0, platform: runtime.platform, arch: runtime.arch, nativeModules, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [expectedArch, root = '/app'] = process.argv.slice(2);
  if (!expectedArch) {
    console.error('쓰는 법: node /smoke.mjs <x64|arm64> [뿌리 폴더]');
    process.exit(2);
  }
  const result = smoke({ expectedArch, root });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
