// 정산 계좌 변경 기록을 ops-svc 감사 받기(POST /internal/v1/ops/audit-records, recordType PAYOUT_ACCOUNT_CHANGED)로 보낸다(F-07-7 계획 I-04, ADR-0370 결정 5, settlement §8).
// 본문 payload는 부르는 쪽이 만든 값(은행·끝 4자리·결과·결제사별 결과·재인증 요소)이고 계좌번호·예금주명은 없다.
// 거절(202 accepted:false·400·422)은 OpsIntakeRefused, 일시 실패는 SettlementProblem 503. ops 주소가 없으면 UnavailableOpsAuditRecords(늘 503, 행은 남고 보낸 시각이 빈다).
import type { Clock } from '@peaket/platform';
import type { PayoutAccountAuditSink } from '../domain/ports.js';
import { SettlementProblem } from '../domain/settlement.js';
import { OpsIntakeHttp } from './ops-intake-http.js';

export const PAYOUT_ACCOUNT_CHANGED = 'PAYOUT_ACCOUNT_CHANGED';

export class HttpOpsAuditRecords implements PayoutAccountAuditSink {
  readonly #http: OpsIntakeHttp;
  constructor(baseUrl: string, internalToken?: string, o: { clock?: Clock; fetch?: typeof fetch } = {}) {
    this.#http = new OpsIntakeHttp(baseUrl, internalToken, o);
  }

  async send(o: { eventKey: string; recordId: string; payload: Record<string, unknown>; occurredAt: Date }): Promise<void> {
    await this.#http.post('/internal/v1/ops/audit-records', { eventKey: o.eventKey, recordType: PAYOUT_ACCOUNT_CHANGED, recordId: o.recordId, payload: o.payload, occurredAt: o.occurredAt.toISOString() }, '감사 기록');
  }
}

export class UnavailableOpsAuditRecords implements PayoutAccountAuditSink {
  async send(): Promise<void> {
    throw new SettlementProblem('dependency-unavailable', 503, '감사 기록을 보낼 ops 주소가 없습니다');
  }
}
