// 시작 파일 시험(BUILD_ORDER PRF-215, ADR-0262 결과 '조립을 시험 조립과 따로 띄워 본다', docs/architecture.md §8.6 '자주 놓친 결함').
// 서비스 넷의 dist/main.js와 합본의 dist/main.js를 운영 시작 명령 그대로 자식 프로세스로 띄워 실제 Valkey 8.1·PostgreSQL 18에 붙인다.
// 환경 값은 kind 무대와 같은 함수(tools/local/v1-stage.mjs의 v1Keys·v1EnvFiles)로 만들고 포트·주소만 이 PC 값으로 바꾼다.
// 본다: /ready가 200이 되고, 앱 포트가 답하며, /metrics에 그 서비스의 지표가 있고, SIGTERM이면 코드 0으로 스스로 끝나며, 로그에 시험 키가 없다.
// 합본은 서비스 넷을 한 프로세스에 띄워 관리 포트 하나로 /ready·/metrics를 모으고, 입구부터 반대 차례로 닫는다. PEAKET_ENV가 local·ci가 아니면 뜨지 않는다.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ensurePurchaseOutboxPartitions, ensureSeatHoldPartitions, migratePurchase } from '../../purchase-svc/scripts/migrate.mjs';
import { migratePayment } from '../../payment-svc/scripts/migrate.mjs';
import { createDatabase, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { envFileText, v1EnvFiles, v1Keys } from '../../../tools/local/v1-stage.mjs';
import { build, freePort, logLines, type Postgres, type Running, SERVICES_DIR, sigterm, spawnMain, startPostgres, startValkey, type Container, waitReady } from './support.js';

type Svc = 'payment-svc' | 'purchase-svc' | 'admission-ctrl' | 'queue-svc';
const SERVICES: Svc[] = ['payment-svc', 'purchase-svc', 'admission-ctrl', 'queue-svc'];
/** 서비스마다 그 서비스만 내는 지표 묶음 */
const OWN_METRIC: Record<Svc, RegExp> = {
  'payment-svc': /^# TYPE payment_confirm_commands_total counter$/m,
  'purchase-svc': /^# TYPE seat_lua_errors_total counter$/m,
  'admission-ctrl': /^# TYPE admission_loop_duration_seconds histogram$/m,
  'queue-svc': /^# TYPE queue_admit_before_turn_total counter$/m,
};

let queueRedis: Container;
let seatRedis: Container;
let pgc: Postgres;
let purchaseDb: string;
let paymentDb: string;
let work: string;
const keys = v1Keys();
/** 로그에 실리면 안 되는 시험 키 값 */
const secrets = (): string[] => [keys.queueTokenKey.split(':')[1], keys.admission.privateJwk.d, keys.ecdh.privateJwk.d, keys.pgSim.secretKey, keys.batchRandomness].filter((s): s is string => typeof s === 'string' && s.length > 0);

beforeAll(async () => {
  queueRedis = startValkey();
  seatRedis = startValkey();
  pgc = await startPostgres();
  purchaseDb = await pgc.database('bundle_purchase');
  paymentDb = await pgc.database('bundle_payment');
  await migratePurchase(purchaseDb);
  await ensureSeatHoldPartitions(purchaseDb);
  await ensurePurchaseOutboxPartitions(purchaseDb);
  await migratePayment(paymentDb);
  const payment = createDatabase({ url: paymentDb, applicationName: 'bundle-it-migrate', max: 1 });
  try {
    await ensureOutboxPartitions(payment, systemClock);
  } finally {
    await payment.close();
  }
  work = mkdtempSync(join(tmpdir(), 'peaket-bundle-it-'));
}, 300_000);

afterAll(() => {
  queueRedis?.stop();
  seatRedis?.stop();
  pgc?.stop();
  if (work) rmSync(work, { recursive: true, force: true });
});

/** 서비스마다 다른 빈 포트(합본 관리 포트 하나를 더한다) */
async function ports() {
  const p = async () => ({ app: await freePort(), management: await freePort() });
  return { bundleManagement: await freePort(), 'queue-svc': { ...(await p()), grpc: await freePort() }, 'purchase-svc': await p(), 'admission-ctrl': await p(), 'payment-svc': { ...(await p()), grpc: await freePort() } };
}

/** 무대와 같은 함수로 만든 서비스별 환경 값(이 PC 주소). 폴더는 실행마다 따로 둔다 */
function envFiles(p: Awaited<ReturnType<typeof ports>>, tag: string): Record<Svc, Record<string, string>> {
  const seatmapDir = join(work, `seatmaps-${tag}`);
  const batchResultDir = join(work, `batch-${tag}`);
  return v1EnvFiles({ keys, queueRedisUrl: queueRedis.url, seatRedisUrl: seatRedis.url, purchaseDatabaseUrl: purchaseDb, paymentDatabaseUrl: paymentDb, seatmapDir, batchResultDir, ports: p, logLevel: 'info' });
}

/** 앱 포트에 닿는지 본다(서비스마다 신원 없이 부를 수 있는 길의 정해진 답) */
async function appAnswers(svc: Svc, port: number): Promise<number> {
  const at = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init).then((r) => r.status);
  if (svc === 'queue-svc') return at('/v1/queues/0193a000-0000-7000-8000-000000000001/segment-states/0.json');
  if (svc === 'purchase-svc') return at('/v1/events/0193a000-0000-7000-8000-000000000001/seatmap-snapshot');
  if (svc === 'payment-svc') return at('/v1/webhooks/toss', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return at('/no-such-route');
}
const EXPECTED_APP: Record<Svc, number> = { 'queue-svc': 404, 'purchase-svc': 401, 'payment-svc': 200, 'admission-ctrl': 404 };

describe('서비스 시작 파일(dist/main.js)', () => {
  test.each(SERVICES.map((s) => [s]))(
    'PRF215_%s 시작 파일은 실제 저장소로 떠서 준비가 되고 앱 포트가 답하며 SIGTERM이면 코드 0으로 스스로 끝난다(로그에 시험 키 없음)',
    async (svc) => {
      const p = await ports();
      const env = envFiles(p, svc)[svc];
      const r: Running = spawnMain(join(SERVICES_DIR, svc), { PEAKET_ENV: 'ci', OTEL_SERVICE_NAME: svc, ...env });
      try {
        await waitReady(r, p[svc].management);
        expect(await appAnswers(svc, p[svc].app)).toBe(EXPECTED_APP[svc]);
        const metrics = await (await fetch(`http://127.0.0.1:${p[svc].management}/metrics`)).text();
        expect(metrics).toMatch(OWN_METRIC[svc]);
        // 다른 서비스의 지표는 없다(시작 파일이 그 서비스만 조립한다)
        for (const other of SERVICES.filter((s) => s !== svc)) expect(metrics, other).not.toMatch(OWN_METRIC[other]);
        const left = await sigterm(r);
        expect(left, r.output().slice(-2000)).toEqual({ code: 0, signal: null });
        const lines = logLines(r.output());
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.every((l) => l.service === svc), '모든 로그 줄이 그 서비스 이름이다').toBe(true);
        for (const s of secrets()) expect(r.output()).not.toContain(s);
      } finally {
        if (!r.gone()) r.child.kill('SIGKILL');
      }
    },
    180_000,
  );
});

describe('한 프로세스 합본(services/bundle dist/main.js)', () => {
  /** 합본 하나를 띄운다(서비스별 환경 파일을 폴더에 쓴다) */
  function spawnBundle(p: Awaited<ReturnType<typeof ports>>, files: Record<Svc, Record<string, string>>, extra: Record<string, string> = {}) {
    // 합본 dist는 서비스 dist의 start.js를 싣는다
    for (const svc of SERVICES) build(join(SERVICES_DIR, svc));
    const dir = mkdtempSync(join(work, 'envs-'));
    for (const svc of SERVICES) writeFileSync(join(dir, `${svc}.env`), envFileText(files[svc]));
    return spawnMain(join(SERVICES_DIR, 'bundle'), {
      PEAKET_ENV: 'ci',
      OTEL_SERVICE_NAME: 'bundle',
      PEAKET_BUNDLE_SERVICES: 'queue-svc,admission-ctrl,purchase-svc,payment-svc',
      PEAKET_BUNDLE_ENV_DIR: dir,
      PEAKET_MANAGEMENT_PORT: String(p.bundleManagement),
      ...extra,
    });
  }

  test(
    'PRF215_합본은 서비스 넷을 한 프로세스에 띄워 관리 포트 하나로 준비·지표를 모으고, 서비스마다 제 앱 포트로 답하며, SIGTERM이면 입구부터 반대 차례로 닫고 코드 0으로 끝난다',
    async () => {
      const p = await ports();
      const files = envFiles(p, 'bundle');
      const r = spawnBundle(p, files);
      try {
        await waitReady(r, p.bundleManagement);
        for (const svc of SERVICES) expect(await appAnswers(svc, p[svc].app), svc).toBe(EXPECTED_APP[svc]);
        const metrics = await (await fetch(`http://127.0.0.1:${p.bundleManagement}/metrics`)).text();
        for (const svc of SERVICES) {
          expect(metrics, svc).toMatch(OWN_METRIC[svc]);
          // 서비스 뼈대 지표는 service 꼬리표로 나뉜다(위에서 앱 포트를 한 번씩 불렀다)
          expect(metrics, svc).toMatch(new RegExp(`^http_server_request_duration_seconds_count\\{[^}]*service="${svc}"`, 'm'));
        }
        // 같은 이름의 지표 묶음은 한 번만 나온다(Prometheus가 두 번째 TYPE 줄을 거절한다)
        const types = [...metrics.matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1]);
        expect(new Set(types).size).toBe(types.length);
        // purchase-svc는 같은 프로세스의 payment-svc 업무 gRPC로 잇는다(대역 경고가 없다)
        expect(r.output()).not.toMatch(/PEAKET_PAYMENT_GRPC_ADDR/);
        const left = await sigterm(r, 60_000);
        expect(left, r.output().slice(-3000)).toEqual({ code: 0, signal: null });
        const lines = logLines(r.output());
        // 합본 로그 줄은 service가 bundle이고 닫은 서비스 이름은 target이다
        const order = lines.filter((l) => l.service === 'bundle' && l.step === 'closed').map((l) => l.target);
        expect(order).toEqual(['queue-svc', 'admission-ctrl', 'purchase-svc', 'payment-svc']);
        // 닫는 데 걸린 시간을 로그에 적는다(종료 유예 60초를 맞추는 근거, 코드 리뷰). 부하 없는 여기서는 몇 초 안이다
        const closed = lines.find((l) => l.service === 'bundle' && l.msg === '합본을 닫았다');
        expect(closed).toBeDefined();
        expect(typeof closed!.closeMs).toBe('number');
        expect(closed!.closeMs as number).toBeLessThan(30_000);
        // 서비스 로그 줄은 제 서비스 이름을 단다(서비스 뼈대 로거가 서비스마다 있다)
        for (const svc of SERVICES) expect(lines.some((l) => l.service === svc), svc).toBe(true);
        for (const s of secrets()) expect(r.output()).not.toContain(s);
      } finally {
        if (!r.gone()) r.child.kill('SIGKILL');
      }
    },
    240_000,
  );

  test.each([['prod'], ['staging'], ['demo']])(
    'PRF215_PEAKET_ENV=%s면 합본은 포트를 열지 않고 코드 1로 끝난다',
    async (PEAKET_ENV) => {
      const p = await ports();
      const r = spawnBundle(p, envFiles(p, `env-${PEAKET_ENV}`), { PEAKET_ENV });
      const left = await Promise.race([r.exited, new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 30_000))]);
      expect(left).toEqual({ code: 1, signal: null });
      expect(r.output()).toMatch(/local·ci에서만 시작한다/);
      await expect(fetch(`http://127.0.0.1:${p.bundleManagement}/livez`)).rejects.toThrow();
    },
    60_000,
  );

  test(
    'PRF215_서비스 하나의 포트가 다른 서비스와 겹치면 아무 서비스도 켜지 않고 코드 1로 끝난다',
    async () => {
      const p = await ports();
      const files = envFiles(p, 'clash');
      files['admission-ctrl'].PORT = files['queue-svc'].PORT!;
      const r = spawnBundle(p, files);
      const left = await Promise.race([r.exited, new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 30_000))]);
      expect(left).toEqual({ code: 1, signal: null });
      expect(r.output()).toMatch(/겹친다: admission-ctrl PORT와 queue-svc PORT|겹친다: queue-svc PORT와 admission-ctrl PORT/);
      expect(r.output()).not.toMatch(/"step":"starting"/);
    },
    60_000,
  );
});

describe('측정 무대의 회차 열기(src/seed.ts)', () => {
  test(
    'PRF215_시드는 합본과 같은 환경 파일로 대기열 일정 사본·회차 목록·좌석 판매 열기·다시 만들기 표시를 정확한 값으로 쓰고, 다시 불러도 좌석 세대를 바꾸지 않는다',
    async () => {
      const { activeEvents, closeEvent, seed } = await import('../src/seed.js');
      const { createHotRedis, systemClock, uuidv7 } = await import('@peaket/platform');
      const p = await ports();
      const files = envFiles(p, 'seed');
      const dir = mkdtempSync(join(work, 'seed-envs-'));
      for (const svc of SERVICES) writeFileSync(join(dir, `${svc}.env`), envFileText(files[svc]));
      const now = Date.now();
      const eventId = uuidv7(systemClock);
      const startsAtMs = now + 25 * 3600_000 + 7_000;
      const r = { eventId, opensAtMs: now - 30_000, startsAtMs, seatCount: 1_003, batchWindowMs: 1_500, layoutVersion: 12 };
      const first = await seed(r, { envDir: dir });
      expect(first).toEqual({ eventId, saleEndsAtMs: startsAtMs - 86_400_000, seatEpoch: expect.any(Number), created: true });
      const again = await seed(r, { envDir: dir });
      expect(again).toEqual({ ...first, created: false });
      const q = await createHotRedis({ url: queueRedis.url });
      const s = await createHotRedis({ url: seatRedis.url });
      try {
        const cfg = `q:{event:${eventId}}:cfg`;
        const hash = (await q.command(['HGETALL', cfg], { key: cfg })) as string[] | Record<string, string>;
        const fields = Array.isArray(hash) ? Object.fromEntries(hash.flatMap((v, i) => (i % 2 === 0 ? [[v, hash[i + 1]]] : []))) : hash;
        expect(fields).toEqual({ opensAtMs: String(now - 30_000), startsAtMs: String(startsAtMs), lobbyShuffle: '0', openBatch: '1', batchWindowMs: '1500', layoutVersion: '12', rev: '1' });
        expect(Number(await q.command(['PEXPIRETIME', cfg], { key: cfg }))).toBe(startsAtMs);
        // 진행 중 회차 목록에 있고(공연 시작이 뒤), 끝내면 일정 사본을 지우고 입장 제어·좌석 판매 목록에서 빠진다. 다시 끝내도 0이다(코드 리뷰 H1)
        expect(await activeEvents(Date.now(), { envDir: dir })).toContain(eventId);
        expect(await activeEvents(startsAtMs, { envDir: dir })).not.toContain(eventId);
        expect(await closeEvent(eventId, { envDir: dir, settleMs: 50 })).toEqual({ queue: 1, seat: 1 });
        expect(await activeEvents(Date.now(), { envDir: dir })).not.toContain(eventId);
        expect(await closeEvent(eventId, { envDir: dir, settleMs: 50 })).toEqual({ queue: 0, seat: 0 });
        // 끝낸 회차는 목록에 없고 일정 사본도 없다(좌석 키는 수명까지 남는다)
        expect(Number(await q.command(['EXISTS', cfg], { key: cfg }))).toBe(0);
        expect(await q.command(['ZSCORE', 'q:{admission}:events', eventId], { key: 'q:{admission}:events' })).toBeNull();
        expect(Number(await s.command(['SISMEMBER', 's:ctl:events', eventId], { key: 's:ctl:events' }))).toBe(0);
        const epochKey = `s:{event:${eventId}}:epoch`;
        const epoch = (await s.command(['HGETALL', epochKey], { key: epochKey })) as string[] | Record<string, string>;
        const ep = Array.isArray(epoch) ? Object.fromEntries(epoch.flatMap((v, i) => (i % 2 === 0 ? [[v, epoch[i + 1]]] : []))) : epoch;
        expect(ep).toMatchObject({ epoch: String(first.seatEpoch), node: 'standalone', gen: '1' });
        // 비트맵은 좌석 수만큼(1,003석 → 126바이트), 수명은 판매 종료 + 1일
        const bitmap = `s:{event:${eventId}}:bitmap`;
        expect(Number(await s.command(['STRLEN', bitmap], { key: bitmap }))).toBe(126);
        expect(Number(await s.command(['PEXPIRETIME', bitmap], { key: bitmap }))).toBe(startsAtMs - 86_400_000 + 86_400_000);
      } finally {
        await Promise.allSettled([q.close(), s.close()]);
      }
      const db = new pg.Client({ connectionString: purchaseDb });
      await db.connect();
      try {
        expect((await db.query('select event_id, gen from seat_rebuild where event_id = $1', [eventId])).rows).toEqual([{ event_id: eventId, gen: 1 }]);
      } finally {
        await db.end();
      }
    },
    120_000,
  );

  test(
    'PRF215_코드리뷰H1_queue-svc가 일정 사본을 읽을 때마다 회차를 진행 중 목록에 다시 넣어도(redis-event-schedules.ts), 끝낸 회차는 목록에 돌아오지 않는다',
    async () => {
      const { activeEvents, closeEvent, seed } = await import('../src/seed.js');
      const { createHotRedis, systemClock, uuidv7 } = await import('@peaket/platform');
      const p = await ports();
      const files = envFiles(p, 'seed-readd');
      const dir = mkdtempSync(join(work, 'seed-readd-envs-'));
      for (const svc of SERVICES) writeFileSync(join(dir, `${svc}.env`), envFileText(files[svc]));
      const now = Date.now();
      const eventId = uuidv7(systemClock);
      const startsAtMs = now + 25 * 3600_000 + 9_000;
      await seed({ eventId, opensAtMs: now - 30_000, startsAtMs, seatCount: 20, batchWindowMs: 1_500, layoutVersion: 3 }, { envDir: dir });
      // queue-svc 대역: 매 20ms 일정 사본을 읽고, 있으면 목록에 ZADD GT(대기 상태 파일 생성·셔플 커밋 일꾼이 매초 하는 것과 같다)
      const q = await createHotRedis({ url: queueRedis.url });
      const cfg = `q:{event:${eventId}}:cfg`;
      let stop = false;
      const readder = (async () => {
        while (!stop) {
          const at = await q.command(['HGET', cfg, 'startsAtMs'], { key: cfg });
          if (at !== null) await q.command(['ZADD', 'q:{admission}:events', 'GT', String(at), eventId], { key: 'q:{admission}:events' });
          await new Promise((r) => setTimeout(r, 20));
        }
      })();
      try {
        expect(await activeEvents(Date.now(), { envDir: dir })).toContain(eventId);
        await closeEvent(eventId, { envDir: dir });
        await new Promise((r) => setTimeout(r, 1_500));
        expect(await activeEvents(Date.now(), { envDir: dir })).not.toContain(eventId);
        expect(Number(await q.command(['EXISTS', cfg], { key: cfg }))).toBe(0);
      } finally {
        stop = true;
        await readder;
        await q.close();
      }
    },
    60_000,
  );
});
