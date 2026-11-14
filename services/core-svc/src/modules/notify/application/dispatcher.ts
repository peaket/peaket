// 파트너 웹훅 발송기·DLQ(BUILD_ORDER BAT-610 잔여, FR-025, N-T5·N-T15, docs/features/notify.md §9).
// webhook_endpoint·webhook_delivery를 읽어 Standard Webhooks로 보내고, 재시도·DEAD·FAILING 비활성화를 맡는다.
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import type { WebhookStore, WebhookTransport } from '../domain/ports.js';
import {
  activeSecrets,
  FAILING_WINDOW_MS,
  retryDelayMs,
  shouldDisableEndpoint,
  WebhookProblem,
  webhookSignature,
  type WebhookDeliveryRecord,
  type WebhookDeliveryView,
  type WebhookEndpointRecord,
  type WebhookEventType,
} from '../domain/webhook.js';
import { deliveryView } from '../domain/webhook.js';

export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = ['order.confirmed', 'order.cancelled', 'event.sold_out', 'event.cancelled', 'event.postponed', 'statement.notified', 'payout.completed', 'payout.failed'];

export interface DispatcherDeps {
  readonly store: WebhookStore;
  readonly transport: WebhookTransport;
  readonly clock: Clock;
  /** 비활성화 알림(파트너 콘솔 알림함·이메일)은 아직 없다. 이 훅이 생기면 그 자리에 잇는다 */
  readonly onDisabled?: (endpoint: WebhookEndpointRecord, now: Date) => void;
}

export interface EnqueueInput {
  promoterId: string;
  eventType: WebhookEventType;
  data: Record<string, unknown>;
  occurredAt?: Date;
}

const bad = (title: string) => new ProblemError({ type: 'invalid-query', status: 400, title });

export class WebhookDispatcher {
  constructor(private readonly d: DispatcherDeps) {}

  /** 사건 하나를 구독한 엔드포인트마다 발송 행을 만든다. 같은 사건은 같은 webhook-id다. */
  async enqueue(input: EnqueueInput): Promise<WebhookDeliveryView[]> {
    if (!WEBHOOK_EVENT_TYPES.includes(input.eventType)) throw bad('모르는 웹훅 이벤트 종류입니다');
    const data = input.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw bad('웹훅 본문 data는 객체여야 합니다');
    const body = JSON.stringify({ type: input.eventType, timestamp: (input.occurredAt ?? new Date(this.d.clock.now())).toISOString(), data });
    if (Buffer.byteLength(body) > 64 * 1024) throw bad('웹훅 본문이 64KiB를 넘습니다');
    const now = input.occurredAt ?? new Date(this.d.clock.now());
    const webhookId = uuidv7(this.d.clock);
    const endpoints = (await this.d.store.listActiveEndpoints(input.promoterId)).filter((e) => e.eventTypes.includes(input.eventType));
    const payload = { type: input.eventType, timestamp: now.toISOString(), data };
    const records: WebhookDeliveryRecord[] = endpoints.map((e) => ({
      deliveryId: uuidv7(this.d.clock),
      endpointId: e.endpointId,
      webhookId,
      eventType: input.eventType,
      status: 'PENDING',
      attemptCount: 0,
      lastHttpStatus: null,
      lastError: null,
      nextAttemptAt: now,
      createdAt: now,
      finishedAt: null,
      payload,
    }));
    await this.d.store.insertDeliveries(records);
    return records.map(deliveryView);
  }

  /** 보낼 때가 된 행을 한 번씩 보낸다. 워커가 주기적으로 부른다. */
  async processDue(now: Date, limit = 100): Promise<{ attempted: number; succeeded: number; retrying: number; dead: number; disabled: string[] }> {
    const due = await this.d.store.listDueDeliveries(now, limit);
    let succeeded = 0;
    let retrying = 0;
    let dead = 0;
    const disabled: string[] = [];
    for (const delivery of due) {
      const endpoint = await this.d.store.findEndpointById(delivery.endpointId);
      if (!endpoint || endpoint.status !== 'ACTIVE') {
        await this.d.store.saveDelivery({ ...delivery, status: 'DEAD', lastError: 'endpoint-disabled', nextAttemptAt: null, finishedAt: now });
        dead += 1;
        continue;
      }
      const attempt = delivery.attemptCount + 1;
      const timestamp = Math.floor(now.getTime() / 1000);
      const body = JSON.stringify(delivery.payload);
      const signature = webhookSignature(activeSecrets(endpoint, now), delivery.webhookId, timestamp, body);
      let status = 0;
      let error: string | null = null;
      try {
        status = (await this.d.transport.send({
          url: endpoint.url,
          headers: {
            'content-type': 'application/json',
            'webhook-id': delivery.webhookId,
            'webhook-timestamp': String(timestamp),
            'webhook-signature': signature,
            'user-agent': 'PEAKET-Webhook/1',
          },
          body,
        })).status;
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 200) : 'transport-error';
      }
      if (status >= 200 && status < 300) {
        await this.d.store.saveDelivery({ ...delivery, status: 'SUCCEEDED', attemptCount: attempt, lastHttpStatus: status, lastError: null, nextAttemptAt: null, finishedAt: now });
        succeeded += 1;
        continue;
      }
      const retryIndex = delivery.status === 'PENDING' && delivery.attemptCount > 6 ? 0 : attempt;
      const delay = retryDelayMs(retryIndex);
      if (delay === null) {
        await this.d.store.saveDelivery({ ...delivery, status: 'DEAD', attemptCount: attempt, lastHttpStatus: status || null, lastError: error ?? `http-${status}`, nextAttemptAt: null, finishedAt: now });
        dead += 1;
        const deadCount = await this.d.store.countDeadSince(endpoint.endpointId, new Date(now.getTime() - FAILING_WINDOW_MS));
        const lastSuccess = await this.d.store.lastSuccessAt(endpoint.endpointId);
        if (shouldDisableEndpoint(now, lastSuccess, deadCount)) {
          await this.d.store.disableEndpoint(endpoint.endpointId, now);
          disabled.push(endpoint.endpointId);
          this.d.onDisabled?.(endpoint, now);
        }
      } else {
        await this.d.store.saveDelivery({ ...delivery, status: 'RETRYING', attemptCount: attempt, lastHttpStatus: status || null, lastError: error ?? `http-${status}`, nextAttemptAt: new Date(now.getTime() + delay), finishedAt: null });
        retrying += 1;
      }
    }
    return { attempted: due.length, succeeded, retrying, dead, disabled };
  }
}

export { WebhookProblem };
