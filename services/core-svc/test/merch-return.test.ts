// 굿즈 반품 요청 단위 시험(P-T62 ④, ADR-0315, POL-016 §1.4, planning/03 §2.13 I7~I10).
// 정본: 단순 변심은 받은 날 + 7일, 이상·다름은 받은 날 + 3개월(달력) 안이다. 받은 날 기록이 없으면 기한 안으로 받는다.
// DELIVERY는 SHIPPED(수취 거부)·DELIVERED, PICKUP은 PICKED_UP, WALLET은 READY·LOCKED이고 입장 시작 뒤에는 이상·다름만 받는다.
// 에스크로는 구매 확정 전에 주문 전체 항목만 받는다. 판매자 전이(I11~I15)는 함수 경계만 본다(HTTP는 BAT-610 잔여).
import { describe, expect, test } from 'vitest';
import {
  defectReturnDueAtMs,
  resolveReturnItems,
  returnDueAtMs,
  sellerReturnTransition,
  type ShopOrderDetail,
  type ShopOrderItem,
  ShopProblem,
} from '../src/modules/shop/index.js';

const MIN = 60_000;
const DAY = 86_400_000;
const T = Date.parse('2026-11-20T03:00:00.000Z');
const KST = (iso: string) => Date.parse(`${iso}+09:00`);

/** 반품 판정에 필요한 항목만 채운다(기본은 배송 완료) */
function item(o: Partial<ShopOrderItem> = {}): ShopOrderItem {
  return {
    itemId: 'item-1',
    orderId: 'o',
    promoterId: 'seller',
    eventId: null,
    productId: 'p',
    productName: '상품',
    quantity: 1,
    unitAmount: 12_300,
    commissionRateBp: 0,
    status: 'DELIVERED',
    fulfillment: 'DELIVERY',
    ticketLinked: false,
    limited: false,
    optionSnapshot: { options: {}, name: '상품', type: 'MERCH', schemaVersion: 1 },
    linkedTicketId: null,
    cancelReason: null,
    refundedAmount: 0,
    pickedUpAt: null,
    eventEndsAt: null,
    ...o,
  };
}

function detail(items: ShopOrderItem[], o: { pgStore?: 'STANDARD' | 'ESCROW'; purchaseConfirmedAt?: Date | null } = {}): Pick<ShopOrderDetail, 'order' | 'items'> {
  return {
    order: {
      orderId: 'o',
      accountId: 'a',
      status: 'PAID',
      pgStore: o.pgStore ?? 'STANDARD',
      purchaseConfirmedAt: o.purchaseConfirmedAt ?? null,
      amount: items.reduce((s, i) => s + i.quantity * i.unitAmount, 0),
    },
    items,
  } as unknown as Pick<ShopOrderDetail, 'order' | 'items'>;
}

const typeOfThrow = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof ShopProblem ? e.type : String(e);
  }
};

describe('반품 기한·사유 판정(P-T62 ④)', () => {
  test('P-T62 ④ 단순 변심은 배송 완료 + 7일 − 1ms·정각에 받고 + 1ms에는 merch-return-not-allowed다', () => {
    const it = item({ deliveredAt: new Date(T) });
    const d = detail([it]);
    expect(returnDueAtMs(it)).toBe(T + 7 * DAY);
    expect(typeOfThrow(() => resolveReturnItems(d, ['item-1'], 'CHANGE_OF_MIND', undefined, T + 7 * DAY - 1))).toBeUndefined();
    expect(typeOfThrow(() => resolveReturnItems(d, ['item-1'], 'CHANGE_OF_MIND', undefined, T + 7 * DAY))).toBeUndefined();
    expect(typeOfThrow(() => resolveReturnItems(d, ['item-1'], 'CHANGE_OF_MIND', undefined, T + 7 * DAY + 1))).toBe('merch-return-not-allowed');
  });

  test('P-T62 ④ 이상·다름은 받은 날 + 3개월(달력) 정각까지 받고 + 1ms에는 거절한다(월말은 그 달 마지막 날로 자른다)', () => {
    // 달력 개월 계산은 KST 날짜만 보고 그날 00:00을 기한으로 둔다. 시각이 잘리지 않도록 KST 00:00에 받은 것으로 둔다
    const deliveredAt = KST('2026-08-31T00:00:00');
    const due = KST('2026-11-30T00:00:00');
    const it = item({ deliveredAt: new Date(deliveredAt) });
    const d = detail([it]);
    expect(defectReturnDueAtMs(it)).toBe(due);
    // 같은 날 + 3개월이면 단순 변심 기한은 이미 지났다
    expect(typeOfThrow(() => resolveReturnItems(d, ['item-1'], 'CHANGE_OF_MIND', undefined, due))).toBe('merch-return-not-allowed');
    expect(typeOfThrow(() => resolveReturnItems(d, ['item-1'], 'DEFECT_OR_MISMATCH', undefined, due - 1))).toBeUndefined();
    expect(typeOfThrow(() => resolveReturnItems(d, ['item-1'], 'DEFECT_OR_MISMATCH', undefined, due))).toBeUndefined();
    expect(typeOfThrow(() => resolveReturnItems(d, ['item-1'], 'DEFECT_OR_MISMATCH', undefined, due + 1))).toBe('merch-return-not-allowed');
  });

  test('P-T62 ④ 받은 날 기록이 없으면 요청을 받고, PICKUP은 수령 기록을 기준으로 하며 SHIPPED는 수취 거부로 받는다', () => {
    const unknown = item({ status: 'DELIVERED', deliveredAt: null });
    expect(returnDueAtMs(unknown)).toBe(null);
    expect(typeOfThrow(() => resolveReturnItems(detail([unknown]), ['item-1'], 'CHANGE_OF_MIND', undefined, T + 30 * DAY))).toBeUndefined();

    const picked = item({ fulfillment: 'PICKUP', status: 'PICKED_UP', deliveredAt: null, pickedUpAt: new Date(T) });
    expect(returnDueAtMs(picked)).toBe(T + 7 * DAY);
    expect(typeOfThrow(() => resolveReturnItems(detail([picked]), ['item-1'], 'CHANGE_OF_MIND', undefined, T + 7 * DAY))).toBeUndefined();
    expect(typeOfThrow(() => resolveReturnItems(detail([picked]), ['item-1'], 'CHANGE_OF_MIND', undefined, T + 7 * DAY + 1))).toBe('merch-return-not-allowed');

    const shipped = item({ status: 'SHIPPED', deliveredAt: null });
    expect(typeOfThrow(() => resolveReturnItems(detail([shipped]), ['item-1'], 'CHANGE_OF_MIND', undefined, T))).toBeUndefined();
    expect(typeOfThrow(() => resolveReturnItems(detail([shipped]), ['item-1'], 'DEFECT_OR_MISMATCH', undefined, T))).toBeUndefined();
  });

  test('P-T62 ④ READY는 거절하고, WALLET은 입장 시작 전 READY·LOCKED를 받되 시작 뒤에는 이상·다름만 받는다', () => {
    const ready = item({ status: 'READY', deliveredAt: null });
    expect(typeOfThrow(() => resolveReturnItems(detail([ready]), ['item-1'], 'DEFECT_OR_MISMATCH', undefined, T))).toBe('merch-return-not-allowed');

    const walletReady = item({ fulfillment: 'WALLET', status: 'READY', deliveredAt: null });
    expect(typeOfThrow(() => resolveReturnItems(detail([walletReady]), ['item-1'], 'CHANGE_OF_MIND', undefined, T))).toBeUndefined();
    // 입장 시작 정각부터는 단순 변심을 받지 않는다
    expect(typeOfThrow(() => resolveReturnItems(detail([walletReady]), ['item-1'], 'CHANGE_OF_MIND', T, T))).toBe('merch-return-not-allowed');
    expect(typeOfThrow(() => resolveReturnItems(detail([walletReady]), ['item-1'], 'DEFECT_OR_MISMATCH', T, T))).toBeUndefined();

    const walletLocked = item({ fulfillment: 'WALLET', status: 'LOCKED', deliveredAt: null });
    expect(typeOfThrow(() => resolveReturnItems(detail([walletLocked]), ['item-1'], 'CHANGE_OF_MIND', T, T))).toBe('merch-return-not-allowed');
    expect(typeOfThrow(() => resolveReturnItems(detail([walletLocked]), ['item-1'], 'DEFECT_OR_MISMATCH', T, T))).toBeUndefined();
  });

  test('P-T62 ④ 에스크로 구매 확정 전에는 주문 전체만 반품하고 부분은 escrow-partial-not-allowed이며, 확정 뒤에는 부분도 받는다', () => {
    const a = item({ itemId: 'a', deliveredAt: new Date(T) });
    const b = item({ itemId: 'b', deliveredAt: new Date(T) });
    expect(typeOfThrow(() => resolveReturnItems(detail([a, b], { pgStore: 'ESCROW' }), ['a'], 'CHANGE_OF_MIND', undefined, T))).toBe('escrow-partial-not-allowed');
    expect(resolveReturnItems(detail([a, b], { pgStore: 'ESCROW' }), ['a', 'b'], 'CHANGE_OF_MIND', undefined, T).map((i) => i.itemId)).toEqual(['a', 'b']);
    expect(typeOfThrow(() => resolveReturnItems(detail([a, b], { pgStore: 'ESCROW', purchaseConfirmedAt: new Date(T) }), ['a'], 'CHANGE_OF_MIND', undefined, T))).toBeUndefined();
    expect(typeOfThrow(() => resolveReturnItems(detail([a, b], { pgStore: 'STANDARD' }), ['a'], 'CHANGE_OF_MIND', undefined, T))).toBeUndefined();
  });

  test('P-T62 ④ 목록 모양: 0개·21개·중복은 400 invalid-body이고 그 주문의 항목이 아니면 404 not-found다', () => {
    const it = item({ deliveredAt: new Date(T) });
    const d = detail([it]);
    expect(typeOfThrow(() => resolveReturnItems(d, [], 'CHANGE_OF_MIND', undefined, T))).toBe('invalid-body');
    expect(typeOfThrow(() => resolveReturnItems(d, Array.from({ length: 21 }, (_, i) => `x${i}`), 'CHANGE_OF_MIND', undefined, T))).toBe('invalid-body');
    expect(typeOfThrow(() => resolveReturnItems(d, ['item-1', 'item-1'], 'CHANGE_OF_MIND', undefined, T))).toBe('invalid-body');
    expect(typeOfThrow(() => resolveReturnItems(d, ['other'], 'CHANGE_OF_MIND', undefined, T))).toBe('not-found');
  });
});

describe('판매자 반품 전이 함수 경계(P-T62 ④, I11~I15, HTTP 없음)', () => {
  test('P-T62 ④ RETURN_REQUESTED는 도착 확인(RECEIVE)으로만 RETURN_RECEIVED가 되고 바로 REFUNDED로 가지 않는다', () => {
    expect(sellerReturnTransition('RETURN_REQUESTED', 'RECEIVE')).toBe('RETURN_RECEIVED');
    expect(sellerReturnTransition('RETURN_REQUESTED', 'REFUND')).toBeUndefined();
    expect(sellerReturnTransition('RETURN_REQUESTED', 'REJECT')).toBeUndefined();
    expect(sellerReturnTransition('RETURN_REQUESTED', 'CS_ACCEPT')).toBeUndefined();
    expect(sellerReturnTransition('RETURN_REQUESTED', 'CS_DENY')).toBeUndefined();
  });

  test('P-T62 ④ RETURN_RECEIVED는 환급(REFUND)과 거절(DISPUTED)로 갈리고 도착 확인을 다시 받지 않는다', () => {
    expect(sellerReturnTransition('RETURN_RECEIVED', 'REFUND')).toBe('REFUNDED');
    expect(sellerReturnTransition('RETURN_RECEIVED', 'REJECT')).toBe('DISPUTED');
    expect(sellerReturnTransition('RETURN_RECEIVED', 'RECEIVE')).toBeUndefined();
    expect(sellerReturnTransition('RETURN_RECEIVED', 'CS_ACCEPT')).toBeUndefined();
  });

  test('P-T62 ④ DISPUTED의 환급은 CS 인정(CS_ACCEPT)만 받고 CS 거절은 DELIVERED이며 그 밖의 전이는 없다', () => {
    expect(sellerReturnTransition('DISPUTED', 'CS_ACCEPT')).toBe('REFUNDED');
    expect(sellerReturnTransition('DISPUTED', 'CS_DENY')).toBe('DELIVERED');
    expect(sellerReturnTransition('DISPUTED', 'REFUND')).toBeUndefined();
    expect(sellerReturnTransition('DISPUTED', 'RECEIVE')).toBeUndefined();
    expect(sellerReturnTransition('READY', 'RECEIVE')).toBeUndefined();
    expect(sellerReturnTransition('CANCELLED', 'CS_ACCEPT')).toBeUndefined();
    expect(sellerReturnTransition('REFUNDED', 'CS_ACCEPT')).toBeUndefined();
  });
});
