// F-03-6(FE-T29) ③ 격리: 두 빌드에서 위젯 하나(대기열)를 막아도 셸·경보 패널·구매 위젯이 그대로인지 3회씩 본다.
// 무대는 stage.mjs가 만든다(빌드는 global-setup.mjs). 막는 경로는 build마다 다르다: MF는 /remotes/queue/**, 한 앱은
// /assets/widgets-queue.*.chunk.js. 값은 같은 ops 대역에서 온다. 결과는 reports/console-baseline/isolation.json에 쌓는다.
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DASHBOARD_PATH, blockRule, waitForMark } from './lib.mjs';
import { startStage } from './stage.mjs';

const RUNS = 3;

for (const build of ['mf', 'single']) {
  test(`F-03-6 T7 ③ ${build}: 대기열 위젯 하나를 막아도 셸·경보 패널·구매 위젯이 그대로다(3회)`, async ({ browser }) => {
    const stage = await startStage(build);
    const records = [];
    try {
      for (let i = 0; i < RUNS; i++) {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', colorScheme: 'dark' });
        const page = await ctx.newPage();
        await page.route(blockRule(build, 'queue'), (r) => r.abort());
        try {
          await page.goto(stage.origin + DASHBOARD_PATH);
          await waitForMark(page);
          await expect(page.locator('main#main')).toBeVisible();
          await expect(page.getByRole('heading', { name: '중앙 관제 대시보드', level: 1 })).toBeVisible();
          await expect(page.locator('#w-alert')).toBeVisible();
          // 한 앱은 purchase 위젯 덩어리가, MF는 purchase 원격이 그대로 실린다
          await expect(page.locator('[data-widget="purchase-pg-status"]')).toHaveCount(1, { timeout: 20_000 });
          // 막은 대기열 자리는 대체 카드이고 값 위젯이 아니다
          await expect(page.locator('[data-widget="queue-admission-rate"]')).toHaveCount(0);
          await expect(page.locator('[data-slot-state="fallback"]').first()).toBeVisible();
          const slots = await page.evaluate(() => {
            const all = [...document.querySelectorAll('[data-slot-state]')];
            return {
              total: all.length,
              loading: all.filter((x) => x.getAttribute('data-slot-state') === 'loading').length,
              fallback: all.filter((x) => x.getAttribute('data-slot-state') === 'fallback').length,
              value: all.filter((x) => x.getAttribute('data-slot-state') === 'value').length,
            };
          });
          expect(slots.loading, '막은 뒤에도 불러오는 중인 자리가 남았다').toBe(0);
          expect(slots.fallback, '막은 자리의 대체 카드가 없다').toBeGreaterThan(0);
          expect(slots.value, '다른 위젯의 값이 그려지지 않았다').toBeGreaterThan(0);
          records.push({ run: i + 1, ok: true, slots });
        } catch (e) {
          records.push({ run: i + 1, ok: false, error: e instanceof Error ? e.message : String(e) });
          throw e;
        } finally {
          await ctx.close();
        }
      }
    } finally {
      writeRecords(build, records);
      await stage.close();
    }
    // SKIPPED·0건이 통과로 새지 않게 3회 모두 기록됐는지 본다
    expect(records).toHaveLength(RUNS);
  });
}

function writeRecords(build, records) {
  const dir = new URL('../reports/console-baseline/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(`isolation-${build}.json`, dir), `${JSON.stringify({ build, runs: records }, null, 2)}\n`);
}
