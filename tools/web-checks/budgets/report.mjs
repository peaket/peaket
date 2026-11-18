// 성능 예산 기록(reports/sizes-js/*.json은 js.spec.mjs, reports/lighthouse/*.json은 lighthouse.spec.mjs가 남긴다)을
// Markdown 표 둘로 표준 출력에 낸다(BUILD_ORDER BAS-220, docs/frontend.md §5.8). CSS 열의 표는 seed-css/report.mjs다.
//   node budgets/report.mjs [--reports <폴더>]   기본 폴더는 이 패키지의 reports/
// 기록이 하나도 없으면(두 폴더 다 없거나 비었다) 멈춘다(종료 코드 2). 한쪽만 있으면 다른 쪽은 '기록이 없다'로 적는다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** 표 칸 글. 세로 막대는 표를 깨므로 이스케이프한다 */
const cell = (v) => String(v).replaceAll('|', '\\|');
const row = (cells) => `| ${cells.map(cell).join(' | ')} |`;
const sep = (n) => `| ${Array.from({ length: n }, () => '---').join(' | ')} |`;
const plus = (a, b) => `+${(Math.round((a - b) * 10) / 10).toFixed(1)}`;

/**
 * 첫 JS 표. 판정: 한도(예산이나 기준선 + 여유)를 넘으면 '한도 초과', 예산만 넘었으면 '예산 초과, 기준선 한도 안', 아니면 '예산 안'
 * @param {{ key: string, row: string, kB: number, budget: number, limit: number }[]} records
 */
export function jsTable(records) {
  const head = ['앱·경로', '§5.8 경로 묶음', '첫 JS(gzip, kB)', '예산(kB)', '한도(kB)', '판정'];
  const rows = [...records]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((r) => {
      const verdict = r.kB > r.limit ? `한도 초과(${plus(r.kB, r.limit)})` : r.kB > r.budget ? `예산 초과(${plus(r.kB, r.budget)}), 기준선 한도 안` : '예산 안';
      return row([r.key, r.row, r.kB, r.budget, r.limit, verdict]);
    });
  return [row(head), sep(head.length), ...rows];
}

const METRICS = [
  ['lcpMs', 'LCP', (v) => String(Math.round(v))],
  ['cls', 'CLS', (v) => v.toFixed(3)],
  ['tbtMs', '총 차단 시간', (v) => String(Math.round(v))],
];

/**
 * 지표 하나의 판정. 기록에 판정 칸(verdict, lighthouse.spec.mjs가 limits.mjs loadVerdict로 정한 값)이 있으면 그것을, 없는 옛 기록은 값과 한도로 정한다
 * @param {{ median: Record<string, number>, limit: Record<string, number>, verdict?: Record<string, string> }} r
 * @param {string} k
 */
const metricVerdict = (r, k) => r.verdict?.[k] ?? (r.median[k] > r.limit[k] ? 'fail' : 'pass');

/** 알림만 지표 글: 'LCP(까닭)'. 까닭은 기록의 warnOnly 항목(limits.mjs WARN_ONLY)에서 가져온다(BAT-176, OPEN[52]) */
function warnText(r, k, ko) {
  const w = r.warnOnly?.find((e) => e.metric === k);
  if (w?.reason) return `${ko}(${w.reason})`;
  return w?.until ? `${ko}(되돌릴 날 ${w.until})` : ko;
}

/**
 * Lighthouse 표. 지표마다 가운데 값 / 한도(목표, 목표를 넘은 주소는 기준선 + 여유)를 적고, 넘은 지표를 판정에 적는다.
 * 한도를 넘었지만 임시로 알림만 내는 지표(limits.mjs WARN_ONLY, docs/frontend.md §5.8 OPEN[52], BAT-176)는 '알림만'으로 따로 적는다. 한도 값은 그대로 보인다
 * @param {{ name: string, row: string, median: Record<string, number>, limit: Record<string, number>, verdict?: Record<string, 'pass' | 'warn' | 'fail'>, warnOnly?: { metric: string, until: string, reason: string }[] }[]} records
 */
export function lighthouseTable(records) {
  const head = ['화면', '§5.8 경로 묶음', 'LCP 가운데 / 한도(ms)', 'CLS 가운데 / 한도', '총 차단 시간 가운데 / 한도(ms)', '판정'];
  const rows = [...records]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => {
      const over = METRICS.filter(([k]) => metricVerdict(r, k) === 'fail').map(([, ko]) => ko);
      const warn = METRICS.filter(([k]) => metricVerdict(r, k) === 'warn').map(([k, ko]) => warnText(r, k, ko));
      const cells = METRICS.map(([k, , fmt]) => `${fmt(r.median[k])} / ${r.limit[k]}`);
      const parts = [...(over.length ? [`한도 초과: ${over.join('·')}`] : []), ...(warn.length ? [`알림만: ${warn.join('·')}`] : [])];
      return row([r.name, r.row, ...cells, parts.length ? parts.join('; ') : '한도 안']);
    });
  return [row(head), sep(head.length), ...rows];
}

/** 폴더의 *.json 기록. 폴더가 없으면 null */
function readRecords(dir) {
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

/** 표 둘을 이은 Markdown(끝 줄바꿈 없음) */
export function renderReport({ js, lighthouse }) {
  const out = ['### 첫 JS(§5.8 첫 JS 열)', ''];
  out.push(...(js?.length ? jsTable(js) : ['(첫 JS 기록이 없다: reports/sizes-js/)']));
  out.push('', '### Lighthouse(§5.8 체감 목표, 가운데 값)', '');
  out.push(...(lighthouse?.length ? lighthouseTable(lighthouse) : ['(Lighthouse 기록이 없다: reports/lighthouse/)']));
  return out.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { reports: { type: 'string', default: fileURLToPath(new URL('../reports/', import.meta.url)) } } });
  const js = readRecords(join(values.reports, 'sizes-js'));
  const lighthouse = readRecords(join(values.reports, 'lighthouse'));
  if (!js?.length && !lighthouse?.length) {
    console.error(`기록이 없다(${join(values.reports, 'sizes-js')}·${join(values.reports, 'lighthouse')}): 먼저 playwright test -c playwright.budgets.config.mjs`);
    process.exit(2);
  }
  console.log(renderReport({ js, lighthouse }));
}
