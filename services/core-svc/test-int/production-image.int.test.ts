// 공연 이미지 올리기·고치기·지우기와 공연 상세 이미지 칸 통합 시험(BUILD_ORDER HOT-190, ADR-0257 결정 1~3, docs/data.md production_image·§5 마지막 줄).
// 실제 PostgreSQL 18 컨테이너, 실제 core-svc HTTP 앱(운영과 같은 권한의 DB 사용자 core_app·core_partner, 행 보안), 로컬 폴더 이미지 저장소,
// 시험 안의 ImageService gRPC 서버(image-worker는 HOT-200이라 이 경계만 대역이다)를 잇는다. 대역은 같은 폴더의 격리 원본을 읽고 준비 위치에 파생본 여덟 개를 쓴다.
// 처리 결과(폭·높이)는 PNG 머리(IHDR)에서 읽고, 시험마다 답을 바꿀 수 있다(호출 수를 센다).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { imageV1Image } from '@peaket/contracts/proto';
import { CreatePartnerProductionImageResponse, UpdatePartnerProductionImageResponse } from '@peaket/contracts/openapi/partner';
import { GetEventResponse } from '@peaket/contracts/openapi/catalog';
import { createDatabase, createService, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { event, production, productionImage, promoter } from '../src/modules/catalog/adapters/db/schema.js';
import { GrpcImageProcessing, LocalFolderImageStore, MemoryCdnInvalidation } from '../src/modules/catalog/index.js';
import { DrizzleProductionMedia } from '../src/modules/catalog/adapters/db/drizzle-production-media.js';
import { FakeIdentity, testMedia } from '../test/support.js';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import pg from 'pg';
import { fakeClock } from '@peaket/platform';
import type { ImageObjectStore } from '../src/modules/catalog/domain/media-ports.js';
import { connectionCounter, logSink, multipart } from './media-support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

const ORIGIN = 'https://img.peaket.test';
const P = 'https://peaket.example/problems/';
const MB = 1024 * 1024;
const NAMES = [320, 640, 960, 1280].flatMap((w) => [`${w}.avif`, `${w}.webp`]);

let pg_: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let svc: Awaited<ReturnType<typeof createService>>;
const clock = fakeClock({ now: Date.parse('2026-11-10T00:00:00Z') });
let store: TestStore;
let httpPort = 0;
let processing: GrpcImageProcessing;
const logs = logSink();
const cdn = new MemoryCdnInvalidation();
const identity = new FakeIdentity();
const dir = join(tmpdir(), `peaket-img-${randomUUID()}`);
const A = randomUUID();
const B = randomUUID();
const PLACE = randomUUID();
/** 판매 승인된 공연 하나(공연 상세 칸), 이미지를 채워 가는 공연 하나, 다른 파트너 공연 하나 */
const PA = randomUUID();
const PA_EVENT = randomUUID();
const PB = randomUUID();
/** 같은 파트너의 다른 공연(이 공연에 없는 이미지 ID 시험) */
const PA2 = randomUUID();

/** 로컬 폴더 저장소를 감싸 결함을 넣는 시험 저장소 */
class TestStore implements ImageObjectStore {
  readonly inner: LocalFolderImageStore;
  mode: { failDeletes?: boolean; failPutQuarantine?: boolean; failPutPublicAt?: number; hangPublicDelete?: boolean; onPutQuarantine?: () => void } = {};
  puts = 0;
  constructor(root: string) {
    this.inner = new LocalFolderImageStore(root);
  }
  async putQuarantine(k: string, b: Uint8Array) {
    this.mode.onPutQuarantine?.();
    if (this.mode.failPutQuarantine) throw new Error('격리 쓰기 실패(시험)');
    return this.inner.putQuarantine(k, b);
  }
  async deleteQuarantine(k: string) {
    if (this.mode.failDeletes) throw new Error('지우기 실패(시험)');
    return this.inner.deleteQuarantine(k);
  }
  readStaging(k: string) {
    return this.inner.readStaging(k);
  }
  stagingSize(k: string) {
    return (this.inner as unknown as { stagingSize: (k: string) => Promise<number | undefined> }).stagingSize(k);
  }
  async deleteStaging(k: string) {
    if (this.mode.failDeletes) throw new Error('지우기 실패(시험)');
    return this.inner.deleteStaging(k);
  }
  async putPublic(k: string, b: Uint8Array, t: string) {
    this.puts++;
    if (this.mode.failPutPublicAt === this.puts) throw new Error('게시 실패(시험)');
    void t;
    return this.inner.putPublic(k, b);
  }
  async deletePublic(k: string) {
    if (this.mode.hangPublicDelete) return new Promise<void>(() => {});
    if (this.mode.failDeletes) throw new Error('지우기 실패(시험)');
    return this.inner.deletePublic(k);
  }
}

type Reply = { status: string; derivative_keys?: string[]; width?: number; height?: number; reject_reason?: string; skipStaging?: boolean };
/** 처리 대역: 받은 요청과 다음 답(없으면 PNG 머리의 크기로 받는다) */
const imaging = {
  calls: [] as { source_key: string; kind: string }[],
  answer: undefined as undefined | ((id: string, size: { width: number; height: number }) => Reply | 'hang' | grpc.status),
  gate: undefined as undefined | Promise<void>,
  /** 받은 호출의 데드라인까지 남은 ms */
  deadlines: [] as number[],
  /** 파생본 내용을 바꾼다(이름 → 내용) */
  content: undefined as undefined | ((name: string) => Uint8Array | string),
};
/** 형식에 맞는 파생본 바이트(WebP RIFF????WEBP, AVIF ftyp avif) */
const derived = (name: string, id: string) =>
  name.endsWith('.webp') ? Buffer.concat([Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'), Buffer.from(`${id}:${name}`)]) : Buffer.concat([Buffer.from('\x00\x00\x00\x1cftypavif\x00\x00\x00\x00', 'latin1'), Buffer.from(`${id}:${name}`)]);
let imagingServer: grpc.Server;

const idOf = (sourceKey: string) => sourceKey.slice('quarantine/production/'.length);
const stagingFile = (id: string, name: string) => join(dir, 'staging', 'production', id, name);
const publicFiles = (id: string) => (existsSync(join(dir, 'public', 'production', id)) ? readdirSync(join(dir, 'public', 'production', id)).sort() : []);
const quarantineFiles = () => (existsSync(join(dir, 'quarantine', 'production')) ? readdirSync(join(dir, 'quarantine', 'production')) : []);
const stagingDirs = () => (existsSync(join(dir, 'staging', 'production')) ? readdirSync(join(dir, 'staging', 'production')).filter((d) => readdirSync(join(dir, 'staging', 'production', d)).length > 0) : []);

/** PNG 머리(서명 + IHDR 폭·높이) 뒤에 채움 바이트 */
function png(width: number, height: number, total = 64): Uint8Array {
  const b = Buffer.alloc(Math.max(total, 33));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b, 0);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return new Uint8Array(b);
}

function startImaging(): Promise<number> {
  const def = protoLoader.fromJSON(imageV1Image as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const svcDef = (grpc.loadPackageDefinition(def) as unknown as { peaket: { image: { v1: { ImageService: grpc.ServiceClientConstructor } } } }).peaket.image.v1.ImageService.service;
  imagingServer = new grpc.Server();
  imagingServer.addService(svcDef, {
    ProcessImage: async (call: grpc.ServerUnaryCall<{ source_key: string; kind: string }, Reply>, cb: grpc.sendUnaryData<Reply>) => {
      imaging.calls.push({ source_key: call.request.source_key, kind: call.request.kind });
      const dl = call.getDeadline();
      imaging.deadlines.push((dl instanceof Date ? dl.getTime() : Number(dl)) - Date.now());
      if (imaging.gate) await imaging.gate;
      const id = idOf(call.request.source_key);
      const src = readFileSync(join(dir, call.request.source_key));
      const size = { width: src.readUInt32BE(16), height: src.readUInt32BE(20) };
      const ans = imaging.answer?.(id, size);
      if (ans === 'hang') return;
      if (typeof ans === 'number') return cb({ code: ans, details: 'fake' });
      // 받으면 준비 위치에 파생본 여덟 개를 쓴다(내용은 이름이 든 바이트)
      if (!ans?.skipStaging) for (const n of NAMES) {
        mkdirSync(dirname(stagingFile(id, n)), { recursive: true });
        writeFileSync(stagingFile(id, n), imaging.content?.(n) ?? derived(n, id));
      }
      cb(null, ans ?? { status: 'IMAGE_STATUS_ACCEPTED', derivative_keys: NAMES.map((n) => `staging/production/${id}/${n}`), width: size.width, height: size.height });
    },
  });
  return new Promise((res, rej) => imagingServer.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
}

beforeAll(async () => {
  pg_ = await startPostgres();
  await migrateCore(pg_.url);
  admin = createDatabase({ url: pg_.url, applicationName: 'core-svc-test', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg_, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg_, 'core_partner_login', 'core_partner', 8);
  await admin.db.insert(promoter).values([
    { id: A, legalName: '(주)에이' },
    { id: B, legalName: '(주)비' },
  ]);
  await admin.db.execute(sql`insert into place (id, name, address, region, created_by) values (${PLACE}, '피켓홀', '서울 어딘가 1', '서울', ${randomUUID()})`);
  await admin.db.insert(production).values([
    { id: PA, promoterId: A, placeId: PLACE, title: 'A 공연', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') },
    { id: PB, promoterId: B, placeId: PLACE, title: 'B 공연', genre: '콘서트' },
    { id: PA2, promoterId: A, placeId: PLACE, title: 'A 두 번째 공연', genre: '콘서트' },
  ]);
  await admin.db.insert(event).values({ id: PA_EVENT, productionId: PA, promoterId: A, openAt: new Date('2027-01-05T11:00:00Z'), startsAt: new Date('2027-02-01T10:00:00Z'), endsAt: new Date('2027-02-01T12:00:00Z') });
  const port = await startImaging();
  processing = new GrpcImageProcessing(`127.0.0.1:${port}`);
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, media: testMedia({ imageOrigin: ORIGIN, processing, store: (store = new TestStore(dir)), cdn }) }),
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

beforeEach(() => {
  imaging.answer = undefined;
  imaging.gate = undefined;
  imaging.content = undefined;
  store.mode = {};
  store.puts = 0;
});

/** 뒤에서 하는 정리(커밋 뒤 지우기·무효화)를 기다린다: 단언이 통과할 때까지 다시 본다 */
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

const partner = (tenant = A) => identity.partner(tenant, 'partner_member');
async function upload(o: { productionId?: string; kind?: string; alt?: string; noAlt?: boolean; order?: string; bytes?: Uint8Array; name?: string; type?: string; headers?: Record<string, string>; xrw?: boolean; fields?: Record<string, string>; extraFiles?: number; raw?: { payload: Buffer; contentType: string } }) {
  const fields: Record<string, string> = { ...(o.kind !== undefined ? { kind: o.kind } : { kind: 'DETAIL' }), ...(o.noAlt ? {} : o.alt !== undefined ? { alt: o.alt } : { alt: '출연진 소개' }), ...(o.order !== undefined ? { order: o.order } : {}), ...o.fields };
  const file = { name: o.name ?? 'image.png', type: o.type ?? 'image/png', bytes: o.bytes ?? png(1200, 1600) };
  const body = o.raw ?? (await multipart(fields, Array.from({ length: 1 + (o.extraFiles ?? 0) }, () => file)));
  return svc.http.inject({
    method: 'POST',
    url: `/v1/partner/productions/${o.productionId ?? PA}/images`,
    headers: { ...(o.headers ?? partner()), 'content-type': body.contentType, ...(o.xrw === false ? {} : { 'x-requested-with': 'peaket-partner' }) },
    payload: body.payload,
  });
}
const patch = (imageId: string, body: unknown, ifMatch?: string, o: { productionId?: string; headers?: Record<string, string> } = {}) =>
  svc.http.inject({ method: 'PATCH', url: `/v1/partner/productions/${o.productionId ?? PA}/images/${imageId}`, headers: { ...(o.headers ?? partner()), 'content-type': 'application/json', ...(ifMatch !== undefined ? { 'if-match': ifMatch } : {}) }, payload: JSON.stringify(body) });
const remove = (imageId: string, o: { productionId?: string; headers?: Record<string, string> } = {}) => svc.http.inject({ method: 'DELETE', url: `/v1/partner/productions/${o.productionId ?? PA}/images/${imageId}`, headers: o.headers ?? partner() });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const rows = (productionId = PA) => admin.db.select().from(productionImage).where(eq(productionImage.productionId, productionId)).orderBy(productionImage.kind, productionImage.displayOrder);
const details = async (productionId = PA) => (await rows(productionId)).filter((r) => r.kind === 'DETAIL').map((r) => [r.id, r.displayOrder, r.version] as const);
/** 지금까지 남은 것이 없는가: 격리 원본·준비 위치 */
const leftovers = () => ({ quarantine: quarantineFiles(), staging: stagingDirs() });
/** 시험 사이 정리: 그 공연의 행과 공개 폴더를 지운다(행만 지우면 공개 파생본이 남는다) */
async function clearImages(productionId = PA): Promise<void> {
  for (const r of await rows(productionId)) rmSync(join(dir, 'public', 'production', r.id), { recursive: true, force: true });
  await admin.db.delete(productionImage).where(eq(productionImage.productionId, productionId));
}

describe('공연 이미지 올리기', () => {
  test('포스터를 올리면 서버가 만든 ID로 원본·파생본 키를 만들고 파생본 여덟 개만 게시하며 원본·준비 위치는 남지 않는다 [ASVS v5.0.0-5.3.2] [ASVS v5.0.0-5.1.1]', async () => {
    await clearImages();
    const calls = imaging.calls.length;
    const cdnCalls = cdn.calls.length;
    const r = await upload({ kind: 'POSTER', alt: '포스터: LUMEN 겨울 콘서트', bytes: png(1200, 1600), name: '../../etc/passwd.png' });
    expect(r.statusCode).toBe(201);
    const out = CreatePartnerProductionImageResponse.parse(json(r));
    const id = out.imageId!;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(json(r)).toEqual({ imageId: id, kind: 'POSTER', alt: '포스터: LUMEN 겨울 콘서트', order: 0, width: 1200, height: 1600, version: 1, url: `${ORIGIN}/production/${id}`, derivatives: Object.fromEntries(NAMES.map((n) => [n, `${ORIGIN}/production/${id}/${n}`])) });
    expect(r.headers.etag).toBe('"1"');
    expect(imaging.calls.slice(calls)).toEqual([{ source_key: `quarantine/production/${id}`, kind: 'IMAGE_KIND_PRODUCTION' }]);
    expect(publicFiles(id)).toEqual([...NAMES].sort());
    expect(readFileSync(join(dir, 'public', 'production', id, '640.webp'))).toEqual(derived('640.webp', id));
    await eventually(() => expect(leftovers()).toEqual({ quarantine: [], staging: [] }));
    expect((await rows()).map((x) => ({ id: x.id, promoterId: x.promoterId, kind: x.kind, alt: x.alt, order: x.displayOrder, width: x.width, height: x.height, version: x.version }))).toEqual([
      { id, promoterId: A, kind: 'POSTER', alt: '포스터: LUMEN 겨울 콘서트', order: 0, width: 1200, height: 1600, version: 1 },
    ]);
    await eventually(() => expect(cdn.calls.slice(cdnCalls)).toEqual([[`production:${PA}`]]));
    // 보낸 파일 이름은 어디에도 쓰지 않는다
    expect(JSON.stringify(await rows()) + logs.text() + r.payload).not.toContain('passwd');
  });

  test('포스터를 다시 올리면 옛 행을 지우고 새 행을 넣으며 옛 파생본을 지운다. 동시에 두 장이 와도 포스터는 하나다 [ASVS v5.0.0-2.3.2]', async () => {
    await clearImages();
    const first = json(await upload({ kind: 'POSTER', bytes: png(900, 1200) })).imageId as string;
    const second = json(await upload({ kind: 'POSTER', bytes: png(1000, 1400) })).imageId as string;
    const now = await rows();
    expect(now.map((x) => [x.id, x.kind, x.width])).toEqual([[second, 'POSTER', 1000]]);
    await eventually(() => expect(publicFiles(first)).toEqual([]));
    expect(publicFiles(second)).toHaveLength(8);
    const [x, y] = await Promise.all([upload({ kind: 'POSTER', bytes: png(1100, 1500) }), upload({ kind: 'POSTER', bytes: png(1101, 1500) })]);
    expect([x.statusCode, y.statusCode]).toEqual([201, 201]);
    const posters = (await rows()).filter((r) => r.kind === 'POSTER');
    expect(posters).toHaveLength(1);
    const kept = posters[0]!.id;
    expect([json(x).imageId, json(y).imageId]).toContain(kept);
    const lost = [json(x).imageId, json(y).imageId, second].filter((i) => i !== kept) as string[];
    await eventually(() => {
      for (const l of lost) expect(publicFiles(l)).toEqual([]);
    });
    expect(publicFiles(kept)).toHaveLength(8);
  });

  test('상세 이미지 10장은 받고 11장째는 409이며 처리 작업을 부르지 않는다 [ASVS v5.0.0-2.3.2]', async () => {
    await clearImages();
    for (let i = 0; i < 10; i++) expect((await upload({ alt: `상세 ${i}` })).statusCode).toBe(201);
    expect((await details()).map((d) => d[1])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const calls = imaging.calls.length;
    const r = await upload({ alt: '상세 10' });
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: `${P}image-limit-exceeded`, status: 409 });
    expect(imaging.calls.length).toBe(calls);
    await eventually(() => expect(leftovers()).toEqual({ quarantine: [], staging: [] }));
    // 포스터는 장수에 들지 않는다
    expect((await upload({ kind: 'POSTER' })).statusCode).toBe(201);
  });

  test('상세 9장일 때 두 장이 함께 와도 공연 행 잠금이 줄을 세워 한 장만 받고, 진 쪽의 게시한 파생본·원본은 지운다 [ASVS v5.0.0-2.3.2]', async () => {
    await clearImages();
    for (let i = 0; i < 9; i++) await upload({ alt: `상세 ${i}` });
    const [x, y] = await Promise.all([upload({ alt: '경합 1' }), upload({ alt: '경합 2' })]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([201, 409]);
    const lost = (x.statusCode === 409 ? x : y) as { payload: string };
    expect(json(lost)).toMatchObject({ type: `${P}image-limit-exceeded` });
    expect((await details()).map((d) => d[1])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // 게시된 공개 파생본은 남은 열 장의 것뿐이다
    const kept = new Set((await rows()).map((r) => r.id));
    const published = readdirSync(join(dir, 'public', 'production')).filter((d) => readdirSync(join(dir, 'public', 'production', d)).length > 0);
    expect(published.filter((d) => !kept.has(d))).toEqual([]);
    await eventually(() => expect(leftovers()).toEqual({ quarantine: [], staging: [] }));
  });

  test('order를 주면 그 자리에 넣고 뒤를 한 칸씩 민다(0부터 빈틈 없이, 넘으면 끝)', async () => {
    await clearImages();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(json(await upload({ alt: `상세 ${i}` })).imageId as string);
    const mid = json(await upload({ alt: '가운데', order: '1' }));
    expect(mid.order).toBe(1);
    const end = json(await upload({ alt: '끝', order: '9' }));
    expect(end.order).toBe(4);
    expect((await details()).map((d) => [d[0], d[1]])).toEqual([
      [ids[0], 0],
      [mid.imageId, 1],
      [ids[1], 2],
      [ids[2], 3],
      [end.imageId, 4],
    ]);
  });

  test('파일 10MB 정확히는 처리하고 1바이트 넘으면 413이며, 본문 상한을 넘는 요청도 이름 붙은 413이고 작업을 부르지 않는다 [ASVS v5.0.0-5.2.1] [ASVS v5.0.0-5.1.1]', async () => {
    await clearImages();
    const calls = imaging.calls.length;
    const at = await upload({ bytes: png(1200, 900, 10 * MB) });
    expect(at.statusCode).toBe(201);
    expect(imaging.calls.length).toBe(calls + 1);
    const over = await upload({ bytes: png(1200, 900, 10 * MB + 1) });
    expect(over.statusCode).toBe(413);
    expect(json(over)).toMatchObject({ type: `${P}image-too-large`, status: 413 });
    const huge = await upload({ raw: await multipart({ kind: 'DETAIL', alt: 'x' }, [{ name: 'a.png', type: 'image/png', bytes: png(1200, 900, 11 * MB) }]) });
    expect(huge.statusCode).toBe(413);
    expect(json(huge)).toMatchObject({ type: `${P}image-too-large` });
    // 파일이 10MB 안이어도 본문 전체가 상한(10MB + 봉투 64KB)을 넘으면 칸을 나누기 전에 413이다
    const padded = await upload({ raw: await multipart({ kind: 'DETAIL', alt: 'x', note: 'x'.repeat(65 * 1024) }, [{ name: 'a.png', type: 'image/png', bytes: png(1200, 900, 10 * MB) }]) });
    expect(padded.statusCode).toBe(413);
    expect(json(padded)).toMatchObject({ type: `${P}image-too-large` });
    expect(imaging.calls.length).toBe(calls + 1);
    await eventually(() => expect(leftovers()).toEqual({ quarantine: [], staging: [] }));
  });

  test('파일 앞부분과 Content-Type·확장자가 다르면 415이고 처리 작업을 부르지 않으며 형식 위장으로 남긴다 [ASVS v5.0.0-5.2.2] [ASVS v5.0.0-16.3.3]', async () => {
    const calls = imaging.calls.length;
    const gif = new TextEncoder().encode(`GIF89a${'x'.repeat(40)}`);
    for (const o of [
      { bytes: png(1200, 900), name: 'a.jpg', type: 'image/jpeg' },
      { bytes: png(1200, 900), name: 'a.png', type: 'image/jpeg' },
      { bytes: png(1200, 900), name: 'a.jpg', type: 'image/png' },
      { bytes: gif, name: 'a.gif', type: 'image/gif' },
      { bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), name: 'a.svg', type: 'image/svg+xml' },
    ]) {
      const r = await upload(o);
      expect(r.statusCode, o.name).toBe(415);
      expect(json(r)).toMatchObject({ type: `${P}image-type-unsupported`, status: 415 });
    }
    expect(imaging.calls.length).toBe(calls);
    expect(logs.lines().filter((l) => l.event === 'image_type_mismatch')).toHaveLength(5);
    expect(logs.lines().filter((l) => l.event === 'image_type_mismatch')[0]).toMatchObject({ kind: 'security', productionId: PA });
  });

  test('처리 결과의 폭·높이를 다시 본다: 포스터 800×1,000은 받고 799·세로=가로·긴 변 20,001·4,000만+1 화소·상세 799는 422이고 아무것도 남지 않는다 [ASVS v5.0.0-2.1.2] [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-1.4.2]', async () => {
    await clearImages();
    expect((await upload({ kind: 'POSTER', bytes: png(800, 1000) })).statusCode).toBe(201);
    const cases: [string, number, number, string][] = [
      ['POSTER', 799, 1000, 'POSTER_SPEC'],
      ['POSTER', 800, 999, 'POSTER_SPEC'],
      ['POSTER', 1200, 1200, 'POSTER_SPEC'],
      ['POSTER', 1000, 20_001, 'PIXEL_LIMIT'],
      ['DETAIL', 8_000, 5_001, 'PIXEL_LIMIT'],
      ['DETAIL', 799, 600, 'DETAIL_SPEC'],
      ['DETAIL', 0, 600, 'PIXEL_LIMIT'],
    ];
    for (const [kind, w, h, reason] of cases) {
      const before = await rows();
      const r = await upload({ kind, bytes: png(w, h) });
      expect({ kind, w, h, status: r.statusCode, body: json(r) }).toMatchObject({ status: 422, body: { type: `${P}image-spec-invalid`, reason } });
      expect(await rows()).toEqual(before);
      await eventually(() => expect(leftovers()).toEqual({ quarantine: [], staging: [] }));
    }
    expect((await upload({ kind: 'DETAIL', bytes: png(20_000, 2_000) })).statusCode).toBe(201);
    expect((await upload({ kind: 'DETAIL', bytes: png(8_000, 5_000) })).statusCode).toBe(201);
  });

  test('처리 작업의 거절 이유를 옮긴다(형식 415·화소 PIXEL_LIMIT·작음 종류별·악성 코드 MALWARE)이고 원본을 지운다. 악성 코드는 보안 사건이다 [ASVS v5.0.0-5.1.1] [ASVS v5.0.0-16.3.3] [ASVS v5.0.0-2.2.3]', async () => {
    const cases: [string, string, number, Record<string, unknown>][] = [
      ['DETAIL', 'IMAGE_REJECT_REASON_UNSUPPORTED_TYPE', 415, { type: `${P}image-type-unsupported` }],
      ['DETAIL', 'IMAGE_REJECT_REASON_TOO_LARGE', 422, { reason: 'PIXEL_LIMIT' }],
      ['POSTER', 'IMAGE_REJECT_REASON_TOO_SMALL', 422, { reason: 'POSTER_SPEC' }],
      ['DETAIL', 'IMAGE_REJECT_REASON_TOO_SMALL', 422, { reason: 'DETAIL_SPEC' }],
      ['DETAIL', 'IMAGE_REJECT_REASON_MALWARE', 422, { reason: 'MALWARE' }],
    ];
    const before = await rows();
    for (const [kind, reason, status, body] of cases) {
      imaging.answer = () => ({ status: 'IMAGE_STATUS_REJECTED', reject_reason: reason });
      const r = await upload({ kind });
      expect({ reason, status: r.statusCode, body: json(r) }).toMatchObject({ status, body });
      await eventually(() => expect(leftovers()).toEqual({ quarantine: [], staging: [] }));
    }
    expect(await rows()).toEqual(before);
    expect(logs.lines().filter((l) => l.event === 'image_malware')).toEqual([expect.objectContaining({ kind: 'security', productionId: PA })]);
  });

  test('파생본 키가 여덟 개가 아니거나 접두사 밖이거나 준비 위치에 없으면 게시하지 않고 503이며 보안 사건으로 남긴다 [ASVS v5.0.0-16.5.3]', async () => {
    const before = await rows();
    const keys = (id: string) => NAMES.map((n) => `staging/production/${id}/${n}`);
    const variants: ((id: string) => string[])[] = [(id) => keys(id).slice(1), (id) => [...keys(id), `staging/production/${id}/2560.webp`], (id) => [...keys(id).slice(1), `production/${id}/320.avif`], (id) => keys(id).map((k) => k.replace(id, randomUUID()))];
    for (const v of variants) {
      imaging.answer = (id, s) => ({ status: 'IMAGE_STATUS_ACCEPTED', derivative_keys: v(id), width: s.width, height: s.height });
      const r = await upload({});
      expect(r.statusCode).toBe(503);
      expect(r.headers['retry-after']).toBe('30');
      expect(json(r)).toMatchObject({ type: `${P}image-processing-unavailable` });
    }
    // 키는 맞지만 준비 위치에 파일이 없다
    imaging.answer = (id, s) => ({ status: 'IMAGE_STATUS_ACCEPTED', derivative_keys: keys(id), width: s.width, height: s.height, skipStaging: true });
    const missing = await upload({});
    expect([missing.statusCode, missing.headers['retry-after']]).toEqual([503, '30']);
    expect(await rows()).toEqual(before);
    const untrusted = logs.lines().filter((l) => l.event === 'image_worker_result_untrusted');
    expect(untrusted.filter((l) => l.why === 'derivative_keys')).toHaveLength(4);
    expect(untrusted.filter((l) => l.why === 'derivative_missing')).toHaveLength(1);
    expect(untrusted[0]).toMatchObject({ kind: 'security', productionId: PA });
    await eventually(() => expect(leftovers()).toEqual({ quarantine: [], staging: [] }));
    // 게시한 것이 없다(남은 행의 것뿐)
    const kept = new Set(before.map((r) => r.id));
    const published = existsSync(join(dir, 'public', 'production')) ? readdirSync(join(dir, 'public', 'production')).filter((d) => readdirSync(join(dir, 'public', 'production', d)).length > 0) : [];
    expect(published.filter((d) => !kept.has(d))).toEqual([]);
  });

  test('검사 결과가 아직 없으면 503 Retry-After 60, 작업이 없거나 답하지 않으면 503 Retry-After 30이다(fail-closed) [ASVS v5.0.0-16.5.3]', async () => {
    await clearImages();
    imaging.answer = () => ({ status: 'IMAGE_STATUS_SCAN_PENDING' });
    const pending = await upload({});
    expect([pending.statusCode, pending.headers['retry-after']]).toEqual([503, '60']);
    imaging.answer = () => grpc.status.UNAVAILABLE;
    const down = await upload({});
    expect([down.statusCode, down.headers['retry-after']]).toEqual([503, '30']);
    imaging.answer = () => ({ status: 'IMAGE_STATUS_UNSPECIFIED' });
    expect((await upload({})).statusCode).toBe(503);
    expect(await rows()).toEqual([]);
    await eventually(() => expect(leftovers()).toEqual({ quarantine: [], staging: [] }));
  });

  test('작업이 답하지 않으면 데드라인 30초에 끊고 503이다(작업은 실제로 불렸다) [ASVS v5.0.0-16.5.3]', async () => {
    imaging.answer = () => 'hang';
    const calls = imaging.calls.length;
    const started = Date.now();
    const r = await upload({});
    expect(Date.now() - started).toBeGreaterThanOrEqual(29_500);
    expect(Date.now() - started).toBeLessThan(32_000);
    expect(imaging.deadlines.at(-1)!).toBeLessThanOrEqual(30_000);
    expect(imaging.calls.length).toBe(calls + 1);
    expect([r.statusCode, r.headers['retry-after']]).toEqual([503, '30']);
    await eventually(() => expect(leftovers()).toEqual({ quarantine: [], staging: [] }));
  }, 45_000);

  test('파트너 multipart 칸막이는 파드마다 넷이고 다섯째(가져오기 포함)는 본문을 읽지 않고 429 server-busy Retry-After 10이며 끝나면 자리가 풀린다', async () => {
    await clearImages();
    let open!: () => void;
    imaging.gate = new Promise<void>((r) => (open = r));
    const calls = imaging.calls.length;
    const four = [0, 1, 2, 3].map((i) => upload({ alt: `동시 ${i}` }));
    try {
      // 넷이 모두 처리 작업에 닿을 때까지 기다린다(고정 시간으로 기다리면 느린 실행에서 흔들린다)
      await eventually(async () => expect(imaging.calls.length).toBe(calls + 4));
      const fifth = await upload({ alt: '다섯째' });
      expect([fifth.statusCode, fifth.headers['retry-after']]).toEqual([429, '10']);
      expect(json(fifth)).toMatchObject({ type: `${P}server-busy`, status: 429 });
      const body = await multipart({ format: 'SVG' }, [{ name: 'a.svg', type: 'image/svg+xml', bytes: new TextEncoder().encode('<svg/>') }]);
      const seat = await svc.http.inject({ method: 'POST', url: `/v1/partner/productions/${PA}/seatmap-imports`, headers: { ...partner(), 'content-type': body.contentType, 'x-requested-with': 'x' }, payload: body.payload });
      expect(seat.statusCode).toBe(429);
    } finally {
      // 단언이 실패해도 자리 넷을 풀어 뒤 시험이 줄줄이 429가 되지 않게 한다
      open();
    }
    expect((await Promise.all(four)).map((r) => r.statusCode)).toEqual([201, 201, 201, 201]);
    expect(imaging.calls.length).toBe(calls + 4);
    expect((await upload({ alt: '풀린 뒤' })).statusCode).toBe(201);
  });

  test('X-Requested-With이 없으면 400이고, 모르는 칸·파일 두 개·틀린 kind·order는 400, 대체 텍스트 0자·301자는 422 ALT_INVALID다 [ASVS v5.0.0-3.5.1]', async () => {
    await clearImages();
    const calls = imaging.calls.length;
    expect((await upload({ xrw: false })).statusCode).toBe(400);
    expect((await upload({ fields: { url: 'http://127.0.0.1:9/x' } })).statusCode).toBe(400);
    expect((await upload({ extraFiles: 1 })).statusCode).toBe(400);
    expect((await upload({ kind: 'BANNER' })).statusCode).toBe(400);
    expect((await upload({ order: '10' })).statusCode).toBe(400);
    for (const alt of ['', '가'.repeat(301)]) {
      const r = await upload({ alt });
      expect(r.statusCode).toBe(422);
      expect(json(r)).toMatchObject({ type: `${P}image-spec-invalid`, reason: 'ALT_INVALID' });
    }
    expect(imaging.calls.length).toBe(calls);
    expect((await upload({ alt: '가'.repeat(300) })).statusCode).toBe(201);
  });

  test('이미지는 파일 본문으로만 받고 서버는 본문·칸의 주소를 부르지 않는다 [ASVS v5.0.0-1.3.6]', async () => {
    const outside = await connectionCounter();
    try {
      await fetch(`${outside.url}/check`);
      expect([outside.connections(), outside.requests()]).toEqual([1, 1]);
      outside.reset();
      const r1 = await upload({ fields: { url: `${outside.url}/a.png` } });
      expect(r1.statusCode).toBe(400);
      const r2 = await upload({ bytes: new TextEncoder().encode(`${outside.url}/b.png`), name: 'b.png' });
      expect(r2.statusCode).toBe(415);
      await new Promise((res) => setTimeout(res, 200));
      expect([outside.connections(), outside.requests()]).toEqual([0, 0]);
    } finally {
      await outside.close();
    }
  });
});

describe('공연 이미지 고치기·지우기', () => {
  async function fourDetails(): Promise<string[]> {
    await clearImages();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(json(await upload({ alt: `상세 ${i}` })).imageId as string);
    await upload({ kind: 'POSTER' });
    return ids;
  }

  test('If-Match가 없으면 428, 판이 다르거나 꼴이 틀리면 412이고 바꾸지 않는다', async () => {
    const [a] = await fourDetails();
    expect(json(await patch(a!, { alt: '새 글' }))).toMatchObject({ type: `${P}precondition-required`, status: 428 });
    for (const tag of ['"2"', '1', 'W/"1"', '*']) expect((await patch(a!, { alt: '새 글' }, tag)).statusCode).toBe(412);
    expect((await rows()).find((r) => r.id === a)).toMatchObject({ alt: '상세 0', version: 1 });
  });

  test('대체 텍스트를 고치면 판이 오르고 ETag가 새 판이며 공연 태그를 무효화한다. 0자·301자는 계약 밖이라 400이다', async () => {
    const [a] = await fourDetails();
    const cdnCalls = cdn.calls.length;
    const r = await patch(a!, { alt: '바꾼 대체 텍스트' }, '"1"');
    expect(r.statusCode).toBe(200);
    expect(r.headers.etag).toBe('"2"');
    expect(UpdatePartnerProductionImageResponse.parse(json(r))).toMatchObject({ imageId: a, alt: '바꾼 대체 텍스트', version: 2, order: 0 });
    await eventually(() => expect(cdn.calls.slice(cdnCalls)).toContainEqual([`production:${PA}`]));
    expect((await patch(a!, { alt: '가'.repeat(301) }, '"2"')).statusCode).toBe(400);
    expect((await patch(a!, { alt: '' }, '"2"')).statusCode).toBe(400);
    expect((await patch(a!, { alt: '두 번째' }, '"1"')).statusCode).toBe(412);
  });

  test('상세 이미지 순서를 바꾸면 다른 상세 이미지를 밀어 0부터 다시 매기고 바뀐 행의 판을 올린다. 포스터 순서는 0만 받는다 [ASVS v5.0.0-1.4.2]', async () => {
    const [a, b, c, d] = await fourDetails();
    const r = await patch(d!, { order: 1 }, '"1"');
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ imageId: d, order: 1, version: 2 });
    expect(await details()).toEqual([
      [a, 0, 1],
      [d, 1, 2],
      [b, 2, 2],
      [c, 3, 2],
    ]);
    const poster = (await rows()).find((x) => x.kind === 'POSTER')!;
    expect((await patch(poster.id, { order: 1 }, '"1"')).statusCode).toBe(400);
    expect((await patch(poster.id, { order: 0, alt: '포스터 글' }, '"1"')).statusCode).toBe(200);
    expect((await patch(a!, { order: 10 }, '"1"')).statusCode).toBe(400);
    // 올리기의 order도 0~9 정수만 받는다(처리 작업을 부르지 않는다)
    const calls = imaging.calls.length;
    for (const order of ['10', '-1', '1.5']) expect((await upload({ order })).statusCode, order).toBe(400);
    expect(imaging.calls.length).toBe(calls);
  });

  test('포스터는 지우지 못하고(409), 상세 이미지를 지우면 남은 순서를 다시 매기고 공개 파생본 여덟 개를 지우며 무효화한다', async () => {
    const [a, b, c, d] = await fourDetails();
    const poster = (await rows()).find((x) => x.kind === 'POSTER')!;
    expect(json(await remove(poster.id))).toMatchObject({ type: `${P}poster-not-deletable`, status: 409 });
    expect(publicFiles(poster.id)).toHaveLength(8);
    const cdnCalls = cdn.calls.length;
    const r = await remove(b!);
    expect(r.statusCode).toBe(204);
    expect(await details()).toEqual([
      [a, 0, 1],
      [c, 1, 2],
      [d, 2, 2],
    ]);
    await eventually(() => expect(publicFiles(b!)).toEqual([]));
    expect(publicFiles(a!)).toHaveLength(8);
    await eventually(() => expect(cdn.calls.slice(cdnCalls)).toContainEqual([`production:${PA}`]));
    expect((await remove(b!)).statusCode).toBe(404);
    expect((await remove('not-a-uuid')).statusCode).toBe(404);
  });

  test('테넌트 조건은 행 보안 없이도 걸린다: 행 보안을 넘는 접속에서도 남의 공연은 소속이 아니고 장수·잠금에 닿지 않는다 [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-8.2.2]', async () => {
    await fourDetails();
    const media = new DrizzleProductionMedia(admin);
    expect([await media.owns(PA, A), await media.owns(PA, B), await media.owns(PB, A)]).toEqual([true, false, false]);
    expect([await media.detailCount(PA, A), await media.detailCount(PA, B)]).toEqual([4, 0]);
    let called = false;
    expect(
      await media.withLockedProduction(PA, B, async () => {
        called = true;
      }),
    ).toBe('not-found');
    expect(called).toBe(false);
  });

  test('다른 파트너는 남의 공연 이미지를 올리지도 고치지도 지우지도 못하고(없는 공연과 같은 404), 실패한 인가 시도로 남는다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-16.3.2]', async () => {
    const [a] = await fourDetails();
    const before = await rows();
    const calls = imaging.calls.length;
    const other = partner(B);
    const up = await upload({ headers: other });
    const pt = await patch(a!, { alt: '남의 것' }, '"1"', { headers: other });
    const rm = await remove(a!, { headers: other });
    const none = await upload({ productionId: randomUUID() });
    // 남의 공연 주소에 자기 테넌트 이미지 ID를 넣어도 같다(공연과 이미지를 함께 대조한다)
    const theirs = json(await upload({ productionId: PB, headers: other })).imageId;
    const mixed = await patch(String(theirs), { alt: 'x' }, '"1"');
    // 자기 공연 주소에 남의 이미지 ID를 넣어 지우거나 고쳐도 없는 이미지와 같고, 남의 공개 파생본을 건드리지 않는다
    const viaOwnDelete = await remove(a!, { productionId: PB, headers: other });
    const viaOwnPatch = await patch(a!, { alt: '남의 것' }, '"1"', { productionId: PB, headers: other });
    for (const r of [up, pt, rm, none, mixed, viaOwnDelete, viaOwnPatch]) {
      expect(r.statusCode).toBe(404);
      expect(json(r)).toMatchObject({ type: `${P}not-found`, status: 404 });
    }
    expect(await rows()).toEqual(before);
    expect(imaging.calls.length).toBe(calls + 1);
    expect(publicFiles(a!)).toHaveLength(8);
    const denied = logs.lines().filter((l) => l.event === 'partner_production_denied' && l.route === 'production_image');
    expect(denied.map((l) => l.action)).toEqual(expect.arrayContaining(['upload', 'update', 'delete']));
    expect(denied.find((l) => l.action === 'update')).toMatchObject({ kind: 'security', productionId: PA, tenantId: B });
    // 행 보안: 테넌트 B로 건 트랜잭션에서는 조건 없이 읽어도 A의 이미지가 보이지 않는다
    const seen = await partnerDb.transaction(async (tx) => tx.select({ id: productionImage.id, promoterId: productionImage.promoterId }).from(productionImage), { tenantId: B });
    expect(seen.map((s) => s.promoterId)).toEqual([B]);
    await clearImages(PB);
  });
});

describe('공연 상세의 이미지 칸', () => {
  test('GET /v1/events/{eventId}의 posterUrl·posterAlt·detailImages(순서대로)를 production_image 표에서 채운다', async () => {
    await clearImages();
    const p = json(await upload({ kind: 'POSTER', alt: '포스터 대체' })).imageId as string;
    const d1 = json(await upload({ alt: '상세 하나' })).imageId as string;
    const d2 = json(await upload({ alt: '상세 둘', order: '0' })).imageId as string;
    const r = await svc.http.inject({ method: 'GET', url: `/v1/events/${PA_EVENT}` });
    expect(r.statusCode).toBe(200);
    const body = GetEventResponse.parse(json(r));
    expect({ posterUrl: body.posterUrl, posterAlt: body.posterAlt, detailImages: body.detailImages }).toEqual({
      posterUrl: `${ORIGIN}/production/${p}`,
      posterAlt: '포스터 대체',
      detailImages: [
        { url: `${ORIGIN}/production/${d2}`, alt: '상세 둘' },
        { url: `${ORIGIN}/production/${d1}`, alt: '상세 하나' },
      ],
    });
    expect(r.headers['x-peaket-cache-tag']).toContain(`production:${PA}`);
    await remove(d2);
    const after = json(await svc.http.inject({ method: 'GET', url: `/v1/events/${PA_EVENT}` }));
    expect(after.detailImages).toEqual([{ url: `${ORIGIN}/production/${d1}`, alt: '상세 하나' }]);
  });

  test('올리기 기록에 언제·누가·무엇(공연·이미지·종류·결과)을 남기고 대체 텍스트·파일 이름은 싣지 않는다 [ASVS v5.0.0-16.2.1]', async () => {
    await clearImages();
    const alt = `대체-${randomUUID()}`;
    const r = await upload({ alt, name: `secret-name-${randomUUID()}.png` });
    const id = json(r).imageId;
    const line = logs.lines().find((l) => l.event === 'production_image_uploaded' && l.imageId === id);
    expect(line).toMatchObject({ productionId: PA, imageId: id, imageKind: 'DETAIL', order: 0, width: 1200, height: 1600, service: 'core-svc', accountId: '[REDACTED]' });
    expect([typeof line!.ts, typeof line!.traceId]).toEqual(['string', 'string']);
    expect(logs.text()).not.toContain(alt);
    expect(logs.text()).not.toContain('secret-name-');
  });
});

/** 본문을 천천히 보내는 진짜 HTTP 요청(앞부분만 보내고 쥔다) */
function slowUpload(payload: Buffer, contentType: string, headers: Record<string, string>, url = `/v1/partner/productions/${PA}/images`) {
  let res!: (r: { status: number; body: string }) => void;
  const done = new Promise<{ status: number; body: string }>((r) => (res = r));
  const req: ClientRequest = httpRequest({ host: '127.0.0.1', port: httpPort, method: 'POST', path: url, headers: { ...headers, 'content-type': contentType, 'content-length': String(payload.length), 'x-requested-with': 'x' } }, (m: IncomingMessage) => {
    let body = '';
    m.on('data', (c) => (body += String(c)));
    m.on('end', () => res({ status: m.statusCode ?? 0, body }));
  });
  req.on('error', () => res({ status: -1, body: '' }));
  req.write(payload.subarray(0, 1024));
  return { done, finish: () => req.end(payload.subarray(1024)), abort: () => req.destroy() };
}

describe('리뷰 2차: 올리기 받기·처리·정리', () => {
  test('S1 본문을 천천히 보내는 요청 넷이 자리를 쥐면 다섯째는 본문을 다 보내기 전에 429이고, 끝나거나 끊기면 자리가 풀린다', async () => {
    if (httpPort === 0) httpPort = (await svc.listen('127.0.0.1')).port;
    await clearImages();
    const body = await multipart({ kind: 'DETAIL', alt: '천천히' }, [{ name: 'a.png', type: 'image/png', bytes: png(1200, 900, 200_000) }]);
    const held = [0, 1, 2, 3].map(() => slowUpload(body.payload, body.contentType, partner()));
    await new Promise((r) => setTimeout(r, 300));
    const fifth = slowUpload(body.payload, body.contentType, partner());
    const t0 = Date.now();
    try {
      const r5 = await fifth.done;
      expect(r5.status).toBe(429);
      expect(Date.now() - t0).toBeLessThan(3_000);
    } catch (err) {
      // 단언이 실패하면 쥔 연결을 모두 끊어 자리를 풀고 뒤 시험이 영향을 받지 않게 한다
      for (const h of [...held, fifth]) h.abort();
      throw err;
    }
    fifth.abort();
    // 하나를 끊으면 자리가 풀린다
    held[0]!.abort();
    await eventually(async () => expect((await upload({ alt: '끊긴 뒤' })).statusCode).toBe(201));
    // 나머지 셋을 끝내면 모두 처리되고 자리가 풀린다
    for (const h of held.slice(1)) h.finish();
    expect((await Promise.all(held.slice(1).map((h) => h.done))).map((r) => r.status)).toEqual([201, 201, 201]);
    const after = await Promise.all([0, 1, 2, 3].map((i) => upload({ alt: `뒤 ${i}` })));
    expect(after.map((r) => r.statusCode)).toEqual([201, 201, 201, 201]);
  }, 30_000);

  test('S2 처리 데드라인은 min(30초, 남은 시간 − 2초)이고 10초 미만이면 맡기지 않고 504 deadline-exceeded다(시간 주입)', async () => {
    await clearImages();
    const calls = imaging.calls.length;
    store.mode.onPutQuarantine = () => clock.advance(80_000);
    const late = await upload({});
    expect(late.statusCode).toBe(504);
    expect(json(late)).toMatchObject({ type: `${P}deadline-exceeded` });
    expect(imaging.calls.length).toBe(calls);
    await eventually(() => expect(leftovers()).toEqual({ quarantine: [], staging: [] }));
    store.mode.onPutQuarantine = () => clock.advance(70_000);
    expect((await upload({})).statusCode).toBe(201);
    const left = imaging.deadlines.at(-1)!;
    expect(left).toBeGreaterThan(16_500);
    expect(left).toBeLessThanOrEqual(18_000);
    store.mode.onPutQuarantine = undefined;
    expect((await upload({})).statusCode).toBe(201);
    expect(imaging.deadlines.at(-1)!).toBeGreaterThan(28_500);
  });

  test('S7 준비 위치 파생본이 5MiB를 넘거나(정확히 5MiB는 받는다) 파일 앞부분이 형식과 다르면 게시하지 않고 503이며 보안 사건이다 [ASVS v5.0.0-16.5.3]', async () => {
    await clearImages();
    const before = logs.lines().filter((l) => l.event === 'image_worker_result_untrusted').length;
    imaging.content = (n) => (n === '640.webp' ? Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'latin1'), Buffer.alloc(5 * 1024 * 1024 - 12)]) : derived(n, 'x'));
    expect((await upload({})).statusCode).toBe(201);
    imaging.content = (n) => (n === '640.webp' ? Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'latin1'), Buffer.alloc(5 * 1024 * 1024 - 11)]) : derived(n, 'x'));
    const big = await upload({});
    expect([big.statusCode, big.headers['retry-after']]).toEqual([503, '30']);
    imaging.content = (n) => (n === '960.avif' ? '<html><script>alert(1)</script></html>' : derived(n, 'x'));
    expect((await upload({})).statusCode).toBe(503);
    imaging.content = (n) => (n === '320.webp' ? derived('320.avif', 'x') : derived(n, 'x'));
    expect((await upload({})).statusCode).toBe(503);
    const untrusted = logs.lines().filter((l) => l.event === 'image_worker_result_untrusted').slice(before);
    expect(untrusted.map((l) => l.why)).toEqual(['derivative_too_large', 'derivative_type', 'derivative_type']);
    expect(untrusted[0]).toMatchObject({ kind: 'security', productionId: PA });
    expect(await rows()).toHaveLength(1);
    await eventually(() => expect(leftovers()).toEqual({ quarantine: [], staging: [] }));
  });

  test('S9 올리기에서 alt 칸이 아예 없으면 400(칸 구조), 길이만 422 ALT_INVALID다', async () => {
    const calls = imaging.calls.length;
    expect((await upload({ noAlt: true })).statusCode).toBe(400);
    expect(json(await upload({ alt: '' }))).toMatchObject({ status: 422, reason: 'ALT_INVALID' });
    expect(imaging.calls.length).toBe(calls);
  });

  test('S11 격리 원본·준비 위치·공개 위치 지우기가 실패하면 production_image_leftover로 남기고, 격리 쓰기 실패는 503이며 처리를 부르지 않는다', async () => {
    await clearImages();
    const mark = logs.lines().length;
    store.mode.failDeletes = true;
    const r = await upload({ alt: '정리 실패' });
    expect(r.statusCode).toBe(201);
    await eventually(() => expect(logs.lines().slice(mark).filter((l) => l.event === 'production_image_leftover').map((l) => l.where).sort()).toEqual(['quarantine', 'staging']));
    const leftover = logs.lines().slice(mark).find((l) => l.event === 'production_image_leftover' && l.where === 'staging');
    expect(leftover).toMatchObject({ productionId: PA, imageId: json(r).imageId, count: 8 });
    const del = await remove(String(json(r).imageId));
    expect(del.statusCode).toBe(204);
    await eventually(() => expect(logs.lines().slice(mark).filter((l) => l.event === 'production_image_leftover' && l.where === 'public')).toHaveLength(1));
    store.mode = {};
    rmSync(join(dir, 'quarantine'), { recursive: true, force: true });
    rmSync(join(dir, 'staging'), { recursive: true, force: true });
    const calls = imaging.calls.length;
    store.mode.failPutQuarantine = true;
    const broken = await upload({});
    expect([broken.statusCode, broken.headers['retry-after']]).toEqual([503, '30']);
    expect(imaging.calls.length).toBe(calls);
  });

  test('S11 커밋 뒤 정리·무효화는 응답을 기다리게 하지 않는다(공개 파생본 지우기가 멈춰도 지우기 응답은 바로 온다)', async () => {
    await clearImages();
    await upload({ kind: 'POSTER' });
    const d = json(await upload({ alt: '지울 것' })).imageId as string;
    store.mode.hangPublicDelete = true;
    const t0 = Date.now();
    const r = await remove(d);
    expect(r.statusCode).toBe(204);
    expect(Date.now() - t0).toBeLessThan(2_000);
    store.mode = {};
  });

  test('S12 남의 공연·다른 공연의 이미지 ID나 없는 ID로 고치기·지우기를 부르면 404이고 보안 사건으로 남는다 [ASVS v5.0.0-16.3.2]', async () => {
    await clearImages();
    await clearImages(PA2);
    const other = json(await upload({ productionId: PA2, alt: '다른 공연' })).imageId as string;
    const mark = logs.lines().length;
    const tries = [await patch(other, { alt: 'x' }, '"1"'), await remove(other), await patch(randomUUID(), { alt: 'x' }, '"1"'), await remove('not-a-uuid')];
    expect(tries.map((t) => t.statusCode)).toEqual([404, 404, 404, 404]);
    const denied = logs.lines().slice(mark).filter((l) => l.event === 'production_image_denied');
    expect(denied.map((l) => l.action)).toEqual(['update', 'delete', 'update', 'delete']);
    expect(denied[0]).toMatchObject({ kind: 'security', productionId: PA, imageId: other });
    expect((await rows(PA2)).map((r) => [r.id, r.alt, r.version])).toEqual([[other, '다른 공연', 1]]);
    await clearImages(PA2);
  });

  test('S14 두 올리기가 공연 행 잠금에서 함께 기다렸다가 상세 10장 상한에 하나만 들어간다(장벽) [ASVS v5.0.0-2.3.2]', async () => {
    await clearImages();
    for (let i = 0; i < 9; i++) await upload({ alt: `상세 ${i}` });
    const holder = new pg.Client({ connectionString: pg_.url });
    await holder.connect();
    await holder.query('begin');
    await holder.query('select id from production where id = $1 for update', [PA]);
    const both = [upload({ alt: '경합 1' }), upload({ alt: '경합 2' })];
    await eventually(async () => {
      const r = await admin.pool.query<{ n: string }>(`select count(*) as n from pg_stat_activity where wait_event_type = 'Lock' and application_name like 'core-svc%'`);
      expect(Number(r.rows[0]!.n)).toBe(2);
    }, 15_000);
    await holder.query('commit');
    await holder.end();
    expect((await Promise.all(both)).map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await details()).map((d) => d[1])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  }, 30_000);

  test('S14 파생본을 일부만 게시한 뒤(둘째 칸부터) 실패하면 게시한 것을 지우고 503이며 행을 남기지 않는다', async () => {
    await clearImages();
    const publishedDirs = () => (existsSync(join(dir, 'public', 'production')) ? readdirSync(join(dir, 'public', 'production')).filter((d) => readdirSync(join(dir, 'public', 'production', d)).length > 0) : []);
    const before = publishedDirs();
    store.mode.failPutPublicAt = 2;
    const r = await upload({});
    expect([r.statusCode, r.headers['retry-after']]).toEqual([503, '30']);
    // 첫 칸은 게시됐다가 지워졌다(앞 시험이 일부러 남긴 객체 말고 새로 남은 것이 없다)
    expect(store.puts).toBe(2);
    expect(publishedDirs().filter((d) => !before.includes(d))).toEqual([]);
    expect(await rows()).toEqual([]);
    await eventually(() => expect(leftovers()).toEqual({ quarantine: [], staging: [] }));
  });
});
