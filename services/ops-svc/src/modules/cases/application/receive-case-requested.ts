// support.cases-requested를 CS 처리함 건으로 바꾸는 쓰임새(GAT-110 첫 몫, BAT-420).
// 받는 종류는 넷이다: 환급 실패(REFUND_FAILED, 공제 차액·일괄 환불 실패 포함), 마감 뒤 환급의 입장 기록 대조가 연 이상 표시(FLAGGED, category ENTRY_AFTER_CANCEL),
// 회차 취소 요청의 판정 대기(JUDGEMENT_PENDING), 가상계좌 계좌 대기의 환불 대기(REFUND_ACCOUNT_PENDING, BAT-420-rest 리뷰 반영 RV-01, transfer-refund §3.1 ⑥ '실패 기록'),
// payment-svc가 이의를 받은 뒤 여는 정산 이의(STATEMENT_DISPUTE, 대상 = 정산서 ID, F-07-5 ADR-0368 결정 5, settlement §4.2).
// 그 밖 종류는 그 건을 처리할 단계가 열 때까지 받지 않는다(accepted: false).
import { randomUUID } from 'node:crypto';
import type { CaseRequested, CsCase, CsCaseKind, CsCaseStore } from '../domain/cs-case.js';

const ACCEPTED: ReadonlySet<CsCaseKind> = new Set<CsCaseKind>(['REFUND_FAILED', 'FLAGGED', 'JUDGEMENT_PENDING', 'REFUND_ACCOUNT_PENDING', 'STATEMENT_DISPUTE']);

export class ReceiveCaseRequested {
  constructor(private readonly store: CsCaseStore) {}

  async handle(payload: CaseRequested, nowMs: number): Promise<{ accepted: boolean; case?: CsCase }> {
    if (!ACCEPTED.has(payload.kind)) return { accepted: false };
    const opened = await this.store.open({ caseId: randomUUID(), kind: payload.kind, targetRef: payload.sourceId, nowMs });
    return { accepted: true, case: opened };
  }
}
