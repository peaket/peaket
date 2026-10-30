// release-plan.mjs를 임시 git 저장소에서 바깥에서 돌려 보는 시험(docs/devops.md §2.2.2~§2.2.5, D-T22·D-T23·D-T25·D-T41 ④).
// 원격 가지는 refs/remotes/origin/…을 직접 만들어 흉내 낸다. 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repo, commit, git, tempDir } from './git-fixture.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'release-plan.mjs');
const PKG = JSON.stringify({ name: 'peaket', private: true, packageManager: 'pnpm@12.16.0' }, null, 2) + '\n';

function run(dir, ...args) {
  const env = { ...process.env };
  delete env.GITHUB_OUTPUT;
  const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // 실패하면 표준 출력이 JSON이 아닐 수 있다
  }
  return { code: r.status, out, text: r.stdout + r.stderr };
}

const remote = (dir, branch, sha) => git(dir, 'update-ref', `refs/remotes/origin/${branch}`, sha);
const tag = (dir, name, sha) => git(dir, 'tag', '-a', name, '-m', name, sha);

// 처음 커밋(필요하면 태그) 위에 develop 커밋을 차례로 쌓는다. subjects의 각 항목은 제목이거나 [제목, 파일]이다
function scenario({ tagName, subjects = [], files = {} } = {}) {
  const dir = repo('release-plan-');
  const base = commit(dir, { 'package.json': PKG, ...files }, 'chore: 처음');
  if (tagName) tag(dir, tagName, base);
  let head = base;
  subjects.forEach((s, i) => {
    const [message, changed] = Array.isArray(s) ? s : [s, { [`docs/n${i}.md`]: `${i}\n` }];
    head = commit(dir, changed, message);
  });
  remote(dir, 'develop', head);
  return { dir, base, head };
}

const start = (dir, kind = 'release', ...more) => run(dir, 'start', '--kind', kind, ...more);

test('출시 태그가 없으면 첫 판은 0.1.0이다', () => {
  const { dir, head } = scenario({ subjects: ['fix(queue): 진입 고침'] });
  const r = start(dir);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.out.release, 'true');
  assert.equal(r.out.version, '0.1.0');
  assert.equal(r.out.branch, 'release/0.1.0');
  assert.equal(r.out.base_sha, head);
  assert.equal(r.out.previous_tag, '');
});

test('D-T41 ④ 운영 출시 전(0.y.z)에는 호환을 깨는 변경도 y만 올린다', () => {
  for (const [subject, body] of [['feat(queue)!: 응답 바꿈', ''], ['fix(queue): 응답 바꿈\n\nBREAKING CHANGE: 칸 이름이 바뀐다', '']]) {
    const { dir } = scenario({ tagName: 'v0.3.2', subjects: [subject + body] });
    assert.equal(start(dir).out.version, '0.4.0', subject);
  }
});

test('feat는 MINOR, 그 밖은 PATCH를 올린다', () => {
  assert.equal(start(scenario({ tagName: 'v0.3.2', subjects: ['fix: a', 'feat(seat): b', 'docs: c'] }).dir).out.version, '0.4.0');
  assert.equal(start(scenario({ tagName: 'v0.3.2', subjects: ['fix: a', 'chore(deps): b'] }).dir).out.version, '0.3.3');
  // 형식에 맞지 않는 제목은 PATCH로 센다
  assert.equal(start(scenario({ tagName: 'v0.3.2', subjects: ['Update readme'] }).dir).out.version, '0.3.3');
});

test('1.0.0 뒤에는 호환을 깨는 변경이 MAJOR를 올린다', () => {
  assert.equal(start(scenario({ tagName: 'v1.4.2', subjects: ['feat(queue)!: 응답 바꿈'] }).dir).out.version, '2.0.0');
  assert.equal(start(scenario({ tagName: 'v1.4.2', subjects: ['feat(queue): 새 칸'] }).dir).out.version, '1.5.0');
});

test('SemVer로 가장 큰 출시 태그를 기준으로 삼고 다른 꼴의 태그는 무시한다', () => {
  const { dir, base } = scenario({ tagName: 'v0.9.0', subjects: ['fix: a'] });
  tag(dir, 'v0.10.0', base);
  tag(dir, 'v0.11.0-rc.1', base);
  tag(dir, 'archive-original', base);
  const r = start(dir);
  assert.equal(r.out.previous_tag, 'v0.10.0');
  assert.equal(r.out.version, '0.10.1');
});

test('출시할 변경이 없으면 아무것도 열지 않는다', () => {
  const r = start(scenario({ tagName: 'v0.3.2' }).dir);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.out.release, 'false');
  assert.match(r.out.reason, /출시할 변경이 없다/);
});

test('이미 열린 릴리스 가지가 있으면 열지 않고 경고만 한다', () => {
  const { dir, head } = scenario({ tagName: 'v0.3.2', subjects: ['feat: a'] });
  remote(dir, 'release/0.4.0', head);
  const r = start(dir);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.out.release, 'false');
  assert.match(r.out.reason, /이미 열린 릴리스 가지 release\/0\.4\.0/);
});

// git flow 한 바퀴: develop → release/0.1.0(버전 올림, 출시 전 수정) → main 병합·태그 → develop 역병합 → 새 수정
function oneCycle() {
  const dir = repo('release-cycle-');
  const m0 = commit(dir, { 'package.json': PKG }, 'chore: 처음');
  git(dir, 'switch', '-q', '-c', 'develop');
  commit(dir, { 'services/queue-svc/a.ts': '1\n' }, 'feat(queue): 진입');
  git(dir, 'switch', '-q', '-c', 'release/0.1.0');
  commit(dir, { 'package.json': PKG.replace('"private"', '"version": "0.1.0",\n  "private"') }, 'chore(release): 0.1.0');
  const candidate = commit(dir, { 'services/queue-svc/a.ts': '2\n' }, 'feat(queue): 릴리스 가지에서 고침');
  git(dir, 'switch', '-q', 'main');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge release/0.1.0', candidate);
  const merged = git(dir, 'rev-parse', 'HEAD');
  tag(dir, 'v0.1.0', merged);
  git(dir, 'switch', '-q', 'develop');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge release/0.1.0 into develop', candidate);
  const head = commit(dir, { 'services/seat-svc/b.ts': '1\n' }, 'fix(seat): 홀드 고침');
  remote(dir, 'develop', head);
  return { dir, m0, candidate, merged, head };
}

test('역병합으로 들어온 릴리스 가지 커밋과 병합 커밋은 세지 않는다', () => {
  const { dir } = oneCycle();
  const r = start(dir);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.out.previous_tag, 'v0.1.0');
  // 릴리스 가지의 feat를 셌다면 0.2.0이 된다
  assert.equal(r.out.version, '0.1.1');
  assert.deepEqual(JSON.parse(r.out.units), ['services/seat-svc']);
});

test('버전을 올린 package.json을 만들고 나머지 칸은 그대로 둔다', () => {
  const { dir, head } = scenario({ tagName: 'v0.3.2', subjects: ['feat: a'] });
  const file = join(tempDir('release-pkg-'), 'package.json');
  const r = start(dir, 'release', '--package-json', file);
  assert.equal(r.code, 0, r.text);
  const text = readFileSync(file, 'utf8');
  const pkg = JSON.parse(text);
  assert.deepEqual(Object.keys(pkg), ['name', 'version', 'private', 'packageManager']);
  assert.equal(pkg.version, '0.4.0');
  assert.equal(pkg.packageManager, 'pnpm@12.16.0');
  assert.ok(text.endsWith('}\n'));
  // 내용 API에 넘길 기존 파일의 블롭
  assert.equal(r.out.package_blob, git(dir, 'rev-parse', `${head}:package.json`));
});

test('변경 기록은 범위별로 묶고, 호환을 깨는 변경을 먼저 두고, @이름을 코드 표시로 감싼다', () => {
  const { dir } = scenario({
    tagName: 'v0.3.2',
    subjects: ['fix(queue): 고침 하나', 'feat(queue)!: 응답 바꿈', 'docs: @someone 안내', 'feat(seat): 자동 배정', 'Update readme'],
  });
  const notes = join(tempDir('release-notes-'), 'notes.md');
  assert.equal(start(dir, 'release', '--notes', notes).code, 0);
  const text = readFileSync(notes, 'utf8');
  assert.match(text, /^## 변경 기록: v0\.3\.2 → 0\.4\.0$/m);
  assert.match(text, /호환을 깨는 변경: 1건/);
  const queue = text.indexOf('### queue');
  const seat = text.indexOf('### seat');
  assert.ok(queue > 0 && seat > 0, text);
  const queueBlock = text.slice(queue, text.indexOf('###', queue + 1));
  assert.ok(queueBlock.indexOf('feat!: 응답 바꿈') < queueBlock.indexOf('fix: 고침 하나'), queueBlock);
  assert.match(text, /docs: `@someone` 안내/);
  assert.match(text, /- Update readme \([0-9a-f]{7}\)/);
  assert.match(text, /### 바뀐 배포 단위\n\n- 없음/);
});

test('바뀐 배포 단위: 그 폴더가 바뀐 단위만, 공용 패키지가 바뀌면 자바스크립트 단위 전부', () => {
  const files = {
    'services/queue-svc/a.ts': '1\n', 'services/seat-svc/a.ts': '1\n', 'apps/web/a.ts': '1\n',
    'apps/widgets/queue/a.ts': '1\n', 'data/dbt_project.yml': 'name: peaket\n', 'services/README.md': '안내\n',
  };
  const one = scenario({ tagName: 'v0.3.2', files, subjects: [['fix(queue): a', { 'services/queue-svc/a.ts': '2\n' }], ['fix: dbt', { 'data/models/a.sql': 'select 1\n' }]] });
  assert.deepEqual(JSON.parse(start(one.dir).out.units), ['data', 'services/queue-svc']);
  const all = scenario({ tagName: 'v0.3.2', files, subjects: [['fix(platform): a', { 'packages/platform/a.ts': '1\n' }]] });
  assert.deepEqual(JSON.parse(start(all.dir).out.units), ['apps/web', 'apps/widgets/queue', 'services/queue-svc', 'services/seat-svc']);
  const docs = scenario({ tagName: 'v0.3.2', files, subjects: ['docs: 글'] });
  assert.deepEqual(JSON.parse(start(docs.dir).out.units), []);
});

test('핫픽스는 마지막 출시 태그에서 Z+1로 연다', () => {
  const { dir, merged } = oneCycle();
  const r = start(dir, 'hotfix');
  assert.equal(r.code, 0, r.text);
  assert.equal(r.out.release, 'true');
  assert.equal(r.out.version, '0.1.1');
  assert.equal(r.out.branch, 'hotfix/0.1.1');
  assert.equal(r.out.base_sha, merged);
});

test('열린 핫픽스 가지가 있거나 출시 태그가 없으면 핫픽스를 열지 못한다', () => {
  const { dir, merged } = oneCycle();
  remote(dir, 'hotfix/0.1.1', merged);
  const r = start(dir, 'hotfix');
  assert.equal(r.code, 1);
  assert.match(r.text, /이미 열린 핫픽스 가지 hotfix\/0\.1\.1/);
  const none = start(scenario({ subjects: ['fix: a'] }).dir, 'hotfix');
  assert.equal(none.code, 1);
  assert.match(none.text, /출시 태그가 없다/);
});

test('D-T23 릴리스 마무리 계획: 태그·후보·역병합 대상 develop과 merge/* 가지', () => {
  const { dir, head } = oneCycle();
  remote(dir, 'release/0.2.0', head);
  const notes = join(tempDir('release-notes-'), 'notes.md');
  const r = run(dir, 'finish', '--branch', 'release/0.2.0', '--notes', notes);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.out.kind, 'release');
  assert.equal(r.out.version, '0.2.0');
  assert.equal(r.out.tag, 'v0.2.0');
  assert.equal(r.out.candidate, head);
  assert.equal(r.out.previous_tag, 'v0.1.0');
  assert.equal(r.out.backmerge_target, 'develop');
  assert.equal(r.out.backmerge_branch, 'merge/release-0.2.0-to-develop');
  assert.match(readFileSync(notes, 'utf8'), /fix: 홀드 고침/);
});

test('D-T25 열린 릴리스 가지가 있으면 핫픽스는 그 가지로 역병합한다', () => {
  const { dir, merged, head } = oneCycle();
  remote(dir, 'hotfix/0.1.1', merged);
  remote(dir, 'release/0.2.0', head);
  const r = run(dir, 'finish', '--branch', 'hotfix/0.1.1');
  assert.equal(r.code, 0, r.text);
  assert.equal(r.out.backmerge_target, 'release/0.2.0');
  assert.equal(r.out.backmerge_branch, 'merge/hotfix-0.1.1-to-release-0.2.0');
  // 열린 릴리스가 없으면 develop이다
  git(dir, 'update-ref', '-d', 'refs/remotes/origin/release/0.2.0');
  assert.equal(run(dir, 'finish', '--branch', 'hotfix/0.1.1').out.backmerge_target, 'develop');
});

test('마무리할 가지 이름·태그·판이 맞지 않으면 실패한다', () => {
  const { dir, head } = oneCycle();
  remote(dir, 'release/0.1.0', head);
  remote(dir, 'release/0.0.9', head);
  for (const [branch, why] of [
    ['feature/1-a', /release\/X\.Y\.Z/], ['release/v0.2.0', /release\/X\.Y\.Z/], ['release/0.2.0;id', /release\/X\.Y\.Z/],
    ['release/0.2.0', /원격 가지 origin\/release\/0\.2\.0이 없다/],
    ['release/0.1.0', /태그 v0\.1\.0이 이미 있다/],
    ['release/0.0.9', /마지막 출시 태그 v0\.1\.0보다 커야 한다/],
  ]) {
    const r = run(dir, 'finish', '--branch', branch);
    assert.equal(r.code, 1, branch);
    assert.match(r.text, why, branch);
  }
});

test('열린 릴리스 가지가 둘이면 핫픽스 역병합 대상을 정하지 못한다', () => {
  const { dir, merged, head } = oneCycle();
  remote(dir, 'hotfix/0.1.1', merged);
  remote(dir, 'release/0.2.0', head);
  remote(dir, 'release/0.3.0', head);
  const r = run(dir, 'finish', '--branch', 'hotfix/0.1.1');
  assert.equal(r.code, 1);
  assert.match(r.text, /열린 릴리스 가지가 둘 이상/);
});

test('D-T22 병합 뒤 확인: 두 번째 부모가 후보이고 트리가 같으면 출시 기록을 붙인다', () => {
  const { dir, candidate, merged } = oneCycle();
  const notes = join(tempDir('release-notes-'), 'notes.md');
  writeFileSync(notes, '## 변경 기록\n');
  const r = run(dir, 'verify', '--merged', merged, '--candidate', candidate, '--notes', notes);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.out.tree, git(dir, 'rev-parse', `${candidate}^{tree}`));
  const text = readFileSync(notes, 'utf8');
  assert.match(text, /^## 변경 기록\n/);
  assert.match(text, new RegExp(`\\| 태그 커밋 \\| \`${merged}\` \\|`));
  assert.match(text, new RegExp(`\\| 후보 커밋 \\| \`${candidate}\` \\|`));
});

test('D-T22 병합 뒤 확인: 후보가 아닌 부모이거나 트리가 다르면 실패한다', () => {
  const { dir, m0, candidate, merged } = oneCycle();
  const wrongParent = run(dir, 'verify', '--merged', merged, '--candidate', m0);
  assert.equal(wrongParent.code, 1);
  assert.match(wrongParent.text, /두 번째 부모/);
  // main에만 있는 변경이 섞인 병합(역병합하지 않은 핫픽스)
  git(dir, 'switch', '-q', '--detach', m0);
  const onlyMain = commit(dir, { 'docs/hotfix.md': '1\n' }, 'fix: main에만');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge', candidate);
  const bad = git(dir, 'rev-parse', 'HEAD');
  assert.ok(onlyMain);
  const r = run(dir, 'verify', '--merged', bad, '--candidate', candidate);
  assert.equal(r.code, 1);
  assert.match(r.text, /트리가 후보와 다르다.*docs\/hotfix\.md/);
});

// 코드 리뷰에서 찾은 결함의 재현 시험(add-release-workflows)
test('열린 핫픽스가 있으면 릴리스는 그 판보다 큰 판을 받는다', () => {
  const { dir, merged } = oneCycle();
  remote(dir, 'hotfix/0.1.1', merged);
  const r = start(dir);
  assert.equal(r.code, 0, r.text);
  // fix만 있으면 0.1.1이 되어 핫픽스와 겹친다
  assert.equal(r.out.version, '0.1.2');
});

test('열린 릴리스와 판이 겹치면 핫픽스를 열지 않고, 겹치지 않으면 연다', () => {
  const { dir, head } = oneCycle();
  remote(dir, 'release/0.1.1', head);
  const r = start(dir, 'hotfix');
  assert.equal(r.code, 1);
  assert.match(r.text, /열린 릴리스 가지 release\/0\.1\.1과 판이 겹친다/);
  git(dir, 'update-ref', '-d', 'refs/remotes/origin/release/0.1.1');
  remote(dir, 'release/0.2.0', head);
  assert.equal(start(dir, 'hotfix').out.version, '0.1.1');
});

test('병합된 뒤 다시 돌리면(--merged) 원격 가지 없이 후보를 병합 커밋의 두 번째 부모로 잇는다', () => {
  const { dir, candidate, merged } = oneCycle();
  git(dir, 'tag', '-d', 'v0.1.0');
  const r = run(dir, 'finish', '--branch', 'release/0.1.0', '--merged', merged);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.out.candidate, candidate);
  assert.equal(r.out.tag_exists, 'false');
  // 태그까지 달았다가 그다음 단계에서 멈췄어도 이어 간다
  tag(dir, 'v0.1.0', merged);
  const again = run(dir, 'finish', '--branch', 'release/0.1.0', '--merged', merged);
  assert.equal(again.code, 0, again.text);
  assert.equal(again.out.tag_exists, 'true');
});

test('이어 가기에서 태그가 다른 커밋에 있거나 병합 커밋이 아니면 실패한다', () => {
  const { dir, m0, merged } = oneCycle();
  git(dir, 'tag', '-d', 'v0.1.0');
  tag(dir, 'v0.1.0', m0);
  const moved = run(dir, 'finish', '--branch', 'release/0.1.0', '--merged', merged);
  assert.equal(moved.code, 1);
  assert.match(moved.text, /태그 v0\.1\.0이 병합 커밋이 아닌 곳\([0-9a-f]{40}\)에 있다/);
  const notMerge = run(dir, 'finish', '--branch', 'release/0.1.0', '--merged', m0);
  assert.equal(notMerge.code, 1);
  assert.match(notMerge.text, /두 번째 부모가 없다/);
});

test('핫픽스를 열린 릴리스로 역병합할 때 판 줄이 충돌하지 않게 대상의 판으로 맞춘 package.json을 낸다', () => {
  const { dir, merged, head } = oneCycle();
  git(dir, 'switch', '-q', '--detach', merged);
  const fixed = commit(dir, { 'package.json': PKG.replace('"private"', '"version": "0.1.1",\n  "private"') }, 'chore(release): 0.1.1');
  remote(dir, 'hotfix/0.1.1', fixed);
  git(dir, 'switch', '-q', '--detach', head);
  remote(dir, 'release/0.2.0', commit(dir, { 'package.json': PKG.replace('"private"', '"version": "0.2.0",\n  "private"') }, 'chore(release): 0.2.0'));
  const file = join(tempDir('release-pkg-'), 'package.json');
  const r = run(dir, 'finish', '--branch', 'hotfix/0.1.1', '--backmerge-package-json', file);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.out.backmerge_version, '0.2.0');
  assert.equal(r.out.backmerge_package_blob, git(dir, 'rev-parse', `${fixed}:package.json`));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, '0.2.0');
  // develop으로 갈 때는 맞추지 않는다
  git(dir, 'update-ref', '-d', 'refs/remotes/origin/release/0.2.0');
  assert.equal(run(dir, 'finish', '--branch', 'hotfix/0.1.1').out.backmerge_version, '');
});

test('하위 명령이 없거나 모르면 2로 끝난다', () => {
  const { dir } = scenario();
  assert.equal(run(dir).code, 2);
  assert.equal(run(dir, 'publish').code, 2);
  assert.equal(run(dir, 'start', '--kind', 'feature').code, 2);
});
