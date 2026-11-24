// SCR-055 실제 API 연결 표시 규칙 시험(F-07-2, openapi GET /v1/orders·GET /v1/shop/orders, docs/frontend.md §5.29).
// 정본이 "티켓과 굿즈를 한 커서로 묶지 않는다 [가정]"이라 했으므로 화면이 두 목록을 createdAt으로 섞는 규칙을 여기서 고정한다.
// 상세 경로와 굿즈 취소·반품 화면 연결은 다음 몫이다(계획 §10).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';

register('../../../shared/lib/test-ts-resolve.mjs', import.meta.url);
const { partialFailureNotice, ticketRow, goodsRow, liveRows } = await import('./live.ts');

const ticket = (over = {}) => ({
  orderId: 'ord-t-1',
  bookingNumber: '2026101400123',
  eventId: 'evt-1',
  eventTitle: 'LUMEN 콘서트 2026 서울',
  eventStartsAt: '2026-10-25T09:00:00.000Z',
  tiers: [{ tierName: 'R석', quantity: 2 }],
  amount: 132000,
  status: 'CONFIRMED',
  issueDelayed: false,
  failureReason: null,
  refundPending: false,
  createdAt: '2026-10-14T03:00:00.000Z',
  ...over,
});
const goods = (over = {}) => ({
  orderId: 'ord-g-1',
  orderNumber: 'M0192F0AA1234',
  fulfillment: 'DELIVERY',
  status: 'PAID',
  paymentStore: 'STANDARD',
  escrow: false,
  totalAmount: 39000,
  items: [{ itemId: 'itm-1', productId: 'prd-1', name: '응원봉', quantity: 1, status: 'READY' }],
  createdAt: '2026-10-15T03:00:00.000Z',
  ...over,
});

test('WEB-ORD ① 두 목록을 createdAt 내림차순으로 섞는다', () => {
  const rows = liveRows({ ticket: [ticket(), ticket({ orderId: 'ord-t-2', createdAt: '2026-10-16T03:00:00.000Z' })], goods: [goods()] });
  assert.deepEqual(
    rows.map((r) => [r.id, r.kind]),
    [
      ['ord-t-2', 'ticket'],
      ['ord-g-1', 'goods'],
      ['ord-t-1', 'ticket'],
    ],
  );
  assert.equal(rows[2].number, '2026101400123');
  assert.equal(rows[0].title, 'LUMEN 콘서트 2026 서울');
  assert.equal(rows[1].title, '응원봉 1개');
});

test('WEB-ORD ② 상태 배지는 d5 §5.29의 글자를 쓴다(발권 지연·환급 보류·입금 오류·결제대금예치)', () => {
  assert.deepEqual(ticketRow(ticket({ status: 'APPROVED', issueDelayed: true })).badges[0], { text: '결제 완료 · 티켓 발급 중', tone: 'success' });
  assert.ok(ticketRow(ticket({ refundPending: true })).badges.some((b) => b.text === '환급 보류' && b.tone === 'warning'));
  assert.ok(ticketRow(ticket({ status: 'FAILED', failureReason: 'DEPOSIT_OVERDUE' })).badges.some((b) => b.text === '입금 오류'));
  assert.ok(goodsRow(goods({ escrow: true })).badges.some((b) => b.text === '결제대금예치'));
  assert.equal(ticketRow(ticket({ status: 'EXPIRED' })).badges[0].text, '주문 취소됨');
  assert.equal(goodsRow(goods({ status: 'FAILED' })).badges[0].text, '결제 취소');
});

test('WEB-ORD ③ 한쪽 API만 실패하면 다른 쪽은 그대로 그리고 부분 실패를 알린다', () => {
  assert.equal(partialFailureNotice(true, true), null);
  assert.equal(partialFailureNotice(true, false), '굿즈 주문을 불러오지 못했습니다. 예매 주문만 보입니다.');
  assert.equal(partialFailureNotice(false, true), '예매 주문을 불러오지 못했습니다. 굿즈 주문만 보입니다.');
  assert.match(partialFailureNotice(false, false), /주문 내역을 불러오지 못했습니다/);
});
