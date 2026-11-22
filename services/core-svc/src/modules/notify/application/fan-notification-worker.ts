// BAT-455 GAT-250 발송 워커: 임대한 낱건을 이메일·웹 푸시로 보내고 결과를 원장에 남긴다.
// 실패는 이 작업·기록 표만 바꾼다(예매·결제·발권을 되돌리지 않는다, notify §10).
import type { Clock } from '@peaket/platform';
import {
  FanNotifyProblem,
  isNightKst,
  isSubscriptionNotice,
  messageOf,
  needsDubiousRetry,
  webPushTargetOf,
  NOTIFY_LEASE_MS,
  NOTIFY_MAX_ATTEMPTS,
  notificationRetryDelayMs,
  optOutTokenFor,
  type FanNoticeKind,
} from '../domain/fan-notify.js';
import { MailTransportError, type FanNotifyStore, type MailTransport, type PushTransport, type Recipient, type RecipientDirectory, type VapidConfig } from '../domain/fan-notify-ports.js';
import type { NotificationDeliveryRecord, NotificationJob, NotificationSubscription } from '../domain/fan-notify-records.js';
import { encryptWebPush, pushTopic, pushTtlUrgency, vapidAuthorization } from '../domain/push-crypto.js';

export interface FanNotificationWorkerDeps {
  readonly store: FanNotifyStore;
  readonly mail: MailTransport;
  readonly push: PushTransport;
  readonly recipients: RecipientDirectory;
  readonly clock: Clock;
  readonly optOutKey: string;
  readonly vapid?: VapidConfig;
  /** 수신 거부 링크의 공개 출처. 운영은 PEAKET_PUBLIC_ORIGIN */
  readonly publicOrigin?: string;
  readonly topicKey?: string;
  readonly log?: (line: Record<string, unknown>) => void;
}

export interface WorkerResult {
  attempted: number;
  sent: number;
  retrying: number;
  dead: number;
  expired: number;
  failed: number;
  suppressed: number;
}

const subscriptionKindOf = (kind: string): 'OPEN' | 'CANCELLATION' | null => {
  if (kind === 'OPEN_LOBBY' || kind === 'OPEN_VERIFY') return 'OPEN';
  if (kind === 'CANCELLATION_ALERT') return 'CANCELLATION';
  return null;
};

export class FanNotificationWorker {
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(private readonly d: FanNotificationWorkerDeps) {}

  start(intervalMs = 5_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      if (this.#running) return;
      this.#running = true;
      void this.processDue(new Date(this.d.clock.now()))
        .catch((e) => this.d.log?.({ kind: 'notify-worker', error: e instanceof Error ? e.message : String(e) }))
        .finally(() => {
          this.#running = false;
        });
    }, intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** 내부 입구가 한 번 처리한 결과를 확인할 때 쓴다(운영 대행이 없는 fake 모드 시험) */
  async deliveryOf(dedupKey: string): Promise<NotificationDeliveryRecord | undefined> {
    return this.d.store.findDelivery(dedupKey);
  }

  async processDue(now: Date, limit = 20): Promise<WorkerResult> {
    const due = await this.d.store.leaseDueJobs(now, limit, NOTIFY_LEASE_MS);
    const out: WorkerResult = { attempted: due.length, sent: 0, retrying: 0, dead: 0, expired: 0, failed: 0, suppressed: 0 };
    for (const job of due) {
      try {
        await this.#one(job, now, out);
      } catch (e) {
        // 저장소·조립 오류는 다음 바퀴에 다시 집는다(임대가 끝난 뒤)
        this.d.log?.({ kind: 'notify-worker', error: e instanceof Error ? e.message : String(e), dedupKey: job.dedupKey });
        await this.#retry(job, now, out, `internal:${e instanceof Error ? e.name : 'unknown'}`);
      }
    }
    return out;
  }

  async #one(job: NotificationJob, now: Date, out: WorkerResult): Promise<void> {
    if (now.getTime() >= job.expiresAt.getTime()) {
      await this.#finish(job, now, 'EXPIRED', null);
      out.expired += 1;
      return;
    }

    let subscription: NotificationSubscription | undefined;
    const subKind = subscriptionKindOf(job.kind);
    if (subKind) {
      subscription = await this.d.store.findSubscription(job.accountId, job.targetId, subKind);
      if (!subscription || subscription.status !== 'ACTIVE') {
        await this.d.store.deleteJob(job.dedupKey);
        out.suppressed += 1;
        return;
      }
      if (job.channel === 'WEB_PUSH' && isNightKst(now.getTime()) && !subscription.nightPush) {
        await this.d.store.deleteJob(job.dedupKey);
        out.suppressed += 1;
        return;
      }
    }

    if (job.channel === 'EMAIL') {
      await this.#email(job, now, subscription, out);
      return;
    }
    if (job.channel === 'WEB_PUSH') {
      await this.#webPush(job, now, out);
      return;
    }
    // 알림톡·문자는 대행 계약 전이다. 지금은 영구 실패로 남긴다(ADR-0060 결정 13)
    await this.#terminate(job, now, 'DEAD', null, out, 'dead');
  }

  async #email(job: NotificationJob, now: Date, subscription: NotificationSubscription | undefined, out: WorkerResult): Promise<void> {
    const [recipient] = await this.d.recipients.getMany([job.accountId], true);
    const r: Recipient | undefined = recipient;
    if (!r || r.status === 'MERGED' || r.status === 'DELETED' || r.status === 'NOT_FOUND') {
      await this.#finish(job, now, 'FAILED', null);
      out.failed += 1;
      return;
    }
    if (!r.email) {
      await this.#retry(job, now, out, 'no-email');
      return;
    }

    const msg = messageOf(job.kind as FanNoticeKind, job.vars);
    const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
    if (isSubscriptionNotice(job.kind as FanNoticeKind) && subscription) {
      const token = optOutTokenFor(subscription.id, this.d.optOutKey);
      const base = (this.d.publicOrigin ?? 'https://peaket.example').replace(/\/+$/, '');
      headers['list-unsubscribe'] = `<${base}/v1/subscription-opt-outs/${token}>`;
      headers['list-unsubscribe-post'] = 'List-Unsubscribe=One-Click';
    }
    try {
      const sent = await this.d.mail.send({ to: r.email, subject: msg.title, body: msg.body, headers, messageKey: job.dedupKey });
      await this.#finish(job, now, 'SENT', sent.providerMessageId ?? null);
      out.sent += 1;
    } catch (e) {
      const err = e instanceof MailTransportError ? e : new MailTransportError('RETRYABLE', e instanceof Error ? e.message : 'transport-error');
      if (err.kind === 'PERMANENT') await this.#terminate(job, now, 'DEAD', null, out, 'dead');
      else if (err.kind === 'UNKNOWN' && !needsDubiousRetry(job.kind as FanNoticeKind)) await this.#terminate(job, now, 'FAILED', null, out, 'failed');
      else await this.#retry(job, now, out, err.message);
    }
  }

  async #webPush(job: NotificationJob, now: Date, out: WorkerResult): Promise<void> {
    if (!this.d.vapid) {
      await this.#terminate(job, now, 'FAILED', null, out, 'failed');
      return;
    }
    // 입장 키 알림은 구독마다 작업 하나다(notify §4.7). 그 작업은 자기 구독에만 보낸다. 나머지 종류는 그 계정의 모든 구독에 보낸다
    const target = webPushTargetOf(job.kind, job.dedupKey);
    const all = await this.d.store.listPushSubscriptions(job.accountId);
    const subs = target ? all.filter((s) => s.endpointHash === target) : all;
    if (subs.length === 0) {
      // 그 계정에 웹 푸시 구독이 없으면 보낼 곳이 없다(이메일 몫은 따로 간다). 실패로 세지 않는다
      await this.d.store.deleteJob(job.dedupKey);
      out.suppressed += 1;
      return;
    }
    const msg = messageOf(job.kind as FanNoticeKind, job.vars);
    const topic = pushTopic(this.d.topicKey ?? this.d.optOutKey, job.kind, job.targetId);
    const plaintext = JSON.stringify({ v: 1, kind: job.kind, title: msg.title, body: msg.body, ...(msg.url ? { url: msg.url } : {}), tag: topic });
    const { ttl, urgency } = pushTtlUrgency(job.kind);
    let success = 0;
    let retryable: string | null = null;

    for (const sub of subs) {
      const authorization = vapidAuthorization(this.d.vapid, new URL(sub.endpoint).origin, now.getTime());
      try {
        const r = await this.d.push.send({
          endpoint: sub.endpoint,
          headers: { ttl, urgency, topic, authorization, 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream' },
          body: encryptWebPush(plaintext, sub.p256dh, sub.auth),
          subscriptionKey: sub.endpointHash,
          service: sub.service,
        });
        if (r.status >= 200 && r.status < 300) success += 1;
        else if (r.status === 404 || r.status === 410 || r.status === 403) await this.d.store.deletePushSubscriptionById(sub.id);
        else retryable = `http-${r.status}`;
      } catch (e) {
        retryable = e instanceof Error ? e.message : 'transport-error';
      }
    }
    if (success > 0) {
      await this.#finish(job, now, 'SENT', null);
      out.sent += 1;
    } else if (retryable) {
      await this.#retry(job, now, out, retryable);
    } else {
      await this.#terminate(job, now, 'FAILED', null, out, 'failed');
    }
  }

  async #retry(job: NotificationJob, now: Date, out: WorkerResult, reason: string): Promise<void> {
    const attempt = job.attempts + 1;
    if (attempt >= NOTIFY_MAX_ATTEMPTS) {
      await this.#terminate(job, now, 'DEAD', null, out, 'dead');
      return;
    }
    const next = new Date(now.getTime() + notificationRetryDelayMs(attempt));
    if (next.getTime() >= job.expiresAt.getTime()) {
      await this.#terminate(job, now, 'EXPIRED', null, out, 'expired');
      return;
    }
    await this.d.store.saveJob({ ...job, status: 'RETRYING', attempts: attempt, nextAttemptAt: next, leaseUntil: null });
    out.retrying += 1;
    this.d.log?.({ kind: 'notify-retry', dedupKey: job.dedupKey, attempt, reason });
  }

  async #terminate(job: NotificationJob, now: Date, status: 'DEAD' | 'FAILED' | 'EXPIRED', providerMessageId: string | null, out: WorkerResult, which: 'dead' | 'failed' | 'expired'): Promise<void> {
    await this.#finish(job, now, status, providerMessageId, job.attempts + 1);
    out[which] += 1;
  }

  async #finish(job: NotificationJob, now: Date, status: 'SENT' | 'FAILED' | 'DEAD' | 'EXPIRED', providerMessageId: string | null, attempts = job.attempts + 1): Promise<void> {
    const delivery: NotificationDeliveryRecord = {
      dedupKey: job.dedupKey,
      sentAt: now,
      kind: job.kind,
      targetId: job.targetId,
      accountId: job.accountId,
      channel: job.channel,
      status,
      providerMessageId,
      createdAt: job.createdAt,
    };
    await this.d.store.insertDelivery(delivery);
    await this.d.store.deleteJob(job.dedupKey);
    if (status === 'DEAD') this.d.log?.({ kind: 'notify-dead', dedupKey: job.dedupKey, channel: job.channel, attempts });
  }
}

/** 워커 조립이 빠졌을 때의 한국어 오류(시작 확인) */
export const missingWorkerDeps = (): never => {
  throw new FanNotifyProblem('INVALID', '알림 발송 워커가 조립되지 않았습니다');
};
