// CS 처리함 건 종류별 기한 규칙(F-06-2 GAT-280, ADR-0364 결정 2).
// 값은 docs/features/transfer-refund.md §7.1 표와 docs/design/d5-screen-blueprint.md §7.6 표의 '기한' 칸이고, 줄마다 그 행을 적는다.
// 기한을 세는 시작(baseMs)은 건 요청의 dueBaseAt, 없으면 createdAt이다. 기한이 둘(진행·결과)인 건은 두 칸에, 하나인 건은 결과 칸에 둔다(d5 §7.6 끝 문단).
// 이 기능이 받지 않는 종류(ADR-0364 결정 4 밖)는 그 건을 받을 기능이 규칙을 더한다. 결제 뒤 미발권(TICKET_NOT_ISSUED)만 미리 둔다(계획 §1 '넘기는 것').
import { addBusinessDays, subtractBusinessDays, type BusinessCalendar } from './business-calendar.js';
import { nextDueOf, type CsCase, type CsCaseKind } from './cs-case.js';

const HOUR_MS = 60 * 60 * 1000;

/** 기한 하나: 영업일 수(같은 KST 시각) 또는 벽시계 시간 */
type Span = { readonly businessDays: number } | { readonly hours: number };
interface Rule {
  readonly progress?: Span;
  readonly result?: Span;
  /** 원래 승인 업무의 기한을 이어받는다(승인 업무 실행 실패) */
  readonly inherit?: true;
  /** 요청의 dueBaseAt(또는 createdAt)을 결과 기한으로 그대로 쓴다(F-06-4 FRAUD_CASE 소명) */
  readonly resultBase?: true;
}

const bd = (businessDays: number): Span => ({ businessDays });

/** 이상 표시(FLAGGED) 가운데 결과 3영업일인 세부(d5 §7.6 '예외 통과 사후 검토'·'현장 확인 결과 부정 의심·판단 불가' 행) */
const FLAGGED_REVIEW_CATEGORIES: ReadonlySet<string> = new Set(['OVERRIDE_REVIEW', 'SUSPECT', 'UNDETERMINED']);

function ruleOf(kind: CsCaseKind, category: string): Rule | undefined {
  switch (kind) {
    // d5 §7.6 '환급 실패'(3영업일)·'일괄 환불 실패'(회차 취소 확정 뒤 3영업일, 시작은 dueBaseAt), transfer-refund §7.1 '일괄 환불 실패' 행
    case 'REFUND_FAILED':
      return { result: bd(3) };
    // d5 §7.6 '이상 표시'(다음 영업일 = 1영업일, ADR-0364 결정 1). 사후 검토·현장 확인은 3영업일(같은 표의 두 행)
    case 'FLAGGED':
      return { result: bd(FLAGGED_REVIEW_CATEGORIES.has(category) ? 3 : 1) };
    // d5 §7.6 '판정 대기'(1영업일), transfer-refund §7.1 '판정 대기' 행
    case 'JUDGEMENT_PENDING':
      return { result: bd(1) };
    // d5 §7.6 '환불 대기'(기한 표시: 첫 요청 뒤 3영업일), transfer-refund §7.1 '환불 대기' 행
    case 'REFUND_ACCOUNT_PENDING':
      return { result: bd(3) };
    // d5 §7.6 '배상 대기'(회차 취소 확정 뒤 10영업일, 시작은 dueBaseAt), transfer-refund §7.1 '배상 대기' 행
    case 'COMPENSATION_PENDING':
      return { result: bd(10) };
    // d5 §7.6 '추가 검증 이의'(결과·설명 통지 10영업일). 온세일 중 판정 30분은 목표라 기한 칸에 두지 않는다
    case 'VERIFICATION_APPEAL':
      return { result: bd(10) };
    // d5 §7.6 '분쟁 접수'(경과 3영업일·결과 10영업일)·'양도 회수 실패'(분쟁 접수와 같다)
    case 'DISPUTE':
      return { progress: bd(3), result: bd(10) };
    // d5 §7.6 '미보고 스캐너'(진행 1영업일 안 파트너 확인 요청, 결과 3영업일)
    case 'SCANNER_UNREPORTED':
      return { progress: bd(1), result: bd(3) };
    // d5 §7.6 '승인 업무 실행 실패'(원래 승인 업무의 기한을 이어받는다. 기한이 없는 승인이면 없다, ADR-0364 결정 6)
    case 'APPROVAL_EXECUTION_FAILED':
      return { inherit: true };
    // d5 §7.6 '정산 이의'(3·10영업일), transfer-refund §7.1 '정산 이의'(진행 경과 3영업일, 결과 10영업일). 받기는 F-07-5(ADR-0368 결정 5)
    case 'STATEMENT_DISPUTE':
      return { progress: bd(3), result: bd(10) };
    // d5 §7.6 '결제 뒤 미발권'(확인 4시간, 벽시계). 받기는 BAT-012가 더한다
    case 'TICKET_NOT_ISSUED':
      return { result: { hours: 4 } };
    // 예매 제한 소명 3영업일. 부정 예매 사건 소명은 사건의 소명 기한(dueBaseAt)을 그대로 쓴다(F-06-4)
    case 'APPEAL':
      return category === 'FRAUD_CASE' ? { resultBase: true } : { result: bd(3) };
    default:
      return undefined;
  }
}

function dueOf(span: Span | undefined, baseMs: number, cal: BusinessCalendar): number | null {
  if (!span) return null;
  return 'hours' in span ? baseMs + span.hours * HOUR_MS : addBusinessDays(cal, baseMs, span.businessDays);
}

/** 건을 열 때의 두 기한(ADR-0364 결정 2). 규칙이 없는 종류는 둘 다 null(next_due_at 'infinity') */
export function deadlinesOf(
  i: { kind: CsCaseKind; category: string; baseMs: number; inheritedDueMs?: number | null | undefined },
  cal: BusinessCalendar,
): { progressDueMs: number | null; resultDueMs: number | null } {
  const rule = ruleOf(i.kind, i.category);
  if (!rule) return { progressDueMs: null, resultDueMs: null };
  if (rule.inherit) return { progressDueMs: null, resultDueMs: i.inheritedDueMs ?? null };
  if (rule.resultBase) return { progressDueMs: null, resultDueMs: i.baseMs };
  return { progressDueMs: dueOf(rule.progress, i.baseMs, cal), resultDueMs: dueOf(rule.result, i.baseMs, cal) };
}

export type CsDueState = 'ON_TRACK' | 'DUE_SOON' | 'OVERDUE' | 'NONE';

/** 기한 하나의 '1영업일 전' 시각(ADR-0364 결정 1·3). 기한까지 1영업일이 안 남은 건은 열리자마자 임박이다 */
export function dueSoonAtOf(dueMs: number, cal: BusinessCalendar): number {
  return subtractBusinessDays(cal, dueMs, 1);
}

/**
 * 서버가 센 기한 상태(openapi CsCase.dueState). 해결됐거나 기한이 없으면 NONE, 이른 기한이 지났으면(정각 포함) OVERDUE,
 * 이른 기한의 1영업일 전이 지났으면(정각 포함) DUE_SOON, 아니면 ON_TRACK
 */
export function dueStateOf(c: Pick<CsCase, 'progressDueAtMs' | 'resultDueAtMs' | 'status'>, nowMs: number, cal: BusinessCalendar): CsDueState {
  if (c.status === 'RESOLVED') return 'NONE';
  const due = nextDueOf(c);
  if (due === null) return 'NONE';
  if (nowMs >= due) return 'OVERDUE';
  if (nowMs >= dueSoonAtOf(due, cal)) return 'DUE_SOON';
  return 'ON_TRACK';
}
