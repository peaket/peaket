// SCR-023 [상품 정산] 탭이 계약의 정산서를 화면 말로 바꾼다. 계산·지급은 payment-svc 몫이고,
// 이 화면은 목록·이의 제기만 부른다(openapi listPartnerProductSettlements·createPartnerSettlementDispute).
import type { SettlementStatement } from '@/shared/api/partner-live';
import { isNotImplemented, isProblem } from '../../../shared/api/problem.ts';

export const SETTLEMENT_STATUS_LABEL: Record<NonNullable<SettlementStatement['status']>, string> = {
  CALCULATED: '계산됨',
  NOTIFIED: '통지됨',
  DISPUTED: '이의 처리 중',
  CONFIRMED: '확정',
  HELD: '지급 보류',
  SCHEDULED: '지급 예정',
  FAILED: '지급 실패',
  PAID: '지급 완료',
  CARRIED_OVER: '다음으로 이월',
  SUPERSEDED: '새 판으로 바뀜',
};

export const SETTLEMENT_STATUS_BADGE: Record<NonNullable<SettlementStatement['status']>, string> = {
  CALCULATED: 'badge',
  NOTIFIED: 'badge badge-primary',
  DISPUTED: 'badge badge-warning',
  CONFIRMED: 'badge badge-success',
  HELD: 'badge badge-warning',
  SCHEDULED: 'badge badge-outline',
  FAILED: 'badge badge-danger',
  PAID: 'badge badge-success',
  CARRIED_OVER: 'badge',
  SUPERSEDED: 'badge',
};

export const HOLD_REASON_LABEL: Record<NonNullable<SettlementStatement['holdReason']>, string> = {
  KYC: 'KYC 확인 필요',
  ACCOUNT_CHANGE: '정산 계좌 변경 뒤 3영업일',
  BALANCE: '결제사 잔액 부족',
  ACCOUNT_MISMATCH: '결제사 정산 계좌 불일치',
  SALE_SUSPENDED: '판매 중지',
};

export const PG_STORE_LABEL: Record<NonNullable<SettlementStatement['pgStore']>, string> = {
  STANDARD: '토스페이먼츠 일반',
  ESCROW: '토스페이먼츠 에스크로',
};

export const DISPUTE_REASONS: readonly { code: 'GROSS_AMOUNT' | 'REFUND_AMOUNT' | 'COMMISSION' | 'OFFSET' | 'OTHER'; label: string; help: string }[] = [
  { code: 'GROSS_AMOUNT', label: '판매 대금 차이', help: '승인된 결제 금액의 합이 판매 기록과 다릅니다' },
  { code: 'REFUND_AMOUNT', label: '환급 금액 차이', help: '취소·환불 금액의 합이나 공제가 다릅니다' },
  { code: 'COMMISSION', label: '중개수수료·부가세 차이', help: '적용한 수수료율이나 계산이 계약과 다릅니다' },
  { code: 'OFFSET', label: '미수금 상계 차이', help: '상계한 미수금의 금액이나 근거가 다릅니다' },
  { code: 'OTHER', label: '그 밖의 사유', help: '위에 없는 사유입니다. 설명을 적어야 보냅니다' },
];

export function won(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `₩${Math.trunc(value).toLocaleString('ko-KR')}`;
}

export function periodText(s: SettlementStatement): string {
  if (!s.periodStart && !s.periodEnd) return '—';
  return `${s.periodStart ?? '—'} ~ ${s.periodEnd ?? '—'}`;
}

export function statementTitle(s: SettlementStatement): string {
  return s.pgStore ? PG_STORE_LABEL[s.pgStore] : s.pg === 'PORTONE' ? '포트원' : '토스페이먼츠';
}

export function statusText(s: SettlementStatement): string {
  if (!s.status) return '—';
  if (s.status === 'HELD' && s.holdReason) return `${SETTLEMENT_STATUS_LABEL.HELD} · ${HOLD_REASON_LABEL[s.holdReason]}`;
  return SETTLEMENT_STATUS_LABEL[s.status];
}

export function statusBadge(s: SettlementStatement): string {
  return s.status ? SETTLEMENT_STATUS_BADGE[s.status] : 'badge';
}

/** 통지 뒤 2영업일 안. 날짜만 보고 화면에서 미리 막고, 서버가 다시 409로 막는다. */
export function canDispute(s: SettlementStatement, now: Date = new Date()): boolean {
  if (s.status !== 'NOTIFIED') return false;
  if (!s.disputeDueAt) return false;
  const due = new Date(s.disputeDueAt);
  return !Number.isNaN(due.getTime()) && now.getTime() <= due.getTime();
}

export function disputeDueText(s: SettlementStatement): string {
  if (!s.disputeDueAt) return '—';
  const d = new Date(s.disputeDueAt);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' }).format(d);
}

export interface BlockedNotice {
  blocked: boolean;
  title: string;
  detail: string;
}

/**
 * 상품 정산서는 payment-svc의 정산 모듈·정산서 표·지급대행 어댑터가 있어야 한다.
 * 아직 없으면 404/501/503이 오므로, 화면은 '서버 준비 중'과 '자료 없음'을 구별한다.
 */
export function settlementBlocked(e: unknown): BlockedNotice {
  if (isNotImplemented(e)) {
    return {
      blocked: true,
      title: '상품 정산서를 아직 받을 수 없습니다',
      detail: 'payment-svc 정산 모듈과 정산서 표, 결제사 지급대행 연결이 아직 없습니다. 상품 빌더·배송·웹훅은 그대로 쓸 수 있습니다.',
    };
  }
  if (isProblem(e) && e.status === 403) {
    return { blocked: true, title: '상품 정산서를 볼 권한이 없습니다', detail: '파트너 관리자·실무자로 다시 로그인해 주세요.' };
  }
  return { blocked: false, title: '', detail: '' };
}
