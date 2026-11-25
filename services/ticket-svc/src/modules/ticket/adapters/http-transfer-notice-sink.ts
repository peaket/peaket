// core-svc 양도 알림 내부 입구(POST /internal/v1/notify/transfer-events, docs/features/notify.md §4.8) 어댑터.
// 2xx·422는 보낸 것, 그 밖(401·5xx·연결 실패·시간 초과)은 다시 보낸다(application/transfer-notices.ts).
import type { ExternalHttpClient } from '@peaket/platform';
import type { TransferNoticeEvent, TransferNoticeSendResult, TransferNoticeSink } from '../domain/transfer-notice.js';

export const TRANSFER_NOTICE_PATH = '/internal/v1/notify/transfer-events';

export class HttpTransferNoticeSink implements TransferNoticeSink {
  constructor(
    private readonly client: ExternalHttpClient,
    private readonly internalToken: string | undefined,
  ) {}

  async send(e: TransferNoticeEvent): Promise<TransferNoticeSendResult> {
    let res: Awaited<ReturnType<ExternalHttpClient['request']>>;
    try {
      res = await this.client.request({
        method: 'POST',
        path: TRANSFER_NOTICE_PATH,
        headers: {
          'content-type': 'application/json',
          ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}),
        },
        body: JSON.stringify({
          noticeId: e.noticeId,
          type: e.type,
          party: e.party,
          offerId: e.offerId,
          ticketId: e.ticketId,
          eventId: e.eventId,
          accountId: e.accountId,
          occurredAtMs: e.createdAtMs,
          ...(e.reason === undefined ? {} : { reason: e.reason }),
        }),
      });
    } catch (err) {
      return { kind: 'retry', reason: err instanceof Error ? err.name : 'transport-error' };
    }
    if ((res.status >= 200 && res.status < 300) || res.status === 422) return { kind: 'sent' };
    return { kind: 'retry', reason: `http-${res.status}` };
  }
}
