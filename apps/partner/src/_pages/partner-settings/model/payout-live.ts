// SCR-020 '정산 계좌' 실제 판의 화면 모델(F-07-7, ADR-0370 결정 9, d5 §6.1 ⑥).
// 계약 GET /v1/partner/payout-account 본문을 화면 말로 바꾸고, PUT 오류(Problem)를 안내 글로 바꾼다.
// 계좌는 은행과 끝 4자리만 다룬다. 문제 본문의 detail 원문은 화면에 싣지 않는다(계좌번호가 섞여 들어와도 보이지 않게).
import type { ProblemShape } from '../../../shared/api/problem.ts';

export interface PayoutAccountRaw {
  bankCode: string | null;
  payoutAccountLast4: string | null;
  holderVerified: boolean;
  holdUntil: string | null;
  agencySyncPending: boolean;
  version: number;
}

export interface PayoutAccountView {
  empty: boolean;
  bankName: string | null;
  last4: string | null;
  masked: string | null;
  holderVerified: boolean;
  /** 보류 끝(KST 'M/D'), 보류 없으면 null */
  holdUntilText: string | null;
  agencySyncPending: boolean;
  version: number;
}

const KST_MONTH_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' });

/** ISO 시각 → KST 'M/D'. 읽지 못하면 null */
export function kstMonthDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = KST_MONTH_DAY.formatToParts(d);
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return month && day ? `${month}/${day}` : null;
}

/** 은행 코드 → 은행 이름(받은 목록에서). 목록에 없는 코드는 이름을 지어내지 않고 코드를 그대로 적는다 */
function bankNameOf(code: string | null, bankNames: Readonly<Record<string, string>>): string | null {
  if (!code) return null;
  return Object.prototype.hasOwnProperty.call(bankNames, code) ? (bankNames[code] ?? null) : `은행 코드 ${code}`;
}

export function payoutAccountView(raw: PayoutAccountRaw, bankNames: Readonly<Record<string, string>>): PayoutAccountView {
  const last4 = typeof raw.payoutAccountLast4 === 'string' && /^[0-9]{4}$/.test(raw.payoutAccountLast4) ? raw.payoutAccountLast4 : null;
  const empty = raw.bankCode === null || last4 === null;
  return {
    empty,
    bankName: empty ? null : bankNameOf(raw.bankCode, bankNames),
    last4: empty ? null : last4,
    masked: empty ? null : `****${last4}`,
    holderVerified: raw.holderVerified === true,
    holdUntilText: kstMonthDay(raw.holdUntil),
    agencySyncPending: raw.agencySyncPending === true,
    version: Number.isSafeInteger(raw.version) ? raw.version : 0,
  };
}

const AGENCY_LABEL: Readonly<Record<string, string>> = {
  TOSS_STANDARD: '토스페이먼츠 일반 상점',
  TOSS_ESCROW: '토스페이먼츠 에스크로 상점',
  PORTONE: '포트원',
};

type PayoutProblem = ProblemShape & { failedAgencies?: unknown };

function failedAgenciesOf(problem: PayoutProblem): string[] {
  const raw = Array.isArray(problem.failedAgencies) ? problem.failedAgencies : Array.isArray(problem.extensions?.failedAgencies) ? problem.extensions.failedAgencies : [];
  return raw.filter((a): a is string => typeof a === 'string' && a in AGENCY_LABEL).map((a) => AGENCY_LABEL[a] as string);
}

/** PUT /v1/partner/payout-account 오류 → 화면 안내 글(d5 §6.1, J-T42 ①). 서버 title·detail 원문은 싣지 않는다 */
export function payoutProblemMessage(problem: PayoutProblem): string {
  const type = problem.type;
  if (problem.status === 422 && type === 'payout-account-holder-mismatch') {
    return '예금주가 판매자 상호나 대표자와 같은 계좌만 받습니다. 판매자 상호나 대표자가 바뀌었으면 판매자 정보 확인을 먼저 요청해 주세요';
  }
  if (problem.status === 412) return '그 사이 다른 사람이 정산 계좌를 바꿨습니다. 지금 계좌를 다시 불러온 뒤 시도해 주세요';
  if (problem.status === 428) return '지금 계좌를 읽지 못했습니다. 화면을 다시 불러온 뒤 시도해 주세요';
  if (problem.status === 403 && type === 'reauth-required') return '재인증이 끝났거나 이미 썼습니다. 비밀번호·인증 앱 코드와 패스키로 다시 인증해 주세요';
  if (problem.status === 403) return '이 작업은 파트너 관리자만 할 수 있습니다';
  if (problem.status === 502 && type === 'payout-agency-update-failed') {
    const names = failedAgenciesOf(problem);
    const where = names.length > 0 ? names.join('·') : '결제사 한 곳 이상';
    return `${where}에 새 계좌를 반영하지 못했습니다. 결제사 수정 대기로 지급을 멈췄고, 다시 바꾸면 반영하지 못한 결제사에만 다시 보냅니다`;
  }
  if (problem.status === 409 && type === 'payout-seller-unverified') return '판매자 확인이 끝나지 않아 정산 계좌를 받을 수 없습니다. 판매 승인 요청에서 판매자 정보를 먼저 내 주세요';
  if (problem.status === 400) return '은행, 계좌번호(숫자 6~20자리), 예금주(100자 안)를 다시 확인해 주세요';
  if (problem.status === 503 && type === 'payout-holder-lookup-unavailable') return '지금은 예금주를 확인할 수 없습니다. 잠시 뒤 다시 시도해 주세요';
  if (problem.status >= 500) return '지금은 정산 계좌를 바꿀 수 없습니다. 잠시 뒤 다시 시도해 주세요';
  return '정산 계좌를 바꾸지 못했습니다. 다시 시도해 주세요';
}
