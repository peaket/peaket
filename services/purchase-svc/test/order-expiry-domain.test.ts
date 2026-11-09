// 결제하지 않은 주문의 만료 규칙(domain/order-expiry.ts의 expiryDecision·상수, ADR-0107 결정 1·2, docs/features/payment.md §2 '결제하지 않은 주문 만료의 첫 구현'·§3 T5·T6,
// docs/data.md §5.1 '주문 만료 안전망', BUILD_ORDER PRF-172, 시험 P-T41). DB·Redis 없는 순수 함수와 값만 본다.
import 'reflect-metadata';
import { describe, expect, test } from 'vitest';
import {
  ATTEMPT_ACCEPT_WINDOW_MS,
  expiryDecision,
  ORDER_EXPIRY_ACTOR,
  ORDER_EXPIRY_ATTEMPT_TTL_MS,
  ORDER_EXPIRY_BATCH,
  ORDER_EXPIRY_CONCURRENCY,
  ORDER_EXPIRY_LOOKBACK_MS,
  ORDER_EXPIRY_STAGES,
  ORDER_EXPIRY_SWEEP_AGE_MS,
  ORDER_EXPIRY_SWEEP_INTERVAL_MS,
  ORDER_EXPIRY_TRIGGERS,
  type OrderExpiryNotYetReason,
  type OrderExpiryView,
} from '../src/modules/booking/index.js';
import { ACTOR_PATTERN, ORDER_STATUSES, type OrderStatus } from '../src/modules/booking/domain/order.js';

const OPEN = ['CREATED', 'AUTHENTICATED'] as const;
const CLOSED = ORDER_STATUSES.filter((s): s is Exclude<OrderStatus, (typeof OPEN)[number]> => s !== 'CREATED' && s !== 'AUTHENTICATED');

const view = (status: OrderStatus, o: Partial<Omit<OrderExpiryView, 'status'>> = {}): OrderExpiryView => ({ status, sessionEnded: true, holdRemains: false, activeAttempt: false, ...o });

/** [세션 끝남, 홀드 남음, 활성 결제 시도, 기대하는 까닭]: 세 조건 조합 가운데 만료가 아닌 일곱 가지. 까닭은 세션 → 홀드 → 결제 시도 차례로 처음 걸린 것이다 */
const NOT_YET_CASES: [boolean, boolean, boolean, OrderExpiryNotYetReason][] = [
  [false, true, true, 'SESSION'],
  [false, true, false, 'SESSION'],
  [false, false, true, 'SESSION'],
  [false, false, false, 'SESSION'],
  [true, true, true, 'HOLD'],
  [true, true, false, 'HOLD'],
  [true, false, true, 'ATTEMPT'],
];

describe('expiryDecision: 열린 주문', () => {
  test.each([
    ['CREATED', 'T5'],
    ['AUTHENTICATED', 'T6'],
  ] as const)('PT41_ADR0107_%s 주문은 세션이 끝나고 홀드가 풀리고 활성 결제 시도가 없으면 %s로 만료한다 [ASVS v5.0.0-2.3.1]', (status, transition) => {
    expect(expiryDecision(view(status))).toEqual({ kind: 'EXPIRE', transition });
  });

  describe.each(OPEN)('%s', (status) => {
    test.each(NOT_YET_CASES)('PT41_ADR0107_세션 끝남 %s·홀드 남음 %s·활성 시도 %s이면 아직이고 까닭은 %s다(세 조건이 모두 끝나야 만료한다) [ASVS v5.0.0-2.3.1]', (sessionEnded, holdRemains, activeAttempt, reason) => {
      expect(expiryDecision(view(status, { sessionEnded, holdRemains, activeAttempt }))).toEqual({ kind: 'NOT_YET', reason });
    });
  });
});

describe('expiryDecision: 열린 주문이 아니면', () => {
  test('PT41_ADR0107_시험 대상 상태 목록에 CREATED·AUTHENTICATED가 빠지고 나머지가 모두 있다', () => {
    expect(CLOSED.length).toBe(ORDER_STATUSES.length - 2);
    expect(CLOSED).toContain('ACCEPTED');
    expect(CLOSED).toContain('EXPIRED');
  });

  test.each(CLOSED)('PT41_ADR0107_%s 주문은 세 조건의 어떤 조합이든 NOT_OPEN이다(결제 접수 뒤로는 만료 대상이 아니다) [ASVS v5.0.0-2.3.1]', (status) => {
    for (const sessionEnded of [true, false]) {
      for (const holdRemains of [true, false]) {
        for (const activeAttempt of [true, false]) {
          expect({ sessionEnded, holdRemains, activeAttempt, d: expiryDecision(view(status, { sessionEnded, holdRemains, activeAttempt })) }).toEqual({
            sessionEnded,
            holdRemains,
            activeAttempt,
            d: { kind: 'NOT_OPEN' },
          });
        }
      }
    }
  });
});

describe('만료 상수', () => {
  test('ADR0107_READY 결제 시도의 유효 시간은 40분 [가정]이고 결제 접수의 판단 값과 같다', () => {
    expect(ORDER_EXPIRY_ATTEMPT_TTL_MS).toBe(40 * 60_000);
    expect(ORDER_EXPIRY_ATTEMPT_TTL_MS).toBe(ATTEMPT_ACCEPT_WINDOW_MS);
  });

  test('ADR0107_안전망은 만든 지 90분 [가정] 지난 주문을 10분 [가정]마다 하루 범위에서 500건씩 읽는다(docs/data.md §5.1)', () => {
    expect(ORDER_EXPIRY_SWEEP_AGE_MS).toBe(90 * 60_000);
    expect(ORDER_EXPIRY_SWEEP_INTERVAL_MS).toBe(10 * 60_000);
    expect(ORDER_EXPIRY_LOOKBACK_MS).toBe(24 * 60 * 60_000);
    expect(ORDER_EXPIRY_BATCH).toBe(500);
  });

  test('ADR0107_고리의 파드마다 동시 처리 수는 4개 [가정]이다(docs/verification.md §4.1)', () => {
    expect(ORDER_EXPIRY_CONCURRENCY).toBe(4);
  });

  test('ADR0107_행위자는 system:order-expiry이고 주문 이력의 행위자 모양에 맞는다', () => {
    expect(ORDER_EXPIRY_ACTOR).toBe('system:order-expiry');
    expect(ACTOR_PATTERN.test(ORDER_EXPIRY_ACTOR)).toBe(true);
  });

  test('ADR0107_지표 이름표 값: trigger는 session·hold·attempt·sweep, stage는 hook·check·attempt·sweep이다(docs/observability.md, BUILD_ORDER PRF-172 설계 5)', () => {
    expect([...ORDER_EXPIRY_TRIGGERS]).toEqual(['session', 'hold', 'attempt', 'sweep']);
    expect([...ORDER_EXPIRY_STAGES]).toEqual(['hook', 'check', 'attempt', 'sweep']);
  });
});
