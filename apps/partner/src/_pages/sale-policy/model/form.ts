// SCR-024 규칙 폼 ↔ 규칙 AST(ADR-0261 결정 3·13). 화면과 시험이 같은 순수 함수를 쓴다.
import type { SalePolicyRule } from '@peaket/validation/sale-policy';

export type FormKind = 'presale' | 'grade' | 'refund';
export interface RuleForm {
  kind: FormKind;
  name: string;
  from: string;
  to: string;
  listKey: string;
  limit: number;
  grade: string;
  daysFrom: number;
  daysTo: number;
  rate: number;
}

export const DEFAULT_FORM: RuleForm = { kind: 'presale', name: '팬클럽 선예매', from: '', to: '', listKey: '', limit: 2, grade: 'R', daysFrom: 7, daysTo: 9, rate: 10 };

const iso = (v: string) => (v.length === 16 ? `${v}:00+09:00` : v);

/** 저장된 규칙의 종류 */
export function kindOf(r: SalePolicyRule): FormKind {
  if (r.refundFee) return 'refund';
  const cond = r.rule?.if;
  if (cond && 'fact' in cond && cond.fact === 'grade') return 'grade';
  return 'presale';
}

/** 목록에 보이는 한 줄 요약 */
export function summaryOf(r: SalePolicyRule): string {
  if (r.refundFee) return r.refundFee.map((b) => `${b.daysLeft.gte}~${b.daysLeft.lte}일 전 ${b.rate}%`).join(' · ');
  const then = r.rule?.then;
  if (then && 'deny' in then) return `거부(${then.deny})`;
  if (then && 'limitPerPerson' in then) return `1인 ${then.limitPerPerson}매`;
  return '허용';
}

/** 폼 값을 규칙 하나로. from이 비면 기간 없이(계속)다 */
export function ruleFromForm(f: RuleForm): SalePolicyRule {
  if (f.kind === 'refund') return { version: 1, name: f.name, rounds: 'ALL', refundFee: [{ daysLeft: { gte: f.daysFrom, lte: f.daysTo }, rate: f.rate }] };
  if (f.kind === 'grade') return { version: 1, name: f.name, rounds: 'ALL', rule: { if: { fact: 'grade', eq: f.grade }, then: { deny: 'GRADE_NOT_ON_SALE' } } };
  return {
    version: 1,
    name: f.name,
    rounds: 'ALL',
    ...(f.from ? { during: { from: iso(f.from), ...(f.to ? { to: iso(f.to) } : {}) } } : {}),
    rule: { if: { fact: 'buyer.lists', has: f.listKey }, then: { limitPerPerson: f.limit }, else: { deny: 'PRESALE_ONLY' } },
  };
}

/** 저장된 규칙을 폼 값으로 되돌린다(고치기) */
export function formOf(r: SalePolicyRule): RuleForm {
  const kind = kindOf(r);
  const cond = r.rule?.if;
  const then = r.rule?.then;
  return {
    ...DEFAULT_FORM,
    kind,
    name: r.name,
    from: r.during?.from ? r.during.from.slice(0, 16) : '',
    to: r.during?.to ? r.during.to.slice(0, 16) : '',
    listKey: cond && 'fact' in cond && cond.has ? cond.has : '',
    limit: then && 'limitPerPerson' in then ? then.limitPerPerson : 2,
    grade: cond && 'fact' in cond && typeof cond.eq === 'string' ? cond.eq : 'R',
    daysFrom: r.refundFee?.[0]?.daysLeft.gte ?? 7,
    daysTo: r.refundFee?.[0]?.daysLeft.lte ?? 9,
    rate: r.refundFee?.[0]?.rate ?? 10,
  };
}
