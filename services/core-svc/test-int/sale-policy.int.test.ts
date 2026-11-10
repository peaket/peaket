// 판매 정책 규칙 저장·회차 고치기·공개 요약의 판매 단계·팬별 판매 자격 통합 시험(BUILD_ORDER HOT-250, ADR-0261 결정 1~5·7, S-T39 ⑥).
// 실제 PostgreSQL 18 컨테이너, 실제 core-svc HTTP 앱(운영과 같은 권한의 DB 사용자: 파트너 경로 core_partner, 팬 경로 core_app)을 잇는다.
// 시계는 시험이 옮긴다(잠금·오픈 경계). 단언 값은 정본의 글(잠금 = 가장 이른 during.from − 24시간, 파기 = 마지막 판매 종료 + 1일)로 적는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { GetEventResponse, GetFanSaleEligibilityResponse } from '@peaket/contracts/openapi/catalog';
import { type Clock, createDatabase, createService, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleSaleStore } from '../src/modules/catalog/adapters/db/drizzle-sale-store.js';
import { event, place, priceTier, production, promoter, saleEligibilityList, saleEligibilityMember, venue } from '../src/modules/catalog/adapters/db/schema.js';
import { layoutVenueId } from '../src/modules/catalog/domain/seatmap-layout.js';
import { fan, FakeIdentity, testMedia } from '../test/support.js';
import { logSink } from './media-support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

type Svc = Awaited<ReturnType<typeof createService>>;

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let svc: Svc;
const logs = logSink();
const identity = new FakeIdentity();
let now = Date.parse('2026-11-05T00:00:00Z');
const clock: Clock = { now: () => now, monotonicMs: () => performance.now() };
const A = randomUUID();
const B = randomUUID();
const PLACE = randomUUID();
const P = 'https://peaket.example/problems/';
const KEY = 'lumen-fanclub-2026';
const H = 3_600_000;
const DAY = 24 * H;

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
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: randomUUID() });
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, media: testMedia() }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info' },
    clock,
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
});

interface Made {
  id: string;
  events: string[];
}

/** 공연과 회차(관리자 연결로 넣는다). 오픈 2026-11-20 20:00 KST, 회차마다 하루씩 늦게 시작, 1인 한도는 회차마다 정한다 */
async function makeProduction(o: { tenant?: string; approved?: boolean; limits?: number[]; tiers?: string[]; rules?: unknown[] } = {}): Promise<Made> {
  const tenant = o.tenant ?? A;
  const id = randomUUID();
  await admin.db.insert(production).values({
    id,
    promoterId: tenant,
    placeId: PLACE,
    title: '겨울 콘서트',
    genre: '콘서트',
    saleReview: o.approved ? 'APPROVED' : 'DRAFT',
    saleApprovedAt: o.approved ? new Date('2026-11-01T00:00:00Z') : null,
    ...(o.rules ? { salePolicy: o.rules } : {}),
  });
  let venueId: string | null = null;
  if (o.tiers) {
    venueId = layoutVenueId(id);
    await admin.db.insert(venue).values({ id: venueId, kind: 'LAYOUT', promoterId: tenant, layoutVersion: 1, versionSeq: 1, canvasWidth: 100, canvasHeight: 100 });
    await admin.db.insert(priceTier).values(o.tiers.map((t, i) => ({ venueId: venueId!, tierId: t, promoterId: tenant, name: `${t}석`, price: 10_000, displayOrder: i })));
  }
  const limits = o.limits ?? [4];
  const events = limits.map(() => randomUUID());
  await admin.db.insert(event).values(
    events.map((e, i) => ({
      id: e,
      productionId: id,
      promoterId: tenant,
      venueId,
      openAt: new Date('2026-11-20T11:00:00Z'),
      startsAt: new Date(Date.parse('2026-12-24T10:00:00Z') + i * DAY),
      endsAt: new Date(Date.parse('2026-12-24T12:30:00Z') + i * DAY),
      perPersonLimit: limits[i]!,
    })),
  );
  return { id, events };
}

const fanclub = (rounds: unknown = 'ALL', from = '2026-11-20T20:00:00+09:00', to = '2026-11-20T22:00:00+09:00') => ({
  version: 1,
  name: '팬클럽 선예매',
  rounds,
  during: { from, to },
  rule: { if: { fact: 'buyer.lists', has: KEY }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } },
});

const adminOf = (t = A) => identity.partner(t, 'partner_admin');
const memberOf = (t = A) => identity.partner(t, 'partner_member');
const put = (id: string, rules: unknown[], ifMatch: string | null = '"1"', h = adminOf()) =>
  svc.http.inject({ method: 'PUT', url: `/v1/partner/productions/${id}/sale-policy`, headers: { ...h, 'content-type': 'application/json', ...(ifMatch ? { 'if-match': ifMatch } : {}) }, payload: JSON.stringify({ rules }) });
const getPolicy = (id: string, h = memberOf()) => svc.http.inject({ method: 'GET', url: `/v1/partner/productions/${id}/sale-policy`, headers: h });
const patch = (eventId: string, body: unknown, ifMatch: string | null = '"1"', h = adminOf()) =>
  svc.http.inject({ method: 'PATCH', url: `/v1/partner/events/${eventId}`, headers: { ...h, 'content-type': 'application/json', ...(ifMatch ? { 'if-match': ifMatch } : {}) }, payload: JSON.stringify(body) });
const problem = (r: { payload: string }) => JSON.parse(r.payload) as { type: string; errors?: { rule: number; path: string; code: string }[] };
const row = async (id: string) => (await admin.db.select().from(production).where(eq(production.id, id)))[0]!;
async function addList(productionId: string, tenant = A, o: { lockedAt?: Date | null; key?: string; members?: string[] } = {}): Promise<string> {
  const id = randomUUID();
  const members = o.members ?? [];
  await admin.db.insert(saleEligibilityList).values({ id, productionId, promoterId: tenant, key: o.key ?? KEY, name: 'LUMEN 팬클럽 2026', memberCount: members.length, fileSha256: Buffer.alloc(32, 7), version: 1, uploadedAt: new Date(now), uploadedBy: randomUUID(), lockedAt: o.lockedAt ?? null, destroyDueAt: new Date('2026-12-24T10:00:00Z') });
  if (members.length > 0) await admin.db.insert(saleEligibilityMember).values(members.map((accountId) => ({ listId: id, promoterId: tenant, accountId })));
  return id;
}
const list = async (id: string) => (await admin.db.select().from(saleEligibilityList).where(eq(saleEligibilityList.id, id)))[0]!;

describe('판매 정책 규칙 저장(실제 DB)', () => {
  test('S-T39 ⑥ 회차 한도를 넘는 limitPerPerson·POL-032 상한 넘음·겹친 구간·다른 공연 회차는 422와 코드 [ASVS v5.0.0-2.1.2] [ASVS v5.0.0-2.2.3]', async () => {
    const m = await makeProduction({ limits: [4, 3], tiers: ['VIP', 'R'] });
    const other = await makeProduction({ limits: [4] });
    const r = await put(m.id, [
      { version: 1, name: '한도', rounds: [m.events[1]], rule: { then: { limitPerPerson: 4 } } },
      { version: 1, name: '공제 상한', rounds: [m.events[0]], refundFee: [{ daysLeft: { gte: 7, lte: 9 }, rate: 20 }] },
      { version: 1, name: '겹침', rounds: [m.events[1]], refundFee: [{ daysLeft: { gte: 3, lte: 6 }, rate: 20 }, { daysLeft: { gte: 6, lte: 9 }, rate: 10 }] },
      { version: 1, name: '남의 회차', rounds: [other.events[0]], rule: { then: { limitPerPerson: 1 } } },
    ]);
    expect([r.statusCode, r.headers['cache-control'], problem(r).type]).toEqual([422, 'no-store', `${P}sale-policy-invalid`]);
    expect(problem(r).errors).toEqual([
      { rule: 0, path: '/rule/then/limitPerPerson', code: 'LIMIT_ABOVE_EVENT' },
      { rule: 1, path: '/refundFee/0/rate', code: 'REFUND_RATE_ABOVE_CAP' },
      { rule: 2, path: '/refundFee/1/daysLeft', code: 'REFUND_BAND_OVERLAP' },
      { rule: 3, path: '/rounds/0', code: 'UNKNOWN_ROUND' },
    ]);
    // 배치본의 등급(VIP·R)만 받는다
    expect(problem(await put(m.id, [{ version: 1, name: '등급', rounds: 'ALL', rule: { if: { fact: 'grade', eq: 'S' }, then: { deny: 'GRADE_NOT_ON_SALE' } } }])).errors).toEqual([{ rule: 0, path: '/rule/if/eq', code: 'UNKNOWN_GRADE' }]);
    expect((await row(m.id)).salePolicy).toBeNull();
    const ok = await put(m.id, [{ version: 1, name: '등급', rounds: 'ALL', rule: { if: { fact: 'grade', eq: 'VIP' }, then: { deny: 'GRADE_NOT_ON_SALE' } } }]);
    expect([ok.statusCode, ok.headers.etag]).toEqual([200, '"2"']);
    expect([(await row(m.id)).salePolicyVersion, (await row(m.id)).salePolicy]).toEqual([2, [{ version: 1, name: '등급', rounds: 'ALL', rule: { if: { fact: 'grade', eq: 'VIP' }, then: { deny: 'GRADE_NOT_ON_SALE' } } }]]);
  });

  test('규칙 저장은 같은 트랜잭션에서 명단 잠금 시각을 가장 이른 during.from − 24시간으로 다시 계산하고 지난 잠금은 늦추지 않는다', async () => {
    now = Date.parse('2026-11-05T00:00:00Z');
    const m = await makeProduction({ limits: [4] });
    const l = await addList(m.id);
    const other = await addList(m.id, A, { key: 'other-list' });
    // 판매 시작 2026-11-20T20:00+09:00(11:00Z)과 같은 키의 더 이른 창 2026-11-19T20:00+09:00 → 가장 이른 값 − 24시간
    expect((await put(m.id, [fanclub(), fanclub('ALL', '2026-11-19T20:00:00+09:00', '2026-11-19T21:00:00+09:00')])).statusCode).toBe(200);
    expect((await list(l)).lockedAt?.toISOString()).toBe('2026-11-18T11:00:00.000Z');
    expect((await list(other)).lockedAt).toBeNull();
    // 아직 지나지 않은 잠금은 규칙이 바뀌면 다시 계산한다(늦어져도 된다)
    expect((await put(m.id, [fanclub()], '"2"')).statusCode).toBe(200);
    expect((await list(l)).lockedAt?.toISOString()).toBe('2026-11-19T11:00:00.000Z');
    // 잠금 시각이 지난 뒤에는 규칙을 바꾸거나 지워도 늦추지 않는다
    now = Date.parse('2026-11-19T11:00:00Z');
    expect((await put(m.id, [fanclub('ALL', '2026-11-21T20:00:00+09:00', '2026-11-21T22:00:00+09:00')], '"3"')).statusCode).toBe(200);
    expect((await list(l)).lockedAt?.toISOString()).toBe('2026-11-19T11:00:00.000Z');
    expect((await put(m.id, [], '"4"')).statusCode).toBe(200);
    expect((await list(l)).lockedAt?.toISOString()).toBe('2026-11-19T11:00:00.000Z');
    now = Date.parse('2026-11-05T00:00:00Z');
  });

  test('승인 이력이 있는 공연의 규칙은 실무자 403이고 관리자는 변경분에만 두며 APPROVED는 SUBMITTED다 [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-16.3.2]', async () => {
    const m = await makeProduction({ approved: true, rules: [fanclub()] });
    const denied = await put(m.id, [], '"1"', memberOf());
    expect([denied.statusCode, problem(denied).type]).toEqual([403, `${P}partner-admin-required`]);
    expect(logs.lines().some((l) => l.event === 'partner_production_denied' && l.route === 'sale_policy' && l.reason === 'partner_admin_required' && l.productionId === m.id)).toBe(true);
    const ok = await put(m.id, [], '"1"', adminOf());
    expect(JSON.parse(ok.payload)).toEqual({ version: 2, pending: true });
    const p = await row(m.id);
    expect([p.salePolicy, (p.pendingRevision as { salePolicy?: unknown }).salePolicy, p.saleReview, p.salePolicyVersion]).toEqual([[fanclub()], [], 'SUBMITTED', 2]);
    expect(JSON.parse((await getPolicy(m.id)).payload)).toEqual({ rules: [], version: 2, pending: true });
  });

  test('다른 파트너 공연의 규칙은 없는 공연과 같은 404이고 실패한 인가로 남는다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-16.3.2]', async () => {
    const theirs = await makeProduction({ tenant: B, rules: [fanclub()] });
    expect(problem(await getPolicy(theirs.id)).type).toBe(`${P}not-found`);
    expect(problem(await put(theirs.id, [])).type).toBe(`${P}not-found`);
    expect(problem(await patch(theirs.events[0]!, { lobbyMinutes: 5 })).type).toBe(`${P}not-found`);
    expect((await row(theirs.id)).salePolicy).toEqual([fanclub()]);
    expect(logs.lines().filter((l) => l.event === 'partner_production_denied' && l.kind === 'security' && (l.productionId === theirs.id || l.eventId === theirs.events[0]))).toHaveLength(3);
  });

  test('겹친 가드: 행 보안을 건너뛰는 연결로도 저장소의 테넌트 조건이 남의 공연·회차·명단을 막는다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.4.1]', async () => {
    // 슈퍼유저(행 보안을 지나는 연결)로 만든 저장소: 앱 조건만 남는다
    const bypass = new DrizzleSaleStore(admin);
    const theirs = await makeProduction({ tenant: B, rules: [fanclub()] });
    const l = await addList(theirs.id, B);
    expect(await bypass.owner(theirs.id, A)).toBeUndefined();
    expect(await bypass.read(theirs.id, A)).toBeUndefined();
    expect(await bypass.eventProduction(theirs.events[0]!, A)).toBeUndefined();
    expect(await bypass.withLockedProduction(theirs.id, A, async () => 'ran')).toBe('not-found');
    await bypass.markCopied(l, A, 1);
    expect((await list(l)).copiedSeq).toBeNull();
    expect((await bypass.read(theirs.id, B))?.lists.map((x) => x.id)).toEqual([l]);
  });
});

describe('회차 고치기(실제 DB)', () => {
  test('오픈 1ms 전 정렬 고치기는 200·오픈 시각은 409 sale-setting-locked, 옛 판 412·없음 428, 승인 이력은 변경분과 SUBMITTED [ASVS v5.0.0-2.3.2]', async () => {
    const open = Date.parse('2026-11-20T11:00:00Z');
    const m = await makeProduction({ limits: [4, 4] });
    now = open - 1;
    expect(problem(await patch(m.events[0]!, { openBatch: false }, null)).type).toBe(`${P}precondition-required`);
    const r = await patch(m.events[0]!, { openBatch: false });
    expect([r.statusCode, r.headers.etag]).toEqual([200, '"2"']);
    const e = async (id: string) => (await admin.db.select().from(event).where(eq(event.id, id)))[0]!;
    expect([(await e(m.events[0]!)).openBatch, (await e(m.events[0]!)).version]).toEqual([false, 2]);
    expect(problem(await patch(m.events[0]!, { openBatch: true }, '"1"')).type).toBe(`${P}precondition-failed`);
    now = open;
    for (const body of [{ openBatch: true }, { lobbyShuffle: false }, { seatAssignment: 'AUTO' }, { openAt: '2026-11-21T11:00:00Z' }, { startsAt: '2026-12-26T10:00:00Z' }]) {
      const locked = await patch(m.events[0]!, body, '"2"');
      expect([locked.statusCode, problem(locked).type]).toEqual([409, `${P}sale-setting-locked`]);
    }
    expect((await e(m.events[0]!)).version).toBe(2);
    // 같은 값을 보내는 것은 바꾸기가 아니다. 잠기지 않은 칸은 오픈 뒤에도 고친다
    expect((await patch(m.events[0]!, { openBatch: false, endsAt: '2026-12-24T13:00:00Z' }, '"2"')).statusCode).toBe(200);
    // 승인 이력: event 행은 판만 오르고 바뀐 칸은 변경분에 합친다
    now = open - DAY;
    const a = await makeProduction({ approved: true, limits: [4] });
    const one = await patch(a.events[0]!, { perPersonLimit: 2 }, '"1"', adminOf());
    const two = await patch(a.events[0]!, { seatAssignment: 'AUTO' }, '"2"', adminOf());
    expect([JSON.parse(one.payload), JSON.parse(two.payload)]).toEqual([
      { eventId: a.events[0], version: 2, pending: true, warnings: [] },
      { eventId: a.events[0], version: 3, pending: true, warnings: [] },
    ]);
    const ev = await e(a.events[0]!);
    expect([ev.perPersonLimit, ev.seatAssignment, ev.version]).toEqual([4, 'PICK', 3]);
    const p = await row(a.id);
    expect([(p.pendingRevision as { eventChanges?: unknown }).eventChanges, p.saleReview]).toEqual([{ [a.events[0]!]: { perPersonLimit: 2, seatAssignment: 'AUTO' } }, 'SUBMITTED']);
    expect(problem(await patch(a.events[0]!, { lobbyMinutes: 1 }, '"3"', memberOf())).type).toBe(`${P}partner-admin-required`);
    now = Date.parse('2026-11-05T00:00:00Z');
  });

  test('1인 한도를 그 회차에 걸린 규칙의 한도보다 작게 바꾸면 422 sale-policy-invalid이고, 공연 시작을 늦추면 명단 파기 시각을 다시 계산한다 [ASVS v5.0.0-2.1.2]', async () => {
    const m = await makeProduction({ limits: [4, 3] });
    expect((await put(m.id, [fanclub([m.events[1]])])).statusCode).toBe(200);
    const low = await patch(m.events[1]!, { perPersonLimit: 1 });
    expect([low.statusCode, problem(low).errors]).toEqual([422, [{ rule: 0, path: '/rule/then/limitPerPerson', code: 'LIMIT_ABOVE_EVENT' }]]);
    expect((await patch(m.events[1]!, { perPersonLimit: 2 })).statusCode).toBe(200);
    const l = await addList(m.id);
    // 마지막 회차 시작 2026-12-25T10:00Z → 2026-12-27T10:00Z: 파기 = 마지막 판매 종료(시작 − 24시간) + 1일
    expect((await patch(m.events[1]!, { startsAt: '2026-12-27T10:00:00Z', endsAt: '2026-12-27T12:30:00Z' }, '"2"')).statusCode).toBe(200);
    expect((await list(l)).destroyDueAt.toISOString()).toBe('2026-12-27T10:00:00.000Z');
  });
});

describe('공개 요약·팬별 자격(실제 DB)', () => {
  test('공개 요약 salePhases·refundFees·PRESALE 배지는 승인 내용의 규칙으로, 팬 자격은 명단 구성원으로 계산하고 no-store다 [ASVS v5.0.0-8.2.2]', async () => {
    now = Date.parse('2026-11-10T00:00:00Z');
    const fee = { version: 1, name: '공제', rounds: 'ALL', refundFee: [{ daysLeft: { gte: 7, lte: 9 }, rate: 10 }] };
    const m = await makeProduction({ approved: true, limits: [3], tiers: ['VIP', 'R'], rules: [fanclub(), fee] });
    // 재승인 대기 변경분의 규칙(빈 목록)은 공개 요약에 쓰지 않는다
    await admin.db.update(production).set({ pendingRevision: { salePolicy: [] } }).where(eq(production.id, m.id));
    const member = randomUUID();
    await addList(m.id, A, { members: [member] });
    const r = await svc.http.inject({ method: 'GET', url: `/v1/events/${m.events[0]}` });
    expect(r.statusCode).toBe(200);
    const body = GetEventResponse.parse(JSON.parse(r.payload));
    expect([body.salePhases, body.refundFees, body.badges]).toEqual([
      [
        { kind: 'PRESALE', startsAt: '2026-11-20T11:00:00.000Z', endsAt: '2026-11-20T13:00:00.000Z', limitPerPerson: 2 },
        { kind: 'GENERAL', startsAt: '2026-11-20T13:00:00.000Z', endsAt: '2026-12-23T10:00:00.000Z', limitPerPerson: 3 },
      ],
      [{ daysLeft: { gte: 7, lte: 9 }, rate: 10 }],
      ['HYBRID', 'PRESALE'],
    ]);
    // 명단 키는 공개 요약에 없다
    expect(r.payload).not.toContain(KEY);
    const mine = await svc.http.inject({ method: 'GET', url: `/v1/events/${m.events[0]}/sale-eligibility`, headers: fan(member) });
    expect([mine.statusCode, mine.headers['cache-control']]).toEqual([200, 'no-store']);
    expect(GetFanSaleEligibilityResponse.parse(JSON.parse(mine.payload))).toEqual({
      eventId: m.events[0],
      phases: [
        { kind: 'PRESALE', startsAt: '2026-11-20T11:00:00.000Z', endsAt: '2026-11-20T13:00:00.000Z', eligible: true, limitPerPerson: 2 },
        { kind: 'GENERAL', startsAt: '2026-11-20T13:00:00.000Z', endsAt: '2026-12-23T10:00:00.000Z', eligible: true, limitPerPerson: 3 },
      ],
      lists: [{ name: 'LUMEN 팬클럽 2026', destroyAt: '2026-12-24T10:00:00.000Z' }],
    });
    expect(mine.payload).not.toContain(KEY);
    const other = JSON.parse((await svc.http.inject({ method: 'GET', url: `/v1/events/${m.events[0]}/sale-eligibility`, headers: fan() })).payload);
    expect([other.phases.map((x: { eligible: boolean }) => x.eligible), other.lists]).toEqual([[false, true], []]);
    // 파기 시각이 지난 명단은 정비 전이어도 대상으로 보지 않는다
    now = Date.parse('2026-12-24T10:00:00Z');
    expect(JSON.parse((await svc.http.inject({ method: 'GET', url: `/v1/events/${m.events[0]}/sale-eligibility`, headers: fan(member) })).payload).lists).toEqual([]);
    now = Date.parse('2026-11-10T00:00:00Z');
    const anon = await svc.http.inject({ method: 'GET', url: `/v1/events/${m.events[0]}/sale-eligibility` });
    expect([anon.statusCode, anon.headers['cache-control']]).toEqual([401, 'no-store']);
    const hidden = await makeProduction({ rules: [fanclub()] });
    expect(problem(await svc.http.inject({ method: 'GET', url: `/v1/events/${hidden.events[0]}/sale-eligibility`, headers: fan(member) })).type).toBe(`${P}not-found`);
    now = Date.parse('2026-11-05T00:00:00Z');
  });
});
