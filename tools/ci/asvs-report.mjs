#!/usr/bin/env node
// ASVS 추적 시험 태그 수집 리포트(docs/architecture.md §8.2 4번 '테스트 결과 자동화 연동', BUILD_ORDER BOT-160).
// 시험 이름에 단 `[ASVS v5.0.0-x.y.z]` 태그를 시험 보고서와 원본에서 모아, ASVS 추적 표(docs/security/asvs/*.md)의 행마다 결과를 낸다.
//   node tools/ci/asvs-report.mjs [--report a.json …] [--scan services …] [--docs docs/security/asvs] [--summary out.md] [--json out.json] [--strict]
// 행의 결과: 통과(태그 시험이 실행돼 모두 통과), 실패(실패한 태그 시험이 하나라도), 미실행(원본에 태그가 있으나 이번 보고서에 없음),
//   태그 없음(적용·부분 적용 행인데 태그 단 시험이 없다), 설계 검사(구현 위치 칸에 '(운영 설계만)': 통과로 세지 않는다), —(적용이 아닌 행). 표의 '테스트 결과' 칸은 손으로 고치지 않고 이 리포트로 본다.
// 종료 코드: 0, 1(실패한 태그 시험이 있다, --strict면 문서 표에 없는 ID의 태그도), 2(인자·보고서가 틀림).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ReportError, readReport } from './test-reports.mjs';

class UsageError extends Error {}

/** 태그: 정본 꼴은 `[ASVS v5.0.0-x.y.z]`. 대괄호 없는 `ASVS v5.0.0-…`·`ASVS-v5.0.0-…`도 읽되 꼴이 다르다고 알린다(재검토 2026-11-05) */
const TAG = /\[?ASVS[ -](v5\.0\.0-\d+\.\d+\.\d+)\]?/g;
const CANONICAL = /^\[ASVS v5\.0\.0-\d+\.\d+\.\d+\]$/;
const ROW = /^\| (v5\.0\.0-\d+\.\d+\.\d+) \| (L\d) \|/;
/** 시험 파일과 시험이 읽는 사례 파일(`*-cases.*`) */
const TEST_FILE = /(\.(test|spec)|-cases)\.(m?[jt]sx?|cjs)$/;
/** 이 표시가 첫 줄에 있는 tools/ci 아래 파일은 훑지 않는다(도구 자신의 시험 자료. 다른 곳의 시험 파일은 이 표시로 빠지지 않는다) */
const IGNORE = /^\/\/ asvs-report: ignore/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage', '.git']);

/** ASVS 추적 표의 행: { doc, id, level, applied }. 적용 여부는 넷째 칸 */
export function readAsvsDocs(dir) {
  const rows = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split(/\r?\n/)) {
      const m = ROW.exec(line);
      if (!m) continue;
      const cells = line.split('|').map((c) => c.trim());
      // 운영 설계로만 있는 행은 '구현 위치' 칸 끝에 '(운영 설계만)'으로 표시돼 있다(ADR-0057, §8.2 4번)
      rows.push({ doc: f, id: m[1], level: m[2], applied: cells[4] ?? '', designOnly: (cells[5] ?? '').includes('(운영 설계만)') });
    }
  }
  return rows;
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (TEST_FILE.test(e.name)) yield p;
  }
}

/** 원본의 시험 파일에서 ID별 태그 수(실행하지 않아도 달린 시험). loose에 꼴이 다른 태그를 { file, tag }로 모은다 */
export function scanTaggedSources(dirs, loose = []) {
  const count = new Map();
  for (const d of dirs) {
    if (!statSync(d, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`--scan 폴더가 없다: ${d}`);
    for (const f of walk(d)) {
      const text = readFileSync(f, 'utf8');
      if (IGNORE.test(text) && /(^|[\\/])tools[\\/]ci[\\/]/.test(f)) continue;
      for (const m of text.matchAll(TAG)) {
        count.set(m[1], (count.get(m[1]) ?? 0) + 1);
        if (!CANONICAL.test(m[0])) loose.push({ file: f, tag: m[0] });
      }
    }
  }
  return count;
}

/** 적용 여부: '적용'·'부분 적용'(재검토 2026-11-05) */
const isApplied = (s) => /^(부분 )?적용/.test(s);

/** 리포트를 만든다 */
export function buildReport({ docsDir, reports = [], scan = [] }) {
  const rows = readAsvsDocs(docsDir);
  const tests = reports.flatMap(readReport);
  const ran = new Map();
  const loose = new Set();
  for (const t of tests) for (const m of t.name.matchAll(TAG)) {
    if (!CANONICAL.test(m[0])) loose.add(t.name);
    const r = ran.get(m[1]) ?? { passed: 0, failed: 0, skipped: 0, failedNames: [] };
    r[t.status]++;
    if (t.status === 'failed') r.failedNames.push(t.name);
    ran.set(m[1], r);
  }
  const looseSources = [];
  const tagged = scanTaggedSources(scan, looseSources);
  const known = new Set(rows.map((r) => r.id));
  const out = rows.map((row) => {
    const r = ran.get(row.id);
    let result;
    if (!isApplied(row.applied)) result = '—';
    // 운영·스테이징 설계로만 있는 행: 시험이 통과해도 통과로 세지 않고 따로 센다(§8.2 4번)
    else if (row.designOnly) result = '설계 검사';
    else if (r?.failed) result = '실패';
    else if (r?.passed) result = '통과';
    else if (tagged.get(row.id) || r) result = '미실행';
    else result = '태그 없음';
    return { ...row, result, passed: r?.passed ?? 0, failed: r?.failed ?? 0, tagged: tagged.get(row.id) ?? 0 };
  });
  const count = (x) => out.filter((r) => r.result === x).length;
  return {
    rows: out,
    failed: [...new Set([...ran.values()].flatMap((r) => r.failedNames))].sort(),
    unknownIds: [...new Set([...ran.keys(), ...tagged.keys()])].filter((id) => !known.has(id)).sort(),
    looseTags: [...loose].sort(),
    looseSources,
    totals: { rows: out.length, applied: out.filter((r) => isApplied(r.applied)).length, passed: count('통과'), failed: count('실패'), notRun: count('미실행'), untagged: count('태그 없음'), designCheck: count('설계 검사') },
  };
}

/** GitHub 작업 요약에 쓰는 markdown */
export function summaryMarkdown(r) {
  const t = r.totals;
  const lines = [
    '## ASVS 추적 시험 태그',
    '',
    `표 ${t.rows}행 가운데 적용 ${t.applied}행: 통과 ${t.passed}, 실패 ${t.failed}, 미실행 ${t.notRun}, 태그 없음 ${t.untagged}, 설계 검사 ${t.designCheck}(통과로 세지 않는다)`,
    '',
    '| 문서 | 적용 | 통과 | 실패 | 미실행 | 태그 없음 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const doc of [...new Set(r.rows.map((x) => x.doc))]) {
    const d = r.rows.filter((x) => x.doc === doc);
    const n = (k) => d.filter((x) => x.result === k).length;
    lines.push(`| ${basename(doc)} | ${d.filter((x) => isApplied(x.applied)).length} | ${n('통과')} | ${n('실패')} | ${n('미실행')} | ${n('태그 없음')} |`);
  }
  if (r.failed.length) lines.push('', '### 실패한 태그 시험', '', ...r.failed.map((n) => `- ${n}`));
  if (r.unknownIds.length) lines.push('', '### 문서 표에 없는 ID의 태그', '', ...r.unknownIds.map((n) => `- ${n}`));
  if (r.looseTags.length || r.looseSources.length) lines.push('', '### 꼴이 다른 태그(정본은 `[ASVS v5.0.0-x.y.z]`)', '', ...r.looseTags.map((n) => `- ${n}`), ...r.looseSources.map((x) => `- ${x.file}: ${x.tag}`));
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const o = { docsDir: 'docs/security/asvs', reports: [], scan: [], summary: null, json: null, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') {
      o.strict = true;
      continue;
    }
    const v = argv[i + 1];
    if (!['--docs', '--report', '--scan', '--summary', '--json'].includes(a)) throw new UsageError(`모르는 인자: ${a}`);
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${a}에 값이 없다`);
    i++;
    if (a === '--docs') o.docsDir = v;
    else if (a === '--report') o.reports.push(v);
    else if (a === '--scan') o.scan.push(v);
    else if (a === '--summary') o.summary = v;
    else o.json = v;
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const r = buildReport(o);
  const md = summaryMarkdown(r);
  if (o.summary) writeFileSync(o.summary, md, { flag: 'a' });
  else process.stdout.write(md);
  if (o.json) writeFileSync(o.json, `${JSON.stringify(r, null, 2)}\n`);
  return r.failed.length || (o.strict && r.unknownIds.length) ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main();
  } catch (e) {
    process.stderr.write(`asvs-report: ${e instanceof UsageError || e instanceof ReportError ? e.message : e?.message ?? e}\n`);
    process.exitCode = 2;
  }
}
