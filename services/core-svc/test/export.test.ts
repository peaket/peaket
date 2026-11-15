// 예매자 명단 내려받기 시험(BUILD_ORDER BAT-610 잔여, I-T53·J-T26, FR-027·064).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryActorNames, MemoryAttendeeExportStore, MemoryPartnerEventLookup } from '../src/modules/export/index.js';
import { ExportProblem } from '../src/modules/export/domain/export.js';
import { MemoryMerchOrderStore, maskName, maskPhone, settlementBasisDate, type MerchOrderItemRecord, type MerchOrderRecord } from '../src/modules/shop/index.js';
import type { BookersReauth } from '../src/modules/export/domain/ports.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';

const TENANT = randomUUID();
const OTHER = randomUUID();
const EVENT = randomUUID();
const IDENTITY = new FakeIdentity();
const merch = new MemoryMerchOrderStore();
const exportsStore = new MemoryAttendeeExportStore();
const events = new MemoryPartnerEventLookup();
const actors = new MemoryActorNames();

class TestReauth implements BookersReauth {
  async verify(token: string | undefined, _o: { sessionId: string; promoterId: string }) {
    if (!token) throw new ExportProblem('reauth-required', 403, '다시 인증해 주세요');
    return { accountId: token, factors: ['password', 'totp', 'passkey'] };
  }
}
const reauth = new TestReauth();
let svc: Awaited<ReturnType<typeof createService>>;

const item = (o: Partial<MerchOrderItemRecord> = {}): MerchOrderItemRecord => ({
  itemId: randomUUID(),
  orderId: '',
  promoterId: TENANT,
  eventId: EVENT,
  productId: randomUUID(),
  productName: '응원봉',
  quantity: 2,
  unitAmount: 15_000,
  commissionRateBp: 1000,
  status: 'DELIVERED',
  fulfillment: 'DELIVERY',
  seatLabel: 'A-12',
  shippedAt: new Date('2026-10-20T00:00:00Z'),
  deliveredAt: new Date('2026-10-22T00:00:00Z'),
  pickedUpAt: null,
  returnRequestedAt: null,
  returnResolvedAt: null,
  refundedAmount: 0,
  eventEndsAt: null,
  ticketLinked: false,
  ...o,
});

const order = (orderId: string, o: Partial<MerchOrderRecord> = {}): MerchOrderRecord => ({
  orderId,
  promoterId: TENANT,
  eventId: EVENT,
  buyerName: '김민수',
  buyerPhone: '010-1234-5678',
  status: 'PAID',
  pg: 'TOSS',
  pgStore: 'STANDARD',
  shippingFee: 3_000,
  purchaseConfirmedAt: null,
  orderedAt: new Date('2026-10-19T00:00:00Z'),
  ...o,
});

beforeAll(async () => {
  const o1 = randomUUID();
  const o2 = randomUUID();
  await merch.insertOrder(order(o1), [item({ orderId: o1 })]);
  await merch.insertOrder(order(o2, { buyerName: '이서', buyerPhone: '010-9876-5432' }), [item({ orderId: o2, seatLabel: 'B-03', quantity: 1 })]);
  events.add(TENANT, EVENT, 'LUMEN 콘서트', new Date('2026-10-25T12:00:00Z'));
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({
      memory: true,
      shop: { merch },
      export: { store: exportsStore, source: { list: (p, e, l, c) => merch.listAttendees(p, e, l, c), count: (p, e) => merch.countAttendees(p, e) }, events, reauth, actors },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: IDENTITY,
  });
});
afterAll(async () => {
  await svc?.close();
});

const headers = (tenant = TENANT, token?: string, role: 'partner_admin' | 'partner_member' = 'partner_admin') => {
  const h = IDENTITY.partner(tenant, role);
  actors.set(h['x-user-id']!, '스텔라 관리자');
  return { ...h, 'x-reauth-token': token ?? h['x-user-id']!, 'content-type': 'application/json' };
};

describe('I-T53·J-T26 예매자 명단', () => {
  test('I-T53 ② 재인증 토큰이 없거나 틀리면 403 reauth-required다', async () => {
    for (const token of ['', 'wrong']) {
      const r = await svc.http.inject({ method: 'POST', url: `/v1/partner/events/${EVENT}/attendee-exports`, headers: headers(TENANT, token), payload: JSON.stringify({ reason: '현장 대조', format: 'CSV' }) });
      expect(r.statusCode).toBe(403);
      expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/reauth-required' });
    }
  });

  test('J-T26 ① 사유가 없으면 거절되고, 사유·건수는 이력에 남는다', async () => {
    const missing = await svc.http.inject({ method: 'POST', url: `/v1/partner/events/${EVENT}/attendee-exports`, headers: headers(), payload: JSON.stringify({ format: 'CSV' }) });
    expect(missing.statusCode).toBe(400);
    const blank = await svc.http.inject({ method: 'POST', url: `/v1/partner/events/${EVENT}/attendee-exports`, headers: headers(), payload: JSON.stringify({ reason: '   ', format: 'CSV' }) });
    expect(blank.statusCode).toBe(422);
    const ok = await svc.http.inject({ method: 'POST', url: `/v1/partner/events/${EVENT}/attendee-exports`, headers: headers(), payload: JSON.stringify({ reason: '현장 명단 대조', format: 'CSV' }) });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/csv');
    expect(ok.rawPayload.toString('utf8')).toContain('김민수');
    expect(ok.rawPayload.toString('utf8')).toContain('010-1234-5678');
    const history = JSON.parse((await svc.http.inject({ method: 'GET', url: `/v1/partner/events/${EVENT}/attendee-exports`, headers: headers() })).payload);
    expect(history.items[0]).toMatchObject({ actorDisplayName: '스텔라 관리자', actorRole: 'partner_admin', reason: '현장 명단 대조', count: 2, format: 'CSV', result: 'COMPLETED' });
    expect(exportsStore.audits.at(-1)).toMatchObject({ reason: '현장 명단 대조', format: 'CSV', count: 2, actorRole: 'partner_admin' });
  });

  test('J-T26 ② XLSX는 ZIP 머리로 시작하고 파일 이름이 붙는다', async () => {
    const r = await svc.http.inject({ method: 'POST', url: `/v1/partner/events/${EVENT}/attendee-exports`, headers: headers(), payload: JSON.stringify({ reason: '회계 확인', format: 'XLSX' }) });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    expect(r.headers['content-disposition']).toContain('LUMEN');
    expect(r.rawPayload.subarray(0, 2).toString('utf8')).toBe('PK');
  });

  test('J-T26 ③ 보유 기간이 지나면 410 retention-ended다', async () => {
    const oldId = randomUUID();
    events.add(TENANT, oldId, '오래된 공연', new Date('2026-08-01T00:00:00Z'));
    const r = await svc.http.inject({ method: 'GET', url: `/v1/partner/events/${oldId}/attendees`, headers: headers() });
    expect(r.statusCode).toBe(410);
    expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/retention-ended' });
  });

  test('J-T26 명단 보기는 가린 값만 주고 다른 테넌트는 404다', async () => {
    const r = await svc.http.inject({ method: 'GET', url: `/v1/partner/events/${EVENT}/attendees`, headers: headers() });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body).toMatchObject({ bookingCount: 2, ticketCount: 3 });
    const kim = body.items.find((i: { buyerNameMasked: string }) => i.buyerNameMasked === '김*수');
    expect(kim).toMatchObject({ buyerPhoneMasked: '010-****-5678', ticketCount: 2 });
    expect(JSON.stringify(body)).not.toContain('김민수');
    expect((await svc.http.inject({ method: 'GET', url: `/v1/partner/events/${EVENT}/attendees`, headers: headers(OTHER) })).statusCode).toBe(404);
  });

  test('J-T26 실무자는 내려받기·이력을 부를 수 없다', async () => {
    const r = await svc.http.inject({ method: 'GET', url: `/v1/partner/events/${EVENT}/attendee-exports`, headers: headers(TENANT, undefined, 'partner_member') });
    expect(r.statusCode).toBe(403);
  });
});

describe('J-T18 상품 정산 기준일', () => {
  const base = order(randomUUID());
  test('택배는 받은 날 +8일, 송장만 있으면 +15일, 구매 확정 전 에스크로는 빠진다', () => {
    expect(settlementBasisDate(item({ deliveredAt: new Date('2026-10-22T00:00:00Z') }), base)).toBe('2026-10-30');
    expect(settlementBasisDate(item({ deliveredAt: null, shippedAt: new Date('2026-10-20T00:00:00Z') }), base)).toBe('2026-11-04');
    expect(settlementBasisDate(item({ deliveredAt: null, shippedAt: null }), base)).toBeNull();
    expect(settlementBasisDate(item({ deliveredAt: new Date('2026-10-22T00:00:00Z') }), { ...base, pgStore: 'ESCROW' })).toBeNull();
    expect(settlementBasisDate(item({ deliveredAt: new Date('2026-10-22T00:00:00Z') }), { ...base, pgStore: 'ESCROW', purchaseConfirmedAt: new Date('2026-10-24T00:00:00Z') })).toBe('2026-10-24');
  });

  test('반품 요청 중·현장 수령·티켓 연동 규칙', () => {
    expect(settlementBasisDate(item({ status: 'RETURN_REQUESTED' }), base)).toBeNull();
    expect(settlementBasisDate(item({ fulfillment: 'PICKUP', deliveredAt: null, pickedUpAt: new Date('2026-10-23T00:00:00Z') }), base)).toBe('2026-10-31');
    expect(settlementBasisDate(item({ ticketLinked: true, eventEndsAt: new Date('2026-10-25T12:00:00Z') }), base)).toBe('2026-10-26');
  });

  test('J-T26 CSV는 수식으로 읽힐 첫 글자를 막는다', async () => {
    const { csvFile } = await import('../src/modules/export/index.js');
    const body = new TextDecoder().decode(csvFile([{ orderId: randomUUID(), eventId: EVENT, buyerName: '=cmd|calc', buyerPhone: '+821012345678', seatLabel: '@A1', quantity: 1 }], 't').body);
    expect(body).toContain(`"'=cmd|calc"`);
    expect(body).toContain(`"'+821012345678"`);
    expect(body).toContain(`"'@A1"`);
  });

  test('이름·휴대폰 가림은 두 글자 이름도 처리한다', () => {
    expect(maskName('김민수')).toBe('김*수');
    expect(maskName('이서')).toBe('이*');
    expect(maskPhone('01012345678')).toBe('010-****-5678');
  });
});
