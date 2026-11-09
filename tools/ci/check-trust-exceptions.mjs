#!/usr/bin/env node
// 공급망 신뢰 정책의 예외를 지킨다(docs/devops.md §4.4 '예외를 둘 수 있는 조건', ADR-0191).
//  - git이 추적하는 pnpm-workspace.yaml마다 trustPolicy: no-downgrade가 있어야 한다(끄거나 빼면 막는다)
//  - trustPolicyIgnoreAfter(그보다 오래된 판은 신뢰 검사를 건너뛴다)는 두지 않는다. 짧게 두면 사실상 정책이 꺼진다
//  - trustPolicyExclude는 목록이고, 항목은 '이름@정확한 판'(1.2.3, 앞선 판 꼬리 -rc.1 허용)만 받는다.
//    이름만, 범위(^·~·x·||), 꼬리표(latest), 와일드카드(*)는 그 패키지의 여러 판을 풀어 버리므로 막는다
//  - 항목마다 docs/devops.md §4.4 안의 예외 표 줄(| 로 시작하는 줄)에 `이름@판`이 적혀 있어야 한다(까닭·지울 조건을 그 표에 둔다)
// 쓰는 법: node tools/ci/check-trust-exceptions.mjs [--root .]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';

const { values } = parseArgs({ options: { root: { type: 'string', default: '.' } } });
const root = values.root;

const EXACT = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function workspaceFiles() {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', ':(glob)**/pnpm-workspace.yaml', 'pnpm-workspace.yaml'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return [...new Set(out.split('\0').filter(Boolean))].filter((p) => !p.split('/').includes('node_modules'));
}

/** docs/devops.md의 ### 4.4 절에서 표 줄만 */
function exceptionTableRows() {
  const md = readFileSync(join(root, 'docs/devops.md'), 'utf8').split(/\r?\n/);
  const start = md.findIndex((l) => /^### 4\.4\b/.test(l));
  if (start < 0) return [];
  // 절 끝은 다음 제목이다. 코드 울타리(```) 안의 '# 주석'은 제목이 아니다
  let fenced = false;
  const out = [];
  for (const l of md.slice(start + 1)) {
    if (/^\s*```/.test(l)) fenced = !fenced;
    else if (!fenced && /^#{1,3} /.test(l)) break;
    else if (!fenced && l.trimStart().startsWith('|')) out.push(l);
  }
  return out;
}

const errors = [];
const rows = exceptionTableRows();
for (const file of workspaceFiles()) {
  const rel = relative(root, join(root, file)).split('\\').join('/');
  const doc = parse(readFileSync(join(root, file), 'utf8')) ?? {};
  if (doc.trustPolicy !== 'no-downgrade') errors.push(`${rel}: trustPolicy가 no-downgrade가 아니다(받은 값 ${JSON.stringify(doc.trustPolicy)})`);
  if (doc.trustPolicyIgnoreAfter !== undefined) errors.push(`${rel}: trustPolicyIgnoreAfter는 두지 않는다(오래된 판의 신뢰 검사를 건너뛰어 정책이 약해진다, docs/devops.md §4.4)`);
  const ex = doc.trustPolicyExclude;
  if (ex === undefined) continue;
  if (!Array.isArray(ex)) {
    errors.push(`${rel}: trustPolicyExclude는 '이름@판' 문자열의 목록이어야 한다`);
    continue;
  }
  for (const entry of ex) {
    const s = String(entry).trim();
    if (!EXACT.test(s)) {
      errors.push(`${rel}: trustPolicyExclude '${s}'는 '이름@정확한 판'이 아니다(이름만·범위·꼬리표·와일드카드는 그 패키지의 여러 판을 푼다)`);
      continue;
    }
    if (!rows.some((l) => l.includes(`\`${s}\``))) errors.push(`${rel}: trustPolicyExclude '${s}'가 docs/devops.md §4.4 예외 표에 없다(까닭과 지울 조건을 적는다)`);
  }
}

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log('신뢰 정책 예외 검사 통과');
