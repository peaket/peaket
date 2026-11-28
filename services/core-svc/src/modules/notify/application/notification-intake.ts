// BAT-455 GAT-250 원장 입구: 무역 사건·로그인 수단 변경(I-T34)·계정 병합(POL-034)·직접 낱건.
// 사건을 받은 트랜잭션에서 중복 키를 먼저 넣고, 들어갔을 때만 작업을 적는다(ADR-0109).
import type { Clock } from '@peaket/platform';
import {
  assertVars,
  FAN_NOTICE_KINDS,
  FanNotifyProblem,
  isSubscriptionNotice,
  newId,
  smsFallbackDedupKey,
  SMS_ALLOWED_KINDS,
  TICKET_KEY_NOTICE_KINDS,
  ticketKeyNoticeDedupKey,
  WEB_PUSH_PRIMARY_KINDS,
  type FanNoticeKind,
  type NotificationChannel,
  type TicketKeyNoticeKind,
  type Vars,
} from '../domain/fan-notify.js';
import type { AbsorbedNoticeInbox, FanNotifyStore } from '../domain/fan-notify-ports.js';
import type { NotificationJob } from '../domain/fan-notify-records.js';

const DAY = 24 * 60 * 60 * 1000;

export interface NotificationIntakeDeps {
  readonly store: FanNotifyStore;
  readonly clock: Clock;
  /** 수신 거부 토큰 키. 워커와 같은 값을 쓴다 */
  readonly optOutKey: string;
  /** 흡수 계정 주소의 프로세스 메모리 inbox(디스크·DB 없음, F-06-1 POL-034) */
  readonly absorbedNotices?: AbsorbedNoticeInbox;
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

/** ticket-svc device_key_notice 보내기 반복이 보내는 입장 키 알림 사건(docs/features/notify.md §4.7, ADR-0363 결정 4) */
export interface TicketKeyNoticeEvent {
  noticeId: string;
  type: TicketKeyNoticeKind;
  accountId: string;
  ticketId: string;
  registeredAtMs: number;
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

  /**
   * POL-034 흡수 계정 완료 통지. identity가 병합 트랜잭션 안 gRPC로 넘긴 주소를 저장하지 않고,
   * 프로세스 inbox에 잠깐 두었다가 워커가 보낸다(계획 §3.1). 받는 계정은 이미 MERGED라
   * 워커는 identity 받는 사람 조회를 하지 않는다.
   */
  async accountMergedAbsorbed(i: { mergeId: string; absorbedAccountId: string; absorbedEmail: string }): Promise<{ created: number; duplicate: number }> {
    if (!isUuid(i.mergeId) || !isUuid(i.absorbedAccountId)) throw new FanNotifyProblem('INVALID', '병합 흡수 계정 통지 모양이 올바르지 않습니다');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.absorbedEmail)) throw new FanNotifyProblem('INVALID', '흡수 계정 이메일 모양이 올바르지 않습니다');
    const dedupKey = `ACCOUNT_MERGED_ABSORBED:${i.mergeId}:${i.absorbedAccountId}:EMAIL`;
    const r = await this.enqueue({
      kind: 'ACCOUNT_MERGED_ABSORBED',
      targetId: i.mergeId,
      accountId: i.absorbedAccountId,
      channel: 'EMAIL',
      vars: {},
      dedupKey,
    });
    if (r === 'created') this.d.absorbedNotices?.put(dedupKey, i.absorbedEmail);
    return { created: r === 'created' ? 1 : 0, duplicate: r === 'duplicate' ? 1 : 0 };
  }

  /**
   * 웹 푸시가 끝내 실패한 거래·안전 알림의 문자 대체 작업(d5 §9.1 4217).
   * 신청 알림·광고·이메일 주 채널 알림에는 만들지 않는다. 작업 키에 `:SMS:fallback`을 붙여
   * 워커가 대체 작업임을 안다.
   */
  async smsFallback(i: { kind: string; targetId: string; accountId: string }): Promise<'created' | 'duplicate' | 'not-applicable'> {
    if (!WEB_PUSH_PRIMARY_KINDS.has(i.kind as FanNoticeKind)) return 'not-applicable';
    if (!isUuid(i.accountId) || !i.targetId) throw new FanNotifyProblem('INVALID', '문자 대체 알림 대상이 올바르지 않습니다');
    const r = await this.enqueue({
      kind: i.kind as FanNoticeKind,
      targetId: i.targetId,
      accountId: i.accountId,
      channel: 'SMS',
      vars: {},
      dedupKey: smsFallbackDedupKey({ kind: i.kind, targetId: i.targetId, accountId: i.accountId }),
    });
    return r === 'created' ? 'created' : 'duplicate';
  }

  /**
   * 입장 키 알림(notify §4.7): 이메일 하나와 그 계정의 살아 있는 웹 푸시 구독마다 하나. 중복 키에 noticeId가 들어가 같은 사건이 다시 와도 작업은 하나다.
   * 변수는 type·registeredAt·ticketId 셋이고 공개키·keyId·이메일 주소는 싣지 않는다. 밤에도 보낸다(거래·안전 알림, §7.2)
   */
  async ticketKeyNotice(e: TicketKeyNoticeEvent): Promise<{ created: number; duplicate: number }> {
    if (!isUuid(e.noticeId) || !isUuid(e.accountId) || !isUuid(e.ticketId)) throw new FanNotifyProblem('INVALID', 'ID 모양이 올바르지 않습니다');
    if (!TICKET_KEY_NOTICE_KINDS.includes(e.type)) throw new FanNotifyProblem('INVALID', '알 수 없는 입장 키 알림 종류입니다');
    if (!Number.isSafeInteger(e.registeredAtMs) || e.registeredAtMs < 0) throw new FanNotifyProblem('INVALID', '등록 시각이 올바르지 않습니다');
    const vars = assertVars(e.type, { type: e.type, registeredAt: new Date(e.registeredAtMs).toISOString(), ticketId: e.ticketId });
    const out = { created: 0, duplicate: 0 };
    const key = { type: e.type, ticketId: e.ticketId, noticeId: e.noticeId, accountId: e.accountId };
    const email = await this.enqueue({ kind: e.type, targetId: e.ticketId, accountId: e.accountId, channel: 'EMAIL', vars, dedupKey: ticketKeyNoticeDedupKey({ ...key, channel: 'EMAIL' }) });
    out[email] += 1;
    for (const sub of await this.d.store.listPushSubscriptions(e.accountId)) {
      const r = await this.enqueue({
        kind: e.type,
        targetId: e.ticketId,
        accountId: e.accountId,
        channel: 'WEB_PUSH',
        vars,
        dedupKey: ticketKeyNoticeDedupKey({ ...key, channel: 'WEB_PUSH', subscriptionKey: sub.endpointHash }),
      });
      out[r] += 1;
    }
    return out;
  }

  async notice(i: NoticeInput): Promise<'created' | 'duplicate'> {
    if (!FAN_NOTICE_KINDS.includes(i.kind)) throw new FanNotifyProblem('INVALID', '알 수 없는 알림 종류입니다');
    if (!isUuid(i.accountId) || !i.targetId) throw new FanNotifyProblem('INVALID', '알림 대상이 올바르지 않습니다');
    if (!['EMAIL', 'WEB_PUSH', 'ALIMTALK', 'SMS'].includes(i.channel)) throw new FanNotifyProblem('INVALID', '알 수 없는 채널입니다');
    // 문자는 d5 §9.1의 월렛·키 미등록과 웹 푸시 실패 대체뿐이다. 나머지는 '문자'가 들어간 오류로 거절한다
    if (i.channel === 'SMS' && !SMS_ALLOWED_KINDS.has(i.kind)) throw new FanNotifyProblem('INVALID', `문자(SMS)로 보낼 수 없는 알림 종류입니다: ${i.kind}`);
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
