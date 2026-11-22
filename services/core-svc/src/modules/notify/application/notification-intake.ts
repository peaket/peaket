// BAT-455 GAT-250 원장 입구: 무역 사건·로그인 수단 변경(I-T34)·계정 병합(POL-034)·직접 낱건.
// 사건을 받은 트랜잭션에서 중복 키를 먼저 넣고, 들어갔을 때만 작업을 적는다(ADR-0109).
import type { Clock } from '@peaket/platform';
import { assertVars, FAN_NOTICE_KINDS, FanNotifyProblem, isSubscriptionNotice, newId, type FanNoticeKind, type NotificationChannel, type Vars } from '../domain/fan-notify.js';
import type { FanNotifyStore } from '../domain/fan-notify-ports.js';
import type { NotificationJob } from '../domain/fan-notify-records.js';

const DAY = 24 * 60 * 60 * 1000;

export interface NotificationIntakeDeps {
  readonly store: FanNotifyStore;
  readonly clock: Clock;
  /** 수신 거부 토큰 키. 워커와 같은 값을 쓴다 */
  readonly optOutKey: string;
}

export interface TradeNoticeEvent {
  type: 'EVENT_CANCELLATION_CONFIRMED' | 'EVENT_POSTPONED' | 'REFUNDED' | 'REFUND_FAILED';
  orderId: string;
  eventId: string;
  accountId: string;
  occurredAtMs?: number;
  fanNoticeReason?: string;
  refundAmount?: number;
  postponedTo?: string;
  refundWindowClosesAt?: string;
}

export interface LoginMethodChangedInput {
  eventKey: string;
  accountId: string;
  change: 'LINKED' | 'UNLINKED';
  provider: string;
  occurredAtMs?: number;
}

export interface AccountMergedInput {
  eventKey: string;
  primaryAccountId: string;
  mergedAccountId: string;
  occurredAtMs?: number;
}

export interface NoticeInput {
  kind: FanNoticeKind;
  targetId: string;
  accountId: string;
  channel: NotificationChannel;
  vars?: Vars;
  expiresAt?: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export class NotificationIntake {
  constructor(private readonly d: NotificationIntakeDeps) {}

  async tradeEvent(e: TradeNoticeEvent): Promise<'created' | 'duplicate'> {
    if (!isUuid(e.orderId) || !isUuid(e.eventId) || !isUuid(e.accountId)) throw new FanNotifyProblem('INVALID', 'ID 모양이 올바르지 않습니다');
    if (!['EVENT_CANCELLATION_CONFIRMED', 'EVENT_POSTPONED', 'REFUNDED', 'REFUND_FAILED'].includes(e.type)) throw new FanNotifyProblem('INVALID', '알 수 없는 알림 종류입니다');
    const vars = this.tradeVars(e);
    return this.enqueue({
      kind: e.type,
      targetId: e.orderId,
      accountId: e.accountId,
      channel: 'EMAIL',
      vars,
      dedupKey: `${e.type}:${e.orderId}:${e.accountId}:EMAIL`,
    });
  }

  async loginMethodChanged(i: LoginMethodChangedInput): Promise<{ created: number; duplicate: number }> {
    if (!isUuid(i.accountId) || !i.eventKey || !['LINKED', 'UNLINKED'].includes(i.change)) throw new FanNotifyProblem('INVALID', '로그인 수단 사건 모양이 올바르지 않습니다');
    const kind: FanNoticeKind = i.change === 'LINKED' ? 'LOGIN_METHOD_LINKED' : 'LOGIN_METHOD_UNLINKED';
    const vars = assertVars(kind, { provider: i.provider });
    const out = { created: 0, duplicate: 0 };
    for (const channel of ['EMAIL', 'WEB_PUSH'] as const) {
      const r = await this.enqueue({ kind, targetId: i.eventKey, accountId: i.accountId, channel, vars, dedupKey: `${kind}:${i.eventKey}:${i.accountId}:${channel}` });
      out[r] += 1;
    }
    return out;
  }

  async accountMerged(i: AccountMergedInput): Promise<{ created: number; duplicate: number; subscriptionsMoved: number; pushMoved: number }> {
    if (!isUuid(i.primaryAccountId) || !isUuid(i.mergedAccountId) || i.primaryAccountId === i.mergedAccountId) throw new FanNotifyProblem('INVALID', '병합 사건 모양이 올바르지 않습니다');
    const now = new Date(this.d.clock.now());
    const sub = await this.d.store.mergeSubscriptions(i.primaryAccountId, i.mergedAccountId, now);
    const push = await this.d.store.mergePushSubscriptions(i.primaryAccountId, i.mergedAccountId, now);
    const out = { created: 0, duplicate: 0, subscriptionsMoved: sub.moved + sub.deduped, pushMoved: push.moved + push.deduped };
    for (const channel of ['EMAIL', 'WEB_PUSH'] as const) {
      const r = await this.enqueue({ kind: 'ACCOUNT_MERGED', targetId: i.eventKey, accountId: i.primaryAccountId, channel, vars: {}, dedupKey: `ACCOUNT_MERGED:${i.eventKey}:${i.primaryAccountId}:${channel}` });
      out[r] += 1;
    }
    return out;
  }

  async notice(i: NoticeInput): Promise<'created' | 'duplicate'> {
    if (!FAN_NOTICE_KINDS.includes(i.kind)) throw new FanNotifyProblem('INVALID', '알 수 없는 알림 종류입니다');
    if (!isUuid(i.accountId) || !i.targetId) throw new FanNotifyProblem('INVALID', '알림 대상이 올바르지 않습니다');
    if (!['EMAIL', 'WEB_PUSH', 'ALIMTALK', 'SMS'].includes(i.channel)) throw new FanNotifyProblem('INVALID', '알 수 없는 채널입니다');
    return this.enqueue({
      kind: i.kind,
      targetId: i.targetId,
      accountId: i.accountId,
      channel: i.channel,
      vars: i.vars ?? {},
      dedupKey: `${i.kind}:${i.targetId}:${i.accountId}:${i.channel}`,
      ...(i.expiresAt ? { expiresAt: i.expiresAt } : {}),
    });
  }

  private tradeVars(e: TradeNoticeEvent): Vars {
    const raw: Vars = {};
    if (e.fanNoticeReason !== undefined) raw.fanNoticeReason = e.fanNoticeReason;
    if (e.refundAmount !== undefined) raw.refundAmount = e.refundAmount;
    if (e.postponedTo !== undefined) raw.postponedTo = e.postponedTo;
    if (e.refundWindowClosesAt !== undefined) raw.refundWindowClosesAt = e.refundWindowClosesAt;
    return assertVars(e.type, raw);
  }

  private async enqueue(o: { kind: FanNoticeKind; targetId: string; accountId: string; channel: NotificationChannel; vars: Vars; dedupKey: string; expiresAt?: Date }): Promise<'created' | 'duplicate'> {
    const now = new Date(this.d.clock.now());
    const vars = assertVars(o.kind, o.vars);
    const job: NotificationJob = {
      dedupKey: o.dedupKey,
      kind: o.kind,
      targetId: o.targetId,
      accountId: o.accountId,
      channel: o.channel,
      vars,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: now,
      leaseUntil: null,
      expiresAt: o.expiresAt ?? new Date(now.getTime() + DAY),
      createdAt: now,
    };
    if (isSubscriptionNotice(o.kind) && o.channel === 'EMAIL' && !vars.body && !vars.title) {
      // 신청 알림 문안은 부르는 쪽이 정한다. 비어 있으면 조용히 보내지 않는다
      throw new FanNotifyProblem('INVALID', '신청 알림에는 문안이 필요합니다');
    }
    const r = await this.d.store.enqueue(job, now);
    return r.created ? 'created' : 'duplicate';
  }
}

/** 웹 푸시만 쓰는 새 ID. 시험이 값 모양을 본다 */
export const newJobId = newId;
