// 에이전트 훅 시험(ADR-0330, tools/claude-hooks). 시험 입력은 이 파일 안에 둔다: 셸 명령줄로 넘기면
// 시험하려는 명령(예: git add -A)을 셸 훅이 먼저 막는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { repo, commit, git, tempDir } from './git-fixture.mjs';
import { parseCommand } from '../claude-hooks/shell.mjs';
import { pre, post } from '../claude-hooks/shell-rules.mjs';
import { preEdit, postEdit } from '../claude-hooks/edit-rules.mjs';
import { unattended } from '../claude-hooks/lib.mjs';
import { main as unattendedMain } from '../claude-hooks/unattended.mjs';

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'claude-hooks');
const ROOT = resolve(HOOKS, '..', '..');

const decision = (out) =>
  out?.hookSpecificOutput?.permissionDecision ?? (out?.hookSpecificOutput?.additionalContext ? 'note' : 'pass');

// 가지 develop에 커밋 하나가 있는 시험 저장소
function devRepo() {
  const dir = repo('claude-hooks-');
  commit(dir, { 'docs/a.md': '# a\n' }, 'docs: 처음');
  git(dir, 'branch', '-M', 'develop');
  return dir;
}
const DEV = devRepo();
const shell = (command, cwd = DEV, tool = 'Bash') => decision(pre({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd }));

test('CH-01 ① 명령 가르기: 구분자·따옴표·전역 옵션', () => {
  const { segments } = parseCommand('cd x && git add "a b.md"; echo "git add -A" | cat');
  assert.deepEqual(segments, [['cd', 'x'], ['git', 'add', 'a b.md'], ['echo', 'git add -A'], ['cat']]);
});

test('CH-01 ② heredoc·here-string 본문은 명령이 아니다', () => {
  const bash = parseCommand("cat > /tmp/m <<'EOF'\nfix: x\n\ngit add -A 를 막는다\nEOF\ngit commit -F /tmp/m");
  assert.deepEqual(bash.heredocs, ['fix: x\n\ngit add -A 를 막는다']);
  assert.ok(!bash.segments.some((w) => w.includes('-A')));
  const ps = parseCommand("git commit -m @'\nfix: y\r\n\r\ngit reset --hard 금지\n'@");
  assert.equal(ps.herestrings.length, 1);
  assert.ok(!ps.segments.some((w) => w.includes('--hard')));
});

test('CH-02 ① 작업 트리 전체 스테이징은 막는다', () => {
  for (const c of ['git add -A', 'git add --all', 'git add .', 'git add -u', 'git add :/', 'git -C sub add -A', 'cd x && git add -A', 'FOO=1 git add .']) {
    assert.equal(shell(c), 'deny', c);
  }
  assert.equal(shell('git add -A', DEV, 'PowerShell'), 'deny');
  assert.equal(shell('& git add .', DEV, 'PowerShell'), 'deny');
});

test('CH-02 ② 파일을 골라 스테이징하면 통과, 폴더·글롭은 묻는다', () => {
  assert.equal(shell('git add docs/a.md tools/x.mjs'), 'pass');
  assert.equal(shell('git add -A -- docs/a.md'), 'pass');
  assert.equal(shell('git add --dry-run -A'), 'pass');
  assert.equal(shell('git add docs'), 'ask');
  assert.equal(shell('git add docs/*.md'), 'ask');
  assert.equal(shell('echo "git add -A"'), 'pass');
});

test('CH-03 ① commit -a는 막는다', () => {
  assert.equal(shell('git commit -a -m "fix: x (A-1)"'), 'deny');
  assert.equal(shell('git commit -am "fix: x (A-1)"'), 'deny');
  assert.equal(shell('git commit --all -m "fix: x (A-1)"'), 'deny');
  assert.equal(shell('git commit --amend --no-edit'), 'pass');
});

test('CH-03 ② 커밋 제목은 Conventional Commits 꼴이어야 한다', () => {
  assert.equal(shell('git commit -m "fix(gateways): 경로를 고친다 (LCH-080)"'), 'pass');
  assert.equal(shell('git commit -m "경로를 고친다"'), 'deny');
  assert.equal(shell('git commit -m "feature: 새 기능"'), 'deny');
  assert.equal(shell("git commit -m \"$(cat <<'EOF'\nfix: 고친다 (R-1)\n\n본문\nEOF\n)\""), 'pass');
  assert.equal(shell("git commit -m \"$(cat <<'EOF'\n고친다\nEOF\n)\""), 'deny');
  assert.equal(shell("git commit -m @'\nfeat(queue): 줄 (Q-1)\r\n\r\n본문\n'@", DEV, 'PowerShell'), 'pass');
  assert.equal(shell("git commit -m @'\n그냥 고침\n'@", DEV, 'PowerShell'), 'deny');
  assert.equal(shell("git commit -F - <<'EOF'\nfeat: x\n\nBREAKING CHANGE: 깨진다\nEOF"), 'deny');
  writeFileSync(join(DEV, 'msg.txt'), 'docs: 적는다 (D-1)\n');
  assert.equal(shell('git commit -F msg.txt'), 'pass');
  writeFileSync(join(DEV, 'bad.txt'), '그냥\n');
  assert.equal(shell('git commit -F bad.txt'), 'deny');
});

test('CH-04 ① 강제 푸시는 막는다', () => {
  for (const c of ['git push --force', 'git push -f origin develop', 'git push origin +develop', 'git push --force-with-lease origin develop', 'git push --force-with-lease']) {
    assert.equal(shell(c), 'deny', c);
  }
  assert.equal(shell('git push --force-with-lease origin lane4-r2'), 'ask');
});

test('CH-04 ② develop 밖 원격 가지·태그 푸시는 묻는다', () => {
  for (const c of ['git push origin develop', 'git push origin HEAD:develop', 'git push origin HEAD:refs/heads/develop', 'git push', 'git push -u origin develop', 'git push . HEAD:refs/heads/develop']) {
    assert.equal(shell(c), 'pass', c);
  }
  for (const c of ['git push origin main', 'git push origin lane1', 'git push origin v1.0.0', 'git push --tags', 'git push origin --delete lane1', 'git push origin :lane1']) {
    assert.equal(shell(c), 'ask', c);
  }
  const lane = devRepo();
  git(lane, 'checkout', '-q', '-b', 'lane1');
  assert.equal(shell('git push', lane), 'ask');
  assert.equal(shell('git push origin HEAD', lane), 'ask');
  assert.equal(shell('git push origin HEAD:develop', lane), 'pass');
});

test('CH-05 ① 작업 트리 버리기: 전체는 막고 경로는 묻는다', () => {
  for (const c of ['git reset --hard', 'git reset --hard origin/develop', 'git clean -fd', 'git checkout -- .', 'git checkout .', 'git restore .', 'git restore --worktree --staged .']) {
    assert.equal(shell(c), 'deny', c);
  }
  for (const c of ['git checkout -- docs/a.md', 'git checkout HEAD -- docs/a.md', 'git restore docs/a.md', 'git switch lane1', 'git checkout -b lane9', 'git stash', 'git stash push -- docs/a.md', 'git update-ref refs/heads/develop abc']) {
    assert.equal(shell(c), 'ask', c);
  }
  for (const c of ['git reset HEAD docs/a.md', 'git clean -n', 'git restore --staged docs/a.md', 'git stash list', 'git checkout develop', 'git status', 'git log -1 --format=%s']) {
    assert.equal(shell(c), 'pass', c);
  }
});

test('CH-06 ① npm·yarn 설치는 막고 pnpm·npx·npm run은 통과', () => {
  for (const c of ['npm install express', 'npm i -D vitest', 'npm ci', 'yarn', 'yarn add lodash', 'npm.cmd install', 'npm install --global pnpm@12']) {
    assert.equal(shell(c), 'deny', c);
  }
  for (const c of ['pnpm install --frozen-lockfile', 'npm run build', 'npx tsc -p .', 'npm view react version', 'corepack pnpm install --frozen-lockfile']) {
    assert.equal(shell(c), 'pass', c);
  }
});

test('CH-06 ② 막는 것이 섞이면 묻기보다 막기가 이긴다', () => {
  assert.equal(shell('git push origin lane1 && git reset --hard'), 'deny');
});

test('CH-07 ① 커밋 뒤 제목 끝 ID가 없으면 알린다', () => {
  const p = (command) => decision(post({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, cwd: DEV }));
  assert.equal(p('git commit -m "docs(claude): 다시 쓴다"'), 'note');
  for (const id of ['LCH-080', 'R-726', 'QR-MA-2', 'ADR-0330', 'BAT-616 검증']) {
    assert.equal(p(`git commit -m "fix(x): 고친다 (${id})"`), 'pass', id);
  }
  assert.equal(p('git status'), 'pass');
});

test('CH-08 ① 생성 파일·다른 잠금 파일 편집은 막는다', () => {
  const dir = repo('claude-hooks-edit-');
  const e = (rel, tool = 'Edit') => decision(preEdit({ tool_name: tool, tool_input: { file_path: join(dir, rel) } }));
  for (const rel of [
    'packages/contracts/src/gen/openapi/x.ts',
    'packages/api-client/src/gen/operations.ts',
    'packages/ds/src/gen/tokens.css',
    'deploy/local/dashboards/queue-svc.json',
    'apps/web/package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'tools/web-checks/pnpm-lock.yaml',
  ]) {
    assert.equal(e(rel), 'deny', rel);
  }
  mkdirSync(join(dir, 'deploy/gateways'), { recursive: true });
  writeFileSync(join(dir, 'deploy/gateways/gw-fan.routes.yaml'), '# 생성 파일이다. 손으로 고치지 않는다(원천 …)\n---\n');
  writeFileSync(join(dir, 'deploy/gateways/gen.mjs'), '#!/usr/bin/env node\n// 생성 파일이다. 손으로 고치지 않는다\n');
  writeFileSync(join(dir, 'deploy/gateways/gw-fan.yaml'), '# 게이트웨이 정의. 생성 파일이다라는 말이 둘째 줄에 있어도\n# 생성 파일이다\n');
  assert.equal(e('deploy/gateways/gw-fan.routes.yaml'), 'deny');
  assert.equal(e('deploy/gateways/gen.mjs'), 'deny');
  assert.equal(e('deploy/gateways/gw-fan.yaml'), 'pass');
  assert.equal(e('services/queue-svc/src/main.ts', 'Write'), 'pass');
  assert.equal(decision(preEdit({ tool_name: 'Write', tool_input: { file_path: join(tempDir('claude-hooks-out-'), 'package-lock.json') } })), 'pass');
});

test('CH-09 ① 원천을 고치면 할 일을 세션마다 한 번 알린다', () => {
  const dir = repo('claude-hooks-post-');
  const session = randomUUID();
  const p = (rel) => postEdit({ session_id: session, tool_name: 'Edit', tool_input: { file_path: join(dir, rel) } });
  const first = p('docs/api/openapi.yaml');
  assert.equal(decision(first), 'note');
  assert.match(first.hookSpecificOutput.additionalContext, /@peaket\/contracts gen/);
  assert.match(first.hookSpecificOutput.additionalContext, /@peaket\/api-client gen/);
  assert.match(first.hookSpecificOutput.additionalContext, /gateway-routes\.mjs --write/);
  assert.equal(decision(p('docs/api/openapi.yaml')), 'pass');
  assert.match(p('packages/platform/src/metrics.ts').hookSpecificOutput.additionalContext, /dashboards\.mjs[\s\S]*turbo run build --filter=@peaket\/platform/);
  assert.match(p('packages/seatmap/src/a.ts').hookSpecificOutput.additionalContext, /@peaket\/core-svc/);
  assert.match(p('services/pg-simulator/src/a.ts').hookSpecificOutput.additionalContext, /@peaket\/purchase-svc/);
  assert.equal(decision(p('services/queue-svc/src/a.ts')), 'pass');
});

const runHook = (script, payload) =>
  spawnSync(process.execPath, [join(HOOKS, script)], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', timeout: 20000 });

test('CH-10 ① 실행 파일은 판정을 JSON으로 내고 끝 코드 0이다', () => {
  const s = runHook('guard-shell.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git reset --hard' }, cwd: DEV });
  assert.equal(s.status, 0);
  assert.equal(JSON.parse(s.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const n = runHook('guard-shell.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m "docs: x"' }, cwd: DEV });
  assert.ok(JSON.parse(n.stdout).hookSpecificOutput.additionalContext);
  const ed = runHook('guard-edit.mjs', { tool_name: 'Write', tool_input: { file_path: join(DEV, 'yarn.lock') } });
  assert.equal(JSON.parse(ed.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const pe = runHook('post-edit.mjs', { session_id: randomUUID(), tool_name: 'Edit', tool_input: { file_path: join(DEV, 'docs/design/tokens.json') } });
  assert.match(JSON.parse(pe.stdout).hookSpecificOutput.additionalContext, /@peaket\/ds tokens/);
});

test('CH-10 ② 입력이 깨지거나 비면 막지 않고 통과한다', () => {
  for (const script of ['guard-shell.mjs', 'guard-edit.mjs', 'post-edit.mjs']) {
    for (const payload of ['{깨진', '', '{}']) {
      const r = runHook(script, payload);
      assert.equal(r.status, 0, `${script} ${payload}`);
      assert.equal(r.stdout, '', `${script} ${payload}`);
    }
  }
});

test('CH-11 ① 공유 설정이 훅 넷을 잇고, 가리키는 파일이 있다', () => {
  const settings = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8'));
  const entries = Object.entries(settings.hooks).flatMap(([event, list]) => list.flatMap((m) => m.hooks.map((h) => ({ event, matcher: m.matcher, command: h.command }))));
  const find = (event, script) => entries.find((e) => e.event === event && e.command.includes(`tools/claude-hooks/${script}`));
  assert.equal(find('PreToolUse', 'guard-shell.mjs')?.matcher, 'Bash|PowerShell');
  assert.equal(find('PostToolUse', 'guard-shell.mjs')?.matcher, 'Bash|PowerShell');
  assert.match(find('PreToolUse', 'guard-edit.mjs')?.matcher ?? '', /^Write\|Edit\|MultiEdit\|NotebookEdit$/);
  assert.match(find('PostToolUse', 'post-edit.mjs')?.matcher ?? '', /^Write\|Edit\|MultiEdit$/);
  for (const e of entries.filter((x) => x.command.includes('tools/claude-hooks/'))) {
    const file = e.command.match(/tools\/claude-hooks\/[\w-]+\.mjs/)[0];
    assert.ok(existsSync(join(ROOT, file)), file);
  }
  // 강제 푸시 금지(permissions.deny)는 PowerShell 도구에도 건다
  assert.ok(settings.permissions.deny.some((r) => r.startsWith('PowerShell(git push --force')));
});

// 명령줄에 넣는 경로는 / 로 쓴다(\ 는 셸 낱말 가르기에서 이스케이프로 읽힌다)
const slash = (p) => p.split('\\').join('/');

test('CH-12 ① 갈래 작업 폴더(링크된 worktree)에서 가지 만들기·바꾸기는 묻지 않는다', () => {
  const main = devRepo();
  const wt = slash(join(tempDir('claude-hooks-wt-'), 'lane9'));
  git(main, 'worktree', 'add', '-q', '-b', 'feature/lane9-x', wt);
  for (const c of ['git switch -c feature/lane9-y origin/develop', 'git checkout -b feature/lane9-z', 'git switch develop']) {
    assert.equal(shell(c, wt), 'pass', c);
  }
  assert.equal(shell(`git -C ${wt} switch -c feature/lane9-w origin/develop`, main), 'pass');
  assert.equal(shell(`cd ${wt} && git switch -c feature/lane9-v`, main), 'pass');
  assert.equal(shell(`Set-Location ${wt}; git switch -c feature/lane9-t`, main, 'PowerShell'), 'pass');
  // 메인 작업 트리(여러 세션이 함께 씀)는 그대로 묻는다. 작업 폴더라도 stash·되돌리기는 묻는다
  assert.equal(shell('git switch -c feature/lane9-u', main), 'ask');
  assert.equal(shell(`cd ${wt} && git -C ${slash(main)} switch lane9`, main), 'ask');
  assert.equal(shell(`cd ${wt} && git stash`, main), 'ask');
  assert.equal(shell('git restore docs/a.md', wt), 'ask');
});

test('CH-12 ② feature/* 가지 올리기·lease·지우기는 묻지 않고, main·다른 가지는 묻는다', () => {
  for (const c of [
    'git push -u origin feature/lane1-BAT-059',
    'git push origin HEAD:refs/heads/feature/lane1-BAT-059',
    'git push --force-with-lease origin feature/lane1-BAT-059',
    'git push origin --delete feature/lane1-BAT-059',
    'git push origin :feature/lane1-BAT-059',
    'git push origin HEAD:develop feature/lane1-BAT-059',
  ]) {
    assert.equal(shell(c), 'pass', c);
  }
  const lane = devRepo();
  git(lane, 'checkout', '-q', '-b', 'feature/lane2-BAT-350');
  assert.equal(shell('git push', lane), 'pass');
  assert.equal(shell('git push origin HEAD', lane), 'pass');
  for (const c of ['git push origin main', 'git push origin lane1', 'git push --force-with-lease origin lane4-r2', 'git push origin --delete lane1', 'git push origin feature/x main']) {
    assert.equal(shell(c), 'ask', c);
  }
  assert.equal(shell('git push --force-with-lease origin feature/x develop'), 'deny');
  assert.equal(shell('git push --force origin feature/lane1-x'), 'deny');
});

function withState(fn) {
  const state = tempDir('claude-hooks-state-');
  const old = process.env.PEAKET_HOOKS_STATE_DIR;
  process.env.PEAKET_HOOKS_STATE_DIR = state;
  try {
    return fn(state);
  } finally {
    if (old == null) delete process.env.PEAKET_HOOKS_STATE_DIR;
    else process.env.PEAKET_HOOKS_STATE_DIR = old;
  }
}

test('CH-13 ① 무인 모드: 묻기는 허용으로 바꾸고 기록하며, 막기와 main 푸시는 막는다', () =>
  withState((state) => {
    assert.equal(shell('git stash'), 'ask');
    assert.equal(unattendedMain(['on', '1']).code, 0);
    const out = pre({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git stash' }, cwd: DEV, session_id: 's-1' });
    assert.equal(decision(out), 'allow');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /무인 모드[\s\S]*git stash/);
    for (const c of ['git push --tags', 'git update-ref refs/heads/x abc', 'git add docs', 'git push origin lane1']) {
      assert.equal(shell(c), 'allow', c);
    }
    for (const c of ['git reset --hard', 'git push --force', 'git add -A', 'npm install x', 'git push origin lane1 && git reset --hard']) {
      assert.equal(shell(c), 'deny', c);
    }
    assert.equal(shell('git push origin main'), 'deny');
    assert.equal(shell('git push -u origin feature/lane1-x'), 'pass');
    const log = readFileSync(join(state, 'allowed.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.length, 5);
    assert.equal(log[0].command, 'git stash');
    assert.equal(log[0].session, 's-1');
    assert.ok(log.every((e) => e.reason && e.at));
    assert.match(unattendedMain(['status']).text, /켜짐[\s\S]*git stash/);
    assert.match(unattendedMain(['off']).text, /5개/);
    assert.equal(shell('git stash'), 'ask');
    assert.match(unattendedMain(['off']).text, /이미 꺼져/);
  }));

test('CH-13 ② 무인 모드는 끝 시각이 지나면 꺼지고, 잘못된 시간은 받지 않는다', () =>
  withState((state) => {
    const t0 = Date.UTC(2026, 10, 21, 15, 0, 0);
    assert.equal(unattendedMain(['on', '2'], t0).code, 0);
    assert.ok(unattended(t0 + 3_600_000));
    assert.equal(unattended(t0 + 2 * 3_600_000), null);
    for (const bad of ['0', '-1', '25', 'abc']) assert.equal(unattendedMain(['on', bad]).code, 2, bad);
    assert.equal(unattendedMain(['bogus']).code, 2);
    writeFileSync(join(state, 'on.json'), '{깨진');
    assert.equal(unattended(), null);
    const r = spawnSync(process.execPath, [join(HOOKS, 'unattended.mjs'), 'status'], { encoding: 'utf8', env: { ...process.env, PEAKET_HOOKS_STATE_DIR: state }, timeout: 20000 });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /꺼짐/);
  }));

test('CH-11 ② 이 저장소의 실제 생성 파일이 막힌다', () => {
  const out = execFileSync(process.execPath, [join(HOOKS, 'guard-edit.mjs')], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(ROOT, 'deploy/gateways/gw-fan.routes.yaml') } }),
    encoding: 'utf8',
  });
  assert.match(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, /gateway-routes\.mjs --write/);
});
