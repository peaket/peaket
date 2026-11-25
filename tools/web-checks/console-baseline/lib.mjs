// F-03-6(FE-T29) 측정 도구의 순수 함수. 브라우저·빌드 없이 중앙값·p75, 실행 유효성, A/A 흔들림,
// 첫 JS·덩어리 크기, 격리 경로, 다시 빌드 폴더를 정한다. 정본은 docs/frontend.md §5.17 FE-T29와
// docs/review/plans/F-03-6.md다. 0건·SKIPPED·빈 결과를 통과로 흘리지 않는다.
import { gzipSync } from 'node:zlib';
import { scriptSrcs } from '../seed-css/apps.mjs';

/** 첫 그림 표시 이름(docs/frontend.md §5.7) */
export const MARK = 'peaket:dashboard-ready';
/** 정본 FE-T29의 CPU 느리게 하기 배수(frontend §5.8 Lighthouse 규칙과 같은 뜻) */
export const CPU_THROTTLE = 4;
/** 실제 값 대시보드(판매 중 탭)가 그리는 위젯 자리 가운데 최소 몇 개를 봐야 '보드가 그려졌다'로 보는가 */
export const EXPECTED_SLOTS = 6;
/** 두 빌드가 같은 화면을 재도록 고정한 주소(회차는 가짜 API·계약 예시와 같은 UUID) */
export const EVENT_ID = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
export const DASHBOARD_PATH = `/dashboard?tab=live&event=${EVENT_ID}`;
/** 3회 중앙값 규칙(정본 ADR-0100 결정 6·F-03-3 계획 §10) */
export const RUNS = 3;
/** A/A 흔들림이 이 비율을 넘으면 '그 시간대 PC 불안정'으로 표시한다(무효로 지우지 않는다) */
export const AA_NOISY_RATIO = 0.25;

/** @param {number[]} xs */
export function median(xs) {
  if (!Array.isArray(xs) || xs.length === 0) throw new Error('값이 없다');
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 가장 가까운 순위(nearest rank) 백분위. q=0.75, n=3이면 3번째(가장 늦은 값)다.
 * @param {number[]} xs
 * @param {number} q 0보다 크고 1 이하
 */
export function nearestRank(xs, q = 0.75) {
  if (!Array.isArray(xs) || xs.length === 0) throw new Error('값이 없다');
  if (!(q > 0 && q <= 1)) throw new Error(`q는 0보다 크고 1 이하여야 한다: ${q}`);
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(q * s.length) - 1];
}

/** @param {number[]} xs */
export function summarize(xs) {
  return { runs: xs.length, median: median(xs), p75: nearestRank(xs, 0.75), min: Math.min(...xs), max: Math.max(...xs) };
}

/** @param {unknown} n */
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * 한 실행(빈 캐시 또는 채운 캐시 한 번)이 유효한가. 무효 사유를 모두 돌려준다(첫 하나만 보지 않는다).
 * @param {Record<string, any>} run
 * @param {{ build: 'mf' | 'single' }} opts
 */
export function validateRun(run, opts) {
  const reasons = [];
  const build = opts?.build;
  if (!run || typeof run !== 'object') return { ok: false, reasons: ['실행 기록이 없다'] };
  if (run.readyMarkCount !== 1) reasons.push(`첫 그림 표시가 ${run.readyMarkCount ?? 0}개다(정확히 1개여야 한다)`);
  if (!finite(run.readyMs) || run.readyMs <= 0) reasons.push('첫 그림 시간이 없다');
  if (!finite(run.fcpMs) || run.fcpMs <= 0) reasons.push('FCP 값이 없다');
  if (!finite(run.lcpMs) || run.lcpMs <= 0) reasons.push('LCP 값이 없다');
  if (run.cpuThrottle !== CPU_THROTTLE) reasons.push(`CPU 스로틀 ${CPU_THROTTLE}배가 아니다(${run.cpuThrottle ?? '없음'})`);
  const slots = run.slotCounts ?? {};
  const total = (slots.value ?? 0) + (slots.fallback ?? 0);
  if (total < EXPECTED_SLOTS) reasons.push(`위젯 자리 ${total}개 < ${EXPECTED_SLOTS}개`);
  if ((slots.loading ?? 0) > 0) reasons.push(`불러오는 중인 자리 ${slots.loading}개가 남았다`);
  if (Array.isArray(run.pageErrors) && run.pageErrors.length > 0) reasons.push(`페이지 오류 ${run.pageErrors.length}건`);
  if (Array.isArray(run.pageErrors) !== true) reasons.push('페이지 오류 기록이 없다');
  if ((run.cspViolations ?? 0) > 0) reasons.push(`CSP 위반 ${run.cspViolations}건`);
  const entries = Array.isArray(run.remoteEntries) ? run.remoteEntries : [];
  if (build === 'mf') {
    const names = new Set(entries.map((e) => e?.name));
    if (!names.has('queue') || !names.has('purchase')) reasons.push(`원격 진입 파일이 모자란다(${[...names].join(',') || '없음'})`);
    if (!finite(run.remoteLoadMs?.queue) || run.remoteLoadMs.queue <= 0) reasons.push('대기열 원격 로드 시간이 없다');
    if (!finite(run.remoteLoadMs?.purchase) || run.remoteLoadMs.purchase <= 0) reasons.push('구매 원격 로드 시간이 없다');
  } else if (build === 'single') {
    if (entries.length !== 0) reasons.push(`한 앱인데 원격 요청 ${entries.length}건이 있다`);
  } else {
    reasons.push(`모르는 빌드: ${String(build)}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * 한 묶음(3회 × 빈/채운 캐시)이 유효한가. 회차마다 이유를 붙인다.
 * @param {{ build: 'mf' | 'single', runs: { cold: any, warm: any }[], valid?: boolean }} result
 */
export function validateResult(result) {
  const reasons = [];
  if (!result || typeof result !== 'object') return { ok: false, reasons: ['결과 파일이 없다'] };
  if (result.valid === false) reasons.push('도구가 결과를 무효로 표시했다');
  const runs = Array.isArray(result.runs) ? result.runs : [];
  if (runs.length !== RUNS) reasons.push(`3회가 아니다(${runs.length}회)`);
  runs.forEach((r, i) => {
    for (const phase of ['cold', 'warm']) {
      const v = validateRun(r?.[phase], { build: result.build });
      for (const reason of v.reasons) reasons.push(`${i + 1}회차 ${phase === 'cold' ? '빈 캐시' : '채운 캐시'}: ${reason}`);
    }
  });
  return { ok: reasons.length === 0, reasons };
}

/**
 * A/A 흔들림: |b-a|/a. a가 0이거나 값이 없으면 ratio null, noisy 참(판단할 수 없음).
 * @param {number} a
 * @param {number} b
 */
export function aaDrift(a, b) {
  if (!finite(a) || !finite(b) || a <= 0) return { abs: null, ratio: null, noisy: true };
  const abs = Math.abs(b - a);
  const ratio = abs / a;
  return { abs, ratio, noisy: ratio >= AA_NOISY_RATIO };
}

/** @param {number} a @param {number} b */
export function ratio(a, b) {
  if (!finite(a) || !finite(b) || b <= 0) throw new Error('비율을 낼 수 없다');
  return a / b;
}

/**
 * 산출물 경로의 덩어리 이름. main·scr-*·widgets-*·원격 진입 파일만 알아보고 나머지는 null.
 * @param {string} p
 */
export function chunkNameOf(p) {
  if (typeof p !== 'string') return null;
  const path = p.split('?')[0].replaceAll('\\', '/');
  const remote = /(?:^|\/)remotes\/([^/]+)\/[^/]+\/remoteEntry\.js$/.exec(path);
  if (remote) return `remote:${remote[1]}`;
  const named = /^\/assets\/([A-Za-z][\w-]*?)\.[0-9a-f]{3,}\.(?:chunk\.)?js$/.exec(path);
  if (!named) return null;
  const name = named[1];
  if (name === 'main' || name.startsWith('scr-') || name.startsWith('widgets-')) return name;
  return null;
}

/**
 * 격리 시험에서 막을 요청. MF는 그 원격 폴더 전체, 한 앱은 그 위젯 덩어리 하나.
 * @param {'mf' | 'single'} build
 * @param {'queue' | 'purchase'} remote
 */
export function blockRule(build, remote) {
  const name = String(remote);
  if (build === 'mf') return new RegExp(`(?:^|/)remotes/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`);
  if (build === 'single') return new RegExp(`(?:^|/)assets/widgets-${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[^/]+\\.chunk\\.js(?:\\?|$)`);
  throw new Error(`모르는 빌드: ${String(build)}(mf|single)`);
}

/**
 * webpack 모듈 이름에서 작업 공간 폴더를 센다. apps/widgets/<이름>은 한 폴더로 묶는다.
 * @param {string[]} moduleNames
 */
export function countFolders(moduleNames) {
  const out = new Set();
  for (const raw of moduleNames ?? []) {
    if (typeof raw !== 'string') continue;
    const m = /(?:^|\/)(apps\/(?:widgets\/[^/]+|[^/]+)|packages\/[^/]+)\//.exec(raw.replaceAll('\\', '/'));
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

/** 화면이 싣는 파일의 gzip 크기 합(kB = 1,000바이트, 소수 첫째 자리, 파일마다 따로) */
export function gzipKB(files) {
  const bytes = files.reduce((n, f) => n + gzipSync(typeof f === 'string' ? Buffer.from(f) : f).length, 0);
  // 빈 파일이 아니면 0.0으로 적지 않는다(도구가 '값 없음'과 '아주 작음'을 구별하게). 실제 파일은 0.1kB보다 크다.
  return files.length > 0 ? Math.max(0.1, Math.round(bytes / 100) / 10) : 0;
}

/**
 * 첫 그림 표시를 브라우저 밖에서 폴링한다(Playwright waitForFunction은 CPU 스로틀에서 rAF 폴링이 늦어질 수 있다).
 * 표시는 mark 하나만 센다(같은 이름의 measure와 구별).
 * @param {{ evaluate: Function, waitForTimeout: Function }} page
 * @param {number} [timeout]
 */
export async function waitForMark(page, timeout = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const n = await page.evaluate((name) => performance.getEntriesByName(name).filter((e) => e.entryType === 'mark').length, MARK);
    if (n === 1) return;
    if (n > 1) throw new Error(`첫 그림 표시가 ${n}개다`);
    await page.waitForTimeout(50);
  }
  throw new Error(`첫 그림 표시(${MARK})를 ${timeout}ms 안에 보지 못했다`);
}

/**
 * 첫 화면 HTML이 싣는 스크립트와 빌드 산출물의 덩어리 크기.
 * @param {{ html: string, files: Record<string, string | Buffer>, build: 'mf' | 'single' }} o
 */
export function buildSizes({ html, files, build }) {
  const initial = scriptSrcs(html).filter((p) => files[p] !== undefined);
  if (initial.length === 0) throw new Error('첫 화면 스크립트가 없다');
  const chunks = [];
  for (const [path, body] of Object.entries(files)) {
    const name = chunkNameOf(path);
    if (!name) continue;
    if (name.startsWith('remote:') && build !== 'mf') continue;
    chunks.push({ name, path, gzipKB: gzipKB([body]) });
  }
  return {
    initial: { files: initial, gzipKB: gzipKB(initial.map((p) => files[p])) },
    chunks: [...new Map(chunks.map((c) => [c.name, c])).values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
