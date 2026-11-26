// F-06-5 ops-svc 팬 조회(SCR-066) 시험(시험 담당 lane2-freeze-F-06-5-opencode).
// 정본: openapi /v1/ops/fan-lookups·/v1/ops/fans*, authz-matrix §4.1·§4.3·AZ-T8, d5 §7.14, docs/features/transfer-refund.md §7.3.
// 원천 넷은 문서화된 포트 계약을 구현한 메모리 대역이다(실제 원천 서비스 연결은 계획 §9 합성 몫). 구현 전에는 경로가 404다.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { csHarness, type CsHarness, type OpsRole } from './cs-support.js';

const ACCOUNT = '0194f065-0000-7000-8000-0000000000c1';
const OTHER = '0194f065-0000-7000-8000-0000000000c2';
const ORDER = '2026101400123';
const RAW = { name: '김피켓', phone: '010-9876-5432', email: 'fan@example.com' };

interface AccessRow {
  id: string;
  adminAccountId: string;
  actorRole: string;
  action: string;
  targetKind: string;
  reason: string;
  fields: string[];
  sourceIp: string;
  occurredAtMs: number;
  retainUntilMs: number;
}

function wiring() {
  const profiles = new Map<string, Record<string, unknown>>([
    [ACCOUNT, {
      accountId: ACCOUNT, memberCode: 'PK-000123', nickname: '피켓팬', status: 'ACTIVE', mergedIntoAccountId: null,
      name: RAW.name, phone: RAW.phone, email: RAW.email,
      identityVerifiedAt: '2026-10-01T03:00:00.000Z', loginProviders: ['KAKAO', 'GOOGLE'],
      mergeHistory: [{ absorbedAccountId: OTHER, mergedAt: '2026-10-02T03:00:00.000Z' }],
      bookingRestriction: { reasonCode: 'ABUSE_CANCEL', startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2027-11-01T00:00:00.000Z', appealDueAt: '2026-11-02T00:00:00.000Z' },
      selfRequestCaseIds: ['0194f065-0000-7000-8000-0000000000d1'],
    }],
    [OTHER, { accountId: OTHER, memberCode: 'PK-000124', nickname: '다른팬', status: 'MERGED', mergedIntoAccountId: ACCOUNT, name: '이병합', phone: '010-1111-2222', email: 'merged@example.com', identityVerifiedAt: null, loginProviders: [], mergeHistory: [], bookingRestriction: null, selfRequestCaseIds: [] }],
  ]);
  const orders: Record<string, unknown>[] = [
    { orderId: randomUUID(), orderNo: ORDER, reservationNo: '2026101400123', kind: 'TICKET', eventId: randomUUID(), title: 'LUMEN 콘서트 2026 서울', status: 'CONFIRMED', amount: 95000, orderedAt: '2026-10-14T11:00:00.000Z', buyerName: RAW.name, buyerPhone: RAW.phone },
    { orderId: randomUUID(), orderNo: 'ord-20261018-0010', reservationNo: null, kind: 'MERCH', eventId: null, title: 'LUMEN 공식 응원봉 외 1건', status: 'PAID', amount: 23000, orderedAt: '2026-10-18T05:00:00.000Z', buyerName: RAW.name, buyerPhone: RAW.phone },
  ];
  const tickets: Record<string, unknown>[] = [
    { ticketId: randomUUID(), orderId: 'order-1', eventId: randomUUID(), title: 'LUMEN 콘서트 2026 서울', seatLabel: 'R석 2열 5번', status: 'ISSUED', transferLocked: false, holderIsPayer: true, qrPayload: 'PEAKET1:secret' },
  ];
  const transfers: Record<string, unknown>[] = [
    { offerId: randomUUID(), ticketId: 'ticket-1', direction: 'SENT', counterpartNickname: '받는팬', status: 'ACCEPTED', createdAt: '2026-10-20T05:00:00.000Z', closedAt: '2026-10-21T05:00:00.000Z' },
  ];
  const queueEntries: Record<string, unknown>[] = [
    { eventId: randomUUID(), title: 'LUMEN 콘서트 2026 서울', status: 'ENTERED', enteredAt: '2026-10-25T09:00:00.000Z', endedAt: '2026-10-25T09:02:00.000Z' },
  ];
  const access: AccessRow[] = [];
  let failNext = false;
  const page = <T>(items: T[], limit: number) => ({ items: items.slice(0, limit), nextCursor: items.length > limit ? 'next' : null });
  return {
    wiring: {
      now: () => Date.parse('2026-11-27T03:00:00.000Z'),
      profile: {
        async get(accountId: string) { return profiles.get(accountId) as never; },
        async resolve(i: { orderNo?: string; reservationNo?: string; memberCode?: string }) {
          if (i.memberCode) return [...profiles.values()].find((p) => p.memberCode === i.memberCode)?.accountId as string | undefined;
          const order = orders.find((o) => (i.orderNo ? o.orderNo === i.orderNo : o.reservationNo === i.reservationNo));
          return order ? ACCOUNT : undefined;
        },
      },
      orders: {
        async list(_accountId: string, p: { limit: number }) { return page(orders, p.limit); },
        async unmask(_accountId: string, orderId: string) {
          const o = orders.find((x) => x.orderNo === orderId || x.orderId === orderId);
          return o ? { name: RAW.name, phone: RAW.phone } : {};
        },
      },
      tickets: { async list(_accountId: string, p: { limit: number }) { return page(tickets, p.limit); } },
      transfers: { async list(_accountId: string, p: { limit: number }) { return page(transfers, p.limit); } },
      queueEntries: { async list(_accountId: string, p: { limit: number }) { return page(queueEntries, p.limit); } },
      access: {
        rows: () => access.map((r) => ({ ...r })),
        async append(r: Omit<AccessRow, 'id'>) {
          if (failNext) { failNext = false; throw new Error('access store down'); }
          access.push({ id: randomUUID(), ...r });
        },
        failNext() { failNext = true; },
      },
    },
    access,
  };
}

let h: CsHarness;
let kit: ReturnType<typeof wiring>;
beforeEach(async () => {
  kit = wiring();
  h = await csHarness({ fanLookup: kit.wiring });
});
afterEach(async () => {
  await h?.close();
});

const problem = (b: Record<string, unknown>): string => String(b.type ?? '').split('/').pop() ?? '';
const post = (role: OpsRole, body: unknown) => h.svc.http.inject({ method: 'POST', url: '/v1/ops/fan-lookups', headers: { ...h.as(role), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const get = (role: OpsRole, path: string) => h.svc.http.inject({ method: 'GET', url: path, headers: h.as(role) });
const unmask = (role: OpsRole, accountId: string, body: unknown) => h.svc.http.inject({ method: 'POST', url: `/v1/ops/fans/${accountId}/unmaskings`, headers: { ...h.as(role), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const json = (p: string): Record<string, unknown> => (p ? (JSON.parse(p) as Record<string, unknown>) : {});

describe('GAT-320 팬 찾기와 요약', () => {
  test('GAT-320 [ASVS v5.0.0-8.1.1][ASVS v5.0.0-8.2.1][ASVS v5.0.0-14.2.6] 회원 코드·주문번호·예매번호 어느 하나로 찾고 응답은 가린 값만 싣는다', async () => {
    for (const body of [{ memberCode: 'PK-000123' }, { orderNo: ORDER }, { reservationNo: '2026101400123' }]) {
      const r = await post('cs_agent', body);
      expect(r.statusCode, JSON.stringify(body)).toBe(200);
      const b = json(r.payload);
      expect(b).toMatchObject({ accountId: ACCOUNT, memberCode: 'PK-000123', nickname: '피켓팬', status: 'ACTIVE' });
      expect(JSON.stringify(b)).not.toContain(RAW.name);
      expect(JSON.stringify(b)).not.toContain(RAW.phone);
      expect(JSON.stringify(b)).not.toContain(RAW.email);
    }
    expect((await post('operator', { memberCode: 'PK-000123' })).statusCode).toBe(200);
    expect((await post('commander', { memberCode: 'PK-000123' })).statusCode).toBe(200);
    expect((await post('cs_lead', { memberCode: 'PK-000123' })).statusCode).toBe(200);
    expect((await post('viewer', { memberCode: 'PK-000123' })).statusCode).toBe(403);
  });

  test('GAT-320 찾는 값이 없거나 둘 이상이면 400, 없으면 404이며 찾는 값은 URL에 싣지 않는다', async () => {
    for (const body of [{}, { memberCode: 'PK-000123', orderNo: ORDER }, { name: '김피켓' }]) {
      const r = await post('cs_agent', body);
      expect([400, 422]).toContain(r.statusCode);
      expect(problem(json(r.payload))).toMatch(/invalid-body/);
    }
    const notFound = await post('cs_agent', { memberCode: 'PK-999999' });
    expect(notFound.statusCode).toBe(404);
    expect(problem(json(notFound.payload))).toBe('not-found');
    const viaQuery = await get('cs_agent', `/v1/ops/fan-lookups?memberCode=PK-000123`);
    expect([404, 405]).toContain(viaQuery.statusCode);
  });

  test('GAT-320 [ASVS v5.0.0-8.1.2][ASVS v5.0.0-14.2.6] 계정 요약은 이름·전화·이메일을 가려 싣고 본인확인·로그인 수단·병합 이력·예매 제한을 보인다', async () => {
    const r = await get('cs_agent', `/v1/ops/fans/${ACCOUNT}`);
    expect(r.statusCode).toBe(200);
    const b = json(r.payload);
    expect(b).toMatchObject({ accountId: ACCOUNT, memberCode: 'PK-000123', status: 'ACTIVE', identityVerifiedAt: '2026-10-01T03:00:00.000Z' });
    expect((b.loginProviders as string[])).toEqual(['KAKAO', 'GOOGLE']);
    expect((b.mergeHistory as unknown[]).length).toBe(1);
    expect(b.bookingRestriction).toMatchObject({ reasonCode: 'ABUSE_CANCEL' });
    expect(String(b.nameMasked)).not.toBe(RAW.name);
    expect(String(b.phoneMasked)).not.toBe(RAW.phone);
    expect(String(b.emailMasked)).not.toBe(RAW.email);
    for (const k of ['name', 'phone', 'email']) expect(k in b).toBe(false);
    expect(String(r.headers['cache-control'])).toContain('no-store');
    expect((await get('cs_agent', `/v1/ops/fans/${randomUUID()}`)).statusCode).toBe(404);
  });

  test('GAT-320 [ASVS v5.0.0-8.1.2] 팬 상세의 selfRequestCaseIds는 비어 있으면 빈 배열이고 viewer는 403이다', async () => {
    const r = await get('cs_agent', `/v1/ops/fans/${OTHER}`);
    expect(r.statusCode).toBe(200);
    expect((json(r.payload).selfRequestCaseIds as string[])).toEqual([]);
    expect((await get('viewer', `/v1/ops/fans/${ACCOUNT}`)).statusCode).toBe(403);
  });
});

describe('GAT-320 가린 값 열람과 접속기록', () => {
  test('GAT-320 [ASVS v5.0.0-14.2.6][ASVS v5.0.0-14.3.2] 사유를 넣어 원문을 열면 접속기록이 먼저 남고 원문 값은 기록에 없다', async () => {
    const r = await unmask('cs_agent', ACCOUNT, { fields: ['NAME', 'PHONE'], reason: '분쟁 접수 #123 확인' });
    expect(r.statusCode, r.payload).toBe(200);
    const b = json(r.payload);
    expect(b).toMatchObject({ name: RAW.name, phone: RAW.phone, reason: '분쟁 접수 #123 확인' });
    expect(b.unmaskedAt).toBe('2026-11-27T03:00:00.000Z');
    expect(String(r.headers['cache-control'])).toContain('no-store');
    expect(kit.access).toHaveLength(1);
    expect(kit.access[0]).toMatchObject({
      adminAccountId: h.as('cs_agent')['x-user-id'], actorRole: 'cs_agent', action: 'VIEW_UNMASKED', targetKind: 'FAN_PROFILE',
      reason: '분쟁 접수 #123 확인', fields: ['NAME', 'PHONE'], occurredAtMs: Date.parse('2026-11-27T03:00:00.000Z'),
    });
    expect(kit.access[0]!.retainUntilMs).toBe(Date.parse('2028-11-27T03:00:00.000Z'));
    expect(JSON.stringify(kit.access)).not.toContain(RAW.name);
    expect(JSON.stringify(kit.access)).not.toContain(RAW.phone);
  });

  test('GAT-320 [ASVS v5.0.0-8.2.3] 사유 5~500자·fields 1~3개·EMAIL+orderId 조합을 검사한다', async () => {
    for (const body of [
      { fields: ['NAME'], reason: '넉자' },
      { fields: ['NAME'], reason: '가'.repeat(501) },
      { fields: [], reason: '사유는 충분히 깁니다' },
      { fields: ['NAME', 'NAME'], reason: '사유는 충분히 깁니다' },
      { fields: ['NAME', 'PHONE', 'EMAIL', 'NAME'], reason: '사유는 충분히 깁니다' },
      { fields: ['EMAIL'], reason: '사유는 충분히 깁니다', orderId: 'ord-20261018-0010' },
    ]) {
      const r = await unmask('cs_agent', ACCOUNT, body);
      expect([400, 422], JSON.stringify(body)).toContain(r.statusCode);
    }
    expect(kit.access).toHaveLength(0);
  });

  test('GAT-320 [ASVS v5.0.0-8.3.1][ASVS v5.0.0-14.2.6] 접속기록을 쓰지 못하면 503이고 원문을 주지 않는다', async () => {
    kit.wiring.access.failNext();
    const r = await unmask('cs_agent', ACCOUNT, { fields: ['NAME', 'PHONE', 'EMAIL'], reason: '기록 실패를 보는 시험입니다' });
    expect(r.statusCode).toBe(503);
    expect(problem(json(r.payload))).toBe('access-log-unavailable');
    expect(JSON.stringify(json(r.payload))).not.toContain(RAW.name);
    expect(kit.access).toHaveLength(0);
  });

  test('GAT-320 [ASVS v5.0.0-2.4.1] 같은 관리 계정이 하루 200회를 넘기면 429다', async () => {
    const me = h.as('cs_agent');
    const call = (i: number) => h.svc.http.inject({ method: 'POST', url: `/v1/ops/fans/${ACCOUNT}/unmaskings`, headers: { ...me, 'content-type': 'application/json' }, payload: JSON.stringify({ fields: ['NAME'], reason: `대량 열람 시험 ${i}번째` }) });
    for (let i = 0; i < 200; i += 1) {
      const r = await call(i);
      expect(r.statusCode, `${i}번째`).toBe(200);
    }
    const r = await call(201);
    expect(r.statusCode).toBe(429);
    expect(problem(json(r.payload))).toBe('fan-lookup-rate-limited');
  });

  test('GAT-320 [ASVS v5.0.0-8.1.2][ASVS v5.0.0-16.3.2] viewer는 원문을 열 수 없고 403 시도가 로그에 남는다', async () => {
    expect((await unmask('viewer', ACCOUNT, { fields: ['NAME'], reason: '권한 없는 열람 시도' })).statusCode).toBe(403);
    expect(kit.access).toHaveLength(0);
    expect(h.logs.lines().some((l) => l.status === 403)).toBe(true);
  });
});

describe('GAT-320 주문·티켓·양도·대기·건 탭', () => {
  test('GAT-320 [ASVS v5.0.0-8.1.1][ASVS v5.0.0-14.2.6] 주문 탭은 예매자 이름·전화를 가려 싣고 operator·commander는 403이다', async () => {
    const r = await get('cs_agent', `/v1/ops/fans/${ACCOUNT}/orders?limit=1`);
    expect(r.statusCode).toBe(200);
    const b = json(r.payload);
    expect((b.items as unknown[]).length).toBe(1);
    expect(b.nextCursor).toBe('next');
    const item = (b.items as Record<string, unknown>[])[0]!;
    expect(item).toMatchObject({ orderNo: ORDER, kind: 'TICKET', status: 'CONFIRMED', amount: 95000 });
    expect(String(item.buyerNameMasked)).not.toContain(RAW.name);
    expect(String(item.buyerPhoneMasked)).not.toContain(RAW.phone);
    for (const k of ['buyerName', 'buyerPhone']) expect(k in item).toBe(false);
    expect((await get('operator', `/v1/ops/fans/${ACCOUNT}/orders`)).statusCode).toBe(403);
    expect((await get('commander', `/v1/ops/fans/${ACCOUNT}/orders`)).statusCode).toBe(403);
    expect((await get('cs_lead', `/v1/ops/fans/${ACCOUNT}/orders`)).statusCode).toBe(200);
    expect((await get('cs_agent', `/v1/ops/fans/${ACCOUNT}/orders?limit=101`)).statusCode).toBe(400);
  });

  test('GAT-320 티켓 탭은 입장 코드를 싣지 않고 잠금·보유자 관계를 보인다', async () => {
    const r = await get('cs_agent', `/v1/ops/fans/${ACCOUNT}/tickets`);
    expect(r.statusCode).toBe(200);
    const item = (json(r.payload).items as Record<string, unknown>[])[0]!;
    expect(item).toMatchObject({ status: 'ISSUED', transferLocked: false, holderIsPayer: true });
    expect(JSON.stringify(item)).not.toContain('PEAKET1:secret');
    expect(item.qrPayload).toBeUndefined();
  });

  test('GAT-320 양도 탭은 상대 닉네임을 가리고 대기 탭은 순번·위험 점수 없이 보인다', async () => {
    const t = await get('cs_agent', `/v1/ops/fans/${ACCOUNT}/transfers`);
    expect(t.statusCode).toBe(200);
    const transfer = (json(t.payload).items as Record<string, unknown>[])[0]!;
    expect(transfer.direction).toBe('SENT');
    expect(String(transfer.counterpartNicknameMasked)).not.toBe('받는팬');
    const q = await get('cs_agent', `/v1/ops/fans/${ACCOUNT}/queue-entries`);
    expect(q.statusCode).toBe(200);
    const entry = (json(q.payload).items as Record<string, unknown>[])[0]!;
    expect(entry).toMatchObject({ status: 'ENTERED' });
    expect(entry.rank).toBeUndefined();
    expect(entry.riskScore).toBeUndefined();
  });

  test('GAT-320 건 탭은 그 계정의 건만 주고 원천이 없으면 503이며 빈 목록으로 속이지 않는다', async () => {
    const caseId = await h.seed('INQUIRY', 'inq-fan-1', { accountId: ACCOUNT });
    await h.seed('INQUIRY', 'inq-other-1', { accountId: OTHER });
    const r = await get('cs_agent', `/v1/ops/fans/${ACCOUNT}/cases`);
    expect(r.statusCode).toBe(200);
    const items = json(r.payload).items as Record<string, unknown>[];
    expect(items.map((x) => x.caseId)).toEqual([caseId]);
    const broken = wiring();
    delete (broken.wiring as { orders?: unknown }).orders;
    await h.close();
    h = await csHarness({ fanLookup: broken.wiring });
    const down = await h.svc.http.inject({ method: 'GET', url: `/v1/ops/fans/${ACCOUNT}/orders`, headers: h.as('cs_agent') });
    expect(down.statusCode).toBe(503);
    expect(problem(json(down.payload))).toBe('fan-lookup-unavailable');
  });
});
