// 경로별 번들 예산 표 시험(F-08-1, docs/frontend.md §5.8·FE-T25, apps/web/src/_app/security/page-headers.ts).
// 단언 값은 정본 표에서 읽은 값과 경로 원천 파일의 실제 개수다. 구현 전 기준 트리에서는 budgets/routes.mjs가 없어 실패한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadJsBudgets, loadLabRuns, loadWorkerBudgets, parseLabRuns, parseWorkerBudgets, repoRoot } from '../lib/canon.mjs';
import { missingRouteRows, parseRouteSource, renderRouteTable, routeBudgetTable, routeRow } from './routes.mjs';

const MD = `### 5.8 성능 예산 표

| 경로 묶음 | 첫 JS | CSS | 체감 목표 | 그 밖 | 강제 도구 |
| --- | --- | --- | --- | --- | --- |
| 홈·공연 상세·굿즈(ISR) | 170KB [가정] | 25KB [가정] | LCP p75 2.5초 | | size-limit |
| 좌석 화면 | 200KB [가정] + Worker 60KB [가정] | 20KB [가정] | 통과 뒤 첫 그림 1초 미만 | | size-limit |
| 결제 화면 | 180KB [가정] | 20KB [가정] | INP 200ms | | size-limit |
| 월렛 | 120KB [가정] | 15KB [가정] | 오프라인 첫 그림 1초 | | size-limit |
| 그 밖 소비자 화면 | 200KB [가정] | 25KB [가정] | INP 200ms | | size-limit |

- **판정은 둘로 나눈다**: 같은 시나리오를 20회 [가정] 반복해 p75로 낸다.

### 5.9 다음`;

const SOURCE = `const ROUTES = [
  cached('/'),
  cached('/events/[id]'),
  req('/booking/[eventId]/seats'),
  req('/booking/[eventId]/checkout'),
  cached('/my/tickets'),
  req('/search'),
  handler('/logout'),
  handler('/login/[provider]'),
];`;

test('F081-08 §5.8에서 Worker 60KB와 랩 20회를 읽는다', () => {
  assert.equal(parseWorkerBudgets(MD).get('좌석 화면'), 60);
  assert.equal(parseWorkerBudgets(MD).has('홈·공연 상세·굿즈(ISR)'), false);
  assert.equal(parseLabRuns(MD), 20);
  assert.throws(() => parseWorkerBudgets(MD.replace('+ Worker 60KB [가정]', '')), /Worker/);
  assert.throws(() => parseLabRuns('# 없음'), /20회/);
  // 실제 정본과 대조한다(문서만 바뀌어도 이 시험이 본다)
  assert.equal(loadWorkerBudgets().get('좌석 화면'), 60);
  assert.equal(loadLabRuns(), 20);
  assert.equal(loadJsBudgets().get('좌석 화면'), 200);
});

test('F081-06 경로 원천을 읽어 화면 45개·처리기 9개로 가른다', () => {
  const src = readFileSync(join(repoRoot, 'apps/web/src/_app/security/page-headers.ts'), 'utf8');
  const entries = parseRouteSource(src);
  assert.equal(entries.length, 54);
  assert.equal(entries.filter((e) => e.kind === 'page').length, 45);
  assert.equal(entries.filter((e) => e.kind === 'handler').length, 9);
  assert.deepEqual(parseRouteSource(SOURCE).map((e) => e.kind), ['page', 'page', 'page', 'page', 'page', 'page', 'handler', 'handler']);
});

test('F081-06b 경로 표는 모든 화면 경로를 §5.8 행에 매기고 처리기는 뺀다', () => {
  const src = readFileSync(join(repoRoot, 'apps/web/src/_app/security/page-headers.ts'), 'utf8');
  const entries = parseRouteSource(src);
  const table = routeBudgetTable({ source: src });
  assert.equal(table.length, 45);
  assert.equal(table.filter((r) => r.kind !== 'page').length, 0, '처리기는 HTML이 아니라 표에서 뺀다');
  assert.deepEqual(missingRouteRows(entries, table), []);

  const by = (pattern) => table.find((r) => r.pattern === pattern);
  const seat = by('/booking/[eventId]/seats');
  assert.equal(seat.row, '좌석 화면');
  assert.equal(seat.jsKB, 200);
  assert.equal(seat.cssKB, 20);
  assert.equal(seat.workerKB, 60);
  assert.equal(by('/booking/[eventId]/checkout').row, '결제 화면');
  assert.equal(by('/shop/checkout').row, '결제 화면');
  assert.equal(by('/my/tickets').row, '월렛');
  assert.equal(by('/my/tickets/[ticketId]').row, '월렛');
  assert.equal(by('/my/tickets/[ticketId]/cancel').row, '그 밖 소비자 화면');
  assert.equal(by('/events/[id]').row, '홈·공연 상세·굿즈(ISR)');
  assert.equal(by('/[locale]/events/[id]').row, '홈·공연 상세·굿즈(ISR)');
  assert.equal(by('/').row, '홈·공연 상세·굿즈(ISR)');
  assert.equal(by('/search').row, '그 밖 소비자 화면');
  // 좌석 화면만 Worker 예산이 있다
  assert.deepEqual(table.filter((r) => r.workerKB !== undefined).map((r) => r.pattern), ['/booking/[eventId]/seats']);
});

test('F081-07 새 경로가 예산 없이 들어오면 실패한다', () => {
  assert.throws(() => routeRow('/brand-new-screen'), /예산 행이 없다/);
  const entries = [{ kind: 'page', pattern: '/brand-new-screen' }];
  assert.deepEqual(missingRouteRows(entries, routeBudgetTable({ source: SOURCE })), ['/brand-new-screen']);
  assert.throws(() => routeBudgetTable({ source: `${SOURCE}\n  req('/brand-new-screen');` }), /예산 행이 없다/);
});

test('F081-07b 경로 표는 정본 표의 행 이름과 예산을 그대로 쓴다', () => {
  const budgets = loadJsBudgets();
  const table = routeBudgetTable({ source: SOURCE });
  for (const r of table) assert.equal(r.jsKB, budgets.get(r.row), `${r.pattern}의 행 ${r.row}`);
  const md = renderRouteTable(table);
  assert.match(md, /^\| 경로 \| §5\.8 행 \| 첫 JS\(kB\) \| CSS\(kB\) \| Worker\(kB\) \|$/m);
  assert.match(md, /\| \/booking\/\[eventId\]\/seats \| 좌석 화면 \| 200 \| 20 \| 60 \|/);
});
