// F-06-8 예매 확정 알림 시험 공용: 흉내 SES·흉내 푸시·고정 시계·메모리 원장.
// 실제 수신자 주소·전화번호를 쓰지 않는다. Docker·Kafka·AWS를 쓰지 않는다.
// 구현 전에는 NotificationIntake에 bookingConfirmed·noticeReader·catalog·heldEvents·signals가 없으므로
// 시험은 아래 좁은 모양으로만 부르고, 구현이 그 모양을 갖출 때까지 기준 트리에서 실패한다.
import { randomUUID } from 'node:crypto';
import { fakeClock, type FakeClock } from '@peaket/platform';
import {
  FakeMailTransport,
  FakePushTransport,
  FanNotificationWorker,
  MemoryFanNotifyStore,
  MemoryRecipientDirectory,
  NotificationIntake,
  subscriptionKeyOf,
  type NotificationJob,
  type Recipient,
} from '../src/modules/notify/index.js';
import { OPTOUT_KEY, pushKeyPair, vapidKeys } from './fan-notify-support.js';

/** 2026-10-14 12:00 KST(예매번호 날짜가 20261014인 시각) */
export const NOW = Date.parse('2026-10-14T12:00:00+09:00');
export const DAY = 24 * 60 * 60 * 1000;
export const EVENT = '0190f3a1-7c2e-7c00-8000-0000000000c1';

export interface BookingNotice {
  bookingNo: string | null;
  status: string;
  noticeAllowed: boolean;
  eventId: string;
  tierIds: string[];
}

export interface SellerNotice {
  legalName: string;
  representative: string;
  address: string;
  phone: string;
  email: string;
  businessRegNo: string;
  mailOrderReportNo: string;
}

export interface CatalogNotice {
  productionName: string;
  venueName: string;
  eventStartsAt: string;
  tierNames: Readonly<Record<string, string>>;
  seller: SellerNotice | null;
}

export interface BookingNoticeReaderLike {
  get(orderId: string): Promise<BookingNotice | undefined>;
}

export interface CatalogNoticeLike {
  getBookingNotice(eventId: string, tierIds: readonly string[]): Promise<CatalogNotice | undefined>;
}

export interface HeldEventInput {
  eventKey: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface HeldEventsLike {
  hold(e: HeldEventInput, now: Date): Promise<void>;
}

export interface BookingSignalsLike {
  dueBacklog(kind: string, count: number): void;
  deliveryLatency(kind: string, channel: string, seconds: number): void;
  templateMissing(locale: string): void;
  emailSent(): void;
  emailFailed(): void;
  suppressed(reason: 'not_confirmed' | 'not_allowed'): void;
  tierNameMissing(): void;
  bookingNoInvalid(): void;
}

export interface BookingConfirmedEventLike {
  type: string;
  eventKey: string;
  orderId: string;
  eventId: string;
  accountId: string;
  occurredAtMs: number;
  amount: number;
  items: readonly { tierId: string }[];
}

export interface BookingIntakeResultLike {
  created: number;
  duplicate: number;
  suppressed?: 'not_confirmed' | 'not_allowed';
  held?: boolean;
}

export type BookingIntakeLike = NotificationIntake & {
  bookingConfirmed(e: BookingConfirmedEventLike): Promise<BookingIntakeResultLike>;
};

export const SELLER: SellerNotice = Object.freeze({
  legalName: '(주)겨울공연',
  representative: '김대표',
  address: '서울특별시 중구 세종대로 1',
  phone: '02-1234-5678',
  email: 'seller@example.test',
  businessRegNo: '123-45-67890',
  mailOrderReportNo: '2026-서울중구-0001',
});

export const CATALOG: CatalogNotice = Object.freeze({
  productionName: '겨울 콘서트',
  venueName: '피켓홀',
  eventStartsAt: '2026-12-24T19:30:00+09:00',
  tierNames: Object.freeze({ R: 'R석', S: 'S석' }),
  seller: SELLER,
});

export function signalCounts() {
  const c = {
    dueBacklog: [] as { kind: string; count: number }[],
    latency: [] as { kind: string; channel: string; seconds: number }[],
    templateMissing: [] as string[],
    emailSent: 0,
    emailFailed: 0,
    suppressed: [] as string[],
    tierNameMissing: 0,
    bookingNoInvalid: 0,
  };
  const signals: BookingSignalsLike = {
    dueBacklog: (kind, count) => c.dueBacklog.push({ kind, count }),
    deliveryLatency: (kind, channel, seconds) => c.latency.push({ kind, channel, seconds }),
    templateMissing: (locale) => c.templateMissing.push(locale),
    emailSent: () => {
      c.emailSent += 1;
    },
    emailFailed: () => {
      c.emailFailed += 1;
    },
    suppressed: (reason) => c.suppressed.push(reason),
    tierNameMissing: () => {
      c.tierNameMissing += 1;
    },
    bookingNoInvalid: () => {
      c.bookingNoInvalid += 1;
    },
  };
  return { c, signals };
}

export function noticeOf(over: Partial<BookingNotice> = {}): BookingNotice {
  return { bookingNo: '2026101400001', status: 'CONFIRMED', noticeAllowed: true, eventId: EVENT, tierIds: ['R', 'S'], ...over };
}

export function catalogOf(over: Partial<CatalogNotice> = {}): CatalogNotice {
  return { ...CATALOG, ...over };
}

export interface Setup {
  clock: FakeClock;
  store: MemoryFanNotifyStore;
  mail: FakeMailTransport;
  push: FakePushTransport;
  recipients: MemoryRecipientDirectory;
  accountId: string;
  orderId: string;
  eventKey: string;
  notice: BookingNotice;
  noticeReader: BookingNoticeReaderLike & { calls: string[] };
  catalog: CatalogNoticeLike & { calls: { eventId: string; tierIds: readonly string[] }[] };
  held: HeldEventsLike & { rows: HeldEventInput[] };
  signals: BookingSignalsLike;
  counts: ReturnType<typeof signalCounts>['c'];
  intake: BookingIntakeLike;
  worker: FanNotificationWorker;
}

export interface SetupOptions {
  notice?: Partial<BookingNotice> | null;
  catalog?: CatalogNotice | null;
  locale?: string;
  email?: string | null;
  /** 살아 있는 웹 푸시 구독 수 */
  subscriptions?: number;
}

/** 같은 계정·회차·판매자로 시험 무대 하나를 만든다. 실제 주소는 example.test만 쓴다 */
export function setupBooking(o: SetupOptions = {}): Setup {
  const clock = fakeClock({ now: NOW });
  const store = new MemoryFanNotifyStore();
  const mail = new FakeMailTransport();
  const push = new FakePushTransport();
  const recipients = new MemoryRecipientDirectory();
  const accountId = randomUUID();
  const orderId = randomUUID();
  const eventKey = randomUUID();
  const recipient: Recipient = {
    accountId,
    status: 'ACTIVE',
    verified: true,
    locale: o.locale ?? 'ko',
    ...(o.email === null ? { email: null } : { email: o.email ?? 'fan@example.test' }),
  };
  recipients.rows.set(accountId, recipient);

  const fixedNotice = o.notice === null ? undefined : noticeOf(o.notice ?? {});
  const noticeReader = {
    calls: [] as string[],
    async get(id: string) {
      this.calls.push(id);
      return fixedNotice;
    },
  };
  const fixedCatalog = o.catalog === null ? undefined : catalogOf(o.catalog ?? {});
  const catalog = {
    calls: [] as { eventId: string; tierIds: readonly string[] }[],
    async getBookingNotice(eventId: string, tierIds: readonly string[]) {
      this.calls.push({ eventId, tierIds });
      return fixedCatalog;
    },
  };
  const held = {
    rows: [] as HeldEventInput[],
    async hold(e: HeldEventInput) {
      // 실제 held_event는 eventKey가 기본 키다(같은 사건은 한 줄만)
      const i = this.rows.findIndex((r) => r.eventKey === e.eventKey);
      if (i >= 0) this.rows[i] = e;
      else this.rows.push(e);
    },
  };
  const { c: counts, signals } = signalCounts();

  for (let i = 0; i < (o.subscriptions ?? 0); i += 1) {
    const kp = pushKeyPair();
    const id = randomUUID();
    const endpoint = `https://fcm.googleapis.com/send/${randomUUID()}`;
    store.push.set(id, {
      id,
      accountId,
      endpoint,
      endpointHash: subscriptionKeyOf(endpoint),
      service: 'FCM',
      p256dh: kp.p256dh,
      auth: kp.auth,
      expiresAt: null,
      boundAt: new Date(NOW),
      createdAt: new Date(NOW),
    });
  }

  const intake = new NotificationIntake({
    store,
    clock,
    optOutKey: OPTOUT_KEY,
    noticeReader,
    catalog,
    heldEvents: held,
    signals,
  } as never) as BookingIntakeLike;
  const worker = new FanNotificationWorker({
    store,
    mail,
    push,
    recipients,
    clock,
    optOutKey: OPTOUT_KEY,
    vapid: vapidKeys(),
    noticeReader,
    catalog,
    signals,
    publicOrigin: 'https://peaket.example',
  } as never);

  return {
    clock,
    store,
    mail,
    push,
    recipients,
    accountId,
    orderId,
    eventKey,
    notice: fixedNotice ?? noticeOf(),
    noticeReader,
    catalog,
    held,
    signals,
    counts,
    intake,
    worker,
  };
}

/** 이 기능의 사건 하나. type을 바꿔 다른 주문 사건을 흉내 낸다 */
export function eventOf(t: Setup, over: Partial<BookingConfirmedEventLike> = {}): BookingConfirmedEventLike {
  return {
    type: 'CONFIRMED',
    eventKey: t.eventKey,
    orderId: t.orderId,
    eventId: EVENT,
    accountId: t.accountId,
    occurredAtMs: NOW,
    amount: 308_000,
    items: [{ tierId: 'R' }, { tierId: 'R' }, { tierId: 'S' }],
    ...over,
  };
}

/** 워커만 보는 시험용 작업(입구를 거치지 않는다). 구현 전에도 작업 모양을 직접 넣어 워커를 본다 */
export function bookingJob(t: Setup, o: { channel?: 'EMAIL' | 'WEB_PUSH'; subscriptionKey?: string; vars?: Record<string, string | number>; locale?: string; templateVersion?: string; createdAt?: number } = {}): NotificationJob {
  const channel = o.channel ?? 'EMAIL';
  const key = `BOOKING_CONFIRMED:${t.orderId}:CONFIRMED:${t.accountId}:${channel}${o.subscriptionKey ? `:${o.subscriptionKey}` : ''}`;
  const job = {
    dedupKey: key,
    kind: 'BOOKING_CONFIRMED',
    targetId: t.orderId,
    accountId: t.accountId,
    channel,
    vars: o.vars ?? {
      productionName: '겨울 콘서트',
      eventStartsAt: '2026-12-24T19:30:00+09:00',
      venueName: '피켓홀',
      seatSummary: 'R석 2매, S석 1매',
      amount: 308_000,
      bookingNoLast4: '0001',
      orderId: t.orderId,
    },
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: new Date(NOW),
    leaseUntil: null,
    expiresAt: new Date(NOW + DAY),
    createdAt: new Date(o.createdAt ?? NOW),
    ...(o.templateVersion ? { templateVersion: o.templateVersion } : {}),
  } as NotificationJob & { templateVersion?: string };
  t.store.jobs.set(key, job);
  t.store.dedup.set(key, job.createdAt);
  return job;
}
