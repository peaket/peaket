// 판매 정책 규칙 읽기(ADR-0261 결정 3): 안전한 JSON 읽기(__proto__·constructor·prototype 거부) → 닫힌 Zod(모양) → 뜻 검사(코드).
// 모양 오류는 던지고(UnsafeKeyError·SalePolicyShapeError·SyntaxError, 서버는 400), 뜻 오류는 규칙 차례·JSON 경로·코드로 돌려준다(서버는 422 sale-policy-invalid).
// 명단 키가 지금 명단으로 있는지는 보지 않는다(명단을 규칙보다 나중에 올릴 수 있다. 판매 승인이 본다).
import { parseJsonSafe, UnsafeKeyError } from '../safe-json.js';
import { bandCap } from './pol032.js';
import { type Condition, type FactCondition, type Outcome, RulesSchema, type SalePolicyRule } from './schema.js';

export type SalePolicyCode =
  | 'UNKNOWN_FACT'
  | 'OPERATOR_MISMATCH'
  | 'TOO_DEEP'
  | 'TOO_MANY_CONDITIONS'
  | 'RULE_TOO_LARGE'
  | 'TOO_MANY_RULES'
  | 'WINDOW_INVALID'
  | 'UNKNOWN_ROUND'
  | 'UNKNOWN_GRADE'
  | 'LIST_KEY_INVALID'
  | 'LIMIT_ABOVE_EVENT'
  | 'RULE_KIND_INVALID'
  | 'REFUND_BAND_OVERLAP'
  | 'REFUND_RATE_ABOVE_CAP'
  | 'TOO_MANY_REFUND_BANDS';

/** rule: 규칙 차례(0부터), path: 규칙 안의 JSON 경로(예 /rule/if/all/0/has) */
export interface SalePolicyIssue {
  rule: number;
  path: string;
  code: SalePolicyCode;
}

/** 저장 검사의 맥락: 그 공연의 회차(변경분의 더한 회차 포함)와 회차 1인 한도, 배치본의 등급 ID */
export interface SalePolicyContext {
  rounds: readonly { eventId: string; perPersonLimit: number }[];
  grades: readonly string[];
}

export type SalePolicyParse = { ok: true; rules: SalePolicyRule[] } | { ok: false; errors: SalePolicyIssue[] };

/** 모양이 정의와 다르다(정의 밖 칸·연산자·결과 종류, 범위 밖 수, 너무 깊은 값) */
export class SalePolicyShapeError extends SyntaxError {
  constructor(readonly path: string) {
    super(`판매 정책 규칙의 모양이 틀렸다: ${path || '/'}`);
    this.name = 'SalePolicyShapeError';
  }
}

// 상한(d5 §6.7, ADR-0261 결정 3 [가정])
const MAX_RULES = 20;
const MAX_LEAVES = 10;
const MAX_DEPTH = 3;
const MAX_RULE_BYTES = 8 * 1024;
const MAX_ERRORS = 50;
/** 한 회차에 걸리는 공제율 구간 수 상한(공개 요약 refundFees maxItems, 리뷰 A1) */
const MAX_BANDS_PER_ROUND = 20;
/** 모양을 보기 전 값의 깊이 상한(규칙 문법이 쓰는 깊이보다 넉넉하다). 깊은 값이 재귀 검사로 스택을 다 쓰지 않게 막는다 */
const MAX_RAW_DEPTH = 32;

const FACTS = ['buyer.lists', 'round', 'grade', 'quantity'] as const;
const OPERATORS = ['has', 'eq', 'in', 'lte', 'gte'] as const;
const LIST_KEY = /^[a-z0-9-]{3,32}$/;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
/** 시간대를 붙인 ISO 8601. 계약(format: date-time)과 같게 초가 있어야 하고 소수 초 자릿수는 묶지 않는다(리뷰 A4) */
const OFFSET_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

/** 시간대가 붙은 ISO 8601이면 그 시각(ms), 아니면 undefined(날짜·시각 칸의 범위까지 본다) */
function offsetTime(s: string): number | undefined {
  const m = OFFSET_DATE_TIME.exec(s);
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > days || h > 23 || mi > 59 || se > 59) return undefined;
  if (m[7] !== 'Z' && (Number(m[8]) > 23 || Number(m[9]) > 59)) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

/** 쓸 수 없는 키와 깊이를 모양 검사보다 먼저 본다(이미 읽은 값으로 받아도 같은 규칙) */
function guard(value: unknown): void {
  const stack: { v: unknown; depth: number }[] = [{ v: value, depth: 0 }];
  while (stack.length > 0) {
    const { v, depth } = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (depth > MAX_RAW_DEPTH) throw new SalePolicyShapeError('');
    for (const k of Object.keys(v)) {
      if (UNSAFE.has(k)) throw new UnsafeKeyError(k);
      stack.push({ v: (v as Record<string, unknown>)[k], depth: depth + 1 });
    }
  }
}

/**
 * 규칙 배열(JSON 글 또는 읽은 값)을 읽는다. 모양이 틀리면 던지고, 뜻 검사에 걸리면 오류 목록(50개까지)을 돌려준다
 * @throws UnsafeKeyError __proto__·constructor·prototype 키
 * @throws SalePolicyShapeError 정의 밖 칸·연산자·결과 종류, 범위 밖 수
 * @throws SyntaxError JSON이 아님
 */
export function parseSalePolicy(input: string | unknown, ctx: SalePolicyContext): SalePolicyParse {
  const value = typeof input === 'string' ? parseJsonSafe(input) : input;
  guard(value);
  const shaped = RulesSchema.safeParse(value);
  if (!shaped.success) {
    const issue = shaped.error.issues[0];
    throw new SalePolicyShapeError(issue ? `/${issue.path.map(String).join('/')}` : '');
  }
  // 회차 ID는 소문자로 읽는다(UUID는 대소문자를 가리지 않는다, 리뷰 A4)
  const rules = (shaped.data as SalePolicyRule[]).map(lowerRounds);
  if (rules.length > MAX_RULES) return { ok: false, errors: [{ rule: MAX_RULES, path: '', code: 'TOO_MANY_RULES' }] };
  const errors: SalePolicyIssue[] = [];
  const roundLimits = new Map(ctx.rounds.map((r) => [r.eventId.toLowerCase(), r.perPersonLimit]));
  const grades = new Set(ctx.grades);
  rules.forEach((r, i) => {
    const add = (path: string, code: SalePolicyCode) => errors.push({ rule: i, path, code });
    checkRule(r, add, roundLimits, grades);
    checkBandsAcrossRules(rules, i, add, roundLimits);
    checkBandCount(rules, i, add, roundLimits);
  });
  return errors.length === 0 ? { ok: true, rules } : { ok: false, errors: errors.slice(0, MAX_ERRORS) };
}

type Add = (path: string, code: SalePolicyCode) => void;

function checkRule(r: SalePolicyRule, add: Add, roundLimits: Map<string, number>, grades: Set<string>): void {
  if (new TextEncoder().encode(JSON.stringify(r)).length > MAX_RULE_BYTES) add('', 'RULE_TOO_LARGE');
  if ((r.rule === undefined) === (r.refundFee === undefined)) add('', 'RULE_KIND_INVALID');
  else if (r.refundFee !== undefined && r.during !== undefined) add('/during', 'RULE_KIND_INVALID');
  if (r.during) {
    const from = offsetTime(r.during.from);
    const to = r.during.to === undefined ? undefined : offsetTime(r.during.to);
    if (from === undefined) add('/during/from', 'WINDOW_INVALID');
    else if (r.during.to !== undefined && (to === undefined || to <= from)) add('/during/to', 'WINDOW_INVALID');
  }
  if (r.rounds !== 'ALL') r.rounds.forEach((id, j) => roundLimits.has(id) || add(`/rounds/${j}`, 'UNKNOWN_ROUND'));
  if (r.rule) {
    if (r.rule.if !== undefined) checkCondition(r.rule.if, add, roundLimits, grades);
    const cap = roundCap(r, roundLimits);
    const limitOf = (o: Outcome | undefined, path: string) => {
      if (o && 'limitPerPerson' in o && cap !== undefined && o.limitPerPerson > cap) add(path, 'LIMIT_ABOVE_EVENT');
    };
    limitOf(r.rule.then, '/rule/then/limitPerPerson');
    limitOf(r.rule.else, '/rule/else/limitPerPerson');
  }
  r.refundFee?.forEach((b, j) => {
    const { gte, lte } = b.daysLeft;
    if (gte > lte) return add(`/refundFee/${j}/daysLeft`, 'WINDOW_INVALID');
    if (b.rate > bandCap(gte, lte)) add(`/refundFee/${j}/rate`, 'REFUND_RATE_ABOVE_CAP');
    if (r.refundFee!.slice(0, j).some((x) => overlaps(x.daysLeft, b.daysLeft))) add(`/refundFee/${j}/daysLeft`, 'REFUND_BAND_OVERLAP');
  });
}

/** 규칙이 걸리는 회차(이 공연의 것)의 1인 한도 가운데 가장 작은 값. 걸리는 회차가 없으면 undefined */
function roundCap(r: SalePolicyRule, roundLimits: Map<string, number>): number | undefined {
  const limits = r.rounds === 'ALL' ? [...roundLimits.values()] : r.rounds.flatMap((id) => (roundLimits.has(id) ? [roundLimits.get(id)!] : []));
  return limits.length > 0 ? Math.min(...limits) : undefined;
}

const overlaps = (a: { gte: number; lte: number }, b: { gte: number; lte: number }) => a.gte <= b.lte && b.gte <= a.lte;

/** 같은 회차에 걸리는 앞 규칙의 공제율 구간과 겹치는가(구간은 정수 날이고 양 끝을 넣는다) */
function checkBandsAcrossRules(rules: readonly SalePolicyRule[], i: number, add: Add, roundLimits: Map<string, number>): void {
  const r = rules[i]!;
  if (!r.refundFee) return;
  const mine = roundsOf(r, roundLimits);
  const earlier = rules.slice(0, i).filter((x) => x.refundFee && [...roundsOf(x, roundLimits)].some((id) => mine.has(id)));
  r.refundFee.forEach((b, j) => {
    if (b.daysLeft.gte > b.daysLeft.lte) return;
    if (earlier.some((x) => x.refundFee!.some((y) => overlaps(y.daysLeft, b.daysLeft)))) add(`/refundFee/${j}/daysLeft`, 'REFUND_BAND_OVERLAP');
  });
}

/** 한 회차에 걸리는 공제율 구간 수가 이 규칙에서 20개 [가정]를 넘기 시작하면 그 규칙에 한 번 알린다(리뷰 A1) */
function checkBandCount(rules: readonly SalePolicyRule[], i: number, add: Add, roundLimits: Map<string, number>): void {
  const r = rules[i]!;
  if (!r.refundFee) return;
  const count = (upTo: number, id: string) => rules.slice(0, upTo).reduce((n, x) => n + (x.refundFee && roundsOf(x, roundLimits).has(id) ? x.refundFee.length : 0), 0);
  for (const id of roundsOf(r, roundLimits)) {
    if (count(i + 1, id) > MAX_BANDS_PER_ROUND && count(i, id) <= MAX_BANDS_PER_ROUND) return add('/refundFee', 'TOO_MANY_REFUND_BANDS');
  }
}

/** 회차 ID(규칙의 rounds와 round 사실 값)를 소문자로 바꾼 사본 */
function lowerRounds(r: SalePolicyRule): SalePolicyRule {
  const cond = (c: Condition): Condition => {
    if (isFact(c)) {
      if (c.fact !== 'round') return c;
      return { ...c, ...(typeof c.eq === 'string' ? { eq: c.eq.toLowerCase() } : {}), ...(c.in ? { in: c.in.map((v) => v.toLowerCase()) } : {}) };
    }
    if ('not' in c) return { not: cond(c.not) };
    return 'all' in c ? { all: c.all.map(cond) } : { any: c.any.map(cond) };
  };
  return {
    ...r,
    rounds: r.rounds === 'ALL' ? 'ALL' : r.rounds.map((id) => id.toLowerCase()),
    ...(r.rule ? { rule: { ...r.rule, ...(r.rule.if !== undefined ? { if: cond(r.rule.if) } : {}) } } : {}),
  };
}

const roundsOf = (r: SalePolicyRule, roundLimits: Map<string, number>) => new Set(r.rounds === 'ALL' ? roundLimits.keys() : r.rounds.filter((id) => roundLimits.has(id)));

const isFact = (c: Condition): c is FactCondition => 'fact' in c;

/** 조건 걸음: 깊이(잎이 1층)·잎 수·사실과 연산자 짝·명단 키 모양·회차·등급 참조 */
function checkCondition(root: Condition, add: Add, roundLimits: Map<string, number>, grades: Set<string>): void {
  let leaves = 0;
  let tooDeep = false;
  const walk = (c: Condition, path: string, depth: number) => {
    if (depth > MAX_DEPTH) {
      if (!tooDeep) add(path, 'TOO_DEEP');
      tooDeep = true;
      return;
    }
    if (isFact(c)) {
      leaves++;
      checkLeaf(c, path, add, roundLimits, grades);
      return;
    }
    if ('not' in c) return walk(c.not, `${path}/not`, depth + 1);
    const [name, list] = 'all' in c ? (['all', c.all] as const) : (['any', c.any] as const);
    list.forEach((x, k) => walk(x, `${path}/${name}/${k}`, depth + 1));
  };
  walk(root, '/rule/if', 1);
  if (leaves > MAX_LEAVES) add('/rule/if', 'TOO_MANY_CONDITIONS');
}

function checkLeaf(c: FactCondition, path: string, add: Add, roundLimits: Map<string, number>, grades: Set<string>): void {
  if (!(FACTS as readonly string[]).includes(c.fact)) return add(`${path}/fact`, 'UNKNOWN_FACT');
  const ops = OPERATORS.filter((op) => c[op] !== undefined);
  const op = ops[0];
  const pairOk =
    ops.length === 1 &&
    (c.fact === 'buyer.lists'
      ? op === 'has'
      : c.fact === 'quantity'
        ? (op === 'eq' && typeof c.eq === 'number') || op === 'lte' || op === 'gte'
        : (op === 'eq' && typeof c.eq === 'string') || op === 'in');
  if (!pairOk) return add(path, 'OPERATOR_MISMATCH');
  if (c.fact === 'buyer.lists') {
    if (!LIST_KEY.test(c.has!)) add(`${path}/has`, 'LIST_KEY_INVALID');
    return;
  }
  if (c.fact !== 'round' && c.fact !== 'grade') return;
  const known = (v: string) => (c.fact === 'round' ? roundLimits.has(v) : grades.has(v));
  const code = c.fact === 'round' ? 'UNKNOWN_ROUND' : 'UNKNOWN_GRADE';
  if (op === 'eq') {
    if (!known(c.eq as string)) add(`${path}/eq`, code);
  } else c.in!.forEach((v, k) => known(v) || add(`${path}/in/${k}`, code));
}
