// F-10-2 이미지 작업 원장의 실제 DB 배선 시험(계획 docs/review/plans/F-10-2.md E4·§3·§5·§7,
// HOT-200, ADR-0148 결정 8, ADR-0257 결정 2). 실제 PostgreSQL 18·core-svc HTTP 앱·작업 큐를 잇는다.
// gRPC 대역은 image-worker 경계만 대신한다. 작업 적기→집기→lease→60초/5초 재시도→10회 DEAD→503 Retry-After→CLEANUP을 본다.
// 시험 먼저: 구현 전에는 image_job 표와 작업 큐 모듈이 없어 실패한다(ADR-0372).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { imageV1Image } from '@peaket/contracts/proto';
import { createDatabase, createService, type Database, ensureOutboxPartitions, fakeClock, systemClock } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { event, place, production, promoter } from '../src/modules/catalog/adapters/db/schema.js';
import { GrpcImageProcessing, LocalFolderImageStore, MemoryCdnInvalidation } from '../src/modules/catalog/index.js';
import { FakeIdentity, testMedia } from '../test/support.js';
import { logSink, multipart } from './media-support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

const P = 'https://peaket.example/problems/';
const WIDTHS = [320, 640, 960, 1280];
const namesFor = (width: number) => WIDTHS.filter((w) => w <= width).flatMap((w) => [`${w}.avif`, `${w}.webp`]);
const reviewNames = (longEdge: number) => (longEdge >= 1280 ? ['240.webp', '1280.webp'] : ['240.webp']);

let pg_: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let svc: Awaited<ReturnType<typeof createService>>;
const clock = fakeClock({ now: Date.parse('2026-11-26T00:00:00Z') });
const identity = new FakeIdentity();
const cdn = new MemoryCdnInvalidation();
const logs = logSink();
const dir = join(tmpdir(), `peaket-image-job-${randomUUID()}`);
const A = randomUUID();
const PLACE = randomUUID();
const PA = randomUUID();
let imagingServer: grpc.Server;
let processing: GrpcImageProcessing;
let store: LocalFolderImageStore;
let jobStore: {
  enqueue(record: { sourceKey: string; kind: string }, now: Date): Promise<unknown>;
  find(sourceKey: string): Promise<Record<string, unknown> | undefined>;
  leaseDue(now: Date, limit: number, leaseMs: number): Promise<Record<string, unknown>[]>;
  save(record: Record<string, unknown>): Promise<void>;
};
let worker: { runOnce(now?: Date): Promise<{ claimed: number; done: number; retrying: number; dead: number }> };
let jobProcessing: { process(q: { sourceKey: string; kind: string; timeoutMs: number }): Promise<Record<string, unknown>> };
let startFailure: string | undefined;
const ready = () => {
  if (startFailure) throw new Error(startFailure);
  if (!jobStore || !worker || !jobProcessing) throw new Error('이미지 작업 큐가 배선되지 않았다');
};

type Reply = { status: string; derivative_keys?: string[]; width?: number; height?: number; reject_reason?: string; skipStaging?: boolean };
const imaging = {
  calls: [] as { source_key: string; kind: string }[],
  answer: undefined as undefined | ((id: string, size: { width: number; height: number }, kind: string) => Reply | 'hang' | grpc.status),
  gate: undefined as undefined | Promise<void>,
};

/** PNG 머리(서명 + IHDR 폭·높이) 뒤에 채움 바이트 */
function png(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b, 0);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return new Uint8Array(b);
}
const idOf = (sourceKey: string) => sourceKey.slice(sourceKey.lastIndexOf('/') + 1);
const prefixOf = (sourceKey: string) => (sourceKey.includes('/review/') ? 'review' : sourceKey.includes('/banner/') ? 'banner' : 'production');
/** core-svc가 다시 보는 형식(RIFF????WEBP / ftyp avif)에 맞는 준비 위치 바이트(production-image.int의 derived()와 같다) */
const derived = (name: string, id: string) =>
  name.endsWith('.webp')
    ? Buffer.concat([Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'), Buffer.from(`${id}:${name}`)])
    : Buffer.concat([Buffer.from('\x00\x00\x00\x1cftypavif\x00\x00\x00\x00', 'latin1'), Buffer.from(`${id}:${name}`)]);

function startImaging(): Promise<number> {
  const def = protoLoader.fromJSON(imageV1Image as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const svcDef = (grpc.loadPackageDefinition(def) as unknown as { peaket: { image: { v1: { ImageService: grpc.ServiceClientConstructor } } } }).peaket.image.v1.ImageService.service;
  imagingServer = new grpc.Server();
  imagingServer.addService(svcDef, {
    ProcessImage: async (call: grpc.ServerUnaryCall<{ source_key: string; kind: string }, Reply>, cb: grpc.sendUnaryData<Reply>) => {
      imaging.calls.push({ source_key: call.request.source_key, kind: call.request.kind });
      if (imaging.gate) await imaging.gate;
      const id = idOf(call.request.source_key);
      const src = readFileSync(join(dir, call.request.source_key));
      const size = { width: src.readUInt32BE(16), height: src.readUInt32BE(20) };
      const ans = imaging.answer?.(id, size, call.request.kind);
      if (ans === 'hang') return;
      if (typeof ans === 'number') return cb({ code: ans, details: 'fake' });
      const prefix = prefixOf(call.request.source_key);
      const names = call.request.kind === 'IMAGE_KIND_REVIEW_PHOTO' ? reviewNames(Math.max(size.width, size.height)) : namesFor(size.width);
      if (!ans?.skipStaging) {
        for (const n of names) {
          mkdirSync(dirname(join(dir, 'staging', prefix, id, n)), { recursive: true });
          writeFileSync(join(dir, 'staging', prefix, id, n), derived(n, id));
        }
      }
      cb(null, ans ?? { status: 'IMAGE_STATUS_ACCEPTED', derivative_keys: names.map((n) => `staging/${prefix}/${id}/${n}`), width: size.width, height: size.height });
    },
  });
  return new Promise((res, rej) => imagingServer.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
}

const partner = () => identity.partner(A, 'partner_member');
async function upload(o: { kind?: string; bytes?: Uint8Array; name?: string } = {}) {
  const body = await multipart(
    { kind: o.kind ?? 'DETAIL', alt: '작업 원장 시험' },
    [{ name: o.name ?? 'a.png', type: 'image/png', bytes: o.bytes ?? png(1200, 1600) }],
  );
  return svc.http.inject({ method: 'POST', url: `/v1/partner/productions/${PA}/images`, headers: { ...partner(), 'content-type': body.contentType, 'x-requested-with': 'peaket-partner' }, payload: body.payload });
}
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const publicFiles = (id: string) => (existsSync(join(dir, 'public', 'production', id)) ? readdirSync(join(dir, 'public', 'production', id)).sort() : []);
const stagingDirs = () => (existsSync(join(dir, 'staging', 'production')) ? readdirSync(join(dir, 'staging', 'production')).filter((d) => readdirSync(join(dir, 'staging', 'production', d)).length > 0) : []);
const quarantineFiles = () => (existsSync(join(dir, 'quarantine', 'production')) ? readdirSync(join(dir, 'quarantine', 'production')) : []);
async function eventually(check: () => unknown, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      await check();
      return;
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

async function waitJob(kind = 'PRODUCTION'): Promise<string> {
  const end = Date.now() + 5_000;
  for (;;) {
    const r = await admin.pool.query<{ source_key: string }>(`select source_key from image_job where kind = $1 order by created_at desc limit 1`, [kind]);
    if (r.rows[0]) return r.rows[0].source_key;
    if (Date.now() > end) throw new Error('image_job 행이 생기지 않았다');
    await new Promise((r2) => setTimeout(r2, 20));
  }
}

beforeAll(async () => {
  pg_ = await startPostgres();
  await migrateCore(pg_.url);
  admin = createDatabase({ url: pg_.url, applicationName: 'core-svc-image-job-test', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg_, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg_, 'core_partner_login', 'core_partner', 8);
  await admin.db.insert(promoter).values({ id: A, legalName: '(주)에이' });
  await admin.db.execute(sql`insert into place (id, name, address, region, created_by) values (${PLACE}, '피켓홀', '서울 어딘가 1', '서울', ${randomUUID()})`);
  await admin.db.insert(production).values({ id: PA, promoterId: A, placeId: PLACE, title: '이미지 작업 시험', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') });
  await admin.db.insert(event).values({ id: randomUUID(), productionId: PA, promoterId: A, openAt: new Date('2027-01-05T11:00:00Z'), startsAt: new Date('2027-02-01T10:00:00Z'), endsAt: new Date('2027-02-01T12:00:00Z') });
  const port = await startImaging();
  processing = new GrpcImageProcessing(`127.0.0.1:${port}`);
  store = new LocalFolderImageStore(dir);
  try {
    // @ts-ignore 구현 전에는 작업 큐 모듈이 없다(시험 먼저, ADR-0372)
    const mod = (await import('../src/modules/catalog/index.js')) as Record<string, any>;
    const JobStore = mod.DrizzleImageJobStore;
    const JobWorker = mod.ImageJobWorker;
    const JobProcessing = mod.ImageJobProcessing;
    if (typeof JobStore !== 'function' || typeof JobWorker !== 'function' || typeof JobProcessing !== 'function') {
      startFailure = 'catalog index에 DrizzleImageJobStore·ImageJobWorker·ImageJobProcessing이 없다';
    } else {
      jobStore = new JobStore(appDb);
      jobProcessing = new JobProcessing({ store: jobStore, clock, waitMs: 10 });
      worker = new JobWorker({ store: jobStore, processing, objects: store, clock });
    }
  } catch (e) {
    startFailure = e instanceof Error ? e.message : String(e);
  }
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, notifyDatabase: appDb, partnerDatabase: partnerDb, media: testMedia({ imageOrigin: 'https://img.peaket.test', processing: jobProcessing as never, store, cdn }) }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' },
    clock,
    logDestination: logs.stream,
    adminAuthz: identity,
  });
}, 180_000);

afterAll(async () => {
  await svc?.close();
  processing?.close();
  imagingServer?.forceShutdown();
  await appDb?.close();
  await partnerDb?.close();
  await admin?.close();
  pg_?.stop();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  imaging.answer = undefined;
  imaging.gate = undefined;
  imaging.calls = [];
  await admin.db.execute(sql`delete from image_job`);
  await admin.db.execute(sql`delete from production_image`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});

describe('F-10-2 이미지 작업 원장 실제 DB 배선', () => {
  test('F-10-2 올리기가 작업을 적고 워커가 집어 결과를 반영하면 201로 끝난다 [ASVS v5.0.0-16.5.3]', async () => {
    ready();
    const p = upload();
    const key = await waitJob();
    const run = await worker.runOnce(new Date(clock.now()));
    expect(run.claimed).toBe(1);
    const r = await p;
    expect(r.statusCode).toBe(201);
    const id = json(r).imageId as string;
    expect(key).toBe(`quarantine/production/${id}`);
    const job = await jobStore.find(key);
    expect(job).toMatchObject({ kind: 'PRODUCTION', status: 'DONE', resultStatus: 'ACCEPTED', attempts: 1, sourceKey: key });
    expect(job!.leaseUntil).toBeNull();
    expect(publicFiles(id)).toEqual([...namesFor(1200)].sort());
    // 게시가 끝나면 격리 원본·준비 위치가 남지 않는다
    await eventually(() => expect({ staging: stagingDirs(), quarantine: quarantineFiles(), public: publicFiles(id) }).toEqual({ staging: [], quarantine: [], public: [...namesFor(1200)].sort() }));
    expect(imaging.calls.at(-1)).toEqual({ source_key: key, kind: 'IMAGE_KIND_PRODUCTION' });
  });

  test('F-10-2 검사 대기면 작업을 남기고 503 Retry-After 60으로 답하며 60초 뒤 워커가 다시 맡긴다 [ASVS v5.0.0-16.5.3]', async () => {
    ready();
    imaging.answer = () => ({ status: 'IMAGE_STATUS_SCAN_PENDING' });
    const p = upload();
    const key = await waitJob();
    await worker.runOnce(new Date(clock.now()));
    const pending = await p;
    expect([pending.statusCode, pending.headers['retry-after']]).toEqual([503, '60']);
    const job = await jobStore.find(key);
    expect(job).toMatchObject({ status: 'RETRYING', rejectReason: 'SCAN_PENDING', attempts: 1 });
    expect((job!.nextAttemptAt as Date).getTime()).toBe(clock.now() + 60_000);
    // 원본은 남아 워커가 다시 맡긴다
    expect(existsSync(join(dir, key))).toBe(true);
    // 60초가 지나고 검사가 끝나면 같은 작업이 완결된다
    clock.advance(60_000);
    imaging.answer = undefined;
    expect((await worker.runOnce(new Date(clock.now()))).claimed).toBe(1);
    const done = await jobStore.find(key);
    expect(done).toMatchObject({ status: 'DONE', resultStatus: 'ACCEPTED' });
    expect(publicFiles(idOf(key))).toEqual([...namesFor(1200)].sort());
  });

  test('F-10-2 처리 무응답은 5초 뒤 다시 맡기고 열 번이면 DEAD로 두며 요청은 503 Retry-After 30이다 [ASVS v5.0.0-16.5.3]', async () => {
    ready();
    imaging.answer = () => grpc.status.UNAVAILABLE;
    const p = upload();
    const key = await waitJob();
    await worker.runOnce(new Date(clock.now()));
    const down = await p;
    expect([down.statusCode, down.headers['retry-after']]).toEqual([503, '30']);
    let job = await jobStore.find(key);
    expect(job).toMatchObject({ status: 'RETRYING', rejectReason: 'UNAVAILABLE', attempts: 1 });
    expect((job!.nextAttemptAt as Date).getTime()).toBe(clock.now() + 5_000);
    for (let i = 2; i <= 10; i++) {
      clock.advance(5_000);
      expect((await worker.runOnce(new Date(clock.now()))).claimed).toBe(1);
      job = await jobStore.find(key);
    }
    expect(job).toMatchObject({ status: 'DEAD', attempts: 10 });
    expect(job!.nextAttemptAt).toBeNull();
    expect(await publicFiles(idOf(key))).toEqual([]);
  });

  test('F-10-2 워커는 lease가 살아 있는 작업을 다른 바퀴에서 집지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    ready();
    let release!: () => void;
    imaging.gate = new Promise<void>((r) => (release = r));
    const p = upload();
    const key = await waitJob();
    const first = worker.runOnce(new Date(clock.now()));
    // lease가 잡힐 때까지 기다린다
    const end = Date.now() + 5_000;
    for (;;) {
      const j = await jobStore.find(key);
      if (j?.leaseUntil) break;
      if (Date.now() > end) throw new Error('lease가 잡히지 않았다');
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await worker.runOnce(new Date(clock.now()))).claimed).toBe(0);
    release();
    expect((await first).claimed).toBe(1);
    expect((await p).statusCode).toBe(201);
    expect((await jobStore.find(key))!.status).toBe('DONE');
    // lease가 만료된 작업은 다음 바퀴가 다시 집는다
    const staleKey = `cleanup/production/${randomUUID()}`;
    const t0 = clock.now();
    await jobStore.enqueue({ sourceKey: staleKey, kind: 'CLEANUP' }, new Date(t0));
    expect((await jobStore.leaseDue(new Date(t0), 1, 1_000))[0]!.sourceKey).toBe(staleKey);
    expect(await jobStore.leaseDue(new Date(t0 + 999), 1, 1_000)).toEqual([]);
    expect((await jobStore.leaseDue(new Date(t0 + 1_001), 1, 1_000))[0]!.sourceKey).toBe(staleKey);
  });

  test('F-10-2 포스터를 바꾸면 옛 파생본 정리가 CLEANUP 작업으로 원장에 오르고 워커가 지운다 [ASVS v5.0.0-16.5.3]', async () => {
    ready();
    const first = upload({ kind: 'POSTER' });
    await waitJob();
    await worker.runOnce(new Date(clock.now()));
    const firstId = json(await first).imageId as string;
    expect(publicFiles(firstId)).toHaveLength(namesFor(1200).length);
    // 첫 올리기의 #background 정리가 끝난 뒤에야 남은 시험 객체를 써야 경쟁하지 않는다
    await eventually(() => {
      expect(stagingDirs()).not.toContain(firstId);
      expect(quarantineFiles()).not.toContain(firstId);
    });
    // 옛 이미지의 준비·격리 위치에 남은 객체도 CLEANUP이 지우는지 보려고 하나씩 남긴다
    mkdirSync(join(dir, 'staging', 'production', firstId), { recursive: true });
    writeFileSync(join(dir, 'staging', 'production', firstId, '320.webp'), derived('320.webp', firstId));
    mkdirSync(join(dir, 'quarantine', 'production'), { recursive: true });
    writeFileSync(join(dir, 'quarantine', 'production', firstId), Buffer.from('orphan'));
    expect(stagingDirs()).toContain(firstId);
    expect(quarantineFiles()).toContain(firstId);
    const second = upload({ kind: 'POSTER' });
    await waitJob();
    await worker.runOnce(new Date(clock.now()));
    expect((await second).statusCode).toBe(201);
    const cleanupKey = await waitJob('CLEANUP');
    expect(cleanupKey).toBe(`cleanup/production/${firstId}`);
    await worker.runOnce(new Date(clock.now()));
    expect(publicFiles(firstId)).toEqual([]);
    expect(stagingDirs()).not.toContain(firstId);
    expect(quarantineFiles()).not.toContain(firstId);
    expect(await jobStore.find(cleanupKey)).toMatchObject({ status: 'DONE', resultStatus: 'DELETED' });
  });

  test('F-10-2 image_job 표는 실제 DB에서 칸·기본값·core_app 권한을 갖는다 [ASVS v5.0.0-16.5.3]', async () => {
    const cols = await admin.pool.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `select column_name, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'image_job' order by ordinal_position`,
    );
    const got = new Map(cols.rows.map((c) => [c.column_name, c]));
    for (const c of ['id', 'source_key', 'kind', 'status', 'attempts', 'next_attempt_at', 'lease_until', 'result_status', 'width', 'height', 'derivative_keys', 'reject_reason', 'created_at', 'updated_at']) expect(got.has(c), `칸 ${c}`).toBe(true);
    expect([got.get('status')!.is_nullable, got.get('status')!.column_default]).toEqual(['NO', "'PENDING'::text"]);
    expect([got.get('attempts')!.is_nullable, got.get('attempts')!.column_default]).toEqual(['NO', '0']);
    const grants = await admin.pool.query<{ privilege_type: string }>(`select privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'image_job' and grantee = 'core_app'`);
    expect(new Set(grants.rows.map((g) => g.privilege_type))).toEqual(new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']));
  });
});
