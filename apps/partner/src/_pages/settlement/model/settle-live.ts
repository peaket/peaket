// SCR-027 '정산서' 탭 실제 판의 화면 모델(F-07-7, ADR-0370 결정 9, d5 §6.10).
// 계약 GET /v1/partner/events/{eventId}/settlements의 정산서를 결제사별(토스페이먼츠 → 포트원)로 묶어 화면 말로 바꾼다.
// 날짜는 KST 'M/D(요일)', 금액은 원 단위다. 배상 줄은 실제 판에서 그리지 않는다(F-07-8 몫).
import type { ProblemShape } from '../../../shared/api/problem.ts';

type Pg = 'TOSS' | 'PORTONE';
type Status = 'CALCULATED' | 'NOTIFIED' | 'DISPUTED' | 'CONFIRMED' | 'HELD' | 'SCHEDULED' | 'FAILED' | 'PAID' | 'CARRIED_OVER' | 'SUPERSEDED';
type HoldReason = 'KYC' | 'ACCOUNT_CHANGE' | 'BALANCE' | 'ACCOUNT_MISMATCH' | 'SALE_SUSPENDED';

export interface EventStatementRaw {
  statementId?: string;
  pg?: Pg;
  pgStore?: 'STANDARD' | 'ESCROW';
  grossAmount?: number;
  refundAmount?: number;
  commissionAmount?: number;
  commissionVat?: number;
  offsetAmount?: number;
  payoutAmount?: number;
  status?: Status;
  holdReason?: HoldReason;
  disputeDueAt?: string;
  payoutDate?: string;
  kycNotice?: boolean;
}

export interface SettleItemView {
  statementId: string;
  storeTitle: string;
  statusText: string;
  holdReasonText: string | null;
  disputeDueText: string | null;
  payoutDateText: string | null;
  amounts: { gross: string; refund: string; commission: string; vat: string; offset: string; payout: string };
  /** 이의를 낼 수 있는 상태(통지됨). 기한은 서버가 다시 409로 막는다 */
  disputable: boolean;
  /** 지급 예정·완료 판단에 쓰는 원래 값 */
  raw: EventStatementRaw;
}

export interface SettleGroupView {
  pg: Pg;
  title: string;
  items: SettleItemView[];
}

export interface SettleStatementsView {
  groups: SettleGroupView[];
  kycNotice: boolean;
  kycBanner: string | null;
}

const PG_TITLE: Readonly<Record<Pg, string>> = { TOSS: '토스페이먼츠', PORTONE: '포트원' };

const STATUS_TEXT: Readonly<Record<Status, string>> = {
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

/** d5 §6.10 보류 사유 다섯 */
const HOLD_TEXT: Readonly<Record<HoldReason, string>> = {
  KYC: 'KYC 필요',
  ACCOUNT_CHANGE: '계좌 변경 3영업일',
  BALANCE: '잔액 부족',
  ACCOUNT_MISMATCH: '포트원 계좌 불일치',
  SALE_SUSPENDED: '판매 중지',
};

/** d5 §6.10 'KYC 예고' 행의 info 배너 글 */
export const KYC_NOTICE_BANNER =
  '이번 지급으로 토스페이먼츠 결제분 지급이 7일 동안 1천만 원 이상이 될 수 있어, 결제사가 고객확인(KYC)을 요청할 수 있습니다. 결제사가 셀러 등록 이메일로 고객확인 신청서를 보내면 PC에서 바로 제출해 주세요(서류는 최근 3개월 안에 발급한 것). 고객확인은 미리 받을 수 없고, 요청이 오면 승인될 때까지 토스페이먼츠 결제분 지급이 보류됩니다.';

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function monthDayWeek(utcMidnightOfKstDate: Date): string {
  return `${utcMidnightOfKstDate.getUTCMonth() + 1}/${utcMidnightOfKstDate.getUTCDate()}(${WEEKDAY[utcMidnightOfKstDate.getUTCDay()]})`;
}

/** ISO 시각 → KST 'M/D(요일)' */
function kstDateTimeText(iso: string | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return monthDayWeek(new Date(t + KST_OFFSET_MS));
}

/** 'YYYY-MM-DD'(KST 날짜) → 'M/D(요일)' */
function kstDateText(date: string | undefined): string | null {
  if (!date || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) return null;
  const d = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : monthDayWeek(d);
}

export function wonText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `₩${Math.trunc(value).toLocaleString('en-US')}`;
}

function storeTitle(s: EventStatementRaw): string {
  if (s.pg === 'PORTONE') return '포트원';
  return s.pgStore === 'ESCROW' ? '토스페이먼츠 에스크로' : '토스페이먼츠 일반';
}

function itemView(s: EventStatementRaw): SettleItemView {
  return {
    statementId: s.statementId ?? '',
    storeTitle: storeTitle(s),
    statusText: s.status ? STATUS_TEXT[s.status] : '—',
    holdReasonText: s.status === 'HELD' && s.holdReason ? HOLD_TEXT[s.holdReason] : null,
    disputeDueText: kstDateTimeText(s.disputeDueAt),
    payoutDateText: kstDateText(s.payoutDate),
    amounts: {
      gross: wonText(s.grossAmount),
      refund: wonText(s.refundAmount),
      commission: wonText(s.commissionAmount),
      vat: wonText(s.commissionVat),
      offset: wonText(s.offsetAmount),
      payout: wonText(s.payoutAmount),
    },
    disputable: s.status === 'NOTIFIED',
    raw: s,
  };
}

export function settleStatementsView(raw: readonly EventStatementRaw[]): SettleStatementsView {
  const groups: SettleGroupView[] = [];
  for (const pg of ['TOSS', 'PORTONE'] as const) {
    const items = raw.filter((s) => s.pg === pg).map(itemView);
    if (items.length > 0) groups.push({ pg, title: PG_TITLE[pg], items });
  }
  // KYC 예고는 토스페이먼츠 정산서만 본다(포트원은 서버가 늘 false를 주고, 와도 배너를 켜지 않는다)
  const kycNotice = raw.some((s) => s.pg === 'TOSS' && s.kycNotice === true);
  return { groups, kycNotice, kycBanner: kycNotice ? KYC_NOTICE_BANNER : null };
}

export type DisputeReasonCode = 'GROSS_AMOUNT' | 'REFUND_AMOUNT' | 'COMMISSION' | 'OFFSET' | 'OTHER';

/** 이의 사유 다섯(openapi createPartnerSettlementDispute reasonCode, SCR-023과 같은 말) */
export const DISPUTE_REASONS: readonly { code: DisputeReasonCode; label: string; help: string }[] = [
  { code: 'GROSS_AMOUNT', label: '판매 대금 차이', help: '승인된 결제 금액의 합이 판매 기록과 다릅니다' },
  { code: 'REFUND_AMOUNT', label: '환급 금액 차이', help: '취소·환불 금액의 합이나 공제가 다릅니다' },
  { code: 'COMMISSION', label: '중개수수료·부가세 차이', help: '적용한 수수료율이나 계산이 계약과 다릅니다' },
  { code: 'OFFSET', label: '미수금 상계 차이', help: '상계한 미수금의 금액이나 근거가 다릅니다' },
  { code: 'OTHER', label: '그 밖의 사유', help: '위에 없는 사유입니다. 설명을 적어야 보냅니다' },
];

/** 이의 제기 오류 → 화면 안내 글. 서버 title·detail 원문은 싣지 않는다 */
export function disputeProblemMessage(problem: ProblemShape): string {
  if (problem.status === 409 && problem.type === 'settlement-dispute-window-closed') return '이의 기간이 끝났습니다';
  if (problem.status === 409) return '지금은 이의를 낼 수 없는 정산서입니다. 새로 고친 뒤 다시 확인해 주세요';
  if (problem.status === 422) return '그 밖의 사유는 설명을 적어야 보냅니다';
  if (problem.status === 400) return '이의 사유를 다시 골라 주세요';
  if (problem.status === 403) return '이 작업은 파트너 관리자만 할 수 있습니다';
  if (problem.status >= 500) return '지금은 이의를 낼 수 없습니다. 잠시 뒤 다시 시도해 주세요';
  return '이의를 내지 못했습니다. 다시 시도해 주세요';
}
