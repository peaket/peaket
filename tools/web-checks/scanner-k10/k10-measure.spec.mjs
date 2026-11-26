// F-05-9 K10 측정 실행(계획 docs/review/plans/F-05-9.md §4·§5).
// 이 파일은 측정 창 3에서만 돈다: K10_MEASURE=1. 평소 CI에서는 전부 건너뛴다.
// 실행 방법(측정 창):
//   1) pnpm --filter @peaket/scanner build
//   2) tools/web-checks에서 pnpm install --frozen-lockfile
//   3) K10_MEASURE=1 pnpm exec playwright test -c playwright.scanner-k10.config.mjs
// 결과 JSON은 뿌리 .cache/k10/에 쓴다(측정 담당이 docs/perf-ledger/runs/로 옮긴다).
// 표시: 실측(PC), 무대 'Chromium 흉내(실제 관리형 기기 아님)'.
import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import os from 'node:os';
import { K10, judgeLane, judgeTransition, laneRunValidity, throughputPerMinute, transitionPlan, transitionWindowIndexes } from './k10-lib.mjs';
import {
  fakeApi,
  installFakeDetector,
  installProbe,
  newKey,
  presentQr,
  qrOf,
  queueCount,
  resultOf,
  signedIn,
  startShift,
  ticketId,
  ticketOf,
  uploadedIds,
  waitQueueCount,
  waitVerdict,
} from './fixture.mjs';

const RUN = process.env.K10_MEASURE === '1';
const CACHE = resolve(process.cwd(), '../../.cache/k10');
const BASE_URL = process.env.K10_BASE_URL ?? 'http://127.0.0.1:4104';

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

function writeRun(name, run) {
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(resolve(CACHE, name), JSON.stringify(run, null, 2));
}

function readRun(name) {
  return JSON.parse(readFileSync(resolve(CACHE, name), 'utf8'));
}

/** QR 한 번: 대고, 판정 화면이 뜰 때까지 기다린다. 없으면 던진다. */
async function scanOnce(page, key, id) {
  await presentQr(page, await qrOf(key, id, Date.now()));
  return waitVerdict(page);
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
      expect(resultOf(ok.text)).toBe('PASS');
      if (withExpired) {
        // 보정 밖(±31초) QR은 유효시간이 지난 QR로 거부된다.
        await presentQr(page, await qrOf(key, tickets[1].ticketId, Date.now() + 31_000));
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
  const t1 = ticketId(1);
  const t2 = ticketId(2);
  const tickets = [ticketOf(t1, oldKey), ticketOf(t2, newKeyB)];
  const api = await boot(page, { tickets, key: oldKey });

  // 변경분 전: 옛 키가 통과한다.
  const before = await scanOnce(page, oldKey, t1);
  expect(resultOf(before.text)).toBe('PASS');

  // 다음 60초 변경분에 양도(키 교체)가 온다.
  api.changesReply = () => ({
    changes: [
      { seq: 11, kind: 'KEY_REGISTERED', payload: { ticketId: t1, keyId: newKeyB.keyId, publicKey: newKeyB.publicKey } },
      { seq: 12, kind: 'KEY_REVOKED', payload: { ticketId: t1, keyId: oldKey.keyId } },
    ],
    lastSeq: 12,
  });
  const changesBefore = api.changes;
  await expect.poll(() => api.changes, { timeout: 70_000 }).toBeGreaterThan(changesBefore);

  // 변경분 뒤: 옛 키는 '옛 QR'로 거부되고, 새 키 티켓은 통과한다.
  await presentQr(page, await qrOf(oldKey, t1, Date.now()));
  const revoked = await waitVerdict(page);
  expect(revoked.text).toContain('양도·취소·재발급된 티켓의 옛 QR');
  expect(resultOf(revoked.text)).toBe('REJECT');

  const fresh = await scanOnce(page, newKeyB, t2);
  expect(resultOf(fresh.text)).toBe('PASS');
});

test('K10-S6 새 키를 못 받은 오프라인 스캐너는 키 미반영으로 거부하고 부스·책임자를 안내한다 (O-T25)', async ({ page }) => {
  test.setTimeout(60_000);
  const listed = await newKey();
  const notSynced = await newKey();
  const tickets = [ticketOf(ticketId(1), listed)];
  const api = await boot(page, { tickets, key: listed });
  api.offline = true;
  await page.context().setOffline(true);

  await presentQr(page, await qrOf(notSynced, tickets[0].ticketId, Date.now()));
  const verdict = await waitVerdict(page);
  expect(resultOf(verdict.text)).toBe('REJECT');
  expect(verdict.text).toContain('키가 아직 반영되지 않았습니다');
  expect(verdict.text).toContain('부스나 책임자');
});

// ---------------------------------------------------------------------------
// O-T40 — 온라인 → 오프라인 전환 중 판정.
// ---------------------------------------------------------------------------

/** 300건 전환 실행 하나. 150번째 전에 끊고, 301번째에 다시 켠다. */
async function runTransition(page, run) {
  test.setTimeout(18 * 60_000);
  const key = await newKey();
  const plan = transitionPlan();
  const warmup = Array.from({ length: 10 }, (_, i) => ticketOf(ticketId(1000 + i), key));
  const tickets = [...plan.map((s) => ticketOf(ticketId(s.index), key)), ...warmup];
  const api = await boot(page, { tickets, key });
  const startedAt = new Date().toISOString();
  const cpu0 = cpuSnapshot();
  for (const t of warmup) await scanOnce(page, key, t.ticketId);

  const scans = [];
  let offline = false;
  for (const step of plan) {
    if (!offline && step.index === K10.transitionAt) {
      api.offline = true;
      await page.context().setOffline(true);
      offline = true;
    }
    if (offline && step.phase === 'recovery') {
      api.offline = false;
      await page.context().setOffline(false);
      offline = false;
    }
    let probe;
    let error;
    try {
      await presentQr(page, await qrOf(key, ticketId(step.index), Date.now()));
      probe = await waitVerdict(page);
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 200);
    }
    scans.push({
      index: step.index,
      phase: step.phase,
      presentedAtMs: probe?.presentedAt ?? 0,
      decodedAtMs: probe?.decodedAt ?? 0,
      verdictAtMs: probe?.verdictAt ?? 0,
      presentLatencyMs: probe ? probe.verdictAt - probe.presentedAt : undefined,
      decodeLatencyMs: probe && probe.decodedAt ? probe.verdictAt - probe.decodedAt : undefined,
      result: probe ? resultOf(probe.text) : undefined,
      text: probe?.text,
      error,
    });
  }

  let queueAfter;
  try {
    await waitQueueCount(page, 0, 90_000);
    queueAfter = 0;
  } catch {
    queueAfter = await queueCount(page);
  }
  const uploaded = uploadedIds(api);
  const hostCpuPercent = cpuPercent(cpu0, cpuSnapshot());
  const invalidReasons = [];
  if (Number.isFinite(hostCpuPercent) && hostCpuPercent > 80) invalidReasons.push(`호스트 CPU ${hostCpuPercent.toFixed(0)}% > 80%`);
  const runData = {
    scenario: 'O-T40-a',
    run,
    startedAt,
    finishedAt: new Date().toISOString(),
    env: envOf(),
    scans,
    expectedScans: plan.length,
    warmup: 10,
    transitionWindows: transitionWindowIndexes(),
    queueAfter,
    uploadedIds: uploaded,
    uploadedCount: uploaded.length,
    expectedUploadCount: 10 + plan.length,
    network: 'online->offline->online',
    hostCpuPercent,
    valid: invalidReasons.length === 0,
    invalidReasons,
  };
  writeRun(`o-t40-a-r${run}.json`, runData);
  expect(scans.length).toBe(plan.length);
  expect(queueAfter).toBe(0);
}

test('K10-O-T40-a 전환 사이에 끊기 r1', async ({ page }) => runTransition(page, 1));
test('K10-O-T40-a 전환 사이에 끊기 r2', async ({ page }) => runTransition(page, 2));
test('K10-O-T40-a 전환 사이에 끊기 r3', async ({ page }) => runTransition(page, 3));

test('K10-O-T40-b 업로드가 진행 중일 때 끊겨도 큐에 남아 다시 연결되면 올라간다', async ({ page }) => {
  test.setTimeout(90_000);
  const key = await newKey();
  const tickets = [ticketOf(ticketId(1), key)];
  const api = await boot(page, { tickets, key, apiOptions: { scanDelayMs: 1_500 } });
  await scanOnce(page, key, tickets[0].ticketId);

  await expect.poll(() => api.inFlight, { timeout: 15_000 }).toBe('scans');
  api.offline = true;
  await page.context().setOffline(true);
  await expect.poll(() => api.scanCalls.some((c) => c.aborted), { timeout: 15_000 }).toBe(true);
  const queued = await queueCount(page);

  api.offline = false;
  await page.context().setOffline(false);
  await waitQueueCount(page, 0, 30_000);
  const uploaded = uploadedIds(api);
  const pass = queued === 1 && uploaded.length === 1 && new Set(uploaded).size === 1;
  writeRun('o-t40-upload.json', { scenario: 'O-T40-b', pass, queued, uploadedCount: uploaded.length, aborted: api.scanCalls.filter((c) => c.aborted).length });
  expect(pass).toBe(true);
});

test('K10-O-T40-c 변경분 받기가 진행 중일 때 끊겨도 다음 동기화가 이어진다', async ({ page }) => {
  test.setTimeout(180_000);
  const key = await newKey();
  const tickets = [ticketOf(ticketId(1), key)];
  const api = await boot(page, { tickets, key, apiOptions: { changesDelayMs: 3_000 } });

  await expect.poll(() => api.changeCalls.length, { timeout: 70_000 }).toBeGreaterThan(0);
  await expect.poll(() => api.inFlight, { timeout: 10_000 }).toBe('changes');
  api.offline = true;
  await page.context().setOffline(true);
  await expect.poll(() => api.changeCalls.some((c) => c.aborted), { timeout: 10_000 }).toBe(true);
  const abortedCount = api.changeCalls.length;

  api.offline = false;
  await page.context().setOffline(false);
  await expect.poll(() => api.changeCalls.length, { timeout: 75_000 }).toBeGreaterThan(abortedCount);
  const last = api.changeCalls.at(-1);
  const pass = Boolean(last) && last.aborted === false;
  writeRun('o-t40-changes.json', { scenario: 'O-T40-c', pass, calls: api.changeCalls.length, aborted: api.changeCalls.filter((c) => c.aborted).length });
  expect(pass).toBe(true);
});

test('O-T40 전환 앞뒤 판정이 오류·결과 없음 0건, 150ms, 멈춘 시간 0초, 큐 0을 지킨다', async () => {
  test.setTimeout(30_000);
  const runs = [1, 2, 3].map((r) => readRun(`o-t40-a-r${r}.json`));
  const verdicts = runs.map((run) => judgeTransition(run));
  const failed = verdicts.filter((v) => !v.pass);
  expect(failed, failed.map((v) => v.reasons.join(' / ')).join('\n')).toHaveLength(0);
  const variants = ['o-t40-upload.json', 'o-t40-changes.json'].map((f) => readRun(f));
  expect(variants.every((v) => v.pass)).toBe(true);
  writeRun('o-t40-summary.json', { verdicts, variants });
});

// ---------------------------------------------------------------------------
// O-T41 — 레인 처리량(온라인·오프라인 10분씩 3회).
// 20명은 동시에 줄을 서는 사람 역할이다. 지나가는 사람마다 새 티켓을 쓴다.
// ---------------------------------------------------------------------------

async function runLane(page, { condition, run }) {
  test.setTimeout(18 * 60_000);
  const key = await newKey();
  const maxScans = 420;
  const tickets = Array.from({ length: maxScans }, (_, i) => ticketOf(ticketId(2000 + i), key));
  const api = await boot(page, { tickets, key });
  if (condition === 'offline') {
    api.offline = true;
    await page.context().setOffline(true);
  }

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
  while (Date.now() < windowEnd) {
    const role = cursor % K10.lanePeople;
    const ticket = nextTicket();
    try {
      const probe = await scanOnce(page, key, ticket.ticketId);
      verdicts++;
      ticketsSeen.add(ticket.ticketId);
      rolesSeen.add(role);
      latencies.push(probe.verdictAt - probe.presentedAt);
      if (resultOf(probe.text) !== 'PASS') nonPass++;
    } catch {
      missing++;
    }
  }
  const windowMs = Date.now() - windowStart;
  const hostCpuPercent = cpuPercent(cpu0, cpuSnapshot());

  let queueDrainMs = 0;
  let queueDrainCount = 0;
  if (condition === 'offline') {
    queueDrainCount = await queueCount(page);
    const drainStart = Date.now();
    api.offline = false;
    await page.context().setOffline(false);
    await waitQueueCount(page, 0, 90_000);
    queueDrainMs = Date.now() - drainStart;
  }

  const perMinute = throughputPerMinute(verdicts, windowMs);
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
    network: condition,
    expectedNetwork: condition,
    pageReloaded: false,
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
