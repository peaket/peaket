#!/usr/bin/env node
// 병합 결과 트리 검사(필수 검사 merge-tree, docs/devops.md §2.2.4, 시험 D-T22, openspec 변경 add-ci-foundation).
// 출시 후보를 대상(main)에 병합한 결과가 후보 커밋의 트리와 같아야 한다. 그래야 데모에서 검증한 후보를
// 다시 빌드하지 않고 그대로 운영에 낸다. 다르면 대상에만 있는 변경(예: 역병합하지 않은 핫픽스)이 있다는 뜻이다.
// 쓰는 법: node tools/ci/check-merge-tree.mjs --target <대상 커밋|가지> --candidate <후보 커밋>
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { target: { type: 'string' }, candidate: { type: 'string' } } });
if (!values.target || !values.candidate) {
  console.error('쓰는 법: node tools/ci/check-merge-tree.mjs --target <대상> --candidate <후보>');
  process.exit(2);
}

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });

// git merge-tree는 없는 커밋에도 충돌과 같은 종료 코드 1을 낸다. 그래서 두 커밋을 먼저 확인한다
for (const ref of [values.target, values.candidate]) {
  const r = git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  if (r.status !== 0) {
    console.log(`실패: 커밋 '${ref}'를 읽지 못했다(체크아웃의 fetch-depth를 확인)`);
    process.exit(2);
  }
}

// --write-tree: 충돌이 없으면 0, 충돌이면 1(git-merge-tree 문서)
const merged = git('merge-tree', '--write-tree', '--name-only', '--no-messages', values.target, values.candidate);
if (merged.status === 1) {
  const files = merged.stdout.split('\n').slice(1).filter(Boolean);
  console.log(`실패: ${values.target}과 ${values.candidate}를 병합하면 충돌한다: ${files.join(', ')}`);
  console.log('대상을 후보 가지에 병합해 충돌을 풀고, 새 후보를 다시 검증한다(§2.2.4).');
  process.exit(1);
}
if (merged.status !== 0) {
  console.log(`실패: git merge-tree가 끝나지 못했다: ${merged.stderr.trim()}`);
  process.exit(2);
}

const mergedTree = merged.stdout.split('\n')[0].trim();
const candidateTree = git('rev-parse', `${values.candidate}^{tree}`).stdout.trim();
if (mergedTree !== candidateTree) {
  const diff = git('diff', '--name-only', candidateTree, mergedTree).stdout.split('\n').filter(Boolean);
  console.log(`실패: 병합 결과가 후보와 다르다. 대상에만 있는 변경: ${diff.join(', ')}`);
  console.log('그 변경을 후보 가지에 넣고 새 후보를 데모에서 다시 검증한다(§2.2.4, D-T22).');
  process.exit(1);
}
console.log(`통과: 병합 결과 트리 ${mergedTree}가 후보 트리와 같다`);
