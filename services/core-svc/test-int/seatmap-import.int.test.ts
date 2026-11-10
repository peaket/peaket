// 좌석맵 가져오기 통합 시험(BUILD_ORDER HOT-210, ADR-0257 결정 5~8, docs/features/seat-hold.md §10, S-T32·S-T34).
// 실제 PostgreSQL 18 컨테이너, 실제 core-svc HTTP 앱(운영과 같은 권한의 DB 사용자), 운영 실행 명령으로 띄운 seatmap-worker 프로세스(진짜 해석기)를 잇는다.
// 시간·힙 상한은 작업의 환경 값으로 줄인 두 번째·세 번째 작업으로 본다(5초·384MiB를 실제로 기다리지 않는다). 결과를 바꾼 작업과 답하지 않는 작업은
// 시험 안의 gRPC 서버다(호출 수를 센다).
import 'reflect-metadata';
import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { createDatabase, createService, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { production, promoter } from '../src/modules/catalog/adapters/db/schema.js';
import { GrpcSeatmapParser, MemoryImageObjectStore, MemoryPublicFileStore } from '../src/modules/catalog/index.js';
import { SEAT_ID_PATTERN } from '../../purchase-svc/src/modules/inventory/domain/hold.js';
import { parseEventSeatMapFile } from '../../purchase-svc/src/modules/inventory/domain/seat-layout.js';
import { event } from '../src/modules/catalog/adapters/db/schema.js';
import { seatmapServiceDefinition } from '../src/seatmap-worker/server.js';
import { FakeIdentity, testMedia } from '../test/support.js';
import { DrizzleProductionMedia } from '../src/modules/catalog/adapters/db/drizzle-production-media.js';
import { connectionCounter, enc, logLines, logSink, multipart, spawnWorker, startWorker, until, type WorkerProcess } from './media-support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

type Svc = Awaited<ReturnType<typeof createService>>;

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
const identity = new FakeIdentity();
const A = randomUUID();
const B = randomUUID();
const PROD_A = randomUUID();
const PROD_B = randomUUID();
const P = 'https://peaket.example/problems/';
const MiB = 1024 * 1024;

/** 진짜 해석기(기본 상한), 시간 상한을 20ms로 줄인 것, 힙 상한을 16MiB로 줄인 것 */
let worker: WorkerProcess;
let slowWorker: WorkerProcess;
let smallWorker: WorkerProcess;
/** 시험용 작업: 정한 답을 주고 호출을 센다 */
const fake = { calls: 0, mode: 'too-many' as 'too-many' | 'hang' | 'invalid' | 'proto' | 'too-many-invalid' | 'weird' | 'many-errors' };
let fakeServer: grpc.Server;
let fakePort = 0;
let outside: Awaited<ReturnType<typeof connectionCounter>>;

interface App {
  svc: Svc;
  logs: ReturnType<typeof logSink>;
  store: MemoryImageObjectStore;
  parser: GrpcSeatmapParser;
  publicFiles: MemoryPublicFileStore;
}
const apps: App[] = [];
let main: App;
let slow: App;
let small: App;
let altered: App;

async function app(address: string): Promise<App> {
  const logs = logSink();
  const store = new MemoryImageObjectStore();
  const parser = new GrpcSeatmapParser(address);
  const publicFiles = new MemoryPublicFileStore();
  const svc = await createService({ name: 'core-svc', module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, media: testMedia({ store, seatmap: parser, publicFiles }) }), env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info' }, logDestination: logs.stream, adminAuthz: identity });
  const a = { svc, logs, store, parser, publicFiles };
  apps.push(a);
  return a;
}

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-test', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 4);
  await admin.db.insert(promoter).values([
    { id: A, legalName: '(주)에이' },
    { id: B, legalName: '(주)비' },
  ]);
  await admin.db.insert(production).values([
    { id: PROD_A, promoterId: A, requestedPlace: { name: '새 공연장', address: '서울 어딘가' }, title: 'A 공연', genre: '콘서트' },
    { id: PROD_B, promoterId: B, requestedPlace: { name: '새 공연장', address: '서울 어딘가' }, title: 'B 공연', genre: '콘서트' },
  ]);
  [worker, slowWorker, smallWorker] = await Promise.all([startWorker(), startWorker({ PEAKET_SEATMAP_PARSE_TIMEOUT_MS: '20' }), startWorker({ PEAKET_SEATMAP_HEAP_MB: '16' })]);
  fakeServer = new grpc.Server({ 'grpc.max_receive_message_length': 12 * MiB, 'grpc.max_send_message_length': 8 * MiB });
  fakeServer.addService(seatmapServiceDefinition(), {
    ParseSeatmapImport: (_call: unknown, cb: grpc.sendUnaryData<unknown>) => {
      fake.calls++;
      if (fake.mode === 'hang') return;
      const reply = (layout: unknown, errors: unknown[] = []) => cb(null, { status: 'PARSE_STATUS_PARSED', layout_json: Buffer.from(typeof layout === 'string' ? layout : JSON.stringify(layout)), errors, ignored: [] });
      const one = (o: Record<string, unknown> = {}, seat: Record<string, unknown> = {}) => ({ canvas: { width: 10, height: 10 }, sections: [{ sectionId: '1', name: 'A', shape: { kind: 'POLYGON', points: [[0, 0], [10, 0], [10, 10]] }, seats: [{ row: '1', number: 1, x: 1, y: 1, ...seat }], ...o }] });
      if (fake.mode === 'proto') return reply('{"canvas":{"width":10,"height":10},"sections":[],"__proto__":{"polluted":true}}');
      if (fake.mode === 'too-many-invalid') return reply({ canvas: { width: 'wide' }, sections: [{ seats: Array.from({ length: 50_001 }, () => ({})) }] });
      if (fake.mode === 'weird') return reply(one({ label: { x: 500 }, seatIndexRange: { from: 3, to: 1 } }, { number: 0, index: -5, tierId: 'R\u202e' }));
      if (fake.mode === 'many-errors') {
        const seats = Array.from({ length: 20 }, () => ({ row: '1', number: 1, x: 1, y: 1 }));
        return reply({ ...one(), sections: [{ ...one().sections[0], seats }] }, Array.from({ length: 1_000 }, (_, i) => ({ line: i + 2, field: 'x', code: 'COORD_INVALID' })));
      }
      if (fake.mode === 'invalid') {
        cb(null, { status: 'PARSE_STATUS_PARSED', layout_json: Buffer.from('{"canvas":{"width":"wide"},"sections":"x"}'), errors: [], ignored: [] });
        return;
      }
      const seats = Array.from({ length: 50_001 }, (_, i) => ({ row: String(Math.floor(i / 1000)), number: i % 1000, x: 1, y: 1 }));
      const layout = { canvas: { width: 10, height: 10 }, sections: [{ sectionId: '1', name: 'A', shape: { kind: 'POLYGON', points: [[0, 0], [10, 0], [10, 10]] }, seats }] };
      cb(null, { status: 'PARSE_STATUS_PARSED', layout_json: Buffer.from(JSON.stringify(layout)), errors: [], ignored: [] });
    },
  });
  fakePort = await new Promise<number>((res, rej) => fakeServer.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  outside = await connectionCounter();
  main = await app(worker.address);
  slow = await app(slowWorker.address);
  small = await app(smallWorker.address);
  altered = await app(`127.0.0.1:${fakePort}`);
}, 180_000);

afterAll(async () => {
  for (const a of apps) {
    await a.svc.close();
    a.parser.close();
  }
  fakeServer?.forceShutdown();
  await outside?.close();
  await Promise.all([worker?.stop(), slowWorker?.stop(), smallWorker?.stop()]);
  await appDb?.close();
  await partnerDb?.close();
  await admin?.close();
  pg?.stop();
});

const partnerA = () => identity.partner(A, 'partner_member');

async function importFile(a: App, o: { format?: string; file?: Uint8Array; name?: string; type?: string; productionId?: string; headers?: Record<string, string>; fields?: Record<string, string>; xrw?: boolean; raw?: { payload: Buffer; contentType: string } }) {
  const body = o.raw ?? (await multipart({ ...(o.format !== undefined ? { format: o.format } : {}), ...o.fields }, o.file ? [{ name: o.name ?? 'seatmap.bin', type: o.type ?? 'application/octet-stream', bytes: o.file }] : []));
  return a.svc.http.inject({
    method: 'POST',
    url: `/v1/partner/productions/${o.productionId ?? PROD_A}/seatmap-imports`,
    headers: { ...(o.headers ?? partnerA()), 'content-type': body.contentType, ...(o.xrw === false ? {} : { 'x-requested-with': 'peaket-partner' }) },
    payload: body.payload,
  });
}
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const svg = (body: string, attrs = 'viewBox="0 0 1000 1000"') => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>\n${body}\n</svg>`;
/** 저장소의 모든 표에 그 글자가 남았는가(원본 미저장) */
async function anyTableContains(marker: string): Promise<string[]> {
  const tables = (await admin.db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)).rows as { table_name: string }[];
  const hit: string[] = [];
  for (const t of tables) {
    const r = (await admin.db.execute(sql.raw(`select count(*)::int as n from "${t.table_name}" x where x::text like '%${marker}%'`))).rows as { n: number }[];
    if (r[0]!.n > 0) hit.push(t.table_name);
  }
  return hit;
}
const heavySvg = () => svg(`<rect data-section="A" x="0" y="0" width="1000" height="1000"/>\n${Array.from({ length: 50_000 }, (_, i) => `<circle cx="${i % 1000}" cy="${Math.floor(i / 50)}" data-section="A" data-row="${Math.floor(i / 1000)}" data-number="${(i % 1000) + 1}"/>`).join('\n')}`);

describe('S-T32 좌석맵 가져오기 공격 파일', () => {
  test('S-T32 ① 외부 엔터티를 부르는 SVG는 422이고 바깥 연결이 0번이며 보안 사건으로 남는다 [ASVS v5.0.0-1.5.1] [ASVS v5.0.0-1.3.6] [ASVS v5.0.0-13.2.5] [ASVS v5.0.0-16.3.3]', async () => {
    // 연결을 세는 자리가 실제로 닿는지 먼저 본다
    await fetch(`${outside.url}/check`);
    expect([outside.connections(), outside.requests()]).toEqual([1, 1]);
    outside.reset();
    const before = worker.parses().length;
    const xxe = `<?xml version="1.0"?>\n<!DOCTYPE svg [ <!ENTITY ext SYSTEM "${outside.url}/xxe"> <!ENTITY % p SYSTEM "${outside.url}/dtd"> %p; ]>\n${svg('<polygon data-section="&ext;" points="0,0 10,0 10,10"/>')}`;
    const r = await importFile(main, { format: 'SVG', file: enc(xxe) });
    expect(r.statusCode).toBe(422);
    expect(json(r)).toMatchObject({ type: `${P}seatmap-import-rejected`, status: 422, detail: 'DOCTYPE_PRESENT' });
    await until(() => worker.parses().length === before + 1, '작업 기록');
    expect(worker.parses().at(-1)).toMatchObject({ format: 'SVG', status: 'PARSE_STATUS_REJECTED', code: 'DOCTYPE_PRESENT' });
    await new Promise((res) => setTimeout(res, 200));
    expect([outside.connections(), outside.requests()]).toEqual([0, 0]);
    expect(main.logs.lines().filter((l) => l.event === 'seatmap_import_doctype')).toEqual([expect.objectContaining({ kind: 'security', productionId: PROD_A, format: 'SVG' })]);
  });

  test('S-T32 ② DOCTYPE와 엔터티 확장으로 부풀린 SVG도 422이고 바깥 연결이 0번이다 [ASVS v5.0.0-1.5.1]', async () => {
    outside.reset();
    const lol = ['<?xml version="1.0"?>', '<!DOCTYPE lolz [', ' <!ENTITY lol "lol">', ...Array.from({ length: 9 }, (_, i) => ` <!ENTITY lol${i + 1} "${`&lol${i === 0 ? '' : i};`.repeat(10)}">`), ` <!ENTITY far SYSTEM "${outside.url}/far">`, ']>', svg('<polygon data-section="&lol9;&far;" points="0,0 1,0 1,1"/>')].join('\n');
    const r = await importFile(main, { format: 'SVG', file: enc(lol) });
    expect(r.statusCode).toBe(422);
    expect(json(r)).toMatchObject({ type: `${P}seatmap-import-rejected`, detail: 'DOCTYPE_PRESENT' });
    await new Promise((res) => setTimeout(res, 200));
    expect([outside.connections(), outside.requests()]).toEqual([0, 0]);
  });

  test('S-T32 ③ script·foreignObject·image·use·style·바깥 href는 읽지 않고 SVG_IGNORED 경고로만 나오며 정한 도형만 읽는다 [ASVS v5.0.0-1.3.4] [ASVS v5.0.0-1.3.6] [ASVS v5.0.0-13.2.5]', async () => {
    outside.reset();
    const file = svg(`<style>@import url("${outside.url}/css");</style>
<script><![CDATA[ fetch("${outside.url}/js") ]]></script>
<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
<image href="${outside.url}/img.png" width="10" height="10"/>
<use xlink:href="${outside.url}/s.svg#a"/>
<rect data-kind="stage" x="0" y="0" width="1000" height="100" style="fill:url(${outside.url}/f)"/>
<polygon data-section="A" points="0,200 500,200 500,600 0,600" onclick="x()"/>
<circle data-section="A" data-row="1" data-number="1" cx="10" cy="210" href="${outside.url}/c"/>`);
    const r = await importFile(main, { format: 'SVG', file: enc(file) });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({
      ok: true,
      layout: {
        canvas: { width: 1000, height: 1000 },
        stage: [{ kind: 'RECT', points: [[0, 0], [1000, 0], [1000, 100], [0, 100]] }],
        sections: [{ sectionId: '1', name: 'A', shape: { kind: 'POLYGON', points: [[0, 200], [500, 200], [500, 600], [0, 600]] }, seats: [{ seatId: '1-1-1', row: '1', number: 1, x: 10, y: 210 }] }],
      },
      errors: [],
      warnings: [{ code: 'SVG_IGNORED', ignored: ['style', 'script', 'foreignObject', 'image', 'use', 'onclick', 'href'] }],
    });
    expect(r.payload).not.toContain(outside.url);
    await new Promise((res) => setTimeout(res, 200));
    expect([outside.connections(), outside.requests()]).toEqual([0, 0]);
  });

  test('S-T32 ④ 10MB 정확히는 해석하고 1바이트 넘으면 413이며 작업을 부르지 않는다 [ASVS v5.0.0-5.1.1] [ASVS v5.0.0-15.2.2]', async () => {
    const head = svg('<polygon data-section="A" points="0,0 10,0 10,10"/>\n<!--');
    const pad = (n: number) => enc(`${head}${'x'.repeat(n - head.length - '-->\n</svg>'.length)}-->\n</svg>`);
    const before = worker.parses().length;
    const at = await importFile(main, { format: 'SVG', file: pad(10 * MiB) });
    expect(at.statusCode).toBe(200);
    expect(json(at)).toMatchObject({ ok: true });
    await until(() => worker.parses().length === before + 1, '작업 기록');
    expect(worker.parses().at(-1)).toMatchObject({ bytes: 10 * MiB, status: 'PARSE_STATUS_PARSED' });
    const over = await importFile(main, { format: 'SVG', file: pad(10 * MiB + 1) });
    expect(over.statusCode).toBe(413);
    expect(json(over)).toMatchObject({ type: `${P}seatmap-import-too-large`, status: 413 });
    await new Promise((res) => setTimeout(res, 200));
    expect(worker.parses().length).toBe(before + 1);
  });

  test('S-T32 ④ 압축 파일(gzip·zip)은 413이고 작업을 부르지 않는다 [ASVS v5.0.0-5.1.1] [ASVS v5.0.0-5.2.2]', async () => {
    const before = worker.parses().length;
    const gz = gzipSync(enc(svg('<polygon data-section="A" points="0,0 1,0 1,1"/>')));
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...enc('seatmap.svg')]);
    for (const file of [gz, zip]) {
      const r = await importFile(main, { format: 'SVG', file });
      expect(r.statusCode).toBe(413);
      expect(json(r)).toMatchObject({ type: `${P}seatmap-import-too-large` });
    }
    await new Promise((res) => setTimeout(res, 200));
    expect(worker.parses().length).toBe(before);
  });

  test('S-T32 ⑤ 좌석 50,001석·구역 501개·꼭짓점 1,001개인 JSON은 422이고 50,000·500·1,000은 받는다 [ASVS v5.0.0-2.2.1]', async () => {
    const seats = (n: number) => Array.from({ length: n }, (_, i) => ({ seatId: `s${i}`, row: String(Math.floor(i / 1000)), number: (i % 1000) + 1, x: i % 1000, y: Math.floor(i / 1000) }));
    const sec = (o: Record<string, unknown> = {}) => ({ sectionId: 'A', name: 'A', shape: { kind: 'POLYGON', points: [[0, 0], [1000, 0], [1000, 100]] }, seats: [], ...o });
    const doc = (sections: unknown[]) => enc(JSON.stringify({ canvas: { width: 1000, height: 100 }, sections }));
    const send = (sections: unknown[]) => importFile(main, { format: 'JSON', file: doc(sections) });
    const ok = await send([sec({ seats: seats(50_000) })]);
    expect(ok.statusCode).toBe(200);
    expect((json(ok).layout as { sections: { seats: unknown[] }[] }).sections[0]!.seats).toHaveLength(50_000);
    expect(json(await send([sec({ seats: seats(50_001) })]))).toMatchObject({ status: 422, detail: 'TOO_MANY_SEATS' });
    const many = (n: number) => Array.from({ length: n }, (_, i) => sec({ sectionId: `S${i}`, name: `S${i}` }));
    expect((await send(many(500))).statusCode).toBe(200);
    expect(json(await send(many(501)))).toMatchObject({ status: 422, detail: 'TOO_MANY_SECTIONS' });
    const pts = (n: number) => Array.from({ length: n }, (_, i) => [i % 1000, i % 2]);
    expect((await send([sec({ shape: { kind: 'POLYGON', points: pts(1000) } })])).statusCode).toBe(200);
    expect(json(await send([sec({ shape: { kind: 'POLYGON', points: pts(1001) } })]))).toMatchObject({ status: 422, detail: 'TOO_MANY_POINTS' });
  }, 60_000);

  test('S-T32 ⑥ format이 JSON인데 내용이 SVG면 422 FORMAT_MISMATCH다(파일 이름·확장자는 보지 않는다) [ASVS v5.0.0-5.2.2]', async () => {
    const r = await importFile(main, { format: 'JSON', file: enc(svg('<polygon data-section="A" points="0,0 1,0 1,1"/>')), name: 'layout.json', type: 'application/json' });
    expect(r.statusCode).toBe(422);
    expect(json(r)).toMatchObject({ type: `${P}seatmap-import-rejected`, detail: 'FORMAT_MISMATCH' });
    // 파일 이름·확장자·파일 칸 형식이 SVG라도 요청의 format(JSON)으로만 읽는다
    const named = await importFile(main, { format: 'JSON', file: enc(svg('<polygon data-section="A" points="0,0 1,0 1,1"/>')), name: 'map.svg', type: 'image/svg+xml' });
    expect(json(named)).toMatchObject({ status: 422, detail: 'FORMAT_MISMATCH' });
  });

  test('S-T32 ⑦ 해석이 시간 상한을 넘기는 도형은 작업이 스레드를 끝내고 422 CPU_LIMIT이다(같은 파일은 기본 상한에서 해석된다) [ASVS v5.0.0-15.2.2] [ASVS v5.0.0-15.1.3]', async () => {
    const file = enc(heavySvg());
    const cut = await importFile(slow, { format: 'SVG', file });
    expect(cut.statusCode).toBe(422);
    expect(json(cut)).toMatchObject({ type: `${P}seatmap-import-rejected`, detail: 'CPU_LIMIT' });
    expect(slowWorker.parses().at(-1)).toMatchObject({ status: 'PARSE_STATUS_REJECTED', code: 'CPU_LIMIT' });
    const whole = await importFile(main, { format: 'SVG', file });
    expect(whole.statusCode).toBe(200);
    expect((json(whole).layout as { sections: { seats: unknown[] }[] }).sections[0]!.seats).toHaveLength(50_000);
    // 기본 작업의 상한은 해석 5초·스레드 힙 384MiB다(시험용 작업만 환경 값으로 줄였다)
    expect(logLines(worker.output()).find((l) => l.event === 'seatmap_worker_started')).toMatchObject({ timeoutMs: 5_000, heapMb: 384 });
  }, 60_000);

  test('S-T32 ⑧ 구역 이름에 제어 문자·양방향 제어 문자를 넣은 CSV는 그 문자를 지운 이름으로 읽는다 [ASVS v5.0.0-1.1.1] [ASVS v5.0.0-1.3.5]', async () => {
    const csv = ['section,row,number,x,y,tier,wheelchair,gate,shape', '"V\u202eIP\u2066석\u2069\u0007\u200f",1,1,10,10,R,true,동문,"0 0;100 0;100 100;0 100"', 'VIP석,1,2,20,10,R,,동문,'].join('\n');
    const r = await importFile(main, { format: 'CSV', file: enc(csv) });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({
      ok: true,
      layout: { canvas: { width: 100, height: 100 }, stage: [], sections: [{ sectionId: '1', name: 'VIP석', shape: { kind: 'POLYGON', points: [[0, 0], [100, 0], [100, 100], [0, 100]] }, seats: [{ seatId: '1-1-1', row: '1', number: 1, x: 10, y: 10, tierId: 'R', wheelchair: true, gateZone: '동문' }, { seatId: '1-1-2', row: '1', number: 2, x: 20, y: 10, tierId: 'R', gateZone: '동문' }] }] },
      errors: [],
      warnings: [],
    });
  });

  test('S-T38 ② 한글 열 이름 CSV를 가져와 저장하면 팬 파일 좌석 ID가 모두 소문자 UUID이고 purchase-svc 판 해석기와 홀드 좌석 ID 꼴을 지난다 [ASVS v5.0.0-2.2.2]', async () => {
    const eventId = randomUUID();
    await admin.db.insert(event).values({ id: eventId, productionId: PROD_A, promoterId: A, openAt: new Date('2026-11-20T11:00:00Z'), startsAt: new Date('2026-12-24T10:00:00Z'), endsAt: new Date('2026-12-24T12:00:00Z') });
    const csv = ['section,row,number,x,y,tier,wheelchair,gate,shape', '가구역,가,1,10,10,R,,,"0 0;100 0;100 100;0 100"', '가구역,가,2,20,10,R,,,', '가구역,나,1,10,20,R,,,', '나구역,다,1,110,10,R,,,"100 0;200 0;200 100;100 100"'].join('\n');
    const r = await importFile(main, { format: 'CSV', file: enc(csv) });
    expect(r.statusCode).toBe(200);
    const layout = json(r).layout as Record<string, unknown>;
    const saved = await main.svc.http.inject({
      method: 'PUT',
      url: `/v1/partner/productions/${PROD_A}/seatmap`,
      headers: { ...partnerA(), 'content-type': 'application/json', 'if-match': '"0"' },
      payload: JSON.stringify({ ...layout, priceTiers: [{ tierId: 'R', name: 'R석', price: 50_000 }] }),
    });
    expect(saved.statusCode).toBe(200);
    const out = json(saved) as unknown as { layoutVersion: number; sections: { sectionId: string; seats: { seatId: string }[] }[] };
    const file = main.publicFiles.files.get(`v1/events/${eventId}/seatmap-layouts/1.json`);
    expect(file).toBeDefined();
    const fan = JSON.parse(new TextDecoder().decode(file!.bytes)) as { sections: { sectionId: string; seats: { seatId: string[] } }[] };
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const ids = fan.sections.flatMap((s) => s.seats.seatId);
    expect(ids).toHaveLength(4);
    for (const id of ids) expect([id, uuid.test(id), SEAT_ID_PATTERN.test(id)]).toEqual([id, true, true]);
    for (const s of fan.sections) expect(SEAT_ID_PATTERN.test(s.sectionId)).toBe(true);
    // purchase-svc의 운영 좌석맵 판 해석기가 저장 응답(SeatMapLayout)을 그대로 받는다
    const parsedMap = parseEventSeatMapFile(eventId, { perAccountLimit: 4, saleEndsAt: '2026-12-23T10:00:00Z', layout: out });
    expect(parsedMap.byId.size).toBe(4);
    expect([...parsedMap.byId.keys()].sort()).toEqual([...ids].sort());
  });

  test('S-T32 ①~⑧ 어느 경우든 원본 파일이 저장소에 남지 않는다 [ASVS v5.0.0-5.3.1] [ASVS v5.0.0-5.3.2] [ASVS v5.0.0-5.4.1]', async () => {
    // 구역 이름 상한(30자) 안이라 SVG·CSV는 받아들이는 길(ok true)까지 간다
    const marker = `MARK${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const nameMarker = `NAME${randomUUID().replaceAll('-', '')}`;
    const payloads: string[] = [];
    for (const [format, text] of [
      ['SVG', svg(`<polygon data-section="${marker}" points="0,0 1,0 1,1"/>`)],
      ['CSV', `section,row,number,x,y,tier,wheelchair,gate,shape\n${marker},1,1,1,1,,,,"0 0;1 0;1 1"`],
      ['JSON', '{"x":1}'],
      ['SVG', `<!DOCTYPE x>${marker}`],
    ] as const) {
      const r = await importFile(main, { format, file: enc(text), name: `../../${nameMarker}.svg` });
      expect([200, 422]).toContain(r.statusCode);
      payloads.push(r.payload);
    }
    expect(payloads.map((p) => (JSON.parse(p) as { ok?: boolean; status?: number }).ok ?? (JSON.parse(p) as { status: number }).status)).toEqual([true, true, 422, 422]);
    expect(await anyTableContains(marker)).toEqual([]);
    expect([main.store.quarantine.size, main.store.staging.size, main.store.published.size]).toEqual([0, 0, 0]);
    // 사용자가 보낸 파일 이름은 응답·기록·표 어디에도 쓰이지 않는다. 파일의 글자(구역 이름)도 기록에 없다
    expect(payloads.join('\n')).not.toContain(nameMarker);
    expect(await anyTableContains(nameMarker)).toEqual([]);
    expect(main.logs.text()).not.toContain(nameMarker);
    expect(main.logs.text()).not.toContain(marker);
  });
});

describe('S-T34 좌석맵 해석 작업 격리', () => {
  test('S-T34 ④ 시간 상한을 넘긴 해석은 422이고 그동안 다른 가져오기는 정상이며 작업은 다음 요청을 받는다', async () => {
    const tiny = enc(svg('<polygon data-section="A" points="0,0 10,0 10,10"/>'));
    const [cut, other] = await Promise.all([importFile(slow, { format: 'SVG', file: enc(heavySvg()) }), importFile(main, { format: 'SVG', file: tiny })]);
    expect(cut.statusCode).toBe(422);
    expect(json(cut)).toMatchObject({ detail: 'CPU_LIMIT' });
    expect(other.statusCode).toBe(200);
    expect(slowWorker.isRunning()).toBe(true);
    const again = await importFile(slow, { format: 'SVG', file: tiny });
    expect(again.statusCode).toBe(200);
  }, 60_000);

  test('S-T34 ④ 힙 상한을 넘긴 해석은 스레드만 죽고 503 Retry-After이며 작업 프로세스와 core-svc는 다음 요청을 받는다 [ASVS v5.0.0-15.2.2] [ASVS v5.0.0-15.2.5]', async () => {
    const seats = Array.from({ length: 49_000 }, (_, i) => ({ seatId: `seat-${i}-xxxxxxxxxxxxxxxx`, row: `R${i % 100}`, number: i, x: i % 1000, y: Math.floor(i / 1000), tierId: 'tier-abcdefghij', gateZone: 'gate-abcdefghij' }));
    const big = enc(JSON.stringify({ canvas: { width: 1000, height: 1000 }, sections: [{ sectionId: 'A', name: 'A', shape: { kind: 'RECT', points: [[0, 0], [1000, 0], [1000, 1000]] }, seats }] }));
    const r = await importFile(small, { format: 'JSON', file: big });
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('10');
    expect(json(r)).toMatchObject({ type: `${P}seatmap-worker-unavailable`, status: 503 });
    expect(smallWorker.parses().at(-1)).toMatchObject({ status: 'RESOURCE_EXHAUSTED', code: 'out-of-memory' });
    expect(smallWorker.isRunning()).toBe(true);
    const next = await importFile(small, { format: 'SVG', file: enc(svg('<polygon data-section="A" points="0,0 10,0 10,10"/>')) });
    expect(next.statusCode).toBe(200);
    // 같은 core-svc의 다른 경로도 그대로다
    expect((await small.svc.http.inject({ method: 'GET', url: `/v1/events/${randomUUID()}` })).statusCode).toBe(404);
  }, 60_000);

  test('S-T34 ⑤ 작업이 꺼져 있으면 503과 Retry-After 10이고, 답하지 않으면 데드라인 10초 뒤 503이다 [ASVS v5.0.0-15.1.3]', async () => {
    const w = await startWorker();
    const a = await app(w.address);
    const file = enc(svg('<polygon data-section="A" points="0,0 10,0 10,10"/>'));
    expect((await importFile(a, { format: 'SVG', file })).statusCode).toBe(200);
    await w.stop();
    const down = await importFile(a, { format: 'SVG', file });
    expect(down.statusCode).toBe(503);
    expect(down.headers['retry-after']).toBe('10');
    expect(json(down)).toMatchObject({ type: `${P}seatmap-worker-unavailable` });
    expect(a.logs.lines().filter((l) => l.event === 'seatmap_import').at(-1)).toMatchObject({ result: 'unavailable', code: 'UNAVAILABLE' });
    fake.mode = 'hang';
    const calls = fake.calls;
    const started = Date.now();
    const hung = await importFile(altered, { format: 'SVG', file });
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_500);
    expect(Date.now() - started).toBeLessThan(12_000);
    expect(fake.calls).toBe(calls + 1);
    expect(hung.statusCode).toBe(503);
    expect(altered.logs.lines().filter((l) => l.event === 'seatmap_import').at(-1)).toMatchObject({ result: 'unavailable', code: 'DEADLINE_EXCEEDED' });
    fake.mode = 'too-many';
  }, 60_000);

  test('S-T34 ⑥ 작업 응답의 배치가 좌석 50,001석이면 core-svc가 다시 보고 422로 거절하며 보안 사건으로 남긴다 [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-15.2.5]', async () => {
    const calls = fake.calls;
    const r = await importFile(altered, { format: 'JSON', file: enc('{}') });
    expect(fake.calls).toBe(calls + 1);
    expect(r.statusCode).toBe(422);
    expect(json(r)).toMatchObject({ type: `${P}seatmap-import-rejected`, detail: 'TOO_MANY_SEATS' });
    expect(altered.logs.lines().filter((l) => l.event === 'seatmap_worker_result_invalid')).toEqual([expect.objectContaining({ kind: 'security', code: 'TOO_MANY_SEATS' })]);
  });

  test('S-T34 ⑦ 12MiB 넘는 요청은 413이고 작업을 부르지 않는다(본문을 끝까지 읽지 않는다) [ASVS v5.0.0-5.1.1]', async () => {
    const before = worker.parses().length;
    const calls = fake.calls;
    const body = await multipart({ format: 'SVG' }, [{ name: 'a.svg', type: 'image/svg+xml', bytes: new Uint8Array(12 * MiB + 1) }]);
    for (const a of [main, altered]) {
      const r = await importFile(a, { raw: body });
      expect(r.statusCode).toBe(413);
      expect(json(r)).toMatchObject({ type: `${P}seatmap-import-too-large` });
    }
    await new Promise((res) => setTimeout(res, 200));
    expect(worker.parses().length).toBe(before);
    expect(fake.calls).toBe(calls);
  });

  test('S-T34 ⑦ 파일이 10MB 안이어도 본문 전체가 상한(10MB + 봉투 64KB)을 넘으면 칸을 나누기 전에 413이고 작업을 부르지 않는다 [ASVS v5.0.0-5.1.1]', async () => {
    const before = worker.parses().length;
    const body = await multipart({ format: 'SVG', note: 'x'.repeat(65 * 1024) }, [{ name: 'a.svg', type: 'image/svg+xml', bytes: new Uint8Array(10 * MiB) }]);
    const r = await importFile(main, { raw: body });
    expect(r.statusCode).toBe(413);
    expect(json(r)).toMatchObject({ type: `${P}seatmap-import-too-large` });
    await new Promise((res) => setTimeout(res, 200));
    expect(worker.parses().length).toBe(before);
  });

  test('자격 증명 환경 값(DB·Kafka·Redis·AWS)이 하나라도 있으면 seatmap-worker가 뜨지 않고 값은 글에 싣지 않는다 [ASVS v5.0.0-15.2.5]', async () => {
    for (const env of [{ PEAKET_DATABASE_URL: 'postgres://u:secret-db@h/x' }, { AWS_SECRET_ACCESS_KEY: 'secret-aws' }, { PEAKET_REDIS_SEAT_URL: 'redis://secret-redis' }, { PEAKET_KAFKA_BROKERS: '' }] as Record<string, string>[]) {
      const w = spawnWorker({ PEAKET_GRPC_PORT: '0', ...env });
      const done = await w.exited;
      expect(done.code).not.toBe(0);
      const name = Object.keys(env)[0]!;
      expect(w.output()).toContain(name);
      expect(w.output()).not.toContain('secret');
      expect(w.output()).not.toContain('seatmap_worker_started');
    }
  }, 60_000);
});

describe('가져오기 받는 쪽의 차례와 기록', () => {
  test('남의 공연·없는 공연은 같은 404이고 작업을 부르지 않으며 실패한 인가 시도로 남는다 [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-16.3.2]', async () => {
    const before = worker.parses().length;
    const file = enc(svg('<polygon data-section="A" points="0,0 1,0 1,1"/>'));
    const other = await importFile(main, { format: 'SVG', file, productionId: PROD_B });
    const none = await importFile(main, { format: 'SVG', file, productionId: randomUUID() });
    for (const r of [other, none]) {
      expect(r.statusCode).toBe(404);
      expect(json(r)).toMatchObject({ type: `${P}not-found`, status: 404 });
    }
    // X-Requested-With이 없어도, 너무 커도 남의 공연이면 먼저 404다
    expect((await importFile(main, { format: 'SVG', file, productionId: PROD_B, xrw: false })).statusCode).toBe(404);
    await new Promise((res) => setTimeout(res, 200));
    expect(worker.parses().length).toBe(before);
    const denied = main.logs.lines().filter((l) => l.event === 'partner_production_denied');
    expect(denied).toContainEqual(expect.objectContaining({ kind: 'security', route: 'seatmap_import', productionId: PROD_B, tenantId: A }));
  });

  test('X-Requested-With이 없거나, 모르는 칸·겹친 칸·틀린 format이면 400이고 작업을 부르지 않는다(형식은 SVG·JSON·CSV만) [ASVS v5.0.0-5.1.1]', async () => {
    const before = worker.parses().length;
    const file = enc(svg('<polygon data-section="A" points="0,0 1,0 1,1"/>'));
    expect((await importFile(main, { format: 'SVG', file, xrw: false })).statusCode).toBe(400);
    expect((await importFile(main, { format: 'SVG', file, fields: { extra: '1' } })).statusCode).toBe(400);
    expect((await importFile(main, { format: 'PDF', file })).statusCode).toBe(400);
    expect((await importFile(main, { format: 'SVG' })).statusCode).toBe(400);
    expect((await importFile(main, { raw: { payload: Buffer.from('garbage'), contentType: 'multipart/form-data; boundary=zzz' } })).statusCode).toBe(400);
    await new Promise((res) => setTimeout(res, 200));
    expect(worker.parses().length).toBe(before);
  });

  test('소속 확인은 행 보안을 넘는 접속에서도 테넌트 조건으로 남의 공연을 소속이 아니라고 본다(앱 층 1차 방어) [ASVS v5.0.0-8.2.1]', async () => {
    const media = new DrizzleProductionMedia(admin);
    expect([await media.owns(PROD_A, A), await media.owns(PROD_B, A), await media.owns(PROD_A, B), await media.owns(randomUUID(), A)]).toEqual([true, false, false, false]);
  });

  test('응답은 JSON 직렬화기로만 만들어 구역 이름의 따옴표·태그가 구조를 바꾸지 않는다 [ASVS v5.0.0-1.2.3]', async () => {
    const name = '"</script><b onclick=x>';
    const csv = `section,row,number,x,y,tier,wheelchair,gate,shape\n"${name.replaceAll('"', '""')}",1,1,1,1,,,,"0 0;5 0;5 5"`;
    const r = await importFile(main, { format: 'CSV', file: enc(csv) });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect((json(r).layout as { sections: { name: string }[] }).sections[0]!.name).toBe(name);
  });

  test('가져오기 결과를 형식·크기·좌석·구역 수·결과 코드로 남기고 구역 이름 같은 파트너 글자와 제어 문자는 싣지 않는다 [ASVS v5.0.0-16.1.1] [ASVS v5.0.0-16.4.1]', async () => {
    const secret = `구\n{"forged":1}\u001b[31m${randomUUID().slice(0, 6)}`;
    const q = secret.replaceAll('"', '""');
    const csv = `section,row,number,x,y,tier,wheelchair,gate,shape\n"${q}",1,1,1,1,,,,"0 0;5 0;5 5"\n"${q}",1,2,2,2,,,,`;
    const who = partnerA();
    const r = await importFile(main, { format: 'CSV', file: enc(csv), headers: who });
    expect(r.statusCode).toBe(200);
    const line = main.logs.lines().filter((l) => l.event === 'seatmap_import').at(-1);
    // 계정 원문은 플랫폼 로거가 가린다(가명은 같은 traceId의 정규 로그 줄에 있다, ADR-0053 결정 1)
    expect(line).toMatchObject({ productionId: PROD_A, accountId: '[REDACTED]', format: 'CSV', bytes: enc(csv).length, seats: 2, sections: 1, result: 'ok', level: 'info', service: 'core-svc' });
    expect([typeof line!.ts, typeof line!.traceId]).toEqual(['string', 'string']);
    expect(main.logs.text()).not.toContain(who['x-user-id']);
    const all = main.logs.text() + worker.output();
    expect(all).not.toContain('forged');
    expect(all).not.toContain('\u001b');
    expect(worker.parses().at(-1)).toMatchObject({ format: 'CSV', status: 'PARSE_STATUS_PARSED', seats: 2, sections: 1 });
  });

  test('작업이 계약 모양이 아닌 배치를 주면 반영하지 않는 결과(ok false)이고, 행 오류는 줄 번호와 함께 돌려준다 [ASVS v5.0.0-1.5.2]', async () => {
    const csv = ['section,row,number,x,y,tier,wheelchair,gate,shape', 'A,1,1,1,1,,,,"0 0;50 0;50 50"', 'A,1,1,2,2,,,,', 'A,1,x,1,1,,,,', 'B,1,1,500,500,,,,"400 400;600 400;600 600"'].join('\n');
    const r = await importFile(main, { format: 'CSV', file: enc(csv) });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({
      ok: false,
      errors: [
        { line: 4, field: 'number', code: 'NUMBER_INVALID' },
        { line: 0, field: 'sections[0].seats[1]', code: 'DUPLICATE_SEAT' },
        { line: 0, field: 'sections[0].seats[1].seatId', code: 'DUPLICATE_SEAT_ID' },
      ],
      warnings: [],
    });
    fake.mode = 'invalid';
    const bad = await importFile(altered, { format: 'JSON', file: enc('{}') });
    fake.mode = 'too-many';
    expect(bad.statusCode).toBe(200);
    expect(json(bad)).toEqual({ ok: false, errors: [{ line: 0, field: 'layout', code: 'LAYOUT_INVALID' }], warnings: [] });
    expect(altered.logs.lines().filter((l) => l.event === 'seatmap_worker_result_invalid').at(-1)).toMatchObject({ kind: 'security' });
  });
});

/** 작업 프로세스에 바로 붙는 gRPC 클라이언트(받기 상한 시험) */
function directClient(address: string) {
  const Client = grpc.makeGenericClientConstructor(seatmapServiceDefinition(), 'SeatmapImportService');
  return new Client(address, grpc.credentials.createInsecure(), { "grpc.max_send_message_length": 64 * MiB, "grpc.max_receive_message_length": 64 * MiB }) as unknown as grpc.Client & {
    ParseSeatmapImport: (req: object, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: { status: string; errors: { code: string }[] }) => void) => grpc.ClientUnaryCall;
  };
}

describe('리뷰 2차: 작업 결과 다시 보기와 작업 줄', () => {
  test('작업 응답 JSON의 __proto__ 키는 받지 않고(LAYOUT_INVALID) 보안 사건으로 남긴다 [ASVS v5.0.0-1.5.2]', async () => {
    fake.mode = 'proto';
    const r = await importFile(altered, { format: 'JSON', file: enc('{}') });
    fake.mode = 'too-many';
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ ok: false, errors: [{ line: 0, field: 'layout', code: 'LAYOUT_INVALID' }], warnings: [] });
  });

  test('S-T34 ⑥ 개수 상한은 스키마 검사보다 먼저 본다: 스키마에도 맞지 않는 5만 1석 배치는 422 TOO_MANY_SEATS다', async () => {
    fake.mode = 'too-many-invalid';
    const r = await importFile(altered, { format: 'JSON', file: enc('{}') });
    fake.mode = 'too-many';
    expect(r.statusCode).toBe(422);
    expect(json(r)).toMatchObject({ type: `${P}seatmap-import-rejected`, detail: 'TOO_MANY_SEATS' });
  });

  test('라벨 하나만 범위 밖·seatIndexRange 거꾸로·index 음수·좌석 번호 0·제어 문자가 남은 등급은 ok false 행 오류다 [ASVS v5.0.0-2.2.1]', async () => {
    fake.mode = 'weird';
    const r = await importFile(altered, { format: 'JSON', file: enc('{}') });
    fake.mode = 'too-many';
    expect(r.statusCode).toBe(200);
    expect((json(r).errors as { field: string; code: string }[]).map((e) => [e.field, e.code])).toEqual([
      ['sections[0].label', 'OUT_OF_CANVAS'],
      ['sections[0].seatIndexRange', 'RANGE_INVALID'],
      ['sections[0].seats[0].tierId', 'TEXT_INVALID'],
      ['sections[0].seats[0].number', 'NUMBER_INVALID'],
      ['sections[0].seats[0].index', 'RANGE_INVALID'],
    ]);
  });

  test('작업의 행 오류와 다시 보기 오류를 합쳐 1,000개까지만 싣는다', async () => {
    fake.mode = 'many-errors';
    const r = await importFile(altered, { format: 'JSON', file: enc('{}') });
    fake.mode = 'too-many';
    const errors = json(r).errors as { code: string }[];
    expect([r.statusCode, json(r).ok, errors.length]).toEqual([200, false, 1_000]);
    expect(errors.filter((e) => e.code === 'DUPLICATE_SEAT')).toHaveLength(0);
  });

  test('해석한 배치 JSON이 응답 상한을 넘으면 작업이 REJECTED LAYOUT_TOO_LARGE로 답하고 core-svc는 422다(503이 아니다) [ASVS v5.0.0-15.2.2]', async () => {
    const seats = Array.from({ length: 45_000 }, (_, i) => ({ seatId: `${'s'.repeat(56)}${String(i).padStart(8, '0')}`, row: 'R'.repeat(8), number: (i % 1000) + 1, x: i % 1000, y: Math.floor(i / 1000), tierId: 'T'.repeat(30), gateZone: 'G'.repeat(30) }));
    const file = enc(JSON.stringify({ canvas: { width: 1000, height: 1000 }, sections: [{ sectionId: 'A', name: 'A', shape: { kind: 'RECT', points: [[0, 0], [1000, 0], [1000, 1000]] }, seats }] }));
    expect(file.length).toBeLessThanOrEqual(10 * MiB);
    const r = await importFile(main, { format: 'JSON', file });
    expect(r.statusCode).toBe(422);
    expect(json(r)).toMatchObject({ type: `${P}seatmap-import-rejected`, detail: 'LAYOUT_TOO_LARGE' });
  }, 60_000);

  test('작업 받기 상한 12MiB: 넘는 요청은 RESOURCE_EXHAUSTED이고 상한 안은 해석한다 [ASVS v5.0.0-15.2.2]', async () => {
    const c = directClient(worker.address);
    const call = (bytes: number) => new Promise<{ code?: number; status?: string }>((res) => c.ParseSeatmapImport({ file: Buffer.alloc(bytes, 0x20), format: 'SEATMAP_FORMAT_JSON' }, { deadline: Date.now() + 20_000 }, (e, v) => res(e ? { code: e.code } : { status: v!.status })));
    expect(await call(12 * MiB + 1)).toEqual({ code: grpc.status.RESOURCE_EXHAUSTED });
    expect(await call(12 * MiB - 64)).toEqual({ status: 'PARSE_STATUS_REJECTED' });
    c.close();
  }, 60_000);

  test('작업 대기 줄(동시 1 + 대기 4)이 차면 RESOURCE_EXHAUSTED이고 core-svc는 503 Retry-After 10이다(같은 작업 프로세스)', async () => {
    const c = directClient(worker.address);
    const before = worker.parses().length;
    // 큰 파일 하나가 해석을 시작한 뒤(스레드가 뜨고 해석하는 동안) 작은 파일 넷으로 대기 줄을 채운다(작은 메시지는 바로 닿는다)
    const heavy = new Promise<void>((res) => c.ParseSeatmapImport({ file: Buffer.from(heavySvg()), format: 'SEATMAP_FORMAT_SVG' }, { deadline: Date.now() + 30_000 }, () => res()));
    await new Promise((res) => setTimeout(res, 150));
    const tiny = Buffer.from(svg('<polygon data-section="A" points="0,0 1,0 1,1"/>'));
    const queued = Array.from({ length: 4 }, () => new Promise<void>((res) => c.ParseSeatmapImport({ file: tiny, format: 'SEATMAP_FORMAT_SVG' }, { deadline: Date.now() + 30_000 }, () => res())));
    await new Promise((res) => setTimeout(res, 30));
    const r = await importFile(main, { format: 'SVG', file: enc(svg('<polygon data-section="A" points="0,0 1,0 1,1"/>')) });
    expect([r.statusCode, r.headers['retry-after']]).toEqual([503, '10']);
    expect(main.logs.lines().filter((l) => l.event === 'seatmap_import').at(-1)).toMatchObject({ result: 'unavailable', code: 'RESOURCE_EXHAUSTED' });
    await Promise.all([heavy, ...queued]);
    // 줄이 찬 요청은 해석하지 않았다: 다섯은 해석했고 하나는 busy다
    const lines = worker.parses().slice(before);
    expect([lines.filter((l) => l.status === 'PARSE_STATUS_PARSED').length, lines.filter((l) => l.code === 'busy').length]).toEqual([5, 1]);
    c.close();
  }, 60_000);

  test('차례가 왔을 때 부른 쪽이 끊었거나 데드라인이 지났으면 해석하지 않고 넘긴다(작업 기록으로 센다) [ASVS v5.0.0-15.2.2]', async () => {
    const c = directClient(worker.address);
    const before = worker.parses().length;
    const first = new Promise<void>((res) => c.ParseSeatmapImport({ file: Buffer.from(heavySvg()), format: 'SEATMAP_FORMAT_SVG' }, { deadline: Date.now() + 30_000 }, () => res()));
    await new Promise((res) => setTimeout(res, 150));
    const tiny = Buffer.from(svg('<polygon data-section="A" points="0,0 1,0 1,1"/>'));
    const cancelled = [0, 1].map(() => c.ParseSeatmapImport({ file: tiny, format: 'SEATMAP_FORMAT_SVG' }, { deadline: Date.now() + 30_000 }, () => {}));
    const expired = [0, 1].map(() => new Promise<void>((res) => c.ParseSeatmapImport({ file: tiny, format: 'SEATMAP_FORMAT_SVG' }, { deadline: Date.now() + 60 }, () => res())));
    await new Promise((res) => setTimeout(res, 20));
    for (const k of cancelled) k.cancel();
    await Promise.all([first, ...expired]);
    await until(() => worker.parses().length >= before + 5, '작업 기록 다섯 줄', 20_000);
    const lines = worker.parses().slice(before);
    expect(lines.filter((l) => l.status === 'PARSE_STATUS_PARSED')).toHaveLength(1);
    expect(lines.filter((l) => l.status === 'SKIPPED').map((l) => l.code).sort()).toEqual(['cancelled', 'cancelled', 'deadline', 'deadline']);
    c.close();
  }, 60_000);

  test('S-T34 ④ 시간 상한을 넘긴 해석이 있어도 같은 작업 프로세스의 다른 가져오기는 정상이다', async () => {
    const [cut, other] = await Promise.all([importFile(slow, { format: 'SVG', file: enc(heavySvg()) }), importFile(slow, { format: 'SVG', file: enc(svg('<polygon data-section="A" points="0,0 10,0 10,10"/>')) })]);
    expect([cut.statusCode, json(cut).detail]).toEqual([422, 'CPU_LIMIT']);
    expect(other.statusCode).toBe(200);
  }, 60_000);
});
