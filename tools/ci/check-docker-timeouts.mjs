#!/usr/bin/env node
// Docker 호출 시간 제한 점검(ADR-0283 결정 4, 계획 docs/review/plans/W10-guards.md G2).
// 2026-11-17 Docker 엔진이 멈췄을 때 시험 도우미의 execFileSync('docker', …)가 시간 제한 없이 불려 vitest 시간 한도도 걸리지 않고
// 몇 시간 멈췄다. 그래서 시험 파일에서 Docker를 부르는 곳마다 옵션에 timeout을 정수 숫자로 바로 적었는지 본다.
// 보는 곳: git이 추적하는 apps/·services/·packages/의 .ts·.tsx·.mts·.cts·.js·.mjs·.cjs 가운데 시험 파일
//   (이름이 *.test.*·*.spec.*이거나 폴더 마디 하나가 정확히 test·test-int·test-sim·__tests__·e2e, roles-check.mjs와 같은 정의).
//   tools/·loadtest/는 보지 않는다(이미지 만들기·kind처럼 오래 걸리는 일이 섞여 한 값으로 묶기 어렵다).
// 찾는 호출: execFileSync·execFile·spawnSync·spawn·execSync·exec(점 이름·promisify(execFile)(…) 꼴 포함)의 첫 인자가
//   글 조각 'docker' 또는 'docker …'인 것. 주석 안의 글도 똑같이 본다.
// 통과: 호출 괄호 안(글 조각·주석 밖)에 timeout: <숫자와 _만> 뒤 , 또는 }가 오고 값이 1~300000.
// 쓰는 법: node tools/ci/check-docker-timeouts.mjs [--root <저장소>]
// 끝 코드: 0 통과, 1 문제 있음(또는 Docker 호출 0곳), 2 인자 오류·git 오류
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const MAX_TIMEOUT_MS = 300_000;

const ROOTS = ['apps', 'services', 'packages'];
const EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const TEST_DIRS = new Set(['test', 'test-int', 'test-sim', '__tests__', 'e2e']);
const TEST_NAME = /^.+\.(?:test|spec)\..+$/;
const CALL = /(?<![\w$])(execFileSync|execFile|spawnSync|spawn|execSync|exec)(?![\w$])/g;
const QUOTES = new Set(["'", '"', '`']);

/** 저장소 상대 경로('/' 꼴)가 점검하는 시험 파일이면 true */
export function inScope(path) {
  const parts = String(path).split('/');
  if (parts.length < 2 || !ROOTS.includes(parts[0])) return false;
  const name = parts[parts.length - 1];
  if (!EXTENSIONS.test(name)) return false;
  return TEST_NAME.test(name) || parts.slice(0, -1).some((d) => TEST_DIRS.has(d));
}

// i에서 시작하는 글 조각('…'·"…"·`…`)의 끝 다음 자리. 닫히지 않으면 글 끝
function skipString(text, i) {
  const q = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== q) j += text[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, text.length);
}

// i가 주석 머리('//'·'/*')면 그 주석의 끝 다음 자리, 아니면 -1
function skipComment(text, i) {
  if (text[i] !== '/') return -1;
  if (text[i + 1] === '/') {
    const end = text.indexOf('\n', i);
    return end < 0 ? text.length : end;
  }
  if (text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end < 0 ? text.length : end + 2;
  }
  return -1;
}

function skipBlank(text, i) {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    const c = skipComment(text, i);
    if (c < 0) return i;
    i = c;
  }
}

// 이름 바로 뒤에서 호출의 여는 괄호 자리. 'promisify(execFile)(' 꼴은 닫는 괄호를 건너뛴다. 호출이 아니면 -1
function openParen(text, i) {
  let j = skipBlank(text, i);
  while (text[j] === ')') j = skipBlank(text, j + 1);
  return text[j] === '(' ? j : -1;
}

// 여는 괄호 open부터 짝이 맞는 닫는 괄호까지. 글 조각·주석 안의 괄호는 세지 않고, 그 글자는 빈칸으로 가린 사본을 돌려준다
function callRange(text, open) {
  let depth = 0;
  let masked = '';
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (QUOTES.has(ch)) {
      const end = skipString(text, i);
      masked += ' '.repeat(end - i);
      i = end;
      continue;
    }
    const c = skipComment(text, i);
    if (c >= 0) {
      masked += ' '.repeat(c - i);
      i = c;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    masked += ch;
    i++;
    if (depth === 0) break;
  }
  return masked;
}

// 가린 호출 범위에서 timeout 판정. 통과면 null, 아니면 까닭
function timeoutProblem(masked) {
  let first = null;
  for (const m of masked.matchAll(/(?<![\w$.])timeout(?![\w$])/g)) {
    const rest = masked.slice(m.index + m[0].length);
    const v = /^\s*:\s*([0-9][0-9_]*)\s*[,}]/.exec(rest);
    let problem;
    if (!v) {
      problem = `Docker 호출의 timeout 값이 정수 숫자가 아니다(변수·식·줄인 꼴은 안 된다). 옵션에 timeout: 300_000 이하의 정수를 바로 적는다(ADR-0283 결정 4)`;
    } else {
      const raw = v[1];
      const value = Number(raw.replaceAll('_', ''));
      if (Number.isInteger(value) && value >= 1 && value <= MAX_TIMEOUT_MS) return null;
      const shown = raw.includes('_') ? `${raw}(${value})` : raw;
      problem = `Docker 호출의 timeout 값 ${shown}이 1~${MAX_TIMEOUT_MS} 밖이다(ADR-0283 결정 4)`;
    }
    first ??= problem;
  }
  return first ?? `Docker 호출에 시간 제한(timeout)이 없다. 옵션에 timeout: 300_000 이하의 정수를 바로 적는다(ADR-0283 결정 4)`;
}

/**
 * 파일 글에서 Docker 호출을 찾아 판정한다.
 * @returns {{ line: number, ok: boolean, reason: string | null }[]} line은 호출 이름이 있는 줄(1부터)
 */
export function dockerCalls(text) {
  const src = String(text);
  const out = [];
  for (const m of src.matchAll(CALL)) {
    const open = openParen(src, m.index + m[0].length);
    if (open < 0) continue;
    const argAt = skipBlank(src, open + 1);
    if (!QUOTES.has(src[argAt])) continue;
    const end = skipString(src, argAt);
    const command = src.slice(argAt + 1, end - 1);
    if (command !== 'docker' && !command.startsWith('docker ')) continue;
    const reason = timeoutProblem(callRange(src, open));
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ line, ok: reason === null, reason });
  }
  return out;
}

function trackedFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', ...ROOTS], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 28,
  });
  return out.split('\0').filter(Boolean);
}

function main(argv) {
  let root;
  try {
    const { values } = parseArgs({
      args: argv,
      options: { root: { type: 'string', default: fileURLToPath(new URL('../../', import.meta.url)) } },
    });
    root = values.root;
  } catch (e) {
    process.stderr.write(`인자 오류: ${e.message}\n`);
    return 2;
  }
  let files;
  try {
    files = trackedFiles(root).filter(inScope);
  } catch (e) {
    process.stderr.write(`git ls-files 실패(--root ${root}): ${String(e.stderr || e.message).trim()}\n`);
    return 2;
  }
  const problems = [];
  let calls = 0;
  let seen = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') continue; // 추적하지만 작업 트리에서 지운 파일
      throw e;
    }
    seen++;
    for (const c of dockerCalls(text)) {
      calls++;
      if (!c.ok) problems.push(`${file}:${c.line} ${c.reason}`);
    }
  }
  if (calls === 0) {
    console.log('막음: Docker 호출을 찾지 못했다(검사 범위를 확인한다)');
    return 1;
  }
  for (const p of problems) console.log(process.env.GITHUB_ACTIONS === 'true' ? `::error::${p}` : `막음: ${p}`);
  if (problems.length === 0) {
    console.log(`통과: 시험 파일 ${seen}개, Docker 호출 ${calls}곳`);
    return 0;
  }
  console.log(`막음: 시험 파일 ${seen}개, Docker 호출 ${calls}곳, 문제 ${problems.length}건`);
  return 1;
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e?.message ?? e}\n`);
    process.exitCode = 2;
  }
}
