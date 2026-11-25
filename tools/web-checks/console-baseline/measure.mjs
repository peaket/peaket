// F-03-6(FE-T29) ① 첫 그림·FCP·LCP·INP 대리 측정. 한 빌드를 3회(빈 캐시) + 3회(같은 맥락에서 다시 열기, 채운 캐시) 잰다.
// - 화면: /dashboard?tab=live&event=<UUID> (원격 둘이 실제로 실리는 판매 중 탭)
// - 조건: Playwright Chromium, 1440×900, CPU 4배(Emulation.setCPUThrottlingRate), 네트워크 느리게 하기 없음
// - 첫 그림: peaket:dashboard-ready 표시(정본 docs/frontend.md §5.7). 없거나 2개 이상이면 그 실행은 무효다.
// - 값은 같은 ops 대역에서 온다. 도구는 화면 글자를 읽지 않고 data-slot-state만 센다.
// 실행: node console-baseline/measure.mjs --build mf --label aa1 --runs 3
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CPU_THROTTLE, DASHBOARD_PATH, RUNS, validateRun, waitForMark } from './lib.mjs';
import { measureSizes } from './sizes.mjs';
import { REPO, assertPortsFree, buildConsole, startStage } from './stage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const parse = () => {
  const { values } = parseArgs({
    options: {
      build: { type: 'string' },
      label: { type: 'string' },
      runs: { type: 'string', default: String(RUNS) },
      out: { type: 'string' },
      'force-build': { type: 'boolean', default: false },
    },
  });
  if (values.build !== 'mf' && values.build !== 'single') throw new Error('--build mf|single 이 필요하다');
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 3) throw new Error('--runs는 3 이상의 정수여야 한다(정본 3회)');
  return { build: values.build, label: values.label ?? values.build, runs, out: values.out, force: values['force-build'] };
};

const commit = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();

/** 브라우저 안에서 LCP·긴 작업·이벤트 시간·CSP 위반을 모은다 */
async function initPage(page) {
  await page.addInitScript(() => {
    window.__peaket = { lcp: 0, longTasks: 0, eventMax: 0, csp: [] };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__peaket.lcp = Math.max(window.__peaket.lcp, e.startTime);
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      /* 브라우저가 LCP를 지원하지 않는다 */
    }
    try {
      new PerformanceObserver((list) => {
        window.__peaket.longTasks += list.getEntries().length;
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      /* longtask 미지원 */
    }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__peaket.eventMax = Math.max(window.__peaket.eventMax, e.duration);
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
    } catch {
      /* event timing 미지원 */
    }
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__peaket.csp.push({ directive: e.effectiveDirective, blocked: e.blockedURI, sample: (e.sample || '').slice(0, 120) });
    });
  });
}

/** 한 번(빈 캐시 또는 채운 캐시)을 잰다 */
async function collect(page, { remoteSeen, scriptSeen }) {
  const nav = await page.evaluate(({ remoteSeenArg, scriptSeenArg }) => {
    const n = performance.getEntriesByType('navigation')[0];
    const pick = (name, type) => {
      const e = performance.getEntriesByName(name).find((x) => !type || x.entryType === type);
      return e ? e.startTime : null;
    };
    const slots = [...document.querySelectorAll('[data-slot-state]')];
    const count = (v) => slots.filter((s) => s.getAttribute('data-slot-state') === v).length;
    const resources = performance.getEntriesByType('resource');
    const remoteLoadMs = { queue: null, purchase: null };
    const remoteEntries = [];
    for (const r of resources) {
      const m = /\/remotes\/([^/]+)\/[^/]+\/remoteEntry\.js(?:$|\?)/.exec(r.name);
      if (!m) continue;
      remoteLoadMs[m[1]] = Math.round(r.responseEnd * 10) / 10;
      remoteEntries.push({ name: m[1], ms: Math.round(r.responseEnd * 10) / 10 });
    }
    return {
      readyMarkCount: performance.getEntriesByName('peaket:dashboard-ready').filter((e) => e.entryType === 'mark').length,
      readyMs: pick('peaket:dashboard-ready', 'mark'),
      fcpMs: pick('first-contentful-paint'),
      lcpMs: window.__peaket.lcp || null,
      dclMs: n ? n.domContentLoadedEventEnd : null,
      loadMs: n ? n.loadEventEnd : null,
      longTasks: window.__peaket.longTasks,
      inpMs: window.__peaket.eventMax || 0,
      slotCounts: { loading: count('loading'), value: count('value'), fallback: count('fallback') },
      remoteEntries,
      remoteLoadMs,
      remoteRequests: remoteSeenArg.slice(),
      scripts: [...new Set(scriptSeenArg)],
      cspViolations: window.__peaket.csp.length,
      csp: window.__peaket.csp,
    };
  }, { remoteSeenArg: remoteSeen, scriptSeenArg: scriptSeen });
  return nav;
}

/** 한 빌드를 여러 회 잰다. 회차마다 빈 캐시와 채운 캐시를 함께 잰다 */
async function runOne(stage, { runs, label }) {
  const browser = await chromium.launch({ headless: true });
  const chromeVersion = await browser.version();
  const rows = [];
  const allPageErrors = [];
  try {
    // 예열: 빌드 파일과 OS 파일 캐시를 데운다(값에 넣지 않는다)
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', colorScheme: 'dark', reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.goto(stage.origin + DASHBOARD_PATH, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await waitForMark(page).catch(() => undefined);
      await ctx.close();
    }
    for (let i = 0; i < runs; i++) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', colorScheme: 'dark', reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      const remoteSeen = [];
      const scriptSeen = [];
      page.on('request', (r) => {
        const p = new URL(r.url()).pathname;
        if (p.startsWith('/remotes/')) remoteSeen.push(p);
      });
      page.on('response', (r) => {
        try {
          const u = new URL(r.url());
          if (u.origin === stage.origin && r.request().resourceType() === 'script' && r.status() === 200) scriptSeen.push(u.pathname);
        } catch {
          /* 응답 주소를 읽지 못하는 경우는 건너뛴다 */
        }
      });
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));
      await initPage(page);
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
      try {
        await page.goto(stage.origin + DASHBOARD_PATH, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await waitForMark(page);
        await page.waitForTimeout(300);
        const cold = await collect(page, { remoteSeen, scriptSeen });
        // 탭을 눌러 한 조작의 INP 대리값을 잰다(T=0 탭). 첫 그림 뒤라 측정값을 흔들지 않는다.
        await page.locator('#tab-t0').click({ timeout: 10_000 }).catch(() => undefined);
        await page.waitForTimeout(400);
        const inpMs = await page.evaluate(() => window.__peaket.eventMax || 0);
        cold.inpMs = inpMs;
        // 채운 캐시: 같은 맥락에서 다시 연다(원격·자산은 이름/경로에 해시·sha가 있어 캐시된다)
        remoteSeen.length = 0;
        scriptSeen.length = 0;
        await page.goto(stage.origin + DASHBOARD_PATH, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await waitForMark(page);
        await page.waitForTimeout(300);
        const warm = await collect(page, { remoteSeen, scriptSeen });
        await page.locator('#tab-t0').click({ timeout: 10_000 }).catch(() => undefined);
        await page.waitForTimeout(400);
        warm.inpMs = await page.evaluate(() => window.__peaket.eventMax || 0);
        const errors = [...pageErrors];
        allPageErrors.push(...errors);
        rows.push({ cold: { ...cold, pageErrors: errors, cpuThrottle: CPU_THROTTLE }, warm: { ...warm, pageErrors: errors, cpuThrottle: CPU_THROTTLE } });
      } catch (e) {
        const diag = await page.evaluate(() => ({
          url: location.href,
          marks: performance.getEntriesByName('peaket:dashboard-ready').map((m) => [m.entryType, Math.round(m.startTime)]),
          slots: [...document.querySelectorAll('[data-slot-state]')].map((x) => x.getAttribute('data-slot-state')),
          body: document.body.innerText.slice(0, 160),
        })).catch((x) => ({ evalError: String(x?.message ?? x) }));
        console.log('DIAG', JSON.stringify(diag));
        rows.push({
          cold: { readyMarkCount: 0, readyMs: null, fcpMs: null, lcpMs: null, slotCounts: { loading: 0, value: 0, fallback: 0 }, remoteEntries: [], remoteLoadMs: {}, pageErrors: [String(e?.message ?? e)], cspViolations: 0, cpuThrottle: CPU_THROTTLE },
          warm: null,
        });
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }
  return { label, rows, pageErrors: allPageErrors, chromeVersion };
}

const main = async () => {
  const o = parse();
  await assertPortsFree([o.build === 'mf' ? 4310 : 4311]);
  const build = buildConsole(o.build, { force: o.force });
  const stage = await startStage(o.build);
  try {
    const measured = await runOne(stage, { runs: o.runs, label: o.label });
    const firstScripts = measured.rows[0]?.cold?.scripts ?? [];
    const sizes = await measureSizes(o.build, stage, { scripts: firstScripts });
    const invalidReasons = [];
    measured.rows.forEach((r, i) => {
      for (const phase of ['cold', 'warm']) {
        const v = validateRun(r?.[phase], { build: o.build });
        for (const reason of v.reasons) invalidReasons.push(`${i + 1}회차 ${phase}: ${reason}`);
      }
    });
    if (stage.ops.stats.requests === 0) invalidReasons.push('대역 ops API 요청이 0건이다');
    const result = {
      build: o.build,
      label: o.label,
      commit: commit(),
      chrome: `Chromium/${measured.chromeVersion}`,
      cpuThrottle: CPU_THROTTLE,
      viewport: { width: 1440, height: 900 },
      path: DASHBOARD_PATH,
      buildMs: build.ms,
      built: build.built,
      stub: { version: 'widgets-v1', requests: stage.ops.stats.requests, streams: stage.ops.stats.streams, widgets: stage.ops.stats.widgets },
      runs: measured.rows,
      pageErrors: measured.pageErrors,
      sizes,
      valid: invalidReasons.length === 0,
      invalidReasons,
    };
    const out = o.out ?? path.join(HERE, '../reports/console-baseline', o.label);
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`${o.build}/${o.label}: ${result.valid ? '유효' : '무효'} (${measured.rows.length}회, 대역 요청 ${stage.ops.stats.requests})`);
    if (!result.valid) {
      for (const r of invalidReasons) console.error(`  - ${r}`);
      process.exitCode = 1;
    }
  } finally {
    await stage.close();
  }
};

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exitCode = 1;
});
