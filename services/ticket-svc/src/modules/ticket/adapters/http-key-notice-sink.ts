// core-svc 알림 내부 입구(POST /internal/v1/notify/ticket-events, docs/features/notify.md §4.7)로 입장 키 알림을 넘기는 어댑터(ADR-0363 결정 4).
// 시간 상한 2초 [가정]은 부르는 쪽(start.ts)이 createExternalHttpClient의 timeoutCapMs로 준다. 내부 토큰이 있으면 x-peaket-internal-token에 싣는다.
// 2xx·422면 보낸 것, 그 밖(401·5xx·연결 실패·시간 초과)은 다시 보낸다(application/device-key-notices.ts).
import type { ExternalHttpClient } from '@peaket/platform';
import type { DeviceKeyNoticeEvent, DeviceKeyNoticeSendResult, DeviceKeyNoticeSink } from '../domain/ports.js';

export const DEVICE_KEY_NOTICE_PATH = '/internal/v1/notify/ticket-events';

export class HttpDeviceKeyNoticeSink implements DeviceKeyNoticeSink {
  constructor(
    private readonly client: ExternalHttpClient,
    private readonly internalToken: string | undefined,
  ) {}

  async send(e: DeviceKeyNoticeEvent): Promise<DeviceKeyNoticeSendResult> {
    let res: Awaited<ReturnType<ExternalHttpClient['request']>>;
    try {
      res = await this.client.request({
        method: 'POST',
        path: DEVICE_KEY_NOTICE_PATH,
        headers: {
          'content-type': 'application/json',
          ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}),
        },
        body: JSON.stringify({ noticeId: e.noticeId, type: e.type, accountId: e.accountId, ticketId: e.ticketId, registeredAtMs: e.registeredAtMs }),
      });
    } catch (err) {
      return { kind: 'retry', reason: err instanceof Error ? err.name : 'transport-error' };
    }
    if ((res.status >= 200 && res.status < 300) || res.status === 422) return { kind: 'sent', status: res.status };
    return { kind: 'retry', reason: `http-${res.status}` };
  }
}
