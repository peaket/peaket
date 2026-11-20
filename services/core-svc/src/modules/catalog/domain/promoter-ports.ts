// 파트너사·계약 저장소와 ops 승인 업무 클라이언트의 포트(BAT-615 LCH-070, ADR-0320).
// 관제 경로는 core_ops 풀로, 상품 게시의 수수료율 읽기는 core_partner 풀로 접속한다(ADR-0320 결정 8).
import type { ContractTerms, ContractTermsChange, PromoterContractPage, PromoterDetail, PromoterPage, PromoterSummary, PromoterContractPeriod } from './promoter-contract.js';

/** 멱등 요청 값(플랫폼 IdempotencyRequest와 모양이 같다). 도메인 층이 바깥 의존을 모르게 구조로 받는다 */
export interface Once {
  accountRef: string;
  operation: string;
  key: string;
  requestHash: Uint8Array;
}

export interface OpsPromoterActor {
  accountId: string;
  role: string;
}

export interface PromoterCreateInput extends ContractTerms {
  legalName: string;
}

export interface PromoterTermsQuery {
  cursor?: string | undefined;
  limit: number;
}

/** 변경 요청을 예약한 결과. 값은 지금 계약의 조건과 기간이다 */
export interface ReservedContractChange {
  current: PromoterContractPeriod;
  requested: ContractTerms;
}

export interface PromoterStore {
  list(q: { q?: string | undefined; cursor?: string | undefined; limit: number }): Promise<PromoterPage>;
  /** 없으면 undefined(다른 테넌트라는 개념이 없는 관제 경로) */
  detail(promoterId: string): Promise<PromoterDetail | undefined>;
  terms(promoterId: string, q: PromoterTermsQuery): Promise<PromoterContractPage | undefined>;
  /** 첫 계약을 승인 업무 없이 만든다. 같은 멱등 키는 같은 파트너를 돌려준다 */
  create(input: PromoterCreateInput, actor: OpsPromoterActor, now: Date, once?: Once | undefined): Promise<PromoterDetail>;
  /** 한 파트너에 열린 변경은 하나다. 지금 계약이 없거나 열린 변경이 있으면 그 뜻을 돌려준다 */
  reserveChange(promoterId: string, approvalId: string, requested: ContractTerms, now: Date): Promise<ReservedContractChange | 'not-found' | 'pending' | 'no-contract'>;
  /** 반려·철회·실패로 예약을 푼다. 같은 승인 ID가 아니면 아무것도 하지 않는다 */
  clearPending(promoterId: string, approvalId: string): Promise<void>;
  /** 승인된 변경을 같은 승인 ID로 한 번만 적용한다. 바꿀 칸만 받아 지금 값 위에 덮는다. 지금 값이 그 사이 바뀌었으면 'conflict'다 */
  applyChange(promoterId: string, approvalId: string, requested: Partial<ContractTerms>, approvedAt: Date, approverId: string): Promise<{ kind: 'applied' | 'already'; validFrom: Date } | 'not-found' | 'conflict'>;
  /** 파트너사 상호만(계약이 없으면 undefined). 관제 목록과 같은 값이다 */
  summary(promoterId: string): Promise<PromoterSummary | undefined>;
  /** 그 파트너의 지금 계약 수수료율. 계약이 없으면 undefined(임의 1000bp를 만들지 않는다) */
  currentCommissionRateBp(promoterId: string): Promise<number | undefined>;
}

/** core-svc가 ops-svc의 내부 승인 생성 경로를 부른다. 같은 승인 ID 재호출은 같은 답이다 */
export interface OpsApprovalClient {
  createContractTermsChange(input: {
    approvalId: string;
    promoterId: string;
    requestedBy: OpsPromoterActor;
    reasonText: string;
    current: ContractTerms & { validFrom: string };
    requested: ContractTerms;
  }): Promise<{ approvalId: string; status: string; requestedAt: string }>;
}

export const PROMOTER_STORE = Symbol('PROMOTER_STORE');
export const OPS_APPROVAL_CLIENT = Symbol('OPS_APPROVAL_CLIENT');
/** ops DB를 쓰지 않는 메모리 조립에서도 같은 저장소를 쓴다(시험 대역) */
export const COMMISSION_RATE_FALLBACK = Symbol('COMMISSION_RATE_FALLBACK');

export type { ContractTermsChange, PromoterContractPeriod, PromoterDetail, PromoterPage, PromoterSummary };
