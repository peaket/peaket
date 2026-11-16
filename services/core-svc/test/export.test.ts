// 예매자 명단 내려받기 시험(BUILD_ORDER BAT-610 잔여, I-T53·J-T26, FR-027·064).
// W7-audit A2-17·A2-19: 명단 보기 응답의 nextCursor는 원천 값 그대로이고, 보기마다 로그인 주체가 LIST 접속기록에 남으며,
// 내려받기 접속기록을 남기지 못하면 파일을 주지 않는다(docs/features/settlement.md §9, J-T26 ④⑤⑥).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryActorNames, MemoryAttendeeExportStore, MemoryPartnerEventLookup } from '../src/modules/export/index.js';
import { attendeeSourceUnavailable, ExportProblem } from '../src/modules/export/domain/export.js';
import { MemoryMerchOrderStore, maskName, maskPhone, settlementBasisDate, type MerchOrderItemRecord, type MerchOrderRecord } from '../src/modules/shop/index.js';
import type { AttendeeExportRecord } from '../src/modules/export/domain/export.js';
import type { AttendeeSource, BookersReauth } from '../src/modules/export/domain/ports.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';

const TENANT = randomUUID();
const OTHER = randomUUID();
const EVENT = randomUUID();
const IDENTITY = new FakeIdentity();
const merch = new MemoryMerchOrderStore();
/** failExport를 켜면 내려받기 기록(recordExport)이 던진다. 접속지(둘째 인자)는 받은 그대로 넘긴다(시험 이의 R2: 버리면 메모리 저장소가 접속지를 남길 수 없다) */
class FailableExportStore extends MemoryAttendeeExportStore {
  failExport = false;
  override async recordExport(record: AttendeeExportRecord, access: { clientIp: string }): Promise<void> {
    if (this.failExport) throw new Error('audit-down');
    return super.recordExport(record, access);
  }
}
const exportsStore = new FailableExportStore();
/** 명단 원천: 기본은 굿즈 주문 메모리 저장소, 시험이 override로 잠시 바꾼다 */
const source: AttendeeSource & { override?: AttendeeSource } = {
  list: (p, e, l, c) => (source.override ? source.override.list(p, e, l, c) : merch.listAttendees(p, e, l, c)),
  count: (p, e) => (source.override ? source.override.count(p, e) : merch.countAttendees(p, e)),
};
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
      export: { store: exportsStore, source, events, reauth, actors },
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

  test('A2-17 J-T26 ④ 명단 보기 응답의 nextCursor는 원천 값 그대로다 — GET …/attendees', async () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ orderId: randomUUID(), eventId: EVENT, buyerName: '김민수', buyerPhone: '010-1234-5678', seatLabel: `C-${i}`, quantity: 1 }));
    const pages = [
      { items: rows(49), nextCursor: 'opaque-c' as string | null },
      { items: rows(50), nextCursor: null },
    ];
    const cursors: (string | undefined)[] = [];
    source.override = {
      list: async (_p, _e, _l, c) => {
        cursors.push(c);
        return pages[cursors.length - 1]!;
      },
      count: async () => ({ bookings: 99, tickets: 99 }),
    };
    try {
      const short = await svc.http.inject({ method: 'GET', url: `/v1/partner/events/${EVENT}/attendees?limit=50`, headers: headers() });
      expect(short.statusCode).toBe(200);
      expect(JSON.parse(short.payload)).toMatchObject({ nextCursor: 'opaque-c' });
      expect(JSON.parse(short.payload).items).toHaveLength(49);
      // 경계 반대쪽: 정확히 limit건인 마지막 페이지에서 원천이 null을 주면 null이다
      const last = await svc.http.inject({ method: 'GET', url: `/v1/partner/events/${EVENT}/attendees?limit=50&cursor=opaque-c`, headers: headers() });
      expect(last.statusCode).toBe(200);
      expect(JSON.parse(last.payload).nextCursor).toBeNull();
      expect(JSON.parse(last.payload).items).toHaveLength(50);
      expect(cursors).toEqual([undefined, 'opaque-c']);
    } finally {
      delete source.override;
    }
  });

  test('A2-19 J-T26 ⑤ GET …/attendees는 로그인 주체를 접속기록 행위자로 쓴다', async () => {
    const before = exportsStore.views.length;
    const first: Record<string, string> = headers();
    const second: Record<string, string> = headers();
    expect(first['x-user-id']).not.toBe(second['x-user-id']);
    for (const h of [first, second]) {
      const r = await svc.http.inject({ method: 'GET', url: `/v1/partner/events/${EVENT}/attendees?limit=50`, headers: h });
      expect(r.statusCode).toBe(200);
    }
    const added = exportsStore.views.slice(before);
    expect(added.map((v) => v.actorAccountId)).toEqual([first['x-user-id'], second['x-user-id']]);
    for (const v of added) {
      expect(v).toMatchObject({ promoterId: TENANT, eventId: EVENT, actorRole: 'partner_admin', actorDisplayName: '스텔라 관리자', count: 2 });
      expect(v.actorAccountId).not.toBe(TENANT);
      expect(v.filter).toStrictEqual({ limit: 50 });
    }
    // 실무자는 403이고 접속기록이 늘지 않는다
    const member = await svc.http.inject({ method: 'GET', url: `/v1/partner/events/${EVENT}/attendees?limit=50`, headers: headers(TENANT, undefined, 'partner_member') });
    expect(member.statusCode).toBe(403);
    expect(exportsStore.views.length).toBe(before + 2);
  });

  test('A2-19 J-T26 ⑥ 접속기록 저장이 실패하면 내려받기 성공으로 답하지 않는다 — POST …/attendee-exports', async () => {
    exportsStore.failExport = true;
    try {
      const r = await svc.http.inject({ method: 'POST', url: `/v1/partner/events/${EVENT}/attendee-exports`, headers: headers(), payload: JSON.stringify({ reason: '감사 실패', format: 'CSV' }) });
      expect(r.statusCode).toBeGreaterThanOrEqual(500);
      expect(r.headers['content-disposition']).toBeUndefined();
      expect(r.rawPayload.toString('utf8')).not.toContain('010-1234-5678');
    } finally {
      exportsStore.failExport = false;
    }
  });

  test('A2-19 R2 J-T26 ⑤ 명단 보기 접속기록에 요청의 접속지를 남긴다 — GET …/attendees', async () => {
    const before = exportsStore.views.length;
    // 입구가 다시 쓴 x-forwarded-for가 IP 모양이면 그것, 없거나 IP 모양이 아니면 연결 주소(주입 요청은 127.0.0.1)
    const cases: [Record<string, string>, string][] = [
      [{ 'x-forwarded-for': '203.0.113.7' }, '203.0.113.7'],
      [{}, '127.0.0.1'],
      [{ 'x-forwarded-for': 'not-an-ip' }, '127.0.0.1'],
      [{ 'x-forwarded-for': '2001:db8::1' }, '2001:db8::1'],
    ];
    for (const [extra] of cases) {
      const r = await svc.http.inject({ method: 'GET', url: `/v1/partner/events/${EVENT}/attendees?limit=50`, headers: { ...headers(), ...extra } });
      expect(r.statusCode, JSON.stringify(extra)).toBe(200);
      // 응답에는 접속지를 싣지 않는다
      expect(r.payload).not.toContain('203.0.113.7');
    }
    expect(exportsStore.views.slice(before).map((v) => v.clientIp)).toEqual(cases.map(([, ip]) => ip));
  });

  test('A2-19 R2 J-T26 ⑥ 내려받기 접속기록에도 접속지를 남기고 이력 응답에는 싣지 않는다 — POST·GET …/attendee-exports', async () => {
    const h = { ...headers(), 'x-forwarded-for': '203.0.113.7' };
    const r = await svc.http.inject({ method: 'POST', url: `/v1/partner/events/${EVENT}/attendee-exports`, headers: h, payload: JSON.stringify({ reason: '접속지 확인', format: 'CSV' }) });
    expect(r.statusCode).toBe(200);
    expect(exportsStore.audits.at(-1)).toMatchObject({ reason: '접속지 확인', clientIp: '203.0.113.7' });
    expect(Object.keys(exportsStore.rows.at(-1)!)).not.toContain('clientIp');
    const history = await svc.http.inject({ method: 'GET', url: `/v1/partner/events/${EVENT}/attendee-exports`, headers: h });
    expect(history.statusCode).toBe(200);
    expect(JSON.parse(history.payload).items.some((i: { reason: string }) => i.reason === '접속지 확인')).toBe(true);
    expect(history.payload).not.toContain('203.0.113.7');
  });

  test('A2-17 C1 J-T26 ④ 같은 커서를 되풀이하면 503 dependency-unavailable의 목록 제목·detail·Retry-After 30을 싣는다 — POST …/attendee-exports', async () => {
    const rows = Array.from({ length: 1_000 }, (_, i) => ({ orderId: `c1-order-${String(i).padStart(4, '0')}`, eventId: EVENT, buyerName: '김민수', buyerPhone: '010-1234-5678', seatLabel: `R-${i}`, quantity: 1 }));
    const before = { rows: exportsStore.rows.length, audits: exportsStore.audits.length };
    source.override = { list: async () => ({ items: rows, nextCursor: 'same-cursor' }), count: async () => ({ bookings: 1_000, tickets: 1_000 }) };
    try {
      const r = await svc.http.inject({ method: 'POST', url: `/v1/partner/events/${EVENT}/attendee-exports`, headers: headers(), payload: JSON.stringify({ reason: '되풀이 커서', format: 'CSV' }) });
      expect(r.statusCode).toBe(503);
      expect(r.headers['retry-after']).toBe('30');
      expect(r.headers['content-disposition']).toBeUndefined();
      expect(JSON.parse(r.payload)).toMatchObject({
        type: 'https://peaket.example/problems/dependency-unavailable',
        title: '의존 서비스를 잠시 쓸 수 없습니다',
        detail: '예매자 명단 원천이 같은 페이지를 되풀이했습니다',
      });
      expect({ rows: exportsStore.rows.length, audits: exportsStore.audits.length }).toEqual(before);
    } finally {
      delete source.override;
    }
  });

  test('A2-17 C1 GET …/attendees는 원천을 쓸 수 없으면 503과 Retry-After 30이고 접속기록이 없다', async () => {
    const before = exportsStore.views.length;
    source.override = {
      list: async () => {
        throw attendeeSourceUnavailable('예매자 명단 원천을 쓸 수 없습니다');
      },
      count: async () => ({ bookings: 0, tickets: 0 }),
    };
    try {
      const r = await svc.http.inject({ method: 'GET', url: `/v1/partner/events/${EVENT}/attendees?limit=50`, headers: headers() });
      expect(r.statusCode).toBe(503);
      expect(r.headers['retry-after']).toBe('30');
      expect(JSON.parse(r.payload)).toMatchObject({
        type: 'https://peaket.example/problems/dependency-unavailable',
        title: '의존 서비스를 잠시 쓸 수 없습니다',
        detail: '예매자 명단 원천을 쓸 수 없습니다',
      });
      expect(exportsStore.views.length).toBe(before);
    } finally {
      delete source.override;
    }
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
