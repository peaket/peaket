// FR-024 상품 빌더의 표시 가격·재고·저장 본문 검사(SCR-023). node --test가 .ts를 그대로 읽는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_PRODUCT_FORM,
  buildProductBody,
  detailToForm,
  kstText,
  priceView,
  stockText,
} from './product-live.ts';

test('FR-024 상품 표시 가격: 택배만이면 배송비 포함 총액이다', () => {
  assert.deepEqual(priceView({ price: 45000, shippingFee: 3000, fulfillments: ['DELIVERY'] }), {
    main: '배송비 포함 ₩48,000',
    sub: '상품 ₩45,000 + 배송비 ₩3,000',
  });
});

test('FR-024 상품 표시 가격: 현장 수령도 되면 상품가와 배송비 별도다', () => {
  assert.deepEqual(priceView({ price: 45000, shippingFee: 3000, fulfillments: ['DELIVERY', 'PICKUP'] }), {
    main: '₩45,000',
    sub: '택배 배송비 ₩3,000 별도(현장 수령 무료)',
  });
});

test('FR-024 상품 표시 가격: 택배가 없으면 배송비가 있어도 상품가만 보인다', () => {
  assert.deepEqual(priceView({ price: 20000, shippingFee: 3000, fulfillments: ['PICKUP'] }), { main: '₩20,000' });
});

test('FR-024 재고 표시: 한정 없음과 남은/전체를 가른다', () => {
  assert.equal(stockText({ stockRemaining: null, stockTotal: null }), '한정 없음');
  assert.equal(stockText({ stockRemaining: 120, stockTotal: 680 }), '120 / 680');
  assert.equal(stockText({ stockRemaining: 0, stockTotal: 600 }), '0 / 600');
});

test('FR-024 저장 본문: 필수 칸이 맞으면 계약 모양으로 만든다', () => {
  const { body, errors } = buildProductBody({
    ...EMPTY_PRODUCT_FORM,
    type: 'MERCH',
    name: 'LUMEN 공식 응원봉',
    price: '45,000',
    shippingFee: '3,000',
    returnShippingFee: '3,000',
    returnAddress: '서울특별시 마포구',
    limitedQty: '120',
    fulfillments: ['DELIVERY', 'PICKUP'],
    description: '공식 응원봉입니다',
    options: '색상: 인디고, 화이트',
  });
  assert.deepEqual(errors, {});
  assert.deepEqual(body, {
    type: 'MERCH',
    name: 'LUMEN 공식 응원봉',
    price: 45000,
    shippingFee: 3000,
    returnShippingFee: 3000,
    returnAddress: '서울특별시 마포구',
    ticketLinked: false,
    linkedEventId: null,
    limitedQty: 120,
    fulfillments: ['DELIVERY', 'PICKUP'],
    transferable: false,
    status: 'PUBLISHED',
    attributes: { description: '공식 응원봉입니다', options: '색상: 인디고, 화이트' },
  });
});

test('FR-024 저장 본문: 빈 이름·숫자 아닌 가격·택배인데 배송비 없음을 막는다', () => {
  const { body, errors } = buildProductBody({ ...EMPTY_PRODUCT_FORM, name: ' ', price: '사만원', shippingFee: '' });
  assert.equal(body, null);
  assert.equal(errors.name, '상품명을 적어 주세요');
  assert.equal(errors.price, '가격을 숫자로 적어 주세요');
  assert.equal(errors.shippingFee, '택배 배송비를 숫자로 적어 주세요');
});

test('FR-024 저장 본문: 상품명은 100자까지이고 배송이면 반품 주소가 필요하다', () => {
  const longName = buildProductBody({ ...EMPTY_PRODUCT_FORM, name: '가'.repeat(101), price: '1000' });
  assert.equal(longName.errors.name, '상품명은 100자까지입니다');
  const noAddress = buildProductBody({
    ...EMPTY_PRODUCT_FORM,
    name: '상품',
    price: '1000',
    shippingFee: '3000',
    returnShippingFee: '3000',
    returnAddress: ' ',
    fulfillments: ['DELIVERY'],
  });
  assert.equal(noAddress.errors.returnAddress, '반품 받을 주소를 적어 주세요');
});

test('FR-024 저장 본문: 티켓 연동 부가 상품은 연결 공연·회차가 필요하다', () => {
  const { body, errors } = buildProductBody({ ...EMPTY_PRODUCT_FORM, type: 'VIP', name: 'VIP 패키지', price: '88000', ticketLinked: true, fulfillments: ['PICKUP'] });
  assert.equal(body, null);
  assert.equal(errors.linkedProductionId, '연결 공연을 골라 주세요');
  assert.equal(errors.linkedEventId, '연결 회차를 골라 주세요');
});

test('FR-024 고치기: 상세 값을 입력 칸으로 되돌린다', () => {
  const v = detailToForm({
    productId: 'p1',
    name: 'LUMEN 투어 티셔츠',
    type: 'MERCH',
    ticketLinked: false,
    status: 'ON_SALE',
    price: 39000,
    shippingFee: 3000,
    fulfillments: ['DELIVERY', 'PICKUP'],
    stockRemaining: 220,
    stockTotal: 800,
    saleStartsAt: null,
    saleEndsAt: null,
    linkedProductionId: null,
    linkedProductionTitle: null,
    version: 3,
    linkedEventId: null,
    returnShippingFee: 3000,
    returnAddress: '서울',
    limitedQty: 800,
    transferable: false,
    attributes: { options: 'L, M' },
  });
  assert.equal(v.price, '39000');
  assert.equal(v.limitedQty, '800');
  assert.equal(v.options, 'L, M');
  assert.equal(v.status, 'PUBLISHED');
});

test('FR-024 고치기: 초안·숨김 상품은 그 상태로 남는다', () => {
  const base = {
    productId: 'p1',
    name: '초안 상품',
    type: 'MERCH',
    ticketLinked: false,
    status: 'DRAFT',
    price: 1000,
    shippingFee: null,
    fulfillments: ['PICKUP'],
    stockRemaining: null,
    stockTotal: null,
    saleStartsAt: null,
    saleEndsAt: null,
    linkedProductionId: null,
    linkedProductionTitle: null,
    version: 1,
    linkedEventId: null,
    returnShippingFee: null,
    returnAddress: null,
    limitedQty: null,
    transferable: false,
    attributes: {},
  };
  assert.equal(detailToForm(base).status, 'DRAFT');
  assert.equal(detailToForm({ ...base, status: 'HIDDEN' }).status, 'HIDDEN');
  const withAttributes = detailToForm({ ...base, attributes: { perks: ['사인회'], description: '설명', options: 'L' } });
  assert.deepEqual(buildProductBody(withAttributes).body.attributes, { perks: ['사인회'], description: '설명', options: 'L' });
});

test('FR-024 시각 표시: KST로 바꾸고 값이 없으면 —다', () => {
  assert.equal(kstText(null), '—');
  assert.match(kstText('2026-10-25T09:00:00.000Z'), /10\/25\(일\) 18:00/);
});
