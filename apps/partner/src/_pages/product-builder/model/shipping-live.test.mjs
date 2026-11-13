// POL-016·FR-024 배송·반품 처리의 상태별 버튼과 송장·거절 입력 검사(SCR-023).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canConfirmReturn, canRegisterInvoice, canRejectReturn, checkExportReason, checkInvoice, checkRejection, recipientText } from './shipping-live.ts';

const ui = readFileSync(new URL('../ui/live/ShippingLive.tsx', import.meta.url), 'utf8');

const item = (over = {}) => ({
  itemId: 'i1',
  orderId: 'o1',
  version: 1,
  status: 'READY',
  fulfillment: 'DELIVERY',
  productId: 'p1',
  productName: 'LUMEN 투어 티셔츠',
  ticketLinked: false,
  optionSummary: 'L',
  quantity: 1,
  orderedAt: '2026-10-14T10:00:00.000Z',
  escrow: true,
  recipient: { nameMasked: '김*수', phoneMasked: '010-****-2841' },
  trackingCarrier: null,
  trackingNo: null,
  deliveredAt: null,
  pickedUpAt: null,
  returnReason: null,
  returnTrackingNo: null,
  returnReceivedAt: null,
  ...over,
});

test('FR-024 송장 등록은 택배 READY·SHIPPED에서만 된다', () => {
  assert.equal(canRegisterInvoice(item()), true);
  assert.equal(canRegisterInvoice(item({ status: 'SHIPPED' })), true);
  assert.equal(canRegisterInvoice(item({ status: 'DELIVERED' })), false);
  assert.equal(canRegisterInvoice(item({ fulfillment: 'PICKUP' })), false);
});

test('POL-016 반품 도착 확인은 부가 상품이 아닌 RETURN_REQUESTED만 된다', () => {
  assert.equal(canConfirmReturn(item({ status: 'RETURN_REQUESTED' })), true);
  assert.equal(canConfirmReturn(item({ status: 'RETURN_REQUESTED', ticketLinked: true })), false);
  assert.equal(canConfirmReturn(item({ status: 'RETURN_RECEIVED' })), false);
});

test('POL-016 반품 거절은 RETURN_REQUESTED·RETURN_RECEIVED에서 된다', () => {
  assert.equal(canRejectReturn(item({ status: 'RETURN_REQUESTED' })), true);
  assert.equal(canRejectReturn(item({ status: 'RETURN_RECEIVED' })), true);
  assert.equal(canRejectReturn(item({ status: 'DELIVERED' })), false);
});

test('POL-037 받는 분은 가린 이름·연락처만 보인다', () => {
  assert.equal(recipientText(item()), '김*수 · 010-****-2841');
  assert.equal(recipientText(item({ recipient: null })), '—');
});

test('FR-024 송장 검사: 택배사 코드와 8~30자 송장 번호', () => {
  assert.deepEqual(checkInvoice('CJ', '601233457781').errors, {});
  assert.equal(checkInvoice('', '601233457781').errors.carrier, '택배사를 골라 주세요');
  assert.equal(checkInvoice('CJ', '1234').errors.trackingNo, '송장 번호는 영문·숫자·-로 8~30자입니다');
});

test('POL-016 반품 거절: 사유·근거가 필요하고 연락처로 보이는 숫자를 막는다', () => {
  assert.equal(checkRejection('DAMAGED_BY_BUYER', '포장을 뜯어 사용한 흔적이 있습니다').ok, true);
  assert.equal(checkRejection('', '').errors.reasonCode, '거절 사유를 골라 주세요');
  assert.equal(checkRejection('DAMAGED_BY_BUYER', '010-1234-5678 로 연락함').errors.evidence, '구매자의 연락처로 보이는 숫자는 적지 마세요');
});

test('FR-064 배송 명단 사유는 1~500자다', () => {
  assert.equal(checkExportReason('  '), '다운로드 사유를 적어 주세요');
  assert.equal(checkExportReason('가'.repeat(501)), '다운로드 사유는 500자까지입니다');
  assert.equal(checkExportReason('10/15 발송분 송장 출력'), null);
});

test('FR-024 송장·반품 쓰기는 목록의 version과 멱등 키를 쓴다', () => {
  assert.match(ui, /putShipment\(selectedInvoice\.itemId, \{ carrier, trackingNo \}, selectedInvoice\.version\)/);
  assert.match(ui, /confirmArrival\(item\.itemId\)/);
  assert.match(ui, /rejectArrival\(rejectItem\.itemId, \{ reasonCode: rejectReason as 'DAMAGED_BY_BUYER' \| 'VALUE_LOST_BY_USE', evidence: rejectEvidence\.trim\(\) \}\)/);
});
