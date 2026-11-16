// support.cases-requested를 CS 처리함 건으로 바꾸는 쓰임새(GAT-110 첫 몫, BAT-420).
// 받는 종류는 셋이다: 환급 실패(REFUND_FAILED), 마감 뒤 환급의 입장 기록 대조가 연 이상 표시(FLAGGED, category ENTRY_AFTER_CANCEL),
// 회차 취소 요청의 판정 대기(JUDGEMENT_PENDING). 그 밖 종류는 그 건을 처리할 단계가 열 때까지 받지 않는다(accepted: false).
import { randomUUID } from 'node:crypto';
import type { CaseRequested, CsCase, CsCaseKind, CsCaseStore } from '../domain/cs-case.js';

const ACCEPTED: ReadonlySet<CsCaseKind> = new Set<CsCaseKind>(['REFUND_FAILED', 'FLAGGED', 'JUDGEMENT_PENDING']);

export class ReceiveCaseRequested {
  constructor(private readonly store: CsCaseStore) {}

  async handle(payload: CaseRequested, nowMs: number): Promise<{ accepted: boolean; case?: CsCase }> {
    if (!ACCEPTED.has(payload.kind)) return { accepted: false };
    const opened = await this.store.open({ caseId: randomUUID(), kind: payload.kind, targetRef: payload.sourceId, nowMs });
    return { accepted: true, case: opened };
  }
}
