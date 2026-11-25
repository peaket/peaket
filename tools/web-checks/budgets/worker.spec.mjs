// 좌석 화면 Worker 스크립트 예산(F-08-1, docs/frontend.md §5.8 좌석 화면 행 '+ Worker 60KB [가정]').
// 운영 빌드의 좌석 화면 데모를 브라우저로 열어 화면이 만드는 Worker 스크립트를 잡아 gzip으로 잰다(첫 JS와 다른 파일이다).
// Worker를 못 찾거나 화면이 안 열리면 건너뛰지 않고 실패한다(조용한 통과 금지). 워커 이름은 빌드마다 바뀌는 해시라 브라우저가 만든 주소를 쓴다.
import { test, expect } from '@playwright/test';
import { gzipKB } from '../seed-css/check-css.mjs';
import { loadWorkerBudgets } from '../lib/canon.mjs';
import { lighthousePages, seatDemoAdmission } from './pages.mjs';
import { HOST } from '../seed-css/apps.mjs';

test('F081-14 §5.8 좌석 화면 Worker 스크립트(gzip)가 Worker 예산 안이다', async ({ page }) => {
  const limit = loadWorkerBudgets().get('좌석 화면');
  expect(limit, "§5.8 좌석 화면 행의 '+ Worker NKB'").toBe(60);
  const seat = lighthousePages(HOST).find((p) => p.name === '좌석 화면 데모');
  expect(seat, '대표 주소의 좌석 화면 데모').toBeDefined();
  await page.addInitScript((entries) => {
    for (const [k, v] of entries) sessionStorage.setItem(k, v);
  }, Object.entries(seatDemoAdmission()));
  const workers = [];
  page.on('worker', (w) => workers.push(w.url()));
  await page.goto(seat.url, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => workers.length, { message: `좌석 화면이 Worker를 만들지 않았다(${seat.url})`, timeout: 30_000 }).toBeGreaterThan(0);
  const url = workers.find((u) => /seatmap/i.test(u)) ?? workers[0];
  // Next/Turbopack은 Worker 진입 파일이 작은 부트스트랩이고 실제 코드는 `#params=`에 적힌 덩어리들에 있다.
  // 그래서 Worker가 처음 받는 덩어리 전부를 잰다(부트스트랩만 재면 0.6kB로 조용히 통과한다).
  const parsed = new URL(url);
  let chunks = [];
  if (parsed.hash.startsWith('#params=')) {
    const decoded = JSON.parse(decodeURIComponent(parsed.hash.slice('#params='.length)));
    if (Array.isArray(decoded?.[0])) chunks = decoded[0];
  }
  const paths = [parsed.pathname, ...chunks];
  const texts = [];
  for (const p of paths) {
    const res = await page.request.get(new URL(p, parsed.origin).href);
    expect(res.status(), p).toBe(200);
    texts.push(await res.text());
  }
  expect(paths.length, 'Worker가 받는 스크립트').toBeGreaterThan(0);
  const kb = gzipKB(texts);
  // 보고서에 남길 값
  test.info().annotations.push({ type: 'worker-budget', description: `${paths.length}개 파일 ${kb}kB / ${limit}kB (${parsed.pathname})` });
  expect(kb, `좌석 Worker ${kb}kB > ${limit}kB(${paths.length}개 파일, ${parsed.pathname})`).toBeLessThanOrEqual(limit);
});
