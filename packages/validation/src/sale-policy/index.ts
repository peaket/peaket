// @peaket/validation/sale-policy: 판매 정책 규칙 문법 1판(docs/design/d5 §6.7)의 공개 함수 넷(ADR-0261 결정 3·11).
// 화면 미리보기(BAT-158)·core-svc 저장 검사와 공개 요약·팬별 자격·purchase-svc 홀드 평가가 같은 함수를 쓴다.
// zod와 같은 패키지의 safe-json만 가져오고 계약 생성 스키마는 가져오지 않는다. 서비스는 빌드한 dist(default 조건)를, 화면은 원본을 쓴다.
export { parseSalePolicy, SalePolicyShapeError, type SalePolicyCode, type SalePolicyContext, type SalePolicyIssue, type SalePolicyParse } from './parse.js';
export { evaluateSalePolicy, type SaleDecision, type SaleFacts } from './evaluate.js';
export { entryGate, type EntryDecision, type EntryFacts } from './entry-gate.js';
export { salePhases, type SalePhase } from './phases.js';
export { DENY_REASONS, type Condition, type DenyReason, type FactCondition, type Outcome, type RefundBand, type SalePolicyRule } from './schema.js';
export { UnsafeKeyError } from '../safe-json.js';
