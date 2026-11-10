// 받는 층: 판매 정책 규칙 읽기·저장, 회차 고치기, 공개 요약의 판매 단계, 팬별 판매 자격(openapi getPartnerSalePolicy·putPartnerSalePolicy·updatePartnerEvent·
// getEvent·getFanSaleEligibility, ADR-0261 결정 1~5, BUILD_ORDER HOT-250). 메모리 저장소로 응답이 계약 응답 스키마에 맞는지와 판정 차례를 본다.
// 실제 DB·행 보안·잠금은 test-int/sale-policy.int.test.ts가 본다. 단언 값은 정본의 글로 적는다(코드 상수를 가져오지 않는다).
import 'reflect-metadata';
import { GetEventResponse, GetFanSaleEligibilityResponse } from '@peaket/contracts/openapi/catalog';
import { GetPartnerSalePolicyResponse, PutPartnerSalePolicyResponse, UpdatePartnerEventResponse } from '@peaket/contracts/openapi/partner';
import { type Clock, createService } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import { fan, FakeIdentity, logSinkUnit, NOW_MS } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
const logs = logSinkUnit();
let now = NOW_MS;
const clock: Clock = { now: () => now, monotonicMs: () => performance.now() };
const TENANT = randomUUID();
const OTHER = randomUUID();
const P = 'https://peaket.example/problems/';
const KEY = 'lumen-fanclub-2026';

beforeAll(async () => {
  repo.sellerNames.set(TENANT, '(주)피켓공연');
  repo.sellerNames.set(OTHER, '(주)다른공연');
  svc = await createService({ name: 'core-svc', module: AppModule.register({ memory: true, catalog: repo }), env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info' }, clock, logDestination: logs.stream, adminAuthz: identity });
});
afterAll(async () => {
  await svc?.close();
});

/** 공연 하나와 회차 둘(1인 한도 4·3, 2026-11-20 20:00 KST 오픈). 승인 이력이 있으면 APPROVED */
function seed(o: { approved?: boolean; tenant?: string } = {}): { productionId: string; events: [string, string] } {
  const productionId = randomUUID();
  repo.productions.set(productionId, { id: productionId, promoterId: o.tenant ?? TENANT, placeId: randomUUID(), title: '겨울 콘서트', genre: '콘서트', saleReview: o.approved ? 'APPROVED' : 'DRAFT', saleApprovedAt: o.approved ? new Date('2026-11-01T00:00:00Z') : null });
  const events = [randomUUID(), randomUUID()] as [string, string];
  events.forEach((id, i) => {
    repo.events.set(id, { id, productionId, venueId: null, openAt: new Date('2026-11-20T11:00:00Z'), startsAt: new Date(Date.parse('2026-12-24T10:00:00Z') + i * 86_400_000), status: 'SCHEDULED' });
    repo.details.set(id, { event: { perPersonLimit: i === 0 ? 4 : 3, endsAt: new Date(Date.parse('2026-12-24T12:30:00Z') + i * 86_400_000) } });
  });
  return { productionId, events };
}

const fanclub = (rounds: unknown = 'ALL') => ({
  version: 1,
  name: '팬클럽 선예매',
  rounds,
  during: { from: '2026-11-20T20:00:00+09:00', to: '2026-11-20T22:00:00+09:00' },
  rule: { if: { fact: 'buyer.lists', has: KEY }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } },
});

const policyUrl = (id: string) => `/v1/partner/productions/${id}/sale-policy`;
const getPolicy = (id: string, h = identity.partner(TENANT)) => svc.http.inject({ method: 'GET', url: policyUrl(id), headers: h });
const putRaw = (id: string, payload: string, ifMatch: string | null, h = identity.partner(TENANT)) =>
  svc.http.inject({ method: 'PUT', url: policyUrl(id), headers: { ...h, 'content-type': 'application/json', ...(ifMatch ? { 'if-match': ifMatch } : {}) }, payload });
/** ifMatch null이면 If-Match를 보내지 않는다 */
const put = (id: string, rules: unknown[], ifMatch: string | null = '"1"', h?: Record<string, string>) => putRaw(id, JSON.stringify({ rules }), ifMatch, h);
const patch = (eventId: string, body: unknown, ifMatch: string | null = '"1"', h = identity.partner(TENANT)) =>
  svc.http.inject({ method: 'PATCH', url: `/v1/partner/events/${eventId}`, headers: { ...h, 'content-type': 'application/json', ...(ifMatch ? { 'if-match': ifMatch } : {}) }, payload: JSON.stringify(body) });
const problem = (r: { payload: string }) => JSON.parse(r.payload) as { type: string; errors?: { rule: number; path: string; code: string }[] };

describe('판매 정책 규칙 읽기·저장(메모리)', () => {
  test('규칙 본문의 __proto__·constructor·prototype 키와 정의 밖 칸은 거절한다 [ASVS v5.0.0-1.5.2]', async () => {
    const { productionId } = seed();
    const rule = JSON.stringify(fanclub());
    for (const inner of ['"__proto__":{"x":1}', '"constructor":{"x":1}', '"prototype":{"x":1}', '"extra":1']) {
      const r = await putRaw(productionId, `{"rules":[${rule.slice(0, -1)},${inner}}]}`, '"1"');
      expect([r.statusCode, r.headers['cache-control']]).toEqual([400, 'no-store']);
    }
    // 조건 안 깊은 곳의 키도 같다
    const deep = await putRaw(productionId, `{"rules":[{"version":1,"name":"x","rounds":"ALL","rule":{"if":{"all":[{"fact":"grade","eq":"VIP","__proto__":{"y":1}}]},"then":{"allow":true}}}]}`, '"1"');
    expect(deep.statusCode).toBe(400);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    // 하나도 저장되지 않았다
    expect(JSON.parse((await getPolicy(productionId)).payload)).toEqual({ rules: [], version: 1, pending: false });
  });

  test('계약 밖 모양(키 모양·이름 길이·사실·연산자·깊이 4·잎 11·8KB·규칙 21)은 400·422다 [ASVS v5.0.0-2.1.1] [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-2.3.2]', async () => {
    const { productionId } = seed();
    const leaf = { fact: 'quantity', lte: 2 };
    const ruleWith = (cond: unknown, extra: Record<string, unknown> = {}) => ({ version: 1, name: '조건', rounds: 'ALL', rule: { if: cond, then: { limitPerPerson: 1 } }, ...extra });
    const status = async (rules: unknown[]) => (await put(productionId, rules)).statusCode;
    // 모양은 계약이 400으로 막는다(이름 41자·모르는 연산자). 사실 이름·명단 키 모양·규칙 수·깊이는 칸 위치를 알리려 평가 함수의 422로 낸다(리뷰 A4)
    expect(await status([ruleWith(leaf, { name: '가'.repeat(41) })])).toBe(400);
    expect(await status([ruleWith(leaf, { name: '가'.repeat(40) })])).toBe(200);
    expect(await status([ruleWith({ fact: 'grade', ne: 'VIP' })])).toBe(400);
    const errorsOf = async (rules: unknown[]) => {
      const r = await put(productionId, rules, '"2"');
      return [r.statusCode, problem(r).errors];
    };
    expect(await errorsOf([ruleWith({ fact: 'buyer.lists', has: 'AB' })])).toEqual([422, [{ rule: 0, path: '/rule/if/has', code: 'LIST_KEY_INVALID' }]]);
    expect(await errorsOf([ruleWith({ fact: 'buyer.age', eq: 1 })])).toEqual([422, [{ rule: 0, path: '/rule/if/fact', code: 'UNKNOWN_FACT' }]]);
    expect(await errorsOf([ruleWith({ all: [{ any: [{ not: leaf }] }] })])).toEqual([422, [{ rule: 0, path: '/rule/if/all/0/any/0/not', code: 'TOO_DEEP' }]]);
    expect(await errorsOf(Array.from({ length: 21 }, (_, i) => ruleWith(leaf, { name: `규칙 ${i}` })))).toEqual([422, [{ rule: 20, path: '', code: 'TOO_MANY_RULES' }]]);
    // 계약이 받는 모양이어도 뜻 검사(@peaket/validation/sale-policy)가 422로 막는다: 잎 11·규칙 8KB·사실과 연산자 짝·창
    const many = await put(productionId, [ruleWith({ all: [{ all: Array.from({ length: 6 }, () => leaf) }, { any: Array.from({ length: 5 }, () => leaf) }] })], '"2"');
    expect([many.statusCode, problem(many).type, problem(many).errors]).toEqual([422, `${P}sale-policy-invalid`, [{ rule: 0, path: '/rule/if', code: 'TOO_MANY_CONDITIONS' }]]);
    const big = await put(productionId, [ruleWith({ fact: 'grade', in: Array.from({ length: 60 }, (_, i) => `grade-${i}`.padEnd(140, 'x')) })], '"2"');
    expect(problem(big).errors?.[0]).toEqual({ rule: 0, path: '', code: 'RULE_TOO_LARGE' });
    const pair = await put(productionId, [ruleWith({ fact: 'buyer.lists', eq: KEY })], '"2"');
    expect(problem(pair).errors).toEqual([{ rule: 0, path: '/rule/if', code: 'OPERATOR_MISMATCH' }]);
    const window = await put(productionId, [{ ...fanclub(), during: { from: '2026-11-20T20:00:00+09:00', to: '2026-11-20T20:00:00+09:00' } }], '"2"');
    expect(problem(window).errors).toEqual([{ rule: 0, path: '/during/to', code: 'WINDOW_INVALID' }]);
    // 20개까지는 받는다
    expect((await put(productionId, Array.from({ length: 20 }, (_, i) => ruleWith(leaf, { name: `규칙 ${i}` })), '"2"')).statusCode).toBe(200);
  });

  test('규칙 저장은 If-Match 판을 보고(없으면 428·옛 판 412) 판을 9에서 10으로 올려도 글자로 견주지 않으며 GET이 그 판과 규칙을 준다', async () => {
    const { productionId } = seed();
    const first = await getPolicy(productionId);
    expect([first.statusCode, first.headers.etag, first.headers['cache-control']]).toEqual([200, '"1"', 'no-store']);
    expect(GetPartnerSalePolicyResponse.parse(JSON.parse(first.payload))).toEqual({ rules: [], version: 1, pending: false });
    expect(problem(await put(productionId, [fanclub()], null)).type).toBe(`${P}precondition-required`);
    for (let v = 1; v <= 10; v++) {
      const r = await put(productionId, [fanclub()], `"${v}"`);
      expect([r.statusCode, r.headers.etag]).toEqual([200, `"${v + 1}"`]);
      expect(PutPartnerSalePolicyResponse.parse(JSON.parse(r.payload))).toEqual({ version: v + 1, pending: false });
    }
    expect(problem(await put(productionId, [fanclub()], '"10"')).type).toBe(`${P}precondition-failed`);
    expect(problem(await put(productionId, [fanclub()], '"1"')).type).toBe(`${P}precondition-failed`);
    const after = JSON.parse((await getPolicy(productionId)).payload);
    expect(after).toEqual({ rules: [fanclub()], version: 11, pending: false });
  });

  test('승인 이력이 있는 공연의 규칙 저장은 실무자 403이고 관리자는 변경분에 두며 APPROVED는 SUBMITTED다 [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-16.3.2]', async () => {
    const { productionId } = seed({ approved: true });
    repo.salePolicies.set(productionId, { rules: [], version: 1 });
    const member = identity.partner(TENANT, 'partner_member');
    const denied = await put(productionId, [fanclub()], '"1"', member);
    expect([denied.statusCode, problem(denied).type]).toEqual([403, `${P}partner-admin-required`]);
    expect(logs.lines().some((l) => l.event === 'partner_production_denied' && l.route === 'sale_policy' && l.reason === 'partner_admin_required' && l.kind === 'security')).toBe(true);
    const ok = await put(productionId, [fanclub()], '"1"', identity.partner(TENANT, 'partner_admin'));
    expect(JSON.parse(ok.payload)).toEqual({ version: 2, pending: true });
    // 공개본은 그대로, 변경분에만 있다
    expect(repo.salePolicies.get(productionId)).toEqual({ rules: [], version: 2, pending: [fanclub()] });
    expect(repo.productions.get(productionId)?.saleReview).toBe('SUBMITTED');
    expect(JSON.parse((await getPolicy(productionId)).payload)).toEqual({ rules: [fanclub()], version: 2, pending: true });
  });

  test('다른 파트너 공연의 규칙 읽기·저장과 판매 중지 공연 저장은 거절한다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.4.1]', async () => {
    const { productionId } = seed({ tenant: OTHER });
    expect(problem(await getPolicy(productionId)).type).toBe(`${P}not-found`);
    expect(problem(await put(productionId, [fanclub()])).type).toBe(`${P}not-found`);
    expect(problem(await getPolicy(randomUUID())).type).toBe(`${P}not-found`);
    expect(repo.salePolicies.get(productionId)).toBeUndefined();
    const s = seed({ approved: true });
    repo.productions.set(s.productionId, { ...repo.productions.get(s.productionId)!, saleReview: 'SUSPENDED' });
    expect(problem(await put(s.productionId, [fanclub()], '"1"', identity.partner(TENANT, 'partner_admin'))).type).toBe(`${P}production-suspended`);
  });
});

describe('회차 고치기(메모리)', () => {
  test('오픈 1ms 전 정렬 고치기는 200·오픈 시각은 409 sale-setting-locked, 옛 판 412·없음 428, 승인 이력은 변경분과 SUBMITTED [ASVS v5.0.0-2.3.2]', async () => {
    const { productionId, events } = seed();
    const open = Date.parse('2026-11-20T11:00:00Z');
    now = open - 1;
    expect((await patch(events[0], { lobbyShuffle: false }, null)).statusCode).toBe(428);
    const r = await patch(events[0], { lobbyShuffle: false });
    expect([r.statusCode, r.headers.etag, r.headers['cache-control']]).toEqual([200, '"2"', 'no-store']);
    expect(UpdatePartnerEventResponse.parse(JSON.parse(r.payload))).toEqual({ eventId: events[0], version: 2, pending: false, warnings: [] });
    expect(repo.details.get(events[0])?.event?.lobbyShuffle).toBe(false);
    expect(problem(await patch(events[0], { openBatch: true }, '"1"')).type).toBe(`${P}precondition-failed`);
    // 둘 다 끄면 422
    expect(problem(await patch(events[0], { openBatch: false }, '"2"')).type).toBe(`${P}queue-order-invalid`);
    now = open;
    const locked = await patch(events[0], { lobbyShuffle: true }, '"2"');
    expect([locked.statusCode, problem(locked).type]).toEqual([409, `${P}sale-setting-locked`]);
    expect(logs.lines().some((l) => l.event === 'sale_setting_locked_attempt' && l.kind === 'security')).toBe(true);
    // 오픈 뒤에도 잠기지 않은 칸(종료 시각·1인 한도)은 고친다
    expect((await patch(events[0], { perPersonLimit: 3 }, '"2"')).statusCode).toBe(200);
    // 승인 이력이 있으면 변경분에 두고 APPROVED는 SUBMITTED
    now = NOW_MS;
    const a = seed({ approved: true });
    const member = await patch(a.events[1], { perPersonLimit: 2 }, '"1"', identity.partner(TENANT, 'partner_member'));
    expect(problem(member).type).toBe(`${P}partner-admin-required`);
    const admin = await patch(a.events[1], { perPersonLimit: 2, seatAssignment: 'AUTO' }, '"1"', identity.partner(TENANT, 'partner_admin'));
    expect(JSON.parse(admin.payload)).toEqual({ eventId: a.events[1], version: 2, pending: true, warnings: [] });
    expect(repo.eventChanges.get(a.productionId)).toEqual({ [a.events[1]]: { perPersonLimit: 2, seatAssignment: 'AUTO' } });
    expect(repo.details.get(a.events[1])?.event?.perPersonLimit).toBe(3);
    expect(repo.productions.get(a.productionId)?.saleReview).toBe('SUBMITTED');
    // 본문 모양: 빈 본문·정의 밖 칸은 400, 다른 파트너 회차는 404
    expect((await patch(events[1], {})).statusCode).toBe(400);
    expect((await patch(events[1], { reentryAllowed: true })).statusCode).toBe(400);
    expect(problem(await patch(seed({ tenant: OTHER }).events[0], { lobbyMinutes: 5 })).type).toBe(`${P}not-found`);
    void productionId;
  });

  test('1인 한도를 그 회차에 걸린 규칙의 limitPerPerson보다 작게 바꾸면 422 sale-policy-invalid다 [ASVS v5.0.0-2.1.2]', async () => {
    now = NOW_MS;
    const { productionId, events } = seed();
    expect((await put(productionId, [fanclub([events[1]])])).statusCode).toBe(200);
    const r = await patch(events[1], { perPersonLimit: 1 });
    expect([r.statusCode, problem(r).type, problem(r).errors]).toEqual([422, `${P}sale-policy-invalid`, [{ rule: 0, path: '/rule/then/limitPerPerson', code: 'LIMIT_ABOVE_EVENT' }]]);
    // 같은 값(2)까지는 된다. 규칙이 걸리지 않은 회차는 1도 된다
    expect((await patch(events[1], { perPersonLimit: 2 })).statusCode).toBe(200);
    expect((await patch(events[0], { perPersonLimit: 1 })).statusCode).toBe(200);
  });
});

describe('공개 요약·팬별 자격(메모리)', () => {
  test('공개 요약 salePhases·refundFees·PRESALE 배지는 승인 내용의 규칙으로, 팬 자격은 명단 구성원으로 계산하고 no-store다 [ASVS v5.0.0-8.2.2]', async () => {
    now = Date.parse('2026-11-10T00:00:00Z');
    const { productionId, events } = seed({ approved: true });
    const fee = { version: 1, name: '공제', rounds: 'ALL', refundFee: [{ daysLeft: { gte: 7, lte: 9 }, rate: 10 }, { daysLeft: { gte: 10, lte: 365 }, rate: 0 }] };
    repo.salePolicies.set(productionId, { rules: [fanclub(), fee] as never, version: 1, pending: [] });
    const r = await svc.http.inject({ method: 'GET', url: `/v1/events/${events[0]}` });
    const body = GetEventResponse.parse(JSON.parse(r.payload));
    expect(body.salePhases).toEqual([
      { kind: 'PRESALE', startsAt: '2026-11-20T11:00:00.000Z', endsAt: '2026-11-20T13:00:00.000Z', limitPerPerson: 2 },
      { kind: 'GENERAL', startsAt: '2026-11-20T13:00:00.000Z', endsAt: '2026-12-23T10:00:00.000Z', limitPerPerson: 4 },
    ]);
    expect(body.refundFees).toEqual([
      { daysLeft: { gte: 10, lte: 365 }, rate: 0 },
      { daysLeft: { gte: 7, lte: 9 }, rate: 10 },
    ]);
    expect(body.badges).toEqual(['HYBRID', 'PRESALE']);
    // 변경분(pending)의 빈 규칙이 아니라 공개본으로 계산했다. 선예매 창이 끝나면 배지를 떼다
    now = Date.parse('2026-11-20T13:00:00Z');
    expect(GetEventResponse.parse(JSON.parse((await svc.http.inject({ method: 'GET', url: `/v1/events/${events[0]}` })).payload)).badges).toEqual(['HYBRID']);
    now = Date.parse('2026-11-10T00:00:00Z');
    // 팬별 자격: 명단 구성원은 선예매 대상이고 한도 2, 아니면 대상이 아니다
    const member = randomUUID();
    repo.saleLists.set(randomUUID(), { id: randomUUID(), key: KEY, name: 'LUMEN 팬클럽 2026', memberCount: 1, version: 1, copySeq: 1, copiedSeq: null, uploadedAt: new Date(now), lockedAt: null, destroyDueAt: new Date('2026-12-25T10:00:00Z'), productionId, promoterId: TENANT, fileSha256: new Uint8Array(32), uploadedBy: randomUUID(), members: new Set([member]) });
    const mine = await svc.http.inject({ method: 'GET', url: `/v1/events/${events[0]}/sale-eligibility`, headers: fan(member) });
    expect([mine.statusCode, mine.headers['cache-control']]).toEqual([200, 'no-store']);
    expect(GetFanSaleEligibilityResponse.parse(JSON.parse(mine.payload))).toEqual({
      eventId: events[0],
      phases: [
        { kind: 'PRESALE', startsAt: '2026-11-20T11:00:00.000Z', endsAt: '2026-11-20T13:00:00.000Z', eligible: true, limitPerPerson: 2 },
        { kind: 'GENERAL', startsAt: '2026-11-20T13:00:00.000Z', endsAt: '2026-12-23T10:00:00.000Z', eligible: true, limitPerPerson: 4 },
      ],
      lists: [{ name: 'LUMEN 팬클럽 2026', destroyAt: '2026-12-25T10:00:00.000Z' }],
    });
    const stranger = JSON.parse((await svc.http.inject({ method: 'GET', url: `/v1/events/${events[0]}/sale-eligibility`, headers: fan() })).payload);
    expect(stranger.phases.map((p: { eligible: boolean }) => p.eligible)).toEqual([false, true]);
    expect(stranger.lists).toEqual([]);
    // 비로그인 401(no-store), 공개되지 않은 회차 404
    const anon = await svc.http.inject({ method: 'GET', url: `/v1/events/${events[0]}/sale-eligibility` });
    expect([anon.statusCode, anon.headers['cache-control']]).toEqual([401, 'no-store']);
    const hidden = seed();
    expect(problem(await svc.http.inject({ method: 'GET', url: `/v1/events/${hidden.events[0]}/sale-eligibility`, headers: fan() })).type).toBe(`${P}not-found`);
  });
});

describe('리뷰 재현(메모리, 2026-11-10)', () => {
  const fee = (name: string, rounds: unknown, from: number, n: number) => ({ version: 1, name, rounds, refundFee: Array.from({ length: n }, (_, i) => ({ daysLeft: { gte: from + i, lte: from + i }, rate: 0 })) });

  test('S-T39 ⑥ 한 회차에 걸리는 공제율 구간이 20개를 넘는 규칙은 422 TOO_MANY_REFUND_BANDS이고 공개 요약은 20개까지만 싣는다(리뷰 A1)', async () => {
    now = NOW_MS;
    const { productionId, events } = seed({ approved: true });
    repo.salePolicies.set(productionId, { rules: [], version: 1 });
    const r = await put(productionId, [fee('가', 'ALL', 10, 10), fee('나', [events[0]], 30, 10), fee('다', [events[0]], 50, 1)], '"1"', identity.partner(TENANT, 'partner_admin'));
    expect([r.statusCode, problem(r).errors]).toEqual([422, [{ rule: 2, path: '/refundFee', code: 'TOO_MANY_REFUND_BANDS' }]]);
    // 저장 검사를 지나지 않은 옛 규칙이 남아 있어도 공개 요약은 계약 상한(20개)을 넘기지 않는다
    repo.salePolicies.set(productionId, { rules: [fee('가', 'ALL', 10, 10), fee('나', 'ALL', 30, 10), fee('다', 'ALL', 50, 5)] as never, version: 1 });
    const body = GetEventResponse.parse(JSON.parse((await svc.http.inject({ method: 'GET', url: `/v1/events/${events[0]}` })).payload));
    expect(body.refundFees).toHaveLength(20);
  });

  test('회차 더하기도 그 공연의 ALL 규칙 한도를 보고 1인 한도가 더 작으면 422 sale-policy-invalid다(리뷰 A5)', async () => {
    now = NOW_MS;
    const { productionId } = seed();
    expect((await put(productionId, [fanclub()])).statusCode).toBe(200);
    const add = (perPersonLimit: number) =>
      svc.http.inject({
        method: 'POST',
        url: `/v1/partner/productions/${productionId}/events`,
        headers: { ...identity.partner(TENANT), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        payload: JSON.stringify({ openAt: '2026-11-21T11:00:00Z', startsAt: '2026-12-30T10:00:00Z', endsAt: '2026-12-30T12:00:00Z', perPersonLimit }),
      });
    const low = await add(1);
    expect([low.statusCode, problem(low).type, problem(low).errors]).toEqual([422, `${P}sale-policy-invalid`, [{ rule: 0, path: '/rule/then/limitPerPerson', code: 'LIMIT_ABOVE_EVENT' }]]);
    expect((await add(2)).statusCode).toBe(201);
  });

  test('S-T39 ⑥ 승인 뒤 더한 회차(변경분에만 있는 회차)도 그 공연의 회차로 보고 그 회차의 1인 한도와 견준다(틀린 구현 검사 BAT-157) [ASVS v5.0.0-2.1.2]', async () => {
    now = NOW_MS;
    const { productionId } = seed({ approved: true });
    repo.salePolicies.set(productionId, { rules: [], version: 1 });
    const admin = identity.partner(TENANT, 'partner_admin');
    const add = await svc.http.inject({
      method: 'POST',
      url: `/v1/partner/productions/${productionId}/events`,
      headers: { ...admin, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      payload: JSON.stringify({ openAt: '2026-11-22T11:00:00Z', startsAt: '2026-12-31T10:00:00Z', endsAt: '2026-12-31T12:00:00Z', perPersonLimit: 2 }),
    });
    expect(add.statusCode).toBe(201);
    const added = JSON.parse(add.payload).eventId as string;
    // 더한 회차(1인 한도 2)에 한도 3은 LIMIT_ABOVE_EVENT, 2는 받는다(UNKNOWN_ROUND가 아니다)
    const over = await put(productionId, [{ version: 1, name: '더한 회차', rounds: [added], rule: { then: { limitPerPerson: 3 } } }], '"1"', admin);
    expect([over.statusCode, problem(over).errors]).toEqual([422, [{ rule: 0, path: '/rule/then/limitPerPerson', code: 'LIMIT_ABOVE_EVENT' }]]);
    const ok = await put(productionId, [{ version: 1, name: '더한 회차', rounds: [added], rule: { if: { fact: 'round', eq: added }, then: { limitPerPerson: 2 } } }], '"1"', admin);
    expect([ok.statusCode, JSON.parse(ok.payload)]).toEqual([200, { version: 2, pending: true }]);
  });

  test('회차 고치기의 한도 검사는 고친 뒤 상태 전체로 보고, 같은 값만 보낸 PATCH는 판을 올리지 않으며 승인 이력 공연은 바뀐 칸만 변경분에 둔다(리뷰 A5)', async () => {
    now = NOW_MS;
    const { productionId, events } = seed();
    expect((await put(productionId, [fanclub()])).statusCode).toBe(200);
    // 앞서 다른 회차가 이미 규칙 한도(2)보다 작다(옛 자료). 이 회차를 1로 낮추는 것도 같은 규칙에 걸린다
    repo.details.set(events[0], { event: { ...repo.details.get(events[0])?.event, perPersonLimit: 1 } });
    const r = await patch(events[1], { perPersonLimit: 1 });
    expect([r.statusCode, problem(r).errors]).toEqual([422, [{ rule: 0, path: '/rule/then/limitPerPerson', code: 'LIMIT_ABOVE_EVENT' }]]);
    // 같은 값만 보내면 아무것도 바꾸지 않고 판도 그대로다
    const same = await patch(events[1], { perPersonLimit: 3, lobbyMinutes: 10 });
    expect([same.statusCode, same.headers.etag, JSON.parse(same.payload)]).toEqual([200, '"1"', { eventId: events[1], version: 1, pending: false, warnings: [] }]);
    expect(repo.eventVersions.get(events[1])).toBeUndefined();
    const a = seed({ approved: true });
    const changed = await patch(a.events[0], { perPersonLimit: 4, seatAssignment: 'AUTO' }, '"1"', identity.partner(TENANT, 'partner_admin'));
    expect(changed.statusCode).toBe(200);
    expect(repo.eventChanges.get(a.productionId)).toEqual({ [a.events[0]]: { seatAssignment: 'AUTO' } });
  });

  test('팬별 자격은 공개 요약 전체를 읽지 않고, 단계마다 그 조각 시작 시각으로 계산한다(카드사 명단은 둘째 조각에서 대상, 리뷰 A2·C3)', async () => {
    now = Date.parse('2026-11-10T00:00:00Z');
    const { productionId, events } = seed({ approved: true });
    const window = (key: string, from: string, to: string) => ({ version: 1, name: key, rounds: 'ALL', during: { from, to }, rule: { if: { fact: 'buyer.lists', has: key }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } } });
    repo.salePolicies.set(productionId, { rules: [window('fanclub-a', '2026-11-20T20:00:00+09:00', '2026-11-20T21:00:00+09:00'), window('card-b', '2026-11-20T21:00:00+09:00', '2026-11-20T22:00:00+09:00')] as never, version: 1 });
    const member = randomUUID();
    repo.saleLists.set(randomUUID(), { id: randomUUID(), key: 'card-b', name: '카드사 회원', memberCount: 1, version: 1, copySeq: 1, copiedSeq: null, uploadedAt: new Date(now), lockedAt: null, destroyDueAt: new Date('2026-12-25T10:00:00Z'), productionId, promoterId: TENANT, fileSha256: new Uint8Array(32), uploadedBy: randomUUID(), members: new Set([member]) } as never);
    const summary = repo.findEventSummary.bind(repo);
    let summaries = 0;
    repo.findEventSummary = async (id: string) => {
      summaries++;
      return summary(id);
    };
    try {
      const r = await svc.http.inject({ method: 'GET', url: `/v1/events/${events[0]}/sale-eligibility`, headers: fan(member) });
      expect(JSON.parse(r.payload).phases.map((p: { kind: string; eligible: boolean }) => [p.kind, p.eligible])).toEqual([
        ['PRESALE', false],
        ['PRESALE', true],
        ['GENERAL', true],
      ]);
      expect(summaries).toBe(0);
    } finally {
      repo.findEventSummary = summary;
    }
  });
});
