// 조건·결과 계산(내부, 공개하지 않는다). 사실을 모르면(진입 때의 등급·매수) 참·거짓·모름 셋값으로 계산한다(ADR-0261 결정 3).
import type { Condition, FactCondition, Outcome, SalePolicyRule } from './schema.js';

/** 참·거짓·모름(undefined) */
export type Tri = boolean | undefined;

/** 조건에 쓰는 사실. grade·quantity가 없으면 모름이다 */
export interface Facts {
  round: string;
  lists: readonly string[];
  grade?: string;
  quantity?: number;
}

const isFact = (c: Condition): c is FactCondition => 'fact' in c;

function leaf(c: FactCondition, f: Facts): Tri {
  switch (c.fact) {
    case 'buyer.lists':
      return typeof c.has === 'string' && f.lists.includes(c.has);
    case 'round':
      if (c.eq !== undefined) return f.round === c.eq;
      return c.in !== undefined && c.in.includes(f.round);
    case 'grade':
      if (f.grade === undefined) return undefined;
      if (c.eq !== undefined) return f.grade === c.eq;
      return c.in !== undefined && c.in.includes(f.grade);
    case 'quantity':
      if (f.quantity === undefined) return undefined;
      if (c.eq !== undefined) return f.quantity === c.eq;
      if (c.lte !== undefined) return f.quantity <= c.lte;
      return c.gte !== undefined && f.quantity >= c.gte;
    default:
      // 읽기(parseSalePolicy)를 지난 규칙에는 없다. 모르는 사실은 참으로 보지 않는다
      return false;
  }
}

/** 셋값 논리: all은 거짓이 하나라도 있으면 거짓, 아니면 모름이 있으면 모름. any는 참이 하나라도 있으면 참, 아니면 모름이 있으면 모름. not(모름)은 모름 */
export function evalCondition(c: Condition, f: Facts): Tri {
  if (isFact(c)) return leaf(c, f);
  if ('not' in c) {
    const v = evalCondition(c.not, f);
    return v === undefined ? undefined : !v;
  }
  if ('all' in c) {
    let unknown = false;
    for (const x of c.all) {
      const v = evalCondition(x, f);
      if (v === false) return false;
      if (v === undefined) unknown = true;
    }
    return unknown ? undefined : true;
  }
  let unknown = false;
  for (const x of c.any) {
    const v = evalCondition(x, f);
    if (v === true) return true;
    if (v === undefined) unknown = true;
  }
  return unknown ? undefined : false;
}

const timeOf = (s: string | undefined) => (s === undefined ? undefined : Date.parse(s));

/** 걸리는 규칙: rule 규칙이고, rounds에 그 회차가 들고(ALL 포함), during이 없거나 from ≤ at < to(to가 없으면 끝 없음) */
export function applies(r: SalePolicyRule, round: string, at: number): boolean {
  if (!r.rule) return false;
  if (r.rounds !== 'ALL' && !r.rounds.includes(round)) return false;
  if (!r.during) return true;
  const from = timeOf(r.during.from)!;
  const to = timeOf(r.during.to);
  return from <= at && (to === undefined || at < to);
}

/**
 * 규칙 하나가 낼 수 있는 결과(null은 '적용되지 않음'). 조건이 없거나 참이면 then, 거짓이면 else(없으면 null),
 * 모름이면 둘 다 나올 수 있다
 */
export function outcomes(r: SalePolicyRule, f: Facts): (Outcome | null)[] {
  const rule = r.rule!;
  if (rule.if === undefined) return [rule.then];
  const v = evalCondition(rule.if, f);
  if (v === true) return [rule.then];
  if (v === false) return [rule.else ?? null];
  return [rule.then, rule.else ?? null];
}

/** 나올 수 있는 한도 가운데 가장 작은 값(거부는 빼고 보며 회차 1인 한도를 넘지 않는다) */
export function smallestLimit(rules: readonly SalePolicyRule[], f: Facts, at: number, roundLimit: number): number {
  let limit = roundLimit;
  for (const r of rules) {
    if (!applies(r, f.round, at)) continue;
    for (const o of outcomes(r, f)) if (o && 'limitPerPerson' in o) limit = Math.min(limit, o.limitPerPerson);
  }
  return limit;
}

/** 조건에 쓰인 명단 키(규칙 차례, 처음 나온 차례) */
export function listKeysOf(c: Condition | undefined, out: string[] = []): string[] {
  if (c === undefined) return out;
  if (isFact(c)) {
    if (c.fact === 'buyer.lists' && typeof c.has === 'string' && !out.includes(c.has)) out.push(c.has);
    return out;
  }
  if ('not' in c) return listKeysOf(c.not, out);
  for (const x of 'all' in c ? c.all : c.any) listKeysOf(x, out);
  return out;
}
