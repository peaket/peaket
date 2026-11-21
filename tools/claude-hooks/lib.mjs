// 에이전트 훅 공용 도움 함수(ADR-0330). Claude Code는 훅에 사건을 JSON으로 표준 입력에 주고, 훅은 표준 출력의 JSON으로 답한다.
// 훅이 스스로 고장 나면 막지 않고 통과시킨다(run). 훅은 실수를 막는 난간이지 보안 경계가 아니다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
