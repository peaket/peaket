#!/usr/bin/env node
// 보안 린트 끄기 검사(docs/devops.md §4.4 '보안 린트' ①, docs/security/asvs/delivery.md 3.2.2·3.5.5·15.3.1·15.3.2, ADR-0259 결정 12, 리뷰 R7 ①).
// 뿌리 package.json의 lint 경로(pnpm lint와 같은 파일 묶음)를 실제 ESLint 설정으로 읽되, 줄 안 설정(noInlineConfig)을 끄고 보안 규칙
// (peaket-web/*·peaket-service/*)만 돌린다. 그래서
//   1. 보안 규칙을 끄는 줄 안 주석을 찾는다: eslint-disable·eslint-disable-line·eslint-disable-next-line(줄·다음 줄·블록·파일 머리 꼴)이
//      보안 규칙을 적었거나, 보안 규칙이 걸린 파일에서 규칙 이름 없이 모든 규칙을 끈다. 줄 안 설정 /* eslint peaket-…: … */도 같다.
//      주석 목록은 ESLint가 줄 안 설정으로 읽는 주석 그대로다(ESLint가 '효과 없음'으로 알린 주석).
//   2. 주석이 숨긴 보안 규칙 위반을 다시 알린다(주석을 무시하고 돌린 결과).
// 예외는 이름을 단 목록(lint-disable-exceptions.json: 주석 글, 파일, 까닭)에 적은 주석뿐이다. 예외 파일 안이라도 2의 위반은 막는다.
// 목록에 적었는데 그 주석이 없는 파일(쓰이지 않는 예외)도 막는다. 해석하지 못한 파일도 막는다(닫힘 실패).
// 쓰는 법: node tools/ci/check-lint-disables.mjs [--root <저장소>] [--exceptions <예외 목록 JSON>]
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const SECURITY_RULE = /^peaket-(web|service)(\/|$)/;
const DIRECTIVE = /^(eslint(?:-env|-enable|-disable(?:(?:-next)?-line)?)?|exported|globals?)(?:\s|$)/u;
const DISABLES = new Set(['eslint-disable', 'eslint-disable-line', 'eslint-disable-next-line']);
const NO_EFFECT = /^'([\s\S]*)' has no effect because you have 'noInlineConfig' setting/;

/**
 * 주석 글 전체('// …', '/* … *\/')를 ESLint 줄 안 설정 문법으로 읽는다. 줄 안 설정이 아니면 null
 * @returns {{ label: string, rules: string[] | null, value: string, text: string } | null} rules: 끄는 규칙(null이면 모든 규칙)
 */
export function parseDirective(text) {
  const t = String(text).trim();
  const body = t.startsWith('//') ? t.slice(2) : t.startsWith('/*') ? t.replace(/^\/\*/, '').replace(/\*\/$/, '') : t;
  // ESLint처럼 '--' 뒤의 까닭을 뗀다
  const [directive] = body.split(/\s-{2,}\s/u);
  const d = directive.trim();
  const m = DIRECTIVE.exec(d);
  if (!m) return null;
  const label = m[1];
  const value = d.slice(label.length).trim();
  const rules = DISABLES.has(label) ? value.split(',').map((r) => r.trim()).filter(Boolean) : [];
  return { label, rules: DISABLES.has(label) && rules.length === 0 ? null : rules, value, text: t };
}

/** 이 주석이 보안 규칙을 끄거나 바꾸는가. securityFile: 그 파일에 보안 규칙이 걸려 있다 */
export function touchesSecurity(d, { securityFile }) {
  if (DISABLES.has(d.label)) return d.rules === null ? securityFile : d.rules.some((r) => SECURITY_RULE.test(r));
  if (d.label === 'eslint') return /peaket-(web|service)(\/|\b)/.test(d.value);
  return false;
}

/** 뿌리 lint 스크립트('eslint [옵션] <경로…>')의 경로 */
export function lintPaths(script) {
  const tokens = String(script ?? '').trim().split(/\s+/);
  if (tokens[0] !== 'eslint' || tokens.some((t) => /^(&&|\|\||;|\|)$/.test(t))) throw new Error(`뿌리 lint 스크립트가 'eslint [옵션] <경로…>' 꼴이 아니다: ${script}`);
  return tokens.slice(1).filter((t) => !t.startsWith('-'));
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

function readExceptions(file) {
  let j;
  try {
    j = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`예외 목록을 읽지 못했다(${file}): ${e.message}`);
  }
  if (!j || !Array.isArray(j.exceptions)) throw new Error(`예외 목록에 exceptions가 없다: ${file}`);
  return j.exceptions.map((e, i) => {
    if (typeof e?.reason !== 'string' || e.reason.trim() === '') throw new Error(`예외 목록 ${i + 1}번째에 까닭이 없다`);
    if (typeof e.directive !== 'string' || !parseDirective(e.directive)) throw new Error(`예외 목록 ${i + 1}번째의 directive가 ESLint 주석이 아니다: ${e.directive}`);
    if (!Array.isArray(e.files) || e.files.length === 0 || e.files.some((f) => typeof f !== 'string' || f.includes('*'))) throw new Error(`예외 목록 ${i + 1}번째의 files는 파일 경로 목록이다(글롭 없이)`);
    return { directive: norm(e.directive), files: new Set(e.files), reason: e.reason };
  });
}

/**
 * @param {{ root: string, exceptionsFile: string }} o
 * @returns {Promise<{ problems: string[], excepted: number, files: number }>}
 */
export async function check({ root, exceptionsFile }) {
  const { ESLint } = await import('eslint');
  const exceptions = readExceptions(exceptionsFile);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const paths = lintPaths(pkg.scripts?.lint);
  const eslint = new ESLint({
    cwd: root,
    errorOnUnmatchedPattern: false,
    overrideConfig: { linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off', reportUnusedInlineConfigs: 'off' } },
    ruleFilter: ({ ruleId }) => SECURITY_RULE.test(ruleId),
  });
  const results = await eslint.lintFiles(paths);
  const problems = [];
  const used = new Set();
  let excepted = 0;
  for (const r of results) {
    const file = relative(root, r.filePath).replaceAll('\\', '/');
    const config = await eslint.calculateConfigForFile(r.filePath);
    const securityFile = Object.entries(config?.rules ?? {}).some(([id, v]) => SECURITY_RULE.test(id) && [v].flat()[0] !== 'off' && [v].flat()[0] !== 0);
    for (const m of r.messages) {
      if (m.fatal) {
        problems.push(`${file}:${m.line ?? 0} 해석하지 못했다: ${m.message}`);
        continue;
      }
      if (m.ruleId && SECURITY_RULE.test(m.ruleId)) {
        problems.push(`${file}:${m.line} ${m.ruleId} 위반(줄 안 주석을 무시하고 돌린 결과): ${m.message}`);
        continue;
      }
      const hit = m.ruleId === null ? NO_EFFECT.exec(m.message) : null;
      if (!hit) continue;
      const d = parseDirective(hit[1]);
      if (!d || !touchesSecurity(d, { securityFile })) continue;
      const ex = exceptions.find((e) => e.files.has(file) && e.directive === norm(d.text));
      if (ex) {
        used.add(`${exceptions.indexOf(ex)}|${file}`);
        excepted++;
        continue;
      }
      problems.push(`${file}:${m.line} 보안 규칙을 줄 안 주석으로 끈다: ${d.text}. 예외는 규칙의 허용 목록(파일과 까닭)으로만 둔다(devops §4.4 '보안 린트')`);
    }
  }
  exceptions.forEach((e, i) => {
    for (const f of e.files) if (!used.has(`${i}|${f}`)) problems.push(`쓰이지 않는 예외: ${f}에 ${e.directive}가 없다(지웠거나 고쳤으면 예외 목록에서 지운다)`);
  });
  return { problems, excepted, files: results.length };
}

async function main() {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', default: fileURLToPath(new URL('../../', import.meta.url)) },
      exceptions: { type: 'string', default: fileURLToPath(new URL('./lint-disable-exceptions.json', import.meta.url)) },
    },
  });
  try {
    const { problems, excepted, files } = await check({ root: values.root, exceptionsFile: values.exceptions });
    for (const p of problems) console.log(process.env.GITHUB_ACTIONS === 'true' ? `::error::${p}` : `막음: ${p}`);
    console.log(`${problems.length === 0 ? '통과' : '막음'}: 파일 ${files}개, 문제 ${problems.length}건, 예외 ${excepted}건`);
    return problems.length === 0 ? 0 : 1;
  } catch (e) {
    console.log(`막음: 검사하지 못했다: ${e?.message ?? e}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main();
