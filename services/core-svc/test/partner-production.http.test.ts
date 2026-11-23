// 받는 층: 공연 등록·회차 더하기(openapi createPartnerProduction·createPartnerProductionEvent, ADR-0198, BUILD_ORDER HOT-171)
import 'reflect-metadata';
import { CreatePartnerProductionEventResponse, CreatePartnerProductionResponse } from '@peaket/contracts/openapi/partner';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import { eventBody, FakeIdentity, NOW_MS, productionBody, quiet } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
const TENANT = randomUUID();
const OTHER = randomUUID();
const PLACE = randomUUID();
const ARTIST = randomUUID();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/**
 * 이 시험의 '지금'은 서비스에 주입한 시계(fakeClock NOW_MS)뿐이다. 모든 시각을 그 시계의 날(00:00 UTC) + n일로 만든다.
 * 실제 시계(Date.now)를 섞으면 날이 갈수록 상대 시각이 같은 저장소의 다른 공연 오픈과 5분 안으로 겹쳐
 * open-too-close(409)가 난다(FIX-core-datebomb: 2026-11-23 실행에서 실행일+11일 = 12-04 11:00(반려 시험의 오픈)이 판매 중지 시험의 고정 오픈과 겹쳤다).
 * 판정 규칙(정본): 지금 < 오픈 < 판매 종료(시작 24시간 전) < 시작 < 끝(용어집 '판매 종료', ADR-0064·ADR-0198),
 * 공개 중인 다른 공연과 오픈 5분 간격, 수요일 03:00~06:30 KST 정비 창(ADR-0198, docs/devops.md '오픈 시각 제한').
 */
const NOW_DAY_MS = NOW_MS - (NOW_MS % DAY);
const atIn = (days: number, utcHour: number, minute = 0): string => new Date(NOW_DAY_MS + days * DAY + utcHour * HOUR + minute * MIN).toISOString();
/** 오픈(UTC 11:00 = 20:00 KST, 정비 창 밖). 회차가 서로 5분 안에 겹치지 않게 시험마다 다른 날을 쓴다 */
const openAtIn = (days: number, minute = 0): string => atIn(days, 11, minute);
/** 시작(UTC 10:00). 판매 종료(시작 24시간 전)가 오픈 뒤가 되도록 오픈보다 넉넉히 뒤로 잡는다 */
const startsAtIn = (days: number): string => atIn(days, 10);
const endsAtOf = (startsAt: string): string => new Date(Date.parse(startsAt) + 2 * HOUR).toISOString();
/** 판매 승인 이력 시각(지금 하루 전) */
const APPROVED_AT = new Date(NOW_MS - DAY);

beforeAll(async () => {
  repo.sellerNames.set(TENANT, '(주)피켓공연');
  repo.sellerNames.set(OTHER, '(주)다른공연');
  repo.places.add(PLACE);
  repo.artists.add(ARTIST);
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

const post = (url: string, headers: Record<string, string>, body: unknown, key: string = randomUUID()) =>
  svc.http.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': key }, payload: JSON.stringify(body) });
const create = (headers: Record<string, string>, body: unknown, key?: string) => post('/v1/partner/productions', headers, body, key);
const problem = (r: { payload: string }) => JSON.parse(r.payload) as { type: string; eventIndex?: number; suggestedOpenAt?: string };
const P = 'https://peaket.example/problems/';

describe('공연 등록', () => {
  test('공연과첫회차들을_DRAFT로만들고_기존·새아티스트순서·다른이름·회차기본값을저장한다', async () => {
    const admin = identity.partner(TENANT, 'partner_member');
    const body = productionBody(PLACE, {
      artists: [{ name: '새 밴드' }, { artistId: ARTIST }],
      events: [eventBody(), eventBody({ startsAt: startsAtIn(50), endsAt: atIn(50, 12, 30), lobbyShuffle: false, seatAssignment: 'AUTO', perPersonLimit: 2 })],
    });
    const r = await create(admin, body);
    expect(r.statusCode).toBe(201);
    const out = CreatePartnerProductionResponse.parse(JSON.parse(r.payload));
    expect(out.eventIds).toHaveLength(2);
    expect(out.warnings).toEqual([]);
    const p = repo.productions.get(out.productionId as string);
    expect(p).toMatchObject({ promoterId: TENANT, placeId: PLACE, saleReview: 'DRAFT', saleApprovedAt: null });
    const reg = repo.registrations.get(out.productionId as string);
    expect(reg?.artists).toEqual([{ artistId: ARTIST, sortOrder: 1 }]);
    expect(reg?.requestedArtists).toEqual([{ name: '새 밴드', sortOrder: 0 }]);
    expect(reg?.aliases.map((a) => a.alias)).toEqual(['WINTER CONCERT']);
    expect(repo.eventDrafts.get(out.eventIds![0]!)).toMatchObject({ lobbyMinutes: 10, lobbyShuffle: true, openBatch: true, seatAssignment: 'PICK', perPersonLimit: 4, reentryAllowed: false });
    expect(repo.eventDrafts.get(out.eventIds![1]!)).toMatchObject({ lobbyShuffle: false, openBatch: true, seatAssignment: 'AUTO', perPersonLimit: 2 });
    // 같은 공연의 두 회차는 오픈이 같아도 된다(오픈 간격은 다른 공연과만 본다)
    expect(repo.events.get(out.eventIds![1]!)?.venueId).toBeNull();
  });

  test('새공연장요청은_공연장ID없이요청칸에둔다', async () => {
    const r = await create(identity.partner(TENANT), productionBody(PLACE, { placeId: undefined, newPlace: { name: '새 홀', address: '서울 어딘가 2' }, events: [eventBody({ openAt: openAtIn(16) })] }));
    expect(r.statusCode).toBe(201);
    const id = JSON.parse(r.payload).productionId;
    expect(repo.productions.get(id)?.placeId).toBeNull();
    expect(repo.registrations.get(id)?.requestedPlace).toEqual({ name: '새 홀', address: '서울 어딘가 2' });
  });

  test('같은멱등키로다시보내면_같은결과이고_공연이하나만생긴다', async () => {
    const h = identity.partner(TENANT);
    const key = randomUUID();
    const body = productionBody(PLACE, { title: '한 번만', events: [eventBody({ openAt: openAtIn(17) })] });
    const a = await create(h, body, key);
    const b = await create(h, body, key);
    expect(b.statusCode).toBe(201);
    expect(b.payload).toBe(a.payload);
    expect([...repo.productions.values()].filter((p) => p.title === '한 번만')).toHaveLength(1);
    expect((await create(h, { ...body, title: '다른 본문' }, key)).statusCode).toBe(422);
  });

  test('[ASVS v5.0.0-8.2.3] 본문은닫혀있어_판매자·상태칸을보내면400이고_테넌트는세션의값만쓴다', async () => {
    const h = identity.partner(TENANT);
    expect((await create(h, productionBody(PLACE, { promoterId: OTHER }))).statusCode).toBe(400);
    expect((await create(h, productionBody(PLACE, { saleReview: 'APPROVED' }))).statusCode).toBe(400);
    expect((await create(h, productionBody(PLACE, { events: [eventBody({ venueId: randomUUID() })] }))).statusCode).toBe(400);
  });

  test('공연장은placeId·newPlace가운데하나_아티스트칸도하나_같은아티스트·다른이름겹침은400이다', async () => {
    const h = identity.partner(TENANT);
    expect((await create(h, productionBody(PLACE, { newPlace: { name: 'a', address: 'b' } }))).statusCode).toBe(400);
    expect((await create(h, productionBody(PLACE, { placeId: undefined }))).statusCode).toBe(400);
    expect((await create(h, productionBody(PLACE, { artists: [{ artistId: ARTIST, name: '둘 다' }] }))).statusCode).toBe(400);
    expect((await create(h, productionBody(PLACE, { artists: [{}] }))).statusCode).toBe(400);
    expect((await create(h, productionBody(PLACE, { artists: [{ artistId: ARTIST }, { artistId: ARTIST }] }))).statusCode).toBe(400);
    expect((await create(h, productionBody(PLACE, { aliases: ['A', 'A'] }))).statusCode).toBe(400);
    expect((await create(h, productionBody(PLACE, { aliases: ['1', '2', '3', '4', '5', '6'] }))).statusCode).toBe(400);
  });

  test('없는공연장·아티스트는_404다', async () => {
    const h = identity.partner(TENANT);
    expect(problem(await create(h, productionBody(randomUUID()))).type).toBe(`${P}not-found`);
    expect(problem(await create(h, productionBody(PLACE, { artists: [{ artistId: randomUUID() }] }))).type).toBe(`${P}not-found`);
  });

  test('회차일정순서가틀리면_event-schedule-invalid이고_정렬두값을끄면queue-order-invalid다(몇째회차인지싣는다)', async () => {
    const h = identity.partner(TENANT);
    const bad = await create(h, productionBody(PLACE, { events: [eventBody(), eventBody({ openAt: atIn(48, 10), startsAt: startsAtIn(49), endsAt: endsAtOf(startsAtIn(49)) })] }));
    expect(bad.statusCode).toBe(422);
    expect(problem(bad)).toMatchObject({ type: `${P}event-schedule-invalid`, eventIndex: 1 });
    const off = await create(h, productionBody(PLACE, { events: [eventBody({ lobbyShuffle: false, openBatch: false })] }));
    expect(off.statusCode).toBe(422);
    expect(problem(off)).toMatchObject({ type: `${P}queue-order-invalid`, eventIndex: 0 });
  });

  /** 그 공연을 판매 승인된 것으로 바꾼다(공개 중인 공연만 오픈 간격을 막는다) */
  function approve(productionId: string, saleReview: 'APPROVED' | 'SUSPENDED' = 'APPROVED'): void {
    repo.productions.set(productionId, { ...repo.productions.get(productionId)!, saleReview, saleApprovedAt: APPROVED_AT });
  }

  test('공개중인다른공연과오픈이5분안이면_409 open-too-close와가능시각이고_수요일정비창은open-maintenance-window다', async () => {
    const h = identity.partner(TENANT);
    const firstOpen = openAtIn(22);
    const first = await create(h, productionBody(PLACE, { events: [eventBody({ openAt: firstOpen })] }));
    expect(first.statusCode).toBe(201);
    approve(JSON.parse(first.payload).productionId);
    const near = await create(identity.partner(OTHER), productionBody(PLACE, { events: [eventBody({ openAt: openAtIn(22, 3) })] }));
    expect(near.statusCode).toBe(409);
    expect(problem(near)).toEqual(expect.objectContaining({ type: `${P}open-too-close`, eventIndex: 0, suggestedOpenAt: new Date(Date.parse(firstOpen) + 5 * MIN).toISOString() }));
    // 지금+19일 19:00 UTC = 다음 날 수요일 04:00 KST(정비 창 03:00~06:30 안). 가능 시각은 창이 끝나는 06:30 KST
    const inWindow = atIn(19, 19);
    expect(new Date(Date.parse(inWindow) + 9 * HOUR).getUTCDay()).toBe(3);
    const window = await create(h, productionBody(PLACE, { events: [eventBody({ openAt: inWindow })] }));
    expect(window.statusCode).toBe(409);
    expect(problem(window)).toEqual(expect.objectContaining({ type: `${P}open-maintenance-window`, suggestedOpenAt: atIn(19, 21, 30) }));
  });

  test('승인전·판매중지공연의회차는_남의오픈을막지않는다(승인전공연이시각을차지하거나드러나지않게)', async () => {
    const draft = await create(identity.partner(TENANT), productionBody(PLACE, { events: [eventBody({ openAt: openAtIn(33) })] }));
    expect(draft.statusCode).toBe(201);
    expect((await create(identity.partner(OTHER), productionBody(PLACE, { events: [eventBody({ openAt: openAtIn(33, 1) })] }))).statusCode).toBe(201);
    const suspended = await create(identity.partner(TENANT), productionBody(PLACE, { events: [eventBody({ openAt: openAtIn(34) })] }));
    approve(JSON.parse(suspended.payload).productionId, 'SUSPENDED');
    expect((await create(identity.partner(OTHER), productionBody(PLACE, { events: [eventBody({ openAt: openAtIn(34, 1) })] }))).statusCode).toBe(201);
  });

  test('테넌트가없는파트너세션은_503 authz-unavailable로닫는다', async () => {
    const accountId = randomUUID();
    const sessionId = randomUUID();
    identity.answers.set(`${accountId}/${sessionId}`, { valid: true, role: 'partner_admin' });
    const r = await create({ 'x-user-id': accountId, 'x-session-id': sessionId, 'x-user-aud': 'partner', 'x-user-scope': '' }, productionBody(PLACE, { events: [eventBody({ openAt: openAtIn(35) })] }));
    expect(r.statusCode).toBe(503);
    expect(problem(r).type).toBe(`${P}authz-unavailable`);
  });

  test('팬세션과끝난파트너세션으로는_파트너경로를부를수없다(401)', async () => {
    expect((await create({ 'x-user-id': randomUUID(), 'x-session-id': randomUUID(), 'x-user-aud': 'fan', 'x-user-scope': 'openid' }, productionBody(PLACE))).statusCode).toBe(401);
    expect((await create({ 'x-user-id': randomUUID(), 'x-session-id': randomUUID(), 'x-user-aud': 'partner', 'x-user-scope': '' }, productionBody(PLACE))).statusCode).toBe(401);
  });
});

describe('회차 더하기', () => {
  /** 그 테넌트의 공연을 만들고 ID를 돌려준다. approvedAt을 주면 판매 승인된 것으로 바꾼다 */
  async function production(tenant: string, openAt: string, approvedAt?: Date, saleReview: 'APPROVED' | 'SUSPENDED' | 'REJECTED' = 'APPROVED', startsAt?: string): Promise<{ id: string; eventId: string }> {
    const event = startsAt ? eventBody({ openAt, startsAt, endsAt: endsAtOf(startsAt) }) : eventBody({ openAt });
    const r = await create(identity.partner(tenant), productionBody(PLACE, { events: [event] }));
    // 준비가 막히면(409 등) 아래 eventIds[0]의 TypeError 대신 응답을 보여 준다
    expect(r.statusCode, r.payload).toBe(201);
    const out = JSON.parse(r.payload);
    if (approvedAt) repo.productions.set(out.productionId, { ...repo.productions.get(out.productionId)!, saleReview, saleApprovedAt: approvedAt });
    return { id: out.productionId, eventId: out.eventIds[0] };
  }
  const add = (h: Record<string, string>, productionId: string, body: unknown = eventBody({ openAt: openAtIn(23) })) => post(`/v1/partner/productions/${productionId}/events`, h, body);

  test('[ASVS v5.0.0-8.2.2] 다른테넌트의공연과없는공연은_같은404다', async () => {
    const p = await production(OTHER, openAtIn(24));
    const h = identity.partner(TENANT);
    const theirs = await add(h, p.id);
    const missing = await add(h, randomUUID());
    expect(theirs.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(problem(theirs).type).toBe(problem(missing).type);
    expect((await add(h, 'not-a-uuid')).statusCode).toBe(404);
  });

  test('승인이력이없는공연은_회차를바로넣고_실무자도더한다', async () => {
    const p = await production(TENANT, openAtIn(25));
    const r = await add(identity.partner(TENANT, 'partner_member'), p.id, eventBody({ openAt: openAtIn(25), startsAt: startsAtIn(51), endsAt: endsAtOf(startsAtIn(51)) }));
    expect(r.statusCode).toBe(201);
    const out = CreatePartnerProductionEventResponse.parse(JSON.parse(r.payload));
    expect(out.pending).toBe(false);
    expect(repo.events.get(out.eventId as string)?.productionId).toBe(p.id);
  });

  test('[ASVS v5.0.0-8.1.1] 승인이력이있는공연은_파트너관리자만더하고_실무자는403 partner-admin-required다', async () => {
    const p = await production(TENANT, openAtIn(26), APPROVED_AT);
    const r = await add(identity.partner(TENANT, 'partner_member'), p.id);
    expect(r.statusCode).toBe(403);
    expect(problem(r).type).toBe(`${P}partner-admin-required`);
  });

  test('[ASVS v5.0.0-8.1.1] 승인뒤더한회차는_변경분에만두고재승인대기가되며_그회차는공개요약에없다', async () => {
    const openAt = openAtIn(27);
    const startsAt = startsAtIn(52);
    const p = await production(TENANT, openAt, APPROVED_AT, 'APPROVED', startsAt);
    const r = await add(identity.partner(TENANT, 'partner_admin'), p.id, eventBody({ openAt, startsAt, endsAt: endsAtOf(startsAt) }));
    expect(r.statusCode).toBe(201);
    const out = JSON.parse(r.payload);
    expect(out.pending).toBe(true);
    expect(repo.events.has(out.eventId)).toBe(false);
    expect(repo.pending.get(p.id)?.map((e) => e.eventId)).toEqual([out.eventId]);
    expect(repo.productions.get(p.id)?.saleReview).toBe('SUBMITTED');
    // 마지막 승인 내용(첫 회차)은 계속 공개되고, 더한 회차는 승인 전까지 없는 회차다
    expect((await svc.http.inject({ method: 'GET', url: `/v1/events/${p.eventId}` })).statusCode).toBe(200);
    expect((await svc.http.inject({ method: 'GET', url: `/v1/events/${out.eventId}` })).statusCode).toBe(404);
  });

  test('반려된재승인중에더해도_상태는반려그대로다(다시요청은따로)', async () => {
    const openAt = openAtIn(28);
    const startsAt = startsAtIn(53);
    const p = await production(TENANT, openAt, APPROVED_AT, 'REJECTED', startsAt);
    const r = await add(identity.partner(TENANT, 'partner_admin'), p.id, eventBody({ openAt, startsAt, endsAt: endsAtOf(startsAt) }));
    expect(r.statusCode).toBe(201);
    expect(repo.productions.get(p.id)?.saleReview).toBe('REJECTED');
  });

  test('판매중지중인공연은_409 production-suspended다', async () => {
    const p = await production(TENANT, openAtIn(29), APPROVED_AT, 'SUSPENDED');
    const r = await add(identity.partner(TENANT, 'partner_admin'), p.id);
    expect(r.statusCode).toBe(409);
    expect(problem(r).type).toBe(`${P}production-suspended`);
  });
});
