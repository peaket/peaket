// 파트너사 계약 조건의 순수 부분(BAT-615 LCH-070, ADR-0320, settlement §4.1).
// 계약은 기간(tstzrange [valid_from, valid_until))으로 남기고 지난 기간은 고치지 않는다. 지금 계약은 상한이 없는 기간 하나다.
// 수수료율·보증 비율은 만분율(bp, 10% = 1000)이고, 보증 종류는 보증금(DEPOSIT)·이행보증보험(PERFORMANCE_BOND) 둘이다.

export class ContractTermsProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
  ) {
    super(title);
    this.name = 'ContractTermsProblem';
  }
}

export type GuaranteeKind = 'DEPOSIT' | 'PERFORMANCE_BOND';

/** 계약 조건 한 기간의 값(기간·승인 업무 제외) */
export interface ContractTerms {
  commissionRateBp: number;
  guaranteeRateBp: number;
  guaranteeKind: GuaranteeKind;
}

/** 계약 조건 한 기간(docs/data.md promoter_contract) */
export interface PromoterContractPeriod extends ContractTerms {
  validFrom: Date;
  /** null이면 지금 계약(상한 없음) */
  validUntil: Date | null;
  /** 변경 승인 업무. 첫 계약은 null */
  approvalId: string | null;
}

/** 바꿀 칸만 보낸다. 없으면 지금 값을 그대로 쓴다 */
export interface ContractTermsChange {
  commissionRateBp?: number | undefined;
  guaranteeRateBp?: number | undefined;
  guaranteeKind?: GuaranteeKind | undefined;
  reason: string;
}

/** 파트너사 목록의 한 줄(openapi OpsPromoterSummary) */
export interface PromoterSummary {
  promoterId: string;
  legalName: string;
  commissionRateBp: number;
  guaranteeRateBp: number;
  contractChangePending: boolean;
}

/** 공개 판매자 신원정보(openapi SellerInfo). 없는 칸은 null/빈 값이다 */
export interface SellerInfo {
  legalName: string;
  representative?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  businessRegNo?: string | null;
  mailOrderReportNo?: string | null;
  exemptionBasis?: string | null;
}

/** 파트너사 상세(openapi OpsPromoterDetail). 결제사의 셀러·파트너 ID 원문은 없다 */
export interface PromoterDetail {
  promoterId: string;
  legalName: string;
  contract: PromoterContractPeriod;
  pendingContractApprovalId: string | null;
  seller: SellerInfo | null;
  verifiedAt: Date | null;
  /** 이 묶음은 지급대행 연동 전이라 늘 null이다(ADR-0320 결정 7) */
  payoutAccount: null;
  /** 결제사 등록도 연동 전이다. 가짜 상태를 채우지 않는다 */
  pgRegistration: { tossSellers: []; portonePartnerRegistered: false };
}

export interface PromoterPage {
  items: PromoterSummary[];
  nextCursor: string | null;
}

export interface PromoterContractPage {
  items: PromoterContractPeriod[];
  nextCursor: string | null;
}

export const GUARANTEE_KINDS: readonly GuaranteeKind[] = ['DEPOSIT', 'PERFORMANCE_BOND'];

const invalid = (type: string, title: string): ContractTermsProblem => new ContractTermsProblem(type, 422, title);

/** 0~10,000 정수(bp). 범위 밖·정수가 아닌 값은 422다 */
export function validateBp(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) throw invalid('contract-terms-invalid', `${name}은 0~10,000 사이 정수(만분율)여야 합니다`);
}

export function isGuaranteeKind(value: string): value is GuaranteeKind {
  return value === 'DEPOSIT' || value === 'PERFORMANCE_BOND';
}

/** 바꿀 칸이 없거나 지금 값과 같은 값만 있으면 422다(openapi PromoterContractTermChangeCreate) */
export function validateChange(current: ContractTerms, change: ContractTermsChange): void {
  if (change.commissionRateBp !== undefined) validateBp('수수료율', change.commissionRateBp);
  if (change.guaranteeRateBp !== undefined) validateBp('보증 비율', change.guaranteeRateBp);
  if (change.guaranteeKind !== undefined && !isGuaranteeKind(change.guaranteeKind)) throw invalid('contract-terms-invalid', '보증 종류가 맞지 않습니다');
  const reason = change.reason.trim();
  if (reason.length < 1 || reason.length > 2_000) throw invalid('contract-terms-invalid', '변경 사유는 1~2,000자여야 합니다');
  const changed = requestedTerms(current, change);
  if (changed.commissionRateBp === current.commissionRateBp && changed.guaranteeRateBp === current.guaranteeRateBp && changed.guaranteeKind === current.guaranteeKind) {
    throw invalid('contract-terms-unchanged', '바꿀 칸이 없거나 지금 값과 같습니다');
  }
}

/** 지금 값 위에 바꿀 칸만 덮는다 */
export function requestedTerms(current: ContractTerms, change: ContractTermsChange): ContractTerms {
  return {
    commissionRateBp: change.commissionRateBp ?? current.commissionRateBp,
    guaranteeRateBp: change.guaranteeRateBp ?? current.guaranteeRateBp,
    guaranteeKind: change.guaranteeKind ?? current.guaranteeKind,
  };
}

/** 이 기간에 승인된 변경인가(같은 승인 ID를 다시 보내도 기간을 두 번 만들지 않는다) */
export function isSameApproval(period: PromoterContractPeriod, approvalId: string): boolean {
  return period.approvalId !== null && period.approvalId === approvalId;
}

/**
 * 판매자 신원정보를 상세 응답 모양으로 만든다. 등록은 상호만 받으므로 사업자번호·대표자 같은 칸이 하나도 없으면 null이다
 * (openapi OpsPromoterDetail.seller: 아직 받지 않았으면 null).
 */
export function sellerInfoOf(r: { legalName: string; representative: string | null; address: string | null; phone: string | null; email: string | null; businessRegNo: string | null; mailOrderReportNo: string | null; exemptionBasis: string | null }): SellerInfo | null {
  const received = r.representative ?? r.address ?? r.phone ?? r.email ?? r.businessRegNo ?? r.mailOrderReportNo ?? r.exemptionBasis;
  if (received === null) return null;
  return {
    legalName: r.legalName,
    representative: r.representative,
    address: r.address,
    phone: r.phone,
    email: r.email,
    businessRegNo: r.businessRegNo,
    mailOrderReportNo: r.mailOrderReportNo,
    exemptionBasis: r.exemptionBasis,
  };
}

/** 지금 계약(상한 없음)을 고른다. 없으면 마지막 기간을 쓴다 */
export function currentPeriod(periods: readonly PromoterContractPeriod[]): PromoterContractPeriod | undefined {
  return periods.find((p) => p.validUntil === null) ?? periods.at(-1);
}

/** bp를 화면 표기 퍼센트로 바꾼다(10,000bp = 100%). 소수 둘째 자리까지 남기고 0을 줄인다 */
export function formatBp(bp: number): string {
  const value = bp / 100;
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
