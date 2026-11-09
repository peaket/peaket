// 결제사 가상계좌 칸 → 공통 값(docs/features/payment.md §6 '입금 확인의 첫 구현', BUILD_ORDER HOT-151). 대응표는 이 파일과 계약 시험이 정본이다.
// 토스는 Payment의 virtualAccount.accountNumber·bankCode·dueDate와 최상위 secret, 포트원은 method(PaymentMethodVirtualAccount)의 accountNumber·bank·expiredAt이다(공식 문서·스키마, 2026-11-09 확인).
// 없거나 모양이 틀린 칸만 뺀다(코드 리뷰 M5). 토스 dueDate는 공식 문서 형식이 yyyy-MM-dd'T'HH:mm:ss라 시간대가 없어 KST로 읽는다(2026-11-09 확인. 문서가 시간대를 적지 않아 KST는 [가정]이다).
// 이 파일은 v0 이미지(build:lib)에도 들어간다. 서버 전용 부품을 가져오지 않는다. 계좌번호·secret을 로그·오류 글에 싣지 않는다.
import type { ConfirmVirtualAccount } from '../../domain/payment-gateway.js';
import { str } from './pg-reply.js';

/** 계좌번호 모양: 영문·숫자·하이픈 1~64자 [가정] */
const ACCOUNT_NUMBER = /^[0-9A-Za-z-]{1,64}$/;
/** 은행 코드·이름 모양: 영문·숫자·밑줄·하이픈 1~40자 [가정](토스는 두 자리 코드, 포트원은 열거값) */
const BANK = /^[0-9A-Za-z_-]{1,40}$/;
/** 토스 secret 모양: 공백·제어 문자가 없는 ASCII 1~200자(웹훅의 대조값과 같은 규칙) */
const SECRET = /^[\x21-\x7e]{1,200}$/;
/** 시간대가 없는 날짜시각 */
const NO_TIME_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/** 맞는 칸만 담는다. 맞는 칸이 하나도 없으면 undefined */
function fields(accountNumber: string | undefined, bank: string | undefined, dueAt: string | undefined, secret: string | undefined): ConfirmVirtualAccount | undefined {
  const out: ConfirmVirtualAccount = {
    ...(accountNumber !== undefined && ACCOUNT_NUMBER.test(accountNumber) ? { accountNumber } : {}),
    ...(bank !== undefined && BANK.test(bank) ? { bank } : {}),
    ...(dueAt !== undefined && !Number.isNaN(Date.parse(dueAt)) ? { dueAt } : {}),
    ...(secret !== undefined && SECRET.test(secret) ? { secret } : {}),
  };
  return Object.keys(out).length === 0 ? undefined : out;
}

/** 시간대가 없는 토스 기한은 KST로 적는다. 그 밖의 값은 그대로다 */
function tossDueAt(raw: string | undefined): string | undefined {
  return raw !== undefined && NO_TIME_ZONE.test(raw) ? `${raw}+09:00` : raw;
}

/** 토스 Payment 본문의 virtualAccount·secret → 공통 값. 맞는 칸이 없으면 undefined */
export function tossVirtualAccountOf(json: Record<string, unknown> | undefined): ConfirmVirtualAccount | undefined {
  const raw = json?.virtualAccount as Record<string, unknown> | null | undefined;
  const va = raw !== null && typeof raw === 'object' ? raw : undefined;
  return fields(str(va?.accountNumber), str(va?.bankCode), tossDueAt(str(va?.dueDate)), str(json?.secret));
}

/** 포트원 method(PaymentMethodVirtualAccount) → 공통 값. 가상계좌가 아니거나 맞는 칸이 없으면 undefined */
export function portoneVirtualAccountOf(method: Record<string, unknown> | undefined): ConfirmVirtualAccount | undefined {
  if (method === undefined || str(method.type) !== 'PaymentMethodVirtualAccount') return undefined;
  return fields(str(method.accountNumber), str(method.bank), str(method.expiredAt), undefined);
}
