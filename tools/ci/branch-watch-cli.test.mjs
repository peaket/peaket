// branch-watch.mjs의 명령줄 규칙(종료 코드·::warning:: 줄·대상 가지 CODEOWNERS·잡 요약)을 가짜 GitHub API 서버와 임시 git 저장소로 바깥에서 돌려 보는 시험(D-T49, FND-160). 실행: node --test "tools/ci/*.test.mjs"
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repo, commit, git, tempDir } from './git-fixture.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'branch-watch.mjs');
const REPO = 'peaket/peaket';
const QUEUE_FILE = 'services/queue-svc/src/main.ts';

// ── 가짜 GitHub API 서버(127.0.0.1의 임의 포트). 시험마다 serve()로 응답을 바꾸고 받은 요청을 비운다 ──
let server;
let apiUrl;
let handler = () => ({ status: 404, body: { message: 'Not Found' } });
let requests = [];
const serve = (fn) => {
  handler = fn;
  requests = [];
};

before(async () => {
  server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    const { status = 200, body = null } = handler(req.url) ?? {};
    res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify(body));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((ok) => server.close(ok));
});

// 자식 환경: 바깥 GITHUB_* 값(GITHUB_STEP_SUMMARY 등)을 지우고 필요한 것만 넣는다. 가짜 서버로 가는 요청은 프록시를 타지 않게 한다
function childEnv(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^GITHUB_/i.test(k) || /^no_proxy$/i.test(k)) delete env[k];
  return { ...env, NO_PROXY: '127.0.0.1', ...extra };
}

// 스크립트를 비동기로 돌린다(spawnSync는 이 프로세스의 이벤트 루프를 막아 가짜 서버가 답하지 못한다)
function run(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: childEnv(env), timeout: 60_000 });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err, all: `${out}\n${err}` }));
  });
}

const warningLines = (out) => out.split(/\r?\n/).filter((l) => l.startsWith('::warning::'));

// ── count 준비 ──
const ghPr = (number, ref, owner = REPO) => ({ number, head: { ref, repo: owner === null ? null : { full_name: owner } } });
const codeowners = (queueOwner) => `*                      @peaket/architecture\n/services/queue-svc/   ${queueOwner}\n`;
const teamWarnLine = (team) => `::warning::팀 ${team}의 열린 작업 가지가 4개다(3개 이하, docs/devops.md §2.2.1): #1, #2, #3, #4`;

// 같은 팀(대기열) 파일을 바꾸는 작업 가지 PR 넷(#1~#4)
const fourQueuePrs = (url) => {
  if (url === `/repos/${REPO}/pulls?state=open&per_page=100&page=1`) return { body: [1, 2, 3, 4].map((n) => ghPr(n, `feature/q${n}`)) };
  if (/^\/repos\/peaket\/peaket\/pulls\/[1-4]\/files\?per_page=100&page=1$/.test(url)) return { body: [{ filename: QUEUE_FILE, status: 'modified' }] };
  return { status: 404, body: { message: 'Not Found' } };
};

/**
 * 임시 저장소: 대상 가지(origin/develop)의 커밋과, 그 위에 작업 트리 커밋을 둔다.
 * base·worktree는 그 커밋의 .github/CODEOWNERS 글(null이면 두지 않는다)
 */
function countRepo({ base, worktree }) {
  const dir = repo('branch-watch-cli-');
  const baseSha = commit(dir, { 'README.md': '처음\n', ...(base === null ? {} : { '.github/CODEOWNERS': base }) }, 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/develop', baseSha);
  if (worktree !== null) commit(dir, { '.github/CODEOWNERS': worktree, [QUEUE_FILE]: '바꿈\n' }, 'feature');
  return dir;
}

// PR 사건 파일
function eventFile(ref, { number = 4, baseRef = 'develop', owner = REPO } = {}) {
  const file = join(tempDir('branch-watch-event-'), 'event.json');
  const event = {
    action: 'opened',
    pull_request: { number, head: { ref, repo: owner === null ? null : { full_name: owner } }, base: { ref: baseRef, repo: { full_name: REPO } } },
  };
  writeFileSync(file, JSON.stringify(event));
  return file;
}

const countEnv = (eventPath, extra = {}) => ({ GITHUB_REPOSITORY: REPO, GITHUB_EVENT_PATH: eventPath, GITHUB_API_URL: apiUrl, ...extra });

// ── count ──

test('FND160_DT49_명령줄 count는 release 가지 사건이면 API를 부르지 않고 경고 없이 0으로 끝난다', async () => {
  serve(fourQueuePrs);
  const cwd = countRepo({ base: codeowners('@peaket/queue'), worktree: codeowners('@peaket/queue') });
  const r = await run(['count'], { cwd, env: countEnv(eventFile('release/1.0.0')) });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(warningLines(r.out), [], r.all);
  assert.deepEqual(requests, []);
});

test('FND160_DT49_① 명령줄 count는 같은 팀 작업 가지 넷이면 대상 가지 CODEOWNERS의 주인으로 ::warning:: 줄을 내고 0으로 끝난다', async () => {
  serve(fourQueuePrs);
  const cwd = countRepo({ base: codeowners('@peaket/base-queue'), worktree: codeowners('@peaket/worktree-queue') });
  const r = await run(['count'], { cwd, env: countEnv(eventFile('feature/q4')) });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(warningLines(r.out), [teamWarnLine('@peaket/base-queue')], r.all);
  assert.doesNotMatch(r.out, /worktree-queue/);
});

test('FND160_DT49_명령줄 count는 대상 가지에 CODEOWNERS가 없거나 대상 가지가 없으면 작업 트리의 것을 쓴다', async () => {
  serve(fourQueuePrs);
  const cwd = countRepo({ base: null, worktree: codeowners('@peaket/worktree-queue') });
  const r = await run(['count'], { cwd, env: countEnv(eventFile('feature/q4')) });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(warningLines(r.out), [teamWarnLine('@peaket/worktree-queue')], r.all);
  // 대상 가지(origin/nope)가 없을 때
  serve(fourQueuePrs);
  const r2 = await run(['count'], { cwd, env: countEnv(eventFile('feature/q4', { baseRef: 'nope' })) });
  assert.equal(r2.code, 0, r2.all);
  assert.deepEqual(warningLines(r2.out), [teamWarnLine('@peaket/worktree-queue')], r2.all);
});

test('FND160_DT49_명령줄 count에 --codeowners 파일을 주면 그 파일만 쓴다', async () => {
  serve(fourQueuePrs);
  const cwd = countRepo({ base: codeowners('@peaket/base-queue'), worktree: codeowners('@peaket/worktree-queue') });
  const flag = join(tempDir('branch-watch-co-'), 'CODEOWNERS');
  writeFileSync(flag, codeowners('@peaket/flag-queue'));
  const r = await run(['count', '--codeowners', flag], { cwd, env: countEnv(eventFile('feature/q4')) });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(warningLines(r.out), [teamWarnLine('@peaket/flag-queue')], r.all);
  assert.doesNotMatch(r.out, /base-queue|worktree-queue/);
});

test('FND160_DT49_⑥ 명령줄 count는 API가 500을 돌려줘도 읽지 못했다는 경고를 내고 0으로 끝난다', async () => {
  serve(() => ({ status: 500, body: { message: 'Server Error' } }));
  const cwd = countRepo({ base: codeowners('@peaket/queue'), worktree: codeowners('@peaket/queue') });
  const r = await run(['count'], { cwd, env: countEnv(eventFile('feature/q4')) });
  assert.equal(r.code, 0, r.all);
  const lines = warningLines(r.out);
  assert.equal(lines.length, 1, r.all);
  assert.ok(lines[0].startsWith('::warning::작업 가지 수를 읽지 못했다: '), lines[0]);
  assert.ok(requests.length > 0, '서버가 요청을 받지 않았다');
});

test('FND160_DT49_명령줄은 토큰이 있으면 요청마다 Authorization: Bearer로 싣고 없으면 싣지 않는다', async () => {
  serve(fourQueuePrs);
  const cwd = countRepo({ base: codeowners('@peaket/queue'), worktree: codeowners('@peaket/queue') });
  const r = await run(['count'], { cwd, env: countEnv(eventFile('feature/q4'), { GITHUB_TOKEN: 'test-token-123' }) });
  assert.equal(r.code, 0, r.all);
  assert.ok(requests.length > 0, '서버가 요청을 받지 않았다');
  for (const q of requests) assert.equal(q.authorization, 'Bearer test-token-123', q.url);
  serve(fourQueuePrs);
  const r2 = await run(['count'], { cwd, env: countEnv(eventFile('feature/q4')) });
  assert.equal(r2.code, 0, r2.all);
  assert.ok(requests.length > 0, '서버가 요청을 받지 않았다');
  for (const q of requests) assert.equal(q.authorization, undefined, q.url);
});

test('FND160_DT49_명령줄 count는 사건 파일을 읽지 못하면 1로 끝난다', async () => {
  serve(fourQueuePrs);
  const cwd = countRepo({ base: codeowners('@peaket/queue'), worktree: codeowners('@peaket/queue') });
  const missing = join(tempDir('branch-watch-event-'), 'none.json');
  const r = await run(['count'], { cwd, env: countEnv(missing) });
  assert.equal(r.code, 1, r.all);
  const env = countEnv(missing);
  delete env.GITHUB_EVENT_PATH;
  const r2 = await run(['count'], { cwd, env });
  assert.equal(r2.code, 1, r2.all);
});

test('FND160_DT49_명령줄 count는 --codeowners 파일이 없으면 다른 CODEOWNERS로 넘어가지 않고 1로 끝난다', async () => {
  serve(fourQueuePrs);
  const cwd = countRepo({ base: codeowners('@peaket/base-queue'), worktree: codeowners('@peaket/worktree-queue') });
  const r = await run(['count', '--codeowners', join(tempDir('branch-watch-co-'), 'none')], { cwd, env: countEnv(eventFile('feature/q4')) });
  assert.equal(r.code, 1, r.all);
  assert.deepEqual(warningLines(r.out), [], r.all);
});

test('FND160_DT49_명령줄 count는 대상 가지에도 작업 트리에도 CODEOWNERS가 없으면 1로 끝난다', async () => {
  serve(fourQueuePrs);
  const cwd = countRepo({ base: null, worktree: null });
  const r = await run(['count'], { cwd, env: countEnv(eventFile('feature/q4')) });
  assert.equal(r.code, 1, r.all);
});

test('FND160_DT49_명령줄 count는 세지 않을 PR(작업 가지 아님·포크)이면 CODEOWNERS가 없어도 읽지 않고 0으로 끝난다', async () => {
  serve(fourQueuePrs);
  const cwd = countRepo({ base: null, worktree: null });
  for (const event of [eventFile('release/1.0.0'), eventFile('feature/q4', { owner: 'someone/fork' }), eventFile('feature/q4', { owner: null })]) {
    const r = await run(['count'], { cwd, env: countEnv(event) });
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(warningLines(r.out), [], r.all);
  }
  assert.deepEqual(requests, []);
});

// ── weekly ──

/**
 * origin/develop 첫 부모 이력에 병합 커밋을 차례로 둔 저장소. merges는 [제목, 며칠 전](0이면 지금).
 * 병합 커밋의 시각은 GIT_AUTHOR_DATE·GIT_COMMITTER_DATE로 둔다(git log --since는 커밋 시각을 본다)
 */
function mergesRepo(merges) {
  const dir = repo('branch-watch-weekly-');
  commit(dir, { 'README.md': '처음\n' }, 'base');
  const shas = [];
  merges.forEach(([subject, daysAgo], i) => {
    const side = `side-${i}`;
    git(dir, 'switch', '-q', '-c', side, 'main');
    commit(dir, { [`${side}.txt`]: `${side}\n` }, side);
    git(dir, 'switch', '-q', 'main');
    const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    const env = daysAgo ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
    const r = spawnSync('git', ['merge', '-q', '--no-ff', '-m', subject, side], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    shas.push(git(dir, 'rev-parse', 'HEAD'));
  });
  git(dir, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
  return { dir, shas };
}

/** origin/develop 첫 부모 이력에 병합 커밋 둘(feature/a%b, release/1.0.0)을 둔 저장소 */
function weeklyRepo() {
  const { dir, shas } = mergesRepo([
    ["Merge branch 'feature/a%b'", 0],
    ["Merge branch 'release/1.0.0'", 0],
  ]);
  return { dir, featureMerge: shas[0], releaseMerge: shas[1] };
}

const commitPullsUrl = (sha) => `/repos/${REPO}/commits/${sha}/pulls`;
const hasNumber = (text, n) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(text);

const weeklyEnv = (extra = {}) => ({ GITHUB_REPOSITORY: REPO, GITHUB_API_URL: apiUrl, ...extra });

test('FND160_DT49_④⑤ 명령줄 weekly는 feature 병합 커밋을 %를 %25로 바꾼 ::warning:: 줄로 내고 요약을 잡 요약 파일과 표준 출력에 낸다', async () => {
  const { dir, featureMerge, releaseMerge } = weeklyRepo();
  serve((url) => (/^\/repos\/peaket\/peaket\/commits\/[0-9a-f]{40}\/pulls$/.test(url) ? { body: [] } : { status: 404, body: { message: 'Not Found' } }));
  const summaryFile = join(tempDir('branch-watch-summary-'), 'summary.md');
  const prior = '이전 단계의 요약\n';
  writeFileSync(summaryFile, prior);
  const r = await run(['weekly'], { cwd: dir, env: weeklyEnv({ GITHUB_STEP_SUMMARY: summaryFile }) });
  assert.equal(r.code, 0, r.all);
  const short = featureMerge.slice(0, 7);
  assert.deepEqual(
    warningLines(r.out),
    [`::warning::${short} feature/a%25b: develop에 병합 커밋으로 들어왔다(작업 가지는 스쿼시, §2.2.6)`],
    r.all,
  );
  assert.deepEqual(
    [...new Set(requests.map((q) => q.url))].sort(),
    [featureMerge, releaseMerge].map((sha) => `/repos/${REPO}/commits/${sha}/pulls`).sort(),
  );
  // 잡 요약 파일 끝에 붙는다(앞의 글은 그대로)
  const written = readFileSync(summaryFile, 'utf8');
  assert.ok(written.startsWith(prior), written);
  const appended = written.slice(prior.length).trim();
  assert.ok(appended.includes(`${short} feature/a%b: develop에 병합 커밋으로 들어왔다(작업 가지는 스쿼시, §2.2.6)`), appended);
  // release 병합 커밋에 대한 경고 글은 없다
  assert.ok(!appended.includes(`${releaseMerge.slice(0, 7)} release/1.0.0:`), appended);
  // 표준 출력에도 같은 요약이 나온다
  assert.ok(r.out.includes(appended), `표준 출력에 요약이 없다:\n${r.out}`);
});

test('FND160_DT49_⑥ 명령줄 weekly는 API가 500이어도 커밋마다 병합 PR을 읽지 못했다는 ::warning:: 줄을 내고 0으로 끝난다', async () => {
  const { dir, featureMerge, releaseMerge } = weeklyRepo();
  serve(() => ({ status: 500, body: { message: 'Server Error' } }));
  const r = await run(['weekly'], { cwd: dir, env: weeklyEnv() });
  assert.equal(r.code, 0, r.all);
  const lines = warningLines(r.out);
  for (const sha of [featureMerge, releaseMerge]) {
    assert.ok(lines.some((l) => l.startsWith(`::warning::${sha.slice(0, 7)}: 병합 PR을 읽지 못했다: `)), `${sha}\n${r.all}`);
  }
});

test('FND160_DT49_명령줄 ::warning:: 줄은 %를 %25로, CR·LF를 %0D·%0A로 바꿔 경고 하나를 한 줄로 낸다', async () => {
  const { dir, featureMerge, releaseMerge } = weeklyRepo();
  serve((url) => {
    if (url === commitPullsUrl(featureMerge)) return { body: [{ number: 1, merge_commit_sha: featureMerge, head: { ref: 'feature/a%b\r\nc' } }] };
    if (url === commitPullsUrl(releaseMerge)) return { body: [] };
    return { status: 404, body: { message: 'Not Found' } };
  });
  const r = await run(['weekly'], { cwd: dir, env: weeklyEnv() });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(
    warningLines(r.out),
    [`::warning::${featureMerge.slice(0, 7)} feature/a%25b%0D%0Ac: develop에 병합 커밋으로 들어왔다(작업 가지는 스쿼시, §2.2.6)`],
    r.all,
  );
});

test('FND160_DT49_명령줄 weekly --since-days n은 git log가 고르는 기간(커밋 시각 기준)과 요약에 쓰인다', async () => {
  // 첫 병합 커밋은 10일 전, 둘째는 지금
  const { dir, shas } = mergesRepo([
    ["Merge branch 'feature/old'", 10],
    ["Merge branch 'feature/new'", 0],
  ]);
  serve(() => ({ body: [] }));
  const r8 = await run(['weekly'], { cwd: dir, env: weeklyEnv() });
  assert.equal(r8.code, 0, r8.all);
  assert.deepEqual([...new Set(requests.map((q) => q.url))], [commitPullsUrl(shas[1])], '기본 8일 창에는 지금 커밋만 든다');
  serve(() => ({ body: [] }));
  const r13 = await run(['weekly', '--since-days', '13'], { cwd: dir, env: weeklyEnv() });
  assert.equal(r13.code, 0, r13.all);
  assert.deepEqual([...new Set(requests.map((q) => q.url))].sort(), shas.map(commitPullsUrl).sort(), '13일 창에는 둘 다 든다');
  assert.ok(hasNumber(r13.out, 13), `요약에 기간 13이 없다:\n${r13.out}`);
});

test('FND160_DT49_명령줄 weekly는 가지 이력을 읽지 못하면 1로 끝난다', async () => {
  const { dir } = weeklyRepo();
  serve(() => ({ body: [] }));
  const r = await run(['weekly', '--branch', 'origin/nope'], { cwd: dir, env: weeklyEnv() });
  assert.equal(r.code, 1, r.all);
});

test('FND160_DT49_명령줄 쓰는 법 오류(--since-days가 1 이상의 정수가 아님·모르는 명령·GITHUB_REPOSITORY 없음)는 2로 끝난다', async () => {
  const { dir } = weeklyRepo();
  serve(() => ({ body: [] }));
  for (const days of ['0', 'abc', '1.5']) {
    const r = await run(['weekly', '--since-days', days], { cwd: dir, env: weeklyEnv() });
    assert.equal(r.code, 2, `--since-days ${days}: ${r.all}`);
  }
  const unknown = await run(['monthly'], { cwd: dir, env: weeklyEnv() });
  assert.equal(unknown.code, 2, unknown.all);
  const env = weeklyEnv();
  delete env.GITHUB_REPOSITORY;
  for (const command of ['weekly', 'count']) {
    const r = await run([command], { cwd: dir, env: { ...env, GITHUB_EVENT_PATH: eventFile('feature/q4') } });
    assert.equal(r.code, 2, `${command}: ${r.all}`);
  }
});
