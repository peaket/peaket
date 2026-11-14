// shop 상품 상태·검증 단위 시험(BUILD_ORDER BAT-610 서버 잔여, FR-024).
import { describe, expect, test } from 'vitest';
import { ProductProblem, productEtag, statusOf, validateInput, validatePatch } from '../src/modules/shop/domain/product.js';
import { MemoryProductStore } from '../src/modules/shop/index.js';
import type { ProductRecord } from '../src/modules/shop/index.js';

const now = new Date('2026-11-14T00:00:00.000Z');
const base = {
  status: 'PUBLISHED' as const,
  limitedQty: null as number | null,
  stock: null as number | null,
  saleStartsAt: null as Date | null,
  saleEndsAt: null as Date | null,
};

describe('shop 상품 상태', () => {
  test('저장 상태 DRAFT·HIDDEN이 먼저다', () => {
    expect(statusOf({ ...base, status: 'DRAFT' }, now)).toBe('DRAFT');
    expect(statusOf({ ...base, status: 'HIDDEN' }, now)).toBe('HIDDEN');
  });

  test('한정 재고가 0이면 품절이다', () => {
    expect(statusOf({ ...base, limitedQty: 10, stock: 0 }, now)).toBe('SOLD_OUT');
    expect(statusOf({ ...base, limitedQty: 10, stock: 1 }, now)).toBe('ON_SALE');
  });

  test('판매 기간 전후를 가른다', () => {
    expect(statusOf({ ...base, saleStartsAt: new Date('2026-12-01T00:00:00Z') }, now)).toBe('NOT_STARTED');
    expect(statusOf({ ...base, saleEndsAt: new Date('2026-11-01T00:00:00Z') }, now)).toBe('ENDED');
  });

  test('ETag는 판을 큰따옴표로 감싼다', () => {
    expect(productEtag(3)).toBe('"3"');
  });
});

describe('shop 상품 입력 검증', () => {
  const input = {
    type: 'MERCH',
    name: '응원봉',
    price: 45000,
    shippingFee: 3000,
    returnShippingFee: 3000,
    returnAddress: '서울',
    ticketLinked: false,
    linkedEventId: null,
    limitedQty: 10,
    fulfillments: ['DELIVERY', 'PICKUP'] as ('DELIVERY' | 'PICKUP')[],
    status: 'PUBLISHED' as const,
  };

  test('택배 상품은 배송비·반품 배송비·반품 주소가 필요하다', () => {
    expect(() => validateInput(input)).not.toThrow();
    expect(() => validateInput({ ...input, shippingFee: null })).toThrow(ProductProblem);
    expect(() => validateInput({ ...input, returnShippingFee: null })).toThrow(ProductProblem);
    expect(() => validateInput({ ...input, returnAddress: null })).toThrow(ProductProblem);
  });

  test('티켓 연동 여부와 연결 회차가 맞아야 한다', () => {
    expect(() => validateInput({ ...input, ticketLinked: true, linkedEventId: null })).toThrow(ProductProblem);
    expect(() => validateInput({ ...input, ticketLinked: false, linkedEventId: '11111111-1111-4111-8111-111111111111' })).toThrow(ProductProblem);
    expect(() => validateInput({ ...input, ticketLinked: true, linkedEventId: '11111111-1111-4111-8111-111111111111', fulfillments: ['PICKUP'] })).not.toThrow();
  });

  test('수령 방식은 하나 이상이고 겹치지 않는다', () => {
    expect(() => validateInput({ ...input, fulfillments: [] })).toThrow(ProductProblem);
    expect(() => validateInput({ ...input, fulfillments: ['PICKUP', 'PICKUP'] })).toThrow(ProductProblem);
  });

  test('고치기 검증도 같은 규칙을 본다', () => {
    expect(() => validatePatch({ ticketLinked: false, linkedEventId: null, fulfillments: ['PICKUP'], shippingFee: null, returnShippingFee: null, returnAddress: null, limitedQty: null })).not.toThrow();
    expect(() => validatePatch({ ticketLinked: true, linkedEventId: null, fulfillments: ['PICKUP'], shippingFee: null, returnShippingFee: null, returnAddress: null, limitedQty: null })).toThrow(ProductProblem);
  });
});

describe('shop 메모리 저장소', () => {
  test('판이 다르면 conflict이고, 맞으면 판을 올린다', async () => {
    const store = new MemoryProductStore();
    const record: ProductRecord = {
      productId: '11111111-1111-4111-8111-111111111111',
      promoterId: '22222222-2222-4222-8222-222222222222',
      type: 'MERCH',
      name: '응원봉',
      status: 'DRAFT',
      price: 1000,
      shippingFee: null,
      returnShippingFee: null,
      returnAddress: null,
      limitedQty: null,
      stock: null,
      transferable: false,
      ticketLinked: false,
      linkedEventId: null,
      fulfillments: ['PICKUP'],
      saleStartsAt: null,
      saleEndsAt: null,
      commissionRateBp: null,
      attributes: {},
      version: 1,
      publishedAt: null,
      updatedAt: now,
    };
    await store.insert(record);
    expect(await store.save(record.promoterId, { ...record, name: '바꿈' }, 9)).toBe('conflict');
    expect(await store.save(record.promoterId, { ...record, name: '바꿈' }, 1)).toMatchObject({ name: '바꿈', version: 2 });
  });
});
