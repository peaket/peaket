// F-06-5 SCR-066 팬 조회 화면 값 해석 시험(시험 담당 lane2-freeze-F-06-5-opencode).
// 정본: openapi OpsFan*, d5 §7.14, authz-matrix §4.1·§4.3. 구현 전에는 model/lookup.ts가 없어 각 시험이 그 자리에서 실패한다.
// 서버가 가린 값만 준다. 이 해석은 모르는 칸(원문 이름·전화·이메일)을 버리고, 화면은 글자 노드로만 그린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function mod() {
  try {
    return await import('./lookup.ts');
  } catch (err) {
    throw new Error(`SCR-066 model/lookup.ts가 없다(계획 §3): ${err instanceof Error ? err.message : String(err)}`);
  }
}

const SUMMARY = { accountId: 'acc-1', memberCode: 'PK-000123', nickname: '피켓팬', status: 'ACTIVE', mergedIntoAccountId: null, name: '김피켓', phone: '010-9876-5432' };
const DETAIL = {
  accountId: 'acc-1', memberCode: 'PK-000123', nickname: '피켓팬', status: 'ACTIVE',
  nameMasked: '김*', phoneMasked: '010-****-5432', emailMasked: 'fa***@example.com',
  identityVerifiedAt: '2026-10-01T03:00:00.000Z', loginProviders: ['KAKAO', 'GOOGLE'],
  mergeHistory: [{ absorbedAccountId: 'acc-0', mergedAt: '2026-10-02T03:00:00.000Z' }],
  bookingRestriction: { reasonCode: 'ABUSE_CANCEL', startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2027-11-01T00:00:00.000Z', appealDueAt: '2026-11-02T00:00:00.000Z' },
  selfRequestCaseIds: ['case-1'], name: '김피켓', phone: '010-9876-5432', email: 'fan@example.com',
};
const ORDER = { orderId: 'o-1', orderNo: '2026101400123', reservationNo: '2026101400123', kind: 'TICKET', eventId: 'e-1', title: 'LUMEN 콘서트', status: 'CONFIRMED', amount: 95000, orderedAt: '2026-10-14T11:00:00.000Z', buyerNameMasked: '김*', buyerPhoneMasked: '010-****-5432', buyerName: '김피켓' };
const TICKET = { ticketId: 't-1', orderId: 'o-1', eventId: 'e-1', title: 'LUMEN 콘서트', seatLabel: 'R석 2열 5번', status: 'ISSUED', transferLocked: false, holderIsPayer: true, qrPayload: 'PEAKET1:secret' };
const TRANSFER = { offerId: 'tr-1', ticketId: 't-1', direction: 'SENT', counterpartNicknameMasked: '받*', status: 'ACCEPTED', createdAt: '2026-10-20T05:00:00.000Z', closedAt: null, counterpartNickname: '받는팬' };
const QUEUE = { eventId: 'e-1', title: 'LUMEN 콘서트', status: 'ENTERED', enteredAt: '2026-10-25T09:00:00.000Z', endedAt: null, rank: 7, riskScore: 91 };

test('팬 요약은 가린 값만 옮기고 원문 칸(이름·전화)은 버린다', async () => {
  const m = await mod();
  const v = m.fanSummaryOf(SUMMARY);
  assert.deepEqual(v, { accountId: 'acc-1', memberCode: 'PK-000123', nickname: '피켓팬', status: 'ACTIVE', mergedIntoAccountId: null });
  for (const k of ['name', 'phone']) assert.equal(k in v, false, k);
  assert.equal(m.fanSummaryOf({ ...SUMMARY, accountId: '' }), null);
});

test('팬 상세는 가린 이름·전화·이메일과 본인확인·로그인 수단·병합 이력·예매 제한만 남긴다', async () => {
  const m = await mod();
  const v = m.fanDetailOf(DETAIL);
  assert.equal(v.nameMasked, '김*');
  assert.equal(v.phoneMasked, '010-****-5432');
  assert.equal(v.emailMasked, 'fa***@example.com');
  assert.deepEqual(v.loginProviders, ['KAKAO', 'GOOGLE']);
  assert.equal(v.mergeHistory.length, 1);
  assert.equal(v.bookingRestriction.reasonCode, 'ABUSE_CANCEL');
  assert.deepEqual(v.selfRequestCaseIds, ['case-1']);
  for (const k of ['name', 'phone', 'email']) assert.equal(k in v, false, k);
  assert.equal(m.fanDetailOf({ ...DETAIL, accountId: '' }), null);
});

test('주문 한 페이지는 가린 예매자 이름·전화만 남기고 쪽 정보를 보존한다', async () => {
  const m = await mod();
  const p = m.orderPageOf({ items: [ORDER], nextCursor: 'next-1' });
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].buyerNameMasked, '김*');
  assert.equal(p.items[0].buyerPhoneMasked, '010-****-5432');
  assert.equal(p.items[0].buyerName, undefined);
  assert.equal(p.nextCursor, 'next-1');
  assert.deepEqual(m.orderPageOf({ items: [{ ...ORDER, orderId: '' }], nextCursor: null }), { items: [], nextCursor: null });
});

test('티켓 한 페이지는 입장 코드를 버리고 잠금·보유자 관계를 남긴다', async () => {
  const m = await mod();
  const p = m.ticketPageOf({ items: [TICKET], nextCursor: null });
  assert.equal(p.items[0].qrPayload, undefined);
  assert.equal(p.items[0].transferLocked, false);
  assert.equal(p.items[0].holderIsPayer, true);
  assert.ok(!JSON.stringify(p).includes('PEAKET1:secret'));
});

test('양도·대기 한 페이지는 상대 닉네임을 가리고 순번·위험 점수를 버린다', async () => {
  const m = await mod();
  const t = m.transferPageOf({ items: [TRANSFER], nextCursor: null });
  assert.equal(t.items[0].counterpartNickname, undefined);
  assert.equal(t.items[0].counterpartNicknameMasked, '받*');
  const q = m.queuePageOf({ items: [QUEUE], nextCursor: null });
  assert.equal(q.items[0].rank, undefined);
  assert.equal(q.items[0].riskScore, undefined);
  assert.equal(q.items[0].status, 'ENTERED');
});

test('원문 열람 응답은 칸 셋과 사유·시각만 남긴다', async () => {
  const m = await mod();
  const v = m.unmaskingOf({ name: '김피켓', phone: '010-9876-5432', email: null, reason: '분쟁 확인', unmaskedAt: '2026-11-27T03:00:00.000Z', extra: '버림' });
  assert.deepEqual(v, { name: '김피켓', phone: '010-9876-5432', email: null, reason: '분쟁 확인', unmaskedAt: '2026-11-27T03:00:00.000Z' });
  assert.equal(m.unmaskingOf({ reason: '사유만 있음' }), null);
});

test('찾는 값은 정확히 하나만 보내고 0개·2개 이상은 거절한다', async () => {
  const m = await mod();
  assert.deepEqual(m.lookupBody({ memberCode: ' PK-000123 ' }).body, { memberCode: 'PK-000123' });
  assert.deepEqual(m.lookupBody({ orderNo: '2026101400123' }).body, { orderNo: '2026101400123' });
  assert.deepEqual(m.lookupBody({ reservationNo: '2026101400123' }).body, { reservationNo: '2026101400123' });
  assert.equal(m.lookupBody({}).ok, false);
  assert.equal(m.lookupBody({ memberCode: 'a', orderNo: 'b' }).ok, false);
  assert.equal(m.lookupBody({ memberCode: '   ' }).ok, false);
});

test('열람 사유는 5~500자이고 fields는 1~3개 중복 없이 고른다', async () => {
  const m = await mod();
  assert.equal(m.reasonValid('넉자'), false);
  assert.equal(m.reasonValid('다섯자임'), true);
  assert.equal(m.reasonValid('가'.repeat(500)), true);
  assert.equal(m.reasonValid('가'.repeat(501)), false);
  assert.equal(m.unmaskBodyValid({ fields: ['NAME'], reason: '분쟁 확인' }), true);
  assert.equal(m.unmaskBodyValid({ fields: ['NAME', 'NAME'], reason: '분쟁 확인' }), false);
  assert.equal(m.unmaskBodyValid({ fields: [], reason: '분쟁 확인' }), false);
  assert.equal(m.unmaskBodyValid({ fields: ['NAME', 'PHONE', 'EMAIL', 'NAME'], reason: '분쟁 확인' }), false);
  assert.equal(m.unmaskBodyValid({ fields: ['EMAIL'], reason: '분쟁 확인', orderId: 'o-1' }), false);
});

test('계정 주소는 계정 ID만 encode하고 다른 경로를 붙이지 않는다', async () => {
  const m = await mod();
  assert.equal(m.customerHref('acc-1'), '/customers/acc-1');
  assert.equal(m.customerHref('a/b?c'), '/customers/a%2Fb%3Fc');
});
