// F-05-9 K10 측정 실행(계획 docs/review/plans/F-05-9.md §4·§5).
// 이 파일은 측정 창 3에서만 돈다: K10_MEASURE=1. 평소 CI에서는 전부 건너뛴다.
// 실행 방법(측정 창):
//   1) pnpm --filter @peaket/scanner build
//   2) tools/web-checks에서 pnpm install --frozen-lockfile
//   3) K10_MEASURE=1 pnpm exec playwright test -c playwright.scanner-k10.config.mjs
// 결과 JSON은 뿌리 .cache/k10/<run-id>/에 쓴다(측정 담당이 docs/perf-ledger/runs/로 옮긴다).
// 표시: 실측(PC), 무대 'Chromium 흉내(실제 관리형 기기 아님)'.
import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import os from 'node:os';
import { K10, intervalStatsOf, judgeLane, judgeTransition, laneRunValidity, throughputPerMinute, transitionPlan, transitionWindowIndexes } from './k10-lib.mjs';
import {
  apiReachable,
  fakeApi,
  installFakeDetector,
  installProbe,
  newKey,
  onlineState,
  presentQr,
  qrOf,
  queueCount,
  resultOf,
  signedIn,
  startShift,
  ticketId,
  ticketOf,
  ticketState,
  uploadedIds,
  waitQueueCount,
  waitVerdict,
} from './fixture.mjs';

const RUN = process.env.K10_MEASURE === '1';
const RUN_ID = process.env.K10_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const RUN_TOKEN = process.env.K10_RUN_TOKEN ?? 'local';
const CACHE = resolve(process.cwd(), '../../.cache/k10', RUN_ID);
const META = resolve(CACHE, 'run-meta.json');
const BASE_URL = process.env.K10_BASE_URL ?? 'http://127.0.0.1:4104';

// 지난 실행 파일을 이번 결과로 읽지 않는다. 같은 측정 작업자의 새 작업자(worker)는
// run-meta.json의 runToken이 같아 이어 쓸 수 있고, 다른 측정은 새 토큰을 준다.
if (process.env.K10_RUN_ID && existsSync(CACHE) && readdirSync(CACHE).length > 0 && existsSync(META)) {
  const meta = JSON.parse(readFileSync(META, 'utf8'));
  if (meta.runToken !== RUN_TOKEN) {
    throw new Error(`K10_RUN_ID ${RUN_ID} 폴더는 다른 실행의 것이다(runToken 불일치). 새 ID나 토큰을 준다.`);
  }
}

test.skip(!RUN, 'K10 측정 창에서만 돈다. K10_MEASURE=1로 실행한다.');

function envOf() {
  return {
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    totalmem: os.totalmem(),
    freemem: os.freemem(),
    node: process.version,
    startedAt: new Date().toISOString(),
  };
}

/** 호스트 CPU 사용률을 재기 위한 스냅숏. os.loadavg는 Windows에서 늘 0이라 CPU 시간을 쓴다. */
function cpuSnapshot() {
  return os.cpus().map((c) => {
    const total = Object.values(c.times).reduce((a, b) => a + b, 0);
    return { idle: c.times.idle, total };
  });
}

function cpuPercent(before, after) {
  const idle = after.reduce((sum, c, i) => sum + (c.idle - before[i].idle), 0);
  const total = after.reduce((sum, c, i) => sum + (c.total - before[i].total), 0);
  return total > 0 ? ((total - idle) / total) * 100 : undefined;
}

/** 실행 ID를 붙여 이번 실행 폴더에 쓴다. 요약 시험이 지난 파일을 읽지 않게 한다(RV059-11). */
function writeRun(name, run) {
  mkdirSync(CACHE, { recursive: true });
  if (!existsSync(META)) writeFileSync(META, JSON.stringify({ runId: RUN_ID, runToken: RUN_TOKEN, startedAt: new Date().toISOString() }, null, 2));
  writeFileSync(resolve(CACHE, name), JSON.stringify({ runId: RUN_ID, ...run }, null, 2));
}

function readRun(name) {
  const run = JSON.parse(readFileSync(resolve(CACHE, name), 'utf8'));
  if (run.runId !== RUN_ID) throw new Error(`지난 실행 파일이다: ${name} (${run.runId} ≠ ${RUN_ID})`);
  return run;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** QR 한 번: 2초 목표 시각이 있으면 기다린 뒤 대고, 판정 화면이 뜰 때까지 기다린다. */
async function scanOnce(page, key, id, targetWallMs) {
  if (targetWallMs !== undefined) {
    const wait = targetWallMs - Date.now();
    if (wait > 0) await sleep(wait);
  }
  await presentQr(page, await qrOf(key, id, Date.now()));
  const presentWall = Date.now();
  const probe = await waitVerdict(page);
  return { probe, presentWall };
}

/** 이 문서가 같은지. 새 문서(새로고침)면 probe의 bootId가 달라진다. */
async function bootIdOf(page) {
  return page.evaluate(() => window.__k10?.bootId);
}

/** 스캐너를 띄우고 근무 준비까지 마친다. 반환값은 가짜 API 로그다. */
async function boot(page, { tickets, key, clockOffsetMs = 0, apiOptions = {} }) {
  await installProbe(page);
  await installFakeDetector(page);
  if (clockOffsetMs !== 0) {
    await page.addInitScript((ms) => {
      const realNow = Date.now;
      Date.now = () => realNow() + ms;
    }, clockOffsetMs);
  }
  const api = await fakeApi(page, { tickets, ...apiOptions });
  await signedIn(page);
  await startShift(page);
  return api;
}

// ---------------------------------------------------------------------------
// K10 현장 시나리오 6종 가운데 이 하네스가 직접 돌리는 S3~S6.
// S1(완전 오프라인 판정)과 S2(두 기기 동시 스캔)는 기존 시험을 쓴다(계획 §4).
// ---------------------------------------------------------------------------

test('K10-S3 저장소에 없는 키와 다른 키로 서명한 QR은 통과하지 않는다 (O-T4)', async ({ page }) => {
  test.setTimeout(60_000);
  const key = await newKey();
  const tickets = [ticketOf(ticketId(1), key)];
  const api = await boot(page, { tickets, key });
  api.offline = true;
  await page.context().setOffline(true);

  // 양성 대조(RV059-03): 이 오프라인 상황에서 목록에 있는 정상 QR은 통과한다.
  const positive = await scanOnce(page, key, tickets[0].ticketId);
  expect(resultOf(positive.probe.text)).toBe('PASS');

  const other = await newKey();
  await presentQr(page, await qrOf(other, tickets[0].ticketId, Date.now()));
  const unknown = await waitVerdict(page);
  expect(unknown.text).toContain('키가 아직 반영되지 않았습니다');
  expect(resultOf(unknown.text)).toBe('REJECT');

  // 있는 keyId에 다른 키로 서명: 저장소만 훔쳐도 서명을 만들 수 없다.
  const forged = { ...other, keyIdBytes: key.keyIdBytes, keyId: key.keyId };
  await presentQr(page, await qrOf(forged, tickets[0].ticketId, Date.now()));
  const bad = await waitVerdict(page);
  expect(bad.text).toContain('위조가 의심됩니다');
  expect(resultOf(bad.text)).toBe('REJECT');
});

test('K10-S4 기기 시계가 +60초·-60초 어긋나도 서버 시각 보정 뒤 정상 QR이 통과하고, 보정 밖 QR은 거부된다 (O-T5)', async ({ browser }) => {
  test.setTimeout(120_000);
  async function run(offsetMs, withExpired) {
    const context = await browser.newContext({ baseURL: BASE_URL, locale: 'ko-KR', timezoneId: 'Asia/Seoul', permissions: ['camera'] });
    const page = await context.newPage();
    try {
      const key = await newKey();
      const tickets = [ticketOf(ticketId(1), key), ticketOf(ticketId(2), key)];
      await boot(page, { tickets, key, clockOffsetMs: offsetMs });
      const ok = await scanOnce(page, key, tickets[0].ticketId);
      expect(resultOf(ok.probe.text)).toBe('PASS');
      if (withExpired) {
        // 보정 밖 QR은 유효시간(±30초)을 넉넉히 넘겨야 한다. 31초는 양성 대조 뒤 경과 시간 때문에
        // 30초 안으로 들어올 수 있어 60초 앞으로 둔다.
        await presentQr(page, await qrOf(key, tickets[1].ticketId, Date.now() + 60_000));
        const expired = await waitVerdict(page);
        expect(resultOf(expired.text)).toBe('REJECT');
        expect(expired.text).toContain('유효시간이 지난 QR');
      }
    } finally {
      await context.close();
    }
  }
  await run(60_000, true);
  await run(-60_000, false);
});

test('K10-S5 양도 변경분을 받기 전 옛 키 QR은 통과하고, 받은 뒤에는 옛 QR로 거부되며 새 키는 통과한다 (O-T7·O-T19)', async ({ page }) => {
  test.setTimeout(120_000);
  const oldKey = await newKey();
  const newKeyB = await newKey();
  const control = ticketId(1); // 양도되지 않는 대조 티켓
  const transferred = ticketId(2); // 양도되는 티켓(아직 입장 전)
  const tickets = [ticketOf(control, oldKey), ticketOf(transferred, oldKey)];
  const api = await boot(page, { tickets, key: oldKey });

  // 변경분 전: 옛 키가 대조 티켓에서 통과한다.
  const before = await scanOnce(page, oldKey, control);
  expect(resultOf(before.probe.text)).toBe('PASS');

  // 다음 60초 변경분에 양도된 티켓의 키가 바뀐다.
  api.changesReply = () => ({
    changes: [
      { seq: 11, kind: 'KEY_REGISTERED', payload: { v: 1, ticketId: transferred, keyId: newKeyB.keyId, publicKey: newKeyB.publicKey } },
      { seq: 12, kind: 'KEY_REVOKED', payload: { v: 1, ticketId: transferred, keyId: oldKey.keyId } },
    ],
    lastSeq: 12,
  });
  // 요청 수가 아니라 앱 저장소에 적용된 상태를 기다린다(RV059-05).
  await expect
    .poll(
      async () => {
        const state = await ticketState(page, transferred);
        return state.keys.includes(newKeyB.keyId) && state.revoked.includes(oldKey.keyId);
      },
      { timeout: 70_000 },
    )
    .toBe(true);

  // 변경분 뒤: 양도된 티켓의 옛 키는 '옛 QR'로 거부된다.
  await presentQr(page, await qrOf(oldKey, transferred, Date.now()));
  const revoked = await waitVerdict(page);
  expect(revoked.text).toContain('양도·취소·재발급된 티켓의 옛 QR');
  expect(resultOf(revoked.text)).toBe('REJECT');

  // 같은 양도 티켓의 새 키는 입장 전이므로 통과한다.
  const fresh = await scanOnce(page, newKeyB, transferred);
  expect(resultOf(fresh.probe.text)).toBe('PASS');
});

test('K10-S6 새 키를 못 받은 오프라인 스캐너는 키 미반영으로 거부하고 부스·책임자를 안내한다 (O-T25)', async ({ page }) => {
  test.setTimeout(60_000);
  const listed = await newKey();
  const notSynced = await newKey();
  const tickets = [ticketOf(ticketId(1), listed)];
  const api = await boot(page, { tickets, key: listed });
  api.offline = true;
  await page.context().setOffline(true);

  // 양성 대조(RV059-03): 목록에 있는 키는 이 오프라인 상황에서 통과한다.
  const positive = await scanOnce(page, listed, tickets[0].ticketId);
  expect(resultOf(positive.probe.text)).toBe('PASS');

  await presentQr(page, await qrOf(notSynced, tickets[0].ticketId, Date.now()));
  const verdict = await waitVerdict(page);
  expect(resultOf(verdict.text)).toBe('REJECT');
  expect(verdict.text).toContain('키가 아직 반영되지 않았습니다');
  expect(verdict.text).toContain('부스나 책임자');
});

// ---------------------------------------------------------------------------
// O-T40 — 온라인 → 오프라인 전환 중 판정.
// ---------------------------------------------------------------------------

/** 300건 전환 실행 하나. 2초 목표 간격, 150번째 전에 끊고, 301번째에 다시 켠다. */
async function runTransition(page, run) {
  test.setTimeout(20 * 60_000);
  const key = await newKey();
  const plan = transitionPlan();
  const warmup = Array.from({ length: 10 }, (_, i) => ticketOf(ticketId(1000 + i), key));
  const tickets = [...plan.map((s) => ticketOf(ticketId(s.index), key)), ...warmup];
  const api = await boot(page, { tickets, key });
  const bootId = await bootIdOf(page);
  const startedAt = new Date().toISOString();
  const cpu0 = cpuSnapshot();

  let lastPresentWall;
  let lastWarmupProbe;
  for (const t of warmup) {
    const result = await scanOnce(page, key, t.ticketId);
    lastWarmupProbe = result.probe;
    lastPresentWall = result.presentWall;
  }

  const beforeOnline = await onlineState(page);
  const apiBefore = await apiReachable(page);
  let afterOfflineOnline;
  let apiOffline;
  let beforeReconnectOnline;
  let apiAfter;
  let queueBeforeReconnect;
  let transitionAtScan;
  let reconnectAtScan;

  const scans = [];
  let offline = false;
  for (const step of plan) {
    if (!offline && step.index === K10.transitionAt) {
      api.offline = true;
      await page.context().setOffline(true);
      await expect.poll(() => onlineState(page), { timeout: 5_000 }).toBe(false);
      afterOfflineOnline = await onlineState(page);
      apiOffline = await apiReachable(page);
      transitionAtScan = step.index;
      offline = true;
    }
    if (offline && step.phase === 'recovery') {
      beforeReconnectOnline = await onlineState(page);
      queueBeforeReconnect = await queueCount(page);
      api.offline = false;
      await page.context().setOffline(false);
      await expect.poll(() => onlineState(page), { timeout: 5_000 }).toBe(true);
      apiAfter = await apiReachable(page);
      reconnectAtScan = step.index;
      offline = false;
    }
    const online = await onlineState(page);
    const target = lastPresentWall === undefined ? undefined : lastPresentWall + K10.intervalMs;
    let result;
    let error;
    try {
      result = await scanOnce(page, key, ticketId(step.index), target);
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 200);
    }
    lastPresentWall = result?.presentWall ?? Date.now();
    scans.push({
      index: step.index,
      ticketId: ticketId(step.index),
      phase: step.phase,
      online,
      presentedAtMs: result?.probe.presentedAt ?? 0,
      decodedAtMs: result?.probe.decodedAt ?? 0,
      verdictAtMs: result?.probe.verdictAt ?? 0,
      presentLatencyMs: result ? result.probe.verdictAt - result.probe.presentedAt : undefined,
      decodeLatencyMs: result && result.probe.decodedAt ? result.probe.verdictAt - result.probe.decodedAt : undefined,
      result: result ? resultOf(result.probe.text) : undefined,
      text: result?.probe.text,
      error,
    });
  }

  const afterOnline = await onlineState(page);
  let queueAfter;
  try {
    await waitQueueCount(page, 0, 90_000);
    queueAfter = 0;
  } catch {
    queueAfter = await queueCount(page);
  }
  const uploaded = uploadedIds(api);
  const hostCpuPercent = cpuPercent(cpu0, cpuSnapshot());
  const offlineScans = scans.filter((s) => s.phase === 'offline').length;
  const offlineScansWithOnlineTrue = scans.filter((s) => s.phase === 'offline' && s.online === true).length;
  const observed =
    beforeOnline === true &&
    afterOfflineOnline === false &&
    beforeReconnectOnline === false &&
    afterOnline === true &&
    apiBefore === true &&
    apiOffline === false &&
    apiAfter === true &&
    offlineScans > 0 &&
    offlineScansWithOnlineTrue === 0
      ? 'offline'
      : 'mixed';
  const intervalStats = intervalStatsOf(scans, { previousPresentedAtMs: lastWarmupProbe?.presentedAt });
  const ticketIds = scans.map((s) => s.ticketId);
  const pageReloaded = (await bootIdOf(page)) !== bootId;
  const invalidReasons = [];
  if (Number.isFinite(hostCpuPercent) && hostCpuPercent > 80) invalidReasons.push(`호스트 CPU ${hostCpuPercent.toFixed(0)}% > 80%`);
  if (observed !== 'offline') invalidReasons.push('실제 오프라인 단절 증거가 계획과 다르다');
  if (!(queueBeforeReconnect >= offlineScans)) invalidReasons.push(`다시 연결 전 큐 ${queueBeforeReconnect ?? 0}건 < 오프라인 판정 ${offlineScans}건`);
  if (pageReloaded) invalidReasons.push('측정 중 페이지를 새로고침했다');
  if (api.unknownPaths.length > 0) invalidReasons.push(`예상 밖 API 경로 ${api.unknownPaths.length}건`);
  if (new Set(ticketIds).size !== ticketIds.length) invalidReasons.push('티켓 ID가 겹친다');
  if (transitionAtScan !== K10.transitionAt) invalidReasons.push(`전환 시각 ${transitionAtScan ?? '없음'}번째`);
  if (reconnectAtScan !== K10.transitionScans + 1) invalidReasons.push(`복구 시각 ${reconnectAtScan ?? '없음'}번째`);
  if (intervalStats.overruns > 0) invalidReasons.push(`2초+${intervalStats.toleranceMs}ms를 넘긴 간격 ${intervalStats.overruns}건`);
  if (Number.isFinite(intervalStats.medianMs) && Math.abs(intervalStats.medianMs - K10.intervalMs) > K10.intervalToleranceMs) {
    invalidReasons.push(`간격 중앙값 ${intervalStats.medianMs.toFixed(0)}ms`);
  }

  const runData = {
    scenario: 'O-T40-a',
    run,
    startedAt,
    finishedAt: new Date().toISOString(),
    env: envOf(),
    scans,
    expectedScans: plan.length,
    warmupLastPresentedAtMs: lastWarmupProbe?.presentedAt,
    transitionWindows: transitionWindowIndexes(),
    intervalStats,
    transitionAtScan,
    reconnectAtScan,
    queueAfter,
    queueBeforeReconnect,
    uploadedIds: uploaded,
    uploadedCount: uploaded.length,
    expectedUploadCount: 10 + plan.length,
    network: observed,
    networkEvidence: {
      observed,
      before: beforeOnline ? 'online' : 'offline',
      afterOffline: afterOfflineOnline ? 'online' : 'offline',
      beforeReconnect: beforeReconnectOnline ? 'online' : 'offline',
      afterReconnect: afterOnline ? 'online' : 'offline',
      apiReachableBefore: apiBefore,
      apiReachableOffline: apiOffline,
      apiReachableAfter: apiAfter,
      offlineScans,
      offlineScansWithOnlineTrue,
      queueBeforeReconnect,
    },
    unknownPaths: api.unknownPaths.length,
    pageReloaded,
    hostCpuPercent,
    valid: invalidReasons.length === 0,
    invalidReasons,
  };
  writeRun(`o-t40-a-r${run}.json`, runData);
  expect(scans.length).toBe(plan.length);
  expect(queueAfter).toBe(0);
  expect(observed, invalidReasons.join(' / ')).toBe('offline');
}

test('K10-O-T40-a 전환 사이에 끊기 r1', async ({ page }) => runTransition(page, 1));
test('K10-O-T40-a 전환 사이에 끊기 r2', async ({ page }) => runTransition(page, 2));
test('K10-O-T40-a 전환 사이에 끊기 r3', async ({ page }) => runTransition(page, 3));

test('K10-O-T40-b 업로드가 진행 중일 때 끊겨도 큐에 남아 다시 연결되면 올라간다', async ({ page }) => {
  test.setTimeout(90_000);
  const key = await newKey();
  const tickets = [ticketOf(ticketId(1), key)];
  const api = await boot(page, { tickets, key });
  // 서버가 받고 응답을 잃은 뒤, 앱이 같은 ID로 다시 보내는 갈래(RV059-04).
  api.loseScanResponseOnce = true;
  await scanOnce(page, key, tickets[0].ticketId);
  await waitQueueCount(page, 0, 30_000);

  const batches = api.scans.filter((s) => Array.isArray(s.ids) && s.ids.length > 0);
  const received = batches.flatMap((s) => s.ids);
  const first = batches[0];
  const second = batches[1];
  const sameId = first?.ids?.[0] === second?.ids?.[0];
  const pass =
    batches.length >= 2 &&
    first?.responseLost === true &&
    first.ids.length === 1 &&
    second?.ids?.length === 1 &&
    sameId === true &&
    received.length === 2 &&
    new Set(received).size === 1;
  writeRun('o-t40-upload.json', {
    scenario: 'O-T40-b',
    pass,
    batches: batches.length,
    responseLost: first?.responseLost ?? false,
    sameIdRetried: sameId,
    receivedCount: received.length,
    uniqueCount: new Set(received).size,
  });
  expect(pass).toBe(true);
});

test('K10-O-T40-c 변경분 받기가 진행 중일 때 끊겨도 다음 동기화가 이어진다', async ({ page }) => {
  test.setTimeout(180_000);
  const key = await newKey();
  const ticket = ticketOf(ticketId(1), key);
  const api = await boot(page, { tickets: [ticket], key, apiOptions: { changesDelayMs: 3_000 } });
  api.changesReply = () => ({
    changes: [{ seq: 11, kind: 'TICKET_STATUS', payload: { v: 1, ticketId: ticket.ticketId, status: 'REFUNDED', version: 1 } }],
    lastSeq: 11,
  });

  await expect.poll(() => api.changeCalls.length, { timeout: 70_000 }).toBeGreaterThan(0);
  await expect.poll(() => api.inFlight, { timeout: 10_000 }).toBe('changes');
  api.offline = true;
  await page.context().setOffline(true);
  await expect.poll(() => api.changeCalls.some((c) => c.aborted), { timeout: 10_000 }).toBe(true);
  const abortedCount = api.changeCalls.length;

  api.offline = false;
  await page.context().setOffline(false);
  await expect.poll(() => api.changeCalls.length, { timeout: 75_000 }).toBeGreaterThan(abortedCount);
  const next = api.changeCalls.at(-1);
  // 요청 수가 아니라 적용 상태와 커서를 본다(RV059-06).
  await expect.poll(async () => (await ticketState(page, ticket.ticketId)).status, { timeout: 10_000 }).toBe('REFUNDED');
  const applied = await ticketState(page, ticket.ticketId);

  await presentQr(page, await qrOf(key, ticket.ticketId, Date.now()));
  const verdict = await waitVerdict(page);
  const pass =
    next?.aborted === false &&
    next?.after === '10' &&
    applied.status === 'REFUNDED' &&
    resultOf(verdict.text) === 'REJECT' &&
    verdict.text.includes('취소');
  writeRun('o-t40-changes.json', {
    scenario: 'O-T40-c',
    pass,
    calls: api.changeCalls.length,
    aborted: api.changeCalls.filter((c) => c.aborted).length,
    nextAfter: next?.after,
    appliedStatus: applied.status,
    verdict: verdict.text,
  });
  expect(pass).toBe(true);
});

test('O-T40 전환 앞뒤 판정이 오류·결과 없음 0건, 150ms, 멈춘 시간 0초, 큐 0을 지킨다', async () => {
  test.setTimeout(30_000);
  const runs = [1, 2, 3].map((r) => readRun(`o-t40-a-r${r}.json`));
  const verdicts = runs.map((run) => judgeTransition(run));
  const variants = ['o-t40-upload.json', 'o-t40-changes.json'].map((f) => readRun(f));
  const failed = verdicts.filter((v) => !v.pass);
  writeRun('o-t40-summary.json', { verdicts, variants });
  expect(failed, failed.map((v) => v.reasons.join(' / ')).join('\n')).toHaveLength(0);
  expect(variants.every((v) => v.pass)).toBe(true);
});

// ---------------------------------------------------------------------------
// O-T41 — 레인 처리량(온라인·오프라인 10분씩 3회).
// 20명은 동시에 줄을 서는 사람 역할이다. 지나가는 사람마다 새 티켓을 쓴다.
// ---------------------------------------------------------------------------

async function runLane(page, { condition, run }) {
  test.setTimeout(20 * 60_000);
  const key = await newKey();
  const maxScans = 420;
  const tickets = Array.from({ length: maxScans }, (_, i) => ticketOf(ticketId(2000 + i), key));
  const api = await boot(page, { tickets, key });
  const bootId = await bootIdOf(page);
  if (condition === 'offline') {
    api.offline = true;
    await page.context().setOffline(true);
    await expect.poll(() => onlineState(page), { timeout: 5_000 }).toBe(false);
  }
  const onlineAtStart = await onlineState(page);
  const apiReachableAtStart = await apiReachable(page);

  let cursor = 0;
  const nextTicket = () => tickets[cursor++ % tickets.length];
  const cpu0 = cpuSnapshot();
  // 30초 예열: 세지 않는다.
  const warmupUntil = Date.now() + 30_000;
  while (Date.now() < warmupUntil) await scanOnce(page, key, nextTicket().ticketId);

  const startedAt = new Date().toISOString();
  const windowStart = Date.now();
  const windowEnd = windowStart + K10.laneWindowMs;
  const ticketsSeen = new Set();
  const rolesSeen = new Set();
  const latencies = [];
  let verdicts = 0;
  let nonPass = 0;
  let missing = 0;
  let duplicateTickets = 0;
  let onlineSamples = 0;
  let offlineSamples = 0;
  while (Date.now() < windowEnd) {
    const role = cursor % K10.lanePeople;
    const ticket = nextTicket();
    const online = await onlineState(page);
    try {
      const result = await scanOnce(page, key, ticket.ticketId);
      verdicts++;
      if (online) onlineSamples++;
      else offlineSamples++;
      if (ticketsSeen.has(ticket.ticketId)) duplicateTickets++;
      ticketsSeen.add(ticket.ticketId);
      rolesSeen.add(role);
      latencies.push(result.probe.verdictAt - result.probe.presentedAt);
      if (resultOf(result.probe.text) !== 'PASS') nonPass++;
    } catch {
      missing++;
    }
  }
  const windowMs = Date.now() - windowStart;
  const hostCpuPercent = cpuPercent(cpu0, cpuSnapshot());

  const queueDrainCount = condition === 'offline' ? await queueCount(page) : 0;
  let queueDrainMs = 0;
  if (condition === 'offline') {
    const drainStart = Date.now();
    api.offline = false;
    await page.context().setOffline(false);
    await waitQueueCount(page, 0, 90_000);
    queueDrainMs = Date.now() - drainStart;
  }

  const observed =
    condition === 'offline'
      ? offlineSamples === verdicts && onlineSamples === 0 && onlineAtStart === false && apiReachableAtStart === false
        ? 'offline'
        : 'mixed'
      : onlineSamples === verdicts && offlineSamples === 0 && onlineAtStart === true && apiReachableAtStart === true
        ? 'online'
        : 'mixed';
  const perMinute = throughputPerMinute(verdicts, windowMs);
  const pageReloaded = (await bootIdOf(page)) !== bootId;
  const runData = {
    scenario: 'O-T41',
    condition,
    run,
    startedAt,
    finishedAt: new Date().toISOString(),
    env: envOf(),
    windowMs,
    verdicts,
    perMinute,
    latencies,
    tickets: [...ticketsSeen],
    roles: [...rolesSeen],
    people: K10.lanePeople,
    nonPass,
    missing,
    duplicateTickets,
    network: observed,
    expectedNetwork: condition,
    networkEvidence: {
      observed,
      onlineAtStart,
      apiReachableAtStart,
      onlineSamples,
      offlineSamples,
      queueDrainCount,
    },
    unknownPaths: api.unknownPaths.length,
    pageReloaded,
    hostCpuPercent,
    queueDrainMs,
    queueDrainCount,
    valid: false,
    invalidReasons: [],
  };
  const validity = laneRunValidity(runData);
  runData.valid = validity.valid;
  runData.invalidReasons = validity.reasons;
  writeRun(`o-t41-${condition}-r${run}.json`, runData);
  expect(validity.valid, validity.reasons.join(' / ')).toBe(true);
  expect(observed, validity.reasons.join(' / ')).toBe(condition);
  if (condition === 'offline') expect(queueDrainCount).toBeGreaterThanOrEqual(verdicts);
}

test('K10-O-T41 온라인 r1', async ({ page }) => runLane(page, { condition: 'online', run: 1 }));
test('K10-O-T41 온라인 r2', async ({ page }) => runLane(page, { condition: 'online', run: 2 }));
test('K10-O-T41 온라인 r3', async ({ page }) => runLane(page, { condition: 'online', run: 3 }));
test('K10-O-T41 오프라인 r1', async ({ page }) => runLane(page, { condition: 'offline', run: 1 }));
test('K10-O-T41 오프라인 r2', async ({ page }) => runLane(page, { condition: 'offline', run: 2 }));
test('K10-O-T41 오프라인 r3', async ({ page }) => runLane(page, { condition: 'offline', run: 3 }));

test('O-T41 오프라인 분당 통과 인원 중앙값이 온라인의 90% 이상이다', async () => {
  test.setTimeout(30_000);
  const onlineRuns = [1, 2, 3].map((r) => readRun(`o-t41-online-r${r}.json`));
  const offlineRuns = [1, 2, 3].map((r) => readRun(`o-t41-offline-r${r}.json`));
  const verdict = judgeLane({ onlineRuns, offlineRuns });
  writeRun('o-t41-summary.json', verdict);
  expect(verdict.pass, verdict.reasons.join(' / ')).toBe(true);
});
