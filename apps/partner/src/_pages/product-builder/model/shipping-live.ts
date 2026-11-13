// SCR-023 [배송·반품 처리]가 계약의 항목 상태를 화면 말로 바꾸고, 송장·반품 거절 입력을 먼저 검사한다.
// 실제 상태 전이는 서버가 한다(openapi putPartnerMerchOrderItemShipment·arrival-confirmation·arrival-rejection).
import type { MerchOrderItem } from '@/shared/api/partner-live';

export const SHIP_STATUS_LABEL: Record<MerchOrderItem['status'], string> = {
  READY: '배송 준비',
  SHIPPED: '배송 중',
  DELIVERED: '배송 완료',
  PICKED_UP: '수령함',
  LOCKED: '잠김',
  RETURN_REQUESTED: '반품 요청',
  RETURN_RECEIVED: '반품 도착 확인',
  DISPUTED: '반품 확인 중(분쟁)',
  CANCELLED: '취소',
  REFUNDED: '환급됨',
};

export const SHIP_STATUS_BADGE: Record<MerchOrderItem['status'], string> = {
  READY: 'badge',
  SHIPPED: 'badge badge-primary',
  DELIVERED: 'badge badge-success',
  PICKED_UP: 'badge badge-success',
  LOCKED: 'badge',
  RETURN_REQUESTED: 'badge badge-warning',
  RETURN_RECEIVED: 'badge badge-warning',
  DISPUTED: 'badge badge-warning',
  CANCELLED: 'badge',
  REFUNDED: 'badge',
};

export const RETURN_REASON_LABEL: Record<'CHANGE_OF_MIND' | 'DEFECT_OR_MISMATCH', string> = {
  CHANGE_OF_MIND: '단순 변심',
  DEFECT_OR_MISMATCH: '상품 이상·설명과 다름',
};

export const CARRIERS: readonly { code: string; label: string }[] = [
  { code: 'CJ', label: 'CJ대한통운' },
  { code: 'HANJIN', label: '한진택배' },
  { code: 'LOTTE', label: '롯데택배' },
  { code: 'LOGEN', label: '로젠택배' },
  { code: 'POST', label: '우체국택배' },
];

export function carrierLabel(code: string | null | undefined): string {
  if (!code) return '—';
  return CARRIERS.find((c) => c.code === code)?.label ?? code;
}

export function canRegisterInvoice(item: MerchOrderItem): boolean {
  return item.fulfillment === 'DELIVERY' && (item.status === 'READY' || item.status === 'SHIPPED');
}

export function canConfirmReturn(item: MerchOrderItem): boolean {
  return item.fulfillment === 'DELIVERY' && !item.ticketLinked && item.status === 'RETURN_REQUESTED';
}

export function canRejectReturn(item: MerchOrderItem): boolean {
  return item.fulfillment === 'DELIVERY' && !item.ticketLinked && (item.status === 'RETURN_REQUESTED' || item.status === 'RETURN_RECEIVED');
}

export function canPickup(item: MerchOrderItem): boolean {
  return item.fulfillment === 'PICKUP' && item.status === 'READY';
}

export function recipientText(item: MerchOrderItem): string {
  if (!item.recipient) return '—';
  return `${item.recipient.nameMasked} · ${item.recipient.phoneMasked}`;
}

export function itemText(item: MerchOrderItem): string {
  const option = item.optionSummary ? ` · ${item.optionSummary}` : '';
  return `${item.productName}${option} · ${item.quantity}개`;
}

export interface InvoiceCheck {
  ok: boolean;
  errors: { carrier?: string; trackingNo?: string };
}

export function checkInvoice(carrier: string, trackingNo: string): InvoiceCheck {
  const errors: InvoiceCheck['errors'] = {};
  if (!/^[A-Z0-9_]{2,30}$/.test(carrier.trim())) errors.carrier = '택배사를 골라 주세요';
  if (!/^[0-9A-Za-z-]{8,30}$/.test(trackingNo.trim())) errors.trackingNo = '송장 번호는 영문·숫자·-로 8~30자입니다';
  return { ok: Object.keys(errors).length === 0, errors };
}

export interface RejectionCheck {
  ok: boolean;
  errors: { reasonCode?: string; evidence?: string };
}

export function checkRejection(reasonCode: string, evidence: string): RejectionCheck {
  const errors: RejectionCheck['errors'] = {};
  if (reasonCode !== 'DAMAGED_BY_BUYER' && reasonCode !== 'VALUE_LOST_BY_USE') errors.reasonCode = '거절 사유를 골라 주세요';
  const text = evidence.trim();
  if (text.length === 0) errors.evidence = '근거를 적어 주세요';
  else if (text.length > 1000) errors.evidence = '근거는 1,000자까지입니다';
  else if (/\d{2,3}-?\d{3,4}-?\d{4}/.test(text)) errors.evidence = '구매자의 연락처로 보이는 숫자는 적지 마세요';
  return { ok: Object.keys(errors).length === 0, errors };
}

/** 배송 명단 내려받기 사유(1~500자). */
export function checkExportReason(reason: string): string | null {
  const text = reason.trim();
  if (text.length === 0) return '다운로드 사유를 적어 주세요';
  if (text.length > 500) return '다운로드 사유는 500자까지입니다';
  return null;
}
