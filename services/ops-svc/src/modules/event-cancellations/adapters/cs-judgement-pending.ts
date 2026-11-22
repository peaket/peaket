// 회차 취소 요청 접수 때 CS 처리함 '판정 대기'(JUDGEMENT_PENDING) 건을 연다(BAT-420 GAT-110, transfer-refund §5 '요청 두 길').
// CS 처리함의 건 요청 처리기로 열어 기한(요청 + 1영업일)이 붙고, eventKey `judgement-pending:<요청 ID>`가 한 번만 적힌다(F-06-2 ADR-0364 결정 2·4).
// 같은 요청(대상 ID)의 열린 건은 하나다(CS 저장소의 (kind, target_ref) 멱등).
import type { ReceiveCaseRequested } from '../../cases/index.js';
import type { EventCancellationCases } from '../domain/ports.js';

export class CsCaseEventCancellationCases implements EventCancellationCases {
  constructor(private readonly cases: Pick<ReceiveCaseRequested, 'handle'>) {}

  async judgementPending(requestId: string, nowMs: number): Promise<void> {
    await this.cases.handle(
      { eventKey: `judgement-pending:${requestId}`, kind: 'JUDGEMENT_PENDING', sourceId: requestId, category: 'EVENT_CANCELLATION', createdAt: new Date(nowMs).toISOString() },
      nowMs,
    );
  }
}
