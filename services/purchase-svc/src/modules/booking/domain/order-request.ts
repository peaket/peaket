// 주문 생성 본문의 업무 규칙: 동의(422), 예매자(400), 금액(등급 가격 합)(docs/features/payment.md §2 '주문 생성의 첫 구현', openapi POST /v1/orders, BUILD_ORDER PRF-161).
// 순수 함수라 프레임워크·플랫폼 형을 가져오지 않는다. 쓰임새(application/create-order.ts)가 검사 차례대로 부른다.
import type { OrderItem } from './order.js';
import { toE164 } from './phone.js';
import type { HeldSeat } from './ports.js';

/** 본문 consents(openapi CreateOrderBody.consents. 받는 층이 모양을 이미 봤다) */
export interface OrderConsents {
  readonly provisionToSeller?: boolean;
  readonly salesTerms?: boolean;
  readonly consentVersion?: string;
}

/** 본문 buyer(openapi CreateOrderBody.buyer. 두 칸 모두 선택 칸이라 여기서 있는지 본다) */
export interface OrderBuyerInput {
  readonly name?: string;
  readonly phone?: string;
}

/** 예매자 성명·번호 글 길이 상한 [가정: 100자](payment §2, 주문 저장소 assertNewOrder와 같은 값) */
export const BUYER_TEXT_MAX = 100;

/**
 * 동의 판정(openapi 422 설명):
 * - consents가 없거나, provisionToSeller가 true가 아니거나, salesTerms가 true가 아니거나, consentVersion이 없으면 → 'CONSENT_REQUIRED'
 * - consentVersion이 currentVersion(환경 값 PEAKET_ORDER_CONSENT_VERSION)과 글 그대로 다르면 → 'CONSENT_VERSION_OUTDATED'
 * - 아니면 'OK'
 */
export function consentVerdict(consents: OrderConsents | undefined, currentVersion: string): 'OK' | 'CONSENT_REQUIRED' | 'CONSENT_VERSION_OUTDATED' {
  // 동의가 빠진 것을 판보다 먼저 본다
  if (!consents || consents.provisionToSeller !== true || consents.salesTerms !== true || typeof consents.consentVersion !== 'string') return 'CONSENT_REQUIRED';
  return consents.consentVersion === currentVersion ? 'OK' : 'CONSENT_VERSION_OUTDATED';
}

/** 저장할 예매자 값 */
export interface OrderBuyer {
  /** 받은 성명 그대로 */
  readonly name: string;
  /** E.164로 맞춘 번호(purchase_order.buyer_phone에 이 값을 넣고 ComputeContactRef에도 이 값을 보낸다) */
  readonly phoneE164: string;
}

/**
 * 예매자 판정: name·phone이 둘 다 글로 있고 각각 1~BUYER_TEXT_MAX자이며 C0·C1 제어 문자(U+0000~001F, U+007F~009F)가 없고
 * phone을 toE164(domain/phone.ts)로 맞출 수 있으면 { name, phoneE164 }, 아니면 undefined(400).
 * 성명은 고치지 않고 받은 그대로 둔다(앞뒤 빈칸도 그대로)
 */
export function buyerOf(buyer: OrderBuyerInput): OrderBuyer | undefined {
  const { name, phone } = buyer ?? {};
  if (!isBuyerText(name) || !isBuyerText(phone)) return undefined;
  const phoneE164 = toE164(phone);
  return phoneE164 === undefined ? undefined : { name, phoneE164 };
}

/** C0(U+0000~001F)·C1(U+007F~009F) 제어 문자(리뷰 고침 L1). 빈칸 U+0020은 들지 않는다 */
const CONTROL_CHAR = /[\u0000-\u001F\u007F-\u009F]/;

/** 1~BUYER_TEXT_MAX자 글이고 제어 문자가 없다(길이는 UTF-16 글자 수, 주문 저장소 assertNewOrder와 같은 셈) */
const isBuyerText = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= BUYER_TEXT_MAX && !CONTROL_CHAR.test(v);

/** 금액 계산 결과 */
export type OrderPricing =
  /** items는 seats와 같은 차례(줄 번호 차례)이고 unitPrice = tierPrices[tierId], amount = unitPrice 합 */
  | { readonly status: 'OK'; readonly amount: number; readonly items: readonly OrderItem[] }
  /** 가격이 없는 등급(seats 차례로 처음 만난 것). 주문을 만들지 않고 500(설정 오류, 로그 kind config) */
  | { readonly status: 'PRICE_MISSING'; readonly tierId: string }
  /** 합이 주문 금액 칸(PostgreSQL int4, ORDER_AMOUNT_MAX)을 넘는다. 가격 없음과 같은 설정 오류 길(500, 로그 kind config, 리뷰 고침 L5) */
  | { readonly status: 'AMOUNT_OUT_OF_RANGE' };

/** 주문 금액 상한(purchase_order.amount int4) */
export const ORDER_AMOUNT_MAX = 2_147_483_647;

/**
 * 홀드 좌석의 등급 가격 합(payment §2 '금액'). 가격은 회차 좌석맵 판 파일의 tierPrices({등급 ID: 원})다.
 * tierPrices에 그 등급 칸이 없으면(자기 속성만 본다. 'toString' 같은 이름도 칸이 없으면 없음) PRICE_MISSING, 합이 ORDER_AMOUNT_MAX를 넘으면 AMOUNT_OUT_OF_RANGE.
 * 값은 판 파일 해석이 0 이상 정수로 이미 걸렀다고 본다. 던지지 않는다
 */
export function priceSeats(seats: readonly HeldSeat[], tierPrices: Readonly<Record<string, number>>): OrderPricing {
  const items: OrderItem[] = [];
  let amount = 0;
  for (const s of seats) {
    // 자기 속성만 본다(프로토타입의 toString 같은 이름을 가격으로 읽지 않는다. 프로토타입 없는 객체도 읽는다)
    if (!Object.hasOwn(tierPrices, s.tierId)) return { status: 'PRICE_MISSING', tierId: s.tierId };
    const unitPrice = tierPrices[s.tierId]!;
    items.push({ seatId: s.seatId, tierId: s.tierId, sectionId: s.sectionId, unitPrice });
    amount += unitPrice;
  }
  // 가격 없는 등급을 먼저 다 본 뒤에 합을 본다(가격 없음이 먼저다)
  if (!(amount <= ORDER_AMOUNT_MAX)) return { status: 'AMOUNT_OUT_OF_RANGE' };
  return { status: 'OK', amount, items };
}

/**
 * 우선 구매 보류의 주문 금액(GAT-135, ADR-0171). 좌석마다 권리의 원래 가격(priority_grant.price) 하나를 쓴다.
 * 등급 가격표를 보지 않으므로 PRICE_MISSING이 없고, 합이 int4를 넘을 때만 AMOUNT_OUT_OF_RANGE다
 */
export function priceSeatsAt(seats: readonly HeldSeat[], unitPrice: number): OrderPricing {
  const items: OrderItem[] = seats.map((s) => ({ seatId: s.seatId, tierId: s.tierId, sectionId: s.sectionId, unitPrice }));
  const amount = unitPrice * seats.length;
  if (!(amount <= ORDER_AMOUNT_MAX)) return { status: 'AMOUNT_OUT_OF_RANGE' };
  return { status: 'OK', amount, items };
}
