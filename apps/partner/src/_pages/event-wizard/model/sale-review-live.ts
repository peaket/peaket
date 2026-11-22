// SCR-021 5단계 판매 승인 요청의 폼·검사·본문·상태(BAT-617, LCH-080, d5 §6.4, ADR-0327).
// React·브라우저를 모르는 순수 함수만 둔다. 계좌번호는 요청 본문에만 쓰고 어디에도 저장하지 않는다(지급대행 연동 전).
import type { ProblemShape } from '../../../shared/api/problem.ts';

export type SaleReviewStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
export type ReportKind = 'NUMBER' | 'EXEMPTION';
export type ShortfallReason = 'RELAXED_STANDARD' | 'RECOMMENDED_FACILITY' | 'NOT_USED_THIS_SHOW' | 'OTHER';

export interface SellerForm {
  legalName: string;
  representative: string;
  address: string;
  phone: string;
  email: string;
  businessRegNo: string;
}
export interface SaleReviewForm {
  seller: SellerForm;
  report: { kind: ReportKind; value: string };
  payout: { bankCode: string; accountNumber: string; holderName: string };
  wheelchair: { confirmed: boolean; shortfallReason: ShortfallReason | ''; note: string };
}
export interface SaleReviewIssue {
  field: string;
  message: string;
}

/** 현황 응답에서 화면이 쓰는 값만(openapi PartnerSaleReviewStatus) */
export interface SaleReviewStatusLike {
  title: string;
  saleReview: SaleReviewStatus;
  rejectionReason: string | null;
  hasApprovalHistory: boolean;
  submittedAt: string | null;
  seller: {
    legalName: string;
    representative: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    businessRegNo: string | null;
    mailOrderReportNo: string | null;
    exemptionBasis: string | null;
  } | null;
  events: { eventId: string; openAt: string; startsAt: string; scale?: 'LARGE' | 'MEDIUM' | 'SMALL' | null }[];
}

export interface SaleReviewView {
  label: string;
  tone: 'default' | 'primary' | 'warning' | 'success' | 'danger';
  editable: boolean;
  canRequest: boolean;
  canCancel: boolean;
  reason: string | null;
}

export function emptySaleReviewForm(): SaleReviewForm {
  return {
    seller: { legalName: '', representative: '', address: '', phone: '', email: '', businessRegNo: '' },
    report: { kind: 'NUMBER', value: '' },
    payout: { bankCode: '', accountNumber: '', holderName: '' },
    wheelchair: { confirmed: false, shortfallReason: '', note: '' },
  };
}

/** 현황에서 판매자 정보를 채운다. 계좌는 서버가 저장하지 않으므로 늘 빈 칸이다 */
export function formFromStatus(status: SaleReviewStatusLike): SaleReviewForm {
  const form = emptySaleReviewForm();
  const s = status.seller;
  if (s) {
    form.seller = {
      legalName: s.legalName,
      representative: s.representative ?? '',
      address: s.address ?? '',
      phone: s.phone ?? '',
      email: s.email ?? '',
      businessRegNo: s.businessRegNo ?? '',
    };
    if (s.exemptionBasis && s.exemptionBasis.trim() !== '') form.report = { kind: 'EXEMPTION', value: s.exemptionBasis };
    else if (s.mailOrderReportNo && s.mailOrderReportNo.trim() !== '') form.report = { kind: 'NUMBER', value: s.mailOrderReportNo };
  }
  return form;
}

const issue = (field: string, message: string): SaleReviewIssue => ({ field, message });
const text = (v: string, field: string, label: string, max: number): SaleReviewIssue | null => {
  const value = v.trim();
  if (value === '') return issue(field, `${label}을(를) 입력해 주세요`);
  if (value.length > max) return issue(field, `${label}은(는) ${max.toLocaleString('en-US')}자까지 적을 수 있습니다`);
  return null;
};

/** 5단계 필수값·모양 검사. 서버가 다시 검사하고 여기 검사는 보내기 전에 칸에 알려 주려는 것이다 */
export function validateSaleReview(form: SaleReviewForm): SaleReviewIssue[] {
  const out: SaleReviewIssue[] = [];
  for (const [field, label, max] of [
    ['legalName', '상호', 100],
    ['representative', '대표자', 100],
    ['address', '주소', 300],
    ['phone', '전화', 30],
    ['email', '전자우편', 200],
    ['businessRegNo', '사업자등록번호', 20],
  ] as const) {
    const e = text(form.seller[field], `seller.${field}`, label, max);
    if (e) out.push(e);
  }
  if (form.seller.email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.seller.email.trim())) out.push(issue('seller.email', '전자우편 주소 모양이 아닙니다'));

  const reportMax = form.report.kind === 'NUMBER' ? 100 : 500;
  const reportLabel = form.report.kind === 'NUMBER' ? '통신판매업 신고번호' : '면제 근거';
  const reportIssue = text(form.report.value, 'report.value', reportLabel, reportMax);
  if (reportIssue) out.push(reportIssue);

  for (const [field, label, max] of [
    ['bankCode', '은행 코드', 10],
    ['accountNumber', '계좌번호', 30],
    ['holderName', '예금주', 60],
  ] as const) {
    const e = text(form.payout[field], `payout.${field}`, label, max);
    if (e) out.push(e);
  }
  if (form.payout.accountNumber.trim() !== '' && !/^[0-9-]+$/.test(form.payout.accountNumber.trim())) out.push(issue('payout.accountNumber', '계좌번호는 숫자와 -만 적을 수 있습니다'));

  if (!form.wheelchair.confirmed) out.push(issue('wheelchair.confirmed', '휠체어석의 수와 위치를 공연장 좌석 배치도와 대조해 확인해 주세요'));
  if (form.wheelchair.shortfallReason === 'OTHER' && form.wheelchair.note.trim() === '') out.push(issue('wheelchair.note', '기타를 골랐으면 이유를 적어 주세요'));
  if (form.wheelchair.note.trim().length > 500) out.push(issue('wheelchair.note', '이유는 500자까지 적을 수 있습니다'));
  return out;
}

/** 계약 CreatePartnerProductionSaleReviewBody와 같은 세 칸만 낸다. 계좌는 여기서만 쓰고 저장하지 않는다 */
export function toSaleReviewBody(form: SaleReviewForm) {
  const seller = {
    legalName: form.seller.legalName.trim(),
    representative: form.seller.representative.trim(),
    address: form.seller.address.trim(),
    phone: form.seller.phone.trim(),
    email: form.seller.email.trim(),
    businessRegNo: form.seller.businessRegNo.trim(),
    ...(form.report.kind === 'NUMBER' ? { mailOrderReportNo: form.report.value.trim() } : { exemptionBasis: form.report.value.trim() }),
  };
  return {
    seller,
    payoutAccount: {
      bankCode: form.payout.bankCode.trim(),
      accountNumber: form.payout.accountNumber.trim(),
      holderName: form.payout.holderName.trim(),
    },
    accessibleSeating: {
      confirmed: true as const,
      ...(form.wheelchair.shortfallReason !== '' ? { shortfallReason: form.wheelchair.shortfallReason } : {}),
      ...(form.wheelchair.note.trim() !== '' ? { note: form.wheelchair.note.trim() } : {}),
    },
  };
}

export function saleReviewView(status: Pick<SaleReviewStatusLike, 'saleReview' | 'hasApprovalHistory' | 'rejectionReason'>): SaleReviewView {
  const { saleReview, hasApprovalHistory } = status;
  const label =
    saleReview === 'DRAFT'
      ? '초안'
      : saleReview === 'SUBMITTED'
        ? hasApprovalHistory
          ? '재승인 대기'
          : '승인 대기'
        : saleReview === 'APPROVED'
          ? '승인'
          : saleReview === 'REJECTED'
            ? hasApprovalHistory
              ? '변경 반려'
              : '반려'
            : '판매 중지';
  const tone = saleReview === 'APPROVED' ? 'success' : saleReview === 'REJECTED' || saleReview === 'SUSPENDED' ? 'danger' : saleReview === 'SUBMITTED' && hasApprovalHistory ? 'warning' : saleReview === 'SUBMITTED' ? 'primary' : 'default';
  const editable = saleReview === 'DRAFT' || saleReview === 'REJECTED';
  return {
    label,
    tone,
    editable,
    canRequest: editable,
    canCancel: hasApprovalHistory && (saleReview === 'SUBMITTED' || saleReview === 'REJECTED'),
    reason: status.rejectionReason,
  };
}

export type SaleReviewProblemKind = 'member' | 'conflict' | 'validation' | 'notfound' | 'server' | 'unknown';

/** 문제 응답을 화면 문구와 새로고침 여부로 바꾼다. 서버 title·detail 원문은 그대로 보이지 않는다 */
export function problemOf(e: unknown): { kind: SaleReviewProblemKind; message: string; reload: boolean } {
  const p = (typeof e === 'object' && e !== null ? e : {}) as Partial<ProblemShape>;
  if (p.status === 403) {
    if (p.type === 'partner-admin-required' || p.type === 'forbidden') return { kind: 'member', message: '판매 승인 요청과 변경 취소는 파트너 관리자만 할 수 있습니다.', reload: false };
    return { kind: 'unknown', message: '이 화면을 쓸 권한이 없습니다.', reload: false };
  }
  if (p.status === 409) {
    if (p.type === 'production-suspended' || p.type === 'sale-review-suspended') return { kind: 'conflict', message: '판매 중지된 공연은 판매 승인을 요청할 수 없습니다.', reload: true };
    return { kind: 'conflict', message: '지금 상태에서는 할 수 없습니다. 새로 고친 뒤 다시 시도해 주세요.', reload: true };
  }
  if (p.status === 422) return { kind: 'validation', message: '입력한 값을 다시 확인해 주세요.', reload: false };
  if (p.status === 400) return { kind: 'validation', message: '입력한 값을 다시 확인해 주세요.', reload: false };
  if (p.status === 404) return { kind: 'notfound', message: '공연을 찾을 수 없습니다.', reload: false };
  if (typeof p.status === 'number' && p.status >= 500) return { kind: 'server', message: '서버가 잠시 응답하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', reload: false };
  return { kind: 'unknown', message: '요청을 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.', reload: false };
}

/** 한국 시각 YYYY-MM-DD HH:mm */
export function formatKst(iso: string | null): string {
  if (iso === null) return '—';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '—' : new Date(t + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
}
