// 팬 알림 발송기 `core-notify-sender`의 첫 몫(BAT-425 GAT-130 잔여, FR-040, docs/features/notify.md §9).
// purchase-svc trade.orders Outbox의 회차 취소·연기·환급·환급 실패 사건을 받아 결제자·보유자 문안으로 보낸다.
// 외부 푸시·이메일 대행 계정이 없어 실제 전송은 가짜 전송기(FakeNotificationTransport)로만 하고,
// PEAKET_NOTIFY_SENDER_MODE=fake가 아니면 UNAVAILABLE(503)이다. 발송 원장·Kafka 소비자는 마이그레이션 허용 밖이라 후속이다.
import { isProductionLikeEnv } from '@peaket/platform';

export type FanNoticeType = 'EVENT_CANCELLATION_CONFIRMED' | 'EVENT_POSTPONED' | 'REFUNDED' | 'REFUND_FAILED';

export interface FanNoticeEvent {
  readonly type: FanNoticeType;
  readonly orderId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly occurredAtMs: number;
  readonly fanNoticeReason?: string;
  readonly refundAmount?: number;
}

export interface FanNoticeDelivery {
  readonly deliveryId: string;
  readonly type: FanNoticeType;
  readonly orderId: string;
  readonly status: 'SENT' | 'UNAVAILABLE';
  readonly message: string;
}

export interface NotificationTransport {
  send(input: { readonly deliveryId: string; readonly accountId: string; readonly title: string; readonly body: string }): Promise<void>;
}

export class NotificationSenderProblem extends Error {
  constructor(
    readonly code: 'INVALID' | 'UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'NotificationSenderProblem';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES: ReadonlySet<string> = new Set(['EVENT_CANCELLATION_CONFIRMED', 'EVENT_POSTPONED', 'REFUNDED', 'REFUND_FAILED']);

const messageOf = (e: FanNoticeEvent): { title: string; body: string } => {
  switch (e.type) {
    case 'EVENT_CANCELLATION_CONFIRMED':
      return { title: '공연이 취소되었습니다', body: e.fanNoticeReason ?? '회차가 취소되어 환급을 진행합니다.' };
    case 'EVENT_POSTPONED':
      return { title: '공연 일정이 바뀌었습니다', body: e.fanNoticeReason ?? '새 일정과 환급 신청 기간을 확인해 주세요.' };
    case 'REFUNDED':
      return { title: '환급이 완료되었습니다', body: `환급 금액 ${e.refundAmount ?? 0}원이 결제 수단으로 돌아갑니다.` };
    case 'REFUND_FAILED':
      return { title: '환급을 마치지 못했습니다', body: e.fanNoticeReason ?? '고객센터에서 처리 상황을 확인해 주세요.' };
  }
};

/** 운영(NODE_ENV=production 또는 PEAKET_ENV=prod·staging, production은 옛 이름 호환)에서 fake 모드를 켜면 시작을 막는다(감사 SEC-07). */
export function assertNotifyFakeAllowed(env: Record<string, string | undefined>): void {
  if (env.PEAKET_NOTIFY_SENDER_MODE?.trim() !== 'fake') return;
  if (isProductionLikeEnv(env)) throw new Error('PEAKET_NOTIFY_SENDER_MODE=fake는 운영(prod·staging)에서 쓸 수 없다');
}

export class NotificationSender {
  readonly #sent = new Map<string, FanNoticeDelivery>();
  readonly #enabled: boolean;

  constructor(
    private readonly transport: NotificationTransport,
    env: Record<string, string | undefined> = process.env,
    private readonly now: () => number = Date.now,
  ) {
    assertNotifyFakeAllowed(env);
    this.#enabled = env.PEAKET_NOTIFY_SENDER_MODE?.trim() === 'fake';
  }

  async send(input: FanNoticeEvent): Promise<FanNoticeDelivery> {
    if (!TYPES.has(input.type)) throw new NotificationSenderProblem('INVALID', '알 수 없는 알림 종류입니다');
    if (!UUID.test(input.orderId) || !UUID.test(input.eventId) || !UUID.test(input.accountId)) throw new NotificationSenderProblem('INVALID', 'ID 모양이 올바르지 않습니다');
    const deliveryId = `${input.type}:${input.orderId}`;
    const existing = this.#sent.get(deliveryId);
    if (existing) return existing;
    const message = messageOf(input);
    if (!this.#enabled) {
      const unavailable: FanNoticeDelivery = { deliveryId, type: input.type, orderId: input.orderId, status: 'UNAVAILABLE', message: message.title };
      this.#sent.set(deliveryId, unavailable);
      return unavailable;
    }
    await this.transport.send({ deliveryId, accountId: input.accountId, ...message });
    const sent: FanNoticeDelivery = { deliveryId, type: input.type, orderId: input.orderId, status: 'SENT', message: message.title };
    this.#sent.set(deliveryId, sent);
    // 첫 몫은 메모리 기록이라 무한히 자라지 않게 오래된 것부터 버린다(운영 발송 원장은 후속).
    while (this.#sent.size > 10_000) {
      const oldest = this.#sent.keys().next().value;
      if (oldest === undefined) break;
      this.#sent.delete(oldest);
    }
    return sent;
  }

  /** 시험·로컬에서 보낸 기록(운영 발송 원장은 후속). */
  sent(): readonly FanNoticeDelivery[] {
    return [...this.#sent.values()];
  }
}

/** 가짜 전송기: 바깥으로 보내지 않고 보낸 것만 기록한다. */
export class FakeNotificationTransport implements NotificationTransport {
  readonly sent: { deliveryId: string; accountId: string; title: string; body: string }[] = [];
  async send(input: { deliveryId: string; accountId: string; title: string; body: string }): Promise<void> {
    this.sent.push(input);
  }
}
