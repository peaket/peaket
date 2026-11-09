#!/usr/bin/env node
// 공용 기록 표 맞추기(ADR-0190 결정 3). 단계마다 기록은 한 번만 쓴다:
//   - BUILD_ORDER의 체크, 진행 로그 한 줄, 커밋 메시지 본문의 '정합 점검: | R-NNN | … |' 행(과 고를 때 '변경 요약: …' 줄)
// 이 스크립트가 그것으로 네 파일을 맞춘다. 고치는 쪽은 갈래 1(루프) 하나뿐이라 갈래 셋이 같은 파일을 고치지 않는다.
//   - docs/review/consistency-review.md: 없는 R 행을 마지막 R 행 뒤에 번호 차례로 넣는다
//   - docs/00-summary.md §4: 없는 R 번호의 줄을 §4 끝에 넣는다(요약 줄이 없으면 문제 → 방법 칸으로 만든다)
//   - docs/wbs/wbs.csv·wbs.md 상태 칸: BUILD_ORDER 단계 머리의 wbs ID로 예정 → 진행 → 완료로 올리기만 한다
// 쓰는 법: node tools/ci/records.mjs [--check] [--next-r] [--rev <리비전>] [--root <저장소>]
//   --check  고칠 것이 있으면 알리고 1로 끝난다(파일은 고치지 않는다)
//   --next-r 다음 R 번호를 찍는다(정합 점검 표와 커밋 기록 가운데 큰 번호 + 1)
// 끝 코드: 0 맞음(또는 고침), 1 --check에서 고칠 것 있음, 2 읽기·실행 오류(아무것도 고치지 않는다)
// 지난 커밋의 잘못된 행이나 겹친 번호는 경고하고 건너뛴다. develop 기록은 고칠 수 없어서, 오류로 멈추면 영구히 막히기 때문이다.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROW_PREFIX = '정합 점검: ';
const SUMMARY_PREFIX = '변경 요약: ';
const R_ROW = /^\| (R-(\d+)) \|/;
const RANK = { 예정: 0, 진행: 1, 완료: 2 };
const TASK_TABLE_HEADER = '| WBS ID | 작업 | 산출물 | 담당 | 추정(일) | 선행 | 관련 ID | 상태 |';
export const LOG_FORMAT = '--format=%H%x1f%h%x1f%cs%x1f%s%x1f%b%x1e';

// 표 행의 칸. '\|'와 코드 표시(`…`) 속 '|'는 칸 안의 글자다(문서 점검 check_all.py와 같은 셈)
function cells(row) {
  const out = [];
  let cur = '';
  let code = false;
  const s = row.trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (ch === '`' && (code || s.indexOf('`', i + 1) >= 0)) {
      // 닫는 백틱이 있을 때만 코드 표시로 본다(짝 없는 백틱 하나는 글자)
      code = !code;
      cur += ch;
    } else if (ch === '|' && !code) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.slice(1, -1).map((c) => c.trim());
}

// LOG_FORMAT으로 찍은 git log를 읽는다. 되돌린 커밋의 기록은 뺀다. 잘못된 행과 같은 번호의 다른 행은 warn으로 알린다
export function parseRecords(logText, warn = () => {}) {
  const entries = [];
  for (const entry of logText.split('\x1e')) {
    const e = entry.replace(/^\n+/, '');
    if (!e.trim()) continue;
    const [full, hash, date, subject, body = ''] = e.split('\x1f');
    entries.push({ full, hash, date, subject, body });
  }
  // git log는 새것부터 찍는다. 오래된 것부터 읽어 같은 번호에서는 먼저 쓴 커밋이 앞선다
  const oldest = entries.reverse();
  // 되돌림을 차례대로 따라간다: 되돌림을 다시 되돌리면 처음 커밋이 살아난다
  const revertOf = new Map();
  const reverted = new Set();
  for (const { full, body } of oldest) {
    const m = /This reverts commit ([0-9a-f]{40})/.exec(body);
    if (!m) continue;
    revertOf.set(full, m[1]);
    reverted.add(m[1]);
    if (revertOf.has(m[1])) reverted.delete(revertOf.get(m[1]));
  }
  const byR = new Map();
  const out = [];
  for (const { full, hash, date, subject, body } of oldest) {
    if (reverted.has(full)) continue;
    const rows = [];
    const summaries = [];
    for (const raw of body.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith(ROW_PREFIX)) {
        const row = line.slice(ROW_PREFIX.length).trim();
        if (!row.startsWith('|')) continue;
        const m = R_ROW.exec(row);
        if (!m || cells(row).length !== 5 || !row.endsWith('|')) {
          const r = /R-\d+/.exec(row)?.[0] ?? '?';
          warn(`${r}: 정합 점검 행의 칸이 다섯(번호·문제·고친 곳·방법·상태)이 아니라 건너뛴다(커밋 ${hash})`);
          continue;
        }
        rows.push({ r: m[1], num: Number(m[2]), row });
      } else if (line.startsWith(SUMMARY_PREFIX)) {
        summaries.push(line.slice(SUMMARY_PREFIX.length).trim());
      }
    }
    for (const rec of rows) {
      const own = summaries.find((s) => new RegExp(`\\b${rec.r}\\b`).test(s));
      const summary = own ?? (rows.length === 1 && summaries.length === 1 ? summaries[0] : null);
      const seen = byR.get(rec.r) ?? [];
      if (seen.some((p) => p.row === rec.row)) continue;
      if (seen.length) {
        warn(`${rec.r}: 커밋 ${seen[0].commit}과 ${hash}가 다른 정합 점검 행을 쓴다. 표에는 먼저 것만 넣으니, 뒤의 것은 다음 번호(--next-r)로 손으로 넣는다`);
      }
      const full = { ...rec, summary, date, commit: hash, subject };
      seen.push(full);
      byR.set(rec.r, seen);
      out.push(full);
    }
  }
  return out.sort((a, b) => a.num - b.num);
}

// 없는 R 행을 마지막 R 행 뒤에 넣는다. 같은 행이 있거나, 같은 문제 칸이 이미 있으면(상태 칸을 고쳤거나 번호를 옮겼으면) 넣지 않는다.
// 번호만 같고 다른 행이 이미 있으면 넣지 않고 warn으로 알린다.
// accepted: 표에 그 번호로 들어 있거나 이번에 넣은 기록(요약 §4는 이것만 쓴다. 겹친 번호나 번호를 옮긴 기록은 빠진다)
export function applyReview(text, records, warn = () => {}) {
  const lines = text.split('\n');
  const rowsByR = new Map();
  const problemR = new Map();
  const rows = new Set();
  let last = -1;
  lines.forEach((l, i) => {
    const m = R_ROW.exec(l);
    if (m) {
      rowsByR.set(m[1], l);
      rows.add(l.trim());
      problemR.set(cells(l)[1], m[1]);
      last = i;
    }
  });
  if (last < 0) throw new Error('docs/review/consistency-review.md에서 R 행을 찾지 못했다');
  const add = [];
  const accepted = [];
  for (const rec of [...records].sort((a, b) => a.num - b.num)) {
    const problem = cells(rec.row)[1];
    if (rows.has(rec.row) || problemR.has(problem)) {
      if (rows.has(rec.row) || problemR.get(problem) === rec.r) accepted.push(rec);
      continue;
    }
    if (rowsByR.has(rec.r)) {
      warn(`${rec.r}: 표에 같은 번호가 다른 행으로 있어 넣지 않았다(커밋 ${rec.commit}). 다음 번호(--next-r)로 손으로 넣는다`);
      continue;
    }
    add.push(rec);
    accepted.push(rec);
    rowsByR.set(rec.r, rec.row);
    rows.add(rec.row);
    problemR.set(problem, rec.r);
  }
  if (!add.length) return { text, added: [], accepted };
  lines.splice(last + 1, 0, ...add.map((r) => r.row));
  return { text: lines.join('\n'), added: add.map((r) => r.r), accepted };
}

export function applySummary(text, records) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## 4\. 변경 요약/.test(l));
  if (start < 0) throw new Error('docs/00-summary.md에서 "## 4. 변경 요약"을 찾지 못했다');
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const have = new Set();
  for (let i = start; i < end; i++) for (const m of lines[i].matchAll(/\bR-(\d+)\b/g)) have.add(`R-${m[1]}`);
  const add = [];
  for (const r of [...records].sort((a, b) => a.num - b.num)) {
    if (have.has(r.r)) continue;
    have.add(r.r);
    add.push(r);
  }
  if (!add.length) return { text, added: [] };
  let at = end - 1;
  while (at > start && !lines[at].trim()) at--;
  const bullets = add.map((r) => {
    if (r.summary) return `- ${r.summary}`;
    const c = cells(r.row);
    return `- ${r.r}(${r.date}, 커밋 ${r.commit}): ${c[1]} → ${c[3]}`;
  });
  lines.splice(at + 1, 0, ...bullets);
  return { text: lines.join('\n'), added: add.map((r) => r.r) };
}

// BUILD_ORDER 단계 머리('- [ ] PRF-135 wbs 2.5.1 ②:')의 wbs ID마다 끝낸 줄 수·전체 줄 수
export function wbsCounts(buildOrderText) {
  const counts = new Map();
  for (const line of buildOrderText.split('\n')) {
    const m = /^- \[( |x)\] [A-Z]{3}-\d{3} wbs ([^:]*):/.exec(line);
    if (!m) continue;
    for (const id of m[2].match(/\d+\.\d+\.\d+/g) ?? []) {
      const c = counts.get(id) ?? { done: 0, total: 0 };
      c.total += 1;
      if (m[1] === 'x') c.done += 1;
      counts.set(id, c);
    }
  }
  return counts;
}

function target(c) {
  if (!c) return null;
  if (c.done === c.total) return '완료';
  if (c.done > 0) return '진행';
  return null;
}

function raise(id, current, counts) {
  const t = target(counts.get(id));
  if (!t || !(current in RANK) || RANK[t] <= RANK[current]) return null;
  return t;
}

// CSV 한 줄의 칸 자리(따옴표 안의 쉼표는 칸을 나누지 않는다)
function csvSpans(line) {
  const spans = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i <= line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if ((ch === ',' && !quoted) || i === line.length) {
      spans.push([start, i]);
      start = i + 1;
    }
  }
  if (quoted) throw new Error(`wbs.csv 줄의 따옴표가 닫히지 않았다: ${line.slice(0, 60)}`);
  return spans;
}

function csvValue(line, [a, b]) {
  const raw = line.slice(a, b);
  return raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw;
}

export function applyWbsCsv(text, counts) {
  const lines = text.split('\n');
  const header = csvSpans(lines[0]).map((s) => csvValue(lines[0], s));
  const si = header.indexOf('상태');
  if (si < 0) throw new Error('wbs.csv 머리에 상태 칸이 없다');
  const changed = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const spans = csvSpans(lines[i]);
    const id = csvValue(lines[i], spans[0]);
    const cur = csvValue(lines[i], spans[si]);
    const t = raise(id, cur, counts);
    if (!t) continue;
    const [a, b] = spans[si];
    lines[i] = lines[i].slice(0, a) + t + lines[i].slice(b);
    changed.push(`${id} ${cur}→${t}`);
  }
  return { text: lines.join('\n'), changed };
}

export function applyWbsMd(text, counts) {
  const lines = text.split('\n');
  const changed = [];
  let inTasks = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimEnd() === TASK_TABLE_HEADER) {
      inTasks = true;
      continue;
    }
    if (!line.startsWith('|')) {
      inTasks = false;
      continue;
    }
    const m = /^\| (\d+\.\d+\.\d+) \|/.exec(line);
    if (!inTasks || !m) continue;
    const body = line.trimEnd();
    const pipes = [...body.matchAll(/(?<!\\)\|/g)].map((x) => x.index);
    const [a, b] = pipes.slice(-2);
    const cur = body.slice(a + 1, b).trim();
    const t = raise(m[1], cur, counts);
    if (!t) continue;
    lines[i] = `${body.slice(0, a + 1)} ${t} ${body.slice(b)}`;
    changed.push(`${m[1]} ${cur}→${t}`);
  }
  return { text: lines.join('\n'), changed };
}

export function nextR(reviewText, records) {
  let max = 0;
  for (const m of reviewText.matchAll(/^\| R-(\d+) \|/gm)) max = Math.max(max, Number(m[1]));
  for (const r of records) max = Math.max(max, r.num);
  return `R-${max + 1}`;
}

// ---------- 명령줄 ----------
const FILES = {
  review: 'docs/review/consistency-review.md',
  summary: 'docs/00-summary.md',
  build: 'docs/BUILD_ORDER.md',
  csv: 'docs/wbs/wbs.csv',
  md: 'docs/wbs/wbs.md',
};

function main(argv) {
  const opt = { check: false, nextR: false, rev: 'HEAD', root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') opt.check = true;
    else if (argv[i] === '--next-r') opt.nextR = true;
    else if (argv[i] === '--rev') opt.rev = argv[++i];
    else if (argv[i] === '--root') opt.root = argv[++i];
    else {
      process.stderr.write(`모르는 인자: ${argv[i]}\n`);
      return 2;
    }
  }
  const read = (k) => readFileSync(join(opt.root, FILES[k]), 'utf8').replaceAll('\r\n', '\n');
  const gitLog = (...refs) => {
    const r = spawnSync('git', ['log', LOG_FORMAT, ...refs], { cwd: opt.root, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`git log 실패: ${r.stderr}`);
    return r.stdout;
  };
  const warn = (w) => process.stderr.write(`경고: ${w}\n`);
  const texts = Object.fromEntries(Object.keys(FILES).map((k) => [k, read(k)]));
  if (opt.nextR) {
    // 번호는 다른 갈래의 작업 가지까지 보고 고른다(아직 develop에 합치지 않은 커밋과 겹치지 않게)
    process.stdout.write(`${nextR(texts.review, parseRecords(gitLog('--branches', opt.rev)))}\n`);
    return 0;
  }
  // 표에 넣는 것은 지금 리비전에서 닿는 커밋의 기록뿐이다(합치지 않은 작업 가지의 기록은 넣지 않는다)
  const records = parseRecords(gitLog(opt.rev), warn);
  const counts = wbsCounts(texts.build);
  const review = applyReview(texts.review, records, warn);
  const summary = applySummary(texts.summary, review.accepted);
  const csv = applyWbsCsv(texts.csv, counts);
  const md = applyWbsMd(texts.md, counts);
  const report = [
    ...review.added.map((r) => `${FILES.review}: ${r} 행을 더한다`),
    ...summary.added.map((r) => `${FILES.summary} §4: ${r} 줄을 더한다`),
    ...csv.changed.map((c) => `${FILES.csv}: ${c}`),
    ...md.changed.map((c) => `${FILES.md}: ${c}`),
  ];
  if (!report.length) {
    process.stdout.write('기록 표가 맞다\n');
    return 0;
  }
  process.stdout.write(`${report.join('\n')}\n`);
  if (opt.check) return 1;
  const out = { review: review.text, summary: summary.text, csv: csv.text, md: md.text };
  for (const [k, t] of Object.entries(out)) if (t !== texts[k]) writeFileSync(join(opt.root, FILES[k]), t);
  return 0;
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
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 2;
  }
}
