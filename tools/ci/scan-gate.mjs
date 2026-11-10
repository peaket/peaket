#!/usr/bin/env node
// 외부 보안 검사 판정(docs/devops.md §4.4 '외부 보안 검사 게이트', ADR-0263 결정 4·5, ASVS 13.3.1·15.3.6·16.5.3, BUILD_ORDER BAS-011 ②).
// security-scan.yml(secrets·codeql·iac-config)과 build-image.yml(이미지 비밀 검사)이 부른다. 도구가 낸 결과 파일(SARIF)을 읽어 막고 알린다.
// - 비밀 검사(gitleaks, Trivy 이미지 비밀): 결과가 하나라도 있으면 등급과 상관없이 막는다. 예외 파일로 풀지 않는다(오탐은 각 도구 설정의 허용 목록).
//   gitleaks는 종료 코드(--exit-code)도 본다: 0(누출 없음)이나 누출 코드가 아니면 막고, 누출 코드인데 결과가 없거나 0인데 결과가 있어도 막는다.
// - CodeQL: 보안 등급(security-severity) 7.0 이상(높음·치명)과 프로토타입 오염 쿼리 셋(등급과 상관없이)은 막고 나머지는 알림만 남긴다.
//   그 셋이 돌았다는 흔적(규칙 목록)이 없으면 막는다. 소스 안 억제 주석(SARIF suppressions)은 예외로 보지 않는다.
// - Trivy 설정 검사: 7.0 이상(Trivy 높음 8.0·치명 9.5)은 막고 그 아래는 알림만이다. 등급이 없는 결과는 판정하지 못해 막는다.
// - 예외: tools/ci/scan-exceptions.json의 줄(도구·규칙·경로·사유·이슈·만든 날·만료일)이 도구·규칙·경로 모두 맞고 만료 전(한국 날짜로 만료일
//   그날까지)이면 받는다. 만료일은 만든 날부터 30일 [가정]을 넘지 못하고, 그 도구의 판정에서 쓰이지 않는 예외도 막는다.
// - 예외·받아들인 결과 줄은 맞을 결과 수(count)를 적고, 그보다 많은 결과가 맞으면 그 줄의 결과를 모두 막는다. PR(--event pull_request)에서는 CodeQL이 바뀐
//   곳만 볼 수 있어 쓰이지 않는 줄을 알림만 남기고, 푸시·예약 실행(그 밖의 사건이나 --event 없음)에서 막는다(devops §4.4 '리뷰 뒤 더한 규칙' ②, ADR-0263 결정 13).
// - 받아들인 결과: 고칠 것이 아니라 설계로 받아들인 결과(예: 의도한 공개 저장소, ADR-0169)는 같은 파일에 이슈 번호 대신 근거 ADR(adr, docs/adr에
//   그 번호의 파일이 있어야 한다)과 만료일 대신 다시 볼 날(reviewOn, 만든 날부터 1년 [가정] 안)을 적은 줄로 둔다. 다시 볼 날이 지나면 막고, 받은 결과는
//   알림 줄에 '받아들인 결과 ADR-…(다시 볼 날 …)'로 남긴다(devops §4.4 '예외 파일', ADR-0263 결정 12). 그 밖의 규칙(경로 하나·사유·쓰이지 않으면 막음)은 예외와 같다.
//   받아들인 결과는 IaC 설정 검사(trivy-config)에만 쓰고, 근거 ADR 파일 본문에 그 규칙 ID가 적혀 있어야 한다(ADR-0263 결정 13).
// - 닫힘 실패: 결과 파일이 없거나 비었거나 JSON·SARIF가 아니거나, 도구 이름이 다르거나, 결과 목록이 없으면 통과로 보지 않는다.
// - 보고서·잡 요약·주석에는 도구·규칙·파일·줄·등급(gitleaks는 커밋)만 적는다. 조각(snippet)·메시지 원문·작성자·메일은 옮기지 않는다.
// 쓰는 법: node tools/ci/scan-gate.mjs --tool <gitleaks|codeql|trivy-config|trivy-secret> --sarif <파일|폴더> [--exit-code <gitleaks 종료 코드>]
//          [--exceptions tools/ci/scan-exceptions.json] [--adr-dir docs/adr] [--event <GitHub 사건 이름>] [--now <ISO 시각>] [--report <판정 보고서 JSON>]
// 종료 코드: 0 통과, 1 막음(판정 실패나 입력을 못 읽음)
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runIfMain } from './entry.mjs';
import { GITLEAKS_LEAK_EXIT, SRC_MOUNT } from './scan-tools.mjs';
import { addDays, isDate, localDay, POLICY } from './vuln-deadline.mjs';

/** 막는 문턱과 예외 한도. 시험이 다른 값을 넣을 수 있게 인자로 받는다(날짜 규칙은 의존성 취약점 판정과 같다) */
export const GATE_POLICY = Object.freeze({ exceptionMaxDays: POLICY.exceptionMaxDays, acceptedMaxMonths: 12, utcOffsetMinutes: POLICY.utcOffsetMinutes, blockSeverity: 7.0 });
/** 받아들인 결과의 근거 ADR이 있는 폴더(저장소의 docs/adr) */
export const ADR_DIR = fileURLToPath(new URL('../../docs/adr/', import.meta.url));
/** 등급과 상관없이 막는 CodeQL 프로토타입 오염 쿼리 셋(ASVS 15.3.6, ADR-0263 결정 4) */
export const PROTOTYPE_QUERIES = Object.freeze(['js/prototype-polluting-assignment', 'js/prototype-pollution', 'js/prototype-pollution-utility']);
/** 판정하는 도구와 SARIF의 도구 이름 */
export const TOOLS = Object.freeze({ gitleaks: 'gitleaks', codeql: 'CodeQL', 'trivy-config': 'Trivy', 'trivy-secret': 'Trivy' });
const SECRET_TOOLS = new Set(['gitleaks', 'trivy-secret']);
const EXCEPTION_TOOLS = ['codeql', 'trivy-config'];
const EXCEPTION_KEYS = ['tool', 'rule', 'path', 'reason', 'issue', 'adr', 'count', 'createdOn', 'expiresOn', 'reviewOn'];
/** 받아들인 결과를 둘 수 있는 도구(설계로 받아들일 수 있는 것은 인프라 설정뿐이다) */
const ACCEPTED_TOOLS = ['trivy-config'];
const ADR = /^ADR-(\d{4})$/;

/** 달력 날짜에 달 수를 더한다. 그 달에 같은 날이 없으면 그 달의 마지막 날(1-31 + 1개월 = 2-28) */
function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}
/** 그 번호의 ADR 파일(NNNN-이름.md)의 본문. 없으면 null */
function adrText(dir, number) {
  try {
    const f = readdirSync(dir).find((n) => n.startsWith(`${number}-`) && n.endsWith('.md'));
    return f ? readFileSync(join(dir, f), 'utf8') : null;
  } catch {
    return null;
  }
}
const mentions = (text, id) => new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);
const PATH = /^(?!\/)[\w@.+-]+(?:\/[\w@.+-]+)*$/;

/** 입력이 틀렸다(닫힘 실패로 막는다) */
export class InputError extends Error {}
const fail = (msg) => {
  throw new InputError(msg);
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseJson(text, what) {
  if (typeof text !== 'string' || text.trim() === '') fail(`${what}가 비었다`);
  try {
    return JSON.parse(text);
  } catch (e) {
    return fail(`${what}가 JSON이 아니다: ${e.message}`);
  }
}

/** 보안 등급 글('6.1')을 수로. 없거나 틀리면 null */
function severityOf(...props) {
  for (const p of props) {
    const v = p?.['security-severity'];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && n <= 10) return n;
  }
  return null;
}

/** 결과의 파일 경로(저장소 기준). 설정 검사는 컨테이너 안 저장소 뿌리(/src)를 뗀다 */
function pathOf(result, run, tool, at) {
  const a = result.locations?.[0]?.physicalLocation?.artifactLocation;
  if (!isObj(a) || typeof a.uri !== 'string' || a.uri === '') fail(`${at}에 위치(locations[0].physicalLocation.artifactLocation.uri)가 없다`);
  let uri = a.uri;
  const base = a.uriBaseId ? run.originalUriBaseIds?.[a.uriBaseId]?.uri : undefined;
  if (typeof base === 'string' && base.startsWith('file:')) uri = new URL(uri, base).href;
  if (uri.startsWith('file:')) uri = decodeURIComponent(new URL(uri).pathname);
  if (tool === 'trivy-config' && uri.startsWith(`${SRC_MOUNT}/`)) uri = uri.slice(SRC_MOUNT.length + 1);
  return uri.replace(/^\.\//, '');
}

/**
 * SARIF 파일들을 읽어 결과 목록과 돈 규칙 ID 모음을 낸다. 모양이 틀리면 InputError
 * @param {{ file: string, text: string }[]} inputs
 * @param {keyof typeof TOOLS} tool
 * @returns {{ findings: { tool: string, rule: string, path: string, line: number | null, severity?: number, commit?: string, suppressed?: true }[], rules: Set<string> }}
 */
export function readFindings(inputs, tool) {
  const expected = TOOLS[tool];
  if (!expected) fail(`모르는 도구: ${tool}`);
  if (!Array.isArray(inputs) || inputs.length === 0) fail('읽을 결과 파일이 없다');
  const findings = [];
  const rules = new Set();
  for (const { file, text } of inputs) {
    const what = `결과 파일(${file})`;
    const j = parseJson(text, what);
    if (!isObj(j) || !Array.isArray(j.runs) || j.runs.length === 0) fail(`${what}에 runs 목록이 없다(SARIF가 아니다)`);
    j.runs.forEach((run, ri) => {
      const at = `${what}의 runs[${ri}]`;
      const name = run?.tool?.driver?.name;
      if (name !== expected) fail(`${at}의 도구 이름이 ${expected}가 아니다: ${name}`);
      if (!Array.isArray(run.results)) fail(`${at}에 results 목록이 없다`);
      const components = [run.tool.driver, ...(Array.isArray(run.tool.extensions) ? run.tool.extensions : [])];
      const byId = new Map();
      for (const c of components) for (const r of Array.isArray(c?.rules) ? c.rules : []) if (typeof r?.id === 'string') {
        rules.add(r.id);
        if (!byId.has(r.id)) byId.set(r.id, r);
      }
      run.results.forEach((res, i) => {
        const rat = `${at}의 results[${i}]`;
        if (!isObj(res)) fail(`${rat}가 객체가 아니다`);
        let descriptor;
        if (isObj(res.rule) && Number.isInteger(res.rule.index)) {
          const ci = Number.isInteger(res.rule.toolComponent?.index) ? res.rule.toolComponent.index + 1 : 0;
          descriptor = components[ci]?.rules?.[res.rule.index];
        } else if (Number.isInteger(res.ruleIndex)) descriptor = run.tool.driver.rules?.[res.ruleIndex];
        const rule = res.ruleId ?? res.rule?.id ?? descriptor?.id;
        if (typeof rule !== 'string' || rule === '') fail(`${rat}에 규칙 ID가 없다`);
        descriptor ??= byId.get(rule);
        const line = res.locations?.[0]?.physicalLocation?.region?.startLine;
        const f = { tool, rule, path: pathOf(res, run, tool, rat), line: Number.isInteger(line) ? line : null };
        const severity = severityOf(res.properties, descriptor?.properties);
        if (severity !== null) f.severity = severity;
        if (tool === 'gitleaks' && typeof res.partialFingerprints?.commitSha === 'string') f.commit = res.partialFingerprints.commitSha;
        if (Array.isArray(res.suppressions) && res.suppressions.length > 0) f.suppressed = true;
        findings.push(f);
      });
    });
  }
  // IaC 설정 검사는 같은 차트를 두 값으로 그리므로(deploy·chart-ci) 같은 (규칙, 경로, 줄) 결과를 하나로 센다(다시 보기 7)
  if (tool === 'trivy-config') {
    const seen = new Set();
    return {
      findings: findings.filter((f) => {
        const k = `${f.rule}|${f.path}|${f.line}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }),
      rules,
    };
  }
  return { findings, rules };
}

/**
 * 예외 파일을 읽는다. 한 줄은 도구(codeql·trivy-config), 규칙 ID, 파일 경로(저장소 기준, 글롭 없이), 사유(영향과 완화), 만든 날과
 * 예외면 이슈 번호(issue)·만료일(expiresOn, 만든 날부터 정책의 최대 일수 안), 받아들인 결과면 근거 ADR(adr, adrDir에 그 파일이 있어야 한다)·
 * 다시 볼 날(reviewOn, 만든 날부터 정책의 최대 달 수 안)이다. issue와 adr은 하나만 쓴다. 만든 날은 오늘보다 뒤일 수 없다. 틀리면 InputError
 * @returns {{ kind: 'exception' | 'accepted', tool: string, rule: string, path: string, reason: string, issue?: number, adr?: string, createdOn: string, expiresOn?: string, reviewOn?: string, until: string }[]}
 */
export function parseScanExceptions(text, { now = new Date(), policy = GATE_POLICY, adrDir = ADR_DIR } = {}) {
  const what = 'scan-exceptions.json';
  const j = parseJson(text, what);
  if (!isObj(j) || !Array.isArray(j.exceptions)) fail(`${what}에 exceptions 목록이 없다`);
  for (const k of Object.keys(j)) if (k !== 'exceptions' && k !== '$comment') fail(`${what}의 모르는 칸: ${k}`);
  const today = localDay(now, policy);
  const seen = new Set();
  return j.exceptions.map((e, i) => {
    const at = `${what}의 ${i + 1}번째 줄`;
    if (!isObj(e)) fail(`${at}가 객체가 아니다`);
    for (const k of Object.keys(e)) if (!EXCEPTION_KEYS.includes(k)) fail(`${at}의 모르는 칸: ${k}`);
    if (SECRET_TOOLS.has(e.tool)) fail(`${at}: 비밀 검사(${e.tool}) 결과는 예외 파일로 풀지 않는다. 오탐은 그 도구 설정의 허용 목록에 둔다`);
    if (!EXCEPTION_TOOLS.includes(e.tool)) fail(`${at}의 tool은 ${EXCEPTION_TOOLS.join('·')} 가운데 하나다: ${e.tool}`);
    if (typeof e.rule !== 'string' || e.rule.trim() === '' || /\s/.test(e.rule)) fail(`${at}의 rule은 규칙 ID다: ${e.rule}`);
    if (typeof e.path !== 'string' || !PATH.test(e.path) || e.path.split('/').includes('..')) fail(`${at}의 path는 저장소 기준 파일 경로 하나다(글롭·절대 경로·..를 쓰지 않는다): ${e.path}`);
    if (typeof e.reason !== 'string' || e.reason.trim().length < 10) fail(`${at}에 사유(영향과 완화)가 없다`);
    if ('issue' in e && 'adr' in e) fail(`${at}: issue와 adr을 함께 쓰지 않는다(고치지 못한 결과의 예외는 issue, 설계로 받아들인 결과는 adr)`);
    if (!('issue' in e) && !('adr' in e)) fail(`${at}: issue(예외)나 adr(받아들인 결과) 가운데 하나가 있어야 한다`);
    const kind = 'adr' in e ? 'accepted' : 'exception';
    if (!Number.isInteger(e.count) || e.count < 1) fail(`${at}의 count는 이 줄이 맞을 결과 수(1 이상의 정수)다: ${JSON.stringify(e.count)}`);
    if (!isDate(e.createdOn)) fail(`${at}의 createdOn은 YYYY-MM-DD 날짜다: ${e.createdOn}`);
    if (e.createdOn > today) fail(`${at}의 만든 날(${e.createdOn})이 오늘(${today})보다 뒤다`);
    let until;
    let base;
    if (kind === 'exception') {
      if ('reviewOn' in e) fail(`${at}: 예외 줄은 reviewOn이 아니라 만료일 expiresOn을 쓴다(reviewOn은 받아들인 결과 줄의 칸이다)`);
      if (!Number.isInteger(e.issue) || e.issue <= 0) fail(`${at}의 issue는 이슈 번호(양의 정수)다: ${e.issue}`);
      if (!isDate(e.expiresOn)) fail(`${at}의 expiresOn은 YYYY-MM-DD 날짜다: ${e.expiresOn}`);
      if (e.expiresOn < e.createdOn) fail(`${at}의 만료일(${e.expiresOn})이 만든 날보다 앞이다`);
      const max = addDays(e.createdOn, policy.exceptionMaxDays);
      if (e.expiresOn > max) fail(`${at}의 만료일(${e.expiresOn})은 만든 날부터 ${policy.exceptionMaxDays}일(${max})을 넘지 못한다`);
      until = e.expiresOn;
      base = { issue: e.issue, expiresOn: e.expiresOn };
    } else {
      if ('expiresOn' in e) fail(`${at}: 받아들인 결과 줄은 expiresOn이 아니라 다시 볼 날 reviewOn을 쓴다`);
      const m = ADR.exec(String(e.adr));
      if (typeof e.adr !== 'string' || !m) fail(`${at}의 adr은 'ADR-0000' 꼴의 근거 ADR 번호다: ${JSON.stringify(e.adr)}`);
      if (!ACCEPTED_TOOLS.includes(e.tool)) fail(`${at}: 받아들인 결과는 ${ACCEPTED_TOOLS.join('·')}에만 둔다(${e.tool} 결과는 고치거나 30일 예외로 둔다)`);
      const body = adrText(adrDir, m[1]);
      if (body === null) fail(`${at}: 근거 ADR 파일이 없다(${adrDir}의 ${m[1]}-*.md, ${e.adr})`);
      if (!mentions(body, e.rule)) fail(`${at}: 근거 ADR(${e.adr}) 본문에 규칙 ID ${e.rule}가 없다(그 결과를 받아들인다고 적은 ADR을 가리킨다)`);
      if (!isDate(e.reviewOn)) fail(`${at}의 reviewOn은 YYYY-MM-DD 날짜다: ${e.reviewOn}`);
      if (e.reviewOn < e.createdOn) fail(`${at}의 다시 볼 날(${e.reviewOn})이 만든 날보다 앞이다`);
      const max = addMonths(e.createdOn, policy.acceptedMaxMonths);
      if (e.reviewOn > max) fail(`${at}의 다시 볼 날(${e.reviewOn})은 만든 날부터 ${policy.acceptedMaxMonths}개월(${max})을 넘지 못한다`);
      until = e.reviewOn;
      base = { adr: e.adr, reviewOn: e.reviewOn };
    }
    const key = `${e.tool}|${e.rule}|${e.path}`;
    if (seen.has(key)) fail(`${at}가 앞의 줄과 겹친다: ${e.tool} ${e.rule} ${e.path}`);
    seen.add(key);
    return { kind, tool: e.tool, rule: e.rule, path: e.path, reason: e.reason, count: e.count, createdOn: e.createdOn, ...base, until };
  });
}

/** 이 결과가 막는 종류인가(예외를 보기 전) */
function blockingKind(tool, f, policy) {
  if (SECRET_TOOLS.has(tool)) return true;
  if (tool === 'codeql') return PROTOTYPE_QUERIES.includes(f.rule) || (f.severity !== undefined && f.severity >= policy.blockSeverity);
  // 설정 검사: 등급이 없으면 판정하지 못해 막는다
  return f.severity === undefined || f.severity >= policy.blockSeverity;
}

const exceptionView = (e) =>
  e.kind === 'accepted'
    ? { tool: e.tool, rule: e.rule, path: e.path, adr: e.adr, reviewOn: e.reviewOn, count: e.count }
    : { tool: e.tool, rule: e.rule, path: e.path, issue: e.issue, expiresOn: e.expiresOn, count: e.count };

/**
 * 판정. 예외·받아들인 결과는 그 도구의 줄만 본다. 막는 종류의 결과에 도구·규칙·경로가 맞는 줄이 있고 오늘(정책 시간대 날짜)이 만료일·다시 볼 날
 * 이하면 받는다(예외는 excepted, 받아들인 결과는 accepted). 지났으면 막고 expiredExceptions에 적는다. 한 줄에 맞은 결과가 그 줄의 count보다 많으면
 * 그 결과를 모두 막고 overCount에 적는다. 쓰이지 않는 줄은 막는다. 다만 PR(event pull_request)에서는 알림만이다
 * @returns {{ ok: boolean, today: string, blocking: object[], notices: object[], excepted: object[], accepted: object[], expiredExceptions: object[], unusedExceptions: object[], overCount: object[], unusedBlocks: boolean }}
 */
export function judge({ tool, findings, exceptions = [], now = new Date(), policy = GATE_POLICY, event }) {
  const today = localDay(now, policy);
  const mine = SECRET_TOOLS.has(tool) ? [] : exceptions.filter((e) => e.tool === tool);
  const blocking = [];
  const notices = [];
  /** @type {Map<object, object[]>} 줄 → 그 줄에 맞은 막는 종류의 결과 */
  const matched = new Map();
  for (const f of findings) {
    if (!blockingKind(tool, f, policy)) {
      notices.push(f);
      continue;
    }
    const e = mine.find((x) => x.rule === f.rule && x.path === f.path);
    if (!e) {
      blocking.push(f);
      continue;
    }
    if (!matched.has(e)) matched.set(e, []);
    matched.get(e).push(f);
  }
  const excepted = [];
  const accepted = [];
  const expired = [];
  const overCount = [];
  for (const [e, fs] of matched) {
    if (fs.length > e.count) {
      overCount.push({ ...exceptionView(e), matched: fs.length });
      blocking.push(...fs);
    } else if (today > e.until) {
      expired.push(exceptionView(e));
      blocking.push(...fs);
    } else if (e.kind === 'accepted') accepted.push(...fs.map((f) => ({ ...f, accepted: exceptionView(e) })));
    else excepted.push(...fs.map((f) => ({ ...f, exception: exceptionView(e) })));
  }
  const unusedExceptions = mine.filter((e) => !matched.has(e)).map(exceptionView);
  // PR에서는 CodeQL만 바뀐 곳을 보므로 그 쓰이지 않은 줄만 알림이다. IaC 설정 검사는 PR에서도 저장소 전체를 본다(다시 보기 5)
  const unusedBlocks = !(event === 'pull_request' && tool === 'codeql');
  return {
    ok: blocking.length === 0 && (unusedExceptions.length === 0 || !unusedBlocks),
    today,
    blocking,
    notices,
    excepted,
    accepted,
    expiredExceptions: expired,
    unusedExceptions,
    overCount,
    unusedBlocks,
  };
}

/** --sarif가 파일이면 그 파일, 폴더면 그 안의 *.sarif 전부 */
function readInputs(target) {
  let st;
  try {
    st = statSync(target);
  } catch (e) {
    return fail(`결과 파일을 읽지 못했다(${target}): ${e.code ?? e.message}`);
  }
  const files = st.isDirectory() ? readdirSync(target).filter((f) => f.endsWith('.sarif')).sort().map((f) => join(target, f)) : [target];
  if (files.length === 0) fail(`결과 폴더(${target})에 .sarif 파일이 없다`);
  return files.map((file) => {
    try {
      return { file, text: readFileSync(file, 'utf8') };
    } catch (e) {
      return fail(`결과 파일을 읽지 못했다(${file}): ${e.code ?? e.message}`);
    }
  });
}

// GitHub 작업 명령의 값·속성 이스케이프(@actions/core와 같다)
const escData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
/** 잡 요약(마크다운 표)의 칸: 역슬래시를 먼저 이스케이프한 뒤 |를 이스케이프하고 줄바꿈을 띄어 쓴다(CodeQL js/incomplete-sanitization) */
export const markdownCell = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n|\r/g, ' ');
const where = (f) => `${f.path}${f.line ? `:${f.line}` : ''}`;
const acceptedLabel = (f) => `받아들인 결과 ${f.accepted.adr}(다시 볼 날 ${f.accepted.reviewOn})`;
const detail = (f) => [f.severity !== undefined ? `등급 ${f.severity}` : null, f.commit ? `커밋 ${f.commit.slice(0, 12)}` : null, f.suppressed ? '억제 주석 있음(예외 아님)' : null].filter(Boolean).join(', ');

/** 명령줄. 종료 코드: 0 통과, 1 막음 */
export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log } = {}) {
  const gha = env.GITHUB_ACTIONS === 'true';
  const annotate = (level, f, msg) => log(gha ? `::${level} file=${escProp(f.path)}${f.line ? `,line=${f.line}` : ''}::${escData(msg)}` : `${level === 'error' ? '막음' : '알림'}: ${msg} (${where(f)})`);
  const say = (level, msg) => log(gha ? `::${level}::${escData(msg)}` : `${{ error: '막음', warning: '알림', notice: '참고' }[level]}: ${msg}`);
  const errors = [];
  let tool = null;
  let r = null;
  let reportFile;
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        tool: { type: 'string' },
        sarif: { type: 'string' },
        'exit-code': { type: 'string' },
        exceptions: { type: 'string', default: fileURLToPath(new URL('./scan-exceptions.json', import.meta.url)) },
        'adr-dir': { type: 'string', default: ADR_DIR },
        event: { type: 'string' },
        now: { type: 'string' },
        report: { type: 'string' },
      },
    });
    reportFile = values.report;
    tool = values.tool ?? null;
    if (!tool || !(tool in TOOLS)) fail(`--tool은 ${Object.keys(TOOLS).join('·')} 가운데 하나다: ${tool ?? '(없음)'}`);
    if (!values.sarif) fail('--sarif(결과 파일이나 폴더)가 없다');
    const now = values.now === undefined ? new Date() : new Date(values.now);
    if (Number.isNaN(now.getTime())) fail(`--now가 시각이 아니다: ${values.now}`);
    let exText;
    try {
      exText = readFileSync(values.exceptions, 'utf8');
    } catch (e) {
      fail(`예외 목록을 읽지 못했다(${values.exceptions}): ${e.code ?? e.message}`);
    }
    const exceptions = parseScanExceptions(exText, { now, adrDir: values['adr-dir'] });
    const { findings, rules } = readFindings(readInputs(values.sarif), tool);
    if (tool === 'codeql') {
      for (const id of PROTOTYPE_QUERIES) if (!rules.has(id)) errors.push(`CodeQL 결과의 규칙 목록에 ${id}가 없다(프로토타입 오염 쿼리 셋이 돈 흔적이 없다. 쿼리 묶음이 바뀌었는지 본다)`);
    }
    if (tool === 'gitleaks') {
      const code = values['exit-code'];
      if (code === undefined || !/^\d+$/.test(code)) errors.push(`gitleaks 종료 코드가 없다(앞 단계가 끝까지 돌지 않았다): ${code === undefined ? '(없음)' : JSON.stringify(code)}`);
      else {
        const n = Number(code);
        if (n !== 0 && n !== GITLEAKS_LEAK_EXIT) errors.push(`gitleaks가 누출 아닌 까닭으로 끝났다(종료 코드 ${n}. 미끼를 못 찾았거나 설정·git 오류다)`);
        if (n === GITLEAKS_LEAK_EXIT && findings.length === 0) errors.push(`gitleaks 종료 코드는 누출(${GITLEAKS_LEAK_EXIT})인데 보고서에 결과가 없다`);
      }
    }
    r = judge({ tool, findings, exceptions, now, event: values.event });
  } catch (e) {
    errors.push(e instanceof InputError || e?.code?.startsWith?.('ERR_PARSE_ARGS') ? e.message : `판정 도구가 넘어졌다: ${e?.stack ?? e}`);
  }
  const ok = errors.length === 0 && r !== null && r.ok;
  const report = { tool, today: r?.today ?? null, ok, errors, blocking: r?.blocking ?? [], notices: r?.notices ?? [], excepted: r?.excepted ?? [], accepted: r?.accepted ?? [], expiredExceptions: r?.expiredExceptions ?? [], unusedExceptions: r?.unusedExceptions ?? [], overCount: r?.overCount ?? [] };
  for (const e of errors) say('error', `검사 결과를 판정하지 못해 막는다: ${e}`);
  for (const f of report.blocking) annotate('error', f, `${tool} ${f.rule}${detail(f) ? ` (${detail(f)})` : ''} 막음`);
  for (const f of report.notices) annotate('warning', f, `${tool} ${f.rule}${detail(f) ? ` (${detail(f)})` : ''} 알림만`);
  for (const f of report.excepted) say('notice', `예외로 지나감: ${tool} ${f.rule} ${where(f)} #${f.exception.issue}(${f.exception.expiresOn}까지)`);
  for (const f of report.accepted) annotate('warning', f, `${tool} ${f.rule}${detail(f) ? ` (${detail(f)})` : ''} ${acceptedLabel(f)}`);
  for (const e of report.expiredExceptions) {
    if (e.adr) say('error', `다시 볼 날이 지난 받아들인 결과: ${e.tool} ${e.rule} ${e.path} ${e.adr}(${e.reviewOn}). 근거 ADR을 다시 보고 다시 볼 날을 새로 적거나 고친다`);
    else say('error', `만료된 예외: ${e.tool} ${e.rule} ${e.path} #${e.issue}(${e.expiresOn} 만료). 고치거나 새 예외를 둔다`);
  }
  const unusedLevel = r && !r.unusedBlocks ? 'warning' : 'error';
  for (const e of report.unusedExceptions) say(unusedLevel, `쓰이지 않는 ${e.adr ? `받아들인 결과: ${e.tool} ${e.rule} ${e.path} ${e.adr}` : `예외: ${e.tool} ${e.rule} ${e.path} #${e.issue}`}. 고쳤으면 지운다${unusedLevel === 'warning' ? '(PR은 바뀐 곳만 보므로 알림만, 푸시·예약 실행에서 막는다)' : ''}`);
  for (const e of report.overCount) say('error', `결과 수를 넘은 줄: ${e.tool} ${e.rule} ${e.path} ${e.adr ?? `#${e.issue}`} count ${e.count}인데 ${e.matched}건이 맞았다. 늘어난 결과를 보고 고치거나 줄을 고친다`);
  log(`${ok ? '통과' : '막음'}: ${tool ?? '(도구 모름)'} 막음 ${report.blocking.length}, 알림 ${report.notices.length}, 예외 ${report.excepted.length}, 받아들인 결과 ${report.accepted.length}, 오류 ${errors.length}`);
  if (reportFile) writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    const lines = [`## 보안 검사 판정: ${tool ?? '(도구 모름)'}${report.today ? `(${report.today}, 한국 날짜)` : ''}`, '', ok ? '통과' : `막음: 결과 ${report.blocking.length}건, 판정 오류 ${errors.length}건, 쓰이지 않는 예외 ${report.unusedExceptions.length}건`, ''];
    for (const e of errors) lines.push(`- 판정 오류: ${markdownCell(e)}`);
    const rows = [...report.blocking.map((f) => ['막음', f]), ...report.excepted.map((f) => [`예외 #${f.exception.issue}`, f]), ...report.accepted.map((f) => [`알림(${acceptedLabel(f)})`, f]), ...report.notices.map((f) => ['알림', f])];
    if (rows.length > 0) {
      lines.push('', '| 판정 | 규칙 | 파일 | 줄 | 더 |', '| --- | --- | --- | --- | --- |');
      for (const [what, f] of rows.slice(0, 300)) lines.push(`| ${what} | \`${markdownCell(f.rule)}\` | \`${markdownCell(f.path)}\` | ${f.line ?? ''} | ${markdownCell(detail(f))} |`);
      if (rows.length > 300) lines.push('', `(표는 300줄까지. 나머지 ${rows.length - 300}줄은 판정 보고서에 있다)`);
    }
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
  return ok ? 0 : 1;
}

// 직접 실행 판별이 틀리면 통과가 아니라 실패로 끝낸다(링크 경로로 불러도 실제 경로로 견준다, ADR-0263 결정 13 ⑦)
await runIfMain(import.meta.url, () => main());
