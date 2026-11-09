// 결제 수단 연결값의 계산(docs/features/payment.md §2.1 '결제 수단 연결값'·'결제 수단 연결값의 첫 구현', ADR-0171 결정 4, BUILD_ORDER HOT-145).
// 어댑터가 공통 값으로 맞춘 카드 칸으로 invRef("pay", BIN 6자리 + "|" + 보이는 끝자리 + "|" + 발급사 코드 + "|" + 카드 종류)를 만든다.
// 프레임워크·저장소를 모른다(순수 값과 함수). 가린 번호는 여기서 계산에만 쓰고 결과에 싣지 않는다.
// 구현에서 정한 것(정본·설계에 없다):
// - 끝자리는 가린 번호에서 구분자 -를 지운 뒤 첫 * 뒤에 보이는 숫자를 이은 것이다(43301234****123* → 123). 가린 번호가 없으면 빈 글자다.
// - 카드 칸이 있어도 BIN이 없으면 NONE이다(정본 '카드 정보에 BIN이 없으면 둘 다 비운다'). BIN이나 가린 번호가 있는데 모양이 틀리면 계산하지 못한 것이다(CARD_SHAPE).
import type { ConfirmCard } from './payment-gateway.js';
import type { PaymentMethodRefs } from './ports.js';

/** 숫자 6~8자(토스 앞 6자리, 포트원 bin 앞 6자리나 8자리). 벗어나면 CARD_SHAPE다 */
export const CARD_BIN = /^[0-9]{6,8}$/;
/** 구분자를 지운 가린 번호: 숫자로 시작하고 * 가 있으며 숫자와 * 만이다 */
export const MASKED_CARD_NUMBER = /^[0-9]+\*[0-9*]*$/;
/** 가린 번호 최대 길이 20자(토스 card.number 최대 20자). 구분자를 지우기 전의 길이다 */
export const MASKED_CARD_MAX_LENGTH = 20;
/** 가린 번호에서 지우는 구분자. 두 결제사 공식 문서에 번호 형식이 적혀 있지 않아 -만 받고 다른 글자는 모양 오류로 둔다(BUILD_ORDER HOT-145 코드 리뷰) */
const CARD_SEPARATOR = /-/g;
/** 가린 번호의 보이는 숫자 상한 12개 [가정]. 번호가 거의 다 보이는 값을 가린 번호로 받지 않는다 */
export const MASKED_CARD_MAX_VISIBLE_DIGITS = 12;
/** cardBin과 계산에 쓰는 BIN 자리 수 */
const BIN_LENGTH = 6;

/** 라벨 키가 없거나(NO_KEY) 카드 칸 모양이 틀려(CARD_SHAPE) 계산하지 못한 까닭 */
export type PaymentMethodRefMissingReason = 'NO_KEY' | 'CARD_SHAPE';

/** LINKED: 값을 만들었다. NONE: 카드 정보나 BIN이 없다(두 칸을 비우고 refMissing 거짓). MISSING: 계산하지 못했다(두 칸을 비우고 refMissing 참) */
export type PaymentMethodLink =
  | { readonly kind: 'LINKED'; readonly paymentMethodRef: string; readonly cardBin: string }
  | { readonly kind: 'NONE' }
  | { readonly kind: 'MISSING'; readonly reason: PaymentMethodRefMissingReason };

export const NO_METHOD_LINK: PaymentMethodLink = Object.freeze({ kind: 'NONE' });
const NO_KEY: PaymentMethodLink = Object.freeze({ kind: 'MISSING', reason: 'NO_KEY' });
const CARD_SHAPE: PaymentMethodLink = Object.freeze({ kind: 'MISSING', reason: 'CARD_SHAPE' });

/** 가린 번호에서 구분자를 지운 값(토스 BIN을 자를 때도 쓴다) */
export function withoutCardSeparators(masked: string): string {
  return masked.replace(CARD_SEPARATOR, '');
}

/** 가린 번호의 보이는 끝자리. 모양이 틀리면 undefined */
function visibleTailOf(masked: string): string | undefined {
  if (masked.length > MASKED_CARD_MAX_LENGTH) return undefined;
  const number = withoutCardSeparators(masked);
  if (!MASKED_CARD_NUMBER.test(number)) return undefined;
  if (number.replace(/\*/g, '').length > MASKED_CARD_MAX_VISIBLE_DIGITS) return undefined;
  return number.slice(number.indexOf('*')).replace(/\*/g, '');
}

/**
 * 결제 수단 연결값을 계산한다. 던지지 않는다(연결값 때문에 결제를 막지 않는다).
 * @param card 어댑터가 공통 값으로 맞춘 카드 칸(없으면 NONE)
 * @param refs 라벨 키 pay로 invRef를 만드는 것(없으면 라벨 키 없음)
 * @param onMissing 계산하지 못했을 때 까닭과 함께 부른다(지표 inv_ref_missing_total. 출시 필수 값이라 identity-svc와 달리 NO_KEY도 센다, BUILD_ORDER HOT-145 코드 리뷰)
 */
export function paymentMethodLinkOf(card: ConfirmCard | undefined, refs: PaymentMethodRefs | undefined, onMissing?: (reason: PaymentMethodRefMissingReason) => void): PaymentMethodLink {
  if (card?.bin === undefined) return NO_METHOD_LINK;
  const tail = card.maskedNumber === undefined ? '' : visibleTailOf(card.maskedNumber);
  if (!CARD_BIN.test(card.bin) || tail === undefined) {
    onMissing?.('CARD_SHAPE');
    return CARD_SHAPE;
  }
  const cardBin = card.bin.slice(0, BIN_LENGTH);
  let paymentMethodRef: string | undefined;
  try {
    paymentMethodRef = refs?.ref(`${cardBin}|${tail}|${card.issuerCode}|${card.cardType}`);
  } catch {
    paymentMethodRef = undefined;
  }
  if (paymentMethodRef === undefined) {
    onMissing?.('NO_KEY');
    return NO_KEY;
  }
  return { kind: 'LINKED', paymentMethodRef, cardBin };
}

/** ConfirmFinish(APPROVED)에 넣는 칸 */
export function linkFinishFields(link: PaymentMethodLink | undefined): { paymentMethodRef?: string; cardBin?: string; refMissing?: true } {
  if (link?.kind === 'LINKED') return { paymentMethodRef: link.paymentMethodRef, cardBin: link.cardBin };
  return link?.kind === 'MISSING' ? { refMissing: true } : {};
}
