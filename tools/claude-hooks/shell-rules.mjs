// 셸 명령 검사 규칙(ADR-0330 결정 2·3). 실행 파일은 guard-shell.mjs이고 Bash와 PowerShell 도구 둘 다 건다(.claude/settings.json).
// 실행 전(PreToolUse): CLAUDE.md 절대 규칙 가운데 명령으로 드러나는 것을 막거나 묻는다.
//   - 남의 미완 변경 섞기·날리기: git add -A·.·-u, 폴더 통째 스테이징(묻기), commit -a, reset --hard, clean -f, checkout/restore 전체(막기)와 경로(묻기), stash(묻기),
//     메인 작업 트리의 switch·checkout -b(묻기. 갈래 작업 폴더인 링크된 worktree 안에서는 묻지 않는다)
//   - 소유자에게 묻는 일(docs/architecture.md §8.6 '맡기기'): 강제 푸시(막기), develop·feature/* 밖 원격 가지·태그 푸시(묻기), update-ref(묻기).
//     feature/* 가지 올리기·자기 가지 --force-with-lease·합친 뒤 지우기는 소유자가 허락했다(2026-11-16, docs/PROGRESS.md 턴 규칙 '원격 올리기')
//   - pnpm 전용(docs/devops.md §4.4): npm·yarn 설치 명령(막기)
//   - 커밋 제목은 Conventional Commits 1.0.0(tools/ci/conventional.mjs, docs/devops.md §2.2.5)
// 무인 모드(lib.mjs unattended, 소유자 결정 2026-11-21)가 켜져 있으면 '묻기'를 허용으로 바꾸고 기록한다. main 푸시만은 그때 막는다
// 실행 뒤(PostToolUse): 커밋 제목 끝에 요구사항·시험 ID 괄호가 없으면 알린다(막지 않는다)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseTitle, TYPES } from '../ci/conventional.mjs';
import { deny, ask, allow, note, repoRootOf, unattended, logAllowed } from './lib.mjs';
import { parseCommand, program, gitCall } from './shell.mjs';

const STAGE_OTHERS =
  '다른 세션이 같은 저장소를 동시에 고친다(CLAUDE.md 절대 규칙). 내가 고친 파일만 이름으로 골라 스테이징한다: `git add <파일> <파일>`';
const DISCARD_OTHERS =
  '작업 트리를 버리면 다른 세션의 미완 변경까지 사라진다(CLAUDE.md 절대 규칙). 되돌릴 파일이 내가 고친 것인지 확인한다';
const OWNER_ASK = 'docs/architecture.md §8.6 \'맡기기\': develop 밖 원격 가지·태그 푸시와 강제 푸시는 소유자에게 묻는 일이다';

const shortFlags = (a) => (/^-[A-Za-z]+$/.test(a) ? a.slice(1) : '');
const hasFlag = (args, long, short) => args.some((a) => a === long || a.startsWith(`${long}=`) || (short && shortFlags(a).includes(short)));
// '--' 뒤이거나 '-'로 시작하지 않는 인자. 값을 받는 옵션의 값은 걸러 주지 않으므로 부르는 쪽이 고른다
const positional = (args) => {
  const dd = args.indexOf('--');
  const before = (dd < 0 ? args : args.slice(0, dd)).filter((a) => !a.startsWith('-'));
  return { before, after: dd < 0 ? [] : args.slice(dd + 1) };
};
const WHOLE_TREE = new Set(['.', './', ':/', ':', '*', ':/:']);

function currentBranch(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function isDir(dir, p) {
  try {
    return fs.statSync(path.resolve(dir, p)).isDirectory();
  } catch {
    return false;
  }
}

// 링크된 worktree(뿌리의 .git이 파일)인지. 갈래 작업 폴더는 모두 git worktree add로 만든 이것이고 한 세션만 쓴다.
// 메인 작업 트리(.git이 폴더)는 여러 세션이 함께 쓰므로 가지를 바꾸면 남의 미완 변경이 섞인다
function isLinkedWorktree(dir) {
  try {
    const root = repoRootOf(dir);
    return root != null && fs.statSync(path.join(root, '.git')).isFile();
  } catch {
    return false;
  }
}

// Git Bash의 /d/foo 꼴 경로를 D:/foo로 바꾼다(Windows에서 path.resolve가 잘못 읽지 않게)
const nativePath = (p) => (process.platform === 'win32' ? p.replace(/^\/([A-Za-z])(?=\/|$)/, '$1:') : p);

// 소유자가 자리를 비웠을 때도 묻지 않고 막을 '묻기'(main 푸시). 무인 모드에서 허용으로 바꾸지 않는다
const OWNER_ONLY = new WeakSet();
const askOwnerOnly = (reason) => {
  const out = ask(reason);
  OWNER_ONLY.add(out);
  return out;
};

function checkAdd(args, dir) {
  if (hasFlag(args, '--dry-run', 'n')) return null;
  const { before, after } = positional(args);
  const paths = [...before, ...after];
  const all = hasFlag(args, '--all', 'A') || hasFlag(args, '--update', 'u');
  if (paths.some((p) => WHOLE_TREE.has(p)) || (all && paths.length === 0)) {
    return deny(`작업 트리 전체를 스테이징하는 git add다. ${STAGE_OTHERS}`);
  }
  const dirs = paths.filter((p) => p.includes('*') || isDir(dir, p));
  if (dirs.length) {
    return ask(`폴더나 글롭(${dirs.join(', ')})을 통째로 스테이징한다. 그 안에 다른 세션의 미완 변경이 섞일 수 있다. ${STAGE_OTHERS}`);
  }
  return null;
}

function checkCommit(args, parsed, dir) {
  if (args.some((a) => a === '--all' || (shortFlags(a).includes('a') && !a.startsWith('--')))) {
    return deny(`git commit -a는 바뀐 추적 파일을 모두 담는다. ${STAGE_OTHERS}`);
  }
  const message = commitMessage(args, parsed, dir);
  if (message == null) return null;
  const title = message.split('\n').find((l) => l.trim()) ?? '';
  const c = parseTitle(title.trim(), message);
  if (!c) {
    return deny(
      `커밋 제목 '${title.trim()}'이 Conventional Commits 1.0.0 '<종류>[(범위)][!]: <설명>' 꼴이 아니다(docs/devops.md §2.2.5, CLAUDE.md). 예: fix(gateways): … (LCH-080)`,
    );
  }
  if (!TYPES.includes(c.type)) return deny(`커밋 종류 '${c.type}'는 허용 목록(${TYPES.join(', ')})에 없다(docs/devops.md §2.2.6)`);
  if (c.breaking && !c.bang) return deny('본문에 BREAKING CHANGE 꼬리말이 있으면 제목에도 !를 붙인다(예: feat(queue)!: …, docs/devops.md §2.2.6)');
  return null;
}

// 커밋 메시지 글. 알 수 없으면(편집기, --no-edit, -C 등) null
export function commitMessage(args, parsed, dir) {
  const fill = (v) =>
    v
      .replace(/@@HS(\d+)@@/g, (_, n) => parsed.herestrings[Number(n)] ?? '')
      .replace(/\$\(cat <<@@HD(\d+)@@[^)]*\)?/g, (_, n) => parsed.heredocs[Number(n)] ?? '')
      .replace(/<<@@HD(\d+)@@/g, (_, n) => parsed.heredocs[Number(n)] ?? '');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-m' || a === '--message') return args[i + 1] != null ? fill(args[i + 1]) : null;
    if (a.startsWith('--message=')) return fill(a.slice('--message='.length));
    if (/^-[A-Za-z]*m$/.test(a) && !a.startsWith('--')) return args[i + 1] != null ? fill(args[i + 1]) : null;
    if (a.startsWith('-m') && a.length > 2 && !a.startsWith('--')) return fill(a.slice(2));
    let file = null;
    if (a === '-F' || a === '--file') file = args[i + 1];
    else if (a.startsWith('--file=')) file = a.slice('--file='.length);
    if (file != null) {
      if (file === '-') return parsed.heredocs[0] ?? null;
      try {
        return fs.readFileSync(path.resolve(dir, file), 'utf8').replace(/\r\n/g, '\n');
      } catch {
        return null;
      }
    }
  }
  return null;
}

function checkPush(args, dir) {
  const { before } = positional(args);
  // 값을 받는 옵션(--repo, -o 등)의 값이 위치 인자로 잘못 읽히는 일은 드물어 그대로 둔다
  const [remote, ...refspecs] = before;
  const force = hasFlag(args, '--force', 'f') || refspecs.some((r) => r.startsWith('+'));
  const lease = hasFlag(args, '--force-with-lease') || hasFlag(args, '--force-if-includes');
  const dst = (r) => {
    const s = r.replace(/^\+/, '');
    const d = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
    return d.replace(/^refs\/heads\//, '');
  };
  const targets = refspecs.map(dst).map((d) => (d === 'HEAD' ? currentBranch(dir) : d));
  // 갈래 작업 가지(feature/<갈래>-<묶음>): 초안 PR CI용으로 올리고, 자기 가지는 lease로 다시 올리고, 합친 뒤 지운다(소유자 허락 2026-11-16)
  const feature = (t) => typeof t === 'string' && t.startsWith('feature/');
  const pushed = refspecs.length ? targets : [currentBranch(dir)];
  if (force) return deny(`강제 푸시다. ${OWNER_ASK}. .claude/settings.json도 막는다`);
  if (lease) {
    if (!targets.length || targets.some((t) => t === 'develop' || t === 'main' || t == null)) {
      return deny(`develop·main(또는 가지를 알 수 없는) 강제 푸시다. ${OWNER_ASK}`);
    }
    if (targets.every(feature)) return null;
    return ask(`강제 푸시(--force-with-lease)다. ${OWNER_ASK}`);
  }
  if (remote === '.') return null; // 로컬 가지 옮기기(합치기 줄)
  if (hasFlag(args, '--all') || hasFlag(args, '--mirror') || hasFlag(args, '--tags') || hasFlag(args, '--follow-tags')) {
    return ask(`가지 여럿이나 태그를 원격에 올린다. ${OWNER_ASK}`);
  }
  if (hasFlag(args, '--delete', 'd') || refspecs.some((r) => r.startsWith(':'))) {
    if (targets.length && targets.every(feature)) return null;
    return ask(`원격 가지·태그를 지운다. ${OWNER_ASK}`);
  }
  const off = pushed.filter((t) => t !== 'develop' && !feature(t));
  if (off.includes('main')) return askOwnerOnly(`main으로 푸시한다(출시). ${OWNER_ASK}`);
  if (off.length) return ask(`develop·feature/* 밖(${off.map((t) => t ?? '알 수 없음').join(', ')})으로 푸시한다. ${OWNER_ASK}`);
  return null;
}

function checkGit(sub, args, dir, parsed) {
  switch (sub) {
    case 'add':
      return checkAdd(args, dir);
    case 'commit':
      return checkCommit(args, parsed, dir);
    case 'push':
      return checkPush(args, dir);
    case 'reset':
      return hasFlag(args, '--hard') ? deny(`git reset --hard다. ${DISCARD_OTHERS}`) : null;
    case 'clean':
      return hasFlag(args, '--dry-run', 'n') || !hasFlag(args, '--force', 'f') ? null : deny(`git clean -f는 추적하지 않는 파일(다른 세션이 새로 만든 파일)을 지운다. ${DISCARD_OTHERS}`);
    case 'checkout': {
      if (hasFlag(args, '-b') || args.includes('-B') || hasFlag(args, '--orphan')) {
        if (isLinkedWorktree(dir)) return null;
        return ask('공유 작업 트리에서 가지를 바꾼다. 다른 세션이 고치던 파일이 섞인다(docs/devops.md §2.2.5 문서 행). 갈래 작업이면 worktree를 쓴다');
      }
      const { before, after } = positional(args);
      if ([...before, ...after].some((p) => WHOLE_TREE.has(p))) return deny(`작업 트리 전체를 되돌리는 git checkout이다. ${DISCARD_OTHERS}`);
      if (after.length || hasFlag(args, '--force', 'f')) return ask(`git checkout으로 파일을 되돌린다(${after.join(', ') || '-f'}). ${DISCARD_OTHERS}`);
      return null;
    }
    case 'restore': {
      const staged = hasFlag(args, '--staged', 'S');
      const worktree = hasFlag(args, '--worktree', 'W');
      if (staged && !worktree) return null; // 스테이징만 내리기
      const { before, after } = positional(args);
      const paths = [...before, ...after];
      if (!paths.length || paths.some((p) => WHOLE_TREE.has(p))) return deny(`작업 트리 전체를 되돌리는 git restore다. ${DISCARD_OTHERS}`);
      return ask(`git restore로 파일을 되돌린다(${paths.join(', ')}). ${DISCARD_OTHERS}`);
    }
    case 'switch':
      if (isLinkedWorktree(dir)) return null;
      return ask('공유 작업 트리에서 가지를 바꾼다. 다른 세션이 고치던 파일이 섞인다(docs/devops.md §2.2.5 문서 행). 갈래 작업이면 worktree를 쓴다');
    case 'stash': {
      const op = args[0];
      if (op === 'list' || op === 'show') return null;
      return ask('git stash는 다른 세션의 미완 변경까지 치운다(CLAUDE.md 절대 규칙). 정말 필요한지 확인한다');
    }
    case 'update-ref':
      return ask('git update-ref로 가지를 직접 옮긴다. 합치기는 `git push origin HEAD:develop`(앞으로 감기만)이나 메인 폴더의 `merge --ff-only`로 하고 update-ref는 쓰지 않는다(ADR-0286)');
    default:
      return null;
  }
}

const NPM_INSTALL = new Set(['i', 'install', 'ci', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'link']);

export function pre(input) {
  const command = String(input?.tool_input?.command ?? '');
  if (!command.trim()) return null;
  const cwd = input?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const parsed = parseCommand(command);
  const asks = [];
  // 같은 명령줄 안의 cd(cd X && git …)를 따라간다. 갈래 작업 폴더인지 가리는 데 쓴다
  let here = cwd;
  for (const words of parsed.segments) {
    const p = program(words);
    if (!p) continue;
    let out = null;
    const sub = p.args.find((a) => !a.startsWith('-')) ?? (p.name === 'yarn' ? 'install' : '');
    if (CD.has(p.name)) {
      const to = p.args.find((a) => !a.startsWith('-') && a.toLowerCase() !== '/d');
      if (to) here = path.resolve(here, nativePath(to));
      continue;
    }
    if ((p.name === 'npm' || p.name === 'yarn') && NPM_INSTALL.has(sub)) {
      out = deny(
        `${p.name} 설치 명령이다. 이 저장소는 pnpm 작업 공간 전용이고 잠금 파일은 pnpm-lock.yaml 하나다(docs/devops.md §4.4). 대신: corepack pnpm install --frozen-lockfile, pnpm --filter <패키지> add <의존성>`,
      );
    } else if (p.name === 'git') {
      const g = gitCall(p.args);
      if (g) out = checkGit(g.sub, g.args, g.dir ? path.resolve(here, nativePath(g.dir)) : here, parsed);
    }
    if (out?.hookSpecificOutput?.permissionDecision === 'deny') return out;
    if (out) asks.push(out);
  }
  return settle(asks[0] ?? null, input, command, cwd);
}

const CD = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl']);

// 무인 모드면 '묻기'를 허용으로 바꾸고 기록한다(소유자 결정 2026-11-21). main 푸시는 그때 막는다
function settle(out, input, command, cwd) {
  if (out?.hookSpecificOutput?.permissionDecision !== 'ask') return out;
  const on = unattended();
  if (!on) return out;
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  if (OWNER_ONLY.has(out)) return deny(`무인 모드라 소유자에게 물을 수 없어 막는다. 아침에 소유자가 정한다. ${reason}`);
  logAllowed({ at: new Date().toISOString(), session: input?.session_id ?? null, cwd, command: command.slice(0, 2000), reason });
  return allow(`무인 모드(소유자 결정 2026-11-21)라 묻지 않고 허용한다. 원래 물을 까닭: ${reason}`);
}

// 제목 끝 괄호에 ID(대문자-숫자 꼴, 예 LCH-080·R-726·QR-MA-2·ADR-0330)가 있는지
const TRAILING_ID = /\(([^()]*\b[A-Z][A-Z0-9]*-[A-Z0-9-]*\d[^()]*)\)\s*$/;

export function post(input) {
  const command = String(input?.tool_input?.command ?? '');
  const cwd = input?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const parsed = parseCommand(command);
  for (const words of parsed.segments) {
    const p = program(words);
    const g = p?.name === 'git' ? gitCall(p.args) : null;
    if (g?.sub !== 'commit') continue;
    const message = commitMessage(g.args, parsed, g.dir ? path.resolve(cwd, g.dir) : cwd);
    const title = (message ?? '').split('\n').find((l) => l.trim())?.trim();
    if (title && !TRAILING_ID.test(title)) {
      return note(
        `커밋 제목 '${title}' 끝에 요구사항·시험 ID 괄호가 없다(CLAUDE.md: 예 fix(gateways): … (LCH-080)). 묶음·요구사항에 딸린 커밋이면 푸시 전에 git commit --amend로 붙인다. 딸린 ID가 없는 정리 커밋이면 그대로 둔다`,
      );
    }
  }
  return null;
}
