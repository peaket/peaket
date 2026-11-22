// BAT-455 팬 알림 저장·전송 포트: 신청·푸시 구독·발송 원장·받는 사람 조회·이메일·웹 푸시.
import type { NotificationChannel } from './fan-notify.js';
import type { NotificationSubscription, PushSubscriptionRecord, NotificationJob, NotificationDeliveryRecord } from './fan-notify-records.js';

export * from './fan-notify-records.js';

export interface SubscriptionStateView {
  eventId: string;
  open: boolean;
  cancellation: boolean;
  nightPush: boolean;
  cancellationStatus: 'ACTIVE' | 'ENDED' | null;
  endReason: 'SENT_MAX' | 'BOOKED' | 'SALE_ENDED' | null;
  sentCount: number;
}

export interface SubscriptionPage {
  items: SubscriptionStateView[];
  nextCursor: string | null;
}

export interface EnqueueResult {
  created: boolean;
}

export interface FanNotifyStore {
  // 신청
  findSubscription(accountId: string, eventId: string, kind: 'OPEN' | 'CANCELLATION'): Promise<NotificationSubscription | undefined>;
  findSubscriptionById(id: string): Promise<NotificationSubscription | undefined>;
  listSubscriptions(accountId: string, eventIds: readonly string[] | undefined, cursor: string | null, limit: number): Promise<NotificationSubscription[]>;
  countActiveSubscriptions(accountId: string): Promise<number>;
  insertSubscription(record: NotificationSubscription): Promise<void>;
  saveSubscription(record: NotificationSubscription): Promise<void>;
  deleteSubscription(accountId: string, eventId: string, kind: 'OPEN' | 'CANCELLATION'): Promise<boolean>;
  deleteSubscriptionById(id: string): Promise<boolean>;
  mergeSubscriptions(primaryAccountId: string, absorbedAccountId: string, now: Date): Promise<{ moved: number; deduped: number }>;

  // 웹 푸시 구독
  listPushSubscriptions(accountId: string): Promise<PushSubscriptionRecord[]>;
  findPushSubscriptionByEndpoint(endpoint: string): Promise<PushSubscriptionRecord | undefined>;
  insertPushSubscription(record: PushSubscriptionRecord, limit: number): Promise<string[]>;
  savePushSubscription(record: PushSubscriptionRecord): Promise<void>;
  deletePushSubscription(accountId: string, subscriptionKey: string): Promise<boolean>;
  deletePushSubscriptionById(id: string): Promise<void>;
  mergePushSubscriptions(primaryAccountId: string, absorbedAccountId: string, now: Date): Promise<{ moved: number; deduped: number }>;

  // 발송 원장
  enqueue(record: NotificationJob, now: Date): Promise<EnqueueResult>;
  findJob(dedupKey: string): Promise<NotificationJob | undefined>;
  leaseDueJobs(now: Date, limit: number, leaseMs: number): Promise<NotificationJob[]>;
  saveJob(record: NotificationJob): Promise<void>;
  deleteJob(dedupKey: string): Promise<void>;
  insertDelivery(record: NotificationDeliveryRecord): Promise<void>;
  findDelivery(dedupKey: string): Promise<NotificationDeliveryRecord | undefined>;
  listDeliveries(accountId: string, limit: number): Promise<NotificationDeliveryRecord[]>;
  purgeDedupBefore(cutoff: Date): Promise<number>;
}

export interface Recipient {
  accountId: string;
  status: 'ACTIVE' | 'WITHDRAWAL_PENDING' | 'MERGED' | 'DELETED' | 'NOT_FOUND';
  verified: boolean;
  locale: string;
  email?: string | null;
}

export interface RecipientDirectory {
  getMany(accountIds: readonly string[], includeEmail: boolean): Promise<Recipient[]>;
}

/** 신청 받는 때를 가르는 회차 정보(공개 판매 승인·오픈 시각·공연 시작). 카탈로그 경계의 작은 포트다 */
export interface NotifyEvent {
  eventId: string;
  productionId: string;
  openAt: Date;
  startsAt: Date;
  saleReview: string;
  saleApprovedAt: Date | null;
}

export interface NotificationEventDirectory {
  find(eventId: string): Promise<NotifyEvent | undefined>;
}

export interface MailMessage {
  to: string;
  subject: string;
  body: string;
  headers: Record<string, string>;
  messageKey: string;
}

export interface MailSendResult {
  providerMessageId?: string;
}

export interface MailTransport {
  send(input: MailMessage): Promise<MailSendResult>;
}

export type MailFailureKind = 'RETRYABLE' | 'PERMANENT' | 'UNKNOWN';

export class MailTransportError extends Error {
  constructor(
    readonly kind: MailFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MailTransportError';
  }
}

export interface PushSendInput {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer;
  /** 시험·관측용: 구독 해시와 서비스. 주소는 싣지 않는다 */
  subscriptionKey: string;
  service: string;
}

export interface PushSendResult {
  status: number;
}

export interface PushTransport {
  send(input: PushSendInput): Promise<PushSendResult>;
}

export interface VapidConfig {
  /** PEM PKCS8 또는 JWK JSON 문자열 */
  privateKey: string;
  /** base64url 65바이트 비압축 P-256 점 */
  publicKey: string;
  subject: string;
}

export type PushLookup = (hostname: string) => Promise<readonly { address: string; family: number }[]>;
