// 사후 포렌식 자체 법률 검토(ADR-0173)를 화면에 옮긴 규칙과 고정 문구(SCR-046·070·071, OpenSpec apply-legal-review-to-screens design.md 결정 5).
// 화면 안내용 규칙이다. 서버 규칙(409 fraud-summary-not-viewed, 422 approval-reason-required·approval-scope-invalid·restriction-too-long,
// 외부 게시물 422)의 정본은 openapi(ApprovalDecisionBody·ExternalPostCreate)와 docs/features/forensic-replay.md·control-tower.md §9.2다.
// 이 파일은 실행 때 가져오는 것이 없다(Node 내장 시험 실행기가 타입만 지우고 그대로 읽는다, rules.test.mjs). 시험을 먼저 쓰고 만들었다.
// 문구는 d5 §7.7·§7.18·§7.19·§9.2 글 그대로이고, d5의 [가정] 표시는 화면 글에 넣지 않는다.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KST_OFFSET = 9 * HOUR;

// ── SCR-046 부정 예매 조치(POL-038 ⑪, ADR-0173 결정 2) ──

/** 승인자 판단 이유 최대 글자 수(openapi ApprovalDecisionBody.reason maxLength) */
export const APPROVAL_REASON_MAX = 1000;
/** 판단 이유 칸 안내 */
export const APPROVAL_REASON_HINT = '요청자의 사유를 옮기지 말고, 요약을 보고 내가 판단한 이유를 적어 주세요';
/** 요약을 처음 연 시각 옆 안내 */
export const SUMMARY_VIEWED_NOTE = '이 열람 시각이 승인 기록에 함께 남습니다';
/** 대상 줄 아래 안내 */
export const APPROVAL_SCOPE_NOTE = '뺀 계정·표는 이 요청에서 반려한 것으로 보고, 그 계정에 다른 열린 조치 요청이 없으면 양도 잠금이 풀립니다';
/** 409 fraud-summary-not-viewed(d5 §9.2) */
export const ERR_FRAUD_SUMMARY_NOT_VIEWED = '사건 요약을 연 기록이 없어 승인하지 못했습니다. 요약을 다시 불러온 뒤 승인해 주세요';
/** 422 approval-scope-invalid(d5 §9.2) */
export const ERR_APPROVAL_SCOPE_INVALID = '뺄 수 있는 것은 이 요청에 든 계정·표뿐입니다. 모두 빼려면 반려해 주세요';

/** 코드 포인트 수(서버 JSON 스키마의 글자 수 세기와 같다) */
const length = (s: string) => Array.from(s).length;

/**
 * 승인 단추가 비활성인 이유(CMP-001 disabled-with-reason). 없으면 null(누를 수 있다).
 * 요약을 열기 전이 먼저이고, 대상을 모두 뺐으면 반려를 안내한다. 판단 이유가 빈 것은 비활성이 아니라 누를 때의 칸 오류다(approvalReasonError).
 */
export function approveBlockReason(input: { summaryViewed: boolean; remainingTickets: number }): string | null {
  if (!input.summaryViewed) return '사건 요약을 연 뒤에 승인할 수 있습니다';
  if (input.remainingTickets <= 0) return '모두 빼려면 반려해 주세요';
  return null;
}

/** 판단 이유 칸 오류(필수, 1~1000자). 없으면 null */
export function approvalReasonError(reason: string): string | null {
  if (reason.trim() === '') return '판단 이유를 적어 주세요';
  if (length(reason) > APPROVAL_REASON_MAX) return `판단 이유는 ${APPROVAL_REASON_MAX}자까지 적을 수 있습니다`;
  return null;
}

/** 승인 단추 글. 범위를 줄이면 남은 표 수와 뺀 표 수를 말한다 */
export function approveButtonText(totalTickets: number, excludedTickets: number): string {
  const left = totalTickets - excludedTickets;
  return excludedTickets > 0 ? `표 ${left}장 취소와 환급을 승인합니다(${excludedTickets}장 뺌)` : `표 ${totalTickets}장 취소와 환급을 승인합니다`;
}

/** 뺀 계정 줄(목록 순서 번호)을 빼고 남은 계정·표. 목록 밖 번호는 무시한다(요청 밖 값은 서버가 422로 거절한다) */
export function remainingScope(targets: readonly { ticketCount: number }[], excluded: readonly number[]): { accounts: number; tickets: number; excludedTickets: number } {
  let accounts = 0;
  let tickets = 0;
  let excludedTickets = 0;
  targets.forEach((t, i) => {
    if (excluded.includes(i)) excludedTickets += t.ticketCount;
    else {
      accounts += 1;
      tickets += t.ticketCount;
    }
  });
  return { accounts, tickets, excludedTickets };
}

/** 대상 줄 이름 '계정 1'(목록 순서로 붙인다. 계정 ID는 화면에 보이지 않고 본문 excludeAccountIds에만 쓴다) */
export function targetLabel(index: number): string {
  return `계정 ${index + 1}`;
}

// ── SCR-071 사건 작업대(FR-073·074, ADR-0173 결정 3·4·5·6·7) ──

/** 소명 요청의 양도 잠금 안내(ADR-0173 결정 3) */
export const APPEAL_LOCK_NOTICE = '소명을 요청하면 이 표들의 양도가 잠깁니다. 늦어도 14일 뒤 풀립니다';
/** 양도 잠금 최대 기간(일, 연장 없음 [가정]) */
export const LOCK_MAX_DAYS = 14;
/** 받은 사람 안내(ADR-0173 결정 4) */
export const HOLDER_NOTICE = '이 계정들이 결제해 다른 분에게 양도한 표가 있으면, 그 표를 가진 분에게도 같은 기한으로 사정을 알릴 기회를 드립니다(사유 범주는 알리지 않음)';
/** 조사관 의견 칸 안내(ADR-0173 결정 5) */
export const OPINION_HINT = '행동 요약은 세션 하나가 자동화인지 보는 근거로만 적습니다. 계정끼리 행동이 비슷하다는 것을 같은 사람·명의 대여의 근거로 적지 않습니다';
/** 422 restriction-too-long(ADR-0173 결정 7) */
export const RESTRICTION_TOO_LONG = '부정 예매 이용 제한은 요청한 날부터 1년까지만 정할 수 있습니다. 더 늘리려면 끝나기 전에 새로 요청해 주세요';
/** 고소·고발용 요약을 받은 뒤 안내(ADR-0173 결정 6) */
export const COMPLAINT_NOTE = '계정·연락처·IP 같은 개인정보는 들어 있지 않습니다. 수사기관 제출은 영장이나 공연법 요청을 받은 뒤 기관 제출로만 합니다';

/** 양도 잠금 최대 기한 = 그 계정의 첫 소명 요청 + 14일(같은 계정에 다시 요청해도 늘지 않는다) */
export function transferLockExpiresAt(firstAppealRequestIso: string): string {
  return new Date(Date.parse(firstAppealRequestIso) + LOCK_MAX_DAYS * DAY).toISOString();
}

/** 잠금 최대 기한이 지난 계정이 있을 때의 안내(모두면 사건 머리 아래 안내, 일부면 계정 수). 없으면 null */
export function lockReleasedNotice(releasedAccounts: number, totalAccounts: number): string | null {
  if (releasedAccounts <= 0) return null;
  if (releasedAccounts >= totalAccounts) return `소명 요청 ${LOCK_MAX_DAYS}일이 지나 양도 잠금이 풀렸습니다. 조사와 조치 요청은 계속할 수 있습니다`;
  return `계정 ${releasedAccounts}개의 양도 잠금이 최대 기한이 지나 풀렸습니다`;
}

/** 이용 제한 끝의 상한 = 요청 + 1년(KST 달력). 다음 해에 같은 날이 없으면(2월 29일) 그달의 마지막 날로 줄인다 */
export function restrictionEndMax(requestIso: string): string {
  const k = new Date(Date.parse(requestIso) + KST_OFFSET);
  const y = k.getUTCFullYear() + 1;
  const m = k.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = Math.min(k.getUTCDate(), lastDay);
  const ms = Date.UTC(y, m, d, k.getUTCHours(), k.getUTCMinutes(), k.getUTCSeconds(), k.getUTCMilliseconds()) - KST_OFFSET;
  return new Date(ms).toISOString();
}

/** 이용 제한 끝 칸 오류. 없으면 null */
export function restrictionEndError(requestIso: string, endIso: string): string | null {
  const end = Date.parse(endIso);
  if (end <= Date.parse(requestIso)) return '이용 제한 끝은 요청한 때보다 뒤여야 합니다';
  if (end > Date.parse(restrictionEndMax(requestIso))) return RESTRICTION_TOO_LONG;
  return null;
}

/** 증거 묶음 내보내기 종류(openapi EvidenceExport.kind) */
export const EXPORT_KINDS = ['AUTHORITY', 'PROMOTER', 'COMPLAINT'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const EXPORT_KIND_LABEL: Readonly<Record<ExportKind, string>> = {
  AUTHORITY: '기관 제출(접수된 자료 요청 번호 필수)',
  PROMOTER: '기획사 보고(회차 집계만)',
  COMPLAINT: '고소·고발용 요약(개인정보 없음)',
};

/** 고소·고발용 요약 파일 이름 */
export function complaintFileName(caseId: string): string {
  return `complaint-${caseId}.json`;
}

// ── SCR-070 사건 목록(FR-072, ADR-0173 결정 9) ──

/** 외부 게시물 등록 확인 칸 셋(모두 체크해야 등록 단추가 켜진다) */
export const POST_CHECKS = [
  '로그인 없이 누구나 볼 수 있는 공개 게시물입니다(비공개 모임·받은 메시지가 아닙니다)',
  '게시물 한 건의 화면만 캡처했습니다',
  '작성자 프로필·다른 글을 찾거나 닉네임·연락처를 검색하지 않았습니다',
] as const;

/** 가릴 자리를 고르지 않았을 때 안내 */
export const MASK_NONE_HINT = '가릴 자리가 없으면 그대로 등록합니다';
/** 외부 게시물 등록 422(신고 건이 외부 되팔이 게시물 신고가 아님, d5 §9.2) */
export const ERR_REPORT_SOURCE = "신고 출처에는 문의 유형이 '외부 되팔이 게시물 신고'인 건 번호만 넣을 수 있습니다";

/** 확인 칸 셋을 모두 체크했는지 */
export function postRegisterEnabled(checks: readonly boolean[]): boolean {
  return checks.length === POST_CHECKS.length && checks.every(Boolean);
}

/** 신고 출처 규칙: 출처가 신고(REPORT)면 그 CS 처리함 건의 문의 유형이 RESALE_POST_REPORT여야 한다. 직접 찾음(MANUAL)은 건 번호가 없다 */
export function reportSourceError(source: 'REPORT' | 'MANUAL', inquiryCategory: string | null): string | null {
  if (source === 'MANUAL') return null;
  return inquiryCategory === 'RESALE_POST_REPORT' ? null : ERR_REPORT_SOURCE;
}

/** 자동 다시 시도 횟수(처음 셋 [가정], openapi FraudClusterRun.autoRetriesLeft) */
export const AUTO_RETRY_MAX = 3;

/** '후보 만들기 다시 시도 중' 글. 남은 자동 다시 시도가 없으면 null('후보 만들기 실패' 상태다) */
export function candidateRetryText(autoRetriesLeft: number): string | null {
  if (autoRetriesLeft <= 0) return null;
  const n = AUTO_RETRY_MAX - Math.min(autoRetriesLeft, AUTO_RETRY_MAX) + 1;
  return `후보 묶음을 만들지 못해 자동으로 다시 하고 있습니다(${n}/${AUTO_RETRY_MAX})`;
}
