// F021-E2E(F-02-1 OPS-300, 계획 9절 '실제 서버'·14절 2): 받는 쪽 넷(admission-ctrl 리더 하나, purchase-svc 파드 둘, queue-svc 파드 하나)을 각자의 시작 함수로
// 실제로 띄우고, ops-svc가 진짜 저장소(DrizzleCommandStore, PostgreSQL 18)·진짜 gRPC 보내기(GrpcControlSender)·환경 값 주소(controlTargetsFromEnv)로
// 명령 1·2·3·11을 보내 받는 쪽 저장소의 값·판·명령 칸과 ops 상세의 delivery를 본다. 받는 쪽은 실제 Valkey 8.1·PostgreSQL 18을 쓴다.
// 자리 고르기(14절 2): ops-svc 통합 시험이 받는 쪽 원본을 상대 경로로 읽는다(의존 선언을 더하지 않는다, devops §4.4). 타입 검사가 받는 쪽 원본까지 따라가
// 서로 묶이지 않게 시작 함수는 계산한 경로의 동적 가져오기로 읽고, 부르는 꼴만 이 파일에 적는다. 실행 전에 받는 쪽 의존 패키지 dist가 있어야 한다
// (pnpm exec turbo run build --filter=@peaket/purchase-svc^... --filter=@peaket/queue-svc^... --filter=@peaket/admission-ctrl^...).
// 명령 7(LOBBY_BANNER)은 ops 명령 params 꼴이 정본에 없어 이 파일에서 보내지 않는다(받는 쪽은 queue-svc f021-queue-notice-control이 본다, 계획 '10. 실패 확인'의 빈칸).
import 'reflect-metadata';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDatabase, createHotRedis, createService, type Database, fakeClock, type HotRedis, systemClock } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { controlTargetsFromEnv } from '../src/adapters/control-targets.js';
import { GrpcControlSender } from '../src/adapters/grpc-control-sender.js';
import { AppModule } from '../src/app.module.js';
import { type Command, type CommandType, ControlDispatcher, DrizzleCommandStore } from '../src/modules/commands/index.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { controlClient, freePort } from '../../queue-svc/test-int/control-client.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { adminAccountsForCommands } from './reauth.js';

type StartFn = (o: { env: Record<string, string | undefined>; logDestination?: Writable }) => Promise<{ close(): Promise<void> }>;
const SERVICES = fileURLToPath(new URL('../../', import.meta.url));
const startOf = async (svc: string): Promise<StartFn> => ((await import(pathToFileURL(join(SERVICES, svc, 'src', 'start.ts')).href)) as { start: StartFn }).start;
const sink = () => new Writable({ write: (_c, _e, cb) => cb() });
const REQUESTER = '0193a000-0000-7000-8000-0000000000f3';
const identity = new FakeIdentity();

let pgc: PostgresContainer;
let opsDb: Database;
let purchaseAdmin: pg.Client;
let valkeyStop: () => void;
let redis: HotRedis;
let seatDir: string;
let resultDir: string;
const running: { close(): Promise<void> }[] = [];
let addrs: { purchase: string[]; queue: string[]; admission: string[] };
let dispatcher: ControlDispatcher;
let store: DrizzleCommandStore;
let ops: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  // 실제 Valkey(대기열·좌석 Redis를 한 서버로. 키 이름이 겹치지 않는다)
  const { startValkey } = (await import(pathToFileURL(join(SERVICES, 'queue-svc', 'test-int', 'valkey.ts')).href)) as { startValkey: () => Promise<{ url: string; stop(): void }> };
  const [p, v] = await Promise.all([startPostgres(), startValkey()]);
  pgc = p;
  valkeyStop = v.stop;
  redis = await createHotRedis({ url: v.url });
  await migrateOps(pgc.url);
  opsDb = createDatabase({ url: pgc.url, applicationName: 'ops-svc-f021-e2e' });
  const root = new pg.Client({ connectionString: pgc.url });
  await root.connect();
  await root.query('create database purchase_f021');
  await root.end();
  const purchaseUrl = pgc.url.replace(/\/peaket$/, '/purchase_f021');
  const { migratePurchase } = (await import(pathToFileURL(join(SERVICES, 'purchase-svc', 'scripts', 'migrate.mjs')).href)) as { migratePurchase: (url: string) => Promise<unknown> };
  await migratePurchase(purchaseUrl);
  purchaseAdmin = new pg.Client({ connectionString: purchaseUrl });
  await purchaseAdmin.connect();
  seatDir = await mkdtemp(join(tmpdir(), 'peaket-f021-e2e-seat-'));
  resultDir = await mkdtemp(join(tmpdir(), 'peaket-f021-e2e-batch-'));

  const common = async (pod: string) => ({
    PEAKET_ENV: 'ci',
    PEAKET_POD: pod,
    HOSTNAME: pod,
    PEAKET_CONTROL_GRPC_HOST: '127.0.0.1',
    PORT: String(await freePort()),
    PEAKET_MANAGEMENT_PORT: String(await freePort()),
    PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
    PEAKET_LOG_LEVEL: 'fatal',
  });
  const ecdhJwk = (() => {
    const j = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' }) as Record<string, string>;
    return { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d!, kid: 'it-f021-e2e' };
  })();
  const admissionPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const admissionJwk = { ...(admissionPair.privateKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'it-f021-e2e-q' };
  const admissionPublic = { ...(admissionPair.publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'it-f021-e2e-q' };

  addrs = { purchase: [], queue: [], admission: [] };
  const purchaseStart = await startOf('purchase-svc');
  for (const pod of ['purchase-e2e-1', 'purchase-e2e-2']) {
    const port = await freePort();
    running.push(
      await purchaseStart({
        env: {
          ...(await common(pod)),
          PEAKET_SEAT_REDIS_URL: v.url,
          PEAKET_DATABASE_URL: purchaseUrl,
          PEAKET_ORDER_CONSENT_VERSION: 'f021-e2e',
          PEAKET_ADMISSION_JWKS: JSON.stringify({ keys: [{ ...admissionPublic, alg: 'ES256', use: 'sig' }] }),
          PEAKET_ADMISSION_ISSUER: 'https://queue.peaket.example',
          PEAKET_PURCHASE_ECDH_KEY: JSON.stringify(ecdhJwk),
          PEAKET_SEATMAP_DIR: seatDir,
          PEAKET_PAYMENT_GRPC_ADDR: '127.0.0.1:1',
          PEAKET_TICKET_GRPC_ADDR: '127.0.0.1:1',
          PEAKET_GRPC_PORT: String(await freePort()),
          PEAKET_GRPC_HOST: '127.0.0.1',
          PEAKET_PURCHASE_CONTROL_GRPC_PORT: String(port),
        },
        logDestination: sink(),
      }),
    );
    addrs.purchase.push(`127.0.0.1:${port}`);
  }
  const queuePort = await freePort();
  running.push(
    await (await startOf('queue-svc'))({
      env: {
        ...(await common('queue-e2e-1')),
        PEAKET_QUEUE_REDIS_URL: v.url,
        PEAKET_QUEUE_TOKEN_KEY: `k1:${Buffer.alloc(32, 3).toString('base64')}`,
        PEAKET_ADMISSION_TOKEN_KEY: JSON.stringify(admissionJwk),
        PEAKET_ADMISSION_TOKEN_ISSUER: 'https://queue.peaket.example',
        PEAKET_GRPC_PORT: String(await freePort()),
        PEAKET_GRPC_HOST: '127.0.0.1',
        PEAKET_QUEUE_CONTROL_GRPC_PORT: String(queuePort),
      },
      logDestination: sink(),
    }),
  );
  addrs.queue.push(`127.0.0.1:${queuePort}`);
  const admissionPort = await freePort();
  running.push(
    await (await startOf('admission-ctrl'))({
      env: {
        ...(await common('admission-e2e-1')),
        PEAKET_QUEUE_REDIS_URL: v.url,
        PEAKET_BATCH_RESULT_DIR: resultDir,
        PEAKET_TEST_BATCH_RANDOMNESS: Buffer.alloc(32, 5).toString('base64'),
        PEAKET_ADMISSION_CONTROL_GRPC_PORT: String(admissionPort),
      },
      logDestination: sink(),
    }),
  );
  addrs.admission.push(`127.0.0.1:${admissionPort}`);
  // admission-ctrl이 메모리 Lease로 리더가 될 때까지 기다린다(쓰지 않는 회차에 명령 2를 보내 본다)
  const probe = controlClient(addrs.admission[0]!);
  let pv = 1;
  await expect
    .poll(
      () =>
        probe.apply({ commandId: randomUUID(), scope: randomUUID(), kind: 'CONTROL_KIND_ADMISSION_PAUSE', version: pv++, desiredStateJson: '{"paused":false,"expiresAtMs":null}' }).then(
          () => 'leader',
          (e: { details?: string }) => String(e.details),
        ),
      { timeout: 30_000, interval: 200 },
    )
    .toBe('leader');
  probe.close();

  store = new DrizzleCommandStore(opsDb);
  const targets = controlTargetsFromEnv({
    PEAKET_ENV: 'ci',
    PEAKET_PURCHASE_CONTROL_GRPC_ADDRS: addrs.purchase.join(','),
    PEAKET_QUEUE_CONTROL_GRPC_ADDRS: addrs.queue.join(','),
    PEAKET_ADMISSION_CONTROL_GRPC_ADDRS: addrs.admission.join(','),
  });
  dispatcher = new ControlDispatcher({
    store,
    targets,
    senderFor: (service: string, address: string) => new GrpcControlSender({ address, dependency: `${service}-control` }),
    clock: systemClock,
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  });
  ops = await createService({
    name: 'ops-svc',
    module: AppModule.register({ database: opsDb, adminAccounts: adminAccountsForCommands }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: Date.now() }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
}, 300_000);

afterAll(async () => {
  await ops?.close().catch(() => undefined);
  for (const r of running.reverse()) await r.close().catch(() => undefined);
  await purchaseAdmin?.end().catch(() => undefined);
  await opsDb?.close().catch(() => undefined);
  await redis?.close();
  valkeyStop?.();
  pgc?.stop();
  for (const d of [seatDir, resultDir]) if (d) await rm(d, { recursive: true, force: true });
});

async function hash(key: string): Promise<Record<string, string>> {
  const raw = (await redis.command(['HGETALL', key], { key })) as unknown;
  if (Array.isArray(raw)) {
    const o: Record<string, string> = {};
    for (let i = 0; i + 1 < raw.length; i += 2) o[String(raw[i])] = String(raw[i + 1]);
    return o;
  }
  return Object.fromEntries(Object.entries((raw ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}
const send = async (type: CommandType, params: Record<string, unknown>, eventId?: string): Promise<{ before: number; final: Command }> => {
  const before = Date.now();
  const c = await store.create({ commandId: randomUUID(), type, reason: '온세일 대응(실제 연결 시험)', params, requestedBy: REQUESTER, requestedRole: 'commander', nowMs: Date.now(), approvalMode: 'ONE', ...(eventId ? { eventId } : {}) });
  const final = await dispatcher.dispatch(await store.markDispatched(c.commandId, Date.now()));
  return { before, final };
};
const delivery = async (commandId: string) => {
  const r = await ops.http.inject({ method: 'GET', url: `/v1/ops/commands/${commandId}`, headers: identity.ops('commander') });
  expect(r.statusCode).toBe(200);
  return (JSON.parse(r.payload) as { delivery?: unknown }).delivery;
};

describe('F021-E2E ops-svc → 실제 받는 쪽 넷', () => {
  test('F021-E2E ① 명령 1·2는 admission-ctrl 리더의 q:{event:E}:ctl에 같은 판·명령 칸으로 서고 ACKED다', async () => {
    const e = randomUUID();
    const target = await send('ADMISSION_TARGET', { eventId: e, target: 3_200 }, e);
    const pause = await send('ADMISSION_PAUSE', { eventId: e }, e);
    expect([target.final.state, pause.final.state]).toEqual(['ACKED', 'ACKED']);
    const row = await hash(`q:{event:${e}}:ctl`);
    expect(row).toMatchObject({ target: '3200', targetCmd: target.final.commandId, admitPaused: '1', admitCmd: pause.final.commandId });
    expect(Number(row.targetRev)).toBeGreaterThanOrEqual(target.before);
    expect(Number(row.admitRev)).toBeGreaterThanOrEqual(pause.before);
    expect(await delivery(target.final.commandId)).toEqual({ kind: 'ACK', ackedCount: 1, targetCount: 1, unackedTargets: [] });
  }, 60_000);

  test('F021-E2E ② 명령 3은 purchase-svc 두 파드·admission-ctrl·queue-svc에 같은 판으로 서고, 네 대상 모두 ack해야 ACKED다', async () => {
    const e = randomUUID();
    const { before, final } = await send('KILL_SWITCH', { scope: 'EVENT', eventIds: [e] });
    expect(final.state).toBe('ACKED');
    const seat = await hash(`s:{event:${e}}:ctl`);
    const queue = await hash(`q:{event:${e}}:notice`);
    const leader = await hash(`q:{event:${e}}:ctl`);
    const { rows } = await purchaseAdmin.query<{ paused: boolean; paused_revision: string; paused_command_id: string }>(
      "select paused, paused_revision::text, paused_command_id::text from sale_control where scope = 'EVENT' and event_id = $1",
      [e],
    );
    const rev = seat.pausedRev;
    expect(Number(rev)).toBeGreaterThanOrEqual(before);
    expect({ seat: [seat.paused, seat.pausedRev, seat.pausedCmd], queue: [queue.paused, queue.pausedRev, queue.pausedCmd], leader: [leader.paused, leader.pausedRev, leader.pausedCmd], db: rows[0] }).toEqual({
      seat: ['1', rev, final.commandId],
      queue: ['1', rev, final.commandId],
      leader: ['1', rev, final.commandId],
      db: { paused: true, paused_revision: rev, paused_command_id: final.commandId },
    });
    expect(await delivery(final.commandId)).toEqual({ kind: 'ACK', ackedCount: 4, targetCount: 4, unackedTargets: [] });
  }, 60_000);

  test('F021-E2E ③ 명령 11은 admission-ctrl의 q:{admission}:ctl autoStopped로 서고 ACKED다', async () => {
    const { before, final } = await send('AUTOMATION_STOP', {});
    expect(final.state).toBe('ACKED');
    const row = await hash('q:{admission}:ctl');
    expect(row).toMatchObject({ autoStopped: '1', autoStoppedCmd: final.commandId });
    expect(Number(row.autoStoppedRev)).toBeGreaterThanOrEqual(before);
  }, 60_000);
});
