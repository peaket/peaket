#!/usr/bin/env node
// 정본 ID 대조(docs/architecture.md §8.6의 5단계 '대조', ADR-0178 결정 4).
// 이번 단계의 범위 목록에 적은 시험 ID(예: J-T25, FR-073, ASVS v5.0.0-1.2.4)마다 이름에 그 ID를 단 시험이 통과했는지 시험 보고서로 본다.
//   node tools/ci/trace-check.mjs --ids "J-T25,P-T39" --report a.json [--report b.xml …]
// 보고서: vitest JSON·JUnit XML(읽기는 test-reports.mjs).
// 종료 코드: 0 모두 통과, 1 통과한 시험이 없는 ID가 있음, 2 인자·보고서가 틀림.
import { ReportError, readReport } from './test-reports.mjs';

class UsageError extends Error {}

function parseArgs(argv) {
  const ids = [];
  const reports = [];
  let sawIds = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--ids' || a === '--report') {
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a}에 값이 없다`);
      i++;
      if (a === '--ids') {
        sawIds = true;
        ids.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
      } else reports.push(v);
    } else throw new UsageError(`모르는 인자: ${a}`);
  }
  if (!sawIds || ids.length === 0) throw new UsageError('--ids "<ID,ID,…>"가 필요하다');
  if (reports.length === 0) throw new UsageError('--report <보고서>가 하나 이상 필요하다');
  return { ids: [...new Set(ids)], reports };
}

/** ID가 시험 이름에 들어 있는지. 'X-T12'·'FR-073' 꼴은 가운데 '-'를 빼고 적어도 맞는다(FR073_…). 앞뒤 경계를 본다 */
function idPattern(id) {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = /^[A-Z]+-[A-Z]*\d+$/.test(id) ? esc.replace('-', '-?') : esc;
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![0-9])(?!\\.[0-9])`);
}

function main() {
  const { ids, reports } = parseArgs(process.argv.slice(2));
  const tests = reports.flatMap(readReport);
  let missing = 0;
  for (const id of ids) {
    const re = idPattern(id);
    const hits = tests.filter((t) => re.test(t.name));
    const n = (s) => hits.filter((t) => t.status === s).length;
    if (n('passed') > 0) {
      process.stdout.write(`${id} 통과 ${n('passed')}\n`);
      continue;
    }
    missing++;
    if (hits.length === 0) process.stdout.write(`${id} 시험 없음\n`);
    else process.stdout.write(`${id}${n('failed') ? ` 실패 ${n('failed')}` : ''}${n('skipped') ? ` 건너뜀 ${n('skipped')}` : ''}\n`);
  }
  process.stdout.write(missing ? `대조 실패: 통과한 시험이 없는 ID ${missing}개(시험 ${tests.length}개를 봄)\n` : `대조 통과: ID ${ids.length}개(시험 ${tests.length}개를 봄)\n`);
  return missing ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (e) {
  process.stderr.write(`trace-check: ${e instanceof UsageError || e instanceof ReportError ? e.message : e?.message ?? e}\n`);
  process.exitCode = 2;
}
