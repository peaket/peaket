#!/usr/bin/env node
// 정산 민감 정보 정적 검사(docs/features/settlement.md §13 J-T14, F-07-7 계획 I-11, ADR-0370 결정 1, ADR-0053 결정 5).
// 계좌번호·보안 키·JWE 원문이 로그·응답·예외 메시지로 나가는 모양을 찾는다. 찾을 이름은 accountNumber·securityKey·jwe·compact이고
// 끝 4자리(accountLast4·last4)와 이름이 비슷한 다른 칸(compactView·jweHeaderAlg)은 찾지 않는다. 글자열 안의 글은 이름으로 보지 않는다(템플릿의 ${…}는 본다).
//   - log: logger·log·console(this.log·deps.log?.x 포함) 호출 인자에 이름이 있음
//   - response: 이름이 Response로 끝나는 스키마 선언 안에 accountNumber·securityKey 칸이 있음(요청 본문 스키마는 보지 않는다)
//   - error: new …Error·…Problem·…Exception( 인자에 이름이 있음
// 로그 표본 검사(실제 로그 줄에 값이 없는지)는 payment-svc 시험 몫이다(settlement-payout-account.http.test.ts J-T14).
// 쓰는 법: node tools/ci/settlement-secrets-scan.mjs [--root <저장소>] → 찾으면 끝 코드 1(자리와 규칙만 표준 오류에, 값은 싣지 않음), 없으면 0, 모르는 인자 2
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMain } from './entry.mjs';

/** 찾을 이름(계획 I-11) */
const SECRET_NAME = /(?<![\w$])(accountNumber|securityKey|jwe|compact)(?![\w$])/;
/** 응답 스키마에서 찾을 칸 */
const RESPONSE_KEY = /(?<![\w$])(accountNumber|securityKey)\s*\??\s*:/;
/** 검사 범위(저장소 뿌리 기준): payment-svc 정산 모듈, core-svc 판매 승인(catalog), 파트너 정산 화면 */
export const SCAN_ROOTS = ['services/payment-svc/src/modules/settlement', 'services/core-svc/src/modules/catalog', 'apps/partner/src/_pages/settlement', 'apps/partner/src/_pages/partner-settings'];
const SOURCE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const TEST_FILE = /\.(?:test|spec)\.[^.]+$/;

/**
 * 글자열 안의 글과 주석을 빈칸으로 바꾼 같은 길이의 글(줄 바꿈은 그대로라 자리가 같다). 템플릿 글자열의 ${…}는 코드로 둔다
 * @param {string} text
 */
export function maskSource(text) {
  const out = text.split('');
  /** 상태 쌓기: 'code'(깊이는 brace 수), 'tpl' */
  const stack = [{ mode: 'code', braces: 0 }];
  let i = 0;
  const blank = (k) => {
    if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < text.length) {
    const top = stack[stack.length - 1];
    const c = text[i];
    const n = text[i + 1];
    if (top.mode === 'tpl') {
      if (c === '\\') {
        blank(i);
        if (i + 1 < text.length) blank(i + 1);
        i += 2;
      } else if (c === '`') {
        stack.pop();
        i += 1;
      } else if (c === '$' && n === '{') {
        stack.push({ mode: 'code', braces: 0 });
        i += 2;
      } else {
        blank(i);
        i += 1;
      }
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') blank(i++);
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) blank(i);
    } else if (c === "'" || c === '"') {
      i += 1;
      while (i < text.length && text[i] !== c && text[i] !== '\n') {
        if (text[i] === '\\') blank(i++);
        if (i < text.length) blank(i++);
      }
      i += 1;
    } else if (c === '`') {
      stack.push({ mode: 'tpl' });
      i += 1;
    } else if (c === '{') {
      top.braces += 1;
      i += 1;
    } else if (c === '}') {
      if (top.braces === 0 && stack.length > 1) stack.pop();
      else top.braces -= 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/** open 자리의 여는 괄호와 짝인 닫는 괄호 다음 자리(없으면 글 끝) */
function closeOf(masked, open) {
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    const ch = masked[k];
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return k + 1;
    }
  }
  return masked.length;
}

const lineAt = (text, offset) => {
  let line = 1;
  for (let k = 0; k < offset; k++) if (text.charCodeAt(k) === 10) line += 1;
  return line;
};

const LOG_CALL = /(?<![\w$])(?:logger|log|console)(?:\??\.[\w$]+)+\s*(?:\?\.)?\(/g;
const ERROR_NEW = /\bnew\s+[\w$.]*(?:Error|Problem|Exception)[\w$]*\s*\(/g;
const RESPONSE_DECL = /(?<![\w$])(?:const|let|var)\s+([\w$]*Response)\s*(?::[^=]+)?=/g;

/**
 * 파일 하나를 본다
 * @param {string} text 원문
 * @param {string} file 보고에 쓸 경로
 * @returns {{ file: string, line: number, rule: 'log' | 'response' | 'error' }[]}
 */
export function scanSource(text, file) {
  const masked = maskSource(String(text));
  /** @type {Map<string, { file: string, line: number, rule: 'log' | 'response' | 'error' }>} */
  const found = new Map();
  const add = (offset, rule) => {
    const line = lineAt(masked, offset);
    found.set(`${line}:${rule}`, { file, line, rule });
  };
  for (const [re, rule] of [
    [LOG_CALL, 'log'],
    [ERROR_NEW, 'error'],
  ]) {
    re.lastIndex = 0;
    for (let m = re.exec(masked); m; m = re.exec(masked)) {
      const open = m.index + m[0].length - 1;
      const args = masked.slice(open, closeOf(masked, open));
      if (SECRET_NAME.test(args)) add(m.index, rule);
    }
  }
  RESPONSE_DECL.lastIndex = 0;
  for (let m = RESPONSE_DECL.exec(masked); m; m = RESPONSE_DECL.exec(masked)) {
    const start = m.index + m[0].length;
    const open = masked.indexOf('(', start);
    const semi = masked.indexOf(';', start);
    if (open === -1 || (semi !== -1 && semi < open)) continue;
    const end = closeOf(masked, open);
    const key = new RegExp(RESPONSE_KEY.source, 'g');
    const body = masked.slice(open, end);
    for (let k = key.exec(body); k; k = key.exec(body)) add(open + k.index, 'response');
  }
  return [...found.values()].sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

function walk(dir, files) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'test' || name === 'test-int') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, files);
    else if (SOURCE.test(name) && !TEST_FILE.test(name) && !name.endsWith('.d.ts')) files.push(p);
  }
}

/**
 * 저장소의 검사 범위를 본다
 * @param {{ root: string, roots?: readonly string[] }} o
 * @returns {{ files: number, findings: { file: string, line: number, rule: 'log' | 'response' | 'error' }[] }}
 */
export function scanRepo({ root, roots = SCAN_ROOTS }) {
  const files = [];
  for (const r of roots) {
    const dir = join(root, r);
    if (existsSync(dir)) walk(dir, files);
  }
  const findings = files.flatMap((f) => scanSource(readFileSync(f, 'utf8'), relative(root, f).split(sep).join('/')));
  return { files: files.length, findings };
}

if (isMain(import.meta.url)) {
  let values;
  try {
    ({ values } = parseArgs({ options: { root: { type: 'string' } }, strict: true, allowPositionals: false }));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n쓰는 법: node tools/ci/settlement-secrets-scan.mjs [--root <저장소>]\n`);
    process.exit(2);
  }
  const root = resolve(values.root ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..'));
  const out = scanRepo({ root });
  if (out.findings.length > 0) {
    for (const f of out.findings) process.stderr.write(`${f.file}:${f.line} ${f.rule}: 계좌번호·보안 키·JWE 원문 이름이 ${f.rule === 'log' ? '로그 호출 인자' : f.rule === 'response' ? '응답 스키마 칸' : '예외 인자'}에 있다\n`);
    process.stderr.write(`정산 민감 정보 검사: ${out.findings.length}곳(파일 ${out.files}개, J-T14)\n`);
    process.exit(1);
  }
  process.stdout.write(`정산 민감 정보 검사 통과: 파일 ${out.files}개(J-T14)\n`);
}
