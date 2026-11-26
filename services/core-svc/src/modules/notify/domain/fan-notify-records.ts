// BAT-455 발송 원장·신청·푸시 구독의 저장 모양(docs/data.md §2 ⑥, notify §2.2).
import type { DeliveryStatus, JobStatus, NotificationChannel, PushService, SubscriptionEndReason, SubscriptionKind, SubscriptionStatus, Vars } from './fan-notify.js';

export interface NotificationSubscription {
  id: string;
  accountId: string;
  eventId: string;
  kind: SubscriptionKind;
  nightPush: boolean;
  sentCount: number;
  status: SubscriptionStatus;
  endReason: SubscriptionEndReason | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PushSubscriptionRecord {
  id: string;
  accountId: string;
  endpoint: string;
  endpointHash: string;
  service: PushService;
  p256dh: string;
  auth: string;
  expiresAt: Date | null;
  boundAt: Date;
  createdAt: Date;
}

export interface NotificationJob {
  dedupKey: string;
  kind: string;
  targetId: string;
  accountId: string;
  channel: NotificationChannel;
  vars: Vars;
  /** 만든 때의 문안 판(코드에 고정한 템플릿 version, ADR-0388) */
  templateVersion?: string;
  status: JobStatus;
  attempts: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface NotificationDeliveryRecord {
  dedupKey: string;
  sentAt: Date;
  kind: string;
  targetId: string;
  accountId: string;
  channel: NotificationChannel;
  status: DeliveryStatus;
  providerMessageId: string | null;
  /** 실제로 그린 문안 판(ADR-0388) */
  templateVersion?: string;
  createdAt: Date;
}
