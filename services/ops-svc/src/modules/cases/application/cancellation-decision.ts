// GAT-300 처리 행동(F-06-3 IR-11): FLAGGED 취소 무효(VOID)/환급(REFUND)과 TICKET_NOT_ISSUED 시스템 잘못 환불.
// 내부 경로: POST /v1/ops/cases/{caseId}/cancellation-decision, POST /v1/ops/cases/{caseId}/system-refund.

export const CANCELLATION_DECISION_PATH = '/v1/ops/cases/{caseId}/cancellation-decision';
export const SYSTEM_REFUND_PATH = '/v1/ops/cases/{caseId}/system-refund';
