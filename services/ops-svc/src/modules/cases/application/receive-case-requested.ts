// support.cases-requested를 CS 처리함 건으로 바꾸는 쓰임새(GAT-110 첫 몫). 지금은 REFUND_FAILED만 연다.
import { randomUUID } from 'node:crypto';
import type { CaseRequested, CsCase, CsCaseStore } from '../domain/cs-case.js';

export class ReceiveCaseRequested {
  constructor(private readonly store: CsCaseStore) {}

  async handle(payload: CaseRequested, nowMs: number): Promise<{ accepted: boolean; case?: CsCase }> {
    if (payload.kind !== 'REFUND_FAILED') return { accepted: false };
    const opened = await this.store.open({ caseId: randomUUID(), kind: payload.kind, targetRef: payload.sourceId, nowMs });
    return { accepted: true, case: opened };
  }
}
