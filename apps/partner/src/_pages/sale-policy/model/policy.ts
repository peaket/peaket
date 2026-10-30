// SCR-024 판매 정책 규칙 목업(보드 SCR-024-m·t·d, d5 §6.7의 두 예시 규칙). 합성 데이터다.
// 데이터를 잇는 단계에서 판매 정책 규칙 API(규칙 목록·자격 명단)와 @peaket/validation의 같은 Zod 스키마·평가 함수로 바꾼다.

export type RuleStatus = 'APPROVED' | 'DRAFT';

export interface PolicyRuleRow {
  id: 'fanclub-presale' | 'general' | 'refund-7-9';
  name: string;
  target: string;
  summary: string;
  status: RuleStatus;
}

export const RULE_STATUS: Record<RuleStatus, { cls: string; label: string }> = {
  APPROVED: { cls: 'badge badge-success', label: '승인' },
  DRAFT: { cls: 'badge', label: '초안' },
};

/** 등록 규칙(보드 순서). 취소 공제율 초안은 '입력 오류'·'상한 위반' 상태에서만 목록에 있다 */
export const PRESALE_RULE: PolicyRuleRow = {
  id: 'fanclub-presale',
  name: '팬클럽 선예매',
  target: '전 회차',
  summary: '팬클럽 회원 · 10/13(화) 20:00~22:00 KST · 1인 2매',
  status: 'APPROVED',
};
export const GENERAL_RULE: PolicyRuleRow = {
  id: 'general',
  name: '일반 예매',
  target: '전 회차',
  summary: '누구나 · 10/14(수) 20:00 KST부터 · 1인 4매',
  status: 'APPROVED',
};
export const REFUND_RULE: PolicyRuleRow = {
  id: 'refund-7-9',
  name: '7~9일 전 취소 공제율',
  target: '전 회차',
  summary: '관람일 7~9일 전 취소 · 공제율 20%',
  status: 'DRAFT',
};

/** 휴대폰 규칙 카드의 대상 줄 */
export const RULE_SCOPE = '대상: 전 회차(2개) · 좌석 2,400석';

/** 규칙 종류(d5 §6.7 '규칙 종류별 폼') */
export const RULE_KINDS = [
  { value: 'presale', label: '선예매 창·자격 명단·1인 한도' },
  { value: 'grade', label: '등급 판매 여부' },
  { value: 'refund', label: '취소 공제율 구간' },
] as const;

/** 읽기 전용 JSON(d5 §6.7 두 예시 그대로) */
export const PRESALE_JSON = `{
  "version": 1,
  "name": "팬클럽 선예매",
  "rounds": "ALL",
  "during": { "from": "2026-10-13T20:00+09:00", "to": "2026-10-13T22:00+09:00" },
  "rule": {
    "if": { "fact": "buyer.lists", "has": "lumen-fanclub-2026" },
    "then": { "limitPerPerson": 2 },
    "else": { "deny": "PRESALE_ONLY" }
  }
}`;

export const REFUND_JSON = `{
  "version": 1,
  "name": "7~9일 전 취소 공제율",
  "rounds": "ALL",
  "refundFee": [ { "daysLeft": { "gte": 7, "lte": 9 }, "rate": 20 } ]
}`;

/** 공제율 칸 옆 오류 글 */
export const RATE_ERROR = {
  input: '공제율 20%는 공연일 7~9일 전 상한 10%를 넘습니다(POL-032).',
  cap: '허용 범위를 넘었습니다. 관람일 7~9일 전 공제율은 10% 이하로만 정할 수 있습니다(POL-032).',
};

/** 시뮬레이션 · 팬클럽 선예매의 다른 경우 */
export const PRESALE_CASES: readonly { label: string; result: 'allow' | 'deny' | 'na'; note?: string }[] = [
  { label: '팬클럽 회원 A · 10/13(화) 20:30 · 2매', result: 'allow' },
  { label: '일반 회원 B · 10/13(화) 20:30 · 1매', result: 'deny', note: '선예매 기간' },
  { label: '일반 회원 B · 10/14(수) 20:00 · 4매', result: 'na', note: '기간 밖' },
];

export const CASE_RESULT: Record<'allow' | 'deny' | 'na', { cls: string; label: string }> = {
  allow: { cls: 'badge badge-success', label: '허용' },
  deny: { cls: 'badge badge-danger', label: '거부' },
  na: { cls: 'badge', label: '적용 안 됨' },
};

/** 자격 명단(d5 §6.7 '판매 자격 명단') */
export const FANCLUB_LIST = {
  name: 'LUMEN 팬클럽 2026',
  count: '12,345명',
  lockedAt: '10/12(월) 20:00 KST 잠금',
  key: 'lumen-fanclub-2026',
  usedBy: '팬클럽 선예매 · 10/13(화) 20:00 KST 판매 시작',
  uploadedBy: '파트너 관리자 · 10/11(일) 14:20 KST',
  result: {
    applied: '12,345명',
    badFormat: { count: '3줄', rows: '행 번호 118, 2,047, 9,310' },
    unknown: { count: '2줄', rows: '행 번호 4,512, 11,006' },
  },
} as const;
