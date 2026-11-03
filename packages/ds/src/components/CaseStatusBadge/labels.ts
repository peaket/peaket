// CMP-081 CaseStatusBadge의 글과 색 단계(d2 CMP-081, d5 §7.18·§7.19). openapi 열거값을 화면 글로 옮긴다.
// 실행 때 가져오는 것이 없다(Node 내장 시험 실행기가 그대로 읽는다, labels.test.mjs). 점수 원값·가중치는 두지 않는다(범주만, POL-046 ⑦).
import type { BadgeTone } from '../Badge/Badge';

export interface StatusLook {
  label: string;
  tone: BadgeTone;
}

/** 사건 상태(openapi FraudCaseStatus) */
export const CASE_STATUS = {
  INVESTIGATING: { label: '조사 중', tone: 'primary' },
  APPEAL_PENDING: { label: '소명 대기', tone: 'warning' },
  DECISION_PENDING: { label: '결정 대기', tone: 'warning' },
  ACTIONED: { label: '조치됨', tone: 'danger' },
  OBJECTED: { label: '이의 접수', tone: 'warning' },
  CLEARED: { label: '정상 종료', tone: 'success' },
  REVERSED: { label: '이의 인정', tone: 'outline' },
} as const satisfies Record<string, StatusLook>;

/** 계정 소명 결과(openapi FraudClusterMember.appealResult) */
export const APPEAL_RESULT = {
  NOT_REQUESTED: { label: '요청 전', tone: 'outline' },
  PENDING: { label: '기다림', tone: 'neutral' },
  SUBMITTED: { label: '냄·판단 전', tone: 'primary' },
  ACCEPTED: { label: '인정', tone: 'success' },
  REJECTED: { label: '불인정', tone: 'danger' },
  EXPIRED: { label: '기한까지 안 냄', tone: 'warning' },
} as const satisfies Record<string, StatusLook>;

/** 점수 범주(openapi FraudCluster.scoreBand) */
export const SCORE_BAND = {
  HIGH: { label: '높음', tone: 'danger' },
  MEDIUM: { label: '중간', tone: 'warning' },
  LOW: { label: '낮음', tone: 'neutral' },
} as const satisfies Record<string, StatusLook>;

export type CaseStatusValue = keyof typeof CASE_STATUS;
export type AppealResultValue = keyof typeof APPEAL_RESULT;
export type ScoreBandValue = keyof typeof SCORE_BAND;
