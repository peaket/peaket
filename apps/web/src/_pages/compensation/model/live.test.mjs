// SCR-043 화면 모델(F-07-15 I-04). API 배상 응답을 화면 값으로 옮기고 모르는 칸은 버린다.
// 기준 트리에는 model/live.mjs가 없어 실패한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compensationViewOf, compensationReasonText } from './live.ts';
import { COMPENSATION_REAUTH_EXPIRED, COMPENSATION_REAUTH_NOT_SENT } from './copy.ts';

const raw = (over = {}) => ({
  compensationId: '0194b000-0000-7000-8000-000000000101',
  orderId: '0194b000-0000-7000-8000-000000000201',
  amount: 15_400,
  status: 'ACCOUNT_PENDING',
  accountLast4: null,
  eventId: '0194b000-0000-7000-8000-000000000301',
  reason: 'ORGANIZER',
  createdAt: '2026-11-27T03:00:00.000Z',
  ...over,
});

test('SCR043_모델 계좌 대기·요청됨·완료·실패를 가른다', () => {
  assert.equal(compensationViewOf(raw()).form, true);
  assert.equal(compensationViewOf(raw({ status: 'REQUESTED', accountLast4: '1234' })).requested, true);
  assert.equal(compensationViewOf(raw({ status: 'PAID', accountLast4: '1234' })).paid, true);
  assert.equal(compensationViewOf(raw({ status: 'FAILED' })).failed, true);
});

test('SCR043_모델 사유 문구와 금액·끝 4자리만 남긴다', () => {
  assert.equal(compensationReasonText('ORGANIZER'), '주최 측 사정으로 공연이 취소되었습니다');
  assert.equal(compensationReasonText('CONTENT_CHANGE'), '공연 내용이 변경되었습니다');
  const v = compensationViewOf(raw({ reason: 'CONTENT_CHANGE', amount: 4_750, accountLast4: '0000' }));
  assert.equal(v.reasonText, '공연 내용이 변경되었습니다');
  assert.equal(v.amount, 4_750);
  assert.equal(v.accountLast4, '0000');
  assert.equal(JSON.stringify(v).includes('123-456'), false);
});

test('SCR043_모델 모양이 틀리거나 배상금이 아니면 null이다', () => {
  assert.equal(compensationViewOf(null), null);
  assert.equal(compensationViewOf({}), null);
  assert.equal(compensationViewOf(raw({ amount: -1 })), null);
  assert.equal(compensationViewOf(raw({ status: 'UNKNOWN' })), null);
  assert.equal(compensationViewOf(raw({ reason: 'FORCE_MAJEURE' })), null);
});

test('SCR043_문구 재인증 만료·아직 보내지 않음을 d5 그대로 쓴다', () => {
  assert.equal(COMPENSATION_REAUTH_EXPIRED, '다시 로그인한 확인이 만료되었거나 이미 쓰였습니다. 다시 로그인해 주세요');
  assert.equal(COMPENSATION_REAUTH_NOT_SENT, '송금 요청은 아직 보내지 않았습니다. 다시 로그인하면 이어서 보낼 수 있습니다');
});
