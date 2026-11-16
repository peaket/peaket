// 부정 예매 운영자 취소의 purchase DB 저장소(0022 fraud_cancellation_request·fraud_cancellation_ticket, docs/data.md, BUILD_ORDER GAT-080).
// BAT-415 시험 담당의 빈 뼈대다. 동작은 구현 담당이 채운다.
import type { Database } from '@peaket/platform';
import type { FraudRefundProgress, FraudTicketResult } from '../../domain/fraud-cancellation.js';
import type { FraudCancellationRequestRecord, FraudCancellationStore } from '../../domain/ports.js';

export class DrizzleFraudCancellationStore implements FraudCancellationStore {
  constructor(readonly database: Database) {}

  async find(_approvalId: string): Promise<FraudCancellationRequestRecord | undefined> {
    throw new Error('아직 없음');
  }

  async create(_r: FraudCancellationRequestRecord): Promise<{ readonly status: 'CREATED' } | { readonly status: 'EXISTS'; readonly record: FraudCancellationRequestRecord }> {
    throw new Error('아직 없음');
  }

  async results(_approvalId: string): Promise<readonly FraudTicketResult[]> {
    throw new Error('아직 없음');
  }

  async saveResults(_approvalId: string, _results: readonly (FraudTicketResult & { readonly expectedHolderAccountId: string })[], _nowMs: number): Promise<void> {
    throw new Error('아직 없음');
  }

  async refunds(_approvalId: string): Promise<readonly FraudRefundProgress[]> {
    throw new Error('아직 없음');
  }
}
