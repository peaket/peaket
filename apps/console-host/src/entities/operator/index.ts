// 관제 운영자와 역할(목업). 이름은 지어낸 이름이고 이메일은 예시 도메인이다(실제 사람 아님).
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';

export interface Operator {
  name: string;
  initial: string;
  email: string;
  role: ConsoleRole;
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

export function isRole(v: string | null | undefined): v is ConsoleRole {
  return !!v && (ROLES as readonly string[]).includes(v);
}
