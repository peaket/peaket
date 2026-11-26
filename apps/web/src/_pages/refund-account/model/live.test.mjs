// SCR-060 화면 모델(F-07-15 I-05). 취소 상세를 화면 값으로 옮긴다.
// 기준 트리에는 model/live.ts가 없어 각 시험이 실행 중 import에서 실패한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const loadModel = async () => {
  // @ts-ignore 구현 전에는 모듈이 없다. 구현이 만들면 같은 import가 통한다
  return await import('./live.ts');
};
const loadCopy = async () => {
  // @ts-ignore 구현 전에는 모듈이 없다
  return await import('./copy.ts');
};

const raw = (over = {}) => ({
  cancellationId: '0194b000-0000-7000-8000-000000000101',
  orderId: '0194b000-0000-7000-8000-000000000201',
  eventId: '0194b000-0000-7000-8000-000000000301',
  refundAmount: 6_600,
  deductionAmount: 59_400,
  deductionBp: 9000,
  reason: 'USER',
  status: 'REFUND_PENDING',
  refundAccountRequired: true,
  createdAt: '2026-11-27T03:00:00.000Z',
  ...over,
});

test('SCR060_모델 계좌 대기와 완료를 가른다', async () => {
  const m = await loadModel();
  const v = m.cancellationViewOf(raw());
  assert.equal(v?.form, true);
  assert.equal(v?.done, false);
  assert.equal(v?.refundAmount, 6_600);
  assert.equal(v?.deductionAmount, 59_400);
  assert.equal(v?.deductionPercent, 90);
  assert.equal(m.cancellationViewOf(raw({ status: 'REFUNDED', refundAccountRequired: false }))?.done, true);
});

test('SCR060_모델 계좌가 필요 없는 대기와 모양 틀린 값을 버린다', async () => {
  const m = await loadModel();
  assert.equal(m.cancellationViewOf(raw({ refundAccountRequired: false }))?.form, false);
  assert.equal(m.cancellationViewOf(null), null);
  assert.equal(m.cancellationViewOf(raw({ refundAmount: -1 })), null);
  assert.equal(m.cancellationViewOf(raw({ status: 'UNKNOWN' })), null);
  assert.equal(m.cancellationViewOf(raw({ deductionBp: 10001 })), null);
});

test('SCR060_모델 금액은 정수이고 계좌 원문 칸이 없다', async () => {
  const m = await loadModel();
  const v = m.cancellationViewOf(raw());
  assert.equal(Number.isInteger(v.refundAmount), true);
  assert.equal(Object.keys(v).some((k) => k === 'accountNumber' || k === 'holderName'), false);
});

test('SCR060_문구 재인증 만료·아직 보내지 않음을 d5 그대로 쓴다', async () => {
  const c = await loadCopy();
  assert.equal(c.REFUND_REAUTH_EXPIRED, '다시 로그인한 확인이 만료되었거나 이미 쓰였습니다. 다시 로그인해 주세요');
  assert.equal(c.REFUND_REAUTH_NOT_SENT, '환급 요청은 아직 보내지 않았습니다. 다시 로그인하면 이어서 보낼 수 있습니다.');
});
