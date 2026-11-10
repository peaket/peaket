#!/usr/bin/env node
// 취약점 조치 기한·예외 만료 판정(docs/devops.md §4.4 '취약점 조치 기한'·'조치 기한 판정'·'라이선스', ASVS 15.1.1·16.5.3,
// ADR-0259 결정 10, BUILD_ORDER BAS-010 ①). security-scan.yml이 부른다.
// - 읽는 것: pnpm 내장 검사 결과 `pnpm audit --json`(advisories·metadata 모양, pnpm 12는 레지스트리의 advisories/bulk를 묻는다),
//   예외 파일 tools/ci/vuln-exceptions.json, 선택으로 `pnpm licenses list --json`(라이선스 → 패키지 목록).
// - 기한: 수정본 공개일부터 치명 7일, 높음 30일, 중간 90일. 낮음은 분기 정기 갱신 목록에 올리고 날짜 기한을 세지 않는다.
//   pnpm audit 결과에는 수정본 공개일이 없어, 설치된 판보다 큰 가장 작은 수정 판(patched_versions의 하한)의 게시 시각을 레지스트리
//   문서(time)에서 읽는다(--registry). 못 읽으면 그 기한은 '알 수 없음'으로 적고 PR 판정은 등급과 예외로만 한다.
// - PR 게이트: 유효한 예외가 없는 치명·높음이 하나라도 있으면 막는다(종료 1). 중간 이하는 알림만 남긴다.
//   기한을 넘긴 이미지의 운영 승격 차단은 BAS-140(D-T13)이 이 도구의 보고서(--report)를 쓴다.
// - 닫힘 실패(ASVS 16.5.3): 검사 결과·예외 파일·라이선스 결과가 없거나 읽지 못하거나 형식이 틀리면 통과로 보지 않고 막는다.
// - 날짜는 한국 시각(UTC+9) [가정]의 달력 날짜로 센다. 만료일은 그날 끝까지 유효하다.
// - 예외는 예외 파일에만 둔다: pnpm의 무시 설정(auditConfig·audit의 ignoreGhsas·ignoreCves·ignore, auditLevel·audit.level, .npmrc의 audit-level)이
//   뿌리 pnpm-workspace.yaml·package.json(pnpm 칸)·.npmrc에 있으면 막는다. 검사 결과에서 취약점을 미리 지워 기한·만료 판정을 건너뛰지 못하게 한다
//   (devops §4.4 '조치 기한 판정', ADR-0259 결정 12, 리뷰 R10).
// 쓰는 법: node tools/ci/vuln-deadline.mjs --audit <pnpm audit --json 결과> [--exceptions tools/ci/vuln-exceptions.json]
//          [--licenses <pnpm licenses list --json 결과>] [--registry https://registry.npmjs.org | --fix-dates <파일>]
//          [--now <ISO 시각>] [--report <보고서 JSON>]
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

/** 기한(일)과 예외 최대 일수. 시험이 다른 값을 넣을 수 있게 인자로 받는다 */
export const POLICY = Object.freeze({ days: Object.freeze({ critical: 7, high: 30, moderate: 90 }), exceptionMaxDays: 30, utcOffsetMinutes: 9 * 60 });
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'];
const BLOCKING = new Set(['critical', 'high']);
const SEVERITY_KO = { critical: '치명', high: '높음', moderate: '중간', low: '낮음', info: '정보' };
const GHSA = /^GHSA(-[0-9a-z]{4}){3}$/;
const DAY = 86_400_000;

/** 입력이 틀렸다(닫힘 실패로 막는다) */
export class InputError extends Error {}
const fail = (msg) => {
  throw new InputError(msg);
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// 날짜: 'YYYY-MM-DD' 달력 날짜끼리 견준다
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);
/** 그 시각의 달력 날짜(정책의 시간대) */
export const localDay = (date, policy = POLICY) => new Date(date.getTime() + policy.utcOffsetMinutes * 60_000).toISOString().slice(0, 10);

function parseJson(text, what) {
  if (typeof text !== 'string' || text.trim() === '') fail(`${what}가 비었다`);
  try {
    return JSON.parse(text);
  } catch (e) {
    return fail(`${what}가 JSON이 아니다: ${e.message}`);
  }
}

/**
 * pnpm audit --json 결과를 판(설치된 판)마다의 발견 목록으로 바꾼다. 모양이 틀리면 InputError
 * @returns {{ name: string, version: string, package: string, advisory: string, id: string, severity: string, title: string, url: string, patched: string|null, paths: string[] }[]}
 */
export function parseAudit(text) {
  const what = '취약점 검사 결과(pnpm audit --json)';
  const j = parseJson(text, what);
  if (!isObj(j)) fail(`${what}가 객체가 아니다`);
  if ('error' in j) fail(`${what}가 오류다: ${JSON.stringify(j.error).slice(0, 300)}`);
  if (!isObj(j.advisories)) fail(`${what}에 advisories 객체가 없다`);
  const counts = j.metadata?.vulnerabilities;
  if (!isObj(counts)) fail(`${what}에 metadata.vulnerabilities가 없다`);
  for (const s of ['critical', 'high', 'moderate', 'low']) if (!Number.isInteger(counts[s]) || counts[s] < 0) fail(`${what}의 metadata.vulnerabilities.${s}가 0 이상의 정수가 아니다`);
  const deps = j.metadata.totalDependencies;
  if (deps !== undefined && !(Number.isInteger(deps) && deps > 0)) fail(`${what}의 의존성 수가 ${deps}다(다른 자리에서 돌았거나 잠금 파일을 못 읽었다)`);
  const out = [];
  for (const [key, a] of Object.entries(j.advisories)) {
    const at = `${what}의 advisories[${key}]`;
    if (!isObj(a)) fail(`${at}가 객체가 아니다`);
    if (typeof a.module_name !== 'string' || a.module_name === '') fail(`${at}에 module_name이 없다`);
    if (!SEVERITIES.includes(a.severity)) fail(`${at}의 등급을 모른다: ${a.severity}`);
    const advisory = a.github_advisory_id ?? /GHSA(-[0-9a-z]{4}){3}/.exec(String(a.url ?? ''))?.[0];
    if (!GHSA.test(String(advisory))) fail(`${at}에 GHSA 취약점 ID가 없다`);
    if (a.patched_versions !== null && a.patched_versions !== undefined && typeof a.patched_versions !== 'string') fail(`${at}의 patched_versions가 글이 아니다`);
    if (!Array.isArray(a.findings) || a.findings.length === 0) fail(`${at}에 findings(설치된 판)가 없다`);
    for (const f of a.findings) {
      if (!isObj(f) || typeof f.version !== 'string' || f.version === '') fail(`${at}의 findings에 판이 없다`);
      out.push({
        name: a.module_name,
        version: f.version,
        package: `${a.module_name}@${f.version}`,
        advisory,
        id: String(a.id ?? key),
        severity: a.severity,
        title: String(a.title ?? ''),
        url: String(a.url ?? ''),
        patched: a.patched_versions ?? null,
        paths: Array.isArray(f.paths) ? f.paths.map(String) : [],
      });
    }
  }
  // 요약이 센 치명·높음·중간·낮음이 목록에 없으면 잘린 결과다
  for (const s of ['critical', 'high', 'moderate', 'low']) {
    if (counts[s] > 0 && !out.some((f) => f.severity === s)) fail(`${what}의 요약은 ${SEVERITY_KO[s]} ${counts[s]}건인데 목록에 없다(잘린 결과)`);
  }
  return out;
}

const PACKAGE = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const EXCEPTION_KEYS = ['package', 'advisory', 'reason', 'issue', 'createdOn', 'expiresOn'];

/**
 * 예외 파일을 읽는다. 한 줄은 `패키지@판`(정확한 판), 취약점 ID(GHSA), 사유(영향 분석·완화 방법), 이슈 번호, 만든 날, 만료일이다.
 * 만료일은 만든 날부터 정책의 최대 일수(30일 [가정])를 넘지 못하고, 만든 날은 오늘보다 뒤일 수 없다. 틀리면 InputError
 */
export function parseExceptions(text, { now = new Date(), policy = POLICY } = {}) {
  const what = '예외 파일(vuln-exceptions.json)';
  const j = parseJson(text, what);
  if (!isObj(j) || !Array.isArray(j.exceptions)) fail(`${what}에 exceptions 목록이 없다`);
  for (const k of Object.keys(j)) if (k !== 'exceptions' && k !== '$comment') fail(`${what}의 모르는 칸: ${k}`);
  const today = localDay(now, policy);
  const seen = new Set();
  return j.exceptions.map((e, i) => {
    const at = `${what}의 ${i + 1}번째 예외`;
    if (!isObj(e)) fail(`${at}가 객체가 아니다`);
    for (const k of Object.keys(e)) if (!EXCEPTION_KEYS.includes(k)) fail(`${at}의 모르는 칸: ${k}`);
    const m = PACKAGE.exec(String(e.package));
    if (!m) fail(`${at}의 package는 '이름@정확한 판'이다: ${e.package}`);
    if (!GHSA.test(String(e.advisory))) fail(`${at}의 advisory는 GHSA 취약점 ID다: ${e.advisory}`);
    if (typeof e.reason !== 'string' || e.reason.trim().length < 10) fail(`${at}에 사유(영향 분석·완화 방법)가 없다`);
    if (!Number.isInteger(e.issue) || e.issue <= 0) fail(`${at}의 issue는 이슈 번호(양의 정수)다: ${e.issue}`);
    if (!isDate(e.createdOn)) fail(`${at}의 createdOn은 YYYY-MM-DD 날짜다: ${e.createdOn}`);
    if (!isDate(e.expiresOn)) fail(`${at}의 expiresOn은 YYYY-MM-DD 날짜다: ${e.expiresOn}`);
    if (e.createdOn > today) fail(`${at}의 만든 날(${e.createdOn})이 오늘(${today})보다 뒤다`);
    if (e.expiresOn < e.createdOn) fail(`${at}의 만료일(${e.expiresOn})이 만든 날보다 앞이다`);
    const max = addDays(e.createdOn, policy.exceptionMaxDays);
    if (e.expiresOn > max) fail(`${at}의 만료일(${e.expiresOn})은 만든 날부터 ${policy.exceptionMaxDays}일(${max})을 넘지 못한다`);
    const key = `${e.package}|${e.advisory}`;
    if (seen.has(key)) fail(`${at}가 앞의 예외와 겹친다: ${e.package} ${e.advisory}`);
    seen.add(key);
    return { package: e.package, advisory: e.advisory, reason: e.reason, issue: e.issue, createdOn: e.createdOn, expiresOn: e.expiresOn };
  });
}

// 판 번호: 숫자 세 마디와 선택적 사전 판. 두 자리 이상도 숫자로 견준다(1.3.9 < 1.3.10)
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim());
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null, text: String(v).trim().replace(/^v/, '') } : null;
}
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  const pa = a.pre.split('.');
  const pb = b.pre.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb && Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
    if (na !== nb) return na ? -1 : 1;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** 수정본 판: patched_versions의 하한(>=X) 가운데 설치된 판보다 큰 가장 작은 것. 수정본이 없으면 null */
export function fixVersionOf(installed, patched) {
  if (typeof patched !== 'string' || patched.trim() === '' || /^<\s*0\.0\.0(-0)?$/.test(patched.trim())) return null;
  const lows = [...patched.matchAll(/>=?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)].map((m) => parseVersion(m[1])).filter(Boolean);
  if (lows.length === 0) return null;
  lows.sort(compareVersions);
  const cur = parseVersion(installed);
  const above = cur ? lows.filter((l) => compareVersions(l, cur) > 0) : [];
  return (above[0] ?? lows[0]).text;
}

/**
 * 발견마다 기한·예외 상태를 세고 PR 판정을 낸다.
 * @param {{ findings: ReturnType<typeof parseAudit>, exceptions: ReturnType<typeof parseExceptions>, now: Date, fixDates?: Record<string, string>, policy?: typeof POLICY }} i
 *   fixDates: '이름@수정 판' → 게시 시각(ISO)
 */
export function evaluate({ findings, exceptions, now, fixDates = {}, policy = POLICY }) {
  const today = localDay(now, policy);
  const used = new Set();
  const rows = findings.map((f) => {
    const fixVersion = fixVersionOf(f.version, f.patched);
    const published = fixVersion ? fixDates[`${f.name}@${fixVersion}`] : undefined;
    const publishedAt = published ? new Date(published) : null;
    const fixPublishedOn = publishedAt && !Number.isNaN(publishedAt.getTime()) ? localDay(publishedAt, policy) : null;
    const days = policy.days[f.severity];
    const schedule = f.severity === 'low' ? 'quarterly' : f.severity === 'info' ? 'none' : 'deadline';
    const deadline = schedule === 'deadline' && fixPublishedOn ? addDays(fixPublishedOn, days) : null;
    const ex = exceptions.find((e) => e.package === f.package && e.advisory === f.advisory) ?? null;
    if (ex) used.add(ex);
    const exceptionState = !ex ? 'none' : today <= ex.expiresOn ? 'valid' : 'expired';
    return {
      ...f,
      fixVersion,
      fixPublishedOn,
      schedule,
      deadline,
      deadlineUnknown: schedule === 'deadline' && fixVersion !== null && !fixPublishedOn,
      daysLeft: deadline ? diffDays(deadline, today) : null,
      overdue: deadline ? today > deadline : false,
      exception: ex,
      exceptionState,
      exceptionDaysLeft: ex ? diffDays(ex.expiresOn, today) : null,
    };
  });
  const blocking = rows.filter((r) => BLOCKING.has(r.severity) && r.exceptionState !== 'valid');
  const excepted = rows.filter((r) => r.exceptionState === 'valid');
  const notices = rows.filter((r) => !BLOCKING.has(r.severity) && r.exceptionState !== 'valid');
  return {
    ok: blocking.length === 0,
    today,
    findings: rows,
    blocking,
    excepted,
    notices,
    expiredExceptions: exceptions.filter((e) => today > e.expiresOn),
    unusedExceptions: exceptions.filter((e) => !used.has(e)),
  };
}

/** 허용 라이선스(devops §4.4 '라이선스': MIT, Apache-2.0, BSD, ISC 등 [가정]: 그 이름의 SPDX 판들) */
export const ALLOWED_LICENSES = ['MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'ISC'];

/** SPDX 식이 허용 목록 안인가. 괄호 안팎에 AND·OR가 섞이면 사람이 본다(허용으로 보지 않는다) */
export function licenseAllowed(expr, allowed = ALLOWED_LICENSES) {
  const s = String(expr ?? '').trim();
  if (s === '') return false;
  const ok = (id) => allowed.includes(id.replace(/\s+WITH\s+.+$/i, '').trim());
  if (/[()]/.test(s)) {
    const inner = s.replace(/[()]/g, ' ');
    if (/\bAND\b/i.test(inner) && /\bOR\b/i.test(inner)) return false;
    return licenseAllowed(inner.replace(/\s+/g, ' '), allowed);
  }
  return s.split(/\s+OR\s+/i).some((alt) => alt.split(/\s+AND\s+/i).every(ok));
}

/** pnpm licenses list --json 결과(라이선스 → 패키지 목록)를 패키지·판마다로 바꾼다. 모양이 틀리면 InputError */
export function parseLicenses(text) {
  const what = '라이선스 검사 결과(pnpm licenses list --json)';
  const j = parseJson(text, what);
  if (!isObj(j)) fail(`${what}가 객체가 아니다`);
  if ('error' in j) fail(`${what}가 오류다: ${JSON.stringify(j.error).slice(0, 300)}`);
  const out = [];
  for (const [group, list] of Object.entries(j)) {
    if (!Array.isArray(list)) fail(`${what}의 ${group}가 목록이 아니다`);
    for (const p of list) {
      if (!isObj(p) || typeof p.name !== 'string' || p.name === '') fail(`${what}의 ${group}에 이름 없는 패키지가 있다`);
      const versions = Array.isArray(p.versions) ? p.versions : typeof p.version === 'string' ? [p.version] : null;
      if (!versions || versions.length === 0) fail(`${what}의 ${p.name}에 판이 없다`);
      for (const v of versions) out.push({ name: p.name, version: String(v), license: typeof p.license === 'string' ? p.license : group });
    }
  }
  return out;
}

/** 허용 목록 밖의 라이선스(경고만, 사람이 확인한다) */
export function judgeLicenses(packages, allowed = ALLOWED_LICENSES) {
  return packages.filter((p) => !licenseAllowed(p.license, allowed)).map((p) => ({ package: `${p.name}@${p.version}`, license: p.license }));
}

/** 무시로 보는 pnpm 설정 칸: audit(새 이름)·auditConfig(옛 이름)의 ignore…(ignorePrune은 목록을 줄이기만 해 뺀다)와 등급 문턱 */
const isIgnoreKey = (section, key) => (/^ignore/i.test(key) && key !== 'ignorePrune') || (section === 'audit' && key === 'level');

/** pnpm-workspace.yaml에서 무시 설정을 찾는다(YAML 읽개 없이 줄 단위로. 맨 위 칸과 그 아래 칸, 흐름 꼴 { … }) */
function workspaceIgnores(text) {
  const found = [];
  const lines = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l) && l.trim() !== '').map((l) => l.replace(/\s+#.*$/, ''));
  let section = null;
  for (const line of lines) {
    const top = /^(['"]?)([A-Za-z_][\w-]*)\1\s*:(.*)$/.exec(line);
    if (top) {
      const [, , key, rest] = top;
      section = key === 'audit' || key === 'auditConfig' ? key : null;
      if (key === 'auditLevel') found.push('auditLevel');
      if (section) for (const m of rest.matchAll(/(['"]?)([A-Za-z_][\w-]*)\1\s*:/g)) if (isIgnoreKey(section, m[2])) found.push(`${section}.${m[2]}`);
      continue;
    }
    const child = /^\s+(['"]?)([A-Za-z_][\w-]*)\1\s*:/.exec(line);
    if (section && child && isIgnoreKey(section, child[2])) found.push(`${section}.${child[2]}`);
  }
  // 닻(&)·병합(<<) 같은 꼴로 위치를 놓쳐도 이름이 보이면 막는다(닫힘 실패)
  for (const m of lines.join('\n').matchAll(/\b(ignoreGhsas|ignoreCves|auditLevel)\b/g)) if (!found.some((f) => f.endsWith(m[1]))) found.push(`${m[1]}(위치를 모름)`);
  return found;
}

/**
 * 뿌리의 pnpm 무시 설정을 찾는다. 찾은 것마다 '파일: 칸' 글을 돌려준다(없으면 빈 목록). 파일이 없으면 넘어가고, 읽지 못하거나 형식이 틀리면 InputError
 * @param {string} root 저장소 뿌리
 */
export function findAuditIgnores(root) {
  const read = (name) => {
    try {
      return readFileSync(join(root, name), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      return fail(`${name}를 읽지 못했다: ${e.code ?? e.message}`);
    }
  };
  const found = [];
  const ws = read('pnpm-workspace.yaml');
  if (ws !== null) for (const f of workspaceIgnores(ws)) found.push(`pnpm-workspace.yaml: ${f}`);
  const pkgText = read('package.json');
  if (pkgText !== null) {
    const pkg = parseJson(pkgText, '뿌리 package.json');
    const pnpm = isObj(pkg) && isObj(pkg.pnpm) ? pkg.pnpm : {};
    for (const section of ['auditConfig', 'audit']) {
      if (isObj(pnpm[section])) for (const k of Object.keys(pnpm[section])) if (isIgnoreKey(section, k)) found.push(`package.json: pnpm.${section}.${k}`);
    }
    if ('auditLevel' in pnpm) found.push('package.json: pnpm.auditLevel');
  }
  const npmrc = read('.npmrc');
  if (npmrc !== null) {
    for (const l of npmrc.split(/\r?\n/)) {
      const m = /^\s*(audit[-_]level|audit[-_]config|ignore[-_](?:ghsas|cves))\s*=/i.exec(l);
      if (m) found.push(`.npmrc: ${m[1].toLowerCase()}`);
    }
  }
  return found;
}

/** 레지스트리 문서의 time에서 수정 판의 게시 시각을 읽는다. 못 읽은 것은 빼고 경고를 남긴다 */
async function lookupFixDates(rows, registry, warn, fetchImpl = fetch) {
  const want = new Map();
  for (const f of rows) {
    const v = fixVersionOf(f.version, f.patched);
    if (v && f.severity !== 'info') (want.get(f.name) ?? want.set(f.name, new Set()).get(f.name)).add(v);
  }
  const out = {};
  for (const [name, versions] of want) {
    const path = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
    try {
      const res = await fetchImpl(`${registry.replace(/\/+$/, '')}/${path}`, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const time = (await res.json())?.time ?? {};
      for (const v of versions) {
        if (typeof time[v] === 'string') out[`${name}@${v}`] = time[v];
        else warn(`수정본 공개일을 모른다: ${name}@${v}(레지스트리 문서에 게시 시각이 없다)`);
      }
    } catch (e) {
      warn(`수정본 공개일을 모른다: ${name}(레지스트리를 못 읽었다: ${e.message})`);
    }
  }
  return out;
}

function describe(f) {
  const due = f.schedule === 'quarterly' ? '분기 정기 갱신' : f.schedule === 'none' ? '기한 없음' : f.fixVersion === null ? '수정본 없음(예외로 영향 분석·완화를 적는다)' : f.deadline ? `기한 ${f.deadline}(${f.overdue ? `${-f.daysLeft}일 넘김` : `${f.daysLeft}일 남음`})` : '기한 알 수 없음';
  const ex = f.exception ? ` 예외 #${f.exception.issue} ${f.exceptionState === 'valid' ? `${f.exception.expiresOn}까지` : `${f.exception.expiresOn}에 만료`}` : ' 예외 없음';
  return `${f.package} ${f.advisory} ${SEVERITY_KO[f.severity]}(${f.severity}) ${due}${ex}${f.fixVersion ? ` 수정 판 ${f.fixVersion}` : ''}`;
}

/** 명령줄. 종료 코드: 0 통과, 1 막음(게이트 실패나 입력을 못 읽음) */
export async function main(argv = process.argv.slice(2), { env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const gha = env.GITHUB_ACTIONS === 'true';
  const say = (level, msg) => log(gha ? `::${level}::${msg.replace(/\r?\n/g, ' ')}` : `${{ error: '막음', warning: '알림', notice: '참고' }[level]}: ${msg}`);
  const summary = [];
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        audit: { type: 'string' },
        exceptions: { type: 'string', default: fileURLToPath(new URL('./vuln-exceptions.json', import.meta.url)) },
        licenses: { type: 'string' },
        registry: { type: 'string' },
        'fix-dates': { type: 'string' },
        now: { type: 'string' },
        report: { type: 'string' },
        root: { type: 'string', default: fileURLToPath(new URL('../../', import.meta.url)) },
      },
    }));
    if (!values.audit) fail('--audit(pnpm audit --json 결과 파일)가 없다');
    const now = values.now === undefined ? new Date() : new Date(values.now);
    if (Number.isNaN(now.getTime())) fail(`--now가 시각이 아니다: ${values.now}`);
    const read = (file, what) => {
      try {
        return readFileSync(file, 'utf8');
      } catch (e) {
        return fail(`${what}를 읽지 못했다(${file}): ${e.code ?? e.message}`);
      }
    };
    const findings = parseAudit(read(values.audit, '취약점 검사 결과'));
    const ignores = findAuditIgnores(values.root);
    if (ignores.length > 0) {
      for (const f of ignores) say('error', `pnpm 무시 설정을 찾아 막는다: ${f}. 예외는 tools/ci/vuln-exceptions.json에만 둔다(검사 결과에서 취약점을 미리 지우면 기한·만료 판정을 건너뛴다)`);
      summary.push('## 취약점 조치 기한 판정', '', `막음: pnpm 무시 설정 ${ignores.length}건(${ignores.join(', ')})`);
      return 1;
    }
    const exceptions = parseExceptions(read(values.exceptions, '예외 파일'), { now });
    const licenses = values.licenses === undefined ? null : parseLicenses(read(values.licenses, '라이선스 검사 결과'));
    let fixDates = {};
    if (values['fix-dates']) {
      fixDates = parseJson(read(values['fix-dates'], '수정본 공개일 파일'), '수정본 공개일 파일');
      if (!isObj(fixDates)) fail('수정본 공개일 파일이 객체가 아니다');
    } else if (values.registry) {
      fixDates = await lookupFixDates(findings, values.registry, (m) => say('warning', m), fetchImpl);
    }
    const r = evaluate({ findings, exceptions, now, fixDates });
    for (const f of r.blocking) say('error', `유효한 예외가 없는 ${SEVERITY_KO[f.severity]} 취약점: ${describe(f)}`);
    for (const f of r.notices) say('warning', `취약점(알림만): ${describe(f)}`);
    for (const f of r.excepted) say('notice', `예외로 지나감: ${describe(f)}`);
    for (const e of r.expiredExceptions) say('warning', `만료된 예외: ${e.package} ${e.advisory} #${e.issue}(${e.expiresOn} 만료). 고치거나 새 예외를 둔다`);
    for (const e of r.unusedExceptions) say('warning', `쓰이지 않는 예외: ${e.package} ${e.advisory} #${e.issue}. 고쳤으면 지운다`);
    const licenseWarnings = licenses ? judgeLicenses(licenses) : [];
    for (const w of licenseWarnings) say('warning', `허용 목록 밖의 라이선스(사람이 확인한다): ${w.package} ${w.license}`);
    summary.push(`## 취약점 조치 기한 판정(${r.today}, 한국 날짜)`, '', r.ok ? '통과: 유효한 예외가 없는 치명·높음이 없다' : `막음: 유효한 예외가 없는 치명·높음 ${r.blocking.length}건`, '');
    if (r.findings.length > 0) {
      summary.push('| 패키지 | 취약점 | 등급 | 기한 | 예외 |', '| --- | --- | --- | --- | --- |');
      for (const f of r.findings) summary.push(`| \`${f.package}\` | ${f.advisory} | ${SEVERITY_KO[f.severity]} | ${f.deadline ?? (f.schedule === 'quarterly' ? '분기 정기 갱신' : '알 수 없음·없음')}${f.overdue ? ' 넘김' : ''} | ${f.exception ? `#${f.exception.issue} ${f.exceptionState}` : '없음'} |`);
    }
    if (licenseWarnings.length > 0) summary.push('', `허용 목록 밖의 라이선스 ${licenseWarnings.length}건: ${licenseWarnings.map((w) => `\`${w.package}\` ${w.license}`).join(', ')}`);
    if (values.report) writeFileSync(values.report, `${JSON.stringify({ ...r, licenseWarnings }, null, 2)}\n`);
    log(`${r.ok ? '통과' : '막음'}: 발견 ${r.findings.length}건(막음 ${r.blocking.length}, 알림 ${r.notices.length}, 예외 ${r.excepted.length}), 라이선스 경고 ${licenseWarnings.length}건`);
    return r.ok ? 0 : 1;
  } catch (e) {
    // 닫힘 실패: 읽지 못하면 통과로 보지 않는다
    const msg = e instanceof InputError || e?.code?.startsWith?.('ERR_PARSE_ARGS') ? e.message : `판정 도구가 넘어졌다: ${e?.stack ?? e}`;
    say('error', `검사 결과를 판정하지 못해 막는다: ${msg}`);
    summary.push('## 취약점 조치 기한 판정', '', `막음: ${msg}`);
    return 1;
  } finally {
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main();
