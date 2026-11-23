// 도메인 층: payment-svc 지급대행 등록 포트(F-07-7 LCH-120, settlement §3, ADR-0370 결정 3·4).
// 판매 승인 요청이 등록(예금주 조회·이름 비교·포트원 파트너·토스 두 상점 셀러)을 부르고, 판매 승인이 등록 읽기로 조건을 보며
// 승인 성공 때 payment의 판매자 확인(seller_kyc)을 쓴다. core는 등록 값을 저장하지 않고 payment에서 읽는다.
// 계좌번호 원문은 register 인자로만 넘기고 core의 감사·로그·Outbox·오류에 싣지 않는다.

/** 토스 셀러 상태(payment toss_seller.status, settlement §3) */
export type PayoutTossSellerStatus = 'APPROVAL_REQUIRED' | 'PENDING' | 'PARTIALLY_APPROVED' | 'KYC_REQUIRED' | 'APPROVED' | 'REJECTED';

/** payment 등록 읽기(GET /internal/v1/settlements/promoters/{promoterId}/payout-registration). 결제사의 셀러·파트너 ID 원문은 없다 */
export interface PayoutRegistrationView {
  payoutAccount: { bankCode: string; last4: string; holdUntil: string | null; holderVerified: boolean } | null;
  agencySyncPending: boolean;
  tossEnabled: boolean;
  portoneEnabled: boolean;
  tossSellers: { pgStore: 'STANDARD' | 'ESCROW'; status: PayoutTossSellerStatus | null }[];
  portonePartnerRegistered: boolean;
}

/** 등록 요청의 판매자 정보(칸 이름은 payment PayoutAgencySyncInput.company와 같다) */
export interface PayoutRegistrationCompany {
  name: string;
  representativeName: string;
  /** 숫자만 10자리 */
  businessRegistrationNumber: string;
  email: string;
  phone: string;
}

export interface PayoutRegistrationInput {
  promoterId: string;
  businessType: 'INDIVIDUAL_BUSINESS' | 'CORPORATE';
  company: PayoutRegistrationCompany;
  /** 두 자리 은행 코드·계좌번호(숫자만)·예금주. 이 요청 안에서만 쓴다 */
  account: { bankCode: string; accountNumber: string; holderName: string };
}

export interface PayoutRegistrationPort {
  /** 지급대행 등록. holderChecked false면 포트원 플랫폼이 꺼져 모양만 본 것이다. 422·502·503은 같은 이름의 ProblemError로 던진다 */
  register(input: PayoutRegistrationInput): Promise<{ holderChecked: boolean }>;
  /** 등록 읽기. 실패는 503 payout-dependency-unavailable */
  read(promoterId: string): Promise<PayoutRegistrationView>;
  /** 판매자 확인 쓰기(같은 값이면 멱등). 실패는 503 payout-dependency-unavailable */
  verifySeller(promoterId: string, input: { legalName: string; representative: string; verifiedAt: Date }): Promise<void>;
}

export const PAYOUT_REGISTRATION = Symbol('PAYOUT_REGISTRATION');

/** 둘 다 꺼진 읽기(payment 주소가 없거나 읽기가 실패했을 때 상세에 싣는 모양) */
export const PAYOUT_REGISTRATION_OFF: PayoutRegistrationView = Object.freeze({
  payoutAccount: null,
  agencySyncPending: false,
  tossEnabled: false,
  portoneEnabled: false,
  tossSellers: [],
  portonePartnerRegistered: false,
}) as PayoutRegistrationView;

/** 판매 승인을 막는 모자란 조건(openapi createOpsSaleReviewApproval 409 sale-review-payout-registration-incomplete의 missing) */
export type PayoutRegistrationMissing = 'HOLDER' | 'PORTONE_PARTNER' | 'TOSS_SELLER';

/** 토스 일반 상점 셀러가 판매를 열 수 있는 상태(settlement §3: 상태 여섯 가운데 둘) */
const SELLABLE: ReadonlySet<string> = new Set(['PARTIALLY_APPROVED', 'APPROVED']);

/**
 * 판매 승인 조건(ADR-0370 결정 4). 켜진 결제사만 본다.
 * 포트원: 정산 계좌의 예금주 확인·포트원 파트너 등록. 토스: 일반 상점(STANDARD) 셀러가 PARTIALLY_APPROVED·APPROVED.
 */
export function missingPayoutConditions(v: PayoutRegistrationView): PayoutRegistrationMissing[] {
  const missing: PayoutRegistrationMissing[] = [];
  if (v.portoneEnabled) {
    if (v.payoutAccount === null || !v.payoutAccount.holderVerified) missing.push('HOLDER');
    if (!v.portonePartnerRegistered) missing.push('PORTONE_PARTNER');
  }
  if (v.tossEnabled) {
    const standard = v.tossSellers.find((s) => s.pgStore === 'STANDARD');
    if (!standard || standard.status === null || !SELLABLE.has(standard.status)) missing.push('TOSS_SELLER');
  }
  return missing;
}

/**
 * 사업자 형태 [가정]: 사업자등록번호 가운데 두 자리(구분 코드)가 81~88이면 법인, 그 밖은 개인사업자로 본다(국세청 사업자등록번호 체계).
 * 판매 승인 요청 본문에는 사업자 형태 칸이 없다
 */
export function businessTypeOf(businessRegNoDigits: string): PayoutRegistrationInput['businessType'] {
  const code = Number(businessRegNoDigits.slice(3, 5));
  return Number.isInteger(code) && code >= 81 && code <= 88 ? 'CORPORATE' : 'INDIVIDUAL_BUSINESS';
}

/** 조립 없이 직접 만든 유스케이스(시험)의 기본값: 둘 다 꺼짐, 등록·판매자 확인은 건너뜀. 운영 조립은 늘 포트를 넘긴다 */
export const PAYOUT_REGISTRATION_UNWIRED: PayoutRegistrationPort = Object.freeze({
  register: async () => ({ holderChecked: false }),
  read: async () => structuredClone(PAYOUT_REGISTRATION_OFF),
  verifySeller: async () => undefined,
});
