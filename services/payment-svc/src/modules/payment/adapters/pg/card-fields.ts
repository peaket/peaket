// 결제사 카드 칸 → 공통 카드 값(docs/features/payment.md §2.1 '결제 수단 연결값의 첫 구현', BUILD_ORDER HOT-145).
// 표준 값은 토스 카드사 코드표의 영문 표기와 포트원 CardType 열거값이다. 대응표는 이 파일과 계약 시험이 정본이다.
// 토스 코드표는 공식 문서(카드사 코드, 2026-11-09 확인) 그대로다. 포트원 issuer는 공식 스키마에 값 목록이 없어 표로 바꾸지 못하고 모양만 본다.
// 이 파일은 v0 이미지(build:lib)에도 들어간다. 서버 전용 부품을 가져오지 않는다. 표는 결제사가 준 값을 키로 찾으므로 Map이다.
import type { ConfirmCard } from '../../domain/payment-gateway.js';
import { withoutCardSeparators } from '../../domain/payment-method-ref.js';

/** 토스 발급사 코드(두 자리) → 영문 표기. 표에 없는 코드는 빈 글자다 */
const TOSS_ISSUER: ReadonlyMap<string, string> = new Map([
  ['3K', 'IBK_BC'],
  ['46', 'GWANGJUBANK'],
  ['71', 'LOTTE'],
  ['30', 'KDBBANK'],
  ['31', 'BC'],
  ['51', 'SAMSUNG'],
  ['38', 'SAEMAUL'],
  ['41', 'SHINHAN'],
  ['62', 'SHINHYEOP'],
  ['36', 'CITI'],
  ['33', 'WOORI'],
  ['W1', 'WOORI'],
  ['37', 'POST'],
  ['39', 'SAVINGBANK'],
  ['35', 'JEONBUKBANK'],
  ['42', 'JEJUBANK'],
  ['15', 'KAKAOBANK'],
  ['3A', 'KBANK'],
  ['24', 'TOSSBANK'],
  ['21', 'HANA'],
  ['61', 'HYUNDAI'],
  ['11', 'KOOKMIN'],
  ['91', 'NONGHYEOP'],
  ['34', 'SUHYEOP'],
  ['6D', 'DINERS'],
  ['4M', 'MASTER'],
  ['3C', 'UNIONPAY'],
  ['7A', 'AMEX'],
  ['4J', 'JCB'],
  ['4V', 'VISA'],
]);
/** 토스 cardType → 공통 카드 종류. 미확인과 표에 없는 값은 빈 글자다 */
const TOSS_CARD_TYPE: ReadonlyMap<string, string> = new Map([
  ['신용', 'CREDIT'],
  ['체크', 'DEBIT'],
  ['기프트', 'GIFT'],
]);
/** 포트원 CardType(공식 스키마 열거값) */
const PORTONE_CARD_TYPES: ReadonlySet<string> = new Set(['CREDIT', 'DEBIT', 'GIFT']);
/** 포트원 issuer의 모양. 공식 스키마에 값 목록이 없다 */
const PORTONE_ISSUER = /^[A-Za-z0-9_-]{1,40}$/;
/** 토스 BIN은 가린 번호의 앞 6자리다(payment §2.1) */
const TOSS_BIN_LENGTH = 6;

const objectOf = (raw: unknown): Record<string, unknown> | undefined => (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined);
/** 글이고 빈 글이 아니면 그 글 */
const textOf = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** 토스 Payment.card → 공통 카드 값. 카드 칸이 객체가 아니면 undefined */
export function tossCardOf(raw: unknown): ConfirmCard | undefined {
  const card = objectOf(raw);
  if (!card) return undefined;
  const maskedNumber = textOf(card.number);
  return {
    ...(maskedNumber === undefined ? {} : { maskedNumber, bin: withoutCardSeparators(maskedNumber).slice(0, TOSS_BIN_LENGTH) }),
    issuerCode: TOSS_ISSUER.get(textOf(card.issuerCode) ?? '') ?? '',
    cardType: TOSS_CARD_TYPE.get(textOf(card.cardType) ?? '') ?? '',
  };
}

/**
 * 포트원 Payment.method → 공통 카드 값. 공식 스키마(v2.openapi.json 1.16.0)대로 카드 결제는 method.card이고,
 * 간편결제는 easyPayMethod가 PaymentMethodCard일 때만 그 card다(충전식·계좌는 카드가 아니다, BUILD_ORDER HOT-145 코드 리뷰). 카드 칸이 없으면 undefined
 */
export function portoneCardOfMethod(raw: unknown): ConfirmCard | undefined {
  const method = objectOf(raw);
  if (method?.type !== 'PaymentMethodEasyPay') return portoneCardOf(method?.card);
  const easyPayMethod = objectOf(method.easyPayMethod);
  return easyPayMethod?.type === 'PaymentMethodCard' ? portoneCardOf(easyPayMethod.card) : undefined;
}

/** 포트원 PaymentMethodCard.card → 공통 카드 값. 카드 칸이 객체가 아니면 undefined */
export function portoneCardOf(raw: unknown): ConfirmCard | undefined {
  const card = objectOf(raw);
  if (!card) return undefined;
  const maskedNumber = textOf(card.number);
  const bin = textOf(card.bin);
  const issuer = textOf(card.issuer);
  const type = textOf(card.type);
  return {
    ...(maskedNumber === undefined ? {} : { maskedNumber }),
    ...(bin === undefined ? {} : { bin }),
    issuerCode: issuer !== undefined && PORTONE_ISSUER.test(issuer) ? issuer.toUpperCase() : '',
    cardType: type !== undefined && PORTONE_CARD_TYPES.has(type) ? type : '',
  };
}
