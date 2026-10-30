#!/usr/bin/env node
// 내부 패키지(@peaket/*)는 workspace: 프로토콜로만 잇는다(docs/devops.md §4.4, ADR-0165).
// 이 프로토콜은 작업 공간 밖의 패키지로 풀리기를 거부하므로, 공개 레지스트리에 같은 이름이 올라와도 설치되지 않는다.
// 다음을 막는다.
//  - 네 의존성 칸의 @peaket/* 판이 workspace:로 시작하지 않는 것
//  - 다른 이름으로 @peaket/*을 받는 npm: 별칭("ds": "npm:@peaket/ds@^1")
//  - 덮어쓰기 칸(overrides, resolutions, pnpm.overrides)에서 @peaket/*을 workspace: 밖의 판으로 바꾸는 것
//  - pnpm-workspace.yaml(덮어쓰기·카탈로그)에 @peaket/ 이름을 쓰는 것(주석은 괜찮다)
// git이 추적하는 파일만 본다(git 밖에서는 폴더를 훑고, 어느 쪽이든 node_modules 안은 건너뛴다).
// 쓰는 법: node tools/ci/check-workspace-protocol.mjs [--root .]
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { root: { type: 'string', default: '.' } } });

const TARGETS = new Set(['package.json', 'pnpm-workspace.yaml']);
const SKIP_DIRS = new Set(['node_modules', '.git']);
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const SCOPE = '@peaket/';

function trackedFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', ':(glob)**/package.json', ':(glob)**/pnpm-workspace.yaml'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\0').filter(Boolean).map((p) => join(root, p));
  } catch {
    return null; // git 저장소가 아니다
  }
}

function* walkedFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walkedFiles(join(dir, entry.name));
    } else if (TARGETS.has(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

// 덮어쓰기 칸은 중첩된 객체일 수 있다(npm overrides). 키나 값에 @peaket/이 있으면 찾는다
function* scopedOverrides(obj, path) {
  for (const [key, value] of Object.entries(obj ?? {})) {
    const here = `${path}.${key}`;
    if (value !== null && typeof value === 'object') {
      if (key.includes(SCOPE)) yield [here, JSON.stringify(value)];
      yield* scopedOverrides(value, here);
    } else if ((key.includes(SCOPE) || String(value).includes(SCOPE)) && !String(value).startsWith('workspace:')) {
      yield [here, String(value)];
    }
  }
}

const errors = [];
const files = (trackedFiles(values.root) ?? [...walkedFiles(values.root)]).filter(
  (f) => !f.split(/[\\/]/).includes('node_modules'),
);

for (const file of files) {
  const where = relative(values.root, file) || file;
  const text = readFileSync(file, 'utf8');

  if (basename(file) === 'pnpm-workspace.yaml') {
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.replace(/(^|\s)#.*$/, '');
      if (line.includes(SCOPE)) {
        errors.push(`${where}:${i + 1}: pnpm-workspace.yaml에 @peaket/ 이름이 있다(덮어쓰기·카탈로그로 내부 패키지를 레지스트리 판에 묶을 수 있다)`);
      }
    });
    continue;
  }

  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    errors.push(`${where}: JSON으로 읽을 수 없다(${e.message})`);
    continue;
  }
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (name.startsWith(SCOPE) && !String(spec).startsWith('workspace:')) {
        errors.push(`${where}: ${field}.${name}의 판 '${spec}'은 workspace: 프로토콜이 아니다`);
      } else if (String(spec).startsWith(`npm:${SCOPE}`)) {
        errors.push(`${where}: ${field}.${name}이 npm: 별칭으로 '${spec}'을 받는다(@peaket/*은 workspace:로만 잇는다)`);
      }
    }
  }
  for (const [field, obj] of [['overrides', manifest.overrides], ['resolutions', manifest.resolutions], ['pnpm.overrides', manifest.pnpm?.overrides]]) {
    for (const [here, value] of scopedOverrides(obj, field)) {
      errors.push(`${where}: ${here}가 @peaket/*을 '${value}'로 바꾼다(덮어쓰기로 내부 패키지를 레지스트리 판에 묶을 수 없다)`);
    }
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  console.error(`workspace: 표기 검사 실패: ${errors.length}건`);
  process.exit(1);
}
console.log(`workspace: 표기 검사 통과: 파일 ${files.length}개`);
