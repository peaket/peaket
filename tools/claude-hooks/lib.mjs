// 에이전트 훅 공용 도움 함수(ADR-0330). Claude Code는 훅에 사건을 JSON으로 표준 입력에 주고, 훅은 표준 출력의 JSON으로 답한다.
// 훅이 스스로 고장 나면 막지 않고 통과시킨다(run). 훅은 실수를 막는 난간이지 보안 경계가 아니다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));

export async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

// 판정 함수 main(input)이 돌려준 답을 내보낸다. 던지면 통과(끝 코드 0, 출력 없음)
export async function run(main) {
  let out = null;
  try {
    out = await main(await readInput());
  } catch {
    out = null;
  }
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

// 도구 실행 전(PreToolUse): 막는다
export const deny = (reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

// 도구 실행 전: 사용자에게 묻는다
export const ask = (reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
});

// 도구 실행 전: 묻지 않고 허용한다(무인 모드에서 '묻기'를 바꿀 때만 쓴다)
export const allow = (reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason },
});

// 무인 모드(소유자 결정 2026-11-21, ADR-0330 보충). 소유자가 자리를 비운 동안 '묻기'를 허용으로 바꾸고 그 명령을 기록한다.
// 상태는 저장소 뿌리의 .claude/unattended/(기록하지 않음)에 둔다. 켜고 끄기는 unattended.mjs가 한다
export function stateDir() {
  return process.env.PEAKET_HOOKS_STATE_DIR || path.join(HOOKS_DIR, '..', '..', '.claude', 'unattended');
}

// 켜져 있으면 { since, until }(밀리초), 꺼져 있거나 끝 시각이 지났으면 null
export function unattended(now = Date.now()) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(stateDir(), 'on.json'), 'utf8'));
    if (typeof s?.until !== 'number' || now >= s.until) return null;
    return s;
  } catch {
    return null;
  }
}

// 무인 모드에서 허용한 명령을 한 줄씩 남긴다(아침에 소유자가 본다). 쓰지 못해도 막지 않는다
export function logAllowed(entry) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.appendFileSync(path.join(stateDir(), 'allowed.jsonl'), `${JSON.stringify(entry)}\n`);
  } catch {
    // 기록 실패는 무시한다
  }
}

// 도구 실행 뒤(PostToolUse): 모델에게 할 일을 알린다(막지 않는다)
export const note = (context) => ({
  hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
});

// 파일이 든 저장소(또는 worktree)의 뿌리. .git(폴더나 파일)을 찾아 위로 올라간다. 없으면 null
export function repoRootOf(filePath) {
  let dir = path.resolve(filePath);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// 저장소 뿌리 기준 '/' 경로. 저장소 밖이면 null
export function relPath(filePath) {
  if (!filePath) return null;
  const root = repoRootOf(path.dirname(path.resolve(filePath)));
  if (!root) return null;
  const rel = path.relative(root, path.resolve(filePath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// 세션마다 같은 열쇠로는 한 번만 참. 알림이 편집마다 되풀이되지 않게 한다
export function firstInSession(sessionId, key) {
  if (!sessionId) return true;
  const dir = path.join(os.tmpdir(), 'peaket-claude-hooks');
  const marker = path.join(dir, `${String(sessionId).replace(/[^\w-]/g, '')}.${key.replace(/[^\w-]/g, '_')}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(marker)) return false;
    fs.writeFileSync(marker, '');
    return true;
  } catch {
    return true;
  }
}
