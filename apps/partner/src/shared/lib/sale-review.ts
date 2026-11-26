// 판매 승인 상태 이름·배지(화면 문구 한 곳). 화면·라이브 모델이 함께 쓰고, next/navigation을 가져오지 않아
// node --test의 순수 함수 시험이 이 파일만 읽을 수 있다.
export type SaleReview = 'DRAFT' | 'SUBMITTED' | 'RESUBMITTED' | 'APPROVED' | 'REJECTED' | 'CHANGE_REJECTED' | 'SUSPENDED';

export const SALE_REVIEW_LABEL: Record<SaleReview, string> = {
  DRAFT: '초안',
  SUBMITTED: '승인 대기',
  RESUBMITTED: '재승인 대기',
  APPROVED: '승인',
  REJECTED: '반려',
  CHANGE_REJECTED: '변경 반려',
  SUSPENDED: '판매 중지',
};

/** 키트 배지 클래스 */
export const SALE_REVIEW_BADGE: Record<SaleReview, string> = {
  DRAFT: 'badge',
  SUBMITTED: 'badge',
  RESUBMITTED: 'badge badge-warning',
  APPROVED: 'badge badge-success',
  REJECTED: 'badge badge-danger',
  CHANGE_REJECTED: 'badge badge-danger',
  SUSPENDED: 'badge badge-danger',
};
