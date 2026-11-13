// 좌석맵 에디터 잇기 통합 시험(BUILD_ORDER HOT-220, ADR-0264, docs/frontend.md FE-T46·FE-T38).
// 화면 모델 시험(apps/partner …/model/golden.test.mjs)과 같은 골든 파일(fixtures/seatmap-editor/)을 실제 core-svc HTTP 앱(실제 PostgreSQL 18,
// 운영과 같은 권한의 DB 사용자, 로컬 폴더 팬 파일 저장소)과 운영 실행 명령으로 띄운 seatmap-worker 프로세스에 보낸다. 서버가 매긴 좌석 UUID는
// 나온 차례 번호('#1'…)로 바꿔 견준다. 골든을 다시 쓸 때만 PEAKET_UPDATE_GOLDEN=1(load-response·save-response·fan-file·가져오기 결과).
import 'reflect-metadata';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { createDatabase, createService, type Database, ensureOutboxPartitions, fakeClock, systemClock } from '@peaket/platform';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decodeLayout } from '../../../packages/seatmap/src/layout.js';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { event, place, production, promoter } from '../src/modules/catalog/adapters/db/schema.js';
import { GrpcSeatmapParser, LocalFolderPublicFileStore } from '../src/modules/catalog/index.js';
import { FakeIdentity, NOW_MS, testMedia } from '../test/support.js';
import { buildDist, freePort, logSink, multipart, SERVICE_DIR, startWorker, until, type WorkerProcess } from './media-support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

type Svc = Awaited<ReturnType<typeof createService>>;
type Json = Record<string, unknown>;

const FIXTURES = join(SERVICE_DIR, 'test-int', 'fixtures', 'seatmap-editor');
const UPDATE = process.env.PEAKET_UPDATE_GOLDEN === '1';
const fixture = (name: string) => readFile(join(FIXTURES, name), 'utf8');
const fixtureJson = async (name: string) => JSON.parse(await fixture(name)) as Json;
const writeFixture = (name: string, v: unknown) => writeFile(join(FIXTURES, name), `${JSON.stringify(v, null, 2)}\n`);

/** 좌석 ID를 나온 차례로 '#1'…로 바꾼다(화면 골든 시험의 normalizeIds와 같다. 팬 파일의 열 꼴 seatId 배열도 바꾼다) */
function normalizeIds(v: unknown): unknown {
  const map = new Map<string, string>();
  const id = (s: string) => {
    if (!map.has(s)) map.set(s, `#${map.size + 1}`);
    return map.get(s);
  };
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      const out: Json = {};
      for (const [k, val] of Object.entries(x)) {
        if (k === 'seatId' && typeof val === 'string') out[k] = id(val);
        else if (k === 'seatId' && Array.isArray(val)) out[k] = val.map((s) => (typeof s === 'string' ? id(s) : s));
        else out[k] = walk(val);
      }
      return out;
    }
    return x;
  };
  return walk(v);
}

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let opsDb: Database;
let svc: Svc;
let worker: WorkerProcess;
let parser: GrpcSeatmapParser;
let root: string;
const logs = logSink();
const identity = new FakeIdentity();
const A = randomUUID();
const B = randomUUID();
const PLACE = randomUUID();
const P = 'https://peaket.example/problems/';
const NOW = new Date(NOW_MS);
const FUTURE_OPEN = new Date('2026-11-20T11:00:00Z');

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-test', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 4);
  opsDb = await loginFor(admin, pg, 'core_ops_login', 'core_ops', 4);
  await admin.db.insert(promoter).values([
    { id: A, legalName: '(주)에이' },
    { id: B, legalName: '(주)비' },
  ]);
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: randomUUID() });
  worker = await startWorker();
  parser = new GrpcSeatmapParser(worker.address);
  root = await mkdtemp(join(tmpdir(), 'peaket-editor-'));
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, media: testMedia({ seatmap: parser, publicFiles: new LocalFolderPublicFileStore(root) }) }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: logs.stream,
    adminAuthz: identity,
  });
}, 180_000);

afterAll(async () => {
  await svc?.close();
  parser?.close();
  await worker?.stop();
  await appDb?.close();
  await partnerDb?.close();
  await opsDb?.close();
  await admin?.close();
  pg?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

const adminOf = (t: string) => identity.partner(t, 'partner_admin');
const memberOf = (t: string) => identity.partner(t, 'partner_member');
const json = (r: { payload: string }) => JSON.parse(r.payload) as Json;

async function makeProduction(o: { tenant?: string; approved?: boolean; rows?: number; openAt?: Date } = {}): Promise<{ id: string; events: string[] }> {
  const id = randomUUID();
  const tenant = o.tenant ?? A;
  const events = Array.from({ length: o.rows ?? 2 }, () => randomUUID());
  await admin.db.insert(production).values({ id, promoterId: tenant, placeId: PLACE, title: '겨울 콘서트', genre: '콘서트', saleReview: o.approved ? 'APPROVED' : 'DRAFT', saleApprovedAt: o.approved ? new Date('2026-11-01T00:00:00Z') : null });
  if (events.length > 0) {
    await admin.db.insert(event).values(events.map((e, i) => ({ id: e, productionId: id, promoterId: tenant, openAt: o.openAt ?? FUTURE_OPEN, startsAt: new Date(Date.UTC(2026, 11, 10 + i, 10)), endsAt: new Date(Date.UTC(2026, 11, 10 + i, 12)) })));
  }
  return { id, events };
}

function put(productionId: string, h: Record<string, string>, body: unknown, ifMatch?: string) {
  return svc.http.inject({ method: 'PUT', url: `/v1/partner/productions/${productionId}/seatmap`, headers: { ...h, 'content-type': 'application/json', ...(ifMatch !== undefined ? { 'if-match': ifMatch } : {}) }, payload: JSON.stringify(body) });
}
const get = (productionId: string, h: Record<string, string>) => svc.http.inject({ method: 'GET', url: `/v1/partner/productions/${productionId}/seatmap`, headers: h });

/** 에디터와 같은 가져오기 요청: 파일 칸 이름 seatmap.{형식}(사용자 파일 이름을 보내지 않는다), X-Requested-With */
async function importAs(productionId: string, format: 'SVG' | 'JSON' | 'CSV', text: string | Uint8Array, h = memberOf(A)) {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  const body = await multipart({ format }, [{ name: `seatmap.${format.toLowerCase()}`, type: { SVG: 'image/svg+xml', JSON: 'application/json', CSV: 'text/csv' }[format], bytes }]);
  return svc.http.inject({ method: 'POST', url: `/v1/partner/productions/${productionId}/seatmap-imports`, headers: { ...h, 'content-type': body.contentType, 'x-requested-with': 'peaket-partner' }, payload: body.payload });
}

const layoutDir = (eventId: string, where: 'public' | 'staging' = 'public') => join(root, ...(where === 'staging' ? ['staging'] : ['public']), 'v1', 'events', eventId, 'seatmap-layouts');
const counts = (layout: Json) => (layout.sections as { sectionId: string; seats: unknown[] }[]).map((s) => s.seats.length);
const coords = (layout: Json) => (layout.sections as { seats: { row: string; number: number; x: number; y: number }[] }[]).map((s) => s.seats.map((x) => [x.row, x.number, x.x, x.y]));

describe('FE-T46 에디터 저장 본문·불러오기 응답(골든)', () => {
  test('FE-T46 ⑦ 에디터 저장 본문 골든을 실제 core-svc가 판 0에서 200·판 1로 받고 옛 판은 412다', async () => {
    const m = await makeProduction({ rows: 2 });
    const body = await fixtureJson('save-body.json');
    const r = await put(m.id, adminOf(A), body, '"0"');
    expect(r.statusCode).toBe(200);
    expect(r.headers.etag).toBe('"1"');
    const out = json(r);
    expect([out.layoutVersion, out.fanFilePublished, out.geometryLocked]).toEqual([1, true, false]);
    if (UPDATE) await writeFixture('save-response.json', normalizeIds(out));
    expect(normalizeIds(out)).toEqual(await fixtureJson('save-response.json'));
    // 회차마다 팬 파일이 하나씩 생기고 decodeLayout을 지난다(좌석 83석)
    for (const e of m.events) {
      expect(await readdir(layoutDir(e))).toEqual(['1.json']);
      expect(decodeLayout(JSON.parse(await readFile(join(layoutDir(e), '1.json'), 'utf8'))).N).toBe(83);
    }
    // 팬 파일 골든: 에디터 미리보기(previewColumns)가 같은 규칙인지 화면 시험이 이 파일과 견준다(FE-T38 ④, ADR-0264 결정 40)
    const fan = normalizeIds(JSON.parse(await readFile(join(layoutDir(m.events[0]!), '1.json'), 'utf8')));
    if (UPDATE) await writeFixture('fan-file.json', fan);
    expect(fan).toEqual(await fixtureJson('fan-file.json'));
    // 같은 판 0으로 다시 보내면 412(다른 곳에서 먼저 저장)
    const stale = await put(m.id, adminOf(A), body, '"0"');
    expect(stale.statusCode).toBe(412);
    expect(json(stale).type).toBe(`${P}precondition-failed`);
  });

  test('FE-T46 ⑦ 판 9에서 10으로 오른 뒤 옛 판 "9"는 412이고 "10"은 받는다(판을 글자로 견주지 않는다)', async () => {
    const m = await makeProduction({ rows: 1 });
    const body = await fixtureJson('save-body.json');
    for (let v = 0; v < 10; v++) expect((await put(m.id, adminOf(A), { ...body, layoutVersion: v }, `"${v}"`)).statusCode).toBe(200);
    const loaded = await get(m.id, memberOf(A));
    expect(loaded.headers.etag).toBe('"10"');
    expect((await put(m.id, adminOf(A), { ...body, layoutVersion: 9 }, '"9"')).statusCode).toBe(412);
    expect((await put(m.id, adminOf(A), { ...body, layoutVersion: 10 }, '"10"')).headers.etag).toBe('"11"');
  });

  test('FE-T46 ① 실제 불러오기 응답이 에디터 골든과 같다', async () => {
    const m = await makeProduction({ rows: 1 });
    expect((await get(m.id, memberOf(A))).statusCode).toBe(404);
    expect((await put(m.id, adminOf(A), await fixtureJson('save-body.json'), '"0"')).statusCode).toBe(200);
    const r = await get(m.id, memberOf(A));
    expect(r.statusCode).toBe(200);
    expect(r.headers.etag).toBe('"1"');
    expect(r.headers['cache-control']).toBe('no-store');
    const out = json(r);
    if (UPDATE) await writeFixture('load-response.json', normalizeIds(out));
    expect(normalizeIds(out)).toEqual(await fixtureJson('load-response.json'));
    expect(counts(out)).toEqual([36, 5, 12, 30]);
  });

  test('FE-T46 ⑩ 부채꼴 arc가 저장·불러오기를 지나 그대로이고 팬 파일에 없으며 어긋난 arc는 422 SHAPE_PARAMS_INVALID다', async () => {
    const m = await makeProduction({ rows: 1 });
    const body = await fixtureJson('save-body.json');
    expect((await put(m.id, adminOf(A), body, '"0"')).statusCode).toBe(200);
    const out = json(await get(m.id, memberOf(A)));
    const sections = out.sections as { shape: { kind: string; arc?: unknown } }[];
    expect(sections.map((s) => [s.shape.kind, s.shape.arc ?? null])).toEqual([
      ['RECT', null],
      ['POLYGON', null],
      ['SECTOR', { cx: 1500, cy: 4500, innerRadius: 0, outerRadius: 1000, startAngle: 180, endAngle: 270 }],
      ['ARC_BAND', { cx: 4000, cy: 500, innerRadius: 2500, outerRadius: 3200, startAngle: 60, endAngle: 120 }],
    ]);
    // 팬 파일에는 arc가 없다(에디터 값)
    const fan = await readFile(join(layoutDir(m.events[0]!), '1.json'), 'utf8');
    expect(fan.includes('"arc"')).toBe(false);
    expect(fan.includes('innerRadius')).toBe(false);
    // 관계가 틀린 arc는 422 seatmap-invalid의 SHAPE_PARAMS_INVALID(경계 바로 안쪽은 받는다)
    const withArc = (i: number, arc: Json, kind?: string) => {
      const b = structuredClone(body) as { layoutVersion: number; sections: { shape: Json }[] };
      b.layoutVersion = 1;
      b.sections[i]!.shape = { ...b.sections[i]!.shape, ...(kind ? { kind } : {}), arc };
      return b;
    };
    const band = { cx: 4000, cy: 500, innerRadius: 2500, outerRadius: 3200, startAngle: 60, endAngle: 120 };
    const bad: [number, Json, string?][] = [
      [3, { ...band, innerRadius: 3200 }],
      [3, { ...band, endAngle: 60 }],
      [3, { ...band, startAngle: 0, endAngle: 361 }],
      [0, band, 'RECT'],
    ];
    for (const [i, arc, kind] of bad) {
      const r = await put(m.id, adminOf(A), withArc(i, arc, kind), '"1"');
      expect(r.statusCode).toBe(422);
      const p = json(r) as { type: string; result: { errors: { field: string; code: string }[] } };
      expect(p.type).toBe(`${P}seatmap-invalid`);
      expect(p.result.errors).toContainEqual({ line: 0, field: `sections[${i}].shape.arc`, code: 'SHAPE_PARAMS_INVALID' });
    }
    // 범위 밖(바깥 반지름 0)은 계약 검사 400
    expect((await put(m.id, adminOf(A), withArc(3, { ...band, outerRadius: 0 }), '"1"')).statusCode).toBe(400);
    // 경계 바로 안: 안쪽 = 바깥 − 1, 각도 범위 정확히 360
    const ok = await put(m.id, adminOf(A), withArc(3, { ...band, innerRadius: 3199, startAngle: 0, endAngle: 360 }), '"1"');
    expect(ok.statusCode).toBe(200);
    expect((json(ok).sections as { shape: { arc: Json } }[])[3]!.shape.arc).toEqual({ ...band, innerRadius: 3199, startAngle: 0, endAngle: 360 });
  });

  test('FE-T46 ⑫ 오픈한 승인 공연의 불러오기·저장 응답 geometryLocked가 참이고 오픈 1ms 전은 거짓이다', async () => {
    const m = await makeProduction({ rows: 2 });
    const body = await fixtureJson('save-body.json');
    const first = await put(m.id, adminOf(A), body, '"0"');
    expect(json(first).geometryLocked).toBe(false);
    await admin.db.update(production).set({ saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') }).where(eq(production.id, m.id));
    // 오픈 1ms 전: 잠기지 않았다
    await admin.db.update(event).set({ openAt: new Date(NOW_MS + 1) }).where(eq(event.id, m.events[0]!));
    expect(json(await get(m.id, memberOf(A))).geometryLocked).toBe(false);
    // 오픈 그 순간(오픈 시각 = 지금): 잠겼다
    await admin.db.update(event).set({ openAt: NOW }).where(eq(event.id, m.events[0]!));
    const loaded = json(await get(m.id, memberOf(A)));
    expect(loaded.geometryLocked).toBe(true);
    // 속성(판매 제외)만 바꾼 저장은 받고 저장 응답도 geometryLocked가 참이다
    const attrs = structuredClone(loaded) as { layoutVersion: number; sections: { seats: Json[] }[] } & Json;
    for (const k of ['geometryLocked', 'fanFilePublished', 'warnings']) delete attrs[k];
    for (const s of attrs.sections) {
      delete (s as Json).seatIndexRange;
      for (const x of s.seats) delete x.index;
    }
    attrs.sections[0]!.seats[3]!.unavailable = true;
    const saved = await put(m.id, adminOf(A), attrs, '"1"');
    expect(saved.statusCode).toBe(200);
    expect([json(saved).layoutVersion, json(saved).geometryLocked]).toEqual([2, true]);
    // 화면이 잠금을 놓쳐 도형을 바꿔 보내도 서버가 409로 막는다(겹친 가드 하나 빼기)
    const moved = structuredClone(attrs) as typeof attrs;
    (moved.sections[0]!.seats[0] as { x: number }).x += 10;
    const r = await put(m.id, adminOf(A), { ...moved, layoutVersion: 2 }, '"2"');
    expect(r.statusCode).toBe(409);
    expect(json(r).type).toBe(`${P}seatmap-geometry-locked`);
  });

  test('FE-T46 ⑦ 승인 이력 공연의 실무자 저장은 403, 다른 테넌트 공연은 불러오기·저장·가져오기가 404, 가격 등급에 없는 등급은 422 TIER_UNKNOWN이다', async () => {
    const m = await makeProduction({ rows: 1, approved: true });
    const body = await fixtureJson('save-body.json');
    const member = await put(m.id, memberOf(A), body, '"0"');
    expect(member.statusCode).toBe(403);
    expect(json(member).type).toBe(`${P}partner-admin-required`);
    expect((await get(m.id, adminOf(B))).statusCode).toBe(404);
    expect((await put(m.id, adminOf(B), body, '"0"')).statusCode).toBe(404);
    expect((await importAs(m.id, 'CSV', await fixture('import-rows.csv'), adminOf(B))).statusCode).toBe(404);
    // 화면의 등급 검사를 빼도 서버가 모르는 등급을 막는다
    const unknown = structuredClone(body) as { priceTiers: unknown[] };
    unknown.priceTiers = (unknown.priceTiers as { tierId: string }[]).filter((t) => t.tierId !== 'A');
    const r = await put(m.id, adminOf(A), unknown, '"0"');
    expect(r.statusCode).toBe(422);
    expect((json(r) as { result: { errors: { code: string }[] } }).result.errors.every((e) => e.code === 'TIER_UNKNOWN')).toBe(true);
  });
});

describe('FE-T46 ⑧·FE-T38 가져오기와 내보내기(실제 seatmap-worker)', () => {
  test('FE-T46 ⑧ 에디터 가져오기 요청 골든(파일 칸 이름 seatmap.csv, X-Requested-With)을 실제 core-svc·seatmap-worker가 받아 행 오류를 낸다 [ASVS v5.0.0-1.2.1]', async () => {
    const m = await makeProduction({ rows: 0 });
    const r = await importAs(m.id, 'CSV', await fixture('import-rows.csv'));
    expect(r.statusCode).toBe(200);
    const out = json(r);
    if (UPDATE) await writeFixture('import-rows-result.json', normalizeIds(out));
    expect(normalizeIds(out)).toEqual(await fixtureJson('import-rows-result.json'));
    expect(out.ok).toBe(false);
    expect((out.errors as { line: number; code: string }[]).map((e) => [e.line, e.code])).toEqual([
      [5, 'COORD_INVALID'],
      [6, 'WHEELCHAIR_INVALID'],
      [4, 'NUMBER_INVALID'],
    ]);
    // SVG의 script·image는 읽지 않고 이름만 경고로 온다
    const s = await importAs(m.id, 'SVG', await fixture('import-svg.svg'));
    const svgOut = json(s);
    if (UPDATE) await writeFixture('import-svg-result.json', normalizeIds(svgOut));
    expect(normalizeIds(svgOut)).toEqual(await fixtureJson('import-svg-result.json'));
    expect(svgOut.ok).toBe(true);
    expect(svgOut.warnings).toContainEqual({ code: 'SVG_IGNORED', ignored: ['script', 'image'] });
  });

  test('FE-T46 ⑧ 가져오기 파일은 10MB 정확히는 해석에 넘기고 1바이트 넘으면 413이며 압축 파일도 413이다', async () => {
    const m = await makeProduction({ rows: 0 });
    const MiB = 1024 * 1024;
    const exact = new Uint8Array(10 * MiB).fill(0x20);
    const at = await importAs(m.id, 'CSV', exact);
    expect(at.statusCode).not.toBe(413);
    const over = await importAs(m.id, 'CSV', new Uint8Array(10 * MiB + 1).fill(0x20));
    expect(over.statusCode).toBe(413);
    expect(json(over).type).toBe(`${P}seatmap-import-too-large`);
    const gz = await importAs(m.id, 'CSV', new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0]));
    expect(gz.statusCode).toBe(413);
  });

  test('FE-T38 ① 골든 JSON 내보내기를 실제 가져오기가 받아 구역·좌석 수와 좌표가 같다', async () => {
    const m = await makeProduction({ rows: 0 });
    const loaded = await fixtureJson('load-response.json');
    const r = await importAs(m.id, 'JSON', await fixture('export.json'));
    expect(r.statusCode).toBe(200);
    const out = json(r) as { ok: boolean; layout: Json };
    expect(out.ok).toBe(true);
    expect(counts(out.layout)).toEqual(counts(loaded));
    expect(coords(out.layout)).toEqual(coords(loaded));
  });

  test('FE-T38 ② 골든 SVG·CSV 내보내기를 실제 seatmap-worker가 읽어 같은 구역·좌석 수를 만들고 이름은 글자 그대로다 [ASVS v5.0.0-5.4.1]', async () => {
    const m = await makeProduction({ rows: 0 });
    const loaded = await fixtureJson('load-response.json');
    for (const [format, file] of [['SVG', 'export.svg'], ['CSV', 'export.csv']] as const) {
      const r = await importAs(m.id, format, await fixture(file));
      expect(r.statusCode).toBe(200);
      const out = json(r) as { ok: boolean; errors: unknown[]; layout: Json };
      expect([format, out.ok, out.errors]).toEqual([format, true, []]);
      expect(counts(out.layout)).toEqual(counts(loaded));
      expect(coords(out.layout)).toEqual(coords(loaded));
      expect((out.layout.sections as { name: string }[]).map((s) => s.name)).toEqual(['A구역', '<img src=x onerror=alert(1)>', 'C구역', 'D구역']);
    }
  });
});

// ---------- 시작 파일 조립(arc·geometryLocked가 운영 조립에서도 실린다) ----------

describe('시작 파일(main.ts) 조립', () => {
  let identityServer: grpc.Server;
  let identityPort = 0;
  const answers = new Map<string, { valid: boolean; role: string; tenant_id: string }>();
  beforeAll(async () => {
    buildDist();
    const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, grpc.ServiceClientConstructor> } } }).peaket.identity.v1;
    identityServer = new grpc.Server();
    identityServer.addService(pkg.AdminAuthzService!.service, {
      GetAdminAuthz: (call: grpc.ServerUnaryCall<Record<string, string>, unknown>, cb: grpc.sendUnaryData<unknown>) => cb(null, answers.get(`${call.request.admin_account_id}/${call.request.session_id}`) ?? { valid: false, role: '', tenant_id: '' }),
    });
    identityPort = await new Promise<number>((res, rej) => identityServer.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  }, 120_000);
  afterAll(() => identityServer?.forceShutdown());

  test('FE-T46 ⑩ ⑫ 운영 시작 파일로 띄운 core-svc가 골든 본문의 arc를 저장해 돌려주고 geometryLocked를 싣는다', async () => {
    const [port, mgmt] = [await freePort(), await freePort()];
    const dir = await mkdtemp(join(tmpdir(), 'peaket-main-'));
    const base: Record<string, string> = {};
    for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[k]) base[k] = process.env[k]!;
    const env = {
      ...base,
      PEAKET_ENV: 'local',
      PORT: String(port),
      PEAKET_MANAGEMENT_PORT: String(mgmt),
      PEAKET_DATABASE_URL: pg.urlFor('core_app_login', 'peaket-test'),
      PEAKET_PARTNER_DATABASE_URL: pg.urlFor('core_partner_login', 'peaket-test'),
      PEAKET_OPS_DATABASE_URL: pg.urlFor('core_ops_login', 'peaket-test'),
      PEAKET_IDENTITY_GRPC_URL: `127.0.0.1:${identityPort}`,
      PEAKET_IMAGE_GRPC_URL: '127.0.0.1:1',
      PEAKET_SEATMAP_GRPC_URL: worker.address,
      PEAKET_IMAGE_BASE_URL: 'http://127.0.0.1:1',
      PEAKET_IMAGE_STORE_DIR: dir,
      PEAKET_PUBLIC_FILE_DIR: join(dir, 'public-files'),
    };
    const child: ChildProcess = spawn(process.execPath, ['dist/main.js'], { cwd: SERVICE_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout!.on('data', (d) => (text += String(d)));
    child.stderr!.on('data', (d) => (text += String(d)));
    const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
    try {
      await until(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${mgmt}/ready`)).status === 200;
        } catch {
          return false;
        }
      }, `core-svc 준비: ${text.slice(-400)}`, 30_000, 200);
      const m = await makeProduction({ rows: 1 });
      const account = randomUUID();
      const session = randomUUID();
      answers.set(`${account}/${session}`, { valid: true, role: 'partner_admin', tenant_id: A });
      const h = { 'x-user-id': account, 'x-session-id': session, 'x-user-aud': 'partner', 'x-user-scope': '' };
      const url = `http://127.0.0.1:${port}/v1/partner/productions/${m.id}/seatmap`;
      const saved = await fetch(url, { method: 'PUT', headers: { ...h, 'content-type': 'application/json', 'if-match': '"0"' }, body: await fixture('save-body.json') });
      expect(saved.status).toBe(200);
      expect(((await saved.json()) as Json).geometryLocked).toBe(false);
      const loaded = (await (await fetch(url, { headers: h })).json()) as Json;
      expect(normalizeIds(loaded)).toEqual(await fixtureJson('load-response.json'));
    } finally {
      child.kill();
      await exited;
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
