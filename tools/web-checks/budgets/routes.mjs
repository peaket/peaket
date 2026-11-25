// 경로별 번들 예산 표(F-08-1, docs/frontend.md §5.8, apps/web/src/_app/security/page-headers.ts의 ROUTES).
// 소비자 웹의 화면 경로를 빠짐없이 §5.8의 경로 묶음 행에 매긴다. 새 화면 경로가 생겼는데 여기 매핑이 없으면 시험이 멈춘다.
// 처리기 경로(handler, HTML이 아니다)는 HTML 첫 JS 예산 대상이 아니라 표에서 뺀다. 숫자는 정본 표에서 읽는다(lib/canon.mjs).
//   node budgets/routes.mjs   → 경로 → 행·첫 JS·CSS·Worker 예산 표를 표준 출력에 낸다
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCssBudgets, loadJsBudgets, loadWorkerBudgets, repoRoot } from '../lib/canon.mjs';

/** 경로 원천 파일(정본은 apps/web/src/_app/security/page-headers.ts의 ROUTES. 그 파일의 시험이 app/ 폴더와 대조한다) */
export const ROUTE_SOURCE = join(repoRoot, 'apps/web/src/_app/security/page-headers.ts');

/** 행 이름(§5.8 표의 '경로 묶음' 칸과 같은 글) */
export const ROWS = {
  ISR: '홈·공연 상세·굿즈(ISR)',
  SEAT: '좌석 화면',
  CHECKOUT: '결제 화면',
  WALLET: '월렛',
  OTHER: '그 밖 소비자 화면',
};

/**
 * 화면 경로 → §5.8 행. 한 경로도 빠뜨리지 않는다(원천의 화면 경로 45개, 2026-11-25).
 * 판단 규칙: 굿즈·공연 상세·홈은 ISR, 좌석 화면은 좌석, 결제·결제 결과·굿즈 결제는 결제, 월렛 셸(티켓 상세 포함)은 월렛, 나머지는 그 밖.
 */
const TABLE = {
  '/': ROWS.ISR,
  '/~offline': ROWS.OTHER,
  '/booking/[eventId]/checkout/return': ROWS.CHECKOUT,
  '/events/[id]': ROWS.ISR,
  '/[locale]/events/[id]': ROWS.ISR,
  '/events/[id]/shuffle-proof': ROWS.OTHER,
  '/help': ROWS.OTHER,
  '/my/tickets': ROWS.WALLET,
  '/my/tickets/[ticketId]': ROWS.WALLET,
  '/open-in-browser': ROWS.OTHER,
  '/policy/[slug]': ROWS.OTHER,
  '/preview': ROWS.OTHER,
  '/search': ROWS.OTHER,
  '/shop': ROWS.ISR,
  '/shop/[productId]': ROWS.ISR,
  '/staff/approve': ROWS.OTHER,
  '/staff/invitations': ROWS.OTHER,
  '/system-notice': ROWS.OTHER,
  '/verify/return': ROWS.OTHER,
  '/booking/[eventId]/checkout': ROWS.CHECKOUT,
  '/booking/[eventId]/result': ROWS.CHECKOUT,
  '/booking/[eventId]/seats': ROWS.SEAT,
  '/help/inquiries': ROWS.OTHER,
  '/help/inquiries/[id]': ROWS.OTHER,
  '/help/inquiries/new': ROWS.OTHER,
  '/login': ROWS.OTHER,
  '/[locale]/login': ROWS.OTHER,
  '/login/link': ROWS.OTHER,
  '/my/appeals/[id]': ROWS.OTHER,
  '/my/compensations/[id]': ROWS.OTHER,
  '/my/likes': ROWS.OTHER,
  '/my/orders': ROWS.OTHER,
  '/my/orders/[orderId]': ROWS.OTHER,
  '/my/refunds/[refundId]/account': ROWS.OTHER,
  '/my/settings': ROWS.OTHER,
  '/my/settings/providers': ROWS.OTHER,
  '/my/tickets/[ticketId]/addons': ROWS.OTHER,
  '/my/tickets/[ticketId]/cancel': ROWS.OTHER,
  '/my/tickets/[ticketId]/transfer': ROWS.OTHER,
  '/my/transfers/[offerId]': ROWS.OTHER,
  '/queue/[eventId]/verify': ROWS.OTHER,
  '/shop/cart': ROWS.OTHER,
  '/shop/checkout': ROWS.CHECKOUT,
  '/signup/consent': ROWS.OTHER,
  '/staff': ROWS.OTHER,
};

/**
 * 경로 원천에서 화면·처리기를 읽는다. `cached(...)`·`req(...)`는 화면, `handler(...)`는 처리기다.
 * @param {string} src
 * @returns {{kind: 'page' | 'handler', pattern: string}[]}
 */
export function parseRouteSource(src) {
  if (typeof src !== 'string') throw new TypeError('경로 원천이 글자가 아니다');
  const out = [];
  for (const m of src.matchAll(/^\s*(cached|req|handler)\(\s*'([^']+)'/gm)) {
    out.push({ kind: m[1] === 'handler' ? 'handler' : 'page', pattern: m[2] });
  }
  if (out.length === 0) throw new Error('경로 원천에서 ROUTES 항목을 읽지 못했다');
  return out;
}

/**
 * 화면 경로 하나를 §5.8 행으로. 표에 없으면 멈춘다(새 경로를 예산 없이 들이지 않는다).
 * @param {string} pattern
 */
export function routeRow(pattern) {
  const row = TABLE[pattern];
  if (!row) throw new Error(`경로 ${pattern}에 §5.8 예산 행이 없다. budgets/routes.mjs의 TABLE에 행을 매기고, 필요하면 정본에 행을 더한다`);
  return row;
}

/**
 * 화면 경로마다 §5.8 행과 예산을 붙인 표. 처리기는 뺀다.
 * @param {{source?: string}} [opts] source를 주면 그 글에서 읽는다(시험용)
 */
export function routeBudgetTable({ source } = {}) {
  const src = source ?? readFileSync(ROUTE_SOURCE, 'utf8');
  const js = loadJsBudgets();
  const css = loadCssBudgets();
  const worker = loadWorkerBudgets();
  const out = [];
  for (const e of parseRouteSource(src)) {
    if (e.kind !== 'page') continue;
    const row = routeRow(e.pattern);
    const jsKB = js.get(row);
    const cssKB = css.get(row);
    if (jsKB === undefined) throw new Error(`§5.8 첫 JS 열에 '${row}' 행이 없다`);
    if (cssKB === undefined) throw new Error(`§5.8 CSS 열에 '${row}' 행이 없다`);
    out.push({ kind: 'page', pattern: e.pattern, row, jsKB, cssKB, ...(worker.has(row) ? { workerKB: worker.get(row) } : {}) });
  }
  return out;
}

/**
 * 원천의 화면 경로 가운데 표에 없는 것. 표를 손으로 줄였거나 새 경로를 더했을 때 시험이 이 목록으로 실패한다.
 * @param {{kind: string, pattern: string}[]} entries
 * @param {{pattern: string}[]} table
 */
export function missingRouteRows(entries, table) {
  const have = new Set(table.map((r) => r.pattern));
  return entries.filter((e) => e.kind === 'page' && !have.has(e.pattern)).map((e) => e.pattern);
}

/** 표를 Markdown으로(보고서·터미널). Worker 예산이 없는 행은 '-' */
export function renderRouteTable(table) {
  const head = ['경로', '§5.8 행', '첫 JS(kB)', 'CSS(kB)', 'Worker(kB)'];
  const rows = [...table]
    .sort((a, b) => a.pattern.localeCompare(b.pattern))
    .map((r) => `| ${r.pattern} | ${r.row} | ${r.jsKB} | ${r.cssKB} | ${r.workerKB ?? '-'} |`);
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(renderRouteTable(routeBudgetTable()));
}
