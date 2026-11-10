// 판매 정책 규칙 문법 1판의 모양(닫힌 Zod, docs/design/d5 §6.7, ADR-0261 결정 3). 모든 칸이 닫혀 있다(정의 밖 칸·연산자·결과 종류는 모양 오류).
// 뜻 규칙(사실과 연산자 짝, 깊이·조건 수·크기·규칙 수, 창, 회차·등급 참조, 명단 키 모양, 한도, 공제율)은 parse.ts가 코드로 본다.
// 계약 생성 스키마(@peaket/contracts)는 가져오지 않는다(서비스가 모든 태그의 스키마를 싣지 않게, ADR-0261 결정 11).
import { z } from 'zod';

/** 거부 사유(d5 §6.7): PRESALE_ONLY 선예매 기간이라 대상만 구매, GRADE_NOT_ON_SALE 이 등급은 지금 판매하지 않음 */
export const DENY_REASONS = ['PRESALE_ONLY', 'GRADE_NOT_ON_SALE'] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

/** 조건의 잎: 사실 하나와 연산자 하나. 사실 이름과 연산자 짝은 뜻 검사가 본다(UNKNOWN_FACT·OPERATOR_MISMATCH) */
export interface FactCondition {
  fact: string;
  has?: string;
  eq?: string | number;
  in?: string[];
  lte?: number;
  gte?: number;
}
export type Condition = FactCondition | { all: Condition[] } | { any: Condition[] } | { not: Condition };
export type Outcome = { limitPerPerson: number } | { deny: DenyReason } | { allow: true };
export interface RefundBand {
  daysLeft: { gte: number; lte: number };
  rate: number;
}

/** 규칙 하나. rule(구매 자격·매수)과 refundFee(취소 공제율) 가운데 꼭 하나이고 during은 rule에만 쓴다(뜻 검사 RULE_KIND_INVALID) */
export interface SalePolicyRule {
  version: 1;
  name: string;
  rounds: 'ALL' | string[];
  during?: { from: string; to?: string };
  rule?: { if?: Condition; then: Outcome; else?: Outcome };
  refundFee?: RefundBand[];
}

/** 이름 길이는 코드 포인트로 센다(계약 maxLength와 같다) */
const codePoints = (s: string) => [...s].length;

const Leaf = z
  .object({
    fact: z.string(),
    has: z.string().optional(),
    eq: z.union([z.string(), z.int()]).optional(),
    in: z.array(z.string()).min(1).max(60).optional(),
    lte: z.int().min(1).max(10).optional(),
    gte: z.int().min(1).max(10).optional(),
  })
  .strict();

// 깊이는 뜻 검사가 센다(TOO_DEEP). 모양은 재귀로 받되, 읽기 전 걸음(parse.ts)이 아주 깊은 값을 먼저 막는다
const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    Leaf,
    z.object({ all: z.array(ConditionSchema).min(1).max(10) }).strict(),
    z.object({ any: z.array(ConditionSchema).min(1).max(10) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
  ]),
) as z.ZodType<Condition>;

const OutcomeSchema = z.union([
  z.object({ limitPerPerson: z.int().min(1).max(10) }).strict(),
  z.object({ deny: z.enum(DENY_REASONS) }).strict(),
  z.object({ allow: z.literal(true) }).strict(),
]);

const BandSchema = z
  .object({
    daysLeft: z.object({ gte: z.int().min(0).max(365), lte: z.int().min(0).max(365) }).strict(),
    rate: z.int().min(0).max(100),
  })
  .strict();

const RuleSchema = z
  .object({
    version: z.literal(1),
    name: z.string().refine((s) => codePoints(s) >= 1 && codePoints(s) <= 40, '이름은 1~40자'),
    rounds: z.union([z.literal('ALL'), z.array(z.string()).min(1).max(60).refine((a) => new Set(a).size === a.length, '회차가 겹친다')]),
    during: z.object({ from: z.string(), to: z.string().optional() }).strict().optional(),
    rule: z.object({ if: ConditionSchema.optional(), then: OutcomeSchema, else: OutcomeSchema.optional() }).strict().optional(),
    refundFee: z.array(BandSchema).min(1).max(10).optional(),
  })
  .strict();

/** 규칙 배열(규칙 수 상한은 뜻 검사 TOO_MANY_RULES) */
export const RulesSchema = z.array(RuleSchema);
