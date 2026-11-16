// 회차 취소 요청 접수 때 CS 처리함 '판정 대기'(JUDGEMENT_PENDING) 건을 연다(BAT-420 GAT-110, transfer-refund §5 '요청 두 길').
// 같은 요청(대상 ID)의 열린 건은 하나다(CS 저장소의 (kind, target_ref) 멱등).
import { randomUUID } from 'node:crypto';
import type { CsCaseStore } from '../../cases/index.js';
import type { EventCancellationCases } from '../domain/ports.js';

export class CsCaseEventCancellationCases implements EventCancellationCases {
  constructor(private readonly cases: CsCaseStore) {}

  async judgementPending(requestId: string, nowMs: number): Promise<void> {
    await this.cases.open({ caseId: randomUUID(), kind: 'JUDGEMENT_PENDING', targetRef: requestId, nowMs });
  }
}
