// J-T18 상품 정산서 화면의 금액·상태·이의 기한과, payment-svc 정산 모듈이 없을 때의 안내(SCR-023 §4.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canDispute, periodText, settlementBlocked, statementTitle, statusBadge, statusText, won } from './settlement-live.ts';

const statement = (over = {}) => ({
  statementId: 's1',
  kind: 'PRODUCT',
  pgStore: 'ESCROW',
  periodStart: '2026-10-05',
  periodEnd: '2026-10-11',
  grossAmount: 3120000,
  refundAmount: 0,
  commissionAmount: 312000,
  commissionVat: 31200,
  offsetAmount: 0,
  payoutAmount: 2776800,
  status: 'NOTIFIED',
  disputeDueAt: '2026-10-14T14:59:59.000Z',
  payoutDate: '2026-10-16',
  ...over,
});

test('J-T18 상품 정산서 금액은 원 단위로 쉼표를 찍는다', () => {
  assert.equal(won(2776800), '₩2,776,800');
  assert.equal(won(null), '—');
});

test('J-T18 결제 상점과 기간을 화면 말로 바꾼다', () => {
  assert.equal(statementTitle(statement()), '토스페이먼츠 에스크로');
  assert.equal(statementTitle(statement({ pgStore: 'STANDARD' })), '토스페이먼츠 일반');
  assert.equal(periodText(statement()), '2026-10-05 ~ 2026-10-11');
});

test('J-T18 지급 보류는 사유를 함께 보인다', () => {
  assert.equal(statusText(statement({ status: 'HELD', holdReason: 'KYC' })), '지급 보류 · KYC 확인 필요');
  assert.equal(statusBadge(statement({ status: 'HELD' })), 'badge badge-warning');
});

test('J-T18 이의는 통지 뒤 2영업일 안에만 낼 수 있다', () => {
  assert.equal(canDispute(statement(), new Date('2026-10-14T00:00:00.000Z')), true);
  assert.equal(canDispute(statement(), new Date('2026-10-15T00:00:00.000Z')), false);
  assert.equal(canDispute(statement({ status: 'CONFIRMED', disputeDueAt: '2099-01-01T00:00:00.000Z' })), false);
  assert.equal(canDispute(statement({ status: 'DISPUTED', disputeDueAt: '2099-01-01T00:00:00.000Z' })), false);
  assert.equal(canDispute(statement({ disputeDueAt: undefined })), false);
});

test('J-T18 payment-svc 정산 모듈이 없으면 404/501/503을 준비 중으로 안내한다', () => {
  assert.deepEqual(settlementBlocked({ status: 404, type: 'not-found' }), {
    blocked: true,
    title: '상품 정산서를 아직 받을 수 없습니다',
    detail: 'payment-svc 정산 모듈과 정산서 표, 결제사 지급대행 연결이 아직 없습니다. 상품 빌더·배송·웹훅은 그대로 쓸 수 있습니다.',
  });
  assert.equal(settlementBlocked({ status: 500 }).blocked, false);
});
