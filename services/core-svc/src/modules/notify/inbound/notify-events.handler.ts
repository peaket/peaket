// F-06-1 notify Kafka 처리기: identity 두 사건과 trade.orders 가운데 팬 알림 네 종류만 NotificationIntake로 넘긴다.
// 업무 키는 주문 orderId, 병합 mergeId, 로그인 수단 accountId다(docs/streaming.md §2.6).
// 계약에 맞지 않는 값은 던져 플랫폼이 5회 뒤 held_event에 보류하게 한다. 나머지 OrderEvent.type은 인테이크를 부르지 않는다.
import { AccountMerged, LoginMethodChanged, OrderEvent, type AccountMergedOutput, type LoginMethodChangedOutput, type OrderEventOutput } from '@peaket/contracts/asyncapi';
import type { ConsumedMessage, KeyedHandler } from '@peaket/platform';
import type { NotificationIntake } from '../application/notification-intake.js';

export type NotifyKafkaEvent =
  | { topic: 'trade.orders'; order: OrderEventOutput }
  | { topic: 'identity.accounts-merged'; merged: AccountMergedOutput }
  | { topic: 'identity.login-methods-changed'; login: LoginMethodChangedOutput };

const NOTICE_TYPES: ReadonlySet<OrderEventOutput['type']> = new Set(['EVENT_CANCELLATION_CONFIRMED', 'EVENT_POSTPONED', 'REFUNDED', 'REFUND_FAILED']);

type Intake = Pick<NotificationIntake, 'tradeEvent' | 'loginMethodChanged' | 'accountMerged'>;

export class NotifyEventHandler implements KeyedHandler<NotifyKafkaEvent> {
  constructor(private readonly d: { intake: Intake; logger?: { warn(o: object, msg?: string): void } }) {}

  /** Kafka 값 바이트를 계약 Zod로 해독한다. null·JSON 아님·계약 위반은 던져 보류로 간다 */
  decode(m: ConsumedMessage): NotifyKafkaEvent {
    if (m.value === null) throw new Error('알림 사건의 값이 없다');
    let raw: unknown;
    try {
      raw = JSON.parse(m.value.toString('utf8'));
    } catch {
      throw new Error('알림 사건의 값을 해독하지 못했다');
    }
    switch (m.topic) {
      case 'trade.orders':
        return { topic: 'trade.orders', order: OrderEvent.parse(raw) };
      case 'identity.accounts-merged':
        return { topic: 'identity.accounts-merged', merged: AccountMerged.parse(raw) };
      case 'identity.login-methods-changed':
        return { topic: 'identity.login-methods-changed', login: LoginMethodChanged.parse(raw) };
      default:
        throw new Error(`알림 처리기가 모르는 주제다: ${m.topic}`);
    }
  }

  keyOf(e: NotifyKafkaEvent): string {
    switch (e.topic) {
      case 'trade.orders':
        return e.order.orderId;
      case 'identity.accounts-merged':
        return e.merged.mergeId;
      case 'identity.login-methods-changed':
        return e.login.accountId;
    }
  }

  async handle(e: NotifyKafkaEvent): Promise<void> {
    switch (e.topic) {
      case 'trade.orders': {
        if (!NOTICE_TYPES.has(e.order.type)) return; // 알림 대상이 아닌 주문 사건은 no-op(오프셋만 커밋)
        const occurredAtMs = Date.parse(e.order.occurredAt);
        await this.d.intake.tradeEvent({
          type: e.order.type as 'EVENT_CANCELLATION_CONFIRMED' | 'EVENT_POSTPONED' | 'REFUNDED' | 'REFUND_FAILED',
          orderId: e.order.orderId,
          eventId: e.order.eventId,
          accountId: e.order.accountId,
          ...(Number.isFinite(occurredAtMs) ? { occurredAtMs } : {}),
          ...(e.order.fanNoticeReason !== undefined ? { fanNoticeReason: e.order.fanNoticeReason } : {}),
          ...(e.order.refundAmount !== undefined ? { refundAmount: e.order.refundAmount } : {}),
          ...(e.order.postponedTo !== undefined ? { postponedTo: e.order.postponedTo } : {}),
          ...(e.order.refundWindowClosesAt !== undefined ? { refundWindowClosesAt: e.order.refundWindowClosesAt } : {}),
        });
        return;
      }
      case 'identity.accounts-merged': {
        const occurredAtMs = Date.parse(e.merged.confirmedAt);
        await this.d.intake.accountMerged({
          eventKey: e.merged.mergeId,
          primaryAccountId: e.merged.primaryAccountId,
          mergedAccountId: e.merged.mergedAccountId,
          ...(Number.isFinite(occurredAtMs) ? { occurredAtMs } : {}),
        });
        return;
      }
      case 'identity.login-methods-changed': {
        const occurredAtMs = Date.parse(e.login.occurredAt);
        await this.d.intake.loginMethodChanged({
          eventKey: e.login.eventKey,
          accountId: e.login.accountId,
          change: e.login.change,
          provider: e.login.provider,
          ...(Number.isFinite(occurredAtMs) ? { occurredAtMs } : {}),
        });
      }
    }
  }
}
