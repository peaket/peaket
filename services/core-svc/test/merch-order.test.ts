// 굿즈 주문 도메인 공개 함수 단위 시험(ADR-0300 결정 3~5, P-T56 ⑦, P-T42 ②).
// 단언 값은 정본에서: 계정당 한도 = 이 주문 수량 + PAID·결제 접수한 주문 수량 ≤ perAccountLimit(결정 4), 금액 = 가격 × 수량 + 택배 배송비 한 번(결정 4),
// 결제 접수 뒤 예약 시각 = 지금 값과 인증 시각 + 10분 가운데 늦은 쪽(결정 5), 결제 시도 3회(결정 5), 승인 명령 다시 보내기 1초부터 두 배씩 30초까지(결정 5),
// 재고 키 수명 = 판매 종료 + 1일, 판매 종료가 없으면 30일(결정 3). 코드 상수는 가져오지 않고 숫자를 적는다.
import { describe, expect, test } from 'vitest';
import {
  attemptStartBlocker,
  checkPerAccountLimit,
  confirmRetryDelayMs,
  orderAmount,
  type OrderableProduct,
  reservedUntilAfterAccept,
  type ShopOrderDetail,
  ShopProblem,
  stockKeyTtlSeconds,
} from '../src/modules/shop/index.js';

const MIN = 60_000;
const DAY = 86_400_000;
const T = Date.parse('2026-11-20T03:00:00.000Z');

function product(id: string, o: Partial<OrderableProduct> = {}): OrderableProduct {
  return {
    productId: id,
    promoterId: 'seller',
    type: 'MERCH',
    name: id,
    status: 'PUBLISHED',
    price: 12_300,
    shippingFee: 3_000,
    returnShippingFee: 3_000,
    returnAddress: null,
    limitedQty: null,
    stock: null,
    transferable: false,
    ticketLinked: false,
    linkedEventId: null,
    fulfillments: ['DELIVERY', 'PICKUP'],
    saleStartsAt: null,
    saleEndsAt: null,
    commissionRateBp: 1000,
    attributes: {},
    schemaVersion: 1,
    version: 1,
    publishedAt: null,
    updatedAt: new Date(T),
    ...o,
  };
}

const typeOfThrow = (fn: () => void): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof ShopProblem ? e.type : String(e);
  }
};

describe('계정당 한도(P-T56 ⑦)', () => {
  const limited = new Map([['p', product('p', { attributes: { perAccountLimit: 2 } })]]);

  test('P-T56 ⑦ 한도 2: 기존 0 + 2는 통과, 기존 0 + 3은 merch-quantity-limit-exceeded다', () => {
    expect(typeOfThrow(() => checkPerAccountLimit([{ productId: 'p', quantity: 2 }], limited, new Map()))).toBeUndefined();
    expect(typeOfThrow(() => checkPerAccountLimit([{ productId: 'p', quantity: 3 }], limited, new Map()))).toBe('merch-quantity-limit-exceeded');
  });

  test('P-T56 ⑦ 한도 2: 기존 1 + 1은 통과(한도와 같음), 기존 1 + 2·기존 2 + 1은 거절한다', () => {
    expect(typeOfThrow(() => checkPerAccountLimit([{ productId: 'p', quantity: 1 }], limited, new Map([['p', 1]])))).toBeUndefined();
    expect(typeOfThrow(() => checkPerAccountLimit([{ productId: 'p', quantity: 2 }], limited, new Map([['p', 1]])))).toBe('merch-quantity-limit-exceeded');
    expect(typeOfThrow(() => checkPerAccountLimit([{ productId: 'p', quantity: 1 }], limited, new Map([['p', 2]])))).toBe('merch-quantity-limit-exceeded');
  });

  test('P-T56 ⑦ 한도가 없는(null) 상품은 수량을 보지 않고, 한도는 상품마다 따로 센다', () => {
    const products = new Map([
      ['free', product('free')],
      ['p', product('p', { attributes: { perAccountLimit: 2 } })],
    ]);
    expect(typeOfThrow(() => checkPerAccountLimit([{ productId: 'free', quantity: 99 }], products, new Map([['free', 50]])))).toBeUndefined();
    expect(typeOfThrow(() => checkPerAccountLimit([{ productId: 'p', quantity: 2 }], products, new Map([['free', 50]])))).toBeUndefined();
  });
});

describe('주문 금액(ADR-0300 결정 4)', () => {
  const products = new Map([
    ['a', product('a', { price: 12_300, shippingFee: 3_000 })],
    ['b', product('b', { price: 4_100, shippingFee: 3_000 })],
  ]);
  test('P-T56 ⑦ 택배는 가격 × 수량 합에 배송비를 한 번만 더하고 현장 수령·월렛은 배송비가 없다', () => {
    const lines = [
      { productId: 'a', quantity: 2 },
      { productId: 'b', quantity: 3 },
    ];
    expect(orderAmount('DELIVERY', lines, products)).toEqual({ amount: 12_300 * 2 + 4_100 * 3 + 3_000, shippingFee: 3_000 });
    expect(orderAmount('PICKUP', lines, products)).toEqual({ amount: 12_300 * 2 + 4_100 * 3, shippingFee: 0 });
    expect(orderAmount('WALLET', [{ productId: 'a', quantity: 1 }], products)).toEqual({ amount: 12_300, shippingFee: 0 });
  });
});

describe('결제 접수 뒤 예약 시각(P-T42 ②)', () => {
  test('P-T42 ② 주문 뒤 10분에 접수하면 인증 + 10분(주문 + 20분)이 주문 + 15분보다 늦어 그쪽이다', () => {
    const current = new Date(T + 15 * MIN);
    expect(reservedUntilAfterAccept(current, T + 10 * MIN).getTime()).toBe(T + 20 * MIN);
  });
  test('P-T42 ② 주문 뒤 2분에 접수하면 주문 + 15분 그대로다(인증 + 10분 = 주문 + 12분이 더 이르다)', () => {
    const current = new Date(T + 15 * MIN);
    expect(reservedUntilAfterAccept(current, T + 2 * MIN).getTime()).toBe(T + 15 * MIN);
  });
  test('P-T42 ② 경계: 인증 + 10분이 지금 값과 같으면 그 값이다', () => {
    expect(reservedUntilAfterAccept(new Date(T + 15 * MIN), T + 5 * MIN).getTime()).toBe(T + 15 * MIN);
    expect(reservedUntilAfterAccept(new Date(T + 15 * MIN), T + 5 * MIN + 1).getTime()).toBe(T + 15 * MIN + 1);
  });
});

describe('결제 시도 시작 조건(ADR-0300 결정 5)', () => {
  const detail = (o: { status?: ShopOrderDetail['order']['status']; until?: number; attempts?: number; active?: 'READY' | 'ACCEPTED' }): Pick<ShopOrderDetail, 'order' | 'activeAttempt' | 'attemptCount'> =>
    ({
      order: { status: o.status ?? 'CREATED', stockReservedUntil: new Date(o.until ?? T + 15 * MIN) },
      activeAttempt: o.active ? { status: o.active } : undefined,
      attemptCount: o.attempts ?? 0,
    }) as unknown as Pick<ShopOrderDetail, 'order' | 'activeAttempt' | 'attemptCount'>;
  const type = (d: ReturnType<typeof detail>, now = T) => attemptStartBlocker(d, now)?.type;

  test('P-T56 ⑦ 시도 2회까지는 시작하고 3회째 뒤는 payment-attempts-exceeded다', () => {
    expect(type(detail({ attempts: 2 }))).toBeUndefined();
    expect(type(detail({ attempts: 3 }))).toBe('payment-attempts-exceeded');
  });
  test('P-T42 ① 예약 기한 − 1ms에는 시작하고 기한(= 지금)에는 order-expired다', () => {
    expect(type(detail({ until: T + 1 }))).toBeUndefined();
    expect(type(detail({ until: T }))).toBe('order-expired');
  });
  test('P-T56 ⑦ 결제를 접수했거나 PAID면 payment-already-accepted, EXPIRED·FAILED면 order-expired다', () => {
    expect(type(detail({ active: 'ACCEPTED' }))).toBe('payment-already-accepted');
    expect(type(detail({ status: 'PAID' }))).toBe('payment-already-accepted');
    expect(type(detail({ status: 'EXPIRED' }))).toBe('order-expired');
    expect(type(detail({ status: 'FAILED' }))).toBe('order-expired');
  });
});

describe('승인 명령 다시 보내기 간격과 재고 키 수명', () => {
  test('P-T42 ② 승인 명령 다시 보내기는 1초부터 두 배씩 30초까지다', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 12].map(confirmRetryDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });
  test('P-T56 ③ 재고 키 수명은 판매 종료 + 1일이고 판매 종료가 없으면 30일이다', () => {
    expect(stockKeyTtlSeconds(new Date(T + 2 * DAY), T)).toBe((3 * DAY) / 1000);
    expect(stockKeyTtlSeconds(new Date(T + 7 * DAY + 500), T)).toBe(Math.ceil((8 * DAY + 500) / 1000));
    expect(stockKeyTtlSeconds(null, T)).toBe((30 * DAY) / 1000);
  });
});
