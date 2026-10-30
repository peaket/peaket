#!/usr/bin/env node
// 내부 패키지(@peaket/*)는 workspace: 프로토콜로만 잇는다(docs/devops.md §4.4, ADR-0165).
// 이 프로토콜은 작업 공간 밖의 패키지로 풀리기를 거부하므로, 공개 레지스트리에 같은 이름이 올라와도 설치되지 않는다.
// 뿌리부터 package.json을 찾아(node_modules·.git 제외) 네 의존성 칸의 @peaket/* 판이 workspace:로 시작하지 않으면 실패한다.
// 쓰는 법: node tools/ci/check-workspace-protocol.mjs [--root .]
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { root: { type: 'string', default: '.' } } });

const SKIP_DIRS = new Set(['node_modules', '.git']);
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const SCOPE = '@peaket/';

function* packageJsons(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* packageJsons(join(dir, entry.name));
    } else if (entry.name === 'package.json') {
      yield join(dir, entry.name);
    }
  }
}

const errors = [];
let files = 0;
for (const file of packageJsons(values.root)) {
  files += 1;
  const where = relative(values.root, file) || file;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`${where}: JSON으로 읽을 수 없다(${e.message})`);
    continue;
  }
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (name.startsWith(SCOPE) && !String(spec).startsWith('workspace:')) {
        errors.push(`${where}: ${field}.${name}의 판 '${spec}'은 workspace: 프로토콜이 아니다`);
      }
    }
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  console.error(`workspace: 표기 검사 실패: ${errors.length}건`);
  process.exit(1);
}
console.log(`workspace: 표기 검사 통과: package.json ${files}개`);
