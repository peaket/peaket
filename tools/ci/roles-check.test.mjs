// roles-check.mjs를 가짜 저장소에서 바깥으로 돌려 보는 시험(계획 docs/review/plans/W7-L1-roles-check.md §4, ADR-0270 결정 5).
// 실행: node --test "tools/ci/*.test.mjs". 시험 이름의 RC-<번호>와 ①~⑩은 계획의 시험 번호와 검사 번호다.
// 사건은 기준 커밋(꼬리말 없음) 위에 '좋은 묶음'을 쌓고 한 군데만 틀리게 바꾼다. 같은 앞부분은 한 번만 만든다(아래 build).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repo, commit, git, tempDir } from './git-fixture.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'roles-check.mjs');

// 좋은 묶음의 역할별 세션(계획 §4)
const S = { plan: 's-plan', test: 's-test', impl: 's-impl', review: 's-review', verify: 's-verify', record: 's-sup', doc: 's-doc' };
const T0 = '2026-11-16T07:41+09:00';
const T1 = '2026-11-16T07:54+09:00';
const HEADER = '| 역할 | 세션 ID | 모델 | 시작 | 끝 |';
const SEP = '| --- | --- | --- | --- | --- |';

let dir;
let base;
let current;
const cache = new Map();

before(() => {
  dir = repo('roles-check-');
  base = commit(dir, { 'README.md': '처음\n' }, 'base');
  // 사건 커밋은 가지 없이(떨어진 HEAD) 쌓는다. main은 기준에 남는다
  git(dir, 'checkout', '-q', '--detach');
  current = base;
});

// ---- 계획 파일 ----

const row = (role, session, start = T0, end = T1, model = 'fixture-model') => `| ${role} | ${session} | ${model} | ${start} | ${end} |`;
const codeRows = () => ['plan', 'test', 'impl', 'review', 'verify'].map((r) => row(r, S[r]));
const docRows = () => ['plan', 'doc', 'review'].map((r) => row(r, S[r]));

// 코드 묶음 계획 파일: 네 절이 차 있고, 비어 있는 '시험 이의' 절과 다른 절의 표도 있다(담당 표 절 밖의 표는 담당 표가 아니다)
function codePlan(id, { header = HEADER, sep = SEP, rows = codeRows(), after = '' } = {}) {
  return [
    `# 작업 계획: ${id}`,
    '',
    '## 계획',
    '',
    '시험 목록을 정한다.',
    '',
    '## 실패 확인',
    '',
    '`node --test` 시험 3개 가운데 3개가 실패했다(아직 없음).',
    '',
    '## 시험 이의',
    '',
    '## 리뷰',
    '',
    '높음 0, 중간 1.',
    '',
    '## 틀린 구현 목록',
    '',
    '| 번호 | 넣을 것 |',
    '| --- | --- |',
    '| M-01 | 뺀다 |',
    '',
    '## 검증',
    '',
    '틀린 구현 1개를 모두 잡았다.',
    '',
    '## 담당 표',
    '',
    header,
    sep,
    ...rows,
    '',
    after,
  ].join('\n');
}

function docPlan(id, rows = docRows()) {
  return [`# 작업 계획: ${id}`, '', '## 계획', '', '고칠 문서를 정한다.', '', '## 리뷰', '', '높음 0.', '', '## 담당 표', '', HEADER, SEP, ...rows, ''].join('\n');
}

// 글 일부를 바꾼다. 바꿀 곳이 없으면 시험이 틀린 것이므로 던진다
function swap(text, from, to) {
  assert.ok(text.includes(from), `시험 사건이 틀렸다: '${from}'가 없다`);
  return text.replace(from, to);
}

// ---- 커밋 사양 ----

function spec(label, role, batch, session, files = {}, more = {}) {
  return { label, role, batch, session, files, ...more };
}

function defaultTrailers(s) {
  return [
    ...(s.batch === undefined ? [] : [`Batch: ${s.batch}`]),
    `Role: ${s.role}`,
    ...(s.fixBy ? [`Fix-By: ${s.fixBy}`] : []),
    ...(s.findings ?? []).map((f) => `Finding: ${f}`),
    `Agent-Session: ${s.session}`,
    'Agent-Model: fixture-model',
  ];
}

function message(s) {
  if (s.message) return s.message;
  const trailers = s.trailers ?? defaultTrailers(s);
  return `${s.role}(${s.batch ?? '없음'}): ${s.label}\n\n${s.body ?? '바꾼 까닭을 적는다.'}\n\n${trailers.join('\n')}\n`;
}

const find = (seq, label) => {
  const s = seq.find((x) => x.label === label);
  assert.ok(s, `시험 사건이 틀렸다: 커밋 '${label}'이 없다`);
  return s;
};
function set(seq, label, patch) {
  find(seq, label);
  return seq.map((s) => (s.label === label ? { ...s, ...patch } : s));
}
const addFiles = (seq, label, files) => set(seq, label, { files: { ...find(seq, label).files, ...files } });
const retrail = (seq, label, fn) => set(seq, label, { trailers: fn(defaultTrailers(find(seq, label))) });
function drop(seq, ...labels) {
  for (const l of labels) find(seq, l);
  return seq.filter((s) => !labels.includes(s.label));
}
const pick = (seq, labels) => labels.map((l) => find(seq, l));

const REST = ['review', 'verify', 'rfTest', 'rfImpl', 'record'];

// 좋은 코드 묶음(계획 §4): plan → test → impl → review → verify → review-fix(test) → review-fix(impl) → record
function codeBatch(id = 'BAT-901', o = {}) {
  const area = o.area ?? (id === 'BAT-901' ? 'a' : 'b');
  const src = `services/${area}/src/x.ts`;
  const tst = `services/${area}/test/x.test.ts`;
  const s = { ...S, ...o.sessions };
  const planPath = o.planPath === undefined ? `docs/review/plans/${id}.md` : o.planPath;
  const p = o.prefix ?? '';
  return [
    spec(`${p}plan`, 'plan', id, s.plan, planPath ? { [planPath]: o.plan ?? codePlan(id) } : {}),
    spec(`${p}test`, 'test', id, s.test, { [src]: "export const x = () => { throw new Error('아직 없음'); };\n", [tst]: '시험 1\n', ...o.testFiles }),
    spec(`${p}impl`, 'impl', id, s.impl, { [src]: 'export const x = () => 1;\n' }),
    spec(`${p}review`, 'review', id, s.review, { [`docs/review/notes/${id}-review.md`]: '높음 0\n' }),
    spec(`${p}verify`, 'verify', id, s.verify, { [`docs/review/notes/${id}-verify.md`]: '다 잡았다\n' }),
    spec(`${p}rfTest`, 'review-fix', id, s.test, { [tst]: '시험 1\n시험 2\n' }, { fixBy: 'test', findings: ['RV-901'] }),
    spec(`${p}rfImpl`, 'review-fix', id, s.impl, { [src]: 'export const x = () => 2;\n' }, { fixBy: 'impl', findings: ['RV-901'] }),
    spec(`${p}record`, 'record', id, s.record, { 'docs/PROGRESS.md': `${id} 끝\n` }),
  ];
}

// 좋은 문서 묶음(계획 §4): plan → doc → review → record
function docBatch(id = 'BAT-902') {
  return [
    spec('plan', 'plan', id, S.plan, { [`docs/review/plans/${id}.md`]: docPlan(id) }),
    spec('doc', 'doc', id, S.doc, { 'notes/a.md': '글\n' }),
    spec('review', 'review', id, S.review, { [`docs/review/notes/${id}-review.md`]: '높음 0\n' }),
    spec('record', 'record', id, S.record, { 'docs/PROGRESS.md': `${id} 끝\n` }),
  ];
}

// BAT-903: BAT-901과 섞어 넣는 두 번째 코드 묶음(plan·test·impl·review·verify)
const bat903 = (o = {}) => codeBatch('BAT-903', { prefix: 'b3.', ...o }).slice(0, 5);

// 좋은 코드 묶음 끝에 계획 파일만 고치는 plan 커밋을 하나 더 단다(계획 파일 사건용, 앞 8커밋은 다시 쓴다)
const withPlan = (text, id = 'BAT-901') => [...codeBatch(id), spec('planFix', 'plan', id, S.plan, { [`docs/review/plans/${id}.md`]: text })];

// ---- 가짜 저장소 만들기 ----

function checkout(sha) {
  if (current === sha) return;
  git(dir, 'checkout', '-q', '-f', '--detach', sha);
  git(dir, 'clean', '-q', '-f', '-d', '-x');
  current = sha;
}

function write(files) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

function makeCommit(s) {
  write(s.files ?? {});
  for (const p of s.del ?? []) rmSync(join(dir, p));
  for (const [from, to] of s.mv ?? []) {
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    git(dir, 'mv', from, to);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '--cleanup=verbatim', '-m', message(s));
  return git(dir, 'rev-parse', 'HEAD');
}

function make(s) {
  if (!s.merge) return { sha: makeCommit(s) };
  const parent = current;
  const side = makeCommit(s.merge);
  current = side;
  checkout(parent);
  git(dir, 'merge', '-q', '--no-ff', '--cleanup=verbatim', '-m', message(s), side);
  return { sha: git(dir, 'rev-parse', 'HEAD'), side };
}

// 사양 목록을 start 위에 커밋으로 쌓고 작업 트리를 머리에 둔다. 같은 앞부분은 기억해 둔 커밋을 다시 쓴다
function build(seq, start = base) {
  const sha = {};
  let head = start;
  let key = start;
  for (const s of seq) {
    key += `\n${JSON.stringify(s)}`;
    let hit = cache.get(key);
    if (!hit) {
      checkout(head);
      hit = make(s);
      current = hit.sha;
      cache.set(key, hit);
    }
    head = hit.sha;
    sha[s.label] = hit.sha;
    if (hit.side) sha[s.merge.label] = hit.side;
  }
  checkout(head);
  return { head, sha };
}

// 작업 트리를 손으로 바꾼 뒤에는 다음 checkout이 꼭 되돌리게 한다
const dirtied = () => {
  current = undefined;
};

// ---- 돌리기와 단언 ----

function run(head, { base: b = base, args, env = {}, cwd = dir } = {}) {
  const e = { ...process.env };
  delete e.GITHUB_ACTIONS;
  Object.assign(e, env);
  const r = spawnSync(process.execPath, [script, ...(args ?? ['--base', b, '--head', head])], { cwd, encoding: 'utf8', env: e });
  const out = r.stdout ?? '';
  const err = r.stderr ?? '';
  return { code: r.status, out, err, all: `끝 코드 ${r.status}\n[표준 출력]\n${out}\n[표준 오류]\n${err}` };
}

function check(seq, o = {}) {
  const { head, sha } = build(seq, o.start);
  return { r: run(head, o), sha, head };
}

const lines = (out) => out.split(/\r?\n/).filter((l) => l !== '');

// 실패 줄: '<앞머리>[<검사 이름>] <묶음 또는 -> <짧은 해시 7자 이상 또는 -> <까닭>'
function failures(out, prefix = '실패: ') {
  return lines(out)
    .filter((l) => l.startsWith(prefix))
    .map((l) => {
      const m = l.slice(prefix.length).match(/^\[([^\]]+)\] (.+?) (-|[0-9a-f]{7,40}) (\S.*)$/);
      return m ? { check: m[1], batch: m[2], hash: m[3], reason: m[4], line: l } : { bad: true, line: l };
    });
}

const hashOk = (hash, sha) => (sha === null ? hash === '-' : hash !== '-' && sha.startsWith(hash));
const show = (batch, sha) => `${batch} ${sha === null ? '-' : sha.slice(0, 7)}`;

// 끝 코드 1과, 검사 이름·묶음·해시가 맞고 까닭에 reason 글이 모두 든 실패 줄을 본다
function expectFail(r, label, name, batch, sha, reason = [], prefix = '실패: ') {
  assert.equal(r.code, 1, `${label}: 끝 코드가 1이 아니다\n${r.all}`);
  const hit = failures(r.out, prefix).find((f) => !f.bad && f.check === name && f.batch === batch && hashOk(f.hash, sha) && reason.every((x) => f.reason.includes(x)));
  assert.ok(hit, `${label}: '${prefix}[${name}] ${show(batch, sha)}' 실패 줄이 없다(까닭에 ${JSON.stringify(reason)})\n${r.all}`);
  assert.doesNotMatch(r.out, /^통과:/m, `${label}: 실패했는데 통과 줄이 있다\n${r.all}`);
}

function expectPass(r, label, batches, commits) {
  assert.equal(r.code, 0, `${label}: 끝 코드가 0이 아니다\n${r.all}`);
  assert.deepEqual(failures(r.out), [], `${label}: 실패 줄이 있다\n${r.all}`);
  assert.equal(lines(r.out).at(-1), `통과: 묶음 ${batches}개, 커밋 ${commits}개`, `${label}: 마지막 줄\n${r.all}`);
}

// 끝 코드 2: 표준 출력에 '<앞머리><까닭>' 한 줄만(묶음 줄·통과 줄 없음), 표준 오류는 비어 있다(계획 §1 출력 세부 셋의 셋째)
function expectError(r, label, prefix = '오류: ') {
  assert.equal(r.code, 2, `${label}: 끝 코드가 2가 아니다\n${r.all}`);
  const ls = lines(r.out);
  assert.equal(ls.length, 1, `${label}: 표준 출력이 오류 한 줄이 아니다\n${r.all}`);
  assert.ok(ls[0].startsWith(prefix) && ls[0].length > prefix.length, `${label}: '${prefix}<까닭>' 꼴이 아니다\n${r.all}`);
  assert.equal(r.err, '', `${label}: 표준 오류에 썼다\n${r.all}`);
}

const batchLine = (r, id) => lines(r.out).find((l) => l.startsWith(`묶음 ${id}: `));
const summary = (id, kind, n, c) => `묶음 ${id}: ${kind} 커밋 ${n}개(plan ${c[0]}·test ${c[1]}·impl ${c[2]}·review ${c[3]}·review-fix ${c[4]}·verify ${c[5]}·record ${c[6]}·doc ${c[7]})`;

// ---- 시험 ----

test('RC-01 ⑩ 좋은 코드 묶음은 통과한다', () => {
  const { r, head } = check(codeBatch());
  expectPass(r, 'RC-01', 1, 8);
  assert.equal(batchLine(r, 'BAT-901'), summary('BAT-901', '코드', 8, [1, 1, 1, 1, 2, 1, 1, 0]), r.all);

  // 기본 인자: --base origin/develop, --head HEAD(작업 트리가 머리에 있다). 로컬 main은 머리로 옮겨 기본값이 main이면 빈 범위가 된다
  git(dir, 'update-ref', 'refs/remotes/origin/develop', base);
  git(dir, 'branch', '-f', 'main', head);
  try {
    expectPass(run(head, { args: [] }), 'RC-01 기본 인자', 1, 8);
    // --root: 다른 폴더에서 저장소 뿌리를 준다
    expectPass(run(head, { args: ['--root', dir, '--base', base, '--head', head], cwd: tempDir('roles-check-cwd-') }), 'RC-01 --root', 1, 8);
  } finally {
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/develop');
    git(dir, 'branch', '-f', 'main', base);
  }
});

test('RC-02 ⑩ 좋은 문서 묶음은 통과한다', () => {
  const { r } = check(docBatch());
  expectPass(r, 'RC-02', 1, 4);
  assert.equal(batchLine(r, 'BAT-902'), summary('BAT-902', '문서', 4, [1, 0, 0, 1, 0, 0, 1, 1]), r.all);
});

test('RC-03 ③⑦ 섞여 들어온 묶음 둘과 묶음을 넘은 같은 역할 세션은 통과한다', () => {
  const seq = pick([...codeBatch(), ...bat903()], ['plan', 'test', 'b3.plan', 'impl', 'b3.test', 'b3.impl', 'b3.review', 'b3.verify', ...REST]);
  const { r } = check(seq);
  expectPass(r, 'RC-03', 2, 13);
  assert.equal(batchLine(r, 'BAT-901'), summary('BAT-901', '코드', 8, [1, 1, 1, 1, 2, 1, 1, 0]), r.all);
  assert.equal(batchLine(r, 'BAT-903'), summary('BAT-903', '코드', 5, [1, 1, 1, 1, 0, 1, 0, 0]), r.all);
});

test('RC-04 ① 꼬리말이 빠지면 실패한다', () => {
  for (const [name, label, fn, batch] of [
    ['Role 없음', 'impl', (t) => t.filter((x) => !x.startsWith('Role: ')), 'BAT-901'],
    ['Agent-Session 없음', 'review', (t) => t.filter((x) => !x.startsWith('Agent-Session: ')), 'BAT-901'],
    ['Batch 없음', 'verify', (t) => t.filter((x) => !x.startsWith('Batch: ')), '-'],
    ['Agent-Session 값이 빔', 'review', (t) => t.map((x) => (x.startsWith('Agent-Session: ') ? 'Agent-Session: ' : x)), 'BAT-901'],
    ['Agent-Session 값에 공백', 'review', (t) => t.map((x) => (x.startsWith('Agent-Session: ') ? 'Agent-Session: s review' : x)), 'BAT-901'],
  ]) {
    const { r, sha } = check(retrail(codeBatch(), label, fn));
    expectFail(r, `RC-04 ${name}`, '꼬리말', batch, sha[label]);
  }
  // 꼬리말 덩이가 아예 없는 커밋
  const { r, sha } = check(set(codeBatch(), 'record', { message: '기록을 남긴다\n\n본문만 있다.\n' }));
  expectFail(r, 'RC-04 꼬리말 덩이 없음', '꼬리말', '-', sha.record);
});

test('RC-05 ① Role 키·값의 대소문자가 다르면 빠진 것으로 본다', () => {
  const swapLine = (from, to) => (t) => t.map((x) => (x === from ? to : x));
  for (const [name, label, fn, batch] of [
    ['role: plan', 'plan', swapLine('Role: plan', 'role: plan'), 'BAT-901'],
    ['ROLE: plan', 'plan', swapLine('Role: plan', 'ROLE: plan'), 'BAT-901'],
    ['Role: Plan', 'plan', swapLine('Role: plan', 'Role: Plan'), 'BAT-901'],
    ['agent-session: s-plan', 'plan', swapLine('Agent-Session: s-plan', 'agent-session: s-plan'), 'BAT-901'],
    ['batch: BAT-901', 'plan', swapLine('Batch: BAT-901', 'batch: BAT-901'), '-'],
    ['Fix-by: test', 'rfTest', swapLine('Fix-By: test', 'Fix-by: test'), 'BAT-901'],
  ]) {
    const { r, sha } = check(retrail(codeBatch(), label, fn));
    expectFail(r, `RC-05 ${name}`, '꼬리말', batch, sha[label]);
  }
});

test('RC-06 ① 마지막 꼬리말 덩이 밖의 Role은 세지 않는다', () => {
  // 본문 둘째 문단의 Role: impl, 끝 덩이에는 Role이 없다
  const a = set(retrail(codeBatch(), 'impl', (t) => t.filter((x) => !x.startsWith('Role: '))), 'impl', { body: '첫 문단이다.\n\nRole: impl' });
  const one = check(a);
  expectFail(one.r, 'RC-06 본문 문단의 Role', '꼬리말', 'BAT-901', one.sha.impl);
  // 꼬리말 덩이 뒤에 글 문단이 오면 그 덩이는 마지막 덩이가 아니다
  const b = set(codeBatch(), 'impl', { message: `impl: 구현\n\n${defaultTrailers(find(codeBatch(), 'impl')).join('\n')}\n\n이 문단은 꼬리말이 아니다.\n` });
  const two = check(b);
  expectFail(two.r, 'RC-06 덩이 뒤 글 문단', '꼬리말', '-', two.sha.impl);
});

test('RC-07 ① 같은 꼬리말이 둘이면 실패한다', () => {
  for (const [name, extra, batch] of [
    ['Role 둘(같은 값)', 'Role: impl', 'BAT-901'],
    ['Role 둘(다른 값)', 'Role: test', 'BAT-901'],
    ['Agent-Session 둘(같은 값)', 'Agent-Session: s-impl', 'BAT-901'],
    ['Agent-Session 둘(다른 값)', 'Agent-Session: s-impl2', 'BAT-901'],
  ]) {
    const { r, sha } = check(retrail(codeBatch(), 'impl', (t) => [...t, extra]));
    expectFail(r, `RC-07 ${name}`, '꼬리말', batch, sha.impl);
  }
  // Batch가 둘이면 묶음 자리는 -이고, 그 커밋은 어느 묶음에도 들지 않는다(계획 §1 출력 세부 셋의 둘째)
  for (const [name, extra] of [
    ['Batch 둘(같은 값)', 'Batch: BAT-901'],
    ['Batch 둘(다른 값)', 'Batch: BAT-903'],
  ]) {
    const { r, sha } = check(retrail(codeBatch(), 'impl', (t) => [...t, extra]));
    expectFail(r, `RC-07 ${name}`, '꼬리말', '-', sha.impl);
    assert.equal(batchLine(r, 'BAT-901'), summary('BAT-901', '코드', 7, [1, 1, 0, 1, 2, 1, 1, 0]), `RC-07 ${name}: 그 커밋을 BAT-901에 넣었다\n${r.all}`);
    assert.equal(batchLine(r, 'BAT-903'), undefined, `RC-07 ${name}: 그 커밋으로 BAT-903 묶음을 만들었다\n${r.all}`);
  }
});

test('RC-08 ① 목록 밖 역할 값은 실패하고 앞뒤 공백은 지운다', () => {
  for (const value of ['reviewer', 'implementation', 'review_fix', 'reviewfix', 'tests', 'Review', 'supervisor', '']) {
    const { r, sha } = check(retrail(codeBatch(), 'review', (t) => t.map((x) => (x === 'Role: review' ? `Role: ${value}` : x))));
    expectFail(r, `RC-08 Role: '${value}'`, '꼬리말', 'BAT-901', sha.review);
  }
  const { r } = check(retrail(codeBatch(), 'impl', (t) => t.map((x) => (x === 'Role: impl' ? 'Role:  impl ' : x))));
  expectPass(r, "RC-08 'Role:  impl '", 1, 8);
});

test('RC-09 ① 리뷰 반영의 Fix-By', () => {
  const noFix = (t) => t.filter((x) => !x.startsWith('Fix-By: '));
  for (const [name, label, fn] of [
    ['review-fix에 Fix-By 없음', 'rfTest', noFix],
    ['Fix-By: plan', 'rfTest', (t) => [...noFix(t), 'Fix-By: plan']],
    ['Fix-By: verify', 'rfTest', (t) => [...noFix(t), 'Fix-By: verify']],
    ['Fix-By: Test', 'rfTest', (t) => [...noFix(t), 'Fix-By: Test']],
    ['Fix-By 값이 빔', 'rfTest', (t) => [...noFix(t), 'Fix-By: ']],
    ['Fix-By 둘(같은 값)', 'rfTest', (t) => [...t, 'Fix-By: test']],
    ['Fix-By 둘(test와 impl)', 'rfTest', (t) => [...t, 'Fix-By: impl']],
    ['impl 커밋에 Fix-By', 'impl', (t) => [...t, 'Fix-By: impl']],
    ['test 커밋에 Fix-By', 'test', (t) => [...t, 'Fix-By: test']],
    ['record 커밋에 Fix-By', 'record', (t) => [...t, 'Fix-By: impl']],
  ]) {
    const { r, sha } = check(retrail(codeBatch(), label, fn));
    expectFail(r, `RC-09 ${name}`, '꼬리말', 'BAT-901', sha[label]);
  }
});

test('RC-10 ① Batch 값 꼴', () => {
  for (const value of ['../x', 'BAT 901', '.hidden', '', 'BAT..901', '-x', '_x', 'BAT/901']) {
    const { r, sha } = check(retrail(codeBatch(), 'record', (t) => t.map((x) => (x === 'Batch: BAT-901' ? `Batch: ${value}` : x))));
    expectFail(r, `RC-10 Batch: '${value}'`, '꼬리말', '-', sha.record);
    assert.equal(batchLine(r, 'BAT-901'), summary('BAT-901', '코드', 7, [1, 1, 1, 1, 2, 1, 0, 0]), `RC-10 Batch: '${value}': 그 커밋을 BAT-901에 넣었다\n${r.all}`);
  }
  // 꼴이 틀린 Batch의 커밋도 커밋 하나로 보는 검사(⑤⑥⑦)는 그대로 받고, 그 실패의 묶음 자리도 -다
  const bad = (seq, label, value) => retrail(seq, label, (t) => t.map((x) => (x === 'Batch: BAT-901' ? `Batch: ${value}` : x)));
  const tf = 'services/a/test/z.test.ts';
  const five = check(bad(addFiles(codeBatch(), 'impl', { [tf]: '구현이 더함\n' }), 'impl', '../x'));
  expectFail(five.r, 'RC-10 꼴 틀린 impl 커밋의 시험 파일', '시험 파일', '-', five.sha.impl, [tf]);
  const six = check(bad(addFiles(codeBatch(), 'record', { 'tools/x.mjs': '\n' }), 'record', '.hidden'));
  expectFail(six.r, 'RC-10 꼴 틀린 record 커밋의 코드 경로', '코드 경로', '-', six.sha.record, ['tools/x.mjs']);
  const seven = check(bad(set(codeBatch(), 'record', { session: S.impl }), 'record', 'BAT..901'));
  expectFail(seven.r, 'RC-10 꼴 틀린 record 커밋의 세션', '세션', '-', seven.sha.record, [S.impl, 'impl', 'record']);
  // 경계의 맞는 값: 한 글자, 가운데의 . _ -(기록만 묶음이라 계획 파일이 없어도 된다)
  const { r } = check([spec('rec1', 'record', 'B', S.record, { 'notes/b.md': '1\n' }), spec('rec2', 'record', 'a.b_C-9', S.record, { 'notes/c.md': '2\n' })]);
  expectPass(r, 'RC-10 맞는 값 B·a.b_C-9', 2, 2);
});

test('RC-11 ② 범위의 합치기 커밋은 실패한다', () => {
  const g = codeBatch();
  const impl = find(g, 'impl');
  const seq = g.map((s) => (s.label === 'impl' ? { ...impl, label: 'merge', merge: { ...impl, label: 'implSide' } } : s));
  const { r, sha } = check(seq);
  expectFail(r, 'RC-11', '범위', 'BAT-901', sha.merge);
});

test('RC-12 ② 실행할 수 없으면 2', () => {
  const { head } = build(codeBatch());
  expectError(run(head, { base: head }), 'RC-12 빈 범위(base=head)');
  expectError(run(head, { args: ['--base', 'no-such-rev', '--head', head] }), 'RC-12 없는 base 리비전');
  expectError(run(head, { args: ['--base', base, '--head', 'f'.repeat(40)] }), 'RC-12 없는 head 리비전');
  expectError(run(head, { args: ['--base', base, '--head', head, '--bogus'] }), 'RC-12 모르는 인자 --bogus');
  expectError(run(head, { args: ['--base', base, '--head', head, 'extra'] }), 'RC-12 모르는 인자 extra');
  expectError(run(head, { args: ['--head', head, '--base'] }), 'RC-12 값 없는 --base');
  expectError(run(head, { args: ['--base', base, '--head'] }), 'RC-12 값 없는 --head');
  expectError(run(head, { args: ['--base', base, '--head', head, '--root'] }), 'RC-12 값 없는 --root');
  const plain = tempDir('roles-check-norepo-');
  const env = { GIT_CEILING_DIRECTORIES: tmpdir() };
  expectError(run(head, { args: ['--base', base, '--head', head], cwd: plain, env }), 'RC-12 git 저장소가 아닌 지금 폴더');
  expectError(run(head, { args: ['--root', plain, '--base', base, '--head', head], env }), 'RC-12 git 저장소가 아닌 --root');
  expectError(run(head, { base: head, env: { GITHUB_ACTIONS: 'true' } }), 'RC-12 Actions의 빈 범위', '::error::');
});

test('RC-13 ② 범위 밖 커밋은 보지 않는다', () => {
  // 기준 쪽: 꼬리말 없는 커밋 셋과 합치기 커밋 하나
  checkout(base);
  const n1 = commit(dir, { 'old/a.md': '1\n' }, '꼬리말 없음 1');
  const n2 = commit(dir, { 'old/b.md': '2\n' }, '꼬리말 없음 2');
  git(dir, 'checkout', '-q', '-f', '--detach', n1);
  commit(dir, { 'old/c.md': '3\n' }, '꼬리말 없음 3');
  git(dir, 'merge', '-q', '--no-ff', '-m', '합치기', n2);
  const start = git(dir, 'rev-parse', 'HEAD');
  current = start;
  const { r } = check(codeBatch(), { start, base: start });
  expectPass(r, 'RC-13', 1, 8);
});

test('RC-14 ③ 시험보다 먼저 온 구현은 실패한다', () => {
  for (const [name, order, first] of [
    ['plan → impl → test', ['plan', 'impl', 'test'], 'impl'],
    ['test → plan → impl', ['test', 'plan', 'impl'], 'test'],
    ['impl만 첫째', ['impl', 'plan', 'test'], 'impl'],
  ]) {
    const { r, sha } = check(pick(codeBatch(), [...order, ...REST]));
    expectFail(r, `RC-14 ${name}`, '차례', 'BAT-901', sha[first]);
  }
});

test('RC-15 ③ 늦은 계획 고침과 구현 뒤 시험 커밋은 통과한다', () => {
  const g = [
    ...codeBatch(),
    spec('plan2', 'plan', 'BAT-901', S.plan, { 'docs/review/plans/BAT-901.md': `${codePlan('BAT-901')}\n정본 빈칸을 더 적었다.\n` }),
    spec('test2', 'test', 'BAT-901', S.test, { 'services/a/test/y.test.ts': '시험 3\n' }),
  ];
  const one = check(pick(g, ['plan', 'test', 'plan2', 'impl', 'test2', ...REST]));
  expectPass(one.r, 'RC-15 plan → test → plan → impl → test', 1, 10);
  assert.equal(batchLine(one.r, 'BAT-901'), summary('BAT-901', '코드', 10, [2, 2, 1, 1, 2, 1, 1, 0]), one.r.all);
  // record는 차례를 보지 않는다(맨 앞에 와도 된다)
  const two = check(pick(codeBatch(), ['record', 'plan', 'test', 'impl', 'review', 'verify', 'rfTest', 'rfImpl']));
  expectPass(two.r, 'RC-15 record가 맨 앞', 1, 8);
});

test('RC-16 ③ 리뷰·검증·리뷰 반영의 차례', () => {
  for (const [name, order, first] of [
    ['review가 첫 impl 앞', ['plan', 'test', 'review', 'impl', 'verify', 'rfTest', 'rfImpl', 'record'], 'review'],
    ['verify가 첫 review 앞', ['plan', 'test', 'impl', 'verify', 'review', 'rfTest', 'rfImpl', 'record'], 'verify'],
    ['review-fix가 review·verify 앞(impl 뒤)', ['plan', 'test', 'impl', 'rfTest', 'review', 'verify', 'rfImpl', 'record'], 'rfTest'],
  ]) {
    const { r, sha } = check(pick(codeBatch(), order));
    expectFail(r, `RC-16 ${name}`, '차례', 'BAT-901', sha[first]);
  }
  // 경계: review-fix가 첫 review 뒤·첫 verify 앞이면 통과(둘 가운데 이른 것보다 뒤)
  const { r } = check(pick(codeBatch(), ['plan', 'test', 'impl', 'review', 'rfTest', 'verify', 'rfImpl', 'record']));
  expectPass(r, 'RC-16 review → review-fix → verify', 1, 8);
});

test('RC-17 ③ 차례는 묶음마다 본다', () => {
  const seq = pick([...codeBatch(), ...bat903()], ['plan', 'test', 'b3.plan', 'b3.impl', 'impl', 'b3.test', 'b3.review', 'b3.verify', ...REST]);
  const { r, sha } = check(seq);
  expectFail(r, 'RC-17', '차례', 'BAT-903', sha['b3.impl']);
  assert.deepEqual(failures(r.out).filter((f) => f.batch === 'BAT-901'), [], `RC-17: BAT-901 실패 줄이 있다\n${r.all}`);
});

test('RC-18 ③ 문서 묶음 차례', () => {
  for (const [name, order, first] of [
    ['doc이 plan 앞', ['doc', 'plan', 'review', 'record'], 'doc'],
    ['review가 doc 앞', ['plan', 'review', 'doc', 'record'], 'review'],
  ]) {
    const { r, sha } = check(pick(docBatch(), order));
    expectFail(r, `RC-18 ${name}`, '차례', 'BAT-902', sha[first]);
  }
  // 첫 review 뒤의 doc 커밋은 막지 않는다
  const d = [...docBatch(), spec('doc2', 'doc', 'BAT-902', S.doc, { 'notes/a.md': '글 고침\n' })];
  const { r } = check(pick(d, ['plan', 'doc', 'review', 'doc2', 'record']));
  expectPass(r, 'RC-18 review 뒤 doc', 1, 5);
});

test('RC-19 ④ 코드 묶음의 역할이 빠지면 실패한다', () => {
  for (const role of ['plan', 'test', 'impl', 'review', 'verify']) {
    const { r } = check(drop(codeBatch(), role));
    expectFail(r, `RC-19 ${role} 없음`, '구성', 'BAT-901', null);
  }
  // 리뷰 반영·기록은 없어도 된다
  const { r } = check(drop(codeBatch(), 'rfTest', 'rfImpl', 'record'));
  expectPass(r, 'RC-19 review-fix·record 없음', 1, 5);
});

test('RC-20 ④ 문서 묶음 구성', () => {
  const add = (s) => pick([...docBatch(), s], ['plan', 'doc', s.label, 'review', 'record']);
  for (const [name, seq] of [
    ['review 없음', drop(docBatch(), 'review')],
    ['plan 없음', drop(docBatch(), 'plan')],
    ['test 커밋 섞임', add(spec('t', 'test', 'BAT-902', S.test, { 'notes/t.md': '시험\n' }))],
    ['impl 커밋 섞임', add(spec('i', 'impl', 'BAT-902', S.impl, { 'notes/i.md': '구현\n' }))],
    ['review-fix 커밋 섞임', add(spec('f', 'review-fix', 'BAT-902', S.test, { 'notes/f.md': '반영\n' }, { fixBy: 'test', findings: ['RV-902'] }))],
    ['verify 커밋 섞임', add(spec('v', 'verify', 'BAT-902', S.verify, { 'notes/v.md': '검증\n' }))],
  ]) {
    const { r } = check(seq);
    expectFail(r, `RC-20 ${name}`, '구성', 'BAT-902', null);
  }
});

test('RC-21 ④ 기록만 묶음은 계획 파일 없이 통과한다', () => {
  const w7 = spec('w7', 'record', 'W7-L1', S.record, { 'notes/wave7.md': '웨이브 7 보고\n' });
  const one = check([w7]);
  expectPass(one.r, 'RC-21 기록만', 1, 1);
  assert.equal(batchLine(one.r, 'W7-L1'), summary('W7-L1', '기록만', 1, [0, 0, 0, 0, 0, 0, 1, 0]), one.r.all);
  const two = check([...codeBatch(), w7]);
  expectPass(two.r, 'RC-21 코드 묶음 뒤 기록만', 2, 9);
});

test('RC-22 ⑤ 구현 커밋이 시험 파일을 바꾸면 실패한다', () => {
  const patterns = ['services/a/src/a.test.ts', 'services/a/src/b.spec.tsx', 'services/a/x/test/a.ts', 'services/a/x/test-int/a.ts', 'services/a/x/__tests__/a.ts', 'apps/web/e2e/a.ts'];
  const cases = [];
  for (const p of patterns) {
    cases.push([`${p} 더함`, addFiles(codeBatch(), 'impl', { [p]: '더함\n' }), p]);
    cases.push([`${p} 고침`, addFiles(codeBatch('BAT-901', { testFiles: { [p]: '처음\n' } }), 'impl', { [p]: '고침\n' }), p]);
    cases.push([`${p} 지움`, set(codeBatch('BAT-901', { testFiles: { [p]: '처음\n' } }), 'impl', { del: [p] }), p]);
  }
  // 경계: 맨 위 폴더 마디 test/, 앞뒤 한 글자의 a.test.b
  for (const p of ['test/a.ts', 'services/a/src/a.test.b']) cases.push([`${p} 더함`, addFiles(codeBatch(), 'impl', { [p]: '더함\n' }), p]);
  for (const [name, seq, p] of cases) {
    const { r, sha } = check(seq);
    expectFail(r, `RC-22 ${name}`, '시험 파일', 'BAT-901', sha.impl, [p]);
  }
});

test('RC-23 ⑤ 시험 파일이 아닌 비슷한 경로는 통과한다', () => {
  const near = ['services/contest/a.ts', 'src/latest/a.ts', 'src/testing.ts', 'src/test.ts', 'apps/web/e2e-utils/a.ts', 'tools/ci/git-fixture.mjs'];
  const one = check(addFiles(codeBatch(), 'impl', Object.fromEntries(near.map((p) => [p, '고침\n']))));
  expectPass(one.r, 'RC-23 계획의 예', 1, 8);
  // 경계: 대소문자가 다른 마디·이름, 마디 이름이 비슷한 것, 이름의 앞이나 뒤가 빈 것
  const edge = [
    'services/edge/Test/a.ts', 'services/edge/tests/a.ts', 'services/edge/test-ints/a.ts', 'services/edge/__tests/a.ts', 'services/edge/E2E/a.ts',
    'services/edge/e2e.ts', 'services/edge/a.Test.ts', 'services/edge/a.SPEC.ts', 'services/edge/src/.test.ts', 'services/edge/src/a.test', 'services/edge/src/a.spec',
  ];
  const two = check(addFiles(codeBatch(), 'impl', Object.fromEntries(edge.map((p) => [p, '고침\n']))));
  expectPass(two.r, 'RC-23 경계', 1, 8);
});

test('RC-24 ⑤ 시험 파일을 옮기는 구현 커밋은 실패한다', () => {
  const body = '옮겨도 같은 내용이다\n'.repeat(5);
  for (const [name, from, to, shown] of [
    ['x.test.ts → x.ts', 'services/a/src/y.test.ts', 'services/a/src/y.ts', 'services/a/src/y.test.ts'],
    ['a.ts → test/a.ts', 'services/a/src/a.ts', 'services/a/test/a.ts', 'services/a/test/a.ts'],
  ]) {
    const seq = set(codeBatch('BAT-901', { testFiles: { [from]: body } }), 'impl', { mv: [[from, to]] });
    const { r, sha } = check(seq);
    expectFail(r, `RC-24 ${name}`, '시험 파일', 'BAT-901', sha.impl, [shown]);
  }
});

test('RC-25 ⑤ 구현 쪽 리뷰 반영도 시험 파일을 못 바꾼다', () => {
  const p = 'services/a/test/x.test.ts';
  const { r, sha } = check(addFiles(codeBatch(), 'rfImpl', { [p]: '구현 담당이 고침\n' }));
  expectFail(r, 'RC-25', '시험 파일', 'BAT-901', sha.rfImpl, [p]);
});

test('RC-26 ⑥ 코드를 쓰지 않는 역할이 코드 경로를 바꾸면 실패한다', () => {
  const w7 = (files) => spec('w7', 'record', 'W7-L1', S.record, files);
  for (const [name, seq, label, batch, p] of [
    ['plan → tools/ci/x.mjs', addFiles(codeBatch(), 'plan', { 'tools/ci/x.mjs': '\n' }), 'plan', 'BAT-901', 'tools/ci/x.mjs'],
    ['plan → apps/web/a.ts', addFiles(codeBatch(), 'plan', { 'apps/web/a.ts': '\n' }), 'plan', 'BAT-901', 'apps/web/a.ts'],
    ['review → services/a/src/x.ts', addFiles(codeBatch(), 'review', { 'services/a/src/x.ts': '리뷰가 고침\n' }), 'review', 'BAT-901', 'services/a/src/x.ts'],
    ['review → data/a.sql', addFiles(codeBatch(), 'review', { 'data/a.sql': 'select 1;\n' }), 'review', 'BAT-901', 'data/a.sql'],
    ['verify → services/a/test/x.test.ts', addFiles(codeBatch(), 'verify', { 'services/a/test/x.test.ts': '검증이 고침\n' }), 'verify', 'BAT-901', 'services/a/test/x.test.ts'],
    ['verify가 services/a/src/x.ts를 지움', set(codeBatch(), 'verify', { del: ['services/a/src/x.ts'] }), 'verify', 'BAT-901', 'services/a/src/x.ts'],
    ['record → .github/workflows/a.yml', addFiles(codeBatch(), 'record', { '.github/workflows/a.yml': 'name: a\n' }), 'record', 'BAT-901', '.github/workflows/a.yml'],
    ['doc → packages/p/a.ts', addFiles(docBatch(), 'doc', { 'packages/p/a.ts': '\n' }), 'doc', 'BAT-902', 'packages/p/a.ts'],
    ['기록만 묶음 record → infra/a.tf', [...codeBatch(), w7({ 'infra/a.tf': '\n' })], 'w7', 'W7-L1', 'infra/a.tf'],
  ]) {
    const { r, sha } = check(seq);
    expectFail(r, `RC-26 ${name}`, '코드 경로', batch, sha[label], [p]);
  }
  // 경계(계획 8의 2 허용 목록): docs/ 아래, 코드 경로 밖의 .md(맨 위가 아닌 곳의 같은 이름, 비슷한 맨 위 이름 포함)
  const near = ['docs/apps/a.md', 'notes/services/a.md', 'toolbox/a.md', '.githubx/a.md', 'loadtest/README.md', 'specs/a.md'];
  const { r } = check(addFiles(codeBatch(), 'plan', Object.fromEntries(near.map((p) => [p, '\n']))));
  expectPass(r, 'RC-26 코드 경로가 아닌 곳', 1, 8);
});

// 세션 실패 줄(계획 §1 출력 세부 셋의 첫째): 세션의 역할은 범위에서 처음 나온 커밋의 역할이고, 다른 역할로 처음 나온 커밋마다
// (세션·새 역할 쌍마다) 한 줄을 그 커밋의 묶음·해시로 찍는다. 까닭에는 세션 ID, 먼저 맡은 역할, 새 역할이 이 차례로 든다
function ordered(reason, session, first, next) {
  if (!reason.includes(session)) return false;
  const rest = reason.split(session).join(' ');
  const a = rest.indexOf(first);
  return a >= 0 && rest.indexOf(next, a + first.length) > a;
}

function expectSession(r, label, want) {
  assert.equal(r.code, 1, `${label}: 끝 코드가 1이 아니다\n${r.all}`);
  const got = failures(r.out).filter((f) => f.check === '세션');
  assert.equal(got.length, want.length, `${label}: [세션] 줄이 ${want.length}개가 아니다\n${r.all}`);
  for (const [batch, sha, session, first, next] of want) {
    const hit = got.find((f) => f.batch === batch && hashOk(f.hash, sha) && ordered(f.reason, session, first, next));
    assert.ok(hit, `${label}: '실패: [세션] ${show(batch, sha)}' 줄(까닭에 ${session}, ${first} 다음 ${next})이 없다\n${r.all}`);
  }
}

test('RC-27 ⑦ 다른 역할끼리 같은 세션은 실패한다', () => {
  const one = check(set(codeBatch(), 'impl', { session: S.test }));
  expectSession(one.r, 'RC-27 impl 세션 = test 세션(같은 묶음)', [['BAT-901', one.sha.impl, S.test, 'test', 'impl']]);
  const two = check([...set(codeBatch(), 'impl', { session: 's-t3' }), ...bat903({ sessions: { test: 's-t3' } })]);
  expectSession(two.r, 'RC-27 BAT-901 impl 세션 = BAT-903 test 세션', [['BAT-903', two.sha['b3.test'], 's-t3', 'impl', 'test']]);
  const three = check(set(codeBatch(), 'record', { session: S.impl }));
  expectSession(three.r, 'RC-27 record 세션 = impl 세션', [['BAT-901', three.sha.record, S.impl, 'impl', 'record']]);
  const four = check(set(codeBatch(), 'rfTest', { session: S.impl }));
  expectSession(four.r, 'RC-27 Fix-By: test 커밋이 impl 세션', [['BAT-901', four.sha.rfTest, S.impl, 'impl', 'test']]);
  // 세션 하나가 역할 셋: 새 역할마다 처음 나온 커밋에 한 줄씩. 같은 새 역할의 두 번째 커밋(Fix-By: impl)은 줄을 더하지 않는다
  const seq = ['impl', 'review', 'rfImpl'].reduce((q, l) => set(q, l, { session: S.test }), codeBatch());
  const five = check(seq);
  expectSession(five.r, 'RC-27 세션 하나가 역할 셋', [
    ['BAT-901', five.sha.impl, S.test, 'test', 'impl'],
    ['BAT-901', five.sha.review, S.test, 'test', 'review'],
  ]);
});

test('RC-28 ⑧ 계획 파일이 머리 커밋에 없으면 실패한다', () => {
  const plan = codePlan('BAT-901');
  // 커밋하지 않고 작업 트리에만 둔다
  const { head } = build(codeBatch('BAT-901', { planPath: null }));
  write({ 'docs/review/plans/BAT-901.md': plan });
  dirtied();
  expectFail(run(head), 'RC-28 작업 트리에만', '계획 파일', 'BAT-901', null);
  for (const [name, path] of [
    ['다른 이름 bat-901.md', 'docs/review/plans/bat-901.md'],
    ['다른 폴더 docs/review/BAT-901.md', 'docs/review/BAT-901.md'],
  ]) {
    const { r } = check(codeBatch('BAT-901', { planPath: path }));
    expectFail(r, `RC-28 ${name}`, '계획 파일', 'BAT-901', null);
  }
});

test('RC-29 ⑧ 머리 커밋의 계획 파일을 읽는다', () => {
  const { head } = build(codeBatch());
  rmSync(join(dir, 'docs/review/plans/BAT-901.md'));
  dirtied();
  expectPass(run(head), 'RC-29 작업 트리에서 지움', 1, 8);
  build(codeBatch());
  write({ 'docs/review/plans/BAT-901.md': '# 작업 트리에만 있는 깨진 계획\n' });
  dirtied();
  expectPass(run(head), 'RC-29 작업 트리에서 깨뜨림', 1, 8);
  build(codeBatch());
});

test('RC-30 ⑧ 절이 없거나 비면 실패한다', () => {
  const p = codePlan('BAT-901');
  const FAIL = '## 실패 확인\n\n`node --test` 시험 3개 가운데 3개가 실패했다(아직 없음).\n\n';
  const REVIEW = '## 리뷰\n\n높음 0, 중간 1.\n\n';
  const VERIFY = '## 검증\n\n틀린 구현 1개를 모두 잡았다.\n\n';
  const TABLE = `## 담당 표\n\n${HEADER}\n${SEP}\n${codeRows().join('\n')}\n`;
  for (const [name, text] of [
    ['실패 확인 없음', swap(p, FAIL, '')],
    ['리뷰 없음', swap(p, REVIEW, '')],
    ['검증 없음', swap(p, VERIFY, '')],
    ['담당 표 없음', swap(p, TABLE, '')],
    ['## 리뷰 밑에 빈 줄만', swap(p, REVIEW, '## 리뷰\n\n\n\n')],
    ['## 리뷰 밑에 하위 제목만', swap(p, REVIEW, '## 리뷰\n\n### 세부\n\n')],
    ['## 리뷰 대기만', swap(p, REVIEW, '## 리뷰 대기\n\n높음 0, 중간 1.\n\n')],
    ['#### 리뷰만', swap(p, REVIEW, '#### 리뷰\n\n높음 0, 중간 1.\n\n')],
    ['# 리뷰만', swap(p, REVIEW, '# 리뷰\n\n높음 0, 중간 1.\n\n')],
    ['펜스 안의 ## 검증만', swap(p, VERIFY, '```text\n## 검증\n\n틀린 구현 1개를 모두 잡았다.\n```\n\n')],
  ]) {
    const { r } = check(withPlan(text));
    expectFail(r, `RC-30 ${name}`, '계획 파일', 'BAT-901', null);
  }
});

test('RC-31 ⑧ 절 제목의 허용 꼴', () => {
  const p = codePlan('BAT-901');
  const REVIEW = '## 리뷰\n\n높음 0, 중간 1.\n\n';
  const VERIFY = '## 검증\n\n틀린 구현 1개를 모두 잡았다.\n\n';
  for (const [name, text] of [
    ['## 3. 리뷰', swap(p, REVIEW, '## 3. 리뷰\n\n높음 0, 중간 1.\n\n')],
    ['### 리뷰', swap(p, REVIEW, '### 리뷰\n\n높음 0, 중간 1.\n\n')],
    ['### 3.1 검증', swap(p, VERIFY, '### 3.1 검증\n\n틀린 구현 1개를 모두 잡았다.\n\n')],
    ['하위 제목 밑에만 내용이 있는 ## 검증', swap(p, VERIFY, '## 검증\n\n### 세부\n\n틀린 구현 1개를 모두 잡았다.\n\n')],
  ]) {
    const { r } = check(withPlan(text));
    expectPass(r, `RC-31 ${name}`, 1, 9);
  }
  const { r } = check(docBatch());
  expectPass(r, 'RC-31 문서 묶음에 실패 확인·검증 없음', 1, 4);
});

test('RC-32 ⑨ 담당 표 머리·칸', () => {
  const withRows = (rows, o = {}) => codePlan('BAT-901', { rows, ...o });
  const blank = (i) => codeRows().map((l, n) => (n === 2 ? l.split('|').map((c, k) => (k === i + 1 ? '  ' : c)).join('|') : l));
  for (const [name, text] of [
    ['머리 차례 바뀜', codePlan('BAT-901', { header: '| 역할 | 세션 ID | 모델 | 끝 | 시작 |' })],
    ['머리 이름 다름', codePlan('BAT-901', { header: '| 역할 | 세션 | 모델 | 시작 | 끝 |' })],
    ['머리 칸 더 있음', codePlan('BAT-901', { header: '| 역할 | 세션 ID | 모델 | 시작 | 끝 | 메모 |', sep: '| --- | --- | --- | --- | --- | --- |', rows: codeRows().map((l) => `${l} 메모 |`) })],
    ['칸 하나 없음', withRows(codeRows().map((l, n) => (n === 2 ? `| impl | ${S.impl} | fixture-model | ${T0} |` : l)))],
    ['역할 칸 빔', withRows(blank(0))],
    ['세션 칸 빔', withRows(blank(1))],
    ['모델 칸 빔', withRows(blank(2))],
    ['시작 칸 빔', withRows(blank(3))],
    ['끝 칸 빔', withRows(blank(4))],
    ['역할 칸 record', withRows([...codeRows(), row('record', S.record)])],
    ['역할 칸 감독', withRows([...codeRows(), row('감독', S.record)])],
    ['역할 칸 review-fix', withRows([...codeRows(), row('review-fix', S.test)])],
    ['역할 칸 Plan', withRows([...codeRows(), row('Plan', 's-plan-old')])],
    ['담당 표 절에 표가 없음', swap(codePlan('BAT-901'), `${HEADER}\n${SEP}\n${codeRows().join('\n')}\n`, '담당은 위 커밋 꼬리말을 본다.\n')],
  ]) {
    const { r } = check(withPlan(text));
    expectFail(r, `RC-32 ${name}`, '담당 표', 'BAT-901', null);
  }
  // 첫 표만 담당 표다: 그 뒤의 다른 표는 보지 않는다
  const { r } = check(withPlan(codePlan('BAT-901', { after: '\n| 메모 | 값 |\n| --- | --- |\n| 아무 | 것 |\n' })));
  expectPass(r, 'RC-32 담당 표 뒤의 다른 표', 1, 9);
});

test('RC-33 ⑨ 담당 표 시각', () => {
  const at = (start, end) => codePlan('BAT-901', { rows: codeRows().map((l, n) => (n === 4 ? row('verify', S.verify, start, end) : l)) });
  for (const [name, start, end] of [
    ['오프셋 없음', '2026-11-16T07:41', T1],
    ['T 대신 빈칸', T0, '2026-11-16 07:54+09:00'],
    ['13월', '2026-13-01T00:00+09:00', '2026-13-01T00:10+09:00'],
    ['11월 31일', '2026-11-31T07:41+09:00', '2026-11-31T07:54+09:00'],
    ['윤년 아닌 2월 29일', '2026-02-29T07:41+09:00', '2026-02-29T07:54+09:00'],
    ['24시', T0, '2026-11-16T24:00+09:00'],
    ['60분', T0, '2026-11-16T07:60+09:00'],
    ['콜론 없는 오프셋', T0, '2026-11-16T07:54+0900'],
    ['끝이 시작보다 1분 이름', '2026-11-16T07:54+09:00', '2026-11-16T07:53+09:00'],
    ['오프셋을 맞추면 끝이 이름(글자로는 뒤)', '2026-11-16T07:00Z', '2026-11-16T15:30+09:00'],
  ]) {
    const { r } = check(withPlan(at(start, end)));
    expectFail(r, `RC-33 ${name}`, '담당 표', 'BAT-901', null);
  }
  for (const [name, start, end] of [
    ['끝 = 시작', T0, T0],
    ['Z', '2026-11-15T22:41Z', '2026-11-15T22:54Z'],
    ['초까지', '2026-11-16T07:41:30+09:00', '2026-11-16T07:41:30+09:00'],
    ['음수 오프셋', '2026-11-16T07:41-05:00', '2026-11-16T07:54-05:00'],
    ['윤년 2월 29일과 23:59', '2028-02-29T23:59+09:00', '2028-02-29T23:59+09:00'],
    ['오프셋이 달라도 같은 순간', '2026-11-16T07:00Z', '2026-11-16T16:00+09:00'],
    ['오프셋을 맞추면 끝이 뒤(글자로는 앞)', '2026-11-16T08:00+09:00', '2026-11-16T07:30+08:00'],
  ]) {
    const { r } = check(withPlan(at(start, end)));
    expectPass(r, `RC-33 ${name}`, 1, 9);
  }
});

test('RC-34 ⑨ 커밋의 역할·세션이 표에 있어야 한다', () => {
  for (const [name, rows] of [
    ['s-verify 줄 없음', codeRows().filter((l) => !l.includes(S.verify))],
    ['s-impl이 test 줄로 적힘', codeRows().map((l) => (l.includes(S.impl) ? row('test', S.impl) : l))],
    ['s-review 대신 다른 세션', codeRows().map((l) => (l.includes(S.review) ? row('review', 's-reviewer') : l))],
  ]) {
    const { r } = check(withPlan(codePlan('BAT-901', { rows })));
    expectFail(r, `RC-34 ${name}`, '담당 표', 'BAT-901', null);
  }
  // review-fix 세션은 test·impl 줄로 충분하고, record 세션(s-sup)은 표에 없어도 된다(좋은 묶음 그대로)
  expectPass(check(codeBatch()).r, 'RC-34 review-fix·record', 1, 8);
  // 커밋이 없는 줄이 더 있어도 된다
  const { r } = check(withPlan(codePlan('BAT-901', { rows: [...codeRows(), row('review', 's-old')] })));
  expectPass(r, 'RC-34 커밋 없는 줄', 1, 9);
});

test('RC-35 ⑩ 실패를 모두 찍고 Actions 꼴을 쓴다', () => {
  const p = 'services/a/test/100%.test.ts';
  const seq = addFiles(retrail(codeBatch(), 'record', (t) => t.filter((x) => !x.startsWith('Agent-Session: '))), 'impl', { [p]: '구현이 더함\n' });
  const { head, sha } = build(seq);
  const r = run(head);
  expectFail(r, 'RC-35 꼬리말', '꼬리말', 'BAT-901', sha.record);
  expectFail(r, 'RC-35 시험 파일', '시험 파일', 'BAT-901', sha.impl, [p]);
  assert.equal(batchLine(r, 'BAT-901'), summary('BAT-901', '코드', 8, [1, 1, 1, 1, 2, 1, 1, 0]), `RC-35: 실패해도 묶음 줄을 찍는다\n${r.all}`);
  const gh = run(head, { env: { GITHUB_ACTIONS: 'true' } });
  expectFail(gh, 'RC-35 Actions 꼬리말', '꼬리말', 'BAT-901', sha.record, [], '::error::');
  expectFail(gh, 'RC-35 Actions 시험 파일', '시험 파일', 'BAT-901', sha.impl, ['services/a/test/100%25.test.ts'], '::error::');
  assert.doesNotMatch(gh.out, /^실패: /m, `RC-35: Actions에서 '실패: ' 앞머리를 썼다\n${gh.all}`);
});

// ---- 리뷰 지적 RV-01~RV-03과 감독 결정(계획 8, 2026-11-16) ----

// 리뷰 반영 사양: 지적 번호와 바꾼 파일을 준다(시험 쪽은 s-test, 구현 쪽은 s-impl)
const rfTestOf = (label, findings, files = { 'services/a/test/x.test.ts': `시험 ${label}\n` }) => spec(label, 'review-fix', 'BAT-901', S.test, files, { fixBy: 'test', findings });
const rfImplOf = (label, findings, files = { 'services/a/src/x.ts': `export const x = () => '${label}';\n` }) => spec(label, 'review-fix', 'BAT-901', S.impl, files, { fixBy: 'impl', findings });
const BEFORE_RF = ['plan', 'test', 'impl', 'review', 'verify'];

test('RC-36 ⑤ 파이썬 시험과 test-sim 폴더도 시험 파일이다', () => {
  const cases = [];
  for (const p of ['tools/doc-check/test_public.py', 'services/q/test-sim/cluster.ts', 'services/q/test-sim/a.sim.test.ts']) {
    cases.push([`${p} 더함`, addFiles(codeBatch(), 'impl', { [p]: '더함\n' }), p]);
    cases.push([`${p} 고침`, addFiles(codeBatch('BAT-901', { testFiles: { [p]: '처음\n' } }), 'impl', { [p]: '고침\n' }), p]);
    cases.push([`${p} 지움`, set(codeBatch('BAT-901', { testFiles: { [p]: '처음\n' } }), 'impl', { del: [p] }), p]);
  }
  // 경계: test_ 뒤 한 글자
  cases.push(['services/q/py/test_a.py 더함', addFiles(codeBatch(), 'impl', { 'services/q/py/test_a.py': '더함\n' }), 'services/q/py/test_a.py']);
  for (const [name, seq, p] of cases) {
    const { r, sha } = check(seq);
    expectFail(r, `RC-36 ${name}`, '시험 파일', 'BAT-901', sha.impl, [p]);
  }
});

test('RC-37 ⑤ 파이썬·test-sim과 비슷한 경로는 시험 파일이 아니다', () => {
  // services/r/Test-sim은 계획의 services/q/Test-sim과 같은 뜻이다(대소문자만 다른 폴더가 RC-36의 services/q/test-sim과 한 저장소에서 부딪히지 않게 부모를 바꿨다)
  const near = [
    'services/q/py/test_.py', 'services/q/py/contest_a.py', 'services/q/py/test_a.pyc', 'services/q/py/test_a.py.txt', 'services/q/py/Test_a.py',
    'services/q/test-sims/a.ts', 'services/r/Test-sim/a.ts', 'apps/web/src/shared/lib/test-ts-resolve.mjs',
  ];
  const { r } = check(addFiles(codeBatch(), 'impl', Object.fromEntries(near.map((p) => [p, '고침\n']))));
  expectPass(r, 'RC-37', 1, 8);
});

test('RC-38 ⑥ 코드를 쓰지 않는 역할은 문서 밖 경로를 못 바꾼다', () => {
  const w7 = (files) => spec('w7', 'record', 'W7-L1', S.record, files);
  const cases = [
    ['review → deploy/charts/a/templates/deployment.yaml', addFiles(codeBatch(), 'review', { 'deploy/charts/a/templates/deployment.yaml': 'kind: Deployment\n' }), 'review', 'BAT-901', 'deploy/charts/a/templates/deployment.yaml'],
    ['plan → loadtest/a.mjs', addFiles(codeBatch(), 'plan', { 'loadtest/a.mjs': '\n' }), 'plan', 'BAT-901', 'loadtest/a.mjs'],
    ['verify → specs/a.tla', addFiles(codeBatch(), 'verify', { 'specs/a.tla': '\n' }), 'verify', 'BAT-901', 'specs/a.tla'],
    ['doc → .claude/settings.json', addFiles(docBatch(), 'doc', { '.claude/settings.json': '{}\n' }), 'doc', 'BAT-902', '.claude/settings.json'],
    ['기록만 묶음 record → notes/a.txt', [...codeBatch(), w7({ 'notes/a.txt': '\n' })], 'w7', 'W7-L1', 'notes/a.txt'],
    ['plan → tools/ci/README.md(코드 경로 안의 .md)', addFiles(codeBatch(), 'plan', { 'tools/ci/README.md': '# 표\n' }), 'plan', 'BAT-901', 'tools/ci/README.md'],
    ['review → apps/README.md(코드 경로 안의 .md)', addFiles(codeBatch(), 'review', { 'apps/README.md': '# 앱\n' }), 'review', 'BAT-901', 'apps/README.md'],
    ['record가 deploy/a.yaml을 지움', set(codeBatch('BAT-901', { testFiles: { 'deploy/a.yaml': 'a: 1\n' } }), 'record', { del: ['deploy/a.yaml'] }), 'record', 'BAT-901', 'deploy/a.yaml'],
    // 옛 RC-26 통과 사례(코드 경로 밖이지만 .md가 아님)와 대소문자
    ['plan → toolbox/a.mjs', addFiles(codeBatch(), 'plan', { 'toolbox/a.mjs': '\n' }), 'plan', 'BAT-901', 'toolbox/a.mjs'],
    ['plan → .githubx/a.yml', addFiles(codeBatch(), 'plan', { '.githubx/a.yml': '\n' }), 'plan', 'BAT-901', '.githubx/a.yml'],
    ['plan → notes/a.MD', addFiles(codeBatch(), 'plan', { 'notes/a.MD': '\n' }), 'plan', 'BAT-901', 'notes/a.MD'],
    // Docs/는 docs/가 없는 범위(기록만 묶음 하나)에서 만든다. 대소문자를 가리지 않는 파일 체계(Windows)에서는 docs/가 이미 있으면
    // Docs/a.yaml이 docs/a.yaml로 커밋되어 사건이 바뀐다(시험 이의 2026-11-16). 아래에서 커밋된 경로가 정말 Docs/a.yaml인지 본다
    ['기록만 묶음 record → Docs/a.yaml', [w7({ 'Docs/a.yaml': '\n' })], 'w7', 'W7-L1', 'Docs/a.yaml'],
  ];
  for (const f of ['package.json', 'pnpm-lock.yaml', 'eslint.config.mjs', 'turbo.json', '.gitignore']) {
    cases.push([`record → ${f}`, addFiles(codeBatch(), 'record', { [f]: f === '.gitignore' ? 'node_modules/\n' : '{}\n' }), 'record', 'BAT-901', f]);
  }
  for (const [name, seq, label, batch, p] of cases) {
    const { r, sha } = check(seq);
    const tree = git(dir, 'show', '--no-renames', '--name-only', '--format=', sha[label]).split(/\r?\n/);
    assert.ok(tree.includes(p), `RC-38 ${name}: 시험 사건이 틀렸다(커밋이 바꾼 경로에 ${p}가 없다: ${tree.join(', ')})`);
    expectFail(r, `RC-38 ${name}`, '코드 경로', batch, sha[label], ['문서 밖 경로', p]);
  }
});

test('RC-39 ⑥ 허용 목록 안은 통과한다', () => {
  let a = addFiles(codeBatch(), 'plan', { 'docs/api/openapi.yaml': 'openapi: 3.1.0\n', 'docs/wbs/wbs.csv': 'id\n' });
  a = addFiles(a, 'review', { '.claude/skills/x/SKILL.md': '# 기술\n' });
  a = addFiles(a, 'record', { 'specs/README.md': '# 명세\n', 'deploy/README.md': '# 배포\n' });
  const d = addFiles(docBatch(), 'doc', { 'README.md': '고침\n', 'CLAUDE.md': '# 규칙\n' }).map((s) => ({ ...s, label: `d.${s.label}` }));
  const { r } = check([...a, ...d]);
  expectPass(r, 'RC-39', 2, 12);
});

test('RC-40 ③ 구현 뒤의 plan 커밋', () => {
  const late = (files) => [...codeBatch(), spec('planLate', 'plan', 'BAT-901', S.plan, files)];
  const one = check(pick(late({ 'docs/PROGRESS.md': '정본 빈칸을 고쳤다\n' }), ['plan', 'test', 'impl', 'planLate', ...REST]));
  expectPass(one.r, 'RC-40 구현 뒤 plan이 docs/PROGRESS.md만 고침', 1, 9);
  const two = check(pick(late({ 'docs/PROGRESS.md': '정본 빈칸을 고쳤다\n', 'services/a/src/x.ts': '계획이 고침\n' }), ['plan', 'test', 'impl', 'planLate', ...REST]));
  expectFail(two.r, 'RC-40 구현 뒤 plan이 services/a/src/x.ts도 고침', '코드 경로', 'BAT-901', two.sha.planLate, ['services/a/src/x.ts']);
});

// 첫 구현 전 plan·test 섞기에 쓰는 커밋
const mixed = () => [
  ...codeBatch(),
  spec('plan2', 'plan', 'BAT-901', S.plan, { 'docs/review/plans/BAT-901.md': `${codePlan('BAT-901')}\n둘째 계획 고침.\n` }),
  spec('plan3', 'plan', 'BAT-901', S.plan, { 'docs/review/plans/BAT-901.md': `${codePlan('BAT-901')}\n셋째 계획 고침.\n` }),
  spec('test2', 'test', 'BAT-901', S.test, { 'services/a/test/y.test.ts': '시험 3\n' }),
];

test('RC-41 ③ 첫 구현 전에는 plan과 test가 섞여도 된다', () => {
  const one = check(pick(mixed(), ['plan', 'test', 'plan2', 'test2', 'plan3', 'impl', ...REST]));
  expectPass(one.r, 'RC-41 plan → test → plan → test → plan → impl', 1, 11);
  const two = check(pick(mixed(), ['plan', 'plan2', 'test', 'test2', 'impl', ...REST]));
  expectPass(two.r, 'RC-41 plan → plan → test → test → impl', 1, 10);
});

test('RC-42 ③ 첫 구현 전 섞기의 경계', () => {
  const one = check(pick(mixed(), ['test', 'plan', 'test2', 'impl', ...REST]));
  expectFail(one.r, 'RC-42 test → plan → test → impl', '차례', 'BAT-901', one.sha.test);
  const two = check(pick(mixed(), ['plan', 'plan2', 'impl', 'test', ...REST]));
  expectFail(two.r, 'RC-42 plan → plan → impl → test', '차례', 'BAT-901', two.sha.impl);
});

test('RC-43 ① Finding 꼬리말', () => {
  const noFinding = (t) => t.filter((x) => !x.startsWith('Finding: '));
  for (const [name, label, fn] of [
    ['review-fix에 Finding 없음', 'rfTest', noFinding],
    ['Finding: RV 01', 'rfTest', (t) => [...noFinding(t), 'Finding: RV 01']],
    ['Finding: ../x', 'rfTest', (t) => [...noFinding(t), 'Finding: ../x']],
    ['Finding 값이 빔', 'rfTest', (t) => [...noFinding(t), 'Finding: ']],
    ['finding: RV-901(키 대소문자)', 'rfTest', (t) => [...noFinding(t), 'finding: RV-901']],
    ['impl 커밋에 Finding', 'impl', (t) => [...t, 'Finding: RV-901']],
    ['test 커밋에 Finding', 'test', (t) => [...t, 'Finding: RV-901']],
    ['review 커밋에 Finding', 'review', (t) => [...t, 'Finding: RV-901']],
    ['plan 커밋에 Finding', 'plan', (t) => [...t, 'Finding: RV-901']],
    ['verify 커밋에 Finding', 'verify', (t) => [...t, 'Finding: RV-901']],
    ['record 커밋에 Finding', 'record', (t) => [...t, 'Finding: RV-901']],
  ]) {
    const { r, sha } = check(retrail(codeBatch(), label, fn));
    expectFail(r, `RC-43 ${name}`, '꼬리말', 'BAT-901', sha[label]);
  }
  const doc = check(retrail(docBatch(), 'doc', (t) => [...t, 'Finding: RV-902']));
  expectFail(doc.r, 'RC-43 doc 커밋에 Finding', '꼬리말', 'BAT-902', doc.sha.doc);
  // 지적 둘은 Finding 두 줄(값 꼴은 Batch와 같다: RV-01, A2-17)
  const two = check(pick([...codeBatch(), rfTestOf('rfT', ['RV-01', 'A2-17']), rfImplOf('rfI', ['RV-01', 'A2-17'])], [...BEFORE_RF, 'rfT', 'rfI', 'record']));
  expectPass(two.r, 'RC-43 Finding 두 줄', 1, 8);
});

test('RC-44 ③ 리뷰 반영은 지적마다 시험 쪽이 먼저다', () => {
  const base901 = codeBatch();
  const expectOrder = (r, label, sha, finding) => expectFail(r, label, '차례', 'BAT-901', sha, [finding]);
  const one = check(pick([...base901, rfImplOf('i1', ['RV-01'])], [...BEFORE_RF, 'i1', 'record']));
  expectOrder(one.r, 'RC-44 Fix-By: impl(RV-01)만', one.sha.i1, 'RV-01');
  const two = check(pick([...base901, rfImplOf('i1', ['RV-01']), rfTestOf('t1', ['RV-01'])], [...BEFORE_RF, 'i1', 't1', 'record']));
  expectOrder(two.r, 'RC-44 impl(RV-01) → test(RV-01)', two.sha.i1, 'RV-01');
  const three = check(pick([...base901, rfTestOf('t1', ['RV-01']), rfImplOf('i1', ['RV-01']), rfImplOf('i2', ['RV-02'])], [...BEFORE_RF, 't1', 'i1', 'i2', 'record']));
  expectOrder(three.r, 'RC-44 test(RV-01) → impl(RV-01) → impl(RV-02)', three.sha.i2, 'RV-02');
  assert.deepEqual(failures(three.r.out).filter((f) => f.check === '차례' && three.sha.i1.startsWith(f.hash)), [], `RC-44: 시험 쪽이 먼저인 impl(RV-01)에 차례 실패를 찍었다\n${three.r.all}`);
  // 시험 쪽 커밋이 다른 묶음(BAT-903)에만 있다
  const t903 = spec('b3.t1', 'review-fix', 'BAT-903', S.test, { 'services/b/test/x.test.ts': '시험 903\n' }, { fixBy: 'test', findings: ['RV-01'] });
  const four = check([...pick([...base901, rfImplOf('i1', ['RV-01'])], [...BEFORE_RF, 'i1', 'record']), ...bat903(), t903]);
  expectOrder(four.r, 'RC-44 test(RV-01)이 BAT-903에만', four.sha.i1, 'RV-01');
});

test('RC-45 ③ 리뷰 반영 차례의 통과 꼴', () => {
  const base901 = codeBatch();
  const one = check(pick([...base901, rfTestOf('t1', ['RV-01', 'RV-02']), rfImplOf('i1', ['RV-01']), rfImplOf('i2', ['RV-02'])], [...BEFORE_RF, 't1', 'i1', 'i2', 'record']));
  expectPass(one.r, 'RC-45 test(RV-01·RV-02) → impl(RV-01) → impl(RV-02)', 1, 9);
  const two = check(pick([...base901, rfTestOf('t1', ['RV-01']), rfTestOf('t2', ['RV-01']), rfImplOf('i1', ['RV-01'])], [...BEFORE_RF, 't1', 't2', 'i1', 'record']));
  expectPass(two.r, 'RC-45 test(RV-01) → test(RV-01) → impl(RV-01)', 1, 9);
  const docOnly = rfImplOf('i3', ['RV-03'], { 'tools/ci/README.md': '# 표 고침\n', 'docs/PROGRESS.md': '문구 고침\n' });
  const three = check(pick([...base901, docOnly], [...BEFORE_RF, 'rfTest', 'rfImpl', 'i3', 'record']));
  expectPass(three.r, 'RC-45 .md만 고친 impl(RV-03)', 1, 9);
});

test('RC-46 ③ 문서 예외의 경계', () => {
  for (const [name, files] of [
    ['tools/ci/README.md와 tools/ci/roles-check.mjs', { 'tools/ci/README.md': '# 표 고침\n', 'tools/ci/roles-check.mjs': '// 고침\n' }],
    ['.github/workflows/a.yml만', { '.github/workflows/a.yml': 'name: a\n' }],
    ['tools/ci/README.md.bak만', { 'tools/ci/README.md.bak': '옛 표\n' }],
  ]) {
    const { r, sha } = check(pick([...codeBatch(), rfImplOf('i3', ['RV-03'], files)], [...BEFORE_RF, 'rfTest', 'rfImpl', 'i3', 'record']));
    expectFail(r, `RC-46 ${name}`, '차례', 'BAT-901', sha.i3, ['RV-03']);
  }
});

// 정본 §8.6 세부와 ADR-0270 결정 1 표: 시험 담당은 시험과 함께 공개 인터페이스의 빈 뼈대(코드 폴더의 제품 파일)를 더한다. ⑥은 test 커밋을 보지 않는다
test('RC-47 ⑥ test 커밋은 시험 파일 밖의 코드 파일(빈 뼈대)을 바꿔도 통과한다', () => {
  const skeleton = { 'services/a/src/y.ts': "export const y = () => { throw new Error('아직 없음'); };\n", 'packages/p/src/a.ts': 'export {};\n', 'apps/web/src/a.ts': 'export {};\n', 'tools/ci/new-check.mjs': "process.stderr.write('아직 없음\\n');\n" };
  const { r } = check(addFiles(codeBatch(), 'test', skeleton));
  expectPass(r, 'RC-47', 1, 8);
});

// ---- 검증 지적 VF-01과 감독 결정의 차례 뜻(계획 9, 2026-11-16) ----

test('RC-48 ⑧⑨ 문서 묶음의 계획 파일 절과 담당 표', () => {
  const p = docPlan('BAT-902');
  const REVIEW = '## 리뷰\n\n높음 0.\n\n';
  const TABLE = `## 담당 표\n\n${HEADER}\n${SEP}\n${docRows().join('\n')}\n`;
  const late = (text) => [...docBatch(), spec('planFix', 'plan', 'BAT-902', S.plan, { 'docs/review/plans/BAT-902.md': text })];
  for (const [name, text, check_] of [
    ['리뷰 절 없음', swap(p, REVIEW, ''), '계획 파일'],
    ['## 리뷰 밑에 빈 줄만', swap(p, REVIEW, '## 리뷰\n\n\n\n'), '계획 파일'],
    ['담당 표 절 없음', swap(p, TABLE, ''), '계획 파일'],
    ['담당 표 머리 차례 바뀜', swap(p, HEADER, '| 역할 | 세션 ID | 모델 | 끝 | 시작 |'), '담당 표'],
    ['s-doc 줄 없음', docPlan('BAT-902', docRows().filter((l) => !l.includes(S.doc))), '담당 표'],
  ]) {
    const { r } = check(late(text));
    expectFail(r, `RC-48 ${name}`, check_, 'BAT-902', null);
  }
});

// 시험 먼저의 뜻(계획 9의 2): 첫 시험 쪽이 첫 구현 쪽보다 앞이면 된다. 구현 뒤의 시험 쪽 커밋은 막지 않는다
test('RC-49 ③ 구현 뒤의 시험 커밋은 통과한다', () => {
  const one = check(pick(mixed(), ['plan', 'test', 'impl', 'test2', 'review', 'verify', 'rfTest', 'rfImpl', 'record']));
  expectPass(one.r, 'RC-49 impl 뒤 test(시험 이의에 답한 고침)', 1, 9);
  const two = check(pick(mixed(), ['plan', 'test', 'impl', 'review', 'verify', 'test2', 'rfTest', 'rfImpl', 'record']));
  expectPass(two.r, 'RC-49 verify 뒤 test(살아남은 틀린 구현을 잡는 시험)', 1, 9);
});

test('RC-50 ③ 같은 지적에서 구현 쪽 뒤의 시험 쪽 커밋은 통과한다', () => {
  const one = check(pick([...codeBatch(), rfTestOf('t1', ['RV-01']), rfImplOf('i1', ['RV-01']), rfTestOf('t2', ['RV-01'])], [...BEFORE_RF, 't1', 'i1', 't2', 'record']));
  expectPass(one.r, 'RC-50 test(RV-01) → impl(RV-01) → test(RV-01)', 1, 9);
  const seq = [...codeBatch(), rfTestOf('t1', ['RV-01']), rfTestOf('t2', ['RV-02']), rfImplOf('i1', ['RV-01']), rfImplOf('i2', ['RV-02']), rfTestOf('t3', ['RV-01']), rfTestOf('t4', ['RV-02'])];
  const two = check(pick(seq, [...BEFORE_RF, 't1', 't2', 'i1', 'i2', 't3', 't4', 'record']));
  expectPass(two.r, 'RC-50 지적 둘을 엇갈려', 1, 12);
});

test('RC-51 ③ 같은 지적에서 구현 쪽이 첫 시험 쪽보다 앞서면 실패한다', () => {
  const only = (r, label, sha, finding) => {
    expectFail(r, label, '차례', 'BAT-901', sha, [finding]);
    const lines_ = failures(r.out).filter((f) => f.check === '차례');
    assert.equal(lines_.length, 1, `${label}: [차례] 줄이 하나가 아니다(뒤의 구현 쪽이나 시험이 먼저인 지적에도 찍었다)\n${r.all}`);
  };
  const one = check(pick([...codeBatch(), rfImplOf('i1', ['RV-01']), rfTestOf('t1', ['RV-01']), rfImplOf('i2', ['RV-01'])], [...BEFORE_RF, 'i1', 't1', 'i2', 'record']));
  only(one.r, 'RC-51 impl(RV-01) → test(RV-01) → impl(RV-01)', one.sha.i1, 'RV-01');
  const two = check(pick([...codeBatch(), rfTestOf('t1', ['RV-01']), rfImplOf('i2', ['RV-02']), rfImplOf('i1', ['RV-01']), rfTestOf('t2', ['RV-02'])], [...BEFORE_RF, 't1', 'i2', 'i1', 't2', 'record']));
  only(two.r, 'RC-51 RV-02만 구현 쪽이 앞섬', two.sha.i2, 'RV-02');
});
