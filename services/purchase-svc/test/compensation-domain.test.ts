// 보상 세 걸음의 순수 규칙 시험(BUILD_ORDER BAT-011, PRF-173, P-T39 ③).
// 정본: docs/adr/0354-prf-173-split-compensation-fence.md 결정 3·4, docs/features/payment.md §3 '승인 뒤 발권',
// specs/payment.qnt `compStart`·`compFence`·`compCancel`, docs/data.md `order_compensation`(0032_order_compensation.sql).
// - 보상 중은 주문 상태가 아니라 order_compensation의 STARTED·FENCED다. 주문은 결제 취소가 끝난 뒤 T20으로 한 번만 COMPENSATED가 된다
// - cancellation_id는 `compensation:{orderId}`의 UUIDv8로 고정한다(다시 돌아도 payment-svc가 같은 취소로 본다)
// - payment_id는 ADR-0354 결정 4대로 결제 취소 어댑터가 마지막 ACCEPTED 결제를 payment-svc `GetPayment`로 찾는다(도메인 도우미가 아니다)
// 기대 UUID는 시험 안에서 정본 식(SHA-256 앞 16바이트 + 버전 8·변형 비트)으로 직접 계산한다(ticket-issue-domain.test.ts와 같은 방식).
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  COMPENSATION_MAX_ATTEMPTS,
  COMPENSATION_STATUSES,
  compensationCancellationId,
  compensationRetryDelayMs,
} from '../src/modules/booking/index.js';

const ORDER = '0190f3a1-7c2e-7a00-8000-000000000301';
const OTHER_ORDER = '0190f3a1-7c2e-7a00-8000-000000000302';
const UUID8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** SHA-256(입력)의 앞 16바이트에 UUID 버전 8·변형 비트를 맞춘 글(정본 식을 시험 안에서 직접 계산한다) */
function uuid8Of(input: string): string {
  const b = Buffer.from(createHash('sha256').update(input).digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

describe('보상 세 걸음의 순수 규칙 [PRF-173] [P-T39 ③]', () => {
  test('P-T39 ③_compensationCancellationId는_compensation_주문ID의_UUIDv8로_고정된다', () => {
    // ADR-0354 결정 4: `compensation:{orderId}`의 UUIDv8. 같은 주문은 늘 같은 값이라 보상이 다시 돌아도 같은 결제사 취소다
    expect(compensationCancellationId(ORDER)).toBe(uuid8Of(`compensation:${ORDER}`));
    expect(compensationCancellationId(ORDER)).toMatch(UUID8);
    expect(compensationCancellationId(ORDER)).toBe(compensationCancellationId(ORDER));
    expect(compensationCancellationId(ORDER)).not.toBe(compensationCancellationId(OTHER_ORDER));
  });

  test('P-T39 ③_보상_상태는_STARTED_FENCED_COMPENSATED_FAILED_넷이고_보상_중은_주문_상태가_아니다', () => {
    // ADR-0354 결정 3: 보상 중은 order_compensation의 STARTED·FENCED다. 공개 Order.status에 COMPENSATING을 더하지 않는다.
    // 주문은 결제 취소가 끝난 뒤 T20으로 한 번만 COMPENSATED가 된다
    expect([...COMPENSATION_STATUSES]).toEqual(['STARTED', 'FENCED', 'COMPENSATED', 'FAILED']);
    expect(COMPENSATION_STATUSES).not.toContain('COMPENSATING');
  });

  test('P-T39 ③_다시_보내기_간격은_시도가_늘수록_길어지고_상한이_있다', () => {
    // docs/features/payment.md §3 '승인 뒤 발권'의 재시도 규칙과 같은 꼴이다: 결과 모름·일시 실패는 같은 취소 ID로 다시 보낸다.
    // 값은 [가정]이므로 정본에 적힌 상한과 단조 증가만 본다
    let previous = 0;
    for (let attempts = 1; attempts <= 10; attempts += 1) {
      const ms = compensationRetryDelayMs(attempts);
      expect(Number.isSafeInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(60_000);
      expect(ms).toBeGreaterThanOrEqual(previous);
      previous = ms;
    }
    expect(compensationRetryDelayMs(COMPENSATION_MAX_ATTEMPTS)).toBe(compensationRetryDelayMs(COMPENSATION_MAX_ATTEMPTS + 100));
  });

  test('P-T39 ③_RV-05_payment_id는_도메인_도우미가_아니라_payment-svc_GetPayment가_찾는다', async () => {
    // ADR-0354 결정 4(수정): purchase payment_attempt에는 APPROVED가 없다. 마지막 ACCEPTED 결제 시도를 거쳐
    // payment-svc `GetPayment`가 결제 원장 ID를 찾고, 그 값을 `CancelPayment.payment_id`로 쓴다.
    // 그래서 도메인에 '마지막 APPROVED를 고르는' 도우미를 두지 않는다(생산에서 쓰지 않는 죽은 코드)
    const domain = await import('../src/modules/booking/domain/compensation.js');
    expect('compensationPaymentIdOf' in domain).toBe(false);
  });
});
