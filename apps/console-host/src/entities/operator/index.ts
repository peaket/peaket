// 관제 운영자와 역할(목업). 이름은 지어낸 이름이고 이메일은 예시 도메인이다(실제 사람 아님).
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';

/**
 * 역할과 따로 붙는 지정(docs/security/authz-matrix.md §3.7). 토큰에 싣지 않고 서버가 요청마다 본다.
 * 한 계정에 둘을 함께 두지 않는다(ADR-0171 결정 7). 콘솔은 GET /v1/ops/auth/sessions/me로 알아 온다(데이터 연결 단계).
 */
export type Designation = 'FRAUD_INVESTIGATOR' | 'PSEUDONYM_HANDLER';

export interface Operator {
  name: string;
  initial: string;
  email: string;
  role: ConsoleRole;
  /** 살아 있는 지정(없으면 빈 목록) */
  designations?: readonly Designation[];
}

export const ROLES: readonly ConsoleRole[] = ['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'];

/** 역할마다 한 사람(?role=로 바꿔 본다). 보드: commander 수진, viewer 서연, operator 민호 */
export const OPERATORS: Record<ConsoleRole, Operator> = {
  commander: { name: '수진', initial: '수', email: 'sujin@ops.peaket.example', role: 'commander' },
  operator: { name: '민호', initial: '민', email: 'minho@ops.peaket.example', role: 'operator' },
  viewer: { name: '서연', initial: '서', email: 'seoyeon@ops.peaket.example', role: 'viewer' },
  cs_agent: { name: '지우', initial: '지', email: 'jiwoo@cs.peaket.example', role: 'cs_agent' },
  cs_lead: { name: '하린', initial: '하', email: 'harin@cs.peaket.example', role: 'cs_lead' },
};

/**
 * 부정 거래 조사 목업의 사람(지어낸 이름, add-fraud-investigation-screens design.md 결정 3).
 * 도윤·예린은 부정 거래 조사관, 태오는 가명정보 취급자 commander다. 승인자는 지정이 없는 commander 수진(OPERATORS.commander)이다.
 */
export const DESIGNATED: Record<'investigator' | 'investigator2' | 'pseudonym', Operator> = {
  investigator: { name: '도윤', initial: '도', email: 'doyun@cs.peaket.example', role: 'cs_lead', designations: ['FRAUD_INVESTIGATOR'] },
  investigator2: { name: '예린', initial: '예', email: 'yerin@ops.peaket.example', role: 'commander', designations: ['FRAUD_INVESTIGATOR'] },
  pseudonym: { name: '태오', initial: '태', email: 'taeo@ops.peaket.example', role: 'commander', designations: ['PSEUDONYM_HANDLER'] },
};

/** ?designation= 값(퍼블리싱): investigator · pseudonym · none */
export type DesignationChoice = 'investigator' | 'pseudonym' | 'none';

export function isDesignationChoice(v: string | null | undefined): v is DesignationChoice {
  return v === 'investigator' || v === 'pseudonym' || v === 'none';
}

export function designationsOf(choice: DesignationChoice): readonly Designation[] {
  return choice === 'investigator' ? ['FRAUD_INVESTIGATOR'] : choice === 'pseudonym' ? ['PSEUDONYM_HANDLER'] : [];
}

/** 부정 거래 조사 화면을 여는 사람인지(commander·cs_lead이면서 조사관 지정, control-tower §9.2) */
export function isInvestigator(role: ConsoleRole, designations: readonly Designation[] | undefined): boolean {
  return (role === 'commander' || role === 'cs_lead') && !!designations?.includes('FRAUD_INVESTIGATOR');
}

export function isRole(v: string | null | undefined): v is ConsoleRole {
  return !!v && (ROLES as readonly string[]).includes(v);
}
