// 공연용 배치본 저장·불러오기·팬 좌석맵 파일 게시 통합 시험(BUILD_ORDER HOT-240, ADR-0260, docs/features/seat-hold.md §10, S-T38).
// 실제 PostgreSQL 18 컨테이너, 실제 core-svc HTTP 앱(운영과 같은 권한의 DB 사용자), 로컬 폴더 어댑터의 실제 파일을 잇는다.
// 팬 파일은 폴더에서 다시 읽어 @peaket/seatmap의 decodeLayout으로 푼다. 파일 저장소는 실제 로컬 폴더 어댑터를 감싼 기록기라, 쓰기 사이에
// 다른 저장·회차 더하기·오픈 시각 넘기기를 끼워 넣고(두 트랜잭션 사이) 쓰기·지우기 실패를 넣는다.
import 'reflect-metadata';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { createDatabase, createService, type Database, ensureOutboxPartitions, fakeClock, systemClock } from '@peaket/platform';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { decodeLayout } from '../../../packages/seatmap/src/layout.js';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleSeatmapLayoutStore } from '../src/modules/catalog/adapters/db/drizzle-seatmap-layout.js';
import { event, place, priceTier, production, promoter, seat, section, venue } from '../src/modules/catalog/adapters/db/schema.js';
import { LocalFolderPublicFileStore } from '../src/modules/catalog/index.js';
import type { PublicFileStore, PublishLimits } from '../src/modules/catalog/domain/seatmap-ports.js';
import { layoutVenueId } from '../src/modules/catalog/domain/seatmap-layout.js';
import { FakeIdentity, NOW_MS, testMedia } from '../test/support.js';
import { buildDist, freePort, logSink, multipart, SERVICE_DIR, until } from './media-support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

type Svc = Awaited<ReturnType<typeof createService>>;

/** 실제 로컬 폴더 어댑터를 감싸 쓰기·지우기를 기록하고, 쓰기 사이에 일을 끼워 넣거나 실패를 넣는다 */
class RecordingStore implements PublicFileStore {
  puts: { key: string; contentType: string; cacheControl: string; bytes: Uint8Array }[] = [];
  deletes: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  /** 쓰기마다 먼저 부른다(두 트랜잭션 사이에 끼워 넣기) */
  beforePut: ((key: string) => Promise<void> | void) | undefined;
  /** 참이면 그 쓰기를 실패시킨다(n은 지금까지의 쓰기 수, 1부터) */
  failPut: ((key: string, n: number) => boolean) | undefined;
  failDelete = false;
  delayMs = 0;
  constructor(readonly inner: PublicFileStore) {}
  reset(): void {
    this.puts = [];
    this.deletes = [];
    this.maxInFlight = 0;
    this.beforePut = undefined;
    this.failPut = undefined;
    this.failDelete = false;
    this.delayMs = 0;
  }
  async put(key: string, bytes: Uint8Array, meta: { contentType: string; cacheControl: string }): Promise<void> {
    const n = this.puts.length + 1;
    this.puts.push({ key, ...meta, bytes });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.beforePut) await this.beforePut(key);
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      if (this.failPut?.(key, n)) throw new Error('파일 쓰기 실패(시험이 넣음)');
      await this.inner.put(key, bytes, meta);
    } finally {
      this.inFlight--;
    }
  }
  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    if (this.failDelete) throw new Error('파일 지우기 실패(시험이 넣음)');
    await this.inner.delete(key);
  }
}

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let svc: Svc;
let root: string;
let store: RecordingStore;
const logs = logSink();
const identity = new FakeIdentity();
/** 시험 값은 운영 기본(8개·20초)과 다르게 둔다. 시험마다 바꿔 본다 */
const limits: PublishLimits = { concurrency: 5, totalMs: 10_000 };
const A = randomUUID();
const B = randomUUID();
const PLACE = randomUUID();
const P = 'https://peaket.example/problems/';
const MiB = 1024 * 1024;
const NOW = new Date(NOW_MS);
const FUTURE_OPEN = new Date('2026-11-20T11:00:00Z');

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-test', max: 6 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 6);
  await admin.db.insert(promoter).values([
    { id: A, legalName: '(주)에이' },
    { id: B, legalName: '(주)비' },
  ]);
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: randomUUID() });
  root = await mkdtemp(join(tmpdir(), 'peaket-public-'));
  store = new RecordingStore(new LocalFolderPublicFileStore(root));
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, media: testMedia({ publicFiles: store, publishLimits: limits }) }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: logs.stream,
    adminAuthz: identity,
  });
}, 180_000);

afterAll(async () => {
  await svc?.close();
  await appDb?.close();
  await partnerDb?.close();
  await admin?.close();
  pg?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  store.reset();
  limits.concurrency = 5;
  limits.totalMs = 10_000;
});

// ---------- 자료 ----------

const sq = (x: number, y: number, w: number): [number, number][] => [
  [x, y],
  [x + w, y],
  [x + w, y + w],
  [x, y + w],
];
const TIERS = [
  { tierId: 'VIP', name: 'VIP석', price: 180_000 },
  { tierId: 'R', name: 'R석', price: 150_000 },
  { tierId: 'S', name: 'S석', price: 99_000 },
];
const seatsOf = (sec: string, n: number, o: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => ({ seatId: `${sec}-1-${i + 1}`, row: '1', number: i + 1, x: (sec === 'A' ? 10 : 610) + i * 50, y: 100, ...o }));
const secA = (n = 3, o: Record<string, unknown> = {}) => ({ sectionId: 'A', name: 'A구역', level: '1층', shape: { kind: 'POLYGON', points: sq(0, 0, 500) }, tierId: 'R', gateZone: 'G1', fillRule: { method: 'COUNT', targetCount: n }, seats: seatsOf('A', n), ...o });
const secB = (n = 2, o: Record<string, unknown> = {}) => ({ sectionId: 'B', name: 'B구역', shape: { kind: 'RECT', points: sq(600, 0, 500) }, label: { x: 850, y: 250 }, tierId: 'S', seats: seatsOf('B', n, { tierId: 'VIP' }), ...o });
function layoutBody(o: Record<string, unknown> = {}): Record<string, unknown> {
  return { canvas: { width: 2000, height: 1500 }, stage: [{ kind: 'RECT', points: sq(900, 1000, 200), name: '무대' }], sections: [secA(), secB()], priceTiers: TIERS, ...o };
}

interface Made {
  id: string;
  /** event 행 */
  events: string[];
  /** 변경분의 더한 회차 */
  pending: string[];
}

const times = (openAt: Date, day: number) => ({ openAt, startsAt: new Date(Date.UTC(2026, 11, day, 10)), endsAt: new Date(Date.UTC(2026, 11, day, 12)) });

/** 공연 하나(event 행 rows개, 변경분의 더한 회차 pending개). approved면 승인 이력이 있다 */
async function makeProduction(o: { tenant?: string; approved?: boolean; rows?: number; pending?: number; openAt?: Date } = {}): Promise<Made> {
  const id = randomUUID();
  const tenant = o.tenant ?? A;
  const events = Array.from({ length: o.rows ?? 2 }, () => randomUUID());
  const pending = Array.from({ length: o.pending ?? 0 }, () => randomUUID());
  const addedEvents = pending.map((eventId, i) => {
    const t = times(o.openAt ?? FUTURE_OPEN, 20 + i);
    return { eventId, openAt: t.openAt.toISOString(), startsAt: t.startsAt.toISOString(), endsAt: t.endsAt.toISOString(), lobbyMinutes: 10, reentryAllowed: false, lobbyShuffle: true, openBatch: true, seatAssignment: 'PICK', perPersonLimit: 4, addedAt: NOW.toISOString() };
  });
  await admin.db.insert(production).values({
    id,
    promoterId: tenant,
    placeId: PLACE,
    title: '겨울 콘서트',
    genre: '콘서트',
    saleReview: o.approved ? 'APPROVED' : 'DRAFT',
    saleApprovedAt: o.approved ? new Date('2026-11-01T00:00:00Z') : null,
    pendingRevision: pending.length > 0 ? { addedEvents } : null,
  });
  if (events.length > 0) await admin.db.insert(event).values(events.map((e, i) => ({ id: e, productionId: id, promoterId: tenant, ...times(o.openAt ?? FUTURE_OPEN, 10 + i) })));
  return { id, events, pending };
}

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const stagedDir = (eventId: string) => join(root, 'staging', 'v1', 'events', eventId, 'seatmap-layouts');
async function stagedFiles(eventId: string): Promise<string[]> {
  try {
    return (await readdir(stagedDir(eventId))).sort();
  } catch {
    return [];
  }
}
type SavedLayout = { sections: { sectionId: string; seats: { seatId: string; row: string; number: number; index: number }[] }[] };
/** 저장 응답의 서버 좌석 ID(구역/열/번호 → 좌석 ID) */
const idsOf = (r: { payload: string }) => new Map<string, string>((json(r) as unknown as SavedLayout).sections.flatMap((s) => s.seats.map((x) => [`${s.sectionId}/${x.row}/${x.number}`, x.seatId] as const)));
/** 본문 좌석에 서버 좌석 ID를 넣는다(없는 좌석은 보낸 값 그대로) */
function withIds(body: Record<string, unknown>, ids: Map<string, string>): Record<string, unknown> {
  const sections = (body.sections as { sectionId: string; seats?: { row: string; number: number; seatId: string }[] }[]).map((s) => ({ ...s, seats: (s.seats ?? []).map((x) => ({ ...x, seatId: ids.get(`${s.sectionId}/${x.row}/${x.number}`) ?? x.seatId })) }));
  return { ...body, sections };
}
/** 파트너 DB 사용자의 열린 트랜잭션 수(파일을 쓰는 동안 0이어야 한다, docs/architecture.md idle_in_transaction 10초) */
async function openPartnerTx(): Promise<number> {
  const r = await admin.db.execute(sql`select count(*)::int as n, string_agg(left(query, 120), ' | ') as q from pg_stat_activity where usename = 'core_partner_login' and state like 'idle in transaction%'`);
  const row = (r.rows as { n: number; q: string | null }[])[0]!;
  if (row.n > 0) console.log('열린 트랜잭션:', row.q);
  return row.n;
}

/** 승인 이력이 없는 동안 판 1을 저장하고 승인한다(행에 승인된 판이 있는 공연) */
async function approvedWithRows(o: { openAt?: Date; rows?: number } = {}): Promise<Made & { ids: Map<string, string> }> {
  const m = await makeProduction({ rows: o.rows ?? 2 });
  const r = await put(m.id, adminOf(A), layoutBody(), '"0"');
  expect(r.statusCode).toBe(200);
  const ids = idsOf(r);
  await admin.db.update(production).set({ saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') }).where(eq(production.id, m.id));
  if (o.openAt) await admin.db.update(event).set({ openAt: o.openAt }).where(eq(event.id, m.events[0]!));
  store.reset();
  return { ...m, ids };
}

const adminOf = (t: string) => identity.partner(t, 'partner_admin');
const memberOf = (t: string) => identity.partner(t, 'partner_member');

function put(productionId: string, h: Record<string, string>, body: unknown, ifMatch?: string) {
  return svc.http.inject({
    method: 'PUT',
    url: `/v1/partner/productions/${productionId}/seatmap`,
    headers: { ...h, 'content-type': 'application/json', ...(ifMatch !== undefined ? { 'if-match': ifMatch } : {}) },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const get = (productionId: string, h: Record<string, string>, query = '') => svc.http.inject({ method: 'GET', url: `/v1/partner/productions/${productionId}/seatmap${query}`, headers: h });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

const layoutDir = (eventId: string) => join(root, 'public', 'v1', 'events', eventId, 'seatmap-layouts');
async function files(eventId: string): Promise<string[]> {
  try {
    return (await readdir(layoutDir(eventId))).sort();
  } catch {
    return [];
  }
}
const fileOf = async (eventId: string, v: number) => readFile(join(layoutDir(eventId), `${v}.json`));

async function venueRow(productionId: string) {
  const [v] = await admin.db.select().from(venue).where(eq(venue.id, layoutVenueId(productionId)));
  return v;
}
async function rowCounts(productionId: string) {
  const id = layoutVenueId(productionId);
  const n = async (t: typeof section | typeof seat | typeof priceTier) => (await admin.db.select({ n: sql<number>`count(*)::int` }).from(t).where(eq(t.venueId, id)))[0]!.n;
  return { sections: await n(section), seats: await n(seat), tiers: await n(priceTier) };
}
const securityLines = (event: string) => logs.lines().filter((l) => l.kind === 'security' && l.event === event);

// ---------- S-T38 ----------

describe('S-T38 배치본 저장과 팬 좌석맵 파일', () => {
  test('S-T38 ① 구역 차례와 어긋난 색인·빈틈 범위·좌석 차례와 다른 index는 422이고 판·파일이 그대로다 [ASVS v5.0.0-2.2.2] [ASVS v5.0.0-2.1.2]', async () => {
    const m = await makeProduction({ approved: true, rows: 2, pending: 1 });
    const bad = [
      layoutBody({ sections: [secA(3, { seatIndexRange: { from: 2, to: 4 } }), secB()] }),
      layoutBody({ sections: [secA(), secB(2, { seatIndexRange: { from: 4, to: 5 } })] }),
      layoutBody({ sections: [secA(3, { seats: seatsOf('A', 3).map((s, i) => ({ ...s, index: [0, 2, 1][i] })) }), secB()] }),
    ];
    const fields = ['sections[0].seatIndexRange', 'sections[1].seatIndexRange', 'sections[0].seats[1].index'];
    for (const [i, body] of bad.entries()) {
      const r = await put(m.id, adminOf(A), body, '"0"');
      expect(r.statusCode).toBe(422);
      const p = json(r);
      expect(p.type).toBe(`${P}seatmap-invalid`);
      expect((p.result as { ok: boolean; errors: { field: string; code: string }[] }).errors).toContainEqual({ line: 0, field: fields[i], code: 'INDEX_MISMATCH' });
      expect((p.result as { ok: boolean }).ok).toBe(false);
    }
    // 판이 오르지 않고(배치본 행도 판 차례도 없다) 파일이 0개다
    expect(await venueRow(m.id)).toBeUndefined();
    expect(store.puts).toEqual([]);
    for (const e of [...m.events, ...m.pending]) expect(await files(e)).toEqual([]);
  });

  test('S-T38 ② 판 0 저장은 판 1, 모든 회차(변경분 포함)에 같은 venue_id, 회차마다 풀리는 팬 파일 하나 [ASVS v5.0.0-5.3.1] [ASVS v5.0.0-5.3.2]', async () => {
    const m = await makeProduction({ approved: true, rows: 2, pending: 1 });
    const tiers = [TIERS[2]!, TIERS[0]!, TIERS[1]!];
    const r = await put(m.id, adminOf(A), layoutBody({ priceTiers: tiers }), '"0"');
    expect(r.statusCode).toBe(200);
    expect(r.headers.etag).toBe('"1"');
    expect(r.headers['cache-control']).toBe('no-store');
    const out = json(r) as { layoutVersion: number; fanFilePublished: boolean; priceTiers: unknown; sections: { seatIndexRange: unknown; seats: { seatId: string; index: number }[] }[] };
    expect(out.layoutVersion).toBe(1);
    expect(out.fanFilePublished).toBe(true);
    expect(out.priceTiers).toEqual(tiers);
    expect(out.sections.map((s) => s.seatIndexRange)).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 4 },
    ]);
    expect(out.sections.flatMap((s) => s.seats.map((x) => x.index))).toEqual([0, 1, 2, 3, 4]);
    // 좌석 ID는 서버가 매긴 소문자 UUID다(보낸 A-1-1 같은 값은 쓰지 않는다, 리뷰 H2)
    expect(out.sections.flatMap((s) => s.seats.map((x) => x.seatId)).every((id) => UUID_LOWER.test(id))).toBe(true);
    // 세 회차 모두 같은 배치본(event 행 둘과 변경분의 더한 회차)
    const vid = layoutVenueId(m.id);
    const rows = await admin.db.select({ id: event.id, venueId: event.venueId }).from(event).where(eq(event.productionId, m.id));
    expect(rows.map((x) => x.venueId)).toEqual([vid, vid]);
    const [p] = await admin.db.select().from(production).where(eq(production.id, m.id));
    expect((p!.pendingRevision as { addedEvents: { eventId: string; venueId: string }[] }).addedEvents.map((x) => [x.eventId, x.venueId])).toEqual([[m.pending[0], vid]]);
    // 회차마다 1.json 하나(승인 이력이 있어 준비 위치, 리뷰 H3), 같은 바이트, decodeLayout을 지나고 열 위치가 서버가 매긴 index, tiers가 보이는 순서
    const all = [...m.events, ...m.pending];
    const stagedOf = (e: string) => readFile(join(stagedDir(e), '1.json'));
    const first = await stagedOf(all[0]!);
    for (const e of all) {
      expect([await files(e), await stagedFiles(e)]).toEqual([[], ['1.json']]);
      expect(Buffer.compare(await stagedOf(e), first)).toBe(0);
    }
    const f = JSON.parse(first.toString('utf8'));
    const d = decodeLayout(f);
    expect(d.layoutVersion).toBe(1);
    expect(f.tiers).toEqual(['S', 'VIP', 'R']);
    for (const s of out.sections) {
      const col = f.sections.find((x: { sectionId: string }) => x.sectionId === (s as unknown as { sectionId: string }).sectionId);
      for (const seat of s.seats) expect(col.seats.seatId[seat.index - col.seatIndexRange.from]).toBe(seat.seatId);
    }
    expect(f.sections[0].seats.tier).toEqual([2, 2, 2]);
    expect(f.sections[1].seats.tier).toEqual([1, 1]);
    // 키는 DB의 회차 ID와 서버가 잡은 정수 판으로만, 메타데이터는 JSON·immutable
    expect(store.puts.map((x) => x.key).sort()).toEqual(all.map((e) => `staging/v1/events/${e}/seatmap-layouts/1.json`).sort());
    for (const x of store.puts) expect([x.contentType, x.cacheControl]).toEqual(['application/json; charset=utf-8', 'public, max-age=31536000, immutable']);
    expect(logs.lines().filter((l) => l.event === 'seatmap_saved').at(-1)).toMatchObject({ productionId: m.id, version: 1, seats: 5, sections: 2, published: true, rounds: 3 });
  });

  test('S-T38 ② 승인 이력이 없는 공연은 구역·좌석·가격 등급 행을 바꿔 넣고 layout_version이 새 판이며 불러오기가 그 배치를 준다', async () => {
    const m = await makeProduction({ rows: 2 });
    const r = await put(m.id, memberOf(A), layoutBody(), '"0"');
    expect(r.statusCode).toBe(200);
    expect(await rowCounts(m.id)).toEqual({ sections: 2, seats: 5, tiers: 3 });
    expect(await venueRow(m.id)).toMatchObject({ kind: 'LAYOUT', promoterId: A, layoutVersion: 1, versionSeq: 1, pendingLayout: null, canvasWidth: 2000, canvasHeight: 1500 });
    const g = await get(m.id, memberOf(A));
    expect(g.statusCode).toBe(200);
    expect(g.headers.etag).toBe('"1"');
    expect(g.headers['cache-control']).toBe('no-store');
    const out = json(g);
    expect(out).toEqual({ ...json(r), fanFilePublished: undefined });
    // 다시 보낸 서버 좌석 ID는 다음 저장에도 그대로이고(행을 바꿔 넣어도) 새 좌석만 새 ID를 받으며 앞 판 파일은 지운다
    const before = idsOf(r);
    const r2 = await put(m.id, memberOf(A), withIds(layoutBody({ sections: [secA(4), secB()] }), before), '"1"');
    expect(r2.statusCode).toBe(200);
    expect(await rowCounts(m.id)).toEqual({ sections: 2, seats: 6, tiers: 3 });
    const keys = (await admin.db.select({ k: seat.seatKey }).from(seat).where(eq(seat.venueId, layoutVenueId(m.id))).orderBy(seat.seatIndex)).map((x) => String(x.k));
    const after = idsOf(r2);
    expect(keys).toEqual(['A/1/1', 'A/1/2', 'A/1/3', 'A/1/4', 'B/1/1', 'B/1/2'].map((k) => after.get(k)));
    for (const k of ['A/1/1', 'A/1/2', 'A/1/3', 'B/1/1', 'B/1/2']) expect(after.get(k)).toBe(before.get(k));
    expect(before.has('A/1/4')).toBe(false);
    for (const e of m.events) expect(await files(e)).toEqual(['2.json']);
  });

  test('S-T38 ③ 옛 판 412·없음 428, 동시 저장은 하나만 이기고 진 판 번호는 다시 쓰이지 않는다 [ASVS v5.0.0-2.2.3]', async () => {
    const m = await makeProduction({ rows: 2 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    store.reset();
    // 옛 판·없음·꼴이 틀린 If-Match·본문 판이 머리와 다름: 판을 잡기 전에 거절한다(판 차례와 파일을 건드리지 않는다)
    const stale = await put(m.id, memberOf(A), layoutBody(), '"0"');
    expect([stale.statusCode, json(stale).type]).toEqual([412, `${P}precondition-failed`]);
    const none = await put(m.id, memberOf(A), layoutBody());
    expect([none.statusCode, json(none).type]).toEqual([428, `${P}precondition-required`]);
    expect((await put(m.id, memberOf(A), layoutBody(), 'W/"1"')).statusCode).toBe(412);
    expect((await put(m.id, memberOf(A), layoutBody({ layoutVersion: 0 }), '"1"')).statusCode).toBe(412);
    expect((await venueRow(m.id))!.versionSeq).toBe(1);
    expect(store.puts).toEqual([]);

    // 같은 판의 동시 저장 둘: 둘 다 판을 잡을 때까지 쓰기를 붙잡아 두 트랜잭션 ②가 겹치게 한다
    const started = new Set<string>();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    store.beforePut = async (key) => {
      started.add(key.split('/').at(-1)!);
      if (started.size >= 2) release();
      await gate;
    };
    const [x, y] = await Promise.all([put(m.id, memberOf(A), layoutBody({ sections: [secA(2), secB()] }), '"1"'), put(m.id, memberOf(A), layoutBody({ sections: [secA(1), secB()] }), '"1"')]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 412]);
    const win = x.statusCode === 200 ? x : y;
    const winV = json(win).layoutVersion as number;
    const loseV = winV === 2 ? 3 : 2;
    expect((await venueRow(m.id))!.versionSeq).toBe(3);
    // 이긴 판 파일만 남고(진 판 파일은 지웠다), 같은 키에 두 번 쓴 적이 없어 이긴 판 파일 바이트가 그대로다
    const keys = store.puts.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of m.events) {
      expect(await files(e)).toEqual([`${winV}.json`]);
      const written = store.puts.find((p) => p.key === `v1/events/${e}/seatmap-layouts/${winV}.json`)!;
      expect(Buffer.compare(await fileOf(e, winV), Buffer.from(written.bytes))).toBe(0);
    }
    expect(store.deletes).toEqual(expect.arrayContaining(m.events.map((e) => `v1/events/${e}/seatmap-layouts/${loseV}.json`)));
    // 다음 저장은 진 판 번호를 다시 쓰지 않는다
    store.reset();
    const next = await put(m.id, memberOf(A), layoutBody(), `"${winV}"`);
    expect(json(next).layoutVersion).toBe(4);
    expect(store.puts.some((p) => p.key.endsWith(`/${loseV}.json`))).toBe(false);
  });

  test('S-T38 ③ 판 9 → 10을 지나도 판을 수로 견주고 파일 이름도 10이다', async () => {
    const m = await makeProduction({ rows: 1 });
    for (let v = 0; v < 10; v++) expect((await put(m.id, memberOf(A), layoutBody(), `"${v}"`)).statusCode).toBe(200);
    expect((await get(m.id, memberOf(A))).headers.etag).toBe('"10"');
    expect(json(await get(m.id, memberOf(A))).layoutVersion).toBe(10);
    expect(await files(m.events[0]!)).toEqual(['10.json']);
    expect((await put(m.id, memberOf(A), layoutBody(), '"9"')).statusCode).toBe(412);
    expect((await put(m.id, memberOf(A), layoutBody({ layoutVersion: 10 }), '"10"')).statusCode).toBe(200);
    expect(await files(m.events[0]!)).toEqual(['11.json']);
  });

  test('S-T38 ③ 트랜잭션 ①과 ② 사이에 다른 저장이 커밋되면 ②가 412로 거절하고 그 판 파일을 지운다 [ASVS v5.0.0-2.2.3]', async () => {
    const m = await makeProduction({ rows: 2 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    store.reset();
    let other: Awaited<ReturnType<typeof put>> | undefined;
    store.beforePut = async () => {
      if (other) return;
      store.beforePut = undefined;
      other = await put(m.id, memberOf(A), layoutBody({ sections: [secA(1), secB()] }), '"1"');
    };
    const r = await put(m.id, memberOf(A), layoutBody({ sections: [secA(2), secB()] }), '"1"');
    expect(other!.statusCode).toBe(200);
    expect(json(other!).layoutVersion).toBe(3);
    expect([r.statusCode, json(r).type]).toEqual([412, `${P}precondition-failed`]);
    for (const e of m.events) expect(await files(e)).toEqual(['3.json']);
    expect((await venueRow(m.id))).toMatchObject({ layoutVersion: 3, versionSeq: 3 });
  });

  test('S-T38 ③ 첫 배치본 저장 중에 더한 회차도 트랜잭션 ②가 같은 배치본에 잇고 그 판 파일을 쓴다', async () => {
    const m = await makeProduction({ rows: 1 });
    let added: string | undefined;
    store.beforePut = async () => {
      if (added) return;
      store.beforePut = undefined;
      const r = await svc.http.inject({
        method: 'POST',
        url: `/v1/partner/productions/${m.id}/events`,
        headers: { ...memberOf(A), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        payload: JSON.stringify({ openAt: '2026-11-21T11:00:00Z', startsAt: '2026-12-26T10:00:00Z', endsAt: '2026-12-26T12:00:00Z' }),
      });
      expect(r.statusCode).toBe(201);
      added = json(r).eventId as string;
    };
    const r = await put(m.id, memberOf(A), layoutBody(), '"0"');
    expect(r.statusCode).toBe(200);
    const [e] = await admin.db.select().from(event).where(eq(event.id, added!));
    expect(e!.venueId).toBe(layoutVenueId(m.id));
    expect(await files(added!)).toEqual(['1.json']);
    expect(Buffer.compare(await fileOf(added!, 1), await fileOf(m.events[0]!, 1))).toBe(0);
  });

  test('S-T38 ④ 파일 쓰기 실패는 503이고 판·행이 그대로이며 그 판 파일이 남지 않는다', async () => {
    const m = await makeProduction({ rows: 3 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    const before = await rowCounts(m.id);
    store.reset();
    // 셋 가운데 둘을 쓴 뒤 실패한다(이미 쓴 둘을 지운다)
    limits.concurrency = 1;
    store.failPut = (_k, n) => n === 3;
    const r = await put(m.id, memberOf(A), layoutBody({ sections: [secA(5), secB()] }), '"1"');
    expect([r.statusCode, json(r).type, r.headers['retry-after']]).toEqual([503, `${P}seatmap-publish-unavailable`, '10']);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(store.puts.length).toBe(3);
    expect(await venueRow(m.id)).toMatchObject({ layoutVersion: 1, versionSeq: 2 });
    expect(await rowCounts(m.id)).toEqual(before);
    for (const e of m.events) expect(await files(e)).toEqual(['1.json']);
    expect(logs.lines().filter((l) => l.event === 'seatmap_publish_failed').at(-1)).toMatchObject({ productionId: m.id, version: 2, failed: 1, reason: 'write' });
    // 버린 번호 2는 다시 쓰지 않는다
    store.reset();
    expect(json(await put(m.id, memberOf(A), layoutBody(), '"1"')).layoutVersion).toBe(3);
    for (const e of m.events) expect(await files(e)).toEqual(['3.json']);
  });

  test('S-T38 ④ 전체 시한을 넘긴 게시는 503이고 늦게 끝난 쓰기의 파일도 지운다', async () => {
    const m = await makeProduction({ rows: 2 });
    limits.totalMs = 150;
    store.delayMs = 600;
    const r = await put(m.id, memberOf(A), layoutBody(), '"0"');
    expect([r.statusCode, json(r).type]).toEqual([503, `${P}seatmap-publish-unavailable`]);
    expect(logs.lines().filter((l) => l.event === 'seatmap_publish_failed').at(-1)).toMatchObject({ productionId: m.id, version: 1, reason: 'timeout' });
    // 늦게 끝난 쓰기가 파일을 남기지 않는다
    await until(async () => store.inFlight === 0, '늦은 쓰기 끝', 5_000);
    await until(async () => (await Promise.all(m.events.map(files))).every((f) => f.length === 0), '늦은 파일 지우기', 5_000);
    expect(await venueRow(m.id)).toMatchObject({ layoutVersion: 0, versionSeq: 1 });
    expect(await rowCounts(m.id)).toEqual({ sections: 0, seats: 0, tiers: 0 });
  });

  test('S-T38 ④ 트랜잭션 ②가 실패하면 판은 버린 번호가 되고 그 판 파일을 지운다', async () => {
    const m = await makeProduction({ rows: 2 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    store.reset();
    // 게시 뒤(트랜잭션 ② 전) 좌석 행을 받지 않는 제약을 걸어 ②의 쓰기가 실제로 실패하게 한다
    store.beforePut = async () => {
      store.beforePut = undefined;
      await admin.db.execute(sql`alter table seat add constraint seat_test_block check (x < 0) not valid`);
    };
    try {
      const r = await put(m.id, memberOf(A), layoutBody({ sections: [secA(2), secB()] }), '"1"');
      expect(r.statusCode).toBe(500);
    } finally {
      await admin.db.execute(sql`alter table seat drop constraint if exists seat_test_block`);
    }
    expect(store.puts.length).toBe(2);
    expect(await venueRow(m.id)).toMatchObject({ layoutVersion: 1, versionSeq: 2 });
    for (const e of m.events) expect(await files(e)).toEqual(['1.json']);
  });

  test('S-T38 ④ 커밋 뒤 앞 판 지우기가 실패해도 응답은 200이고 남은 파일 수를 기록한다', async () => {
    const m = await makeProduction({ rows: 2 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    store.reset();
    store.failDelete = true;
    const r = await put(m.id, memberOf(A), layoutBody(), '"1"');
    expect(r.statusCode).toBe(200);
    expect(logs.lines().filter((l) => l.event === 'seatmap_file_leftover').at(-1)).toMatchObject({ productionId: m.id, version: 1, count: 2 });
    for (const e of m.events) expect(await files(e)).toEqual(['1.json', '2.json']);
  });

  test('S-T38 ⑤ 승인 공연의 오픈 뒤 도형·좌석 변경은 409 seatmap-geometry-locked·가격은 sale-setting-locked·속성만은 200 [ASVS v5.0.0-16.3.3] [ASVS v5.0.0-2.1.2]', async () => {
    // 회차 하나의 open_at이 지금과 같다(경계에서 잠긴다)
    const m = await approvedWithRows({ openAt: NOW });
    const seatsA = seatsOf('A', 3).map((x) => ({ ...x, seatId: m.ids.get(`A/${x.row}/${x.number}`)! }));
    const withServer = (b: Record<string, unknown>) => withIds(b, m.ids);
    const cases: [string, Record<string, unknown>, string[]][] = [
      ['좌표', layoutBody({ sections: [secA(3, { seats: seatsA.map((s, i) => (i === 0 ? { ...s, x: s.x + 1 } : s)) }), secB()] }), ['SEAT_GEOMETRY']],
      ['좌석 추가', layoutBody({ sections: [secA(4), secB()] }), ['SEAT_SET']],
      ['색인(좌석 차례 바꿈)', layoutBody({ sections: [secA(3, { seats: [seatsA[1], seatsA[0], seatsA[2]] }), secB()] }), ['SEAT_SET']],
      ['좌석 등급', layoutBody({ sections: [secA(3, { seats: seatsA.map((s, i) => (i === 0 ? { ...s, tierId: 'S' } : s)) }), secB()] }), ['SEAT_GEOMETRY']],
      ['구역 차례', layoutBody({ sections: [secB(), secA()] }), ['SEAT_SET', 'SECTION_SET']],
    ];
    for (const [what, body, changes] of cases) {
      const r = await put(m.id, adminOf(A), withServer(body), '"1"');
      expect([what, r.statusCode, json(r).type]).toEqual([what, 409, `${P}seatmap-geometry-locked`]);
      expect(securityLines('seatmap_locked_attempt').at(-1)).toMatchObject({ productionId: m.id, changes });
    }
    const price = await put(m.id, adminOf(A), withServer(layoutBody({ priceTiers: TIERS.map((t, i) => (i === 0 ? { ...t, price: t.price + 1000 } : t)) })), '"1"');
    expect([price.statusCode, json(price).type]).toEqual([409, `${P}sale-setting-locked`]);
    // 판을 잡지 않았다(트랜잭션 ①에서 거절)
    expect((await venueRow(m.id))!.versionSeq).toBe(1);
    expect(store.puts).toEqual([]);
    // 판매 제외·휠체어석·게이트만 바꾸면 받는다(재승인 대기 판)
    const attrs = await put(m.id, adminOf(A), withServer(layoutBody({ sections: [secA(3, { gateZone: 'G7', seats: seatsA.map((s, i) => ({ ...s, unavailable: i === 0, wheelchair: i === 1, gateZone: 'G8' })) }), secB()] })), '"1"');
    expect(attrs.statusCode).toBe(200);
    expect(json(attrs).layoutVersion).toBe(2);
  });

  test('S-T38 ⑤ 트랜잭션 ①과 ② 사이에 오픈 시각이 지나면 ②가 409로 거절하고 그 판 파일을 지운다 [ASVS v5.0.0-16.3.3]', async () => {
    const m = await approvedWithRows();
    store.beforePut = async () => {
      store.beforePut = undefined;
      await admin.db.update(event).set({ openAt: new Date(NOW_MS - 1) }).where(eq(event.id, m.events[1]!));
    };
    const r = await put(m.id, adminOf(A), layoutBody({ sections: [secA(4), secB()] }), '"1"');
    expect([r.statusCode, json(r).type]).toEqual([409, `${P}seatmap-geometry-locked`]);
    expect(securityLines('seatmap_locked_attempt').at(-1)).toMatchObject({ productionId: m.id, changes: ['SEAT_SET'] });
    for (const e of m.events) expect(await files(e)).toEqual(['1.json']);
    expect(await venueRow(m.id)).toMatchObject({ layoutVersion: 1, versionSeq: 2, pendingLayout: null });
  });

  test('S-T38 ⑥ 승인 이력 공연은 실무자 403, 관리자는 대기 판에만 두고 SUBMITTED가 된다 [ASVS v5.0.0-16.3.2]', async () => {
    const m = await approvedWithRows();
    const rowsBefore = await admin.db.select().from(seat).where(eq(seat.venueId, layoutVenueId(m.id))).orderBy(seat.seatIndex);
    const tiersBefore = await admin.db.select().from(priceTier).where(eq(priceTier.venueId, layoutVenueId(m.id))).orderBy(priceTier.displayOrder);
    const sectionsBefore = await admin.db.select().from(section).where(eq(section.venueId, layoutVenueId(m.id))).orderBy(section.sortOrder);
    const approvedFiles = await Promise.all(m.events.map((e) => fileOf(e, 1)));
    const member = await put(m.id, memberOf(A), layoutBody({ sections: [secA(4), secB()] }), '"1"');
    expect([member.statusCode, json(member).type]).toEqual([403, `${P}partner-admin-required`]);
    expect(securityLines('partner_production_denied').at(-1)).toMatchObject({ route: 'seatmap', action: 'save', productionId: m.id, reason: 'partner_admin_required' });
    const newTiers = [{ tierId: 'R', name: 'R석', price: 160_000 }, TIERS[2]!, TIERS[0]!];
    const r = await put(m.id, adminOf(A), layoutBody({ sections: [secA(4), secB()], priceTiers: newTiers }), '"1"');
    expect(r.statusCode).toBe(200);
    expect(json(r).layoutVersion).toBe(2);
    // 행·승인된 판의 파일은 그대로, 대기 판 파일은 새 판 경로에, 판매 승인은 SUBMITTED
    expect(await admin.db.select().from(seat).where(eq(seat.venueId, layoutVenueId(m.id))).orderBy(seat.seatIndex)).toEqual(rowsBefore);
    expect(await admin.db.select().from(priceTier).where(eq(priceTier.venueId, layoutVenueId(m.id))).orderBy(priceTier.displayOrder)).toEqual(tiersBefore);
    expect(await admin.db.select().from(section).where(eq(section.venueId, layoutVenueId(m.id))).orderBy(section.sortOrder)).toEqual(sectionsBefore);
    const v = await venueRow(m.id);
    expect(v).toMatchObject({ layoutVersion: 1, versionSeq: 2 });
    expect((v!.pendingLayout as { version: number }).version).toBe(2);
    for (const e of m.events) expect([await files(e), await stagedFiles(e)]).toEqual([['1.json'], ['2.json']]);
    for (const [i, e] of m.events.entries()) expect(Buffer.compare(await fileOf(e, 1), approvedFiles[i]!)).toBe(0);
    const [p] = await admin.db.select().from(production).where(eq(production.id, m.id));
    expect(p!.saleReview).toBe('SUBMITTED');
    // 불러오기는 대기 판을 준다
    const g = await get(m.id, memberOf(A));
    expect([g.headers.etag, json(g).layoutVersion, json(g).priceTiers]).toEqual(['"2"', 2, newTiers]);
    // 대기 판을 다시 바꾸면 앞 대기 판 파일(2)만 지우고 승인된 판 파일(1)은 남긴다. SUBMITTED는 그대로다
    expect((await put(m.id, adminOf(A), layoutBody(), '"2"')).statusCode).toBe(200);
    for (const e of m.events) expect([await files(e), await stagedFiles(e)]).toEqual([['1.json'], ['3.json']]);
    for (const [i, e] of m.events.entries()) expect(Buffer.compare(await fileOf(e, 1), approvedFiles[i]!)).toBe(0);
    expect((await admin.db.select().from(production).where(eq(production.id, m.id)))[0]!.saleReview).toBe('SUBMITTED');
    // 공개 응답(공연 상세의 가격 등급)은 승인된 판 그대로다
    const summary = await svc.http.inject({ method: 'GET', url: `/v1/events/${m.events[0]}` });
    expect([summary.statusCode, json(summary).priceTiers]).toEqual([200, TIERS]);
  });

  test('S-T38 ⑦ 다른 파트너 공연 404·행 보안 0건·정의 밖 칸 400 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-15.3.3] [ASVS v5.0.0-16.3.2]', async () => {
    const m = await makeProduction({ rows: 1 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    store.reset();
    const save = await put(m.id, adminOf(B), layoutBody(), '"1"');
    expect([save.statusCode, json(save).type]).toEqual([404, `${P}not-found`]);
    const load = await get(m.id, adminOf(B));
    expect([load.statusCode, json(load).type]).toEqual([404, `${P}not-found`]);
    expect(load.headers['cache-control']).toBe('no-store');
    expect(securityLines('partner_production_denied').filter((l) => l.route === 'seatmap' && l.productionId === m.id && l.tenantId === B).map((l) => l.action)).toEqual(['save', 'load']);
    // 없는 공연·모양이 틀린 ID도 같은 404
    expect((await get(randomUUID(), adminOf(A))).statusCode).toBe(404);
    expect((await put('not-a-uuid', adminOf(A), layoutBody(), '"0"')).statusCode).toBe(404);
    expect(store.puts).toEqual([]);
    expect((await venueRow(m.id))!.versionSeq).toBe(1);
    // 행 보안: 테넌트 B로 건 트랜잭션은 A의 배치본·구역·좌석·가격 등급 행을 0건으로 읽는다(조회 조건 없이)
    const vid = layoutVenueId(m.id);
    const read = (tenantId: string) =>
      partnerDb.transaction(
        async (tx) => ({
          venue: (await tx.select().from(venue).where(eq(venue.id, vid))).length,
          section: (await tx.select().from(section).where(eq(section.venueId, vid))).length,
          seat: (await tx.select().from(seat).where(eq(seat.venueId, vid))).length,
          tier: (await tx.select().from(priceTier).where(eq(priceTier.venueId, vid))).length,
        }),
        { tenantId },
      );
    expect(await read(B)).toEqual({ venue: 0, section: 0, seat: 0, tier: 0 });
    expect(await read(A)).toEqual({ venue: 1, section: 2, seat: 5, tier: 3 });
    // 정의 밖 칸(소유·승인 상태·판매 상태·다른 회차·게시 표시)은 400이다
    const extra = [
      layoutBody({ promoterId: B }),
      layoutBody({ saleReview: 'APPROVED' }),
      layoutBody({ events: [randomUUID()] }),
      layoutBody({ fanFilePublished: true }),
      // 판 번호 차례·잠금 칸도 받지 않는다(seat-hold 8.2.3, 틀린 구현 검사 보강)
      layoutBody({ versionSeq: 9 }),
      layoutBody({ geometryLocked: false }),
      layoutBody({ sections: [secA(3, { promoterId: B }), secB()] }),
      layoutBody({ sections: [secA(3, { seats: seatsOf('A', 3, { status: 'SOLD' }) }), secB()] }),
      layoutBody({ priceTiers: [{ ...TIERS[0]!, soldOut: true }] }),
    ];
    for (const b of extra) expect((await put(m.id, memberOf(A), b, '"1"')).statusCode).toBe(400);
    expect((await venueRow(m.id))!.versionSeq).toBe(1);
  });

  test('S-T38 ⑦ 앱의 테넌트 조건만으로도 남의 공연을 잠그거나 읽지 못한다(행 보안을 건너뛰는 연결) [ASVS v5.0.0-8.4.1]', async () => {
    const m = await makeProduction({ rows: 1 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    // 슈퍼유저 연결은 행 보안을 건너뛴다. 그래도 저장소의 테넌트 조건이 남의 공연을 없는 것으로 본다
    const bypass = new DrizzleSeatmapLayoutStore(admin);
    expect(await bypass.owns(m.id, B)).toBe(false);
    expect(await bypass.current(m.id, B)).toBe('not-found');
    let called = false;
    expect(await bypass.withLockedProduction(m.id, B, async () => void (called = true))).toBe('not-found');
    expect(called).toBe(false);
    expect(await bypass.owns(m.id, A)).toBe(true);
  });

  test('S-T38 ⑧ 공연 상세 priceTiers가 보이는 순서이고 팬 파일에 판매 상태·개인정보 칸이 없으며 no-store다 [ASVS v5.0.0-14.2.2]', async () => {
    const m = await makeProduction({ rows: 1 });
    const summaryOf = async () => json(await svc.http.inject({ method: 'GET', url: `/v1/events/${m.events[0]}` }));
    // 보이는 순서(S, VIP, R)가 등급 ID 순(R, S, VIP)과 다르다
    const tiers = [TIERS[2]!, TIERS[0]!, TIERS[1]!];
    const r = await put(m.id, memberOf(A), layoutBody({ priceTiers: tiers }), '"0"');
    expect(r.statusCode).toBe(200);
    // 성공한 저장 응답도 no-store다(틀린 구현 검사 보강, BAT-155)
    expect(r.headers['cache-control']).toBe('no-store');
    await admin.db.update(production).set({ saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') }).where(eq(production.id, m.id));
    expect((await summaryOf()).priceTiers).toEqual(tiers);
    // 재승인 대기 가격은 공개 응답에 나오지 않는다(행은 마지막 승인 내용)
    expect((await put(m.id, adminOf(A), layoutBody({ priceTiers: [{ tierId: 'R', name: 'R석', price: 1 }, TIERS[0]!, TIERS[2]!] }), '"1"')).statusCode).toBe(200);
    expect((await summaryOf()).priceTiers).toEqual(tiers);
    // 팬 파일 칸은 정한 것뿐이다(판매 상태·계정 값·가격·편집 값 없음)
    const f = JSON.parse((await fileOf(m.events[0]!, 1)).toString('utf8'));
    expect(Object.keys(f).sort()).toEqual(['canvas', 'format', 'layoutVersion', 'seatCount', 'sections', 'stage', 'tiers']);
    for (const s of f.sections) {
      expect(Object.keys(s).sort()).toEqual(['label', 'name', 'seatIndexRange', 'seats', 'sectionId', 'shape']);
      expect(Object.keys(s.seats).sort()).toEqual(['flags', 'number', 'row', 'seatId', 'tier', 'x', 'y']);
    }
    const text = JSON.stringify(f);
    for (const banned of ['price', '150000', 'R석', 'gateZone', 'G1', 'fillRule', '1층', A, 'promoter', 'status']) expect(text).not.toContain(banned);
    // 불러오기·저장 응답은 성공·오류 모두 no-store다
    expect((await get(m.id, memberOf(A))).headers['cache-control']).toBe('no-store');
    const invalid = await put(m.id, adminOf(A), layoutBody({ sections: [secA(3, { seatIndexRange: { from: 1, to: 3 } }), secB()] }), '"2"');
    expect([invalid.statusCode, invalid.headers['cache-control']]).toEqual([422, 'no-store']);
    // 배치본이 없는 공연의 공연 상세는 빈 목록이다
    const bare = await makeProduction({ approved: true, rows: 1 });
    expect(json(await svc.http.inject({ method: 'GET', url: `/v1/events/${bare.events[0]}` })).priceTiers).toEqual([]);
  });

  test('S-T38 ⑨ fromTemplate 초안은 판 0이고 틀은 바뀌지 않으며 배치본 ID를 틀로 넣으면 404·422다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-2.1.2]', async () => {
    const T = randomUUID();
    const U = randomUUID();
    await admin.db.insert(venue).values([
      { id: T, name: '실내 아레나 엔드 스테이지', kind: 'TEMPLATE', canvasWidth: 2000, canvasHeight: 1500, stageShapes: [{ kind: 'RECT', points: sq(900, 1000, 200), name: '무대' }], published: true },
      { id: U, name: '숨긴 틀', kind: 'TEMPLATE', canvasWidth: 100, canvasHeight: 100, stageShapes: [], published: false },
    ]);
    await admin.db.insert(section).values([
      { venueId: T, sectionKey: 'F1', sortOrder: 0, name: '플로어 1', shape: sq(0, 0, 500), editorMeta: { tool: 'RECT', fillRule: { method: 'GRID', rows: 10, seatsPerRow: 20 } }, defaultTier: 'R' },
      { venueId: T, sectionKey: 'F2', sortOrder: 1, name: '플로어 2', shape: sq(600, 0, 500), editorMeta: { tool: 'POLYGON' }, labelX: 850, labelY: 250 },
    ]);
    const templateRows = async () => admin.db.select().from(section).where(eq(section.venueId, T)).orderBy(section.sortOrder);
    const before = await templateRows();
    const m = await makeProduction({ rows: 1 });
    // 배치본이 없으면 fromTemplate 없이는 404, 숨긴 틀·없는 틀도 404
    expect((await get(m.id, memberOf(A))).statusCode).toBe(404);
    expect((await get(m.id, memberOf(A), `?fromTemplate=${U}`)).statusCode).toBe(404);
    expect((await get(m.id, memberOf(A), `?fromTemplate=${randomUUID()}`)).statusCode).toBe(404);
    const draft = await get(m.id, memberOf(A), `?fromTemplate=${T}`);
    expect(draft.statusCode).toBe(200);
    expect(draft.headers.etag).toBe('"0"');
    expect(json(draft)).toEqual({
      layoutVersion: 0,
      templateVenueId: T,
      priceTiers: [],
      canvas: { width: 2000, height: 1500 },
      stage: [{ kind: 'RECT', points: sq(900, 1000, 200), name: '무대' }],
      sections: [
        { sectionId: 'F1', name: '플로어 1', shape: { kind: 'RECT', points: sq(0, 0, 500) }, tierId: 'R', fillRule: { method: 'GRID', rows: 10, seatsPerRow: 20 }, seats: [] },
        { sectionId: 'F2', name: '플로어 2', shape: { kind: 'POLYGON', points: sq(600, 0, 500) }, label: { x: 850, y: 250 }, seats: [] },
      ],
    });
    // 다른 공연의 배치본 ID를 틀로 넣으면 불러오기는 404, 저장은 422 TEMPLATE_INVALID
    const other = await makeProduction({ rows: 1 });
    expect((await put(other.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    const layoutId = layoutVenueId(other.id);
    expect((await get(m.id, memberOf(A), `?fromTemplate=${layoutId}`)).statusCode).toBe(404);
    for (const t of [layoutId, U, 'not-a-uuid']) {
      const bad = await put(m.id, memberOf(A), layoutBody({ templateVenueId: t }), '"0"');
      expect(bad.statusCode).toBe(422);
      expect((json(bad).result as { errors: unknown[] }).errors).toContainEqual({ line: 0, field: 'templateVenueId', code: 'TEMPLATE_INVALID' });
    }
    expect(await venueRow(m.id)).toBeUndefined();
    // 판 0과 templateVenueId로 저장하면 틀을 적고 틀 행은 바뀌지 않는다
    const saved = await put(m.id, memberOf(A), layoutBody({ templateVenueId: T }), '"0"');
    expect(saved.statusCode).toBe(200);
    expect(json(saved).templateVenueId).toBe(T);
    expect((await venueRow(m.id))!.templateVenueId).toBe(T);
    expect(await templateRows()).toEqual(before);
    // 배치본이 있으면 fromTemplate는 보지 않는다
    expect(json(await get(m.id, memberOf(A), `?fromTemplate=${U}`)).layoutVersion).toBe(1);
    // 판 1 이상에서 다른 틀을 보내면 422, 같은 틀이나 보내지 않으면 받는다
    const changed = await put(m.id, memberOf(A), layoutBody({ templateVenueId: U }), '"1"');
    expect((json(changed).result as { errors: unknown[] }).errors).toContainEqual({ line: 0, field: 'templateVenueId', code: 'TEMPLATE_INVALID' });
    expect((await put(m.id, memberOf(A), layoutBody({ templateVenueId: T }), '"1"')).statusCode).toBe(200);
    expect((await put(m.id, memberOf(A), layoutBody(), '"2"')).statusCode).toBe(200);
    expect(json(await get(m.id, memberOf(A))).templateVenueId).toBe(T);
  });

  test('S-T38 ⑩ 좌석 없는 구역이 있으면 저장은 200이고 fanFilePublished false·파일 0개', async () => {
    const m = await makeProduction({ rows: 2 });
    const r = await put(m.id, memberOf(A), layoutBody({ sections: [secA(), secB(0, { seats: [] })] }), '"0"');
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ layoutVersion: 1, fanFilePublished: false });
    expect(store.puts).toEqual([]);
    for (const e of m.events) expect(await files(e)).toEqual([]);
    expect(await venueRow(m.id)).toMatchObject({ layoutVersion: 1 });
    expect(logs.lines().filter((l) => l.event === 'seatmap_saved').at(-1)).toMatchObject({ productionId: m.id, version: 1, published: false });
    // 모든 구역에 좌석을 채우면 그 판부터 게시한다
    const full = await put(m.id, memberOf(A), layoutBody(), '"1"');
    expect(json(full)).toMatchObject({ layoutVersion: 2, fanFilePublished: true });
    for (const e of m.events) expect(await files(e)).toEqual(['2.json']);
  });
});

describe('회차 더하기의 팬 파일(ADR-0260 결정 8)', () => {
  // 오픈은 회차마다 한 시간씩 떼어 다른 시험의 공개 공연과 5분 안에 들지 않게 한다(2026-11-23 월요일)
  const addEvent = (productionId: string, h: Record<string, string>, day: number, key = randomUUID()) =>
    svc.http.inject({
      method: 'POST',
      url: `/v1/partner/productions/${productionId}/events`,
      headers: { ...h, 'content-type': 'application/json', 'idempotency-key': key },
      payload: JSON.stringify({ openAt: `2026-11-23T${String(day - 10).padStart(2, '0')}:00:00Z`, startsAt: `2026-12-${day}T10:00:00Z`, endsAt: `2026-12-${day}T12:00:00Z` }),
    });

  test('S-T38 ② 배치본이 있는 공연에 더한 회차도 같은 배치본과 같은 판 파일을 가진다(대기 판이 있으면 그 판도)', async () => {
    const m = await makeProduction({ rows: 1 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    const r = await addEvent(m.id, memberOf(A), 27);
    expect(r.statusCode).toBe(201);
    const id = json(r).eventId as string;
    expect((await admin.db.select().from(event).where(eq(event.id, id)))[0]!.venueId).toBe(layoutVenueId(m.id));
    expect(await files(id)).toEqual(['1.json']);
    expect(Buffer.compare(await fileOf(id, 1), await fileOf(m.events[0]!, 1))).toBe(0);
    // 승인 이력이 있고 대기 판이 있으면 승인된 판과 대기 판을 모두 쓴다
    await admin.db.update(production).set({ saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') }).where(eq(production.id, m.id));
    expect((await put(m.id, adminOf(A), layoutBody({ sections: [secA(4), secB()] }), '"1"')).statusCode).toBe(200);
    const added = await addEvent(m.id, adminOf(A), 28);
    expect([added.statusCode, json(added).pending]).toEqual([201, true]);
    const pid = json(added).eventId as string;
    expect([await files(pid), await stagedFiles(pid)]).toEqual([['1.json'], ['2.json']]);
    const [p] = await admin.db.select().from(production).where(eq(production.id, m.id));
    expect((p!.pendingRevision as { addedEvents: { eventId: string; venueId: string }[] }).addedEvents.find((x) => x.eventId === pid)?.venueId).toBe(layoutVenueId(m.id));
  });

  test('S-T38 ② 더한 회차의 파일을 쓰지 못하면 503이고 회차를 더하지 않으며 같은 키로 다시 보내면 더한다', async () => {
    const m = await makeProduction({ rows: 1 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    store.reset();
    store.failPut = () => true;
    const key = randomUUID();
    const r = await addEvent(m.id, memberOf(A), 29, key);
    expect([r.statusCode, json(r).type, r.headers['retry-after']]).toEqual([503, `${P}seatmap-publish-unavailable`, '10']);
    expect((await admin.db.select().from(event).where(eq(event.productionId, m.id))).length).toBe(1);
    store.failPut = undefined;
    const again = await addEvent(m.id, memberOf(A), 29, key);
    expect(again.statusCode).toBe(201);
    expect(await files(json(again).eventId as string)).toEqual(['1.json']);
  });
});

describe('저장 받기 상한·칸막이·게시 동시 수', () => {
  test('S-T38 ① 본문은 12MiB까지 받고 1바이트 넘으면 413이다', async () => {
    const m = await makeProduction({ rows: 1 });
    const base = JSON.stringify(layoutBody());
    // 바이트로 센다(한글 구역 이름은 한 글자가 3바이트)
    const pad = (n: number) => base.slice(0, -1) + ' '.repeat(n - Buffer.byteLength(base)) + '}';
    expect(Buffer.byteLength(pad(12 * MiB))).toBe(12 * MiB);
    const exact = await put(m.id, memberOf(A), pad(12 * MiB), '"0"');
    expect(exact.statusCode).toBe(200);
    const over = await put(m.id, memberOf(A), pad(12 * MiB + 1), '"1"');
    expect(over.statusCode).toBe(413);
    expect((await venueRow(m.id))!.versionSeq).toBe(1);
  });

  test('게시는 정한 동시 쓰기 수를 넘지 않고 모든 회차에 쓴다', async () => {
    const m = await makeProduction({ rows: 7 });
    limits.concurrency = 3;
    store.delayMs = 40;
    const r = await put(m.id, memberOf(A), layoutBody(), '"0"');
    expect(r.statusCode).toBe(200);
    expect(store.maxInFlight).toBe(3);
    expect(store.puts.length).toBe(7);
  });

  test('S-T38 ② 가격 등급은 16개까지·가격은 1~10,000,000원이고 그 밖은 400이다', async () => {
    const m = await makeProduction({ rows: 1 });
    const tiers = (n: number) => Array.from({ length: n }, (_, i) => ({ tierId: i === 0 ? 'R' : i === 1 ? 'S' : i === 2 ? 'VIP' : `T${i}`, name: `${i}석`, price: i === 0 ? 1 : i === 1 ? 10_000_000 : 5_000 }));
    const ok = await put(m.id, memberOf(A), layoutBody({ priceTiers: tiers(16) }), '"0"');
    expect(ok.statusCode).toBe(200);
    expect((json(ok).priceTiers as unknown[]).length).toBe(16);
    expect((await put(m.id, memberOf(A), layoutBody({ priceTiers: tiers(17) }), '"1"')).statusCode).toBe(400);
    for (const price of [0, 10_000_001, 1.5]) expect((await put(m.id, memberOf(A), layoutBody({ priceTiers: [{ ...TIERS[0]!, price }, TIERS[1]!, TIERS[2]!] }), '"1"')).statusCode).toBe(400);
    // 빈 목록은 등급 없이 저장한다는 뜻이라(리뷰 A6) 좌석이 있으면 422 TIER_UNKNOWN이다
    const none = await put(m.id, memberOf(A), layoutBody({ priceTiers: [] }), '"1"');
    expect([none.statusCode, (json(none).result as { errors: { code: string }[] }).errors[0]!.code]).toEqual([422, 'TIER_UNKNOWN']);
    // 보내지 않으면 지금 가격 등급을 그대로 쓰고, 그 등급에 없는 좌석 등급은 422 TIER_UNKNOWN이다
    const { priceTiers: _drop, ...noTiers } = layoutBody();
    const kept = await put(m.id, memberOf(A), noTiers, '"1"');
    expect([kept.statusCode, (json(kept).priceTiers as unknown[]).length]).toEqual([200, 16]);
    const unknown = await put(m.id, memberOf(A), { ...noTiers, sections: [secA(3, { tierId: 'Z' }), secB()] }, '"2"');
    expect(unknown.statusCode).toBe(422);
    expect((json(unknown).result as { errors: { code: string }[] }).errors.map((e) => e.code)).toEqual(['TIER_UNKNOWN', 'TIER_UNKNOWN', 'TIER_UNKNOWN']);
  });

  test('S-T38 ② 5만 석 배치를 저장하고 회차마다 풀리는 파일을 쓰며 50,001석은 422다', { timeout: 180_000 }, async () => {
    const m = await makeProduction({ rows: 3 });
    const sections = Array.from({ length: 50 }, (_, s) => ({
      sectionId: `S${s}`,
      name: `${s}구역`,
      shape: { kind: 'RECT', points: sq((s % 10) * 1000, Math.floor(s / 10) * 1000, 990) },
      tierId: TIERS[s % 3]!.tierId,
      seats: Array.from({ length: 1000 }, (_, i) => ({ seatId: `S${s}-${Math.floor(i / 50) + 1}-${(i % 50) + 1}`, row: String(Math.floor(i / 50) + 1), number: (i % 50) + 1, x: (s % 10) * 1000 + (i % 50) * 19 + 5, y: Math.floor(s / 10) * 1000 + Math.floor(i / 50) * 45 + 5 })),
    }));
    const big = layoutBody({ canvas: { width: 10_000, height: 5_000 }, stage: [], sections });
    const started = Date.now();
    const r = await put(m.id, memberOf(A), big, '"0"');
    expect(r.statusCode).toBe(200);
    expect(await rowCounts(m.id)).toEqual({ sections: 50, seats: 50_000, tiers: 3 });
    for (const e of m.events) expect(decodeLayout(JSON.parse((await fileOf(e, 1)).toString('utf8'))).N).toBe(50_000);
    console.log(`5만 석·회차 3 저장 ${Date.now() - started}ms`);
    const over = layoutBody({ canvas: { width: 10_000, height: 5_000 }, stage: [], sections: [...sections.slice(0, 49), { ...sections[49]!, seats: [...sections[49]!.seats, { seatId: 'X-1-1', row: '99', number: 1, x: 1, y: 1 }] }] });
    const rejected = await put(m.id, memberOf(A), over, '"1"');
    expect(rejected.statusCode).toBe(422);
    expect((json(rejected).result as { errors: { code: string }[] }).errors[0]!.code).toBe('TOO_MANY_SEATS');
  });
});

// ---------- 리뷰 재현(BAT-155 관점 넷 리뷰, 2026-11-10) ----------

describe('리뷰 재현: 좌석·구역 ID(H2, D1)', () => {
  test('S-T38 ② 응답·행·팬 파일의 좌석 ID는 서버가 매긴 소문자 UUID이고 다시 보낸 기존 ID는 그대로, 모르는 UUID는 새 좌석이다 [ASVS v5.0.0-2.2.2]', async () => {
    const m = await makeProduction({ rows: 1 });
    const r = await put(m.id, memberOf(A), layoutBody(), '"0"');
    expect(r.statusCode).toBe(200);
    const ids = idsOf(r);
    expect([...ids.values()].every((v) => UUID_LOWER.test(v))).toBe(true);
    expect(new Set(ids.values()).size).toBe(5);
    const keys = (await admin.db.select({ k: seat.seatKey }).from(seat).where(eq(seat.venueId, layoutVenueId(m.id))).orderBy(seat.seatIndex)).map((x) => String(x.k));
    expect(keys).toEqual((json(r) as unknown as SavedLayout).sections.flatMap((s) => s.seats.map((x) => x.seatId)));
    const f = JSON.parse((await fileOf(m.events[0]!, 1)).toString('utf8'));
    expect(f.sections.flatMap((s: { seats: { seatId: string[] } }) => s.seats.seatId)).toEqual(keys);
    // 기존 ID는 그대로, 이 배치본에 없는 UUID(남의 것·지운 것)는 새 좌석
    const stranger = randomUUID();
    const again = withIds(layoutBody(), new Map([...ids].map(([k, v]) => [k, k === 'B/1/1' ? stranger : v])));
    const r2 = await put(m.id, memberOf(A), again, '"1"');
    expect(r2.statusCode).toBe(200);
    const ids2 = idsOf(r2);
    for (const [k, v] of ids) if (k !== 'B/1/1') expect(ids2.get(k)).toBe(v);
    expect(ids2.get('B/1/1')).not.toBe(stranger);
    expect(ids2.get('B/1/1')).not.toBe(ids.get('B/1/1'));
    expect(UUID_LOWER.test(ids2.get('B/1/1')!)).toBe(true);
  });

  test('S-T38 ⑤ 잠긴 배치에 모르는 좌석 ID를 보내면 새 좌석이라 409이고, 서버 ID를 다시 보낸 속성 변경은 200이다', async () => {
    const m = await makeProduction({ rows: 1 });
    const first = await put(m.id, adminOf(A), layoutBody(), '"0"');
    const ids = idsOf(first);
    await admin.db.update(production).set({ saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') }).where(eq(production.id, m.id));
    await admin.db.update(event).set({ openAt: NOW }).where(eq(event.id, m.events[0]!));
    const swapped = withIds(layoutBody(), new Map([...ids].map(([k, v]) => [k, k === 'A/1/2' ? randomUUID() : v])));
    const r = await put(m.id, adminOf(A), swapped, '"1"');
    expect([r.statusCode, json(r).type]).toEqual([409, `${P}seatmap-geometry-locked`]);
    const attrs = withIds(layoutBody({ sections: [secA(3, { seats: seatsOf('A', 3).map((s, i) => ({ ...s, unavailable: i === 0 })) }), secB()] }), ids);
    expect((await put(m.id, adminOf(A), attrs, '"1"')).statusCode).toBe(200);
  });

  test('S-T38 ① 구역 ID가 키 조각 꼴(영문·숫자·_·-, 64자)이 아니면 422 SECTION_ID_INVALID이고 판이 오르지 않는다 [ASVS v5.0.0-2.2.2]', async () => {
    const m = await makeProduction({ rows: 1 });
    const r = await put(m.id, memberOf(A), layoutBody({ sections: [secA(3, { sectionId: '가구역' }), secB()] }), '"0"');
    expect(r.statusCode).toBe(422);
    expect((json(r).result as { errors: unknown[] }).errors).toContainEqual({ line: 0, field: 'sections[0].sectionId', code: 'SECTION_ID_INVALID' });
    expect(await venueRow(m.id)).toBeUndefined();
  });
});

describe('리뷰 재현: 승인 이력 공연의 대기 판 파일(H3, D3)', () => {
  test('S-T38 ⑥ 승인 이력 공연의 대기 판 파일은 공개 위치가 아니라 준비 위치에 쓰고, 게시 여부를 DB에 남긴다', async () => {
    const m = await makeProduction({ rows: 2 });
    expect((await put(m.id, adminOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    // 초안 공연은 공개 위치이고 행 판의 게시 판 번호가 남는다
    for (const e of m.events) expect([await files(e), await stagedFiles(e)]).toEqual([['1.json'], []]);
    expect(await venueRow(m.id)).toMatchObject({ layoutVersion: 1, publishedVersion: 1 });
    await admin.db.update(production).set({ saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') }).where(eq(production.id, m.id));
    store.reset();
    const r = await put(m.id, adminOf(A), layoutBody({ sections: [secA(4), secB()] }), '"1"');
    expect(r.statusCode).toBe(200);
    for (const e of m.events) expect([await files(e), await stagedFiles(e)]).toEqual([['1.json'], ['2.json']]);
    expect(store.puts.filter((p) => p.key.startsWith('v1/'))).toEqual([]);
    expect((await venueRow(m.id))!.pendingLayout).toMatchObject({ version: 2, staged: true });
    // 대기 판을 다시 바꾸면 앞 대기 판 준비 파일만 지운다
    expect((await put(m.id, adminOf(A), layoutBody({ sections: [secA(5), secB()] }), '"2"')).statusCode).toBe(200);
    for (const e of m.events) expect([await files(e), await stagedFiles(e)]).toEqual([['1.json'], ['3.json']]);
    // 좌석 없는 구역이 있으면 준비하지 않았다고 남긴다
    expect((await put(m.id, adminOf(A), layoutBody({ sections: [secA(), secB(0, { seats: [] })] }), '"3"')).statusCode).toBe(200);
    expect((await venueRow(m.id))!.pendingLayout).toMatchObject({ version: 4, staged: false });
    for (const e of m.events) expect(await stagedFiles(e)).toEqual([]);
  });

  test('S-T38 ⑥ 승인 이력 공연에 더한 회차는 승인된 판 공개 파일과 대기 판 준비 파일을 받는다', async () => {
    const m = await makeProduction({ rows: 1 });
    expect((await put(m.id, adminOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    await admin.db.update(production).set({ saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') }).where(eq(production.id, m.id));
    expect((await put(m.id, adminOf(A), layoutBody({ sections: [secA(4), secB()] }), '"1"')).statusCode).toBe(200);
    const added = await svc.http.inject({
      method: 'POST',
      url: `/v1/partner/productions/${m.id}/events`,
      headers: { ...adminOf(A), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      payload: JSON.stringify({ openAt: '2026-11-24T13:00:00Z', startsAt: '2026-12-29T10:00:00Z', endsAt: '2026-12-29T12:00:00Z' }),
    });
    expect(added.statusCode).toBe(201);
    const id = json(added).eventId as string;
    expect([await files(id), await stagedFiles(id)]).toEqual([['1.json'], ['2.json']]);
  });
});

describe('리뷰 재현: 테넌트·권한(S1·S3·S5)', () => {
  test('S-T38 ⑦ 남의 배치본 ID에 자기 판매자로 구역·좌석·가격 등급을 넣으면 묶음 외래키가 막는다(23503) [ASVS v5.0.0-8.4.1]', async () => {
    const mb = await makeProduction({ tenant: B, rows: 1 });
    expect((await put(mb.id, memberOf(B), layoutBody(), '"0"')).statusCode).toBe(200);
    const vb = layoutVenueId(mb.id);
    const asA = (fn: Parameters<Database['transaction']>[0]) => expect(partnerDb.transaction(fn, { tenantId: A })).rejects.toMatchObject({ cause: { code: '23503' } });
    await asA(async (tx) => tx.insert(section).values({ venueId: vb, sectionKey: 'X', promoterId: A, sortOrder: 9, name: 'X', shape: sq(0, 0, 10) }));
    await asA(async (tx) => tx.insert(priceTier).values({ venueId: vb, tierId: 'Z', promoterId: A, name: 'Z석', price: 1, displayOrder: 9 }));
    await asA(async (tx) => tx.insert(seat).values({ venueId: vb, seatKey: randomUUID(), sectionKey: 'A', promoterId: A, seatIndex: 99, rowLabel: '9', number: 9, x: 1, y: 1 }));
  });

  test('S-T38 ⑧ 공연 상세의 가격 등급은 회차 판매자의 행만 읽는다(묶음 외래키를 뺀 채로 다른 판매자 행을 끼워 봄) [ASVS v5.0.0-8.4.1]', async () => {
    const m = await makeProduction({ rows: 1 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    await admin.db.update(production).set({ saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') }).where(eq(production.id, m.id));
    await admin.db.execute(sql`alter table price_tier drop constraint price_tier_venue_promoter_fk`);
    try {
      await admin.db.insert(priceTier).values({ venueId: layoutVenueId(m.id), tierId: 'ZZ', promoterId: B, name: '끼어든 석', price: 1, displayOrder: 9 });
      const s = json(await svc.http.inject({ method: 'GET', url: `/v1/events/${m.events[0]}` }));
      expect((s.priceTiers as { tierId: string }[]).map((t) => t.tierId)).toEqual(['VIP', 'R', 'S']);
    } finally {
      await admin.db.delete(priceTier).where(eq(priceTier.tierId, 'ZZ'));
      await admin.db.execute(sql`alter table price_tier add constraint price_tier_venue_promoter_fk foreign key (venue_id, promoter_id) references venue (id, promoter_id)`);
    }
  });

  test('S-T38 ⑨ 배치본의 template_venue_id는 공개된 TEMPLATE 행만 가리킨다(DB 2차 방어) [ASVS v5.0.0-2.2.3]', async () => {
    const T = randomUUID();
    const H = randomUUID();
    await admin.db.insert(venue).values([
      { id: T, name: '공개 틀', kind: 'TEMPLATE', canvasWidth: 100, canvasHeight: 100, published: true },
      { id: H, name: '숨긴 틀', kind: 'TEMPLATE', canvasWidth: 100, canvasHeight: 100, published: false },
    ]);
    const m = await makeProduction({ rows: 1 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    const other = await makeProduction({ rows: 1 });
    expect((await put(other.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    const setTemplate = (id: string) => partnerDb.transaction(async (tx) => tx.update(venue).set({ templateVenueId: id }).where(eq(venue.id, layoutVenueId(m.id))), { tenantId: A });
    for (const bad of [H, layoutVenueId(other.id)]) await expect(setTemplate(bad)).rejects.toMatchObject({ cause: { code: '23514' } });
    await setTemplate(T);
    expect((await venueRow(m.id))!.templateVenueId).toBe(T);
  });

  test('S-T38 ⑧ 팬·관제 DB 사용자는 배치본 표 가운데 공연 상세에 필요한 가격 등급만 읽는다 [ASVS v5.0.0-8.2.3]', async () => {
    const denied = (q: Promise<unknown>) => expect(q).rejects.toMatchObject({ cause: { code: '42501' } });
    await denied(appDb.db.select().from(venue));
    await denied(appDb.db.select().from(section));
    await denied(appDb.db.select().from(seat));
    await appDb.db.select({ tierId: priceTier.tierId, name: priceTier.name, price: priceTier.price }).from(priceTier).limit(1);
  });
});

// 틀린 구현 검사(BAT-155, A등급)가 찾은 빈틈: 행 보안이 가려 HTTP 시험이 놓친 앱 조건을 행 보안을 건너뛰는 연결로 하나씩 본다
describe('틀린 구현 검사 보강: 행 보안이 가린 앱 조건(BAT-155)', () => {
  test('S-T38 ⑦ 소속 확인(ownerView)도 앱의 테넌트 조건만으로 남의 공연을 없는 것으로 본다(행 보안을 건너뛰는 연결) [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.4.1]', async () => {
    const m = await makeProduction({ rows: 1, approved: true });
    const bypass = new DrizzleSeatmapLayoutStore(admin);
    expect(await bypass.ownerView(m.id, B)).toBeUndefined();
    expect(await bypass.ownerView(m.id, A)).toEqual({ approvedBefore: true });
  });

  test('S-T38 ⑨ 틀 초안과 틀 확인은 앱 조건만으로 공개된 TEMPLATE 행만 받는다(숨긴 틀·배치본 ID, 행 보안을 건너뛰는 연결) [ASVS v5.0.0-2.2.3]', async () => {
    const T = randomUUID();
    const H = randomUUID();
    await admin.db.insert(venue).values([
      { id: T, name: '공개 틀', kind: 'TEMPLATE', canvasWidth: 100, canvasHeight: 100, stageShapes: [], published: true },
      { id: H, name: '숨긴 틀', kind: 'TEMPLATE', canvasWidth: 100, canvasHeight: 100, stageShapes: [], published: false },
    ]);
    const m = await makeProduction({ rows: 1 });
    const other = await makeProduction({ rows: 1 });
    expect((await put(other.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    const layoutId = layoutVenueId(other.id);
    const bypass = new DrizzleSeatmapLayoutStore(admin);
    expect(await bypass.templateDraft(H, A)).toBeUndefined();
    expect(await bypass.templateDraft(layoutId, A)).toBeUndefined();
    expect(await bypass.templateDraft(T, A)).toMatchObject({ templateVenueId: T, canvas: { width: 100, height: 100 } });
    const ok = await bypass.withLockedProduction(m.id, A, async (tx) => [await tx.templateOk(H), await tx.templateOk(layoutId), await tx.templateOk(T)]);
    expect(ok).toEqual([false, false, true]);
  });
});

describe('리뷰 재현: 보안 사건(S4)', () => {
  test('S-T38 ⑥ 승인 이력 공연에 실무자가 틀린 본문을 보내 422여도 실패한 인가 시도를 남긴다 [ASVS v5.0.0-16.3.2]', async () => {
    const m = await approvedWithRows();
    const before = securityLines('partner_production_denied').filter((l) => l.productionId === m.id).length;
    const r = await put(m.id, memberOf(A), layoutBody({ sections: [secA(3, { seatIndexRange: { from: 1, to: 3 } }), secB()] }), '"1"');
    expect(r.statusCode).toBe(422);
    const lines = securityLines('partner_production_denied').filter((l) => l.productionId === m.id);
    expect(lines.length).toBe(before + 1);
    expect(lines.at(-1)).toMatchObject({ route: 'seatmap', action: 'save', reason: 'partner_admin_required' });
  });

  test('S-T38 ⑤ 잠긴 배치를 옛 If-Match로 바꾸려 해 412여도 잠긴 배치본 바꾸기 시도를 남긴다 [ASVS v5.0.0-16.3.3]', async () => {
    const m = await approvedWithRows({ openAt: NOW });
    const before = securityLines('seatmap_locked_attempt').filter((l) => l.productionId === m.id).length;
    const r = await put(m.id, adminOf(A), layoutBody({ sections: [secA(4), secB()] }), '"0"');
    expect(r.statusCode).toBe(412);
    expect(securityLines('seatmap_locked_attempt').filter((l) => l.productionId === m.id).length).toBe(before + 1);
  });
});

describe('리뷰 재현: 동시 실행·장애(C1~C6)', () => {
  test('S-T38 ④ 트랜잭션 ②의 커밋 결과를 모르면 그 판 파일을 지우지 않고 seatmap_commit_unknown을 남긴다', async () => {
    const m = await makeProduction({ rows: 2 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    // 커밋 때에야 실패하는 미룬 제약(커밋 문장을 보낸 뒤의 실패를 흉내 낸다)
    await admin.db.execute(sql.raw(`create table if not exists test_commit_fail (on_ boolean);
      create or replace function test_commit_fail_fn() returns trigger language plpgsql security definer set search_path = public as $$ begin if exists (select 1 from test_commit_fail) then raise exception 'commit failed (test)'; end if; return null; end $$;
      drop trigger if exists test_commit_fail_tg on seat;
      create constraint trigger test_commit_fail_tg after insert on seat deferrable initially deferred for each row execute function test_commit_fail_fn();
      insert into test_commit_fail values (true);`));
    try {
      const r = await put(m.id, memberOf(A), layoutBody({ sections: [secA(2), secB()] }), '"1"');
      expect(r.statusCode).toBe(500);
    } finally {
      await admin.db.execute(sql.raw('drop trigger if exists test_commit_fail_tg on seat; delete from test_commit_fail;'));
    }
    expect(logs.lines().filter((l) => l.event === 'seatmap_commit_unknown').at(-1)).toMatchObject({ productionId: m.id, version: 2 });
    for (const e of m.events) expect(await files(e)).toEqual(['1.json', '2.json']);
  });

  test('S-T38 ③ 팬 파일은 파트너 트랜잭션을 연 채 쓰지 않는다(회차 더하기·저장 ② 앞에 더한 회차)', async () => {
    const m = await makeProduction({ rows: 1 });
    // 한 번에 하나씩 써서, 쓰는 순간 열린 파트너 트랜잭션이 끼워 넣은 다른 요청의 것이 아니게 한다
    limits.concurrency = 1;
    const seen: number[] = [];
    store.beforePut = async () => void seen.push(await openPartnerTx());
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    const add = (day: number) =>
      svc.http.inject({
        method: 'POST',
        url: `/v1/partner/productions/${m.id}/events`,
        headers: { ...memberOf(A), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        payload: JSON.stringify({ openAt: `2026-11-25T${String(day - 10).padStart(2, '0')}:00:00Z`, startsAt: `2026-12-${day}T10:00:00Z`, endsAt: `2026-12-${day}T12:00:00Z` }),
      });
    expect((await add(26)).statusCode).toBe(201);
    // 저장 ①과 ② 사이에 회차를 더하면 ②를 되돌려 그 회차 파일을 잠금 밖에서 쓴 뒤 다시 한다
    let added = false;
    const hook = store.beforePut;
    store.beforePut = async (key) => {
      await hook!(key);
      if (added) return;
      added = true;
      expect((await add(27)).statusCode).toBe(201);
    };
    const r = await put(m.id, memberOf(A), layoutBody({ sections: [secA(2), secB()] }), '"1"');
    expect(r.statusCode).toBe(200);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen).toEqual(seen.map(() => 0));
    const all = await admin.db.select({ id: event.id }).from(event).where(eq(event.productionId, m.id));
    for (const e of all) expect(await files(e.id)).toEqual(['2.json']);
  });

  test('S-T38 ③ 회차 더하기가 파일을 쓴 뒤 넣기 전에 좌석맵 저장이 커밋되면 되돌리고 새 판 파일로 다시 한다', async () => {
    const m = await makeProduction({ rows: 1 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    let armed = true;
    store.beforePut = async () => {
      if (!armed) return;
      armed = false;
      // 회차 더하기의 첫 파일 쓰기(판 1) 사이에 저장 하나를 끝까지 커밋한다(판 2)
      expect((await put(m.id, memberOf(A), layoutBody({ sections: [secA(2), secB()] }), '"1"')).statusCode).toBe(200);
    };
    const r = await svc.http.inject({
      method: 'POST',
      url: `/v1/partner/productions/${m.id}/events`,
      headers: { ...memberOf(A), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      payload: JSON.stringify({ openAt: '2026-11-27T09:00:00Z', startsAt: '2026-12-27T10:00:00Z', endsAt: '2026-12-27T12:00:00Z' }),
    });
    expect(r.statusCode).toBe(201);
    const id = json(r).eventId as string;
    // 새 회차는 지금 판(2)의 파일만 갖는다(앞서 쓴 판 1 파일은 지웠다)
    expect(await files(id)).toEqual(['2.json']);
    expect(Buffer.compare(await fileOf(id, 2), await fileOf(m.events[0]!, 2))).toBe(0);
  });

  test('S-T38 ③ ②를 다시 해도 회차가 계속 늘면 503 Retry-After 1이고 그 판 파일을 지운다', { timeout: 60_000 }, async () => {
    const m = await makeProduction({ rows: 1 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    store.reset();
    let n = 0;
    store.beforePut = async (key) => {
      if (!key.includes('/2.json')) return;
      n++;
      const add = svc.http.inject({
        method: 'POST',
        url: `/v1/partner/productions/${m.id}/events`,
        headers: { ...memberOf(A), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        payload: JSON.stringify({ openAt: `2026-11-26T0${n}:00:00Z`, startsAt: `2026-12-2${n}T10:00:00Z`, endsAt: `2026-12-2${n}T12:00:00Z` }),
      });
      // 잠금 안에서 파일을 쓰는 구현이면 회차 더하기가 그 잠금을 기다려 멈추므로 5초까지만 기다린다
      await Promise.race([add, new Promise((r) => setTimeout(r, 5_000))]);
    };
    const r = await put(m.id, memberOf(A), layoutBody({ sections: [secA(2), secB()] }), '"1"');
    expect([r.statusCode, json(r).type, r.headers['retry-after']]).toEqual([503, `${P}seatmap-publish-unavailable`, '1']);
    const all = await admin.db.select({ id: event.id }).from(event).where(eq(event.productionId, m.id));
    for (const e of all) expect((await files(e.id)).filter((x) => x === '2.json')).toEqual([]);
    expect(await venueRow(m.id)).toMatchObject({ layoutVersion: 1, versionSeq: 2 });
  });

  test('S-T38 ④ 게시 직전 남은 시간이 모자라면 504 deadline-exceeded이고, 게시 시한은 남은 시간으로 줄인다', async () => {
    const m = await makeProduction({ rows: 1 });
    const short = await svc.http.inject({ method: 'PUT', url: `/v1/partner/productions/${m.id}/seatmap`, headers: { ...memberOf(A), 'content-type': 'application/json', 'if-match': '"0"', 'x-peaket-deadline-ms': '2500' }, payload: JSON.stringify(layoutBody()) });
    expect([short.statusCode, json(short).type]).toEqual([504, `${P}deadline-exceeded`]);
    expect(store.puts).toEqual([]);
    store.delayMs = 2_000;
    const slow = await svc.http.inject({ method: 'PUT', url: `/v1/partner/productions/${m.id}/seatmap`, headers: { ...memberOf(A), 'content-type': 'application/json', 'if-match': '"0"', 'x-peaket-deadline-ms': '3500' }, payload: JSON.stringify(layoutBody()) });
    expect([slow.statusCode, json(slow).type]).toEqual([503, `${P}seatmap-publish-unavailable`]);
    expect(logs.lines().filter((l) => l.event === 'seatmap_publish_failed').at(-1)).toMatchObject({ productionId: m.id, reason: 'timeout' });
  });

  test('좌석맵 저장은 자기 칸막이 2개를 쓰고 셋째는 429이며 이미지·가져오기 칸막이는 막지 않는다', async () => {
    const ms = await Promise.all(Array.from({ length: 3 }, () => makeProduction({ rows: 1 })));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = 0;
    store.beforePut = async () => {
      held++;
      await gate;
    };
    const pending = ms.slice(0, 2).map((m) => put(m.id, memberOf(A), layoutBody(), '"0"'));
    await until(() => held === 2, '저장 둘이 칸을 잡음', 10_000);
    const thirdP = put(ms[2]!.id, memberOf(A), layoutBody(), '"0"');
    const third = await Promise.race([thirdP, new Promise<undefined>((r) => setTimeout(() => r(undefined), 2_000))]);
    const body = await multipart({ format: 'JSON' }, [{ name: 'a.json', type: 'application/json', bytes: new TextEncoder().encode('{}') }]);
    const impP = svc.http.inject({ method: 'POST', url: `/v1/partner/productions/${ms[2]!.id}/seatmap-imports`, headers: { ...memberOf(A), 'content-type': body.contentType, 'x-requested-with': 'peaket-partner' }, payload: body.payload });
    const imp = await Promise.race([impP, new Promise<undefined>((r) => setTimeout(() => r(undefined), 2_000))]);
    release();
    await Promise.all([thirdP, impP, ...pending]);
    expect(third && [third.statusCode, json(third).type, third.headers['retry-after'], third.headers['cache-control']]).toEqual([429, `${P}server-busy`, '10', 'no-store']);
    expect(imp?.statusCode).not.toBe(429);
    expect((await Promise.all(pending)).map((r) => r.statusCode)).toEqual([200, 200]);
  });

  test('S-T38 ⑦ 본문 상한 413에도 no-store다', async () => {
    const m = await makeProduction({ rows: 1 });
    const over = await put(m.id, memberOf(A), ' '.repeat(12 * MiB + 1), '"0"');
    expect([over.statusCode, over.headers['cache-control']]).toEqual([413, 'no-store']);
  });

  test('S-T38 ③ 회차 잇기는 첫 배치본 때만 한다(다음 저장은 회차 행을 고치지 않는다)', async () => {
    const m = await makeProduction({ rows: 2 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    await admin.db.execute(sql.raw(`create table if not exists test_event_updates (id uuid);
      create or replace function test_event_updates_fn() returns trigger language plpgsql security definer set search_path = public as $$ begin insert into test_event_updates values (new.id); return new; end $$;
      drop trigger if exists test_event_updates_tg on event;
      create trigger test_event_updates_tg after update on event for each row execute function test_event_updates_fn();
      delete from test_event_updates;`));
    try {
      expect((await put(m.id, memberOf(A), layoutBody(), '"1"')).statusCode).toBe(200);
      const r = await admin.db.execute(sql.raw('select count(*)::int as n from test_event_updates'));
      expect((r.rows as { n: number }[])[0]!.n).toBe(0);
    } finally {
      await admin.db.execute(sql.raw('drop trigger if exists test_event_updates_tg on event'));
    }
  });

  test('S-T38 ⑤ 트랜잭션 ②의 잠금 판정은 쓰기 뒤 커밋 바로 앞에 한다(② 안에서 오픈 시각이 지나면 409) [ASVS v5.0.0-16.3.3]', async () => {
    const m = await approvedWithRows();
    // ②의 대기 판 쓰기(venue 고치기)가 같은 트랜잭션에서 회차 오픈 시각을 지나게 한다
    await admin.db.execute(sql.raw(`create table if not exists test_open_now (on_ boolean);
      create or replace function test_open_now_fn() returns trigger language plpgsql security definer set search_path = public as $$ begin if exists (select 1 from test_open_now) then update event set open_at = '2026-11-04T00:00:00Z' where venue_id = new.id; end if; return new; end $$;
      drop trigger if exists test_open_now_tg on venue;
      create trigger test_open_now_tg after update of pending_layout on venue for each row execute function test_open_now_fn();
      insert into test_open_now values (true);`));
    try {
      const r = await put(m.id, adminOf(A), layoutBody({ sections: [secA(4), secB()] }), '"1"');
      expect([r.statusCode, json(r).type]).toEqual([409, `${P}seatmap-geometry-locked`]);
    } finally {
      await admin.db.execute(sql.raw('drop trigger if exists test_open_now_tg on venue; delete from test_open_now;'));
    }
    expect(await venueRow(m.id)).toMatchObject({ pendingLayout: null });
    const [e] = await admin.db.select({ openAt: event.openAt }).from(event).where(eq(event.id, m.events[0]!));
    expect(e!.openAt.getTime()).toBe(FUTURE_OPEN.getTime());
  });

  test('S-T38 ⑦ 불러오기는 읽기 전용 REPEATABLE READ 트랜잭션 하나로 읽는다(판이 섞이지 않게)', async () => {
    const m = await makeProduction({ rows: 1 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    const opts: unknown[] = [];
    const spy = { ...partnerDb, transaction: <T>(fn: (tx: never) => Promise<T>, o?: unknown) => (opts.push(o), partnerDb.transaction(fn as never, o as never)) } as unknown as Database;
    const s = new DrizzleSeatmapLayoutStore(spy);
    expect(await s.current(m.id, A)).toMatchObject({ version: 1 });
    expect(opts).toEqual([{ tenantId: A, isolationLevel: 'repeatable read', accessMode: 'read only' }]);
  });

  test('S-T38 ③ ①과 ② 사이에 판매 중지나 승인이 생기면 ②가 409·403으로 거절하고 그 판 파일을 지운다', async () => {
    const m = await makeProduction({ rows: 1 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    store.beforePut = async () => {
      store.beforePut = undefined;
      await admin.db.update(production).set({ saleReview: 'SUSPENDED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') }).where(eq(production.id, m.id));
    };
    const r = await put(m.id, adminOf(A), layoutBody({ sections: [secA(2), secB()] }), '"1"');
    expect([r.statusCode, json(r).type]).toEqual([409, `${P}production-suspended`]);
    expect(await files(m.events[0]!)).toEqual(['1.json']);
    const m2 = await makeProduction({ rows: 1 });
    expect((await put(m2.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    store.beforePut = async () => {
      store.beforePut = undefined;
      await admin.db.update(production).set({ saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') }).where(eq(production.id, m2.id));
    };
    const r2 = await put(m2.id, memberOf(A), layoutBody({ sections: [secA(2), secB()] }), '"1"');
    expect([r2.statusCode, json(r2).type]).toEqual([403, `${P}partner-admin-required`]);
    expect(await files(m2.events[0]!)).toEqual(['1.json']);
    expect(await venueRow(m2.id)).toMatchObject({ layoutVersion: 1, versionSeq: 2 });
  });

  test('S-T38 ④ ② 앞에 더한 회차의 파일 쓰기가 실패하면 503이고 앞서 쓴 그 판 파일도 지운다', async () => {
    const m = await makeProduction({ rows: 1 });
    expect((await put(m.id, memberOf(A), layoutBody(), '"0"')).statusCode).toBe(200);
    store.reset();
    let added: string | undefined;
    let started = false;
    store.beforePut = async () => {
      if (started) return;
      started = true;
      const r = await svc.http.inject({
        method: 'POST',
        url: `/v1/partner/productions/${m.id}/events`,
        headers: { ...memberOf(A), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        payload: JSON.stringify({ openAt: '2026-11-27T05:00:00Z', startsAt: '2026-12-28T10:00:00Z', endsAt: '2026-12-28T12:00:00Z' }),
      });
      added = json(r).eventId as string;
      store.failPut = (key) => key.includes(added!) && key.endsWith('/2.json');
    };
    const r = await put(m.id, memberOf(A), layoutBody({ sections: [secA(2), secB()] }), '"1"');
    expect([r.statusCode, json(r).type]).toEqual([503, `${P}seatmap-publish-unavailable`]);
    expect(await files(m.events[0]!)).toEqual(['1.json']);
    expect(await files(added!)).toEqual(['1.json']);
  });
});

describe('리뷰 재현: 정확성(A1·A2·A6·H1)', () => {
  test('S-T38 ② 열 위치는 좌석 색인이고 번호의 글자 순서·좌석 ID 순서와 다르다 [ASVS v5.0.0-5.3.1]', async () => {
    const m = await makeProduction({ rows: 1 });
    // 한 열의 번호 2·10·1(글자 순은 1·10·2)
    const odd = [2, 10, 1].map((n, i) => ({ seatId: `A-1-${n}`, row: '1', number: n, x: 10 + i * 50, y: 100 }));
    const body = layoutBody({ sections: [secA(3, { seats: odd }), secB()] });
    const r = await put(m.id, memberOf(A), body, '"0"');
    expect(r.statusCode).toBe(200);
    // 다시 보낼 때는 좌석 ID 순서와 다른 차례로 보낸다
    const ids = idsOf(r);
    const sorted = [...ids.entries()].filter(([k]) => k.startsWith('A/')).sort((a, b) => (a[1] < b[1] ? 1 : -1));
    const again = { ...body, sections: [{ ...secA(3), seats: sorted.map(([k, seatId]) => ({ seatId, row: '1', number: Number(k.split('/')[2]), x: 10 + Number(k.split('/')[2]), y: 100 })) }, secB()] };
    const r2 = await put(m.id, memberOf(A), withIds(again, ids), '"1"');
    expect(r2.statusCode).toBe(200);
    const out = json(r2) as unknown as { sections: { sectionId: string; seatIndexRange: { from: number }; seats: { seatId: string; row: string; number: number; x: number; y: number; index: number }[] }[] };
    const f = JSON.parse((await fileOf(m.events[0]!, 2)).toString('utf8'));
    for (const s of out.sections) {
      const col = f.sections.find((x: { sectionId: string }) => x.sectionId === s.sectionId);
      for (const seat of s.seats) {
        const at = seat.index - s.seatIndexRange.from;
        expect([col.seats.seatId[at], col.seats.row[at], col.seats.number[at], col.seats.x[at], col.seats.y[at]]).toEqual([seat.seatId, seat.row, String(seat.number), seat.x, seat.y]);
      }
    }
    expect(out.sections[0]!.seats.map((x) => x.seatId)).toEqual(sorted.map(([, v]) => v));
  });

  test('S-T38 ⑨ 불러오기가 준 빈 가격 등급(priceTiers: [])을 그대로 다시 저장하면 등급 없이 저장한다', async () => {
    const T = randomUUID();
    await admin.db.insert(venue).values({ id: T, name: '틀', kind: 'TEMPLATE', canvasWidth: 2000, canvasHeight: 1500, stageShapes: [], published: true });
    await admin.db.insert(section).values({ venueId: T, sectionKey: 'F1', sortOrder: 0, name: '플로어', shape: sq(0, 0, 500), editorMeta: { tool: 'RECT' } });
    const m = await makeProduction({ rows: 1 });
    const draft = json(await get(m.id, memberOf(A), `?fromTemplate=${T}`));
    const { layoutVersion: _v, ...rest } = draft;
    const r = await put(m.id, memberOf(A), rest, '"0"');
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ layoutVersion: 1, priceTiers: [], fanFilePublished: false, templateVenueId: T });
  });

  test('S-T38 ② 한 구역 5만 석 배치의 불러오기·회차 더하기·잠긴 배치 저장이 시간 안에 끝난다', { timeout: 240_000 }, async () => {
    const m = await makeProduction({ rows: 1 });
    const seats = Array.from({ length: 50_000 }, (_, i) => ({ seatId: `p${i}`, row: String(Math.floor(i / 250) + 1), number: (i % 250) + 1, x: (i % 250) * 39 + 5, y: Math.floor(i / 250) * 24 + 5 }));
    const big = layoutBody({ canvas: { width: 10_000, height: 5_000 }, stage: [], sections: [{ sectionId: 'ONE', name: '한 구역', shape: { kind: 'RECT', points: sq(0, 0, 9_999).map(([x, y]) => [x, Math.min(y, 4_999)]) }, tierId: 'R', seats }] });
    const saved = await put(m.id, adminOf(A), big, '"0"');
    expect(saved.statusCode).toBe(200);
    const ids = idsOf(saved);
    const t0 = Date.now();
    const g = await get(m.id, adminOf(A));
    const loadMs = Date.now() - t0;
    expect(g.statusCode).toBe(200);
    const t1 = Date.now();
    const added = await svc.http.inject({
      method: 'POST',
      url: `/v1/partner/productions/${m.id}/events`,
      headers: { ...adminOf(A), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      payload: JSON.stringify({ openAt: '2026-11-28T03:00:00Z', startsAt: '2026-12-30T10:00:00Z', endsAt: '2026-12-30T12:00:00Z' }),
    });
    const addMs = Date.now() - t1;
    expect(added.statusCode).toBe(201);
    await admin.db.update(production).set({ saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') }).where(eq(production.id, m.id));
    await admin.db.update(event).set({ openAt: NOW }).where(eq(event.id, m.events[0]!));
    const attrs = withIds({ ...big, sections: [{ ...(big.sections as Record<string, unknown>[])[0]!, seats: seats.map((s, i) => ({ ...s, unavailable: i === 0 })) }] }, new Map([...ids].map(([k, v]) => [k.replace(/^[^/]+/, 'ONE'), v])));
    const t2 = Date.now();
    const locked = await put(m.id, adminOf(A), attrs, '"1"');
    const lockMs = Date.now() - t2;
    expect(locked.statusCode).toBe(200);
    console.log(`한 구역 5만 석: 불러오기 ${loadMs}ms, 회차 더하기 ${addMs}ms, 잠긴 배치 저장 ${lockMs}ms`);
    // 구역별 묶기가 n²이면 불러오기만 몇 초다(이 PC 약 8초). CI가 느려 상한은 넉넉히 둔다 [가정]
    expect(loadMs).toBeLessThan(4_000);
    expect(addMs).toBeLessThan(4_000);
    expect(lockMs).toBeLessThan(20_000);
  });
});

// ---------- 시작 파일 조립 ----------

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

  async function boot(env: Record<string, string>): Promise<{ child: ChildProcess; output: () => string; exited: Promise<number | null> }> {
    const base: Record<string, string> = {};
    for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[k]) base[k] = process.env[k]!;
    const child = spawn(process.execPath, ['dist/main.js'], { cwd: SERVICE_DIR, env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout!.on('data', (d) => (text += String(d)));
    child.stderr!.on('data', (d) => (text += String(d)));
    const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
    return { child, output: () => text, exited };
  }

  test('PEAKET_PUBLIC_FILE_DIR이 없으면 뜨지 않고, 있으면 운영 시작 파일로 띄운 앱이 그 폴더에 쓴다', async () => {
    const [port, mgmt] = [await freePort(), await freePort()];
    const dir = await mkdtemp(join(tmpdir(), 'peaket-main-'));
    const env = {
      PEAKET_ENV: 'local',
      PORT: String(port),
      PEAKET_MANAGEMENT_PORT: String(mgmt),
      PEAKET_DATABASE_URL: pg.urlFor('core_app_login', 'peaket-test'),
      PEAKET_PARTNER_DATABASE_URL: pg.urlFor('core_partner_login', 'peaket-test'),
      PEAKET_IDENTITY_GRPC_URL: `127.0.0.1:${identityPort}`,
      PEAKET_IMAGE_GRPC_URL: '127.0.0.1:1',
      PEAKET_SEATMAP_GRPC_URL: '127.0.0.1:1',
      PEAKET_IMAGE_BASE_URL: 'http://127.0.0.1:1',
      PEAKET_IMAGE_STORE_DIR: dir,
    };
    try {
      const missing = await boot(env);
      expect(await missing.exited).not.toBe(0);
      expect(missing.output()).toContain('PEAKET_PUBLIC_FILE_DIR');
      const pub = join(dir, 'public-files');
      const ok = await boot({ ...env, PEAKET_PUBLIC_FILE_DIR: pub });
      try {
        await until(async () => {
          try {
            return (await fetch(`http://127.0.0.1:${mgmt}/ready`)).status === 200;
          } catch {
            return false;
          }
        }, 'core-svc 준비', 30_000, 200);
        const m = await makeProduction({ rows: 1 });
        const account = randomUUID();
        const session = randomUUID();
        answers.set(`${account}/${session}`, { valid: true, role: 'partner_member', tenant_id: A });
        const r = await fetch(`http://127.0.0.1:${port}/v1/partner/productions/${m.id}/seatmap`, {
          method: 'PUT',
          headers: { 'x-user-id': account, 'x-session-id': session, 'x-user-aud': 'partner', 'x-user-scope': '', 'content-type': 'application/json', 'if-match': '"0"' },
          body: JSON.stringify(layoutBody()),
        });
        expect(r.status).toBe(200);
        const f = JSON.parse(await readFile(join(pub, 'public', 'v1', 'events', m.events[0]!, 'seatmap-layouts', '1.json'), 'utf8'));
        expect(decodeLayout(f).N).toBe(5);
      } finally {
        ok.child.kill();
        await ok.exited;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
