// 승인된 EVENT_CANCEL을 purchase-svc 내부 HTTP로 넘기는 어댑터(BAT-425 첫 몫).
// 공개 계약은 refund.proto EventRefundService.StartEventRefund이고, 첫 몫은 같은 쓰임새의 내부 HTTP를 쓴다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { Command } from '../modules/commands/domain/command.js';
import type { CommandDispatcher } from '../modules/commands/domain/ports.js';

const FAULTS = new Set(['ORGANIZER', 'FORCE_MAJEURE', 'CONTENT_CHANGE']);

export class HttpEventRefundDispatcher implements CommandDispatcher {
  constructor(private readonly client: Pick<ExternalHttpClient, 'request'>) {}

  async dispatch(command: Command): Promise<void> {
    if (command.type !== 'EVENT_CANCEL') return;
    const eventId = command.params.eventId;
    const fault = command.params.fault;
    if (typeof eventId !== 'string' || typeof fault !== 'string' || !FAULTS.has(fault)) throw new Error('EVENT_CANCEL params에 eventId·fault가 없다');
    const confirmedBy = command.approvals[0];
    if (!confirmedBy) throw new Error('EVENT_CANCEL 승인자가 없다');
    const fanNoticeReason = typeof command.params.fanNoticeReason === 'string' ? command.params.fanNoticeReason : undefined;
    const token = process.env.PEAKET_INTERNAL_TOKEN;
    const res = await this.client.request({
      method: 'POST',
      path: '/internal/v1/event-refunds',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-peaket-internal-token': token } : {}) },
      body: JSON.stringify({
        eventId,
        requestId: command.commandId,
        fault,
        ruledBy: command.requestedBy,
        confirmedBy,
        ...(fanNoticeReason !== undefined ? { fanNoticeReason } : {}),
      }),
      timeoutCapMs: 30_000,
    });
    if (!res.ok) throw new Error(`purchase-svc event refund ${res.status}`);
  }
}
